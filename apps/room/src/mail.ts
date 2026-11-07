import { spawn } from "node:child_process";

// Agent mail inside the Room: GitHub issues in ROOM_MAIL_REPO, read and written through the
// `gh` CLI. See "Agent mail" in Connection Engine/docs/agent-mail.md for the format.
// gh is always run with an argument array (never a shell), with a timeout and an output cap.
const GH_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const CACHE_MS = 30_000;
const LIST_LIMIT = 100;
const MAX_TITLE = 120;
const MAX_BODY = 8_000;
const MAX_FILES = 50;
const MAX_FIELD = 200;
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/;
const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,38}$/;

type Fail = (status: number, message: string) => Error;
type GhResult = { stdout: string };
type Label = { name: string };
type Issue = {
  number: number;
  title: string;
  body?: string;
  url: string;
  state?: string;
  updatedAt?: string;
  labels?: Label[];
  comments?: Array<{ author?: { login?: string }; body: string; createdAt?: string; url?: string }>;
};

/** Removes the `@` that would make GitHub notify a user (or team). Emails like a@b.c are left alone. */
export const stripMentions = (text: string): string =>
  text.replace(/(^|[^A-Za-z0-9])[@＠](?=[A-Za-z0-9_-])/g, "$1");

/** Control characters out, and no way to forge a mention. */
export const cleanText = (value: unknown, field: string, max: number, fail: Fail): string => {
  if (typeof value !== "string") throw fail(400, `${field} is required.`);
  const text = stripMentions(
    value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""),
  ).trim();
  if (text === "") throw fail(400, `${field} is required.`);
  return text.slice(0, max);
};

const cleanLine = (value: unknown, field: string, max: number, fail: Fail) =>
  cleanText(value, field, max, fail).replace(/\s+/g, " ");

/** "Chase" becomes "chase-room", the name a person's Room posts under. */
export const roomAgentName = (person: string): string => {
  const slug = person
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return `${slug || "guest"}-room`;
};

const expandBraces = (value: string): string[] => {
  const match = /^(.*?)\{([^{}]*)\}(.*)$/.exec(value);
  if (!match) return [value];
  return match[2]!.split(",").flatMap((part) => expandBraces(`${match[1]}${part.trim()}${match[3]}`));
};

const splitOutsideBraces = (value: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "{") depth += 1;
    if (char === "}") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts;
};

const field = (body: string, name: string): string | null => {
  const match = new RegExp(`^\\s*\\*\\*${name}:\\*\\*[ \\t]*(.*)$`, "im").exec(body);
  return match ? match[1]!.trim() : null;
};

export type Claim = {
  number: number;
  title: string;
  agent: string;
  files: string[];
  branch: string;
  url: string;
};

const titleParts = (title: string) => {
  const match = /^\[([^→\]]*?)\s*(?:→|->)\s*([^\]]*)\]/.exec(title);
  return { from: match?.[1]?.trim() ?? "", to: match?.[2]?.trim() ?? "" };
};

export const parseClaim = (issue: Issue): Claim => {
  const body = issue.body ?? "";
  const filesField = field(body, "Files") ?? "";
  const ticked = [...filesField.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
  const raw = ticked.length > 0 ? ticked : splitOutsideBraces(filesField);
  const files = raw
    .flatMap((item) => expandBraces(item.trim()))
    .map((item) => item.replace(/^`|`$/g, "").trim())
    .filter((item) => item !== "" && !/^(none|n\/a|-|tbd)$/i.test(item))
    .slice(0, MAX_FILES)
    .map((item) => item.slice(0, MAX_FIELD));
  const branch = (field(body, "Branch") ?? "").replace(/`/g, "").trim();
  return {
    number: issue.number,
    title: issue.title,
    agent: (field(body, "From") ?? titleParts(issue.title).from).replace(/[`*]/g, "").trim(),
    files,
    branch: /^(none|n\/a|-|tbd)$/i.test(branch) ? "" : branch.slice(0, MAX_FIELD),
    url: issue.url,
  };
};

const labelNames = (issue: Issue) => (issue.labels ?? []).map((label) => label.name);

