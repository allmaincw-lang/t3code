// Board tab: one shared Excalidraw scene, synced through roomSync on "board:main".
// Update payloads are base64(JSON): {t:"els", els:[...]} or {t:"file", file:{...}}.
const DOC = "board:main";
const SEND_MS = 250;
const CHUNK_JSON = 300_000; // keeps a base64 update well under the 700 KB relay limit
const MAX_UPDATE = 690_000;
const MAX_IMAGE = 380_000; // data URL chars per image after downscaling
const COMPACT_AFTER = 150; // updates in the log at open time

const app = window.roomApp;
const enc = (obj) => {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const dec = (b64) => {
  try {
    const bin = atob(b64);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
};
const stamp = (el) => `${el.version}:${el.versionNonce}`;

const loadLib = async () => {
  if (window.RoomBoardLib) return window.RoomBoardLib;
  window.EXCALIDRAW_ASSET_PATH = new URL("vendor/board/", document.baseURI).href;
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "vendor/board/board.css";
  document.head.append(css);
  const own = document.createElement("link");
  own.rel = "stylesheet";
  own.href = "board.css";
  document.head.append(own);
  await import(new URL("vendor/board/board.js", document.baseURI).href);
  return window.RoomBoardLib;
};

// Shrink a too-large image to a JPEG that fits; returns null when it cannot.
const fitImage = async (file) => {
  if (file.dataURL.length <= MAX_IMAGE) return file;
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = file.dataURL;
    });
    for (const [max, quality] of [[1200, 0.7], [900, 0.6], [600, 0.5]]) {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataURL = canvas.toDataURL("image/jpeg", quality);
      if (dataURL.length <= MAX_IMAGE) return { ...file, mimeType: "image/jpeg", dataURL };
    }
  } catch {}
  return null;
};

