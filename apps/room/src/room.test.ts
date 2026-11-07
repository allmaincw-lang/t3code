import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  appendNote,
  MAX_EXCERPT,
  MAX_FILE,
  MAX_NOTE,
  memoryFile,
  parseRemember,
  readExcerpt,
} from "./memory.ts";
import { createRoomServer, invitePerson } from "./server.ts";

let dataDir: string;
let server: Server;
let base: string;
let owner: string;
let guest: string;
const openStreams: AbortController[] = [];

const post = (token: string, path: string, body: unknown = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const openEvents = async (token: string, query = "") => {
  const controller = new AbortController();
  openStreams.push(controller);
  const res = await fetch(`${base}/api/events${query}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  return {
    next: async (type: string) => {
      while (true) {
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (let index = 0; index < lines.length; index += 1) {
          if (lines[index] === "") continue;
          const event = JSON.parse(lines[index]!);
          if (event.type === type) {
            buffer = [...lines.slice(index + 1), buffer].join("\n");
            return event.data;
          }
        }
        const { value, done } = await reader.read();
        if (done) throw new Error(`Stream ended waiting for ${type}`);
        buffer += value;
      }
    },
  };
};

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "room-test-"));
  owner = invitePerson(dataDir, "Chase");
  guest = invitePerson(dataDir, "Partner");
  server = createRoomServer(dataDir);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  for (const controller of openStreams) controller.abort();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
});

test("rejects requests without a valid invite", async () => {
  assert.equal((await post("wrong", "/api/messages", { text: "hi" })).status, 401);
  assert.equal((await fetch(`${base}/api/events`)).status, 401);
});

test("names come from the invite, not the request", async () => {
  const stream = await openEvents(guest);
  await stream.next("snapshot");
  await post(guest, "/api/messages", { text: "hello", author: "Chase" });
  const message = await stream.next("message");
  assert.equal(message.author, "Partner");
});

test("a teammate's mention waits for the owner and only the owner can approve", async () => {
  const connector = await openEvents(owner, "?machine=Mac");
  await connector.next("snapshot");
  await post(owner, "/api/agents", { machine: "Mac", agents: [{ name: "codex" }] });

  const res = await post(guest, "/api/messages", { text: "@codex delete everything" });
  assert.equal(res.status, 200);
  const pending = await connector.next("dispatch");
  assert.equal(pending.status, "pending");
  assert.equal(pending.approvedBy, null);

  assert.equal((await post(guest, `/api/dispatches/${pending.id}/approve`)).status, 403);
  assert.equal((await post(owner, `/api/dispatches/${pending.id}/approve`)).status, 200);
  const run = await connector.next("run");
  assert.equal(run.id, pending.id);
  assert.equal(run.approvedBy, "Chase");
  assert.equal((await post(owner, `/api/dispatches/${pending.id}/approve`)).status, 409);

  assert.equal(
    (await post(guest, `/api/dispatches/${pending.id}/result`, { text: "fake" })).status,
    403,
  );
  assert.equal((await post(owner, `/api/dispatches/${pending.id}/result`, { text: "done" })).status, 200);
});

test("the owner's own mention runs without a prompt", async () => {
  const connector = await openEvents(owner, "?machine=Mac2");
  await connector.next("snapshot");
  await post(owner, "/api/agents", { machine: "Mac2", agents: [{ name: "claude" }] });
  await post(owner, "/api/messages", { text: "@claude hi" });
  const run = await connector.next("run");
  assert.equal(run.agent, "claude");
  assert.equal(run.approvedBy, "Chase");
});

test("a person cannot take over someone else's agent name", async () => {
  await post(owner, "/api/agents", { machine: "Mac", agents: [{ name: "grok" }] });
  const res = await post(guest, "/api/agents", { machine: "Theirs", agents: [{ name: "GROK" }] });
  assert.equal(res.status, 409);
});

test("declined requests never reach the connector", async () => {
  const connector = await openEvents(owner, "?machine=Mac3");
  await connector.next("snapshot");
  await post(owner, "/api/agents", { machine: "Mac3", agents: [{ name: "pi" }] });
  await post(guest, "/api/messages", { text: "@pi do it" });
  const pending = await connector.next("dispatch");
  assert.equal((await post(owner, `/api/dispatches/${pending.id}/decline`)).status, 200);
  assert.equal((await connector.next("dispatch")).status, "declined");
  assert.equal((await post(owner, `/api/dispatches/${pending.id}/approve`)).status, 409);
});

test("signals only flow from your own connection", async () => {
  const mine = await openEvents(owner);
  const snapshot = await mine.next("snapshot");
  const res = await post(guest, "/api/signal", {
    from: snapshot.connectionId,
    to: snapshot.connectionId,
    data: {},
  });
  assert.equal(res.status, 404);
});

test("chat history survives a restart", async () => {
  await post(owner, "/api/messages", { text: "remember me" });
  const restarted = createRoomServer(dataDir);
  await new Promise<void>((resolve) => restarted.listen(0, "127.0.0.1", resolve));
  const port = (restarted.address() as AddressInfo).port;
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
    headers: { authorization: `Bearer ${owner}` },
    signal: controller.signal,
  });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const { value } = await reader.read();
  assert.match(value!, /remember me/);
  controller.abort();
  restarted.closeAllConnections();
  await new Promise((resolve) => restarted.close(resolve));
});

test("LiveKit tokens need an invite and a configured server", async () => {
  assert.equal((await post("wrong", "/api/livekit/token")).status, 401);
  assert.equal((await post(owner, "/api/livekit/token")).status, 503);

  const secretFile = join(dataDir, "livekit-secret");
  writeFileSync(secretFile, "test-secret\n");
  process.env.ROOM_LIVEKIT_URL = "wss://lk.example.test";
  process.env.ROOM_LIVEKIT_KEY = "test-key";
  process.env.ROOM_LIVEKIT_SECRET_FILE = secretFile;
  try {
    const before = Math.floor(Date.now() / 1000);
    const res = await post(guest, "/api/livekit/token");
    assert.equal(res.status, 200);
    const { url, token, room } = await res.json();
    assert.equal(url, "wss://lk.example.test");
    assert.equal(room, "room");

    const [header, payload, signature] = token.split(".");
    assert.equal(
      signature,
      createHmac("sha256", "test-secret").update(`${header}.${payload}`).digest("base64url"),
    );
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
      alg: "HS256",
      typ: "JWT",
    });
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    assert.equal(claims.iss, "test-key");
    assert.equal(claims.name, "Partner");
    assert.match(claims.sub, /^Partner-/);
    assert.ok(claims.exp - before >= 6 * 3600 && claims.exp - before <= 6 * 3600 + 5);
    assert.deepEqual(claims.video, {
      roomJoin: true,
      room: "room",
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const again = await (await post(guest, "/api/livekit/token")).json();
    const sub = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()).sub;
    assert.notEqual(sub(again.token), claims.sub);
  } finally {
    delete process.env.ROOM_LIVEKIT_URL;
    delete process.env.ROOM_LIVEKIT_KEY;
    delete process.env.ROOM_LIVEKIT_SECRET_FILE;
  }
});

test("local speech is off until a key file is set up", async () => {
  const status = await fetch(`${base}/api/transcribe/status`, {
    headers: { authorization: `Bearer ${owner}` },
  });
  assert.deepEqual(await status.json(), { available: false });
  const res = await fetch(`${base}/api/transcribe`, {
    method: "POST",
    headers: { authorization: `Bearer ${owner}` },
    body: new Float32Array(16),
  });
  assert.equal(res.status, 503);
});

test("speech is forwarded to T3 with its framing and key, and kept private", async () => {
  const seen: { auth?: string; path?: string; body: Buffer }[] = [];
  const t3 = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    seen.push({ auth: req.headers.authorization, path: req.url, body: Buffer.concat(chunks) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: "hello room" }));
  });
  await new Promise<void>((resolve) => t3.listen(0, "127.0.0.1", resolve));
  const keyFile = join(dataDir, "voice.token");
  writeFileSync(keyFile, "t3-secret\n");
  const voiceRoom = createRoomServer(dataDir, {
    t3Url: `http://127.0.0.1:${(t3.address() as AddressInfo).port}`,
    tokenFile: keyFile,
  });
  await new Promise<void>((resolve) => voiceRoom.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(voiceRoom.address() as AddressInfo).port}/api/transcribe`;
  const send = (token: string, body: BodyInit) =>
    fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` }, body });

  try {
    const pcm = new Float32Array([0.25, -0.5, 1]);
    const ok = await send(owner, pcm);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { text: "hello room" });
    const [call] = seen;
    assert.equal(call!.path, "/api/voice/transcribe");
    assert.equal(call!.auth, "Bearer t3-secret");
    const length = call!.body.readUInt32LE(0);
    const options = JSON.parse(call!.body.subarray(4, 4 + length).toString("utf8"));
    assert.equal(options.speechLanguage, "auto");
    assert.deepEqual(call!.body.subarray(4 + length), Buffer.from(pcm.buffer));

    const status = await fetch(`${url}/status`, { headers: { authorization: `Bearer ${owner}` } });
    assert.deepEqual(await status.json(), { available: true });

    assert.equal((await send("wrong", pcm)).status, 401);
    assert.equal((await send(owner, new Uint8Array(0))).status, 400);
    assert.equal((await send(owner, new Uint8Array(7))).status, 400);
    assert.equal((await send(owner, new Uint8Array(16_000 * 4 * 300 + 4))).status, 413);
    assert.equal(seen.length, 1);

    const t3Down = createRoomServer(dataDir, { t3Url: "http://127.0.0.1:1", tokenFile: keyFile });
    await new Promise<void>((resolve) => t3Down.listen(0, "127.0.0.1", resolve));
    const down = await fetch(
      `http://127.0.0.1:${(t3Down.address() as AddressInfo).port}/api/transcribe`,
      { method: "POST", headers: { authorization: `Bearer ${owner}` }, body: pcm },
    );
    assert.equal(down.status, 502);
    assert.doesNotMatch(JSON.stringify(await down.json()), /t3-secret/);
    t3Down.closeAllConnections();
    await new Promise((resolve) => t3Down.close(resolve));
  } finally {
    voiceRoom.closeAllConnections();
    t3.closeAllConnections();
    await new Promise((resolve) => voiceRoom.close(resolve));
    await new Promise((resolve) => t3.close(resolve));
  }
});

