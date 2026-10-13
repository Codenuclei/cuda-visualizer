# cuvis — CUDA visualizer & playground

Explore AI library operations and **see the math, tensors, and CUDA-style execution**—even on a machine with no NVIDIA GPU.

Two modes:

| Mode | What it is | Needs GPU? |
|------|------------|------------|
| **[Playground](web/playground.html)** | Library source explorer + CUDA teaching interpreter | No |
| **[Dashboard](web/dashboard.html)** | Analytical profiler over 10 accel-sim GPU configs | No |

---

## Playground: a source-linked CUDA workbench

Serve the static app with Python—no build step, dependencies, GPU, backend, or LLM service:

```sh
python3 -m http.server 3000 --directory web
# Open http://localhost:3000 (or /playground.html)
```

The repository-owned `.hoplite/settings.json` starts the same app in managed Preview.

### Start from a library, not a kernel

The playground opens in **Library explorer**. Choose PyTorch, NumPy, or TensorFlow.js, select an operation, and click **Explore operation**. Only the selected JSON lesson pack is fetched; no framework is downloaded or installed.

- **Eight tested operations:** PyTorch Linear + ReLU, Conv1d, scaled dot-product attention, and LayerNorm; NumPy matrix multiplication and stable softmax composition; TensorFlow.js sigmoid and softmax.
- **The whole operation:** readable API examples, formulas, tensor shapes, connected stages, and deterministic human-readable explanations. Select a stage to connect its explanation and source lines.
- **Actual simulated tensors:** input fixtures, intermediate buffers, final outputs, signed heatmaps, and statistics. Select a tensor cell to jump to its exact recorded memory access. Attention exposes scores and normalized probabilities before mixing values.
- **Three source views:** an authored usage example, a pinned original source excerpt fetched as text from jsDelivr only when opened, and a CPU-reference-tested CUDA teaching mapping. Source excerpts retain original line numbers, repository/version attribution, and license links.
- **Private snippet suggestions:** find known Python/JavaScript APIs in a short pasted snippet, entirely in-browser. Suggestions do not translate, validate, or execute pasted code.
- **Bounded loading:** schema and URL validation, streamed size caps, aborts/timeouts, retry states, and memory-bounded caching. A CDN failure leaves the local lesson usable. There is no service worker or durable offline cache.

These are reviewed mappings for fixed fixtures, **not an arbitrary-library importer or universal language-to-CUDA transpiler**. Upstream Python, TypeScript, and native bindings are references; downloaded source is never executed. The examples illustrate individual operations, not complete neural-network training or inference. Versions are deliberately pinned for reproducibility, not advertised as the latest releases.

Select **CUDA kernels** for the original editor, or **Open CUDA trace** from a lesson to inspect and modify its executable teaching kernel.

### Explore the machine

- **Kernel library:** vector addition, shared-memory reduction, 2D matrix multiplication, MLP linear + ReLU, valid 1D convolution, LM-head vocabulary projection, strided access, and divergent branches.
- **Editable source and launch settings:** run custom code, change grid/block x dimensions, and change vector-add buffer length. Other examples use explicit fixed-size fixtures; the matrix example keeps block y at eight.
- **Logical execution map:** inspect blocks, 32-lane warps, and the currently recorded thread. This is not physical SM scheduling.
- **Memory inspection:** map recorded global-memory lane addresses into 32-byte sectors, with analytical coalescing estimates.
- **Source-linked playback:** play, pause, rewind, scrub, and step through bounded execution events. Source highlighting, thread identity, recorded values, and deterministic explanations follow the same event.
- **Real output:** inspect final buffer values, changed cells, device `printf`, CPU-reference checks for unmodified examples, and actionable errors.

Runs execute in a cancelable Web Worker with an 8-second UI timeout. Editing source or launch parameters invalidates the previous trace. The UI requests at most 12,000 source events and explicitly discloses truncation; computation continues after the trace fills. Buffers are final results, not reconstructed intermediate state. Deadlocks are reported as partial execution, never success.

### Truth boundary

This is an educational interpreter of a **supported CUDA C subset**, not nvcc, a hardware emulator, or a complete CUDA runtime. It supports scalar declarations and math, indexed typed buffers, branches, `for`/`while` loops, block barriers, shared memory, and selected atomics. Unsupported syntax is rejected; the language model simplifies CUDA numerical and scheduling semantics. There are no hardware timing claims.

MLP, CNN, and LM-head examples are small individual kernels, not complete neural-network inference. Explanations are finite rules applied to recorded interpreter events. Algorithm-overview cards are authored lesson metadata, labeled separately from execution evidence. No LLM is used at runtime.

Known playground configuration limits: launches are one- or two-dimensional; only scalar parameters named `n` or `N` are supplied by the UI. Built-in pointer names use preset fixtures. Additional const pointer parameters receive a deterministic numeric ramp; additional writable pointers receive zero-filled buffers. Custom kernels must fit that buffer/scalar contract. Memory coalescing is estimated for block zero, and the request selector displays at most 160 requests. The map displays at most four blocks and two warps per block at once, following the selected event.

