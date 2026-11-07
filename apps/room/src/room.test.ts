import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
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
