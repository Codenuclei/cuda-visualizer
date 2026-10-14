# GPU backend and evidence contract

This is an additive executable-kernel path, not an entire backend rewrite or an arbitrary CUDA-to-WGSL compiler. The source-linked CUDA interpreter and C++ analytical/native paths remain intact. WGSL handles GPU compute; JavaScript owns browser APIs, validation, worker lifecycle and evidence export. No WASM build or remote service is required.

## API

`web/gpu-backend.js` exports `globalThis.CuvisGPU` and CommonJS:

```js
const backend = await CuvisGPU.createBackend({ forceCPU: false });
try {
  const result = await backend.run('vectorAdd', {
    a: new Float32Array([1, 2]), b: new Float32Array([3, 4])
  });
  // result.output, result.backend, result.timings.totalMs
} finally {
  backend.dispose();
}
```

Operations are `vectorAdd({a,b})`, `relu({a})`, and row-major `matmul({a,b,m,k,n})`. Inputs must contain finite Float32-representable numbers. Empty vectors are valid; matrix dimensions must be positive. Matmul uses 16×16 workgroup tiles and shared workgroup arrays, with zero-filled tails and barriers reached by all invocations. Vectors use 256-invocation workgroups with bounds checks.

`backend.kind` describes current adapter availability; **each `run().backend` describes actual execution**. Adapter limits or a lost device can cause CPU execution even after successful initialization. The worker records actual measured backends and withholds a GPU ratio on CPU/mixed runs. Adapter metadata is informational, may be redacted, and is not proof of physical NVIDIA hardware.

Allocation/work budgets are 64 MiB per buffer, 128 MiB aggregate, and 64 Mi multiply-accumulate terms per matrix operation. Device buffer/binding/dispatch limits are checked separately. The UI further bounds square matrices to 256×256, vectors to 1,048,576 elements and repetitions to 5 or 9. Device buffers are destroyed after readback; device loss, shader initialization failure and unavailable WebGPU have a labeled CPU fallback. GPU-capable browsers require a secure context (HTTPS or localhost).

## Measurement

`web/gpu-worker.js` uses deterministic inputs: Float32 `a[i]=((i%97)-48)/97`, `b[i]=((i%89)-44)/89`. Two warmups precede 5/9 measured runs. Backend order alternates. Each sample times the entire awaited `run()` call, including input validation, allocation, upload, dispatch, map/readback and output validation. Adapter initialization and warmed shader compilation are excluded. Cross-worker transport and page rendering are not in the sample.

Every measured output is checked against the CPU result with `absError <= 1e-4 + 1e-4*abs(reference)`. The baseline uses JavaScript double-precision accumulation rounded into Float32 output; the WGSL path uses Float32 arithmetic, so equality is tolerant rather than bitwise for matrix multiplication. A failed comparison withholds the speedup ratio. The ratio is CPU median / selected-backend median, not shader-only throughput, and small workloads can be slower on the GPU. Browser timer precision, JIT compilation, thermal state and competing work affect results. Downloaded JSON retains all samples, recipe, browser, adapter information and methodology.

The worker has a 90-second deadline. Cancel terminates it; a new worker starts each run, preventing stale updates. Input generation and CPU compute stay off the UI thread. Downloaded results are generated locally; no telemetry or uploads occur.

## Scope and future gates

- No shader execution or physical GPU performance claim follows from CPU tests or a software adapter.
- This benchmark is not cuBLAS, optimized native CUDA, the trace-producing interpreter, a multi-GPU workload, or proof that the entire application is faster.
- Browser adapter selection does not promise a particular vendor, GPU generation or device count. Native CUDA build targeting is separate; see [NVIDIA support](nvidia-support.md).
- Tensor cores, CUDA graphs, FP16/BF16/FP8 kernels, NVLink/NCCL, out-of-core execution and multi-GPU scheduling are not implemented here.
- Rust/WASM can be evaluated for a measured CPU bottleneck; language choice alone is not a throughput guarantee. See [the assessment](rust-assessment.md).
