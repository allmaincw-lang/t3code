import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SAMPLE_RATE = 24_000;
const MAX_SPOKEN = 240;

// Short spoken version of a reply: no code or links, at most two sentences.
export const shorten = (text: string) => {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_#>~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = plain.split(/(?<=[.!?])\s+/);
  let spoken = sentences.slice(0, 2).join(" ").trim();
  if (spoken.length > MAX_SPOKEN) spoken = `${spoken.slice(0, MAX_SPOKEN).replace(/\s+\S*$/, "")}...`;
  return spoken;
};

// Returns the samples of the WAV's data chunk.
export const wavToPcm = (wav: Buffer) => {
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") {
      const bytes = wav.subarray(offset + 8, Math.min(wav.length, offset + 8 + size));
      return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length - (bytes.length % 2)));
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("No audio data in the speech file.");
};

// macOS `say` writes a mono 16-bit file. Free and on-device.
export const synthesize = async (text: string, voice?: string) => {
  const dir = await mkdtemp(join(tmpdir(), "room-bot-"));
  const file = join(dir, "speech.wav");
  try {
    await new Promise<void>((resolve, reject) =>
      execFile(
        "say",
        [...(voice ? ["-v", voice] : []), "-o", file, "--file-format=WAVE", `--data-format=LEI16@${SAMPLE_RATE}`, "--", text],
        (error) => (error ? reject(error) : resolve()),
      ),
    );
    return wavToPcm(await readFile(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
