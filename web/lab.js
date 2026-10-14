(function (root) {
  "use strict";

  const catalog = Object.freeze([
    { id: "blackwell-datacenter", vendor: "NVIDIA", family: "Blackwell", product: "B200", context: "Datacenter accelerator example" },
    { id: "blackwell-desktop", vendor: "NVIDIA", family: "Blackwell", product: "GeForce RTX 5090", context: "Desktop GPU example" },
    { id: "hopper", vendor: "NVIDIA", family: "Hopper", product: "H100", context: "Datacenter accelerator example" },
    { id: "ada", vendor: "NVIDIA", family: "Ada", product: "GeForce RTX 4090", context: "Desktop GPU example" },
    { id: "ampere-datacenter", vendor: "NVIDIA", family: "Ampere", product: "A100", context: "Datacenter accelerator example" },
    { id: "ampere-edge", vendor: "NVIDIA", family: "Ampere", product: "Jetson AGX Orin", context: "Edge system example" }
  ]);

  const SCENE_NOTE = "This is an instructional model, not measured hardware topology.";
  const colors = {
    platform: [0.055, 0.13, 0.16],
    trim: [0.08, 0.34, 0.37],
    sm: [0.055, 0.48, 0.53],
    warp: [0.91, 0.39, 0.12],
    thread: [0.17, 0.86, 0.83],
    io: [0.18, 0.45, 0.49],
    flow: [0.18, 0.76, 0.75]
  };

  function buildScene() {
    const blocks = [];
    const smCenters = [];
    const xs = [-2.7, -0.9, 0.9, 2.7];
    const zs = [-1.15, 1.15];
    let smNumber = 0;
    blocks.push(makeBlock("platform", "Platform", "deck", [0, -0.16, 0], [9, 0.32, 5.15], colors.platform, { glow: 0.02, pickable: false }));
    blocks.push(makeBlock("deck-trim", "Platform trim", "trim", [0, 0.025, 0], [8.64, 0.06, 4.84], colors.trim, { glow: 0.08, pickable: false }));
    blocks.push(makeBlock("io-ingress", "Ingress", "io", [-0.8, 0.18, 2.08], [1.12, 0.32, 0.22], colors.io, { glow: 0.08, pickable: false }));
    blocks.push(makeBlock("io-egress", "Egress", "io", [0.8, 0.18, 2.08], [1.12, 0.32, 0.22], colors.io, { glow: 0.08, pickable: false }));
    blocks.push(makeBlock("io-bridge", "Fabric bridge", "io", [0, 0.22, 2.08], [0.38, 0.42, 0.3], colors.warp, { glow: 0.2, pickable: false }));

    zs.forEach((z) => xs.forEach((x) => {
      smNumber += 1;
      const smId = `sm-${String(smNumber).padStart(2, "0")}`;
      const center = [x, 0.69, z];
      smCenters.push({ id: smId, position: center, x, z, index: smNumber });
      blocks.push(makeBlock(smId, `SM-${String(smNumber).padStart(2, "0")}`, "sm", center, [0.68, 1.26, 0.82], colors.sm, {
        glow: 0.06,
        pickable: true,
        detail: "A schematic compute cluster that groups execution resources. Real designs vary by product and generation."
      }));

      [-1, 1].forEach((dx, xi) => [-1, 1].forEach((dz, zi) => {
        const warpIndex = zi * 2 + xi + 1;
        const id = `warp-${String(smNumber).padStart(2, "0")}-${warpIndex}`;
        blocks.push(makeBlock(id, `Warp ${String(smNumber).padStart(2, "0")}.${warpIndex}`, "warp",
          [x + dx * 0.18, 1.43, z + dz * 0.2], [0.21, 0.18, 0.22], colors.warp, {
            glow: 0.22,
            pickable: true,
            parentId: smId,
            detail: "A visual work-group tile. Its shape and count are teaching cues, not a claim about this product's warp hardware."
          }));
      }));

      [-1, 1].forEach((dx) => [0.43, 0.9].forEach((y, row) => {
        blocks.push(makeBlock(`${smId}-thread-${dx}-${row}`, `Thread cue ${smNumber}`, "thread",
          [x + dx * 0.17, y, z + 0.426], [0.055, 0.055, 0.025], colors.thread, {
            glow: 0.52,
            phase: (smNumber * 0.41 + row * 0.7 + dx * 0.18),
            pickable: false,
            parentId: smId
          }));
      }));
    }));

    return { blocks, smCenters };
  }

  function makeBlock(id, label, kind, position, scale, color, options) {
    return Object.assign({
      id, label, kind, position, scale, color,
      glow: 0,
      phase: 0,
      pickable: false,
      parentId: null,
      detail: ""
    }, options || {});
  }

  function getArchitecture(id) {
    return catalog.find((entry) => entry.id === id) || catalog[0];
  }

  const BOX_FACES = Object.freeze([
    { indices: [0, 1, 5, 4], normal: [0, -1, 0] },
    { indices: [3, 7, 6, 2], normal: [0, 1, 0] },
    { indices: [4, 5, 6, 7], normal: [0, 0, 1] },
    { indices: [1, 0, 3, 2], normal: [0, 0, -1] },
    { indices: [5, 1, 2, 6], normal: [1, 0, 0] },
    { indices: [0, 4, 7, 3], normal: [-1, 0, 0] }
  ]);

  function buildCanvasFaces(block) {
    const [x, y, z] = block.position;
    const [sx, sy, sz] = block.scale;
    const vertices = [
      [x - sx, y - sy, z - sz], [x + sx, y - sy, z - sz],
      [x + sx, y + sy, z - sz], [x - sx, y + sy, z - sz],
      [x - sx, y - sy, z + sz], [x + sx, y - sy, z + sz],
      [x + sx, y + sy, z + sz], [x - sx, y + sy, z + sz]
    ];
    return BOX_FACES.map((face) => ({
      normal: face.normal,
      vertices: face.indices.map((index) => vertices[index])
    }));
  }

  function rayAabbDistance(origin, direction, center, halfSize) {
    let near = 0;
    let far = Infinity;
    for (let axis = 0; axis < 3; axis += 1) {
      const min = center[axis] - halfSize[axis];
      const max = center[axis] + halfSize[axis];
      if (Math.abs(direction[axis]) < 1e-8) {
        if (origin[axis] < min || origin[axis] > max) return null;
        continue;
      }
      let first = (min - origin[axis]) / direction[axis];
      let second = (max - origin[axis]) / direction[axis];
      if (first > second) [first, second] = [second, first];
      near = Math.max(near, first);
      far = Math.min(far, second);
      if (near > far) return null;
    }
    return far < 0 ? null : near;
  }

  function buildPaths(smCenters) {
    const segments = [];
    const add = (a, b, color) => segments.push({ a, b, color });
    const rows = [-1.15, 1.15];
    rows.forEach((z, row) => {
      const rowCenters = smCenters.filter((sm) => sm.z === z).sort((a, b) => a.x - b.x);
      for (let i = 0; i < rowCenters.length - 1; i += 1) {
        add([rowCenters[i].x, 1.76, z], [rowCenters[i + 1].x, 1.76, z], row ? [0.34, 0.58, 0.56] : [0.21, 0.72, 0.72]);
      }
    });
    [-2.7, 0.9].forEach((x, i) => add([x, 1.76, rows[0]], [x, 1.76, rows[1]], i ? [0.88, 0.48, 0.22] : [0.21, 0.72, 0.72]));
    add([0, 1.76, rows[0]], [0, 1.76, rows[1]], [0.88, 0.48, 0.22]);
    smCenters.forEach((sm) => add([sm.x, 1.48, sm.z], [sm.x, 1.76, sm.z], [0.2, 0.49, 0.5]));
    add([-0.8, 0.39, 2.08], [-2.7, 1.76, 1.15], [0.76, 0.43, 0.2]);
    add([0.8, 0.39, 2.08], [2.7, 1.76, 1.15], [0.18, 0.68, 0.68]);
    return segments;
  }

  const api = { catalog, SCENE_NOTE, buildScene, buildPaths, buildCanvasFaces, rayAabbDistance, getArchitecture };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (!root || !root.document) return;

  const doc = root.document;
  const canvas = doc.getElementById("lab-canvas");
  if (!canvas) return;

  const scene = buildScene();
  const paths = buildPaths(scene.smCenters);
  const ui = {
    frame: doc.getElementById("scene-frame"),
    noWebgl: doc.getElementById("no-webgl"),
    fallbackSummary: doc.getElementById("fallback-summary"),
    rendererStatus: doc.getElementById("renderer-status"),
    rendererLabel: doc.getElementById("renderer-label"),
    xrToolbar: doc.querySelector(".xr-toolbar"),
    xrStatus: doc.getElementById("xr-status"),
    enterVR: doc.getElementById("enter-vr"),
    xrButtonLabel: doc.getElementById("xr-button-label"),
    architecture: doc.getElementById("architecture"),
    targetContext: doc.getElementById("target-context"),
    selectionChip: doc.getElementById("selection-chip"),
    selectionChipLabel: doc.getElementById("selection-chip-label"),
    selectedKind: doc.getElementById("selected-kind"),
    selectedIndex: doc.getElementById("selected-index"),
    selectedHeading: doc.getElementById("selected-heading"),
    selectedDescription: doc.getElementById("selected-description"),
    componentButtons: doc.getElementById("component-buttons"),
    zoomReadout: doc.getElementById("zoom-readout"),
    pauseFlow: doc.getElementById("pause-flow"),
    pauseLabel: doc.getElementById("pause-label")
  };

  const renderer = createRenderer(canvas);
  const state = {
    yaw: 0.73,
    pitch: 0.48,
    distance: 13.6,
    selected: "sm-01",
    paused: false,
    reducedMotion: false,
    pauseTime: 0,
    pauseAt: 0,
    pointer: null,
    lastViewProjection: null,
    lastWidth: 0,
    lastHeight: 0
  };

  if (!renderer) {
      ui.noWebgl.hidden = false;
      ui.fallbackSummary.hidden = false;
      ui.rendererStatus.classList.add("is-fallback");
      ui.rendererLabel.textContent = "TEXT GUIDE AVAILABLE";
      canvas.setAttribute("aria-describedby", "scene-summary renderer-explanation");
      canvas.tabIndex = -1;
      disableSceneControls();
  } else if (renderer.type === "canvas2d") {
    ui.rendererStatus.classList.add("is-fallback");
    ui.rendererLabel.textContent = "CANVAS CPU FALLBACK · WEBGL OFF";
    ui.rendererStatus.title = "Software-projected Canvas 2D; no WebGL GPU shaders are active.";
    initCanvasFallback(renderer);
  } else {
    ui.rendererLabel.textContent = renderer.webgl2 ? "WEBGL2 · INSTANCED" : "WEBGL · COMPATIBILITY VIEW";
    initRenderer(renderer);
  }

  renderComponentButtons();
  setSelected(state.selected);
  updateArchitecture();
  bindControls();
  refreshXRSupport();

  function renderComponentButtons() {
    scene.blocks.filter((block) => block.pickable).forEach((block) => {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "unit-selector";
      button.dataset.target = block.id;
      button.dataset.kind = block.kind;
      button.setAttribute("aria-pressed", "false");
      button.textContent = block.label;
      button.addEventListener("click", () => setSelected(block.id));
      ui.componentButtons.appendChild(button);
    });
  }

  function setSelected(id) {
    const block = scene.blocks.find((candidate) => candidate.id === id && candidate.pickable);
    if (!block) return;
    state.selected = block.id;
    const isWarp = block.kind === "warp";
    ui.selectedKind.textContent = isWarp ? "WARP / VISUAL TILE" : "SM / CLUSTER";
    ui.selectedIndex.textContent = isWarp ? block.label.replace("Warp ", "") : block.label.replace("SM-", "");
    ui.selectedHeading.textContent = isWarp ? "Illustrative warp tile" : "Streaming multiprocessor";
    ui.selectedDescription.textContent = block.detail;
    ui.selectionChipLabel.textContent = isWarp ? block.label : block.label;
    ui.selectionChip.setAttribute("aria-hidden", "true");
    ui.componentButtons.querySelectorAll(".unit-selector").forEach((button) => {
      const active = button.dataset.target === block.id;
      button.setAttribute("aria-pressed", String(active));
    });
    canvas.setAttribute("aria-label", `${block.label} selected. ${block.detail} Drag to orbit, scroll to zoom, use arrow keys to look around, R to reset, and Space to pause flow animation.`);
    if (renderer) renderer.setSelection(block.id, block.parentId);
  }

  function updateArchitecture() {
    const entry = getArchitecture(ui.architecture.value);
    ui.targetContext.textContent = `${entry.context} · ${entry.family} family`;
  }

  function bindControls() {
    ui.architecture.addEventListener("change", updateArchitecture);
    doc.getElementById("reset-view").addEventListener("click", resetView);
    doc.getElementById("zoom-in").addEventListener("click", () => zoom(0.88));
    doc.getElementById("zoom-out").addEventListener("click", () => zoom(1.14));
    ui.pauseFlow.addEventListener("click", togglePause);
    ui.enterVR.addEventListener("click", () => {
      if (!renderer || !renderer.active || !renderer.xrSupported) return;
      if (renderer.xrSession) renderer.stopXR();
      else renderer.startXR();
    });

    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      state.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false };
      if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!state.pointer || state.pointer.id !== event.pointerId) return;
      const dx = event.clientX - state.pointer.x;
      const dy = event.clientY - state.pointer.y;
      if (Math.abs(event.clientX - state.pointer.startX) + Math.abs(event.clientY - state.pointer.startY) > 5) state.pointer.moved = true;
      if (state.pointer.moved) {
        state.yaw -= dx * 0.008;
        state.pitch = clamp(state.pitch + dy * 0.006, 0.12, 1.22);
      }
      state.pointer.x = event.clientX;
      state.pointer.y = event.clientY;
    });
    const finishPointer = (event) => {
      if (!state.pointer || state.pointer.id !== event.pointerId) return;
      const wasClick = !state.pointer.moved;
      state.pointer = null;
      if (wasClick && renderer && renderer.active) pick(event.clientX, event.clientY);
    };
    canvas.addEventListener("pointerup", finishPointer);
    canvas.addEventListener("pointercancel", () => { state.pointer = null; });
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      zoom(event.deltaY > 0 ? 1.08 : 0.92);
    }, { passive: false });
    canvas.addEventListener("keydown", (event) => {
      const key = event.key;
      if (key === "ArrowLeft") { state.yaw -= 0.12; event.preventDefault(); }
      else if (key === "ArrowRight") { state.yaw += 0.12; event.preventDefault(); }
      else if (key === "ArrowUp") { state.pitch = clamp(state.pitch + 0.08, 0.12, 1.22); event.preventDefault(); }
      else if (key === "ArrowDown") { state.pitch = clamp(state.pitch - 0.08, 0.12, 1.22); event.preventDefault(); }
      else if (key === "+" || key === "=") { zoom(0.88); event.preventDefault(); }
      else if (key === "-") { zoom(1.14); event.preventDefault(); }
      else if (key.toLowerCase() === "r") { resetView(); event.preventDefault(); }
      else if (key === " ") { togglePause(); event.preventDefault(); }
    });
    root.addEventListener("resize", resizeCanvas);
    if (root.ResizeObserver && ui.frame) new root.ResizeObserver(resizeCanvas).observe(ui.frame);
  }

  async function refreshXRSupport() {
    if (!renderer || renderer.type === "canvas2d" || !renderer.active) {
      setXRUI("Immersive VR requires working WebGL. The screen-based scene remains available.", "WebGL required", true);
      return;
    }
    if (root.isSecureContext === false) {
      setXRUI("WebXR requires a secure context (HTTPS or localhost).", "Secure context required", true);
      return;
    }
    const xr = root.navigator && root.navigator.xr;
    if (!xr || typeof xr.isSessionSupported !== "function") {
      setXRUI("This browser does not expose WebXR immersive-vr. Screen mode remains available.", "Immersive VR unsupported", true);
      return;
    }
    if (typeof root.XRWebGLLayer !== "function") {
      setXRUI("WebXR is present, but this browser has no XRWebGLLayer for the WebGL renderer.", "XR WebGL unavailable", true);
      return;
    }
    if (typeof renderer.gl.makeXRCompatible !== "function") {
      setXRUI("This WebGL context cannot be prepared for a WebXR framebuffer.", "XR WebGL unavailable", true);
      return;
    }
    setXRUI("Checking browser support for immersive-vr…", "Checking support…", true);
    try {
      const supported = await xr.isSessionSupported("immersive-vr");
      renderer.xrSupported = supported;
      setXRUI(
        supported ? "Immersive VR is available. Start only from this button; a compatible headset/session is still required." : "This browser reports immersive-vr unsupported. Screen mode remains available.",
        supported ? "Enter immersive VR" : "Immersive VR unsupported",
        !supported
      );
    } catch (error) {
      renderer.xrSupported = false;
      setXRUI(`Could not check immersive-vr support: ${error.message || "support query failed"}.`, "VR support unavailable", true);
    }
  }

  function setXRUI(status, label, disabled, active) {
    ui.xrStatus.textContent = status;
    ui.xrButtonLabel.textContent = label;
    ui.enterVR.disabled = Boolean(disabled);
    ui.enterVR.setAttribute("aria-pressed", String(Boolean(active)));
    ui.xrToolbar.classList.toggle("is-active", Boolean(active));
  }

  function resetView() {
    state.yaw = 0.73;
    state.pitch = 0.48;
    state.distance = 13.6;
    ui.zoomReadout.textContent = "100%";
  }

  function zoom(factor) {
    state.distance = clamp(state.distance * factor, 8, 24);
    ui.zoomReadout.textContent = `${Math.round(13.6 / state.distance * 100)}%`;
  }

  function togglePause() {
    if (!renderer || !renderer.active || state.reducedMotion) return;
    state.paused = !state.paused;
    if (state.paused) state.pauseAt = performanceNow();
    else state.pauseTime += performanceNow() - state.pauseAt;
    ui.pauseFlow.setAttribute("aria-pressed", String(state.paused));
    ui.pauseLabel.textContent = state.paused ? "Resume flow" : "Pause flow";
    ui.pauseFlow.querySelector(".pause-glyph").textContent = state.paused ? "▶" : "Ⅱ";
  }

  function pick(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) * canvas.width / rect.width;
    const y = (clientY - rect.top) * canvas.height / rect.height;
    let nearest = null;
    let distance = 46 * (canvas.width / rect.width);
    scene.blocks.filter((block) => block.pickable).forEach((block) => {
      const center = block.position;
      const projected = project([center[0], center[1], center[2]], state.lastViewProjection);
      if (!projected || projected[2] < -1 || projected[2] > 1) return;
      const dx = projected[0] - x;
      const dy = projected[1] - y;
      const candidateDistance = Math.hypot(dx, dy);
      if (candidateDistance < distance) {
        distance = candidateDistance;
        nearest = block;
      }
    });
    if (nearest) setSelected(nearest.id);
  }

  function createRenderer(target) {
    let gl = null;
    let webgl2 = false;
    try {
      gl = target.getContext("webgl2", { alpha: true, antialias: true, powerPreference: "high-performance" });
      webgl2 = Boolean(gl);
      if (!gl) gl = target.getContext("webgl", { alpha: true, antialias: true, powerPreference: "high-performance" }) || target.getContext("experimental-webgl");
    } catch (_) { gl = null; }
    if (!gl) {
      try {
        const context = target.getContext("2d", { alpha: true, desynchronized: true });
        if (context) return { type: "canvas2d", context, active: true, setSelection: (selected, parent) => { target.dataset.selected = selected; target.dataset.parent = parent || ""; } };
      } catch (_) { return null; }
      return null;
    }
    return { type: webgl2 ? "webgl2" : "webgl", gl, webgl2, active: false, setSelection: (selected, parent) => { target.dataset.selected = selected; target.dataset.parent = parent || ""; } };
  }

  function initCanvasFallback(view) {
    const ctx = view.context;
    const ratio = Math.min(2, root.devicePixelRatio || 1);
    const flowDots = makeFlowDots(paths);
    const reducedMotion = root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const started = performanceNow();
    state.reducedMotion = Boolean(reducedMotion);
    if (reducedMotion) {
      state.paused = true;
      ui.pauseFlow.disabled = true;
      ui.pauseFlow.setAttribute("aria-pressed", "true");
      ui.pauseLabel.textContent = "Motion reduced";
      ui.pauseFlow.title = "Flow animation is off because reduced motion is enabled";
    }

    function draw(now) {
      if (!canvas.isConnected) return;
      resizeCanvas();
      const width = canvas.width;
      const height = canvas.height;
      const elapsed = reducedMotion ? 0 : Math.max(0, (now - started - state.pauseTime - (state.paused ? now - state.pauseAt : 0)) / 1000);
      const eye = [
        Math.sin(state.yaw) * Math.cos(state.pitch) * state.distance,
        Math.sin(state.pitch) * state.distance + 0.25,
        Math.cos(state.yaw) * Math.cos(state.pitch) * state.distance
      ];
      const viewProjection = multiply(perspective(0.72, width / Math.max(1, height), 0.1, 80), lookAt(eye, [0, 0.3, 0], [0, 1, 0]));
      state.lastViewProjection = viewProjection;
      ctx.clearRect(0, 0, width, height);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      paths.forEach((path) => {
        const a = project(path.a, viewProjection);
        const b = project(path.b, viewProjection);
        if (!a || !b) return;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.strokeStyle = `rgba(${toRgb(path.color)},0.48)`;
        ctx.lineWidth = 1.15 * ratio;
        ctx.stroke();
      });

      const faces = [];
      scene.blocks.forEach((block) => {
        buildCanvasFaces(block).forEach((face) => {
          const points = face.vertices.map((point) => project(point, viewProjection));
          if (points.some((point) => !point)) return;
          const depth = points.reduce((sum, point) => sum + point[2], 0) / points.length;
          const diffuse = Math.max(0, dot(face.normal, [-0.38, 0.84, 0.54]));
          const light = 0.34 + diffuse * 0.66;
          const isSelected = block.id === state.selected || block.id === scene.blocks.find((item) => item.id === state.selected)?.parentId;
          const base = isSelected ? [0.95, 0.56, 0.24] : block.color;
          const pulse = 0.94 + 0.06 * Math.sin(elapsed * 2.4 + block.phase * 6.28318);
          faces.push({ block, face, points, depth, color: base.map((channel) => clamp(channel * light * (1 + block.glow * pulse * 0.24), 0, 1)), isSelected });
        });
      });
      faces.sort((a, b) => {
        const floor = item => item.block.kind === "deck" || item.block.kind === "trim";
        return Number(floor(b)) - Number(floor(a)) || b.depth - a.depth;
      });
      faces.forEach((item) => {
        ctx.beginPath();
        ctx.moveTo(item.points[0][0], item.points[0][1]);
        for (let i = 1; i < item.points.length; i += 1) ctx.lineTo(item.points[i][0], item.points[i][1]);
        ctx.closePath();
        ctx.fillStyle = `rgb(${item.color.map((channel) => Math.round(channel * 255)).join(",")})`;
        ctx.fill();
        ctx.strokeStyle = item.isSelected ? "rgba(255,190,112,0.84)" : `rgba(${toRgb(item.block.color)},0.38)`;
        ctx.lineWidth = (item.isSelected ? 1.2 : 0.65) * ratio;
        ctx.stroke();
      });

      flowDots.forEach((dotBlock) => {
        const point = project(interpolate(dotBlock.from, dotBlock.to, (dotBlock.phase + elapsed * 0.14) % 1), viewProjection);
        if (!point || point[2] < -1 || point[2] > 1) return;
        ctx.beginPath();
        ctx.arc(point[0], point[1], 2.1 * ratio, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${toRgb(dotBlock.color)},0.86)`;
        ctx.fill();
      });
      root.requestAnimationFrame(draw);
    }
    root.requestAnimationFrame(draw);
  }

  function toRgb(color) {
    return color.map((channel) => Math.round(channel * 255)).join(",");
  }

  function initRenderer(view) {
    const gl = view.gl;
    const webgl2 = view.webgl2;
    const program = createProgram(gl, webgl2, webgl2 ? vertex300 : vertex100, webgl2 ? fragment300 : fragment100);
    if (!program) {
      view.active = false;
      ui.noWebgl.hidden = false;
      ui.fallbackSummary.hidden = false;
      ui.rendererStatus.classList.add("is-fallback");
      ui.rendererLabel.textContent = "TEXT GUIDE AVAILABLE";
      canvas.tabIndex = -1;
      disableSceneControls();
      return;
    }
    view.active = true;
    gl.useProgram(program);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0.025, 0.055, 0.068, 1);

    const cube = createCubeBuffers(gl, program, webgl2);
    const line = createLineBuffers(gl, program, webgl2, paths);
    const uniforms = {
      viewProjection: gl.getUniformLocation(program, "uViewProjection"),
      time: gl.getUniformLocation(program, "uTime"),
      light: gl.getUniformLocation(program, "uLightDirection"),
      mode: gl.getUniformLocation(program, "uMode"),
      translate: gl.getUniformLocation(program, "uTranslate"),
      scale: gl.getUniformLocation(program, "uScale"),
      color: gl.getUniformLocation(program, "uColor"),
      selected: gl.getUniformLocation(program, "uSelected"),
      glow: gl.getUniformLocation(program, "uGlow"),
      phase: gl.getUniformLocation(program, "uPhase")
    };
    const selection = { id: state.selected, parent: null };
    view.setSelection(state.selected, null);
    view.setSelection = (id, parent) => { selection.id = id; selection.parent = parent; target.dataset.selected = id; target.dataset.parent = parent || ""; };
    const reducedMotion = root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches;
    state.reducedMotion = Boolean(reducedMotion);
    const started = performanceNow();
    if (reducedMotion) {
      state.paused = true;
      ui.pauseFlow.disabled = true;
      ui.pauseFlow.setAttribute("aria-pressed", "true");
      ui.pauseLabel.textContent = "Motion reduced";
      ui.pauseFlow.title = "Flow animation is off because reduced motion is enabled";
    }
    const flowDots = makeFlowDots(paths);
    const renderedBlocks = scene.blocks.concat(flowDots);
    const instanceBuffer = webgl2 ? gl.createBuffer() : null;
    let screenAnimationFrame = 0;
    let xrAnimationFrame = 0;
    let xrSession = null;
    let xrReferenceSpace = null;
    let xrLayer = null;
    let xrSceneOffsetY = -1.2;
    let xrStarting = false;
    view.xrSupported = false;

    function draw(now) {
      if (!target.isConnected || xrSession) return;
      resizeCanvas();
      const width = target.width;
      const height = target.height;
      gl.viewport(0, 0, width, height);
      const aspect = width / Math.max(1, height);
      const projection = perspective(0.72, aspect, 0.1, 80);
      const eye = [
        Math.sin(state.yaw) * Math.cos(state.pitch) * state.distance,
        Math.sin(state.pitch) * state.distance + 0.25,
        Math.cos(state.yaw) * Math.cos(state.pitch) * state.distance
      ];
      const viewMatrix = lookAt(eye, [0, 0.3, 0], [0, 1, 0]);
      const viewProjection = multiply(projection, viewMatrix);
      state.lastViewProjection = viewProjection;
      const elapsed = reducedMotion ? 0 : (now - started - state.pauseTime - (state.paused ? now - state.pauseAt : 0)) / 1000;
      renderScene(viewProjection, elapsed);
      screenAnimationFrame = root.requestAnimationFrame(draw);
    }

    function renderScene(viewProjection, elapsed) {
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.uniformMatrix4fv(uniforms.viewProjection, false, viewProjection);
      gl.uniform3f(uniforms.light, -0.38, 0.84, 0.54);
      gl.uniform1f(uniforms.time, elapsed);
      drawLine(gl, program, uniforms, line, cube);
      if (webgl2) drawInstanced(gl, program, uniforms, cube, renderedBlocks, selection, elapsed, instanceBuffer);
      else drawCompat(gl, program, uniforms, cube, renderedBlocks, selection, elapsed);
    }

    function startScreenLoop() {
      if (!xrSession) screenAnimationFrame = root.requestAnimationFrame(draw);
    }

    function scheduleXRFrame(session) {
      if (xrSession === session) xrAnimationFrame = session.requestAnimationFrame(renderXRFrame);
    }

    function renderXRFrame(time, frame) {
      const session = frame.session;
      if (!session || session !== xrSession || !xrReferenceSpace || !xrLayer) return;
      const pose = frame.getViewerPose(xrReferenceSpace);
      if (pose) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, xrLayer.framebuffer);
        gl.enable(gl.SCISSOR_TEST);
        const elapsed = reducedMotion ? 0 : (time - started - state.pauseTime - (state.paused ? time - state.pauseAt : 0)) / 1000;
        const placement = translationMatrix(0, xrSceneOffsetY, -7);
        for (const xrView of pose.views) {
          const viewport = xrLayer.getViewport(xrView);
          if (!viewport) continue;
          gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
          gl.scissor(viewport.x, viewport.y, viewport.width, viewport.height);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          const viewMatrix = xrView.transform.inverse.matrix;
          const viewProjection = multiply(multiply(xrView.projectionMatrix, viewMatrix), placement);
          renderScene(viewProjection, elapsed);
        }
        gl.disable(gl.SCISSOR_TEST);
      }
      scheduleXRFrame(session);
    }

    async function startXR() {
      if (xrStarting || xrSession || !view.xrSupported) return;
      xrStarting = true;
      setXRUI("Requesting an immersive VR session. Follow the browser's headset prompt.", "Requesting VR…", true);
      let session = null;
      try {
        session = await root.navigator.xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor"] });
        xrSession = session;
        view.xrSession = session;
        session.addEventListener("end", () => finishXR(session), { once: true });
        if (screenAnimationFrame) root.cancelAnimationFrame(screenAnimationFrame);
        if (typeof gl.makeXRCompatible !== "function") throw new Error("This WebGL context cannot be made XR-compatible");
        await gl.makeXRCompatible();
        if (xrSession !== session) throw new Error("The immersive VR session ended during setup");
        xrLayer = new root.XRWebGLLayer(session, gl, { alpha: false, depth: true, stencil: false, antialias: true });
        session.updateRenderState({ baseLayer: xrLayer });

        let referenceSpace;
        let referenceType;
        let lastReferenceError;
        for (const type of ["local", "local-floor", "viewer"]) {
          try {
            referenceSpace = await session.requestReferenceSpace(type);
            referenceType = type;
            break;
          } catch (error) { lastReferenceError = error; }
        }
        if (!referenceSpace) throw lastReferenceError || new Error("No usable XR reference space was provided");
        if (xrSession !== session) throw new Error("The immersive VR session ended during setup");
        xrReferenceSpace = referenceSpace;
        xrSceneOffsetY = referenceType === "local-floor" ? 0 : -1.2;
        session.addEventListener("select", onXRSelect);
        gl.bindFramebuffer(gl.FRAMEBUFFER, xrLayer.framebuffer);
        setXRUI(`Immersive VR active · ${referenceType} reference space · screen scene remains available after exit.`, "Leave immersive VR", false, true);
        scheduleXRFrame(session);
      } catch (error) {
        if (session) {
          try { await session.end(); } catch (_) { finishXR(session); }
        }
        setXRUI(`Could not start immersive VR: ${error.message || "session setup failed"}. Screen mode is still available.`, "Retry immersive VR", !view.xrSupported);
      } finally {
        xrStarting = false;
      }
    }

    function onXRSelect(event) {
      if (!xrReferenceSpace || !event.frame) return;
      const pose = event.frame.getPose(event.inputSource.targetRaySpace, xrReferenceSpace);
      if (!pose) return;
      const ray = rayFromPoseMatrix(pose.transform.matrix);
      let nearest = null;
      let nearestDistance = Infinity;
      scene.blocks.filter((block) => block.pickable).forEach((block) => {
        const center = [block.position[0], block.position[1] + xrSceneOffsetY, block.position[2] - 7];
        const distance = rayAabbDistance(ray.origin, ray.direction, center, block.scale);
        if (distance !== null && distance < nearestDistance) {
          nearest = block;
          nearestDistance = distance;
        }
      });
      if (nearest) setSelected(nearest.id);
    }

    function finishXR(session) {
      if (!xrSession || session !== xrSession) return;
      if (xrSession && xrAnimationFrame) {
        try { xrSession.cancelAnimationFrame(xrAnimationFrame); } catch (_) { /* Ended sessions may already discard pending frames. */ }
      }
      xrSession = null;
      view.xrSession = null;
      xrAnimationFrame = 0;
      xrReferenceSpace = null;
      xrLayer = null;
      try {
        gl.disable(gl.SCISSOR_TEST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      } catch (_) { /* A lost context still ends XR mode and reports the exit. */ }
      setXRUI("Immersive VR ended. The same scene is ready in screen mode.", "Enter immersive VR", !view.xrSupported);
      startScreenLoop();
    }

    async function stopXR() {
      const session = xrSession;
      if (!session) return;
      setXRUI("Ending immersive VR session…", "Leaving VR…", true, true);
      try { await session.end(); }
      catch (error) {
        setXRUI(`Could not end the session cleanly: ${error.message || "session exit failed"}.`, "Leave immersive VR", false, true);
      }
    }

    view.startXR = startXR;
    view.stopXR = stopXR;
    resizeCanvas();
    startScreenLoop();
  }

  function resizeCanvas() {
    if (!renderer || renderer.xrSession) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = Math.min(2, root.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  function disableSceneControls() {
    ["zoom-out", "zoom-in", "reset-view", "pause-flow"].forEach((id) => {
      const button = doc.getElementById(id);
      if (button) button.disabled = true;
    });
  }

  function makeFlowDots(segments) {
    const dots = [];
    segments.forEach((segment, segmentIndex) => {
      for (let i = 0; i < 3; i += 1) {
        dots.push(makeBlock(`flow-${segmentIndex}-${i}`, "Flow cue", "flow", [0, 0, 0], [0.04, 0.04, 0.04], segment.color, {
          glow: 0.65,
          phase: (i / 3 + segmentIndex * 0.173) % 1,
          from: segment.a,
          to: segment.b,
          pickable: false
        }));
      }
    });
    return dots;
  }

  function createCubeBuffers(gl, program, webgl2) {
    const positions = [];
    const normals = [];
    const indices = [];
    const faces = [
      { n: [0, 0, 1], v: [[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]] },
      { n: [0, 0, -1], v: [[1,-1,-1],[-1,-1,-1],[-1,1,-1],[1,1,-1]] },
      { n: [1, 0, 0], v: [[1,-1,1],[1,-1,-1],[1,1,-1],[1,1,1]] },
      { n: [-1, 0, 0], v: [[-1,-1,-1],[-1,-1,1],[-1,1,1],[-1,1,-1]] },
      { n: [0, 1, 0], v: [[-1,1,1],[1,1,1],[1,1,-1],[-1,1,-1]] },
      { n: [0, -1, 0], v: [[-1,-1,-1],[1,-1,-1],[1,-1,1],[-1,-1,1]] }
    ];
    faces.forEach((face) => {
      const base = positions.length / 3;
      face.v.forEach((vertex) => { positions.push(...vertex); normals.push(...face.n); });
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    const interleaved = new Float32Array(positions.length / 3 * 6);
    for (let i = 0; i < positions.length / 3; i += 1) {
      interleaved.set(positions.slice(i * 3, i * 3 + 3), i * 6);
      interleaved.set(normals.slice(i * 3, i * 3 + 3), i * 6 + 3);
    }
    gl.bufferData(gl.ARRAY_BUFFER, interleaved, gl.STATIC_DRAW);
    const indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
    const attributes = {
      position: gl.getAttribLocation(program, "aPosition"),
      normal: gl.getAttribLocation(program, "aNormal"),
      offset: gl.getAttribLocation(program, "aOffset"),
      scale: gl.getAttribLocation(program, "aScale"),
      color: gl.getAttribLocation(program, "aColor"),
      selected: gl.getAttribLocation(program, "aSelected"),
      glow: gl.getAttribLocation(program, "aGlow"),
      phase: gl.getAttribLocation(program, "aPhase")
    };
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(attributes.position);
    gl.vertexAttribPointer(attributes.position, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(attributes.normal);
    gl.vertexAttribPointer(attributes.normal, 3, gl.FLOAT, false, 24, 12);
    return { positionBuffer, indexBuffer, attributes, indexCount: indices.length, webgl2 };
  }

  function createLineBuffers(gl, program, webgl2, segments) {
    const vertices = [];
    const colorsData = [];
    const add = (point, color) => { vertices.push(...point); colorsData.push(...color); };
    segments.forEach((segment) => { add(segment.a, segment.color); add(segment.b, segment.color); });
    const corners = [[-4.32, 0.035, -2.42], [4.32, 0.035, -2.42], [4.32, 0.035, 2.42], [-4.32, 0.035, 2.42]];
    corners.forEach((point, i) => {
      add(point, [0.1, 0.43, 0.46]);
      add(corners[(i + 1) % corners.length], [0.1, 0.43, 0.46]);
    });
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    const colorBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colorsData), gl.STATIC_DRAW);
    return {
      positionBuffer,
      colorBuffer,
      count: vertices.length / 3,
      position: gl.getAttribLocation(program, "aPosition"),
      color: gl.getAttribLocation(program, "aColor")
    };
  }

  function drawLine(gl, program, uniforms, line, cube) {
    gl.uniform1f(uniforms.mode, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, line.positionBuffer);
    gl.enableVertexAttribArray(line.position);
    gl.vertexAttribPointer(line.position, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, line.colorBuffer);
    gl.enableVertexAttribArray(line.color);
    gl.vertexAttribPointer(line.color, 3, gl.FLOAT, false, 0, 0);
    const a = cube.attributes;
    [a.normal, a.offset, a.scale, a.selected, a.glow, a.phase].forEach((location) => gl.disableVertexAttribArray(location));
    gl.vertexAttrib3f(a.normal, 0, 0, 1);
    gl.vertexAttrib3f(a.offset, 0, 0, 0);
    gl.vertexAttrib3f(a.scale, 1, 1, 1);
    gl.vertexAttrib1f(a.selected, 0);
    gl.vertexAttrib1f(a.glow, 0);
    gl.vertexAttrib1f(a.phase, 0);
    gl.drawArrays(gl.LINES, 0, line.count);
  }

  function drawInstanced(gl, program, uniforms, cube, blocks, selection, time, instanceBuffer) {
    const floatsPerInstance = 12;
    const data = new Float32Array(blocks.length * floatsPerInstance);
    blocks.forEach((block, i) => {
      const p = block.from ? interpolate(block.from, block.to, (block.phase + time * 0.14) % 1) : block.position;
      const selected = block.id === selection.id || block.id === selection.parent ? 1 : 0;
      data.set([p[0], p[1], p[2], block.scale[0], block.scale[1], block.scale[2], block.color[0], block.color[1], block.color[2], selected, block.glow, block.phase], i * floatsPerInstance);
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, cube.positionBuffer);
    gl.enableVertexAttribArray(cube.attributes.position);
    gl.vertexAttribPointer(cube.attributes.position, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(cube.attributes.normal);
    gl.vertexAttribPointer(cube.attributes.normal, 3, gl.FLOAT, false, 24, 12);
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    const stride = floatsPerInstance * 4;
    const attributes = cube.attributes;
    [
      [attributes.offset, 3, 0], [attributes.scale, 3, 12], [attributes.color, 3, 24],
      [attributes.selected, 1, 36], [attributes.glow, 1, 40], [attributes.phase, 1, 44]
    ].forEach(([location, size, offset]) => {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(location, 1);
    });
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, cube.indexBuffer);
    gl.uniform1f(uniforms.mode, 1);
    gl.drawElementsInstanced(gl.TRIANGLES, cube.indexCount, gl.UNSIGNED_SHORT, 0, blocks.length);
    [attributes.offset, attributes.scale, attributes.color, attributes.selected, attributes.glow, attributes.phase].forEach((location) => gl.vertexAttribDivisor(location, 0));
  }

  function drawCompat(gl, program, uniforms, cube, blocks, selection, time) {
    gl.bindBuffer(gl.ARRAY_BUFFER, cube.positionBuffer);
    gl.enableVertexAttribArray(cube.attributes.position);
    gl.vertexAttribPointer(cube.attributes.position, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(cube.attributes.normal);
    gl.vertexAttribPointer(cube.attributes.normal, 3, gl.FLOAT, false, 24, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, cube.indexBuffer);
    gl.uniform1f(uniforms.mode, 0);
    blocks.forEach((block) => {
      const position = block.from ? interpolate(block.from, block.to, (block.phase + time * 0.14) % 1) : block.position;
      const selected = block.id === selection.id || block.id === selection.parent ? 1 : 0;
      gl.uniform3f(uniforms.translate, position[0], position[1], position[2]);
      gl.uniform3f(uniforms.scale, block.scale[0], block.scale[1], block.scale[2]);
      gl.uniform3f(uniforms.color, block.color[0], block.color[1], block.color[2]);
      gl.uniform1f(uniforms.selected, selected);
      gl.uniform1f(uniforms.glow, block.glow);
      gl.uniform1f(uniforms.phase, block.phase);
      gl.drawElements(gl.TRIANGLES, cube.indexCount, gl.UNSIGNED_SHORT, 0);
    });
  }

  function createProgram(gl, webgl2, vertexSource, fragmentSource) {
    const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
    if (!vertex || !fragment) return null;
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return null;
    }
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    return program;
  }

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  const vertex300 = `#version 300 es
in vec3 aPosition; in vec3 aNormal; in vec3 aOffset; in vec3 aScale; in vec3 aColor;
in float aSelected; in float aGlow; in float aPhase;
uniform mat4 uViewProjection; uniform float uMode; uniform vec3 uTranslate; uniform vec3 uScale;
uniform vec3 uColor; uniform float uSelected; uniform float uGlow; uniform float uPhase;
out vec3 vNormal; out vec3 vColor; out vec3 vWorld; out float vSelected; out float vGlow; out float vPhase;
void main() {
  vec3 scale = mix(uScale, aScale, step(0.5, uMode));
  vec3 offset = mix(uTranslate, aOffset, step(0.5, uMode));
  vec3 color = mix(uColor, aColor, step(0.5, uMode));
  vSelected = mix(uSelected, aSelected, step(0.5, uMode));
  vGlow = mix(uGlow, aGlow, step(0.5, uMode));
  vPhase = mix(uPhase, aPhase, step(0.5, uMode));
  vec3 world = aPosition * scale + offset;
  vWorld = world; vNormal = normalize(aNormal / max(scale, vec3(0.001))); vColor = color;
  gl_Position = uViewProjection * vec4(world, 1.0);
}`;
  const fragment300 = `#version 300 es
precision mediump float;
in vec3 vNormal; in vec3 vColor; in vec3 vWorld; in float vSelected; in float vGlow; in float vPhase;
uniform vec3 uLightDirection; uniform float uTime; uniform float uMode; uniform vec3 uColor;
out vec4 outColor;
void main() {
  vec3 base = mix(uColor, vColor, step(0.5, uMode));
  float light = 0.29 + 0.71 * max(dot(normalize(vNormal), normalize(uLightDirection)), 0.0);
  float pulse = 0.84 + 0.16 * sin(uTime * 2.4 + vPhase * 6.28318);
  vec3 selected = mix(base, vec3(1.0, 0.66, 0.27), vSelected * 0.62);
  vec3 color = selected * light + base * vGlow * pulse;
  float rim = pow(1.0 - abs(normalize(vNormal).z), 3.0) * 0.11;
  outColor = vec4(color + vec3(0.04, 0.22, 0.24) * rim, 1.0);
}`;
  const vertex100 = `precision mediump float;
attribute vec3 aPosition; attribute vec3 aNormal; attribute vec3 aOffset; attribute vec3 aScale; attribute vec3 aColor;
attribute float aSelected; attribute float aGlow; attribute float aPhase;
uniform mat4 uViewProjection; uniform float uMode; uniform vec3 uTranslate; uniform vec3 uScale;
uniform vec3 uColor; uniform float uSelected; uniform float uGlow; uniform float uPhase;
varying vec3 vNormal; varying vec3 vColor; varying vec3 vWorld; varying float vSelected; varying float vGlow; varying float vPhase;
void main() {
  vec3 scale = mix(uScale, aScale, step(0.5, uMode));
  vec3 offset = mix(uTranslate, aOffset, step(0.5, uMode));
  vec3 color = mix(uColor, aColor, step(0.5, uMode));
  vSelected = mix(uSelected, aSelected, step(0.5, uMode)); vGlow = mix(uGlow, aGlow, step(0.5, uMode)); vPhase = mix(uPhase, aPhase, step(0.5, uMode));
  vec3 world = aPosition * scale + offset;
  vWorld = world; vNormal = normalize(aNormal / max(scale, vec3(0.001))); vColor = color;
  gl_Position = uViewProjection * vec4(world, 1.0);
}`;
  const fragment100 = `precision mediump float;
varying vec3 vNormal; varying vec3 vColor; varying vec3 vWorld; varying float vSelected; varying float vGlow; varying float vPhase;
uniform vec3 uLightDirection; uniform float uTime; uniform float uMode; uniform vec3 uColor;
void main() {
  vec3 base = mix(uColor, vColor, step(0.5, uMode));
  float light = 0.29 + 0.71 * max(dot(normalize(vNormal), normalize(uLightDirection)), 0.0);
  float pulse = 0.84 + 0.16 * sin(uTime * 2.4 + vPhase * 6.28318);
  vec3 selected = mix(base, vec3(1.0, 0.66, 0.27), vSelected * 0.62);
  vec3 color = selected * light + base * vGlow * pulse;
  float rim = pow(1.0 - abs(normalize(vNormal).z), 3.0) * 0.11;
  gl_FragColor = vec4(color + vec3(0.04, 0.22, 0.24) * rim, 1.0);
}`;

  function perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2);
    const range = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (near + far) * range, -1, 0, 0, 2 * near * far * range, 0]);
  }

  function lookAt(eye, center, up) {
    const z = normalize(subtract(eye, center));
    const x = normalize(cross(up, z));
    const y = cross(z, x);
    return new Float32Array([
      x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
      -dot(x, eye), -dot(y, eye), -dot(z, eye), 1
    ]);
  }

  function translationMatrix(x, y, z) {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
  }

  function rayFromPoseMatrix(matrix) {
    return {
      origin: [matrix[12], matrix[13], matrix[14]],
      direction: normalize([-matrix[8], -matrix[9], -matrix[10]])
    };
  }

  function multiply(a, b) {
    const out = new Float32Array(16);
    for (let column = 0; column < 4; column += 1) for (let row = 0; row < 4; row += 1) {
      out[column * 4 + row] = a[row] * b[column * 4] + a[4 + row] * b[column * 4 + 1] + a[8 + row] * b[column * 4 + 2] + a[12 + row] * b[column * 4 + 3];
    }
    return out;
  }

  function project(point, matrix) {
    if (!matrix) return null;
    const x = point[0], y = point[1], z = point[2];
    const cx = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    const cy = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    const cz = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    const cw = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
    if (cw <= 0) return null;
    return [(cx / cw + 1) * canvas.width / 2, (1 - cy / cw) * canvas.height / 2, cz / cw];
  }

  function normalize(v) { const length = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / length, v[1] / length, v[2] / length]; }
  function subtract(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function interpolate(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function performanceNow() { return root.performance && root.performance.now ? root.performance.now() : Date.now(); }
})(typeof window !== "undefined" ? window : null);
