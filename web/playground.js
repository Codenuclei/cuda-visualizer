/* playground.js — editor, launch, and the four internals visualizations. */

(function () {
  "use strict";

  const INK = "#18191b", SLATE = "#6a6a6c", ASH = "#acadae",
        CLOUD = "#f2f2f2", FERN = "#448f52", MINT = "#dbeddf",
        PERIWINKLE = "#99b7fa";

  const $ = id => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";
  function el(name, attrs, parent) {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  /* ================= presets ================= */

  const PRESETS = [
    {
      id: "vecadd", label: "vector add — the hello world",
      grid: [16, 1], block: [256, 1], n: 4096, shmem: 0,
      code: `// Vector add — one thread per element.
// c[i] = a[i] + b[i]. Watch the coalescing tab:
// lane k of every warp reads byte k*4 of a sector. Perfect.
__global__ void vecAdd(const float *a, const float *b, float *c, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        c[i] = a[i] + b[i];
    }
    if (i == 0) {
        printf("hello from thread 0: a[0]=%f b[0]=%f\\n", a[0], b[0]);
    }
}`
    },
    {
      id: "stride", label: "strided access — coalescing broken",
      grid: [16, 1], block: [256, 1], n: 4096, shmem: 0,
      code: `// Same vector add, but each thread reads with a stride of 32.
// Now the 32 lanes of a warp each touch a DIFFERENT 32-byte
// sector: one request = 32 transactions instead of 8.
// Compare the coalescing tab with the plain vecAdd preset.
__global__ void strided(const float *a, float *c, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    int j = (i * 32) % n;   // stride-32 shuffle
    if (i < n) {
        c[i] = a[j] * 2.0f;
    }
}`
    },
    {
      id: "transpose-bad", label: "transpose — bank conflicts",
      grid: [4, 4], block: [16, 16], n: 4096, shmem: 0,
      code: `// Tiled transpose WITHOUT padding.
// tile is 16x16: column reads hit the same bank 16 ways.
// Check the shared-banks tab, then try the padded preset.
__global__ void transpose(const float *in, float *out, int w) {
    __shared__ float tile[16][16];
    int x = blockIdx.x * 16 + threadIdx.x;
    int y = blockIdx.y * 16 + threadIdx.y;
    tile[threadIdx.y][threadIdx.x] = in[y * w + x];
    __syncthreads();
    x = blockIdx.y * 16 + threadIdx.x;
    y = blockIdx.x * 16 + threadIdx.y;
    out[y * w + x] = tile[threadIdx.x][threadIdx.y];
}`
    },
    {
      id: "transpose-good", label: "transpose — padded, conflict-free",
      grid: [4, 4], block: [16, 16], n: 4096, shmem: 0,
      code: `// Tiled transpose WITH the classic +1 padding column.
// The extra column skews each row by one bank, so the
// column read tile[x][y] lands on 16 different banks.
__global__ void transposePadded(const float *in, float *out, int w) {
    __shared__ float tile[16][17];   // <- the +1 does the magic
    int x = blockIdx.x * 16 + threadIdx.x;
    int y = blockIdx.y * 16 + threadIdx.y;
    tile[threadIdx.y][threadIdx.x] = in[y * w + x];
    __syncthreads();
    x = blockIdx.y * 16 + threadIdx.x;
    y = blockIdx.x * 16 + threadIdx.y;
    out[y * w + x] = tile[threadIdx.x][threadIdx.y];
}`
    },
    {
      id: "reduce", label: "reduction — tree in shared memory",
      grid: [16, 1], block: [256, 1], n: 4096, shmem: 0,
      code: `// Block-level sum reduction. Each block folds 256 values
// down to one. Watch the divergence tab: the tree's tail
// (s = 16, 8, 4, 2, 1) leaves most lanes idle.
__global__ void reduceSum(const float *in, float *out, int n) {
    __shared__ float sdata[256];
    int tid = threadIdx.x;
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    sdata[tid] = (i < n) ? in[i] : 0.0f;
    __syncthreads();
    for (int s = blockDim.x / 2; s > 0; s = s / 2) {
        if (tid < s) {
            sdata[tid] = sdata[tid] + sdata[tid + s];
        }
        __syncthreads();
    }
    if (tid == 0) {
        out[blockIdx.x] = sdata[0];
        printf("block %d sum = %f\\n", blockIdx.x, sdata[0]);
    }
}`
    },
    {
      id: "histogram", label: "histogram — atomics under contention",
      grid: [8, 1], block: [256, 1], n: 8192, shmem: 0,
      code: `// 256-bin histogram with a shared-memory staging pass.
// atomicAdd on hot bins serializes — the mini-stats count
// every atomic the kernel issued.
__global__ void histogram(const unsigned char *data, unsigned int *bins, int n) {
    __shared__ unsigned int local[256];
    if (threadIdx.x < 256) local[threadIdx.x] = 0;
    __syncthreads();
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    int stride = gridDim.x * blockDim.x;
    while (i < n) {
        atomicAdd(&local[data[i]], 1);
        i = i + stride;
    }
    __syncthreads();
    if (threadIdx.x < 256) {
        atomicAdd(&bins[threadIdx.x], local[threadIdx.x]);
    }
}`
    },
    {
      id: "diverge", label: "divergence — a warp at war with itself",
      grid: [4, 1], block: [128, 1], n: 512, shmem: 0,
      code: `// Odd lanes do 60x more work than even lanes.
// On real hardware the even lanes just WAIT — a warp runs
// both sides of a branch. See the divergence tab stripes.
__global__ void divergent(const float *in, float *out, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;
    float v = in[i];
    if (threadIdx.x % 2 == 1) {
        for (int k = 0; k < 60; k = k + 1) {
            v = v * 1.01f + 0.001f;   // "expensive" path
        }
    } else {
        v = v + 1.0f;                 // cheap path
    }
    out[i] = v;
}`
    },
    {
      id: "deadlock", label: "bug — __syncthreads in a branch",
      grid: [2, 1], block: [64, 1], n: 128, shmem: 0,
      code: `// CLASSIC BUG: __syncthreads() inside a divergent branch.
// Threads with i >= 32 return early; the rest wait forever
// at the barrier. cuvis detects it — real GPUs hang.
__global__ void buggy(const float *in, float *out, int n) {
    __shared__ float s[64];
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (threadIdx.x >= 32) {
        return;               // half the block leaves...
    }
    s[threadIdx.x] = in[i];
    __syncthreads();          // ...and these threads wait forever
    out[i] = s[threadIdx.x % 32];
}`
    },
  ];

  /* ================= editor ================= */

  const codeEl = $("code"), hlEl = $("highlight"), gutterEl = $("gutter");

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  const TOKEN_RE = new RegExp([
    "(\\/\\/[^\\n]*)",                                       // 1 comment
    "(\"(?:[^\"\\\\\\n]|\\\\.)*\")",                          // 2 string
    "\\b(__global__|__shared__|__device__|__syncthreads|__syncwarp|threadIdx|blockIdx|blockDim|gridDim|atomicAdd|atomicMax|atomicMin|atomicSub|atomicExch|printf|extern)\\b", // 3 cuda
    "\\b(float|double|int|unsigned|char|void|bool|const|long|size_t)\\b", // 4 type
    "\\b(if|else|for|while|do|return|break|continue)\\b",     // 5 keyword
    "\\b(0x[0-9a-fA-F]+|\\d+\\.?\\d*(?:[eE][+-]?\\d+)?f?)\\b", // 6 number
  ].join("|"), "g");

  function highlight() {
    const src = codeEl.value;
    let out = "", last = 0;
    src.replace(TOKEN_RE, (m, com, str, cuda, type, kw, num, off) => {
      out += escapeHtml(src.slice(last, off));
      const cls = com ? "tok-com" : str ? "tok-str" : cuda ? "tok-cuda" :
                  type ? "tok-type" : kw ? "tok-kw" : "tok-num";
      out += '<span class="' + cls + '">' + escapeHtml(m) + "</span>";
      last = off + m.length;
      return m;
    });
    out += escapeHtml(src.slice(last));
    hlEl.innerHTML = out + "\n";
    const lines = src.split("\n").length;
    gutterEl.textContent =
      Array.from({ length: lines }, (_, i) => i + 1).join("\n");
  }

  codeEl.addEventListener("input", highlight);
  codeEl.addEventListener("scroll", () => {
    hlEl.scrollTop = codeEl.scrollTop;
    hlEl.scrollLeft = codeEl.scrollLeft;
    gutterEl.scrollTop = codeEl.scrollTop;
  });
  codeEl.addEventListener("keydown", e => {
    if (e.key === "Tab") {
      e.preventDefault();
      const s = codeEl.selectionStart;
      codeEl.setRangeText("    ", s, codeEl.selectionEnd, "end");
      highlight();
    }
  });

  /* preset picker */
  const presetSel = $("preset-select");
  PRESETS.forEach((p, i) => {
    const o = document.createElement("option");
    o.value = i; o.textContent = p.label;
    presetSel.appendChild(o);
  });
  function loadPreset(i) {
    const p = PRESETS[i];
    codeEl.value = p.code;
    $("in-gx").value = p.grid[0]; $("in-gy").value = p.grid[1];
    $("in-bx").value = p.block[0]; $("in-by").value = p.block[1];
    $("in-n").value = p.n; $("in-shmem").value = p.shmem;
    highlight();
  }
  presetSel.addEventListener("change", () => loadPreset(+presetSel.value));
  loadPreset(0);

  /* ================= tooltip ================= */

  const tooltip = $("tooltip");
  function showTip(evt, html) {
    tooltip.innerHTML = html;
    tooltip.style.opacity = 1;
    let x = evt.clientX + 14, y = evt.clientY + 14;
    const r = tooltip.getBoundingClientRect();
    if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - 14;
    if (y + r.height > innerHeight - 8) y = evt.clientY - r.height - 14;
    tooltip.style.left = x + "px"; tooltip.style.top = y + "px";
  }
  function hideTip() { tooltip.style.opacity = 0; }

  /* ================= worker management ================= */

  let worker = null, runToken = 0;
  function spawnWorker() {
    if (worker) worker.terminate();
    worker = new Worker("sim-worker.js");
    worker.onerror = e => {
      runBtn.classList.remove("running");
      runBtn.disabled = false;
      setError("Worker error: " + (e.message || "unknown"));
    };
  }
  spawnWorker();

  /* ================= buffers ================= */

  function makeBuffers(params, n) {
    const buffers = {}, inits = {};
    for (const p of params) {
      if (!p.isPtr) continue;
      const T = window.CudaSim.TYPE_MAP[p.type] || Float32Array;
      const arr = new T(Math.max(1, n));
      if (p.isConst) {
        if (T === Uint8Array) {
          // deterministic pseudo-random bytes, mildly skewed
          let s = 1234567;
          for (let i = 0; i < arr.length; i++) {
            s = (s * 1103515245 + 12345) & 0x7fffffff;
            arr[i] = (s >> 8) % 200;
          }
          inits[p.name] = "random bytes";
        } else {
          for (let i = 0; i < arr.length; i++)
            arr[i] = Math.sin(i * 0.13) * 8 + Math.sin(i * 0.017) * 4;
          inits[p.name] = "sine ramp";
        }
      } else {
        inits[p.name] = "zeros";
      }
      buffers[p.name] = arr;
    }
    return { buffers, inits };
  }

  function makeScalars(params, n) {
    const scalars = {};
    for (const p of params) {
      if (p.isPtr) continue;
      const nm = p.name.toLowerCase();
      scalars[p.name] =
        nm === "n" ? n :
        nm === "w" || nm === "width" || nm === "h" || nm === "height"
          ? Math.max(1, Math.round(Math.sqrt(n)))
          : nm === "alpha" || nm === "beta" ? 2.0 : n;
    }
    return scalars;
  }

  /* ================= run ================= */

  const runBtn = $("run-btn");
  let lastResult = null, beforeSnapshots = {};

  runBtn.addEventListener("click", runKernel);

  function setError(msg) {
    const strip = $("error-strip");
    if (msg) { strip.textContent = msg; strip.classList.add("show"); }
    else strip.classList.remove("show");
  }

  function runKernel() {
    setError(null);
    $("deadlock-strip").classList.remove("show");

    let parsed;
    try {
      parsed = window.CudaSim.parseKernel(codeEl.value);
    } catch (e) { setError(e.message); return; }

    const n = Math.max(1, +$("in-n").value | 0);
    const grid = [Math.max(1, +$("in-gx").value | 0), Math.max(1, +$("in-gy").value | 0)];
    const block = [Math.max(1, +$("in-bx").value | 0), Math.max(1, +$("in-by").value | 0)];
    const { buffers, inits } = makeBuffers(parsed.params, n);
    const scalars = makeScalars(parsed.params, n);

    // snapshot "before" images of the buffers for the data strips
    beforeSnapshots = {};
    for (const k in buffers) beforeSnapshots[k] = buffers[k].slice(0);

    const token = ++runToken;
    runBtn.classList.add("running");
    runBtn.disabled = true;

    const timeout = setTimeout(() => {
      if (token !== runToken) return;
      spawnWorker();
      runBtn.classList.remove("running");
      runBtn.disabled = false;
      setError("Timed out after 8 s — probably an infinite loop. Worker restarted.");
    }, 8000);

    worker.onmessage = e => {
      if (token !== runToken) return;
      clearTimeout(timeout);
      runBtn.classList.remove("running");
      runBtn.disabled = false;
      if (!e.data.ok) { setError(e.data.error); return; }
      lastResult = e.data;
      lastResult.inits = inits;
      renderResults();
    };

    worker.postMessage({
      source: codeEl.value, grid, block,
      buffers, scalars,
      dynShmemBytes: Math.max(0, +$("in-shmem").value | 0),
      focusBlock: 0,
    });
  }

  /* ================= results rendering ================= */

  function fmt(v) {
    if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return String(v);
  }

  function renderResults() {
    const r = lastResult;
    if (r.deadlock) $("deadlock-strip").classList.add("show");

    // mini stats
    const effPct = Math.round(r.coalescing.efficiency * 100);
    const stats = [
      [r.launch.total, "threads launched", false],
      [fmt(r.counts.gld + r.counts.gst), "global accesses", false],
      [fmt(r.counts.shld + r.counts.shst), "shared accesses", false],
      [fmt(r.counts.atomics), "atomics", false],
      [effPct + "%", "coalescing efficiency", effPct >= 95],
      [r.banks.worst + "-way", "worst bank conflict", r.banks.worst === 1],
      [r.divergence.divergent + "/" + r.divergence.warps, "divergent warps (blk 0)", r.divergence.divergent === 0],
      [fmt(r.counts.syncs), "barrier waits", false],
    ];
    $("mini-stats").innerHTML = stats.map(s =>
      '<div class="mini-stat"><div class="v' + (s[2] ? " good" : "") + '">' +
      s[0] + '</div><div class="l">' + s[1] + "</div></div>").join("");

    renderDataStrips();
    renderConsole();
    initSchedule();
    renderCoalesce();
    renderBanks();
    renderDivergence();
  }

  /* ---- data strips ---- */

  function renderDataStrips() {
    const host = $("data-strips");
    host.innerHTML = "";
    const r = lastResult;
    for (const name in r.buffers) {
      const after = r.buffers[name];
      const before = beforeSnapshots[name];
      const changed = !before || before.some((v, i) => v !== after[i]);

      const label = document.createElement("div");
      label.className = "strip-label";
      label.innerHTML = '<span class="bname">' + name + "</span><span>" +
        (r.inits[name] || "") + " → " + (changed ? "written by kernel" : "unchanged") +
        " · " + after.length + " elems</span>";
      host.appendChild(label);

      host.appendChild(makeStrip(before, name + " (before)"));
      host.appendChild(makeStrip(after, name + " (after)"));
    }
  }

  function makeStrip(arr, label) {
    const canvas = document.createElement("canvas");
    canvas.className = "data-strip";
    const w = Math.min(arr.length, 2048);
    canvas.width = w; canvas.height = 1;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(w, 1);
    let maxAbs = 1e-9;
    for (let i = 0; i < arr.length; i++)
      maxAbs = Math.max(maxAbs, Math.abs(arr[i]));
    const step = arr.length / w;
    for (let x = 0; x < w; x++) {
      const v = arr[Math.floor(x * step)];
      const m = Math.min(1, Math.abs(v) / maxAbs);
      let rr, gg, bb;
      if (v >= 0) {  // ink scale on paper
        rr = 255 - m * (255 - 24); gg = 255 - m * (255 - 25); bb = 255 - m * (255 - 27);
      } else {       // fern scale for negatives
        rr = 255 - m * (255 - 68); gg = 255 - m * (255 - 143); bb = 255 - m * (255 - 82);
      }
      img.data[x * 4] = rr; img.data[x * 4 + 1] = gg;
      img.data[x * 4 + 2] = bb; img.data[x * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    canvas.addEventListener("mousemove", e => {
      const rect = canvas.getBoundingClientRect();
      const idx = Math.floor((e.clientX - rect.left) / rect.width * arr.length);
      const v = arr[Math.max(0, Math.min(arr.length - 1, idx))];
      showTip(e, "<strong>" + label + "</strong><br><span class='t'>[" + idx +
                 "] = " + (typeof v === "number" ? +v.toFixed(4) : v) + "</span>");
    });
    canvas.addEventListener("mouseleave", hideTip);
    return canvas;
  }

  /* ---- console ---- */

  function renderConsole() {
    const out = $("console-out");
    const lines = lastResult.printfLines;
    if (!lines.length) {
      out.innerHTML = '<span class="empty">kernel produced no printf output</span>';
      return;
    }
    out.innerHTML = lines.map(l =>
      '<div><span class="tid">[b' + l.block + " t" + l.thread + "]</span> " +
      escapeHtml(l.text) + "</div>").join("");
  }

  /* ================= tabs ================= */

  document.querySelectorAll(".viz-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".viz-tab").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".viz-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      $("panel-" + btn.dataset.tab).classList.add("active");
    });
  });

  /* ---- SM scheduler animation ---- */

  const NUM_SM = 8;
  let schedTimer = null, schedState = null;

  function initSchedule() {
    const r = lastResult;
    const tpb = r.launch.threadsPerBlock;
    const slotsPerSM = Math.max(1, Math.min(8, Math.floor(1536 / tpb)));
    schedState = {
      total: r.launch.numBlocks,
      slotsPerSM,
      launched: 0, finished: 0, tick: 0,
      sms: Array.from({ length: NUM_SM }, () =>
        Array.from({ length: slotsPerSM }, () => null)),
    };
    $("sched-sub").textContent =
      r.launch.numBlocks + " blocks of " + tpb + " threads · " +
      NUM_SM + " SMs × " + slotsPerSM + " resident blocks (cartoon GPU)";
    if (schedTimer) { clearInterval(schedTimer); schedTimer = null; }
    $("sched-play").innerHTML = "Play &#9654;";
    buildSchedGrid();
    stepScheduleRender();
  }

  function buildSchedGrid() {
    const host = $("sm-sched-grid");
    host.innerHTML = "";
    for (let s = 0; s < NUM_SM; s++) {
      const box = document.createElement("div");
      box.className = "sm-box";
      box.innerHTML = '<div class="t">SM ' + s + "</div>";
      const slots = document.createElement("div");
      slots.className = "sm-slots";
      for (let k = 0; k < schedState.slotsPerSM; k++) {
        const cell = document.createElement("div");
        cell.className = "slot";
        cell.id = "slot-" + s + "-" + k;
        slots.appendChild(cell);
      }
      box.appendChild(slots);
      host.appendChild(box);
    }
  }

  function stepSchedule() {
    const st = schedState;
    st.tick++;
    // retire finished blocks (block lifetime 6..12 ticks, deterministic)
    for (let s = 0; s < NUM_SM; s++)
      for (let k = 0; k < st.slotsPerSM; k++) {
        const b = st.sms[s][k];
        if (b && st.tick >= b.ends) { st.sms[s][k] = null; st.finished++; }
      }
    // schedule new blocks into free slots
    for (let s = 0; s < NUM_SM && st.launched < st.total; s++)
      for (let k = 0; k < st.slotsPerSM && st.launched < st.total; k++)
        if (!st.sms[s][k]) {
          const id = st.launched++;
          const life = 6 + ((id * 2654435761) >>> 28); // 6..21 ticks
          st.sms[s][k] = { id, born: st.tick, ends: st.tick + life };
        }
    stepScheduleRender();
    if (st.finished >= st.total) {
      clearInterval(schedTimer); schedTimer = null;
      $("sched-play").innerHTML = "Replay &#8635;";
    }
  }

  function stepScheduleRender() {
    const st = schedState;
    for (let s = 0; s < NUM_SM; s++)
      for (let k = 0; k < st.slotsPerSM; k++) {
        const cell = $("slot-" + s + "-" + k);
        if (!cell) continue;
        const b = st.sms[s][k];
        cell.className = "slot" + (b ? (st.tick - b.born < 2 ? " fresh" : " busy") : "");
        cell.title = b ? "block " + b.id : "free";
      }
    $("sched-status").textContent =
      "tick " + st.tick + " · " + st.finished + "/" + st.total + " blocks retired";
  }

  $("sched-play").addEventListener("click", () => {
    if (!schedState) return;
    if (schedTimer) {
      clearInterval(schedTimer); schedTimer = null;
      $("sched-play").innerHTML = "Play &#9654;";
      return;
    }
    if (schedState.finished >= schedState.total) initSchedule();
    const speed = +$("sched-speed").value;
    schedTimer = setInterval(stepSchedule, 620 - speed * 55);
    $("sched-play").innerHTML = "Pause &#10074;&#10074;";
  });
  $("sched-speed").addEventListener("input", () => {
    if (schedTimer) {
      clearInterval(schedTimer);
      schedTimer = setInterval(stepSchedule, 620 - (+$("sched-speed").value) * 55);
    }
  });

  /* ---- coalescing inspector ---- */

  let activeReq = 0;

  function renderCoalesce() {
    const c = lastResult.coalescing;
    $("coalesce-sub").textContent =
      c.transactions + " DRAM transactions for " + c.ideal +
      " ideal — " + Math.round(c.efficiency * 100) + "% efficiency · " +
      fmt(c.bytes) + "B moved (block 0 shown)";
    const host = $("warp-req-list");
    host.innerHTML = "";
    activeReq = Math.min(activeReq, Math.max(0, c.requests.length - 1));
    c.requests.forEach((rq, i) => {
      const b = document.createElement("button");
      b.className = "warp-req" + (i === activeReq ? " active" : "");
      const bad = rq.sectors > rq.ideal;
      b.innerHTML = "w" + rq.warp + " " + (rq.rw === "r" ? "LD" : "ST") + " " +
        rq.buf + " · <span" + (bad ? ' class="bad"' : "") + ">" +
        rq.sectors + "</span>/" + rq.ideal + " sect";
      b.addEventListener("click", () => { activeReq = i; renderCoalesce(); });
      host.appendChild(b);
    });
    drawLaneMap(c.requests[activeReq]);
  }

  function drawLaneMap(rq) {
    const svg = $("lane-svg");
    svg.innerHTML = "";
    if (!rq) return;
    const W = 940, H = 240, laneY = 40, secY = 190;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("width", "100%");
    svg.style.minWidth = "700px";

    // sectors present in this request
    const sectors = [...new Set(rq.lanes.map(l => Math.floor(l.byte / 32)))]
      .sort((a, b) => a - b);
    const secX = new Map();
    const secW = Math.min(90, (W - 80) / sectors.length);
    sectors.forEach((s, i) => secX.set(s, 50 + i * secW + secW / 2));

    const laneX = l => 50 + l * ((W - 90) / 31);

    // header
    el("text", { x: 50, y: 16, "font-size": 11, fill: SLATE }, svg)
      .textContent = "warp " + rq.warp + " · " +
        (rq.rw === "r" ? "load from" : "store to") + " " + rq.buf +
        " · access #" + rq.seq;

    // lanes
    for (let l = 0; l < 32; l++) {
      const active = rq.lanes.find(a => a.lane === l);
      el("circle", { cx: laneX(l), cy: laneY, r: 7,
                     fill: active ? INK : CLOUD }, svg);
      if (l % 4 === 0)
        el("text", { x: laneX(l), y: laneY - 14, "font-size": 9,
                     fill: ASH, "text-anchor": "middle" }, svg)
          .textContent = l;
    }
    el("text", { x: 26, y: laneY + 4, "font-size": 10, fill: SLATE,
                 "text-anchor": "middle" }, svg).textContent = "lane";

    // connection lines
    for (const a of rq.lanes) {
      const sx = secX.get(Math.floor(a.byte / 32));
      const scattered = rq.sectors > rq.ideal;
      el("line", { x1: laneX(a.lane), y1: laneY + 8, x2: sx, y2: secY - 14,
                   stroke: scattered ? ASH : FERN,
                   "stroke-width": 1.1, opacity: 0.75 }, svg);
    }

    // sectors
    sectors.forEach(s => {
      const x = secX.get(s);
      const r = el("rect", { x: x - secW / 2 + 3, y: secY - 12,
                             width: secW - 6, height: 26, rx: 7,
                             fill: MINT, stroke: FERN, "stroke-width": 1 }, svg);
      el("text", { x: x, y: secY + 5, "font-size": 9, fill: INK,
                   "text-anchor": "middle" }, svg)
        .textContent = "0x" + (s * 32).toString(16);
      r.addEventListener?.("mouseleave", hideTip);
    });
    el("text", { x: 50, y: secY + 34, "font-size": 10, fill: SLATE }, svg)
      .textContent = sectors.length + " × 32-byte sectors touched " +
        "(ideal " + rq.ideal + ")";
  }

  /* ---- shared banks ---- */

  function renderBanks() {
    const reqs = lastResult.sharedRequests || [];
    const b = lastResult.banks;
    if (!reqs.length) {
      $("banks-sub").textContent = "this kernel made no shared-memory accesses";
      $("banks-summary").innerHTML = "";
      $("bank-grid").innerHTML = "";
      return;
    }
    $("banks-sub").textContent =
      b.total + " warp requests to shared memory · " + b.conflicted +
      " with conflicts · worst " + b.worst + "-way (block 0)";
    const worst = reqs[0];
    $("banks-summary").innerHTML =
      '<div class="strip-label"><span>worst request: warp ' + worst.warp +
      " · " + (worst.rw === "r" ? "load" : "store") + " of <span class='bname'>" +
      worst.buf + "</span></span><span>" + worst.degree +
      "-way serialization</span></div>";
    const grid = $("bank-grid");
    grid.innerHTML = "";
    const maxDeg = Math.max(1, worst.degree);
    for (let bank = 0; bank < 32; bank++) {
      const cell = document.createElement("div");
      const hits = worst.perBank[bank] || 0;
      cell.className = "bank-cell" + (hits > 1 ? " hitN" : hits === 1 ? " hit1" : "");
      if (hits > 1) cell.style.opacity = 0.45 + 0.55 * (hits / maxDeg);
      cell.title = "bank " + bank + ": " + hits + " distinct words";
      grid.appendChild(cell);
    }
  }

  /* ---- divergence ---- */

  function renderDivergence() {
    const d = lastResult.divergence, heat = lastResult.heat;
    $("diverge-sub").textContent =
      d.divergent + " of " + d.warps + " warps diverged in block 0";
    const host = $("diverge-rows");
    host.innerHTML = "";
    d.perWarp.forEach(w => {
      const row = document.createElement("div");
      row.className = "div-warp-row";
      const tag = document.createElement("span");
      tag.style.width = "70px";
      tag.innerHTML = "warp " + w.warp +
        (w.max !== w.min ? ' <span style="color:var(--color-fern)">◆</span>' : "");
      row.appendChild(tag);
      const lanes = document.createElement("div");
      lanes.className = "div-lanes";
      for (let l = 0; l < 32; l++) {
        const t = w.warp * 32 + l;
        const cell = document.createElement("div");
        cell.className = "div-lane";
        if (l < w.lanes && w.max > 0) {
          const v = (heat[t] || 0) / w.max;
          cell.style.background = v === 0 ? CLOUD :
            "rgba(24,25,27," + (0.15 + 0.85 * v).toFixed(2) + ")";
          cell.title = "lane " + l + ": " + (heat[t] || 0) + " ops";
        }
        lanes.appendChild(cell);
      }
      row.appendChild(lanes);
      host.appendChild(row);
    });
  }

  /* auto-run the first preset so the page never looks empty */
  runKernel();
})();
