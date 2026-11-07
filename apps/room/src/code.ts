import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { join, sep } from "node:path";

// The shared working copy: a git worktree named by ROOM_CODE_ROOT. Everything that
// touches it goes through `resolveInside`, and nothing here ever pushes.
export const MAX_CODE_FILE = 1024 * 1024;
const MAX_FILES = 3000;
const MAX_DEPTH = 12;
const MAX_BODY_BYTES = 2 * MAX_CODE_FILE + 4_096;
const SEED_CLAIM_MS = 20_000;
const SKIPPED_DIRS = new Set([".git", "node_modules"]);
const BINARY_EXTENSIONS = new Set(
  "png jpg jpeg gif webp ico bmp icns pdf zip gz tgz bz2 xz 7z rar jar wasm woff woff2 ttf otf eot mp3 mp4 mov avi webm wav ogg flac glb sqlite db dylib so exe bin class o a pyc".split(" "),
);

type CodeDeps = {
  dataDir: string;
  broadcast: (type: string, data: unknown) => void;
  fail: (status: number, message: string) => Error;
};

const isEnvFile = (name: string) => name === ".env" || name.startsWith(".env.");
const extensionOf = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase();

// First bytes: a NUL means binary. Invalid UTF-8 is rejected when the whole file is decoded.
const sniffBinary = (file: string) => {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(8000);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).includes(0);
  } finally {
    closeSync(fd);
  }
};

export const documentIdFor = (path: string) =>
  `code-${createHash("sha256").update(path).digest("hex").slice(0, 32)}`;

