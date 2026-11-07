import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

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
