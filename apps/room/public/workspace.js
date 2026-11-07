// Workspace tabs and the shared-document relay. Features register a tab with
// window.roomWorkspace.addTab and share live edits through window.roomSync.
const app = window.roomApp;
const tabs = document.getElementById("workspace-tabs");
const panes = document.getElementById("workspace-panes");
const meetingParts = ["jarvis", "people", "grid"].map((id) => document.getElementById(id));
const registered = new Map();
let active = "people";

const show = (id) => {
  if (!registered.has(id) && id !== "people") return;
  active = id;
  for (const part of meetingParts) part?.classList.toggle("workspace-hidden", id !== "people");
  for (const [tabId, entry] of registered) {
    entry.pane.hidden = tabId !== id;
    entry.button.setAttribute("aria-selected", String(tabId === id));
    if (tabId === id && !entry.mounted) {
      entry.mounted = true;
      entry.mount(entry.pane);
    }
    if (tabId === id) entry.onShow?.();
  }
  peopleButton.setAttribute("aria-selected", String(id === "people"));
  try {
    localStorage.setItem("room-tab", id);
  } catch {}
};

const tabButton = (id, label) => {
  const button = document.createElement("button");
  button.type = "button";
  button.role = "tab";
  button.textContent = label;
  button.dataset.tab = id;
  button.addEventListener("click", () => show(id));
  tabs.append(button);
  return button;
};
const peopleButton = tabButton("people", "Meeting");
peopleButton.setAttribute("aria-selected", "true");

window.roomWorkspace = {
  /** mount(pane) runs the first time the tab opens; onShow() runs every time. */
  addTab({ id, label, mount, onShow }) {
    if (registered.has(id) || id === "people") throw new Error(`Tab ${id} already exists`);
    const pane = document.createElement("section");
    pane.className = "workspace-pane";
    pane.hidden = true;
    pane.setAttribute("aria-label", label);
    panes.append(pane);
    registered.set(id, { pane, button: tabButton(id, label), mount, onShow, mounted: false });
    let saved = null;
    try {
      saved = localStorage.getItem("room-tab");
    } catch {}
    if (saved === id) show(id);
    return { pane, show: () => show(id) };
  },
  show,
  get active() {
    return active;
  },
};

// Shared documents. Updates are opaque base64 strings (for example Yjs updates).
const listeners = new Map();
const connectionId = () => app.state.connectionId;
window.roomSync = {
  /** Every update stored for a document, oldest first. */
  load: async (doc) => (await app.api("/api/sync/load", { doc })).updates,
  send: (doc, update) => app.api("/api/sync", { doc, update, from: connectionId() }),
  /** Replace a document's history with one merged snapshot. */
  compact: (doc, snapshot) => app.api("/api/sync/compact", { doc, snapshot }),
  /** cb(update, { by }) for updates from other connections; returns an unsubscribe function. */
  subscribe(doc, cb) {
    if (!listeners.has(doc)) listeners.set(doc, new Set());
    listeners.get(doc).add(cb);
    return () => listeners.get(doc)?.delete(cb);
  },
};
window.addEventListener("room:event", ({ detail: { type, data } }) => {
  if (type !== "sync" || data.from === connectionId()) return;
  for (const cb of listeners.get(data.doc) ?? []) cb(data.update, { by: data.by });
});
