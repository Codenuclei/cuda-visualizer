(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LibraryLoader = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PINNED_REVISIONS = Object.freeze({
    'pytorch/pytorch': 'v2.5.1',
    'numpy/numpy': 'v2.1.3',
    'tensorflow/tfjs': 'tfjs-v4.22.0'
  });

  function fail(message, name) {
    const error = new Error(message);
    if (name) error.name = name;
    return error;
  }

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function text(value, field, maxLength) {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
      throw new TypeError(`${field} must be a non-empty string of at most ${maxLength} characters`);
    }
    return value;
  }

  function safeHttpsUrl(value, field) {
    text(value, field, 2048);
    let parsed;
    try { parsed = new URL(value); } catch (_) {
      throw new TypeError(`${field} must be an HTTPS URL`);
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new TypeError(`${field} must be an HTTPS URL without credentials`);
    }
    return parsed;
  }

  function safeSourcePath(value, field) {
    text(value, field, 512);
    if (value.startsWith('/') || value.includes('//') || !/^[A-Za-z0-9_.\/-]+$/.test(value) ||
        value.split('/').some(part => part === '.' || part === '..' || part.length === 0)) {
      throw new TypeError(`${field} must be a literal relative source path`);
    }
    return value;
  }

  function validateUpstream(upstream) {
    if (!isRecord(upstream)) throw new TypeError('upstream must be an object');
    const repository = text(upstream.repository, 'upstream.repository', 80);
    const revision = text(upstream.revision, 'upstream.revision', 40);
    const path = safeSourcePath(upstream.path, 'upstream.path');
    const pinnedRevision = PINNED_REVISIONS[repository];
    if (!pinnedRevision || revision !== pinnedRevision) {
      throw new TypeError('upstream must use an approved pinned repository revision');
    }
    const expectedUrl = `https://cdn.jsdelivr.net/gh/${repository}@${revision}/${path}`;
    if (upstream.url !== expectedUrl) {
      throw new TypeError('upstream.url must be the approved jsDelivr URL for its pinned source path');
    }
    safeHttpsUrl(upstream.url, 'upstream.url');
    text(upstream.license, 'upstream.license', 160);
    safeHttpsUrl(upstream.licenseUrl, 'upstream.licenseUrl');
    text(upstream.symbol, 'upstream.symbol', 200);
    return upstream;
  }

  function positiveInteger(value, field, allowZero) {
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
      throw new TypeError(`${field} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`);
    }
    return value;
  }

  function lineList(value, field) {
    if (!Array.isArray(value) || value.length > 512) throw new TypeError(`${field} must be an array of line numbers`);
    value.forEach((line, index) => positiveInteger(line, `${field}[${index}]`, false));
  }

  function finiteNumberList(value, field, limit) {
    if (!Array.isArray(value) || value.length > limit) throw new TypeError(`${field} must be a bounded number array`);
    value.forEach((number, index) => {
      if (typeof number !== 'number' || !Number.isFinite(number)) {
        throw new TypeError(`${field}[${index}] must be a finite number`);
      }
    });
  }

  function validateTypedValues(buffer, field) {
    buffer.values.forEach((value, index) => {
      if (buffer.dtype === 'int32' && (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)) {
        throw new TypeError(`${field}.values[${index}] must fit in int32`);
      }
      if (buffer.dtype === 'float32' && Math.abs(value) > 3.4028234663852886e38) {
        throw new TypeError(`${field}.values[${index}] must fit in float32`);
      }
    });
  }

  function validatePack(pack, operation) {
    if (!isRecord(pack)) throw new TypeError('pack must be a JSON object');
    if (pack.schemaVersion !== 1) throw new TypeError('pack.schemaVersion must be 1');
    for (const field of ['id', 'library', 'version', 'language', 'title', 'api', 'summary', 'formula', 'example']) {
      text(pack[field], `pack.${field}`, field === 'example' ? 32768 : 8192);
    }
    if (!/^[a-z0-9-]+$/.test(pack.id) || pack.id !== operation.id) {
      throw new TypeError('pack.id must match the selected operation');
    }
    if (!/^[a-z0-9-]+$/.test(pack.library) || pack.library !== operation.library) {
      throw new TypeError('pack.library must match the selected operation');
    }
    if (!Array.isArray(pack.limitations) || pack.limitations.length > 64) {
      throw new TypeError('pack.limitations must be a bounded array');
    }
    pack.limitations.forEach((item, index) => text(item, `pack.limitations[${index}]`, 2048));

    if (!Array.isArray(pack.tensors) || pack.tensors.length > 64) throw new TypeError('pack.tensors must be a bounded array');
    pack.tensors.forEach((tensor, index) => {
      const field = `pack.tensors[${index}]`;
      if (!isRecord(tensor)) throw new TypeError(`${field} must be an object`);
      text(tensor.name, `${field}.name`, 120);
      text(tensor.role, `${field}.role`, 120);
      text(tensor.description, `${field}.description`, 2048);
      if (!Array.isArray(tensor.shape) || tensor.shape.length === 0 || tensor.shape.length > 8) {
        throw new TypeError(`${field}.shape must contain one to eight dimensions`);
      }
      tensor.shape.forEach((dimension, axis) => positiveInteger(dimension, `${field}.shape[${axis}]`, false));
    });

    if (!Array.isArray(pack.stages) || pack.stages.length === 0 || pack.stages.length > 64) {
      throw new TypeError('pack.stages must be a bounded non-empty array');
    }
    pack.stages.forEach((stage, index) => {
      const field = `pack.stages[${index}]`;
      if (!isRecord(stage)) throw new TypeError(`${field} must be an object`);
      text(stage.id, `${field}.id`, 120);
      text(stage.title, `${field}.title`, 200);
      text(stage.summary, `${field}.summary`, 4096);
      text(stage.formula, `${field}.formula`, 2048);
      text(stage.insight, `${field}.insight`, 4096);
      lineList(stage.sourceLines, `${field}.sourceLines`);
      lineList(stage.cudaLines, `${field}.cudaLines`);
    });

    const kernel = pack.kernel;
    if (!isRecord(kernel)) throw new TypeError('pack.kernel must be an object');
    text(kernel.name, 'pack.kernel.name', 200);
    text(kernel.code, 'pack.kernel.code', 32768);
    for (const field of ['grid', 'block']) {
      if (!Array.isArray(kernel[field]) || kernel[field].length !== 2) {
        throw new TypeError(`pack.kernel.${field} must contain two dimensions`);
      }
      kernel[field].forEach((size, axis) => positiveInteger(size, `pack.kernel.${field}[${axis}]`, false));
    }
    positiveInteger(kernel.n, 'pack.kernel.n', true);
    positiveInteger(kernel.sharedBytes, 'pack.kernel.sharedBytes', true);
    if (!isRecord(kernel.buffers)) throw new TypeError('pack.kernel.buffers must be an object');
    const bufferNames = Object.keys(kernel.buffers);
    if (bufferNames.length === 0 || bufferNames.length > 64) throw new TypeError('pack.kernel.buffers must be a bounded non-empty object');
    let totalValues = 0;
    for (const name of bufferNames) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TypeError(`invalid buffer name: ${name}`);
      const buffer = kernel.buffers[name];
      if (!isRecord(buffer)) throw new TypeError(`pack.kernel.buffers.${name} must be an object`);
      if (buffer.dtype !== 'float32' && buffer.dtype !== 'int32') {
        throw new TypeError(`pack.kernel.buffers.${name}.dtype is unsupported`);
      }
      finiteNumberList(buffer.values, `pack.kernel.buffers.${name}.values`, 32768);
      validateTypedValues(buffer, `pack.kernel.buffers.${name}`);
      totalValues += buffer.values.length;
      if (totalValues > 32768) throw new TypeError('pack.kernel buffer data exceeds its value limit');
    }
    text(kernel.outputBuffer, 'pack.kernel.outputBuffer', 120);
    if (!Object.prototype.hasOwnProperty.call(kernel.buffers, kernel.outputBuffer)) {
      throw new TypeError('pack.kernel.outputBuffer must name a buffer');
    }
    finiteNumberList(kernel.expected, 'pack.kernel.expected', 32768);
    if (kernel.expected.length === 0 || kernel.expected.length !== kernel.buffers[kernel.outputBuffer].values.length) {
      throw new TypeError('pack.kernel.expected must match the output buffer length');
    }
    validateTypedValues({ dtype: kernel.buffers[kernel.outputBuffer].dtype, values: kernel.expected }, 'pack.kernel.expected');

    validateUpstream(pack.upstream);
    safeHttpsUrl(pack.docsUrl, 'pack.docsUrl');
    return pack;
  }

  function createLoader({
    fetchImpl = typeof globalThis !== 'undefined' ? globalThis.fetch : undefined,
    timeoutMs = 10000,
    maxPackBytes = 131072,
    maxSourceBytes = 1048576,
    maxCacheBytes = 2097152
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    positiveInteger(timeoutMs, 'timeoutMs', false);
    if (timeoutMs > 2147483647) throw new TypeError('timeoutMs is too large');
    positiveInteger(maxPackBytes, 'maxPackBytes', false);
    positiveInteger(maxSourceBytes, 'maxSourceBytes', false);
    positiveInteger(maxCacheBytes, 'maxCacheBytes', true);

    const cache = new Map();
    let cacheBytes = 0;

    function cacheGet(key) {
      const entry = cache.get(key);
      if (!entry) return null;
      cache.delete(key);
      cache.set(key, entry);
      return entry;
    }

    function cachePut(key, value, bytes) {
      if (maxCacheBytes === 0 || bytes > maxCacheBytes) return;
      if (cache.has(key)) {
        cacheBytes -= cache.get(key).bytes;
        cache.delete(key);
      }
      cache.set(key, { value, bytes });
      cacheBytes += bytes;
      while (cacheBytes > maxCacheBytes) {
        const oldestKey = cache.keys().next().value;
        cacheBytes -= cache.get(oldestKey).bytes;
        cache.delete(oldestKey);
      }
    }

    function requestContext(signal) {
      if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function')) {
        throw new TypeError('signal must be an AbortSignal');
      }
      const controller = new AbortController();
      let rejectCancel;
      let cancelError = null;
      const cancelled = new Promise((_, reject) => { rejectCancel = reject; });
      cancelled.catch(() => {});
      const cancel = error => {
        if (cancelError) return;
        cancelError = error;
        controller.abort(error);
        rejectCancel(error);
      };
      const onAbort = () => cancel(fail('The request was aborted', 'AbortError'));
      if (signal && signal.aborted) onAbort();
      else if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => cancel(fail('The request timed out', 'TimeoutError')), timeoutMs);
      return {
        controller,
        wait(start) {
          if (cancelError) return Promise.reject(cancelError);
          const promise = typeof start === 'function' ? Promise.resolve().then(() => {
            if (cancelError) throw cancelError;
            return start();
          }) : start;
          return Promise.race([promise, cancelled]);
        },
        get error() { return cancelError; },
        dispose() {
          clearTimeout(timer);
          if (signal && !signal.aborted) signal.removeEventListener('abort', onAbort);
        }
      };
    }

    function contentLength(response) {
      const raw = response.headers && typeof response.headers.get === 'function'
        ? response.headers.get('content-length') : null;
      if (raw === null || raw === undefined || raw === '') return null;
      if (!/^\d+$/.test(String(raw))) throw new TypeError('Invalid Content-Length response header');
      const total = Number(raw);
      if (!Number.isSafeInteger(total)) throw new TypeError('Invalid Content-Length response header');
      return total;
    }

    function cancelBody(response) {
      const body = response && response.body;
      if (!body) return;
      try {
        const cancellation = typeof body.cancel === 'function'
          ? body.cancel()
          : typeof body.getReader === 'function' ? body.getReader().cancel() : null;
        if (cancellation && typeof cancellation.catch === 'function') cancellation.catch(() => {});
      } catch (_) {}
    }

    function notify(onProgress, loaded, total) {
      if (onProgress) onProgress({ loaded, total });
    }

    async function responseBytes(response, limit, onProgress, context) {
      if (!response || typeof response !== 'object') throw new TypeError('Invalid fetch response');
      if (response.redirected === true) throw new Error('Redirected responses are not allowed');
      if ((typeof response.status === 'number' && (response.status < 200 || response.status >= 300)) || response.ok === false) {
        throw new Error(`Request failed with HTTP ${response.status || 'error'}`);
      }
      const total = contentLength(response);
      if (total !== null && total > limit) {
        cancelBody(response);
        throw new RangeError(`Response exceeds the ${limit}-byte limit`);
      }

      let chunks = [];
      let loaded = 0;
      const body = response.body;
      if (body && typeof body.getReader === 'function') {
        const reader = body.getReader();
        try {
          while (true) {
            const result = await context.wait(() => reader.read());
            if (result.done) break;
            let chunk = result.value;
            if (typeof chunk === 'string') chunk = new TextEncoder().encode(chunk);
            else if (chunk instanceof ArrayBuffer) chunk = new Uint8Array(chunk);
            else if (ArrayBuffer.isView(chunk)) chunk = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            else throw new TypeError('Response stream returned an invalid chunk');
            loaded += chunk.byteLength;
            if (loaded > limit) {
              try {
                const cancellation = reader.cancel();
                if (cancellation && typeof cancellation.catch === 'function') cancellation.catch(() => {});
              } catch (_) {}
              throw new RangeError(`Response exceeds the ${limit}-byte limit`);
            }
            chunks.push(chunk);
            notify(onProgress, loaded, total);
          }
        } catch (error) {
          try {
            const cancellation = reader.cancel();
            if (cancellation && typeof cancellation.catch === 'function') cancellation.catch(() => {});
          } catch (_) {}
          throw error;
        } finally {
          if (typeof reader.releaseLock === 'function') reader.releaseLock();
        }
      } else {
        let raw;
        if (typeof response.arrayBuffer === 'function') {
          raw = await context.wait(() => response.arrayBuffer());
          if (raw instanceof ArrayBuffer) chunks = [new Uint8Array(raw)];
          else if (ArrayBuffer.isView(raw)) chunks = [new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)];
          else throw new TypeError('Response body is not readable');
        } else if (typeof response.text === 'function') {
          raw = await context.wait(() => response.text());
          if (typeof raw !== 'string') throw new TypeError('Response body is not readable');
          chunks = [new TextEncoder().encode(raw)];
        } else {
          chunks = [];
        }
        loaded = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        if (loaded > limit) throw new RangeError(`Response exceeds the ${limit}-byte limit`);
        notify(onProgress, loaded, total);
      }
      const bytes = new Uint8Array(loaded);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { bytes, total };
    }

    async function retrieve(url, limit, signal, onProgress) {
      if (onProgress !== undefined && typeof onProgress !== 'function') {
        throw new TypeError('onProgress must be a function');
      }
      const context = requestContext(signal);
      try {
        const response = await context.wait(() => fetchImpl(url, {
          signal: context.controller.signal,
          redirect: 'error',
          credentials: 'omit',
          referrerPolicy: 'no-referrer'
        }));
        const result = await responseBytes(response, limit, onProgress, context);
        if (context.error) throw context.error;
        let decoded;
        try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(result.bytes); } catch (_) {
          throw new TypeError('Response is not valid UTF-8');
        }
        return { text: decoded, bytes: result.bytes.byteLength };
      } catch (error) {
        if (context.error) throw context.error;
        throw error;
      } finally {
        context.dispose();
      }
    }

    async function loadPack(operation, { signal, onProgress } = {}) {
      if (!isRecord(operation)) throw new TypeError('operation must be an object');
      text(operation.id, 'operation.id', 120);
      text(operation.library, 'operation.library', 120);
      if (!/^[a-z0-9-]+$/.test(operation.id) || !/^[a-z0-9-]+$/.test(operation.library)) {
        throw new TypeError('operation id and library must be lowercase identifiers');
      }
      if (operation.pack !== `packs/${operation.id}.json` || !/^packs\/[a-z0-9-]+\.json$/.test(operation.pack)) {
        throw new TypeError('operation.pack must be a safe local packs/<id>.json path');
      }
      const key = `pack:${operation.pack}`;
      const cached = cacheGet(key);
      if (cached) {
        if (onProgress) onProgress({ loaded: cached.bytes, total: cached.bytes });
        return JSON.parse(JSON.stringify(cached.value));
      }
      const response = await retrieve(operation.pack, maxPackBytes, signal, onProgress);
      let parsed;
      try { parsed = JSON.parse(response.text); } catch (_) {
        throw new TypeError('Pack response is not valid JSON');
      }
      const pack = validatePack(parsed, operation);
      cachePut(key, pack, response.bytes);
      return JSON.parse(JSON.stringify(pack));
    }

    async function loadSource(upstream, { signal, onProgress } = {}) {
      validateUpstream(upstream);
      const key = `source:${upstream.url}`;
      const cached = cacheGet(key);
      if (cached) {
        if (onProgress) onProgress({ loaded: cached.bytes, total: cached.bytes });
        return { ...cached.value, cached: true };
      }
      const response = await retrieve(upstream.url, maxSourceBytes, signal, onProgress);
      if (response.bytes === 0) throw new TypeError('Source response is empty');
      const result = { text: response.text, bytes: response.bytes, url: upstream.url };
      cachePut(key, result, response.bytes);
      return { ...result, cached: false };
    }

    function clearCache() {
      cache.clear();
      cacheBytes = 0;
    }

    function getCacheInfo() {
      return { entries: cache.size, bytes: cacheBytes, maxBytes: maxCacheBytes };
    }

    return { loadPack, loadSource, clearCache, getCacheInfo };
  }

  return { createLoader };
});
