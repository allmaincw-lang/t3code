// The Mail tab: agent mail (GitHub issues) inside the Room. The server does all GitHub access.
// Other tabs can ask which files are claimed: window.roomMail.claims().
const app = window.roomApp;
const workspace = window.roomWorkspace;

const state = { threads: null, claims: null, inbox: null, view: "list", error: "", busy: false };
let root = null;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (label, className, onClick) => {
  const node = el("button", className, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
};
const when = (iso) => {
  if (!iso) return "";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1_440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1_440)}d ago`;
};

const loadList = async () => {
  const [threads, claims] = await Promise.all([
    app.api("/api/mail/threads", {}),
    app.api("/api/mail/claims", {}),
  ]);
  state.threads = threads;
  state.claims = claims.claims;
};

const refresh = async () => {
  state.busy = true;
  state.error = "";
  render();
  try {
    await loadList();
  } catch (error) {
    state.error = error.message;
  }
  state.busy = false;
  render();
};

// For other tabs (the code editor shows who is editing what). Never throws.
window.roomMail = {
  async claims() {
    try {
      return (await app.api("/api/mail/claims", {})).claims;
    } catch (error) {
      console.warn("roomMail.claims:", error.message);
      return [];
    }
  },
  async threads() {
    try {
      return (await app.api("/api/mail/threads", {})).threads;
    } catch (error) {
      console.warn("roomMail.threads:", error.message);
      return [];
    }
  },
};

const field = (label, control) => {
  const wrap = el("label", "mail-field");
  wrap.append(el("span", "mail-label", label), control);
  return wrap;
};

const renderList = (frag) => {
  const head = el("div", "mail-head");
  head.append(
    el("strong", "", state.threads?.repo ?? "Agent mail"),
    button("New thread", "", () => ((state.view = "new"), render())),
    button("Refresh", "", refresh),
  );
  frag.append(head);
  if (state.busy && !state.threads) frag.append(el("p", "muted", "Loading..."));
  if (!state.threads) return;

  const inboxes = el("div", "mail-chips");
  inboxes.setAttribute("role", "group");
  inboxes.setAttribute("aria-label", "Inboxes");
  const chip = (label, count, value) => {
    const node = button(`${label} ${count}`, "mail-chip", () => {
      state.inbox = state.inbox === value ? null : value;
      render();
    });
    node.setAttribute("aria-pressed", String(state.inbox === value));
    return node;
  };
  const counts = Object.entries(state.threads.inboxes).sort(([a], [b]) => a.localeCompare(b));
  if (counts.length === 0) inboxes.append(el("span", "muted", "No tagged threads."));
  for (const [name, count] of counts) inboxes.append(chip(`to:${name}`, count, name));
  frag.append(inboxes);

  frag.append(el("h3", "mail-h", `Claims (${state.claims.length})`));
  const claims = el("ul", "mail-rows");
  for (const claim of state.claims) {
    const row = el("li", "mail-row");
    const open = button(claim.title, "mail-link", () => openThread(claim.number));
    const meta = [claim.agent, claim.branch].filter(Boolean).join(" · ");
    row.append(open, el("div", "muted mail-meta", meta));
    if (claim.files.length > 0) row.append(el("div", "mail-files", claim.files.join("  ")));
    claims.append(row);
  }
  if (state.claims.length === 0) claims.append(el("li", "muted", "No open claims."));
  frag.append(claims);

  const shown = state.threads.threads.filter(
    (thread) => !thread.directory && (!state.inbox || thread.inboxes.includes(state.inbox)),
  );
  frag.append(el("h3", "mail-h", `Threads (${shown.length})`));
  const list = el("ul", "mail-rows");
  for (const thread of shown) {
    const row = el("li", "mail-row");
    row.append(button(`#${thread.number} ${thread.title}`, "mail-link", () => openThread(thread.number)));
    const tags = thread.inboxes.map((name) => `to:${name}`).join(" ");
    row.append(el("div", "muted mail-meta", [when(thread.updatedAt), tags].filter(Boolean).join(" · ")));
    list.append(row);
  }
  if (shown.length === 0) list.append(el("li", "muted", "Nothing here."));
  frag.append(list);
};

const openThread = async (number) => {
  state.view = "thread";
  state.thread = null;
  state.error = "";
  render();
  try {
    state.thread = (await app.api("/api/mail/thread", { number })).thread;
  } catch (error) {
    state.error = error.message;
  }
  render();
};