test("meeting actions use the invite's identity and own connection", async () => {
  const mine = await openEvents(owner);
  const { connectionId } = await mine.next("snapshot");
  const watcher = await openEvents(guest);
  await watcher.next("snapshot");

  assert.equal((await post(guest, "/api/meeting", { connectionId, hand: true })).status, 404);
  assert.equal((await post(guest, "/api/react", { connectionId, emoji: "👍" })).status, 404);
  assert.equal((await post(owner, "/api/meeting", { connectionId: "nope", hand: true })).status, 404);

  assert.equal((await post(owner, "/api/meeting", { connectionId, hand: true, person: "Partner" })).status, 200);
  const raised = await watcher.next("meeting");
  assert.deepEqual(raised.filter((entry: { hand: boolean }) => entry.hand).map((e: { id: string }) => e.id), [connectionId]);

  await post(owner, "/api/react", { connectionId, emoji: "🎉", person: "Partner" });
  const reaction = await watcher.next("reaction");
  assert.deepEqual(reaction, { connectionId, person: "Chase", emoji: "🎉" });

  assert.equal((await post(owner, "/api/meeting", { connectionId, hand: false })).status, 200);
  const lowered = await watcher.next("meeting");
  assert.equal(lowered.some((entry: { id: string }) => entry.id === connectionId), false);
});

