'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const LibraryLoader = require('../web/library-loader.js');

const upstream = Object.freeze({
  url: 'https://cdn.jsdelivr.net/gh/pytorch/pytorch@v2.5.1/torch/nn/modules/linear.py',
  repository: 'pytorch/pytorch',
  path: 'torch/nn/modules/linear.py',
  revision: 'v2.5.1',
  license: 'BSD-3-Clause',
  licenseUrl: 'https://github.com/pytorch/pytorch/blob/v2.5.1/LICENSE',
  symbol: 'torch.nn.Linear'
});

function validPack() {
  return {
    schemaVersion: 1,
    id: 'torch-linear',
    library: 'pytorch',
    version: '2.5.1',
    language: 'Python',
    title: 'Linear layer',
    api: 'torch.nn.Linear',
    summary: 'A small fully connected layer.',
    formula: 'y = xWᵀ + b',
    example: 'layer = torch.nn.Linear(3, 2)',
    limitations: ['Educational sample only.'],
    tensors: [{ name: 'input', shape: [2, 3], role: 'input', description: 'Two input rows.' }],
    stages: [{
      id: 'multiply', title: 'Multiply and accumulate', summary: 'Each output accumulates products.',
      sourceLines: [1, 2], cudaLines: [3, 4], formula: 'sum(xᵢwᵢ)', insight: 'The output elements are independent.'
    }],
    kernel: {
      name: 'linear_forward', code: '__global__ void linear_forward() {}', grid: [1, 1], block: [32, 1],
      n: 2, sharedBytes: 0,
      buffers: {
        input: { dtype: 'float32', values: [1, 2, 3] },
        output: { dtype: 'float32', values: [0, 0] }
      },
      outputBuffer: 'output', expected: [4, 5]
    },
    upstream: { ...upstream },
    docsUrl: 'https://pytorch.org/docs/2.5/generated/torch.nn.Linear.html'
  };
}

function streamResponse(chunks, { status = 200, headers = {}, redirected = false } = {}) {
  const encoded = chunks.map(chunk => typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
  let index = 0;
  const normalizedHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected,
    headers: { get: name => normalizedHeaders[name.toLowerCase()] ?? null },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= encoded.length) return { done: true };
            return { done: false, value: encoded[index++] };
          },
          async cancel() {},
          releaseLock() {}
        };
      }
    }
  };
}

function fetchQueue(...responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  };
  return { calls, fetchImpl };
}

function selectedOperation(pack = 'packs/torch-linear.json') {
  return { id: 'torch-linear', library: 'pytorch', pack };
}

test('exposes a dependency-free CommonJS and browser global API', () => {
  assert.equal(typeof LibraryLoader.createLoader, 'function');
  assert.equal(globalThis.LibraryLoader, LibraryLoader);
});

test('fetches only explicitly selected pack/source URLs and omits credentials', async () => {
  const { calls, fetchImpl } = fetchQueue(
    streamResponse([JSON.stringify(validPack())]),
    streamResponse(['class Linear: pass'])
  );
  const loader = LibraryLoader.createLoader({ fetchImpl });
  assert.equal(calls.length, 0);

  const pack = await loader.loadPack(selectedOperation());
  assert.equal(pack.id, 'torch-linear');
  const source = await loader.loadSource(upstream);
  assert.equal(source.text, 'class Linear: pass');
  assert.deepEqual(calls.map(call => call.url), ['packs/torch-linear.json', upstream.url]);
  for (const call of calls) {
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.referrerPolicy, 'no-referrer');
  }
});

test('rejects unsafe pack paths and operation metadata before fetching', async () => {
  let fetches = 0;
  const loader = LibraryLoader.createLoader({ fetchImpl: async () => { fetches++; } });
  await assert.rejects(loader.loadPack(selectedOperation('../secret.json')), /safe local/);
  await assert.rejects(loader.loadPack({ id: 'UPPER', library: 'pytorch', pack: 'packs/UPPER.json' }), /lowercase/);
  await assert.rejects(loader.loadPack({ id: 'other', library: 'pytorch', pack: 'packs/torch-linear.json' }), /safe local/);
  assert.equal(fetches, 0);
});

