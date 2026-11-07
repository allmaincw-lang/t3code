import { joinLiveKitCall } from "./livekit-call.js";
import { createDictation, createRoomVoice } from "./voice.js";

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "room-token";
const STATUS_LABELS = {
  idle: "Ready",
  working: "Working",
  "needs-approval": "Needs approval in T3",
  error: "Hit an error",
  offline: "Offline",
};

const readToken = () => {
  const invite = new URLSearchParams(location.hash.slice(1)).get("invite");
  try {
    if (invite) {
      localStorage.setItem(TOKEN_KEY, invite);
      history.replaceState(null, "", location.pathname);
    }
    return invite ?? localStorage.getItem(TOKEN_KEY);
  } catch {
    if (invite) history.replaceState(null, "", location.pathname);
    return invite;
  }
};

const token = readToken();
const state = {
  me: null,
  connectionId: null,
  connections: [],
  agents: new Map(),
  dispatches: new Map(),
  renderedMessages: new Set(),
};

const call = {
  active: false,
  lk: null,
  stream: null,
  screenTrack: null,
  placeholderTimer: null,
  peers: new Map(),
  remoteStreams: new Map(),
};

const api = async (path, body) => {
  const res = await fetch(`.${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(result.error ?? "That did not work.");
  return result;
};

const notify = (text) => {
  $("notice").textContent = text ?? "";
  $("notice").hidden = !text;
};

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const renderMessage = (message) => {
  if (state.renderedMessages.has(message.id)) return;
  state.renderedMessages.add(message.id);
  const list = $("messages");
  const pinned = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  const row = element("div", `message ${message.kind}`);
  const time = new Date(message.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const author = element("div");
  author.append(element("span", "message-author", message.author), ` `);
  author.append(element("span", "muted", time));
  row.append(author, element("div", "message-text", message.text));
  list.append(row);
  if (pinned) list.scrollTop = list.scrollHeight;
};

const renderApprovals = () => {
  const box = $("approvals");
  box.replaceChildren();
  for (const dispatch of state.dispatches.values()) {
    if (dispatch.status !== "pending") continue;
    if (dispatch.owner !== state.me) {
      if (dispatch.from === state.me) {
        box.append(
          element("div", "approval muted", `Waiting for ${dispatch.owner} to approve ${dispatch.agent}.`),
        );
      }
      continue;
    }
    const row = element("div", "approval");
    row.append(
      element("div", null, `${dispatch.from} wants ${dispatch.agent} to run on your machine:`),
      element("div", "muted message-text", dispatch.text),
    );
    const actions = element("div", "approval-actions");
    for (const [label, verb, className] of [
      ["Approve", "approve", "primary"],
      ["Decline", "decline", ""],
    ]) {
      const button = element("button", className, label);
      button.type = "button";
      button.addEventListener("click", () => {
        api(`/api/dispatches/${dispatch.id}/${verb}`, {}).catch((error) => notify(error.message));
      });
      actions.append(button);
    }
    row.append(actions);
    box.append(row);
  }
};

const personTile = (key, person, stream, isLocal) => {
  const tile = element("div", "tile");
  tile.dataset.key = key;
  if (stream) {
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = isLocal;
    video.srcObject = stream;
    tile.append(video);
  } else {
    tile.append(element("div", "tile-initial", person.slice(0, 1).toUpperCase()));
  }
  tile.append(element("div", "tile-label", isLocal ? `${person} (you)` : person));
  return tile;
};

const agentTile = (agent) => {
  const status = agent.online ? agent.status : "offline";
  const tile = element("button", `tile agent ${status}`);
  tile.type = "button";
  tile.setAttribute("aria-label", `Mention ${agent.name}`);
  tile.append(
    element("div", "agent-name", agent.name),
    element("div", "muted", `${agent.owner}'s ${agent.machine}`),
    element("div", "agent-task", agent.task ?? ""),
    element("div", `agent-status status-${status}`, STATUS_LABELS[status] ?? status),
  );
  tile.addEventListener("click", () => {
    const input = $("message-input");
    input.value = `@${agent.name} ${input.value}`;
    input.focus();
  });
  return tile;
};

