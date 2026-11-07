// LiveKit call: publishes camera and mic, renders one tile per participant (plus screen shares).
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// Read-only call state for other modules. Covers LiveKit calls only; the mesh fallback leaves it unjoined.
// `window.roomCall` = { joined, micOn, cameraOn, screenOn }; `roomcall:change` fires on window after any change.
const publish = (state) => {
  window.roomCall = Object.freeze({ joined: false, micOn: false, cameraOn: false, screenOn: false, ...state });
  window.dispatchEvent(new CustomEvent("roomcall:change", { detail: window.roomCall }));
};
publish({});

export const joinLiveKitCall = async ({ url, token, onChange, notify }) => {
  const { Room, RoomEvent, Track } = window.LivekitClient;
  const room = new Room({ adaptiveStream: true, dynacast: true });
  const tiles = new Map();
  const audioHost = element("div");
  audioHost.hidden = true;
  document.body.append(audioHost);

  const tileFor = (key) => {
    let entry = tiles.get(key);
    if (!entry) {
      const node = element("div", "tile");
      node.dataset.lk = key;
      const initial = element("div", "tile-initial");
      const label = element("div", "tile-label");
      const name = element("span");
      const muted = element("span", "tile-muted", " 🔇");
      muted.title = "Muted";
      label.append(name, muted);
      node.append(initial, label);
      entry = { node, initial, name, muted, video: null, track: null };
      tiles.set(key, entry);
    }
    return entry;
  };

  const showVideo = (entry, track) => {
    if (entry.track === track) return;
    if (entry.track) entry.track.detach(entry.video);
    entry.video?.remove();
    entry.video = null;
    entry.track = track;
    if (track) {
      entry.video = document.createElement("video");
      entry.video.playsInline = true;
      entry.video.autoplay = true;
      entry.video.muted = true;
      track.attach(entry.video);
      entry.node.prepend(entry.video);
    }
  };

  const sync = () => {
    const seen = new Set();
    const people = [room.localParticipant, ...room.remoteParticipants.values()];
    for (const person of people) {
      const isLocal = person === room.localParticipant;
      const label = person.name || person.identity;
      const camera = person.getTrackPublication(Track.Source.Camera);
      const mic = person.getTrackPublication(Track.Source.Microphone);
      const screen = person.getTrackPublication(Track.Source.ScreenShare);

      const entry = tileFor(person.identity);
      seen.add(person.identity);
      showVideo(entry, camera && !camera.isMuted ? camera.track : null);
      entry.initial.textContent = label.slice(0, 1).toUpperCase();
      entry.name.textContent = isLocal ? `${label} (you)` : label;
      entry.node.classList.toggle("self", isLocal);
      entry.muted.hidden = !!mic && !mic.isMuted;
      entry.node.classList.toggle("speaking", person.isSpeaking);

      if (screen?.track) {
        const key = `${person.identity}:screen`;
        const share = tileFor(key);
        seen.add(key);
        showVideo(share, screen.track);
        share.initial.hidden = true;
        share.name.textContent = `${label}'s screen`;
        share.muted.hidden = true;
      }
    }
    for (const [key, entry] of tiles) {
      if (seen.has(key)) continue;
      showVideo(entry, null);
      tiles.delete(key);
    }
    const me = room.localParticipant;
    publish({
      joined: room.state === "connected",
      micOn: me.isMicrophoneEnabled,
      cameraOn: me.isCameraEnabled,
      screenOn: me.isScreenShareEnabled,
    });
    onChange();
  };

  room
    .on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) audioHost.append(track.attach());
    })
    .on(RoomEvent.TrackUnsubscribed, (track) => {
      for (const media of track.detach()) media.remove();
    })
    .on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (!room.canPlaybackAudio) notify("Click anywhere to hear the call.");
    });
  for (const event of [
    RoomEvent.ParticipantConnected,
    RoomEvent.ParticipantDisconnected,
    RoomEvent.TrackSubscribed,
    RoomEvent.TrackUnsubscribed,
    RoomEvent.TrackMuted,
    RoomEvent.TrackUnmuted,
    RoomEvent.LocalTrackPublished,
    RoomEvent.LocalTrackUnpublished,
    RoomEvent.ActiveSpeakersChanged,
  ]) {
    room.on(event, sync);
  }

  try {
    await room.connect(url, token);
  } catch (error) {
    await room.disconnect();
    audioHost.remove();
    throw error;
  }
  await room.startAudio().catch(() => {});

  // Joining must work without devices, so each device failure is reported but not fatal.
  const problems = [];
  for (const [label, enable] of [
    ["microphone", () => room.localParticipant.setMicrophoneEnabled(true)],
    ["camera", () => room.localParticipant.setCameraEnabled(true)],
  ]) {
    await enable().catch(() => problems.push(label));
  }
  if (problems.length) {
    notify(
      window.isSecureContext
        ? `Could not use your ${problems.join(" or ")}. You joined and can still see and hear others.`
        : "Camera and microphone need HTTPS. Open the room through its Tailscale HTTPS address to use them.",
    );
  }
  sync();

  const toggle = async (enable, on) => {
    try {
      await enable(on);
    } catch {
      notify("That device is not available.");
    }
    sync();
  };

  return {
    tiles: () => [...tiles.values()].map((entry) => entry.node),
    micOn: () => room.localParticipant.isMicrophoneEnabled,
    cameraOn: () => room.localParticipant.isCameraEnabled,
    screenOn: () => room.localParticipant.isScreenShareEnabled,
    toggleMic: async () => {
      await toggle((on) => room.localParticipant.setMicrophoneEnabled(on), !room.localParticipant.isMicrophoneEnabled);
    },
    toggleCamera: async () => {
      await toggle((on) => room.localParticipant.setCameraEnabled(on), !room.localParticipant.isCameraEnabled);
    },
    toggleScreen: async () => {
      await toggle((on) => room.localParticipant.setScreenShareEnabled(on), !room.localParticipant.isScreenShareEnabled);
    },
    onDisconnected: (handler) => room.on(RoomEvent.Disconnected, handler),
    leave: async () => {
      await room.disconnect();
      for (const entry of tiles.values()) showVideo(entry, null);
      tiles.clear();
      audioHost.remove();
      publish({});
    },
  };
};
