# DeepClause meets pi: executable agent plans inside your coding session

### DML orchestration with pi’s models, tools and context

`tldr;` I built a [pi](https://github.com/badlogic/pi-mono) extension for [DeepClause](https://github.com/deepclause/deepclause-sdk). It runs DML programs with pi’s active model, credentials and session context. It can also turn a normal planning request into an executable DML plan. The plan can delegate individual steps back to pi, with a fixed set of tools for each step.

The extension is available here: [https://github.com/deepclause/deepclause-pi](https://github.com/deepclause/deepclause-pi)

[The following is mostly written by a real person ;-]

I have spent quite a bit of time using DeepClause as a standalone agent runtime. That works well for benchmarks and self-contained workflows, but it leaves out something useful: the environment of a coding agent that is already running.

A coding agent such as pi already has:

- a selected model and working authentication
- the current conversation and compacted session history
- repository instructions and loaded skills
- file, shell and extension tools
- a terminal UI, cancellation and usage accounting

Reimplementing all of that in DeepClause would make little sense. The more useful option is to let pi remain the host and use DeepClause for the part it is good at: explicit orchestration.

This is what the new extension does.

[Image: `/dc` status and command overview]

### Running DML inside pi

The basic case is simple. DML programs live in `.pi/deepclause/skills/` and can be executed with a slash command:

```text
/dc-run example --debug
```

The extension uses the model currently selected in pi. It does not ask for another API key or try to guess the provider. Model calls, cancellation, input prompts and usage stay connected to the current pi session.

A minimal skill still looks like ordinary DML:

```prolog
agent_main(Topic) :-
    system("You are a concise technical analyst."),
    format(string(Request),
           "Explain ~w. Store the final explanation in Summary.",
           [Topic]),
    task(Request, string(Summary)),
    answer(Summary).
```

Run it as follows:

```text
/dc-run skills/explain.dml "constraint logic programming"
```

There are three context modes:

- `turn` imports the current request and its immediate context
- `branch` imports a bounded part of the active session branch
- `isolated` starts without pi conversation history

For example:

```text
/dc-run skills/explain.dml "constraint logic programming" --context=isolated
```

Pi remains the session owner. DeepClause does not create another chat history next to it.

### Tools are deliberately boring

Ordinary DML programs do not receive pi’s complete tool registry. They start with two narrow host operations:

- `pi_workspace_list` lists one directory level inside the workspace
- `pi_bash` runs an approved command inside the workspace

Every `pi_bash` call requires user confirmation. Paths are checked against the active workspace, including resolved symlinks.

A DML program can wrap these operations in a more useful tool predicate:

```prolog
tool(bing_search(Query, Results),
     "Search Bing RSS and return the response body") :-
    format(string(QueryArg), "q=~w", [Query]),
    exec(pi_bash("curl", [
        "--fail", "--silent", "--show-error", "--location", "--get",
        "--data-urlencode", QueryArg,
        "https://www.bing.com/search?format=rss&count=8"
    ]), Result),
    get_dict(stdout, Result, Results).
```

The repository includes a small deep-research example built on this pattern. It asks the user to review a search plan through pi’s input UI, runs approved `curl` requests and produces a cited report.

I intentionally did not expose all coding tools directly through `exec/2`. Pi extensions can describe their tools, but there is no public generic API for another extension to invoke any tool by name. More importantly, copying tool execution into DeepClause would bypass behavior owned by pi or another extension, such as approval dialogs and policy checks.

This becomes relevant for planning.

### DML is the plan

The extension adds this command:

```text
/dc-plan <request> [--name=slug]
```

For example:

```text
/dc-plan build a small Three.js Space Invaders game and verify it --name=threejs-space-invaders
```

This starts a normal pi turn. The planner can inspect the repository, read its instructions, see loaded skills and consider the currently active tools. It does not directly return a Markdown checklist and it does not generate arbitrary DML source in one shot.

Instead, the planning turn finishes by calling a temporary tool named `dc_plan_commit`. The tool accepts a typed plan specification with:

- a title and objective
- ordered steps
- an executor for each step
- exact required tool names
- relevant pi skills
- an expected result for every step
- a fallback message

The extension validates this object and shows a preview. After user confirmation, it deterministically assembles the DML file, parses the generated program and writes it under `.pi/deepclause/plans/` without overwriting an existing file.

This follows the same general idea as the planner used in my DeepPlanning experiments: ask the model for a constrained intermediate representation and let normal code produce the executable DML. This is simpler and more reliable than asking the model to get every comma, variable and fallback clause right.

A generated plan looks like this:

```prolog
agent_main :-
    output("Step 1/3: Inspect the workspace"),
    exec(pi_agent_step(
        instruction: "Inspect repository instructions and identify the target app.",
        tools: ["bash", "read"],
        expected: "A target directory and concrete implementation baseline.",
        skills: []
    ), Step1Summary),
    Step1Summary \= "",

    output("Step 2/3: Implement the application"),
    exec(pi_agent_step(
        instruction: "Implement the agreed application and keep changes scoped.",
        tools: ["read", "write", "edit"],
        expected: "A runnable implementation with a concise change summary.",
        skills: []
    ), Step2Summary),
    Step2Summary \= "",

    output("Step 3/3: Validate the result"),
    exec(pi_agent_step(
        instruction: "Run the relevant checks and fix implementation failures.",
        tools: ["bash", "read", "write", "edit"],
        expected: "Passing checks or a precise account of remaining failures.",
        skills: []
    ), Step3Summary),
    Step3Summary \= "",

    answer([Step1Summary, Step2Summary, Step3Summary]).
```

The full file is executable. There is no Markdown-to-DML compilation step in the pi integration.

[Image: generated DML plan in the editor]

### What `pi_agent_step` does

`pi_agent_step` is the bridge between DML orchestration and a normal pi coding turn.

When the DML runtime reaches one of these calls, the extension:

1. checks that every named tool is installed and currently active
2. rejects DeepClause control tools to prevent recursive planning or execution
3. saves pi’s current active-tool set
4. temporarily activates only the tools named by the step
5. sends the bounded instruction through a normal pi turn
6. captures the final textual summary and tool failures
7. restores the previous active-tool set on success, failure or cancellation

The important point is that pi still executes the turn. A third-party extension tool therefore keeps its own UI, approvals and policy. DeepClause only controls which tools are available to that particular step and what should happen next.

The user must start such a plan explicitly:

```text
/dc-run plans/threejs_space_invaders.dml
```

Before execution, the extension shows the required tools and asks for confirmation.

The optional model-callable `dc_run` tool cannot execute contextual plans. Allowing an agent turn to start a plan that starts more agent turns would make recursion and session ownership needlessly difficult. For this first version, the boundary is simple: reusable self-contained skills may be model-called after explicit enablement; contextual plans are user-called.

### A concrete example

I used `/dc-plan` to create a five-step plan for a small Three.js Space Invaders game. The generated DML fixes the execution order:

1. inspect the workspace and choose the integration boundary
2. create the browser application foundation
3. implement deterministic game state and collision logic
4. connect the state to rendering, controls and UI
5. run tests and build the production bundle

Each step has a different tool set. Inspection gets `bash` and `read`. Pure implementation steps get `read`, `write` and `edit`. Validation gets all four. The plan records these requirements before any work starts.

This does not guarantee a correct game. The model can still write bad code, misunderstand an API or produce an incomplete summary. What it does guarantee is a more explicit execution structure. The agent cannot quietly skip from initial inspection to a confident final answer without the intervening DML goals succeeding.

This is the same reason I find DML useful with smaller models. Long context alone does not make long-running execution reliable. An explicit program can carry the sequence, checks, retries and fallback while the model deals with the parts that actually require judgment.

### Installation

The current release is `0.1.2` and depends on `deepclause-sdk` `0.0.87`.

Install directly from GitHub:

```sh
pi install git:github.com/deepclause/deepclause-pi
```

Or install it for one project:

```sh
pi install git:github.com/deepclause/deepclause-pi -l
```

For a project-local installation, start pi in the directory containing `.pi/settings.json`. The startup screen should list the DeepClause extension. If it does not, `/dc-run` will be treated as an ordinary message and sent to the model.

Useful commands:

```text
/dc
/dc-list
/dc-plan inspect this repository and propose a safe migration --name=migration
/dc-run plans/migration.dml
/dc-tool enable
/dc-cancel
```

`dc_run` is disabled by default. `/dc-tool enable` makes it available to the model for that workspace. This does not grant ordinary DML programs access to all pi tools.

### Some more thoughts and notes

1. This is an early integration. The main execution path works and has tests for plan creation, tool preflight, contextual delegation, cancellation and tool restoration. There are still plenty of rough edges to find in real repositories.

2. `task/N` supports stream events, but the current pi model adapter receives a completed model response and forwards it as one chunk. Tool activity, DML progress, input requests and usage are already live.

3. Generated plans currently record tool names, but not stable hashes of their schemas. A tool can change between planning and execution. The runtime catches missing or inactive tools, while deeper schema-drift checks can be added later.

4. DML backtracking does not undo external effects. If a plan writes a file and later fails, Prolog can try another clause, but the file is still there. Generated coding plans therefore use ordered steps and explicit summaries rather than pretending that side effects are transactional.

5. Does this produce better coding results than an unconstrained pi turn? I have some good examples, but no benchmark yet. The useful claim for now is narrower: it gives us an executable, inspectable plan with a clear boundary around context and tools. Please try it and report what breaks.

Repository: [https://github.com/deepclause/deepclause-pi](https://github.com/deepclause/deepclause-pi)

DeepClause SDK: [https://github.com/deepclause/deepclause-sdk](https://github.com/deepclause/deepclause-sdk)
