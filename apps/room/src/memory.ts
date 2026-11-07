import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Opt-in agent memory as plain Obsidian-compatible Markdown: <dir>/<room>/<project>.md.
// The idea (agent memory kept as readable notes) follows jaredrhod/ai-memory-vault's public
// description; no code from it is used.

export const MAX_NOTE = 500;
export const MAX_EXCERPT = 2_000;
export const MAX_FILE = 128 * 1024;

// The hash keeps "A b" and "a-b" from sharing a file once names are made path-safe.
const slug = (value: string) => {
  const readable =
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "x";
  return `${readable}-${createHash("sha256").update(value).digest("hex").slice(0, 6)}`;
};

export const memoryFile = (dir: string, room: string, project: string) =>
  join(resolve(dir), slug(room), `${slug(project)}.md`);

export const parseRemember = (text: string): { mentions: string[]; note: string } | null => {
  const match = /^((?:@[\p{L}\p{N}_-]+\s+)*)remember:\s*([\s\S]*\S)\s*$/iu.exec(text.trim());
  if (!match) return null;
  const mentions = [...match[1]!.matchAll(/@([\p{L}\p{N}_-]+)/gu)].map((m) => m[1]!.toLowerCase());
  return { mentions, note: match[2]! };
};

export const appendNote = (
  dir: string,
  room: string,
  project: string,
  by: string,
  note: string,
  now = new Date(),
) => {
  const file = memoryFile(dir, room, project);
  const line = `- ${now.toISOString().slice(0, 16).replace("T", " ")} ${by.replace(/[\r\n]+/g, " ")}: ${note
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NOTE)}\n`;
  const size = existsSync(file) ? statSync(file).size : 0;
  if (size + line.length > MAX_FILE) throw new Error("This memory file is full.");
  if (size === 0) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `---\nroom: ${JSON.stringify(room)}\nproject: ${JSON.stringify(project)}\n---\n# Room memory\n\n`,
    );
  }
  appendFileSync(file, line);
  return file;
};

// The newest notes that fit, cut at line boundaries.
export const readExcerpt = (dir: string, room: string, project: string, max = MAX_EXCERPT) => {
  const file = memoryFile(dir, room, project);
  if (!existsSync(file)) return "";
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("- "));
  const kept: string[] = [];
  let used = 0;
  for (const line of lines.reverse()) {
    if (used + line.length + 1 > max) break;
    kept.unshift(line);
    used += line.length + 1;
  }
  return kept.join("\n");
};

// Notes belong in a folder of their own, not in a project's repository.
export const insideGitRepo = (dir: string) => {
  let current = resolve(dir);
  while (true) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
};
