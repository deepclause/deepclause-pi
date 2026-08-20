# DML authoring guide analysis

## Purpose

This document records the evidence and design decisions behind the pi-specific guide seeded as `.pi/deepclause/AGENTS.md`. The guide is intentionally not a copy of one SDK document: the SDK corpus addresses several runtimes, includes legacy examples, and contains both implemented and proposed features.

The proposed pi-native plan-generation and delegated-execution architecture is documented separately in [DC_PLAN_PROPOSAL.md](DC_PLAN_PROPOSAL.md).

## Corpus reviewed

The review covered these source categories in `deepclause-sdk`:

- Language references: `docs/DML_REFERENCE.md`, `docs/DML_FILE_PATTERNS.md`, and the packaged reference under `src/system/assets/docs/`.
- Model instructions: `DML_COMPILER_PROMPT.md`, `TASK_PROMPT.md`, `CONDUCTOR_PROMPT.md`, and the coding-workflow recipe.
- Runtime implementation: `src/agent.ts`, `src/runner.ts`, `src/types.ts`, `src/prolog/bridge.ts`, and `src/prolog-src/deepclause_mi.pl`.
- Examples: research, coding, conversational, knowledge-base, CLP(FD), data-analysis, file, nested-task, type, and tool-scoping programs under `dml-examples/`.
- System DML: planner, conductor, security planner, skill creator, and compactors.
- Planning benchmarks: travel variants and worker plans under `benchmarks/deepplanning/` and `benchmarks/worker/`.
- Benchmark and design Markdown: SWE-bench design, retry design, travel-planner specification, and natural-language examples.
- Pi integration: workspace initialization, context import, active-model adapter, event mapping, command parsing, restricted tools, examples, and tests.

Generated `dist/` copies and dependency trees were excluded where their source equivalents existed.

## Findings

### The runtime is the source of truth

The current meta-interpreter dispatches `agent_main/0` through `agent_main/3`, while some older reference text only mentions arities through 2. It transforms `task` calls with zero through four output variables. The pi command supplies positional strings and does not expose arbitrary named user parameters.

The guide therefore documents the implemented pi surface rather than repeating older limits.

### The compiler prompt contains useful hard-earned rules, but cannot be copied directly

The compiler prompt has the strongest catalog of common generation failures:

- exact variable names in task descriptions
- `{Variable}` interpolation
- correct `format/3` and `get_dict/3` use
- typed task outputs
- output before long operations
- explicit fallback clauses
- safe list and dict idioms

However, it assumes the general CLI environment, `.deepclause/`, compiler and validation commands, package installation, and tools such as `web_search`, `url_fetch`, `write_file`, and generic `bash`. Those assumptions are wrong for pi. The new guide retains language rules while replacing the environment and tool sections with pi's actual boundary.

### Examples are pattern evidence, not API guarantees

The examples demonstrate valuable architectures:

- `deep_research.dml`: staged planning, feedback, gathering, and synthesis
- `coding-agent.dml`: failure-driven control and explicit progress
- `knowledge-agent.dml`: symbolic facts exposed through model-callable tools
- `clpfd-planner.dml`: model creativity followed by deterministic constraints
- nested-task and tool-scoping examples: capability composition and memory isolation

Many SDK examples use legacy or CLI-only tools such as `vm_exec`, `web_search`, and unrestricted file operations. The guide uses their architecture but never advertises those tools as available in pi.

### The planning benchmarks contain the strongest DML design principle

The later travel benchmark decomposes work into:

1. typed model extraction
2. candidate gathering
3. Prolog candidate selection
4. deterministic hard-constraint checks
5. model scheduling or presentation
6. backtracking to another candidate on failure

This yields the guide's central model: **a deterministic workflow with probabilistic leaves**. It is more useful than presenting DML as prompt chaining because it explains when DML provides value over a script or a single model call.

### Design documents may describe unimplemented features

`benchmarks/RETRY_DESIGN.md` proposes `retry_atmost/2` and `retry_with_analysis/2`. It is a design document, not evidence that those predicates exist in the current runtime. The guide does not expose them. It uses implemented Prolog clauses, recursion, failure, and backtracking instead.

### Backtracking needs an effects warning

