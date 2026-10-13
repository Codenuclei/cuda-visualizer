'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createLoader } = require('../web/package-loader.js');

const NAME = '@demo/tools';
const VERSION = '2.3.4';

function packageMetadata(name = NAME) {
  return {
    type: 'npm', name,
    tags: { latest: VERSION },
    versions: [{ version: VERSION }, { version: '2.3.4-beta.1' }]
  };
}

function fileMetadata(name = NAME, files) {
  return {
    type: 'npm', name, version: VERSION,
    files: files || [
      { name: '/src/a file.js', size: 17, hash: 'registry-hash' },
      { name: '/src/typed.ts', size: 10, hash: 'ts-hash' },
      { name: '/README.md', size: 7, hash: 'readme-hash' },
      { name: '/LICENSE', size: 5, hash: 'license-hash' },
      { name: '/dist/a.min.js', size: 100, hash: 'min-hash' },
      { name: '/dist/a.js.map', size: 100, hash: 'map-hash' },
      { name: '/image.png', size: 100, hash: 'binary-hash' }
    ]
  };
}

function jsonResponse(value, options = {}) {
  return new Response(JSON.stringify(value), {
    status: options.status || 200,
    headers: options.headers || {}
  });
}

function queueFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const result = routes(String(url), options, calls.length);
    if (result instanceof Error) throw result;
    if (typeof result === 'function') return result();
    return result;
  };
  return { calls, fetchImpl };
}

function expectedUrl(pathname) {
  return `https://data.jsdelivr.com/v1/packages/npm/${NAME}${pathname}`;
}

function makeLoader(routes = () => jsonResponse(packageMetadata()), options = {}) {
  const queue = queueFetch(routes);
  return { ...queue, loader: createLoader({ fetchImpl: queue.fetchImpl, ...options }) };
}

test('exports a dependency-free CommonJS and browser-global API', () => {
  assert.equal(typeof createLoader, 'function');
  const source = fs.readFileSync(path.join(__dirname, '../web/package-loader.js'), 'utf8');
  const context = { URL, TextDecoder, AbortController, setTimeout, clearTimeout };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  assert.equal(typeof context.PackageLoader.createLoader, 'function');
  assert.deepEqual(Object.keys(context.PackageLoader.createLoader({ fetchImpl: async () => {} })).sort(),
    ['clearCache', 'discover', 'getCacheInfo', 'listFiles', 'loadFile']);
});

test('discovers arbitrary unscoped and scoped npm package versions without executing content', async () => {
  const { loader, calls } = makeLoader((url) => {
    const name = decodeURIComponent(url.slice(url.indexOf('/npm/') + 5));
    return jsonResponse(packageMetadata(name));
  });
  const scoped = await loader.discover('@demo/tools');
  const unscoped = await loader.discover('lodash');
  assert.deepEqual(scoped, { name: '@demo/tools', versions: [VERSION, '2.3.4-beta.1'], latest: VERSION });
  assert.equal(unscoped.name, 'lodash');
  assert.equal(calls[0].url, 'https://data.jsdelivr.com/v1/packages/npm/@demo/tools');
  assert.equal(calls[1].url, 'https://data.jsdelivr.com/v1/packages/npm/lodash');
  for (const call of calls) {
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.referrerPolicy, 'no-referrer');
    assert.equal(call.options.method, 'GET');
  }
});

test('only fetches metadata until a selected safe text file is loaded', async () => {
  const { loader, calls } = makeLoader(url => url.includes('?structure=flat') ?
    jsonResponse(fileMetadata()) : url.startsWith('https://cdn.jsdelivr.net/') ?
      new Response(JSON.stringify({ safe: 'never executed' })) : jsonResponse(packageMetadata()));
  const discovered = await loader.discover(NAME);
  assert.equal(discovered.latest, VERSION);
  const listing = await loader.listFiles(NAME, VERSION);
  assert.deepEqual(listing.files.map(file => file.path), ['src/a file.js', 'src/typed.ts', 'README.md', 'LICENSE']);
  assert.equal(listing.omitted, 3);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, expectedUrl(`@${VERSION}?structure=flat`));
  assert.deepEqual(listing.files[0], {
    path: 'src/a file.js', size: 17, hash: 'registry-hash', language: 'JavaScript'
  });

  const loaded = await loader.loadFile(listing, 'src/a file.js');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].url, 'https://cdn.jsdelivr.net/npm/@demo/tools@2.3.4/src/a%20file.js');
  assert.deepEqual(loaded, {
    name: NAME, version: VERSION, path: 'src/a file.js', url: calls[2].url,
    text: JSON.stringify({ safe: 'never executed' }), bytes: 25, cached: false,
    language: 'JavaScript', hash: 'registry-hash'
  });
  assert.equal(listing.files.some(file => file.path.includes('.min.')), false);
  assert.equal(listing.files.some(file => file.path.endsWith('.map')), false);
});

