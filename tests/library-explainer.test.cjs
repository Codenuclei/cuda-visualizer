const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const LibraryExplainer = require("../web/library-explainer.js");
const LibraryCatalog = require("../web/library-catalog.js");

const pack = {
  schemaVersion: 1,
  id: "tiny-mlp",
  library: "PyTorch",
  version: "2.x",
  language: "python",
  title: "Linear layer followed by ReLU",
  api: "nn.Linear",
  summary: "Maps each input row to a new feature space.\nThe next stage gates negative values.",
  formula: "relu(XW + b)",
  example: "nn.Linear(3, 2)",
  limitations: ["Small educational input only."],
  tensors: [
    { name: "input", shape: [2, 3], role: "input", description: "Feature rows." },
    { name: "weights", shape: [3, 2], role: "weight", description: "Learned projection." },
    { name: "output", shape: [2, 2], role: "output", description: "Activated values." },
  ],
  stages: [
    { id: "linear", title: "Linear projection", summary: "Multiply the input by weights.\nAdd the bias.", sourceLines: [4], cudaLines: [12, 13], formula: "XW + b", insight: "Each row is independent." },
    { id: "relu", title: "ReLU", summary: "Clamp values below zero.", sourceLines: [5], cudaLines: [14], formula: "max(0, x)", insight: "Nonlinear activation." },
  ],
  kernel: { name: "tiny", code: "", grid: [1, 1], block: [2, 1], n: 2, sharedBytes: 0, buffers: {}, outputBuffer: "output", expected: [0, 1] },
  upstream: { url: "https://example.test/source", repository: "org/repo", path: "nn.py", revision: "abc123", license: "MIT", licenseUrl: "https://example.test/license", symbol: "Linear" },
  docsUrl: "https://example.test/docs",
};

test("exports its API for CommonJS and the browser global", () => {
  assert.deepEqual(Object.keys(LibraryExplainer).sort(), ["classifyEvent", "extractSource", "matchSnippet", "summarize", "tensorStats"].sort());
  assert.equal(globalThis.LibraryExplainer, LibraryExplainer);
  const browser = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve("../web/library-explainer.js"), "utf8"), browser);
  assert.equal(typeof browser.LibraryExplainer.summarize, "function");
  assert.equal(typeof browser.LibraryExplainer.matchSnippet, "function");
});

test("summarizes the whole multi-stage operation and keeps line mappings", () => {
  const summary = LibraryExplainer.summarize(pack);
  assert.equal(summary.headline, pack.title);
  assert.match(summary.overview, /Linear projection → ReLU/);
  assert.match(summary.overview, /authored operation/);
  assert.match(summary.overview, /Maps each input row[\s\S]*gates negative values/);
  assert.equal(summary.shapeSummary.split("\n").length, 3);
  assert.equal(summary.steps.length, 2);
  assert.equal(summary.steps[0].summary, "Multiply the input by weights.\nAdd the bias.");
  assert.deepEqual(summary.steps[0].sourceLines, [4]);
  assert.deepEqual(summary.steps[0].cudaLines, [12, 13]);
  assert.deepEqual(summary.limitations, pack.limitations);
  assert.match(summary.provenance, /org\/repo\/nn\.py at abc123/);
  assert.match(summary.provenance, /https:\/\/example\.test\/license/);
  assert.match(summary.provenance, /https:\/\/example\.test\/docs/);
  assert.match(summary.provenance, /does not fetch or independently verify/);
  assert.deepEqual(summary.observations, ["No run result was supplied; this describes the authored pack, not observed execution."]);
});

test("reports only finite checks for completed outputs and separates trace truncation", () => {
  const summary = LibraryExplainer.summarize(pack, {
    ok: true,
    deadlock: false,
    traceMeta: { truncated: true },
    counts: { gld: 10 },
    launch: { grid: [1, 1] },
    executionTrace: [],
    buffers: { output: [1, NaN, Infinity, -2] },
  });
  assert.match(summary.observations[0], /successful completion/);
  assert.match(summary.observations[1], /trace is truncated/);
  assert.match(summary.observations[2], /2 of 4 inspected values are finite/);
  assert.equal(summary.observations.some((line) => /speed|performance|expected values/.test(line)), false);
});

test("reports deadlocks and failed runs as partial without treating them as complete", () => {
  const deadlock = LibraryExplainer.summarize(pack, { ok: true, deadlock: true, buffers: { output: [1] } });
  assert.match(deadlock.observations[0], /deadlock was reported; this run is partial/);
  assert.doesNotMatch(deadlock.observations[0], /successful completion/);
  const failure = LibraryExplainer.summarize(pack, { ok: false, error: "unsupported syntax", buffers: { output: [NaN] } });
  assert.match(failure.observations[0], /failed run: unsupported syntax/);
  assert.match(failure.observations[1], /0 of 1 inspected values are finite/);
});

test("tensorStats bounds work and excludes non-finite values from aggregates", () => {
  assert.deepEqual(LibraryExplainer.tensorStats([1, NaN, 3, Infinity]), {
    count: 4, min: 1, max: 3, mean: 2, sum: 4, finiteCount: 2,
  });
  assert.deepEqual(LibraryExplainer.tensorStats([NaN, -Infinity]), {
    count: 2, min: null, max: null, mean: null, sum: 0, finiteCount: 0,
  });
  assert.equal(LibraryExplainer.tensorStats(new Float32Array([1, 2])).sum, 3);
  assert.equal(LibraryExplainer.tensorStats(new Array(100001).fill(1)).count, 100000);
  assert.equal(LibraryExplainer.tensorStats(null).count, 0);
});

