/* cuvis workbench: all playback is driven by the worker's recorded trace. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const number = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US', {maximumFractionDigits: 4}) : String(value);
  const library = window.KernelLibrary || [];
  const state = {preset: null, result: null, before: {}, steps: [], index: 0, playing: false, timer: null, worker: null, timeout: null, runId: 0, running: false, view: 'threads', inspector: 'trace', block: 0, request: 0, assistantSession: null, assistantRequest: 0, assistantSelection: null};
  const editor = $('code-editor');
  const categories = [
    {label:'FUNDAMENTALS', ids:['vector-add','reduction','matmul'], icon:'code'},
    {label:'NEURAL BUILDING BLOCKS', ids:['mlp-linear-relu','cnn-valid-conv1d','lm-head'], icon:'layers'},
    {label:'UNDER THE HOOD', ids:['strided-access','divergent-branches'], icon:'chip'},
  ];
  const displayNames = {'vector-add':'Vector addition','reduction':'Parallel reduction','matmul':'Matrix multiplication','mlp-linear-relu':'MLP · Linear + ReLU','cnn-valid-conv1d':'CNN · Convolution','lm-head':'LM head · Projection','strided-access':'Strided memory','divergent-branches':'Warp divergence'};
  const groupName = preset => preset.category === 'machine-learning' ? 'Neural networks' : ['memory-access','control-flow'].includes(preset.category) ? 'GPU internals' : 'Fundamentals';

  function renderLibrary(query = '') {
    const q = query.trim().toLowerCase();
    let found = 0;
    $('kernel-list').innerHTML = categories.map(group => {
      const items = library.filter(p => group.ids.includes(p.id) && `${p.title} ${p.shortName} ${p.description}`.toLowerCase().includes(q));
      found += items.length;
      if (!items.length) return '';
      return `<div class="kernel-group"><div class="kernel-group-title">${group.label}<span>${String(items.length).padStart(2,'0')}</span></div>${items.map(p => `<button class="kernel-item ${state.preset?.id === p.id ? 'active' : ''}" data-kernel="${esc(p.id)}" aria-pressed="${state.preset?.id === p.id}" title="${esc(p.description)}">${icon(group.icon)}<span>${esc(displayNames[p.id] || p.shortName)}</span><span class="item-tail">${state.preset?.id === p.id ? '↗' : ''}</span></button>`).join('')}</div>`;
    }).join('');
    $('search-empty').hidden = found > 0;
  }

  function highlight(code) {
    const pattern = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|\b(?:__global__|__shared__|const|float|double|int|unsigned|void|if|else|for|while|return|bool)\b|\b(?:threadIdx|blockIdx|blockDim|gridDim|__syncthreads|atomicAdd|fmaxf|expf|sqrtf|printf)\b|\b\d+(?:\.\d+)?f?\b)/g;
    let result = '', end = 0;
    for (const match of code.matchAll(pattern)) {
      result += esc(code.slice(end, match.index));
      const token = match[0];
      const type = token.startsWith('//') || token.startsWith('/*') ? 'comment' : token.startsWith('"') ? 'string' : /^\d/.test(token) ? 'number' : /^(threadIdx|blockIdx|blockDim|gridDim|__syncthreads|atomicAdd|fmaxf|expf|sqrtf|printf)$/.test(token) ? 'builtin' : 'keyword';
      result += token.split('\n').map(part => `<span class="syntax-${type}">${esc(part)}</span>`).join('\n');
      end = match.index + token.length;
    }
    return result + esc(code.slice(end));
  }

  function renderEditor() {
    const currentLine = state.steps[state.index]?.line;
    $('code-highlight').innerHTML = highlight(editor.value).split('\n').map((line,i) => `<span class="code-line ${currentLine === i + 1 ? 'current' : ''}">${line || ' '}</span>`).join('');
    $('line-numbers').innerHTML = editor.value.split('\n').map((_,i) => `<span class="${currentLine === i + 1 ? 'current' : ''}">${i + 1}</span>`).join('');
    $('dirty-dot').hidden = editor.value === state.preset?.code;
    syncScroll();
    updateCursor();
  }

  function syncScroll() {
    $('code-highlight').style.transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`;
    $('line-numbers').scrollTop = editor.scrollTop;
  }

  function updateCursor() {
    const lines = editor.value.slice(0, editor.selectionStart).split('\n');
    $('source-location').textContent = `Ln ${lines.length}, Col ${lines.at(-1).length + 1}`;
  }

  function getLaunch(validate = false) {
    const gx = Number($('grid-input').value), bx = Number($('block-input').value), n = Number($('n-input').value);
    const gy = state.preset?.grid[1] || 1, by = state.preset?.block[1] || 1;
    if (validate && (!Number.isInteger(gx) || gx < 1 || gx > 64 || !Number.isInteger(bx) || bx < 1 || bx * by > 1024 || !Number.isInteger(n) || n < 1 || n > 4096 || gx * gy * bx * by > 65536)) {
      throw new Error('Use integer launch dimensions: grid 1–64, at most 1,024 threads per block, at most 65,536 threads total, and N 1–4,096.');
    }
    return {gx, gy, bx, by, n, blocks:gx * gy, threads:bx * by, total:gx * gy * bx * by};
  }

  function updateLaunch() {
    const launch = getLaunch();
    let name = state.preset?.filename.replace('.cu','') || 'kernel';
    try { name = window.CudaSim.parseKernel(editor.value).name; } catch { /* Incomplete edits are allowed. */ }
    const blockLabel = launch.by > 1 ? `(${launch.bx}, ${launch.by})` : launch.bx;
    $('launch-code').textContent = `${name}<<<${launch.gx}, ${blockLabel}>>>`;
    $('launch-thread-count').textContent = `${number(launch.total)} threads${launch.by > 1 ? ' · 2D block' : ''}`;
  }

  function status(message, type = '') {
    $('run-status').textContent = message;
    $('run-status').className = `run-status ${type}`;
  }

  function stopPlayback() {
    state.playing = false;
    clearTimeout(state.timer);
    $('trace-play').classList.remove('is-playing');
    $('trace-play').innerHTML = icon('play');
    $('trace-play').setAttribute('aria-label','Play trace');
  }

  function stopWorker() {
    state.runId++;
    clearTimeout(state.timeout);
    state.worker?.terminate();
    state.worker = null;
    state.running = false;
    $('run-label').textContent = 'Run kernel';
    $('run-button').classList.remove('running');
  }

  function invalidate(message) {
    stopWorker(); stopPlayback();
    state.result = null; state.steps = []; state.index = 0; state.block = 0; state.request = 0; state.before = {};
    $('error-panel').hidden = true;
    $('map-status').textContent = 'READY TO EXPLORE';
    renderMetrics(); renderEditor(); renderTrace(); renderMap(); renderOutputs(); renderConsole(); updateLaunch();
    if (message) status(message, 'modified');
    window.dispatchEvent(new CustomEvent('cuvis:invalidated', {detail:{presetId:state.preset?.id, sourceMatches:editor.value === state.preset?.code}}));
  }

  function selectPreset(id, autoRun = true) {
    const preset = library.find(p => p.id === id);
    if (!preset) return;
    state.preset = preset;
    editor.value = preset.code;
    editor.scrollTop = 0; editor.scrollLeft = 0;
    $('kernel-title').textContent = displayNames[preset.id] || preset.title;
    $('kernel-category').textContent = groupName(preset);
    $('editor-heading').textContent = preset.filename;
    $('grid-input').value = preset.grid[0]; $('block-input').value = preset.block[0]; $('n-input').value = preset.n;
    $('block-input').max = Math.floor(1024 / (preset.block[1] || 1));
    $('n-input').readOnly = preset.id !== 'vector-add';
    $('n-input').title = preset.id === 'vector-add' ? 'Input and output buffer length' : 'Fixed fixture size. Dimensions are explicit in this example’s source.';
    $('n-label').textContent = preset.id === 'vector-add' ? 'N' : 'Fixture N';
    invalidate('Ready. Run the kernel to inspect its execution.');
    renderLibrary($('kernel-search').value);
    window.dispatchEvent(new CustomEvent('cuvis:preset', {detail:{presetId:preset.id, libraryPack:preset.libraryPack || null}}));
    if (autoRun) runKernel();
  }

  function buildBuffers(parsed, n) {
    const buffers = state.preset.buffers(n);
    for (const param of parsed.params) {
      if (!param.isPtr || buffers[param.name]) continue;
      const Type = /unsigned/.test(param.type) ? Uint32Array : /int|short|char/.test(param.type) ? Int32Array : Float32Array;
      buffers[param.name] = Type.from({length:n}, (_,i) => param.isConst ? (i % 16) / 4 : 0);
    }
    return buffers;
  }

  function runKernel() {
    if (state.running) {
      invalidate('Execution canceled. Your source is unchanged; run again when ready.');
      return;
    }
    invalidate();
    try {
      const launch = getLaunch(true);
      const parsed = window.CudaSim.parseKernel(editor.value);
      const buffers = buildBuffers(parsed, launch.n), scalars = {};
      for (const p of parsed.params) if (!p.isPtr) {
        if (p.name !== 'n' && p.name !== 'N') throw new Error(`Scalar “${p.name}” needs an explicit value. This playground supplies n / N from the launch configuration.`);
        scalars[p.name] = launch.n;
      }
      state.before = Object.fromEntries(Object.entries(buffers).map(([key,value]) => [key, Array.from(value)]));
      state.worker = new Worker('sim-worker.js');
      const runId = state.runId;
      state.running = true;
      $('run-label').textContent = 'Cancel run';
      $('map-status').textContent = 'EXECUTING';
      status('Executing in an isolated browser worker. You can cancel at any time.');
      state.timeout = setTimeout(() => {
        if (runId !== state.runId) return;
        stopWorker();
        showError('Execution stopped after 8 seconds. Reduce the launch size or check loops and barriers. The editor is still available.');
      }, 8000);
      state.worker.onerror = event => {
        if (runId !== state.runId) return;
        stopWorker(); showError(event.message || 'The simulation worker could not start. Serve this project over HTTP.');
      };
      state.worker.onmessage = event => {
        if (runId !== state.runId) return;
        const response = event.data;
        stopWorker();
        if (!response.ok) { showError(response.error); return; }
        state.result = response;
        state.steps = response.executionTrace || [];
        state.index = 0;
        const isOriginal = editor.value === state.preset.code;
        let reference = '';
        if (isOriginal) {
          const expected = state.preset.expected(launch.n, state.before);
          const actual = response.buffers[state.preset.outputBuffer];
          const correct = actual && actual.length === expected.length && Array.from(actual).every((value,i) => Number.isFinite(value) && Math.abs(value - expected[i]) <= 1e-5 * Math.max(1,Math.abs(expected[i])));
          reference = correct ? 'Output matches the CPU reference.' : 'Output differs from the CPU reference; check launch coverage.';
          state.referenceCorrect = correct;
        }
        if (response.deadlock) {
          showError('Barrier deadlock: not every thread reached the same block barrier. The trace and buffers show partial execution, not a completed result.');
        } else {
          $('map-status').textContent = 'TRACE CAPTURED';
          status(`Kernel complete · ${number(response.launch.total)} threads. ${reference || 'Custom source executed; inspect the output buffers.'}`, reference && !state.referenceCorrect ? 'modified' : 'success');
        }
        renderMetrics(); renderTrace(); renderMap(); renderOutputs(); renderConsole(); renderEditor();
        window.dispatchEvent(new CustomEvent('cuvis:result', {detail:{presetId:state.preset.id,result:response,sourceMatches:isOriginal,referenceCorrect:state.referenceCorrect}}));
      };
      state.worker.postMessage({source:editor.value, grid:[launch.gx,launch.gy], block:[launch.bx,launch.by], buffers, scalars, dynShmemBytes:state.preset.sharedBytes || 0, focusBlock:0, traceLimit:12000});
    } catch (error) {
      stopWorker(); showError(error.message);
    }
  }

  function showError(message) {
    $('error-panel').textContent = message;
    $('error-panel').hidden = false;
    $('map-status').textContent = 'CHECK SOURCE';
    status('The kernel needs attention. Fix the source or reset the example.','modified');
    window.dispatchEvent(new CustomEvent('cuvis:error', {detail:{presetId:state.preset?.id,message}}));
  }

  function renderMetrics() {
    const result = state.result;
    $('metric-threads').textContent = result ? number(result.launch.total) : '—';
    $('metric-blocks').textContent = result ? `${result.launch.numBlocks} blocks` : 'ready';
    $('metric-accesses').textContent = result ? number((result.counts.gld || 0) + (result.counts.gst || 0)) : '—';
    $('metric-coalescing').textContent = result?.coalescing ? `${number(result.coalescing.efficiency * 100)}%` : '—';
    $('metric-events').textContent = result ? number(state.steps.length) : '—';
    $('metric-trace-note').textContent = result?.traceMeta?.truncated ? 'capped' : 'captured';
    $('trace-count').textContent = number(state.steps.length);
  }

  function syncAssistantUI() {
    const event = currentEvent();
    const selection = event ? `${state.runId}:${state.index}` : `empty:${state.runId}`;
    if (selection !== state.assistantSelection) {
      state.assistantSelection = selection;
      state.assistantRequest++;
      $('assistant-answer').hidden = true;
      $('assistant-status').textContent = state.assistantSession
        ? 'On-device AI is ready. Ask about the selected trace step.'
        : 'Off. The recorded trace explanation remains available.';
    }
    $('assistant-button').disabled = !event || state.running;
    $('assistant-button').textContent = state.assistantSession ? 'Explain this step with AI' : 'Enable on-device AI & explain this step';
    $('assistant-disable').hidden = !state.assistantSession;
  }

  async function explainCurrentStep() {
    const event = currentEvent();
    if (!event || state.running) return;
    const selection = `${state.runId}:${state.index}`;
    const request = ++state.assistantRequest;
    const current = () => request === state.assistantRequest && selection === `${state.runId}:${state.index}` && Boolean(currentEvent());
    $('assistant-button').disabled = true;
    $('assistant-answer').hidden = true;
    $('assistant-status').textContent = 'Checking Chrome’s on-device model…';
    $('assistant-disable').hidden = false;
    try {
      if (!state.assistantSession) {
        const result = await CUVIS_ON_DEVICE_ASSISTANT.createSession(undefined, loaded => {
          if (current() && Number.isFinite(loaded)) {
            $('assistant-status').textContent = `Downloading Chrome’s on-device model: ${Math.round(loaded * 100)}%`;
          }
        });
        if (!current()) {
          result.session?.destroy();
          return;
        }
        if (result.status !== 'ready') {
          $('assistant-status').textContent = result.status === 'unsupported'
            ? 'This browser does not expose Chrome’s on-device model. The recorded explanation above still works.'
            : 'Chrome’s on-device model is unavailable on this device. The recorded explanation above still works.';
          $('assistant-disable').hidden = true;
          return;
        }
        state.assistantSession = result.session;
        $('assistant-button').textContent = 'Explain this step with AI';
      }
      $('assistant-status').textContent = 'Asking the on-device model…';
      const prompt = CUVIS_ON_DEVICE_ASSISTANT.buildPrompt({preset: state.preset, steps: state.steps, index: state.index});
      const answer = await state.assistantSession.prompt(prompt);
      if (!current()) return;
      $('assistant-answer').textContent = answer.trim() || 'The model did not return an explanation. Use the recorded explanation above.';
      $('assistant-answer').hidden = false;
      $('assistant-status').textContent = 'AI-generated suggestion. Check it against the recorded trace.';
      $('assistant-disable').hidden = false;
    } catch {
      if (current()) {
        $('assistant-status').textContent = 'The on-device model could not answer. Your recorded explanation remains available.';
        $('assistant-disable').hidden = !state.assistantSession;
      }
    } finally {
      if (current()) $('assistant-button').disabled = false;
    }
  }

  function disableAssistant() {
    state.assistantRequest++;
    state.assistantSession?.destroy();
    state.assistantSession = null;
    $('assistant-answer').hidden = true;
    $('assistant-disable').hidden = true;
    $('assistant-status').textContent = 'AI off. The recorded trace explanation remains available.';
    $('assistant-button').textContent = 'Enable on-device AI & explain this step';
    $('assistant-button').disabled = !currentEvent() || state.running;
  }

  function currentEvent() { return state.steps[state.index]; }
  function eventBlock(event) { return Number(event?.blockId ?? (typeof event?.block === 'number' ? event.block : 0)); }
  function eventThread(event) { return Number(event?.threadId ?? (typeof event?.thread === 'number' ? event.thread : 0)); }

  function renderMap() {
    const content = $('map-content');
    content.setAttribute('aria-labelledby', `tab-${state.view}`);
    if (state.view === 'memory') { renderMemory(); return; }
    if (state.view === 'flow') { renderFlow(); return; }
    const launch = state.result?.launch || (() => { const l = getLaunch(); return {numBlocks:l.blocks,threadsPerBlock:l.threads,total:l.total}; })();
    const blockCount = Math.max(1,Math.min(64,launch.numBlocks || 1));
    const threads = Math.max(1,Math.min(1024,launch.threadsPerBlock || 1));
    const selectedBlock = Math.min(state.block,blockCount - 1);
    const event = currentEvent();
    const thread = eventBlock(event) === selectedBlock ? eventThread(event) : 0;
    const selectedWarp = Math.floor(thread / 32);
    const firstBlock = Math.floor(selectedBlock / 4) * 4;
    const blocks = Array.from({length:Math.min(4,blockCount - firstBlock)}, (_,i) => firstBlock + i);
    const meta = event?.details || event?.values || {};
    const hotCell = Number.isInteger(meta.index) ? meta.index % 32 : -1;
    const cells = Array.from({length:32},(_,i) => `<span class="memory-cell ${i === hotCell ? 'hot' : ''}"></span>`).join('');
    content.innerHTML = `<div class="map-breadcrumb"><strong>Grid</strong><span>/</span><span>${number(blockCount)} blocks</span><span>/</span><span>Block ${selectedBlock}</span><span class="right">LOGICAL TOPOLOGY</span></div><div class="memory-rail"><div class="memory-rail-label">Global memory<small>DEVICE BUFFERS</small></div><div class="memory-cells" aria-hidden="true">${cells}</div></div><svg class="bus-lines" viewBox="0 0 500 24" preserveAspectRatio="none" aria-hidden="true"><path d="M250 0V11H120V24M250 11H380V24"/><circle cx="250" cy="10" r="2"/></svg><div class="block-grid">${blocks.map(b => {
      const warps = Math.ceil(threads / 32), firstWarp = b === selectedBlock ? Math.floor(selectedWarp / 2) * 2 : 0;
      return `<button class="block-card ${b === selectedBlock ? 'selected' : ''}" data-block="${b}" aria-label="Inspect block ${b}" aria-pressed="${b === selectedBlock}"><div class="block-card-title"><span>Block ${String(b).padStart(2,'0')}</span><span>${threads} threads</span></div>${Array.from({length:Math.min(2,warps - firstWarp)},(_,w) => {
        const warp = firstWarp + w;
        return `<div class="warp-row ${b === selectedBlock && warp === selectedWarp ? 'selected' : ''}"><span class="warp-name">W${warp}</span><div class="lanes">${Array.from({length:32},(_,lane) => `<span class="lane ${warp * 32 + lane >= threads ? 'inactive' : ''} ${event && b === eventBlock(event) && warp * 32 + lane === eventThread(event) ? 'current' : ''}" title="Thread ${warp * 32 + lane}"></span>`).join('')}</div></div>`;
      }).join('')}${warps > 2 ? `<div class="block-more">Warps ${firstWarp}–${Math.min(firstWarp+1,warps-1)} of ${warps}</div>` : ''}</button>`;
    }).join('')}</div><div class="map-summary"><span><strong>${number(launch.total)}</strong> threads · <strong>${number(Math.ceil(threads / 32) * blockCount)}</strong> warps</span><span>${blockCount > 4 ? `Showing blocks ${firstBlock}–${firstBlock+blocks.length-1} · ` : ''}Block <strong>${selectedBlock}</strong> / Warp <strong>${selectedWarp}</strong></span></div>`;
  }

  function renderMemory() {
    const coal = state.result?.coalescing;
    const requests = coal?.requests || [];
    const request = requests[Math.min(state.request, requests.length - 1)];
    $('map-content').innerHTML = `<div class="memory-view-title"><span>Lane → 32-byte sector</span><span>BLOCK 0</span></div>${requests.length ? `<label class="sr-only" for="memory-request">Memory request</label><select id="memory-request" class="memory-request-select">${requests.map((r,i) => `<option value="${i}" ${state.request === i ? 'selected' : ''}>${r.rw === 'r' ? 'Load' : 'Store'} ${esc(r.buf)} · warp ${r.warp} · request ${i+1}</option>`).join('')}</select>` : ''}<p class="memory-explainer">${request ? `${request.lanes.length} recorded lanes ${request.rw === 'r' ? 'read from' : 'write to'} <strong>${esc(request.buf)}</strong>. Each cell shows the addressed 32-byte sector—not a measured hardware transaction.` : 'Run a kernel to map each lane’s global-memory address into a 32-byte sector.'}</p><div class="memory-lane-grid">${Array.from({length:32},(_,lane) => { const access = request?.lanes.find(l => l.lane === lane); return `<span class="memory-lane ${access ? '' : 'empty'}" title="Lane ${lane}${access ? ` · byte ${access.byte}` : ' · no recorded access'}">${access ? Math.floor(access.byte / 32) : '·'}</span>`; }).join('')}</div><div class="memory-stat-row"><div class="memory-stat"><strong>${request ? request.sectors : '—'}</strong><span>addressed sectors</span></div><div class="memory-stat"><strong>${request ? request.ideal : '—'}</strong><span>ideal sectors</span></div><div class="memory-stat"><strong>${coal ? number(coal.efficiency*100)+'%' : '—'}</strong><span>aggregate efficiency</span></div></div><p class="flow-note">Access grouping is an analytical estimate. Request list capped at 160.</p>`;
  }

  function renderFlow() {
    const original = editor.value === state.preset.code;
    const stages = original ? state.preset.stages : [
      {label:'Launch the grid',detail:'Create threads using the configured grid and block dimensions.'},
      {label:'Execute the source',detail:'Interpret supported statements and record source-linked state changes.'},
      {label:'Inspect the result',detail:'Read the actual output buffers and memory-access trace.'},
    ];
    $('map-content').innerHTML = `<div class="map-breadcrumb"><strong>${original ? esc(state.preset.shortName) : 'Custom kernel'}</strong><span>/</span><span>Algorithm overview</span></div><div class="flow-nodes">${stages.map((stage,i) => `${i ? '<div class="flow-connector">↓</div>' : ''}<div class="flow-node"><span class="flow-number">${String(i+1).padStart(2,'0')}</span><div><strong>${esc(stage.label)}</strong><p>${esc(stage.detail)}</p></div></div>`).join('')}</div><p class="flow-note">${original ? 'Authored algorithm guide. The execution trace below records what actually ran.' : 'Generic interpreter flow. Source-specific explanations are recorded in the trace below.'}</p>`;
  }

  function setStep(index, scrollSource = true) {
    state.index = Math.max(0,Math.min(state.steps.length - 1,Number(index) || 0));
    const event = currentEvent();
    if (event) state.block = eventBlock(event);
    renderTrace(); renderMap(); renderEditor();
    window.dispatchEvent(new CustomEvent('cuvis:step', {detail:{presetId:state.preset?.id,event,sourceMatches:editor.value === state.preset?.code}}));
    if (scrollSource && event?.line) {
      const lineHeight = parseFloat(getComputedStyle(editor).lineHeight), y = (event.line - 1) * lineHeight;
      if (y < editor.scrollTop || y + lineHeight > editor.scrollTop + editor.clientHeight - 30) {
        editor.scrollTop = Math.max(0,y - editor.clientHeight / 3); syncScroll();
      }
    }
  }

  function renderTrace() {
    const event = currentEvent();
    syncAssistantUI();
    $('trace-scrubber').max = Math.max(0,state.steps.length - 1);
    $('trace-scrubber').value = state.index;
    $('trace-scrubber').disabled = !event;
    $('step-label').textContent = `${event ? number(state.index+1) : 0} / ${number(state.steps.length)}`;
    for (const id of ['trace-start','trace-prev','trace-play','trace-next']) $(id).disabled = !event;
    $('trace-start').disabled = !event || state.index === 0;
    $('trace-prev').disabled = !event || state.index === 0;
    $('trace-next').disabled = !event || state.index >= state.steps.length - 1;
    $('event-kind').textContent = event?.kind?.replaceAll('-',' ') || 'READY';
    $('event-location').textContent = event ? `Line ${event.line} · Block ${eventBlock(event)} · Thread ${eventThread(event)}` : 'Explore the execution';
    $('explanation-title').textContent = event ? (event.source || editor.value.split('\n')[event.line-1] || 'Source event').trim() : 'A thousand threads. One clear picture.';
    $('explanation-text').textContent = event?.explanation || 'Run a kernel to record its execution, then step through the source to see exactly what each thread does.';
    $('state-thread').textContent = event ? `b${eventBlock(event)} · t${eventThread(event)}` : '—';
    const values = event ? {...(event.values || {}), ...(event.details || {})} : {};
    const primitives = Object.entries(values).filter(([key,v]) => key !== 'statement' && v !== null && ['number','string','boolean'].includes(typeof v));
    if (event) primitives.unshift(['threadIdx.x',eventThread(event) % (state.result?.launch.bx || 32)],['blockIdx.x',eventBlock(event) % (state.result?.launch.gx || 1)]);
    $('state-values').innerHTML = primitives.length ? primitives.slice(0,8).map(([key,value]) => `<div class="state-value"><span title="${esc(key)}">${esc(key)}</span><b title="${esc(value)}">${esc(typeof value === 'number' ? number(value) : String(value).slice(0,28))}</b></div>`).join('') : '<span class="muted">Values will appear as you step.</span>';
    const meta = state.result?.traceMeta;
    $('trace-footnote').textContent = meta?.truncated ? `Trace capped at ${number(state.steps.length)} events. Playback covers a prefix; buffers ${state.result.deadlock ? 'contain partial execution' : 'reflect the completed run'}.` : 'Source-level execution order, not a cycle-accurate GPU schedule.';
  }

  function play() {
    if (state.playing) { stopPlayback(); return; }
    if (!state.steps.length) return;
    if (state.index >= state.steps.length - 1) setStep(0);
    state.playing = true;
    $('trace-play').textContent = 'Ⅱ';
    $('trace-play').classList.add('is-playing');
    $('trace-play').setAttribute('aria-label','Pause trace');
    const tick = () => {
      if (!state.playing) return;
      if (state.index >= state.steps.length - 1) { stopPlayback(); return; }
      setStep(state.index+1);
      state.timer = setTimeout(tick,Number($('trace-speed').value));
    };
    state.timer = setTimeout(tick,Number($('trace-speed').value));
  }

  function renderOutputs() {
    const buffers = state.result?.buffers;
    if (!buffers) { $('output-pane').innerHTML = '<p class="output-info">Run a kernel to inspect its actual buffers. Inputs are deterministic fixtures; highlighted cells changed during execution.</p>'; return; }
    $('output-pane').innerHTML = `<p class="output-info">${state.result.deadlock ? 'Partial buffers: execution stopped at a deadlock.' : 'Final buffers after execution.'} Highlighted cells differ from the input fixture. Showing the first 48 elements of each buffer.</p>${Object.entries(buffers).sort(([a],[b]) => Number(b === state.preset.outputBuffer) - Number(a === state.preset.outputBuffer)).map(([name,buffer]) => `<div class="buffer-title"><span>${esc(name)}${name === state.preset.outputBuffer ? ' · output' : ''}</span><small>${buffer.length} elements · ${esc(buffer.constructor.name)}</small></div><div class="buffer-grid">${Array.from(buffer).slice(0,48).map((value,i) => `<span class="buffer-cell ${value !== state.before[name]?.[i] ? 'changed' : ''}" title="${esc(name)}[${i}] = ${esc(value)}; before = ${esc(state.before[name]?.[i])}"><small>[${i}]</small>${esc(number(value))}</span>`).join('')}</div>`).join('')}`;
  }

  function renderConsole() {
    const lines = state.result?.printfLines || [];
    $('console-count').textContent = lines.length;
    $('console-pane').textContent = lines.length ? lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') : state.result ? 'Kernel completed without device printf output.\nAdd printf("thread %d\\n", threadIdx.x); to inspect a value.' : 'No device output yet. Run a kernel to begin.';
  }

  function setMapView(view) {
    state.view = view;
    document.querySelectorAll('[data-view]').forEach(button => {
      const active = button.dataset.view === view;
      button.classList.toggle('active',active); button.setAttribute('aria-selected',active); button.tabIndex = active ? 0 : -1;
    });
    renderMap();
  }

  function setInspector(view) {
    state.inspector = view;
    document.querySelectorAll('[data-inspector]').forEach(button => {
      const active = button.dataset.inspector === view;
      button.classList.toggle('active',active); button.setAttribute('aria-selected',active); button.tabIndex = active ? 0 : -1;
    });
    ['trace','output','console'].forEach(name => { $(`${name}-pane`).hidden = view !== name; });
  }

  $('kernel-list').addEventListener('click',event => { const button = event.target.closest('[data-kernel]'); if (button) selectPreset(button.dataset.kernel); });
  $('kernel-search').addEventListener('input',event => renderLibrary(event.target.value));
  $('run-button').addEventListener('click',runKernel);
  $('reset-code').addEventListener('click',() => selectPreset(state.preset.id));
  editor.addEventListener('input',() => invalidate('Source changed. Run the kernel to generate a fresh trace.'));
  editor.addEventListener('scroll',syncScroll);
  editor.addEventListener('click',updateCursor);
  editor.addEventListener('keyup',updateCursor);
  editor.addEventListener('keydown',event => {
    if (event.key === 'Escape') { editor.dataset.tabEscape = 'true'; return; }
    if (event.key !== 'Tab' || event.shiftKey) return;
    if (editor.dataset.tabEscape) { delete editor.dataset.tabEscape; return; }
    event.preventDefault();
    const start = editor.selectionStart;
    editor.setRangeText('  ',start,editor.selectionEnd,'end');
    editor.dispatchEvent(new Event('input'));
  });
  ['grid-input','block-input','n-input'].forEach(id => $(id).addEventListener('input',() => invalidate('Launch changed. Run again to refresh the trace and output.')));
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click',() => setMapView(button.dataset.view)));
  document.querySelectorAll('[data-inspector]').forEach(button => button.addEventListener('click',() => setInspector(button.dataset.inspector)));
  document.querySelectorAll('[role=tablist]').forEach(tablist => tablist.addEventListener('keydown',event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const tabs = Array.from(tablist.querySelectorAll('[role=tab]'));
    const current = tabs.indexOf(document.activeElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length-1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[index].click(); tabs[index].focus();
  }));
  $('map-content').addEventListener('click',event => {
    const button = event.target.closest('[data-block]');
    if (!button) return;
    stopPlayback(); state.block = Number(button.dataset.block);
    const index = state.steps.findIndex(step => eventBlock(step) === state.block);
    if (index >= 0) setStep(index); else renderMap();
  });
  $('map-content').addEventListener('change',event => { if (event.target.id === 'memory-request') { state.request = Number(event.target.value); renderMemory(); $('memory-request')?.focus(); } });
  $('trace-start').addEventListener('click',() => { stopPlayback(); setStep(0); });
  $('trace-prev').addEventListener('click',() => { stopPlayback(); setStep(state.index-1); });
  $('trace-next').addEventListener('click',() => { stopPlayback(); setStep(state.index+1); });
  $('trace-play').addEventListener('click',play);
  $('trace-scrubber').addEventListener('input',event => { stopPlayback(); setStep(event.target.value); });
  const dialog = $('guide-dialog');
  ['guide-open','model-open'].forEach(id => $(id).addEventListener('click',() => dialog.showModal()));
  ['guide-close','guide-done'].forEach(id => $(id).addEventListener('click',() => dialog.close()));
  dialog.addEventListener('click',event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
  document.addEventListener('keydown',event => {
    if (event.defaultPrevented || document.querySelector('dialog[open]')) return;
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); runKernel(); return; }
    if (/INPUT|TEXTAREA|SELECT|BUTTON/.test(event.target.tagName)) return;
    if (event.key === '/' && matchMedia('(min-width:701px)').matches && $('kernel-search').getClientRects().length) { event.preventDefault(); $('kernel-search').focus(); }
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && state.steps.length) { event.preventDefault(); stopPlayback(); setStep(state.index+(event.key === 'ArrowRight' ? 1 : -1)); }
    if (event.key === ' ' && state.steps.length) { event.preventDefault(); play(); }
  });
  $('assistant-button').addEventListener('click', explainCurrentStep);
  $('assistant-disable').addEventListener('click', disableAssistant);
  document.addEventListener('visibilitychange',() => { if (document.hidden) stopPlayback(); });
  window.addEventListener('beforeunload',() => { stopWorker(); stopPlayback(); state.assistantSession?.destroy(); });
  window.CuvisWorkbench = Object.freeze({
    loadPack(pack) {
      const kernel = pack.kernel;
      const preset = {
        id: `pack-${pack.id}`, title:pack.title, shortName:pack.title, category:'machine-learning',
        description:pack.summary, filename:`${kernel.name}.cu`, code:kernel.code,
        grid:kernel.grid, block:kernel.block, n:kernel.n, sharedBytes:kernel.sharedBytes,
        outputBuffer:kernel.outputBuffer, libraryPack:pack.id,
        stages:pack.stages.map(stage => ({label:stage.title,detail:stage.summary})),
        buffers:() => Object.fromEntries(Object.entries(kernel.buffers).map(([name,buffer]) =>
          [name, buffer.dtype === 'int32' ? Int32Array.from(buffer.values) : Float32Array.from(buffer.values)])),
        expected:() => kernel.expected,
      };
      const existing = library.findIndex(item => item.id === preset.id);
      if (existing >= 0) library[existing] = preset; else library.push(preset);
      selectPreset(preset.id);
    },
    seekLines(lines) {
      if (editor.value !== state.preset?.code) return false;
      const index = state.steps.findIndex(event => lines.includes(event.line));
      if (index < 0) return false;
      stopPlayback(); setInspector('trace'); setStep(index); return true;
    },
    seekMemory(buffer, element) {
      if (editor.value !== state.preset?.code) return false;
      const index = state.steps.findIndex(event => event.details?.buffer === buffer && event.details?.index === element);
      if (index < 0) return false;
      stopPlayback(); setInspector('trace'); setStep(index); return true;
    },
    cancel() { invalidate('Execution canceled.'); },
    getSnapshot:() => ({presetId:state.preset?.id,result:state.result,sourceMatches:editor.value === state.preset?.code}),
  });
  if (!library.length) { showError('The kernel library could not load. Serve the web directory over HTTP and reload.'); return; }
  selectPreset(library[0].id, false);
})();
