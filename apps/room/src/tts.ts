import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_TEXT = 1_200;

const serviceUrl = () => process.env.ROOM_TTS_URL || "";

const readJson = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

/** Speech from the local Kokoro service; returns "handled" after streaming audio itself. */
export const handleTts = async (
  route: string,
  req: IncomingMessage,
  res: ServerResponse,
  fail: (status: number, message: string) => Error,
): Promise<unknown> => {
  if (route !== "GET /api/tts/voices" && route !== "POST /api/tts") return undefined;
  const base = serviceUrl();
  if (route === "GET /api/tts/voices") {
    if (!base) return { available: false, voices: [] };
    try {
      const reply = await fetch(`${base}/voices`, { signal: AbortSignal.timeout(3_000) });
      if (!reply.ok) return { available: false, voices: [] };
      return { available: true, ...(await reply.json()) };
    } catch {
      return { available: false, voices: [] };
    }
  }
  if (!base) throw fail(503, "Natural voices are not set up on this room.");
  const body = await readJson(req);
  const text = typeof body?.text === "string" ? body.text.trim().slice(0, MAX_TEXT) : "";
  if (!text) throw fail(400, "text is required.");
  let reply: Response;
  try {
    reply = await fetch(`${base}/speak`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice: typeof body?.voice === "string" ? body.voice : undefined }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw fail(502, "The voice service is not answering.");
  }
  if (!reply.ok) throw fail(502, "The voice service could not speak that.");
  const audio = Buffer.from(await reply.arrayBuffer());
  res.writeHead(200, { "content-type": "audio/wav", "content-length": audio.length, "cache-control": "no-store" });
  res.end(audio);
  return "handled";
};
