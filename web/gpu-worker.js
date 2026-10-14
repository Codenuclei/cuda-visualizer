'use strict';
importScripts('gpu-backend.js');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
self.onmessage = async ({data}) => {
  let cpu, selected;
  try {
    const {operation, size, repeats, forceCPU} = data;
    const matrix = operation === 'matmul';
    if (!['matmul', 'vectorAdd', 'relu'].includes(operation) || !Number.isInteger(size) || size < 1 || size > (matrix ? 256 : 1048576) || ![5, 9].includes(repeats)) throw new Error('Invalid or oversized benchmark request.');
    const count = matrix ? size * size : size;
    const a = Float32Array.from({length:count}, (_, i) => ((i % 97) - 48) / 97);
    const b = Float32Array.from({length:count}, (_, i) => ((i % 89) - 44) / 89);
    const inputs = matrix ? {a, b, m:size, k:size, n:size} : operation === 'relu' ? {a} : {a, b};
    cpu = await CuvisGPU.createBackend({forceCPU:true});
    selected = await CuvisGPU.createBackend({forceCPU:!!forceCPU});
    self.postMessage({type:'progress',message:`${selected.kind} selected. Warming up both backends…`});
    for (let i = 0; i < 2; i++) { await cpu.run(operation, inputs); await selected.run(operation, inputs); }
    const timings = {cpu:[], selected:[]};
    const executionBackends = new Set();
    let maxAbsoluteError = 0;
    let passed = true;
    let output;
    const measure = async (backend, key) => {
      const start = performance.now();
      const result = await backend.run(operation, inputs);
      timings[key].push(performance.now() - start);
      if (key === 'selected') executionBackends.add(result.backend);
      return result.output;
    };
    for (let i = 0; i < repeats; i++) {
      self.postMessage({type:'progress',message:`Measuring ${i + 1}/${repeats}; checking every output…`});
      let reference;
      if (i % 2) { output = await measure(selected, 'selected'); reference = await measure(cpu, 'cpu'); }
      else { reference = await measure(cpu, 'cpu'); output = await measure(selected, 'selected'); }
      if (output.length !== reference.length) throw new Error('Output length mismatch.');
      for (let j = 0; j < output.length; j++) {
        const error = Math.abs(output[j] - reference[j]);
        if (!Number.isFinite(output[j]) || error > 1e-4 + 1e-4 * Math.abs(reference[j])) passed = false;
        maxAbsoluteError = Math.max(maxAbsoluteError, error);
      }
    }
    const cpuMs = median(timings.cpu), selectedMs = median(timings.selected);
    const actualBackend = executionBackends.size === 1 ? [...executionBackends][0] : 'mixed';
    const report = {schemaVersion:1, timestamp:new Date().toISOString(), operation,size,repeats,warmups:2,backend:actualBackend,executionBackends:[...executionBackends],adapter:selected.info,userAgent:navigator.userAgent,
      methodology:'Median wall-clock run() latency, validation/allocation/upload/dispatch/readback included. Adapter initialization and warmed pipeline compilation excluded. Alternating backend order. Baseline is a direct JavaScript CPU loop, not BLAS or native CUDA. Browser/software adapter is not proof of physical GPU speed.',
      inputRecipe:'Float32 a[i]=((i%97)-48)/97, b[i]=((i%89)-44)/89; row-major matrices.',
      cpu:{medianMs:cpuMs,samplesMs:timings.cpu},selected:{medianMs:selectedMs,samplesMs:timings.selected},speedup:actualBackend === 'webgpu' && selectedMs > 0 && passed ? cpuMs/selectedMs : null,
      correctness:{passed,elements:output.length,maxAbsoluteError,absoluteTolerance:1e-4,relativeTolerance:1e-4},outputSample:Array.from(output.slice(0,16))};
    self.postMessage({type:'result',report});
  } catch (e) { self.postMessage({type:'error',message:e.message || String(e)}); }
  finally { if (cpu) cpu.dispose(); if (selected) selected.dispose(); }
};
