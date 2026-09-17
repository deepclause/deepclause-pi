# DML diagrams in `deepclause-pi` — minimal design

## Goal

> The user asks pi to turn a DML file into a diagram — **presentation grade** or
> **specification grade**. When it's done, a viewer opens.

That's the whole feature. No command suite, no manual build/edit/check/clean
ritual. Pi does the work; the user just asks.

## How the user experiences it

```text
User:  “Make me a presentation-grade diagram of
        skills/deep_research.dml”

pi:    (calls the dc_diagram tool)
       Creating a presentation-grade diagram for deep_research.dml…
       (viewer opens in the browser at the Presentation view)

User:  “Now a specification-grade one for the same file”

pi:    (calls dc_diagram with grade=specification)
       (viewer opens at the Specification view)
```

The DML file can live **anywhere** — a relative path, an absolute path, or a
path outside `.pi/deepclause/`. Pi points at it; the tool reads it.

Grade is inferred from the request, or passed explicitly:
`presentation` / `presentation-grade` → Presentation; `specification` /
`spec` / `detailed` / `technical` → Specification. If the user says "both",
produce both views.

## What the extension exposes

Exactly **one model-callable tool**:

```text
dc_diagram
  dml   : string                      // path to any .dml file (relative or absolute)
  grade : "presentation" | "specification" | "both"   // default: presentation
  view  : "flow" | "sequence"         // optional, default: flow
```

- Registered on startup (it is a safe, read-and-generate operation — it does not
  execute the DML, unlike `dc_run`, so it does not need the `/dc-tool` opt-in).
- `promptGuidelines` tell pi to call it whenever the user asks for a diagram /
  flowchart / visual of a DML file, to infer the grade from the wording, and not
  to hand-write Mermaid itself.
- A short line in `AUTHORING_INSTRUCTION` / `.pi/deepclause/AGENTS.md` mentions
  the tool and where diagrams live.

Optional, only if we want manual triggering: a single `/dc-diagram <path>
[--grade=...]` command that does exactly the same thing. Not required.

## What the tool does (one call, end to end)

1. Resolve the input path: relative to the workspace or absolute; require an
   existing `.dml` file (`realpath` + extension check). No `.pi/deepclause/`
   restriction on input.
2. Read the DML and compute a deterministic Mermaid **seed** in-process
   (`renderDml` / `renderSequence`, ported from `dml_flow.mjs`). Always valid.
3. If a grade is requested, ask the active pi model to rewrite the seed in that
   grade (reusing pi's model backend — no `pi_bash`, no API keys), then validate
   and retry up to ~3 rounds:
   - **Presentation**: ~8–12 nodes, plain language, headline numbers, 1–2
     callouts, no function names or framework jargon.
   - **Specification**: keep function names, `task`/`tool` roles,
     post-conditions, seed data; precise for an engineer.
   - Validation: structural checks always; real Mermaid parser via headless
     Chrome only if Chrome is available. A broken result never reaches the
     viewer.
4. Write the sidecar(s) under the active workspace's
   `.pi/deepclause/diagrams/`: `<name>.presentation.mmd` and/or
   `<name>.specification.mmd`.
5. (Re)build `viewer.html` (embedded manifest + vendored Mermaid).
6. **Open the viewer** at that diagram and view:
   `xdg-open .pi/deepclause/diagrams/viewer.html?view=presentation#<name>`
   (fixed argv via `pi.exec`, TUI/interactive only; otherwise just return the
   path).
7. Return a one-line result: file, grade, and viewer path.

Progress and cancellation reuse the existing `/dc-run` UI plumbing
(`setWidget`/`setStatus`, a local `AbortController` wired to the active
execution so `/dc-cancel` still works).

## Names and collisions

The viewer is keyed by the DML **file name** (without `.dml`). If two DML files
with the same base name are diagrammed, disambiguate with a short path hash
(e.g. `deep_research-3f9a`) so sidecars and viewer entries never collide. The
full source path is always shown in the viewer.

## Artifacts

```text
.pi/deepclause/diagrams/              # in the active workspace, regardless
├── viewer.html                       # of where the DML source lives
├── index.json                        # manifest (also handy for tests/scripts)
├── <name>.md                         # Mermaid fences for editors
├── <name>.presentation.mmd           # presentation-grade sidecar
└── <name>.specification.mmd          # specification-grade sidecar
```

- Created lazily on first use; `initializeWorkspace()` stays untouched.
- Output always stays under `.pi/deepclause/`; no `.deepclause/`, no `docs/`.
- Regenerating a grade overwrites only that sidecar (the user asked for it);
  the other grade and other diagrams are preserved.

## Viewer

Reuse the handbook `viewer.template.html` nearly verbatim, with the sidebar
list, theme picker, split pane (editable Mermaid + read-only DML), SVG/PNG
export and hash deep-links. The view dropdown becomes:

`Presentation → Specification → Flow → Sequence`

Fallback order for the default view: Presentation → Specification → Flow.

## Code changes

```text
src/diagram/extract.ts     # TS port of dml_flow.mjs (renderDml, renderSequence)
src/diagram/grade.ts       # model rewrite + validation/retry loop
src/diagram/viewer.ts      # write sidecars, build viewer.html, open browser
src/assets/viewer.template.html   # adapted; Presentation/Specification labels
src/assets/vendor/mermaid.min.js  # vendored, written on first build
src/runtime.ts             # export a small completeWithPiModel() helper
src/index.ts               # register dc_diagram + authoring note
```

## Policy

- No compiler, no `.deepclause/`, no DML execution.
- Input may be any readable `.dml` path; **output** is confined to the active
  workspace's `.pi/deepclause/diagrams/`.
- Does not register runtime tools and does not widen `pi_bash`/approval scope.
- Browser opening uses a fixed command, not a shell string.

## Validation

- Asking pi for a diagram in natural language results in a `dc_diagram` call and
  an opened viewer.
- A DML file outside `.pi/deepclause/` (including an absolute path) works.
- Presentation vs specification wording selects the right grade; "both"
  produces both.
- Chrome present → real-parser gate; Chrome absent → structural gate, viewer
  still opens.
- Invalid/partial model output is retried and never written as a final sidecar.
- Missing file / non-`.dml` input is rejected.
- Same-name DML files do not collide in the viewer.
- No approval prompts are raised.
- No files appear outside `.pi/deepclause/diagrams/`.
