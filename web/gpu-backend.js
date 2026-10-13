(function (root) {
  "use strict";

  const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
  const MAX_MATMUL_TERMS = 128 * 1024 * 1024;
  const MAX_BENCHMARK_ITERATIONS = 50;
  const TILE = 16;
  const VECTOR_WORKGROUP_SIZE = 256;

  const SHADERS = {
    vectorAdd: `
struct Params { n: u32, _p0: u32, _p1: u32, _p2: u32, };
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.n) { return; }
  output[id.x] = a[id.x] + b[id.x];
}`,
    relu: `
struct Params { n: u32, _p0: u32, _p1: u32, _p2: u32, };
@group(0) @binding(0) var<storage, read> input: array<f32>;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.n) { return; }
  output[id.x] = max(input[id.x], 0.0);
}`,
    matmul: `
struct Params { m: u32, k: u32, n: u32, _p0: u32, };
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;
var<workgroup> tileA: array<f32, 256>;
var<workgroup> tileB: array<f32, 256>;
@compute @workgroup_size(16, 16, 1)
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_id) local: vec3<u32>) {
  let row = group.y * 16u + local.y;
  let col = group.x * 16u + local.x;
  var sum = 0.0;
  let tileCount = (params.k + 15u) / 16u;
  for (var tile = 0u; tile < tileCount; tile += 1u) {
    let aCol = tile * 16u + local.x;
    let bRow = tile * 16u + local.y;
    var valueA = 0.0;
    var valueB = 0.0;
    if (row < params.m && aCol < params.k) { valueA = a[row * params.k + aCol]; }
    if (bRow < params.k && col < params.n) { valueB = b[bRow * params.n + col]; }
    tileA[local.y * 16u + local.x] = valueA;
    tileB[local.y * 16u + local.x] = valueB;
    workgroupBarrier();
    for (var i = 0u; i < 16u; i += 1u) {
      sum += tileA[local.y * 16u + i] * tileB[i * 16u + local.x];
    }
    workgroupBarrier();
  }
  if (row < params.m && col < params.n) { output[row * params.n + col] = sum; }
}`,
  };

  function now() {
    return root.performance && typeof root.performance.now === "function"
      ? root.performance.now()
      : Date.now();
  }

  function positiveDimension(value, label) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff) {
      throw new RangeError(`${label} must be a positive 32-bit integer`);
    }
    return value;
  }

  function checkedProduct(a, b, label) {
    const product = a * b;
    if (!Number.isSafeInteger(product)) throw new RangeError(`${label} is too large`);
    return product;
  }

  function validateInput(value, label, expectedLength) {
    if (value == null || typeof value.length !== "number" || !Number.isSafeInteger(value.length)) {
      throw new TypeError(`${label} must be an array or numeric typed array`);
    }
    if (value.length !== expectedLength) {
      throw new RangeError(`${label} must contain exactly ${expectedLength} values`);
    }
    if (expectedLength * Float32Array.BYTES_PER_ELEMENT > MAX_BUFFER_BYTES) {
      throw new RangeError(`${label} exceeds the ${MAX_BUFFER_BYTES}-byte buffer limit`);
    }
    if (ArrayBuffer.isView(value) && !(value instanceof Float32Array) && value instanceof DataView) {
      throw new TypeError(`${label} must be a numeric array, not a DataView`);
    }
    const output = value instanceof Float32Array ? value : new Float32Array(expectedLength);
    for (let i = 0; i < expectedLength; i++) {
      const number = value[i];
      if (typeof number !== "number" || !Number.isFinite(number)) {
        throw new TypeError(`${label}[${i}] must be a finite number`);
      }
      if (value instanceof Float32Array) continue;
      const converted = Math.fround(number);
      if (!Number.isFinite(converted)) {
        throw new RangeError(`${label}[${i}] is outside the finite float32 range`);
      }
      output[i] = converted;
    }
    return output;
  }

  function prepareOperation(operation, inputs) {
    if (operation !== "vectorAdd" && operation !== "matmul" && operation !== "relu") {
      throw new TypeError(`Unsupported operation: ${String(operation)}`);
    }
    if (inputs == null || typeof inputs !== "object") throw new TypeError("inputs must be an object");

    let arrays;
    let dimensions;
    let outputLength;
    if (operation === "vectorAdd") {
      if (inputs.a == null || inputs.b == null || !Number.isSafeInteger(inputs.a.length) || !Number.isSafeInteger(inputs.b.length)) {
        throw new TypeError("vectorAdd requires array inputs a and b");
      }
      if (inputs.a.length !== inputs.b.length) throw new RangeError("a and b must have equal lengths");
      outputLength = inputs.a.length;
      if (outputLength * 4 > MAX_BUFFER_BYTES) throw new RangeError("vector length exceeds the buffer limit");
      if (outputLength * 28 + 16 > MAX_TOTAL_BYTES) throw new RangeError(`operation exceeds the ${MAX_TOTAL_BYTES}-byte aggregate limit`);
      arrays = [validateInput(inputs.a, "a", outputLength), validateInput(inputs.b, "b", outputLength)];
    } else if (operation === "relu") {
      if (inputs.a == null || !Number.isSafeInteger(inputs.a.length)) throw new TypeError("relu requires array input a");
      outputLength = inputs.a.length;
      if (outputLength * 4 > MAX_BUFFER_BYTES) throw new RangeError("vector length exceeds the buffer limit");
      if (outputLength * 20 + 16 > MAX_TOTAL_BYTES) throw new RangeError(`operation exceeds the ${MAX_TOTAL_BYTES}-byte aggregate limit`);
      arrays = [validateInput(inputs.a, "a", outputLength)];
    } else {
      const m = positiveDimension(inputs.m, "m");
      const k = positiveDimension(inputs.k, "k");
      const n = positiveDimension(inputs.n, "n");
      const aLength = checkedProduct(m, k, "matrix a dimensions");
      const bLength = checkedProduct(k, n, "matrix b dimensions");
      outputLength = checkedProduct(m, n, "matrix output dimensions");
      const terms = checkedProduct(aLength, n, "matrix multiply work");
      if (terms > MAX_MATMUL_TERMS) throw new RangeError(`matmul exceeds the ${MAX_MATMUL_TERMS}-term work limit`);
      if (aLength * 4 > MAX_BUFFER_BYTES || bLength * 4 > MAX_BUFFER_BYTES || outputLength * 4 > MAX_BUFFER_BYTES) {
        throw new RangeError(`matmul buffers cannot exceed ${MAX_BUFFER_BYTES} bytes each`);
      }
      if ((aLength + bLength) * 8 + outputLength * 12 + 16 > MAX_TOTAL_BYTES) {
        throw new RangeError(`operation exceeds the ${MAX_TOTAL_BYTES}-byte aggregate limit`);
      }
      arrays = [validateInput(inputs.a, "a", aLength), validateInput(inputs.b, "b", bLength)];
      dimensions = { m, k, n };
    }

    return { operation, arrays, dimensions, outputLength };
  }

  function assertFiniteOutput(output) {
    for (let i = 0; i < output.length; i++) {
      if (!Number.isFinite(output[i])) throw new RangeError(`operation produced a non-finite value at output[${i}]`);
    }
    return output;
  }

  function runCPUPrepared(prepared) {
    const output = new Float32Array(prepared.outputLength);
    if (prepared.operation === "vectorAdd") {
      const [a, b] = prepared.arrays;
      for (let i = 0; i < output.length; i++) output[i] = a[i] + b[i];
    } else if (prepared.operation === "relu") {
      const [input] = prepared.arrays;
      for (let i = 0; i < output.length; i++) output[i] = input[i] > 0 ? input[i] : 0;
    } else {
      const [a, b] = prepared.arrays;
      const { m, k, n } = prepared.dimensions;
      for (let row = 0; row < m; row++) {
        for (let col = 0; col < n; col++) {
          let sum = 0;
          for (let inner = 0; inner < k; inner++) sum += a[row * k + inner] * b[inner * n + col];
          output[row * n + col] = sum;
        }
      }
    }
    return assertFiniteOutput(output);
  }

  function cpuReference(operation, inputs) {
    return runCPUPrepared(prepareOperation(operation, inputs));
  }

  async function readAdapterInfo(adapter) {
    try {
      if (typeof adapter.requestAdapterInfo !== "function") return undefined;
      const info = await adapter.requestAdapterInfo();
      const safeInfo = {};
      for (const key of ["vendor", "architecture", "device", "description"]) {
        if (typeof info[key] === "string" && info[key]) safeInfo[key] = info[key];
      }
      return Object.keys(safeInfo).length ? safeInfo : undefined;
    } catch (_) {
      return undefined;
    }
  }

  async function createPipeline(device, shader) {
    const module = device.createShaderModule({ code: shader });
    const descriptor = { layout: "auto", compute: { module, entryPoint: "main" } };
    return typeof device.createComputePipelineAsync === "function"
      ? device.createComputePipelineAsync(descriptor)
      : device.createComputePipeline(descriptor);
  }

  // Runs only these built-in tensor operations; it is not a CUDA compiler or arbitrary-kernel executor.
  async function createBackend({ forceCPU = false } = {}) {
    if (typeof forceCPU !== "boolean") throw new TypeError("forceCPU must be a boolean");
    let device;
    let pipelines;
    let gpuEnabled = false;
    let disposed = false;
    let failureReason = forceCPU ? "CPU backend explicitly requested" : "WebGPU is unavailable";
    const info = { kind: "cpu", reason: failureReason, physicalGpu: "unknown" };

    function disableGPU(reason) {
      gpuEnabled = false;
      failureReason = reason || "WebGPU backend failed";
      info.kind = "cpu";
      info.reason = failureReason;
      pipelines = undefined;
      if (device && typeof device.destroy === "function") {
        try { device.destroy(); } catch (_) { /* Device may already be lost. */ }
      }
      device = undefined;
    }

    if (!forceCPU) {
      try {
        const gpu = root.navigator && root.navigator.gpu;
        if (gpu && typeof gpu.requestAdapter === "function") {
          const adapter = await gpu.requestAdapter();
          if (adapter && typeof adapter.requestDevice === "function") {
            const requestedDevice = await adapter.requestDevice({ requiredFeatures: [] });
            device = requestedDevice;
            const names = Object.keys(SHADERS);
            const compiled = await Promise.all(names.map(name => createPipeline(device, SHADERS[name])));
            pipelines = Object.fromEntries(names.map((name, index) => [name, compiled[index]]));
            gpuEnabled = true;
            info.kind = "webgpu";
            delete info.reason;
            const adapterInfo = await readAdapterInfo(adapter);
            const softwareName = adapterInfo && Object.values(adapterInfo).some(value =>
              /swiftshader|llvmpipe|lavapipe|software|warp/i.test(value));
            let fallbackAdapter = null;
            try {
              if (typeof adapter.isFallbackAdapter === "boolean") fallbackAdapter = adapter.isFallbackAdapter;
            } catch (_) {
              // Adapter fallback status is optional browser metadata.
            }
            info.adapter = {
              ...(adapterInfo || {}),
              fallback: fallbackAdapter,
              software: softwareName ? true : null,
            };
            const limits = device.limits || {};
            info.limits = {
              maxBufferSize: limits.maxBufferSize,
              maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
              maxComputeWorkgroupsPerDimension: limits.maxComputeWorkgroupsPerDimension,
            };
            if (device.lost && typeof device.lost.then === "function") {
              device.lost.then(lost => {
                if (!disposed && gpuEnabled) disableGPU(lost && lost.message ? `WebGPU device lost: ${lost.message}` : "WebGPU device lost");
              }).catch(error => {
                if (!disposed && gpuEnabled) disableGPU(`WebGPU device loss notification failed: ${error.message || error}`);
              });
            }
            if (typeof device.addEventListener === "function") {
              device.addEventListener("uncapturederror", event => {
                if (!disposed && gpuEnabled) disableGPU(`Uncaptured WebGPU error: ${event.error && event.error.message || "unknown GPU error"}`);
              });
            }
          } else {
            failureReason = "No compatible WebGPU adapter is available";
          }
        }
      } catch (error) {
        failureReason = `WebGPU initialization failed: ${error && error.message || error}`;
        disableGPU(failureReason);
      }
    }

    if (!gpuEnabled) {
      info.kind = "cpu";
      info.reason = failureReason;
    }

    function deviceSupports(prepared) {
      if (!gpuEnabled || prepared.outputLength === 0) return false;
      const limits = device.limits || {};
      const byteSizes = prepared.arrays.map(array => array.byteLength).concat(prepared.outputLength * 4, 16);
      const maxBufferSize = Number.isFinite(limits.maxBufferSize) ? limits.maxBufferSize : MAX_BUFFER_BYTES;
      const maxStorageSize = Number.isFinite(limits.maxStorageBufferBindingSize)
        ? limits.maxStorageBufferBindingSize
        : MAX_BUFFER_BYTES;
      if (byteSizes.some(size => size > maxBufferSize || size > MAX_BUFFER_BYTES)) return false;
      if (byteSizes.slice(0, prepared.arrays.length + 1).some(size => size > maxStorageSize)) return false;
      const maxGroups = Number.isSafeInteger(limits.maxComputeWorkgroupsPerDimension)
        ? limits.maxComputeWorkgroupsPerDimension
        : 65535;
      if (prepared.operation === "matmul") {
        return Math.ceil(prepared.dimensions.n / TILE) <= maxGroups && Math.ceil(prepared.dimensions.m / TILE) <= maxGroups;
      }
      return Math.ceil(prepared.outputLength / VECTOR_WORKGROUP_SIZE) <= maxGroups;
    }

    async function runGPU(prepared) {
      const usage = root.GPUBufferUsage || { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
      const mapMode = root.GPUMapMode || { READ: 1 };
      const allocated = [];
      function makeBuffer(size, flags) {
        const buffer = device.createBuffer({ size: Math.max(4, size), usage: flags });
        allocated.push(buffer);
        return buffer;
      }
      function storageInput(values) {
        const buffer = makeBuffer(values.byteLength, usage.STORAGE | usage.COPY_DST);
        if (values.byteLength) device.queue.writeBuffer(buffer, 0, values);
        return buffer;
      }
      try {
        const outputBytes = prepared.outputLength * 4;
        const outputBuffer = makeBuffer(outputBytes, usage.STORAGE | usage.COPY_SRC);
        const readback = makeBuffer(outputBytes, usage.MAP_READ | usage.COPY_DST);
        let uniformValues;
        const entries = [];
        if (prepared.operation === "relu") {
          entries.push({ binding: 0, resource: { buffer: storageInput(prepared.arrays[0]) } });
          entries.push({ binding: 1, resource: { buffer: outputBuffer } });
          uniformValues = new Uint32Array([prepared.outputLength, 0, 0, 0]);
          entries.push({ binding: 2, resource: { buffer: makeBuffer(16, usage.UNIFORM | usage.COPY_DST) } });
        } else {
          entries.push({ binding: 0, resource: { buffer: storageInput(prepared.arrays[0]) } });
          entries.push({ binding: 1, resource: { buffer: storageInput(prepared.arrays[1]) } });
          entries.push({ binding: 2, resource: { buffer: outputBuffer } });
          if (prepared.operation === "vectorAdd") {
            uniformValues = new Uint32Array([prepared.outputLength, 0, 0, 0]);
          } else {
            const { m, k, n } = prepared.dimensions;
            uniformValues = new Uint32Array([m, k, n, 0]);
          }
          entries.push({ binding: 3, resource: { buffer: makeBuffer(16, usage.UNIFORM | usage.COPY_DST) } });
        }
        const uniformBuffer = entries[entries.length - 1].resource.buffer;
        device.queue.writeBuffer(uniformBuffer, 0, uniformValues);
        const pipeline = pipelines[prepared.operation];
        const bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries,
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        if (prepared.operation === "matmul") {
          pass.dispatchWorkgroups(Math.ceil(prepared.dimensions.n / TILE), Math.ceil(prepared.dimensions.m / TILE), 1);
        } else {
          pass.dispatchWorkgroups(Math.ceil(prepared.outputLength / VECTOR_WORKGROUP_SIZE), 1, 1);
        }
        pass.end();
        encoder.copyBufferToBuffer(outputBuffer, 0, readback, 0, Math.max(4, outputBytes));
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(mapMode.READ);
        const mapped = readback.getMappedRange();
        const output = new Float32Array(mapped.slice(0, outputBytes));
        readback.unmap();
        return assertFiniteOutput(output);
      } finally {
        for (const buffer of allocated) {
          try { buffer.destroy(); } catch (_) { /* Ignore buffers already invalidated by device loss. */ }
        }
      }
    }

    async function run(operation, inputs, options = {}) {
      if (disposed) throw new Error("GPU backend has been disposed");
      if (options == null || typeof options !== "object") throw new TypeError("options must be an object");
      const started = now();
      const prepared = prepareOperation(operation, inputs);
      let output;
      let actualBackend = "cpu";
      if (deviceSupports(prepared)) {
        try {
          output = await runGPU(prepared);
          actualBackend = "webgpu";
        } catch (error) {
          disableGPU(`WebGPU execution failed; using CPU: ${error && error.message || error}`);
          output = runCPUPrepared(prepared);
        }
      } else {
        output = runCPUPrepared(prepared);
      }
      return { output, timings: { totalMs: Math.max(0, now() - started) }, backend: actualBackend };
    }

    return {
      get kind() { return gpuEnabled ? "webgpu" : "cpu"; },
      info,
      run,
      dispose() {
        if (disposed) return;
        disposed = true;
        if (device && typeof device.destroy === "function") {
          try { device.destroy(); } catch (_) { /* Device may already be lost. */ }
        }
        gpuEnabled = false;
        device = undefined;
        pipelines = undefined;
      },
    };
  }

  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function compareOutputs(actual, expected, absoluteTolerance, relativeTolerance) {
    if (actual.length !== expected.length) return { passed: false, maxAbsError: Infinity };
    let maxAbsError = 0;
    let passed = true;
    for (let i = 0; i < actual.length; i++) {
      if (!Number.isFinite(actual[i]) || !Number.isFinite(expected[i])) {
        passed = false;
        maxAbsError = Infinity;
        continue;
      }
      const difference = Math.abs(actual[i] - expected[i]);
      maxAbsError = Math.max(maxAbsError, difference);
      if (difference > absoluteTolerance + relativeTolerance * Math.abs(expected[i])) {
        passed = false;
      }
    }
    return { passed, maxAbsError };
  }

  async function benchmark(operation, inputs, {
    backend: suppliedBackend,
    warmup = 2,
    iterations = 7,
    absoluteTolerance = 1e-5,
    relativeTolerance = 1e-5,
    runOptions = {},
  } = {}) {
    if (!Number.isSafeInteger(warmup) || warmup < 0 || warmup > MAX_BENCHMARK_ITERATIONS) {
      throw new RangeError(`warmup must be between 0 and ${MAX_BENCHMARK_ITERATIONS}`);
    }
    if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > MAX_BENCHMARK_ITERATIONS) {
      throw new RangeError(`iterations must be between 1 and ${MAX_BENCHMARK_ITERATIONS}`);
    }
    if (![absoluteTolerance, relativeTolerance].every(value => Number.isFinite(value) && value >= 0)) {
      throw new RangeError("tolerances must be finite non-negative numbers");
    }
    prepareOperation(operation, inputs);
    const ownsBackend = !suppliedBackend;
    const selected = suppliedBackend || await createBackend();
    if (!selected || typeof selected.run !== "function" || typeof selected.kind !== "string") {
      throw new TypeError("backend must be created by createBackend or implement kind and run");
    }
    const cpuSamples = [];
    const computeSamples = [];
    let lastCpuOutput;
    let lastCompute;
    try {
      for (let i = 0; i < warmup; i++) {
        lastCpuOutput = cpuReference(operation, inputs);
        await selected.run(operation, inputs, runOptions);
      }
      for (let i = 0; i < iterations; i++) {
        let start = now();
        lastCpuOutput = cpuReference(operation, inputs);
        cpuSamples.push(Math.max(0, now() - start));
        lastCompute = await selected.run(operation, inputs, runOptions);
        computeSamples.push(lastCompute.timings.totalMs);
      }
      const comparison = compareOutputs(lastCompute.output, lastCpuOutput, absoluteTolerance, relativeTolerance);
      const selectedKind = lastCompute.backend;
      const cpuMedianMs = median(cpuSamples);
      const computeMedianMs = median(computeSamples);
      return {
        kind: selectedKind,
        comparisonAvailable: selectedKind === "webgpu",
        warmup,
        iterations,
        cpu: { medianMs: cpuMedianMs, samplesMs: cpuSamples },
        compute: { backend: selectedKind, medianMs: computeMedianMs, samplesMs: computeSamples },
        correctness: { ...comparison, absoluteTolerance, relativeTolerance },
        speedup: comparison.passed && selectedKind === "webgpu" && computeMedianMs > 0
          ? cpuMedianMs / computeMedianMs
          : null,
      };
    } finally {
      if (ownsBackend) selected.dispose();
    }
  }

  const api = {
    createBackend,
    cpuReference,
    benchmark,
    limits: Object.freeze({ maxBufferBytes: MAX_BUFFER_BYTES, maxTotalBytes: MAX_TOTAL_BYTES, maxMatmulTerms: MAX_MATMUL_TERMS }),
  };
  root.CuvisGPU = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