test('rejects malformed pack shape, data, and selected identity', async t => {
  const cases = [
    ['schema version', pack => { pack.schemaVersion = 2; }],
    ['selected library mismatch', pack => { pack.library = 'numpy'; }],
    ['empty tensor shape', pack => { pack.tensors[0].shape = []; }],
    ['non-positive launch dimension', pack => { pack.kernel.grid = [0, 1]; }],
    ['invalid buffer numbers', pack => { pack.kernel.buffers.input.values[0] = NaN; }],
    ['integer buffer outside int32', pack => {
      pack.kernel.buffers.input.dtype = 'int32';
      pack.kernel.buffers.input.values[0] = 2147483648;
    }],
    ['missing output buffer', pack => { pack.kernel.outputBuffer = 'missing'; }],
    ['wrong expected output length', pack => { pack.kernel.expected = [1]; }],
    ['unsafe upstream URL', pack => { pack.upstream.url = 'https://example.com/code.py'; }]
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, async () => {
      const pack = validPack();
      mutate(pack);
      const { fetchImpl } = fetchQueue(streamResponse([JSON.stringify(pack)]));
      const loader = LibraryLoader.createLoader({ fetchImpl });
      await assert.rejects(loader.loadPack(selectedOperation()));
      assert.deepEqual(loader.getCacheInfo(), { entries: 0, bytes: 0, maxBytes: 2097152 });
    });
  }
});

test('allows only literal paths on the three pinned CDN repositories', async t => {
  const invalid = [
    { ...upstream, url: upstream.url.replace('cdn.jsdelivr.net', 'example.com') },
    { ...upstream, revision: 'main', url: upstream.url.replace('@v2.5.1', '@main') },
    { ...upstream, path: '../LICENSE', url: 'https://cdn.jsdelivr.net/gh/pytorch/pytorch@v2.5.1/../LICENSE' },
    { ...upstream, path: 'torch/linear.py?raw=1', url: 'https://cdn.jsdelivr.net/gh/pytorch/pytorch@v2.5.1/torch/linear.py?raw=1' },
    { ...upstream, url: 'https://user:pass@cdn.jsdelivr.net/gh/pytorch/pytorch@v2.5.1/torch/nn/modules/linear.py' }
  ];
  for (const [index, candidate] of invalid.entries()) {
    await t.test(`disallowed upstream ${index + 1}`, async () => {
      let fetches = 0;
      const loader = LibraryLoader.createLoader({ fetchImpl: async () => { fetches++; } });
      await assert.rejects(loader.loadSource(candidate));
      assert.equal(fetches, 0);
    });
  }
});

test('accepts the other explicitly pinned library revisions', async () => {
  const candidates = [
    {
      ...upstream,
      repository: 'numpy/numpy', revision: 'v2.1.3', path: 'numpy/core/_multiarray_umath.py',
      url: 'https://cdn.jsdelivr.net/gh/numpy/numpy@v2.1.3/numpy/core/_multiarray_umath.py'
    },
    {
      ...upstream,
      repository: 'tensorflow/tfjs', revision: 'tfjs-v4.22.0', path: 'tfjs-core/src/ops/add.ts',
      url: 'https://cdn.jsdelivr.net/gh/tensorflow/tfjs@tfjs-v4.22.0/tfjs-core/src/ops/add.ts'
    }
  ];
  const { calls, fetchImpl } = fetchQueue(streamResponse(['numpy source']), streamResponse(['tfjs source']));
  const loader = LibraryLoader.createLoader({ fetchImpl });
  assert.equal((await loader.loadSource(candidates[0])).text, 'numpy source');
  assert.equal((await loader.loadSource(candidates[1])).text, 'tfjs source');
  assert.equal(calls.length, 2);
});

test('reports streamed byte progress and counts UTF-8 bytes', async () => {
  const text = 'Aé🙂Z';
  const bytes = new TextEncoder().encode(text);
  const { fetchImpl } = fetchQueue(streamResponse([bytes.slice(0, 2), bytes.slice(2, 5), bytes.slice(5)]));
  const loader = LibraryLoader.createLoader({ fetchImpl });
  const progress = [];
  const result = await loader.loadSource(upstream, { onProgress: value => progress.push(value) });
  assert.equal(result.text, text);
  assert.equal(result.bytes, bytes.byteLength);
  assert.equal(result.cached, false);
  assert.deepEqual(progress, [
    { loaded: 2, total: null }, { loaded: 5, total: null }, { loaded: bytes.byteLength, total: null }
  ]);
});

test('enforces streamed byte limits without Content-Length and does not cache failures', async () => {
  const { fetchImpl } = fetchQueue(streamResponse(['ab', 'cd']));
  const loader = LibraryLoader.createLoader({ fetchImpl, maxSourceBytes: 3 });
  await assert.rejects(loader.loadSource(upstream), { name: 'RangeError' });
  assert.deepEqual(loader.getCacheInfo(), { entries: 0, bytes: 0, maxBytes: 2097152 });
});

