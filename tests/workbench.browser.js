/* Run against the managed preview with:
 * agent-browser eval "$(cat tests/workbench.browser.js)"
 */
(async () => {
  const $ = id => document.getElementById(id);
  const passed = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const waitFor = async (check, message, timeout = 9000) => {
    const start = performance.now();
    while (!check()) {
      if (performance.now() - start > timeout) throw new Error(message);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  const finished = () => waitFor(() => $('run-label').textContent === 'Run kernel', 'Worker did not finish');
  const fill = (id, value) => { $(id).value = value; $(id).dispatchEvent(new Event('input', {bubbles:true})); };
  const run = async () => { $('run-button').click(); await finished(); };
  const preset = async id => { document.querySelector(`[data-kernel="${id}"]`).click(); await finished(); };
  const noError = () => assert($('error-panel').hidden, $('error-panel').textContent);

  for (const example of KernelLibrary) {
    await preset(example.id);
    noError();
    assert($('run-status').textContent.includes('Output matches'), `${example.id}: CPU reference mismatch`);
    assert(Number($('trace-scrubber').max) > 0, `${example.id}: missing source trace`);
    assert(!/NaN|undefined/.test($('event-location').textContent), `${example.id}: malformed event location`);
    $('output-tab').click();
    assert($('output-pane').textContent.includes(example.outputBuffer), `${example.id}: output missing`);
    $('tab-flow').click();
    assert($('map-content').textContent.includes(example.stages[0].label), `${example.id}: algorithm stages missing`);
    passed.push(`Run + CPU reference + trace + output: ${example.id}`);
  }

  await preset('vector-add');
  $('inspector-heading').click(); $('tab-threads').click();
  $('trace-next').click();
  assert(Number($('trace-scrubber').value) === 1, 'Next step failed');
  assert(document.querySelector('.code-line.current'), 'Source line is not highlighted');
  document.querySelector('[data-block="2"]').click();
  assert($('event-location').textContent.includes('Block 2'), 'Block selection does not seek its trace');
  assert(!/NaN/.test($('map-content').textContent), 'Invalid block/warp identity');
  $('trace-start').click();
  assert(Number($('trace-scrubber').value) === 0, 'Rewind failed');
  $('trace-speed').value = '50'; $('trace-play').click();
  await waitFor(() => Number($('trace-scrubber').value) > 0, 'Playback did not advance');
  $('trace-play').click();
  assert($('trace-play').getAttribute('aria-label') === 'Play trace', 'Pause failed');
  fill('trace-scrubber', $('trace-scrubber').max);
  assert($('trace-next').disabled, 'Last event permits invalid next step');
  passed.push('Source highlighting, block selection, step, rewind, play, pause, scrub');

  $('tab-memory').click();
  assert($('memory-request').options.length > 0, 'Memory requests missing');
  assert(document.querySelectorAll('.memory-lane:not(.empty)').length === 32, 'Wrong lane count');
  assert($('metric-coalescing').textContent === '100%', 'Vector access model should be fully coalesced');
  passed.push('Memory-sector inspection');

  fill('n-input', 73); fill('grid-input', 2); fill('block-input', 64);
  assert($('metric-events').textContent === '—', 'Configuration edit retained stale metrics');
  assert($('trace-play').disabled, 'Configuration edit retained stale playback');
  await run(); noError();
  assert($('run-status').textContent.includes('Output matches'), 'Runtime N reference mismatch');
  assert($('metric-threads').textContent === '128', 'Runtime launch not used');
  passed.push('Runtime launch dimensions + variable N + stale trace invalidation');

  fill('code-editor', 'not a CUDA kernel');
  assert($('trace-play').disabled, 'Source edit retained old trace');
  await run();
  assert(!$('error-panel').hidden, 'Malformed source did not fail');
  $('reset-code').click(); await finished(); noError();
  passed.push('Malformed source diagnosis + reset recovery');

  const infinite = '__global__ void loop(float *out) { while (1) { } }';
  fill('code-editor', infinite);
  $('run-button').click();
  assert($('run-label').textContent === 'Cancel run', 'Running state unavailable');
  $('run-button').click();
  assert($('run-status').textContent.includes('canceled'), 'Cancel did not stop the run');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert($('metric-events').textContent === '—', 'Canceled worker published a stale result');
  $('run-button').click();
  await preset('mlp-linear-relu'); noError();
  assert($('run-status').textContent.includes('Output matches'), 'Preset change did not replace in-flight worker');
  passed.push('Cancel + no stale worker result + replace a running kernel');

  await preset('vector-add');
  fill('grid-input',1); fill('block-input',32);
  fill('code-editor','__global__ void deadlock(float *out) {\n  if (threadIdx.x < 16) {\n    __syncthreads();\n  }\n  out[threadIdx.x] = 1.0f;\n}');
  await run();
  assert(!$('error-panel').hidden && $('error-panel').textContent.includes('deadlock'), 'Divergent barrier was not diagnosed');
  passed.push('Barrier deadlock is visibly reported');

  await preset('vector-add');
  fill('grid-input',64); fill('block-input',64); fill('n-input',4096);
  await run(); noError();
  assert($('run-status').textContent.includes('Output matches'), 'Trace limit altered computation');
  assert($('metric-trace-note').textContent === 'capped', 'Trace cap is not disclosed');
  assert($('trace-footnote').textContent.includes('prefix'), 'Truncated playback is not disclosed');
  passed.push('Bounded trace disclosed without truncating computation');

  await preset('vector-add');
  $('tab-threads').click(); $('inspector-heading').click();
  const createSession = CUVIS_ON_DEVICE_ASSISTANT.createSession;
  let assistantCreates = 0;
  let assistantDestroyed = 0;
  assert(!$('assistant-button').disabled, 'Assistant did not become available after a trace was recorded');
  assert($('assistant-status').textContent.includes('Off'), 'Assistant is not opt-in by default');
  CUVIS_ON_DEVICE_ASSISTANT.createSession = async () => {
    assistantCreates++;
    return {status:'unavailable'};
  };
  $('assistant-button').click();
  await waitFor(() => $('assistant-status').textContent.includes('unavailable'), 'Unavailable-model fallback was not shown');
  assert($('explanation-text').textContent.length > 0, 'Unavailable model hid the recorded explanation');
  CUVIS_ON_DEVICE_ASSISTANT.createSession = async () => ({
    status:'ready',
    session:{
      async prompt(prompt) { assert(prompt.includes('Vector addition'), 'Assistant did not receive kernel context'); return '- Mock on-device explanation.'; },
      destroy() { assistantDestroyed++; }
    }
  });
  $('assistant-button').click();
  await waitFor(() => !$('assistant-answer').hidden, 'On-device explanation was not rendered');
  assert($('assistant-status').textContent.includes('AI-generated suggestion'), 'AI output was not labeled');
  $('assistant-disable').click();
  assert(assistantDestroyed === 1 && $('assistant-answer').hidden, 'Turning AI off did not clear and destroy the session');
  assert(assistantCreates === 1, 'Assistant attempted model creation before explicit use');
  CUVIS_ON_DEVICE_ASSISTANT.createSession = createSession;
  passed.push('Opt-in assistant, unavailable-model fallback, grounded answer, and turn-off');
  $('guide-open').click(); assert($('guide-dialog').open, 'Guide did not open');
  $('guide-done').click(); assert(!$('guide-dialog').open, 'Guide did not close');
  assert(document.documentElement.scrollWidth <= innerWidth, 'Page overflows horizontally');
  passed.push('Guide dialog + no page overflow');
  return {passed:passed.length, checks:passed};
})()