const mountBoard = async (pane) => {
  pane.innerHTML = "";
  const root = document.createElement("div");
  root.className = "board";
  const bar = document.createElement("div");
  bar.className = "board-bar";
  const status = document.createElement("span");
  status.className = "muted";
  status.setAttribute("role", "status");
  status.textContent = "Loading the board...";
  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.textContent = "Export PNG";
  exportButton.disabled = true;
  bar.append(status, exportButton);
  const canvas = document.createElement("div");
  canvas.className = "board-canvas";
  root.append(bar, canvas);
  pane.append(root);

  const say = (text) => {
    status.textContent = text;
    app.notify?.(text);
  };

  let lib;
  let updates;
  try {
    [lib, updates] = await Promise.all([loadLib(), window.roomSync.load(DOC)]);
  } catch (error) {
    status.textContent = "Could not load the board.";
    console.error(error);
    return;
  }

  const sentStamp = new Map(); // element id -> stamp already shared (or received)
  const sentFiles = new Set();
  const files = {};
  let elements = []; // all elements including deleted, reconciled
  let api = null;
  let ready = false;
  const queue = [];

  const mergeEls = (remote, appState = {}) => {
    const restored = lib.restoreElements(remote, null);
    elements = lib.reconcileElements(elements, restored, appState);
    for (const el of remote) sentStamp.set(el.id, stamp(el));
  };
  const take = (update) => {
    const msg = dec(update);
    if (!msg) return null;
    if ((msg.t === "els" || msg.t === "snap") && Array.isArray(msg.els)) return msg;
    if (msg.t === "file" && msg.file?.id && typeof msg.file.dataURL === "string") return msg;
    return null;
  };
  const apply = (msg) => {
    if (msg.t === "snap") {
      apply({ t: "els", els: msg.els });
      for (const file of msg.files ?? []) apply({ t: "file", file });
    } else if (msg.t === "els") {
      if (!api) return mergeEls(msg.els);
      const merged = lib.reconcileElements(
        api.getSceneElementsIncludingDeleted(),
        lib.restoreElements(msg.els, null),
        api.getAppState(),
      );
      for (const el of msg.els) sentStamp.set(el.id, stamp(el));
      api.updateScene({ elements: merged, captureUpdate: "NEVER" });
    } else {
      const file = msg.file;
      sentFiles.add(file.id);
      files[file.id] = file;
      api?.addFiles([file]);
    }
  };

  let count = 0;
  for (const update of updates) {
    const msg = take(update);
    if (!msg) continue;
    count += 1;
    apply(msg);
  }

  // Updates that arrive while the editor is still starting are applied once it is ready.
  const stop = window.roomSync.subscribe(DOC, (update) => {
    const msg = take(update);
    if (!msg) return;
    if (ready) apply(msg);
    else queue.push(msg);
  });

  let timer = null;
  let outbox = Promise.resolve();
  const post = (obj) => {
    const update = enc(obj);
    if (update.length > MAX_UPDATE) return false;
    outbox = outbox
      .then(() => window.roomSync.send(DOC, update))
      .catch((error) => {
        status.textContent = "Could not sync the last change. Check your connection.";
        console.error(error);
      });
    return true;
  };
  const flush = async () => {
    timer = null;
    if (!api) return;
    const all = api.getSceneElementsIncludingDeleted();
    const live = api.getAppState();
    const pendingFiles = [];
    const changed = [];
    for (const el of all) {
      if (sentStamp.get(el.id) === stamp(el)) continue;
      if (el.type === "image" && el.fileId && !el.isDeleted && !sentFiles.has(el.fileId)) pendingFiles.push(el);
      changed.push(el);
    }
    // Images first, so peers rarely see an element before its pixels.
    const drop = new Set();
    for (const el of pendingFiles) {
      const file = api.getFiles()[el.fileId];
      if (!file) continue; // still decoding; picked up on the next change
      sentFiles.add(el.fileId);
      const fitted = await fitImage(file);
      if (fitted && post({ t: "file", file: { ...fitted, id: el.fileId } })) {
        files[el.fileId] = fitted;
        if (fitted !== file) api.addFiles([{ ...fitted, id: el.fileId }]);
        continue;
      }
      drop.add(el.id);
      say("An image was too large to share, so it was removed from the board.");
    }
    if (drop.size) {
      api.updateScene({
        elements: api.getSceneElementsIncludingDeleted().map((el) => (drop.has(el.id) ? { ...el, isDeleted: true, version: el.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) } : el)),
        captureUpdate: "NEVER",
      });
      return;
    }
    const mid = live.newElement?.id;
    let batch = [];
    let size = 0;
    const emit = () => {
      if (batch.length) post({ t: "els", els: batch });
      batch = [];
      size = 0;
    };
    for (const el of changed) {
      if (el.id === mid && live.cursorButton === "down") continue; // still being drawn
      const length = JSON.stringify(el).length;
      if (length > CHUNK_JSON) {
        sentStamp.set(el.id, stamp(el));
        say("One shape was too large to share, so only you can see it.");
        continue;
      }
      if (size + length > CHUNK_JSON) emit();
      batch.push(el);
      size += length;
      sentStamp.set(el.id, stamp(el));
    }
    emit();
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(flush, SEND_MS);
  };

  const initialFiles = Object.values(files);
  lib.mount(canvas, {
    initialData: {
      elements: lib.restoreElements(elements, null),
      files: Object.fromEntries(initialFiles.map((f) => [f.id, f])),
      scrollToContent: true,
    },
    theme: "dark",
    name: "room-board",
    langCode: "en",
    UIOptions: { canvasActions: { saveToActiveFile: false, loadScene: false, export: false, toggleTheme: false } },
    excalidrawAPI: (instance) => {
      api = instance;
      ready = true;
      for (const msg of queue.splice(0)) apply(msg);
      exportButton.disabled = false;
      status.textContent = "Everyone in the room sees this board live.";
    },
    onChange: () => {
      if (ready) schedule();
    },
  });

  exportButton.addEventListener("click", async () => {
    if (!api) return;
    const live = api.getSceneElements();
    if (!live.length) return say("The board is empty.");
    try {
      const blob = await lib.exportToBlob({
        elements: live,
        appState: { ...api.getAppState(), exportBackground: true, exportWithDarkMode: false },
        files: api.getFiles(),
        mimeType: "image/png",
      });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `board-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    } catch (error) {
      console.error(error);
      say("Could not export the board.");
    }
  });

  // Long histories collapse into one snapshot, merged here, when the board opens.
  // The relay keeps a single entry, so compact only when the whole board fits in one.
  if (count > COMPACT_AFTER) {
    const pack = (withDeleted) =>
      enc({ t: "snap", els: elements.filter((el) => withDeleted || !el.isDeleted), files: Object.values(files) });
    let snapshot = pack(true);
    if (snapshot.length > MAX_UPDATE) snapshot = pack(false);
    if (snapshot.length <= MAX_UPDATE) window.roomSync.compact(DOC, snapshot).catch(() => {});
  }

  window.addEventListener("pagehide", () => {
    stop();
  });
};

window.roomWorkspace.addTab({
  id: "board",
  label: "Board",
  mount: mountBoard,
  onShow: () => window.dispatchEvent(new Event("resize")),
});
