// "3D" workspace tab: holographic agent avatars and a shared model viewer.
// three.js loads only when the tab first opens. Both scenes render on demand;
// the avatar loop runs only while an agent is working or speaking, and every
// GPU resource is released after the tab has been hidden for a while.
const app = window.roomApp;
const DOC = "view3d:main";
const MODELS = [
  { id: "robot", label: "Robot", file: "models/robot.glb" },
  { id: "crystal", label: "Crystal", file: "models/crystal.glb" },
  { id: "knot", label: "Knot", file: "models/knot.glb" },
];
const SEND_EVERY_MS = 250;
const COMPACT_AFTER = 150;
const DISPOSE_AFTER_MS = 30_000;
const SPEAK_MS = 2600;
const LOOK = {
  idle: { color: [0.25, 0.85, 1], label: "Idle" },
  working: { color: [0.45, 0.6, 1], label: "Thinking" },
  "needs-approval": { color: [1, 0.68, 0.15], label: "Needs approval" },
  error: { color: [1, 0.25, 0.3], label: "Error" },
  offline: { color: [0.35, 0.4, 0.45], label: "Offline" },
};
const link = document.createElement("link");
link.rel = "stylesheet";
link.href = "view3d.css";
document.head.append(link);

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const statusOf = (agent) => (agent.online ? agent.status : "offline");
const encode = (value) => btoa(JSON.stringify(value));
const decode = (text) => {
  try {
    return JSON.parse(atob(text));
  } catch {
    return null;
  }
};

let T = null; // three namespace
let GLTFLoader = null;
const loadThree = async () => {
  T ??= await import("./vendor/three/three.module.min.js");
  return T;
};

// Disposes a scene's GPU resources; the renderer and canvas go with it.
const disposeScene = (scene) => {
  scene.traverse((obj) => {
    obj.geometry?.dispose();
    for (const mat of [obj.material].flat()) {
      if (!mat) continue;
      for (const value of Object.values(mat)) if (value?.isTexture) value.dispose();
      mat.dispose();
    }
  });
};

const makeRenderer = (holder, label) => {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", label);
  holder.prepend(canvas);
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  renderer.setClearColor(0x000000, 0);
  return { canvas, renderer };
};

// ---------- Avatars ----------

const glowTexture = () => {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.35)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new T.CanvasTexture(c);
};

const SHELLS = {
  idle: () => new T.IcosahedronGeometry(0.62, 1),
  working: () => new T.IcosahedronGeometry(0.62, 1),
  offline: () => new T.IcosahedronGeometry(0.55, 0),
  "needs-approval": () => new T.OctahedronGeometry(0.72, 0),
  error: () => new T.TetrahedronGeometry(0.78, 0),
};

