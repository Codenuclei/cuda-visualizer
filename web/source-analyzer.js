(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SourceAnalyzer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_SOURCE_CHARS = 1024 * 1024;
  const MAX_SOURCE_LINES = 20000;
  const MAX_OUTLINE = 150;
  const analysisDetails = new WeakMap();

  function detectLanguage(path, requested) {
    const raw = typeof requested === 'string' ? requested.trim().toLowerCase() : '';
    const pathName = (typeof path === 'string' ? path : '').split(/[?#]/, 1)[0];
    const extension = /\.([^.\/]+)$/.exec(pathName);
    const value = raw || (extension ? extension[1].toLowerCase() : pathName.toLowerCase());
    const aliases = {
      js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
      ts: 'typescript', tsx: 'typescript',
      py: 'python', python3: 'python', rs: 'rust',
      cu: 'cuda', cuh: 'cuda', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
      md: 'markdown', markdown: 'markdown'
    };
    if (aliases[value]) return aliases[value];
    if (['javascript', 'typescript', 'python', 'cuda', 'c', 'cpp', 'markdown'].includes(value)) return value;
    return value || 'text';
  }

  function boundedSource(text) {
    let source = typeof text === 'string' ? text : '';
    let truncated = source.length > MAX_SOURCE_CHARS;
    if (truncated) source = source.slice(0, MAX_SOURCE_CHARS);
    let lines = 1;
    for (let i = 0; i < source.length; i += 1) {
      if (source.charCodeAt(i) === 10 && ++lines > MAX_SOURCE_LINES) {
        source = source.slice(0, i);
        truncated = true;
        break;
      }
    }
    return { source, truncated };
  }

  function maskCommentsAndStrings(source, language) {
    const parts = [];
    let copied = 0;
    let i = 0;
    const python = language === 'python';
    const cpp = language === 'cpp' || language === 'cuda' || language === 'c';
    const blank = (start, end) => source.slice(start, end).replace(/[^\r\n]/g, ' ');
    const skipQuoted = (start, quote, triple) => {
      let at = start + (triple ? 3 : 1);
      while (at < source.length) {
        if (source[at] === '\\') {
          at += 2;
          continue;
        }
        if (triple && source.startsWith(quote.repeat(3), at)) return at + 3;
        if (!triple && source[at] === quote) return at + 1;
        at += 1;
      }
      return source.length;
    };

    while (i < source.length) {
      let end = i;
      if (source.startsWith('//', i) && !python) {
        end = source.indexOf('\n', i);
        if (end < 0) end = source.length;
      } else if (source.startsWith('/*', i) && !python) {
        const close = source.indexOf('*/', i + 2);
        end = close < 0 ? source.length : close + 2;
      } else if (python && source[i] === '#') {
        end = source.indexOf('\n', i);
        if (end < 0) end = source.length;
      } else {
        let quoteAt = i;
        if (cpp) {
          const rawPrefix = /^(?:u8|u|U|L)?R"/.exec(source.slice(i, i + 5));
          if (rawPrefix) {
            const delimiterStart = i + rawPrefix[0].length;
            const open = source.indexOf('(', delimiterStart);
            if (open >= 0 && open - delimiterStart <= 16) {
              const terminator = `)${source.slice(delimiterStart, open)}"`;
              const close = source.indexOf(terminator, open + 1);
              end = close < 0 ? source.length : close + terminator.length;
            }
          }
        }
        if (end === i) {
          if (python) {
            while (quoteAt < source.length && /[rRuUbBfF]/.test(source[quoteAt]) && quoteAt - i < 3) quoteAt += 1;
          }
          const quote = source[quoteAt];
          if (quote === '"' || quote === "'") {
            const triple = python && source.startsWith(quote.repeat(3), quoteAt);
            end = skipQuoted(quoteAt, quote, triple);
          }
        }
      }
      if (end > i) {
        parts.push(source.slice(copied, i), blank(i, end));
        copied = end;
        i = end;
      } else {
        i += 1;
      }
    }
    parts.push(source.slice(copied));
    return parts.join('');
  }

  function delimiterPairs(code) {
    const pairs = new Int32Array(code.length);
    pairs.fill(-1);
    const stack = new Int32Array(code.length);
    const types = new Uint8Array(code.length);
    let depth = 0;
    const opening = { '(': 1, '[': 2, '{': 3 };
    const closing = { ')': 1, ']': 2, '}': 3 };
    for (let i = 0; i < code.length; i += 1) {
      const type = opening[code[i]];
      if (type) {
        stack[depth] = i;
        types[depth] = type;
        depth += 1;
      } else {
        const closeType = closing[code[i]];
        if (closeType && depth && types[depth - 1] === closeType) {
          const start = stack[--depth];
          pairs[start] = i;
          pairs[i] = start;
        }
      }
    }
    return pairs;
  }

  function lineIndex(source) {
    const starts = [0];
    for (let i = 0; i < source.length; i += 1) if (source.charCodeAt(i) === 10) starts.push(i + 1);
    return starts;
  }

  function lineAt(starts, offset) {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (starts[middle] <= offset) low = middle + 1;
      else high = middle;
    }
    return Math.max(1, low);
  }

  function declaration(name, kind, start, end, starts) {
    const startLine = lineAt(starts, start);
    const endLine = Math.max(startLine, lineAt(starts, Math.max(start, end - 1)));
    return {
      id: `${kind}:${startLine}:${name}`,
      name,
      kind,
      startLine,
      endLine
    };
  }

  function addBlockDeclaration(result, code, match, name, kind, pairs, starts, searchFrom, declarationStart) {
    const start = declarationStart == null ? match.index : declarationStart;
    const bodySearch = searchFrom == null ? match.index + match[0].length : searchFrom;
    const open = code.indexOf('{', bodySearch);
    if (open >= bodySearch + 5000) {
      const lineEnd = code.indexOf('\n', start);
      result.push(declaration(name, kind, start, lineEnd < 0 ? code.length : lineEnd, starts));
      return;
    }
    if (open < 0) {
      const lineEnd = code.indexOf('\n', start);
      result.push(declaration(name, kind, start, lineEnd < 0 ? code.length : lineEnd, starts));
      return;
    }
    const close = pairs[open];
    result.push(declaration(name, kind, start, close < 0 ? open + 1 : close + 1, starts));
  }

  function jsFunctionBody(code, start, pairs) {
    const parameters = code.indexOf('(', start);
    if (parameters < start || parameters >= start + 1000) return -1;
    const close = pairs[parameters];
    if (close < parameters) return -1;
    for (let i = close + 1; i < Math.min(code.length, close + 5000); i += 1) {
      if (code[i] === '{') return i;
      if (code[i] === ';') return -1;
    }
    return -1;
  }

  function jsOutline(code, pairs, starts) {
    const result = [];
    let match;
    const fn = /(?:^|[;{}]|\n)[ \t]*(?:export\s+(?:default\s+)?)?(?:(?:declare|async|abstract)\s+)*function\s*\*?\s*([A-Za-z_$][\w$]*)?/gm;
    while ((match = fn.exec(code)) && result.length < 500) {
      const name = match[1] || 'default';
      const start = match.index + match[0].indexOf('function');
      const body = jsFunctionBody(code, start, pairs);
      if (body >= 0) {
        const close = pairs[body];
        result.push(declaration(name, 'function', start, close < body ? body + 1 : close + 1, starts));
      } else {
        addBlockDeclaration(result, code, match, name, 'function', pairs, starts, undefined, start);
      }
    }
    const cls = /(?:^|[;{}]|\n)[ \t]*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm;
    while ((match = cls.exec(code)) && result.length < 500) {
      const start = match.index + match[0].indexOf('class');
      addBlockDeclaration(result, code, match, match[1], 'class', pairs, starts, undefined, start);
    }

    const variables = /(?:^|[;{}]|\n)[ \t]*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:\:[^=;\n]+)?=/gm;
    while ((match = variables.exec(code)) && result.length < 500) {
      const searchEnd = Math.min(code.length, match.index + 10000);
      const declarationStart = match.index + match[0].search(/(?:const|let|var)\s/);
      const initializerStart = match.index + match[0].length;
      const arrow = code.indexOf('=>', initializerStart);
      const semicolon = code.indexOf(';', initializerStart);
      if (arrow < 0 || arrow >= searchEnd || (semicolon >= 0 && semicolon < arrow)) continue;
      const bodyStart = arrow + 2;
      let cursor = bodyStart;
      while (cursor < code.length && /\s/.test(code[cursor])) cursor += 1;
      let end;
      if (code[cursor] === '{' && pairs[cursor] >= cursor) {
        end = pairs[cursor] + 1;
      } else if (code[cursor] === '(' && pairs[cursor] >= cursor) {
        end = pairs[cursor] + 1;
      } else {
        end = cursor;
        while (end < code.length && code[end] !== ';' && code[end] !== '\n') end += 1;
      }
      result.push(declaration(match[1], 'function', declarationStart, Math.max(end, bodyStart), starts));
    }

    const exported = /^[ \t]*export\s+(?:(?:declare|abstract)\s+)?(interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
    while ((match = exported.exec(code)) && result.length < 500) {
      if (['const', 'let', 'var'].includes(match[1])) {
        const arrow = code.indexOf('=>', match.index + match[0].length);
        const semicolon = code.indexOf(';', match.index + match[0].length);
        if (arrow >= 0 && arrow - match.index < 10000 && (semicolon < 0 || arrow < semicolon)) continue;
      }
      if (['interface', 'enum'].includes(match[1])) {
        addBlockDeclaration(result, code, match, match[2], 'export', pairs, starts);
      } else {
        const lineEnd = code.indexOf('\n', match.index);
        result.push(declaration(match[2], 'export', match.index, lineEnd < 0 ? code.length : lineEnd, starts));
      }
    }
    const exportList = /^[ \t]*export\s*\{([^}\n]*)\}/gm;
    while ((match = exportList.exec(code)) && result.length < 500) {
      for (const item of match[1].split(',')) {
        const names = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?/.exec(item);
        if (names) result.push(declaration(names[2] || names[1], 'export', match.index, exportList.lastIndex, starts));
      }
    }
    return result;
  }

  function pythonOutline(code, starts, pairs) {
    const result = [];
    const lines = code.split('\n');
    const matches = [];
    for (let i = 0; i < lines.length && result.length + matches.length < 500; i += 1) {
      let match = /^[ \t]*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(lines[i]);
      if (match) matches.push({ index: i, name: match[1], kind: 'function', headerStart: (starts[i] || 0) + match.index });
      else {
        match = /^[ \t]*class\s+([A-Za-z_]\w*)\b/.exec(lines[i]);
        if (match) matches.push({ index: i, name: match[1], kind: 'class', headerStart: (starts[i] || 0) + match.index });
      }
    }
    for (const item of matches) {
      const line = lines[item.index];
      const indent = (line.match(/^[ \t]*/) || [''])[0].length;
      const declarationStart = starts[item.index] || 0;
      let open = code.indexOf('(', item.headerStart);
      if (open >= 0 && lineAt(starts, open) > item.index + 1) open = -1;
      const close = open >= 0 ? pairs[open] : -1;
      const headerSearch = close >= open ? close + 1 : item.headerStart;
      const colonInHeader = code.slice(headerSearch, headerSearch + 5000).indexOf(':');
      const headerColon = colonInHeader < 0 ? -1 : headerSearch + colonInHeader;
      const headerEndLine = headerColon >= 0 ? lineAt(starts, headerColon) - 1 : item.index;
      let endLine = lines.length;
      for (let next = headerEndLine + 1; next < lines.length; next += 1) {
        if (!lines[next].trim()) continue;
        if ((lines[next].match(/^[ \t]*/) || [''])[0].length <= indent) {
          endLine = next;
          break;
        }
      }
      const start = declarationStart;
      while (endLine > item.index + 1 && !lines[endLine - 1].trim()) endLine -= 1;
      const end = endLine < lines.length ? starts[endLine] : code.length;
      result.push(declaration(item.name, item.kind, start, end, starts));
    }
    return result;
  }

  function cOutline(code, pairs, starts, language) {
    const result = [];
    const keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'alignof', 'decltype', 'do', 'else']);
    const signature = /^[ \t]*(?:(?:static|inline|constexpr|extern|__host__|__device__|__global__|virtual|unsigned|signed|long|short|const|volatile|friend|typename)\s+)*(?:[A-Za-z_]\w*(?:::\w+)?[\s*&<>]*\s+)+([A-Za-z_~]\w*(?:::\w+)?|operator\s*[\w+\-*/=<>!]+)\s*\(/gm;
    let match;
    while ((match = signature.exec(code)) && result.length < 500) {
      const name = match[1].replace(/\s+/g, '');
      if (keywords.has(name) || name.includes('::') && name.endsWith('::')) continue;
      const open = code.indexOf('(', match.index + match[0].lastIndexOf(name));
      const close = pairs[open];
      if (close < open) continue;
      let cursor = close + 1;
      let body = -1;
      while (cursor < code.length && cursor - close < 5000) {
        if (code[cursor] === ';') break;
        if (code[cursor] === '{') { body = cursor; break; }
        const paired = pairs[cursor];
        if ((code[cursor] === '(' || code[cursor] === '[') && paired > cursor) cursor = paired;
        cursor += 1;
      }
      if (body < 0) continue;
      const end = pairs[body] >= body ? pairs[body] + 1 : body + 1;
      const isKernel = language === 'cuda' && code.slice(match.index, open).includes('__global__');
      result.push(declaration(name, isKernel ? 'kernel' : 'function', match.index, end, starts));
    }
    return result;
  }

  function markdownOutline(source, starts) {
    const lines = source.split('\n');
    const headings = [];
    for (let i = 0; i < lines.length && headings.length < 500; i += 1) {
      const match = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
      if (match) headings.push({ index: i, depth: match[1].length, name: match[2].trim() });
    }
    return headings.map((heading, headingIndex) => {
      let end = lines.length;
      for (let next = headingIndex + 1; next < headings.length; next += 1) {
        if (headings[next].depth <= heading.depth) {
          end = headings[next].index;
          break;
        }
      }
      return declaration(heading.name, 'section', starts[heading.index] || 0,
        end < lines.length ? starts[end] : source.length, starts);
    });
  }

  function extractImports(source, masked, language) {
    const records = [];
    const originals = source.split('\n');
    const visible = masked.split('\n');
    for (let i = 0; i < visible.length && records.length < 100; i += 1) {
      const codeLine = visible[i];
      const sourceLine = originals[i] || '';
      let found = [];
      if (language === 'javascript' || language === 'typescript') {
        if (/^\s*(?:import\b|export\b.*\bfrom\b)/.test(codeLine)) {
          const match = /(?:\bfrom\s*)?['"]([^'"]+)['"]/.exec(sourceLine);
          if (match) found = [match[1]];
        }
      } else if (language === 'python') {
        let match = /^\s*from\s+([\w.]+)\s+import\b/.exec(codeLine);
        if (match) found = [match[1]];
        else if ((match = /^\s*import\s+([\w., ]+)/.exec(codeLine))) {
          found = match[1].split(',').map((name) => name.trim().split(/\s+as\s+/)[0]).filter(Boolean);
        }
      } else if (['c', 'cpp', 'cuda'].includes(language)) {
        const match = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/.exec(sourceLine);
        if (match && /^\s*#\s*include\b/.test(codeLine)) found = [match[1]];
      }
      for (const name of found) {
        records.push({ name, line: i + 1 });
        if (records.length >= 100) break;
      }
    }
    return records;
  }

  function lexicalObservations(masked) {
    const observations = [];
    const loops = (masked.match(/\b(?:for|while|do)\b/g) || []).length;
    const returns = (masked.match(/\breturn\b/g) || []).length;
    const mathNames = [...new Set(masked.match(/\b(?:sqrt|sin|cos|tan|exp|log|pow|dot|matmul|sum|reduce|tanh|softmax|sigmoid)\b/g) || [])];
    if (loops) observations.push(`Contains ${loops} loop keyword occurrence(s) (for/while/do); this does not establish runtime behavior.`);
    if (returns) observations.push(`Contains ${returns} return keyword occurrence(s); this does not establish what values are returned.`);
    if (mathNames.length) observations.push(`Contains math/API identifier(s): ${mathNames.slice(0, 12).join(', ')}; names alone do not establish their semantics.`);
    return observations;
  }

  function summarizeDeclarations(outline) {
    if (!outline.length) return 'No supported declarations were detected by the structural heuristics.';
    const counts = {};
    for (const item of outline) counts[item.kind] = (counts[item.kind] || 0) + 1;
    const kinds = Object.keys(counts).map((kind) => `${counts[kind]} ${kind}${counts[kind] === 1 ? '' : 's'}`).join(', ');
    const names = outline.slice(0, 4).map((item) => `${item.name} (line ${item.startLine})`).join(', ');
    return `Detected ${outline.length} structural item(s): ${kinds}. The first detected names are ${names}${outline.length > 4 ? ', and others' : ''}.`;
  }

  function analyze(text, options = {}) {
    if (!options || typeof options !== 'object') options = {};
    const { source, truncated: sourceTruncated } = boundedSource(text);
    const language = detectLanguage(options.path, options.language);
    const lineCount = source ? source.split('\n').length : 0;
    const starts = lineIndex(source);
    const masked = ['javascript', 'typescript', 'python', 'cuda', 'c', 'cpp'].includes(language)
      ? maskCommentsAndStrings(source, language)
      : source;
    const pairs = delimiterPairs(masked);
    let found = [];
    if (['javascript', 'typescript'].includes(language)) found = jsOutline(masked, pairs, starts);
    else if (language === 'python') found = pythonOutline(masked, starts, pairs);
    else if (['cuda', 'c', 'cpp'].includes(language)) found = cOutline(masked, pairs, starts, language);
    else if (language === 'markdown') found = markdownOutline(source, starts);

    found.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine || a.name.localeCompare(b.name));
    const tooMany = found.length > MAX_OUTLINE;
    const outline = found.slice(0, MAX_OUTLINE);
    const truncated = sourceTruncated || tooMany;
    const imports = extractImports(source, masked, language).map((item) => item.name);
    const supported = ['javascript', 'typescript', 'python', 'cuda', 'c', 'cpp', 'markdown'].includes(language);
    const limitations = [];
    if (supported) limitations.push('Declaration discovery and line ranges use deterministic lexical and indentation heuristics, not a language parser.');
    else limitations.push(`Language "${language}" is unsupported; only the bounded line count is reported, with no semantic analysis.`);
    limitations.push('This analyzer does not execute, compile, translate, or judge the correctness or behavior of source code.');
    if (truncated) limitations.push(`Analysis was bounded to ${MAX_SOURCE_CHARS} source characters, ${MAX_SOURCE_LINES} lines, and ${MAX_OUTLINE} outline items.`);

    const observations = [];
    if (supported) {
      observations.push(summarizeDeclarations(outline));
      if (imports.length) observations.push(`Imports/references detected: ${imports.slice(0, 12).join(', ')}${imports.length > 12 ? ', and others' : ''}.`);
      else observations.push('No static imports/includes were detected by the language-specific patterns.');
      observations.push(...lexicalObservations(masked));
    }
    const summary = supported
      ? `This ${language} source contains ${lineCount} physical line(s). ${summarizeDeclarations(outline)}${truncated ? ' The result is truncated to the analyzer limits.' : ''}`
      : `This source contains ${lineCount} physical line(s). ${limitations[0]}`;
    const result = {
      language,
      lineCount,
      summary,
      outline,
      imports,
      observations,
      limitations,
      truncated
    };
    analysisDetails.set(result, { source, masked, starts, importRecords: extractImports(source, masked, language) });
    return result;
  }

  function summarizeSelection(analysis, symbolId) {
    const outline = analysis && Array.isArray(analysis.outline) ? analysis.outline : [];
    const selected = outline.find((item) => item.id === symbolId);
    if (!selected) {
      return {
        title: 'No symbol selected',
        summary: 'Choose a detected outline item to review its bounded source range.',
        observations: [],
        limitations: ['Only detected outline items can be selected; this tool does not infer symbols from unsupported syntax.'],
        startLine: null,
        endLine: null
      };
    }
    const details = analysisDetails.get(analysis);
    const startLine = selected.startLine;
    const endLine = selected.endLine;
    const span = Math.max(1, endLine - startLine + 1);
    const observations = [`Selected ${selected.kind} "${selected.name}" spans ${span} physical line(s), from line ${startLine} through line ${endLine}.`];
    const nested = outline.filter((item) => item.id !== selected.id && item.startLine >= startLine && item.endLine <= endLine);
    if (nested.length) observations.push(`Detected nested outline item(s): ${nested.slice(0, 8).map((item) => `${item.name} (${item.kind})`).join(', ')}${nested.length > 8 ? ', and others' : ''}.`);
    let limitations = (analysis.limitations || []).slice();
    if (details) {
      const localImports = details.importRecords.filter((item) => item.line >= startLine && item.line <= endLine).map((item) => item.name);
      if (localImports.length) observations.push(`Imports/includes within this range: ${[...new Set(localImports)].join(', ')}.`);
      const firstOffset = details.starts[startLine - 1] || 0;
      const lastOffset = endLine < details.starts.length ? details.starts[endLine] : details.source.length;
      observations.push(...lexicalObservations(details.masked.slice(firstOffset, lastOffset)));
    } else {
      limitations.push('Selection details are limited to the supplied outline because this analysis was copied or serialized.');
    }
    return {
      title: selected.name,
      summary: `The selected ${selected.kind} "${selected.name}" occupies lines ${startLine}–${endLine}. This is a structural range from the analyzer's heuristics, not an explanation or validation of the code's behavior.`,
      observations,
      limitations,
      startLine,
      endLine
    };
  }

  return { analyze, summarizeSelection };
});
