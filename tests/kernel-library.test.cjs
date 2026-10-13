const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const library = require("../web/kernel-library.js");
const simulatorSource = fs.readFileSync(path.join(__dirname, "../web/cuda-sim.js"), "utf8");
const simulatorContext = vm.createContext({ console });
simulatorContext.self = simulatorContext;
vm.runInContext(simulatorSource, simulatorContext, { filename: "cuda-sim.js" });

function execute(preset, buffers) {
  return new simulatorContext.CudaSim.CudaSim().run({
    source: preset.code,
    grid: preset.grid,
    block: preset.block,
    buffers,
    scalars: {},
  });
}

function assertClose(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: output length`);
  for (let i = 0; i < actual.length; i++) {
    const tolerance = 1e-5 * Math.max(1, Math.abs(expected[i]));
    assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance,
      `${label}[${i}]: expected ${expected[i]}, got ${actual[i]}`);
  }
}

test("library exposes the complete preset schema through CommonJS", () => {
  assert.equal(globalThis.KernelLibrary, library);
  const browserContext = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../web/kernel-library.js"), "utf8"), browserContext);
  assert.equal(browserContext.KernelLibrary.length, library.length);
  assert.equal(library.length, 8);
  assert.equal(new Set(library.map(preset => preset.id)).size, library.length);
  for (const preset of library) {
    for (const key of ["id", "title", "shortName", "category", "description", "filename", "code", "grid", "block", "n", "sharedBytes", "buffers", "outputBuffer", "concepts", "stages", "expected"]) {
      assert.ok(key in preset, `${preset.id} is missing ${key}`);
    }
    assert.equal(typeof preset.buffers, "function", `${preset.id} buffer factory`);
    assert.equal(typeof preset.expected, "function", `${preset.id} reference`);
    assert.ok(preset.concepts.every(item => item.label && item.detail), `${preset.id} concepts`);
    assert.ok(preset.stages.every(item => item.label && item.detail), `${preset.id} stages`);
  }
});

for (const preset of library) {
  test(`${preset.id} executes in cuda-sim and matches its CPU reference`, () => {
    const buffers = preset.buffers(preset.n);
    const expected = preset.expected(buffers, preset.n);
    const result = execute(preset, buffers);
    assert.equal(result.deadlock, false, `${preset.id} must not deadlock`);
    assert.ok(buffers[preset.outputBuffer], `${preset.id} output buffer exists`);
    assertClose(buffers[preset.outputBuffer], expected, preset.id);
  });
}