const summarize = (issue: Issue) => {
  const labels = labelNames(issue);
  const { from, to } = titleParts(issue.title);
  return {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    updatedAt: issue.updatedAt ?? null,
    from,
    to,
    labels,
    inboxes: labels.filter((name) => name.startsWith("to:")).map((name) => name.slice(3)),
    claim: labels.includes("claim"),
    directory: labels.includes("directory"),
  };
};

type MailOptions = { fail: Fail; now?: () => number; gh?: string };

export const createMail = ({ fail, now = Date.now, gh = "gh" }: MailOptions) => {
  const cache = new Map<string, { at: number; value: Promise<GhResult> }>();

  const run = (args: string[], input?: string): Promise<GhResult> =>
    new Promise((resolve, reject) => {
      const child = spawn(gh, args, { stdio: ["pipe", "pipe", "pipe"], timeout: GH_TIMEOUT_MS });
      let stdout = "";
      let stderr = "";
      let overflow = false;
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.length > MAX_OUTPUT_BYTES) {
          overflow = true;
          child.kill();
        }
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-2_000);
      });
      child.stdin.on("error", () => {});
      child.on("error", (error: NodeJS.ErrnoException) =>
        reject(
          fail(
            502,
            error.code === "ENOENT"
              ? "The GitHub CLI (gh) is not installed on the room's machine."
              : "Could not run the GitHub CLI.",
          ),
        ),
      );
      child.on("close", (code, signal) => {
        if (overflow) return reject(fail(502, "GitHub sent back too much data."));
        if (signal === "SIGTERM") return reject(fail(504, "GitHub took too long to answer."));
        if (code !== 0) {
          const line = stderr.trim().split("\n")[0]?.slice(0, 200) || `gh exited with ${code}.`;
          return reject(fail(502, `GitHub said: ${line}`));
        }
        resolve({ stdout });
      });
      child.stdin.end(input ?? "");
    });

  /** Every read: cached for about 30 seconds unless `fresh`. Failures are never cached. */
  const read = async (args: string[], fresh = false): Promise<string> => {
    const key = JSON.stringify(args);
    const hit = cache.get(key);
    if (!fresh && hit && now() - hit.at < CACHE_MS) return (await hit.value).stdout;
    const value = run(args);
    cache.set(key, { at: now(), value });
    try {
      return (await value).stdout;
    } catch (error) {
      if (cache.get(key)?.value === value) cache.delete(key);
      throw error;
    }
  };

  /** Every write goes through here, so the exact gh arguments are in one place. */
  const write = async (args: string[], body: string): Promise<string> => {
    const { stdout } = await run(args, body);
    cache.clear();
    return stdout;
  };

  const json = <T>(text: string): T => {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw fail(502, "GitHub sent back something unreadable.");
    }
  };

  const issueNumber = (value: unknown) => {
    const number = typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : value;
    if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > 999_999_999) {
      throw fail(400, "number must be a thread number.");
    }
    return number;
  };

  const agentNames = (value: unknown, field: string): string[] => {
    if (value === undefined || value === null || value === "") return [];
    const list = Array.isArray(value) ? value : [value];
    if (list.length > 8) throw fail(400, `${field} has too many names.`);
    return list.map((item) => {
      const name = typeof item === "string" ? item.trim().replace(/^to:/, "").toLowerCase() : "";
      if (name !== "all" && !AGENT_NAME.test(name)) throw fail(400, `Bad name in ${field}.`);
      return name;
    });
  };

  const repoOf = (): string => {
    const repo = process.env.ROOM_MAIL_REPO?.trim();
    if (!repo) throw fail(503, "Agent mail is not set up on this room (ROOM_MAIL_REPO).");
    if (!REPO.test(repo)) throw fail(503, "ROOM_MAIL_REPO must look like owner/agent-mail.");
    return repo;
  };

  const listIssues = async (repo: string, label: string, fields: string) =>
    json<Issue[]>(
      await read([
        "issue", "list", "-R", repo, "--label", label, "--state", "open",
        "--limit", String(LIST_LIMIT), "--json", fields,
      ]),
    );

  const viewThread = async (repo: string, number: number, fields: string, fresh = false) => {
    let issue: Issue;
    try {
      issue = json<Issue>(await read(["issue", "view", String(number), "-R", repo, "--json", fields], fresh));
    } catch (error) {
      if (error instanceof Error && /not.?found|could not resolve/i.test(error.message)) {
        throw fail(404, "No such thread.");
      }
      throw error;
    }
    // Only agent-mail threads: this is not a general issue browser or commenter.
    if (!labelNames(issue).includes("agent-mail")) throw fail(404, "No such thread.");
    return issue;
  };

  return async (route: string, body: Record<string, unknown>, person: string): Promise<unknown> => {
    if (!route.startsWith("POST /api/mail/")) return undefined;
    const repo = repoOf();
    const me = roomAgentName(person);

    if (route === "POST /api/mail/threads") {
      const issues = await listIssues(repo, "agent-mail", "number,title,url,updatedAt,labels");
      const threads = issues.map(summarize);
      const inboxes: Record<string, number> = {};
      for (const thread of threads) {
        if (thread.directory) continue;
        for (const inbox of thread.inboxes) inboxes[inbox] = (inboxes[inbox] ?? 0) + 1;
      }
      return { repo, me, threads, inboxes };
    }

    if (route === "POST /api/mail/claims") {
      const issues = await listIssues(repo, "claim", "number,title,body,url");
      return { repo, claims: issues.map(parseClaim) };
    }

    if (route === "POST /api/mail/thread") {
      const number = issueNumber(body.number);
      const issue = await viewThread(repo, number, "number,title,body,state,labels,comments,url");
      return {
        repo,
        me,
        thread: {
          ...summarize(issue),
          state: issue.state ?? "OPEN",
          body: issue.body ?? "",
          comments: (issue.comments ?? []).map((comment) => ({
            author: comment.author?.login ?? "",
            body: comment.body,
            at: comment.createdAt ?? null,
            url: comment.url ?? null,
          })),
        },
      };
    }

    if (route === "POST /api/mail/reply") {
      const number = issueNumber(body.number);
      const text = cleanText(body.text, "text", MAX_BODY, fail);
      const thread = await viewThread(repo, number, "number,title,state,labels", true);
      if (thread.state && thread.state.toUpperCase() !== "OPEN") throw fail(409, "That thread is closed.");
      const named = agentNames(body.to, "to");
      const { from, to } = titleParts(thread.title);
      const fallback = [from, ...to.split(",")]
        .map((name) => name.trim().toLowerCase())
        .filter((name) => AGENT_NAME.test(name) && name !== me);
      const recipients = named.length > 0 ? named : fallback.length > 0 ? [...new Set(fallback)] : ["all"];
      const message = `**From:** ${me}\n**To:** ${recipients.join(", ")}\n\n${text}\n`;
      await write(["issue", "comment", String(number), "-R", repo, "--body-file", "-"], message);
      return { ok: true, number, from: me, to: recipients };
    }

    if (route === "POST /api/mail/new") {
      const topic = cleanLine(body.title, "title", MAX_TITLE, fail);
      const text = cleanText(body.body, "body", MAX_BODY, fail);
      const inbox = agentNames(body.inbox, "inbox");
      if (inbox.length > 1) throw fail(400, "Tag one inbox at a time.");
      const target = inbox[0] ?? "all";
      const labels = ["agent-mail", ...(inbox[0] ? [`to:${inbox[0]}`] : [])];
      const args = ["issue", "create", "-R", repo];
      for (const label of labels) args.push("--label", label);
      args.push("--title", `[${me}→${target}] ${topic}`, "--body-file", "-");
      const out = await write(args, `**From:** ${me}\n**To:** ${target}\n\n${text}\n`);
      const url = /https:\/\/\S+\/issues\/(\d+)/.exec(out);
      return { ok: true, number: url ? Number(url[1]) : null, url: url ? url[0] : null, from: me, to: target };
    }

    throw fail(404, "Not found.");
  };
};
