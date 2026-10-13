const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const catalog = require("../web/library-catalog.js");
const requiredIds = [
  "pytorch-linear", "pytorch-conv1d", "pytorch-attention", "pytorch-layernorm",
  "numpy-matmul", "numpy-softmax", "tfjs-sigmoid", "tfjs-softmax",
];
const simulatorContext = vm.createContext({ console });
simulatorContext.self = simulatorContext;
vm.runInContext(fs.readFileSync(path.join(__dirname, "../web/cuda-sim.js"), "utf8"), simulatorContext, {
  filename: "cuda-sim.js",
});

function loadPack(id) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, `../web/packs/${id}.json`), "utf8"));
}

function cpuReference(pack) {
  const buffers = pack.kernel.buffers;
  switch (pack.id) {
    case "pytorch-linear": {
      const result = [];
      for (let row = 0; row < 2; row++) {
        for (let column = 0; column < 2; column++) {
          let sum = buffers.bias.values[column];
          for (let feature = 0; feature < 3; feature++) {
            sum += buffers.input.values[row * 3 + feature] * buffers.weight.values[column * 3 + feature];
          }
          result.push(Math.max(0, sum));
        }
      }
      return result;
    }
    case "pytorch-conv1d":
      return Array.from({ length: 3 }, (_, position) => {
        let sum = buffers.bias.values[0];
        for (let tap = 0; tap < 3; tap++) sum += buffers.input.values[position + tap] * buffers.weight.values[tap];
        return sum;
      });
    case "pytorch-attention": {
      const query = buffers.query.values;
      const keys = buffers.key.values;
      const values = buffers.value.values;
      const scores = Array.from({ length: 4 }, (_, key) => {
        let dot = 0;
        for (let feature = 0; feature < 4; feature++) dot += query[feature] * keys[key * 4 + feature];
        return dot / Math.sqrt(4);
      });
      const maximum = Math.max(...scores);
      const weights = scores.map(score => Math.exp(score - maximum));
      const denominator = weights.reduce((sum, weight) => sum + weight, 0);
      for (let key = 0; key < weights.length; key++) weights[key] /= denominator;
      return Array.from({ length: 4 }, (_, feature) =>
        weights.reduce((sum, weight, key) => sum + weight * values[key * 4 + feature], 0));
    }
    case "pytorch-layernorm": {
      const result = [];
      for (let row = 0; row < 2; row++) {
        const values = buffers.input.values.slice(row * 4, row * 4 + 4);
        const mean = values.reduce((sum, value) => sum + value, 0) / 4;
        const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 4;
        for (let column = 0; column < 4; column++) {
          const normalized = (values[column] - mean) / Math.sqrt(variance + 1e-5);
          result.push(normalized * buffers.gamma.values[column] + buffers.beta.values[column]);
        }
      }
      return result;
    }
    case "numpy-matmul": {
      const result = [];
      for (let row = 0; row < 2; row++) {
        for (let column = 0; column < 2; column++) {
          let sum = 0;
          for (let shared = 0; shared < 3; shared++) {
            sum += buffers.left.values[row * 3 + shared] * buffers.right.values[shared * 2 + column];
          }
          result.push(sum);
        }
      }
      return result;
    }
    case "numpy-softmax":
    case "tfjs-softmax": {
      const logits = pack.id === "numpy-softmax" ? buffers.input.values : buffers.logits.values;
      const maximum = Math.max(...logits);
      const exponentials = logits.map(value => Math.exp(value - maximum));
      const denominator = exponentials.reduce((sum, value) => sum + value, 0);
      return exponentials.map(value => value / denominator);
    }
    case "tfjs-sigmoid":
      return buffers.input.values.map(value => 1 / (1 + Math.exp(-value)));
    default:
      assert.fail(`Missing CPU reference for ${pack.id}`);
  }
}