### Controls

- **Ctrl/⌘ + Enter:** run or cancel a kernel.
- **Left / right arrows:** step when not editing a control.
- **Space:** play/pause when not editing a control.
- **/**: focus kernel search on desktop.
- In the editor, **Tab** indents; **Escape, then Tab** moves focus out.

### Verification

```sh
node --test tests/*.test.cjs
# Against a running preview, with the installed agent-browser CLI:
agent-browser open http://localhost:3000/playground.html
agent-browser eval "$(cat tests/library-explorer.browser.js)"
# The library suite checks one real CDN source and requires network access.
agent-browser open http://localhost:3000/playground.html
agent-browser click '#mode-kernels'
agent-browser eval "$(cat tests/workbench.browser.js)"
```

The Node tests verify pack schemas and independent numerical references, bounded/abortable loading, inert source extraction, snippet suggestions, and interpreter/trace behavior. The library browser suite checks all eight mappings, selection-only requests, caches, live pinned-source loading, tensor/source/trace links, snippet boundaries, rapid switching, and stale state. The original workbench browser suite verifies its eight examples, source-step playback, memory inspection, configuration and source invalidation, cancellation, stale-worker protection, error recovery, deadlock reporting, and bounded-trace disclosure.

### Engineering team rules and reusable prompt

[The engineering quality spec](docs/engineering-quality-spec.md) defines six accountable roles, disjoint microtask ownership, interface contracts, visual/accessibility principles, simulator fidelity boundaries, staged acceptance gates, and a reusable orchestration prompt. It distinguishes implementation evidence from future quality targets. [The library explorer contract](docs/library-explorer-spec.md) describes pack ownership, provenance, loading boundaries, and extension gates.

---

## Dashboard (accel-sim analytical profiler)

The C++ engine models kernel performance on GPUs described by
[Accel-Sim](https://github.com/accel-sim/accel-sim-framework) /
GPGPU-Sim `gpgpusim.config` files — no hardware required.

### Build (analytical backend, no CUDA)

```powershell
.\build.ps1
# or manually:
g++ -std=c++17 -Iinclude -O2 src/main.cpp src/config_parser.cpp src/engine.cpp `
    src/trace_reader.cpp src/json_export.cpp -x c++ src/kernels.cu -o build/cuvis.exe
```

### Run

```powershell
.\build\cuvis.exe --configs configs --out web/data.json
# open web/dashboard.html (or serve web/ and visit /dashboard.html)
```

Models **10 GPUs** (Fermi → Ampere): GTX 480, Kepler TITAN, Pascal TITAN X, Volta V100/GV100/TITAN V, Turing RTX 2060/SUPER, A100, RTX 3070.

### Build with nvcc (CUDA 11 / 12 / 13)

When `nvcc` is on PATH, the same sources compile real CUDA kernels and profile the physical GPU:

```powershell
nvcc -std=c++17 -Iinclude -O2 src/main.cpp src/config_parser.cpp src/engine.cpp `
     src/trace_reader.cpp src/json_export.cpp src/kernels.cu -o build/cuvis.exe
```

CUDA 13 removed `clockRate` from `cudaDeviceProp`; `include/cuvis/cuda_compat.h` queries it via `cudaDeviceGetAttribute` instead.

### Trace input (optional)

Feed an accel-sim `kernelslist.g`:

```powershell
.\build\cuvis.exe --trace path/to/kernelslist.g --configs configs --out web/data.json
```

---

## Project layout

```
cuda-visualizer/
├── src/                  C++ engine (config parser, occupancy, roofline model)
├── include/cuvis/        headers + CUDA 11-13 compat layer
├── configs/              10 accel-sim gpgpusim.config GPU descriptions
├── web/
│   ├── playground.html   ← write CUDA here
│   ├── index.html        ← playground entry point
│   ├── dashboard.html    ← device comparison dashboard
│   ├── kernel-library.js ← tested teaching fixtures
│   ├── cuda-sim.js       browser CUDA interpreter
│   ├── sim-worker.js     off-thread runner
│   └── data.json         generated by cuvis.exe
└── third_party/
    ├── accel-sim-framework/
    └── gpgpu-sim_distribution/
```

---

## How the model works

Hardware specs come from accel-sim's tested GPU configs. For each kernel launch the engine computes:

- **Occupancy** — same rules as `cudaOccupancyMaxActiveBlocksPerMultiprocessor` (warps, blocks, registers, shared memory limits)
- **Duration** — roofline model (compute vs memory bound) with latency floors from simulator L1/SMEM/DRAM cycle counts
- **Stats** — named like accel-sim output: `gpu_tot_sim_cycle`, `gpu_ipc`, `gpu_occupancy`, `L2_BW`, `total dram reads/writes`

The playground goes further: it **executes** your kernel (interpreted lockstep with real `__syncthreads` barriers) and records every memory access for the visualization panels.
