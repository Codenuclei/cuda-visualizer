/* Run against the managed preview with:
 * agent-browser eval "$(cat tests/landing.browser.js)"
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
  await waitFor(() => $('hero-warp-select') && $('hero-lanes-grid'), 'Landing page warp sim not mounted');

  assert(document.querySelector('.brand-title').textContent.trim() === 'cuvis', 'Brand title missing');
  assert(document.querySelectorAll('.pillars-grid .pillar-card').length === 4, 'Expected four workbench pillar cards');
  assert(document.querySelectorAll('#arch-tbody tr').length === 10, 'Expected 10 GPU architecture rows');

  // Verify Warp Simulation rendering & preset switching
  assert(document.querySelectorAll('#hero-lanes-grid .lane-cell').length === 32, 'Expected 32 warp lane cells');
  assert($('stat-active-lanes').textContent.includes('32'), 'Expected 32 active lanes initially');

  $('hero-warp-select').value = 'divergent';
  $('hero-warp-select').dispatchEvent(new Event('change', { bubbles: true }));
  assert($('stat-active-lanes').textContent.includes('16'), 'Divergent preset did not update active lanes');
  assert($('stat-coalescing-eff').textContent === '50%', 'Divergent efficiency incorrect');

  $('hero-warp-step').click();
  assert($('hero-warp-select').value === 'strided', 'Step button did not cycle to strided');
  assert($('stat-memory-trans').textContent.includes('32'), 'Strided preset should require 32 sectors');

  passed.push('Warp simulator rendering, presets, and step controls verified');

  // Verify Architecture Table Filtering
  const ampereTab = document.querySelector('.arch-tab[data-gen="Ampere"]');
  assert(ampereTab, 'Ampere tab missing');
  ampereTab.click();
  const visibleRows = [...document.querySelectorAll('#arch-tbody tr')].filter(r => r.style.display !== 'none');
  assert(visibleRows.length === 2, `Expected 2 Ampere rows, got ${visibleRows.length}`);

  const allTab = document.querySelector('.arch-tab[data-gen="all"]');
  allTab.click();
  const allRows = [...document.querySelectorAll('#arch-tbody tr')].filter(r => r.style.display !== 'none');
  assert(allRows.length === 10, `Expected 10 rows after resetting filter, got ${allRows.length}`);

  passed.push('Architecture catalog generation tabs filtering verified');

  return 'PASS: ' + passed.join(' | ');
})();