const buildStage = (holder, onClick) => {
  const { canvas, renderer } = makeRenderer(holder, "Agent avatars");
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(32, 1, 0.1, 50);
  const glow = glowTexture();
  const labels = el("div", "v3-labels");
  holder.append(labels);
  const avatars = new Map();
  let width = 0;
  let height = 0;

  const make = (agent) => {
    const group = new T.Group();
    const mat = (opacity, extra = {}) =>
      new T.MeshBasicMaterial({
        transparent: true,
        opacity,
        blending: T.AdditiveBlending,
        depthWrite: false,
        ...extra,
      });
    const shell = new T.Mesh(SHELLS.idle(), mat(0.9, { wireframe: true }));
    const inner = new T.Mesh(new T.IcosahedronGeometry(0.34, 0), mat(0.35, { wireframe: true }));
    const core = new T.Sprite(
      new T.SpriteMaterial({ map: glow, transparent: true, blending: T.AdditiveBlending, depthWrite: false }),
    );
    core.scale.setScalar(1.3);
    const ring = new T.Mesh(new T.TorusGeometry(0.95, 0.012, 6, 64), mat(0.8));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.85;
    const beam = new T.Mesh(new T.CylinderGeometry(0.12, 0.95, 0.85, 24, 1, true), mat(0.07, { side: T.DoubleSide }));
    beam.position.y = -0.43;
    group.add(beam, ring, shell, inner, core);
    scene.add(group);

    const button = el("button", "v3-avatar");
    button.type = "button";
    button.setAttribute("aria-label", `Mention ${agent.name}`);
    const name = el("span", "v3-name", agent.name);
    const state = el("span", "v3-state");
    button.append(name, state);
    button.addEventListener("click", () => onClick(agent.name));
    labels.append(button);
    return { group, shell, inner, core, ring, beam, button, state, status: null, color: [...LOOK.idle.color], speakUntil: 0, phase: Math.random() * 6 };
  };

  const place = () => {
    const list = [...avatars.values()];
    const cols = Math.max(1, Math.min(list.length, width < 520 ? 2 : width < 900 ? 3 : 5));
    const rows = Math.max(1, Math.ceil(list.length / cols));
    const cell = 2.3;
    const wanted = `${Math.max(230, rows * 118 + 40)}px`;
    if (holder.style.height !== wanted) holder.style.height = wanted;
    list.forEach((a, i) => {
      const row = Math.floor(i / cols);
      const inRow = Math.min(cols, list.length - row * cols);
      a.group.position.set((i % cols - (inRow - 1) / 2) * cell, ((rows - 1) / 2 - row) * 2.7 + 0.4, 0);
    });
    const aspect = width / Math.max(1, height);
    const needH = rows * 2.7 + 0.5;
    const needW = cols * cell + 0.4;
    const fovT = Math.tan((camera.fov * Math.PI) / 360);
    camera.position.set(0, 0.35, Math.max(needH / (2 * fovT), needW / (2 * fovT * aspect)) + 0.5);
    camera.lookAt(0, 0, 0);
  };

  const project = () => {
    for (const a of avatars.values()) {
      const p = a.group.position.clone().project(camera);
      a.button.style.left = `${((p.x + 1) / 2) * width}px`;
      a.button.style.top = `${((1 - p.y) / 2) * height}px`;
    }
  };

  const applyStatus = (a, agent) => {
    const status = statusOf(agent);
    if (a.status !== status) {
      a.status = status;
      a.shell.geometry.dispose();
      a.shell.geometry = (SHELLS[status] ?? SHELLS.idle)();
      a.button.dataset.status = status;
      a.state.textContent = LOOK[status]?.label ?? status;
    }
    a.target = LOOK[status]?.color ?? LOOK.idle.color;
  };

  const sync = (agents) => {
    const names = new Set();
    for (const agent of agents) {
      names.add(agent.name);
      let a = avatars.get(agent.name);
      if (!a) avatars.set(agent.name, (a = make(agent)));
      applyStatus(a, agent);
    }
    for (const [name, a] of avatars) {
      if (names.has(name)) continue;
      scene.remove(a.group);
      disposeScene(a.group);
      a.button.remove();
      avatars.delete(name);
    }
    place();
  };

  // Advances animation state; returns true while another frame is needed.
  const frame = (now, dt) => {
    let more = false;
    for (const a of avatars.values()) {
      const working = a.status === "working";
      const speaking = a.speakUntil > now;
      if (working || speaking) {
        more = true;
        a.shell.rotation.y += dt * (working ? 1.4 : 0.5);
        a.shell.rotation.x += dt * (working ? 0.7 : 0.2);
        a.inner.rotation.y -= dt * 2.1;
        a.ring.rotation.z += dt * (working ? 2 : 0.6);
      }
      for (let i = 0; i < 3; i++) {
        const d = a.target[i] - a.color[i];
        if (Math.abs(d) > 0.004) {
          a.color[i] += d * Math.min(1, dt * 9);
          more = true;
        } else a.color[i] = a.target[i];
      }
      const t = now / 1000 + a.phase;
      const pulse = speaking ? 1 + 0.16 * Math.sin(t * 11) : working ? 1 + 0.05 * Math.sin(t * 5) : 1;
      a.group.scale.setScalar(pulse);
      a.core.scale.setScalar((speaking ? 1.6 + 0.4 * Math.sin(t * 11) : 1.3) * (a.status === "offline" ? 0.7 : 1));
      a.ring.scale.setScalar(speaking ? 1 + 0.1 * Math.abs(Math.sin(t * 6)) : 1);
      const dim = a.status === "offline" ? 0.45 : 1;
      for (const m of [a.shell, a.inner, a.ring, a.beam]) m.material.color.setRGB(...a.color);
      a.core.material.color.setRGB(...a.color);
      a.shell.material.opacity = 0.7 * dim;
      a.core.material.opacity = (a.status === "idle" ? 0.4 : 0.75) * dim;
      if (!working && !speaking && a.shell.rotation.y === 0) {
        a.shell.rotation.set(0.4, 0.6, 0);
        a.inner.rotation.y = 0.3;
      }
    }
    return more;
  };

  const resize = (w, h) => {
    width = w;
    height = h;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    place();
  };
  const render = () => {
    renderer.render(scene, camera);
    project();
  };
  const dispose = () => {
    disposeScene(scene);
    glow.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
    labels.remove();
  };
  return { sync, frame, resize, render, dispose, avatars };
};

