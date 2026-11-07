import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { AudioFrame, AudioSource, LocalAudioTrack, Room, TrackPublishOptions, TrackSource } from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";
import { SAMPLE_RATE, shorten, synthesize } from "./speech.ts";

// One LiveKit participant per online Room agent. Status goes out as participant attributes, and
// replies are spoken with on-device text-to-speech. Bots start muted; a data message on the
// "bot-control" topic with {"muted": false} (optionally {"agent": "<name>"}) turns speech on.

const env = (name: string) => {
  const value = process.env[name];
  if (!value) {
    console.error(`Set ${name}. See README.md.`);
    process.exit(1);
  }
  return value;
};
const readFileEnv = (name: string) => readFileSync(env(name), "utf8").trim();

const roomUrl = env("ROOM_URL").replace(/\/?$/, "/");
const roomToken = readFileEnv("ROOM_TOKEN_FILE");
const livekitUrl = env("ROOM_LIVEKIT_URL");
const livekitKey = env("ROOM_LIVEKIT_KEY");
const livekitSecret = readFileEnv("ROOM_LIVEKIT_SECRET_FILE");
const livekitRoom = process.env.ROOM_LIVEKIT_ROOM ?? "room";
const speechOff = process.env.ROOM_BOT_SPEECH === "off";
const voice = process.env.ROOM_BOT_VOICE;
const BOT_MACHINE = "room-bot";
const RETRY_MS = 3_000;
const CONTROL_TOPIC = "bot-control";

type AgentInfo = { name: string; status: string; task: string | null; online: boolean };
type Bot = {
  name: string;
  room: Room;
  source: AudioSource;
  muted: boolean;
  speech: Promise<void>;
  status: string;
  attributes: Record<string, string>;
};

const bots = new Map<string, Bot>();
const key = (name: string) => name.toLowerCase();

const mintToken = (name: string) => {
  const token = new AccessToken(livekitKey, livekitSecret, {
    identity: `agent-${key(name)}`,
    name,
    attributes: { kind: "agent" },
    ttl: "6h",
  });
  token.addGrant({ roomJoin: true, room: livekitRoom, canPublish: true, canPublishData: true, canSubscribe: false, canUpdateOwnMetadata: true });
  return token.toJwt();
};

const publishAttributes = (bot: Bot, patch: Record<string, string>) => {
  bot.attributes = { ...bot.attributes, ...patch };
  return bot.room.localParticipant?.setAttributes(bot.attributes).catch((error: unknown) => console.error(error));
};

const statusLabel = (agent: AgentInfo) => (agent.status === "needs-approval" ? "needs approval" : agent.status);

const join = async (agent: AgentInfo) => {
  const room = new Room();
  const source = new AudioSource(SAMPLE_RATE, 1);
  const bot: Bot = { name: agent.name, room, source, muted: true, speech: Promise.resolve(), status: statusLabel(agent), attributes: {} };
  bots.set(key(agent.name), bot);
  try {
    await room.connect(livekitUrl, await mintToken(agent.name), { autoSubscribe: false });
    const track = LocalAudioTrack.createAudioTrack("voice", source);
    await room.localParticipant!.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
    await publishAttributes(bot, {
      kind: "agent",
      status: statusLabel(agent),
      task: agent.task ?? "",
      muted: String(bot.muted),
      speech: speechOff ? "off" : "on",
    });
    room.on("dataReceived", (payload, _participant, _kind, topic) => {
      if (topic !== CONTROL_TOPIC) return;
      try {
        const control = JSON.parse(new TextDecoder().decode(payload));
        if (control.agent && key(String(control.agent)) !== key(agent.name)) return;
        if (typeof control.muted === "boolean") {
          bot.muted = control.muted;
          void publishAttributes(bot, { muted: String(bot.muted) });
        }
      } catch {}
    });
    room.on("disconnected", () => {
      if (bots.get(key(agent.name)) === bot) bots.delete(key(agent.name));
    });
    console.log(`${agent.name} joined ${livekitRoom} (${statusLabel(agent)})`);
  } catch (error) {
    bots.delete(key(agent.name));
    await room.disconnect().catch(() => {});
    console.error(`${agent.name} could not join: ${String(error)}`);
  }
};

const leave = async (name: string) => {
  const bot = bots.get(key(name));
  if (!bot) return;
  bots.delete(key(name));
  await bot.source.close().catch(() => {});
  await bot.room.disconnect().catch(() => {});
  console.log(`${name} left`);
};

const speak = (bot: Bot, text: string) => {
  if (speechOff || bot.muted) return;
  const spoken = shorten(text);
  if (!spoken) return;
  bot.speech = bot.speech.then(async () => {
    try {
      const pcm = await synthesize(spoken, voice);
      await publishAttributes(bot, { speaking: "true", status: "speaking" });
      const frameSize = SAMPLE_RATE / 100;
      for (let at = 0; at < pcm.length; at += frameSize) {
        const chunk = pcm.subarray(at, at + frameSize);
        const data = new Int16Array(frameSize);
        data.set(chunk);
        await bot.source.captureFrame(new AudioFrame(data, SAMPLE_RATE, 1, frameSize));
      }
      await bot.source.waitForPlayout();
    } catch (error) {
      console.error(`${bot.name} could not speak: ${String(error)}`);
    }
    await publishAttributes(bot, { speaking: "false", status: bot.status });
  });
};

const sync = async (agent: AgentInfo) => {
  if (!agent.online) return leave(agent.name);
  const bot = bots.get(key(agent.name));
  if (!bot) return join(agent);
  bot.status = statusLabel(agent);
  await publishAttributes(bot, { status: bot.attributes.speaking === "true" ? "speaking" : bot.status, task: agent.task ?? "" });
};

const handleEvent = (type: string, data: any) => {
  if (type === "snapshot") {
    const online = new Set<string>();
    for (const agent of data.agents as AgentInfo[]) {
      if (agent.online) online.add(key(agent.name));
      void sync(agent);
    }
    for (const bot of [...bots.values()]) if (!online.has(key(bot.name))) void leave(bot.name);
  } else if (type === "agent") {
    void sync(data);
  } else if (type === "message" && data.kind === "agent") {
    const bot = bots.get(key(data.author));
    if (bot) speak(bot, data.text);
  }
};

const connect = async () => {
  const res = await fetch(`${roomUrl}api/events?machine=${BOT_MACHINE}`, {
    headers: { authorization: `Bearer ${roomToken}` },
  });
  if (!res.ok || !res.body) throw new Error(`Room refused the connection: ${res.status}`);
  console.log("Connected to the Room");
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line === "") continue;
      const event = JSON.parse(line);
      handleEvent(event.type, event.data);
    }
  }
};

const shutdown = async () => {
  await Promise.all([...bots.keys()].map(leave));
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

while (true) {
  await connect().catch((error: unknown) => console.error(String(error)));
  await sleep(RETRY_MS);
}
