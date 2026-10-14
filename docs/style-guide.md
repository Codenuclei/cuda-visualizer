# cuvis art direction — the GPU meadow

cuvis is one world: *an afternoon daydream over a wildflower field, rendered
as a GPU profiler.* Every surface — dashboard, playground, explorer — shares
the same scene, light, and typographic voice. This guide is the contract;
new UI reads it before it ships.

## Style (the look)

Painterly-flat, not skeuomorphic, not neon-tech. The interface is a field
study: light comes from above, surfaces are paper over soil, and the only
glow is the sun.

| Token | Value | Role |
|---|---|---|
| `--sky` | `#d7e4f0` | Hero sky, calm backgrounds |
| `--meadow` | `#ecf2e4` | Field wash, selected states |
| `--paper` | `#f8faf5` | Page ground |
| `--panel` | `#fbfcf9` | Chart and content panels |
| `--ink` | `#1b2a20` | Primary text, chart strokes |
| `--slate` | `#5c6b60` | Secondary text |
| `--steel` | `#7a8578` | Captions, axis labels |
| `--line` | `#d8dfd4` | Hairlines, panel borders |
| `--fern` | `#3e7c4f` | Links, "go" affordances, H2D |
| `--cornflower` | `#6f8fd8` | Data accents, D2H |
| `--butter` | `#e0a82e` | The sun; selection highlight only |

Rules: buttercup is never a background. No gradients on controls. One
accent per component; when in doubt, use ink.

## Type (the voice)

- **IBM Plex Serif** — display and the daydream voice (italic serif = the
  world speaking; never for UI controls).
- **IBM Plex Sans** — prose, labels, navigation.
- **IBM Plex Mono** — only genuinely technical values: stats, register
  counts, table numerics, code. Never for prose.

Flush left, sentence case, no all-caps labels, no letter-spaced eyebrows.
Body line length under ~72ch.

## Pipeline (how assets enter the engine)

- All colors come from the token block in `web/style.css` (dashboard) or
  re-declared via the playground theme override files that import the same
  values. No new hex values outside a token file.
- Element IDs and `data-*` hooks are load-bearing: tests and worker
  protocols depend on them. Restyle classes; never rename hooks.
- Contrast floor: WCAG 2.2 AA. Text on `--paper`/`--panel` uses `--ink`
  or `--slate`; mono values never render lighter than `--slate`.
- Motion budget: one orchestrated scene per page (the hero fade / the field
  drift). Everything else animates only in answer to a user action.
  `prefers-reduced-motion` collapses all of it.

## Readability (gameplay clarity)

- **The instrument rule:** chrome lives on light paper; data surfaces that
  depict the machine (execution maps, thread grids, metric screens) may sit
  on the dark instrument panel (deep chlorophyll, `#19231c`-family) framed
  by light chrome. Dark is reserved for these screens — never for buttons,
  badges, or navigation.
- The "players" are students reading kernels: data ink (traces, tensors,
  charts) always outranks chrome. Chrome may whisper; data may not.
- Every chart keeps its legend within the same panel as the chart.
- Selected states read at a glance: butter bar + meadow wash, never color
  alone — pair with weight or inset shadow.
- Small screens are a first-class venue: the nav wraps, the picker
  stacks, and no label truncates.

## Feedback (review cues)

A change is ready when: tokens only, hooks intact, one accent per
component, motion budget respected, and it still reads as the same field
of light as the rest of the world.
