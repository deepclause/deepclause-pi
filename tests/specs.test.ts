import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDeepClause } from "deepclause-sdk";

const LIB_SOURCE = fileURLToPath(new URL("../src/assets/specs.dml", import.meta.url));

const VALID_SPEC = `---
capability: ui/theme
---

# Theme Specification

## Purpose
Lets users choose between light and dark themes.

## Requirements

### Requirement: Theme selection
The app SHALL let users switch between light and dark themes at runtime.

#### Scenario: User toggles dark mode
- **WHEN** the user clicks the theme toggle
- **THEN** the app switches to dark mode and persists the choice

### Requirement: System-preference default
The app SHALL default to the operating system preference.

#### Scenario: First run on a dark system
- **WHEN** the app starts with no stored theme and the OS reports dark
- **THEN** it renders dark without writing a stored choice
`;

const VALID_DELTA = `---
change: add_dark_mode
---

# Spec Delta

## ADDED Requirements

### Requirement: Theme toggle
The app SHALL show a theme toggle in the header.

#### Scenario: Toggle is visible
- **WHEN** the app renders the header
- **THEN** the theme toggle is present
`;

const BROKEN_SPEC = `# Broken Specification

## Requirements

### Requirement: Broken one
Some text.

### Scenario: Wrong depth
- **WHEN** something happens
- **THEN** something is wrong
`;

async function workspace(files: Record<string, string>): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "dc-specs-"));
  await mkdir(path.join(cwd, ".pi", "deepclause", "lib"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "deepclause", "lib", "specs.dml"), await readFile(LIB_SOURCE, "utf8"), "utf8");
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(cwd, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return cwd;
}

async function runLibrary(cwd: string, goal: string): Promise<{ answer: string; errors: string[] }> {
  const sdk = await createDeepClause({
    model: "spec-test",
    llmBackend: { async complete() { return { text: "unused" }; } },
  });
  try {
    const code = `:- consult('.pi/deepclause/lib/specs.dml').\n\nagent_main :-\n    ${goal}.\n`;
    const events = [];
    for await (const event of sdk.runDML(code, { workspacePath: cwd })) events.push(event);
    return {
      answer: events.find((event) => event.type === "answer")?.content ?? "",
      errors: events.filter((event) => event.type === "error").map((event) => event.content ?? ""),
    };
  } finally {
    await sdk.dispose();
  }
}

