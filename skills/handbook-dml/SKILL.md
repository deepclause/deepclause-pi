---
name: handbook-dml
description: Convert a long handbook/SOP into one DeepClause DML skill per workflow/procedure — a small deterministic spine around agentic task/N leaves with narrow tool/2 capabilities and optional verification (deterministic gate or model review). Also teaches how to write the repo-root AGENTS.md policy-routing table so pi calls the skills automatically via dc_run. Use when asked to turn a handbook or procedures manual into executable DML, update a handbook-derived skill, or wire the policy router.
---

# Handbook → DML (procedures)

Turn a long handbook into **one DML skill per workflow/procedure**. Each skill is
a subagent: a small deterministic Prolog spine around agentic `task/N` steps
that inspect and act through narrow `tool/2` capabilities.

Before writing DML, read `.pi/deepclause/AGENTS.md` and
`.pi/deepclause/DML_REFERENCE.md`. They are authoritative for syntax.

## Mental model

- **Pi authors.** Decomposition and authoring happen in a normal pi turn. There
  is no Markdown→DML compiler; every `.dml` must be valid as written.
- **DML is the runtime artifact.** Prolog owns what is checkable (arithmetic,
  thresholds, tool scoping, post-conditions); the model owns reading, composing,
  and producing effects.
- **Express hard rules in Prolog when you can.** If a rule is a computation or a
  deterministic check, make it a predicate. If it is judgment (tone,
  completeness, correctness of free text), let the model apply it and verify it
  with a reviewer.
- **Forbidden actions become tool scoping.** "Never send" means *do not define a
  send tool*. "Only read during inspection" means the inspect phase gets read
  tools only (`with_tools/2`).
- **Verification is optional and proportional.** Add a gate only when the
  procedure has observable post-conditions. Zero is a valid number.

## Workflow

1. **Ingest** the handbook to Markdown (PDF→`pdftotext`, DOCX/HTML→`pandoc`).
   Keep the source under `examples/handbook-md/<handbook_slug>/`.
2. **Decompose by workflow**, using the document's own top-level sections.
3. **Author** one DML per workflow under
   `.pi/deepclause/skills/<handbook_slug>/`, from the template below.
4. **Encode state** as facts where the procedure reads/mutates state; write
   narrow read/write tools.
5. **Add verification** only where post-conditions are observable (see below).
6. **Run and iterate**: `/dc-run skills/<handbook_slug>/<slug>.dml --debug`.
7. **Write `INDEX.md`** (section → skill map) and **add a row to the repo-root
   `AGENTS.md` routing table**.

## Decomposition rules

- One skill per **independently triggerable workflow** with a clear trigger,
  outcome, and (optional) set of effects.
- Keep all rules that govern one procedure in one file; do not split a
  computation from its escalation.
- Do not merge unrelated procedures to reduce file count.
- Skip pure reference material (glossaries, org charts) unless it participates
  in a procedure; record skips in `INDEX.md`.
- `snake_case` slugs, grouped under `.pi/deepclause/skills/<handbook_slug>/`.

## Light template

```prolog
% POLICY: <slug>
% Handbook : <handbook_slug> (<title>)
% Sections : <sections this procedure covers>
% Trigger  : <when to run>
% Effects  : <what state this changes, if any>
%
% Run: /dc-run skills/<handbook_slug>/<slug>.dml

% --- optional: state the procedure reads or mutates -------------------------
:- dynamic <mutable>/<arity>.            % only for facts you assertz/retract
<fact>(...).

% --- deterministic rules (only where expressible) ----------------------------
<decide_or_compute>(...).

% --- read tools (inspection phase) -------------------------------------------
tool(<read_...>(Args, Out), "Description") :- ... .

% --- write tools (action phase) ----------------------------------------------
% Define only the effects the procedure permits. Omit forbidden actions.
tool(<write_...>(Args), "Description") :- assertz(...).   % or exec/2

% --- entry point --------------------------------------------------------------
agent_main :-
    system("Role and hard rules. Treat supplied policy text as governing."),
    output("Inspecting..."),
    with_tools([<read tools>], (
        task("Inspect and summarize. Store ... in Summary.", string(Summary))
    )),
    output("Acting..."),
    with_tools([<write tools>], (
        task("Produce the required effects using only the write tools.", string(ActionSummary))
    )),
    <optional verification>,
    format(string(Final), "Summary: ~w~nActions: ~w", [Summary, ActionSummary]),
    answer(Final).

agent_main :-
    answer("The procedure did not complete. Review the output and retry.").
```

- `task/N` = agentic leaf (memory + DML tools). `prompt/N` = fresh-context
  single call (good for review). `with_tools/2` scopes capability per phase.
- Mutable state predicates must be declared `:- dynamic` before
  `assertz`/`retract`.
- If a phase needs no model, replace its `task/N` with a plain Prolog goal; if a
  phase needs no tools, drop the `with_tools/2` wrapper.

## Verification (optional)

Add a gate only when the procedure has **observable post-conditions** — things
you can re-read from the produced state or output. Two forms; combine freely.

### Deterministic gate

Use when a condition is checkable with Prolog (counts, presence, exact values,
fields, arithmetic):

