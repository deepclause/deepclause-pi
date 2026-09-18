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
      execute: (id: string, params: unknown, signal: unknown, update: unknown, ctx: unknown) => Promise<{ details: { success?: boolean; viewer?: string } }>;
    };
    const graph = await graphTool.execute("id", { view: "capabilities" }, undefined, undefined, ctx);
    expect(graph.details.success).toBe(true);
    expect(graph.details.viewer).toBeTruthy();
    await expect(access(graph.details.viewer!)).resolves.toBeUndefined();
  });
});