const post = async (action) => {
  state.busy = true;
  state.error = "";
  render();
  try {
    await action();
  } catch (error) {
    state.error = error.message;
  }
  state.busy = false;
  render();
};

const renderThread = (frag) => {
  const head = el("div", "mail-head");
  head.append(
    button("Back", "", () => ((state.view = "list"), (state.error = ""), render())),
  );
  const thread = state.thread;
  if (thread) {
    const link = el("a", "mail-link-out", `#${thread.number} on GitHub`);
    link.href = thread.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    head.append(link);
  }
  frag.append(head);
  if (!thread) {
    if (!state.error) frag.append(el("p", "muted", "Loading..."));
    return;
  }
  frag.append(el("h3", "mail-h", thread.title));
  const messages = el("div", "mail-messages");
  const message = (author, body, at) => {
    const box = el("article", "mail-message");
    box.append(el("div", "muted mail-meta", [author, when(at)].filter(Boolean).join(" · ")));
    box.append(el("div", "mail-body", body));
    messages.append(box);
  };
  message(thread.from || "thread", thread.body, null);
  for (const comment of thread.comments) message(comment.author, comment.body, comment.at);
  frag.append(messages);

  if (thread.state !== "OPEN") {
    frag.append(el("p", "muted", "This thread is closed."));
    return;
  }
  const text = el("textarea", "mail-input");
  text.rows = 4;
  text.maxLength = 8000;
  text.placeholder = `Reply as ${state.threads?.me ?? "your room"}`;
  text.value = state.draft ?? "";
  text.addEventListener("input", () => (state.draft = text.value));
  const send = button(state.busy ? "Sending..." : "Reply", "primary", () => {
    if (!text.value.trim()) return;
    void post(async () => {
      await app.api("/api/mail/reply", { number: thread.number, text: text.value });
      state.draft = "";
      state.thread = (await app.api("/api/mail/thread", { number: thread.number })).thread;
    });
  });
  send.disabled = state.busy;
  frag.append(field("Your reply", text), send);
};

const renderNew = (frag) => {
  const head = el("div", "mail-head");
  head.append(button("Back", "", () => ((state.view = "list"), (state.error = ""), render())));
  frag.append(head, el("h3", "mail-h", "New thread"));
  const inbox = el("select", "mail-input");
  inbox.append(new Option("No inbox", ""), new Option("to:all", "all"));
  for (const name of Object.keys(state.threads?.inboxes ?? {}).sort()) {
    if (name !== "all") inbox.append(new Option(`to:${name}`, name));
  }
  const title = el("input", "mail-input");
  title.maxLength = 120;
  title.placeholder = "Short topic";
  const body = el("textarea", "mail-input");
  body.rows = 6;
  body.maxLength = 8000;
  body.placeholder = "What / Why / Ask / Links / Status";
  const nd = (state.draftNew ??= { inbox: "", title: "", body: "" });
  for (const [key, node] of [["inbox", inbox], ["title", title], ["body", body]]) {
    node.value = nd[key];
    node.addEventListener("input", () => (nd[key] = node.value));
  }
  const send = button(state.busy ? "Sending..." : "Send", "primary", () => {
    if (!title.value.trim() || !body.value.trim()) {
      state.error = "Add a topic and a message.";
      return render();
    }
    void post(async () => {
      const result = await app.api("/api/mail/new", {
        title: title.value,
        body: body.value,
        inbox: inbox.value || undefined,
      });
      state.view = "list";
      state.draftNew = null;
      await loadList();
      app.notify(result.number ? `Sent thread #${result.number}.` : "Thread sent.");
    });
  });
  send.disabled = state.busy;
  frag.append(field("Tag an inbox", inbox), field("Topic", title), field("Message", body), send);
};

const render = () => {
  if (!root) return;
  const frag = document.createDocumentFragment();
  if (state.error) {
    const alert = el("p", "mail-error", state.error);
    alert.setAttribute("role", "alert");
    frag.append(alert);
  }
  if (state.view === "thread") renderThread(frag);
  else if (state.view === "new") renderNew(frag);
  else renderList(frag);
  root.replaceChildren(frag);
};

workspace.addTab({
  id: "mail",
  label: "Mail",
  mount(pane) {
    root = el("div", "mail");
    pane.append(root);
    void refresh();
  },
  onShow() {
    if (state.view === "list" && state.threads) void refresh();
  },
});
