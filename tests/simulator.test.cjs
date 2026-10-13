'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

global.self = global;
require('../web/cuda-sim.js');
const CudaSimApi = self.CudaSim;
const { CudaSim, analyzeCoalescing, analyzeBankConflicts } = CudaSimApi;

function run(source, { block = 4, grid = 1, buffers = {}, scalars = {}, ...rest } = {}) {
  return new CudaSim().run({ source, grid: [grid], block: [block], buffers, scalars, ...rest });
}

test('vector arithmetic trace keeps original CUDA lines, branch outcomes, and values', () => {
  const source = `// comment before the kernel

__global__ void vectorAdd(float *out, const float *a, const float *b, int n) {
  int i = threadIdx.x;
  if (i < n) {
    out[i] = sqrtf(a[i] * a[i]) + b[i];
  }
}`;
  const out = new Float32Array(3);
  const result = run(source, { block: 3, buffers: {
    out, a: new Float32Array([3, 4, 5]), b: new Float32Array([1, 2, 3]),
  }, scalars: { n: 2 } });

  assert.deepEqual([...out], [4, 6, 0]);
  assert.deepEqual(result.executionTrace.filter(e => e.kind === 'statement' && e.line === 4)
    .map(e => e.details.statement), ['int i = threadIdx.x', 'int i = threadIdx.x', 'int i = threadIdx.x']);
  assert.deepEqual(result.executionTrace.filter(e => e.kind === 'branch').map(e => e.details.outcome), [true, true, false]);
  const writes = result.executionTrace.filter(e => e.kind === 'memory' && e.details.operation === 'write');
  assert.deepEqual(writes.map(e => [e.line, e.threadId, e.details.value]), [[6, 0, 4], [6, 1, 6]]);
  assert.ok(result.executionTrace.every(e => Number.isInteger(e.line) && e.line >= 1));
  assert.deepEqual(result.executionTrace.map(e => e.sequence), result.executionTrace.map((_, i) => i));
  assert.deepEqual(result.executionTrace[0].block, { x: 0, y: 0, z: 0 });
  assert.deepEqual(result.executionTrace[0].thread, { x: 0, y: 0, z: 0 });
  assert.equal(result.executionTrace[0].warp, 0);
  assert.equal(typeof result.executionTrace[0].source, 'string');
  assert.equal(result.executionTrace[0].values.statement, 'int i = threadIdx.x');
  assert.doesNotThrow(() => JSON.stringify(result.executionTrace));
  assert.equal(result.traceMeta.truncated, false);
  assert.equal(result.trace.length, 8);
  assert.equal(result.accessTrace.length, result.trace.length);
  assert.equal(analyzeCoalescing(result.trace).requests.length, 4);
  assert.equal(analyzeBankConflicts(result.trace).total, 0);
});

test('MLP-style loop traces math, loop decisions, and output stores', () => {
  const source = `__global__ void mlp(float *out, const float *input, const float *weights, int n) {
  int row = threadIdx.x;
  float sum = 0.0f;
  for (int k = 0; k < n; k++) {
    sum += input[k] * weights[row * n + k];
  }
  out[row] = 1.0f / (1.0f + expf(-sum));
}`;
  const out = new Float32Array(2);
  const result = run(source, { block: 2, buffers: {
    out, input: new Float32Array([1, 2]), weights: new Float32Array([1, 0, 0, 1]),
  }, scalars: { n: 2 } });

  assert.ok(Math.abs(out[0] - 0.7310586) < 1e-6);
  assert.ok(Math.abs(out[1] - 0.8807971) < 1e-6);
  assert.equal(result.executionTrace.filter(e => e.kind === 'loop' && e.details.outcome).length, 4);
  assert.equal(result.executionTrace.filter(e => e.kind === 'loop' && !e.details.outcome).length, 2);
  assert.ok(result.executionTrace.some(e => e.kind === 'math' && e.line === 7 && e.details.statement.includes('expf')));
});

test('CNN-style shared tile traces each barrier and coalescible shared/global access', () => {
  const source = `__global__ void conv(float *out, const float *input, const float *filter) {
  __shared__ float tile[4];
  int x = threadIdx.x;
  tile[x] = input[x];
  __syncthreads();
  float sum = 0.0f;
  for (int k = 0; k < 2; k++) {
    sum += tile[(x + k) % 4] * filter[k];
  }
  out[x] = sum;
}`;
  const out = new Float32Array(4);
  const result = run(source, { buffers: {
    out, input: new Float32Array([1, 2, 3, 4]), filter: new Float32Array([2, 1]),
  } });

  assert.deepEqual([...out], [4, 7, 10, 9]);
  assert.equal(result.deadlock, false);
  assert.equal(result.executionTrace.filter(e => e.kind === 'barrier' && e.line === 5).length, 4);
  assert.ok(result.executionTrace.some(e => e.kind === 'memory' && e.details.space === 'shared'));
  assert.ok(result.executionTrace.some(e => e.kind === 'memory' && e.details.buffer === 'input'));
  assert.ok(result.executionTrace.some(e => e.kind === 'memory' && e.details.buffer === 'filter'));
});

