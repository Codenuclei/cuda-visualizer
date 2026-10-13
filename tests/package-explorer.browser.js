/* Run on a fresh managed-preview page:
 * agent-browser eval "$(cat tests/package-explorer.browser.js)"
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
  const submit = () => $('package-discovery-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  const resources = () => performance.getEntriesByType('resource').map(entry => entry.name);
  const jsdelivr = () => resources().filter(url => /(?:data\.jsdelivr\.com|cdn\.jsdelivr\.net)/.test(url));
  const packageSources = () => jsdelivr().filter(url => url.includes('cdn.jsdelivr.net/npm/'));
  const packs = () => resources().filter(url => url.includes('/packs/'));
  const waitForIndex = async version => {
    await wait(() => $('package-status').textContent.includes(`Live index loaded for ml-matrix@${version}`) || !$('package-error').hidden,
      `File index for ml-matrix@${version} did not settle: ${$('package-status').textContent}`);
    assert($('package-error').hidden,$('package-error').textContent);
  };

  assert($('package-explorer') && $('package-name') && $('package-file'), 'Live package explorer controls are missing');
  assert(jsdelivr().length === 0 && packs().length === 0,'Initial page eagerly requested jsDelivr metadata/source or a guided pack');
  assert(!Array.from($('library-select').options).some(option => /ml-matrix/i.test(`${option.value} ${option.textContent}`)),
    'ml-matrix unexpectedly appears in the curated guided catalog');
  passed.push('Fresh page makes no CDN/pack requests; ml-matrix is outside the guided catalog');

  input('package-name','ml-matrix');
  submit();
  await wait(() => $('package-status').textContent.includes('Live index loaded for ml-matrix@') || !$('package-error').hidden,
    `Dynamic ml-matrix discovery did not settle: ${$('package-status').textContent}`);
  assert($('package-error').hidden,$('package-error').textContent);
  assert($('package-discovered-name').textContent === 'ml-matrix','Package form did not discover the requested live npm package');
  await wait(() => jsdelivr().some(url => url.includes('data.jsdelivr.com')), 'Package metadata request was not recorded');
  assert($('package-version').options.length > 0, 'Discovery did not provide package versions');
  assert(packageSources().length === 0 && packs().length === 0,'Discovery downloaded source or a guided pack');

  const exactVersion = '6.12.1';
  assert(Array.from($('package-version').options).some(option => option.value === exactVersion),
    `Discovered versions do not contain required exact fixture ${exactVersion}`);
  select('package-version',exactVersion);
  await waitForIndex(exactVersion);
  const sourcePath = 'src/matrix.js';
  const indexPath = 'src/index.js';
  assert(Array.from($('package-file').options).some(option => option.value === sourcePath),
    `${sourcePath} is absent from the live ${exactVersion} file index`);
  assert(Array.from($('package-file').options).some(option => option.value === indexPath),
    `${indexPath} is absent from the live file index`);
  assert(packageSources().length === 0,'Version/file-index discovery downloaded a source file');
  passed.push('Real npm metadata discovered ml-matrix@6.12.1 and its confirmed src/matrix.js path without source fetch');

  select('package-file',sourcePath);
  $('package-open-file').click();
  await wait(() => !$('package-inspection').hidden || !$('package-error').hidden,
    `Selected source did not settle: ${$('package-status').textContent}`);
  assert($('package-error').hidden,$('package-error').textContent);
  await wait(() => packageSources().length > 0,'The selected source request was not recorded');
  const sourceUrl = new URL(packageSources()[0]);
  assert(packageSources().length === 1 && sourceUrl.hostname === 'cdn.jsdelivr.net' &&
    sourceUrl.pathname === '/npm/ml-matrix@6.12.1/src/matrix.js',
    `Opening one file requested unrelated CDN sources: ${packageSources().join(', ')}`);
  assert(packs().length === 0,'Live package inspection fetched a guided pack');
  assert($('package-file-title').textContent === sourcePath,'Inspection title is not the selected package source');
  assert($('package-analysis-title').textContent.includes('collection') && $('package-analysis-summary').textContent.trim().length > 0,
    'Static source summary is missing');
  assert($('package-source-provenance').textContent.includes('no package execution'),
    'Source provenance does not state that the package was not executed');
  assert(/not automatically translated|do not establish code equivalence|not establish code equivalence/i.test($('package-mapping-message').textContent),
    'The source-to-lesson boundary is not explicit');

  const lineCount = Number($('package-file-facts').querySelector('b')?.textContent);
  const symbols = Array.from($('package-symbol').options).filter(option => option.value);
  assert(Number.isInteger(lineCount) && lineCount > 100,'Source line count is missing or too short to exercise pagination');
  assert(symbols.length > 0,'Static analyzer found no symbols in the selected source');
  const ranges = symbols.map(option => ({option,match:/\bL(\d+)[–-](\d+)\b/.exec(option.textContent)}));
  assert(ranges.every(item => item.match && Number(item.match[1]) >= 1 && Number(item.match[2]) >= Number(item.match[1]) && Number(item.match[2]) <= lineCount),
    'Symbol outline contains an invalid source line range');
  const chosen = ranges.find(item => /\b(class|method|function)\b/i.test(item.option.textContent) && Number(item.match[1]) <= 100);
  assert(chosen, 'No discovered class/function/method begins on the first source page');
  select('package-symbol',chosen.option.value);
  assert(!$('package-symbol-detail').hidden && $('package-selection-summary').textContent.trim().length > 0,
    'Selecting a discovered symbol did not show its static summary');
  const firstRange = $('package-lines-range').textContent;
  assert(!$('package-lines-next').disabled,'Next source page should be available');
  $('package-lines-next').click();
  assert($('package-lines-range').textContent !== firstRange,'Next did not advance the source page');
  $('package-lines-prev').click();
  assert($('package-lines-range').textContent === firstRange,'Previous did not restore the first source page');
  assert(!$('package-source-code').querySelector('script,iframe,object,embed'),
    'Downloaded package text created executable or embedded DOM');
  passed.push('One selected CDN source produced static summary, valid symbols/ranges, selection and source pagination without execution');

  input('package-file-filter','src/index.js');
  assert($('package-file').value === indexPath,'Filtering did not update the selected file option');
  assert($('package-inspection').hidden && $('package-source-code').textContent === '',
    'Changing the file filter left stale source visible');
  assert(packageSources().length === 1,'Filtering fetched a source file before Open');
  input('package-file-filter',sourcePath);
  assert($('package-file').value === sourcePath,'Filtering back did not restore the matching file option');
  assert(packageSources().length === 1,'Changing the file filter fetched source before Open');
  $('package-open-file').click();
  await wait(() => $('package-status').textContent.includes('reused from memory') || !$('package-error').hidden,
    'Reopening the selected source did not settle from cache');
  assert($('package-error').hidden,$('package-error').textContent);
  assert(packageSources().length === 1,'Reopening the same file missed the in-memory source cache');
  passed.push('File filtering updates selection without a source request; reopening reuses the cached file');

  const otherVersion = Array.from($('package-version').options).map(option => option.value).find(version => version !== exactVersion);
  assert(otherVersion,'Metadata did not provide another version for the version-change check');
  select('package-version',otherVersion);
  await waitForIndex(otherVersion);
  assert($('package-inspection').hidden && $('package-source-code').textContent === '',
    'Changing version left stale source visible');
  assert(packageSources().length === 1,'Changing version fetched source instead of metadata/index only');
  select('package-version',exactVersion);
  await waitForIndex(exactVersion);
  assert(packageSources().length === 1,'Returning to the exact version fetched source before Open');
  select('package-file',sourcePath);
  $('package-open-file').click();
  await wait(() => $('package-status').textContent.includes('reused from memory') || !$('package-error').hidden,
    'Opening the exact-version file after a version change did not settle');
  assert($('package-error').hidden,$('package-error').textContent);
  assert(packageSources().length === 1,'Version change discarded the cached source or fetched a dependency');
  passed.push('Version changes refresh only the file index; returning to the exact version reuses source cache');

  const savedTitle = $('package-file-title').textContent;
  const savedSource = $('package-source-code').textContent;
  $('explore-guided').click();
  assert($('package-explorer').hidden && !$('guided-library-panel').hidden,'Guided path did not replace live package panel');
  select('library-select','pytorch');
  select('operation-select','pytorch-linear');
  $('load-operation').click();
  await wait(() => $('lesson-result-status').textContent.includes('COMPLETE') || $('lesson-result-status').textContent.includes('ATTENTION'),
    'Guided CPU-reference lesson did not finish');
  assert($('lesson-result-status').textContent.includes('COMPLETE') &&
    $('operation-observations').textContent.includes('matches the independent CPU reference'),
    'Guided lesson did not complete against its independent CPU reference');
  $('explore-live').click();
  assert(!$('package-explorer').hidden && $('guided-library-panel').hidden,'Live path did not return from the guided lesson');
  assert($('package-file-title').textContent === savedTitle && $('package-source-code').textContent === savedSource,
    'Returning live lost the prior package/version/source inspection');
  assert(packageSources().length === 1,'Switching guided/live paths re-requested package source');
  passed.push('Guided lesson runs against its CPU reference; switching back preserves live inspection state');

  const beforeInvalidName = jsdelivr().length;
  input('package-name','not a valid npm package');
  assert($('package-browser').hidden && $('package-source-code').textContent === '',
    'Changing package input left stale package/source visible');
  submit();
  await wait(() => !$('package-error').hidden,'Invalid package name did not produce a visible validation error');
  assert(jsdelivr().length === beforeInvalidName,'Invalid package-name validation made an external request');
  assert(packs().length === 1 && packs()[0].endsWith(window.LibraryCatalog.operations.find(operation => operation.id === $('operation-select').value).pack), 'Expected only the explicitly chosen guided pack');
  passed.push('Package-input changes clear stale state; invalid names fail without network access');

  assert(document.documentElement.scrollWidth <= innerWidth,
    `Package explorer overflows horizontally at ${innerWidth}px`);
  passed.push(`No horizontal page overflow at ${innerWidth}px`);
  return {passed:passed.length,checks:passed};
})()