Model memory can roll back with Prolog control flow, but external commands, file writes, user-visible output, and other side effects are not transactional. Examples that celebrate retry behavior without this distinction can lead to duplicate or destructive actions. The guide makes the distinction explicit.

### Pi changes the safety and usability model

The pi integration provides:

- pi's selected model and credentials
- `turn`, `branch`, and `isolated` session import
- cancellation and usage accounting
- progress, tool, input, answer, and error events
- `pi_workspace_list/1`
- approval-gated `pi_bash/1` and argv-mode `pi_bash/2`
- internal `ask_user` input that can be wrapped in DML

It intentionally does not provide the full pi tool registry, compilation, unrestricted paths, concurrent runs, or separate persistent sessions. The authoring guide treats these constraints as application design inputs, not footnotes.

## Guide design

The seeded guide is organized for an AI coding agent rather than as a language encyclopedia:

1. non-negotiable workspace rules
2. useful mental model
3. before/after authoring workflow
4. executable entry-point contract
5. choosing `task`, `prompt`, or `llm`
6. memory and typed results
7. interpolation and Prolog formatting
8. direct host calls versus model-callable DML tools
9. exact pi runtime capabilities and approvals
10. progress and completion
11. backtracking, deterministic validation, and CLP
12. reusable architecture patterns
13. application space
14. conservative editing rules
15. common invalid patterns
16. robust starting template

The full SDK reference remains available beside it for breadth. The guide acts as the opinionated pi-specific layer that resolves conflicts and prioritizes reliable patterns.

## Application space

### Evidence and research systems

Architecture: plan → optional user review → several narrow retrieval calls → deterministic source normalization → synthesis → independent review.

Examples include literature reviews, claim/evidence matrices, competitive intelligence, policy monitoring, and due-diligence briefs. The current pi runtime can use approved `curl` in argv mode, as demonstrated by the Bing RSS example.

### Constrained planners and configurators

Architecture: extract typed constraints → gather options → solve with Prolog or CLP → explain the selected solution.

Examples include schedules, budgets, event plans, staffing, package/configuration selection, eligibility, and resource allocation. This is where DML most clearly outperforms unconstrained prompt chaining.

### Workspace engineering agents

Architecture: inspect workspace → create a bounded action plan → ask for confirmation when needed → run approved commands → parse test/build results → repair or report.

Examples include release audits, migration preparation, repository triage, test orchestration, dependency checks, and code-review pipelines. Repeated command approvals make high-frequency autonomous shell loops a poor fit unless the permission model later evolves.

### Compliance and quality gates

Architecture: model extracts or drafts structured artifacts → deterministic predicates enforce policy → failures select remediation or a static fallback.

Examples include requirements traceability, security review, editorial rubrics, policy checks, and structured acceptance gates.

### Interactive expert systems

Architecture: Prolog facts and rules hold stable domain knowledge → narrow tools expose queries or state transitions → a task provides natural-language interaction → `ask_user` handles missing decisions.

Examples include troubleshooting, guided intake, product configuration, and rule-based decision support.

### Data and content pipelines

Architecture: approved command retrieves data → Prolog parses and filters → typed tasks classify or summarize → deterministic aggregation → final report.

Examples include JSON/CSV triage, issue classification, report generation, brief-to-draft workflows, and independent editorial review.

### Pure symbolic applications

A DML skill need not call a model. Prolog recursion, facts, parsing, and CLP can provide deterministic validators, transformations, finite search, simulations, and optimization while still benefiting from pi's command, cancellation, and UI integration.

## Poor fits under the current boundary

- background services and concurrent workers
- silent or high-frequency shell automation requiring many approvals
- workflows requiring arbitrary pi tools
- secret discovery or credential management
- unbounded web crawling or large raw-context ingestion
- durable application state without an explicit, user-approved workspace storage design

## Maintenance policy

- Keep the guide aligned with implementation and tests, not aspirational design files.
- Add a pi capability only after it is registered and policy-tested.
- Do not silently overwrite an existing workspace guide. New bundled guidance applies to newly initialized workspaces until an explicit non-destructive documentation versioning mechanism is introduced.
- When SDK behavior changes, review entry arity, task result typing, interpolation, memory, tool scoping, and side-effect semantics first.
