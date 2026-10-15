const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtml = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
const landing = require('../web/landing.js');

test('index.html contains valid metadata and core workbench links', () => {
  assert.match(indexHtml, /<!doctype html>/i);
  assert.match(indexHtml, /<title>cuvis\s*—/);
  assert.match(indexHtml, /<meta name="description"/);
  assert.match(indexHtml, /href="playground\.html"/);
  assert.match(indexHtml, /href="dashboard\.html"/);
  assert.match(indexHtml, /href="lab\.html"/);
  assert.match(indexHtml, /href="compute\.html"/);
});

test('index.html contains four architectural pillars and roadmap sections', () => {
  assert.match(indexHtml, /Interactive CUDA Playground/);
  assert.match(indexHtml, /Accel-Sim Analytical Profiler/);
  assert.match(indexHtml, /3D Silicon &amp; VR Architecture Lab/);
  assert.match(indexHtml, /Dynamic AI Library Explorer/);

  assert.match(indexHtml, /Shipping Now/);
  assert.match(indexHtml, /Next/);
  assert.match(indexHtml, /Later/);
});

test('index.html lists all 10 GPU architectures in comparison matrix', () => {
  const gpus = [
    'NVIDIA A100',
    'GeForce RTX 3070',
    'GeForce RTX 2060 SUPER',
    'GeForce RTX 2060',
    'Quadro GV100',
    'Tesla V100',
    'TITAN V',
    'TITAN X (Pascal)',
    'GTX TITAN (Kepler)',
    'GeForce GTX 480'
  ];
  for (const gpu of gpus) {
    assert.ok(indexHtml.includes(gpu), `Missing GPU in matrix: ${gpu}`);
  }
});

test('landing.js exports valid 32-lane simulation presets', () => {
  const presets = landing.SIM_PRESETS;
  assert.ok(presets.vecAdd && presets.divergent && presets.strided);

  for (const [key, preset] of Object.entries(presets)) {
    assert.equal(preset.lanes.length, 32, `${key} must have exactly 32 lanes`);
    assert.ok(preset.activeCount > 0 && preset.activeCount <= 32);
    assert.ok(preset.transactions > 0);
    assert.ok(typeof preset.efficiency === 'string' && preset.efficiency.includes('%'));
  }

  assert.equal(presets.vecAdd.efficiency, '100%');
  assert.equal(presets.divergent.efficiency, '50%');
  assert.equal(presets.strided.efficiency, '12.5%');
});

test('landing.js setPreset validates keys and switches active simulation', () => {
  assert.equal(landing.setPreset('unknown_key'), false);
  assert.equal(landing.setPreset('divergent'), true);
  assert.equal(landing.getCurrentPreset(), 'divergent');
  assert.equal(landing.setPreset('vecAdd'), true);
  assert.equal(landing.getCurrentPreset(), 'vecAdd');
});
