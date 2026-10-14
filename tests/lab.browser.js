/* Run with agent-browser eval "$(cat tests/lab.browser.js)" at /lab.html. */
(async () => {
  const $ = id => document.getElementById(id);
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await frame();
  const canvas = $('lab-canvas');
  assert(canvas.width > 0 && canvas.height > 0, 'Scene must have a drawable extent');
  assert(!document.body.textContent.includes('NaN'), 'Invalid scene coordinates');
  if (!$('pause-flow').disabled && $('pause-flow').getAttribute('aria-pressed') !== 'true') $('pause-flow').click();
  await frame();
  const start = canvas.toDataURL();
  $('zoom-in').click();
  await frame();
  assert($('zoom-readout').textContent !== '100%', 'Zoom must update the readout');
  assert(canvas.toDataURL() !== start, 'Zoom must change rendered pixels');
  const zoomed = canvas.toDataURL();
  canvas.focus();
  canvas.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight',bubbles:true,cancelable:true}));
  await frame();
  assert(canvas.toDataURL() !== zoomed, 'Keyboard orbit must change rendered pixels');
  $('reset-view').click();
  await frame();
  assert($('zoom-readout').textContent === '100%', 'Reset must restore zoom');
  $('component-list').open = true;
  const warp = [...document.querySelectorAll('.unit-selector')].find(b => b.dataset.target.startsWith('warp'));
  assert(warp, 'Warp selector missing');
  warp.click();
  assert($('selected-heading').textContent === 'Illustrative warp tile', 'Selection must update detail');
  assert(warp.getAttribute('aria-pressed') === 'true', 'Selection must expose accessible state');
  $('architecture').value = [...$('architecture').options].find(o => o.text.includes('Jetson')).value;
  $('architecture').dispatchEvent(new Event('change'));
  assert($('target-context').textContent.length > 0, 'Architecture context missing');
  if ($('renderer-label').textContent.includes('CPU')) {
    assert($('enter-vr').disabled, 'CPU drawing must not claim immersive VR availability');
    assert($('xr-status').textContent.includes('WebGL'), 'VR limitation must be explained');
  }
  assert(document.documentElement.scrollWidth <= innerWidth, 'Page must fit viewport');
  return {renderer:$('renderer-label').textContent,zoom:true,keyboardOrbit:true,reset:true,selection:true,architecture:$('architecture').selectedOptions[0].textContent,xr:$('xr-status').textContent,overflow:false};
})();
