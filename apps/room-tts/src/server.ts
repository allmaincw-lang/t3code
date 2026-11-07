import { createServer, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const MAX_TEXT = 1_200;
const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_VOICE = process.env.TTS_VOICE ?? "af_heart";

env.cacheDir = process.env.TTS_CACHE ?? join(homedir(), ".connected-empire", "tts-cache");

const tts = await KokoroTTS.from_pretrained(MODEL, {
  dtype: (process.env.TTS_DTYPE as "fp32" | "q8" | undefined) ?? "fp32",
  device: "cpu",
});
const voices = new Set(Object.keys(tts.voices));

const toWav = (samples: Float32Array, rate: number) => {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};

// Kokoro handles about a paragraph at a time, so long replies are spoken sentence by sentence.
const sentences = (text: string) =>
  (text.match(/[^.!?\n]+[.!?]*|\n+/g) ?? [text]).map((s) => s.trim()).filter(Boolean);

let queue = Promise.resolve();
const speak = (text: string, voice: string) => {
  const run = queue.then(async () => {
    const parts: Float32Array[] = [];
    let rate = 24_000;
    for (const sentence of sentences(text)) {
      const audio = await tts.generate(sentence, { voice: voice as never });
      parts.push(audio.audio);
      rate = audio.sampling_rate;
    }
    const total = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      total.set(part, offset);
      offset += part.length;
    }
    return toWav(total, rate);
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

const readJson = async (req: IncomingMessage) => {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
};

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/voices") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ voices: [...voices], default: DEFAULT_VOICE }));
      return;
    }
    if (req.method === "POST" && req.url === "/speak") {
      const body = await readJson(req);
      const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_TEXT) : "";
      const voice = typeof body.voice === "string" && voices.has(body.voice) ? body.voice : DEFAULT_VOICE;
      if (!text) {
        res.writeHead(400).end();
        return;
      }
      const wav = await speak(text, voice);
      res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length });
      res.end(wav);
      return;
    }
    res.writeHead(404).end();
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(400);
    res.end();
  }
});

const port = Number(process.env.TTS_PORT ?? 4790);
server.listen(port, "127.0.0.1", () => {
  console.log(`Kokoro voice service on http://127.0.0.1:${port} (${voices.size} voices)`);
});
