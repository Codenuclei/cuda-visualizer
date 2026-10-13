(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PackageLoader = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const API_ORIGIN = 'https://data.jsdelivr.com';
  const CDN_ORIGIN = 'https://cdn.jsdelivr.net';
  const MAX_FILES = 2000;
  const PACKAGE_NAME = /^(?:[a-z0-9-][a-z0-9._-]*|@[a-z0-9-][a-z0-9._-]*\/[a-z0-9-][a-z0-9._-]*)$/;
  const NUMERIC = '(?:0|[1-9]\\d*)';
  const IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
  const SEMVER = new RegExp(`^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${IDENTIFIER}(?:\\.${IDENTIFIER})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
  const EXTENSIONS = Object.freeze({
    '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
    '.ts': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript', '.tsx': 'TypeScript',
    '.py': 'Python', '.c': 'C', '.h': 'C', '.cc': 'C++', '.cpp': 'C++', '.cxx': 'C++',
    '.hh': 'C++', '.hpp': 'C++', '.hxx': 'C++', '.cu': 'CUDA', '.cuh': 'CUDA',
    '.glsl': 'GLSL', '.vert': 'GLSL', '.frag': 'GLSL', '.geom': 'GLSL', '.tesc': 'GLSL',
    '.tese': 'GLSL', '.comp': 'GLSL', '.wgsl': 'WGSL', '.rs': 'Rust', '.go': 'Go',
    '.java': 'Java', '.r': 'R', '.jl': 'Julia', '.swift': 'Swift', '.kt': 'Kotlin',
    '.kts': 'Kotlin', '.scala': 'Scala', '.sc': 'Scala', '.m': 'Objective-C', '.mm': 'Objective-C++',
    '.cs': 'C#', '.rb': 'Ruby', '.php': 'PHP', '.sh': 'Shell', '.bash': 'Shell',
    '.css': 'CSS', '.html': 'HTML', '.htm': 'HTML', '.json': 'JSON', '.jsonc': 'JSON',
    '.md': 'Markdown', '.markdown': 'Markdown', '.mdx': 'Markdown', '.yaml': 'YAML',
    '.yml': 'YAML', '.toml': 'TOML', '.xml': 'XML', '.sql': 'SQL'
  });

  function fail(message, name) {
    const error = new Error(message);
    if (name) error.name = name;
    return error;
  }

  function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function positiveInteger(value, field, allowZero) {
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
      throw new TypeError(`${field} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`);
    }
    return value;
  }

  function packageName(value) {
    if (typeof value !== 'string' || value.length > 214 || !PACKAGE_NAME.test(value) ||
        value.split('/').some(part => part === '.' || part === '..')) {
      throw new TypeError('name must be a valid npm package name');
    }
    return value;
  }

  function exactVersion(value) {
    if (typeof value !== 'string' || value.length > 128 || !SEMVER.test(value)) {
      throw new TypeError('version must be an exact semantic version');
    }
    return value;
  }

  function safePath(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 1024 ||
        value.startsWith('/') || value.includes('%') || value.includes('\\') ||
        /[\u0000-\u001f\u007f]/.test(value)) {
      throw new TypeError('file path must be a safe relative path');
    }
    const parts = value.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) {
      throw new TypeError('file path must not contain empty or traversal segments');
    }
    return value;
  }

  function urlFor(value, expectedOrigin) {
    let parsed;
    try { parsed = new URL(value); } catch (_) {
      throw new TypeError('constructed request URL is invalid');
    }
    if (parsed.protocol !== 'https:' || parsed.origin !== expectedOrigin || parsed.username ||
        parsed.password || parsed.hash) {
      throw new TypeError('constructed request URL is not an approved HTTPS URL');
    }
    return parsed.href;
  }

  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(deepFreeze);
      Object.freeze(value);
    }
    return value;
  }

  function validateRequestOptions(options) {
    const settings = options === undefined ? {} : options;
    if (!record(settings)) throw new TypeError('request options must be an object');
    const { signal, onProgress } = settings;
    if (signal !== undefined && signal !== null &&
        (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' ||
         typeof signal.removeEventListener !== 'function')) {
      throw new TypeError('signal must be an AbortSignal');
    }
    if (onProgress !== undefined && typeof onProgress !== 'function') {
      throw new TypeError('onProgress must be a function');
    }
    return { signal: signal || null, onProgress: onProgress || null };
  }

  function abortError() {
    return fail('The request was aborted', 'AbortError');
  }

  function cancelBody(response, reason) {
    if (!response || !response.body || typeof response.body.cancel !== 'function') return;
    try {
      const pending = response.body.cancel(reason);
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch (_) { /* A completed or locked body needs no further cleanup. */ }
  }

  function languageFor(path) {
    const lower = path.toLowerCase();
    if (lower.endsWith('.map') || /\.min\.(?:js|mjs|cjs|jsx)$/.test(lower)) return null;
    const basename = lower.slice(lower.lastIndexOf('/') + 1);
    const dot = basename.lastIndexOf('.');
    const extension = dot < 0 ? '' : basename.slice(dot);
    if (EXTENSIONS[extension]) return EXTENSIONS[extension];
    if (/^readme(?:[._-].*)?$/.test(basename) || /^license(?:[._-].*)?$/.test(basename)) return 'Text';
    return null;
  }

  function createLoader({
    fetchImpl = typeof globalThis !== 'undefined' ? globalThis.fetch : undefined,
    timeoutMs = 10000,
    maxMetadataBytes = 2097152,
    maxSourceBytes = 1048576,
    maxCacheBytes = 4194304
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    positiveInteger(timeoutMs, 'timeoutMs', false);
    if (timeoutMs > 2147483647) throw new TypeError('timeoutMs is too large');
    positiveInteger(maxMetadataBytes, 'maxMetadataBytes', false);
    positiveInteger(maxSourceBytes, 'maxSourceBytes', false);
    positiveInteger(maxCacheBytes, 'maxCacheBytes', true);

    const cache = new Map();
    const listings = new WeakMap();
    const knownVersions = new Map();
    let cacheBytes = 0;

    function cacheGet(key) {
      const entry = cache.get(key);
      if (!entry) return null;
      cache.delete(key);
      cache.set(key, entry);
      return entry;
    }

    function cacheSet(key, value, bytes) {
      if (maxCacheBytes === 0 || bytes > maxCacheBytes) return;
      const previous = cache.get(key);
      if (previous) {
        cache.delete(key);
        cacheBytes -= previous.bytes;
      }
      cache.set(key, { value: deepFreeze(value), bytes });
      cacheBytes += bytes;
      while (cacheBytes > maxCacheBytes && cache.size) {
        const oldestKey = cache.keys().next().value;
        cacheBytes -= cache.get(oldestKey).bytes;
        cache.delete(oldestKey);
      }
    }

    function progress(callback, loaded, total) {
      if (!callback) return;
      try { callback(Object.freeze({ loaded, total })); } catch (_) { /* Progress must not change request results. */ }
    }

    async function fetchText(url, origin, limit, requestOptions, accept) {
      const safeUrl = urlFor(url, origin);
      const { signal, onProgress } = requestOptions;
      if (signal && signal.aborted) throw abortError();

      const controller = new AbortController();
      let failure = null;
      let reader = null;
      let timer;
      const cancel = error => {
        if (failure) return;
        failure = error;
        controller.abort(error);
        if (reader) reader.cancel(error).catch(() => {});
      };
      const onAbort = () => cancel(abortError());
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => cancel(fail('The request timed out', 'TimeoutError')), timeoutMs);

      try {
        let response;
        try {
          response = await fetchImpl(safeUrl, {
            method: 'GET',
            signal: controller.signal,
            credentials: 'omit',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
            headers: { Accept: accept }
          });
        } catch (error) {
          if (failure) throw failure;
          if (signal && signal.aborted) throw abortError();
          throw error;
        }
        if (failure) throw failure;
        if (!response || response.redirected || (response.status < 200 || response.status >= 300)) {
          cancelBody(response);
          throw new Error(response && response.redirected ? 'Redirected responses are not allowed' :
            `Request failed${response && Number.isFinite(response.status) ? ` with status ${response.status}` : ''}`);
        }

        const rawLength = response.headers && typeof response.headers.get === 'function' ?
          response.headers.get('content-length') : null;
        let total = null;
        if (rawLength !== null && rawLength !== undefined) {
          if (!/^\d+$/.test(String(rawLength)) || !Number.isSafeInteger(Number(rawLength))) {
            cancelBody(response);
            throw new TypeError('Invalid Content-Length response header');
          }
          total = Number(rawLength);
          if (total > limit) {
            cancelBody(response);
            throw new RangeError(`Response exceeds the ${limit} byte limit`);
          }
        }

        const chunks = [];
        let length = 0;
        if (response.body && typeof response.body.getReader === 'function') {
          reader = response.body.getReader();
          while (true) {
            if (failure) throw failure;
            const part = await reader.read();
            if (failure) throw failure;
            if (part.done) break;
            if (!(part.value instanceof Uint8Array)) throw new TypeError('Response stream must contain byte chunks');
            length += part.value.byteLength;
            if (length > limit) {
              const error = new RangeError(`Response exceeds the ${limit} byte limit`);
              reader.cancel(error).catch(() => {});
              throw error;
            }
            chunks.push(part.value);
            progress(onProgress, length, total);
          }
        } else {
          if (!response || typeof response.arrayBuffer !== 'function') {
            throw new TypeError('Response body is not readable');
          }
          const body = new Uint8Array(await response.arrayBuffer());
          if (failure) throw failure;
          length = body.byteLength;
          if (length > limit) throw new RangeError(`Response exceeds the ${limit} byte limit`);
          chunks.push(body);
          progress(onProgress, length, total);
        }
        if (failure) throw failure;

        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_) {
          throw new TypeError('Response must be valid UTF-8 text');
        }
        if (length === 0) progress(onProgress, 0, total);
        return { text, bytes: length };
      } catch (error) {
        if (failure) throw failure;
        if (signal && signal.aborted) throw abortError();
        throw error;
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (reader) reader.releaseLock();
      }
    }

    function parseJson(text, kind) {
      try { return JSON.parse(text); } catch (_) {
        throw new TypeError(`${kind} response must be valid JSON`);
      }
    }

    function metadataUrl(name, version) {
      const versionPath = version === undefined ? '' : `@${encodeURIComponent(version)}?structure=flat`;
      return urlFor(`${API_ORIGIN}/v1/packages/npm/${name}${versionPath}`, API_ORIGIN);
    }

    function sourceUrl(name, version, path) {
      const encodedPath = path.split('/').map(segment => encodeURIComponent(segment)).join('/');
      return urlFor(`${CDN_ORIGIN}/npm/${name}@${encodeURIComponent(version)}/${encodedPath}`, CDN_ORIGIN);
    }

    async function jsonResult(url, kind, options, normalize) {
      const hit = cacheGet(url);
      if (hit) return { value: hit.value, cached: true };
      const response = await fetchText(url, API_ORIGIN, maxMetadataBytes, options, 'application/json');
      const value = normalize(parseJson(response.text, kind));
      cacheSet(url, value, response.bytes);
      return { value, cached: false };
    }

    function normalizeVersions(value, name) {
      if (!record(value) || value.type !== 'npm' || value.name !== name || !Array.isArray(value.versions) ||
          !record(value.tags)) {
        throw new TypeError('Package metadata has an invalid shape');
      }
      const seen = new Set();
      const versions = value.versions.map((entry, index) => {
        if (!record(entry)) throw new TypeError(`Package metadata version ${index} is invalid`);
        const version = exactVersion(entry.version);
        if (seen.has(version)) throw new TypeError('Package metadata contains duplicate versions');
        seen.add(version);
        return version;
      });
      if (versions.length === 0) throw new TypeError('Package metadata contains no exact versions');
      const latest = typeof value.tags.latest === 'string' && seen.has(value.tags.latest) ? value.tags.latest : null;
      return deepFreeze({ name, versions, latest });
    }

    function normalizeFileList(value, name, version) {
      if (!record(value) || value.type !== 'npm' || value.name !== name || value.version !== version ||
          !Array.isArray(value.files)) {
        throw new TypeError('Version metadata has an invalid shape');
      }
      const paths = new Set();
      const supported = [];
      for (let index = 0; index < value.files.length; index += 1) {
        const entry = value.files[index];
        if (!record(entry) || typeof entry.name !== 'string' || !entry.name.startsWith('/')) {
          throw new TypeError(`Version metadata file ${index} is invalid`);
        }
        const path = safePath(entry.name.slice(1));
        positiveInteger(entry.size, `Version metadata file ${index} size`, true);
        if (entry.hash !== undefined && entry.hash !== null &&
            (typeof entry.hash !== 'string' || entry.hash.length > 256)) {
          throw new TypeError(`Version metadata file ${index} hash is invalid`);
        }
        if (paths.has(path)) throw new TypeError('Version metadata contains duplicate file paths');
        paths.add(path);
        const language = languageFor(path);
        if (language && supported.length < MAX_FILES) {
          supported.push({ path, size: entry.size, hash: entry.hash || null, language });
        }
      }
      return deepFreeze({ name, version, files: supported, omitted: value.files.length - supported.length });
    }

    async function discover(name, options = {}) {
      const safeName = packageName(name);
      const settings = validateRequestOptions(options);
      if (settings.signal && settings.signal.aborted) throw abortError();
      const url = metadataUrl(safeName);
      const result = await jsonResult(url, 'Package metadata', settings,
        value => normalizeVersions(value, safeName));
      knownVersions.set(safeName, new Set(result.value.versions));
      return result.value;
    }

    async function listFiles(name, version, options = {}) {
      const safeName = packageName(name);
      const safeVersion = exactVersion(version);
      if (!knownVersions.has(safeName) || !knownVersions.get(safeName).has(safeVersion)) {
        throw new TypeError('version must be an exact version returned by discover for this package');
      }
      const settings = validateRequestOptions(options);
      if (settings.signal && settings.signal.aborted) throw abortError();
      const url = metadataUrl(safeName, safeVersion);
      const result = await jsonResult(url, 'Version metadata', settings,
        value => normalizeFileList(value, safeName, safeVersion));
      const listing = Object.freeze({
        name: result.value.name,
        version: result.value.version,
        files: result.value.files,
        omitted: result.value.omitted
      });
      listings.set(listing, new Map(result.value.files.map(file => [file.path, file])));
      return listing;
    }

    async function loadFile(listing, filePath, options = {}) {
      const paths = listing && typeof listing === 'object' ? listings.get(listing) : null;
      if (!paths) throw new TypeError('listing must be issued by this PackageLoader instance');
      const safeFilePath = safePath(filePath);
      const file = paths.get(safeFilePath);
      if (!file) throw new TypeError('filePath must identify an inspectable file in this listing');
      if (file.size > maxSourceBytes) throw new RangeError(`File metadata exceeds the ${maxSourceBytes} byte source limit`);
      const settings = validateRequestOptions(options);
      if (settings.signal && settings.signal.aborted) throw abortError();
      const url = sourceUrl(listing.name, listing.version, safeFilePath);
      const hit = cacheGet(url);
      if (hit) {
        if (hit.value.includes('\0')) throw new TypeError('Source response contains a NUL byte');
        return Object.freeze({
          name: listing.name, version: listing.version, path: safeFilePath, url,
          text: hit.value, bytes: hit.bytes, cached: true, language: file.language, hash: file.hash
        });
      }
      const response = await fetchText(url, CDN_ORIGIN, maxSourceBytes, settings, 'text/plain, */*');
      if (response.text.includes('\0')) throw new TypeError('Source response contains a NUL byte');
      cacheSet(url, response.text, response.bytes);
      return Object.freeze({
        name: listing.name, version: listing.version, path: safeFilePath, url,
        text: response.text, bytes: response.bytes, cached: false,
        language: file.language, hash: file.hash
      });
    }

    function clearCache() {
      cache.clear();
      cacheBytes = 0;
    }

    function getCacheInfo() {
      return Object.freeze({ entries: cache.size, bytes: cacheBytes, maxBytes: maxCacheBytes });
    }

    return { discover, listFiles, loadFile, clearCache, getCacheInfo };
  }

  return { createLoader };
});