describe("deterministic spec engine", () => {
  it("parses and reports a clean workspace", async () => {
    const cwd = await workspace({
      ".pi/deepclause/specs/ui/theme.spec.md": VALID_SPEC,
      ".pi/deepclause/changes/add_dark_mode/specs/ui/theme.spec.md": VALID_DELTA,
    });
    const { answer, errors } = await runLibrary(cwd, "sp_check_all(Report), answer(Report)");
    expect(errors).toEqual([]);
    expect(answer).toContain("spec check: OK");
    expect(answer).toContain("(1 capabilities, 1 deltas, 0 errors)");
    expect(answer).toContain("spec ui/theme: 2 requirements, 2 scenarios");
    expect(answer).toContain("no structural errors");
  });

  it("flags a 3-hash scenario and an unmatched requirement", async () => {
    const cwd = await workspace({ ".pi/deepclause/specs/ui/broken.spec.md": BROKEN_SPEC });
    const { answer } = await runLibrary(cwd, "sp_check_all(Report), answer(Report)");
    expect(answer).toContain("spec check: FAILED");
    expect(answer).toContain("scenario heading must use #### (4 hashes), not ###");
    expect(answer).toContain("requirement 'Broken one' has no scenario");
  });

  it("reports status and queries a capability", async () => {
    const cwd = await workspace({
      ".pi/deepclause/specs/ui/theme.spec.md": VALID_SPEC,
      ".pi/deepclause/changes/add_dark_mode/specs/ui/theme.spec.md": VALID_DELTA,
    });
    const status = await runLibrary(cwd, "sp_status(Report), answer(Report)");
    expect(status.answer).toContain("capabilities: 1  (ui/theme)");
    expect(status.answer).toContain("active changes: 1");

    const query = await runLibrary(cwd, `sp_query("ui/theme", Report), answer(Report)`);
    expect(query.answer).toContain("capability ui/theme — Theme Specification");
    expect(query.answer).toContain("Theme selection  (1 scenarios)");
  });

  it("emits a capability graph and a change graph", async () => {
    const cwd = await workspace({
      ".pi/deepclause/specs/ui/theme.spec.md": VALID_SPEC,
      ".pi/deepclause/changes/add_dark_mode/specs/ui/theme.spec.md": VALID_DELTA,
    });
    const caps = await runLibrary(cwd, `sp_graph(capabilities, Mermaid), answer(Mermaid)`);
    expect(caps.answer).toContain("flowchart LR");
    expect(caps.answer).toContain("ui/theme — Theme Specification");
    expect(caps.answer).toContain("Requirement: Theme selection");
    expect(caps.answer).toContain("Scenario: User toggles dark mode");

    const changes = await runLibrary(cwd, `sp_graph(changes, Mermaid), answer(Mermaid)`);
    expect(changes.answer).toContain("flowchart LR");
    expect(changes.answer).toContain("add_dark_mode");
    expect(changes.answer).toContain("-- touches -->");

    // The runtime passes CLI arguments as strings; a string view must dispatch
    // like the atom rather than falling through to the capabilities catch-all.
    const stringView = await runLibrary(cwd, `sp_graph("changes", Mermaid), answer(Mermaid)`);
    expect(stringView.answer).toContain("flowchart LR");
    expect(stringView.answer).toContain("add_dark_mode");
    expect(stringView.answer).toContain("-- touches -->");
    expect(stringView.answer).not.toContain("no specs found");
  });

  it("dispatches a change graph from a string CLI view through the seeded skill", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "dc-graph-arg-"));
    const { initializeWorkspace } = await import("../src/workspace.js");
    const paths = await initializeWorkspace(cwd);
    await mkdir(path.join(paths.specs, "ui"), { recursive: true });
    await writeFile(path.join(paths.specs, "ui", "theme.spec.md"), VALID_SPEC, "utf8");
    await mkdir(path.join(paths.changes, "add_dark_mode", "specs", "ui"), { recursive: true });
    await writeFile(path.join(paths.changes, "add_dark_mode", "specs", "ui", "theme.spec.md"), VALID_DELTA, "utf8");

    const skill = await readFile(path.join(paths.skills, "spec_graph.dml"), "utf8");
    const sdk = await createDeepClause({
      model: "spec-test",
      llmBackend: { async complete() { return { text: "unused" }; } },
    });
    try {
      const events = [];
      for await (const event of sdk.runDML(skill, { workspacePath: cwd, args: ["changes"] })) events.push(event);
      const answer = events.find((event) => event.type === "answer")?.content ?? "";
      expect(answer).toContain("flowchart LR");
      expect(answer).toContain("add_dark_mode");
      expect(answer).toContain("-- touches -->");
      expect(answer).not.toContain("no specs found");
    } finally {
      await sdk.dispose();
    }
  });
});

