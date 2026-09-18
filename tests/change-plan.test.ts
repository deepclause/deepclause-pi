import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assembleTasksDml, parseCheck, validatePlanSpec, type PlanningSnapshot } from "../src/planner.js";
import deepClauseExtension, { parsePlan } from "../src/index.js";

const SNAPSHOT: PlanningSnapshot = {
  model: "test/model",
  thinkingLevel: "medium",
  activeTools: ["read"],
  allTools: [{ name: "read", description: "Read", parameters: { type: "object" }, sourceInfo: { source: "core" } } as never],
  skillNames: [],
  contextFiles: [],
  existingSkills: [],
  existingPlans: [],
};

const SPEC = {
  slug: "add_dark_mode",
  title: "Add dark mode",
  objective: "Add a light/dark theme.",
  assumptions: [],
  steps: [
    {
      id: "1.1",
      title: "Add the toggle",
      instruction: "Add a theme toggle component.",
      executor: "pi",
      requiredTools: ["read"],
      relevantSkills: [],
      expectedResult: "The toggle switches themes.",
      satisfies: ["ui/theme#toggle"],
      checks: ["exists:src/toggle.tsx", "cmd:npm run typecheck"],
    },
  ],
  failureMessage: "Could not complete the change.",
};

describe("change-aware planning", () => {
  it("parses the --change flag", () => {
    expect(parsePlan("add dark mode --change=add_dark_mode")).toMatchObject({ request: "add dark mode", change: "add_dark_mode" });
    expect(() => parsePlan("x --change=")).toThrow("--change requires a non-empty slug");
  });

  it("parses --update and the leading update keyword", () => {
    expect(parsePlan("add aliases --change=custom --update")).toMatchObject({ request: "add aliases", change: "custom", update: true });
    expect(parsePlan("update --change=custom add aliases")).toMatchObject({ request: "add aliases", change: "custom", update: true });
    expect(parsePlan("update the login flow")).toMatchObject({ request: "update the login flow", update: false });
    expect(() => parsePlan("x --update")).toThrow("--update requires --change");
  });

  it("parses checks and rejects malformed ones", () => {
    expect(parseCheck("cmd:npm test")).toEqual({ kind: "cmd", value: "npm test" });
    expect(parseCheck("exists:src/x.ts")).toEqual({ kind: "exists", value: "src/x.ts" });
    expect(parseCheck("model:does it work?")).toEqual({ kind: "model", value: "does it work?" });
    expect(() => parseCheck("nonsense")).toThrow("Check must be");
    expect(() => parseCheck("other:x")).toThrow("Unknown check kind");
    expect(() => parseCheck("cmd:")).toThrow("empty value");
  });

  it("requires checks and carries satisfies into the plan", () => {
    const plan = validatePlanSpec(SPEC, SNAPSHOT, undefined, { requireChecks: true, change: "add_dark_mode" });
    expect(plan.spec.change).toBe("add_dark_mode");
    expect(plan.spec.steps[0]!.satisfies).toEqual(["ui/theme#toggle"]);
    expect(plan.spec.steps[0]!.checks).toEqual(["exists:src/toggle.tsx", "cmd:npm run typecheck"]);

    const missing = { ...SPEC, steps: [{ ...SPEC.steps[0]!, checks: [] }] };
    expect(() => validatePlanSpec(missing, SNAPSHOT, undefined, { requireChecks: true })).toThrow("must declare at least one verification check");
    // without requireChecks (standalone plans) empty checks are allowed
    expect(() => validatePlanSpec({ ...SPEC, steps: [{ ...SPEC.steps[0]!, checks: [] }] }, SNAPSHOT)).not.toThrow();
  });

  it("assembles tasks.dml facts with checks and a managed status block", () => {
    const plan = validatePlanSpec(SPEC, SNAPSHOT, undefined, { requireChecks: true, change: "add_dark_mode" });
    const tasks = assembleTasksDml(plan, SNAPSHOT);
    expect(tasks).toContain('plan_task("1.1", task{');
    expect(tasks).toContain('executor:  pi');
    expect(tasks).toContain('satisfies: ["ui/theme#toggle"]');
    expect(tasks).toContain('checks:    [exists("src/toggle.tsx"), cmd("npm run typecheck")]');
    expect(tasks).toContain("% --- execution state (managed by apply.dml; do not edit by hand) ---");
    expect(tasks).toContain('plan_task_status("1.1", pending).');
  });

  it("writes changes/<slug>/tasks.dml through /dc-plan --change and dc_plan_commit", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "dc-change-plan-"));
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const eventHandlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const tools = new Map<string, { execute: (id: string, params: unknown, signal: unknown, update: unknown, ctx: unknown) => Promise<{ content: Array<{ text: string }>; details: { success?: boolean; error?: string } }> }>();
    const notifications: string[] = [];
    let activeTools = ["read"];
    const pi = {
      registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, def); },
      registerTool(def: { name: string }) { tools.set(def.name, def as never); },
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { eventHandlers.set(name, handler); },
      getActiveTools: () => [...activeTools],
      getAllTools: () => [{ name: "read", description: "Read", parameters: { type: "object" }, sourceInfo: { source: "core" } }],
      setActiveTools(names: string[]) { activeTools = [...names]; },
      getThinkingLevel: () => "medium",
      sendMessage() {},
      sendUserMessage() {},
      async exec() { return { stdout: "", stderr: "", code: 0, killed: false }; },
    };
    const ctx = {
      cwd,
      model: { provider: "test", id: "model" },
      modelRegistry: { hasConfiguredAuth: () => true, async complete() { throw new Error("model must not be called"); } },
      sessionManager: { getBranch: () => [] },
      thinkingLevel: "medium",
      isIdle: () => true,
      hasUI: true,
      abort() {},
      getSystemPromptOptions: () => ({ cwd, contextFiles: [], skills: [] }),
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

    await commands.get("dc-plan")!.handler("add dark mode --change=add_dark_mode", ctx);
    expect(tools.has("dc_plan_commit")).toBe(true);

    const commit = tools.get("dc_plan_commit")!;
    const result = await commit.execute("id", SPEC, undefined, undefined, ctx);
    expect(result.details.success).toBe(true);

    const tasks = await readFile(path.join(cwd, ".pi", "deepclause", "changes", "add_dark_mode", "tasks.dml"), "utf8");
    expect(tasks).toContain('plan_task("1.1", task{');
    expect(tasks).toContain('cmd("npm run typecheck")');
    expect(tasks).toContain('plan_task_status("1.1", pending).');

    // a second commit is rejected (non-destructive)
    const again = await commit.execute("id", SPEC, undefined, undefined, ctx);
    expect(again.details.success).toBe(false);
  });
});

