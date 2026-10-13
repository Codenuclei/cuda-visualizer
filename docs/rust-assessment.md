# Rust/WASM assessment for cuvis

## Recommendation

Do not rewrite the whole backend in Rust or WASM on the current evidence. The browser playground executes a CUDA-C subset by parsing and transpiling it to JavaScript generator bodies, creating a generator for every logical thread, advancing those generators in lockstep to model barriers, and proxy-wrapping buffers to record accesses. Source-level trace events and derived analyses are a product feature, not incidental overhead. A Rust port would be a second interpreter implementation and would not, by language choice alone, provide CUDA hardware execution, WebGPU, or a faithful trace model.

The bounded baseline below compares that existing API with a direct JavaScript CPU vector-add loop on identical deterministic `Float32Array` inputs. It is evidence of the cost of the current traced interpreter versus this deliberately minimal numeric reference—not a Rust comparison, an equivalent amount of work, or proof of a production speedup. No Rust compiler, Cargo, or WASM packaging toolchain was available in the inspected environment; no Rust result is claimed.

## Existing architecture and likely costs

- `web/cuda-sim.js` parses and validates kernel source, instruments statements, transpiles the body, creates a generator factory, and runs one generator per logical thread. This work is repeated for each `CudaSim.run` call. Threads and barriers are a deterministic teaching model, not GPU scheduling.
- Global and shared memory are proxied for access tracking; source statements, branches, memory operations, and other events are recorded. The UI posts a 12,000-event cap, while the simulator allows up to 65,536 launched threads and separately caps focus-block access records. A cap bounds retained event volume; it does not make the run equivalent to an untraced numeric loop.
- `web/sim-worker.js` also derives coalescing, bank-conflict, divergence, and operation summaries from simulator output. The baseline calls `CudaSim.run` directly and therefore does **not** time Worker startup/message transfer or these post-run analyses.
- `src/engine.cpp` / `include/cuvis/engine.h` implement a C++ analytical GPU performance model (occupancy and estimated resource/time behavior); `src/kernels.cu` provides a separate CUDA kernel suite. These are not an implementation of the browser interpreter and do not execute a matching trace-producing vector-add workload. Their timings or estimated durations cannot be compared to the browser baseline as an apples-to-apples language benchmark.

## Reproduce the JavaScript baseline

From the repository root, run:

```sh
node tests/benchmark-baseline.cjs
```

The script reports Node version and platform, uses fixed input generation and sizes (256, 4,096, and 16,384 values), warms each path twice, and reports medians of five alternating-order samples. It compares `CudaSim.run` with a direct loop over the same preallocated Float32 inputs. Exact output equality is checked after every warmup and timed run. The launch uses 128 threads per block and a trace cap matching the playground's 12,000-event setting. Input creation is outside the timed region; the interpreter measurement includes its public run-call work (including parse/transpile, setup, traced execution, and buffer writes). The reference measurement is only the numeric loop and writes. System load, runtime/JIT state, and platform can change the reported figures; rerun on the target environment rather than treating one run as a universal constant.

### Baseline measured in this environment

Environment: Node 24.21.0, Linux x64. Command: `node tests/benchmark-baseline.cjs`. The table reports medians in milliseconds and ranges observed across two invocations in this workspace. The ratio is interpreter median divided by CPU-reference median. These are noisy measurements, not confidence intervals: interpreter time varied substantially between invocations, especially for 4,096 elements. Treat them only as a bounded baseline, not a performance decision or proof of a Rust speedup. The paths do different amounts of work and neither is a drop-in replacement for the other.

| Elements | Launched threads | Traced interpreter median range (ms) | CPU numeric reference median range (ms) | Interpreter/reference ratio range | Retained/attempted execution events | Global accesses |
|---:|---:|---:|---:|---:|---:|---:|
| 256 | 256 | 3.494–3.805 | 0.081–0.095 | 36.9–46.7× | 1,536 / 1,536 | 768 |
| 4,096 | 4,096 | 15.972–146.521 | 0.029–0.046 | 547.0–3,188.0× | 12,000 / 24,576 | 12,288 |
| 16,384 | 16,384 | 84.971–140.468 | 0.032 | 2,644.6–4,355.6× | 12,000 / 98,304 | 49,152 |

