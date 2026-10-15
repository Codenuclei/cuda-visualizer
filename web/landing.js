(function (root, factory) {
  "use strict";
  const landing = factory();
  if (typeof module === "object" && module.exports) module.exports = landing;
  root.CUVIS_LANDING = landing;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ---- 1. Interactive Hero Warp Mini-Sim ----
  const SIM_PRESETS = {
    vecAdd: {
      name: "Vector Addition (Coalesced)",
      code: "out[i] = a[i] + b[i];",
      activeCount: 32,
      transactions: 4,
      idealTransactions: 4,
      efficiency: "100%",
      lanes: Array.from({ length: 32 }, (_, i) => ({ id: i, state: "coalesced", val: (i * 1.5).toFixed(1) }))
    },
    divergent: {
      name: "Branch Divergence (if / else)",
      code: "if (tid % 2 == 0) { out[i] *= 2; }",
      activeCount: 16,
      transactions: 4,
      idealTransactions: 2,
      efficiency: "50%",
      lanes: Array.from({ length: 32 }, (_, i) => ({ id: i, state: i % 2 === 0 ? "active" : "divergent", val: i % 2 === 0 ? (i * 2).toString() : "skip" }))
    },
    strided: {
      name: "Strided Memory (Uncoalesced)",
      code: "out[i] = a[i * 32]; // 32-stride",
      activeCount: 32,
      transactions: 32,
      idealTransactions: 4,
      efficiency: "12.5%",
      lanes: Array.from({ length: 32 }, (_, i) => ({ id: i, state: "active", val: `0x${(i * 32 * 4).toString(16)}` }))
    }
  };

  let currentPresetKey = "vecAdd";
  let isPlaying = false;
  let playTimer = null;

  function renderWarpSim() {
    if (typeof document === "undefined") return;
    const data = SIM_PRESETS[currentPresetKey];
    if (!data) return;

    const gridEl = document.getElementById("hero-lanes-grid");
    if (gridEl) {
      gridEl.innerHTML = "";
      data.lanes.forEach((lane) => {
        const cell = document.createElement("div");
        cell.className = `lane-cell ${lane.state}`;
        cell.title = `Lane ${lane.id}: ${lane.val}`;
        cell.textContent = lane.id;
        gridEl.appendChild(cell);
      });
    }

    const activeEl = document.getElementById("stat-active-lanes");
    const effEl = document.getElementById("stat-coalescing-eff");
    const transEl = document.getElementById("stat-memory-trans");

    if (activeEl) activeEl.textContent = `${data.activeCount} / 32`;
    if (effEl) effEl.textContent = data.efficiency;
    if (transEl) transEl.textContent = `${data.transactions} sectors`;
  }

  function setPreset(key) {
    if (!SIM_PRESETS[key]) return false;
    currentPresetKey = key;
    renderWarpSim();
    return true;
  }

  function setupWarpSim() {
    if (typeof document === "undefined") return;
    const selector = document.getElementById("hero-warp-select");
    const stepBtn = document.getElementById("hero-warp-step");
    const playBtn = document.getElementById("hero-warp-play");

    if (selector) {
      selector.addEventListener("change", (e) => {
        setPreset(e.target.value);
      });
    }

    if (stepBtn) {
      stepBtn.addEventListener("click", () => {
        const keys = Object.keys(SIM_PRESETS);
        const nextIdx = (keys.indexOf(currentPresetKey) + 1) % keys.length;
        currentPresetKey = keys[nextIdx];
        if (selector) selector.value = currentPresetKey;
        renderWarpSim();
      });
    }

    if (playBtn) {
      playBtn.addEventListener("click", () => {
        isPlaying = !isPlaying;
        playBtn.textContent = isPlaying ? "Pause" : "Play";
        playBtn.classList.toggle("active", isPlaying);
        if (isPlaying) {
          playTimer = setInterval(() => {
            const keys = Object.keys(SIM_PRESETS);
            const nextIdx = (keys.indexOf(currentPresetKey) + 1) % keys.length;
            currentPresetKey = keys[nextIdx];
            if (selector) selector.value = currentPresetKey;
            renderWarpSim();
          }, 1500);
        } else {
          clearInterval(playTimer);
        }
      });
    }

    renderWarpSim();
  }

  // ---- 2. Architecture Matrix Filtering ----
  function setupArchTable() {
    if (typeof document === "undefined") return;
    const tabs = document.querySelectorAll(".arch-tab");
    const rows = document.querySelectorAll("#arch-tbody tr");

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        tabs.forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");

        const gen = tab.getAttribute("data-gen");
        rows.forEach((row) => {
          if (gen === "all" || row.getAttribute("data-gen") === gen) {
            row.style.display = "";
          } else {
            row.style.display = "none";
          }
        });
      });
    });
  }

  function init() {
    setupWarpSim();
    setupArchTable();
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }

  return {
    SIM_PRESETS,
    setPreset,
    getCurrentPreset: () => currentPresetKey,
    renderWarpSim,
    setupWarpSim,
    setupArchTable,
    init
  };
});
