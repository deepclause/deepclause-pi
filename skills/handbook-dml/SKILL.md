---
name: handbook-dml
description: Convert a long handbook/SOP into one DeepClause DML skill per workflow — an LLM-first subagent (agentic task/N leaves, narrow tool/2 capabilities) that takes a generic natural-language request as input and uses deterministic Prolog only for mechanical checks, with LLM fallback. Also teaches a tool audit, user confirmation, and how to write the repo-root AGENTS.md policy-routing table so pi calls the skills automatically via dc_run. Use when asked to turn a handbook or procedures manual into executable DML, update a handbook-derived skill, or wire the policy router.
---

# Handbook → DML (procedures)

Turn a long handbook into **one DML skill per workflow/procedure**. Each skill is
an **LLM-first subagent**: agentic `task/N` leaves do the reading, reasoning,
and acting, while Prolog handles only what is genuinely mechanical (arithmetic,
counting, exact equality) or a hard safety invariant.

Before writing DML, read `.pi/deepclause/AGENTS.md` and
`.pi/deepclause/DML_REFERENCE.md`. They are authoritative for syntax.

## Mental model

- **Pi authors; DML is the runtime artifact.** Decomposition and authoring happen
  in a normal pi turn. There is no Markdown→DML compiler.
- **LLM-first.** Rules and flow are `task/N` / `prompt/N` by default. Use Prolog
  only where a rule is mechanical or must never be wrong.
- **Input is a generic request.** `agent_main(Request)` takes free text; the
  first step is an LLM `task/N` that parses it into a typed `object/1` case (or
  the request is used directly for simple skills).
- **Forbidden actions become tool scoping.** "Never send" means *no send tool*.
  "Read-only inspection" means the inspect phase gets read tools only.
- **Every deterministic rule gets an LLM fallback.** If a deterministic check
  fails, branch to a `prompt/N`/`task/N` that reviews, repairs, or asks the user
  — do not hard-fail.
- **Ask, don't assume.** Confirm scope, the decomposition, and tool choices with
  the user before authoring.

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
    <optional verification with LLM fallback>,
    answer(Final).

agent_main(_) :-
    answer("Supply a request describing the case.").
```

Notes:

- `task/N` = agentic leaf (memory + DML tools). `prompt/N` = fresh-context
  review. `with_tools/2` scopes capability per phase.
- Build `task/N` descriptions with `format/3` (not `{Var}` interpolation) when
  you embed dynamic values — avoids singleton-variable noise.
- Mutable facts must be declared `:- dynamic` before `assertz`/`retract`.

## Verification (optional, LLM-first)

Only add checks when the procedure has observable post-conditions. Prefer model
review; use deterministic checks only for mechanical facts, and always give a
deterministic check an LLM fallback.

```prolog
% deterministic gate (mechanical only)
holds(drafts_count) :- findall(_, draft(_,_,_,_), Ds), length(Ds, 2).

verify_state(Failed, Report) :-
    findall(Name, (postcondition(Name), \+ holds(Name)), Failed),
    ( Failed = [] -> Report = "PASS" ; format(string(Report), "FAIL: ~w", [Failed]) ).

% LLM fallback: never hard-fail on a deterministic check
fallback_review(Failed, Verdict, Reason) :-
    format(string(Prompt),
        "These structural checks failed: ~w. Review the outcome and the requirement. Store 'acceptable' or 'needs-attention' in Verdict and a one-line reason in Reason.",
        [Failed]),
    prompt(Prompt, string(Verdict), string(Reason)).
```

In `agent_main`:

```prolog
verify_state(Failed, Report),
(   Failed = [] -> V = "n/a", R = "deterministic checks passed"
;   fallback_review(Failed, V, R)
),
answer(... report Report + V/R ...).
```

Choosing:

- **Model review** (default): tone, completeness, correctness of free text,
  "does this read right", and anything the rubric phrases as a judgment.
- **Deterministic** (only when mechanical): counts, exact IDs, arithmetic. Keep
  it tiny, and route failures to the model or the user instead of failing.

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
3. Deterministic code is limited to arithmetic/counts; every deterministic
   check has an LLM fallback branch.
4. The tool audit was done and its result is recorded in the header/INDEX.
5. Re-check the invalid-pattern table in `.pi/deepclause/AGENTS.md` (singleton
   variables, `~` vs `{}` interpolation, `Result.field` vs `get_dict/3`, `->`
   committing over generators, `answer/1` last, `:- dynamic` before
   `assertz/retract`).

`--context=isolated` keeps session text out of the run. The runtime still needs
a model selected.

## Reference shape

A typical procedure skill has: `agent_main(Request)` that parses the request
with `task/N`, confirms with the user via a `user_feedback` tool loop, acts
through write tools, and reviews with `prompt/N` — with small deterministic
helpers for arithmetic and a fallback branch instead of hard failures.

For DML mechanics, see the bundled example skills in a fresh workspace
(`example.dml`, `deep_research.dml`) and `.pi/deepclause/AGENTS.md`.
