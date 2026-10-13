/* Discovery and inspection never execute downloaded package code. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const size = bytes => `${(bytes / 1024).toFixed(1)} KiB`;
  const pageSize = 100;
  const state = {path:'live',generation:0,controller:null,busy:false,metadata:null,listing:null,source:null,analysis:null,lines:[],symbol:null,page:0};
  const loader = window.PackageLoader?.createLoader();

  function setPath(path) {
    state.path = path;
    const live = path === 'live', libraryMode = document.body.classList.contains('library-mode');
    document.body.classList.toggle('live-package-mode',live && libraryMode);
    $('explore-live').classList.toggle('active',live);
    $('explore-live').setAttribute('aria-pressed',live);
    $('explore-guided').classList.toggle('active',!live);
    $('explore-guided').setAttribute('aria-pressed',!live);
    $('package-explorer').hidden = !live;
    $('guided-library-panel').hidden = live;
    $('package-navigation').hidden = !live || !libraryMode;
    $('library-navigation').hidden = live || !libraryMode;
    if (libraryMode) {
      $('workspace-eyebrow').textContent = live ? 'NO FIXED CATALOG. NO BLACK BOX.' : 'OPEN SOURCE. OPENED UP.';
      $('workspace-title').innerHTML = live ? 'Any package. <span>Look inside.</span>' : 'One library call. <span>The whole picture.</span>';
      $('workspace-subtitle').textContent = live ? 'Discover real source, follow its structure, and connect it to the ideas behind AI.' : 'From familiar APIs to the math, tensors, and threads that make AI work.';
    }
    if (live) $('kernel-workspace').hidden = true;
    else cancelRequest(false);
    window.dispatchEvent(new CustomEvent('cuvis:explorer-path',{detail:{path}}));
  }

  function setBusy(busy) {
    state.busy = busy;
    $('package-cancel').hidden = !busy;
    $('package-discover').disabled = busy;
    $('package-list-files').disabled = busy || !state.metadata;
    $('package-open-file').disabled = busy || !$('package-file').value || !state.listing;
    $('package-file').disabled = busy || !state.listing;
    $('package-file-filter').disabled = busy || !state.listing;
  }

  function cancelRequest(announce = true) {
    const wasBusy = state.busy;
    state.generation++;
    state.controller?.abort(); state.controller = null;
    setBusy(false);
    if (announce && wasBusy) $('package-status').textContent = 'Request canceled. Discover the package, refresh its file index, or open the selected file to retry.';
  }

  function beginRequest(message) {
    cancelRequest(false);
    state.controller = new AbortController();
    $('package-error').hidden = true;
    $('package-status').textContent = message;
    setBusy(true);
    const generation = state.generation;
    return {generation,options:{signal:state.controller.signal,onProgress:progress => {
      if (generation === state.generation) $('package-status').textContent = `${message} · ${size(progress.loaded)} received`;
    }}};
  }

  function fail(error, generation) {
    if (generation !== state.generation || error.name === 'AbortError') return;
    $('package-error').hidden = false;
    $('package-error').textContent = `${error.message}. Retry the same action, choose another file/version, or discover another package. No replacement source was substituted.`;
    $('package-status').textContent = 'The request could not complete. The guided lessons remain available.';
  }

  function clearSource() {
    state.source = null; state.analysis = null; state.lines = []; state.symbol = null; state.page = 0;
    $('package-inspection').hidden = true;
    $('package-empty').hidden = false;
    $('package-source-code').textContent = '';
  }

  function clearFiles() {
    state.listing = null;
    $('package-file').replaceChildren();
    $('package-file-filter').value = '';
    $('package-file-count').textContent = 'Select a version to discover its file index.';
    clearSource();
  }

  function clearPackage() {
    cancelRequest(false);
    state.metadata = null; clearFiles();
    $('package-browser').hidden = true;
    $('package-error').hidden = true;
    $('package-status').textContent = 'Package name changed. Discover it to request fresh metadata.';
    setBusy(false);
  }

  async function discover(event) {
    event?.preventDefault();
    if (!loader || !window.SourceAnalyzer) return;
    const name = $('package-name').value.trim();
    clearPackage();
    const request = beginRequest(`Discovering versions of ${name}`);
    try {
      const metadata = await loader.discover(name,request.options);
      if (request.generation !== state.generation) return;
      state.metadata = metadata;
      $('package-discovered-name').textContent = metadata.name;
      $('package-registry-link').href = `https://www.npmjs.com/package/${metadata.name}`;
      $('package-version').innerHTML = metadata.versions.map(version => `<option value="${esc(version)}">${esc(version)}${version === metadata.latest ? ' · latest tag' : ''}</option>`).join('');
      if (metadata.latest && metadata.versions.includes(metadata.latest)) $('package-version').value = metadata.latest;
      $('package-browser').hidden = false;
      setBusy(false);
      await listFiles();
    } catch (error) { fail(error,request.generation); }
    finally { if (request.generation === state.generation) setBusy(false); }
  }

  async function listFiles() {
    if (!state.metadata) return;
    clearFiles();
    const name = state.metadata.name, version = $('package-version').value;
    const request = beginRequest(`Discovering file index for ${name}@${version}`);
    try {
      const listing = await loader.listFiles(name,version,request.options);
      if (request.generation !== state.generation) return;
      state.listing = listing;
      renderFileOptions();
      $('package-status').textContent = `Live index loaded for ${name}@${version}. No source file has been downloaded. Choose one to inspect.`;
    } catch (error) { fail(error,request.generation); }
    finally { if (request.generation === state.generation) setBusy(false); }
  }

  function renderFileOptions() {
    const previous = $('package-file').value;
    const query = $('package-file-filter').value.trim().toLowerCase();
    const files = state.listing?.files.filter(file => file.path.toLowerCase().includes(query)) || [];
    $('package-file').innerHTML = files.map(file => `<option value="${esc(file.path)}">${esc(file.path)} · ${size(file.size)}</option>`).join('');
    if (files.some(file => file.path === previous)) $('package-file').value = previous;
    if (previous !== $('package-file').value) clearSource();
    $('package-file-count').textContent = `${files.length} matching / ${state.listing?.files.length || 0} inspectable files · ${state.listing?.omitted || 0} omitted (binary, minified, maps, oversized, or index limit). File names are from this package's live index. LICENSE/README files are available when shipped.`;
    setBusy(state.busy);
  }

  async function openFile() {
    if (!state.listing || !$('package-file').value) return;
    clearSource();
    const listing = state.listing, path = $('package-file').value;
    const request = beginRequest(`Streaming only ${path}`);
    try {
      const source = await loader.loadFile(listing,path,request.options);
      if (request.generation !== state.generation) return;
      state.source = source;
      state.lines = source.text.replace(/\r\n?/g,'\n').split('\n');
      state.analysis = window.SourceAnalyzer.analyze(source.text,{path:source.path,language:source.language});
      state.symbol = null; state.page = 0;
      renderInspection();
      $('package-status').textContent = `${source.name}@${source.version} · ${source.path} · ${size(source.bytes)} · ${source.cached ? 'reused from memory' : 'selected file loaded'} · never executed`;
    } catch (error) { fail(error,request.generation); }
    finally { if (request.generation === state.generation) setBusy(false); }
  }

  function renderInspection() {
    const {source,analysis} = state;
    $('package-empty').hidden = true; $('package-inspection').hidden = false;
    $('package-file-origin').textContent = `${source.name} @ ${source.version}`;
    $('package-file-title').textContent = source.path;
    $('package-file-language').textContent = analysis.language;
    $('package-source-link').href = source.url;
    $('package-source-provenance').textContent = `Exact version ${source.version} · ${size(source.bytes)} · selected source from jsDelivr · no package execution`;
    $('package-symbol').innerHTML = '<option value="">Whole file overview</option>'+analysis.outline.map(symbol => `<option value="${esc(symbol.id)}">${esc(symbol.name)} · ${esc(symbol.kind)} · L${symbol.startLine}–${symbol.endLine}</option>`).join('');
    $('package-analysis-title').textContent = 'The file, as a collection.';
    $('package-analysis-summary').textContent = analysis.summary + (analysis.truncated ? '\n\nAnalysis limit reached: only a bounded portion of the source or symbol index was inspected. This is not an exhaustive overview.' : '');
    $('package-file-facts').innerHTML = [[analysis.lineCount,'SOURCE LINES'],[analysis.outline.length,'INDEXED SYMBOLS'],[analysis.imports.length,'VISIBLE IMPORTS']].map(([count,label]) => `<div><b>${count}</b><span>${label}</span></div>`).join('');
    $('package-file-observations').innerHTML = analysis.observations.map(value => `<li>${esc(value)}</li>`).join('');
    $('package-file-imports').innerHTML = (analysis.imports.length ? analysis.imports : ['No import declarations recognized by the structural scanner.']).map(value => `<li>${esc(value)}</li>`).join('');
    $('package-analysis-limits').innerHTML = `<ul>${analysis.limitations.map(value => `<li>${esc(value)}</li>`).join('')}</ul><p>Only files published in this npm package are discoverable. Availability on a public CDN does not establish permission to reuse the code: inspect the package's LICENSE/README or npm metadata. Source is untrusted read-only text. Dependencies, imports, and build/install scripts are not fetched or executed.</p><p>Versions and file lists are discovered dynamically; semantic equivalence is not. A related CUDA lesson, when offered, is a separate fixed-fixture teaching model and is never advertised as a translation of this source.</p>`;
    renderSelection();
  }

  function renderSelection() {
    const symbol = state.analysis.outline.find(item => item.id === state.symbol);
    $('package-symbol-detail').hidden = !symbol;
    if (symbol) {
      const detail = window.SourceAnalyzer.summarizeSelection(state.analysis,symbol.id);
      $('package-selection-title').textContent = detail.title;
      $('package-selection-summary').textContent = detail.summary;
      $('package-selection-observations').innerHTML = detail.observations.map(value => `<li>${esc(value)}</li>`).join('');
    }
    state.page = Math.floor(((symbol?.startLine || 1)-1)/pageSize);
    renderSource();
    $('package-source-code').scrollTop = 0;
    const text = symbol ? state.lines.slice(symbol.startLine-1,symbol.endLine).join('\n') : state.source.text;
    const related = window.LibraryExplainer.matchSnippet(text.slice(0,12000),window.LibraryCatalog);
    $('package-mapping-message').textContent = related.matches.length ? 'Known API references suggest the lessons below. They execute reviewed teaching fixtures—not this downloaded file—and do not establish code equivalence.' : 'No verified CUDA mapping was identified in the inspected text. You can still explore this file and its symbols. Arbitrary package code is not automatically translated or run.';
    if (text.length > 12000) $('package-mapping-message').textContent += ' The known-API scan is limited to the first 12,000 characters of the selected range.';
    $('package-related-lessons').innerHTML = related.matches.map(match => {
      const operation = window.LibraryCatalog.operations.find(item => item.id === match.id);
      return `<button data-related-lesson="${esc(match.id)}"><span>${esc(operation?.title || match.id)}</span><small>Open separate teaching fixture ↗</small></button>`;
    }).join('');
  }

  function renderSource() {
    const start = state.page*pageSize, end = Math.min(start+pageSize,state.lines.length);
    const symbol = state.analysis.outline.find(item => item.id === state.symbol);
    $('package-source-code').innerHTML = state.lines.slice(start,end).map((line,index) => {
      const number = start+index+1, selected = symbol && number >= symbol.startLine && number <= symbol.endLine;
      return `<span class="library-code-line ${selected ? 'selected' : ''}"><span class="library-line-number" aria-hidden="true">${number}</span><span>${esc(line.slice(0,1000)) || ' '}${line.length > 1000 ? ' … [line clipped; open CDN file for full text]' : ''}</span></span>`;
    }).join('');
    $('package-lines-range').textContent = `Lines ${start+1}–${end} / ${state.lines.length}`;
    $('package-lines-prev').disabled = start === 0;
    $('package-lines-next').disabled = end >= state.lines.length;
  }

  $('explore-live').addEventListener('click',() => setPath('live'));
  $('explore-guided').addEventListener('click',() => setPath('guided'));
  ['package-guided-nav','package-all-lessons'].forEach(id => $(id).addEventListener('click',() => setPath('guided')));
  $('package-discovery-form').addEventListener('submit',discover);
  $('package-name').addEventListener('input',clearPackage);
  $('package-version').addEventListener('change',listFiles);
  $('package-list-files').addEventListener('click',listFiles);
  $('package-file-filter').addEventListener('input',renderFileOptions);
  $('package-file').addEventListener('change',() => { cancelRequest(false); clearSource(); $('package-status').textContent = 'Selection changed. Open this file to request its source.'; });
  $('package-open-file').addEventListener('click',openFile);
  $('package-cancel').addEventListener('click',() => cancelRequest());
  $('package-symbol').addEventListener('change',event => { state.symbol = event.target.value || null; renderSelection(); });
  $('package-lines-prev').addEventListener('click',() => { state.page = Math.max(0,state.page-1); renderSource(); $('package-source-code').scrollTop = 0; });
  $('package-lines-next').addEventListener('click',() => { state.page = Math.min(Math.ceil(state.lines.length/pageSize)-1,state.page+1); renderSource(); $('package-source-code').scrollTop = 0; });
  $('package-related-lessons').addEventListener('click',event => {
    const button = event.target.closest('[data-related-lesson]');
    if (button) window.dispatchEvent(new CustomEvent('cuvis:open-lesson',{detail:{id:button.dataset.relatedLesson}}));
  });
  window.addEventListener('cuvis:guided-lesson',() => setPath('guided'));
  window.addEventListener('cuvis:library-mode',event => {
    if (event.detail.mode === 'libraries') setPath(state.path);
    else { cancelRequest(); $('package-navigation').hidden = true; document.body.classList.remove('live-package-mode'); }
  });
  window.addEventListener('beforeunload',() => cancelRequest(false));
  setPath('live'); setBusy(false);
  if (!loader || !window.SourceAnalyzer) {
    $('package-error').hidden = false;
    $('package-error').textContent = 'Dynamic source tools could not load. Reload the page or choose Guided CUDA lessons.';
    $('package-discover').disabled = true;
  }
})();
