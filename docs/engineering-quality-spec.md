# Engineering quality spec: CUDA visualizer and coding playground

This is a reusable execution contract for a small, parallel engineering team. It defines the quality bar for evolving cuvis into a sophisticated CUDA learning workbench; it is a target specification, not a claim that every capability below exists today.

## Repository baseline and truth boundary

The README describes two GPU-free paths: a browser playground that interprets a CUDA C subset in a Web Worker, and a C++ analytical profiler for ten Accel-Sim GPU configurations. The playground currently documents a finite set of language constructs and presets, plus visualizations for buffers, `printf`, SM scheduling, memory coalescing, shared-memory banks, and warp divergence. A physical GPU build and optional Accel-Sim trace input are separate paths. The README does not establish support for MLP, CNN, or language-model-head kernels, a test suite, or cycle-accurate browser simulation; verify actual code before relying on any of those.

Maintain these distinctions in product copy, labels, explanations, and tests:

1. **Interpreted subset:** the browser executes only constructs explicitly implemented by the parser/interpreter. CUDA is too broad to promise arbitrary-source compatibility. Unsupported syntax, intrinsics, launch features, and types must produce a useful diagnostic, never a plausible-looking partial execution. Keep the supported subset documented and versioned.
2. **Teaching model:** scheduling, memory transactions, bank conflicts, occupancy, and timing shown by the browser are derived from named simplifying assumptions. They are not a prediction of a particular GPU unless a named hardware model and validated inputs actually support that claim. Show what is measured, derived, assumed, or illustrative at the point of use.
3. **Profiler and trace provenance:** analytical estimates, physical-device measurements, and imported simulator traces are different evidence sources. Preserve source, configuration/device, units, and uncertainty through every view. Never turn missing trace detail into invented source attribution or hardware facts. A trace may only support the events and mappings it actually contains.

The playground is not a CUDA compiler, a sandbox for arbitrary native code, a general GPU emulator, or a substitute for running on hardware. Prefer honest diagnostics and a smaller complete feature over silently approximating unsupported behavior.

## Product and interface contracts

### Runs, events, and explanations

Keep the existing public UI and worker message shape stable until an explicitly reviewed migration. Before parallel implementation, the technical lead records the actual current request/response shape and proposes adapters for changes. The logical contract must provide:

- A unique run identifier, source/kernel identity, launch dimensions, input descriptions, and declared model/configuration.
- A terminal outcome of `completed`, `failed`, or `cancelled`, plus structured diagnostics. A failed run must not publish partial output as a successful result.
- Output buffers and visualization events associated with the same run identifier. Ignore late messages from superseded runs.
- Ordered event identity and, when known, source span, thread/block/warp coordinates, event kind, and values needed to derive a display. Unknown source mapping stays unknown; do not guess a line number.
- Provenance on every displayed metric or explanation: `observed`, `derived`, or `illustrative`, with the inputs/formula and relevant model assumptions accessible to the learner.

Explanations must be deterministic and local: generate them from the event stream, source spans, known formulas, and versioned templates. The same source, inputs, configuration, and simulator version must yield the same explanation and result. Do not invoke an LLM, remote service, hidden random seed, or nondeterministic prose generation. If evidence is incomplete, say what is missing.

### Worker lifecycle and resource limits

All interpretation, trace parsing, and potentially expensive analysis stays off the UI thread. Set explicit limits for source size, launch dimensions, thread count, allocation/shared-memory size, event volume, output/`printf` volume, and total work. Validate before allocation and execution; make limits visible and produce actionable limit errors. A Web Worker is a responsiveness boundary, not a security guarantee: accept only the implemented language grammar and expose no DOM, network, storage, or arbitrary JavaScript execution to submitted kernels.

Each run has a bounded deadline and bounded memory/event budget. Cancellation must promptly stop work, not merely hide its result. Use cooperative checkpoints or terminate-and-recreate the worker where synchronous interpretation cannot yield. Reset clears prior results and playback state, invalidates pending messages, and restores reproducible initial inputs. Errors, timeout, cancellation, and empty results are distinct states with recovery actions. No stale frame or callback may mutate a newer run.

