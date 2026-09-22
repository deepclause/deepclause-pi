---
name: handbook-dml
description: Convert a long handbook/SOP into one DeepClause DML skill per workflow — a `task/N` subagent for agentic work, the judgment predicates (`choose`/`rate`/`verify`/`probability`/`holds`/`judge`) for bounded classification and calibrated gates, and deterministic Prolog only for mechanical checks, always with fallbacks. Also teaches a tool audit, user confirmation, and how to write the repo-root AGENTS.md policy-routing table so pi calls the skills automatically via dc_run. Use when asked to turn a handbook or procedures manual into executable DML, update a handbook-derived skill, choose between a classifier, a probability gate, and a full agent task, or wire the policy router.
---

# Handbook → DML (procedures)

Turn a long handbook into **one DML skill per workflow/procedure**. Each skill
combines three primitives: agentic `task/N` leaves for work that must act or
reason across turns, bounded judgment predicates (`choose`/`rate`/`verify`/
`probability`/`holds`) for classification and calibrated gates, and Prolog only
for what is genuinely mechanical (arithmetic, counting, exact equality) or a
hard safety invariant.

Before writing DML, read `.pi/deepclause/AGENTS.md` and
`.pi/deepclause/DML_REFERENCE.md`. They are authoritative for syntax.

## Mental model

- **Pi authors; DML is the runtime artifact.** Decomposition and authoring happen
  in a normal pi turn. There is no Markdown→DML compiler.
- **Pick the cheapest primitive.** Bounded classifications, ratings, yes/no
  checks, and probabilities use the judgment predicates (`choose/4`, `rate/4`,
  `verify/3`, `probability/3`, `holds/2-3`, `judge/2`). Fresh-context generation
  and critique use `prompt/N`. Multi-turn work with memory, tools, and typed
  outputs uses `task/N`. Use Prolog only where a rule is mechanical or must
  never be wrong. See **Choosing the reasoning primitive** below.
- **Input is a generic request.** `agent_main(Request)` takes free text; the
  first step is an LLM `task/N` that parses it into a typed `object/1` case (or
  the request is used directly for simple skills).
- **Forbidden actions become tool scoping.** "Never send" means *no send tool*.
  "Read-only inspection" means the inspect phase gets read tools only.
- **Every deterministic rule gets a fallback.** If a deterministic check
  fails, branch to a judgment, a `prompt/N`/`task/N`, or the user — do not
  hard-fail.
- **Ask, don't assume.** Confirm scope, the decomposition, and tool choices with
  the user before authoring.

## Choosing the reasoning primitive

Before writing flow, ask what the **core question** of each step is. A full
`task/N` agent loop carries memory, DML tools, and a multi-turn reasoning loop;
it is the right answer only when the step must act or reason iteratively. A
bounded question over explicit text should use the judgment predicates instead:
they are cheaper, the answer is constrained to the labels/levels you supply,
they never touch DML memory, and they cannot call tools.

| Core question | Primitive | Notes |
| --- | --- | --- |
| "Which category/team/route?" from a small closed set | `choose/4` (or `judge/2` with `choose`) | The answer is always one of your option atoms |
| "How severe/frustrated/confident?" (ordered) | `rate/4` | Answer is constrained to your levels |
| "Is X true?" / "Does it ask for a refund?" | `verify/3`, or `holds/2` when only the boolean matters | Three-valued: `yes` / `no` / `unknown` |
| "How likely is X?" / "Is it over a threshold?" | `probability/3`, or `holds/3` for a threshold gate | Decision-grade only when the backend reports `calibrated` |
| Free-form generation, rewrite, or critique of supplied text | `prompt/N` | Fresh context, no tools, no memory |
| Multi-step job needing tools, memory, or iteration | `task/N` | Typed outputs; scope tools with `with_tools/2` |

**Simple classifier.** If the core question reduces to choosing among a fixed
set of labels, use `choose/4`. Do not spend a `task/N` on it, and do not let the
model invent a label: the judge is constrained to your options.

```prolog
route(Request, Team) :-
    choose(Request, "Which team should handle this request?",
           [billing-"Charges and refunds", orders-"Delivery and returns", account-"Login and security"],
           Team).
```

**Calibrated probability.** If the decision depends on a probability, say so and
gate it. The default `llm` backend is *uncalibrated*: a number from it is an
estimate, not a calibrated probability. Wrap the judgment in
`require_judgment(calibrated, ...)` so the skill cannot silently run on a
backend that only estimates, and provide a fallback clause.

