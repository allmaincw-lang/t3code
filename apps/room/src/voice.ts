import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";

// Mirrors packages/shared/src/speech.ts: 16 kHz mono Float32 PCM, at most 5 minutes.
const SAMPLE_RATE = 16_000;
const MAX_PCM_BYTES = SAMPLE_RATE * Float32Array.BYTES_PER_ELEMENT * 5 * 60;
const TRANSCRIBE_TIMEOUT_MS = 120_000;
const DEFAULT_OPTIONS = {
  speechLanguage: "auto",
  speechTranslateToEnglish: false,
  speechCustomWords: [],
  speechRemoveFillerWords: true,
  speechSilenceFiltering: true,
};

export class VoiceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type VoiceConfig = { t3Url: string; tokenFile: string } | null;

export const voiceConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): VoiceConfig =>
  env.ROOM_T3_URL && env.ROOM_T3_VOICE_TOKEN_FILE
    ? { t3Url: env.ROOM_T3_URL, tokenFile: env.ROOM_T3_VOICE_TOKEN_FILE }
    : null;

// Read per request so the key can be created or rotated without restarting the room.
const readToken = (config: VoiceConfig): string | null => {
  if (!config) return null;
  try {
    return readFileSync(config.tokenFile, "utf8").trim() || null;
  } catch {
    return null;
  }
};

const readPcm = async (req: IncomingMessage): Promise<Buffer> => {
  if (Number(req.headers["content-length"]) > MAX_PCM_BYTES) {
    throw new VoiceError(413, "That recording is too long. The limit is 5 minutes.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_PCM_BYTES) {
      throw new VoiceError(413, "That recording is too long. The limit is 5 minutes.");
    }
    chunks.push(chunk);
  }
  if (size === 0 || size % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new VoiceError(400, "Expected 16 kHz mono Float32 audio.");
  }
  return Buffer.concat(chunks);
};

export const encodeTranscribeRequest = (pcm: Uint8Array): Buffer => {
  const options = Buffer.from(JSON.stringify(DEFAULT_OPTIONS), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(options.length, 0);
  return Buffer.concat([header, options, pcm]);
};

/** Returns undefined for routes this module does not own. */
export const handleVoice = async (
  config: VoiceConfig,
  route: string,
  req: IncomingMessage,
): Promise<unknown> => {
  if (route === "GET /api/transcribe/status") return { available: readToken(config) !== null };
  if (route !== "POST /api/transcribe") return undefined;

  const token = readToken(config);
  if (!config || !token) throw new VoiceError(503, "Local speech is not set up on this room.");
  const pcm = await readPcm(req);

  let upstream: Response;
  try {
    upstream = await fetch(new URL("/api/voice/transcribe", config.t3Url), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
      body: encodeTranscribeRequest(pcm),
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
  } catch {
    throw new VoiceError(502, "The room could not reach T3's speech engine.");
  }
  if (upstream.status === 401 || upstream.status === 403) {
    throw new VoiceError(502, "T3 rejected the room's speech key. Create a new one.");
  }
  if (!upstream.ok) throw new VoiceError(502, "T3's speech engine could not transcribe that.");
  const result = (await upstream.json().catch(() => null)) as { text?: unknown } | null;
  if (typeof result?.text !== "string") throw new VoiceError(502, "T3 sent back something unexpected.");
  return { text: result.text };
};