const run = (cwd: string, args: string[], person?: string) =>
  new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const name = person ?? "Room";
    const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "room"}@room.local`;
    execFile(
      "git",
      args,
      {
        cwd,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 20_000,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          GIT_TERMINAL_PROMPT: "0",
          GIT_AUTHOR_NAME: name,
          GIT_AUTHOR_EMAIL: email,
          GIT_COMMITTER_NAME: name,
          GIT_COMMITTER_EMAIL: email,
        },
      },
      (error, out, err) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, out: String(out), err: String(err) });
      },
    );
  });

export const createCode = ({ dataDir, broadcast, fail }: CodeDeps) => {
  const claims = new Map<string, { from: string; at: number }>();
  let commitLock: Promise<unknown> = Promise.resolve();

  const rootOf = () => {
    const configured = process.env.ROOM_CODE_ROOT;
    if (!configured) throw fail(503, "Shared code is not set up on this room.");
    try {
      return realpathSync(configured);
    } catch {
      throw fail(503, "The shared code folder is not available.");
    }
  };

  // Returns the real path of an existing file inside the root, or throws.
  // Rejects absolute paths, "..", NUL, git internals, env files, and symlinks that leave the root.
  const resolveInside = (root: string, value: unknown) => {
    if (typeof value !== "string" || value === "" || value.length > 500 || value.includes("\0")) {
      throw fail(400, "path is required.");
    }
    const parts = value.split("/");
    if (value.startsWith("/") || value.includes("\\") || parts.some((part) => part === "" || part === "." || part === "..")) {
      throw fail(400, "That path is not allowed.");
    }
    if (parts.some((part) => SKIPPED_DIRS.has(part) || isEnvFile(part))) {
      throw fail(403, "That file is not shared.");
    }
    let real: string;
    try {
      real = realpathSync(join(root, ...parts));
    } catch {
      throw fail(404, "No such file.");
    }
    if (!real.startsWith(root + sep)) throw fail(403, "That path leaves the shared folder.");
    const relative = real.slice(root.length + 1).split(sep);
    if (relative.some((part) => SKIPPED_DIRS.has(part) || isEnvFile(part))) {
      throw fail(403, "That file is not shared.");
    }
    if (!statSync(real).isFile()) throw fail(400, "That is not a file.");
    return real;
  };

  const readText = (real: string) => {
    const size = statSync(real).size;
    if (size > MAX_CODE_FILE) throw fail(413, "That file is over 1 MB.");
    if (BINARY_EXTENSIONS.has(extensionOf(real)) || sniffBinary(real)) {
      throw fail(415, "That looks like a binary file.");
    }
    const bytes = readFileSync(real);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw fail(415, "That looks like a binary file.");
    }
  };

  const listFiles = (root: string) => {
    const files: Array<{ path: string; size: number }> = [];
    let truncated = false;
    const walk = (dir: string, prefix: string, depth: number) => {
      if (depth > MAX_DEPTH) return;
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (files.length >= MAX_FILES) {
          truncated = true;
          return;
        }
        if (SKIPPED_DIRS.has(entry.name) || isEnvFile(entry.name)) continue;
        const full = join(dir, entry.name);
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(full, relative, depth + 1);
        } else if (entry.isFile()) {
          // Symlinks are skipped in the listing (isFile is false for them).
          const { size } = lstatSync(full);
          if (size > MAX_CODE_FILE || BINARY_EXTENSIONS.has(extensionOf(entry.name))) continue;
          try {
            if (sniffBinary(full)) continue;
          } catch {
            continue;
          }
          files.push({ path: relative, size });
        }
      }
    };
    walk(root, "", 0);
    return { files, truncated };
  };

  const readJson = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw fail(413, "That is too large.");
      chunks.push(chunk);
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {}
    throw fail(400, "Expected a JSON object.");
  };

  const status = async (root: string) => {
    const result = await run(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
    if (result.code !== 0) throw fail(409, "The shared folder is not a git worktree.");
    const [branch, top] = await Promise.all([
      run(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
      run(root, ["rev-parse", "--show-toplevel"]),
    ]);
    const entries = result.out.split("\0").filter(Boolean);
    const changes: Array<{ path: string; code: string }> = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      changes.push({ path: entry.slice(3), code: entry.slice(0, 2).trim() || "?" });
      if (entry[0] === "R" || entry[0] === "C") index += 1;
    }
    return {
      branch: branch.out.trim(),
      changes: changes.filter((change) => !change.path.split("/").some(isEnvFile)),
      isRoot: realpathSync(top.out.trim()) === root,
    };
  };

  return async (route: string, req: IncomingMessage, person: string): Promise<unknown> => {
    if (!route.includes(" /api/code/")) return undefined;
    const root = rootOf();

    if (route === "POST /api/code/tree") return listFiles(root);
    if (route === "POST /api/code/status") return status(root);

    if (route === "POST /api/code/presence") {
      const body = await readJson(req);
      if (typeof body.doc !== "string" || typeof body.update !== "string" || body.update.length > 20_000) {
        throw fail(400, "Bad presence.");
      }
      broadcast("code-presence", { doc: body.doc, update: body.update, from: body.from ?? null });
      return { ok: true };
    }

    if (route === "POST /api/code/open") {
      const body = await readJson(req);
      const path = body.path as string;
      const real = resolveInside(root, path);
      const text = readText(real);
      const doc = documentIdFor(path);
      const log = join(dataDir, "sync", `${doc}.log`);
      const hasHistory = existsSync(log) && statSync(log).size > 0;
      const from = typeof body.from === "string" ? body.from.slice(0, 80) : person;
      const claim = claims.get(doc);
      // The first opener of an empty document seeds it; the claim lapses if they never do.
      const seed =
        !hasHistory && (!claim || claim.from === from || Date.now() - claim.at > SEED_CLAIM_MS);
      if (seed) claims.set(doc, { from, at: Date.now() });
      return { path, doc, text, seed, person };
    }

    if (route === "POST /api/code/save") {
      const body = await readJson(req);
      const real = resolveInside(root, body.path);
      if (typeof body.text !== "string") throw fail(400, "text is required.");
      if (Buffer.byteLength(body.text) > MAX_CODE_FILE) throw fail(413, "That file is over 1 MB.");
      readText(real);
      const temp = `${real}.room-save`;
      writeFileSync(temp, body.text, { mode: statSync(real).mode & 0o777 });
      renameSync(temp, real);
      return { ok: true };
    }

    if (route === "POST /api/code/commit") {
      const body = await readJson(req);
      const message = typeof body.message === "string" ? body.message.trim().slice(0, 500) : "";
      if (message === "") throw fail(400, "A commit message is required.");
      const result = commitLock.then(async () => {
        const state = await status(root);
        if (!state.isRoot) throw fail(409, "The shared folder must be the top of its git worktree.");
        if (state.changes.length === 0) throw fail(409, "There is nothing to commit.");
        // Stage only inside the worktree, never env files, and skip repo hooks.
        const add = await run(root, ["add", "-A", "--", ".", ":(exclude,glob)**/.env", ":(exclude,glob)**/.env.*"], person);
        if (add.code !== 0) throw fail(500, "Could not stage the changes.");
        const commit = await run(
          root,
          ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-m", message],
          person,
        );
        if (commit.code !== 0) throw fail(409, (commit.err || commit.out).trim().slice(0, 300) || "Commit failed.");
        const head = await run(root, ["rev-parse", "--short", "HEAD"]);
        return { ok: true, commit: head.out.trim() };
      });
      commitLock = result.catch(() => undefined);
      return result;
    }
    throw fail(404, "Not found.");
  };
};
