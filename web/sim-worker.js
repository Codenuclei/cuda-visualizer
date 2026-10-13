/* sim-worker.js — runs the CUDA interpreter off the main thread so an
 * infinite loop in user code can be killed instead of freezing the tab.
 * The page terminates + respawns the worker on timeout. */

importScripts("cuda-sim.js");

onmessage = function (e) {
  const req = e.data;
  const sim = new self.CudaSim.CudaSim();
  try {
    // Rebuild typed buffers (structured clone gives us plain typed arrays).
    const result = sim.run({
      source: req.source,
      grid: req.grid,
      block: req.block,
      buffers: req.buffers,
      scalars: req.scalars,
      dynShmemBytes: req.dynShmemBytes,
      focusBlock: req.focusBlock,
      traceLimit: req.traceLimit,
    });

    const coal = self.CudaSim.analyzeCoalescing(result.trace);
    const banks = self.CudaSim.analyzeBankConflicts(result.trace);
    const div = self.CudaSim.analyzeDivergence(
      result.perThreadOps, req.focusBlock, result.launch.threadsPerBlock);

    // Slim the coalescing requests for transfer (cap at 160 requests,
    // keep lane -> byte info the inspector needs).
    const requests = coal.requests.slice(0, 160).map(r => ({
      warp: r.warp, seq: r.seq, rw: r.rw, buf: r.buf,
      sectors: r.sectors, ideal: r.ideal,
      lanes: r.lanes.map(l => ({ lane: l.lane, byte: l.byte, bpe: l.bpe })),
    }));

    // Shared-memory warp requests (for the bank-conflict panel).
    const shGroups = new Map();
    for (const a of result.trace) {
      if (a.space !== "shared") continue;
      const key = a.warp + ":" + a.seq + ":" + a.rw + ":" + a.buf;
      if (!shGroups.has(key)) shGroups.set(key, []);
      shGroups.get(key).push(a);
    }
    const sharedRequests = [];
    for (const [, lanes] of shGroups) {
      if (sharedRequests.length >= 120) break;
      const bankWords = new Map();
      for (const a of lanes) {
        const word = Math.floor(a.byte / 4), bank = word % 32;
        if (!bankWords.has(bank)) bankWords.set(bank, new Set());
        bankWords.get(bank).add(word);
      }
      let degree = 1;
      const perBank = new Array(32).fill(0);
      for (const [bank, words] of bankWords) {
        perBank[bank] = words.size;
        degree = Math.max(degree, words.size);
      }
      sharedRequests.push({
        warp: lanes[0].warp, seq: lanes[0].seq, rw: lanes[0].rw,
        buf: lanes[0].buf, degree, perBank,
      });
    }
    sharedRequests.sort((a, b) => b.degree - a.degree);

    // Per-thread op heat for the focus block (divergence strip).
    const heat = [];
    for (let t = 0; t < result.launch.threadsPerBlock; t++)
      heat.push(result.perThreadOps.get(req.focusBlock + ":" + t) || 0);

    postMessage({
      ok: true,
      kernelName: result.kernel.name,
      launch: result.launch,
      counts: result.counts,
      deadlock: result.deadlock,
      printfLines: result.printfLines,
      executionTrace: result.executionTrace,
      traceMeta: result.traceMeta,
      coalescing: {
        efficiency: coal.efficiency,
        transactions: coal.totTransactions,
        ideal: coal.totIdeal,
        bytes: coal.totBytes,
        requests,
      },
      banks,
      sharedRequests,
      divergence: div,
      heat,
      buffers: req.buffers,   // outputs (transferred back)
    });
  } catch (err) {
    postMessage({ ok: false, error: err.message || String(err),
      executionTrace: sim.executionTrace, traceMeta: sim.getTraceMeta() });
  }
};