test('rejects invalid package names, undiscovered versions, forged listings, and unsafe paths before fetching', async () => {
  const { loader, calls } = makeLoader(() => jsonResponse(packageMetadata()));
  for (const name of ['https://evil.invalid/pkg', '../pkg', '@scope/../pkg', 'pkg%2fother', 'pkg?x=1',
    'Uppercase', 'pkg//other', '@scope//pkg', 'pkg#fragment', '.hidden', '_hidden']) {
    await assert.rejects(loader.discover(name), TypeError, name);
  }
  for (const version of ['latest', '^2.3.4', '2.3', 'v2.3.4', '02.3.4', '2.3.4/evil', '2.3.4?x=1']) {
    await assert.rejects(loader.listFiles(NAME, version), TypeError, version);
  }
  await assert.rejects(loader.loadFile({ name: NAME, version: VERSION, files: [] }, 'src/a.js'), /issued by this/);
  assert.equal(calls.length, 0);
  await assert.rejects(loader.listFiles(NAME, VERSION), /returned by discover/);
  assert.equal(calls.length, 0);
});

test('requires the selected version to be among discovered exact versions', async () => {
  const { loader, calls } = makeLoader(url => url.includes('?structure=flat') ?
    jsonResponse(fileMetadata()) : jsonResponse(packageMetadata()));
  await loader.discover(NAME);
  await assert.rejects(loader.listFiles(NAME, '9.9.9'), /returned by discover/);
  assert.equal(calls.length, 1);
});

test('rejects malformed metadata, malformed file entries, traversal, and duplicate paths', async t => {
  await t.test('package metadata shape and exact versions', async () => {
    for (const body of [
      [], { ...packageMetadata(), type: 'github' },
      { ...packageMetadata(), versions: [{ version: 'latest' }] },
      { ...packageMetadata(), versions: [{ version: VERSION }, { version: VERSION }] },
      { ...packageMetadata(), versions: [] }
    ]) {
      const { loader } = makeLoader(() => jsonResponse(body));
      await assert.rejects(loader.discover(NAME), TypeError);
    }
  });
  for (const badName of ['/src/../secret.js', '/src/%2e%2e/secret.js', '/src\\secret.js', '/src//secret.js', '/src/\0x.js']) {
    const { loader } = makeLoader(url => url.includes('?structure=flat') ?
      jsonResponse(fileMetadata(NAME, [{ name: badName, size: 1 }])) : jsonResponse(packageMetadata()));
    await loader.discover(NAME);
    await assert.rejects(loader.listFiles(NAME, VERSION), TypeError);
  }
  const { loader: duplicateLoader } = makeLoader(url => url.includes('?structure=flat') ?
    jsonResponse(fileMetadata(NAME, [{ name: '/same.js', size: 1 }, { name: '/same.js', size: 1 }])) :
    jsonResponse(packageMetadata()));
  await duplicateLoader.discover(NAME);
  await assert.rejects(duplicateLoader.listFiles(NAME, VERSION), /duplicate file paths/);
});

test('caps inspectable files at 2000 and reports every omitted registry entry', async () => {
  const files = Array.from({ length: 2004 }, (_, index) => ({
    name: `/src/file-${index}.py`, size: index, hash: `hash-${index}`
  }));
  files.splice(4, 0, { name: '/dist/no.min.js', size: 3 });
  const { loader } = makeLoader(url => url.includes('?structure=flat') ?
    jsonResponse(fileMetadata(NAME, files)) : jsonResponse(packageMetadata()));
  await loader.discover(NAME);
  const listing = await loader.listFiles(NAME, VERSION);
  assert.equal(listing.files.length, 2000);
  assert.equal(listing.files[0].path, 'src/file-0.py');
  assert.equal(listing.files.at(-1).path, 'src/file-1999.py');
  assert.equal(listing.omitted, 5);
});

