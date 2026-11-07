// Jarvis extras for the Room: push-to-talk, a status face, spoken replies, per-agent memory
// switches and optional camera gestures. Everything is opt-in and reads the Room through
// window.roomApp and "room:event" (see app.js). Ideas follow the public descriptions of
// jaredrhod/backtalk (push-to-talk) and jaredrhod/ai-visualizer (status visuals); no code is copied.

const app = window.roomApp;
const root = document.getElementById("jarvis");
if (app && root) init();

function init() {
  const { state, api, notify } = app;
  const SpeechRecognizer = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  const KEY = "room-jarvis";
  const MAX_SPOKEN = 700;
  const MAX_HOLD_MS = 60_000;
  const prefs = { agent: "", autoSend: false, speak: false, voices: {} };
  // Starting voices per agent; the Voice picker changes the selected agent's voice on this device.
  const AGENT_VOICES = { claude: "bm_george", codex: "af_heart" };
  try {
    Object.assign(prefs, JSON.parse(localStorage.getItem(KEY) ?? "{}"));
    if (!prefs.voices || typeof prefs.voices !== "object") prefs.voices = {};
  } catch {}
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {}
  };

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const checkbox = (label) => {
    const wrap = el("label", "jv-check");
    const input = el("input");
    input.type = "checkbox";
    wrap.append(input, el("span", null, label));
    return { wrap, input };
  };

  // --- layout ---
  const face = el("div", "jv-face");
  face.dataset.state = "idle";
  face.append(el("div", "jv-ring"), el("div", "jv-core"));
  const label = el("div", "jv-label");
  label.setAttribute("role", "status");
  const memoryChip = el("span", "jv-chip", "Memory on");
  const cameraChip = el("span", "jv-chip jv-chip-camera", "Camera on");
  const select = el("select", "jv-agent");
  select.setAttribute("aria-label", "Agent to talk to");
  const ptt = el("button", "jv-ptt", "Hold to talk");
  ptt.type = "button";
  ptt.title = "Hold, or hold the space bar outside a text box";
  const stopSpeech = el("button", "jv-stop", "Stop speaking");
  stopSpeech.type = "button";
  const confirm = el("form", "jv-confirm");
  const transcript = el("textarea", "jv-transcript");
  transcript.rows = 2;
  transcript.maxLength = 7_900;
  transcript.setAttribute("aria-label", "Transcript to send");
  const confirmSend = el("button", "primary", "Send");
  confirmSend.type = "submit";
  const confirmDiscard = el("button", null, "Discard");
  confirmDiscard.type = "button";
  confirm.append(transcript, confirmSend, confirmDiscard);
  confirm.hidden = true;

  const settings = el("details", "jv-settings");
  settings.append(el("summary", null, "Voice settings"));
  const auto = checkbox("Send what I say without asking (still needs the owner's approval)");
  const speak = checkbox("Speak the agent's reply out loud");
  const voiceRow = el("label", "jv-check");
  const voicePick = el("select", "jv-voice");
  const voiceName = el("span", null, "Voice");
  voiceRow.append(voiceName, voicePick);
  voiceRow.hidden = true;
  const gestures = checkbox("Camera gesture: cover the lens to start or stop talking");
  const memory = checkbox("Remember notes for this agent");
  const memoryNote = el("div", "muted jv-note");
  settings.append(
    auto.wrap,
    speak.wrap,
    voiceRow,
    gestures.wrap,
    el("div", "muted jv-note", "Gestures use their own camera permission and never raise your hand."),
    memory.wrap,
    memoryNote,
  );

  const head = el("div", "jv-head");
  const text = el("div", "jv-text");
  text.append(label, memoryChip, cameraChip);
  head.append(face, text);
  const row = el("div", "jv-row");
  row.append(select, ptt, stopSpeech);
  const video = el("video", "jv-video");
  video.muted = true;
  video.playsInline = true;
  video.hidden = true;
  root.append(head, row, confirm, settings, video);

  auto.input.checked = prefs.autoSend;
  speak.input.checked = prefs.speak;

  // --- state ---
  let listening = false;
  let transcribing = false;
  let speaking = false;
  let hint = "";
  let holding = false;
  let starting = false;
  let capture = null;
  let holdTimer = null;
  let utterance = null;
  const awaiting = new Set();

  const target = () => state.agents.get(prefs.agent) ?? null;
  const visual = () => {
    const agent = target();
    if (listening) return ["listening", "Listening..."];
    if (speaking) return ["speaking", `${agent?.name ?? "Agent"} is speaking`];
    if (transcribing) return ["thinking", "Writing that down..."];
    if (!agent) return ["idle", "Pick an agent to talk to"];
    if (!agent.online) return ["idle", `${agent.name} is offline`];
    if (agent.status === "needs-approval") return ["approval", `${agent.name} needs approval in T3`];
    if (agent.status === "working") return ["thinking", `${agent.name} is working`];
    return ["idle", hint || `${agent.name} is ready`];
  };

  let lastAgents = "";
  const renderAgents = () => {
    const names = [...state.agents.values()].map((agent) => agent.name);
    const signature = names.join("|");
    if (signature !== lastAgents) {
      lastAgents = signature;
      select.replaceChildren(
        ...names.map((name) => {
          const option = el("option", null, `@${name}`);
          option.value = name;
          return option;
        }),
      );
    }
    if (!state.agents.has(prefs.agent)) prefs.agent = names[0] ?? "";
    select.value = prefs.agent;
  };

  const render = () => {
    renderAgents();
    const [name, words] = visual();
    face.dataset.state = name;
    label.textContent = words;
    face.setAttribute("aria-label", words);
    const agent = target();
    memoryChip.hidden = !agent?.memoryOn;
    const mine = agent && agent.owner === state.me && agent.memoryAvailable;
    memory.wrap.hidden = !mine;
    memory.input.checked = agent?.memoryOn === true;
    memoryNote.textContent = !agent?.memoryAvailable
      ? agent
        ? `${agent.name}'s machine has no memory folder set up, so memory is off.`
        : ""
      : agent.owner !== state.me
        ? `Only ${agent.owner} can turn memory on. It is ${agent.memoryOn ? "on" : "off"}.`
        : 'Type "remember: ..." in the chat to save a note. Notes are saved on your machine for this room and project.';
    ptt.disabled = !SpeechRecognizer && !window.roomVoice;
    ptt.setAttribute("aria-pressed", String(listening));
    ptt.textContent = listening ? "Release to send" : "Hold to talk";
    stopSpeech.hidden = !speaking;
    cameraChip.hidden = !camera;
  };

  // --- speech output ---
  const spoken = (value) => {
    const plain = value
      .replace(/```[\s\S]*?```/g, " (code omitted) ")
      .replace(/https?:\/\/\S+/g, " link ")
      .replace(/[`*_#>|]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (plain.length <= MAX_SPOKEN) return plain;
    const cut = plain.slice(0, MAX_SPOKEN);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(". ") + 1, 200))} The rest is in the chat.`;
  };
  // Natural voices come from the room's Kokoro service; the browser voice is the fallback.
  let naturalVoice = false;
  const player = new Audio();
  const silence = (() => {
    const bytes = new Uint8Array(46);
    const view = new DataView(bytes.buffer);
    [..."RIFF"].forEach((c, i) => (bytes[i] = c.charCodeAt(0)));
    view.setUint32(4, 38, true);
    [..."WAVEfmt "].forEach((c, i) => (bytes[8 + i] = c.charCodeAt(0)));
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true);
    view.setUint32(28, 16000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    [..."data"].forEach((c, i) => (bytes[36 + i] = c.charCodeAt(0)));
    view.setUint32(40, 2, true);
    return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  })();
  // iOS only lets a page play audio later if it first played some during a tap.
  const unlock = () => {
    player.src = silence;
    player.play().catch(() => {});
    window.removeEventListener("pointerdown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  let playing = null;

  const cancelSpeech = () => {
    utterance = null;
    speaking = false;
    if (playing) {
      player.pause();
      URL.revokeObjectURL(playing);
      playing = null;
    }
    window.speechSynthesis?.cancel();
  };
  const sayWithBrowser = (words, current) => {
    if (!window.speechSynthesis) return;
    const spokenNow = new SpeechSynthesisUtterance(words);
    utterance = current;
    spokenNow.onstart = () => {
      if (utterance !== current) return;
      speaking = true;
      render();
    };
    const done = () => {
      if (utterance !== current) return;
      utterance = null;
      speaking = false;
      render();
    };
    spokenNow.onend = done;
    spokenNow.onerror = done;
    window.speechSynthesis.speak(spokenNow);
  };
  let defaultVoice = "";
  const voiceFor = (agent) => {
    const key = (agent ?? "").toLowerCase();
    return prefs.voices[key] || AGENT_VOICES[key] || defaultVoice || undefined;
  };
  const say = async (value, agent = prefs.agent) => {
    cancelSpeech();
    const words = spoken(value);
    const current = {};
    utterance = current;
    if (naturalVoice && app.speech) {
      try {
        const url = URL.createObjectURL(await app.speech(words, voiceFor(agent)));
        if (utterance !== current) {
          URL.revokeObjectURL(url);
          return;
        }
        playing = url;
        player.src = url;
        const done = () => {
          if (playing !== url) return;
          URL.revokeObjectURL(url);
          playing = null;
          utterance = null;
          speaking = false;
          render();
        };
        player.onended = done;
        player.onerror = done;
        speaking = true;
        render();
        await player.play();
        return;
      } catch {
        if (utterance !== current) return;
        if (playing) {
          URL.revokeObjectURL(playing);
          playing = null;
        }
        speaking = false;
      }
    }
    sayWithBrowser(words, current);
  };

  // --- push to talk ---
  const startCapture = async () => {
    const voice = window.roomVoice;
    if (voice && typeof voice.start === "function" && typeof voice.stop === "function") {
      try {
        await voice.start();
        return {
          finish: async () => String((await voice.stop()) ?? ""),
          cancel: () => Promise.resolve(voice.stop()).catch(() => {}),
        };
      } catch (error) {
        if (!SpeechRecognizer) throw error;
      }
    }
    if (!SpeechRecognizer) throw new Error("This browser cannot listen. Try Chrome or Safari.");
    const recognizer = new SpeechRecognizer();
    recognizer.continuous = true;
    recognizer.interimResults = true;
    recognizer.lang = navigator.language;
    let heard = "";
    let ended = false;
    let onEnded = () => {};
    recognizer.onresult = (event) => {
      heard = Array.from(event.results, (result) => result[0].transcript).join("");
    };
    recognizer.onerror = (event) => {
      if (event.error !== "no-speech" && event.error !== "aborted") {
        notify("Speech recognition stopped working. Check this browser's microphone settings.");
      }
    };
    recognizer.onend = () => {
      ended = true;
      onEnded();
    };
    recognizer.start();
    return {
      finish: () =>
        new Promise((resolve) => {
          if (ended) return resolve(heard);
          onEnded = () => resolve(heard);
          setTimeout(() => resolve(heard), 2_500);
          recognizer.stop();
        }),
      cancel: () => recognizer.abort(),
    };
  };

  const sendToAgent = async (words, agent) => {
    awaiting.add(agent.toLowerCase());
    hint = `Sent to ${agent}`;
    try {
      await api("/api/messages", { text: `@${agent} ${words}` });
    } catch (error) {
      awaiting.delete(agent.toLowerCase());
      hint = "";
      notify(error.message);
    }
    render();
  };

  const finish = async (current) => {
    transcribing = true;
    listening = false;
    render();
    let words = "";
    try {
      words = (await current.finish()).trim();
    } catch (error) {
      notify(error.message);
    }
    transcribing = false;
    const agent = prefs.agent;
    if (!words) {
      hint = "Did not catch that";
    } else if (prefs.autoSend && agent) {
      await sendToAgent(words, agent);
    } else if (agent) {
      transcript.value = words;
      confirmSend.textContent = `Send to @${agent}`;
      confirm.hidden = false;
      transcript.focus();
      hint = "Check what I heard";
    }
    render();
  };

  const release = () => {
    holding = false;
    clearTimeout(holdTimer);
    if (starting || !capture) return;
    const current = capture;
    capture = null;
    void finish(current);
  };

  const press = async () => {
    if (capture || starting || transcribing) return;
    if (!target()) {
      notify("Pick an agent to talk to first.");
      return;
    }
    notify(null);
    hint = "";
    cancelSpeech();
    holding = true;
    starting = true;
    listening = true;
    confirm.hidden = true;
    render();
    try {
      capture = await startCapture();
      holdTimer = setTimeout(release, MAX_HOLD_MS);
    } catch (error) {
      holding = false;
      listening = false;
      notify(error.message);
    }
    starting = false;
    if (capture && !holding) release();
    render();
  };

  const abort = () => {
    holding = false;
    clearTimeout(holdTimer);
    if (!capture) return;
    const current = capture;
    capture = null;
    listening = false;
    current.cancel();
    render();
  };

  ptt.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    ptt.setPointerCapture(event.pointerId);
    event.preventDefault();
    void press();
  });
  ptt.addEventListener("pointerup", release);
  ptt.addEventListener("pointercancel", abort);
  ptt.addEventListener("contextmenu", (event) => event.preventDefault());

  const inTextField = (node) =>
    node instanceof Element &&
    (node.closest("input,textarea,select,[contenteditable]") ||
      (node.closest("button,summary,a") && node !== ptt));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && (capture || starting)) abort();
    if (event.code !== "Space" || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (inTextField(event.target) || $app().hidden) return;
    event.preventDefault();
    void press();
  });
  document.addEventListener("keyup", (event) => {
    if (event.code === "Space" && holding && !inTextField(event.target)) release();
  });
  window.addEventListener("blur", () => holding && abort());

  confirm.addEventListener("submit", (event) => {
    event.preventDefault();
    const words = transcript.value.trim();
    confirm.hidden = true;
    if (words && prefs.agent) void sendToAgent(words, prefs.agent);
  });
  confirmDiscard.addEventListener("click", () => {
    confirm.hidden = true;
    hint = "";
    render();
  });

  select.addEventListener("change", () => {
    prefs.agent = select.value;
    syncVoicePick();
    save();
    render();
  });
  auto.input.addEventListener("change", () => {
    prefs.autoSend = auto.input.checked;
    save();
  });
  const syncVoicePick = () => {
    const wanted = voiceFor(prefs.agent);
    if ([...voicePick.options].some((o) => o.value === wanted)) voicePick.value = wanted;
    voiceName.textContent = prefs.agent ? `Voice for ${prefs.agent}` : "Voice";
  };
  const VOICE_GROUPS = { af: "US woman", am: "US man", bf: "British woman", bm: "British man" };
  const voiceLabel = (id) => {
    const [group, name = id] = id.split("_");
    const who = VOICE_GROUPS[group];
    const nice = name.charAt(0).toUpperCase() + name.slice(1);
    return who ? `${nice} (${who})` : nice;
  };
  app.voices?.().then(({ available, voices = [], default: fallback }) => {
    naturalVoice = available && voices.length > 0;
    if (!naturalVoice) return;
    const english = voices.filter((id) => /^(af|am|bf|bm)_/.test(id));
    voicePick.replaceChildren(
      ...english.map((id) => {
        const option = el("option", null, voiceLabel(id));
        option.value = id;
        return option;
      }),
    );
    defaultVoice = fallback ?? english[0];
    syncVoicePick();
    voiceRow.hidden = false;
  });
  voicePick.addEventListener("change", () => {
    if (!prefs.agent) return;
    prefs.voices[prefs.agent.toLowerCase()] = voicePick.value;
    save();
    if (prefs.speak) void say("This is how I will sound.");
  });
  speak.input.addEventListener("change", () => {
    prefs.speak = speak.input.checked;
    if (!prefs.speak) cancelSpeech();
    if (prefs.speak && !naturalVoice && !window.speechSynthesis) notify("This browser cannot speak out loud.");
    save();
    render();
  });
  stopSpeech.addEventListener("click", () => {
    cancelSpeech();
    render();
  });
  memory.input.addEventListener("change", () => {
    const agent = target();
    if (!agent) return;
    api(`/api/agents/${encodeURIComponent(agent.name)}/memory`, { enabled: memory.input.checked }).catch(
      (error) => {
        notify(error.message);
        render();
      },
    );
  });

  // --- camera gesture: cover the lens for about a second ---
  // A plain brightness check on a tiny frame. A hand-tracking library would need WebAssembly,
  // which this page's content security policy does not allow, so none is loaded.
  let camera = null;
  let sampler = null;
  const stopCamera = () => {
    clearInterval(sampler);
    sampler = null;
    for (const track of camera?.getTracks() ?? []) track.stop();
    camera = null;
    video.srcObject = null;
    gestures.input.checked = false;
    render();
  };
  const startCamera = async () => {
    try {
      camera = await navigator.mediaDevices.getUserMedia({
        video: { width: 160, height: 120 },
        audio: false,
      });
    } catch {
      camera = null;
      gestures.input.checked = false;
      notify(
        window.isSecureContext
          ? "Camera access was not allowed, so gestures are off."
          : "Camera gestures need HTTPS. Open the room through its Tailscale HTTPS address.",
      );
      return;
    }
    video.srcObject = camera;
    video.hidden = false;
    await video.play().catch(() => {});
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 12;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    let baseline = 0;
    let samples = 0;
    let covered = 0;
    let armed = true;
    sampler = setInterval(() => {
      if (document.hidden || video.readyState < 2) return;
      context.drawImage(video, 0, 0, 16, 12);
      const { data } = context.getImageData(0, 0, 16, 12);
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const light = sum / (data.length / 4);
      const dark = samples >= 4 && light < baseline * 0.3 && baseline > 40;
      if (!dark) {
        baseline = samples === 0 ? light : baseline * 0.9 + light * 0.1;
        samples += 1;
      }
      covered = dark ? covered + 1 : 0;
      if (dark && covered === 4 && armed) {
        armed = false;
        if (capture || starting) release();
        else void press();
      }
      if (!dark && covered === 0) armed = true;
    }, 250);
    render();
  };
  gestures.input.addEventListener("change", () => {
    if (gestures.input.checked) void startCamera();
    else stopCamera();
  });
  window.addEventListener("pagehide", stopCamera);

  // --- Room events ---
  const mention = (value) =>
    [...value.matchAll(/@([\p{L}\p{N}_-]+)/gu)].map((match) => match[1].toLowerCase());
  window.addEventListener("room:event", ({ detail: { type, data } }) => {
    if (type === "message") {
      if (data.kind === "person" && data.author === state.me) {
        for (const name of mention(data.text)) awaiting.add(name);
      } else if (data.kind === "agent" && awaiting.delete(data.author.toLowerCase())) {
        hint = "";
        if (prefs.speak && data.author.toLowerCase() === prefs.agent.toLowerCase()) void say(data.text, data.author);
      }
    }
    render();
  });
  render();
}

function $app() {
  return document.getElementById("app");
}
