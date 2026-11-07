// Meeting extras: raised hands, reactions, participants, unread and approval counts.
// Reads the room's state through window.room and listens to the stream via "room-event".
const $ = (id) => document.getElementById(id);
const REACTIONS = ["👍", "👏", "❤️", "😂", "🎉", "😮"];
const REACTION_MS = 3_000;
const STATUS_LABELS = {
  idle: "Ready",
  working: "Working",
  "needs-approval": "Needs approval",
  error: "Hit an error",
  offline: "Offline",
};

const meeting = new Map();
const shown = new Map();
let unread = 0;

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const room = () => window.room;
const me = () => meeting.get(room().state.connectionId);
const report = (path, body) =>
  room()
    .api(path, { connectionId: room().state.connectionId, ...body })
    .catch((error) => {
      $("notice").textContent = error.message;
      $("notice").hidden = false;
    });

const badge = (button, count, label) => {
  button.hidden = count === 0;
  button.textContent = `${label} ${count}`;
};

const renderCounts = () => {
  const { state } = room();
  const approvals = [...state.dispatches.values()].filter(
    (dispatch) => dispatch.status === "pending" && dispatch.owner === state.me,
  ).length;
  badge($("chat-jump"), unread, "New messages");
  badge($("approval-jump"), approvals, "To approve");
  const waiting = approvals > 0 ? " - approval needed" : "";
  document.title = `${unread > 0 ? `(${unread}) ` : ""}Room${waiting}`;
};

const messagesAtBottom = () => {
  const list = $("messages");
  return list.scrollHeight - list.scrollTop - list.clientHeight < 60;
};
const clearUnread = () => {
  if (unread === 0 || document.hidden || !messagesAtBottom()) return;
  unread = 0;
  renderCounts();
};

const renderParticipants = () => {
  const { state } = room();
  const mine = me();
  $("hand").textContent = mine?.hand ? "Lower hand" : "Raise hand";
  $("hand").setAttribute("aria-pressed", String(Boolean(mine?.hand)));
  const hands = [...meeting.values()].filter((entry) => entry.hand).length;
  $("people-toggle").textContent = hands > 0 ? `People (${state.connections.length}) - ${hands} raised` : `People (${state.connections.length})`;

  const panel = $("people");
  if (panel.hidden) return;
  const list = element("ul", "people-list");
  for (const conn of state.connections) {
    const entry = meeting.get(conn.id);
    const item = element("li", "person");
    const name = conn.id === state.connectionId ? `${conn.person} (you)` : conn.person;
    const facts = [conn.inCall ? "In call" : "Here"];
    if (conn.inCall && entry?.muted !== undefined && entry.muted !== null) {
      facts.push(entry.muted ? "Muted" : "Unmuted");
    }
    item.append(element("span", "person-name", name), element("span", "muted", facts.join(" - ")));
    if (entry?.hand) item.append(element("span", "hand-flag", "✋ Hand raised"));
    list.append(item);
  }
  for (const agent of state.agents.values()) {
    const status = agent.online ? agent.status : "offline";
    const item = element("li", "person");
    item.append(
      element("span", "person-name", `${agent.name} (agent)`),
      element("span", "muted", `${agent.owner}'s ${agent.machine} - ${STATUS_LABELS[status] ?? status}`),
    );
    list.append(item);
  }
  panel.replaceChildren(list);
};

const decorateTiles = () => {
  for (const tile of $("grid").children) {
    const id = tile.dataset.key?.split(":")[0];
    if (!id) continue;
    tile.querySelector(".tile-meeting")?.remove();
    const entry = meeting.get(id);
    const reaction = shown.get(id);
    if (!entry?.hand && !reaction) continue;
    const overlay = element("div", "tile-meeting");
    if (entry?.hand) {
      const hand = element("span", "tile-hand", "✋");
      hand.setAttribute("role", "img");
      hand.setAttribute("aria-label", "Hand raised");
      overlay.append(hand);
    }
    if (reaction) {
      const emoji = element("span", "tile-reaction", reaction.emoji);
      emoji.setAttribute("role", "img");
      emoji.setAttribute("aria-label", `Reaction ${reaction.emoji}`);
      overlay.append(emoji);
    }
    tile.append(overlay);
  }
};

const refresh = () => {
  renderParticipants();
  decorateTiles();
  renderCounts();
};

const showReaction = ({ connectionId, emoji }) => {
  clearTimeout(shown.get(connectionId)?.timer);
  const timer = setTimeout(() => {
    shown.delete(connectionId);
    decorateTiles();
  }, REACTION_MS);
  shown.set(connectionId, { emoji, timer });
  decorateTiles();
};

// Keep the mute flag in step with the mic button; the call code owns the button.
const syncMute = () => {
  const { state } = room();
  const self = state.connections.find((conn) => conn.id === state.connectionId);
  if (!self?.inCall || $("toggle-mic").hidden) return;
  const muted = $("toggle-mic").getAttribute("aria-pressed") === "true";
  if (me()?.muted !== muted) report("/api/meeting", { muted });
};

document.addEventListener("room-event", ({ detail: { type, data } }) => {
  if (type === "message") {
    const { state } = room();
    if (data.author !== state.me && (document.hidden || !messagesAtBottom())) unread += 1;
  } else if (type === "meeting" || type === "snapshot") {
    meeting.clear();
    for (const entry of type === "meeting" ? data : data.meeting) meeting.set(entry.id, entry);
  } else if (type === "reaction") {
    showReaction(data);
  }
  queueMicrotask(() => {
    refresh();
    if (type === "presence" || type === "snapshot") syncMute();
  });
});

for (const emoji of REACTIONS) {
  const button = element("button", "reaction-button", emoji);
  button.type = "button";
  button.setAttribute("aria-label", `React ${emoji}`);
  button.addEventListener("click", () => report("/api/react", { emoji }));
  $("reactions").append(button);
}
$("hand").addEventListener("click", () => report("/api/meeting", { hand: !me()?.hand }));
$("toggle-mic").addEventListener("click", () => queueMicrotask(syncMute));
$("people-toggle").addEventListener("click", () => {
  const open = $("people").hidden;
  $("people").hidden = !open;
  $("people-toggle").setAttribute("aria-expanded", String(open));
  refresh();
});
$("chat-jump").addEventListener("click", () => {
  $("messages").scrollTop = $("messages").scrollHeight;
  $("message-input").focus();
  clearUnread();
});
$("approval-jump").addEventListener("click", () => {
  $("approvals").scrollIntoView({ block: "nearest" });
});
$("messages").addEventListener("scroll", clearUnread, { passive: true });
document.addEventListener("visibilitychange", clearUnread);
new MutationObserver(decorateTiles).observe($("grid"), { childList: true });

// Small public API so other features can reach meeting actions without editing this file.
window.roomMeeting = {
  raiseHand: () => report("/api/meeting", { hand: true }),
  lowerHand: () => report("/api/meeting", { hand: false }),
  isHandRaised: () => Boolean(me()?.hand),
  react: (emoji) => report("/api/react", { emoji }),
  reactions: [...REACTIONS],
};