## Required workload acceptance matrix

Use small, seeded, documented fixtures so every expected value is independently calculable. Test normal output, boundaries, invalid launches, unsupported syntax, and repeatability. The accepted browser model is the implemented subset—not source compatibility with general CUDA.

| Workload | Minimum correctness coverage | Teaching evidence |
| --- | --- | --- |
| Vector add | Exact indexing and bounds for empty/one-element inputs (define empty behavior), odd sizes, warp/block tails, multiple blocks, and invalid dimensions. Compare every output element to a CPU reference. | Show per-thread index mapping, tail handling, and memory access grouping with the active model assumptions. |
| Reduction | Sum against a CPU reference for one item, non-power-of-two and odd lengths, warp/block boundaries, multiple blocks, negative/mixed values, and the documented empty-input rule. Repeat identically. | Make reduction stages, participation/masking, synchronization, and accumulation order visible when the supported kernel performs them. Do not imply a tree/order not present in the interpreted code. |
| MLP | A narrowly scoped, documented forward pass (e.g. dense layers, bias, explicitly supported activation) with small fixed shapes and seeded weights. Compare intermediate and final tensors with a CPU reference and stated floating-point tolerance. | Map tensor operations to the supported kernel/trace events; identify host-side or unmodeled work rather than presenting it as GPU execution. |
| CNN | Name the exact supported operators and layout (for example, a bounded convolution and optional activation/pooling); test tiny hand-checkable tensors, edge/padding rules, channel/layout boundaries, and a CPU reference. Unsupported operators fail clearly. | Show the actual tiled/naive accesses and work represented by the source. Do not label a high-level layer as a hardware kernel unless that kernel was actually interpreted or traced. |
| LM head | A small hidden-state-by-vocabulary projection; test dimensions, logits against a CPU reference, and stable softmax/argmax only if those operations are in scope. No model download, training, or claim of full language-model inference is implied. | Distinguish projection, optional normalization, and sampling; show tensor shape and modeled operation provenance. |

Use exact comparisons for integer behavior and justified tolerances for floating-point output. Document evaluation order and tolerance; do not loosen either merely to make a fixture pass. Every preset must state supported launch assumptions, input dimensions, expected output, and the limitation it teaches.

### Trace source fidelity

For every accepted trace path, test that parsed event counts and supported fields match the input; retain source/config/device identity, trace-format version, units, and parser warnings. Preserve instruction or address identity where present. Source-line attribution is allowed only through an explicit, validated mapping; absent or ambiguous mapping must remain unavailable. Clearly label trace playback versus synthetic/derived visualization. Never reconstruct omitted activity and present it as captured trace data. Include malformed, truncated, unsupported-version, and partial-mapping fixtures.

## Visual and interaction quality

Build a sophisticated dark developer workbench, not a dashboard skin: compact but calm hierarchy; precise typography; code-first editor; stable, aligned panels for source, launch controls, execution/playback, buffers, and GPU internals; and useful whitespace at both dense and narrow sizes. Use a restrained signal-green accent for active execution, selected steps, and successful output—not for every border, label, or status. Pair it with neutral surfaces and semantic warning/error colors. Use color plus text, shape, or annotation so no distinction depends on color alone. Keep syntax highlighting, focus, selection, and diagnostic markers legible against the dark theme.

Every visualization answers a learner question and stays linked to its evidence. Selecting a thread/event highlights the matching source span and relevant memory/tensor data when available. Playback controls expose step, play/pause, speed, and reset with a visible position and deterministic end state. Timeline animation must not fabricate events or imply cycle accuracy. Provide concise legends, units, assumptions, empty/loading/error states, and a text/table alternative for dense visual data. Honor reduced-motion settings; animation never blocks interaction.

### Accessibility and responsive behavior

