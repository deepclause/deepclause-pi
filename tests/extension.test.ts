import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDeepClause } from "deepclause-sdk";
import type { LLMBackend } from "deepclause-sdk";
import { buildInitialMessages } from "../src/context.js";
import deepClauseExtension, { parsePlan, parseRun, splitArguments } from "../src/index.js";
import { registerPiRuntimeTools } from "../src/runtime.js";
import { EXAMPLE_DML, initializeWorkspace, resolveDmlPath } from "../src/workspace.js";
import { assemblePlanDml, readPlanRequiredTools, validateGeneratedPlan, validatePlanSpec, type PlanningSnapshot } from "../src/planner.js";

describe("DeepClause pi extension helpers", () => {
  function extensionHarness(cwd: string) {
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const eventHandlers = new Map<string, (event: unknown, ctx: any) => unknown>();
    const tools = new Map<string, any>();
    let activeTools = ["read", "bash"];
    const sentUserMessages: string[] = [];
    const customMessages: Array<{ content: string; details?: unknown }> = [];
    let abortCalls = 0;
    const pi = {
      registerCommand(name: string, definition: { handler: (args: string, ctx: any) => Promise<void> }) {
        commands.set(name, definition);
      },
      registerTool(definition: { name: string }) {
        tools.set(definition.name, definition);
      },
      on(name: string, handler: (event: unknown, ctx: any) => unknown) {
        eventHandlers.set(name, handler);
      },
      getActiveTools: () => [...activeTools],
      getAllTools: () => [
        { name: "read", description: "Read files", parameters: { type: "object" }, sourceInfo: { source: "core" } },
        { name: "bash", description: "Run commands", parameters: { type: "object" }, sourceInfo: { source: "core" } },
        ...[...tools.values()].map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          promptGuidelines: tool.promptGuidelines,
          sourceInfo: { source: "extension" },
        })),
      ],
      setActiveTools(names: string[]) {
        activeTools = [...names];
      },
      getThinkingLevel: () => "medium",
      sendUserMessage(content: string) { sentUserMessages.push(content); },
      sendMessage(message: { content: string; details?: unknown }) { customMessages.push(message); },
      async exec() {
        return { stdout: "", stderr: "", code: 0, killed: false };
      },
    };
    const notifications: string[] = [];
    const ctx = {
      cwd,
      model: { provider: "test", id: "model" },
      modelRegistry: {
        hasConfiguredAuth: () => true,
        async complete() { throw new Error("Model completion was not expected"); },
      },
      sessionManager: { getBranch: () => [] },
      thinkingLevel: "medium",
      isIdle: () => true,
      getSystemPrompt: () => "test system prompt",
      getSystemPromptOptions: () => ({
        cwd,
        contextFiles: [{ path: "AGENTS.md", content: "instructions" }],
        skills: [{ name: "test-skill", description: "test" }],
      }),
      hasUI: true,
      abort() { abortCalls++; },
      ui: {
        notify(message: string) { notifications.push(message); },
        async input() { return undefined; },
        async confirm() { return false; },
        setStatus() {},
        setWidget() {},
      },
    };
    deepClauseExtension(pi as any);
    return {
      commands,
      eventHandlers,
      tools,
      pi,
      ctx,
      notifications,
      sentUserMessages,
      customMessages,
      abortCalls: () => abortCalls,
      activeTools: () => activeTools,
    };
  }

  it("parses quoted slash-command arguments", () => {
    expect(splitArguments(`review "two words" 'three words'`)).toEqual([
      "review",
      "two words",
      "three words",
    ]);
  });

  it("parses context and diagnostics flags without passing them to DML", () => {
    expect(parseRun(`example "topic with spaces" --context=branch --debug`)).toEqual({
      target: "example",
      args: ["topic with spaces"],
      contextMode: "branch",
      verbose: true,
      debug: true,
    });
    expect(parseRun("example -v")).toMatchObject({ verbose: true, debug: false });
  });

  it("parses contextual plan requests and filename overrides", () => {
    expect(parsePlan(`migrate the project to ESM --name="esm migration" --debug`)).toMatchObject({
      request: "migrate the project to ESM",
      name: "esm migration",
      debug: true,
    });
  });

  it("validates and assembles contextual DML plans", async () => {
    const snapshot: PlanningSnapshot = {
      model: "test/model",
      thinkingLevel: "medium",
      activeTools: ["read", "bash"],
      allTools: [
        { name: "read", description: "Read", parameters: { type: "object" }, sourceInfo: { source: "core" } } as any,
        { name: "bash", description: "Bash", parameters: { type: "object" }, sourceInfo: { source: "core" } } as any,
      ],
      skillNames: ["repo-review"],
      contextFiles: ["AGENTS.md"],
      existingSkills: [],
      existingPlans: [],
    };
    const plan = validatePlanSpec({
      slug: "esm migration",
      title: "ESM migration",
      objective: "Migrate safely",
      assumptions: [],
      steps: [
        {
          id: "inspect",
          title: "Inspect repository",
          instruction: "Inspect the repository and identify module boundaries.",
          executor: "pi",
          requiredTools: ["read"],
          relevantSkills: ["repo-review"],
          expectedResult: "A concrete migration map",
        },
        {
          id: "review",
          title: "Review results",
          instruction: "Review the migration map for omissions.",
          executor: "dml",
          requiredTools: [],
          relevantSkills: [],
          expectedResult: "A concise review",
        },
      ],
      finalSynthesis: "Summarize the completed migration plan.",
      failureMessage: "The migration plan failed.",
    }, snapshot);
    const dml = assemblePlanDml(plan, snapshot);
    expect(dml).toContain("exec(pi_agent_step(");
    expect(dml).toContain("task(\"Review the migration map");
    expect(dml).toContain("Step1Summary \\= \"\"");
    expect(dml).not.toContain("Step1Summary = \"\"");
    await expect(validateGeneratedPlan(dml)).resolves.toBeUndefined();
  });

  it("rejects inactive and recursive tools in contextual plan specifications", () => {
    const snapshot: PlanningSnapshot = {
      model: "test/model",
      thinkingLevel: "medium",
      activeTools: ["read"],
      allTools: [
        { name: "read", description: "Read", parameters: { type: "object" }, sourceInfo: { source: "core" } } as any,
        { name: "bash", description: "Bash", parameters: { type: "object" }, sourceInfo: { source: "core" } } as any,
        { name: "dc_run", description: "DeepClause", parameters: { type: "object" }, sourceInfo: { source: "extension" } } as any,
      ],
      skillNames: [],
      contextFiles: [],
      existingSkills: [],
      existingPlans: [],
    };
    const spec = (requiredTools: string[]) => ({
      slug: "unsafe",
      title: "Unsafe",
      objective: "Test rejection",
      assumptions: [],
      steps: [{
        id: "step",
        title: "Step",
        instruction: "Perform the step.",
        executor: "pi",
        requiredTools,
        relevantSkills: [],
        expectedResult: "A result",
      }],
      failureMessage: "Failed.",
    });
    expect(() => validatePlanSpec(spec(["bash"]), snapshot)).toThrow("inactive pi tool bash");
    expect(() => validatePlanSpec(spec(["dc_run"]), snapshot)).toThrow("recursive control tool dc_run");
  });

  it("creates a plan through a pi-native planning turn and commit tool", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "deepclause-pi-plan-"));
    const harness = extensionHarness(cwd);
    harness.ctx.ui.confirm = async () => true;
    await harness.commands.get("dc-plan")!.handler("inspect this repository --name=repo-plan", harness.ctx);
    expect(harness.sentUserMessages).toHaveLength(1);
    expect(harness.sentUserMessages[0]).toContain("test-skill");
    expect(harness.activeTools()).toContain("dc_plan_commit");

    const result = await harness.tools.get("dc_plan_commit").execute(
      "commit-1",
      {
        slug: "ignored",
        title: "Repository inspection",
        objective: "Inspect the repository using pi context",
        assumptions: [],
        steps: [{
          id: "inspect",
          title: "Inspect repository",
          instruction: "Inspect project instructions and source files, then report findings.",
          executor: "pi",
          requiredTools: ["read"],
          relevantSkills: ["test-skill"],
          expectedResult: "Files, constraints, and findings",
        }],
        finalSynthesis: "Summarize the inspection.",
        failureMessage: "Repository inspection failed.",
      },
      new AbortController().signal,
      undefined,
      harness.ctx,
    );
    expect(result.details).toMatchObject({ success: true, path: "plans/repo_plan.dml", contextual: true });
    expect(await readFile(path.join(cwd, ".pi", "deepclause", "plans", "repo_plan.dml"), "utf8")).toContain("pi_agent_step");
    expect(harness.activeTools()).not.toContain("dc_plan_commit");
  });

  it("executes a contextual plan step through pi and restores active tools", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "deepclause-pi-plan-run-"));
    const harness = extensionHarness(cwd);
    harness.ctx.ui.confirm = async () => true;
    const paths = await initializeWorkspace(cwd);
    const snapshot: PlanningSnapshot = {
      model: "test/model",
      thinkingLevel: "medium",
      activeTools: ["read", "bash"],
      allTools: harness.pi.getAllTools() as any,
      skillNames: ["test-skill"],
      contextFiles: ["AGENTS.md"],
      existingSkills: [],
      existingPlans: [],
    };
    const plan = validatePlanSpec({
      slug: "contextual-run",
      title: "Contextual run",
      objective: "Delegate one bounded step",
      assumptions: [],
      steps: [{
        id: "inspect",
        title: "Inspect",
        instruction: "Inspect the relevant files.",
        executor: "pi",
        requiredTools: ["read"],
        relevantSkills: ["test-skill"],
        expectedResult: "A concise inspection summary",
      }],
      failureMessage: "Inspection failed.",
    }, snapshot);
    await writeFile(path.join(paths.plans, "contextual_run.dml"), assemblePlanDml(plan, snapshot), "utf8");
    expect(await readPlanRequiredTools(path.join(paths.plans, "contextual_run.dml"))).toEqual(["read"]);

    let notifyStepStarted!: () => void;
    const stepStarted = new Promise<void>((resolve) => { notifyStepStarted = resolve; });
    harness.pi.sendUserMessage = (content: string) => {
      harness.sentUserMessages.push(content);
      notifyStepStarted();
    };
    const running = harness.commands.get("dc-run")!.handler("plans/contextual_run.dml --context=isolated", harness.ctx);
    await stepStarted;
    expect(harness.sentUserMessages[0]).toContain("Inspect the relevant files");
    expect(harness.sentUserMessages[0]).toContain("Internal correlation: dc-step-");
    expect(harness.activeTools()).toEqual(["read"]);
    harness.eventHandlers.get("agent_end")!({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "Inspected src and found no issues." }] }],
    }, harness.ctx);
    harness.eventHandlers.get("agent_settled")!({ type: "agent_settled" }, harness.ctx);
    await running;

    expect(harness.activeTools()).toEqual(["read", "bash"]);
    expect(harness.customMessages.at(-1)).toMatchObject({ content: expect.stringContaining("Inspected src and found no issues") });
  });

  it("allows a delegated step to recover from an intermediate pi tool failure", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "deepclause-pi-plan-recovery-"));
    const harness = extensionHarness(cwd);
    harness.ctx.ui.confirm = async () => true;
    const paths = await initializeWorkspace(cwd);
    await writeFile(path.join(paths.plans, "recovery.dml"), `
% Required pi tools: bash, read
agent_main :-
    exec(pi_agent_step(
        instruction: "Inspect the workspace and recover from non-fatal command errors.",
        tools: ["bash", "read"],
        expected: "A final inspection summary",
        skills: []
    ), Summary),
    answer(Summary).
`, "utf8");

    let notifyStepStarted!: () => void;
    const stepStarted = new Promise<void>((resolve) => { notifyStepStarted = resolve; });
    harness.pi.sendUserMessage = (content: string) => {
      harness.sentUserMessages.push(content);
      notifyStepStarted();
    };
    const running = harness.commands.get("dc-run")!.handler("plans/recovery.dml", harness.ctx);
    await stepStarted;
    harness.eventHandlers.get("tool_execution_end")!({
      type: "tool_execution_end",
      toolName: "bash",
      isError: true,
    }, harness.ctx);
    harness.eventHandlers.get("agent_end")!({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "Recovered and completed the inspection." }] }],
    }, harness.ctx);
    harness.eventHandlers.get("agent_settled")!({ type: "agent_settled" }, harness.ctx);
    await running;

    expect(harness.activeTools()).toEqual(["read", "bash"]);
    expect(harness.customMessages.at(-1)?.content).toContain("Recovered and completed the inspection.");
  });

  it("fails contextual plan preflight when a required pi tool is inactive", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "deepclause-pi-plan-preflight-"));
    const harness = extensionHarness(cwd);
    harness.ctx.ui.confirm = async () => true;
    const paths = await initializeWorkspace(cwd);
    await writeFile(path.join(paths.plans, "needs_bash.dml"), `
% Required pi tools: bash
agent_main :-
    exec(pi_agent_step(instruction: "Inspect", tools: ["bash"], expected: "Summary", skills: []), Summary),
    answer(Summary).
`, "utf8");
    harness.pi.setActiveTools(["read"]);
    await harness.commands.get("dc-run")!.handler("plans/needs_bash.dml", harness.ctx);
    expect(harness.customMessages.at(-1)?.content).toContain("requires inactive pi tools: bash");
    expect(harness.sentUserMessages).toHaveLength(0);
  });

  it("cancels a delegated pi plan step and restores active tools", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "deepclause-pi-plan-cancel-"));
    const harness = extensionHarness(cwd);
    harness.ctx.ui.confirm = async () => true;
    const paths = await initializeWorkspace(cwd);
    await writeFile(path.join(paths.plans, "cancel.dml"), `
% Required pi tools: read
agent_main :-
    exec(pi_agent_step(instruction: "Wait for cancellation", tools: ["read"], expected: "Summary", skills: []), Summary),
    answer(Summary).
agent_main :- answer("Cancelled fallback").
`, "utf8");
    let notifyStepStarted!: () => void;
    const stepStarted = new Promise<void>((resolve) => { notifyStepStarted = resolve; });
    harness.pi.sendUserMessage = (content: string) => {
      harness.sentUserMessages.push(content);
      notifyStepStarted();
    };
    const running = harness.commands.get("dc-run")!.handler("plans/cancel.dml", harness.ctx);
    await stepStarted;
    expect(harness.activeTools()).toEqual(["read"]);
    await harness.commands.get("dc-cancel")!.handler("", harness.ctx);
    await running;
    expect(harness.abortCalls()).toBe(1);
    expect(harness.activeTools()).toEqual(["read", "bash"]);
  });

  it("builds isolated, turn, and bounded branch context", () => {
    const entries = [
      { type: "message", message: { role: "user", content: "old" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } },
      { type: "message", message: { role: "user", content: "current" } },
    ];
    expect(buildInitialMessages(entries, "isolated", 10)).toEqual([]);
    expect(buildInitialMessages(entries, "turn", 10).map((message) => message.content)).toEqual(["reply", "current"]);
    expect(buildInitialMessages(entries, "branch", 2).map((message) => message.content)).toEqual(["reply", "current"]);
  });

  it("initializes non-destructively without creating .deepclause", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "deepclause-pi-"));
    const paths = await initializeWorkspace(cwd);
    const seededGuide = await readFile(paths.agents, "utf8");
    await writeFile(paths.agents, "user-owned\n", "utf8");
    await initializeWorkspace(cwd);

    expect(seededGuide).toContain("deterministic workflow with probabilistic leaves");
    expect(seededGuide).toContain("Applications enabled by DML in pi");
    expect(seededGuide).toContain("pi_bash(Executable, Args)");
    expect(await readFile(paths.agents, "utf8")).toBe("user-owned\n");
    await expect(readFile(path.join(cwd, ".deepclause", "config.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(paths.skills, "example.dml"), "utf8")).toContain("agent_main");
    expect(await readFile(path.join(paths.skills, "deep_research.dml"), "utf8")).toContain('pi_bash("curl", CurlArgs)');
    expect(JSON.parse(await readFile(paths.config, "utf8"))).toMatchObject({ modelToolEnabled: false });
  });

  it("keeps dc_run disabled by default and toggles it per workspace", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "deepclause-pi-tool-"));
    const harness = extensionHarness(cwd);

    await harness.eventHandlers.get("session_start")?.({}, harness.ctx);
    expect(harness.tools.has("dc_run")).toBe(false);
    expect(harness.activeTools()).not.toContain("dc_run");

    await harness.commands.get("dc-tool")?.handler("enable", harness.ctx);
    expect(harness.tools.has("dc_run")).toBe(true);
    expect(harness.activeTools()).toContain("dc_run");
    expect(JSON.parse(await readFile(path.join(cwd, ".pi", "deepclause", "config.json"), "utf8"))).toMatchObject({
      modelToolEnabled: true,
    });

    const restarted = extensionHarness(cwd);
    await restarted.eventHandlers.get("session_start")?.({}, restarted.ctx);
    expect(restarted.tools.has("dc_run")).toBe(true);
    expect(restarted.activeTools()).toContain("dc_run");

    const skillPath = path.join(cwd, ".pi", "deepclause", "skills", "tool_test.dml");
    await writeFile(skillPath, 'agent_main(Name) :- format(string(Result), "Hello, ~w", [Name]), answer(Result).\n', "utf8");
    const result = await harness.tools.get("dc_run").execute(
      "call-1",
      { skill: "tool_test", args: ["Pi"], context: "isolated" },
      new AbortController().signal,
      undefined,
      harness.ctx,
    );
    expect(result.content[0].text).toBe("Hello, Pi");
    expect(result.details).toMatchObject({ success: true, skill: "skills/tool_test.dml", contextMode: "isolated" });

    await harness.commands.get("dc-tool")?.handler("disable", harness.ctx);
    expect(harness.activeTools()).not.toContain("dc_run");
    expect(JSON.parse(await readFile(path.join(cwd, ".pi", "deepclause", "config.json"), "utf8"))).toMatchObject({
      modelToolEnabled: false,
    });
    const disabledResult = await harness.tools.get("dc_run").execute(
      "call-disabled",
      { skill: "tool_test" },
      new AbortController().signal,
      undefined,
      harness.ctx,
    );
    expect(disabledResult.details).toMatchObject({ success: false, error: "tool_disabled" });
  });

  it("prevents model-callable dc_run from starting contextual plans", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "deepclause-pi-contextual-tool-"));
    const harness = extensionHarness(cwd);
    await harness.commands.get("dc-tool")?.handler("enable", harness.ctx);
    const paths = await initializeWorkspace(cwd);
    await writeFile(path.join(paths.plans, "interactive.dml"), `
      agent_main :-
        exec(pi_agent_step(instruction: "Inspect", tools: [], expected: "Summary", skills: []), Summary),
        answer(Summary).
    `, "utf8");
    const result = await harness.tools.get("dc_run").execute(
      "call-contextual",
      { skill: "plans/interactive.dml", context: "isolated" },
      new AbortController().signal,
      undefined,
      harness.ctx,
    );
    expect(result.details).toMatchObject({ success: false, error: "interactive_plan_requires_user_run" });
    expect(harness.sentUserMessages).toHaveLength(0);
  });

  it("rejects a concurrent dc_run execution", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "deepclause-pi-tool-concurrency-"));
    const harness = extensionHarness(cwd);
    await harness.commands.get("dc-tool")?.handler("enable", harness.ctx);
    const skillPath = path.join(cwd, ".pi", "deepclause", "skills", "wait.dml");
    await writeFile(skillPath, `
      agent_main :-
        exec(pi_workspace_list("."), _Result),
        answer("continued").
    `, "utf8");

    let releaseExec!: (value: { stdout: string; stderr: string; code: number; killed: boolean }) => void;
    const execRequested = new Promise<void>((resolve) => {
      harness.pi.exec = () => new Promise((release) => {
        releaseExec = release;
        resolve();
      });
    });
    const tool = harness.tools.get("dc_run");
    const first = tool.execute("call-1", { skill: "wait" }, new AbortController().signal, undefined, harness.ctx);
    await execRequested;
    const second = await tool.execute("call-2", { skill: "wait" }, new AbortController().signal, undefined, harness.ctx);
    expect(second.details).toMatchObject({ success: false, error: "execution_already_active" });
    releaseExec({ stdout: "", stderr: "", code: 0, killed: false });
    expect((await first).content[0].text).toBe("continued");
  });

  it("rejects traversal and symlink escapes", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "deepclause-pi-"));
    const paths = await initializeWorkspace(cwd);
    const outside = path.join(cwd, "outside.dml");
    await writeFile(outside, "agent_main.\n", "utf8");
    await symlink(outside, path.join(paths.skills, "escape.dml"));

    await expect(resolveDmlPath(paths, "../outside.dml")).rejects.toThrow("escapes");
    await expect(resolveDmlPath(paths, "escape")).rejects.toThrow("symlink");
  });

  it("runs the seeded example through the host model backend", async () => {
    const execCalls: Array<{ command: string; args: string[] }> = [];
    const backend: LLMBackend = {
      async complete(request) {
        expect(request.messages.some((message) =>
          message.content.includes("X=6")
            && message.content.includes("Y=8")
            && message.content.includes("2 top-level entries")
            && message.content.includes("bash bridge cwd="),
        )).toBe(true);
        return {
          text: "",
          toolCalls: [
            {
              id: "result-1",
              name: "set_result",
              arguments: { variable: "Explanation", value: "Six plus eight is fourteen. Six times eight is forty-eight." },
            },
            { id: "finish-1", name: "finish", arguments: { success: true } },
          ],
          usage: { inputTokens: 20, outputTokens: 12, totalTokens: 32 },
        };
      },
    };
    const sdk = await createDeepClause({ model: "pi-test-model", llmBackend: backend });
    try {
      registerPiRuntimeTools(sdk, {
        async exec(command, args) {
          execCalls.push({ command, args });
          return command === "find"
            ? { stdout: "alpha.txt\nsrc\n", stderr: "", code: 0, killed: false }
            : { stdout: `bash bridge cwd=${process.cwd()}`, stderr: "", code: 0, killed: false };
        },
      }, process.cwd(), new AbortController().signal, async (command) => {
        expect(command).toContain("bash bridge cwd");
        return true;
      });
      const events = [];
      for await (const event of sdk.runDML(EXAMPLE_DML, { workspacePath: process.cwd() })) events.push(event);
      expect(events.filter((event) => event.type === "output").map((event) => event.content)).toEqual([
        "Phase 1/4: solving X + Y = 14 and X * Y = 48 with CLP(FD)...",
        "The deterministic solution is X=6 and Y=8.",
        "Phase 2/4: listing the active workspace through pi_workspace_list...",
        "pi.exec returned 2 top-level workspace entries: [alpha.txt,src]",
        "Phase 3/4: requesting an approved bash command through pi_bash...",
        `bash bridge cwd=${process.cwd()}`,
        "Phase 4/4: asking pi's active model for a concise explanation...",
      ]);
      expect(execCalls).toHaveLength(2);
      expect(execCalls[0]?.command).toBe("find");
      expect(execCalls[1]?.command).toBe("bash");
      expect(execCalls[1]?.args).toEqual(["-lc", `printf 'bash bridge cwd=%s' "$PWD"`]);
      expect(events.some((event) => event.type === "tool_call" && event.toolName === "pi_workspace_list" && event.toolState === "completed")).toBe(true);
      expect(events.some((event) => event.type === "tool_call" && event.toolName === "pi_bash" && event.toolState === "completed")).toBe(true);
      expect(events.find((event) => event.type === "answer")?.content).toContain("Six plus eight is fourteen");
      expect(events.some((event) => event.type === "task_activity" && event.taskState === "completed")).toBe(true);
      expect(events.some((event) => event.type === "usage")).toBe(true);
    } finally {
      await sdk.dispose();
    }
  });

  it("does not execute an unapproved pi_bash command", async () => {
    let executed = false;
    const sdk = await createDeepClause({
      model: "pi-test-model",
      llmBackend: { async complete() { return { text: "unused" }; } },
    });
    try {
      registerPiRuntimeTools(sdk, {
        async exec() {
          executed = true;
          return { stdout: "", stderr: "", code: 0, killed: false };
        },
      }, process.cwd(), new AbortController().signal, async () => false);

      const events = [];
      for await (const event of sdk.runDML(`
        agent_main :-
          exec(pi_bash("echo forbidden"), _Result),
          answer("unexpected").
      `)) events.push(event);

      expect(executed).toBe(false);
      expect(events.some((event) =>
        event.type === "tool_call"
          && event.toolName === "pi_bash"
          && event.toolState === "failed"
          && event.toolError?.includes("not approved"),
      )).toBe(true);
      expect(events.some((event) => event.type === "answer")).toBe(false);
    } finally {
      await sdk.dispose();
    }
  });

  it("runs deep research using only approved curl requests to Bing", async () => {
    const dml = await readFile(new URL("../src/assets/deep_research.dml", import.meta.url), "utf8");
    const executed: Array<{ command: string; args: string[] }> = [];
    const approvals: string[] = [];
    let feedbackRequested = false;
    let searchesRequested = false;
    const backend: LLMBackend = {
      async complete(request) {
        const system = request.messages.find((message) => message.role === "system")?.content ?? "";
        if (system.includes("Query1") && system.includes("Query2") && system.includes("Query3") && !system.includes("ApprovedQuery1")) {
          return {
            text: "",
            toolCalls: [
              { id: "q1", name: "set_result", arguments: { variable: "Query1", value: "small language models overview" } },
              { id: "q2", name: "set_result", arguments: { variable: "Query2", value: "small language models benchmarks 2026" } },
              { id: "q3", name: "set_result", arguments: { variable: "Query3", value: "small language models limitations" } },
              { id: "done-plan", name: "finish", arguments: { success: true } },
            ],
          };
        }
        if (system.includes("ApprovedQuery1") && system.includes("ApprovedQuery2") && system.includes("ApprovedQuery3")) {
          expect(request.tools?.some((tool) => tool.name === "user_feedback")).toBe(true);
          if (!feedbackRequested) {
            feedbackRequested = true;
            return {
              text: "",
              toolCalls: [{
                id: "feedback",
                name: "user_feedback",
                arguments: { Prompt: "Review the three-query plan. Type 'approve' or suggest changes." },
              }],
            };
          }
          return {
            text: "",
            toolCalls: [
              { id: "approved-q1", name: "set_result", arguments: { variable: "ApprovedQuery1", value: "site:gov small language models overview" } },
              { id: "approved-q2", name: "set_result", arguments: { variable: "ApprovedQuery2", value: "site:edu small language models benchmarks 2026" } },
              { id: "approved-q3", name: "set_result", arguments: { variable: "ApprovedQuery3", value: "site:edu small language models limitations" } },
              { id: "done-revision", name: "finish", arguments: { success: true } },
            ],
          };
        }
        expect(request.tools?.some((tool) => tool.name === "bing_search")).toBe(true);
        if (!searchesRequested) {
          searchesRequested = true;
          return {
            text: "",
            toolCalls: [
              { id: "search-1", name: "bing_search", arguments: { Query: "site:gov small language models overview" } },
              { id: "search-2", name: "bing_search", arguments: { Query: "site:edu small language models benchmarks 2026" } },
              { id: "search-3", name: "bing_search", arguments: { Query: "site:edu small language models limitations" } },
            ],
          };
        }
        expect(request.messages.some((message) => message.content.includes("Bing result for"))).toBe(true);
        return {
          text: "",
          toolCalls: [
            { id: "report", name: "set_result", arguments: { variable: "Report", value: "# Report\n\nFinding [1].\n\n## Sources\n1. https://example.com/source" } },
            { id: "done-report", name: "finish", arguments: { success: true } },
          ],
        };
      },
    };
    const sdk = await createDeepClause({ model: "pi-test-model", llmBackend: backend });
    try {
      registerPiRuntimeTools(sdk, {
        async exec(command, args) {
          executed.push({ command, args });
          const queryArg = args[args.indexOf("--data-urlencode") + 1] ?? "q=unknown";
          return {
            stdout: `<rss><channel><item><title>Bing result for ${queryArg}</title><link>https://example.com/source</link><description>Evidence snippet</description></item></channel></rss>`,
            stderr: "",
            code: 0,
            killed: false,
          };
        },
      }, process.cwd(), new AbortController().signal, async (display) => {
        approvals.push(display);
        return true;
      });
      sdk.setToolPolicy({ mode: "whitelist", tools: ["pi_workspace_list", "pi_bash"] });

      const events = [];
      for await (const event of sdk.runDML(dml, {
        args: ["Practical impacts of small language models"],
        onUserInput: async (prompt) => {
          expect(prompt).toContain("Bing searches:");
          return "prioritize official and academic sources";
        },
      })) events.push(event);

      expect(executed).toHaveLength(3);
      expect(executed.every(({ command }) => command === "curl")).toBe(true);
      expect(executed.every(({ args }) =>
        args.includes("--data-urlencode")
          && args.includes("https://www.bing.com/search?format=rss&count=8")
          && !args.includes("-lc"),
      )).toBe(true);
      expect(approvals).toHaveLength(3);
      expect(approvals.every((display) => display.startsWith('"curl"'))).toBe(true);
      expect(events.some((event) => event.type === "input_required" && event.prompt?.includes("Type 'approve'"))).toBe(true);
      expect(events.some((event) => event.type === "tool_call" && event.toolName === "user_feedback")).toBe(true);
      expect(events.filter((event) => event.type === "tool_call" && event.toolName === "bing_search")).toHaveLength(3);
      expect(events.filter((event) => event.type === "tool_call" && event.toolName === "pi_bash" && event.toolState === "completed")).toHaveLength(3);
      expect(events.find((event) => event.type === "answer")?.content).toContain("# Report");
    } finally {
      await sdk.dispose();
    }
  });
});
