import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const TOKEN_TTL_SECONDS = 6 * 60 * 60;

export type LiveKitConfig = { url: string; key: string; secret: string };

// The secret is read from a file on every call so rotating it needs no restart and it never sits in env.
export const readLiveKitConfig = (env: NodeJS.ProcessEnv = process.env): LiveKitConfig | null => {
  const { ROOM_LIVEKIT_URL: url, ROOM_LIVEKIT_KEY: key, ROOM_LIVEKIT_SECRET_FILE: file } = env;
  if (!url || !key || !file) return null;
  try {
    const secret = readFileSync(file, "utf8").trim();
    return secret ? { url, key, secret } : null;
  } catch {
    return null;
  }
};

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

export const mintLiveKitToken = (
  config: LiveKitConfig,
  room: string,
  person: string,
  now = Date.now(),
): string => {
  const issuedAt = Math.floor(now / 1000);
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    iss: config.key,
    sub: `${person}-${randomUUID().slice(0, 8)}`,
    name: person,
    nbf: issuedAt,
    exp: issuedAt + TOKEN_TTL_SECONDS,
    video: {
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    },
  })}`;
  const signature = createHmac("sha256", config.secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
};