```prolog
risk_band(Text, Band) :-
    require_judgment(calibrated,
        probability(Text, "What is the probability this is high risk?", P)),
    (   P >= 0.8 -> Band = high
    ;   P >= 0.4 -> Band = medium
    ;   Band = low
    ).

risk_band(Text, Band) :-
    % Uncalibrated fallback: a coarse classifier, never a fake probability.
    choose(Text, "Is this high, medium, or low risk?", [high, medium, low], Band).
```

`holds(Text, Question, Threshold)` is the concise form when you only need the
threshold decision, and `holds(Text, Question)` is the concise form of a yes/no
check. `with_judgment(jev, Goal)` pins a scope to a specific backend (for
example a calibrated one). `require_judgment/2` fails **before** the judgment
runs, which is what makes the fallback clause above reachable; the runtime emits
a warning naming the missing capability.

**Full agent loop.** Use `task/N` (or `prompt/N`) when the step needs to read
accumulated memory, call a DML tool, run several model turns, or produce
free-form text. The judgment layer deliberately cannot do those things.

**Batch judgments.** When one step needs more than one or two judgments, send a
single `judge/2` batch rather than several one-offs:

```prolog
judge(Message, [
    choose("Which team should handle this?", [billing, orders, account]) - Team,
    rate("How frustrated is the customer?", [calm, frustrated, angry]) - Frustration,
    verify("Does the message ask for a refund?") - Refund,
    probability("Is this urgent?") - Urgency
]).
```

### Judgment rules

- `judge/2`, `choose/4`, `rate/4`, `verify/3`, `probability/3`, `holds/2`,
  `holds/3`, `with_judgment/2`, and `require_judgment/2` are runtime special
  predicates. Do not define your own predicates with those names — a common
  collision is a hand-written `verify/3`. Name deterministic helpers
  `verify_task/3`, `check_*`, and so on.
- `verify` is three-valued. `\+ verify(...)` does **not** mean "the model said
  no"; inspect the returned `yes` / `no` / `unknown`.
- Keep `State` explicit: pass the exact text or object to judge. The judge sees
  only that state plus the question and never reads DML memory.
- A `choose`/`rate` answer is constrained to your options/levels, so make them
  exhaustive and mutually exclusive.
- Never present an `estimated` probability as `calibrated`. Require the
  capability and fall back, or label the output as an estimate.
- Answers are memoized per run by backend, model, state, and questions, so
  backtracking reuses an answer instead of re-querying the model.
- The deterministic linter warns when a skill has no `task()` call and suggests
  `task()` for classification. That heuristic predates the judgment layer: a
  skill whose core question is a bounded judgment can legitimately have no
  `task/N`.

## Workflow

1. **Ingest** the handbook to Markdown (PDF→`pdftotext`, DOCX/HTML→`pandoc`).
   Keep the source under `examples/handbook-md/<handbook_slug>/`.
2. **Clarify** with the user: which workflows to convert, what the input looks
   like (a request? a file? a case id?), and what the skill may change.
3. **Decompose** by the document's own workflows and **propose the
   section → skill map; get approval** before writing files.
4. **Tool audit** (below): list each procedure's required capabilities, check
   what is available, flag gaps, and ask whether dummy tools are acceptable.
5. **Author** one DML per workflow from the template below.
6. **Run and iterate** with the user's real input:
   `/dc-run skills/<handbook_slug>/<slug>.dml "<request>" --debug`.
7. **Write `INDEX.md`** and **add a row to the repo-root `AGENTS.md`** routing
   table.

## Input convention

The skill takes a **generic natural-language request**, not positional args and
not hardcoded case facts.

- Default: parse the request with an LLM `task/N` into a typed `object/1` case.
- Simpler skills: pass the request text directly into the first `task/N` and
  skip the extraction step.

```prolog
extract_case(Request, Case) :-
    format(string(Desc),
        "Extract a structured case from this request: ~w. Store an object with keys <fields>. Use null for unknown fields.",
        [Request]),
    task(Desc, object(Case)).
```

`object(Var)` is a supported typed output; read it with `get_dict/3`. Then
confirm with the user before acting. User interaction loops belong **inside a
`task/N`**, with `ask_user` exposed as a tool:

```prolog
tool(user_feedback(Prompt, Response), "Ask the user one focused question and return their response") :-
    exec(ask_user(prompt: Prompt), Result),
    get_dict(user_response, Result, Response).

confirm_case(Case, ConfirmedCase) :-
    format(string(Instruction),
        "Present this extracted case to the user with the user_feedback tool: ~w. Ask them to type 'ok' or describe corrections. If 'ok', return the case unchanged. Otherwise apply corrections and ask again, up to 3 rounds. Store the final case in ConfirmedCase.",
        [Case]),
    with_tools([user_feedback], (
        task(Instruction, object(ConfirmedCase))
    )).
```

## Tool audit

