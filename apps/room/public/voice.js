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

/** `available()` says whether the room can transcribe locally; `toggle()` starts or ends a recording. */
export const createDictation = ({ token, input, button, notify }) => {
  const supported = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  let session = null;
  let transcribing = false;
  let generation = 0;

  const show = (label, pressed = false) => {
    button.textContent = label;
    button.setAttribute("aria-pressed", String(pressed));
    button.disabled = transcribing;
  };

  const fail = (error) => {
    notify(RECORDING_ERRORS[error?.name] ?? error?.message ?? "Dictation stopped working.");
  };

  const stop = async () => {
    const active = session;
    const mine = generation;
    session = null;
    transcribing = true;
    show("Transcribing...");
    notify("Transcribing on this computer...");
    try {
      const pcm = await toPcm16k(await active.finish());
      const text = (await upload(token, pcm)).trim();
      if (mine !== generation) return;
      if (text) {
        const draft = input.value.trim();
        input.value = draft === "" ? text : `${draft} ${text}`;
        input.scrollTop = input.scrollHeight;
        notify(null);
      } else {
        notify("I didn't catch any speech. Try again.");
      }
    } catch (error) {
      if (mine === generation) fail(error);
    } finally {
      transcribing = false;
      show("Talk");
    }
  };

  const start = async () => {
    notify(null);
    try {
      session = await record(() => session && stop());
      show("Stop", true);
      notify("Recording... press Stop when you're done.");
    } catch (error) {
      session = null;
      fail(error);
    }
  };

  return {
    available: async () => {
      if (!supported) return false;
      try {
        const res = await fetch("./api/transcribe/status", {
          headers: { authorization: `Bearer ${token}` },
        });
        return res.ok && (await res.json()).available === true;
      } catch {
        return false;
      }
    },
    toggle: () => {
      if (transcribing) return;
      return session ? stop() : start();
    },
    cancel: () => {
      generation += 1;
      session?.cancel();
      session = null;
      if (!transcribing) show("Talk");
    },
  };
};