test("hands clear when someone disconnects", async () => {
  const leaver = new AbortController();
  openStreams.push(leaver);
  const res = await fetch(`${base}/api/events`, {
    headers: { authorization: `Bearer ${guest}` },
    signal: leaver.signal,
  });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const first = JSON.parse((await reader.read()).value!.split("\n")[0]!);
  const id = first.data.connectionId;
  const watcher = await openEvents(owner);
  await watcher.next("snapshot");

  await post(guest, "/api/meeting", { connectionId: id, hand: true });
  assert.equal((await watcher.next("meeting")).some((e: { id: string }) => e.id === id), true);
  leaver.abort();
  assert.equal((await watcher.next("meeting")).some((e: { id: string }) => e.id === id), false);
  const fresh = await openEvents(owner);
  assert.equal((await fresh.next("snapshot")).meeting.some((e: { id: string }) => e.id === id), false);
});

test("leaving the call lowers the hand and clears mute", async () => {
  const mine = await openEvents(owner);
  const { connectionId } = await mine.next("snapshot");
  await post(owner, "/api/meeting", { connectionId, muted: true });
  assert.equal((await mine.next("meeting")).length, 0, "mute is ignored outside a call");
  await post(owner, "/api/call", { connectionId, inCall: true });
  await post(owner, "/api/meeting", { connectionId, hand: true, muted: true });
  const inCall = (await mine.next("meeting")).find((e: { id: string }) => e.id === connectionId);
  assert.deepEqual(inCall, { id: connectionId, hand: true, muted: true });
  await post(owner, "/api/call", { connectionId, inCall: false });
  assert.deepEqual(await mine.next("meeting"), []);
});

test("reaction and hand input is validated", async () => {
  const mine = await openEvents(owner);
  const { connectionId } = await mine.next("snapshot");
  for (const emoji of ["<script>", "", 7, null, "👍👍", "🖕"]) {
    assert.equal((await post(owner, "/api/react", { connectionId, emoji })).status, 400, String(emoji));
  }
  assert.equal((await post(owner, "/api/meeting", { connectionId, hand: "yes" })).status, 400);
  assert.equal((await post(owner, "/api/meeting", { connectionId, muted: 1 })).status, 400);
  assert.equal((await post(owner, "/api/react", { connectionId, emoji: "👏" })).status, 200);
  assert.equal((await post(owner, "/api/react", { connectionId, emoji: "👏" })).status, 429);
});