The direct loop omits parsing, per-thread execution, source-linked trace recording and memory-proxy instrumentation. The interpreter's main cost centers are therefore structurally apparent, but this microbenchmark does not isolate their individual shares. The Web Worker wrapper and its trace-derived analyses are also outside its timing boundary.

## What Rust/WASM could and could not improve

**Plausible targets:** a measured hot numeric loop, parser/transpiler component, or trace-analysis pass could be ported selectively to Rust and compiled to WebAssembly. Rust offers explicit data layouts, predictable low-level control, and WebAssembly SIMD (`simd128`) intrinsics for suitable regular numeric work. This is a hypothesis to profile, not a speedup guarantee. Generator/barrier scheduling, dynamic per-thread state, event construction, and proxy-equivalent instrumentation may dominate and need their own compatible Rust design. Preserve the existing trace semantics and output contract before comparing implementations.

**Costs and limitations:** WebAssembly has linear memory separate from JavaScript's object heap. Passing typed arrays or structured trace data across that boundary can require copies, conversions, or binding/serialization work, so large repeated transfers can erase kernel-side gains. Module download, compilation/instantiation, and glue-code startup matter for short interactive runs; separately measure cold start and warmed execution. SIMD-capable binaries also need an explicit compatibility policy for runtimes without `simd128`. A browser WASM module is not a CUDA driver and does not make CUDA kernels run on the user's GPU.

**GPU boundary:** Rust/WASM does not replace the browser GPU API. Browser GPU compute still goes through WebGPU and WGSL (or another explicitly supported browser shader path). Rust's `wgpu` is a cross-platform GPU API usable from native Rust and, with the relevant target/backend support, WebAssembly; adopting it is a distinct GPU-backend design, not a way to run native Rust CUDA inside the browser. Browser WebGPU availability and secure-context restrictions remain platform concerns. The current C++ CUDA kernel suite and analytical model are separate native pathways and should be benchmarked against matching native workloads if portability or throughput is the decision criterion.

## Decision gate for a future port

1. Profile representative kernels in the existing browser and separate parse/transpile, scheduling, memory instrumentation, trace storage, and derived-analysis costs.
2. If one portable CPU-side stage remains a measured bottleneck, prototype only that stage in Rust/WASM; keep inputs, outputs, event semantics, and fixtures identical.
3. Measure cold and warm runs in supported browsers, including typed-array transfer/copy and trace costs, with correctness checked against existing deterministic fixtures.
4. Keep a JavaScript fallback unless target-browser and binary-size/startup requirements justify requiring the Rust/WASM build.
5. Treat GPU execution as a separate WebGPU/WGSL architecture decision, with device/browser capability detection and a non-WebGPU fallback.

## References

- Rust and WebAssembly Book, [JavaScript interoperability](https://rustwasm.github.io/docs/book/reference/js-ffi.html), [profiling](https://rustwasm.github.io/docs/book/reference/time-profiling.html), and [WebAssembly support guidance](https://rustwasm.github.io/docs/book/reference/add-wasm-support-to-crate.html).
- Rust standard library, [`wasm32` architecture intrinsics](https://doc.rust-lang.org/stable/core/arch/wasm32/index.html); WebAssembly, [SIMD proposal](https://github.com/WebAssembly/simd/blob/main/proposals/simd/SIMD.md).
- [`wgpu` API documentation](https://docs.rs/wgpu/latest/wgpu/), [W3C WebGPU specification](https://www.w3.org/TR/webgpu/), [W3C WGSL specification](https://www.w3.org/TR/WGSL/), and [MDN WebGPU API availability and security notes](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API).
