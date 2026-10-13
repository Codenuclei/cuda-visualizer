const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lab = require('../web/lab.js');

test('GPU target catalog describes examples without inventing device counts', () => {
  assert.equal(lab.catalog.length, 6);
  assert.deepEqual(lab.catalog.map(({ family, product }) => `${family} ${product}`), [
    'Blackwell B200',
    'Blackwell GeForce RTX 5090',
    'Hopper H100',
    'Ada GeForce RTX 4090',
    'Ampere A100',
    'Ampere Jetson AGX Orin'
  ]);
  assert.ok(lab.catalog.every((entry) => entry.context));
  assert.match(lab.SCENE_NOTE, /instructional model/i);
  assert.equal(lab.getArchitecture('unknown').id, 'blackwell-datacenter');
});

test('scene is bounded, selectable and explicitly illustrative', () => {
  const { blocks, smCenters } = lab.buildScene();
  const sms = blocks.filter((block) => block.kind === 'sm');
  const warps = blocks.filter((block) => block.kind === 'warp');
  const threads = blocks.filter((block) => block.kind === 'thread');
  assert.equal(smCenters.length, 8);
  assert.equal(sms.length, 8);
  assert.equal(warps.length, 32);
  assert.equal(threads.length, 32);
  assert.equal(blocks.filter((block) => block.pickable).length, 40);
  assert.ok(warps.every((warp) => warp.parentId && /teaching cues/.test(warp.detail)));
  assert.ok(blocks.every((block) => block.position.every(Number.isFinite) && block.scale.every((n) => n > 0)));
  assert.ok(blocks.length < 100);
  const faces = lab.buildCanvasFaces(sms[0]);
  assert.equal(faces.length, 6);
  assert.ok(faces.every((face) => face.vertices.length === 4 && face.vertices.flat().every(Number.isFinite)));
});

test('data paths connect the schematic SM rows and are finite', () => {
  const { smCenters } = lab.buildScene();
  const paths = lab.buildPaths(smCenters);
  assert.ok(paths.length >= 15);
  assert.ok(paths.every((path) => [...path.a, ...path.b, ...path.color].every(Number.isFinite)));
  assert.ok(paths.some((path) => path.a[2] < 0 && path.b[2] > 0));
});

test('XR controller ray helper selects the nearest forward schematic block', () => {
  assert.equal(lab.rayAabbDistance([0, 0, 0], [0, 0, -1], [0, 0, -4], [1, 1, 1]), 3);
  assert.equal(lab.rayAabbDistance([0, 0, 0], [0, 0, -1], [3, 0, -4], [1, 1, 1]), null);
  assert.equal(lab.rayAabbDistance([0, 0, 0], [0, 0, 1], [0, 0, -4], [1, 1, 1]), null);
});

test('screen lab is local, accessible and documents unsupported rendering', () => {
  const html = fs.readFileSync(path.join(__dirname, '../web/lab.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../web/lab.js'), 'utf8');
  assert.match(html, /<canvas id="lab-canvas" tabindex="0"/);
  assert.match(html, /not device telemetry or a physical floorplan/i);
  assert.match(html, /selection adds context only/i);
  assert.match(html, /Interactive rendering is unavailable/);
  assert.match(html, /href="compute\.html">GPU compute/);
  assert.match(html, /href="dashboard\.html">Device lab/);
  assert.match(html, /id="enter-vr" type="button" disabled/);
  assert.match(html, /No AR passthrough/);
  assert.match(html, /lab\.css/);
  assert.match(html, /lab\.js/);
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.match(js, /getContext\("webgl2"/);
  assert.match(js, /getContext\("webgl"/);
  assert.match(js, /getContext\("2d"/);
  assert.match(js, /CANVAS CPU FALLBACK · WEBGL OFF/);
  assert.match(js, /buildCanvasFaces/);
  assert.match(js, /drawElementsInstanced/);
  assert.match(js, /drawCompat/);
  assert.match(js, /prefers-reduced-motion/);
  assert.match(js, /ArrowLeft/);
  assert.match(js, /setPointerCapture/);
  assert.match(js, /isSessionSupported\("immersive-vr"\)/);
  assert.match(js, /requestSession\("immersive-vr", \{ optionalFeatures: \["local-floor"\] \}\)/);
  assert.match(js, /makeXRCompatible\(\)/);
  assert.match(js, /new root\.XRWebGLLayer\(session, gl/);
  assert.match(js, /requestReferenceSpace\(type\)/);
  assert.match(js, /xrView\.transform\.inverse\.matrix/);
  assert.match(js, /xrView\.projectionMatrix/);
  assert.match(js, /xrLayer\.getViewport\(xrView\)/);
  assert.match(js, /session\.addEventListener\("end"/);
  assert.match(js, /session\.addEventListener\("select"/);
  assert.match(js, /function finishXR\(session\)/);
});
