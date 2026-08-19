# Changelog

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