describe("change plan update", () => {
  it("fails early when tasks.dml exists and regenerates with --update", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "dc-change-update-"));
    const { initializeWorkspace } = await import("../src/workspace.js");
    const paths = await initializeWorkspace(cwd);
    await mkdir(path.join(paths.changes, "add_dark_mode"), { recursive: true });
    await writeFile(
      path.join(paths.changes, "add_dark_mode", "tasks.dml"),
      'plan_task("1.9", task{do:"old plan", checks:[exists("old")]}).\n% --- execution state (managed by apply.dml; do not edit by hand) ---\nplan_task_status("1.9", done(1)).\n',
    );

    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const eventHandlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const tools = new Map<string, { execute: (id: string, params: unknown, signal: unknown, update: unknown, ctx: unknown) => Promise<{ details: { success?: boolean } }> }>();
    const notifications: string[] = [];
    const userMessages: string[] = [];
    let activeTools = ["read"];
    const pi = {
      registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, def); },
      registerTool(def: { name: string }) { tools.set(def.name, def as never); },
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { eventHandlers.set(name, handler); },
      getActiveTools: () => [...activeTools],
      getAllTools: () => [{ name: "read", description: "Read", parameters: { type: "object" }, sourceInfo: { source: "core" } }],
      setActiveTools(names: string[]) { activeTools = [...names]; },
      getThinkingLevel: () => "medium",
      sendMessage() {},
      sendUserMessage(message: string) { userMessages.push(message); },
      async exec() { return { stdout: "", stderr: "", code: 0, killed: false }; },
    };
    const ctx = {
      cwd,
      model: { provider: "test", id: "model" },
      modelRegistry: { hasConfiguredAuth: () => true, async complete() { throw new Error("model must not be called"); } },
      sessionManager: { getBranch: () => [] },
      thinkingLevel: "medium",
      isIdle: () => true,
      hasUI: true,
      abort() {},
      getSystemPromptOptions: () => ({ cwd, contextFiles: [], skills: [] }),
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

    // without --update: fail before spending a planning turn
    await commands.get("dc-plan")!.handler("add dark mode --change=add_dark_mode", ctx);
    expect(userMessages).toHaveLength(0);
    expect(notifications.some((message) => message.includes("already exists"))).toBe(true);

    // with --update: start a planning turn
    await commands.get("dc-plan")!.handler("update --change=add_dark_mode add keyboard support", ctx);
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toContain("regenerates the change 'add_dark_mode'");
    expect(userMessages[0]).toContain("resets to pending");

    // committing overwrites and resets statuses
    const result = await tools.get("dc_plan_commit")!.execute("id", SPEC, undefined, undefined, ctx);
    expect(result.details.success).toBe(true);
    const tasks = await readFile(path.join(paths.changes, "add_dark_mode", "tasks.dml"), "utf8");
    expect(tasks).toContain('plan_task("1.1", task{');
    expect(tasks).not.toContain("1.9");
    expect(tasks).not.toContain("done(1)");
    expect(tasks).toContain('plan_task_status("1.1", pending).');
  });
});
