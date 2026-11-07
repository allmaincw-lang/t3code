// Code tab: everyone in the Room co-edits real project files live.
// Text syncs through window.roomSync (Yjs updates); disk is written by autosave.
const app = window.roomApp;
const SAVE_DELAY = 1000;
const SEND_DELAY = 120;
const COMPACT_AFTER = 300;
const COLORS = ["#5b8cff", "#46a758", "#f5a524", "#e5484d", "#b07cff", "#2cc1c1", "#ff7eb6", "#9acd32"];

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
const toBase64 = (bytes) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const colorFor = (name) => {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
};

const languageFor = (path) => {
  const { languages } = window.RoomCode;
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"].includes(ext)) {
    return languages.javascript({ jsx: true, typescript: ext.includes("t") });
  }
  if (ext === "json") return languages.json();
  if (ext === "css") return languages.css();
  if (["html", "htm", "svg"].includes(ext)) return languages.html();
  if (["md", "markdown"].includes(ext)) return languages.markdown();
  if (ext === "py") return languages.python();
  return [];
};

// A claim lists files, directories ("src/") or simple globs ("src/*.ts").
const claimMatches = (pattern, path) => {
  if (pattern === path) return true;
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  if (pattern.includes("*")) {
    const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
    return new RegExp(`^${source}$`).test(path);
  }
  return false;
};

