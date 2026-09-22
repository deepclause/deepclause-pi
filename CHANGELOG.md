# Changelog

## 0.5.0 - 2026-09-22

- Fix parallel `dc_run` calls racing past the concurrency guard: the execution slot is now claimed synchronously before any await, so simultaneous model tool calls are rejected cleanly instead of running concurrently and clobbering pi's single input dialog.
- Show the full DeepClause question plus the running skill in the pi input dialog title. Pi's input component ignores the placeholder, so the previous `ctx.ui.input("DeepClause input", prompt)` call never displayed the question.
- Use the same synchronous execution claim for `/dc-run`, diagram generation, and the spec skills so no operation can overwrite another's active-run state.
- Extend the `handbook-dml` skill and the bundled authoring guide with the semantic judgment predicates (`choose`, `rate`, `verify`, `probability`, `holds`, `judge`, `with_judgment`, `require_judgment`) and a decision framework: a bounded classifier, a calibrated probability gate, or a full `task/N` agent loop, whichever the core question actually needs.
- Add an opt-in live test for the real calibrated Jev judge backend (`DEEPCLAUSE_LIVE_JEV=1 TYPESAFE_API_KEY=... npx vitest run tests/judge-live.test.ts`).
- Enrich specification-grade diagrams with the core decision logic: a `LOGIC` section renders every reachable decision predicate with its conditions, thresholds and outcomes (including `verify`/`choose`/`probability` judgments and ordered guard chains), and a `RULES` section summarizes rule fact tables. The presentation seed stays small, and the grade prompts now require preserving domain rules while allowing arithmetic/date helpers to be grouped.
- Fix a DML clause scanner bug where `/\s|$/` tested against a single character was always true, truncating clause bodies at the first decimal point (e.g. `P >= 0.75` became `P >= 0`).

## 0.4.0 - 2026-09-20

- Add semantic judgment backends on top of `deepclause-sdk` 0.0.89: `llm` uses pi's active model and credentials, and `jev` (TypeSafe System One) is opt-in and calibrated.
- Add a `judgment` block to `.pi/deepclause/config.json`: default backend, Jev model, and the API key environment variable.
- Add `/dc-judge` to inspect, enable/disable, and select the backend; `/dc-run --judge=llm|jev` for per-run overrides; and report judge activity and usage in `/dc`.
- Fix the spec library for the corrected meta-interpreter backtracking: replace cut-based parser predicates with if-then-else. The removed first-solution commit had masked the meta-interpreter's inability to honor `!` inside user predicates.
- Rename `apply.dml`'s `verify/3` to `verify_task/3`, since the judge layer registers `verify/3` as a special predicate and shadowed it.
- Jev is off by default; its API key is read only from the environment and never stored.

## 0.3.0 - 2026-09-18

- Add **deepclause-pi speckit**: spec-driven changes on top of the pi runtime.
- Store behaviour specs as plain Markdown under `.pi/deepclause/specs/`, with reviewable change deltas under `.pi/deepclause/changes/<slug>/` (proposal, delta specs, optional design, `tasks.dml`).
- Add a deterministic DML spec engine: spec/delta parsing, structural validation, lossless delta merge, and scenario coverage — no model calls.
- Add `/dc-plan --change=<slug>` to write `changes/<slug>/tasks.dml`; `--update` regenerates it and resets task statuses.
- Add `/dc-check` to validate specs, deltas and coverage, and `dc_spec_graph` / `/dc-run spec_graph` for capability and change graphs in the offline Mermaid viewer.
- Add `/dc-apply` to execute tasks with declarative checks (`exists`, `cmd`, `model`), bounded retry that feeds failure evidence into the repair step, git snapshotting, resume after interruption, and `--abort` rollback.
- Add `/dc-archive` to merge a delta into `specs/` after confirmation and move the change into `changes/archive/`; merging refuses `MODIFIED`/`REMOVED` entries that do not exist in the target spec.
- Add commit prompts after `/dc-plan`, `/dc-apply` and `/dc-archive`.
- Add skills `spec_validate`, `spec_status`, `spec_query`, `spec_coverage`, `spec_scaffold`, `spec_merge`, `spec_archive`, `spec_apply` and `spec_graph`; seed `lib/specs.dml`, `lib/apply.dml`, `specs/` and `changes/` non-destructively.
- Fix `sp_graph` view dispatch so string CLI arguments select the requested view instead of falling through to the capabilities default.
- Add the [deepclause-pi speckit guide](docs/SPECKIT.md) and the [design proposal](docs/SPEC_LAYER_PROPOSAL.md).

