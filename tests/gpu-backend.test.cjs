const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const gpu = require("../web/gpu-backend.js");
const source = fs.readFileSync(path.join(__dirname, "../web/gpu-backend.js"), "utf8");

function mockWebGPU({ limits = {}, submitError, shaderError, fallbackAdapter, adapterInfo, lost } = {}) {
  const state = { shaders: [], pipelines: [], buffers: 0, destroyed: 0 };
  const device = {
    limits: {
      maxBufferSize: 1 << 20,
      maxStorageBufferBindingSize: 1 << 20,
      maxComputeWorkgroupsPerDimension: 65535,
      ...limits,
    },
    lost: lost || new Promise(() => {}),
    queue: {
      writeBuffer() {},
      submit() { if (submitError) throw new Error(submitError); },
    },
    createShaderModule({ code }) {
      state.shaders.push(code);
      if (shaderError) throw new Error(shaderError);
      return { code };
    },
    async createComputePipelineAsync(descriptor) {
      state.pipelines.push(descriptor);
      return { getBindGroupLayout() { return {}; } };
    },
    createBuffer() { state.buffers++; return { destroy() {} }; },
    createBindGroup() { return {}; },
    createCommandEncoder() {
      return {
        beginComputePass() { return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }; },
        copyBufferToBuffer() {},
        finish() { return {}; },
      };
    },
    addEventListener() {},
    destroy() { state.destroyed++; },
  };
  const adapter = {
    isFallbackAdapter: fallbackAdapter,
    async requestDevice() { return device; },
    async requestAdapterInfo() { return adapterInfo || {}; },
  };
  const context = vm.createContext({
    navigator: { gpu: { async requestAdapter() { return adapter; } } },
    GPUBufferUsage: { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 },
    GPUMapMode: { READ: 1 },
  });
  vm.runInContext(source, context, { filename: "gpu-backend.js" });
  return { createBackend: context.CuvisGPU.createBackend, state, device };
}

function assertClose(actual, expected, tolerance = 1e-5) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance * Math.max(1, Math.abs(expected[i])),
      `output[${i}]: expected ${expected[i]}, got ${actual[i]}`);
  }
}

test("exports the same API in CommonJS and browser globals", () => {
  const browser = vm.createContext({});
  vm.runInContext(source, browser, { filename: "gpu-backend.js" });
  assert.equal(typeof browser.CuvisGPU.createBackend, "function");
  assert.equal(typeof gpu.createBackend, "function");
  assert.equal(typeof gpu.cpuReference, "function");
  assert.equal(typeof gpu.benchmark, "function");
});

test("CPU backend computes vector add and reports bounded end-to-end timing", async () => {
  const backend = await gpu.createBackend({ forceCPU: true });
  assert.equal(backend.kind, "cpu");
  const result = await backend.run("vectorAdd", { a: [1, -2.5, 0], b: [2, 0.5, 9] });
  assert.deepEqual(result.output, new Float32Array([3, -2, 9]));
  assert.equal(result.backend, "cpu");
  assert.ok(Number.isFinite(result.timings.totalMs) && result.timings.totalMs >= 0);
  assert.deepEqual(gpu.cpuReference("vectorAdd", { a: [], b: [] }), new Float32Array());
  backend.dispose();
});

test("CPU reference computes non-square row-major matmul and ReLU", async () => {
  const backend = await gpu.createBackend({ forceCPU: true });
  const product = await backend.run("matmul", {
    a: [1, 2, 3, 4, 5, 6], b: [7, 8, 9, 10, 11, 12], m: 2, k: 3, n: 2,
  });
  assertClose(product.output, [58, 64, 139, 154]);
  const relu = await backend.run("relu", { a: [-3, -0, 1.25, 8] });
  assert.deepEqual(relu.output, new Float32Array([0, 0, 1.25, 8]));
  backend.dispose();
});

test("falls back cleanly when the browser has no WebGPU adapter", async () => {
  const context = vm.createContext({ navigator: { gpu: { requestAdapter: async () => null } } });
  vm.runInContext(source, context);
  const backend = await context.CuvisGPU.createBackend();
  assert.equal(backend.kind, "cpu");
  assert.match(backend.info.reason, /adapter/i);
  const result = await backend.run("relu", { a: [-1, 2] });
  assert.deepEqual(Array.from(result.output), [0, 2]);
  backend.dispose();
});

test("reports exposed fallback/software adapter metadata without claiming physical GPU", async () => {
  const mock = mockWebGPU({
    fallbackAdapter: true,
    adapterInfo: { vendor: "Google", description: "SwiftShader software renderer" },
  });
  const backend = await mock.createBackend();
  assert.equal(backend.kind, "webgpu");
  assert.deepEqual({ ...backend.info.adapter }, {
    vendor: "Google", description: "SwiftShader software renderer", fallback: true, software: true,
  });
  assert.equal(backend.info.physicalGpu, "unknown");
  assert.equal(mock.state.shaders.length, 3);
  assert.ok(mock.state.shaders.every(shader => /@compute\s+@workgroup_size/.test(shader)));
  assert.ok(mock.state.pipelines.every(pipeline => pipeline.compute && !pipeline.com));
  backend.dispose();
});

