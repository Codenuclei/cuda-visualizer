# Library and dynamic package explorer contracts

The Guided CUDA lessons path is a deterministic viewer for a fixed catalog of reviewed packs. The separate Live packages path discovers package contents dynamically as described below. `LibraryExplainer` itself is dependency-free, but the complete explorer is not offline-capable: selected lesson-pack JSON is fetched from the app's static origin, and upstream source is fetched from jsDelivr when requested. There is no service worker or durable offline cache; loader caching is in-memory only. A pack is a versioned teaching example, not a promise to translate arbitrary source code. `LibraryExplainer` exposes the same API through CommonJS and `globalThis`.

## Pack and explanation rules

Packs use schema version 1: `{schemaVersion,id,library,version,language,title,api,summary,formula,example,limitations,tensors,stages,kernel,upstream,docsUrl}`. Keep tensor roles to `input`, `weight`, `intermediate`, or `output`. Each stage should explain one meaningful part of the operation and provide accurate, one-based `sourceLines` and `cudaLines`; mappings are evidence links, not inferred equivalence. Explain the full pipeline, formulas, shapes, known limitations, and provenance in accessible language. Never claim hardware speed, GPU execution, numerical correctness, or semantic equivalence from an authored description.

`summarize(pack, result)` keeps the pack's collection-level description and ordered stages together. A missing result describes authored material only. A failed run or reported deadlock is partial; trace truncation is reported separately. Runtime output observations are limited to finite-value checks and make no correctness or performance inference. `tensorStats` examines at most 100,000 array values and aggregates finite numeric values only. `classifyEvent` uses only explicit CUDA source-line mappings.

`extractSource(text, upstream, {maxLines})` searches for the literal `upstream.symbol`, normalizes CRLF, and returns a nearby bounded excerpt with one-based line numbers. A missing symbol yields an empty excerpt. It does not parse, evaluate, or execute upstream code. Keep excerpts at or below 80 lines and show attribution and upstream licensing alongside them.

`matchSnippet(source, catalog)` is a suggestion filter for only the API names explicitly enumerated in its implementation. It masks common comments and string literals before detection where possible, returns only catalog entries with an exact known `api` name, and labels every result as a related example—not a translation, validator, or equivalence proof. Unknown code and missing catalog entries must be reported as unsupported; do not broaden this into language parsing, fuzzy matching, or arbitrary transpilation.

## Loader, upstream, and CDN trust boundary

Treat pack metadata, source text, and CDN responses as untrusted data. The catalog and pack JSON are repository assets; `LibraryLoader.loadPack` fetches only the selected `packs/<id>.json` from the app's static origin and validates its schema and identity. `LibraryLoader.loadSource` is called only when the user opens upstream source. It accepts only the matching HTTPS jsDelivr URL for the approved library/revision and a safe relative source path; responses are size-bounded, redirects and unsuccessful responses are rejected, requests omit credentials, and timeout/abort are supported. Defaults are a 10-second request timeout, 128 KiB per pack, 1 MiB per source file, and a 2 MiB byte-bounded in-memory LRU cache. This cache is not durable offline storage.

The approved revisions are upstream version tags, not immutable commit identifiers: PyTorch `v2.5.1`, NumPy `v2.1.3`, and TensorFlow.js `tfjs-v4.22.0`. Pack attribution should preserve repository, path, exact pinned tag, symbol, license, license URL, and documentation URL. Render retrieved source as inert text. Do not inject fetched text as HTML, evaluate it, silently fall back to an unselected pack, or expose credentials in requests. The explainer itself performs no network requests.

## Team extension and quality gates

- Add a pack only for a named, reviewed library API with a source citation, compatible license, deterministic fixture, complete schema, and clear limitations.
- Preserve the schema and this explainer API; coordinate contract changes rather than silently changing existing pack meanings.
- Map stages to actual source lines and simulator CUDA lines. Test unmapped lines, symbol-not-found excerpts, multiline prose, failed/partial results, and non-finite output values.
- Test suggestions both for known APIs and unknown or comment/string-only mentions. A suggestion is not evidence that the pack reproduces the library implementation.
- Keep behavior deterministic and dependency-free. Run `node --test tests/*.test.cjs`; do not report UI appearance, fetched-source correctness, or GPU behavior as verified by those unit tests.

## Dynamic package discovery and source analysis

`PackageLoader` and `SourceAnalyzer` support the default **Live packages** path independently of the guided catalog. A new npm package needs no repository edit. The package name drives the live jsDelivr version metadata request; selecting a version drives its flat file-index request; opening one indexed file drives a single exact-version CDN text request. No archives, dependencies, install scripts, or imported source are executed or downloaded automatically. Authoritative response contracts: [jsDelivr OpenAPI specification](https://data.jsdelivr.com/v1/spec.yaml).

Keep this path separate from the curated teaching pack loader. Dynamic discovery must not weaken the guided pack schema or substitute arbitrary downloaded text for an executable kernel. A related lesson is an optional suggestion based on known API references, not semantic equivalence, automatic translation, or a run of the inspected source.

### Trust and scope

- Accept npm package names and exact discovered versions—not arbitrary URLs, tags/ranges in source URLs, local paths, or private endpoints.
- Accept source files only from the selected package's validated file index. Construct public CDN URLs, omit credentials and referrers, reject redirects, and bound metadata/source bytes, timeouts, cache memory, file count, and source analysis.
- Fetch no files on index/filter/symbol selection. Opening a file is explicit; canceling or changing package/version/file prevents stale results from rendering. Errors must not silently load a different file or fixture.
- Escape package metadata and source. A symbol named like markup is text, not DOM or executable code. Never evaluate downloaded source or package scripts.
- Show omitted-file counts and analysis/display truncation. Unknown languages have a text-level overview; heuristic symbol ranges and static syntax counts do not prove behavior or correctness.
- Only published npm files are in scope. Public CDN availability is not evidence of an open-source license; point users to shipped LICENSE/README and package metadata rather than assuming licensing.

### Review acceptance

Prove discovery with a package absent from `library-catalog.js`. Verify live version and file options, a selected-file-only request, source-derived symbols and collection summaries, explicit absent-CUDA-mapping behavior, caches, abort/retry/stale response protection, and inert hostile text. Run both dynamic and guided browser checks at desktop and mobile sizes; preserve the original CUDA-workbench tests.
