# deepclause-pi speckit

Spec-driven changes for pi, without leaving the session.

`deepclause-pi speckit` adds a lightweight spec layer on top of the [DeepClause](https://github.com/deepclause/deepclause-sdk) runtime in pi:

- **Specs describe behaviour.** Plain Markdown under `.pi/deepclause/specs/` is the source of truth.
- **A change is a reviewed proposal.** `.pi/deepclause/changes/<slug>/` holds a proposal, delta specs, optional design notes, and an executable task plan.
- **Only the model touches prose.** Parsing, validation, merging, coverage, verification and rollback are deterministic DML — no model calls.
- **Nothing lands silently.** Every step that writes or executes is a gated, reviewable command.

```text
/dc-plan <request> --change=<slug>   propose
/dc-check <slug>                     validate (0 tokens)
/dc-apply <slug>                     execute, verify, retry, resume
/dc-archive <slug>                   merge into specs/
```

## Requirements

- pi with this extension installed (see the [README](../README.md#install)).
- Node.js 22+.
- Git, for apply snapshots and resumable/rollback behaviour. Without it everything still works, but the apply report says `rollback: unavailable`.

## Getting started

### A new project

```sh
git init
printf 'node_modules/\ndist/\n' > .gitignore
git add -A && git commit -m "init"
```

Then in pi, once, to seed the workspace:

```text
/dc
```

Describe the first feature as a change:

```text
/dc-plan build a URL shortener with slugs and click counts --change=url_shortener
```

Pi creates:

```text
.pi/deepclause/changes/url_shortener/
├── proposal.md                     # why / what / capabilities / impact
├── specs/shortener/links.spec.md   # ## Purpose + ## ADDED Requirements + scenarios
├── design.md                       # approach (optional)
└── tasks.dml                       # one plan_task per step, with checks
```

Commit the plan, then run it:

```sh
git add -A && git commit -m "plan: url_shortener"
```

```text
/dc-check url_shortener     # grammar, delta, scenario coverage
/dc-apply url_shortener     # shows the tasks and the exact command set → confirm
/dc-archive url_shortener   # shows the merge diff → confirm
```

Archiving creates `specs/shortener/links.spec.md` and moves the change to `changes/archive/`. That is the bootstrap: **conversation → change → applied → spec.**

Every later feature is the same loop, but pi now reads the existing specs first and writes `## MODIFIED Requirements` when it changes behaviour that already exists.

### An existing project

There is no code-scanning onboarding yet. Two practical routes:

1. **Hand-write the first specs.** Create `specs/<capability>.spec.md` for behaviour you care about, then run `/dc-check` to validate it. This is often the fastest way to capture a system you already understand.
2. **Document as you go.** Use `/dc-plan ... --change=<slug>` for the next real change. Describe the current behaviour you are building on as `## ADDED Requirements` if it is not yet captured, or trust the code and only specify the new behaviour.

Either way, `specs/` grows one reviewed change at a time.

## Command reference

| Command | Effect |
|---|---|
| `/dc` | Status: model, paths, context mode, runtime state |
| `/dc-list` | Skills, plans, specs and changes |
| `/dc-plan <request> [--name=slug]` | Standalone executable plan under `plans/` |
| `/dc-plan <request> --change=<slug>` | Change plan: proposal + delta specs + `tasks.dml` |
| `/dc-plan update --change=<slug> <request>` | Regenerate a change plan (`tasks.dml` statuses reset to pending) |
| `/dc-check` | Validate every spec, delta and coverage hole (0 tokens) |
| `/dc-apply <change>` | Execute tasks; verify, retry, resume |
| `/dc-apply <change> --abort` | Discard an interrupted apply and restore the snapshot |
| `/dc-archive <change>` | Merge the delta into `specs/` and move the change to `archive/` |
| `/dc-run <skill> [args]` | Run any DML skill, e.g. `spec_status`, `spec_query ui/theme` |
| `/dc-cancel` | Cancel the active execution |
| `/dc-tool enable\|disable\|status` | Control the model-callable `dc_run` tool |

`/dc-run` refuses skills marked `% Mutating: true` (`spec_apply`, `spec_archive`) so that mutating steps always go through the reviewed `/dc-apply` and `/dc-archive` paths.

### Read-only helpers

```text
/dc-run spec_status                  # capability + delta inventory
/dc-run spec_query ui/theme          # one capability's requirements and scenarios
/dc-run spec_coverage url_shortener  # uncovered scenarios, tasks without checks
/dc-run spec_merge url_shortener     # merge preview
/dc-run spec_scaffold url_shortener  # draft tasks.dml text
/dc-run spec_graph capabilities      # Mermaid graph
/dc-run spec_graph changes
```

Ask pi for "the graph of capabilities and changes" and it calls `dc_spec_graph`, which renders the graph in the same offline Mermaid viewer as `dc_diagram`.

## Files

```text
.pi/deepclause/
├── specs/<capability>.spec.md          behaviour, source of truth
├── changes/<slug>/
│   ├── proposal.md                     why / what / impact
│   ├── specs/<capability>.spec.md      delta (ADDED / MODIFIED / REMOVED)
│   ├── design.md                       approach (optional)
│   ├── tasks.dml                       plan_task/2 + plan_task_status/2
│   └── change.json                     apply snapshot + applyState
├── changes/archive/<date>-<slug>/
├── lib/specs.dml                       parser, validator, merger, coverage
├── lib/apply.dml                       task driver
└── skills/spec_*.dml
```

## Writing specs

A capability spec:

```markdown
# Theme Specification

## Purpose
Lets users choose between light and dark themes, defaulting to the OS preference.

## Requirements

### Requirement: Theme selection
The app SHALL let users switch between light and dark themes at runtime.

#### Scenario: User toggles dark mode
- **WHEN** the user clicks the theme toggle
- **THEN** the app switches to dark mode and persists the choice
```

Rules the validator enforces:

- exactly **three** hashes for `### Requirement:` and **four** for `#### Scenario:` (the classic silent failure);
- every requirement has at least one scenario;
- no duplicate requirement names;
- specs are behaviour only — no commands, file paths, library choices, or task lists.

A delta wraps requirements in `## ADDED Requirements`, `## MODIFIED Requirements`, `## REMOVED Requirements` or `## RENAMED Requirements`:

- `MODIFIED` carries the **full** replacement requirement;
- `MODIFIED`/`REMOVED` must name a requirement that exists in the target spec (otherwise `/dc-archive` refuses rather than silently dropping it);
- a brand-new capability may only `ADD`;
- `RENAMED` is not supported by merge yet — `/dc-archive` refuses it.

Scenario ids are the join key between specs and tasks. They are derived from the scenario name: `Theme selection` in capability `ui/theme` → `ui/theme#theme-selection`. Renaming a scenario changes its id, so `/dc-check` will report the new scenario as uncovered until a task references it.

## The task plan

`tasks.dml` is data, not a program:

```prolog
plan_task("1.1", task{
    executor:  pi,
    do:        "Add a ThemeProvider context exposing theme and setTheme.",
    tools:     ["read", "edit"],
    expected:  "src/theme/ThemeProvider.tsx exports ThemeProvider and typechecks.",
    satisfies: ["ui/theme#theme-selection"],
    checks:    [ exists("src/theme/ThemeProvider.tsx"),
                 cmd("npm run typecheck") ]
}).

% --- execution state (managed by apply.dml; do not edit by hand) ---
plan_task_status("1.1", pending).
```

- `executor: pi` delegates a bounded step to pi with exactly the listed tools; `executor: dml` uses contained model reasoning with no pi tools.
- `satisfies` links the step to delta scenarios; `/dc-check` fails if any delta scenario is uncovered.
- Checks are declarative: `exists("path")`, `cmd("command")`, `model("question")`.
- Use `plan_task/2` and `plan_task_status/2` — **not** `task/2`, which collides with DML's built-in `task/N` predicate.

## Verification, resume and rollback

- **Checks** run after each step. A failed check retries the step (up to 3 attempts) with the failure evidence — including command stderr — threaded into the repair instruction.
- **Verification commands are approved once per run** and then executed through the allowlisted `dc_verify_run` tool. Ordinary `pi_bash` approvals are unaffected.
- **Snapshots.** `/dc-apply` records a git ref before running and refuses to start on a dirty tree. On success it clears the ref.
- **Resume.** If a run stops — `/dc-cancel`, a crash, or exhausted retries — the working tree and the `done`/`failed` statuses are **preserved**. Re-run `/dc-apply <change>` and it resumes from the remaining tasks, reusing the original snapshot.
- **Abort.** `/dc-apply <change> --abort` discards the apply and restores the snapshot (`git reset --hard` + `git clean -fd`), which also resets `tasks.dml` statuses.

A step interrupted halfway is simply re-executed, because its task is not `done` yet and its checks re-verify.

## Committing

After `/dc-plan`, `/dc-apply` and `/dc-archive` leave uncommitted changes, the extension lists the changed files and offers to commit them (`git add -A` with an `<action>: <change>` message), or reminds you when you decline. A clean tree is what lets the next apply take a snapshot.

Suggested `.gitignore`:

```
.pi/deepclause/diagrams/
.pi/deepclause/changes/*/change.json
```

Track `specs/` and `changes/` (including `tasks.dml`); ignore the generated viewer and the transient apply state.

## Limits

- `RENAMED` deltas are validated but not merged yet.
- There is no digest/drift check between a delta and `specs/` beyond the merge guard; run `/dc-check` after editing specs by hand.
- `/dc-archive` does not run `/dc-check` for you, and it writes per capability, so run the check first.
- The `deltas.dml` / `index.dml` derived-fact files from the design are not implemented; queries derive on demand.

See [SPEC_LAYER_PROPOSAL.md](SPEC_LAYER_PROPOSAL.md) for the full design and rationale.