test("memory is keyed by room and project so nothing leaks between them", () => {
  const dir = mkdtempSync(join(tmpdir(), "room-memory-"));
  try {
    appendNote(dir, "Room A", "proj", "Chase", "alpha secret");
    appendNote(dir, "Room B", "proj", "Chase", "beta secret");
    appendNote(dir, "Room A", "other", "Chase", "gamma secret");
    assert.match(readExcerpt(dir, "Room A", "proj"), /alpha/);
    assert.doesNotMatch(readExcerpt(dir, "Room A", "proj"), /beta|gamma/);
    assert.equal(readExcerpt(dir, "Room C", "proj"), "");
    // Names that normalize alike still get separate files, and none can escape the folder.
    assert.notEqual(memoryFile(dir, "A b", "p"), memoryFile(dir, "a-b", "p"));
    assert.ok(memoryFile(dir, "../../etc", "../x").startsWith(dir));
    assert.match(readFileSync(memoryFile(dir, "Room A", "proj"), "utf8"), /^---\nroom: "Room A"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory notes and excerpts are size capped", () => {
  const dir = mkdtempSync(join(tmpdir(), "room-memory-"));
  try {
    appendNote(dir, "r", "p", "Chase", `${"x".repeat(MAX_NOTE * 3)}\nsecond line`);
    assert.ok(readFileSync(memoryFile(dir, "r", "p"), "utf8").split("\n").every((l) => l.length < MAX_NOTE + 60));
    for (let i = 0; i < 20; i += 1) appendNote(dir, "r", "p", "Chase", `note ${i} ${"y".repeat(300)}`);
    const excerpt = readExcerpt(dir, "r", "p");
    assert.ok(excerpt.length <= MAX_EXCERPT);
    assert.match(excerpt, /note 19/);
    assert.doesNotMatch(excerpt, /note 0 /);
    assert.throws(() => {
      for (let i = 0; i < MAX_FILE / 100; i += 1) appendNote(dir, "r", "p", "Chase", "z".repeat(400));
    }, /full/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseRemember only matches messages that start with remember:", () => {
  assert.deepEqual(parseRemember("remember: use tabs"), { mentions: [], note: "use tabs" });
  assert.deepEqual(parseRemember("@Codex @pi Remember:  ship Friday "), {
    mentions: ["codex", "pi"],
    note: "ship Friday",
  });
  assert.equal(parseRemember("please remember: x"), null);
  assert.equal(parseRemember("remember me"), null);
  assert.equal(parseRemember("remember:   "), null);
});

test("only the owner can turn memory on, and only on a machine that offers it", async () => {
  const connector = await openEvents(owner, "?machine=MacM");
  await connector.next("snapshot");
  await post(owner, "/api/agents", { machine: "MacM", agents: [{ name: "memo", memory: true }, { name: "nomem" }] });
  await connector.next("agent");
  await connector.next("agent");
  assert.equal((await post(guest, "/api/agents/memo/memory", { enabled: true })).status, 403);
  assert.equal((await post(owner, "/api/agents/nomem/memory", { enabled: true })).status, 409);
  assert.equal((await post(owner, "/api/agents/nope/memory", { enabled: true })).status, 404);

  // Off by default: the owner's note is refused and nothing reaches the connector.
  const stream = await openEvents(owner);
  await stream.next("snapshot");
  await post(owner, "/api/messages", { text: "remember: before enabling" });
  await post(owner, "/api/messages", { text: "@memo remember: also too early" });
  assert.equal((await stream.next("message")).text, "remember: before enabling");
  assert.equal((await stream.next("message")).text, "@memo remember: also too early");
  assert.match((await stream.next("message")).text, /Memory is off for memo/);

  assert.equal((await post(owner, "/api/agents/memo/memory", { enabled: true })).status, 200);
  const enabled = await connector.next("agent");
  assert.equal(enabled.memoryOn, true);
  assert.equal(enabled.memoryAvailable, true);

  // A guest's note is plain chat: no memory write, and the mention still waits for approval.
  await post(guest, "/api/messages", { text: "@memo remember: guest note" });
  assert.equal((await connector.next("dispatch")).status, "pending");

  await post(owner, "/api/messages", { text: "remember: prefers tabs" });
  assert.deepEqual(await connector.next("remember"), { agent: "memo", by: "Chase", text: "prefers tabs" });
  await post(owner, "/api/messages", { text: "@memo remember: second" });
  assert.equal((await connector.next("remember")).text, "second");

  // Re-registering the agent keeps the owner's choice.
  await post(owner, "/api/agents", { machine: "MacM", agents: [{ name: "memo", memory: true }] });
  assert.equal((await connector.next("agent")).memoryOn, true);
  assert.equal((await post(owner, "/api/agents/memo/memory", { enabled: false })).status, 200);
  assert.equal((await connector.next("agent")).memoryOn, false);
});

test("natural speech is proxied to the local voice service only for invited people", async () => {
  const seen: string[] = [];
  const service = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    seen.push(`${req.method} ${req.url} ${Buffer.concat(chunks).toString()}`);
    if (req.url === "/voices") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ voices: ["af_heart"], default: "af_heart" }));
      return;
    }
    res.writeHead(200, { "content-type": "audio/wav" });
    res.end(Buffer.from("RIFFfake"));
  });
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  assert.equal((await post(owner, "/api/tts", { text: "hi" })).status, 503);
  process.env.ROOM_TTS_URL = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
  try {
    assert.equal((await post("wrong", "/api/tts", { text: "hi" })).status, 401);
    assert.equal((await post(owner, "/api/tts", { text: "  " })).status, 400);
    const res = await post(owner, "/api/tts", { text: "hello there", voice: "af_heart" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "audio/wav");
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "RIFFfake");
    const voices = await fetch(`${base}/api/tts/voices`, { headers: { authorization: `Bearer ${owner}` } });
    assert.deepEqual(await voices.json(), { available: true, voices: ["af_heart"], default: "af_heart" });
    assert.ok(seen.some((line) => line.includes('"text":"hello there"')));
  } finally {
    delete process.env.ROOM_TTS_URL;
    service.closeAllConnections();
    await new Promise((resolve) => service.close(resolve));
  }
});

