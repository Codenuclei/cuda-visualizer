'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let worker = null;
  let timeout = null;
  let report = null;
  function sizes() {
    const matrix = $('operation').value === 'matmul';
    document.querySelector('label[for="size"]').textContent = matrix ? 'Matrix edge (N × N)' : 'Vector elements';
    $('size').replaceChildren(...(matrix ? [32, 64, 128, 256] : [256, 4096, 65536, 262144, 1048576]).map(n => new Option(n.toLocaleString(), n, false, n === (matrix ? 128 : 65536))));
  }
  function finish() {
    clearTimeout(timeout);
    if (worker) worker.terminate();
    worker = null;
    $('run').disabled = false;
    $('cancel').disabled = true;
    for (const id of ['operation', 'size', 'repeats', 'force-cpu']) $(id).disabled = false;
  }
  function fail(message) {
    $('status').textContent = message;
    $('backend-label').textContent = 'NO RESULT';
    $('correctness').textContent = 'No completed result. Adjust the workload and try again.';
    $('correctness').className = 'correctness fail';
    finish();
  }
  $('operation').addEventListener('change', sizes);
  $('cancel').addEventListener('click', () => fail('Canceled. Worker terminated; no partial result reported.'));
  $('run').addEventListener('click', () => {
    report = null;
    $('download').disabled = true;
    for (const id of ['cpu-ms', 'gpu-ms', 'speedup']) $(id).textContent = '—';
    $('correctness').className = 'correctness';
    $('correctness').textContent = 'Warming up and validating…';
    $('backend-label').textContent = 'RUNNING';
    $('adapter').textContent = 'Detecting adapter…';
    $('workload').textContent = 'In progress';
    $('validation').textContent = 'Awaiting all output checks';
    $('output').textContent = 'Awaiting output';
    $('ratio-note').textContent = 'A ratio above 1 means faster.';
    $('status').textContent = 'Starting isolated compute worker…';
    $('run').disabled = true;
    $('cancel').disabled = false;
    for (const id of ['operation', 'size', 'repeats', 'force-cpu']) $(id).disabled = true;
    try {
      worker = new Worker('gpu-worker.js');
      worker.onerror = e => { e.preventDefault(); fail(`Worker error: ${e.message}`); };
      worker.onmessage = ({data}) => {
        if (data.type === 'progress') { $('status').textContent = data.message; return; }
        if (data.type === 'error') { fail(data.message); return; }
        if (data.type !== 'result') return;
        report = data.report;
        $('backend-label').textContent = report.backend.toUpperCase();
        $('cpu-ms').textContent = report.cpu.medianMs.toFixed(3);
        $('gpu-ms').textContent = report.selected.medianMs.toFixed(3);
        $('speedup').textContent = report.speedup === null ? 'N/A' : `${report.speedup.toFixed(2)}×`;
        $('ratio-note').textContent = !report.correctness.passed ? 'Incorrect output; speed comparison withheld.' : report.backend !== 'webgpu' ? 'CPU or mixed fallback; not a GPU speedup.' : report.speedup > 1 ? 'Faster for this workload on this adapter.' : 'GPU overhead exceeds its benefit here.';
        $('correctness').className = `correctness ${report.correctness.passed ? 'pass' : 'fail'}`;
        $('correctness').textContent = `${report.correctness.passed ? 'PASS' : 'FAIL'} / ${report.correctness.elements.toLocaleString()} outputs checked on every measured run`;
        $('adapter').textContent = JSON.stringify(report.adapter);
        $('workload').textContent = `${report.operation} · ${report.size.toLocaleString()} ${report.operation === 'matmul' ? '× '+report.size+' matrix' : 'elements'} · ${report.repeats} measured runs`;
        $('validation').textContent = `Max absolute error ${report.correctness.maxAbsoluteError.toExponential(3)} · tolerance 1e-4 + 1e-4 × |reference|`;
        $('output').textContent = report.outputSample.join(', ');
        $('status').textContent = report.correctness.passed ? 'Complete. Download the input recipe, methodology and timings as evidence JSON.' : 'Output validation failed. Download the evidence to inspect this run; no speedup is claimed.';
        $('download').disabled = false;
        finish();
      };
      timeout = setTimeout(() => fail('90-second deadline reached. Worker terminated; try a smaller workload.'), 90000);
      worker.postMessage({operation:$('operation').value,size:Number($('size').value),repeats:Number($('repeats').value),forceCPU:$('force-cpu').checked});
    } catch (e) { fail(e.message); }
  });
  $('download').addEventListener('click', () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {type:'application/json'}));
    const a = document.createElement('a');
    a.href = url; a.download = 'cuvis-compute-evidence.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  sizes();
})();