test('rejects malformed version file lists and nonnumeric sizes', async () => {
  for (const body of [
    { ...fileMetadata(), files: 'not-an-array' },
    fileMetadata(NAME, [{ name: '/src/a.js', size: '12' }]),
    { ...fileMetadata(), version: '1.0.0' },
    { ...fileMetadata(), name: 'other-package' }
  ]) {
    const { loader } = makeLoader(url => url.includes('?structure=flat') ?
      jsonResponse(body) : jsonResponse(packageMetadata()));
    await loader.discover(NAME);
    await assert.rejects(loader.listFiles(NAME, VERSION), TypeError);
  }
});

test('rejects source byte caps, invalid UTF-8, and NUL bytes without caching failures', async t => {
  await t.test('stream byte cap', async () => {
    const { loader, calls } = makeLoader(url => {
      if (url.includes('?structure=flat')) return jsonResponse(fileMetadata(NAME, [{ name: '/src/a.js', size: 2 }]));
      if (url.endsWith('/src/a.js')) return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('toolong')); controller.close(); }
      }));
      return jsonResponse(packageMetadata());
    }, { maxSourceBytes: 4 });
    await loader.discover(NAME);
    const listing = await loader.listFiles(NAME, VERSION);
    await assert.rejects(loader.loadFile(listing, 'src/a.js'), RangeError);
    assert.equal(loader.getCacheInfo().entries, 2);
    assert.equal(calls.length, 3);
  });
  for (const body of [new Uint8Array([0xff, 0xfe]), new Uint8Array([0x61, 0x00, 0x62])]) {
    const { loader } = makeLoader(url => {
      if (url.includes('?structure=flat')) return jsonResponse(fileMetadata(NAME, [{ name: '/src/a.js', size: 3 }]));
      if (url.endsWith('/src/a.js')) return new Response(body);
      return jsonResponse(packageMetadata());
    });
    await loader.discover(NAME);
    const listing = await loader.listFiles(NAME, VERSION);
    await assert.rejects(loader.loadFile(listing, 'src/a.js'), /UTF-8|NUL/);
    assert.equal(loader.getCacheInfo().entries, 2);
  }
});

test('enforces metadata limits and declared source lengths before reading bodies', async t => {
  await t.test('metadata response', async () => {
    const { loader } = makeLoader(() => new Response('123456', { headers: { 'Content-Length': '6' } }),
      { maxMetadataBytes: 5 });
    await assert.rejects(loader.discover(NAME), RangeError);
    assert.equal(loader.getCacheInfo().entries, 0);
  });
  await t.test('streamed metadata response', async () => {
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('123456')); controller.close(); }
    });
    const { loader } = makeLoader(() => new Response(body), { maxMetadataBytes: 5 });
    await assert.rejects(loader.discover(NAME), RangeError);
    assert.equal(loader.getCacheInfo().entries, 0);
  });
  await t.test('selected source content length', async () => {
    const { loader, calls } = makeLoader(url => {
      if (url.includes('?structure=flat')) return jsonResponse(fileMetadata(NAME, [{ name: '/src/a.js', size: 2 }]));
      if (url.endsWith('/src/a.js')) return new Response('oversized', { headers: { 'Content-Length': '9' } });
      return jsonResponse(packageMetadata());
    }, { maxSourceBytes: 4 });
    await loader.discover(NAME);
    const listing = await loader.listFiles(NAME, VERSION);
    await assert.rejects(loader.loadFile(listing, 'src/a.js'), RangeError);
    assert.equal(calls.length, 3);
    assert.equal(loader.getCacheInfo().entries, 2);
  });
});

test('evicts least-recent metadata when the combined cache exceeds its byte limit', async () => {
  const listing = fileMetadata(NAME, [{ name: '/src/a.js', size: 1 }]);
  const packageBytes = Buffer.byteLength(JSON.stringify(packageMetadata()));
  const listingBytes = Buffer.byteLength(JSON.stringify(listing));
  const maxCacheBytes = packageBytes + listingBytes - 1;
  const { loader, calls } = makeLoader(url => url.includes('?structure=flat') ?
    jsonResponse(listing) : jsonResponse(packageMetadata()), { maxCacheBytes });

  await loader.discover(NAME);
  await loader.listFiles(NAME, VERSION);
  assert.deepEqual(loader.getCacheInfo(), { entries: 1, bytes: listingBytes, maxBytes: maxCacheBytes });
  await loader.discover(NAME);
  assert.equal(calls.length, 3, 'the least-recent discovery metadata was evicted');
  assert.equal(loader.getCacheInfo().entries, 1);
});