test("static files never escape public and unknown types are not served", async () => {
  assert.equal((await fetch(`${base}/workspace.js`)).status, 200);
  for (const path of ["/../src/server.ts", "/%2e%2e/src/server.ts", "/..%2fsrc%2fserver.ts", "/people.json"]) {
    assert.notEqual((await fetch(`${base}${path}`)).status, 200, path);
  }
});

test("shared documents replay their history and broadcast new updates", async () => {
  const stream = await openEvents(guest);
  await stream.next("snapshot");
  assert.equal((await post(owner, "/api/sync", { doc: "../escape", update: "AAAA" })).status, 400);
  assert.equal((await post(owner, "/api/sync", { doc: "code:main", update: "not base64!" })).status, 400);
  assert.equal((await post("wrong", "/api/sync", { doc: "code:main", update: "AAAA" })).status, 401);
  assert.equal((await post(owner, "/api/sync", { doc: "code:main", update: "AQID", from: "c1" })).status, 200);
  const event = await stream.next("sync");
  assert.deepEqual(event, { doc: "code:main", update: "AQID", from: "c1", by: "Chase" });
  await post(owner, "/api/sync", { doc: "code:main", update: "BAUG" });
  const load = await (await post(guest, "/api/sync/load", { doc: "code:main" })).json();
  assert.deepEqual(load.updates, ["AQID", "BAUG"]);
  assert.equal((await post(guest, "/api/sync/compact", { doc: "code:main", snapshot: "BwgJ" })).status, 200);
  assert.deepEqual((await (await post(owner, "/api/sync/load", { doc: "code:main" })).json()).updates, ["BwgJ"]);
});

// Code tab: the shared working copy.
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();

const withCodeRoot = async (run: (root: string, outside: string) => Promise<void>) => {
  const outside = mkdtempSync(join(tmpdir(), "room-code-"));
  const root = join(outside, "work");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "top secret");
  writeFileSync(join(root, "src", "app.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "big.txt"), "x".repeat(1024 * 1024 + 1));
  writeFileSync(join(root, "blob.dat"), Buffer.from([1, 2, 0, 3]));
  writeFileSync(join(root, "latin.txt"), Buffer.from([0x68, 0xe9, 0x6c]));
  writeFileSync(join(root, ".env"), "KEY=1");
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "node_modules", "x.js"), "1");
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
  symlinkSync(outside, join(root, "linkdir"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Setup");
  git(root, "config", "user.email", "setup@example.com");
  const previous = process.env.ROOM_CODE_ROOT;
  process.env.ROOM_CODE_ROOT = root;
  try {
    await run(root, outside);
  } finally {
    if (previous === undefined) delete process.env.ROOM_CODE_ROOT;
    else process.env.ROOM_CODE_ROOT = previous;
    rmSync(outside, { recursive: true, force: true });
  }
};

test("code routes need ROOM_CODE_ROOT", async () => {
  const previous = process.env.ROOM_CODE_ROOT;
  delete process.env.ROOM_CODE_ROOT;
  try {
    assert.equal((await post(owner, "/api/code/tree")).status, 503);
  } finally {
    if (previous !== undefined) process.env.ROOM_CODE_ROOT = previous;
  }
});

test("code paths stay inside the root, including through symlinks", async () => {
  await withCodeRoot(async (root, outside) => {
    for (const path of ["../secret.txt", "/etc/passwd", "src/../../secret.txt", "link.txt", "linkdir/secret.txt", ".env", ".git/config", "node_modules/x.js", "src//app.ts", "a\\b"]) {
      const open = await post(owner, "/api/code/open", { path });
      assert.ok([400, 403, 404].includes(open.status), `open ${path} -> ${open.status}`);
      const save = await post(owner, "/api/code/save", { path, text: "pwned" });
      assert.ok([400, 403, 404].includes(save.status), `save ${path} -> ${save.status}`);
    }
    assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "top secret");
    const tree = (await (await post(owner, "/api/code/tree")).json()) as { files: Array<{ path: string }> };
    assert.deepEqual(tree.files.map((file) => file.path), ["latin.txt", "src/app.ts"]);
  });
});