// ---------- Shared model viewer ----------

const buildViewer = async (holder, modelId, onLoaded) => {
  const { canvas, renderer } = makeRenderer(holder, "Shared 3D model");
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(40, 1, 0.05, 100);
  scene.add(new T.HemisphereLight(0xcfe8ff, 0x20242c, 1.6));
  const key = new T.DirectionalLight(0xffffff, 2.4);
  key.position.set(3, 4, 5);
  scene.add(key);
  const rim = new T.DirectionalLight(0x5b8cff, 1.6);
  rim.position.set(-4, 2, -4);
  scene.add(rim);
  const floor = new T.Mesh(
    new T.RingGeometry(0.9, 0.93, 64),
    new T.MeshBasicMaterial({ color: 0x5b8cff, transparent: true, opacity: 0.5, side: T.DoubleSide }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  let model = null;
  const view = { yaw: 0.6, pitch: 0.25, dist: 3 };
  let disposed = false;

  const apply = () => {
    const { yaw, pitch, dist } = view;
    camera.position.set(
      Math.sin(yaw) * Math.cos(pitch) * dist,
      Math.sin(pitch) * dist,
      Math.cos(yaw) * Math.cos(pitch) * dist,
    );
    camera.lookAt(0, 0, 0);
  };
  apply();

  const loaded = (async () => {
    if (!GLTFLoader) GLTFLoader = (await import("./vendor/three/GLTFLoader.js")).GLTFLoader;
    const entry = MODELS.find((m) => m.id === modelId) ?? MODELS[0];
    const gltf = await new GLTFLoader().loadAsync(entry.file);
    if (disposed) {
      disposeScene(gltf.scene);
      return;
    }
    model = gltf.scene;
    const box = new T.Box3().setFromObject(model);
    const sphere = box.getBoundingSphere(new T.Sphere());
    const scale = 1 / Math.max(sphere.radius, 1e-6);
    model.scale.setScalar(scale);
    model.position.copy(sphere.center).multiplyScalar(-scale);
    floor.position.y = (box.min.y - sphere.center.y) * scale;
    scene.add(model);
    onLoaded?.();
  })();

  const resize = (w, h) => {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  };
  const render = () => {
    apply();
    renderer.render(scene, camera);
  };
  const dispose = () => {
    disposed = true;
    disposeScene(scene);
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  };
  return { canvas, view, resize, render, dispose, loaded };
};

// ---------- Tab ----------

const mount = (pane) => {
  pane.classList.add("v3-pane");
  const stageBox = el("div", "v3-stage");
  const stageHolder = el("div", "v3-canvas-holder");
  stageBox.append(stageHolder, el("div", "v3-empty", "No agents are in the room yet."));
  const viewerBox = el("div", "v3-viewer");
  const viewerHolder = el("div", "v3-canvas-holder v3-model");
  const bar = el("div", "v3-bar");
  const picker = el("select", "v3-picker");
  picker.setAttribute("aria-label", "Model");
  for (const m of MODELS) picker.append(new Option(m.label, m.id));
  const reset = el("button", "v3-reset", "Reset view");
  reset.type = "button";
  const note = el("span", "v3-note", "Drag to rotate, pinch or scroll to zoom. Everyone sees the same view.");
  bar.append(picker, reset, note);
  const loadingNote = el("div", "v3-loading", "Loading model…");
  viewerHolder.append(loadingNote);
  viewerBox.append(viewerHolder, bar);
  pane.append(stageBox, viewerBox);

  let stage = null;
  let viewer = null;
  let visible = false;
  let building = null;
  let disposeTimer = 0;
  let raf = 0;
  let last = 0;
  let shared = { m: MODELS[0].id, y: 0.6, p: 0.25, d: 3 };
  let remoteTween = null;
  let dragging = false;
  let sent = 0;
  let sendTimer = 0;
  let lastSend = 0;
  let stageSize = [0, 0];
  let viewerSize = [0, 0];

  const agentList = () => [...app.state.agents.values()];
  const empty = () => (stageBox.querySelector(".v3-empty").hidden = agentList().length > 0);

  const speakingNow = () => window.roomJarvis?.speaking === true;
  const loop = (now) => {
    raf = 0;
    if (!visible) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    let more = false;
    if (stage) {
      more = stage.frame(now, dt);
      stage.render();
    }
    if (remoteTween && viewer) {
      const k = Math.min(1, (now - remoteTween.start) / 180);
      const { from, to } = remoteTween;
      viewer.view.yaw = from.yaw + (to.yaw - from.yaw) * k;
      viewer.view.pitch = from.pitch + (to.pitch - from.pitch) * k;
      viewer.view.dist = from.dist + (to.dist - from.dist) * k;
      viewer.render();
      if (k < 1) more = true;
      else remoteTween = null;
    }
    if (more) raf = requestAnimationFrame(loop);
  };
  const wake = () => {
    if (visible && !raf) {
      last = performance.now();
      raf = requestAnimationFrame(loop);
    }
  };
  // One-off draw for resize / state changes that need no animation.
  const redraw = () => {
    if (!visible) return;
    stage?.frame(performance.now(), 0);
    stage?.render();
    viewer?.render();
    wake();
  };

  const syncAgents = () => {
    empty();
    if (!stage) return;
    stage.sync(agentList());
    redraw();
  };

  const pulse = (name) => {
    const a = stage?.avatars.get(name);
    if (!a) return;
    a.speakUntil = performance.now() + SPEAK_MS;
    wake();
    setTimeout(() => {
      if (speakingNow() && stage?.avatars.get(name)) pulse(name);
      else redraw();
    }, SPEAK_MS + 40);
  };

  const build = () => {
    if (building) return building;
    building = (async () => {
      await loadThree();
      if (!stage) {
        stage = buildStage(stageHolder, (name) => {
          const input = document.getElementById("message-input");
          input.value = `@${name} ${input.value}`;
          input.focus();
        });
        stage.resize(...stageSize);
        stage.sync(agentList());
      }
      if (!viewer) {
        const v = await buildViewer(viewerHolder, shared.m, () => {
          loadingNote.hidden = true;
          redraw();
        });
        viewer = v;
        wireViewer(v);
        Object.assign(v.view, { yaw: shared.y, pitch: shared.p, dist: shared.d });
        v.resize(...viewerSize);
        v.loaded.catch(() => (loadingNote.textContent = "Could not load this model."));
      }
      redraw();
    })().finally(() => (building = null));
    return building;
  };

  const teardown = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    stage?.dispose();
    viewer?.dispose();
    stage = viewer = null;
    loadingNote.hidden = false;
    loadingNote.textContent = "Loading model…";
  };

  const setVisible = (now) => {
    if (now === visible) return;
    visible = now;
    clearTimeout(disposeTimer);
    if (now) {
      void build().then(() => {
        if (viewer && !dragging) Object.assign(viewer.view, { yaw: shared.y, pitch: shared.p, dist: shared.d });
        redraw();
      });
    } else {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      disposeTimer = setTimeout(teardown, DISPOSE_AFTER_MS);
    }
  };
  const check = () => setVisible(!pane.hidden && !document.hidden && pane.getClientRects().length > 0);
  new IntersectionObserver(check).observe(pane);
  document.addEventListener("visibilitychange", check);

  new ResizeObserver(() => {
    const s = stageHolder.getBoundingClientRect();
    const v = viewerHolder.getBoundingClientRect();
    stageSize = [Math.round(s.width), Math.round(s.height)];
    viewerSize = [Math.round(v.width), Math.round(v.height)];
    stage?.resize(...stageSize);
    viewer?.resize(...viewerSize);
    redraw();
  }).observe(pane);

  // Shared view: last writer wins, a few updates per second.
  const flush = () => {
    sendTimer = 0;
    lastSend = performance.now();
    shared.t = Date.now();
    shared.c = app.state.connectionId;
    const snapshot = encode(shared);
    const send = ++sent % COMPACT_AFTER === 0
      ? window.roomSync.compact(DOC, snapshot)
      : window.roomSync.send(DOC, snapshot);
    Promise.resolve(send).catch(() => {});
  };
  const publish = () => {
    if (sendTimer) return;
    const wait = Math.max(0, SEND_EVERY_MS - (performance.now() - lastSend));
    sendTimer = setTimeout(flush, wait);
  };
  const adoptLocal = () => {
    if (!viewer) return;
    shared.y = viewer.view.yaw;
    shared.p = viewer.view.pitch;
    shared.d = viewer.view.dist;
    publish();
  };

  const applyRemote = (state) => {
    if (!state || typeof state !== "object") return;
    const num = (v, d) => (Number.isFinite(v) ? v : d);
    const next = {
      m: MODELS.some((m) => m.id === state.m) ? state.m : shared.m,
      y: num(state.y, shared.y),
      p: Math.max(-1.45, Math.min(1.45, num(state.p, shared.p))),
      d: Math.max(1.4, Math.min(8, num(state.d, shared.d))),
    };
    const modelChanged = next.m !== shared.m;
    shared = next;
    picker.value = shared.m;
    if (modelChanged) return swapModel();
    if (!viewer || dragging) return;
    remoteTween = {
      start: performance.now(),
      from: { ...viewer.view },
      to: { yaw: next.y, pitch: next.p, dist: next.d },
    };
    wake();
  };

  const swapModel = () => {
    if (!viewer) return;
    viewer.dispose();
    viewer = null;
    loadingNote.hidden = false;
    loadingNote.textContent = "Loading model…";
    if (visible) void build().then(wake);
  };

  const wireViewer = ({ canvas, view }) => {
    const pointers = new Map();
    let pinch = 0;
    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      dragging = true;
      remoteTween = null;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY };
      pointers.set(e.pointerId, cur);
      if (pointers.size === 1) {
        view.yaw -= (cur.x - prev.x) * 0.008;
        view.pitch = Math.max(-1.45, Math.min(1.45, view.pitch + (cur.y - prev.y) * 0.008));
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0 && d > 0) view.dist = Math.max(1.4, Math.min(8, view.dist * (pinch / d)));
        pinch = d;
      }
      viewer?.render();
      adoptLocal();
    });
    const up = (e) => {
      pointers.delete(e.pointerId);
      pinch = 0;
      if (pointers.size === 0) dragging = false;
    };
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        view.dist = Math.max(1.4, Math.min(8, view.dist * Math.exp(e.deltaY * 0.0012)));
        viewer?.render();
        adoptLocal();
      },
      { passive: false },
    );
  };

  picker.addEventListener("change", () => {
    shared.m = picker.value;
    swapModel();
    publish();
  });
  reset.addEventListener("click", () => {
    if (!viewer) return;
    Object.assign(viewer.view, { yaw: 0.6, pitch: 0.25, dist: 3 });
    viewer.render();
    adoptLocal();
  });

  // Live status and speech.
  window.addEventListener("room:event", ({ detail: { type, data } }) => {
    if (type === "agent") syncAgents();
    else if (type === "message" && data?.kind === "agent") pulse(data.author);
  });
  window.roomSync.subscribe(DOC, (update) => applyRemote(decode(update)));
  void window.roomSync
    .load(DOC)
    .then((updates) => {
      const latest = decode(updates.at(-1) ?? "");
      if (latest) applyRemote(latest);
      if (updates.length > COMPACT_AFTER && latest) void window.roomSync.compact(DOC, updates.at(-1));
    })
    .catch(() => {});
  empty();
  check();
};

window.roomWorkspace.addTab({ id: "3d", label: "3D", mount });
