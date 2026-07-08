/* cuda-sim.js — a CUDA-C kernel interpreter for the browser.
 *
 * Supports a practical subset of CUDA C++ (the part people write in
 * their first months of GPU programming):
 *
 *   __global__ void k(float *out, const float *in, int n)
 *   threadIdx / blockIdx / blockDim / gridDim  (.x .y .z)
 *   int/unsigned/float/double declarations, for/while/if/else
 *   __shared__ arrays (static and extern dynamic), __syncthreads()
 *   atomicAdd/atomicMax/atomicMin on global and shared buffers
 *   printf with %d %u %f %x, math intrinsics (sqrtf, expf, min, max, ...)
 *
 * Every thread runs as a JS generator so __syncthreads() is a real
 * barrier. Global and shared arrays are wrapped in Proxies that record
 * each access with (block, warp, lane, sequence), which is what powers
 * the coalescing / bank-conflict / divergence visualizations.
 */

(function () {
  "use strict";

  const TYPE_MAP = {
    "float": Float32Array, "double": Float64Array,
    "int": Int32Array, "unsigned": Uint32Array, "unsigned int": Uint32Array,
    "unsigned char": Uint8Array, "uchar": Uint8Array,
    "long long": Float64Array, "size_t": Float64Array,
  };

  /* ------------------------------------------------------------------ */
  /* parsing                                                             */
  /* ------------------------------------------------------------------ */

  // Extract the first __global__ kernel: name, params, body.
  function parseKernel(src) {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
      .replace(/\/\/[^\n]*/g, "");

    const sig = /__global__\s+void\s+(\w+)\s*\(([^)]*)\)\s*\{/.exec(noComments);
    if (!sig) throw new Error(
      "No kernel found — expected `__global__ void name(...) { ... }`");

    const name = sig[1];
    const params = [];
    if (sig[2].trim()) {
      for (const raw of sig[2].split(",")) {
        const p = raw.trim().replace(/__restrict__/g, "").replace(/\s+/g, " ");
        const isPtr = p.includes("*");
        const isConst = /\bconst\b/.test(p);
        const clean = p.replace(/\bconst\b/g, "").replace(/\*/g, " ").trim();
        const parts = clean.split(/\s+/);
        const pname = parts.pop();
        const type = parts.join(" ") || "int";
        params.push({ name: pname, type, isPtr, isConst });
      }
    }

    // Body: match braces from the signature's opening brace.
    let i = sig.index + sig[0].length, depth = 1, start = i;
    while (i < noComments.length && depth > 0) {
      const c = noComments[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    if (depth !== 0) throw new Error("Unbalanced braces in kernel body");
    return { name, params, body: noComments.slice(start, i - 1) };
  }

  /* ------------------------------------------------------------------ */
  /* transpilation: CUDA-C body -> JS generator body                     */
  /* ------------------------------------------------------------------ */

  const MATH_MAP = {
    fminf: "Math.min", fmaxf: "Math.max", fmin: "Math.min", fmax: "Math.max",
    min: "Math.min", max: "Math.max", fabsf: "Math.abs", fabs: "Math.abs",
    abs: "Math.abs", sqrtf: "Math.sqrt", sqrt: "Math.sqrt",
    expf: "Math.exp", exp: "Math.exp", logf: "Math.log", log: "Math.log",
    sinf: "Math.sin", sin: "Math.sin", cosf: "Math.cos", cos: "Math.cos",
    powf: "Math.pow", pow: "Math.pow", floorf: "Math.floor",
    ceilf: "Math.ceil", rsqrtf: "__rsqrt", tanhf: "Math.tanh",
  };

  function transpileBody(body) {
    let js = body;

    // strip preprocessor lines (#pragma unroll, ...)
    js = js.replace(/^\s*#[^\n]*$/gm, "");

    // float literal suffixes: 1.0f, .5f, 2e-3f
    js = js.replace(/(\d+\.?\d*(?:[eE][+-]?\d+)?)[fF]\b/g, "$1");
    js = js.replace(/(\.\d+(?:[eE][+-]?\d+)?)[fF]\b/g, "$1");

    // __syncthreads() -> barrier yield
    js = js.replace(/__syncthreads\s*\(\s*\)\s*;/g, "yield __SYNC;");
    js = js.replace(/__syncwarp\s*\(\s*\)\s*;/g, ";");

    // shared memory declarations
    //   __shared__ float s[256];        (static)
    //   extern __shared__ float s[];    (dynamic)
    js = js.replace(
      /extern\s+__shared__\s+([\w ]+?)\s+(\w+)\s*\[\s*\]\s*;/g,
      (m, t, n) => `const ${n} = __sharedDyn(${JSON.stringify(n)}, ${JSON.stringify(t.trim())});`);
    js = js.replace(
      /__shared__\s+([\w ]+?)\s+(\w+)\s*\[\s*([^\]]+)\s*\]\s*(\[\s*([^\]]+)\s*\])?\s*;/g,
      (m, t, n, d1, _b, d2) => d2
        ? `const ${n} = __shared2D(${JSON.stringify(n)}, ${JSON.stringify(t.trim())}, (${d1}), (${d2}));`
        : `const ${n} = __sharedAlloc(${JSON.stringify(n)}, ${JSON.stringify(t.trim())}, (${d1}));`);

    // integer literal suffixes: 1u, 4ull
    js = js.replace(/\b(\d+)[uUlL]+\b/g, "$1");

    // atomics: atomicAdd(&buf[expr], v) -> __atomic("add", buf, expr, v)
    // (index may contain one nested [] level, e.g. local[data[i]])
    js = js.replace(
      /atomic(Add|Sub|Max|Min|Exch)\s*\(\s*&\s*(\w+)\s*\[((?:[^\[\]]|\[[^\]]*\])+)\]\s*,/g,
      (m, op, buf, idx) => `__atomic("${op.toLowerCase()}", ${buf}, (${idx}),`);

    // printf -> __printf (bound per-thread)
    js = js.replace(/\bprintf\s*\(/g, "__printf(");

    // casts
    js = js.replace(/\(\s*(?:float|double)\s*\)/g, "");
    js = js.replace(/\(\s*(?:unsigned\s+)?int\s*\)\s*([A-Za-z_]\w*(?:\[[^\]]*\])?|\([^()]*\))/g,
                    "(($1)|0)");

    // integer declarations — wrap initializer with __i (truncation) so
    // index math stays integral (int row = i / N). Track the names so
    // later re-assignments keep C's integer-division semantics too.
    const intVars = new Set();

    // for-loop init: `for (int k = 0; ...)` is not a standalone statement.
    js = js.replace(
      /\bfor\s*\(\s*(?:unsigned\s+int|unsigned|int|long\s+long|size_t|uint32_t|int32_t)\s+(\w+)\s*=\s*([^;]+);/g,
      (m, n, e) => { intVars.add(n); return `for (let ${n} = __i(${e});`; });
    js = js.replace(
      /\bfor\s*\(\s*(?:float|double)\s+(\w+)\s*=\s*([^;]+);/g,
      "for (let $1 = ($2);");

    js = js.replace(
      /\b(?:unsigned\s+int|unsigned|int|long\s+long|size_t|uint32_t|int32_t)\s+(\w+)\s*=\s*([^;]+);/g,
      (m, n, e) => { intVars.add(n); return `let ${n} = __i(${e});`; });
    js = js.replace(/\b(?:unsigned\s+int|unsigned|int|long\s+long|size_t|uint32_t|int32_t)\s+(\w+)\s*;/g,
                    (m, n) => { intVars.add(n); return `let ${n} = 0;`; });

    // re-assignments of int vars: statement-level `s = s / 2;`
    for (const v of intVars) {
      js = js.replace(
        new RegExp("(^|[;{}()]\\s*)" + v + "\\s*=(?![=])\\s*([^;{}]+);", "gm"),
        (m, pre, expr) => `${pre}${v} = __i(${expr});`);
      // for-header update clause: `for (...; ...; s = s / 2) {`
      js = js.replace(
        new RegExp(";\\s*" + v + "\\s*=(?![=])\\s*([^;)]+)\\)", "g"),
        (m, expr) => `; ${v} = __i(${expr}))`);
      // compound `s /= 2;` and `s /= 2)` in for headers
      js = js.replace(
        new RegExp("\\b" + v + "\\s*/=\\s*([^;)]+)([;)])", "g"),
        (m, expr, tail) => `${v} = __i(${v} / (${expr}))${tail}`);
    }

    // float declarations
    js = js.replace(/\b(?:float|double)\s+(\w+)\s*=\s*([^;]+);/g, "let $1 = ($2);");
    js = js.replace(/\b(?:float|double)\s+(\w+)\s*;/g, "let $1 = 0;");
    js = js.replace(/\bbool\s+(\w+)\s*=\s*([^;]+);/g, "let $1 = ($2);");

    // math intrinsics
    for (const k in MATH_MAP)
      js = js.replace(new RegExp("\\b" + k + "\\s*\\(", "g"), MATH_MAP[k] + "(");

    // loop guards against runaway loops (also count as per-lane work for
    // the divergence view). Non-greedy header match tolerates nested parens.
    js = js.replace(/\b(for|while)\s*\(([^{}]*?)\)\s*\{/g,
                    "$1 ($2) { __g();");
    js = js.replace(/\bdo\s*\{/g, "do { __g();");

    return js;
  }

  // CUDA identifiers that are reserved words in JS (`float *in` is the
  // classic). They get renamed to __p_<name> in the generated function.
  const JS_RESERVED = new Set([
    "in", "new", "delete", "class", "function", "var", "this", "typeof",
    "with", "yield", "enum", "export", "import", "super", "catch", "try",
    "finally", "switch", "case", "default", "throw", "instanceof", "of",
  ]);
  const safeName = n => (JS_RESERVED.has(n) ? "__p_" + n : n);

  function renameReservedParams(jsBody, params) {
    let out = jsBody;
    for (const p of params) {
      if (JS_RESERVED.has(p.name))
        out = out.replace(new RegExp("\\b" + p.name + "\\b", "g"),
                          "__p_" + p.name);
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* instrumented buffers                                                */
  /* ------------------------------------------------------------------ */

  function makeTracedBuffer(name, array, space, sim) {
    return new Proxy(array, {
      get(target, prop) {
        if (typeof prop === "string" && prop !== "length" && !isNaN(prop)) {
          sim.record(name, +prop, "r", space, array.BYTES_PER_ELEMENT);
          return target[prop];
        }
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
      set(target, prop, value) {
        if (typeof prop === "string" && !isNaN(prop)) {
          sim.record(name, +prop, "w", space, array.BYTES_PER_ELEMENT);
          if (+prop >= target.length)
            throw new Error(`out-of-bounds write: ${name}[${prop}] (size ${target.length})`);
          target[prop] = value;
          return true;
        }
        target[prop] = value;
        return true;
      },
    });
  }

  /* ------------------------------------------------------------------ */
  /* the simulator                                                       */
  /* ------------------------------------------------------------------ */

  const MAX_THREADS = 1 << 16;      // total threads per launch
  const MAX_TRACE = 250000;         // recorded accesses (focus block only)
  const OPS_BUDGET = 8_000_000;     // loop-guard budget for the whole launch

  class CudaSim {
    constructor() { this.reset(); }

    reset() {
      this.trace = [];              // focus-block access records
      this.counts = { gld: 0, gst: 0, shld: 0, shst: 0, atomics: 0, syncs: 0 };
      this.printfLines = [];
      this.perThreadOps = new Map();// "b:t" -> op count (divergence estimate)
      this.ops = 0;
      this.cur = null;              // {block, thread, warp, lane, key}
      this.focusBlock = 0;
    }

    record(buf, index, rw, space, bpe) {
      const c = this.counts;
      if (space === "global") { rw === "r" ? c.gld++ : c.gst++; }
      else { rw === "r" ? c.shld++ : c.shst++; }
      const t = this.cur;
      if (t) this.perThreadOps.set(t.key, (this.perThreadOps.get(t.key) || 0) + 1);
      if (t && t.block === this.focusBlock && this.trace.length < MAX_TRACE) {
        this.trace.push({
          buf, index, rw, space,
          byte: index * bpe, bpe,
          warp: t.warp, lane: t.lane, thread: t.thread,
          seq: t.seqCounter[space === "global" ? "g" : "s"]++,
        });
      }
    }

    /* ---- run a launch ------------------------------------------------ */

    run(opts) {
      // opts: {source, grid:[x,y], block:[x,y], buffers:{name:TypedArray},
      //        scalars:{name:value}, dynShmemBytes, focusBlock}
      this.reset();
      this.focusBlock = opts.focusBlock || 0;

      const kernel = parseKernel(opts.source);
      const jsBody = renameReservedParams(transpileBody(kernel.body),
                                          kernel.params);

      const gx = opts.grid[0], gy = opts.grid[1] || 1;
      const bx = opts.block[0], by = opts.block[1] || 1;
      const threadsPerBlock = bx * by;
      const numBlocks = gx * gy;
      const total = threadsPerBlock * numBlocks;
      if (threadsPerBlock > 1024)
        throw new Error("block size > 1024 threads (CUDA limit)");
      if (total > MAX_THREADS)
        throw new Error(`launch too big to simulate: ${total} threads ` +
                        `(playground cap ${MAX_THREADS})`);

      // Build the generator factory once.
      const paramNames = kernel.params.map(p => safeName(p.name));
      let factory;
      try {
        factory = new Function(
          "__ctx", ...paramNames,
          `const {threadIdx, blockIdx, blockDim, gridDim,
                  __SYNC, __i, __g, __rsqrt, __printf, __atomic,
                  __sharedAlloc, __sharedDyn, __shared2D} = __ctx;
           return (function* () {\n${jsBody}\n})();`);
      } catch (e) {
        throw new Error("Transpile error — this construct isn't in the " +
                        "supported CUDA subset: " + e.message);
      }

      // Wrap global buffers.
      const traced = {};
      for (const p of kernel.params) {
        if (p.isPtr) {
          if (!(p.name in opts.buffers))
            throw new Error("no buffer bound for parameter " + p.name);
          traced[p.name] = makeTracedBuffer(p.name, opts.buffers[p.name],
                                            "global", this);
        }
      }

      const sim = this;
      const blockDim = { x: bx, y: by, z: 1 };
      const gridDim = { x: gx, y: gy, z: 1 };

      let deadlock = false;

      for (let b = 0; b < numBlocks; b++) {
        const blockIdx = { x: b % gx, y: Math.floor(b / gx), z: 0 };

        // per-block shared memory pool
        const sharedPool = {};
        const sharedMeta = { bytes: 0 };
        const sharedAlloc = (nm, type, n) => {
          if (!sharedPool[nm]) {
            const T = TYPE_MAP[type] || Float32Array;
            const arr = new T(Math.max(1, n | 0));
            sharedMeta.bytes += arr.byteLength;
            if (sharedMeta.bytes > 101376)
              throw new Error("shared memory per block exceeds 99 KB");
            sharedPool[nm] = makeTracedBuffer(nm, arr, "shared", sim);
          }
          return sharedPool[nm];
        };
        const shared2D = (nm, type, d1, d2) => {
          const flat = sharedAlloc(nm, type, d1 * d2);
          if (!sharedPool[nm + "/2d"]) {
            const rows = [];
            for (let r = 0; r < d1; r++) {
              rows.push(new Proxy({}, {
                get: (_, pr) => flat[r * d2 + (+pr)],
                set: (_, pr, v) => { flat[r * d2 + (+pr)] = v; return true; },
              }));
            }
            sharedPool[nm + "/2d"] = rows;
          }
          return sharedPool[nm + "/2d"];
        };

        // spawn generators for every thread in the block
        const gens = [], states = [];
        for (let t = 0; t < threadsPerBlock; t++) {
          const threadIdx = { x: t % bx, y: Math.floor(t / bx), z: 0 };
          const warp = Math.floor(t / 32), lane = t % 32;
          const meta = {
            block: b, thread: t, warp, lane,
            key: b + ":" + t, seqCounter: { g: 0, s: 0 },
          };
          const ctx = {
            threadIdx, blockIdx, blockDim, gridDim,
            __SYNC: 0,
            __i: v => v | 0,
            __g: () => {
              if (++sim.ops > OPS_BUDGET)
                throw new Error("op budget exceeded — infinite loop? " +
                                "(guard trips after ~8M loop iterations)");
              // loop iterations count as per-lane work (divergence view)
              sim.perThreadOps.set(meta.key,
                                   (sim.perThreadOps.get(meta.key) || 0) + 1);
            },
            __rsqrt: v => 1 / Math.sqrt(v),
            __printf: (fmt, ...args) => sim.printf(meta, fmt, args),
            __atomic: (op, bufp, idx, v) => {
              sim.counts.atomics++;
              const old = bufp[idx];
              if (op === "add") bufp[idx] = old + v;
              else if (op === "sub") bufp[idx] = old - v;
              else if (op === "max") bufp[idx] = Math.max(old, v);
              else if (op === "min") bufp[idx] = Math.min(old, v);
              else if (op === "exch") bufp[idx] = v;
              return old;
            },
            __sharedAlloc: sharedAlloc,
            __sharedDyn: (nm, type) => {
              const T = TYPE_MAP[type] || Float32Array;
              const n = Math.floor((opts.dynShmemBytes || 0) /
                                   T.BYTES_PER_ELEMENT);
              return sharedAlloc(nm, type, n);
            },
            __shared2D: shared2D,
          };
          const args = kernel.params.map(p =>
            p.isPtr ? traced[p.name] : (opts.scalars[p.name] ?? 0));
          gens.push({ gen: factory(ctx, ...args), meta });
          states.push("run");
        }

        // barrier-stepped execution: run every live thread to its next
        // __syncthreads() (or completion), then release the barrier.
        let alive = threadsPerBlock, guard = 0;
        while (alive > 0) {
          if (++guard > 10000)
            throw new Error("barrier loop guard tripped");
          let atBarrier = 0, done = 0;
          for (let t = 0; t < threadsPerBlock; t++) {
            if (states[t] === "done") { done++; continue; }
            sim.cur = gens[t].meta;
            const r = gens[t].gen.next();
            sim.cur = null;
            if (r.done) { states[t] = "done"; done++; }
            else { states[t] = "barrier"; atBarrier++; sim.counts.syncs++; }
          }
          alive = threadsPerBlock - done;
          if (atBarrier > 0 && done > 0) {
            // Some threads exited while others wait at a barrier:
            // classic __syncthreads-in-divergent-branch deadlock.
            deadlock = true;
          }
          for (let t = 0; t < threadsPerBlock; t++)
            if (states[t] === "barrier") states[t] = "run";
          if (atBarrier === 0) break;
        }
      }

      return {
        kernel,
        deadlock,
        counts: this.counts,
        trace: this.trace,
        printfLines: this.printfLines,
        perThreadOps: this.perThreadOps,
        launch: { gx, gy, bx, by, threadsPerBlock, numBlocks, total },
      };
    }

    printf(meta, fmt, args) {
      if (this.printfLines.length >= 400) return;
      let i = 0;
      const line = String(fmt).replace(/%[-+ 0-9.]*([dufxXge])/g, (m, c) => {
        const v = args[i++];
        if (v === undefined) return m;
        if (c === "d" || c === "u") return String(Math.trunc(v));
        if (c === "x" || c === "X") return (v >>> 0).toString(16);
        if (c === "f") return Number(v).toFixed(4);
        return String(v);
      }).replace(/\\n/g, "");
      this.printfLines.push({
        block: meta.block, thread: meta.thread, text: line,
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* post-run analyses                                                   */
  /* ------------------------------------------------------------------ */

  // Group the focus block's global accesses into warp transactions:
  // the k-th global access of each lane in a warp forms one request;
  // count unique 32-byte sectors it touches.
  function analyzeCoalescing(trace) {
    const groups = new Map(); // "warp:seq:rw" -> lanes[]
    for (const a of trace) {
      if (a.space !== "global") continue;
      const key = a.warp + ":" + a.seq + ":" + a.rw;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    const requests = [];
    let totTransactions = 0, totIdeal = 0, totBytes = 0;
    for (const [key, lanes] of groups) {
      const sectors = new Set();
      for (const a of lanes) sectors.add(Math.floor(a.byte / 32));
      const bytes = lanes.reduce((s, a) => s + a.bpe, 0);
      const ideal = Math.max(1, Math.ceil(bytes / 32));
      totTransactions += sectors.size;
      totIdeal += ideal;
      totBytes += bytes;
      requests.push({
        key, warp: lanes[0].warp, seq: lanes[0].seq, rw: lanes[0].rw,
        buf: lanes[0].buf, lanes, sectors: sectors.size, ideal,
      });
    }
    requests.sort((a, b) => a.warp - b.warp || a.seq - b.seq);
    return {
      requests, totTransactions, totIdeal,
      efficiency: totTransactions ? totIdeal / totTransactions : 1,
      totBytes,
    };
  }

  // Shared-memory bank conflicts: 32 banks, 4-byte words. For each warp
  // request, conflict degree = max lanes hitting one bank at different
  // addresses (same-address broadcast is free).
  function analyzeBankConflicts(trace) {
    const groups = new Map();
    for (const a of trace) {
      if (a.space !== "shared") continue;
      const key = a.warp + ":" + a.seq + ":" + a.rw + ":" + a.buf;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    let worst = 1, conflicted = 0, total = 0;
    for (const [, lanes] of groups) {
      const banks = new Map(); // bank -> Set(word addr)
      for (const a of lanes) {
        const word = Math.floor(a.byte / 4);
        const bank = word % 32;
        if (!banks.has(bank)) banks.set(bank, new Set());
        banks.get(bank).add(word);
      }
      let deg = 1;
      for (const [, words] of banks) deg = Math.max(deg, words.size);
      total++;
      if (deg > 1) conflicted++;
      worst = Math.max(worst, deg);
    }
    return { worst, conflicted, total };
  }

  // Divergence estimate: for each warp of the focus block, compare per-lane
  // op counts; uniform warps have ratio 1.
  function analyzeDivergence(perThreadOps, focusBlock, threadsPerBlock) {
    const warps = Math.ceil(threadsPerBlock / 32);
    const perWarp = [];
    for (let w = 0; w < warps; w++) {
      let mx = 0, mn = Infinity, n = 0;
      for (let l = 0; l < 32; l++) {
        const t = w * 32 + l;
        if (t >= threadsPerBlock) break;
        const ops = perThreadOps.get(focusBlock + ":" + t) || 0;
        mx = Math.max(mx, ops); mn = Math.min(mn, ops); n++;
      }
      perWarp.push({ warp: w, max: mx, min: mn === Infinity ? 0 : mn, lanes: n });
    }
    const divergent = perWarp.filter(w => w.max !== w.min).length;
    return { perWarp, divergent, warps };
  }

  // `self` is the global in both window and worker contexts.
  self.CudaSim = {
    CudaSim, parseKernel, transpileBody,
    analyzeCoalescing, analyzeBankConflicts, analyzeDivergence,
    TYPE_MAP, MAX_THREADS,
  };
})();
