(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LibraryExplainer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_STATS_VALUES = 100000;
  const MAX_SOURCE_LINES = 80;

  function text(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function lineNumbers(value) {
    return Array.isArray(value) ? value.filter((line) => Number.isInteger(line) && line > 0) : [];
  }

  function tensorStats(values) {
    const isArray = Array.isArray(values) || (ArrayBuffer.isView(values) && !(values instanceof DataView));
    if (!isArray) return { count: 0, min: null, max: null, mean: null, sum: 0, finiteCount: 0 };

    const count = Math.min(values.length, MAX_STATS_VALUES);
    let finiteCount = 0;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (let index = 0; index < count; index += 1) {
      const value = values[index];
      if (!Number.isFinite(value)) continue;
      finiteCount += 1;
      min = Math.min(min, value);
      max = Math.max(max, value);
      sum += value;
    }

    const safeSum = Number.isFinite(sum) ? sum : null;
    return {
      count,
      min: finiteCount ? min : null,
      max: finiteCount ? max : null,
      mean: finiteCount && safeSum !== null ? safeSum / finiteCount : null,
      sum: safeSum,
      finiteCount,
    };
  }

  function summarize(pack, result) {
    const item = pack && typeof pack === "object" ? pack : {};
    const stages = Array.isArray(item.stages) ? item.stages : [];
    const tensors = Array.isArray(item.tensors) ? item.tensors : [];
    const headline = text(item.title) || text(item.api) || text(item.id) || "Library operation";
    const overviewParts = [text(item.summary)];
    const pipeline = stages.map((stage) => text(stage && stage.title)).filter(Boolean);
    if (pipeline.length) overviewParts.push(`Pipeline: ${pipeline.join(" → ")}.`);
    if (text(item.formula)) overviewParts.push(`Overall formula: ${text(item.formula)}`);
    overviewParts.push("This describes the authored operation; runtime observations are reported separately.");

    const shapeSummary = tensors.map((tensor) => {
      const shape = Array.isArray(tensor.shape) ? tensor.shape.join(" × ") : "unspecified shape";
      const name = text(tensor.name) || "unnamed tensor";
      const role = text(tensor.role) || "unspecified role";
      const description = text(tensor.description);
      return `${name} [${shape}] — ${role}${description ? `: ${description}` : ""}`;
    }).join("\n");

    const steps = stages.map((stage) => ({
      id: stage.id,
      title: text(stage.title),
      summary: typeof stage.summary === "string" ? stage.summary : "",
      formula: typeof stage.formula === "string" ? stage.formula : "",
      insight: typeof stage.insight === "string" ? stage.insight : "",
      sourceLines: lineNumbers(stage.sourceLines),
      cudaLines: lineNumbers(stage.cudaLines),
    }));

    const observations = [];
    if (!result || typeof result !== "object") {
      observations.push("No run result was supplied; this describes the authored pack, not observed execution.");
    } else {
      if (result.deadlock === true) {
        observations.push("A deadlock was reported; this run is partial.");
      } else if (result.ok === false) {
        observations.push(`The simulator reported a failed run${text(result.error) ? `: ${text(result.error)}` : ""}; any recorded trace may be partial.`);
      } else if (result.ok === true) {
        observations.push("The simulator reports successful completion; this is an interpreter result, not a hardware execution claim.");
      } else {
        observations.push("A run result was supplied, but it does not report whether execution completed.");
      }

      if (result.traceMeta && result.traceMeta.truncated === true) {
        observations.push("The recorded execution trace is truncated; trace truncation alone does not establish whether computation completed.");
      }

      const outputName = text(item.kernel && item.kernel.outputBuffer);
      const outputValues = result.buffers && outputName && Object.prototype.hasOwnProperty.call(result.buffers, outputName)
        ? result.buffers[outputName]
        : null;
      if (outputValues !== null && outputValues !== undefined) {
        const stats = tensorStats(outputValues);
        observations.push(`Finite-value check for output ${outputName}: ${stats.finiteCount} of ${stats.count} inspected values are finite.`);
      } else if (outputName) {
        observations.push(`Output buffer ${outputName} was not present in the result; no output finite-value check was possible.`);
      }
    }

    const upstream = item.upstream && typeof item.upstream === "object" ? item.upstream : {};
    const origin = [text(upstream.repository), text(upstream.path)].filter(Boolean).join("/") || "unspecified upstream source";
    const revision = text(upstream.revision);
    const symbol = text(upstream.symbol);
    const license = text(upstream.license);
    const upstreamReference = `Upstream reference: ${origin}${revision ? ` at ${revision}` : ""}${symbol ? `, symbol ${symbol}` : ""}${license ? `, license ${license}` : ""}${text(upstream.url) ? `, source ${text(upstream.url)}` : ""}${text(upstream.licenseUrl) ? `, license terms ${text(upstream.licenseUrl)}` : ""}${text(item.docsUrl) ? `, documentation ${text(item.docsUrl)}` : ""}.`;
    const provenance = [
      `Pack metadata: ${text(item.library) || "unspecified library"}${text(item.version) ? ` ${text(item.version)}` : ""} (${text(item.id) || "unnamed pack"}).`,
      upstreamReference,
      "This summary uses the supplied pack metadata; it does not fetch or independently verify upstream source.",
    ].join(" ");

    return {
      headline,
      overview: overviewParts.filter(Boolean).join("\n\n"),
      shapeSummary,
      steps,
      observations,
      limitations: Array.isArray(item.limitations) ? item.limitations.filter((entry) => typeof entry === "string") : [],
      provenance,
    };
  }

  function classifyEvent(pack, event) {
    const line = event && Number.isInteger(event.line) ? event.line : null;
    if (line === null || !pack || !Array.isArray(pack.stages)) return null;
    return pack.stages.find((stage) => Array.isArray(stage.cudaLines) && stage.cudaLines.includes(line)) || null;
  }

  function extractSource(source, upstream, options) {
    const symbol = text(upstream && upstream.symbol);
    const requested = options && Number.isFinite(options.maxLines) ? Math.floor(options.maxLines) : MAX_SOURCE_LINES;
    const maxLines = Math.max(1, Math.min(MAX_SOURCE_LINES, requested));
    if (typeof source !== "string" || !symbol) {
      return { text: "", startLine: null, endLine: null, matched: false, symbol };
    }

    const lines = source.replace(/\r\n?/g, "\n").split("\n");
    const matchIndex = lines.findIndex((line) => line.includes(symbol));
    if (matchIndex < 0) return { text: "", startLine: null, endLine: null, matched: false, symbol };

    let start = Math.max(0, matchIndex - Math.floor((maxLines - 1) / 2));
    let end = Math.min(lines.length, start + maxLines);
    start = Math.max(0, end - maxLines);
    return {
      text: lines.slice(start, end).join("\n"),
      startLine: start + 1,
      endLine: end,
      matched: true,
      symbol,
    };
  }

  function maskCommentsAndStrings(source) {
    const chars = source.split("");
    let index = 0;
    const mask = (at) => {
      if (chars[at] !== "\n" && chars[at] !== "\r") chars[at] = " ";
    };
    while (index < source.length) {
      const current = source[index];
      const next = source[index + 1];
      if (current === "/" && next === "/") {
        while (index < source.length && source[index] !== "\n") mask(index++);
        continue;
      }
      if (current === "/" && next === "*") {
        mask(index++);
        mask(index++);
        while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) mask(index++);
        if (index < source.length) {
          mask(index++);
          mask(index++);
        }
        continue;
      }
      if (current === "#") {
        while (index < source.length && source[index] !== "\n") mask(index++);
        continue;
      }
      if (current === "'" || current === '"' || current === "`") {
        const triple = source[index + 1] === current && source[index + 2] === current;
        const width = triple ? 3 : 1;
        for (let offset = 0; offset < width; offset += 1) mask(index + offset);
        index += width;
        while (index < source.length) {
          if (source[index] === "\\") {
            mask(index++);
            if (index < source.length) mask(index++);
            continue;
          }
          if (source[index] === current && (!triple || (source[index + 1] === current && source[index + 2] === current))) {
            for (let offset = 0; offset < width; offset += 1) mask(index + offset);
            index += width;
            break;
          }
          mask(index++);
        }
        continue;
      }
      index += 1;
    }
    return chars.join("");
  }

  const API_FAMILIES = [
    {
      aliases: ["nn.Linear", "torch.nn.Linear", "torch.nn.Linear + torch.nn.functional.relu"],
      pattern: /(?:torch\.)?nn\.Linear\b/,
      label: "Linear layer",
    },
    {
      aliases: ["nn.Conv1d", "torch.nn.Conv1d"],
      pattern: /(?:torch\.)?nn\.Conv1d\b/,
      label: "1D convolution",
    },
    {
      aliases: ["scaled_dot_product_attention", "F.scaled_dot_product_attention", "torch.nn.functional.scaled_dot_product_attention"],
      pattern: /(?:torch\.nn\.functional\.|F\.)?scaled_dot_product_attention\b/,
      label: "scaled dot-product attention",
    },
    {
      aliases: ["layer_norm", "F.layer_norm", "torch.nn.functional.layer_norm", "torch.nn.LayerNorm"],
      pattern: /(?:(?:torch\.)?nn\.)?LayerNorm\b|(?:torch\.nn\.functional\.|F\.)?layer_norm\b/,
      label: "layer normalization",
    },
    {
      aliases: ["np.matmul", "numpy.matmul", "numpy.matmul (@)"],
      pattern: /(?:np|numpy)\.matmul\b/,
      label: "NumPy matrix multiplication",
    },
    {
      aliases: ["numpy.exp + numpy.sum"],
      detect(source) {
        const namespace = "(?:np|numpy)\\s*\\.\\s*";
        const hasExp = new RegExp(`\\b${namespace}exp\\b`).test(source);
        const hasSum = new RegExp(`\\b${namespace}sum\\b`).test(source);
        return hasExp && hasSum ? "exp and sum composition" : null;
      },
      label: "NumPy exponential and sum composition",
    },
    { aliases: ["tf.sigmoid"], pattern: /tf\.sigmoid\b/, label: "TensorFlow sigmoid" },
    { aliases: ["tf.softmax"], pattern: /tf\.softmax\b/, label: "TensorFlow softmax" },
  ];

  function hasNumpyClue(source) {
    if (/\b(?:import\s+numpy|from\s+numpy)\b|\b(?:np|numpy)\s*\./.test(source)) return true;
    const imports = /\bimport\s+numpy\s+as\s+([A-Za-z_$][\w$]*)/g;
    let match;
    while ((match = imports.exec(source))) {
      const alias = match[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${alias}\\s*\\.`).test(source)) return true;
    }
    return false;
  }

  function matchSnippet(source, catalog) {
    const code = maskCommentsAndStrings(typeof source === "string" ? source : "");
    const detected = [];
    for (const family of API_FAMILIES) {
      const clue = family.detect ? family.detect(code) : family.pattern.exec(code)?.[0];
      if (clue) detected.push({ family, clue });
    }

    const numpyMatrixOperator = /(?:[A-Za-z0-9_$]|\]|\))\s*@\s*(?:[A-Za-z0-9_$]|\(|\[)/.test(code)
      && hasNumpyClue(code);
    if (numpyMatrixOperator && !detected.some((entry) => entry.family.label === "NumPy matrix multiplication")) {
      detected.push({ family: API_FAMILIES.find((family) => family.label === "NumPy matrix multiplication"), clue: "@ with a NumPy import/qualifier" });
    }

    const packs = Array.isArray(catalog) ? catalog : Array.isArray(catalog && catalog.operations) ? catalog.operations : [];
    const byId = new Map();
    for (const { family, clue } of detected) {
      const matching = packs.filter((pack) => pack && typeof pack.id === "string" && family.aliases.includes(pack.api));
      for (const pack of matching) {
        const reason = `The explicit ${clue} clue suggests a related ${family.label} example; this is a catalog suggestion, not translation or equivalence.`;
        if (byId.has(pack.id)) {
          const existing = byId.get(pack.id);
          if (!existing.reason.includes(clue)) existing.reason += ` Also detected ${clue}.`;
        } else {
          byId.set(pack.id, { id: pack.id, reason });
        }
      }
    }

    const matches = Array.from(byId.values());
    const supported = matches.length > 0;
    let message;
    if (supported) {
      message = "Related catalog examples are suggestions only; no code is translated, executed, or validated for equivalence.";
    } else if (detected.length) {
      message = "A known API clue was found, but this catalog has no exact API entry for it; no translation or validation was attempted.";
    } else {
      message = "No supported catalog suggestion was found. Arbitrary code is not transpiled, executed, or validated.";
    }
    return { matches, supported, message };
  }

  return { summarize, tensorStats, classifyEvent, extractSource, matchSnippet };
});
