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

  function stripComments(source) {
    const chars = source.split("");
    let quote = "";
    for (let i = 0; i < source.length; i++) {
      const c = source[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = "";
        continue;
      }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c !== "/") continue;
      if (source[i + 1] === "/") {
        for (; i < source.length && source[i] !== "\n"; i++)
          if (source[i] !== "\r") chars[i] = " ";
      } else if (source[i + 1] === "*") {
        chars[i++] = " "; chars[i] = " ";
        for (i++; i < source.length; i++) {
          if (source[i] === "*" && source[i + 1] === "/") {
            chars[i] = chars[i + 1] = " "; i++; break;
          }
          if (source[i] !== "\n" && source[i] !== "\r") chars[i] = " ";
        }
      }
    }
    return chars.join("");
  }

  // Extract the first __global__ kernel: name, params, body.
  function parseKernel(src) {
    const noComments = stripComments(src);

    const sig = /__global__\s+void\s+(\w+)\s*\(([^)]*)\)\s*\{/.exec(noComments);
    if (!sig) throw new Error(
      "No kernel found — expected `__global__ void name(...) { ... }`");

    const name = sig[1];
    const params = [];
    if (sig[2].trim()) {
      for (const raw of sig[2].split(",")) {
        const p = raw.trim().replace(/__restrict__/g, "").replace(/\s+/g, " ");
        const isPtr = p.includes("*");
        if ((p.match(/\*/g) || []).length > 1)
          throw new Error("Pointer-to-pointer kernel parameters are not supported");
        const isConst = /\bconst\b/.test(p);
        const clean = p.replace(/\bconst\b/g, "").replace(/\*/g, " ").trim();
        const parts = clean.split(/\s+/);
        const pname = parts.pop();
        const type = parts.join(" ") || "int";
        if (!/^[A-Za-z_]\w*$/.test(pname || ""))
          throw new Error("Unsupported kernel parameter declaration: " + raw.trim());
        if (!/^(?:float|double|int|unsigned|unsigned int|unsigned char|uchar|char|short|long long|size_t|uint32_t|int32_t)$/.test(type))
          throw new Error("Unsupported kernel parameter type: " + type);
        params.push({ name: pname, type, isPtr, isConst });
      }
    }
    const safeParamNames = params.map(p => safeName(p.name));
    if (new Set(safeParamNames).size !== safeParamNames.length ||
        safeParamNames.some(n => CONTEXT_NAMES.has(n)))
      throw new Error("Kernel parameter names must be unique and cannot shadow simulator internals");

    // Body: match braces from the signature's opening brace.
    let i = sig.index + sig[0].length, depth = 1, start = i;
    let quote = false;
    while (i < noComments.length && depth > 0) {
      const c = noComments[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === '"') quote = false;
      } else if (c === '"') quote = true;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    if (depth !== 0) throw new Error("Unbalanced braces in kernel body");
    return {
      name, params, body: noComments.slice(start, i - 1),
      bodyLine: noComments.slice(0, start).split("\n").length,
    };
  }

  const TRACE_HELPERS = new Set([
    "__ctx", "__SYNC", "__i", "__g", "__rsqrt", "__printf", "__atomic",
    "__sharedAlloc", "__sharedDyn", "__shared2D", "__traceStatement",
    "__traceBranch", "__traceStep",
  ]);
  const CONTEXT_NAMES = new Set([
    ...TRACE_HELPERS, "threadIdx", "blockIdx", "blockDim", "gridDim",
  ]);

  // Accept only identifiers and operators that the CUDA-subset transpiler
  // understands. Generated JavaScript executes in a Function scope, so
  // unknown names and JavaScript-only syntax must never reach that scope.
  function validateCudaBody(body, params) {
    const source = body.replace(/^[ \t]*#[^\n]*(?=\n|$)/gm,
                                m => m.replace(/[^\n]/g, " "));
    const declared = new Set(params.map(p => p.name));
    const declaration = /\b(?:unsigned\s+int|unsigned\s+char|long\s+long|uint32_t|int32_t|size_t|unsigned|int|float|double|bool|uchar)\s+(\w+)\b/g;
    let match;
    while ((match = declaration.exec(source))) declared.add(match[1]);
    const shared = /(?:extern\s+)?__shared__\s+[\w ]+?\s+(\w+)\s*\[/g;
    while ((match = shared.exec(source))) declared.add(match[1]);

    const known = new Set([
      "threadIdx", "blockIdx", "blockDim", "gridDim", "if", "else", "for",
      "while", "do", "break", "continue", "return", "int", "unsigned",
      "float", "double", "bool", "long", "size_t", "uint32_t", "int32_t",
      "uchar", "char", "short", "__shared__", "extern", "__syncthreads", "__syncwarp",
      "printf", "atomicAdd", "atomicSub", "atomicMax", "atomicMin", "atomicExch",
      "true", "false", "x", "y", "z", ...Object.keys(MATH_MAP),
    ]);
    const allowedOps = new Set([
      "{", "}", "(", ")", "[", "]", ";", ",", ".", "++", "--", "+", "-",
      "*", "/", "%", "<", ">", "<=", ">=", "==", "!=", "&&", "||", "!",
      "&", "|", "^", "~", "<<", ">>", "=", "+=", "-=", "*=", "/=", "%=",
      "&=", "|=", "^=", "<<=", ">>=",
    ]);
    const tokens = [];
    const opPattern = /^(?:<<=|>>=|\+\+|--|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<|>>|<=|>=|==|!=|&&|\|\||[{}()[\];,.+\-*/%<>!=&|^~=])/;
    let i = 0;
    while (i < source.length) {
      if (/\s/.test(source[i])) { i++; continue; }
      const start = i;
      if (source[i] === '"') {
        i++;
        let closed = false;
        while (i < source.length) {
          if (source[i] === "\\") { i += 2; continue; }
          if (source[i++] === '"') { closed = true; break; }
        }
        if (!closed) throw new Error("Unsupported unterminated string literal in CUDA body");
        const prior = tokens.slice(-2);
        if (prior.length !== 2 || prior[0].value !== "printf" || prior[1].value !== "(")
          throw new Error("String literals are supported only as printf format strings");
        tokens.push({ type: "string", value: source.slice(start, i) });
        continue;
      }
      const id = /^[A-Za-z_$][\w$]*/.exec(source.slice(i));
      if (id) {
        i += id[0].length;
        tokens.push({ type: "id", value: id[0] });
        continue;
      }
      const number = /^(?:0[xX][\da-fA-F]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)[uUlLfF]*/.exec(source.slice(i));
      if (number) {
        i += number[0].length;
        tokens.push({ type: "number", value: number[0] });
        continue;
      }
      const op = opPattern.exec(source.slice(i));
      if (["=>", "?.", "??", "**", "...", "->"].some(token => source.startsWith(token, i)))
        throw new Error("Unsupported JavaScript-only operator in CUDA body");
      if (!op || !allowedOps.has(op[0]))
        throw new Error("Unsupported CUDA token " + JSON.stringify(source[i]) +
                        " — JavaScript escape syntax is not allowed");
      i += op[0].length;
      tokens.push({ type: "op", value: op[0] });
    }

    const dims = new Set(["threadIdx", "blockIdx", "blockDim", "gridDim"]);
    for (let t = 0; t < tokens.length; t++) {
      const token = tokens[t];
      if (token.type === "id" && !declared.has(token.value) && !known.has(token.value))
        throw new Error("Unsupported CUDA identifier " + token.value +
                        " — helper functions and JavaScript globals are not allowed");
      if (token.type === "id" && TRACE_HELPERS.has(token.value))
        throw new Error("CUDA identifier is reserved by the simulator: " + token.value);
      if (["x", "y", "z"].includes(token.value) && !declared.has(token.value) &&
          tokens[t - 1]?.value !== ".")
        throw new Error("CUDA dimension components are valid only after threadIdx, blockIdx, blockDim, or gridDim");
      if (token.value === "." &&
          (!dims.has(tokens[t - 1]?.value) || !["x", "y", "z"].includes(tokens[t + 1]?.value)))
        throw new Error("Only .x, .y, and .z CUDA dimension access is supported");
    }
  }

  function stripPreprocessorLines(body) {
    return body.replace(/^[ \t]*#[^\n]*(?=\n|$)/gm,
                        m => m.replace(/[^\n]/g, " "));
  }

  // Insert line-aware trace hooks while the source is still CUDA. This small
  // statement walker handles the control-flow forms supported by the existing
  // transpiler, rather than guessing line mappings from rewritten JavaScript.
  function instrumentBody(body, lineBase) {
    const source = stripPreprocessorLines(body);
    const literals = [];
    let literalPrefix = "__CUDA_TRACE_LITERAL_TOKEN_";
    while (source.includes(literalPrefix)) literalPrefix += "_";
    const lineStarts = [0];
    for (let i = 0; i < source.length; i++)
      if (source[i] === "\n") lineStarts.push(i + 1);
    const lineAt = pos => {
      let lo = 0, hi = lineStarts.length;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (lineStarts[mid] <= pos) lo = mid; else hi = mid;
      }
      return lineBase + lo;
    };
    const skip = pos => { while (/\s/.test(source[pos] || "\0")) pos++; return pos; };
    const wordAt = (pos, word) => source.slice(pos, pos + word.length) === word &&
      !/[\w$]/.test(source[pos + word.length] || "");
    const matching = (pos, open, close) => {
      let depth = 0, quote = false;
      for (let i = pos; i < source.length; i++) {
        if (quote) {
          if (source[i] === "\\") i++;
          else if (source[i] === '"') quote = false;
          continue;
        }
        if (source[i] === '"') { quote = true; continue; }
        if (source[i] === open) depth++;
        else if (source[i] === close && --depth === 0) return i;
      }
      throw new Error("Unbalanced " + open + close + " in kernel body");
    };
    const splitFor = text => {
      const parts = []; let start = 0, paren = 0, bracket = 0, quote = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) {
          if (c === "\\") i++; else if (c === '"') quote = false;
          continue;
        }
        if (c === '"') quote = true;
        else if (c === "(") paren++;
        else if (c === ")") paren--;
        else if (c === "[") bracket++;
        else if (c === "]") bracket--;
        else if (c === ";" && !paren && !bracket) { parts.push(text.slice(start, i)); start = i + 1; }
      }
      parts.push(text.slice(start));
      if (parts.length !== 3) throw new Error("Unsupported for-loop header");
      return parts;
    };
    const call = (helper, line, kind, text) => {
      const literal = literals.push(text.slice(0, 240)) - 1;
      return `${helper}(${line}, ${JSON.stringify(kind)}, ${literalPrefix}${literal}__`;
    };

    function parseStatement(pos) {
      const start = skip(pos), leading = source.slice(pos, start), line = lineAt(start);
      if (start >= source.length) return { code: leading, next: start };
      if (source[start] === "{") {
        let cursor = start + 1, inner = "";
        while (skip(cursor) < source.length && source[skip(cursor)] !== "}") {
          const stmt = parseStatement(cursor);
          if (stmt.next <= cursor) throw new Error("Unable to parse CUDA block statement");
          inner += stmt.code; cursor = stmt.next;
        }
        const end = skip(cursor);
        if (source[end] !== "}") throw new Error("Unbalanced braces in kernel body");
        return { code: leading + "{" + inner + source.slice(cursor, end) + "}", next: end + 1 };
      }
      if (wordAt(start, "if")) {
        const open = skip(start + 2);
        if (source[open] !== "(") throw new Error("Unsupported if statement");
        const close = matching(open, "(", ")"), cond = source.slice(open + 1, close).trim();
        const yes = parseStatement(close + 1);
        let end = yes.next;
        let code = `${leading}if (${call("__traceBranch", line, "branch", cond)}, (${cond})))${yes.code}`;
        const after = skip(end);
        if (wordAt(after, "else")) {
          const no = parseStatement(after + 4);
          code += source.slice(end, after) + "else" + no.code;
          end = no.next;
        }
        return { code, next: end };
      }
      if (wordAt(start, "for")) {
        const open = skip(start + 3);
        if (source[open] !== "(") throw new Error("Unsupported for statement");
        const close = matching(open, "(", ")"), [init, cond, update] = splitFor(source.slice(open + 1, close));
        const initText = init.trim(), condText = cond.trim(), updateText = update.trim();
        const initHook = initText ? `${call("__traceStatement", line, "statement", initText)});` : "";
        const test = `${call("__traceBranch", line, "loop", condText || "true")}, (${condText || "true"}))`;
        const step = updateText
          ? `(${call("__traceStep", line, "update", updateText)}), (${updateText}))` : "";
        const body = parseStatement(close + 1);
        const header = `for (${init}${init.endsWith(" ") || !init ? "" : " "}; ${test}; ${step})`;
        const code = initText
          ? `${leading}{${initHook}${header}${body.code}}`
          : `${leading}${header}${body.code}`;
        return { code, next: body.next };
      }
      if (wordAt(start, "while")) {
        const open = skip(start + 5);
        if (source[open] !== "(") throw new Error("Unsupported while statement");
        const close = matching(open, "(", ")"), cond = source.slice(open + 1, close).trim();
        const body = parseStatement(close + 1), bodyStart = skip(close + 1);
        return {
          code: `${leading}while (${call("__traceBranch", line, "loop", cond)}, (${cond})))${body.code}`,
          next: body.next,
        };
      }
      if (wordAt(start, "do")) {
        const body = parseStatement(start + 2), tail = skip(body.next);
        if (!wordAt(tail, "while")) throw new Error("Unsupported do-loop");
        const open = skip(tail + 5), close = matching(open, "(", ")");
        const cond = source.slice(open + 1, close).trim(), semicolon = skip(close + 1);
        if (source[semicolon] !== ";") throw new Error("Malformed do-loop");
        return {
          code: `${leading}do${body.code}${source.slice(body.next, open + 1)}${call("__traceBranch", lineAt(tail), "loop", cond)}, (${cond})));`,
          next: semicolon + 1,
        };
      }

      let paren = 0, bracket = 0, quote = false, end = start;
      for (; end < source.length; end++) {
        const c = source[end];
        if (quote) {
          if (c === "\\") end++; else if (c === '"') quote = false;
          continue;
        }
        if (c === '"') quote = true;
        else if (c === "(") paren++;
        else if (c === ")") paren--;
        else if (c === "[") bracket++;
        else if (c === "]") bracket--;
        else if (c === ";" && paren === 0 && bracket === 0) break;
        else if (c === "}" && paren === 0 && bracket === 0)
          throw new Error("Missing semicolon in CUDA statement");
      }
      if (end >= source.length) {
        if (!source.slice(start).trim()) return { code: leading + source.slice(start), next: source.length };
        throw new Error("Missing semicolon in CUDA statement");
      }
      const text = source.slice(start, end).trim();
      if (!text) return { code: leading + ";", next: end + 1 };
      const hasMath = new RegExp("\\b(?:" + Object.keys(MATH_MAP).join("|") + ")\\s*\\(").test(text) ||
                      /(?:\+=|-=|\*=|\/=|%=|[+*/%-])/.test(text);
      const kind = /^(?:__syncthreads|__syncwarp)\s*\(/.test(text) ? "barrier" :
                   /^(?:return|break|continue)\b/.test(text) ? "control" :
                   hasMath ? "math" : "statement";
      return {
        code: `${leading}${call("__traceStatement", line, kind, text)});${source.slice(start, end + 1)}`,
        next: end + 1,
      };
    }

    let cursor = 0, output = "";
    while (skip(cursor) < source.length) {
      const statement = parseStatement(cursor);
      if (statement.next <= cursor) throw new Error("Unable to parse CUDA statement");
      output += statement.code;
      cursor = statement.next;
    }
    return { code: output + source.slice(cursor), literals, literalPrefix };
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
      js = js.replace(new RegExp("(^|[^\\w.])" + k + "\\s*\\(", "g"),
                      (m, prefix) => prefix + MATH_MAP[k] + "(");

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
        if (prop === "length") return target.length;
        if (typeof prop === "string" && /^-?\d+$/.test(prop)) {
          const value = target[prop];
          sim.record(name, +prop, "r", space, array.BYTES_PER_ELEMENT, value);
          return value;
        }
        throw new Error(`unsupported ${space} buffer property access: ${String(prop)}`);
      },
      set(target, prop, value) {
        if (typeof prop === "string" && /^-?\d+$/.test(prop)) {
          sim.record(name, +prop, "w", space, array.BYTES_PER_ELEMENT, value);
          if (+prop >= target.length)
            throw new Error(`out-of-bounds write: ${name}[${prop}] (size ${target.length})`);
          target[prop] = value;
          return true;
        }
        throw new Error(`unsupported ${space} buffer property assignment: ${String(prop)}`);
      },
    });
  }

  /* ------------------------------------------------------------------ */
  /* the simulator                                                       */
  /* ------------------------------------------------------------------ */

  const MAX_THREADS = 1 << 16;      // total threads per launch
  const MAX_TRACE = 250000;         // recorded accesses (focus block only)
  const OPS_BUDGET = 8_000_000;     // loop-guard budget for the whole launch
  const MAX_EXECUTION_TRACE = 50000;
  const DEFAULT_EXECUTION_TRACE = 20000;
  const traceValue = value => {
    if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") return value.slice(0, 120);
    return String(value).slice(0, 120);
  };

  class CudaSim {
    constructor() { this.reset(); }

    reset() {
      this.trace = [];              // focus-block access records
      this.executionTrace = [];
      this.traceLimit = DEFAULT_EXECUTION_TRACE;
      this.traceAttempted = 0;
      this.traceDropped = 0;
      this.counts = { gld: 0, gst: 0, shld: 0, shst: 0, atomics: 0, syncs: 0 };
      this.printfLines = [];
      this.perThreadOps = new Map();// "b:t" -> op count (divergence estimate)
      this.ops = 0;
      this.cur = null;              // {block, thread, warp, lane, key}
      this.focusBlock = 0;
    }

    record(buf, index, rw, space, bpe, value) {
      const c = this.counts;
      if (space === "global") { rw === "r" ? c.gld++ : c.gst++; }
      else { rw === "r" ? c.shld++ : c.shst++; }
      const t = this.cur;
      if (t) this.perThreadOps.set(t.key, (this.perThreadOps.get(t.key) || 0) + 1);
      if (t) {
        if (this.executionTrace.length >= this.traceLimit) this.dropEvent();
        else {
          const operation = rw === "r" ? "read" : "write";
          const printable = traceValue(value);
          this.event(t, t.sourceLine, "memory",
            `${space} ${operation} ${buf}[${index}] = ${printable}`,
            { buffer: buf, index, space, operation, byte: index * bpe, value: printable });
        }
      }
      if (t && t.block === this.focusBlock && this.trace.length < MAX_TRACE) {
        this.trace.push({
          buf, index, rw, space,
          byte: index * bpe, bpe,
          warp: t.warp, lane: t.lane, thread: t.thread,
          seq: t.seqCounter[space === "global" ? "g" : "s"]++,
        });
      }
    }

    event(meta, line, kind, explanation, details) {
      this.traceAttempted++;
      if (this.executionTrace.length >= this.traceLimit) {
        this.traceDropped++;
        return;
      }
      this.executionTrace.push({
        sequence: this.executionTrace.length,
        line: Number.isInteger(line) ? line : null,
        blockId: meta.block,
        block: { x: meta.blockX, y: meta.blockY, z: 0 },
        threadId: meta.thread,
        thread: { x: meta.threadX, y: meta.threadY, z: 0 },
        warpId: meta.warp,
        lane: meta.lane,
        kind,
        explanation: String(explanation).slice(0, 300),
        ...(details ? { details } : {}),
      });
    }

    dropEvent() {
      this.traceAttempted++;
      this.traceDropped++;
    }

    getTraceMeta() {
      return { limit: this.traceLimit, recorded: this.executionTrace.length,
        attempted: this.traceAttempted, dropped: this.traceDropped,
        truncated: this.traceDropped > 0 };
    }

    /* ---- run a launch ------------------------------------------------ */

    run(opts) {
      // opts: {source, grid:[x,y], block:[x,y], buffers:{name:TypedArray},
      //        scalars:{name:value}, dynShmemBytes, focusBlock}
      this.reset();
      this.focusBlock = opts.focusBlock || 0;
      const requestedTraceLimit = opts.traceLimit;
      this.traceLimit = requestedTraceLimit == null ? DEFAULT_EXECUTION_TRACE :
        Math.min(MAX_EXECUTION_TRACE, Math.max(0,
          Number.isFinite(+requestedTraceLimit) ? Math.floor(+requestedTraceLimit) : DEFAULT_EXECUTION_TRACE));

      const kernel = parseKernel(opts.source);
      validateCudaBody(kernel.body, kernel.params);
      const instrumented = instrumentBody(kernel.body, kernel.bodyLine);
      const jsBody = renameReservedParams(transpileBody(instrumented.code),
        kernel.params).replace(new RegExp(instrumented.literalPrefix + "(\\d+)__", "g"),
          (_, index) => JSON.stringify(instrumented.literals[+index]));

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
                  __sharedAlloc, __sharedDyn, __shared2D,
                  __traceStatement, __traceBranch, __traceStep} = __ctx;
           return (function* () {\n${jsBody}\n})();`);
      } catch (e) {
        throw new Error("Transpile error — this construct isn't in the " +
                        "supported CUDA subset: " + e.message);
      }

      // Wrap global buffers.
      const traced = Object.create(null);
      for (const p of kernel.params) {
        if (p.isPtr) {
          if (!opts.buffers || !Object.prototype.hasOwnProperty.call(opts.buffers, p.name))
            throw new Error("no buffer bound for parameter " + p.name);
          const buffer = opts.buffers[p.name];
          if (!ArrayBuffer.isView(buffer) || !Number.isFinite(buffer.BYTES_PER_ELEMENT))
            throw new Error("buffer for parameter " + p.name + " must be a typed array");
          traced[p.name] = makeTracedBuffer(p.name, buffer,
                                            "global", this);
        }
      }

      const sim = this;
      const dimensions = (x, y, z) => Object.freeze(Object.assign(Object.create(null), { x, y, z }));
      const blockDim = dimensions(bx, by, 1);
      const gridDim = dimensions(gx, gy, 1);

      let deadlock = false;

      for (let b = 0; b < numBlocks; b++) {
        const blockIdx = dimensions(b % gx, Math.floor(b / gx), 0);

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
          const threadIdx = dimensions(t % bx, Math.floor(t / bx), 0);
          const warp = Math.floor(t / 32), lane = t % 32;
          const meta = {
            block: b, thread: t, warp, lane,
            blockX: blockIdx.x, blockY: blockIdx.y,
            threadX: threadIdx.x, threadY: threadIdx.y,
            sourceLine: null,
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
            __traceStatement: (line, kind, statement) => {
              meta.sourceLine = line;
              if (sim.executionTrace.length >= sim.traceLimit) {
                sim.dropEvent();
                return;
              }
              const label = kind === "barrier" ? "barrier" :
                kind === "control" ? "control statement" : "execute statement";
              sim.event(meta, line, kind, `${label}: ${statement}`, { statement });
            },
            __traceBranch: (line, kind, condition, value) => {
              meta.sourceLine = line;
              const outcome = !!value;
              if (sim.executionTrace.length >= sim.traceLimit) {
                sim.dropEvent();
                return outcome;
              }
              sim.event(meta, line, kind,
                `${kind === "loop" ? "loop" : "branch"} condition evaluated ${outcome}: ${condition}`,
                { condition, outcome });
              return outcome;
            },
            __traceStep: (line, kind, statement) => {
              meta.sourceLine = line;
              if (sim.executionTrace.length >= sim.traceLimit) {
                sim.dropEvent();
                return;
              }
              sim.event(meta, line, kind, `execute loop ${kind}: ${statement}`, { statement });
            },
            __atomic: (op, bufp, idx, v) => {
              sim.counts.atomics++;
              const old = bufp[idx];
              if (op === "add") bufp[idx] = old + v;
              else if (op === "sub") bufp[idx] = old - v;
              else if (op === "max") bufp[idx] = Math.max(old, v);
              else if (op === "min") bufp[idx] = Math.min(old, v);
              else if (op === "exch") bufp[idx] = v;
              if (sim.executionTrace.length >= sim.traceLimit) sim.dropEvent();
              else sim.event(meta, meta.sourceLine, "atomic",
                  `${op} memory[${idx}] changed from ${traceValue(old)} to ${traceValue(bufp[idx])}`,
                  { operation: op, index: idx, old: traceValue(old), value: traceValue(bufp[idx]) });
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
          const args = kernel.params.map(p => {
            if (p.isPtr) return traced[p.name];
            const scalars = opts.scalars || Object.create(null);
            const value = Object.prototype.hasOwnProperty.call(scalars, p.name)
              ? scalars[p.name] : 0;
            if (typeof value !== "number")
              throw new Error("scalar for parameter " + p.name + " must be a number");
            return value;
          });
          gens.push({ gen: factory(ctx, ...args), meta });
          states.push("run");
        }

        // barrier-stepped execution: run every live thread to its next
        // __syncthreads() (or completion), then release the barrier.
        let alive = threadsPerBlock, guard = 0;
        while (alive > 0) {
          if (++guard > 10000) {
            const pending = states.findIndex(state => state !== "done");
            const meta = gens[pending].meta;
            sim.event(meta, meta.sourceLine, "error", "barrier loop guard tripped",
              { message: "barrier loop guard tripped" });
            throw new Error("barrier loop guard tripped");
          }
          let atBarrier = 0, done = 0;
          for (let t = 0; t < threadsPerBlock; t++) {
            if (states[t] === "done") { done++; continue; }
            sim.cur = gens[t].meta;
            let r;
            try {
              r = gens[t].gen.next();
            } catch (error) {
              sim.event(gens[t].meta, gens[t].meta.sourceLine, "error",
                `execution error: ${String(error && error.message || error)}`,
                { message: String(error && error.message || error).slice(0, 240) });
              throw error;
            } finally {
              sim.cur = null;
            }
            if (r.done) { states[t] = "done"; done++; }
            else { states[t] = "barrier"; atBarrier++; sim.counts.syncs++; }
          }
          alive = threadsPerBlock - done;
          if (atBarrier > 0 && done > 0) {
            // Some threads exited while others wait at a barrier:
            // classic __syncthreads-in-divergent-branch deadlock.
            if (!deadlock) {
              deadlock = true;
              const waiting = states.findIndex(state => state === "barrier");
              sim.event(gens[waiting].meta, gens[waiting].meta.sourceLine, "deadlock",
                "possible __syncthreads deadlock: some threads exited while others wait at a barrier",
                { waitingThreads: atBarrier, exitedThreads: done });
            }
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
        trace: this.executionTrace,
        traceMeta: this.getTraceMeta(),
        accessTrace: this.trace,
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