## 0.2.0 - 2026-09-17

- Ask pi for a diagram of any DML file and get a self-contained offline Mermaid viewer.
- Add the always-active `dc_diagram` model tool with `presentation` and `specification` grades (and `both`).
- Keep DML sources anywhere (workspace-relative or absolute) while confining generated viewers to `.pi/deepclause/diagrams/`.
- Extract diagrams in-process (no shell approval) and validate model output with structural checks plus the real Mermaid parser when Chrome is available.
- Vendor Mermaid so the viewer works offline; no network or external tooling required.
- Document the diagram workflow in the bundled authoring guide.

## 0.1.5 - 2026-09-07

- Add the handbook-dml skill for SOP -> DML (see HANDBOOK.md benchmark and paper) 

## 0.1.4 - 2026-08-23

- Add the `pi-package` npm keyword so the extension can be discovered as a pi package.

## 0.1.3 - 2026-08-21

- Let contextual `pi_agent_step` execution complete when pi recovers from an intermediate tool error and produces a final summary. Tool failures remain recorded as diagnostics instead of incorrectly causing the DML `exec/2` goal to fail.

## 0.1.2 - 2026-08-20

- Add the model-callable `dc_run` tool for executing existing DML programs.
- Keep `dc_run` disabled by default and add `/dc-tool enable|disable|status` for per-workspace control.
- Apply the existing DML path isolation, context modes, cancellation, runtime-tool whitelist, and bash approval policy to model-triggered runs.
- Reject concurrent DeepClause execution and return structured answers, errors, usage, and live progress to pi.
- Replace the minimal seeded authoring notes with a comprehensive pi-specific DML guide grounded in the SDK runtime, prompts, examples, and planning benchmarks.
- Document reliable architecture patterns and application ideas for research, constrained planning, engineering, compliance, expert systems, and data workflows.
- Add `/dc-plan`, which uses a normal pi turn and transaction-scoped `dc_plan_commit` tool to create typed executable plans.
- Deterministically assemble, validate, preview, and non-destructively write generated DML under `.pi/deepclause/plans/`.
- Add bounded `pi_agent_step` delegation so user-run plans can use pi's current context, loaded skills, and exact active built-in or extension tools while preserving their policies and approvals.
- Restore pi's previous active tools after delegated success, failure, or cancellation, and reject recursive DeepClause control tools.
- Require explicit confirmation for contextual plan execution and reject contextual plans invoked through model-callable `dc_run`.

## 0.1.1 - 2026-08-19

- Fix Git installations resolving `deepclause-sdk` to a broken sibling symlink.
- Lock the runtime dependency to the published `deepclause-sdk` 0.0.87 npm tarball.

## 0.1.0 - 2026-08-19

- Add `/dc`, `/dc-list`, `/dc-run`, and `/dc-cancel`.
- Use pi's active model, credentials, session context, cancellation, UI, and usage accounting.
- Add `turn`, `branch`, and `isolated` context modes.
- Initialize `.pi/deepclause/` lazily and non-destructively.
- Restrict DML execution and tool paths to the active workspace.
- Add live progress plus verbose and debug event views.
- Add read-only `pi_workspace_list` and approval-gated `pi_bash` bridges.
- Add DML user-feedback integration through pi's native input UI.
- Bundle CLP(FD) and Bing/curl deep-research examples.