test("code files over 1 MB or binary are refused", async () => {
  await withCodeRoot(async () => {
    assert.equal((await post(owner, "/api/code/open", { path: "big.txt" })).status, 413);
    assert.equal((await post(owner, "/api/code/open", { path: "blob.dat" })).status, 415);
    assert.equal((await post(owner, "/api/code/open", { path: "latin.txt" })).status, 415);
    const tooBig = await post(owner, "/api/code/save", { path: "src/app.ts", text: "y".repeat(1024 * 1024 + 1) });
    assert.equal(tooBig.status, 413);
  });
});

test("opening and saving a file round-trips, and only one opener seeds it", async () => {
  await withCodeRoot(async (root) => {
    const open = (token: string, from: string) =>
      post(token, "/api/code/open", { path: "src/app.ts", from }).then((res) => res.json()) as Promise<{
        doc: string;
        text: string;
        seed: boolean;
      }>;
    const [a, b] = await Promise.all([open(owner, "conn-a"), open(guest, "conn-b")]);
    assert.match(a.doc, /^[a-z0-9][a-z0-9:._-]{0,119}$/i);
    assert.equal(a.doc, b.doc);
    assert.equal(a.text, "export const a = 1;\n");
    assert.equal([a.seed, b.seed].filter(Boolean).length, 1);
    const again = await open(guest, "conn-c");
    assert.equal(again.seed, false);

    await post(owner, "/api/sync", { doc: a.doc, update: "AAE=", from: "conn-a" });
    assert.equal((await open(guest, "conn-d")).seed, false);

    const saved = await post(guest, "/api/code/save", { path: "src/app.ts", text: "export const a = 2;\n" });
    assert.equal(saved.status, 200);
    assert.equal(readFileSync(join(root, "src", "app.ts"), "utf8"), "export const a = 2;\n");
  });
});

