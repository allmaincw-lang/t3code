import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT = 8_000;
const HISTORY_LIMIT = 300;
const HEARTBEAT_MS = 20_000;
const AGENT_STATUSES = new Set(["idle", "working", "needs-approval", "error"]);
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "public/index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "public/app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "public/style.css", type: "text/css; charset=utf-8" },
};

type Message = {
  id: string;
  author: string;
  kind: "person" | "agent" | "system";
  text: string;
  at: string;
};
type Dispatch = {
  id: string;
  agent: string;
  owner: string;
  from: string;
  text: string;
  status: "pending" | "approved" | "delivered" | "declined" | "done" | "failed";
  approvedBy: string | null;
  at: string;
};
type Agent = {
  name: string;
  owner: string;
  machine: string;
  status: string;
  task: string | null;
  link: string | null;
  online: boolean;
};
type Connection = {
  id: string;
  person: string;
  kind: "browser" | "connector";
  machine: string | null;
  inCall: boolean;
  res: ServerResponse;
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const readPeople = (dataDir: string): Record<string, string> => {
  const path = join(dataDir, "people.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
};

export const invitePerson = (dataDir: string, name: string): string => {
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,39}$/u.test(name)) {
    throw new Error("Names are 1 to 40 letters, numbers, spaces, dashes or underscores.");
  }
  mkdirSync(dataDir, { recursive: true });
  const token = randomBytes(24).toString("base64url");
  const people = readPeople(dataDir);
  people[hashToken(token)] = name;
  writeFileSync(join(dataDir, "people.json"), JSON.stringify(people, null, 2), { mode: 0o600 });
  return token;
};

const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Message is too large.");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, "Expected a JSON object.");
  }
};

const requireText = (value: unknown, field: string, max = MAX_TEXT): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `${field} is required.`);
  }
  return value.trim().slice(0, max);
};

const optionalText = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : null;

const httpLink = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
};

