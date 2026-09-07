# Changelog

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
