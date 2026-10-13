/* agent-browser open http://127.0.0.1:3000/compute.html
 * agent-browser eval "$(cat tests/compute.browser.js)"
 */
(async () => {
  const $ = id => document.getElementById(id);
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const wait = async () => {
    const start = performance.now();
    while ($('run').disabled) {
      if (performance.now() - start > 15000) throw new Error('Benchmark did not finish');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const results = [];
  for (const operation of ['matmul', 'vectorAdd', 'relu']) {
    $('operation').value = operation;
    $('operation').dispatchEvent(new Event('change'));
    $('size').value = operation === 'matmul' ? '32' : '4096';
    $('force-cpu').checked = true;
    $('run').click();
    await wait();
    assert($('correctness').classList.contains('pass'), `${operation}: ${$('status').textContent}`);
    assert($('backend-label').textContent === 'CPU', 'CPU fallback must be labeled');
    assert($('speedup').textContent === 'N/A', 'CPU fallback must not claim GPU speedup');
    assert(!$('download').disabled, 'Evidence download should be enabled');
    assert(Number($('cpu-ms').textContent) >= 0, 'Missing CPU latency');
    results.push({operation,correctness:$('correctness').textContent,cpuMs:$('cpu-ms').textContent});
  }
  $('run').click();
  $('cancel').click();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert($('status').textContent.startsWith('Canceled.'), 'Canceled work must not overwrite its result');
  assert($('download').disabled, 'Canceled run must not expose stale evidence');
  assert($('backend-label').textContent === 'NO RESULT', 'Canceled run must not say RUNNING');
  $('force-cpu').checked = false;
  $('operation').value = 'matmul';
  $('operation').dispatchEvent(new Event('change'));
  $('run').click();
  await wait();
  assert($('correctness').classList.contains('pass'), `Adapter-selected run: ${$('status').textContent}`);
  return {passed:results, cancellation:true,automaticBackend:$('backend-label').textContent,adapter:$('adapter').textContent};
})();