test('LM-head-style matrix-vector loop and output scores are traced', () => {
  const source = `__global__ void lmHead(float *scores, const float *hidden, const float *weights, int vocab, int width) {
  int token = threadIdx.x;
  float score = 0.0f;
  for (int j = 0; j < width; j++) {
    score += hidden[j] * weights[token * width + j];
  }
  scores[token] = score;
}`;
  const scores = new Float32Array(2);
  const result = run(source, { block: 2, buffers: {
    scores, hidden: new Float32Array([1, 2, 3]),
    weights: new Float32Array([1, 0, 1, 0, 1, 1]),
  }, scalars: { vocab: 2, width: 3 } });

  assert.deepEqual([...scores], [4, 5]);
  assert.ok(result.executionTrace.some(e => e.kind === 'loop' && e.line === 4));
  assert.ok(result.executionTrace.some(e => e.kind === 'memory' && e.line === 7 && e.details.operation === 'write'));
});

test('barriers complete normally and divergent barriers report possible deadlock', () => {
  const shared = `__global__ void copy(float *out) {
  __shared__ float tile[4];
  tile[threadIdx.x] = threadIdx.x;
  __syncthreads();
  out[threadIdx.x] = tile[threadIdx.x];
}`;
  const ok = run(shared, { buffers: { out: new Float32Array(4) } });
  assert.equal(ok.deadlock, false);
  assert.equal(ok.counts.syncs, 4);

  const divergent = `__global__ void bad(float *out) {
  if (threadIdx.x == 0) {
    __syncthreads();
  }
  out[threadIdx.x] = threadIdx.x;
}`;
  const bad = run(divergent, { buffers: { out: new Float32Array(4) } });
  assert.equal(bad.deadlock, true);
  assert.ok(bad.executionTrace.some(e => e.kind === 'deadlock' && e.line === 3));
});

test('runtime errors preserve a source-linked error event', () => {
  const sim = new CudaSim();
  assert.throws(() => sim.run({
    source: `__global__ void oob(float *out) {\n  out[4] = 1.0f;\n}`,
    grid: [1], block: [1], buffers: { out: new Float32Array(1) }, scalars: {},
  }), /out-of-bounds write/);
  assert.equal(sim.executionTrace.at(-1).kind, 'error');
  assert.equal(sim.executionTrace.at(-1).line, 2);
});

test('trace limit is bounded and reports exact truncation', () => {
  const result = run(`__global__ void k(float *out) {
  int i = threadIdx.x;
  out[i] = i + 1;
}`, { block: 4, buffers: { out: new Float32Array(4) }, traceLimit: 3 });
  assert.equal(result.executionTrace.length, 3);
  assert.equal(result.traceMeta.recorded, 3);
  assert.equal(result.traceMeta.limit, 3);
  assert.ok(result.traceMeta.attempted > 3);
  assert.equal(result.traceMeta.dropped, result.traceMeta.attempted - 3);
  assert.equal(result.traceMeta.truncated, true);
});

test('unsupported JavaScript globals, member access, and injected parameters are rejected', () => {
  assert.throws(() => run(`__global__ void escape(int n) {
  globalThis.process.exit(0);
}`, { block: 1 }), /Unsupported CUDA identifier globalThis/);
  assert.throws(() => run(`__global__ void escape(int *p) {
  p.constructor.constructor("return process")();
}`, { block: 1, buffers: { p: new Int32Array(1) } }), /Only .x, .y, and .z|Unsupported CUDA identifier|String literals are supported only/);
  assert.throws(() => run(`__global__ void escape(float *p, int key) {
  p[key][key](1)();
}`, { block: 1, buffers: { p: new Float32Array(1) }, scalars: { key: 'constructor' } }),
  /scalar for parameter key must be a number/);
  assert.throws(() => run(`__global__ void escape(float *p, int key) {
  p[key][key](1)();
}`, { block: 1, buffers: { p: new Float32Array([1]) }, scalars: { key: 0 } }), /not a function/);
  assert.throws(() => run(`__global__ void escape(float *out, float constructor, float sourceCode) {
  out[0] = constructor(sourceCode)();
}`, { block: 1, buffers: { out: new Float32Array(1) },
  scalars: { constructor: Object, sourceCode: 'return 1' } }), /scalar for parameter constructor must be a number/);
  assert.throws(() => parseKernelForTest(`__global__ void escape(int n=0) {}`), /Unsupported kernel parameter declaration/);
});

function parseKernelForTest(source) {
  return new CudaSim().run({ source, grid: [1], block: [1], buffers: {}, scalars: {} });
}

test('worker returns execution trace but keeps existing analyses on access records', () => {
  const messages = [];
  const context = {
    self: { CudaSim: CudaSimApi },
    importScripts() {},
    postMessage(message) { messages.push(message); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/sim-worker.js'), 'utf8'), context);
  context.onmessage({ data: {
    source: `__global__ void add(float *out, const float *a) {\n  out[threadIdx.x] = a[threadIdx.x] + 1.0f;\n}`,
    grid: [1], block: [2], buffers: { out: new Float32Array(2), a: new Float32Array([2, 3]) },
    scalars: {}, focusBlock: 0,
  } });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ok, true);
  assert.ok(messages[0].executionTrace.some(e => e.kind === 'memory'));
  assert.ok(Array.isArray(messages[0].executionTrace));
  assert.equal(messages[0].traceMeta.truncated, false);
  assert.equal(messages[0].coalescing.requests.length, 2);
  assert.equal(messages[0].buffers.out[1], 4);
  context.onmessage({ data: {
    source: `__global__ void oob(float *out) {\n  out[4] = 1.0f;\n}`,
    grid: [1], block: [1], buffers: { out: new Float32Array(1) }, scalars: {}, focusBlock: 0,
  } });
  assert.equal(messages[1].ok, false);
  assert.equal(messages[1].executionTrace.at(-1).kind, 'error');
  assert.equal(messages[1].traceMeta.truncated, false);
});