const renderGrid = () => {
  const tiles = [];
  for (const conn of state.connections) {
    const isLocal = conn.id === state.connectionId;
    const stream = isLocal ? (call.active ? call.stream : null) : call.remoteStreams.get(conn.id);
    tiles.push({ key: `${conn.id}:${stream?.id ?? "none"}`, build: () => personTile(`${conn.id}:${stream?.id ?? "none"}`, conn.person, stream ?? null, isLocal) });
  }
  const grid = $("grid");
  if (call.lk) {
    // LiveKit draws everyone who is in the call; people who are not in it keep a plain tile.
    const outside = state.connections.filter((conn) => !conn.inCall);
    const nodes = [
      ...call.lk.tiles(),
      ...outside.map((conn) => personTile(`${conn.id}:none`, conn.person, null, false)),
      ...[...state.agents.values()].map(agentTile),
    ];
    grid.replaceChildren(...nodes);
    $("status").textContent = `${state.connections.length} here, ${[...state.agents.values()].filter((a) => a.online).length} agents online`;
    return;
  }
  const existing = new Map([...grid.children].filter((n) => n.dataset.key).map((n) => [n.dataset.key, n]));
  const nodes = tiles.map(({ key, build }) => existing.get(key) ?? build());
  for (const agent of state.agents.values()) nodes.push(agentTile(agent));
  grid.replaceChildren(...nodes);
  $("status").textContent = `${state.connections.length} here, ${[...state.agents.values()].filter((a) => a.online).length} agents online`;
};

const placeholderStream = () => {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 200;
  const context = canvas.getContext("2d");
  const paint = () => {
    context.fillStyle = "#202328";
    context.fillRect(0, 0, 320, 200);
    context.fillStyle = "#9aa1ab";
    context.font = "96px sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText((state.me ?? "?").slice(0, 1).toUpperCase(), 160, 100);
  };
  paint();
  // A canvas only emits frames when repainted, and a peer needs at least occasional frames.
  call.placeholderTimer = setInterval(paint, 2_000);
  return canvas.captureStream(1);
};

const sendSignal = (to, data) =>
  api("/api/signal", { from: state.connectionId, to, data }).catch(() => {});

const dropPeer = (id) => {
  call.peers.get(id)?.close();
  call.peers.delete(id);
  call.remoteStreams.delete(id);
};

const createPeer = (id) => {
  const peer = new RTCPeerConnection({ iceServers: [] });
  call.peers.set(id, peer);
  for (const track of call.stream.getTracks()) peer.addTrack(track, call.stream);
  if (call.screenTrack) {
    peer.getSenders().find((s) => s.track?.kind === "video")?.replaceTrack(call.screenTrack);
  }
  peer.onicecandidate = ({ candidate }) => {
    if (candidate) sendSignal(id, { candidate });
  };
  peer.ontrack = ({ streams }) => {
    call.remoteStreams.set(id, streams[0]);
    renderGrid();
  };
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === "failed") {
      notify("A video connection failed. Both people need to be on the same network or tailnet.");
    }
  };
  return peer;
};

const connectToCallers = async () => {
  for (const conn of state.connections) {
    if (conn.id === state.connectionId || !conn.inCall || call.peers.has(conn.id)) continue;
    // Whoever has the lower id offers, so two people joining together do not both offer.
    if (state.connectionId > conn.id) continue;
    const peer = createPeer(conn.id);
    await peer.setLocalDescription(await peer.createOffer());
    sendSignal(conn.id, { description: peer.localDescription });
  }
};

const handleSignal = async ({ from, data }) => {
  if (!call.active) return;
  let peer = call.peers.get(from);
  if (data.description) {
    if (!peer) peer = createPeer(from);
    await peer.setRemoteDescription(data.description);
    if (data.description.type === "offer") {
      await peer.setLocalDescription(await peer.createAnswer());
      sendSignal(from, { description: peer.localDescription });
    }
  } else if (data.candidate && peer) {
    await peer.addIceCandidate(data.candidate).catch(() => {});
  }
};

const setCallControls = () => {
  $("join-call").hidden = call.active;
  for (const id of ["toggle-mic", "toggle-camera", "share-screen", "leave-call"]) {
    $(id).hidden = !call.active;
  }
};

const joinLiveKit = async () => {
  let credentials;
  try {
    credentials = await api("/api/livekit/token", {});
  } catch {
    return false;
  }
  try {
    const lk = await joinLiveKitCall({ ...credentials, onChange: renderGrid, notify });
    call.lk = lk;
    lk.onDisconnected(() => {
      if (call.lk === lk) leaveCall().catch(() => {});
    });
    return true;
  } catch {
    return false;
  }
};