test("commit is made by the Room person and stays inside the worktree", async () => {
  await withCodeRoot(async (root) => {
    git(root, "add", "src");
    git(root, "commit", "-qm", "base");
    await post(owner, "/api/code/save", { path: "src/app.ts", text: "export const a = 3;\n" });
    writeFileSync(join(root, "src", "new.ts"), "export {};\n");
    const status = (await (await post(owner, "/api/code/status")).json()) as { changes: Array<{ path: string }> };
    assert.ok(status.changes.some((change) => change.path === "src/new.ts"));
    assert.ok(!status.changes.some((change) => change.path.includes(".env")));

    assert.equal((await post(owner, "/api/code/commit", { message: " " })).status, 400);
    const done = await post(owner, "/api/code/commit", { message: "Tweak app" });
    assert.equal(done.status, 200);
    assert.equal(git(root, "log", "-1", "--format=%an|%s"), "Chase|Tweak app");
    assert.equal(git(root, "ls-files", ".env"), "");
    assert.equal(git(root, "status", "--porcelain", "--", "src"), "");
    assert.equal((await post(owner, "/api/code/commit", { message: "again" })).status, 409);
  });

  // A folder inside a bigger repo is refused, so a commit can never reach files outside it.
  const outer = mkdtempSync(join(tmpdir(), "room-code-outer-"));
  const previous = process.env.ROOM_CODE_ROOT;
  try {
    git(outer, "init", "-q");
    git(outer, "config", "user.name", "Setup");
    git(outer, "config", "user.email", "setup@example.com");
    mkdirSync(join(outer, "inner"));
    writeFileSync(join(outer, "inner", "a.ts"), "1");
    writeFileSync(join(outer, "elsewhere.txt"), "1");
    process.env.ROOM_CODE_ROOT = join(outer, "inner");
    assert.equal((await post(owner, "/api/code/commit", { message: "nope" })).status, 409);
    assert.equal(git(outer, "diff", "--cached", "--name-only"), "");
  } finally {
    if (previous === undefined) delete process.env.ROOM_CODE_ROOT;
    else process.env.ROOM_CODE_ROOT = previous;
    rmSync(outer, { recursive: true, force: true });
  }
});
// Agent mail: a fake `gh` that records its arguments and stdin, never talks to GitHub.
const fakeGh = (dir: string, fixtures: unknown) => {
  const script = join(dir, "gh");
  writeFileSync(
    script,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = args.includes("-") ? fs.readFileSync(0, "utf8") : "";
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, stdin }) + "\\n");
const fx = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURES, "utf8"));
if (args[0] === "issue" && args[1] === "list") console.log(JSON.stringify(fx.list[args[args.indexOf("--label") + 1]] ?? []));
else if (args[0] === "issue" && args[1] === "view") {
  if (!fx.view[args[2]]) { console.error("GraphQL: Could not resolve to an issue"); process.exit(1); }
  console.log(JSON.stringify(fx.view[args[2]]));
} else if (args[0] === "issue" && args[1] === "create") console.log("https://github.com/o/r/issues/42");
else if (args[0] === "issue" && args[1] === "comment") console.log("https://github.com/o/r/issues/7#issuecomment-1");
else process.exit(2);
`,
    { mode: 0o755 },
  );
  writeFileSync(join(dir, "fixtures.json"), JSON.stringify(fixtures));
  return {
    log: () =>
      readFileSync(join(dir, "gh.log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { args: string[]; stdin: string }),
  };
};

const withFakeGh = async (fixtures: unknown, body: (gh: ReturnType<typeof fakeGh>) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "room-gh-"));
  writeFileSync(join(dir, "gh.log"), "");
  const gh = fakeGh(dir, fixtures);
  const saved = { path: process.env.PATH, repo: process.env.ROOM_MAIL_REPO };
  process.env.PATH = `${dir}:${saved.path}`;
  process.env.ROOM_MAIL_REPO = "owner/agent-mail";
  process.env.FAKE_GH_LOG = join(dir, "gh.log");
  process.env.FAKE_GH_FIXTURES = join(dir, "fixtures.json");
  try {
    await body(gh);
  } finally {
    process.env.PATH = saved.path;
    if (saved.repo === undefined) delete process.env.ROOM_MAIL_REPO;
    else process.env.ROOM_MAIL_REPO = saved.repo;
    rmSync(dir, { recursive: true, force: true });
  }
};

const label = (name: string) => ({ name });
const mailFixtures = {
  list: {
    "agent-mail": [
      { number: 8, title: "[chase-claude→all] Claim: x", url: "u8", updatedAt: "2026-01-01T00:00:00Z", labels: [label("agent-mail"), label("claim"), label("to:all")] },
      { number: 3, title: "[a→b] Q", url: "u3", updatedAt: "2026-01-01T00:00:00Z", labels: [label("agent-mail"), label("to:b-codex"), label("to:all")] },
      { number: 1, title: "Agent directory", url: "u1", labels: [label("agent-mail"), label("directory"), label("to:b-codex")] },
    ],
    claim: [
      {
        number: 8,
        title: "[chase-claude→all] Claim: invite links",
        url: "u8",
        body: "**From:** chase-claude\n**To:** all\n\n**Task:** t\n**Files:** `apps/room/src/{server,service}.ts`, `packages/contract/PROTOCOL.md`, `apps/web/src/`\n**Branch:** `feat/invite-links`\n**Status:** x\n",
      },
      { number: 9, title: "[z→all] Claim: bare", url: "u9", body: "**Files:** a.ts, b/{c,d}.ts\n**Branch:** none\n" },
    ],
  },
  view: {
    "7": { number: 7, title: "[sam-codex→chase-claude] Topic", state: "OPEN", url: "u7", body: "b", labels: [label("agent-mail")], comments: [{ author: { login: "x" }, body: "hi", createdAt: "2026-01-01T00:00:00Z", url: "c" }] },
    "5": { number: 5, title: "Plain issue", state: "OPEN", url: "u5", labels: [label("bug")], comments: [] },
    "6": { number: 6, title: "[a→b] Old", state: "CLOSED", url: "u6", labels: [label("agent-mail")], comments: [] },
  },
};

test("agent mail is off without ROOM_MAIL_REPO and needs an invite", async () => {
  delete process.env.ROOM_MAIL_REPO;
  assert.equal((await post(owner, "/api/mail/threads")).status, 503);
  assert.equal((await post("wrong", "/api/mail/threads")).status, 401);
});

test("agent mail reads threads, inbox counts and parsed claims, and caches reads", async () => {
  await withFakeGh(mailFixtures, async (gh) => {
    const threads = await (await post(owner, "/api/mail/threads")).json();
    assert.equal(threads.me, "chase-room");
    assert.deepEqual(threads.inboxes, { all: 2, "b-codex": 1 });
    const claims = (await (await post(owner, "/api/mail/claims")).json()).claims;
    assert.deepEqual(claims[0], {
      number: 8,
      title: "[chase-claude→all] Claim: invite links",
      agent: "chase-claude",
      files: ["apps/room/src/server.ts", "apps/room/src/service.ts", "packages/contract/PROTOCOL.md", "apps/web/src/"],
      branch: "feat/invite-links",
      url: "u8",
    });
    assert.deepEqual(claims[1].files, ["a.ts", "b/c.ts", "b/d.ts"]);
    assert.equal(claims[1].agent, "z");
    assert.equal(claims[1].branch, "");
    const before = gh.log().length;
    await post(guest, "/api/mail/threads");
    await post(guest, "/api/mail/claims");
    assert.equal(gh.log().length, before, "second read comes from the cache");
    assert.deepEqual(gh.log()[0]!.args.slice(0, 4), ["issue", "list", "-R", "owner/agent-mail"]);
  });
});

test("the cache expires after about 30 seconds and a write clears it", async () => {
  const { createMail } = await import("./mail.ts");
  await withFakeGh(mailFixtures, async (gh) => {
    let clock = 0;
    const mail = createMail({ fail: (status, message) => new Error(`${status} ${message}`), now: () => clock });
    await mail("POST /api/mail/claims", {}, "Chase");
    clock = 29_000;
    await mail("POST /api/mail/claims", {}, "Chase");
    assert.equal(gh.log().length, 1);
    clock = 31_000;
    await mail("POST /api/mail/claims", {}, "Chase");
    assert.equal(gh.log().length, 2);
    await mail("POST /api/mail/reply", { number: 7, text: "hi" }, "Chase");
    await mail("POST /api/mail/claims", {}, "Chase");
    assert.equal(gh.log().filter((call) => call.args[1] === "list").length, 3);
  });
});

test("agent mail reply writes exactly one comment in the agent-mail format", async () => {
  await withFakeGh(mailFixtures, async (gh) => {
    const res = await post(owner, "/api/mail/reply", { number: 7, text: "Hello @sam-codex and @someone/team, mail a@b.co" });
    assert.equal(res.status, 200);
    const writes = gh.log().filter((call) => call.args[1] === "comment");
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0]!.args, ["issue", "comment", "7", "-R", "owner/agent-mail", "--body-file", "-"]);
    assert.equal(writes[0]!.stdin, "**From:** chase-room\n**To:** sam-codex, chase-claude\n\nHello sam-codex and someone/team, mail a@b.co\n");
    // The thread fetch that guards the write is fresh and limited to labels and state.
    assert.deepEqual(gh.log()[0]!.args, ["issue", "view", "7", "-R", "owner/agent-mail", "--json", "number,title,state,labels"]);
  });
});

test("agent mail refuses bad input and non-mail or closed threads without writing", async () => {
  await withFakeGh(mailFixtures, async (gh) => {
    for (const body of [
      { number: "7; rm -rf /", text: "x" },
      { number: 0, text: "x" },
      { number: 7.5, text: "x" },
      { number: 7, text: "   " },
      { number: 7, text: "x", to: ["Bad Name"] },
      { number: 7, text: "x", to: "--repo=evil" },
    ]) {
      assert.equal((await post(owner, "/api/mail/reply", body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await post(owner, "/api/mail/reply", { number: 5, text: "x" })).status, 404);
    assert.equal((await post(owner, "/api/mail/reply", { number: 6, text: "x" })).status, 409);
    assert.equal((await post(owner, "/api/mail/reply", { number: 99, text: "x" })).status, 404);
    assert.equal((await post(owner, "/api/mail/new", { title: "", body: "x" })).status, 400);
    assert.equal((await post(owner, "/api/mail/new", { title: "t", body: "x", inbox: "to:x y" })).status, 400);
    assert.equal((await post(owner, "/api/mail/new", { title: "t", body: "x", inbox: ["a", "b"] })).status, 400);
    assert.equal(gh.log().filter((call) => ["comment", "create"].includes(call.args[1]!)).length, 0);
    // Oversized text is capped, not rejected.
    await post(owner, "/api/mail/reply", { number: 7, text: "y".repeat(20_000) });
    const sent = gh.log().find((call) => call.args[1] === "comment")!;
    assert.ok(sent.stdin.length < 8_100);
  });
});

test("new threads pass titles and bodies as plain arguments, never through a shell", async () => {
  await withFakeGh(mailFixtures, async (gh) => {
    const nasty = '$(touch /tmp/pwned) `id` ; "quoted" \'x\' --label evil\nsecond line @chase-claude';
    const res = await post(owner, "/api/mail/new", { title: nasty, body: nasty, inbox: "sam-codex" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, number: 42, url: "https://github.com/o/r/issues/42", from: "chase-room", to: "sam-codex" });
    const [create] = gh.log();
    assert.deepEqual(create!.args, [
      "issue", "create", "-R", "owner/agent-mail",
      "--label", "agent-mail", "--label", "to:sam-codex",
      "--title", '[chase-room→sam-codex] $(touch /tmp/pwned) `id` ; "quoted" \'x\' --label evil second line chase-claude',
      "--body-file", "-",
    ]);
    assert.equal(create!.stdin, `**From:** chase-room\n**To:** sam-codex\n\n$(touch /tmp/pwned) \`id\` ; "quoted" 'x' --label evil\nsecond line chase-claude\n`);
  });
  await withFakeGh(mailFixtures, async (gh) => {
    await post(guest, "/api/mail/new", { title: "No tag", body: "b" });
    assert.deepEqual(gh.log()[0]!.args.slice(0, 6), ["issue", "create", "-R", "owner/agent-mail", "--label", "agent-mail"]);
    assert.ok(!gh.log()[0]!.args.some((arg) => arg.startsWith("to:")));
    assert.ok(gh.log()[0]!.args.includes("[partner-room→all] No tag"));
  });
});

test("gh failures become clean errors", async () => {
  await withFakeGh(mailFixtures, async () => {
    process.env.PATH = "/nonexistent";
    const res = await post(owner, "/api/mail/threads");
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /not installed/);
  });
});
