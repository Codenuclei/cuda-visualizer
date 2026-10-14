// Repeatable Node baseline: interpreted/traced CUDA-subset vector add vs a
// direct JavaScript numeric reference on the same deterministic Float32 inputs.
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

globalThis.self = globalThis;
require('../web/cuda-sim.js');

const BLOCK_SIZE = 128;
const TRACE_LIMIT = 12_000; // Same limit posted by the playground.
const WARMUPS = 2;
const SAMPLES = 5;
const SIZES = [256, 4_096, 16_384];
const KERNEL = `__global__ void vector_add(float *out, const float *a, const float *b, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) {
    out[i] = a[i] + b[i];
  }
}`;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] :
    (sorted[middle - 1] + sorted[middle]) / 2;
}

function makeInputs(length) {
  const a = new Float32Array(length);
  const b = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    a[i] = ((i * 17) % 101 - 50) / 13;
    b[i] = ((i * 29) % 89 - 44) / 11;
  }
  return { a, b };
}

function checkOutput(actual, a, b) {
  assert.equal(actual.length, a.length);
  for (let i = 0; i < actual.length; i++) {
    assert.equal(actual[i], Math.fround(a[i] + b[i]), `mismatch at index ${i}`);
  }
}

function runCase(length) {
  const { a, b } = makeInputs(length);
  const simOutput = new Float32Array(length);
  const cpuOutput = new Float32Array(length);
  const sim = new CudaSim.CudaSim();
  const gridX = Math.ceil(length / BLOCK_SIZE);

  function runSimulator() {
    sim.run({
      source: KERNEL,
      grid: [gridX],
      block: [BLOCK_SIZE],
      buffers: { out: simOutput, a, b },
      scalars: { n: length },
      focusBlock: 0,
      traceLimit: TRACE_LIMIT,
    });
  }

  function runCpuReference() {
    for (let i = 0; i < length; i++) cpuOutput[i] = a[i] + b[i];
  }

  function time(fn, output) {
    const start = performance.now();
    fn();
    const elapsed = performance.now() - start;
    checkOutput(output, a, b);
    return elapsed;
  }

  // Alternate order to reduce systematic first/last-position bias.
  for (let i = 0; i < WARMUPS; i++) {
    if (i % 2 === 0) {
      runSimulator();
      runCpuReference();
    } else {
      runCpuReference();
      runSimulator();
    }
  }
  checkOutput(simOutput, a, b);
  checkOutput(cpuOutput, a, b);

  const simTimes = [];
  const cpuTimes = [];
  for (let i = 0; i < SAMPLES; i++) {
    const first = i % 2 === 0;
    simTimes.push(time(first ? runSimulator : runCpuReference,
      first ? simOutput : cpuOutput));
    cpuTimes.push(time(first ? runCpuReference : runSimulator,
      first ? cpuOutput : simOutput));
  }

  const trace = sim.getTraceMeta();
  return {
    length,
    launchedThreads: gridX * BLOCK_SIZE,
    simMedianMs: median(simTimes),
    cpuMedianMs: median(cpuTimes),
    ratio: median(simTimes) / median(cpuTimes),
    trace,
    globalAccesses: sim.counts.gld + sim.counts.gst,
  };
}

console.log(`Node ${process.version}; ${process.platform}/${process.arch}`);
console.log(`API: CudaSim.run; trace limit ${TRACE_LIMIT}; warmups ${WARMUPS}; samples ${SAMPLES}; sizes ${SIZES.join(', ')}`);
console.log('All outputs checked exactly against the Float32 CPU reference after every timed run.');
console.log('n\tlaunch threads\tinterpreter median ms\tCPU reference median ms\tsim/CPU ratio\ttrace recorded/attempted\tglobal accesses');

for (const length of SIZES) {
  const result = runCase(length);
  console.log([
    result.length,
    result.launchedThreads,
    result.simMedianMs.toFixed(3),
    result.cpuMedianMs.toFixed(3),
    result.ratio.toFixed(1),
    `${result.trace.recorded}/${result.trace.attempted}`,
    result.globalAccesses,
  ].join('\t'));
}
