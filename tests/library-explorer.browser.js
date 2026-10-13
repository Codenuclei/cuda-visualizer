/* Run on a fresh managed-preview page:
 * agent-browser eval "$(cat tests/library-explorer.browser.js)"
 */
(async () => {
  const $ = id => document.getElementById(id);
  const passed = [];
  const assert = (condition,message) => { if (!condition) throw new Error(message); };
  const wait = async (predicate,message,timeout = 15000) => {
    const start = performance.now();
    while (!predicate()) {
      if (performance.now()-start > timeout) throw new Error(message);
      await new Promise(resolve => setTimeout(resolve,30));
    }
  };
  const select = (id,value) => { $(id).value = value; $(id).dispatchEvent(new Event('change',{bubbles:true})); };
  const input = (id,value) => { $(id).value = value; $(id).dispatchEvent(new Event('input',{bubbles:true})); };
  const resources = () => performance.getEntriesByType('resource').filter(entry => entry.name.includes('/packs/') || entry.name.includes('cdn.jsdelivr.net'));
  const load = async id => {
    const op = LibraryCatalog.operations.find(item => item.id === id);
    select('library-select',op.library); select('operation-select',id); $('load-operation').click();
    await wait(() => !$('lesson').hidden || !$('pack-error').hidden,`${id}: pack did not load`);
    assert($('pack-error').hidden,$('pack-error').textContent);
    await wait(() => $('lesson-result-status').textContent.includes('COMPLETE') || $('lesson-result-status').textContent.includes('ATTENTION'),`${id}: mapped run did not finish`);
    assert($('lesson-result-status').textContent.includes('COMPLETE'),`${id}: ${$('operation-observations').textContent}`);
    assert($('operation-observations').textContent.includes('matches the independent CPU reference'),`${id}: wrong output`);
  };

  assert(resources().length === 0,'Initial page eagerly fetched a pack or CDN source');
  assert($('kernel-workspace').hidden,'Initial library mode exposes raw CUDA before selection');
  select('library-select','tensorflowjs');
  assert(resources().length === 0,'Selecting a library fetched its packs');
  select('library-select','pytorch');
  passed.push('No eager pack/CDN requests; changing library loads only catalog metadata');

  await load('pytorch-linear');
  const requested = resources();
  assert(requested.length === 1 && requested[0].name.endsWith('/packs/pytorch-linear.json'),'First selection fetched more than one pack');
  assert($('summary-overview').textContent.length > 100,'Whole-operation summary missing');
  assert(document.querySelectorAll('.stage-card').length > 1,'Operation stages missing');
  assert($('source-provenance-label').textContent.includes('Authored'),'Readable example not labeled as authored');
  const firstCount = resources().length;
  await load('pytorch-linear');
  assert(resources().length === firstCount,'Repeated selection missed in-memory pack cache');
  passed.push('Selected pack only, cache reuse, authored-source label, and whole-operation summary');

  for (const operation of LibraryCatalog.operations) {
    await load(operation.id);
    assert(!/NaN|undefined/.test($('tensor-statistics').textContent),`${operation.id}: invalid tensor statistics`);
    assert($('tensor-provenance').textContent === 'Recorded final values',`${operation.id}: missing output provenance`);
    $('source-kernel-tab').click();
    assert($('library-source-code').textContent.includes('__global__'),`${operation.id}: CUDA teaching mapping missing`);
    assert($('source-provenance-label').textContent.includes('teaching mapping'),`${operation.id}: mapping mislabeled`);
    passed.push(`${operation.id}: mapped execution + CPU-reference output + tensor inspection`);
  }

  await load('pytorch-attention');
  const snapshot = CuvisWorkbench.getSnapshot();
  const tensorNames = Object.keys(snapshot.result.buffers);
  const probabilityName = tensorNames.find(name => /prob|weight/i.test(name) && snapshot.result.buffers[name].length === 4);
  assert(probabilityName,'Attention exposes no probability tensor');
  const probabilitySum = Array.from(snapshot.result.buffers[probabilityName]).reduce((a,b)=>a+b,0);
  assert(Math.abs(probabilitySum-1)<1e-5,'Attention probabilities do not sum to one');
  select('tensor-select',probabilityName);
  assert($('tensor-shape').textContent.includes(probabilityName),'Tensor selector did not change the inspector');
  const cell = document.querySelector('#tensor-cells [data-element="2"]');
  cell.click();
  assert(!$('kernel-workspace').hidden,'Tensor click did not open CUDA trace');
  assert($('explanation-text').textContent.includes(`${probabilityName}[2]`),'Tensor click did not seek the exact memory element');
  $('back-to-overview').click();
  assert($('kernel-workspace').hidden,'Returning to overview did not collapse low-level workbench');
  document.querySelector('.stage-card:last-child').click();
  const selectedStage = document.querySelector('.stage-card.active strong').textContent;
  assert($('stage-title').textContent === selectedStage,'Stage detail did not follow selection');
  $('stage-trace-link').click();
  assert(!$('kernel-workspace').hidden && document.querySelector('.code-line.current'),'Stage did not navigate to captured source');
  passed.push('Attention intermediate probabilities + exact tensor-memory trace + stage/source navigation');

  const edited = $('code-editor').value+'\n// local experiment';
  input('code-editor',edited);
  assert($('lesson-result-status').textContent === 'AWAITING EXECUTION','Source edit kept a stale lesson result');
  assert(!$('tensor-provenance').textContent.includes('Recorded final'),'Source edit kept stale tensor provenance');
  assert($('stage-trace-link').disabled,'Source edit left stage trace link enabled');
  $('back-to-overview').click();
  await load('pytorch-attention');
  passed.push('Edits invalidate high-level results, tensor provenance, and stage navigation');

  $('snippet-open').click();
  input('snippet-input','output = torch.nn.functional.scaled_dot_product_attention(q, k, v)');
  $('snippet-match').click();
  assert(document.querySelector('[data-match="pytorch-attention"]'),'Known attention API was not suggested');
  assert($('snippet-results').textContent.includes('not translation') || $('snippet-results').textContent.includes('no code is translated'),'Matcher claims arbitrary translation');
  input('snippet-input','mystery::run_everything(x)'); $('snippet-match').click();
  assert(!document.querySelector('[data-match]'),'Unknown code produced a fake mapping');
  assert($('snippet-results').textContent.includes('not transpiled'),'Unknown-code limitation missing');
  input('snippet-input','// tf.softmax(x)\nconst message = "tf.sigmoid(x)";'); $('snippet-match').click();
  assert(!document.querySelector('[data-match]'),'Comment/string content triggered API suggestions');
  $('snippet-close').click();
  passed.push('Snippet matching: known API, unknown code, comment/string rejection, truthful suggestions');

  select('library-select','numpy'); select('operation-select','numpy-matmul'); $('load-operation').click();
  select('library-select','tensorflowjs'); select('operation-select','tfjs-softmax'); $('load-operation').click();
  await wait(() => $('lesson-title').textContent === 'Softmax' && $('lesson-result-status').textContent.includes('COMPLETE'),'Superseded selection overwrote newer lesson');
  await new Promise(resolve=>setTimeout(resolve,100));
  assert(CuvisWorkbench.getSnapshot().presetId === 'pack-tfjs-softmax','Superseded request ran an old kernel');
  passed.push('Rapid pack switching ignores stale pack and worker results');

  const remoteCount = resources().filter(entry=>entry.name.includes('cdn.jsdelivr.net')).length;
  assert(remoteCount === 0,'Upstream source was fetched before its tab opened');
  $('source-upstream-tab').click();
  await wait(() => $('source-network-state').textContent.includes('Pinned source') || $('source-network-state').textContent.includes('Source unavailable'),'Upstream request did not settle');
  assert(!$('source-retry'),`Real CDN source failed: ${$('source-network-state').textContent}`);
  assert($('library-source-code').textContent.includes('softmax'),'CDN excerpt lacks expected source symbol');
  assert($('source-provenance-label').textContent.includes('tensorflow/tfjs'),'CDN provenance missing');
  assert(resources().filter(entry=>entry.name.includes('cdn.jsdelivr.net')).length === 1,'Upstream selection fetched unrelated sources');
  $('source-example-tab').click(); $('source-upstream-tab').click();
  assert(resources().filter(entry=>entry.name.includes('cdn.jsdelivr.net')).length === 1,'Upstream cache was not reused');
  passed.push('Real pinned CDN fetch, bounded symbol excerpt, repository/license provenance, source cache');

  assert(document.documentElement.scrollWidth <= innerWidth,'Library explorer overflows horizontally');
  assert(!document.querySelector('#library-source-code script'),'Source content was injected as executable markup');
  await load('pytorch-attention');
  $('source-example-tab').click();
  return {passed:passed.length,checks:passed};
})()
