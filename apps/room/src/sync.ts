import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";

// A relay for shared documents (code, whiteboard): clients send opaque updates
// (Yjs or similar), the room logs them per document and broadcasts them to everyone.
const DOC_ID = /^[a-z0-9][a-z0-9:._-]{0,119}$/i;
const MAX_UPDATE_CHARS = 700_000;
const MAX_BODY_BYTES = MAX_UPDATE_CHARS + 4_096;
const MAX_LOG_BYTES = 20 * 1024 * 1024;

type SyncDeps = {
  dataDir: string;
  broadcast: (type: string, data: unknown) => void;
  fail: (status: number, message: string) => Error;
};

const readJson = async (req: IncomingMessage, fail: SyncDeps["fail"]) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw fail(413, "Update is too large.");
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}
  throw fail(400, "Expected a JSON object.");
};

export const createSync = ({ dataDir, broadcast, fail }: SyncDeps) => {
  const dir = join(dataDir, "sync");
  mkdirSync(dir, { recursive: true });
  const logOf = (doc: unknown) => {
    if (typeof doc !== "string" || !DOC_ID.test(doc)) throw fail(400, "Bad document id.");
    return join(dir, `${doc.replaceAll(":", "__")}.log`);
  };
  const updateOf = (value: unknown) => {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_UPDATE_CHARS) {
      throw fail(400, "update is required.");
    }
    if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) throw fail(400, "update must be base64.");
    return value;
  };

  return async (route: string, req: IncomingMessage, person: string): Promise<unknown> => {
    if (route === "POST /api/sync/load") {
      const body = await readJson(req, fail);
      const log = logOf(body.doc);
      const updates = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
      return { doc: body.doc, updates };
    }
    if (route === "POST /api/sync") {
      const body = await readJson(req, fail);
      const log = logOf(body.doc);
      const update = updateOf(body.update);
      if (existsSync(log) && statSync(log).size > MAX_LOG_BYTES) {
        throw fail(507, "This document needs compacting before more changes.");
      }
      appendFileSync(log, `${update}\n`);
      broadcast("sync", {
        doc: body.doc,
        update,
        from: typeof body.from === "string" ? body.from.slice(0, 80) : null,
        by: person,
      });
      return { ok: true };
    }
    if (route === "POST /api/sync/compact") {
      // A client that merged every update replaces the log with one snapshot.
      const body = await readJson(req, fail);
      const log = logOf(body.doc);
      const snapshot = updateOf(body.snapshot);
      writeFileSync(`${log}.tmp`, `${snapshot}\n`);
      renameSync(`${log}.tmp`, log);
      return { ok: true };
    }
    return undefined;
  };
};