Before authoring, list what the procedure needs and check what actually exists.

| Procedure need | Real option | Dummy fallback |
| --- | --- | --- |
| email / Slack / calendar / Jira / Shopify | pi tools (if installed & active) or MCP | `tool/2` over `pi_bash` (files) or over facts |
| read spreadsheets / PDFs / CSVs | pi tools or `pi_bash` | `tool/2` reading fixture files |
| ask the user | `ask_user` (always available in DML) | — |
| arbitrary shell | `pi_bash` (approval-gated) | — |

The DML runtime itself exposes only `pi_workspace_list`, `pi_bash`, and
`ask_user`. Everything else (email, Slack, calendar, structured file readers) is
missing unless you add it as a DML `tool/2`. So:

1. For each required capability, note whether a real tool exists.
2. If it is missing, **tell the user and ask: "use a dummy tool for X?"** before
   authoring. Do not silently build a dummy.
3. Record the chosen substitution in the skill header and in `INDEX.md`.

## Light template

```prolog
% POLICY: <slug>
% Handbook : <handbook_slug> (<title>)
% Trigger  : <when to run>
% Input    : a natural-language request (parsed by the first task)
% Effects  : <what state this changes, if any>
% Tools    : <real or dummy, per the tool audit>
%
% Run: /dc-run skills/<handbook_slug>/<slug>.dml "<request>"

% --- tools ----------------------------------------------------------------
% Read tools for inspection; write tools for action; omit forbidden actions.
tool(<read_...>(Args, Out), "Description") :- ... .
tool(<write_...>(Args, Result), "Description") :- ... .
tool(user_feedback(Prompt, Response), "Ask the user one focused question and return their response") :-
    exec(ask_user(prompt: Prompt), Result),
    get_dict(user_response, Result, Response).

% --- bounded judgments (cheap: no memory, no tools) ------------------------
% Prefer a judgment over a task/N for a bounded question about explicit text.
% classify(Request, Kind) :-
%     choose(Request, "Which case type is this?", [<kind_a>, <kind_b>, other], Kind).
% confirm_requirement(Report) :-
%     holds(Report, "Does the report include the required referral advice?", 0.7).

% --- deterministic helpers (mechanical only) -------------------------------
<compute_or_check>(...).          % arithmetic/counts; keep small

% --- entry point ------------------------------------------------------------
agent_main(Request) :-
    Request \= "",
    system("Role and hard rules. Treat supplied policy text as governing."),
    output("Parsing the request..."),
    extract_case(Request, Case),                    % task/N -> object/1
    output("Confirming..."),
    confirm_case(Case, ConfirmedCase),              % user_feedback loop
    output("Acting..."),
    with_tools([<write tools>], (
        task("Produce the required effects for this case: {ConfirmedCase}.", string(Summary))
    )),
    <optional judgment / prompt / deterministic verification with fallback>,
    answer(Final).

agent_main(_) :-
    answer("Supply a request describing the case.").
```

Notes:

- `task/N` = agentic leaf (memory + DML tools). `prompt/N` = fresh-context
  generation/review. `choose`/`rate`/`verify`/`probability` = the judgment layer.
  `with_tools/2` scopes capability per phase.
- Prefer a judgment over a `task/N` whenever the core question is a bounded
  classification, rating, yes/no check, or probability gate.
- Build `task/N` descriptions with `format/3` (not `{Var}` interpolation) when
  you embed dynamic values — avoids singleton-variable noise.
- Mutable facts must be declared `:- dynamic` before `assertz`/`retract`.

## Verification (optional)

Only add checks when the procedure has observable post-conditions. Match the
check to the question: a bounded semantic check is a judgment, an open-ended
read is a model review, and a count is deterministic. Every check needs a
fallback path so it never hard-fails.

- **Semantic gate (default for bounded checks).** "Does the output recommend
  urgent referral when a danger sign is present?" is a `verify/3` question, or
  `holds/2` when you only need the boolean. Use `holds/3` when the check is a
  probability threshold.
- **Model review (`prompt/N`).** Tone, completeness, correctness of free text,
  "does this read right", and open-ended rubric interpretation.
- **Deterministic (only when mechanical).** Counts, exact IDs, arithmetic. Keep
  it tiny, and route failures to a judgment, a review, or the user.