const joinCall = async () => {
  if (await joinLiveKit()) {
    call.active = true;
    setCallControls();
    await api("/api/call", { connectionId: state.connectionId, inCall: true });
    renderGrid();
    return;
  }
  try {
    call.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    notify(null);
  } catch {
    call.stream = placeholderStream();
    notify(
      window.isSecureContext
        ? "No camera or microphone access, so you joined with a placeholder and can still see and hear others."
        : "Camera and microphone need HTTPS. Open the room through its Tailscale HTTPS address to use them.",
    );
  }
  call.active = true;
  setCallControls();
  await api("/api/call", { connectionId: state.connectionId, inCall: true });
  renderGrid();
  await connectToCallers();
};

const stopScreenShare = async () => {
  if (!call.screenTrack) return;
  call.screenTrack.stop();
  call.screenTrack = null;
  const camera = call.stream.getVideoTracks()[0] ?? null;
  for (const peer of call.peers.values()) {
    await peer.getSenders().find((s) => s.track?.kind === "video")?.replaceTrack(camera);
  }
  $("share-screen").textContent = "Share screen";
  $("share-screen").setAttribute("aria-pressed", "false");
};

const leaveCall = async () => {
  const lk = call.lk;
  call.lk = null;
  await lk?.leave();
  await stopScreenShare();
  clearInterval(call.placeholderTimer);
  for (const track of call.stream?.getTracks() ?? []) track.stop();
  for (const id of [...call.peers.keys()]) dropPeer(id);
  call.stream = null;
  for (const [id, label] of [["toggle-mic", "Mute"], ["toggle-camera", "Stop camera"], ["share-screen", "Share screen"]]) {
    $(id).textContent = label;
    $(id).setAttribute("aria-pressed", "false");
  }
  call.active = false;
  setCallControls();
  notify(null);
  await api("/api/call", { connectionId: state.connectionId, inCall: false });
  renderGrid();
};

const toggleTrack = (button, tracks, onLabel, offLabel) => {
  if (tracks.length === 0) {
    notify("That device is not available.");
    return;
  }
  const enabled = !tracks[0].enabled;
  for (const track of tracks) track.enabled = enabled;
  button.textContent = enabled ? onLabel : offLabel;
  button.setAttribute("aria-pressed", String(!enabled));
};

const handleEvent = async (type, data) => {
  if (type === "snapshot") {
    state.me = data.me;
    state.connectionId = data.connectionId;
    state.connections = data.connections;
    state.agents = new Map(data.agents.map((agent) => [agent.name, agent]));
    state.dispatches = new Map(data.dispatches.map((dispatch) => [dispatch.id, dispatch]));
    for (const message of data.messages) renderMessage(message);
    $("signed-out").hidden = true;
    $("app").hidden = false;
    renderApprovals();
    renderGrid();
  } else if (type === "message") {
    renderMessage(data);
  } else if (type === "dispatch") {
    state.dispatches.set(data.id, data);
    renderApprovals();
  } else if (type === "agent") {
    state.agents.set(data.name, data);
    renderGrid();
  } else if (type === "presence") {
    state.connections = data;
    for (const id of [...call.peers.keys()]) {
      if (!data.some((conn) => conn.id === id && conn.inCall)) dropPeer(id);
    }
    renderGrid();
    if (call.active && !call.lk) await connectToCallers();
  } else if (type === "signal") {
    await handleSignal(data);
  }
};

const connect = async () => {
  const res = await fetch("./api/events", { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    $("signed-out-text").textContent = "This invite is not valid. Ask the room's host for a new one.";
    $("signed-out").hidden = false;
    $("app").hidden = true;
    return false;
  }
  if (!res.ok || !res.body) throw new Error("Could not reach the room.");
  notify(null);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return true;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (line === "") continue;
      const event = JSON.parse(line);
      await handleEvent(event.type, event.data).catch((error) => console.error(error));
    }
  }
};

