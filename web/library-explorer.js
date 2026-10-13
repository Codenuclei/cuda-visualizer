/* Library source is read-only evidence; only validated teaching kernels execute. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const catalog = window.LibraryCatalog;
  const explain = window.LibraryExplainer;
  if (!catalog || !explain || !window.LibraryLoader) {
    $('pack-error').hidden = false;
    $('pack-error').textContent = 'The library explorer could not load. Reload the page or use CUDA kernels.';
    $('mode-kernels').addEventListener('click', () => { $('kernel-workspace').hidden = false; $('library-explorer').hidden = true; });
    return;
  }
  const loader = window.LibraryLoader.createLoader();
  const state = {mode:'libraries', pack:null, result:null, generation:0, controller:null, sourceController:null, sourceView:'example', source:null, sourceLoading:false, sourceError:null, stage:0, tensor:null, loading:false};
  const format = value => value === null || value === undefined ? '—' : Number.isFinite(value) ? value.toLocaleString('en-US', {maximumFractionDigits:4}) : String(value);
  const size = bytes => `${(bytes / 1024).toFixed(1)} KiB`;
  const libraryById = id => catalog.libraries.find(item => item.id === id);
  const operationsFor = id => catalog.operations.filter(item => item.library === id);
  const operationById = id => catalog.operations.find(item => item.id === id);
  const nameFor = library => libraryById(library)?.title || library;
  const abbreviations = {pytorch:'Py',numpy:'np',tensorflowjs:'tf'};
  const categoryNames = {'pytorch-linear':'How does a neuron learn a pattern?','pytorch-conv1d':'How does a CNN find local features?','pytorch-attention':'How does attention choose what matters?','pytorch-layernorm':'Why normalize a hidden vector?','numpy-matmul':'How do matrices combine information?','numpy-softmax':'How do scores become probabilities?','tfjs-sigmoid':'How does a gate decide what passes?','tfjs-softmax':'How does a classifier compare scores?'};

  function renderNavigation() {
    $('library-navigation').innerHTML = `<div class="library-nav-label">OPEN-SOURCE LIBRARIES<span>03</span></div>${catalog.libraries.map(library => `<div class="library-nav-group"><button class="library-nav-heading ${$('library-select').value === library.id ? 'active' : ''}" data-library="${esc(library.id)}"><span class="library-monogram ${esc(library.id)}">${abbreviations[library.id] || 'L'}</span><span>${esc(library.title)}<small>${esc(library.language)}</small></span><span class="library-nav-count">${operationsFor(library.id).length}</span></button><div class="library-nav-operations">${operationsFor(library.id).map(op => `<button data-operation="${esc(op.id)}" class="${state.pack?.id === op.id ? 'active' : ''}" aria-pressed="${state.pack?.id === op.id}"><span class="operation-nav-dot"></span>${esc(op.title)}</button>`).join('')}</div></div>`).join('')}<div class="sidebar-source-note">${icon('layers')}<span>Small packs. Loaded on demand.<br><b>Never an entire framework.</b></span></div>`;
  }

  function setMode(mode, scroll = false) {
    if (mode === 'kernels' && state.loading) {
      cancelPending();
      $('pack-status').textContent = 'Lesson loading canceled. Choose Explore operation to retry.';
    }
    state.mode = mode;
    document.body.classList.toggle('library-mode',mode === 'libraries');
    $('mode-libraries').classList.toggle('selected',mode === 'libraries');
    $('mode-kernels').classList.toggle('selected',mode === 'kernels');
    $('mode-libraries').setAttribute('aria-pressed',mode === 'libraries');
    $('mode-kernels').setAttribute('aria-pressed',mode === 'kernels');
    $('library-explorer').hidden = mode !== 'libraries';
    $('library-navigation').hidden = mode !== 'libraries';
    $('kernel-workspace').hidden = mode === 'libraries';
    $('back-to-overview').hidden = !state.pack;
    $('workspace-eyebrow').textContent = mode === 'libraries' ? 'OPEN SOURCE. OPENED UP.' : 'LESS BLACK BOX. MORE LIGHT BULB.';
    $('workspace-title').innerHTML = mode === 'libraries' ? 'One library call. <span>The whole picture.</span>' : 'Parallel, <span>made visible.</span>';
    $('workspace-subtitle').textContent = mode === 'libraries' ? 'From familiar APIs to the math, tensors, and threads that make AI work.' : 'Write a kernel. Follow every thread. Understand the machine.';
    window.dispatchEvent(new CustomEvent('cuvis:library-mode', {detail:{mode}}));
    if (scroll) $('workspace').scrollIntoView({behavior:'instant',block:'start'});
  }

  function showKernel() {
    if (state.pack && window.CuvisWorkbench.getSnapshot().presetId !== `pack-${state.pack.id}`) window.CuvisWorkbench.loadPack(state.pack);
    $('kernel-workspace').hidden = false;
    $('kernel-workspace').scrollIntoView({behavior:'instant',block:'start'});
  }

  function cancelPending() {
    state.generation++;
    state.controller?.abort(); state.sourceController?.abort();
    state.controller = null; state.sourceController = null;
    state.loading = false; state.sourceLoading = false;
    $('load-operation').disabled = false;
    $('load-operation').querySelector('span').textContent = 'Explore operation';
  }

  function clearLesson() {
    cancelPending();
    state.pack = null; state.result = null; state.source = null; state.sourceError = null;
    window.CuvisWorkbench.cancel();
    $('lesson').hidden = true; $('library-welcome').hidden = false; $('pack-error').hidden = true;
    if (state.mode === 'libraries') $('kernel-workspace').hidden = true;
    $('pack-status').textContent = 'Pick an operation. Only the selected lesson pack is loaded.';
  }

  function chooseLibrary(id, operationId) {
    clearLesson();
    $('library-select').value = id;
    const ops = operationsFor(id);
    $('operation-select').innerHTML = ops.map(op => `<option value="${esc(op.id)}">${esc(op.title)}</option>`).join('');
    if (operationId) $('operation-select').value = operationId;
    $('operation-cards').innerHTML = ops.map((op,index) => `<button class="operation-card" data-operation="${esc(op.id)}"><span class="operation-card-top"><span class="operation-card-number">0${index+1}</span>${icon(index === 2 ? 'layers' : index === 1 ? 'grid' : 'chip')}</span><h3>${esc(categoryNames[op.id] || op.title)}</h3><code>${esc(op.api)}</code><span class="operation-card-bottom">${esc(op.language)} <span>Explore <b>↗</b></span></span></button>`).join('');
    renderNavigation();
  }

  async function loadOperation(id = $('operation-select').value) {
    const operation = operationById(id);
    if (!operation) return;
    if ($('library-select').value !== operation.library) chooseLibrary(operation.library,operation.id);
    else { clearLesson(); $('operation-select').value = operation.id; }
    setMode('libraries');
    window.dispatchEvent(new CustomEvent('cuvis:guided-lesson'));
    state.controller = new AbortController();
    const generation = state.generation;
    state.loading = true;
    $('load-operation').disabled = true;
    $('load-operation').querySelector('span').textContent = 'Loading pack…';
    $('pack-status').textContent = `Loading ${operation.title}—nothing else is requested.`;
    try {
      const pack = await loader.loadPack(operation, {signal:state.controller.signal,onProgress:progress => {
        if (generation === state.generation) $('pack-status').textContent = `Loading selected pack · ${size(progress.loaded)} received`;
      }});
      if (generation !== state.generation) return;
      state.pack = pack; state.stage = 0; state.result = null;
      state.sourceView = 'example'; state.source = null; state.sourceError = null;
      state.tensor = pack.kernel.outputBuffer;
      $('lesson').hidden = false; $('library-welcome').hidden = true;
      $('pack-status').textContent = `${nameFor(pack.library)} / ${pack.title} · ${size(new TextEncoder().encode(JSON.stringify(pack)).length)} lesson · upstream source fetched only when opened`;
      renderLesson(); renderNavigation();
      window.CuvisWorkbench.loadPack(pack);
    } catch (error) {
      if (generation !== state.generation || error.name === 'AbortError') return;
      $('pack-error').hidden = false;
      $('pack-error').textContent = `Could not load this operation: ${error.message}. Select Explore operation to retry.`;
      $('pack-status').textContent = 'No lesson was loaded. Other operations are still available.';
    } finally {
      if (generation === state.generation) {
        state.loading = false; $('load-operation').disabled = false;
        $('load-operation').querySelector('span').textContent = 'Explore operation';
      }
    }
  }

  function renderLesson() {
    const pack = state.pack;
    if (!pack) return;
    $('lesson-library').textContent = `${nameFor(pack.library)} / LIBRARY EXPLORER`;
    $('lesson-title').textContent = pack.title;
    $('lesson-api').textContent = pack.api;
    $('lesson-version').textContent = `${pack.language} · v${pack.version}`;
    $('tensor-select').innerHTML = pack.tensors.map(tensor => `<option value="${esc(tensor.name)}">${esc(tensor.name)} · ${tensor.shape.join(' × ')} · ${esc(tensor.role)}</option>`).join('');
    if (!pack.tensors.some(tensor => tensor.name === state.tensor)) state.tensor = pack.tensors[0].name;
    $('tensor-select').value = state.tensor;
    renderSummary(); renderStages(); renderSource(); renderTensor(); renderResult(); renderLimitations();
  }

  function renderSummary() {
    const pack = state.pack, summary = explain.summarize(pack,state.result);
    $('summary-heading').textContent = summary.headline || pack.title;
    $('summary-overview').textContent = summary.overview || pack.summary;
    $('operation-formula').textContent = pack.formula;
    $('tensor-signature').innerHTML = pack.tensors.filter(t => t.role !== 'intermediate').slice(0,5).map(tensor => `<button class="tensor-shape-chip ${tensor.role}" data-tensor="${esc(tensor.name)}"><span>${esc(tensor.name)}</span><b>${tensor.shape.join(' × ')}</b><small>${esc(tensor.role)}</small></button>`).join('');
  }

  function renderStages() {
    const stages = state.pack.stages;
    $('stage-cards').style.setProperty('--stage-count',stages.length);
    $('stage-cards').innerHTML = stages.map((stage,index) => `<button class="stage-card ${index === state.stage ? 'active' : ''}" data-stage="${index}" aria-pressed="${index === state.stage}"><span class="stage-card-index">${String(index+1).padStart(2,'0')}<span>${index < stages.length-1 ? '→' : '✓'}</span></span><strong>${esc(stage.title)}</strong><code>${esc(stage.formula || 'Follow the source')}</code></button>`).join('');
    const stage = stages[state.stage];
    $('stage-number').textContent = String(state.stage+1).padStart(2,'0');
    $('stage-title').textContent = stage.title;
    $('stage-explanation').textContent = stage.summary;
    $('stage-insight').textContent = stage.insight;
    const trace = state.result?.executionTrace || [];
    $('stage-trace-link').disabled = !trace.some(event => stage.cudaLines.includes(event.line));
    $('stage-trace-link').title = $('stage-trace-link').disabled ? 'No captured event for this stage in the current run.' : 'Jump to the first captured source event in this stage.';
  }

  function highlight(line) {
    const tokens = /(#[^\n]*|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:import|from|as|def|return|for|in|if|else|const|let|function|int|float|void|__global__|__shared__)\b|\b(?:torch|nn|np|tf|threadIdx|blockIdx|blockDim|expf|sqrtf|fmaxf)\b|\b\d+(?:\.\d+)?f?\b)/g;
    let output = '', end = 0;
    for (const match of line.matchAll(tokens)) {
      output += esc(line.slice(end,match.index));
      const token = match[0], type = /^(#|\/\/)/.test(token) ? 'comment' : /^['"]/.test(token) ? 'string' : /^\d/.test(token) ? 'number' : /^(torch|nn|np|tf|threadIdx|blockIdx|blockDim|expf|sqrtf|fmaxf)$/.test(token) ? 'builtin' : 'keyword';
      output += `<span class="syntax-${type}">${esc(token)}</span>`;
      end = match.index+token.length;
    }
    return output+esc(line.slice(end));
  }

  function safeLink(value) {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : '#'; } catch { return '#'; }
  }

  function renderSource() {
    const pack = state.pack;
    if (!pack) return;
    const view = state.sourceView;
    document.querySelectorAll('[data-source-view]').forEach(button => {
      const active = button.dataset.sourceView === view;
      button.classList.toggle('active',active); button.setAttribute('aria-selected',active); button.tabIndex = active ? 0 : -1;
    });
    $('library-source-content').setAttribute('aria-labelledby',`source-${view}-tab`);
    $('source-language').textContent = view === 'kernel' ? 'CUDA C · interpreted' : view === 'upstream' && pack.upstream.path.endsWith('.ts') ? 'TypeScript · upstream' : pack.language;
    $('source-panel-title').textContent = view === 'upstream' ? 'Inside the open-source library' : view === 'kernel' ? 'The executable teaching model' : 'The library call';
    const network = $('source-network-state');
    network.hidden = true;
    let code = view === 'kernel' ? pack.kernel.code : pack.example, startLine = 1;
    const selectedLines = view === 'kernel' ? pack.stages[state.stage].cudaLines : view === 'example' ? pack.stages[state.stage].sourceLines : [];
    if (view === 'upstream') {
      if (state.sourceLoading) { network.hidden = false; network.textContent = 'Fetching the pinned source file from jsDelivr…'; code = ''; }
      else if (state.sourceError) { network.hidden = false; network.innerHTML = `<p>${esc(state.sourceError)}</p><button class="subtle-button" id="source-retry">Retry source fetch ↻</button><p class="source-failure-note">The local teaching lesson still works. No replacement source is fabricated.</p>`; code = ''; }
      else if (state.source) {
        const excerpt = explain.extractSource(state.source.text,pack.upstream,{maxLines:80});
        code = excerpt.text; startLine = excerpt.startLine;
        network.hidden = false;
        network.textContent = excerpt.matched ? `Pinned source · ${size(state.source.bytes)} file · excerpt at lines ${excerpt.startLine}–${excerpt.endLine}` : 'The configured symbol was not found. No source excerpt or verified mapping is shown.';
      } else code = '';
      $('source-provenance-label').textContent = `${pack.upstream.repository} @ ${pack.upstream.revision} · ${pack.upstream.license}`;
      $('source-external-link').href = safeLink(`https://github.com/${pack.upstream.repository}/blob/${pack.upstream.revision}/${pack.upstream.path}`);
      $('source-external-link').textContent = 'Open original ↗';
    } else {
      $('source-provenance-label').textContent = view === 'kernel' ? 'Authored & CPU-reference-tested teaching mapping' : 'Authored usage example · fixed teaching fixture';
      $('source-external-link').href = safeLink(pack.docsUrl);
      $('source-external-link').textContent = 'API documentation ↗';
    }
    $('library-source-code').innerHTML = code ? code.split('\n').map((line,index) => `<span class="library-code-line ${selectedLines.includes(index+startLine) ? 'selected' : ''}"><span class="library-line-number" aria-hidden="true">${index+startLine}</span><span>${highlight(line) || ' '}</span></span>`).join('') : '';
  }

  async function fetchSource() {
    if (!state.pack || state.source || state.sourceLoading) return;
    const pack = state.pack, generation = state.generation;
    state.sourceController = new AbortController(); state.sourceLoading = true; state.sourceError = null;
    renderSource();
    try {
      const source = await loader.loadSource(pack.upstream,{signal:state.sourceController.signal,onProgress:progress => {
        if (generation === state.generation && state.sourceView === 'upstream') $('source-network-state').textContent = `Streaming pinned source · ${size(progress.loaded)} received${progress.total ? ` of ${size(progress.total)}` : ''}`;
      }});
      if (generation !== state.generation) return;
      state.source = source;
    } catch (error) {
      if (generation !== state.generation || error.name === 'AbortError') return;
      state.sourceError = `Source unavailable: ${error.message}`;
    } finally {
      if (generation === state.generation) { state.sourceLoading = false; renderSource(); }
    }
  }

  function renderTensor() {
    if (!state.pack) return;
    const tensor = state.pack.tensors.find(t => t.name === state.tensor);
    if (!tensor) return;
    const output = state.result?.buffers[tensor.name];
    const values = output || state.pack.kernel.buffers[tensor.name]?.values || [];
    const stats = explain.tensorStats(values);
    const width = Math.min(16,tensor.shape.at(-1) || 1);
    $('tensor-description').textContent = tensor.description;
    $('tensor-shape').textContent = `${tensor.name} [${tensor.shape.join(' × ')}]`;
    $('tensor-provenance').textContent = output ? state.result.deadlock ? 'Partial simulated values' : 'Recorded final values' : ['output','intermediate'].includes(tensor.role) ? 'Initialized fixture · not a result' : 'Deterministic input fixture';
    $('tensor-statistics').innerHTML = [['MIN',stats.min],['MAX',stats.max],['MEAN',stats.mean],['SUM',stats.sum]].map(([label,value]) => `<div><span>${label}</span><b>${esc(format(value))}</b></div>`).join('');
    const bound = Math.max(Math.abs(stats.min || 0),Math.abs(stats.max || 0),0.00001);
    $('tensor-cells').style.setProperty('--tensor-columns',width);
    $('tensor-cells').innerHTML = Array.from(values).slice(0,128).map((value,index) => {
      const strength = Math.min(1,Math.abs(value)/bound);
      const color = value >= 0 ? `rgba(126,225,158,${0.08+strength*0.32})` : `rgba(168,143,221,${0.08+strength*0.32})`;
      return `<button class="tensor-value ${value < 0 ? 'negative' : ''}" style="background:${color}" data-element="${index}" title="${esc(tensor.name)}[${index}] = ${esc(value)}" aria-label="${esc(tensor.name)} element ${index}, value ${esc(value)}"><small>${index}</small><span>${esc(format(value))}</span></button>`;
    }).join('');
    $('tensor-count').textContent = `${Math.min(values.length,128)} / ${values.length} values · select a cell to trace`;
  }

  function renderResult() {
    if (!state.pack) return;
    const result = state.result;
    const summary = explain.summarize(state.pack,result);
    $('lesson-result-status').textContent = result ? result.deadlock ? 'PARTIAL EXECUTION' : 'SIMULATION COMPLETE' : 'AWAITING EXECUTION';
    $('operation-observations').innerHTML = (summary.observations?.length ? summary.observations : ['Run the teaching kernel to inspect observed results.']).map(observation => `<span>${icon('info')}${esc(observation)}</span>`).join('');
    if (result) {
      const actual = result.buffers[state.pack.kernel.outputBuffer], expected = state.pack.kernel.expected;
      const correct = !result.deadlock && actual?.length === expected.length && Array.from(actual).every((value,index) => Number.isFinite(value) && Math.abs(value-expected[index]) <= 1e-5*Math.max(1,Math.abs(expected[index])));
      const check = document.createElement('span'); check.className = correct ? 'reference-pass' : 'reference-warning';
      check.textContent = correct ? '✓ Output matches the independent CPU reference.' : 'Output does not match the fixture reference. Inspect launch settings or source.';
      $('operation-observations').prepend(check);
    }
  }

  function renderLimitations() {
    const pack = state.pack;
    $('mapping-limitations').innerHTML = `<p>${esc(explain.summarize(pack,state.result).provenance || 'This is an authored teaching mapping, not automatic translation of upstream source.')}</p><ul>${pack.limitations.map(item => `<li>${esc(item)}</li>`).join('')}</ul><p>Original source is fetched as read-only text from a pinned jsDelivr URL. No Python, JavaScript, or native library code from the CDN is executed. Source files and lesson packs are bounded and cached only in browser memory.</p><a href="${esc(safeLink(pack.upstream.licenseUrl))}" target="_blank" rel="noopener noreferrer">${esc(pack.upstream.repository)} · ${esc(pack.upstream.license)} license ↗</a>`;
  }

  $('library-select').innerHTML = catalog.libraries.map(library => `<option value="${esc(library.id)}">${esc(library.title)} · ${esc(library.version)}</option>`).join('');
  $('library-select').addEventListener('change',event => chooseLibrary(event.target.value));
  $('operation-select').addEventListener('change',() => { clearLesson(); renderNavigation(); });
  $('load-operation').addEventListener('click',() => loadOperation());
  $('library-navigation').addEventListener('click',event => {
    const operation = event.target.closest('[data-operation]'), library = event.target.closest('[data-library]');
    if (operation) loadOperation(operation.dataset.operation);
    else if (library) { chooseLibrary(library.dataset.library); setMode('libraries'); }
  });
  $('operation-cards').addEventListener('click',event => { const button = event.target.closest('[data-operation]'); if (button) loadOperation(button.dataset.operation); });
  $('mode-libraries').addEventListener('click',() => setMode('libraries'));
  $('mode-kernels').addEventListener('click',() => { setMode('kernels'); const snapshot = window.CuvisWorkbench.getSnapshot(); if (!snapshot.result) $('run-button').click(); });
  $('trace-operation').addEventListener('click',showKernel);
  $('back-to-overview').addEventListener('click',() => { setMode('libraries'); $('lesson').scrollIntoView({behavior:'instant',block:'start'}); });
  $('kernel-list').addEventListener('click',event => { if (event.target.closest('[data-kernel]')) setMode('kernels'); });
  document.querySelectorAll('[data-source-view]').forEach(button => button.addEventListener('click',() => {
    state.sourceView = button.dataset.sourceView; renderSource(); if (state.sourceView === 'upstream') fetchSource();
  }));
  $('source-network-state').addEventListener('click',event => { if (event.target.closest('#source-retry')) fetchSource(); });
  $('stage-cards').addEventListener('click',event => {
    const button = event.target.closest('[data-stage]'); if (!button) return;
    state.stage = Number(button.dataset.stage); renderStages(); renderSource();
    document.querySelector(`[data-stage="${state.stage}"]`)?.focus({preventScroll:true});
  });
  $('stage-trace-link').addEventListener('click',() => { if (window.CuvisWorkbench.seekLines(state.pack.stages[state.stage].cudaLines)) showKernel(); });
  $('tensor-select').addEventListener('change',event => { state.tensor = event.target.value; renderTensor(); });
  $('tensor-signature').addEventListener('click',event => { const button = event.target.closest('[data-tensor]'); if (button) { state.tensor = button.dataset.tensor; $('tensor-select').value = state.tensor; renderTensor(); $('tensor-lab-heading').scrollIntoView({behavior:'instant',block:'center'}); } });
  $('tensor-cells').addEventListener('click',event => {
    const cell = event.target.closest('[data-element]'); if (!cell || !state.result) return;
    if (window.CuvisWorkbench.seekMemory(state.tensor,Number(cell.dataset.element))) showKernel();
  });
  window.addEventListener('cuvis:step',event => {
    if (!state.pack || event.detail.presetId !== `pack-${state.pack.id}` || !event.detail.sourceMatches) return;
    const stage = explain.classifyEvent(state.pack,event.detail.event);
    const index = stage ? state.pack.stages.findIndex(item => item.id === stage.id) : -1;
    if (index >= 0 && index !== state.stage) { state.stage = index; renderStages(); renderSource(); }
  });
  window.addEventListener('cuvis:result',event => {
    if (!state.pack || event.detail.presetId !== `pack-${state.pack.id}` || !event.detail.sourceMatches) return;
    state.result = event.detail.result; renderSummary(); renderStages(); renderResult(); renderTensor();
  });
  window.addEventListener('cuvis:invalidated',() => {
    if (!state.pack) return;
    state.result = null; renderResult(); renderTensor(); renderStages();
  });
  window.addEventListener('cuvis:error',event => {
    if (!state.pack || event.detail.presetId !== `pack-${state.pack.id}`) return;
    $('lesson-result-status').textContent = 'RUN NEEDS ATTENTION';
    $('operation-observations').textContent = event.detail.message;
  });
  const dialog = $('snippet-dialog');
  $('snippet-open').addEventListener('click',() => { dialog.showModal(); $('snippet-input').focus(); });
  $('snippet-close').addEventListener('click',() => dialog.close());
  $('snippet-match').addEventListener('click',() => {
    const match = explain.matchSnippet($('snippet-input').value,catalog);
    $('snippet-results').innerHTML = `<p>${esc(match.message)}</p>${match.matches.map(item => `<button data-match="${esc(item.id)}"><span>${esc(operationById(item.id)?.title || item.id)}<small>${esc(item.reason)}</small></span><b>↗</b></button>`).join('')}`;
  });
  $('snippet-results').addEventListener('click',event => { const button = event.target.closest('[data-match]'); if (button) { dialog.close(); loadOperation(button.dataset.match); } });
  window.addEventListener('cuvis:open-lesson',event => {
    if (typeof event.detail?.id === 'string') loadOperation(event.detail.id);
  });
  window.addEventListener('cuvis:explorer-path',event => {
    if (event.detail?.path === 'live') { cancelPending(); window.CuvisWorkbench.cancel(); }
  });
  window.addEventListener('beforeunload',cancelPending);
  chooseLibrary(catalog.libraries[0].id);
  setMode('libraries');
})();
