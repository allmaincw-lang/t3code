import assert from "node:assert/strict";
import { test } from "node:test";

import { shorten, wavToPcm } from "./speech.ts";

test("shortens replies to two plain sentences", () => {
  const text = "I fixed **the bug** in `room.ts`. See https://x.dev/y.\n```ts\nconst a = 1;\n```\nTests pass. Third sentence.";
  assert.equal(shorten(text), "I fixed the bug in room.ts. See Tests pass.");
  assert.equal(shorten("```code only```"), "");
  assert.ok(shorten("word ".repeat(200)).length <= 244);
});

test("reads the data chunk of a WAV file", () => {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.write("WAVE", 8);
  header.write("data", 36);
  header.writeUInt32LE(4, 40);
  const pcm = wavToPcm(Buffer.concat([header, Buffer.from([1, 0, 2, 0])]));
  assert.deepEqual([...pcm], [1, 2]);
});
