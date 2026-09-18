# DeepClause for pi

Run [DeepClause](https://github.com/deepclause/deepclause-sdk) DML programs inside [pi](https://github.com/badlogic/pi-mono).

DeepClause for pi is a runtime-only integration. Pi supplies the selected model, existing credentials, active session context, terminal UI, cancellation, and usage accounting. DeepClause supplies deterministic DML execution, Prolog constraints, task orchestration, backtracking, and a deliberately small runtime-tool boundary.

## Requirements

- Node.js 22 or newer
- pi 0.84 or newer
- A model configured and selected in pi
- `curl` for the bundled deep-research example

The extension does not request API keys or modify provider environment variables.

## Install

Install directly from GitHub:

```sh
pi install git:github.com/deepclause/deepclause-pi
```

For a project-local installation:

```sh
pi install git:github.com/deepclause/deepclause-pi -l
```

Restart pi after installation. Run `/dc` to initialize the current workspace and verify the active model and runtime status.

For a project-local (`-l`) installation, start pi from the directory containing `.pi/settings.json`. Pi does not discover a project package from a parent directory when launched inside a nested subdirectory. The startup screen should list DeepClause under **Extensions** and `/dc-run` should appear in slash-command completion. If the extension is absent, an input beginning with `/dc-run` is forwarded to the model as ordinary text instead of executing the command.

To try an unpublished checkout during development:

```sh
pi -e ./deepclause-pi/src/index.ts
```

## Commands

| Command | Description |
| --- | --- |
| `/dc` | Initialize the workspace non-destructively and show help, model, paths, and status. |
| `/dc-list` | List authored skills and generated plans. |
| `/dc-plan <request> [--name=slug]` | Create a validated executable DML plan using pi's current context, skills, and active tools. |
| `/dc-run <skill> [args]` | Run a named skill such as `example` or `deep_research`. |
| `/dc-run <path> [args]` | Run a DML file below `.pi/deepclause/`. |
| `/dc-tool enable\|disable\|status` | Control the default-off `dc_run` tool callable by pi's model. |
| `/dc-cancel` | Cancel the active DeepClause execution. |

Run options:

- `--context=turn|branch|isolated` overrides session-context import for one run.
- `--verbose` or `-v` displays lifecycle events.
- `--debug` or `-d` displays complete event payloads and SDK model diagnostics.

Examples:

```text
/dc-run example --debug
/dc-run deep_research "What are the practical impacts of small language models?" --verbose
/dc-run skills/my_skill.dml "first argument" --context=isolated
/dc-plan inspect this repository and propose a safe ESM migration --name=esm-migration
/dc-run plans/esm_migration.dml
```

## Workspace layout

The first `/dc` or `/dc-run` creates missing files under the active workspace:

```text
.pi/deepclause/
├── config.json
├── AGENTS.md
├── DML_REFERENCE.md
├── skills/
│   ├── example.dml
│   └── deep_research.dml
└── plans/
```

Existing files are never overwritten silently. The extension neither creates nor reads `.deepclause/`.

`AGENTS.md` teaches pi how to author and conservatively edit DML. `DML_REFERENCE.md` is the bundled language/runtime reference. Add user-maintained programs to `skills/`; `/dc-plan` writes generated executable programs to `plans/`. Pi can edit either with its normal coding tools.

## Session context

Configure the default mode in `.pi/deepclause/config.json`:

```json
{
  "version": 1,
  "contextMode": "turn",
  "branchMessageLimit": 20,
  "gasLimit": 100000,
  "maxTokens": 16384,
    "verbose": false,
    "modelToolEnabled": false
}
```

- `turn` imports the current request and relevant immediate context. This is the default.
- `branch` imports a bounded set of messages from the active pi branch, including compacted history.
- `isolated` imports no pi conversation.

Pi remains the sole persistent session owner. Executions stop when their pi session closes or changes, and results are rendered into the current session.

## Opt-in model tool

The model-callable `dc_run` tool is disabled by default. Enable it explicitly for the current workspace:

```text
/dc-tool enable
```

The change takes effect immediately and persists in `.pi/deepclause/config.json`; no reload is required. Use `/dc-tool status` to inspect it and `/dc-tool disable` to remove it from pi's active tools.

When active, pi can call `dc_run` with an existing `skill`, optional positional `args`, and an optional `turn`, `branch`, or `isolated` context override. The tool reuses the same path isolation, active model, cancellation, session context, events, and runtime policy as `/dc-run`. It rejects concurrent execution, cannot compile natural language into DML, and cannot escape `.pi/deepclause/`. Any DML request for `pi_bash` still requires explicit user approval.

Contextual plans containing `pi_agent_step` cannot be invoked through `dc_run`. They must be started explicitly by the user with `/dc-run`, which displays a confirmation first.

## Contextual executable plans

`/dc-plan` starts a normal pi agent turn. The planner can inspect the workspace and account for project instructions, loaded skills, the selected model, and currently active built-in or extension tools. It does not ask the model to emit raw DML. Instead, a transaction-scoped `dc_plan_commit` tool accepts a typed plan specification; the extension validates it, deterministically assembles DML, validates the generated program with the SDK parser, previews it for confirmation, and writes it without overwriting an existing plan.

The resulting `.dml` file is the plan. Steps use one of two executors:

- `dml` — contained reasoning through ordinary typed DML tasks.
- `pi` — a bounded `pi_agent_step` that runs as a normal pi turn with current session context and loaded skills.

For each pi step, only the exact tools named in the committed plan are temporarily active. They must still be installed and active when execution begins; existing tool policies, UI, and approvals remain authoritative. DeepClause control tools cannot be requested recursively. The prior active-tool set is restored after success, failure, or cancellation.

## deepclause-pi speckit

Spec-driven changes, built on the same runtime: behaviour specs in plain Markdown, reviewable change deltas, and an executable `tasks.dml` that pi runs with deterministic validation, per-task verification, rollback and resume.

```text
/dc-plan <request> --change=<slug>   propose
/dc-check <slug>                     validate (0 tokens)
/dc-apply <slug>                     execute, verify, retry, resume
/dc-archive <slug>                   merge into specs/
```

See the [deepclause-pi speckit guide](docs/SPECKIT.md) for the getting-started walkthrough and reference.

## Diagrams

Ask pi for a diagram of any DML file in plain language:

```text
Make a presentation-grade diagram of .pi/deepclause/skills/deep_research.dml
Give me a specification-grade diagram of src/report.dml
```

Pi calls the always-active `dc_diagram` model tool, which:

1. extracts a deterministic Mermaid seed from the DML in-process,
2. has the active pi model rewrite it in the requested grade,
3. validates each attempt (structural checks, plus the real Mermaid parser when Chrome is available),
4. writes the sidecar under `.pi/deepclause/diagrams/`, rebuilds the self-contained offline `viewer.html`, and opens it.

Grades:

- **presentation** — about 8-12 nodes, plain language, headline numbers; for slides and overviews.
- **specification** — function names, task/tool roles, post-conditions; for engineers.

Selecting `both` produces both sidecars. The DML source may be anywhere (workspace-relative or absolute); only the generated viewer is confined to `.pi/deepclause/`. `dc_diagram` never executes the DML and needs no shell approval. Regenerating a grade replaces only that grade's sidecar (`<name>.presentation.mmd` / `<name>.specification.mmd`). The Mermaid bundle is vendored so the viewer works offline.

## Runtime tools and approval

The extension never exposes pi's general tool registry directly to ordinary DML. The optional `dc_run` tool runs an existing DML program; inside that runtime, only these host operations are registered:

- `pi_workspace_list(RelativePath)` — read-only, one-level workspace listing. Absolute paths, traversal, and resolved symlink escapes are rejected.
- `pi_bash(Command)` — runs an explicitly approved shell command in the active workspace.
- `pi_bash(Executable, Args)` — runs an explicitly approved executable with a separate argv list, avoiding shell interpolation.

Every `pi_bash` call has a 60-second timeout, inherits cancellation, and is denied when interactive approval is unavailable.

User-approved contextual plans additionally receive the internal `pi_agent_step` bridge. That bridge delegates a bounded instruction to a normal pi turn rather than invoking arbitrary tools itself, preserving policies from pi and other extensions.

DML can wrap these runtime operations in higher-level tool predicates. It can also wrap the SDK's internal `ask_user` operation. During `/dc-run`, `ask_user` opens pi's native, cancellable input UI and returns the response to the DML task loop.

```prolog
tool(user_feedback(Prompt, Response), "Ask the user for feedback") :-
    exec(ask_user(prompt: Prompt), Result),
    get_dict(user_response, Result, Response).

tool(bing_search(Query, Results), "Search Bing RSS with curl") :-
    format(string(QueryArg), "q=~w", [Query]),
    exec(pi_bash("curl", [
        "--fail", "--silent", "--show-error", "--location", "--get",
        "--data-urlencode", QueryArg,
        "https://www.bing.com/search?format=rss&count=8"
    ]), Result),
    get_dict(stdout, Result, Results).
```

DML predicates remain visible to `task/N` agent loops, while their nested `exec/2` calls are still checked against the host runtime whitelist.

## Bundled examples

### `example.dml`

Demonstrates:

- CLP(FD) constraint solving
- Read-only workspace listing
- Approval-gated bash execution
- Typed task output through pi's active model
- Runtime progress, tool, usage, and answer events

Run `/dc-run example --debug` and approve the harmless displayed `printf` command.

### `deep_research.dml`

Demonstrates model-callable DML tool predicates:

1. The model creates three focused research queries.
2. `user_feedback/2` presents the plan through pi's input UI.
3. The model revises or accepts the plan.
4. `bing_search/2` invokes approved `curl` requests against Bing RSS.
5. The model synthesizes a cited Markdown report from the returned result snippets.

The example does not use SDK web search, URL fetch, file writing, or unrestricted pi tools. Each curl request requires explicit approval.

## Event presentation

Every run displays a live panel containing the skill, active model, context mode, elapsed time, phase, output, recent events, and token usage. Runtime events map into pi as follows:

- `task_activity` → progress
- `stream` → model text
- `tool_call` → tool activity
- `input_required` → native pi input prompt
- `usage` → usage totals
- `answer` → command result
- `error` → concise error notification

The SDK supports incremental text callbacks inside `task/N`. The current pi adapter uses pi's completion API, so model text presently arrives as one completed stream chunk; task, tool, input, and usage events remain live.

## Authoring a skill

New workspaces receive a comprehensive `.pi/deepclause/AGENTS.md` authoring guide distilled from the SDK language reference, runtime implementation, examples, compiler prompts, and planning benchmarks. It teaches pi to design DML as deterministic Prolog orchestration around typed model tasks, narrow tools, explicit progress, constraints, and safe fallback.

The evidence and design decisions behind it are recorded in [docs/AUTHORING_GUIDE_ANALYSIS.md](docs/AUTHORING_GUIDE_ANALYSIS.md).

The design and security rationale for `/dc-plan` are recorded in [docs/DC_PLAN_PROPOSAL.md](docs/DC_PLAN_PROPOSAL.md).

The guide covers:

- `agent_main/0` through `agent_main/3`, typed `task/N` and isolated `prompt/N`
- memory, interpolation, dicts, model-callable DML tools, and pi's restricted host tools
- backtracking, CLP constraints, failure handling, command approval, and validation workflow
- architecture patterns for research, constrained planning, workspace engineering, compliance gates, interactive expert systems, data pipelines, and generate-review-repair workflows

A minimal skill accepts one slash-command argument:

```prolog
agent_main(Topic) :-
    system("You are a concise analyst."),
    format(string(Request), "Explain ~w and store the final text in Summary.", [Topic]),
    task(Request, string(Summary)),
    answer(Summary).
```

Before creating or modifying DML, consult `.pi/deepclause/AGENTS.md` and `.pi/deepclause/DML_REFERENCE.md`. DeepClause compilation is intentionally unavailable in this integration; authored content must already be valid DML.

## Development

```sh
git clone https://github.com/deepclause/deepclause-pi.git
cd deepclause-pi
npm install
npm run check
```

The package depends on `deepclause-sdk` 0.0.87 and uses pi packages as peer dependencies. The source extension entry point is declared in the `pi.extensions` package field, matching pi's TypeScript extension-loading convention.

## Scope

- No Markdown-to-DML compiler
- No dynamic per-skill slash commands
- No independent DeepClause session or execution-log store
- No direct DML access to pi's full tool registry
- No model-callable execution unless the user enables `dc_run` for the workspace
- No silent mutation of user files
- No workspace path escape

## License

MIT. See [LICENSE](LICENSE).