describe("spec layer wiring", () => {
  it("seeds spec dirs, library and skills without overwriting", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "dc-seed-"));
    const { initializeWorkspace } = await import("../src/workspace.js");
    const paths = await initializeWorkspace(cwd);

    for (const relative of [
      "lib/specs.dml",
      "skills/spec_validate.dml",
      "skills/spec_status.dml",
      "skills/spec_query.dml",
      "skills/spec_graph.dml",
    ]) {
      const content = await readFile(path.join(paths.root, relative), "utf8");
      expect(content.length).toBeGreaterThan(0);
    }
    // re-running must not overwrite a user edit
    await writeFile(path.join(paths.lib, "specs.dml"), "% user edit\n", "utf8");
    await initializeWorkspace(cwd);
    expect(await readFile(path.join(paths.lib, "specs.dml"), "utf8")).toBe("% user edit\n");
  });

  it("registers /dc-check and dc_spec_graph and runs a check through the command", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "dc-cmd-"));
    const { initializeWorkspace } = await import("../src/workspace.js");
    const paths = await initializeWorkspace(cwd);
    await mkdir(path.join(paths.specs, "ui"), { recursive: true });
    await writeFile(path.join(paths.specs, "ui", "theme.spec.md"), VALID_SPEC, "utf8");

    const { default: deepClauseExtension } = await import("../src/index.js");
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const eventHandlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const tools = new Map<string, unknown>();
    const customMessages: Array<{ content: string }> = [];
    let activeTools = ["read", "bash"];
    const pi = {
      registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, def); },
      registerTool(def: { name: string }) { tools.set(def.name, def); },
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { eventHandlers.set(name, handler); },
      getActiveTools: () => [...activeTools],
      getAllTools: () => [],
      setActiveTools(names: string[]) { activeTools = [...names]; },
      getThinkingLevel: () => "medium",
      sendMessage(message: { content: string }) { customMessages.push(message); },
      sendUserMessage() {},
      async exec() { return { stdout: "", stderr: "", code: 0, killed: false }; },
    };
    const notifications: string[] = [];
    const ctx = {
      cwd,
      model: { provider: "test", id: "model" },
      modelRegistry: { hasConfiguredAuth: () => true, async complete() { throw new Error("model must not be called by /dc-check"); } },
      sessionManager: { getBranch: () => [] },
      thinkingLevel: "medium",
      isIdle: () => true,
      hasUI: true,
      abort() {},
      ui: {
        notify(message: string) { notifications.push(message); },
        async input() { return undefined; },
        async confirm() { return false; },
        setStatus() {},
        setWidget() {},
      },
    };
    deepClauseExtension(pi as never);
    await (eventHandlers.get("session_start") as (event: unknown, ctx: unknown) => Promise<unknown>)({}, ctx);

    expect(commands.has("dc-check")).toBe(true);
    expect(tools.has("dc_spec_graph")).toBe(true);
    expect(activeTools).toContain("dc_spec_graph");

    await commands.get("dc-check")!.handler("", ctx);
    expect(customMessages.at(-1)?.content).toContain("spec check: OK");
    expect(notifications.some((message) => message.includes("Spec check passed"))).toBe(true);

    const graphTool = tools.get("dc_spec_graph") as {
      execute: (id: string, params: unknown, signal: unknown, update: unknown, ctx: unknown) => Promise<{ details: { success?: boolean; viewer?: string; viewerPath?: string } }>;
    };
    const graph = await graphTool.execute("id", { view: "capabilities" }, undefined, undefined, ctx);
    expect(graph.details.success).toBe(true);
    expect(graph.details.viewer).toBeTruthy();
    // assert on the absolute path: the display path is workspace-relative and would
    // otherwise resolve against process.cwd() instead of the temp workspace
    expect(graph.details.viewerPath).toBeTruthy();
    await expect(access(graph.details.viewerPath!)).resolves.toBeUndefined();
  });
});

const BASE_SPEC = `# Theme Specification

## Purpose
Lets users choose a theme.

## Requirements

### Requirement: Theme selection
The app SHALL switch themes.

#### Scenario: Toggle
- **WHEN** the user toggles
- **THEN** the theme changes

### Requirement: Legacy theme
The app SHALL support the legacy theme.

#### Scenario: Legacy
- **WHEN** legacy is on
- **THEN** legacy renders

### Requirement: Theme switching
The app SHALL switch without reload.

#### Scenario: No reload
- **WHEN** toggling
- **THEN** no reload happens
`;

const MERGE_DELTA = `---
change: add_dark_mode
---

# Spec Delta

## Purpose
Lets users choose between light and dark themes.

## ADDED Requirements

### Requirement: System-preference default
The app SHALL default to the OS preference.

#### Scenario: First run
- **WHEN** no stored theme
- **THEN** the OS preference applies

## MODIFIED Requirements

### Requirement: Theme switching
The app SHALL switch themes immediately without a reload.

#### Scenario: No reload
- **WHEN** toggling
- **THEN** the visible theme updates in place

## REMOVED Requirements

### Requirement: Legacy theme
**Reason**: Replaced by runtime theming.
**Migration**: Use the theme toggle.

#### Scenario: Legacy
- **WHEN** legacy is on
- **THEN** legacy renders
`;