```prolog
% Semantic gate: a bounded yes/no question about explicit text.
referral_ok(Report) :-
    holds(Report, "Does the report recommend urgent referral when a danger sign is present?").

% Deterministic gate (mechanical only).
drafts_complete :- findall(_, draft(_,_,_,_), Ds), length(Ds, 2).

verify_state(Report, Note) :-
    (   referral_ok(Report), drafts_complete
    ->  Note = "verification passed"
    ;   % Fallback: never hard-fail; explain the failure and let pi/user decide.
        format(string(Prompt),
            "Review this outcome against the requirement and explain any gap: ~w. Store 'acceptable' or 'needs-attention' in Verdict and a one-line reason in Reason.",
            [Report]),
        prompt(Prompt, string(Verdict), string(Reason)),
        format(string(Note), "fallback verdict ~w: ~w", [Verdict, Reason])
    ).
```

In `agent_main`:

```prolog
verify_state(Report, Note),
answer(... report + Note ...).
```

For a calibrated postcondition, wrap `holds(Report, Question, Threshold)` in
`require_judgment(calibrated, ...)` and keep the same fallback pattern.

## Dummy tools

Only after the user approves. Prefer **file-backed** dummy tools (read/write
fixture files through `pi_bash`) because they mirror real services and make the
skill runnable against real data. Use **fact-backed** state only for pure
in-memory cases. Keep the tool name/contract stable so a real `exec/2`/MCP
implementation can replace the dummy body later.

## The AGENTS.md policy router

After the skills are written and tested, wire them into the repo-root
`AGENTS.md` so pi calls them automatically. `AGENTS.md` is always in pi's
context; `dc_run` (enabled once with `/dc-tool enable`) executes a named skill.

```markdown
## DeepClause policy routing

When a request matches a procedure below, do **not** answer from memory or from
the source handbook text. Call the `dc_run` tool with the mapped skill, then
report its answer (including its verification result, if any).

If `dc_run` is unavailable, tell the user to run `/dc-tool enable` (persists for
the workspace) or to run the equivalent `/dc-run` command themselves.

| Handbook | Procedure / trigger | Skill (`dc_run.skill`) | Args (`dc_run.args`) |
| --- | --- | --- | --- |
| <handbook_slug> | <short trigger phrase a request would match> | `skills/<handbook_slug>/<slug>.dml` | `["<the user's request>"]` |

Conventions:

- `args` carries the natural-language request; pass the user's message through.
- If the skill has verification, do not claim success unless it passes.
- Detailed maps live in each handbook's
  `.pi/deepclause/skills/<handbook_slug>/INDEX.md`.
```

Rules:

1. **`Handbook`** — the `<handbook_slug>` directory under `.pi/deepclause/skills/`.
2. **`Procedure / trigger`** — a short phrase in the *user's* wording.
3. **`Skill`** — path relative to `.pi/deepclause/`; must contain `/`.
4. **`Args`** — the request text (the skill parses it). One row per procedure.
5. Update the table in the same change; tell the user to `/reload` if pi is
   already running.

## Testing checklist

For each generated skill:

1. `/dc-run skills/<handbook_slug>/<slug>.dml "<request>" --context=isolated --debug`
   — runs clean; verification (if any) passes or the fallback explains.
2. Inspect phase is read-only, action phase is write-only, and a forbidden
   action has no tool at all.
3. Bounded classifications and checks use the judgment predicates; calibrated
   probabilities are wrapped in `require_judgment(calibrated, ...)` with a
   fallback clause, and `verify/3` results are read as `yes`/`no`/`unknown`.
4. Deterministic code is limited to arithmetic/counts; every deterministic
   check has a model/judgment fallback branch.
5. The tool audit was done and its result is recorded in the header/INDEX.
6. Re-check the invalid-pattern table in `.pi/deepclause/AGENTS.md` (singleton
   variables, `~` vs `{}` interpolation, `Result.field` vs `get_dict/3`, `->`
   committing over generators, `answer/1` last, `:- dynamic` before
   `assertz/retract`).

`--context=isolated` keeps session text out of the run. The runtime still needs
a model selected.

To exercise calibrated judgments for real, enable the Jev backend
(`/dc-judge enable`, `/dc-judge default jev`, or `--judge=jev`) and export the
backend's API key (default `TYPESAFE_API_KEY`) in the shell that launches pi.
Without it, the `llm` backend is uncalibrated and the
`require_judgment(calibrated, ...)` branch is skipped in favor of the fallback.

## Reference shape

A typical procedure skill has: `agent_main(Request)` that parses the request
with `task/N`, confirms with the user via a `user_feedback` tool loop, uses
bounded judgments (`choose`/`verify`/`holds`) for classification and gates, acts
through write tools, and reviews with `prompt/N` — with small deterministic
helpers for arithmetic and a fallback branch instead of hard failures.

For DML mechanics, see the bundled example skills in a fresh workspace
(`example.dml`, `deep_research.dml`), `.pi/deepclause/DML_REFERENCE.md` (the
judgment predicates are documented there), and `.pi/deepclause/AGENTS.md`.
