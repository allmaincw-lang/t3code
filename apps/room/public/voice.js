// Records the microphone and transcribes it on the room's own T3 speech engine.
const SAMPLE_RATE = 16_000;
const MAX_SECONDS = 290;

const RECORDING_ERRORS = {
  NotAllowedError: "Microphone access is not allowed. Check this browser's settings.",
  NotFoundError: "No microphone was found.",
};

// Mono, 16 kHz, Float32: the engine's input format. A one-channel offline context mixes down.
const toPcm16k = async (blob) => {
  const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
  const context = new AudioCtx();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const offline = new OfflineAudioContext(
      1,
      Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE)),
      SAMPLE_RATE,
    );
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    return (await offline.startRendering()).getChannelData(0);
  } finally {
    context.close().catch(() => {});
  }
};

const record = async (onLimit) => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (event) => event.data.size > 0 && chunks.push(event.data);
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  const release = () => stream.getTracks().forEach((track) => track.stop());
  const limit = setTimeout(onLimit, MAX_SECONDS * 1000);
  recorder.start();
  return {
    finish: async () => {
      clearTimeout(limit);
      if (recorder.state !== "inactive") recorder.stop();
      await stopped;
      release();
      return new Blob(chunks, { type: recorder.mimeType });
    },
    cancel: () => {
      clearTimeout(limit);
      recorder.ondataavailable = null;
      if (recorder.state !== "inactive") recorder.stop();
      release();
    },
  };
};

const upload = async (token, pcm) => {
  const res = await fetch("./api/transcribe", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
    body: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
  });
  const result = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(result.error ?? "Transcription did not work.");
  return result.text;
};

/**
 * The stable speech API, also published as `window.roomVoice` by app.js.
 * `ready` resolves once `source` is known: "local" (T3's engine through this room) or "browser"
 * (not set up, so use the browser's own recognition). `start()` and `stop()` work only for "local".
 * `state` is "idle", "recording" or "transcribing". `stop()` resolves with the text, "" if no
 * speech, and rejects with a readable Error. `cancel()` discards a recording or pending result.
 * `onstatechange` is called with the new state.
 */
export const createRoomVoice = ({ token }) => {
  const supported = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  let session = null;
  let generation = 0;
  const api = {
    source: "browser",
    state: "idle",
    onstatechange: null,
    ready: null,
    start: async () => {
      if (api.source !== "local") throw new Error("Local speech is not available.");
      if (api.state !== "idle") throw new Error("Already recording.");
      try {
        session = await record(() => api.state === "recording" && api.stop().catch(() => {}));
      } catch (error) {
        throw new Error(RECORDING_ERRORS[error?.name] ?? error?.message ?? "Recording failed.");
      }
      setState("recording");
    },
    stop: async () => {
      if (api.state !== "recording") throw new Error("Not recording.");
      const active = session;
      const mine = generation;
      session = null;
      setState("transcribing");
      try {
        const text = (await upload(token, await toPcm16k(await active.finish()))).trim();
        return mine === generation ? text : "";
      } finally {
        if (mine === generation) setState("idle");
      }
    },
    cancel: () => {
      generation += 1;
      session?.cancel();
      session = null;
      setState("idle");
    },
  };
  const setState = (state) => {
    api.state = state;
    api.onstatechange?.(state);
  };
  api.ready = (async () => {
    if (!supported) return;
    try {
      const res = await fetch("./api/transcribe/status", {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.ok && (await res.json()).available === true) api.source = "local";
    } catch {}
  })();
  return api;
};

/** Wires the voice API to the composer's Talk button and draft. */
export const createDictation = ({ voice, input, button, notify }) => {
  voice.onstatechange = (state) => {
    button.textContent = { idle: "Talk", recording: "Stop", transcribing: "Transcribing..." }[state];
    button.setAttribute("aria-pressed", String(state === "recording"));
    button.disabled = state === "transcribing";
    if (state === "recording") notify("Recording... press Stop when you're done.");
    if (state === "transcribing") notify("Transcribing on this computer...");
  };
  const finish = async () => {
    try {
      const text = await voice.stop();
      if (text) {
        const draft = input.value.trim();
        input.value = draft === "" ? text : `${draft} ${text}`;
        input.scrollTop = input.scrollHeight;
        notify(null);
      } else {
        notify("I didn't catch any speech. Try again.");
      }
    } catch (error) {
      notify(error.message);
    }
  };
  return {
    toggle: async () => {
      if (voice.state === "recording") return finish();
      if (voice.state !== "idle") return;
      notify(null);
      try {
        await voice.start();
      } catch (error) {
        notify(error.message);
      }
    },
    cancel: () => voice.cancel(),
  };
};