describe("spec merge and archive", () => {
  it("previews without writing, then applies and archives", async () => {
    const cwd = await workspace({
      ".pi/deepclause/specs/ui/theme.spec.md": BASE_SPEC,
      ".pi/deepclause/changes/add_dark_mode/specs/ui/theme.spec.md": MERGE_DELTA,
    });
    const specPath = path.join(cwd, ".pi", "deepclause", "specs", "ui", "theme.spec.md");

    const plan = await runLibrary(cwd, `sp_archive("add_dark_mode", plan, R), answer(R)`);
    expect(plan.errors).toEqual([]);
    expect(plan.answer).toContain("spec archive [plan (read-only)]: add_dark_mode");
    expect(plan.answer).toContain("ui/theme");
    // read-only: the spec is untouched
    expect(await readFile(specPath, "utf8")).toBe(BASE_SPEC);

    const apply = await runLibrary(cwd, `sp_archive("add_dark_mode", apply, R), answer(R)`);
    expect(apply.errors).toEqual([]);
    expect(apply.answer).toContain("spec archive [apply]: add_dark_mode");

    const merged = await readFile(specPath, "utf8");
    // MODIFIED requirement replaced
    expect(merged).toContain("The app SHALL switch themes immediately without a reload.");
    expect(merged).not.toContain("The app SHALL switch without reload.");
    // ADDED requirement appended
    expect(merged).toContain("System-preference default");
    expect(merged).toContain("- **WHEN** no stored theme");
    // REMOVED requirement dropped
    expect(merged).not.toContain("Legacy theme");
    // untouched requirement preserved line-for-line
    expect(merged).toContain("- **WHEN** the user toggles\n- **THEN** the theme changes");
    expect(merged).toContain("## Purpose\nLets users choose a theme.");

    // the skill writes specs/ but leaves the change folder for the /dc-archive command to move
    const stillThere = await runLibrary(cwd, `catch(directory_files(".pi/deepclause/changes/add_dark_mode", _), _, fail), answer("present")`);
    expect(stillThere.answer).toBe("present");
  });
});

describe("dc-archive command", () => {
  it("merges into specs/, moves the change folder, and confirms first", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "dc-archive-"));
    const { initializeWorkspace } = await import("../src/workspace.js");
    const paths = await initializeWorkspace(cwd);
    await mkdir(path.join(paths.specs, "ui"), { recursive: true });
    await writeFile(path.join(paths.specs, "ui", "theme.spec.md"), BASE_SPEC, "utf8");
    await mkdir(path.join(paths.changes, "add_dark_mode", "specs", "ui"), { recursive: true });
    await writeFile(path.join(paths.changes, "add_dark_mode", "specs", "ui", "theme.spec.md"), MERGE_DELTA, "utf8");

    const { default: deepClauseExtension } = await import("../src/index.js");
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const eventHandlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const tools = new Map<string, unknown>();
    const customMessages: Array<{ content: string }> = [];
    const notifications: string[] = [];
    let activeTools = ["read", "bash"];
    const pi = {
      registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, def); },
      registerTool(def: { name: string }) { tools.set(def.name, def); },
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { eventHandlers.set(name, handler); },
      getActiveTools: () => [...activeTools],
      getAllTools: () => [],
      setActiveTools(names: string[]) { activeTools = [...names]; },
      getThinkingLevel: () => "medium",
      sendMessage(message: { content: string }) { customMessages.push(message); },
      sendUserMessage() {},
      async exec() { return { stdout: "", stderr: "", code: 0, killed: false }; },
    };
    const ctx = {
      cwd,
      model: { provider: "test", id: "model" },
      modelRegistry: { hasConfiguredAuth: () => true, async complete() { throw new Error("model must not be called while archiving"); } },
      sessionManager: { getBranch: () => [] },
      thinkingLevel: "medium",
      isIdle: () => true,
      hasUI: true,
      abort() {},
      ui: {
        notify(message: string) { notifications.push(message); },
        async input() { return undefined; },
        async confirm() { return true; },
        setStatus() {},
        setWidget() {},
      },
    };
    deepClauseExtension(pi as never);
    await (eventHandlers.get("session_start") as (event: unknown, ctx: unknown) => Promise<unknown>)({}, ctx);

    await commands.get("dc-archive")!.handler("add_dark_mode", ctx);

    const last = customMessages.at(-1)?.content ?? "";
    expect(last).toContain("spec archive [apply]: add_dark_mode");
    expect(last).toContain("moved to");

    const merged = await readFile(path.join(paths.specs, "ui", "theme.spec.md"), "utf8");
    expect(merged).toContain("System-preference default");
    expect(merged).not.toContain("Legacy theme");

    await expect(access(path.join(paths.changes, "add_dark_mode"))).rejects.toThrow();
    const archiveEntries = await (await import("node:fs/promises")).readdir(path.join(paths.changes, "archive"));
    expect(archiveEntries.some((entry) => entry.endsWith("add_dark_mode"))).toBe(true);
  });
});

const COVERAGE_DELTA = `---
change: add_dark_mode
---

# Spec Delta

## ADDED Requirements

### Requirement: Theme selection
The app SHALL switch themes.

#### Scenario: User toggles dark mode
- **WHEN** the user toggles
- **THEN** the theme changes

#### Scenario: Invalid stored value is rejected
- **WHEN** a stored value is invalid
- **THEN** the system preference applies
`;