test('rejects an oversized declared length before consuming its body', async () => {
  let reads = 0;
  const response = streamResponse(['data'], { headers: { 'content-length': '4' } });
  const getReader = response.body.getReader;
  response.body.getReader = () => {
    const reader = getReader();
    return { ...reader, read: async () => { reads++; return reader.read(); } };
  };
  const loader = LibraryLoader.createLoader({ fetchImpl: async () => response, maxSourceBytes: 3 });
  await assert.rejects(loader.loadSource(upstream), { name: 'RangeError' });
  assert.equal(reads, 0);
});

test('caches successful results, reports hits, and evicts least-recently-used entries by bytes', async () => {
  const firstUrl = 'https://cdn.jsdelivr.net/gh/pytorch/pytorch@v2.5.1/torch/one.py';
  const secondUpstream = { ...upstream, url: 'https://cdn.jsdelivr.net/gh/pytorch/pytorch@v2.5.1/torch/two.py', path: 'torch/two.py' };
  const thirdUpstream = { ...upstream, url: 'https://cdn.jsdelivr.net/gh/pytorch/pytorch@v2.5.1/torch/three.py', path: 'torch/three.py' };
  const { calls, fetchImpl } = fetchQueue(
    streamResponse(['aaaa']), streamResponse(['bbbb']), streamResponse(['cccc']), streamResponse(['bbbb'])
  );
  const loader = LibraryLoader.createLoader({ fetchImpl, maxCacheBytes: 8 });
  assert.equal((await loader.loadSource({ ...upstream, url: firstUrl, path: 'torch/one.py' })).cached, false);
  await loader.loadSource(secondUpstream);
  const hit = await loader.loadSource({ ...upstream, url: firstUrl, path: 'torch/one.py' });
  assert.equal(hit.cached, true);
  assert.deepEqual(loader.getCacheInfo(), { entries: 2, bytes: 8, maxBytes: 8 });
  await loader.loadSource(thirdUpstream);
  assert.deepEqual(loader.getCacheInfo(), { entries: 2, bytes: 8, maxBytes: 8 });
  assert.equal((await loader.loadSource(secondUpstream)).text, 'bbbb');
  assert.equal(calls.length, 4);
  loader.clearCache();
  assert.deepEqual(loader.getCacheInfo(), { entries: 0, bytes: 0, maxBytes: 8 });
});

test('does not cache failed HTTP responses and retries successfully', async () => {
  const { calls, fetchImpl } = fetchQueue(streamResponse([], { status: 503 }), streamResponse(['class Linear: pass']));
  const loader = LibraryLoader.createLoader({ fetchImpl });
  await assert.rejects(loader.loadSource(upstream), /HTTP 503/);
  assert.equal(loader.getCacheInfo().entries, 0);
  assert.equal((await loader.loadSource(upstream)).text, 'class Linear: pass');
  assert.equal(calls.length, 2);
});

test('rejects redirected responses even if a fetch implementation returns one', async () => {
  const { fetchImpl } = fetchQueue(streamResponse(['redirected'], { redirected: true }));
  const loader = LibraryLoader.createLoader({ fetchImpl });
  await assert.rejects(loader.loadSource(upstream), /Redirected responses/);
  assert.equal(loader.getCacheInfo().entries, 0);
});

test('timeout and caller abort reject without caching; retries remain possible', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return new Promise(() => {});
    return streamResponse(['retry succeeded']);
  };
  const loader = LibraryLoader.createLoader({ fetchImpl, timeoutMs: 20 });
  await assert.rejects(loader.loadSource(upstream), { name: 'TimeoutError' });
  const controller = new AbortController();
  const aborted = loader.loadSource(upstream, { signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted, { name: 'AbortError' });
  assert.equal(loader.getCacheInfo().entries, 0);
  assert.equal((await loader.loadSource(upstream)).text, 'retry succeeded');
  assert.equal(calls, 2);
});

test('a pre-aborted signal does not initiate a request', async () => {
  let calls = 0;
  const loader = LibraryLoader.createLoader({ fetchImpl: async () => { calls++; } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loader.loadSource(upstream, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('concurrent requests keep independent cancellation state', async () => {
  const pending = [];
  const fetchImpl = () => new Promise(resolve => pending.push(resolve));
  const loader = LibraryLoader.createLoader({ fetchImpl, timeoutMs: 1000 });
  const controller = new AbortController();
  const first = loader.loadSource(upstream, { signal: controller.signal });
  const second = loader.loadSource(upstream);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2);
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  pending[1](streamResponse(['independent']));
  assert.equal((await second).text, 'independent');
});

test('isolates returned pack objects from cached data', async () => {
  const { fetchImpl } = fetchQueue(streamResponse([JSON.stringify(validPack())]));
  const loader = LibraryLoader.createLoader({ fetchImpl });
  const first = await loader.loadPack(selectedOperation());
  first.title = 'mutated by caller';
  assert.equal((await loader.loadPack(selectedOperation())).title, 'Linear layer');
});