const mount = (pane) => {
  if (!window.RoomCode) {
    pane.append(el("p", "muted", "The editor did not load."));
    return;
  }
  const { basicSetup, EditorState, Compartment, EditorView, keymap, indentWithTab, oneDark, Y, yCollab, Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } = window.RoomCode;

  const wrap = el("div", "code-wrap");
  const side = el("div", "code-side");
  const filesToggle = el("button", "code-files-toggle", "Files");
  filesToggle.type = "button";
  filesToggle.setAttribute("aria-expanded", "true");
  const tree = el("div", "code-tree");
  const git = el("div", "code-git");
  const gitHead = el("div", "code-git-head");
  const branchLabel = el("strong", "", "Git");
  const refresh = el("button", "", "Refresh");
  refresh.type = "button";
  gitHead.append(branchLabel, refresh);
  const changes = el("ul", "code-changes");
  const commitForm = el("form", "code-commit");
  const message = el("input");
  message.type = "text";
  message.placeholder = "Commit message";
  message.maxLength = 500;
  message.setAttribute("aria-label", "Commit message");
  const commitButton = el("button", "primary", "Commit");
  commitButton.type = "submit";
  commitForm.append(message, commitButton);
  const gitNote = el("p", "muted code-note");
  git.append(gitHead, changes, commitForm, gitNote);
  side.append(tree, git);

  const main = el("div", "code-main");
  const bar = el("div", "code-bar");
  const title = el("strong", "code-title", "Pick a file");
  const saveState = el("span", "muted code-save");
  const peers = el("span", "muted code-peers");
  const reload = el("button", "", "Reload from disk");
  reload.type = "button";
  reload.hidden = true;
  bar.append(title, peers, saveState, reload);
  const warn = el("div", "code-warn");
  warn.hidden = true;
  warn.setAttribute("role", "status");
  const editorHost = el("div", "code-editor");
  editorHost.append(el("p", "muted code-empty", "Open a file to start. Everyone who opens it edits the same text."));
  main.append(bar, warn, editorHost);
  wrap.append(filesToggle, side, main);
  pane.append(wrap);

  filesToggle.addEventListener("click", () => {
    const open = side.classList.toggle("code-side-collapsed");
    filesToggle.setAttribute("aria-expanded", String(!open));
  });

  let files = [];
  let changed = new Map();
  let claims = [];
  let current = null;
  let treeFailed = null;
  const acknowledged = new Set();

  const claimFor = (path) => claims.find((claim) => (claim.files ?? []).some((pattern) => claimMatches(pattern, path)));

  const loadClaims = async () => {
    try {
      const source = window.roomMail?.claims;
      const value = typeof source === "function" ? await source.call(window.roomMail) : await source;
      claims = Array.isArray(value) ? value : [];
    } catch {
      claims = [];
    }
    renderTree();
  };

  // Tree -----------------------------------------------------------------
  const renderTree = () => {
    tree.replaceChildren();
    if (treeFailed) {
      tree.append(el("p", "muted code-note", treeFailed));
      return;
    }
    const root = { dirs: new Map(), files: [] };
    for (const file of files) {
      const parts = file.path.split("/");
      let node = root;
      for (const part of parts.slice(0, -1)) {
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
      node.files.push({ name: parts.at(-1), path: file.path });
    }
    const build = (node, container, prefix, depth) => {
      for (const [name, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
        const details = el("details", "code-dir");
        const path = `${prefix}${name}/`;
        details.open = depth < 1 || (current?.path ?? "").startsWith(path);
        details.append(el("summary", "", name));
        build(child, details, path, depth + 1);
        container.append(details);
      }
      for (const file of node.files) {
        const button = el("button", "code-file");
        button.type = "button";
        button.title = file.path;
        button.dataset.path = file.path;
        if (current?.path === file.path) button.setAttribute("aria-current", "true");
        button.append(el("span", "code-file-name", file.name));
        const claim = claimFor(file.path);
        if (claim) {
          const badge = el("span", "code-badge", `claimed by ${claim.agent}`);
          badge.title = `#${claim.number} ${claim.title ?? ""}`.trim();
          button.append(badge);
        }
        if (changed.has(file.path)) button.append(el("span", "code-dot", changed.get(file.path)));
        button.addEventListener("click", () => {
          void openFile(file.path);
          if (window.matchMedia("(max-width: 800px)").matches) {
            side.classList.add("code-side-collapsed");
            filesToggle.setAttribute("aria-expanded", "false");
          }
        });
        container.append(button);
      }
    };
    if (files.length === 0) tree.append(el("p", "muted code-note", "No shareable files."));
    build(root, tree, "", 0);
  };

  const loadTree = async () => {
    try {
      const result = await app.api("/api/code/tree", {});
      files = result.files;
      treeFailed = null;
      if (result.truncated) gitNote.textContent = "Showing the first files only.";
    } catch (error) {
      treeFailed = error.message;
    }
    renderTree();
  };

  // Git ------------------------------------------------------------------
  const loadStatus = async () => {
    try {
      const status = await app.api("/api/code/status", {});
      branchLabel.textContent = `Git: ${status.branch}`;
      changed = new Map(status.changes.map((change) => [change.path, change.code]));
      changes.replaceChildren(
        ...status.changes.map((change) => {
          const item = el("li");
          item.append(el("span", "code-dot", change.code), document.createTextNode(` ${change.path}`));
          return item;
        }),
      );
      if (status.changes.length === 0) changes.append(el("li", "muted", "Nothing to commit."));
      commitButton.disabled = status.changes.length === 0 || !status.isRoot;
      gitNote.textContent = status.isRoot ? "" : "The shared folder is not the top of a git worktree.";
    } catch (error) {
      gitNote.textContent = error.message;
      commitButton.disabled = true;
    }
    renderTree();
  };
  refresh.addEventListener("click", () => void Promise.all([loadTree(), loadStatus(), loadClaims()]));
  commitForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = message.value.trim();
    if (!text) return;
    commitButton.disabled = true;
    try {
      await flushSave();
      const result = await app.api("/api/code/commit", { message: text });
      message.value = "";
      app.notify(`Committed ${result.commit}: ${text}`);
    } catch (error) {
      gitNote.textContent = error.message;
    }
    void loadStatus();
  });

  // Editor ---------------------------------------------------------------
  const setSaveState = (text) => {
    saveState.textContent = text;
  };

  const flushSave = async () => {
    const session = current;
    if (!session || !session.dirty) return;
    clearTimeout(session.saveTimer);
    session.dirty = false;
    setSaveState("Saving...");
    try {
      await app.api("/api/code/save", { path: session.path, text: session.ytext.toString() });
      if (current === session) setSaveState("Saved");
      void loadStatus();
    } catch (error) {
      session.dirty = true;
      if (current === session) setSaveState(`Not saved: ${error.message}`);
    }
  };

  const closeFile = async () => {
    const session = current;
    if (!session) return;
    await flushSave();
    current = null;
    clearTimeout(session.sendTimer);
    clearInterval(session.beat);
    session.unsubscribe();
    window.removeEventListener("room:event", session.onPresence);
    removeAwarenessStates(session.awareness, [session.ydoc.clientID], "close");
    sendPresence(session, [session.ydoc.clientID]);
    session.view.destroy();
    session.ydoc.destroy();
  };

  const sendPresence = (session, ids) => {
    const update = toBase64(encodeAwarenessUpdate(session.awareness, ids));
    app.api("/api/code/presence", { doc: session.doc, update, from: app.state.connectionId }).catch(() => {});
  };

  const flushUpdates = async (session) => {
    if (session.pending.length === 0) return;
    const merged = Y.mergeUpdates(session.pending);
    session.pending = [];
    try {
      await window.roomSync.send(session.doc, toBase64(merged));
      session.updates += 1;
    } catch (error) {
      session.pending.unshift(merged);
      setSaveState(`Offline: ${error.message}`);
      clearTimeout(session.sendTimer);
      session.sendTimer = setTimeout(() => void flushUpdates(session), 3000);
    }
  };

  const maybeCompact = async (session) => {
    if (session.updates < COMPACT_AFTER || session.pending.length > 0) return;
    try {
      await window.roomSync.compact(session.doc, toBase64(Y.encodeStateAsUpdate(session.ydoc)));
      session.updates = 1;
    } catch {}
  };

  const showWarning = (claim) => {
    if (!claim) {
      warn.hidden = true;
      return;
    }
    warn.hidden = false;
    warn.textContent = `${claim.agent} has claimed this file${claim.branch ? ` on ${claim.branch}` : ""}. Editing here may conflict with their work.`;
  };

  const updatePeers = (session) => {
    const names = new Set();
    for (const [id, state] of session.awareness.getStates()) {
      if (id !== session.ydoc.clientID && state.user) names.add(state.user.name);
    }
    peers.textContent = names.size ? `Also here: ${[...names].join(", ")}` : "";
  };

  async function openFile(path) {
    if (current?.path === path) return;
    await closeFile();
    editorHost.replaceChildren(el("p", "muted code-empty", "Opening..."));
    title.textContent = path;
    setSaveState("");
    peers.textContent = "";
    reload.hidden = true;
    let opened;
    try {
      opened = await app.api("/api/code/open", { path, from: app.state.connectionId });
    } catch (error) {
      editorHost.replaceChildren(el("p", "code-empty code-error", error.message));
      return;
    }
    const name = app.state.me ?? opened.person;
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("code");
    const awareness = new Awareness(ydoc);
    const color = colorFor(name);
    awareness.setLocalStateField("user", { name, color, colorLight: `${color}33` });
    const session = {
      path, doc: opened.doc, ydoc, ytext, awareness, view: null, pending: [], updates: 0,
      dirty: false, saveTimer: 0, sendTimer: 0, beat: 0, unsubscribe: () => {}, onPresence: null,
    };

    ydoc.on("update", (update, origin) => {
      if (origin === "remote") return;
      session.pending.push(update);
      clearTimeout(session.sendTimer);
      session.sendTimer = setTimeout(() => void flushUpdates(session), SEND_DELAY);
      session.dirty = true;
      setSaveState("Editing...");
      clearTimeout(session.saveTimer);
      session.saveTimer = setTimeout(() => {
        void flushSave().then(() => maybeCompact(session));
      }, SAVE_DELAY);
    });

    // Subscribe before loading so nothing between the two is missed; Yjs ignores repeats.
    session.unsubscribe = window.roomSync.subscribe(opened.doc, (update) => {
      Y.applyUpdate(ydoc, fromBase64(update), "remote");
      session.updates += 1;
    });
    try {
      const history = await window.roomSync.load(opened.doc);
      for (const update of history) Y.applyUpdate(ydoc, fromBase64(update), "remote");
      session.updates = history.length;
    } catch (error) {
      session.unsubscribe();
      editorHost.replaceChildren(el("p", "code-empty code-error", error.message));
      return;
    }
    // Only the caller the server picked seeds the document, so text is never doubled.
    if (opened.seed && ytext.length === 0 && opened.text !== "") {
      ytext.insert(0, opened.text);
      session.dirty = false;
      clearTimeout(session.saveTimer);
      setSaveState("Saved");
    } else if (!opened.seed && ytext.length === 0 && opened.text !== "") {
      // Another person is seeding. If they never finish, claim the seed ourselves.
      setTimeout(async () => {
        if (current !== session || ytext.length > 0) return;
        try {
          const retry = await app.api("/api/code/open", { path, from: app.state.connectionId });
          if (retry.seed && current === session && ytext.length === 0) ytext.insert(0, retry.text);
        } catch {}
      }, 21_000);
    }

    session.onPresence = ({ detail }) => {
      if (detail.type !== "code-presence" || detail.data.doc !== session.doc) return;
      if (detail.data.from === app.state.connectionId) return;
      const before = session.awareness.getStates().size;
      applyAwarenessUpdate(awareness, fromBase64(detail.data.update), "remote");
      if (session.awareness.getStates().size > before) sendPresence(session, [ydoc.clientID]);
      updatePeers(session);
    };
    window.addEventListener("room:event", session.onPresence);
    let presenceTimer = 0;
    awareness.on("update", (_changes, origin) => {
      if (origin === "remote" || origin === "close") return;
      clearTimeout(presenceTimer);
      presenceTimer = setTimeout(() => sendPresence(session, [ydoc.clientID]), 100);
    });
    session.beat = setInterval(() => sendPresence(session, [ydoc.clientID]), 10_000);

    const claim = claimFor(path);
    showWarning(claim);
    const claimGuard = EditorView.domEventHandlers({
      beforeinput(event) {
        const live = claimFor(path);
        if (!live || acknowledged.has(path)) return false;
        event.preventDefault();
        if (window.confirm(`${live.agent} has claimed ${path}${live.branch ? ` on ${live.branch}` : ""}. Edit it anyway?`)) {
          acknowledged.add(path);
        }
        return true;
      },
    });
    const language = new Compartment();
    session.view = new EditorView({
      parent: (editorHost.replaceChildren(), editorHost),
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          oneDark,
          EditorView.lineWrapping,
          language.of(languageFor(path)),
          yCollab(ytext, awareness),
          claimGuard,
        ],
      }),
    });
    current = session;
    reload.hidden = false;
    setSaveState(session.dirty ? "Editing..." : "Saved");
    updatePeers(session);
    sendPresence(session, [ydoc.clientID]);
    renderTree();
    void maybeCompact(session);
  }

  reload.addEventListener("click", async () => {
    const session = current;
    if (!session || !window.confirm("Replace the shared text with what is on disk? This changes it for everyone.")) return;
    try {
      const opened = await app.api("/api/code/open", { path: session.path, from: app.state.connectionId });
      session.ydoc.transact(() => {
        session.ytext.delete(0, session.ytext.length);
        session.ytext.insert(0, opened.text);
      });
    } catch (error) {
      setSaveState(error.message);
    }
  });

  window.addEventListener("pagehide", () => void flushSave());

  mount.show = () => {
    void Promise.all([loadTree(), loadStatus(), loadClaims()]);
  };
};

let shown = () => {};
window.roomWorkspace.addTab({
  id: "code",
  label: "Code",
  mount(pane) {
    mount(pane);
    shown = mount.show;
  },
  onShow() {
    shown();
  },
});