const TASKS_DML = `plan_task("1.1", task{
    executor:  pi,
    do:        "Add the toggle",
    tools:     ["read", "edit"],
    expected:  "The toggle switches themes.",
    satisfies: ["ui/theme#user-toggles-dark-mode"],
    checks:    [ exists("src/components/ThemeToggle.tsx") ]
}).

plan_task("1.2", task{
    executor:  pi,
    do:        "Handle invalid stored values",
    tools:     ["read", "edit"],
    expected:  "Invalid values fall back.",
    satisfies: [],
    checks:    []
}).
`;

describe("task coverage and scaffold", () => {
  it("reports uncovered scenarios and missing checks, and scaffolds tasks", async () => {
    const cwd = await workspace({
      ".pi/deepclause/changes/add_dark_mode/specs/ui/theme.spec.md": COVERAGE_DELTA,
      ".pi/deepclause/changes/add_dark_mode/tasks.dml": TASKS_DML,
    });

    const coverage = await runLibrary(
      cwd,
      `atomic_list_concat([".pi/deepclause/changes/", "add_dark_mode"], Dir), sp_coverage(Dir, Scenarios, Tasks, Uncovered, NoCheck, Orphan), format(string(M), "S=~w|T=~w|U=~w|N=~w|O=~w", [Scenarios, Tasks, Uncovered, NoCheck, Orphan]), answer(M)`,
    );
    expect(coverage.errors).toEqual([]);
    expect(coverage.answer).toContain("ui/theme#user-toggles-dark-mode");
    expect(coverage.answer).toContain("ui/theme#invalid-stored-value-is-rejected");
    expect(coverage.answer).toContain("U=[ui/theme#invalid-stored-value-is-rejected]");
    expect(coverage.answer).toContain("N=[1.2]");

    const check = await runLibrary(cwd, "sp_check_all(R), answer(R)");
    expect(check.answer).toContain("spec check: FAILED");
    expect(check.answer).toContain("coverage add_dark_mode: 1/2 scenarios covered, 2 tasks, 1 without checks");
    expect(check.answer).toContain("no task satisfies scenario ui/theme#invalid-stored-value-is-rejected");
    expect(check.answer).toContain("task 1.2 declares no verification check");

    const scaffold = await runLibrary(cwd, `sp_scaffold("add_dark_mode", D), answer(D)`);
    expect(scaffold.errors).toEqual([]);
    expect(scaffold.answer).toContain('plan_task("1.1", task{');
    expect(scaffold.answer).toContain('satisfies: ["ui/theme#user-toggles-dark-mode"]');
    expect(scaffold.answer).toContain('satisfies: ["ui/theme#invalid-stored-value-is-rejected"]');
  });
});

const BAD_TARGET_DELTA = `---
change: c
---

# Spec Delta

## MODIFIED Requirements

### Requirement: Nonexistent
The app SHALL do something that is not in the spec.

#### Scenario: Missing
- **WHEN** a
- **THEN** b
`;

describe("merge guard", () => {
  it("refuses MODIFIED/REMOVED that do not exist in the target spec", async () => {
    const cwd = await workspace({
      ".pi/deepclause/specs/ui/theme.spec.md": BASE_SPEC,
      ".pi/deepclause/changes/c/specs/ui/theme.spec.md": BAD_TARGET_DELTA,
    });
    const specPath = path.join(cwd, ".pi", "deepclause", "specs", "ui", "theme.spec.md");

    const plan = await runLibrary(cwd, `sp_archive("c", plan, R), answer(R)`);
    expect(plan.errors).toEqual([]);
    expect(plan.answer).toContain("MODIFIED/REMOVED requirements not found in the target spec: Nonexistent");

    const apply = await runLibrary(cwd, `sp_archive("c", apply, R), answer(R)`);
    expect(apply.answer).toContain("MODIFIED/REMOVED requirements not found");
    // nothing was written
    expect(await readFile(specPath, "utf8")).toBe(BASE_SPEC);
  });

  it("refuses MODIFIED for a brand-new capability", async () => {
    const cwd = await workspace({
      ".pi/deepclause/changes/newbie/specs/ui/newbie.spec.md": BAD_TARGET_DELTA,
    });
    const plan = await runLibrary(cwd, `sp_archive("newbie", plan, R), answer(R)`);
    expect(plan.answer).toContain("only ## ADDED Requirements is allowed for a new capability");
  });
});
