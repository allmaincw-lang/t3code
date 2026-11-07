import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
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