Target WCAG 2.2 AA for the authored interface. All controls are keyboard-operable with visible focus, logical tab order, usable labels, and no keyboard trap. Provide shortcuts only when documented and non-conflicting; editor shortcuts must not break assistive technology conventions. Announce run status and actionable errors without reading every playback event. Expose charts/heatmaps through a concise textual summary or navigable data table. Maintain adequate contrast, meaningful heading/landmark structure, and non-color status cues.

At narrow viewport widths and 200% zoom, the editor, launch controls, diagnostics, and core output remain usable without page-wide horizontal scrolling. Dense GPU panels may stack or offer local horizontal scrolling with an announced alternative; controls must remain reachable, hit targets usable, and content must not be clipped. Test keyboard-only and at least one screen-reader flow in addition to automated checks.

## Bounded team protocol and ownership

The technical lead is accountable for sequencing, contract decisions, and integration, not for concurrently editing every surface. Before work starts, inventory the repository, existing tests, and actual message/API contracts. Turn the scope into microtasks, each small enough to review independently (normally a few hours, never an open-ended “improve the simulator” task). Every ticket names one accountable owner, one outcome, exact owned files or a non-overlapping region, interface/dependencies, acceptance checks, and explicit non-goals. A file has one active editor at a time; parallelize only across disjoint ownership. Shared-file changes are serialized through the owner, with proposals submitted as patches or interface notes. Do not overwrite another worker's changes.

| Role | Owns | Required output / boundary |
| --- | --- | --- |
| Technical lead / integrator | Contract, stage plan, dependency order, review and integration queue | Repository-backed scope and acceptance matrix; recorded API decisions; no unilateral expansion of supported CUDA claims. Own no overlapping feature implementation while parallel owners are active. |
| Simulation correctness engineer | Interpreter semantics and simulator-focused fixtures/tests | Explicit supported grammar, deterministic execution, bounds/diagnostics, CPU-reference results, and event provenance. Does not own visual copy or app layout. |
| GPU education / explanation engineer | Versioned lesson metadata and deterministic explanation content/templates in a dedicated, agreed module | Correct, concise explanations tied to source/events and formulas; assumptions and uncertainty stated. No LLM-generated explanations and no edits to simulator internals or UI-owned files. |
| Visual / interaction designer | Workbench visual system, hierarchy, interaction model, responsive states | Design decisions for dark surfaces and restrained signal-green use, annotated interaction/state designs, motion and empty/error-state guidance. Does not concurrently edit app markup or simulator code. |
| Frontend / accessibility engineer | Page structure, editor/run/playback wiring, worker lifecycle, accessible interaction | Implemented controls, stale-run protection, accessible states and responsive structure. Coordinate selectors and tokens with design; does not change kernel semantics. |
| QA / performance engineer | Isolated test fixtures, browser test coverage, benchmark method and results | Reproducible correctness, lifecycle, accessibility, trace and performance evidence; report failures rather than changing production semantics to hide them. |

The lead may change file ownership after inventory, but must publish one owner per file before parallel edits. Prefer narrow adapters or dedicated new modules over shared-file contention. Each owner returns a concise change summary, files touched, exact checks run, outcomes, and known gaps. Review interface changes before dependent tasks begin.

## Staged delivery and acceptance gates

1. **Truth and contract:** inventory implemented syntax, worker protocol, profiler/trace paths, existing tests, and actual limitations. Write the supported-scope table and event/provenance contract. Gate: no feature plan depends on unverified capability; browser and profiler claims are clearly separated.
2. **Deterministic correctness:** establish CPU-reference fixtures and diagnostics; pass vector-add and reduction cases before expanding examples. Gate: repeatable results, bounds safety, useful failures, and no partial-success ambiguity.
3. **Workload expansion:** add narrowly scoped MLP, CNN, and LM-head examples only when their operators fit the documented interpreter or an explicitly distinct trace path. Gate each example against the matrix above and show what is not modeled. Do not silently extend the language surface through special cases.
4. **Evidence-linked workbench:** build step selection, source/data linking, explanations, and playback on the agreed event contract. Gate: explanations are deterministic, every quantitative claim has provenance, and reset/cancel/error/supersession behavior is correct.
5. **Accessibility, limits, and release:** complete keyboard/screen-reader/mobile checks, worker cancellation and resource limits, trace-fidelity cases, and performance checks on a documented reference browser/device. Gate: no main-thread stalls during bounded runs, limits fail safely, and no unresolved correctness/accessibility blocker is presented as done.

