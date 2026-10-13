const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const CuvisGPU = require('../web/gpu-backend.js');
const source = fs.readFileSync(require('node:path').join(__dirname, '../web/gpu-worker.js'), 'utf8');
async function execute(data, selectedKind = 'cpu') {
  const messages = [];
  const context = vm.createContext({
    importScripts() {}, Float32Array, performance, navigator:{userAgent:'test'},
    self:{postMessage: message => messages.push(message)},
    CuvisGPU:{async createBackend({forceCPU}) {
      return {kind:forceCPU ? 'cpu' : selectedKind,info:{},dispose(){},async run(operation, inputs) {
        return {output:CuvisGPU.cpuReference(operation, inputs),backend:'cpu'};
      }};
    }},
  });
  vm.runInContext(source, context);
  await context.self.onmessage({data});
  return messages.at(-1);
}
test('worker reports correctness and actual CPU execution rather than adapter availability', async () => {
  const result = await execute({operation:'vectorAdd',size:17,repeats:5}, 'webgpu');
  assert.equal(result.type, 'result');
  assert.equal(result.report.backend, 'cpu');
  assert.equal(result.report.speedup, null);
  assert.equal(result.report.correctness.passed, true);
  assert.equal(result.report.cpu.samplesMs.length, 5);
});
test('worker rejects excessive work before allocating inputs', async () => {
  assert.equal((await execute({operation:'matmul',size:512,repeats:5})).type, 'error');
  assert.equal((await execute({operation:'relu',size:17,repeats:500})).type, 'error');
});
