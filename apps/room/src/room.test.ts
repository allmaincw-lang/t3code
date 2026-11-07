import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
