# cuvis — CUDA visualizer & playground

Write CUDA C, run it, and **see what the GPU does** — even on a machine with no NVIDIA GPU.

Four complementary views (with different execution and evidence guarantees):

| Mode | What it is | Needs GPU? |
|------|------------|------------|
| **[Playground](web/playground.html)** | Browser CUDA interpreter + live internals viz | No |
| **[Dashboard](web/dashboard.html)** | Analytical profiler over 10 accel-sim GPU configs | No |
| **[GPU compute](web/compute.html)** | Three built-in WGSL kernels, CPU fallback, correctness-checked local benchmarks | Optional WebGPU adapter |
| **[Spatial lab](web/lab.html)** | Interactive 3D teaching schematic; screen-first exploration | Optional WebGL; CPU drawing fallback |

---

## New GPU and spatial paths

Open `/compute.html` to compare tiled matrix multiplication, vector addition, and ReLU with a JavaScript CPU reference. The cancelable worker warms both backends, alternates their measurement order, checks every output, reports median end-to-end latency, and downloads reproducible evidence JSON. An unavailable adapter uses a labeled CPU path with **no GPU speedup claim**. Shader execution does not produce the interpreter's teaching trace and does not compile arbitrary CUDA.

Open `/lab.html` to orbit, zoom, select SM/warp components, and explore an original futuristic engineering lab on ordinary desktop/mobile screens. WebXR `immersive-vr` is optional on capable browsers/headsets, with per-eye rendering and controller-ray selection; no AR passthrough is implemented. The scene is an **illustrative schematic**, not physical device topology, hardware telemetry, or photorealistic rendering. GPU architecture selections provide context; they do not add validated analytical profiles to the dashboard.

- [Backend contract and benchmark methodology](docs/gpu-backend.md)
- [Modern NVIDIA build support and verification boundaries](docs/nvidia-support.md)
- [Rust/WASM assessment and repeatable baseline](docs/rust-assessment.md)
- [Recorded verification and remaining hardware gates](docs/verification.md)

## Playground: a source-linked CUDA workbench

Serve the static app with Python—no build step, dependencies, GPU, backend, or LLM service:

```sh
python3 -m http.server 3000 --directory web
# Open http://localhost:3000 (or /playground.html)
```

The repository-owned `.hoplite/settings.json` starts the same app in managed Preview.

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
agent-browser eval "$(cat tests/workbench.browser.js)"
```

The Node tests verify CPU-reference outputs and interpreter/trace behavior. The browser suite verifies all library examples, source-step playback, memory inspection, configuration and source invalidation, cancellation, stale-worker protection, error recovery, deadlock reporting, and bounded-trace disclosure.

### Engineering team rules and reusable prompt

[The engineering quality spec](docs/engineering-quality-spec.md) defines six accountable roles, disjoint microtask ownership, interface contracts, visual/accessibility principles, simulator fidelity boundaries, staged acceptance gates, and a reusable orchestration prompt. It distinguishes implementation evidence from future quality targets.

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