```prolog
% one name per check; one holds/1 clause per check
postcondition(drafts_count).
postcondition(bcc_on_drafts).

holds(drafts_count) :-
    findall(_, draft(_,_,_,_), Drafts), length(Drafts, 2).
holds(bcc_on_drafts) :-
    forall(draft(_, Bcc, _, _), Bcc = "may@example.com").

verify_state(Report) :-
    findall(Name, (postcondition(Name), \+ holds(Name)), Failed),
    (   Failed = []
    ->  Report = "PASS: all post-conditions hold."
    ;   format(string(Report), "FAIL: ~w", [Failed])
    ).
```

Then call `verify_state(Report)` in `agent_main` before answering. Only
reference predicates that exist — declare mutable ones `:- dynamic` so an empty
state just fails instead of erroring.

### Model-reviewed gate (fallback)

Use when the criterion is judgment-like (is the draft complete, correct,
professional?) or when a deterministic check would be brittle. A fresh
`prompt/N` (or `task/N` if it needs tools) reviews the artifact and returns a
typed verdict:

```prolog
review_email(Draft, Verdict, Reason) :-
    prompt("Review this draft against the policy. Policy: <paste the rule>. Draft: {Draft}. Store 'ok' or 'fix' in Verdict and a one-line reason in Reason.",
           string(Verdict), string(Reason)).
```

```prolog
review_email(Draft, Verdict, Reason),
(   Verdict = "ok"
->  answer(Draft)
;   format(string(Msg), "Draft needs revision: ~w", [Reason]), answer(Msg)
).
```

### Choosing

- Counts, exact strings, fields, presence, arithmetic → **deterministic gate**.
- Tone, completeness, compliance, "does this read correctly" → **model review**.
- Common split: deterministic gate for the hard facts (2 drafts, correct BCC,
  correct numbers), model review for the prose. Deterministic first, model as
  fallback for what Prolog cannot check.

## Dummy tools

Default: **fact-backed state** — encode the case and mutable environment as
Prolog facts; read/write tools `assertz`/`retract` over them. Deterministic,
approval-free, runs with `/dc-run` and no prompts.

Production swap: replace a fact-backed tool body with `exec/2` (a real service)
or `pi_bash` (files), keeping the tool name and contract unchanged.

## The AGENTS.md policy router

After the skills are written and tested, wire them into the repo-root
`AGENTS.md` so pi calls them automatically. `AGENTS.md` is always in pi's
context; `dc_run` (enabled once with `/dc-tool enable`) executes a named skill.

The router is a Markdown table with exactly these four columns:

```markdown
## DeepClause policy routing

When a request matches a procedure below, do **not** answer from memory or from
the source handbook text. Call the `dc_run` tool with the mapped skill, then
report its answer (including its verification result, if any).

If `dc_run` is unavailable, tell the user to run `/dc-tool enable` (persists for
the workspace) or to run the equivalent `/dc-run` command themselves.

| Handbook | Procedure / trigger | Skill (`dc_run.skill`) | Args (`dc_run.args`) |
| --- | --- | --- | --- |
| <handbook_slug> | <short trigger phrase a request would match> | `skills/<handbook_slug>/<slug>.dml` | `[]` |

Conventions:

- `args: []` runs the procedure against its embedded case; use `["mode", "..."]`
  when the skill documents extra modes.
- If the skill has a verification gate, do not claim success unless it passes.
- Detailed section → skill maps live in each handbook's
  `.pi/deepclause/skills/<handbook_slug>/INDEX.md`.
```

Rules for the table:

1. **`Handbook`** — the `<handbook_slug>` directory under `.pi/deepclause/skills/`.
2. **`Procedure / trigger`** — a short phrase in the *user's* wording ("payer
   overpayment", "denial triage", "temperature out of limit").
3. **`Skill`** — path relative to `.pi/deepclause/`; it must contain `/` so
   `dc_run` resolves it as a path, e.g. `skills/<handbook_slug>/<slug>.dml`.
4. **`Args`** — the exact `dc_run.args` array for the primary mode.
5. One row per procedure. List alternates in `INDEX.md`, not here.
6. Update the table in the same change that adds/removes a skill; tell the user
   to `/reload` if pi is already running.

The table also carries the **behavior contract**: call `dc_run`, report its
answer, never answer a mapped procedure from memory, and point at
`/dc-tool enable` when `dc_run` is off.

## Testing checklist

For each generated skill:

1. `/dc-run skills/<handbook_slug>/<slug>.dml --context=isolated --debug`
   — runs without errors; the verification gate (if any) reports pass.
2. Inspect phase has read tools only; action phase has write tools only; a
   forbidden action has no tool at all.
3. Every expressible hard rule is a Prolog predicate; the model only composes,
   formats, and reviews judgment calls.
4. Re-check the invalid-pattern table in `.pi/deepclause/AGENTS.md` (singleton
   variables, `~` vs `{}` interpolation, `Result.field` vs `get_dict/3`, `->`
   committing over generators, `answer/1` last, `:- dynamic` before
   `assertz/retract`).

`--context=isolated` keeps session text out of the run. The runtime still needs
a model selected.

## Reference shape

A typical procedure skill has: read tools for the inspection phase, write tools
for the action phase (no tool for a forbidden action), one deterministic
`compute_*`/`decide` predicate per expressible rule, and — only when there are
observable post-conditions — a `verify_state` gate and/or a `review_*` model
check.

For DML mechanics, look at the bundled example skills in a fresh workspace
(`example.dml`, `deep_research.dml`) and the authoring guide at
`.pi/deepclause/AGENTS.md`. Most handbook skills are smaller than a full
multi-tool procedure; start from the light template above.