function assertClose(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: output size`);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Number.isFinite(actual[i]), `${label}[${i}] is finite`);
    assert.ok(Math.abs(actual[i] - expected[i]) <= 2e-5 * Math.max(1, Math.abs(expected[i])),
      `${label}[${i}]: expected ${expected[i]}, received ${actual[i]}`);
  }
}

test("catalog is available in browser and CommonJS with eight pinned operations", () => {
  assert.equal(globalThis.LibraryCatalog, catalog);
  const browser = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../web/library-catalog.js"), "utf8"), browser);
  assert.equal(browser.LibraryCatalog.operations.length, 8);
  assert.deepEqual(catalog.operations.map(operation => operation.id), requiredIds);
  assert.deepEqual(catalog.libraries.map(library => [library.id, library.version]), [
    ["pytorch", "2.5.1"], ["numpy", "2.1.3"], ["tensorflowjs", "4.22.0"],
  ]);
  for (const operation of catalog.operations) {
    assert.ok(catalog.libraries.some(library => library.id === operation.library), `${operation.id} library exists`);
    assert.equal(operation.pack, `packs/${operation.id}.json`);
    assert.ok(operation.api && operation.title && operation.tags.length > 0);
  }
});

test("all packs follow the fixed schema and stage line references are valid", () => {
  const keys = ["schemaVersion", "id", "library", "version", "language", "title", "api", "summary", "formula",
    "example", "limitations", "tensors", "stages", "kernel", "upstream", "docsUrl"];
  assert.equal(requiredIds.length, 8);
  for (const id of requiredIds) {
    const pack = loadPack(id);
    assert.deepEqual(Object.keys(pack).sort(), [...keys].sort(), `${id}: top-level schema`);
    assert.equal(pack.schemaVersion, 1);
    assert.equal(pack.id, id);
    assert.ok(pack.summary.length > 40 && pack.formula.length > 3);
    assert.ok(pack.limitations.length >= 2);
    assert.ok(pack.tensors.length >= 2);
    const sourceLineCount = pack.example.split("\n").length;
    const cudaLineCount = pack.kernel.code.split("\n").length;
    assert.ok(pack.stages.length >= 1);
    for (const stage of pack.stages) {
      assert.ok(stage.id && stage.title && stage.summary && stage.formula && stage.insight);
      assert.ok(stage.sourceLines.length > 0 && stage.cudaLines.length > 0);
      for (const line of stage.sourceLines) assert.ok(line >= 1 && line <= sourceLineCount, `${id}: source line ${line}`);
      for (const line of stage.cudaLines) assert.ok(line >= 1 && line <= cudaLineCount, `${id}: CUDA line ${line}`);
    }
    const upstream = pack.upstream;
    assert.match(upstream.url, /^https:\/\/cdn\.jsdelivr\.net\/gh\//);
    assert.ok(upstream.url.includes(`@${upstream.revision}/`));
    assert.ok(upstream.url.endsWith(`/${upstream.path}`));
    assert.equal(upstream.revision, pack.version === "4.22.0" ? "tfjs-v4.22.0" : `v${pack.version}`);
    assert.match(upstream.license, /^(BSD-3-Clause|Apache-2\.0)$/);
    assert.match(upstream.licenseUrl, /^https:\/\/cdn\.jsdelivr\.net\/gh\//);
    assert.match(pack.docsUrl, /^https:\/\//);
    assert.ok(upstream.symbol.length > 2);
    assert.ok(pack.kernel.name && pack.kernel.n > 0 && pack.kernel.sharedBytes === 0);
    assert.deepEqual(pack.kernel.grid.length, 2);
    assert.deepEqual(pack.kernel.block.length, 2);
    assert.ok(pack.kernel.expected.length > 0);
    assert.ok(pack.kernel.buffers[pack.kernel.outputBuffer], `${id}: output buffer exists`);
    for (const [name, buffer] of Object.entries(pack.kernel.buffers)) {
      assert.ok(["float32", "int32"].includes(buffer.dtype), `${id}.${name}: dtype`);
      assert.ok(buffer.values.every(Number.isFinite), `${id}.${name}: finite fixture`);
    }
    assert.equal(pack.library, catalog.operations.find(operation => operation.id === id).library);
    assert.equal(pack.language, catalog.operations.find(operation => operation.id === id).language);
  }
});

for (const id of requiredIds) {
  test(`${id} runs in cuda-sim and matches an independent CPU reference`, () => {
    const pack = loadPack(id);
    const buffers = Object.fromEntries(Object.entries(pack.kernel.buffers).map(([name, buffer]) => [
      name,
      buffer.dtype === "float32" ? new Float32Array(buffer.values) : new Int32Array(buffer.values),
    ]));
    const expected = cpuReference(pack);
    assertClose(pack.kernel.expected, expected, `${id} CPU fixture reference`);
    const result = new simulatorContext.CudaSim.CudaSim().run({
      source: pack.kernel.code,
      grid: pack.kernel.grid,
      block: pack.kernel.block,
      buffers,
      scalars: { n: pack.kernel.n },
    });
    assert.equal(result.deadlock, false, `${id} completes without deadlock`);
    assertClose(buffers[pack.kernel.outputBuffer], expected, `${id} simulator output`);
    if (id === "pytorch-attention") {
      assertClose(buffers.scores, [0.5, 0, 0.5, -0.5], "attention scaled scores");
      assertClose(buffers.weights, expected, "attention weights");
      assert.ok(Math.abs(buffers.weights.reduce((sum, weight) => sum + weight, 0) - 1) < 1e-6);
    }
    if (id === "numpy-softmax" || id === "tfjs-softmax") {
      assert.ok(Math.abs(buffers[pack.kernel.outputBuffer].reduce((sum, value) => sum + value, 0) - 1) < 1e-6,
        `${id} probabilities sum to one`);
    }
  });
}