export const createRoomServer = (dataDir: string): Server => {
  mkdirSync(dataDir, { recursive: true });
  const logPath = join(dataDir, "events.jsonl");
  const messages: Message[] = [];
  const dispatches = new Map<string, Dispatch>();
  const agents = new Map<string, Agent>();
  const connections = new Map<string, Connection>();

  if (existsSync(logPath)) {
    for (const line of readFileSync(logPath, "utf8").split("\n")) {
      if (line === "") continue;
      const entry = JSON.parse(line);
      if (entry.type === "message") messages.push(entry.message);
      if (entry.type === "dispatch") dispatches.set(entry.dispatch.id, entry.dispatch);
    }
  }

  const send = (conn: Connection, type: string, data: unknown) => {
    conn.res.write(`${JSON.stringify({ type, data })}\n`);
  };
  const broadcast = (type: string, data: unknown) => {
    for (const conn of connections.values()) send(conn, type, data);
  };
  const publicConnections = () =>
    [...connections.values()]
      .filter((conn) => conn.kind === "browser")
      .map(({ id, person, inCall }) => ({ id, person, inCall }));
  const broadcastPresence = () => broadcast("presence", publicConnections());
  const agentKey = (name: string) => name.toLowerCase();

  const addMessage = (author: string, kind: Message["kind"], text: string) => {
    const message: Message = {
      id: randomUUID(),
      author,
      kind,
      text,
      at: new Date().toISOString(),
    };
    messages.push(message);
    appendFileSync(logPath, `${JSON.stringify({ type: "message", message })}\n`);
    broadcast("message", message);
    return message;
  };

  const connectorFor = (agent: Agent) =>
    [...connections.values()].find(
      (conn) =>
        conn.kind === "connector" && conn.person === agent.owner && conn.machine === agent.machine,
    );

  const saveDispatch = (dispatch: Dispatch) => {
    appendFileSync(logPath, `${JSON.stringify({ type: "dispatch", dispatch })}\n`);
    broadcast("dispatch", dispatch);
  };

  // Only approved work ever reaches a connector, and it re-checks who approved it.
  const deliver = (dispatch: Dispatch) => {
    if (dispatch.status !== "approved") return;
    const agent = agents.get(agentKey(dispatch.agent));
    const connector = agent && connectorFor(agent);
    if (!connector) return;
    dispatch.status = "delivered";
    saveDispatch(dispatch);
    send(connector, "run", dispatch);
  };

  const routeMentions = (from: string, text: string) => {
    const named = new Set(
      [...text.matchAll(/@([\p{L}\p{N}_-]+)/gu)].map((match) => match[1]!.toLowerCase()),
    );
    for (const name of named) {
      const agent = agents.get(name);
      if (!agent) continue;
      const approved = agent.owner === from;
      const dispatch: Dispatch = {
        id: randomUUID(),
        agent: agent.name,
        owner: agent.owner,
        from,
        text,
        status: approved ? "approved" : "pending",
        approvedBy: approved ? from : null,
        at: new Date().toISOString(),
      };
      dispatches.set(dispatch.id, dispatch);
      saveDispatch(dispatch);
      deliver(dispatch);
    }
  };

  const openStream = (req: IncomingMessage, res: ServerResponse, person: string, url: URL) => {
    const machine = optionalText(url.searchParams.get("machine"), 60);
    res.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    const conn: Connection = {
      id: randomUUID(),
      person,
      kind: machine ? "connector" : "browser",
      machine,
      inCall: false,
      res,
    };
    connections.set(conn.id, conn);
    send(conn, "snapshot", {
      me: person,
      connectionId: conn.id,
      messages: messages.slice(-HISTORY_LIMIT),
      dispatches: [...dispatches.values()].slice(-HISTORY_LIMIT),
      agents: [...agents.values()],
      connections: publicConnections(),
    });
    if (conn.kind === "browser") broadcastPresence();
    const heartbeat = setInterval(() => send(conn, "ping", null), HEARTBEAT_MS);
    req.on("close", () => {
      clearInterval(heartbeat);
      connections.delete(conn.id);
      if (conn.kind === "browser") {
        broadcastPresence();
        return;
      }
      for (const agent of agents.values()) {
        if (agent.owner === person && agent.machine === machine) {
          agent.online = false;
          broadcast("agent", agent);
        }
      }
    });
  };

  const handleApi = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    person: string,
  ): Promise<unknown> => {
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /api/events") {
      openStream(req, res, person, url);
      return undefined;
    }
    if (req.method !== "POST") throw new HttpError(404, "Not found.");
    const body = await readBody(req);

    if (route === "POST /api/messages") {
      const text = requireText(body.text, "text");
      const message = addMessage(person, "person", text);
      routeMentions(person, text);
      return { id: message.id };
    }
    if (route === "POST /api/call") {
      const conn = connections.get(requireText(body.connectionId, "connectionId"));
      if (!conn || conn.person !== person) throw new HttpError(404, "Unknown connection.");
      conn.inCall = body.inCall === true;
      broadcastPresence();
      return { ok: true };
    }
    if (route === "POST /api/signal") {
      const from = connections.get(requireText(body.from, "from"));
      const to = connections.get(requireText(body.to, "to"));
      if (!from || from.person !== person) throw new HttpError(404, "Unknown connection.");
      if (!to || to.kind !== "browser") throw new HttpError(404, "That person has left.");
      send(to, "signal", { from: from.id, person, data: body.data });
      return { ok: true };
    }
    if (route === "POST /api/agents") {
      const machine = requireText(body.machine, "machine", 60);
      if (!Array.isArray(body.agents)) throw new HttpError(400, "agents is required.");
      for (const input of body.agents as Array<Record<string, unknown>>) {
        const name = requireText(input.name, "name", 40);
        if (!/^[\p{L}\p{N}_-]+$/u.test(name)) throw new HttpError(400, `Bad agent name: ${name}`);
        const existing = agents.get(agentKey(name));
        if (existing && existing.owner !== person) {
          throw new HttpError(409, `${name} belongs to ${existing.owner}.`);
        }
        const status =
          typeof input.status === "string" && AGENT_STATUSES.has(input.status)
            ? input.status
            : "idle";
        const agent: Agent = {
          name,
          owner: person,
          machine,
          status,
          task: optionalText(input.task, 200),
          link: httpLink(input.link),
          online: true,
        };
        agents.set(agentKey(name), agent);
        broadcast("agent", agent);
        if (status === "needs-approval" && existing?.status !== "needs-approval") {
          addMessage(name, "system", `${name} is waiting for ${person} to approve an action in T3.`);
        }
      }
      for (const dispatch of dispatches.values()) deliver(dispatch);
      return { ok: true };
    }

    const decision = /^POST \/api\/dispatches\/([\w-]+)\/(approve|decline|result)$/.exec(route);
    if (decision) {
      const dispatch = dispatches.get(decision[1]!);
      if (!dispatch) throw new HttpError(404, "Unknown request.");
      if (dispatch.owner !== person) {
        throw new HttpError(403, `Only ${dispatch.owner} can do that.`);
      }
      if (decision[2] === "result") {
        if (dispatch.status !== "delivered") throw new HttpError(409, "That request is not running.");
        dispatch.status = body.status === "failed" ? "failed" : "done";
        saveDispatch(dispatch);
        addMessage(dispatch.agent, "agent", requireText(body.text, "text"));
        return { ok: true };
      }
      if (dispatch.status !== "pending") throw new HttpError(409, "That request was already handled.");
      if (decision[2] === "approve") {
        dispatch.status = "approved";
        dispatch.approvedBy = person;
        saveDispatch(dispatch);
        deliver(dispatch);
      } else {
        dispatch.status = "declined";
        saveDispatch(dispatch);
      }
      return { ok: true };
    }
    throw new HttpError(404, "Not found.");
  };

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://room.local");
    if (process.env.ROOM_LOG) {
      const agent = (req.headers["user-agent"] ?? "").slice(0, 60);
      console.log(`${req.method} ${url.pathname} from ${req.headers["x-forwarded-for"] ?? "local"} ${agent}`);
    }
    const asset = req.method === "GET" ? STATIC_FILES[url.pathname] : undefined;
    if (asset) {
      res.writeHead(200, {
        "content-type": asset.type,
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy":
          "default-src 'self'; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'",
      });
      res.end(readFileSync(join(ROOT, asset.file)));
      return;
    }
    void (async () => {
      const header = req.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      const person = readPeople(dataDir)[hashToken(token)];
      if (!person) throw new HttpError(401, "This invite is not valid.");
      const result = await handleApi(req, res, url, person);
      if (result !== undefined) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      }
    })().catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: error instanceof HttpError ? error.message : "Server error." }),
      );
    });
  });
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dataDir = process.env.ROOM_DATA ?? join(ROOT, ".data");
  const port = Number(process.env.ROOM_PORT ?? 4780);
  const host = process.env.ROOM_HOST ?? "127.0.0.1";
  if (process.argv[2] === "invite") {
    const name = process.argv.slice(3).join(" ").trim();
    const token = invitePerson(dataDir, name);
    const base = process.env.ROOM_URL ?? `http://${host}:${port}`;
    console.log(`Invite for ${name}. Anyone with this link acts as ${name}:`);
    console.log(`${base}/#invite=${token}`);
    console.log(`Connector token: ${token}`);
  } else {
    createRoomServer(dataDir).listen(port, host, () => {
      console.log(`Room running at http://${host}:${port}`);
    });
  }
}