const run = async () => {
  if (!token) {
    $("signed-out-text").textContent =
      "Open your invite link to join. Ask the room's host to create one for you.";
    return;
  }
  while (true) {
    const reconnect = await connect().catch((error) => {
      $("signed-out-text").textContent = `Could not reach the room: ${error.message}. Retrying...`;
      return true;
    });
    if (!reconnect) return;
    if (call.active) await leaveCall().catch(() => {});
    notify("Disconnected from the room. Reconnecting...");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
};

const SpeechRecognizer = window.SpeechRecognition ?? window.webkitSpeechRecognition;
const SPEECH_ERRORS = {
  "not-allowed": "Microphone or speech recognition is not allowed. Check this browser's settings.",
  "service-not-allowed": "Speech recognition is turned off. On iPhone, turn on Dictation in Settings.",
  "audio-capture": "No microphone was found.",
  network: "Speech recognition needs an internet connection.",
};
let recognizer = null;

const setTalking = (talking) => {
  $("talk").textContent = talking ? "Stop" : "Talk";
  $("talk").setAttribute("aria-pressed", String(talking));
};

const stopTalking = (discard) => {
  const active = recognizer;
  if (!active) return;
  if (discard) recognizer = null;
  if (discard) active.abort();
  else active.stop();
  setTalking(false);
};

const startTalking = () => {
  const input = $("message-input");
  const before = input.value.trim() === "" ? "" : `${input.value.trim()} `;
  const active = new SpeechRecognizer();
  active.continuous = true;
  active.interimResults = true;
  active.lang = navigator.language;
  active.onresult = (event) => {
    if (recognizer !== active) return;
    const spoken = Array.from(event.results, (result) => result[0].transcript).join("");
    input.value = before + spoken.trim();
    input.scrollTop = input.scrollHeight;
  };
  active.onerror = (event) => {
    if (event.error === "no-speech" || event.error === "aborted") return;
    notify(SPEECH_ERRORS[event.error] ?? "Speech recognition stopped working. Please try again.");
  };
  active.onend = () => {
    if (recognizer !== active) return;
    recognizer = null;
    setTalking(false);
  };
  recognizer = active;
  notify(null);
  setTalking(true);
  active.start();
};

const voice = token ? createRoomVoice({ token }) : null;
const dictation = voice
  ? createDictation({ voice, input: $("message-input"), button: $("talk"), notify })
  : null;
window.roomVoice = voice;
let localVoice = false;
$("talk").hidden = !SpeechRecognizer;
voice?.ready.then(() => {
  localVoice = voice.source === "local";
  $("talk").hidden = !(localVoice || SpeechRecognizer);
});
$("talk").addEventListener("click", () => {
  if (localVoice) dictation.toggle();
  else if (recognizer) stopTalking(false);
  else startTalking();
});
$("message-input").addEventListener("input", () => !localVoice && stopTalking(true));

$("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  stopTalking(true);
  dictation?.cancel();
  const input = $("message-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  try {
    await api("/api/messages", { text });
  } catch (error) {
    input.value = text;
    notify(error.message);
  }
});
$("message-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});
$("join-call").addEventListener("click", () => {
  joinCall().catch((error) => notify(error.message));
});
$("leave-call").addEventListener("click", () => {
  leaveCall().catch((error) => notify(error.message));
});
const toggleLiveKit = async (id, toggle, isOn, onLabel, offLabel) => {
  await toggle();
  $(id).textContent = isOn() ? onLabel : offLabel;
  $(id).setAttribute("aria-pressed", String(!isOn()));
};

$("toggle-mic").addEventListener("click", () => {
  if (call.lk) {
    toggleLiveKit("toggle-mic", call.lk.toggleMic, call.lk.micOn, "Mute", "Unmute");
    return;
  }
  toggleTrack($("toggle-mic"), call.stream.getAudioTracks(), "Mute", "Unmute");
});
$("toggle-camera").addEventListener("click", () => {
  if (call.lk) {
    toggleLiveKit("toggle-camera", call.lk.toggleCamera, call.lk.cameraOn, "Stop camera", "Start camera");
    return;
  }
  toggleTrack($("toggle-camera"), call.stream.getVideoTracks(), "Stop camera", "Start camera");
});
$("share-screen").addEventListener("click", async () => {
  if (call.lk) {
    await toggleLiveKit("share-screen", call.lk.toggleScreen, call.lk.screenOn, "Stop sharing", "Share screen");
    $("share-screen").setAttribute("aria-pressed", String(call.lk.screenOn()));
    return;
  }
  if (call.screenTrack) {
    await stopScreenShare();
    return;
  }
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const [track] = display.getVideoTracks();
    call.screenTrack = track;
    track.addEventListener("ended", () => {
      stopScreenShare();
    });
    for (const peer of call.peers.values()) {
      await peer.getSenders().find((s) => s.track?.kind === "video")?.replaceTrack(track);
    }
    $("share-screen").textContent = "Stop sharing";
    $("share-screen").setAttribute("aria-pressed", "true");
  } catch {
    notify("Screen sharing was not started.");
  }
});

run();
