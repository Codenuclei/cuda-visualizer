/* cuvis dashboard — renders window.CUVIS_DATA (written by the C++ engine).
   All charts are hand-drawn SVG in the Anything palette: monochrome ink
   with a single fern accent, 20px card radii, whisper-soft everything. */

(function () {
  "use strict";

  const INK = "#1b2a20", SLATE = "#5c6b60", STEEL = "#7a8578",
        ASH = "#acadae", FOG = "#bbbbbb", CLOUD = "#f2f2f2",
        PEBBLE = "#d8dfd4", FERN = "#3e7c4f", MINT = "#ecf2e4",
        PERIWINKLE = "#6f8fd8";

  const data = window.CUVIS_DATA;
  if (!data || !data.gpus || !data.gpus.length) {
    document.getElementById("gpu-title").textContent =
      "No data — run build/cuvis.exe to generate web/data.js";
    return;
  }

  let gpuIndex = data.gpus.findIndex(g => g.spec.id === "SM86_RTX3070");
  if (gpuIndex < 0) gpuIndex = data.gpus.length - 1;
  let kernelIndex = 2; // sgemmTiled by default

  /* ---------------- helpers ---------------- */

  const $ = id => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";

  function el(name, attrs, parent) {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function fmt(v, digits) {
    if (v == null || !isFinite(v)) return "—";
    if (digits === undefined) digits = 1;
    if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(digits) + "B";
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(digits) + "M";
    if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(digits) + "K";
    return v.toFixed(digits);
  }

  function fmtUs(us) {
    if (us >= 1000) return (us / 1000).toFixed(2) + " ms";
    return us.toFixed(1) + " µs";
  }

  function pct(v) { return (v * 100).toFixed(0) + "%"; }

  const tooltip = $("tooltip");
  function showTip(evt, html) {
    tooltip.innerHTML = html;
    tooltip.style.opacity = 1;
    const pad = 14;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    const r = tooltip.getBoundingClientRect();
    if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - pad;
    if (y + r.height > innerHeight - 8) y = evt.clientY - r.height - pad;
    tooltip.style.left = x + "px";
    tooltip.style.top = y + "px";
  }
  function hideTip() { tooltip.style.opacity = 0; }

  /* ---------------- hero picker ---------------- */

  const sel = $("gpu-select");
  data.gpus.forEach((g, i) => {
    const o = document.createElement("option");
    o.value = i;
    // arch is derivable from CC and always shown in the overview, so the
    // compact picker label drops the parenthetical to fit small screens
    o.textContent = g.spec.name + ", " + g.spec.numSMs + " SMs, CC " + g.spec.cc;
    if (i === gpuIndex) o.selected = true;
    sel.appendChild(o);
  });
  sel.addEventListener("change", () => { gpuIndex = +sel.value; renderAll(); });
  $("gpu-go").addEventListener("click", () => {
    document.getElementById("overview").scrollIntoView({ behavior: "smooth" });
  });
  $("runtime-note").textContent = data.generator + ", " +
    data.gpus.length + " device models from accel-sim tested-cfgs";
  $("generator-note").textContent = data.generator;

  /* ---------------- overview ---------------- */

  function renderOverview() {
    const g = data.gpus[gpuIndex], s = g.spec;
    $("gpu-title").textContent = s.name;
    const sourceLabel = s.id && s.id.startsWith("DEVICE")
      ? "physical device profiled via CUDA " + (data.generator.match(/CUDA\s+([\d.]+)/)?.[1] || "runtime")
      : "modeled from gpgpusim.config";
    $("gpu-subtitle").textContent =
      "compute capability " + s.cc + ", " + s.id + ", " + sourceLabel;

    const cards = [
      [s.numSMs, "", "streaming multiprocessors"],
      [fmt(s.peakGflopsFp32 / 1000, 1), "TFLOP/s", "peak FP32 compute"],
      [fmt(s.memBandwidthGBs, 0), "GB/s", "peak DRAM bandwidth"],
      [s.maxWarpsPerSM, "warps", "max residency per SM"],
    ];
    $("stat-cards").innerHTML = cards.map(c =>
      '<div class="card stat"><div class="value">' + c[0] +
      (c[1] ? "<small>" + c[1] + "</small>" : "") +
      '</div><div class="label">' + c[2] + "</div></div>").join("");

    const silicon = [
      ["SM count", s.numSMs],
      ["Core clock", s.coreClockMHz.toFixed(0) + " MHz"],
      ["FP32 lanes / SM", s.fp32CoresPerSM],
      ["Warp size", s.warpSize],
      ["Max threads / SM", s.maxThreadsPerSM],
      ["Max blocks / SM", s.maxBlocksPerSM],
      ["Registers / SM", fmt(s.regsPerSM, 0)],
      ["Shared memory / SM", (s.shmemPerSM / 1024).toFixed(0) + " KB"],
      ["Warp schedulers / SM", s.schedulersPerSM],
      ["Tensor cores", s.tensorCores ? "yes" : "no"],
    ];
    const memory = [
      ["DRAM clock", s.dramClockMHz.toFixed(0) + " MHz"],
      ["Memory channels", s.memChannels],
      ["Peak bandwidth", s.memBandwidthGBs.toFixed(1) + " GB/s"],
      ["L1 data cache / SM", s.l1SizeKB.toFixed(0) + " KB"],
      ["L2 cache (total)", s.l2SizeMB.toFixed(1) + " MB"],
      ["L1 latency", s.l1Latency + " cycles"],
      ["Shared mem latency", s.smemLatency + " cycles"],
      ["DRAM latency", s.dramLatency + " cycles"],
    ];
    $("spec-silicon").innerHTML = silicon.map(r =>
      '<li><span class="k">' + r[0] + '</span><span class="v">' + r[1] + "</span></li>").join("");
    $("spec-memory").innerHTML = memory.map(r =>
      '<li><span class="k">' + r[0] + '</span><span class="v">' + r[1] + "</span></li>").join("");
  }

  /* ---------------- timeline ---------------- */

  function renderTimeline() {
    const g = data.gpus[gpuIndex];
    const svg = $("timeline-svg");
    svg.innerHTML = "";
    const W = Math.max(720, svg.parentNode.clientWidth || 720), H = 120;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("width", "100%");
    svg.style.minWidth = "680px";
    svg.setAttribute("height", H);

    const total = g.totalTimeUs;
    $("timeline-sub").textContent =
      "whole run " + fmtUs(total) + " — log-time axis so the small kernels stay visible";

    // Log-scale mapping keeps µs-scale kernels visible next to ms copies.
    const L = 60, R = 16, avail = W - L - R;
    const minT = 0.4;
    const xOf = t => L + (Math.log10(Math.max(t, minT)) - Math.log10(minT)) /
                     (Math.log10(total) - Math.log10(minT)) * avail;

    const laneY = 34, laneH = 40;
    el("text", { x: L, y: 18, "font-size": 11, fill: STEEL }, svg)
      .textContent = "stream 0";
    el("line", { x1: L, y1: laneY + laneH + 14, x2: W - R, y2: laneY + laneH + 14,
                 stroke: CLOUD, "stroke-width": 1 }, svg);

    // axis ticks at decades
    for (let d = 0; d <= Math.log10(total); d++) {
      const t = Math.pow(10, d);
      if (t < minT) continue;
      const x = xOf(t);
      el("line", { x1: x, y1: laneY + laneH + 10, x2: x, y2: laneY + laneH + 18,
                   stroke: FOG }, svg);
      el("text", { x: x, y: laneY + laneH + 32, "font-size": 10,
                   fill: STEEL, "text-anchor": "middle" }, svg)
        .textContent = t >= 1000 ? (t / 1000) + " ms" : t + " µs";
    }

    g.timeline.forEach(ev => {
      const x0 = xOf(ev.start === 0 ? minT : ev.start), x1 = xOf(ev.end);
      const w = Math.max(2.5, x1 - x0);
      const color = ev.kind === "kernel" ? INK :
                    ev.kind === "memcpyH2D" ? FERN : PERIWINKLE;
      const rect = el("rect", {
        x: x0, y: laneY, width: w, height: laneH,
        rx: 6, fill: color, opacity: ev.kind === "kernel" ? 0.92 : 0.75,
        class: "bar-clickable"
      }, svg);
      rect.addEventListener("mousemove", e => showTip(e,
        "<strong>" + ev.label + "</strong><br>" +
        '<span class="t">' + fmtUs(ev.start) + " → " + fmtUs(ev.end) +
        " · " + fmtUs(ev.end - ev.start) + "</span>"));
      rect.addEventListener("mouseleave", hideTip);
      if (ev.kind === "kernel") {
        rect.addEventListener("click", () => {
          const ki = g.kernels.findIndex(k => k.name === ev.label);
          if (ki >= 0) selectKernel(ki);
        });
      }
      if (w > 56) {
        el("text", { x: x0 + w / 2, y: laneY + laneH / 2 + 4, "font-size": 10,
                     fill: "#ffffff", "text-anchor": "middle",
                     "pointer-events": "none" }, svg).textContent = ev.label.split(" ")[0];
      }
    });
  }

  /* ---------------- bar charts ---------------- */

  function barChart(svgId, items, valueOf, labelOf, tipOf, opts) {
    const svg = $(svgId);
    svg.innerHTML = "";
    const W = 520, rowH = 34, L = 118, R = 60;
    const H = items.length * rowH + 14;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("width", "100%");

    const vals = items.map(valueOf);
    const useLog = opts && opts.log;
    const maxV = Math.max(...vals);
    const minPos = Math.min(...vals.filter(v => v > 0)) || 1;
    const floor = useLog ? minPos / 2.5 : 0;
    const scale = v => {
      if (v <= 0) return 0;
      if (useLog)
        return (Math.log10(v) - Math.log10(floor)) /
               (Math.log10(maxV) - Math.log10(floor)) * (W - L - R);
      return v / maxV * (W - L - R);
    };

    items.forEach((it, i) => {
      const y = i * rowH + 8;
      const selected = i === kernelIndex && opts && opts.selectable;
      el("text", { x: L - 10, y: y + 15, "font-size": 12,
                   fill: selected ? FERN : SLATE, "text-anchor": "end",
                   "font-weight": selected ? 600 : 400 }, svg)
        .textContent = labelOf(it);
      el("rect", { x: L, y: y, width: W - L - R, height: 20, rx: 9999,
                   fill: CLOUD }, svg);
      const w = Math.max(3, scale(valueOf(it)));
      const bar = el("rect", { x: L, y: y, width: w, height: 20, rx: 9999,
                   fill: selected ? FERN : INK,
                   opacity: selected ? 0.9 : 0.85,
                   class: "bar-clickable" }, svg);
      el("text", { x: L + w + 8, y: y + 15, "font-size": 11, fill: STEEL }, svg)
        .textContent = (opts && opts.fmt ? opts.fmt(valueOf(it)) : fmt(valueOf(it)));
      bar.addEventListener("mousemove", e => showTip(e, tipOf(it)));
      bar.addEventListener("mouseleave", hideTip);
      if (opts && opts.selectable)
        bar.addEventListener("click", () => selectKernel(i));
    });
    if (opts && opts.refLine) {
      const x = L + scale(opts.refLine.value);
      el("line", { x1: x, y1: 2, x2: x, y2: H - 8, stroke: FERN,
                   "stroke-dasharray": "4 4", "stroke-width": 1.2 }, svg);
      el("text", { x: x + 4, y: 12, "font-size": 10, fill: FERN }, svg)
        .textContent = opts.refLine.label;
    }
  }

  function renderBars() {
    const g = data.gpus[gpuIndex];
    barChart("duration-svg", g.kernels,
      k => k.durationUs, k => k.name,
      k => "<strong>" + k.name + "</strong><br><span class='t'>" +
           fmtUs(k.durationUs) + " · " + fmt(k.cycles, 1) + " cycles · " +
           k.bound + "</span>",
      { log: true, selectable: true, fmt: fmtUs });

    barChart("bandwidth-svg", g.kernels,
      k => k.memThroughputGBs, k => k.name,
      k => "<strong>" + k.name + "</strong><br><span class='t'>" +
           k.memThroughputGBs.toFixed(1) + " GB/s of " +
           g.spec.memBandwidthGBs.toFixed(0) + " GB/s peak · L2 " +
           k.l2BwGBs.toFixed(1) + " GB/s</span>",
      { selectable: true,
        fmt: v => v.toFixed(0) + " GB/s",
        refLine: { value: g.spec.memBandwidthGBs, label: "peak" } });
  }

  /* ---------------- table ---------------- */

  function renderTable() {
    const g = data.gpus[gpuIndex];
    const tb = $("kernel-table").querySelector("tbody");
    tb.innerHTML = "";
    g.kernels.forEach((k, i) => {
      const tr = document.createElement("tr");
      if (i === kernelIndex) tr.className = "selected";
      const grid = k.grid.filter(x => x > 1).join("×") || "1";
      const block = k.block.filter(x => x > 1).join("×") || "1";
      const boundCls = k.bound.indexOf("Memory") >= 0 ? "bound mem" : "bound";
      tr.innerHTML =
        '<td class="name">' + k.name + "</td>" +
        "<td>" + grid + " × " + block + "</td>" +
        "<td>" + k.regsPerThread + "</td>" +
        "<td>" + (k.shmemPerBlock ? (k.shmemPerBlock / 1024).toFixed(1) + " KB" : "—") + "</td>" +
        "<td>" + k.durationUs.toFixed(1) + "</td>" +
        "<td>" + (k.gflops > 0 ? fmt(k.gflops, 0) : "—") + "</td>" +
        "<td>" + k.memThroughputGBs.toFixed(1) + "</td>" +
        "<td>" + k.ipc.toFixed(0) + "</td>" +
        "<td>" + pct(k.occupancy.theoretical) + "</td>" +
        '<td><span class="' + boundCls + '">' + k.bound + "</span></td>";
      tr.addEventListener("click", () => selectKernel(i));
      tb.appendChild(tr);
    });
  }

  /* ---------------- occupancy ---------------- */

  function renderOccupancy() {
    const g = data.gpus[gpuIndex];
    const k = g.kernels[kernelIndex];
    const occ = k.occupancy;

    $("occ-title").textContent = "Occupancy — " + k.name;
    $("occ-sub").textContent =
      k.regsPerThread + " regs/thread · " +
      (k.shmemPerBlock ? (k.shmemPerBlock / 1024).toFixed(1) + " KB shmem/block · " : "") +
      k.block.filter(x => x > 1).join("×") + " threads/block";

    const maxAcross = Math.max(occ.limits.warps, occ.limits.blocks,
                               occ.limits.registers, occ.limits.sharedmem);
    const rows = [
      ["warp / thread limit", occ.limits.warps],
      ["block slot limit", occ.limits.blocks],
      ["register file limit", occ.limits.registers],
      ["shared memory limit", occ.limits.sharedmem],
    ];
    $("occ-limits").innerHTML = rows.map(r => {
      const binding = r[1] === occ.activeBlocksPerSM;
      const w = Math.max(3, r[1] / maxAcross * 100);
      return '<div class="limit-row">' +
        '<div class="lr-head"><span>' + r[0] + "</span><span" +
        (binding ? ' class="binding">' + r[1] + " blocks — binding" : ">" + r[1] + " blocks") +
        "</span></div>" +
        '<div class="limit-track"><div class="limit-fill' +
        (binding ? " binding" : "") + '" style="width:' + w + '%"></div></div></div>';
    }).join("");

    $("occ-note").innerHTML =
      "<strong>" + occ.activeBlocksPerSM + " blocks · " + occ.activeWarpsPerSM +
      " warps</strong> resident per SM — theoretical occupancy <strong>" +
      pct(occ.theoretical) + "</strong>, achieved <strong>" +
      pct(occ.achieved) + "</strong>. Limited by <strong>" + occ.limiter +
      "</strong>. " + fmt(k.waves, 1) + " waves of " + fmt(k.blocks, 0) +
      " blocks across " + g.spec.numSMs + " SMs.";

    // SM residency grid: full waves fill everything; the tail wave
    // leaves the remainder partially lit.
    const grid = $("sm-grid");
    grid.innerHTML = "";
    $("sm-grid-title").textContent = "SM residency — " + g.spec.numSMs + " SMs";
    const blocksPerSMWave = occ.activeBlocksPerSM * g.spec.numSMs;
    const tailBlocks = k.blocks % blocksPerSMWave;
    const smWithTail = occ.activeBlocksPerSM
      ? Math.ceil(tailBlocks / occ.activeBlocksPerSM) : 0;
    for (let i = 0; i < g.spec.numSMs; i++) {
      const cell = document.createElement("div");
      cell.className = "sm-cell";
      const fill = document.createElement("div");
      fill.className = "fill";
      const load = tailBlocks === 0 ? 1 : (i < smWithTail ? 1 : 0.18);
      fill.style.height = (load * occ.theoretical * 100) + "%";
      if (load < 1) fill.style.background = ASH;
      cell.appendChild(fill);
      cell.title = "SM " + i;
      grid.appendChild(cell);
    }
  }

  /* ---------------- roofline ---------------- */

  function renderRoofline() {
    const g = data.gpus[gpuIndex], s = g.spec;
    const svg = $("roofline-svg");
    svg.innerHTML = "";
    const W = 900, H = 380, L = 70, R = 30, T = 24, B = 46;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("width", "100%");
    svg.style.minWidth = "640px";

    const peak = s.peakGflopsFp32;                 // GFLOP/s
    const bw = s.memBandwidthGBs;                  // GB/s
    const aiMin = 0.05, aiMax = 4096;
    const pMin = 1, pMax = peak * 2.2;

    const x = ai => L + (Math.log10(ai) - Math.log10(aiMin)) /
                    (Math.log10(aiMax) - Math.log10(aiMin)) * (W - L - R);
    const y = p => H - B - (Math.log10(Math.max(p, pMin)) - Math.log10(pMin)) /
                   (Math.log10(pMax) - Math.log10(pMin)) * (H - T - B);

    // grid + axes
    for (let d = -1; d <= 3; d++) {
      const ai = Math.pow(10, d);
      el("line", { x1: x(ai), y1: T, x2: x(ai), y2: H - B, stroke: CLOUD }, svg);
      el("text", { x: x(ai), y: H - B + 20, "font-size": 11, fill: STEEL,
                   "text-anchor": "middle" }, svg)
        .textContent = ai >= 1 ? ai : ai.toString();
    }
    for (let d = 0; d <= Math.log10(pMax); d++) {
      const p = Math.pow(10, d);
      el("line", { x1: L, y1: y(p), x2: W - R, y2: y(p), stroke: CLOUD }, svg);
      el("text", { x: L - 8, y: y(p) + 4, "font-size": 11, fill: STEEL,
                   "text-anchor": "end" }, svg).textContent = fmt(p, 0);
    }
    el("text", { x: (L + W - R) / 2, y: H - 8, "font-size": 12, fill: SLATE,
                 "text-anchor": "middle" }, svg)
      .textContent = "arithmetic intensity — FLOP per DRAM byte";
    el("text", { x: 16, y: T + 10, "font-size": 12, fill: SLATE }, svg)
      .textContent = "GFLOP/s";

    // roofline: memory slope then compute flat
    const ridge = peak / bw;
    const pts = [
      [aiMin, aiMin * bw],
      [ridge, peak],
      [aiMax, peak],
    ].map(p => x(p[0]) + "," + y(p[1])).join(" ");
    el("polyline", { points: pts, fill: "none", stroke: INK,
                     "stroke-width": 1.6 }, svg);
    el("text", { x: x(ridge) + 6, y: y(peak) - 8, "font-size": 11,
                 fill: SLATE }, svg)
      .textContent = "ridge @ " + ridge.toFixed(1) + " FLOP/B";

    // slope shading (memory-bound region) in mint
    el("polygon", {
      points: [
        x(aiMin) + "," + y(aiMin * bw),
        x(ridge) + "," + y(peak),
        x(ridge) + "," + (H - B),
        x(aiMin) + "," + (H - B),
      ].join(" "),
      fill: MINT, opacity: 0.5
    }, svg);

    // kernels
    const legend = [];
    g.kernels.forEach((k, i) => {
      if (k.gflops <= 0 || k.arithmeticIntensity <= 0) return;
      const cx = x(Math.min(Math.max(k.arithmeticIntensity, aiMin), aiMax));
      const cy = y(k.gflops);
      const selected = i === kernelIndex;
      const dot = el("circle", { cx: cx, cy: cy, r: selected ? 8 : 6,
        fill: selected ? FERN : INK, opacity: 0.9,
        stroke: "#ffffff", "stroke-width": 2, class: "bar-clickable" }, svg);
      dot.addEventListener("mousemove", e => showTip(e,
        "<strong>" + k.name + "</strong><br><span class='t'>" +
        k.arithmeticIntensity.toFixed(2) + " FLOP/B · " + fmt(k.gflops, 0) +
        " GFLOP/s · " + k.bound + "</span>"));
      dot.addEventListener("mouseleave", hideTip);
      dot.addEventListener("click", () => selectKernel(i));
      legend.push('<span><span class="dot" style="background:' +
        (selected ? FERN : INK) + '"></span>' + k.name + "</span>");
    });
    $("roofline-legend").innerHTML = legend.join("") +
      '<span><span class="dot" style="background:' + MINT +
      '"></span>memory-bound region</span>';
  }

  /* ---------------- cross-GPU compare ---------------- */

  function renderCompare() {
    const kName = data.gpus[gpuIndex].kernels[kernelIndex].name;
    $("compare-sub").textContent =
      kName + " modeled on every GPU in the catalog — µs, log scale";
    const items = data.gpus.map(g => ({
      g: g,
      k: g.kernels.find(k => k.name === kName)
    })).filter(it => it.k);

    const svg = $("compare-svg");
    svg.innerHTML = "";
    const W = 520, rowH = 32, L = 168, R = 66;
    const H = items.length * rowH + 12;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("width", "100%");

    const vals = items.map(it => it.k.durationUs);
    const maxV = Math.max(...vals), minV = Math.min(...vals);
    const floor = minV / 2;
    const scale = v => (Math.log10(v) - Math.log10(floor)) /
                       (Math.log10(maxV) - Math.log10(floor)) * (W - L - R);

    items.forEach((it, i) => {
      const yy = i * rowH + 6;
      const isCur = it.g === data.gpus[gpuIndex];
      el("text", { x: L - 10, y: yy + 15, "font-size": 11.5,
                   fill: isCur ? FERN : SLATE, "text-anchor": "end",
                   "font-weight": isCur ? 600 : 400 }, svg)
        .textContent = it.g.spec.name.replace(/ \(.*\)/, "");
      el("rect", { x: L, y: yy, width: W - L - R, height: 18, rx: 9999,
                   fill: CLOUD }, svg);
      const w = Math.max(3, scale(it.k.durationUs));
      const bar = el("rect", { x: L, y: yy, width: w, height: 18, rx: 9999,
                   fill: isCur ? FERN : INK, opacity: 0.85,
                   class: "bar-clickable" }, svg);
      el("text", { x: L + w + 8, y: yy + 14, "font-size": 11, fill: STEEL }, svg)
        .textContent = fmtUs(it.k.durationUs);
      bar.addEventListener("mousemove", e => showTip(e,
        "<strong>" + it.g.spec.name + "</strong><br><span class='t'>" +
        kName + " · " + fmtUs(it.k.durationUs) + " · " +
        pct(it.k.occupancy.theoretical) + " occupancy</span>"));
      bar.addEventListener("mouseleave", hideTip);
      bar.addEventListener("click", () => {
        gpuIndex = data.gpus.indexOf(it.g);
        sel.value = gpuIndex;
        renderAll();
      });
    });
  }

  /* ---------------- orchestration ---------------- */

  function selectKernel(i) {
    kernelIndex = i;
    renderBars();
    renderTable();
    renderOccupancy();
    renderRoofline();
    renderCompare();
  }

  function renderAll() {
    renderOverview();
    renderTimeline();
    renderBars();
    renderTable();
    renderOccupancy();
    renderRoofline();
    renderCompare();
  }

  addEventListener("resize", () => renderTimeline());
  renderAll();
})();
