'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SourceAnalyzer = require('../web/source-analyzer.js');

test('CommonJS API analyzes different source languages without a curated example', () => {
  const js = SourceAnalyzer.analyze(`import { add } from './math.js';
export function calculate(input) { return add(input, 1); }`, { path: 'src/calculate.js' });
  assert.equal(js.language, 'javascript');
  assert.equal(js.lineCount, 2);
  assert.deepEqual(js.outline.map(({ name, kind }) => [name, kind]), [['calculate', 'function']]);
  assert.deepEqual(js.imports, ['./math.js']);
  assert.match(js.summary, /2 physical line/);
  assert.ok(js.observations.some((item) => /return keyword/.test(item)));

  const python = SourceAnalyzer.analyze(`from math import sqrt

def_not_a_declaration = 2

def distance(
    x,
    y,
):
    return sqrt(x * x + y * y)
`, { path: 'distance.py' });
  assert.equal(python.language, 'python');
  assert.deepEqual(python.outline.map((item) => item.name), ['distance']);
  assert.deepEqual(python.imports, ['math']);
  assert.equal(python.outline[0].startLine, 5);
  assert.equal(python.outline[0].endLine, 9);
});

test('JavaScript declarations include multiline signatures, arrows, classes, and named exports', () => {
  const analysis = SourceAnalyzer.analyze(`export async function build(
  input,
  options = {},
) {
  const transform =
    (value) => ({ value, nested: { ok: true } });
  function inner() { return transform(input); }
  return inner();
}

export class Builder {
  run() { return 1; }
}
const helper = (x) => x + 1;
export { helper as publicHelper };`, { path: 'builder.ts' });
  const items = analysis.outline;
  assert.deepEqual(items.map((item) => [item.name, item.kind]), [
    ['build', 'function'], ['transform', 'function'], ['inner', 'function'],
    ['Builder', 'class'], ['helper', 'function'], ['publicHelper', 'export']
  ]);
  const build = items.find((item) => item.name === 'build');
  const inner = items.find((item) => item.name === 'inner');
  assert.deepEqual([build.startLine, build.endLine], [1, 9]);
  assert.deepEqual([inner.startLine, inner.endLine], [7, 7]);
  const selected = SourceAnalyzer.summarizeSelection(analysis, build.id);
  assert.equal(selected.title, 'build');
  assert.deepEqual([selected.startLine, selected.endLine], [1, 9]);
  assert.ok(selected.observations.some((item) => /nested outline/.test(item)));
  assert.match(selected.summary, /not an explanation or validation/);
});

test('whole-file summaries use grammatical plurals for structural kinds', () => {
  const analysis = SourceAnalyzer.analyze('class First {}\nclass Second {}', { path: 'classes.js' });
  assert.match(analysis.summary, /2 classes/);
  assert.doesNotMatch(analysis.summary, /classs/);
});

test('braces and declaration-like text in comments and strings do not create symbols', () => {
  const analysis = SourceAnalyzer.analyze(`const sample = "function fake() { }";
/* function hidden() {
  class AlsoHidden {}
} */
// function commented() {}
function real() {
  const text = \`class FakeTemplate {} { \${1 + 2} }\`;
  return text;
}`, { path: 'sample.js' });
  assert.deepEqual(analysis.outline.map((item) => item.name), ['real']);
  assert.deepEqual([analysis.outline[0].startLine, analysis.outline[0].endLine], [6, 9]);

  const stringsOnly = SourceAnalyzer.analyze(`const a = 'function no() {}';
const b = "class Nope {}";
// function commentOnly() {}`, { language: 'javascript' });
  assert.deepEqual(stringsOnly.outline, []);
});