test("respects adapter binding limits and falls back per operation", async () => {
  const mock = mockWebGPU({ limits: { maxStorageBufferBindingSize: 4 } });
  const backend = await mock.createBackend();
  const result = await backend.run("vectorAdd", { a: [1, 2], b: [3, 4] });
  assert.equal(result.backend, "cpu");
  assert.deepEqual(Array.from(result.output), [4, 6]);
  assert.equal(mock.state.buffers, 0);
  assert.equal(backend.kind, "webgpu");
  backend.dispose();
});

test("device loss and GPU submission errors safely switch execution to CPU", async () => {
  let loseDevice;
  const loss = new Promise(resolve => { loseDevice = resolve; });
  const lostMock = mockWebGPU({ lost: loss });
  const lostBackend = await lostMock.createBackend();
  loseDevice({ message: "simulated reset" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lostBackend.kind, "cpu");
  assert.match(lostBackend.info.reason, /device lost.*simulated reset/i);
  lostBackend.dispose();

  const errorMock = mockWebGPU({ submitError: "simulated submit failure" });
  const errorBackend = await errorMock.createBackend();
  const result = await errorBackend.run("vectorAdd", { a: [2, 4], b: [5, 7] });
  assert.equal(result.backend, "cpu");
  assert.deepEqual(Array.from(result.output), [7, 11]);
  assert.match(errorBackend.info.reason, /simulated submit failure/);
  assert.equal(errorMock.state.destroyed, 1);
  errorBackend.dispose();
});

test("pipeline initialization errors leave a usable CPU backend", async () => {
  const mock = mockWebGPU({ shaderError: "simulated shader compilation failure" });
  const backend = await mock.createBackend();
  assert.equal(backend.kind, "cpu");
  assert.match(backend.info.reason, /initialization failed.*shader compilation/i);
  const result = await backend.run("relu", { a: [-4, 3] });
  assert.deepEqual(Array.from(result.output), [0, 3]);
  backend.dispose();
});

test("validates operations, dimensions, finite float32 values, and work limits", async () => {
  const backend = await gpu.createBackend({ forceCPU: true });
  await assert.rejects(backend.run("unknown", {}), /Unsupported operation/);
  await assert.rejects(backend.run("vectorAdd", { a: [1], b: [] }), /equal lengths/);
  await assert.rejects(backend.run("vectorAdd", { a: [Infinity], b: [1] }), /finite number/);
  await assert.rejects(backend.run("vectorAdd", { a: [1e100], b: [1] }), /float32 range/);
  await assert.rejects(backend.run("matmul", { a: [], b: [], m: 0, k: 1, n: 1 }), /positive 32-bit/);
  await assert.rejects(backend.run("matmul", { a: [], b: [], m: 1000, k: 1000, n: 1000 }), /work limit/);
  const oversized = { length: 5_000_000 };
  await assert.rejects(backend.run("vectorAdd", { a: oversized, b: oversized }), /aggregate limit/);
  await assert.rejects(backend.run("vectorAdd", { a: [3e38], b: [3e38] }), /non-finite/);
  backend.dispose();
  await assert.rejects(backend.run("relu", { a: [1] }), /disposed/);
});

test("benchmark warms both paths, reports medians and checks correctness without speed claims on CPU", async () => {
  const backend = await gpu.createBackend({ forceCPU: true });
  const result = await gpu.benchmark("matmul", {
    a: [1, 2, 3, 4], b: [5, 6, 7, 8], m: 2, k: 2, n: 2,
  }, { backend, warmup: 1, iterations: 3 });
  assert.equal(result.kind, "cpu");
  assert.equal(result.comparisonAvailable, false);
  assert.equal(result.correctness.passed, true);
  assert.equal(result.speedup, null);
  assert.equal(result.cpu.samplesMs.length, 3);
  assert.equal(result.compute.samplesMs.length, 3);
  assert.ok(Number.isFinite(result.cpu.medianMs));
  backend.dispose();
});

test("benchmark withholds speedup on incorrect GPU output and reports full maximum error", async () => {
  const result = await gpu.benchmark("vectorAdd", { a: [3, -2], b: [4, 5] }, {
    backend: {
      kind: "webgpu",
      async run() {
        return { output: new Float32Array([0, 0]), timings: { totalMs: 1 }, backend: "webgpu" };
      },
    },
    warmup: 0,
    iterations: 1,
  });
  assert.equal(result.correctness.passed, false);
  assert.equal(result.correctness.maxAbsError, 7);
  assert.equal(result.speedup, null);
});

test("benchmark rejects non-finite output as incorrect", async () => {
  const result = await gpu.benchmark("vectorAdd", { a: [3], b: [4] }, {
    backend: {
      kind: "webgpu",
      async run() {
        return { output: new Float32Array([NaN]), timings: { totalMs: 1 }, backend: "webgpu" };
      },
    },
    warmup: 0,
    iterations: 1,
  });
  assert.equal(result.correctness.passed, false);
  assert.equal(result.correctness.maxAbsError, Infinity);
  assert.equal(result.speedup, null);
});