test('reuses immutable normalized metadata/source in a byte-bounded LRU and clears it', async () => {
  const { loader, calls } = makeLoader(url => {
    if (url.includes('?structure=flat')) return jsonResponse(fileMetadata());
    if (url.startsWith('https://cdn.jsdelivr.net/')) return new Response('const safe = true;');
    return jsonResponse(packageMetadata());
  });
  const first = await loader.discover(NAME);
  const second = await loader.discover(NAME);
  assert.equal(first, second);
  assert.equal(calls.length, 1);
  assert.ok(Object.isFrozen(first.versions));

  const listing = await loader.listFiles(NAME, VERSION);
  const again = await loader.listFiles(NAME, VERSION);
  assert.deepEqual(again.files, listing.files);
  assert.notEqual(again, listing, 'each listing is independently issued and loader-bound');
  assert.equal(calls.length, 2);
  const loaded = await loader.loadFile(listing, 'src/a file.js');
  const cached = await loader.loadFile(listing, 'src/a file.js');
  assert.equal(loaded.cached, false);
  assert.equal(cached.cached, true);
  assert.equal(loaded.text, 'const safe = true;');
  assert.equal(calls.length, 3);
  assert.ok(loader.getCacheInfo().bytes > 0);

  loader.clearCache();
  assert.deepEqual(loader.getCacheInfo(), { entries: 0, bytes: 0, maxBytes: 4194304 });
  assert.equal((await loader.loadFile(listing, 'src/a file.js')).cached, false);
  assert.equal(calls.length, 4);
});

test('does not cache failed requests and supports retry after HTTP errors', async () => {
  const { loader, calls } = makeLoader((url, options, count) => {
    if (count === 1) return new Response('unavailable', { status: 503 });
    return jsonResponse(packageMetadata());
  });
  await assert.rejects(loader.discover(NAME), /status 503/);
  assert.equal(loader.getCacheInfo().entries, 0);
  assert.equal((await loader.discover(NAME)).latest, VERSION);
  assert.equal(calls.length, 2);
});

test('aborts independently, enforces timeouts, and rejects redirects', async t => {
  await t.test('caller cancellation and concurrent request isolation', async () => {
    const { loader } = makeLoader((url, options) => {
      if (url.includes('?structure=flat')) return jsonResponse(fileMetadata(NAME, [
        { name: '/src/one.js', size: 3 }, { name: '/src/two.js', size: 3 }
      ]));
      if (url.startsWith('https://data.jsdelivr.com/')) return jsonResponse(packageMetadata());
      return new Promise((resolve, reject) => {
        const source = url.endsWith('/one.js') ? 'one' : 'two';
        if (source === 'one') options.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
        if (source === 'one') setTimeout(() => resolve(new Response(source)), 25);
        else setTimeout(() => resolve(new Response(source)), 5);
      });
    });
    await loader.discover(NAME);
    const listing = await loader.listFiles(NAME, VERSION);
    const controller = new AbortController();
    const aborted = loader.loadFile(listing, 'src/one.js', { signal: controller.signal });
    const completed = loader.loadFile(listing, 'src/two.js');
    controller.abort();
    const [failure, result] = await Promise.allSettled([aborted, completed]);
    assert.equal(failure.status, 'rejected');
    assert.equal(failure.reason.name, 'AbortError');
    assert.equal(result.status, 'fulfilled');
    assert.equal(result.value.text, 'two');
  });
  await t.test('timeout', async () => {
    const fetchImpl = (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
    const loader = createLoader({ fetchImpl, timeoutMs: 10 });
    await assert.rejects(loader.discover(NAME), error => error.name === 'TimeoutError');
    assert.equal(loader.getCacheInfo().entries, 0);
  });
  await t.test('redirect rejection', async () => {
    const { loader } = makeLoader(() => new Response('redirected', { status: 302 }));
    await assert.rejects(loader.discover(NAME), /status 302/);
  });
});