test("classifies events only against explicit CUDA source line mappings", () => {
  assert.equal(LibraryExplainer.classifyEvent(pack, { line: 13 }), pack.stages[0]);
  assert.equal(LibraryExplainer.classifyEvent(pack, { line: 14 }), pack.stages[1]);
  assert.equal(LibraryExplainer.classifyEvent(pack, { line: 99 }), null);
  assert.equal(LibraryExplainer.classifyEvent(pack, { line: "14" }), null);
});

test("extracts a bounded literal-symbol window with normalized line endings", () => {
  const source = ["header", "unrelated", "function Linear(x) {", "  return x", "}", "trailer"].join("\r\n");
  const excerpt = LibraryExplainer.extractSource(source, pack.upstream, { maxLines: 3 });
  assert.deepEqual(excerpt, {
    text: "unrelated\nfunction Linear(x) {\n  return x",
    startLine: 2,
    endLine: 4,
    matched: true,
    symbol: "Linear",
  });
  assert.deepEqual(LibraryExplainer.extractSource("const x = 1;", pack.upstream), {
    text: "", startLine: null, endLine: null, matched: false, symbol: "Linear",
  });
  assert.equal(LibraryExplainer.extractSource("Linear", { symbol: "Linear" }, { maxLines: 1000 }).endLine, 1);
});

test("suggests only exact known API catalog entries and ignores comments and strings", () => {
  const catalog = [
    { id: "linear-pack", api: "nn.Linear" },
    { id: "conv-pack", api: "nn.Conv1d" },
    { id: "attention-pack", api: "scaled_dot_product_attention" },
  ];
  const result = LibraryExplainer.matchSnippet([
    "# nn.Conv1d(3, 5, 3)",
    "message = 'torch.nn.Linear(3, 2)'",
    "layer = torch.nn.Linear(3, 2)",
    "attention = scaled_dot_product_attention(q, k, v)",
  ].join("\n"), catalog);
  assert.deepEqual(result.matches.map((item) => item.id), ["linear-pack", "attention-pack"]);
  assert.equal(result.supported, true);
  assert.match(result.message, /suggestions only/);
  assert.ok(result.matches.every((item) => /not translation or equivalence/.test(item.reason)));
});

test("matches the live catalog's compound API labels as related suggestions", () => {
  const snippets = [
    ["pytorch-linear", "torch.nn.Linear(4, 2)"],
    ["pytorch-conv1d", "torch.nn.Conv1d(2, 4, 3)"],
    ["pytorch-attention", "torch.nn.functional.scaled_dot_product_attention(q, k, v)"],
    ["pytorch-layernorm", "torch.nn.LayerNorm(4)"],
    ["numpy-matmul", "import numpy as np\ny = a @ b"],
    ["numpy-softmax", "import numpy as np\ne = np.exp(x)\nz = np.sum(e)"],
    ["tfjs-sigmoid", "tf.sigmoid(x)"],
    ["tfjs-softmax", "tf.softmax(x)"],
  ];

  for (const [expectedId, source] of snippets) {
    const result = LibraryExplainer.matchSnippet(source, LibraryCatalog);
    assert.ok(result.matches.some((match) => match.id === expectedId), `${expectedId} should be suggested`);
    assert.ok(result.matches.every((match) => /suggestion, not translation or equivalence/.test(match.reason)));
  }
});

test("does not match catalog APIs mentioned only in comments or strings", () => {
  const source = [
    "# torch.nn.Linear(4, 2)",
    "message = 'torch.nn.LayerNorm(4)'",
    "/* numpy.matmul(x, y) */",
    "text = \"np.exp(x); np.sum(x)\"",
  ].join("\n");
  const result = LibraryExplainer.matchSnippet(source, LibraryCatalog);
  assert.deepEqual(result.matches, []);
  assert.equal(result.supported, false);
});

test("requires a NumPy clue for @ suggestions and explicitly rejects unknown code", () => {
  const catalog = [{ id: "matmul-pack", api: "np.matmul" }];
  assert.equal(LibraryExplainer.matchSnippet("left @ right", catalog).supported, false);
  const numpy = LibraryExplainer.matchSnippet("import numpy as np\nresult = left @ right", catalog);
  assert.deepEqual(numpy.matches.map((item) => item.id), ["matmul-pack"]);
  assert.match(numpy.matches[0].reason, /NumPy import\/qualifier/);
  const unknown = LibraryExplainer.matchSnippet("custom_magic_kernel(x)", catalog);
  assert.deepEqual(unknown.matches, []);
  assert.equal(unknown.supported, false);
  assert.match(unknown.message, /Arbitrary code is not transpiled/);
});

test("does not imply a known API is supported when the catalog lacks an exact entry", () => {
  const result = LibraryExplainer.matchSnippet("tf.softmax(logits)", []);
  assert.deepEqual(result.matches, []);
  assert.equal(result.supported, false);
  assert.match(result.message, /no exact API entry/);
});