## Definition of done

A change is done only when all applicable items are true:

- Scope, owner, touched files, and compatibility impact match the approved microtask; no unrelated edits or unsupported claims.
- Correctness tests cover the accepted behavior and important boundaries; CPU references and floating-point tolerances are documented.
- Unsupported, malformed, over-limit, failed, cancelled, and stale-run paths are explicit and cannot appear successful.
- Displayed events, explanations, and profiler/trace metrics retain their source and `observed`/`derived`/`illustrative` status.
- Keyboard, focus, status announcements, contrast, narrow viewport/zoom, reduced motion, and text alternatives are checked where affected.
- Worker execution remains bounded and cancellable; performance evidence identifies browser/device, fixture size, and measured metric.
- Relevant repository tests/builds and focused browser checks pass. Report exact commands and results; if a browser or hardware path was unavailable, say so and leave that gate pending.
- The diff is reviewed for accidental scope changes; docs and UI copy describe current behavior rather than aspiration.

## Reusable orchestration prompt

```text
You are the technical lead for a high-quality CUDA visualization and coding-playground team. Work in the existing repository; first inspect its instructions, README, relevant source, tests, and runtime before proposing changes. The requested goal is: [TARGET SCOPE]. The available verification environment is: [BROWSER / DEVICE / TEST LIMITS].

Build a sophisticated, accessible dark developer workbench with restrained signal-green accents, useful step-by-step visualization, and deterministic explanations generated locally from source, events, formulas, and versioned templates—never an LLM. Treat the checked-in implementation as the authority: report its real capabilities before planning. This project may interpret only an explicit finite CUDA subset. Do not claim arbitrary CUDA support, hardware fidelity, cycle accuracy, or trace/source mapping without evidence. Label observed, derived, and illustrative data and expose assumptions.

Stage the work: (1) inventory and lock the supported-scope, event/provenance, and worker contracts; (2) correctness for vector add and reduction; (3) narrowly defined MLP, CNN, and LM-head examples only where actual supported operators or an explicitly separate trace path justify them; (4) source-linked deterministic explanations and playback; (5) cancellation/reset/error handling, browser resource bounds, keyboard/screen-reader/mobile accessibility, and performance. Do not skip a gate to make the scope appear complete.

Divide work into reviewable few-hour microtasks. Assign one accountable owner per file or non-overlapping region, explicit inputs/outputs, dependencies, acceptance checks, and non-goals. Do not let agents edit a shared file concurrently; serialize integration and preserve concurrent changes. Use separate roles for simulation correctness, GPU education/explanation, visual/interaction design, frontend/accessibility, and QA/performance; the technical lead owns contracts and integration. Resolve interface proposals before dependent implementation. Keep this work within the requested scope.

Acceptance must include CPU-reference and boundary fixtures; deterministic reruns; truthful trace provenance and no invented source mapping; visible and recoverable run/playback states; promptly effective cancellation and stale-result rejection; bounded worker work; keyboard-only, screen-reader, contrast, reduced-motion, narrow viewport and zoom checks; and documented reference-browser performance. Unsupported syntax and over-limit inputs must fail safely with actionable diagnostics. Apply WCAG 2.2 AA as the accessibility target. Test exact integer behavior and justified floating-point tolerances.

Before each stage, state its bounded outcome and acceptance checks. After implementation, run the relevant repository checks and focused browser/hardware checks that are available, inspect the diff, and report exact files, commands/results, assumptions, limitations, and remaining gates. Never claim appearance verified by a build or tests alone. Stop when the requested stage is complete; do not broaden the task or claim unfinished gates passed.
```
