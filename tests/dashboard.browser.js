/* Run against the managed preview with:
 * agent-browser eval "$(cat tests/dashboard.browser.js)"
 */
(async () => {
  const $ = id => document.getElementById(id);
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const passed = [];

  const waitFor = async (check, message, timeout = 9000) => {
    const start = performance.now();
    while (!check()) {
      if (performance.now() - start > timeout) throw new Error(message);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };

  if (document.readyState !== 'complete') await new Promise(r => addEventListener('load', r, { once: true }));
  await waitFor(() => $('gpu-form') && $('gpu-form').isConnected &&
    $('gpu-select').options.length > 0, 'Dashboard never finished loading');

  assert(location.pathname.endsWith('/dashboard.html'), 'Run against dashboard.html');
  assert(document.querySelector('.hero-inner .brand').textContent.trim() === 'cuvis', 'Hero brand missing');
  assert($('runtime-note').textContent.length > 0, 'Runtime note not populated');

  const gpuCount = $('gpu-select').options.length;
  assert(gpuCount >= 2, 'Device picker has too few options');

  const firstTitle = $('gpu-title').textContent;
  assert(firstTitle && firstTitle !== '—', 'Overview title not rendered');
  assert(document.querySelectorAll('#stat-cards .card.stat').length === 4, 'Expected four stat cards');
  assert($('spec-silicon').children.length > 0 && $('spec-memory').children.length > 0, 'Spec lists empty');

  const mid = Math.floor(gpuCount / 2);
  $('gpu-select').value = String(mid);
  $('gpu-select').dispatchEvent(new Event('change', { bubbles: true }));
  assert($('gpu-title').textContent !== firstTitle, 'Device switch did not re-render overview');
  assert(document.querySelectorAll('#kernel-table tbody tr').length >= 6, 'Kernel table missing rows');
  $('gpu-select').value = '0';
  $('gpu-select').dispatchEvent(new Event('change', { bubbles: true }));
  passed.push(`Device picker drives overview, ${gpuCount} device models`);

  assert($('kernel-table').querySelector('tbody tr.selected'), 'Kernel table selection missing');
  assert($('timeline-svg').querySelector('rect, circle, path'), 'Timeline chart empty');
  assert($('roofline-svg').textContent.includes('GFLOP/s'), 'Roofline labels missing');

  const form = $('gpu-form');
  assert(form && $('gpu-select').closest('.select-wrap'), 'Picker form structure missing');
  assert(document.querySelector('.nav a[href="#roadmap"]'), 'Nav roadmap link missing');
  const roadCards = document.querySelectorAll('#roadmap .road-card');
  assert(roadCards.length >= 5, 'Roadmap cards missing');
  assert([...roadCards].every(c => c.querySelector('.badge')), 'Roadmap cards missing status badges');
  passed.push('Roadmap section with ' + roadCards.length + ' cards + picker form structure');

  const lane = document.querySelector('.warp-lanes .lane');
  assert(lane, 'Hero warp lanes missing');
  passed.push('Hero warp-lane backdrop present');

  return 'PASS: ' + passed.join(' | ');
})()
