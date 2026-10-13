# Verification record — 2026-10-13

This branch is a first GPU/spatial milestone, **not** a full backend rewrite, a photorealistic AR system, or proof of being faster than native CUDA/BLAS or the entire prior application.

## Environment and reproducible checks

Linux x86-64 Modal sandbox, Node 24.21.0, GNU C++ 13.3, CMake 3.28.3, bundled headless Chrome 155. No CUDA compiler, physical GPU device, or headset was available. The app has no new runtime dependency; native verification requires the C++/CMake prerequisites.

```sh
node --test tests/*.test.cjs
cmake -P tests/cuda-architectures.cmake
cmake -S . -B build
cmake --build build -j2
ctest --test-dir build --output-on-failure
./build/cuvis --configs configs --out /tmp/cuvis-proof.json
node tests/benchmark-baseline.cjs
```

The native CPU configuration/build and architecture-selection test passed. Running `cuvis` exported valid analytical JSON for the existing 10 GPU configurations × 8 kernels. Those analytical profiles have not been expanded or validated as modern physical-device models.

With the static app running on port 3000:

```sh
agent-browser open http://127.0.0.1:3000/compute.html
agent-browser eval "$(cat tests/compute.browser.js)"
agent-browser open http://127.0.0.1:3000/lab.html
agent-browser eval "$(cat tests/lab.browser.js)"
agent-browser open http://127.0.0.1:3000/playground.html
agent-browser eval "$(cat tests/workbench.browser.js)"
```

Confirmed in the integrated browser:

- All three numeric operations match their CPU references; CPU execution is labeled and its GPU speedup reads `N/A`.
- Cancel terminates work without a late/stale result; automatic unavailable-adapter fallback and evidence JSON generation work.
- Screen lab orbit changes rendered pixels; zoom, reset, pause and component selection work; architecture context changes without fabricating device counts.
- Desktop and 390-pixel mobile layouts fit the viewport. Fresh screenshots were inspected, including the labeled software-rendered scene.
- The existing workbench's 16 browser checks pass, covering eight examples, trace playback, memory inspection, launch changes, error/reset recovery, cancellation, deadlock and truncation disclosure.

## Measured evidence, not a speedup claim

[`evidence/cpu-fallback.json`](evidence/cpu-fallback.json) is a captured local UI export, not invented data. For a 128×128 matrix, every one of 16,384 outputs matched in five measured runs after two warmups. Both selected execution and the reference used CPU; maximum absolute error was zero. The export includes individual latencies, timestamp, browser, adapter reason, methodology and exact deterministic input recipe. The ratio is deliberately `null` because **no GPU ran**. Timing samples vary across runs; this is correctness/fallback evidence only.

The separately reproducible interpreter/direct-loop baseline in [the Rust assessment](rust-assessment.md) shows the cost of traced interpretation versus numeric-only work. It does **not** establish equivalent functionality or a Rust/GPU/whole-application speedup.

## Outstanding hardware gates

The bundled browser returned no WebGPU adapter and no WebGL context. SwiftShader initialization failed with Vulkan initialization error −3 even in a dedicated software-rendering test profile; the platform issue was reported. The app uses a labeled CPU numeric fallback and Canvas2D perspective renderer instead. No browser security flags are shipped with the app.

Still unverified:

1. Real WGSL shader compilation/execution and non-square/partial-tile results on WebGPU adapters. Backend unit tests use CPU references and GPU API test doubles; they cannot prove shader correctness.
2. GPU latency/throughput against matching existing workloads on physical NVIDIA/AMD/Intel/Apple hardware. No fastest-in-class claim is supported.
3. CUDA compilation/device execution for the documented toolkit/SM combinations, including Jetson ARM64 and DGX/desktop deployments. Build target selection is not hardware certification or multi-GPU support.
4. WebGL/WebGL2 shader rendering, real headset stereo/session/controller behavior, and device loss during immersive VR. The optional WebXR path is implemented but no headset was available. AR passthrough, hit testing and photorealistic assets are not implemented.
5. Rust/WASM performance: no Rust implementation or measured Rust improvement is claimed.
