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

To try an unpublished checkout during development:

```sh
pi -e ./deepclause-pi/src/index.ts
```

## Commands

| Command | Description |
| --- | --- |
| `/dc` | Initialize the workspace non-destructively and show help, model, paths, and status. |
| `/dc-list` | List DML programs under `.pi/deepclause/skills/`. |
| `/dc-run <skill> [args]` | Run a named skill such as `example` or `deep_research`. |
| `/dc-run <path> [args]` | Run a DML file below `.pi/deepclause/`. |
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
```

## Workspace layout

The first `/dc` or `/dc-run` creates missing files under the active workspace:

```text
.pi/deepclause/
├── config.json
├── AGENTS.md
├── DML_REFERENCE.md
└── skills/
    ├── example.dml
    └── deep_research.dml
```

Existing files are never overwritten silently. The extension neither creates nor reads `.deepclause/`.

`AGENTS.md` teaches pi how to author and conservatively edit DML. `DML_REFERENCE.md` is the bundled language/runtime reference. Add user-maintained programs to `skills/`; pi can edit these files with its normal coding tools.

## Session context

Configure the default mode in `.pi/deepclause/config.json`:

```json
{
  "version": 1,
  "contextMode": "turn",
  "branchMessageLimit": 20,
  "gasLimit": 100000,
  "maxTokens": 16384,
  "verbose": false
}
```

- `turn` imports the current request and relevant immediate context. This is the default.
- `branch` imports a bounded set of messages from the active pi branch, including compacted history.
- `isolated` imports no pi conversation.

Pi remains the sole persistent session owner. Executions stop when their pi session closes or changes, and results are rendered into the current session.

## Runtime tools and approval

The extension does not expose DeepClause as a tool to the pi model and does not expose pi's general tool registry to DML. It registers only:

- `pi_workspace_list(RelativePath)` — read-only, one-level workspace listing. Absolute paths, traversal, and resolved symlink escapes are rejected.
- `pi_bash(Command)` — runs an explicitly approved shell command in the active workspace.
- `pi_bash(Executable, Args)` — runs an explicitly approved executable with a separate argv list, avoiding shell interpolation.

Every `pi_bash` call has a 60-second timeout, inherits cancellation, and is denied when interactive approval is unavailable.

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
- No access to pi's full tool registry
- No silent mutation of user files
- No workspace path escape

## License

MIT. See [LICENSE](LICENSE).
