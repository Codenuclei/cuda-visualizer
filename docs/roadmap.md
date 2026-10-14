# cuvis roadmap

Where the playground and profiler go next. Every item stays inside the
project's contract: GPU-free by default, deterministic, and honest about
what is measured, derived or illustrative.

## Shipping now

- **Device catalog dashboard** — 10 accel-sim device models with silicon,
  memory, timeline, occupancy and roofline views.
- **Teaching interpreter** — a supported CUDA C subset with bounded traces,
  CPU-reference fixtures and cancellation.
- **Library explorer** — curated packs plus live npm discovery through
  jsDelivr, read-only and never executed.

## Next

- **Device compare mode** — select two devices and render every chart side
  by side. Occupancy and roofline math are already per-device, so this is
  primarily a UI story on top of `window.CUVIS_DATA`.
- **Imported trace view** — accept a real accel-sim stats CSV (the
  `gpu_tot_sim_cycle` / `gpu_ipc` vocabulary the dashboard already emits) and
  replay it on the timeline, labeled *measured* next to the analytic model.
- **Shareable dashboards** — encode device + kernel selection in the URL
  hash so views can be linked from PRs or classroom notes. No server.
- **Kernel challenge cards** — guided exercises that pair a broken kernel
  (uncoalesced access, bank conflicts) with a roofline diagnosis, then a fix
  in the playground and a visible chart delta.

## Later

- **WebGPU reference mode** — an optional real-GPU run through WebGPU
  compute, used only to sanity-check the teaching model, never as a timing
  source.
- **Offline classroom pack** — a single self-contained export (PWA or file
  bundle) with the packs inlined for zero-network lessons.
- **Playground ↔ dashboard bridge** — run a playground kernel and hand its
  simulated occupancy stats to the dashboard charts for the chosen device.

## Non-goals

- No hardware timing claims from the analytical model.
- No execution of downloaded package code.
- No LLM-generated explanations; all mappings stay versioned and reviewed.