test('CUDA kernels and ordinary C/C++ definitions have distinct structural kinds', () => {
  const cuda = SourceAnalyzer.analyze(`#include <cuda_runtime.h>
__global__ void scaleKernel(
    float* values,
    int count
) {
  for (int i = 0; i < count; ++i) { values[i] *= 2; }
}
float hostScale(float value) { return value * 2; }`, { path: 'scale.cu' });
  assert.equal(cuda.language, 'cuda');
  assert.deepEqual(cuda.imports, ['cuda_runtime.h']);
  assert.deepEqual(cuda.outline.map(({ name, kind }) => [name, kind]), [
    ['scaleKernel', 'kernel'], ['hostScale', 'function']
  ]);
  assert.deepEqual([cuda.outline[0].startLine, cuda.outline[0].endLine], [2, 7]);

  const cpp = SourceAnalyzer.analyze(`int add(
  int a,
  int b
) {
  return a + b;
}`, { path: 'add.cpp' });
  assert.deepEqual(cpp.outline.map((item) => item.name), ['add']);
  assert.deepEqual([cpp.outline[0].startLine, cpp.outline[0].endLine], [1, 6]);
});

test('Python and Markdown ranges follow indentation and heading levels', () => {
  const python = SourceAnalyzer.analyze(`def outer(value):
    def inner():
        return value
    return inner()

def sibling():
    pass`, { language: 'python' });
  assert.deepEqual(python.outline.map((item) => [item.name, item.startLine, item.endLine]), [
    ['outer', 1, 4], ['inner', 2, 3], ['sibling', 6, 7]
  ]);

  const markdown = SourceAnalyzer.analyze(`# Overview
Intro.
## Details
More.
### Example
Text.
## Next
Done.`, { path: 'README.md' });
  assert.deepEqual(markdown.outline.map((item) => [item.name, item.startLine, item.endLine, item.kind]), [
        ['Overview', 1, 8, 'section'], ['Details', 3, 6, 'section'],
    ['Example', 5, 6, 'section'], ['Next', 7, 8, 'section']
  ]);
});

test('unsupported language is explicit and does not infer semantic constructs', () => {
  const analysis = SourceAnalyzer.analyze('fn main() { loop {} }', { path: 'main.rs' });
  assert.equal(analysis.language, 'rust');
  assert.equal(analysis.outline.length, 0);
  assert.match(analysis.summary, /unsupported/);
  assert.match(analysis.limitations[0], /unsupported/);
});

test('minified files retain ranges; large source and outline are safely bounded', () => {
  const minified = SourceAnalyzer.analyze('function a(){return 1}function b(){return 2}', { path: 'min.js' });
  assert.deepEqual(minified.outline.map((item) => [item.name, item.startLine, item.endLine]), [
    ['a', 1, 1], ['b', 1, 1]
  ]);
  const minifiedArrows = SourceAnalyzer.analyze('const a=x=>x+1;const b=()=>({ value: 2 });', { path: 'arrows.js' });
  assert.deepEqual(minifiedArrows.outline.map((item) => item.name), ['a', 'b']);

  const huge = SourceAnalyzer.analyze(`function first() { return 0; }\n${'// pad\n'.repeat(21000)}`, { path: 'large.js' });
  assert.equal(huge.lineCount, 20000);
  assert.equal(huge.truncated, true);
  assert.ok(huge.limitations.some((item) => /bounded/.test(item)));

  const many = Array.from({ length: 180 }, (_, i) => `function f${i}(){}`).join('\n');
  const bounded = SourceAnalyzer.analyze(many, { language: 'javascript' });
  assert.equal(bounded.outline.length, 150);
  assert.equal(bounded.truncated, true);

  const chars = SourceAnalyzer.analyze(' '.repeat(1024 * 1024 + 20), { language: 'text' });
  assert.equal(chars.truncated, true);
  assert.match(chars.limitations.at(-1), /bounded/);
});

test('browser global and missing selection contract are available', () => {
  assert.equal(globalThis.SourceAnalyzer, SourceAnalyzer);
  const browser = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/source-analyzer.js'), 'utf8'), browser);
  assert.equal(typeof browser.SourceAnalyzer.analyze, 'function');
  assert.equal(browser.SourceAnalyzer.analyze('def ready():\n    pass', { path: 'ready.py' }).outline[0].name, 'ready');
  assert.deepEqual(SourceAnalyzer.summarizeSelection(SourceAnalyzer.analyze('', { path: 'empty.py' }), 'missing'), {
    title: 'No symbol selected',
    summary: 'Choose a detected outline item to review its bounded source range.',
    observations: [],
    limitations: ['Only detected outline items can be selected; this tool does not infer symbols from unsupported syntax.'],
    startLine: null,
    endLine: null
  });
});
