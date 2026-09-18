import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDeepClause } from "deepclause-sdk";
import type { DeepClauseSDK } from "deepclause-sdk";

const SP_SOURCE = fileURLToPath(new URL("../src/assets/specs.dml", import.meta.url));
const APPLY_SOURCE = fileURLToPath(new URL("../src/assets/apply.dml", import.meta.url));
const SKILL_SOURCE = fileURLToPath(new URL("../src/assets/spec_apply.dml", import.meta.url));

const TASKS = `plan_task("1.1", task{
    executor:  pi,
    do:        "Add the toggle",
    tools:     ["read", "edit"],
    expected:  "toggle exists",
    satisfies: ["ui/theme#toggle"],
    checks:    [ exists("src/toggle.tsx"), cmd("npm run typecheck") ]
}).

plan_task("1.2", task{
    executor:  pi,
    do:        "Wire it up",
    tools:     ["read", "edit"],
    expected:  "wired",
    satisfies: [],
    checks:    [ cmd("npm test") ]
}).

% --- execution state (managed by apply.dml; do not edit by hand) ---
plan_task_status("1.1", pending).
plan_task_status("1.2", pending).
`;

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "dc-apply-"));
  const root = path.join(cwd, ".pi", "deepclause");
  await mkdir(path.join(root, "lib"), { recursive: true });
  await mkdir(path.join(root, "changes", "c"), { recursive: true });
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(root, "lib", "specs.dml"), await readFile(SP_SOURCE, "utf8"));
  await writeFile(path.join(root, "lib", "apply.dml"), await readFile(APPLY_SOURCE, "utf8"));
  await writeFile(path.join(root, "changes", "c", "tasks.dml"), TASKS);
  await writeFile(path.join(cwd, "src", "toggle.tsx"), "export const Toggle = () => null;\n");
  return cwd;
}

describe("apply driver", () => {
  it("executes tasks, retries a failing check with feedback, and records status", async () => {
    const cwd = await workspace();
    const skill = await readFile(SKILL_SOURCE, "utf8");
    const calls: string[] = [];
    const verifyCalls: Record<string, number> = {};
    const sdk = await createDeepClause({
      model: "apply-test",
      llmBackend: { async complete() { return { text: "unused" }; } },
    });
    try {
      sdk.registerTool("pi_agent_step", {
        description: "stub delegated pi step",
        parameters: { type: "object", properties: { instruction: { type: "string" } }, required: ["instruction"] },
        execute: async (args) => {
          calls.push(String(args.instruction));
          return "implemented the task";
        },
      });
      sdk.registerTool("dc_verify_run", {
        description: "stub verification command",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        execute: async (args) => {
          const command = String(args.command);
          verifyCalls[command] = (verifyCalls[command] ?? 0) + 1;
          const failing = command === "npm test" && verifyCalls[command] === 1;
          return { command, stdout: "", stderr: failing ? "1 failing test" : "", exitCode: failing ? 1 : 0, killed: false };
        },
      });
      sdk.setToolPolicy({ mode: "whitelist", tools: ["pi_agent_step", "dc_verify_run"] });

      const events = [];
      for await (const event of sdk.runDML(skill, { workspacePath: cwd, args: ["c", "apply"] })) events.push(event);
      const answer = events.find((event) => event.type === "answer")?.content ?? "";
      const errors = events.filter((event) => event.type === "error").map((event) => event.content);
      expect(errors).toEqual([]);
      expect(answer).toContain("apply c: 2/2 tasks verified");
      expect(answer).toContain("status: OK");

      // 1.2 failed once and was retried; the retry got the failure feedback
      expect(verifyCalls["npm test"]).toBe(2);
      expect(verifyCalls["npm run typecheck"]).toBe(1);
      expect(calls.some((instruction) => instruction.includes("1 failing test"))).toBe(true);

      const updated = await readFile(path.join(cwd, ".pi", "deepclause", "changes", "c", "tasks.dml"), "utf8");
      expect(updated).toContain('plan_task_status("1.1", done(1))');
      expect(updated).toContain('plan_task_status("1.2", done(2))');
    } finally {
      await sdk.dispose();
    }
  });

  it("lists approved commands in plan mode without executing", async () => {
    const cwd = await workspace();
    const skill = await readFile(SKILL_SOURCE, "utf8");
    let executed = false;
    const sdk: DeepClauseSDK = await createDeepClause({
      model: "apply-test",
      llmBackend: { async complete() { return { text: "unused" }; } },
    });
    try {
      sdk.registerTool("pi_agent_step", {
        description: "stub",
        parameters: { type: "object", properties: {}, required: [] },
        execute: async () => { executed = true; return "should not run"; },
      });
      sdk.registerTool("dc_verify_run", {
        description: "stub",
        parameters: { type: "object", properties: {}, required: [] },
        execute: async () => { executed = true; return { exitCode: 0 }; },
      });
      sdk.setToolPolicy({ mode: "whitelist", tools: ["pi_agent_step", "dc_verify_run"] });

      const events = [];
      for await (const event of sdk.runDML(skill, { workspacePath: cwd, args: ["c", "plan"] })) events.push(event);
      const answer = events.find((event) => event.type === "answer")?.content ?? "";
      expect(answer).toContain("apply plan c: 2 tasks");
      expect(answer).toContain("command: npm run typecheck");
      expect(answer).toContain("command: npm test");
      expect(executed).toBe(false);
    } finally {
      await sdk.dispose();
    }
  });
});

describe("apply rollback wiring", () => {
  it("snapshots before applying and accepts on success", async () => {
    const cwd = await workspace();
    const skill = await readFile(SKILL_SOURCE, "utf8");
    let snapshots = 0;
    let accepts = 0;
    const sdk = await createDeepClause({
      model: "apply-test",
      llmBackend: { async complete() { return { text: "unused" }; } },
    });
    try {
      sdk.registerTool("pi_agent_step", {
        description: "stub",
        parameters: { type: "object", properties: { instruction: { type: "string" } }, required: ["instruction"] },
        execute: async () => "implemented the task",
      });
      sdk.registerTool("dc_verify_run", {
        description: "stub",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        execute: async (args) => ({ command: String(args.command), stdout: "", stderr: "", exitCode: 0, killed: false }),
      });
      sdk.registerTool("dc_apply_snapshot", {
        description: "stub snapshot",
        parameters: { type: "object", properties: {}, required: [] },
        execute: async () => { snapshots += 1; return "abc1234"; },
      });
      sdk.registerTool("dc_apply_accept", {
        description: "stub accept",
        parameters: { type: "object", properties: {}, required: [] },
        execute: async () => { accepts += 1; return "accepted"; },
      });
      sdk.setToolPolicy({ mode: "whitelist", tools: ["pi_agent_step", "dc_verify_run", "dc_apply_snapshot", "dc_apply_accept"] });

      const events = [];
      for await (const event of sdk.runDML(skill, { workspacePath: cwd, args: ["c", "apply"] })) events.push(event);
      const answer = events.find((event) => event.type === "answer")?.content ?? "";
      const errors = events.filter((event) => event.type === "error").map((event) => event.content);
      expect(errors).toEqual([]);
      expect(answer).toContain("status: OK");
      expect(answer).toContain("rollback: snapshot abc1234");
      expect(snapshots).toBe(1);
      expect(accepts).toBe(1);
    } finally {
      await sdk.dispose();
    }
  });
});

describe("apply resume", () => {
  it("skips tasks already marked done", async () => {
    const cwd = await workspace();
    await writeFile(
      path.join(cwd, ".pi", "deepclause", "changes", "c", "tasks.dml"),
      `plan_task("1.1", task{executor: pi, do: "one", tools: ["read"], expected: "x", satisfies: [], checks: [exists("src/toggle.tsx")]}).
plan_task("1.2", task{executor: pi, do: "two", tools: ["read"], expected: "y", satisfies: [], checks: [exists("src/toggle.tsx")]}).

% --- execution state (managed by apply.dml; do not edit by hand) ---
plan_task_status("1.1", done(1)).
plan_task_status("1.2", pending).
`,
    );
    const skill = await readFile(SKILL_SOURCE, "utf8");
    const calls: string[] = [];
    const sdk = await createDeepClause({
      model: "apply-test",
      llmBackend: { async complete() { return { text: "unused" }; } },
    });
    try {
      sdk.registerTool("pi_agent_step", {
        description: "stub",
        parameters: { type: "object", properties: { instruction: { type: "string" } }, required: ["instruction"] },
        execute: async (args) => { calls.push(String(args.instruction)); return "done"; },
      });
      sdk.registerTool("dc_verify_run", {
        description: "stub",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        execute: async () => ({ exitCode: 0 }),
      });
      sdk.registerTool("dc_apply_snapshot", { description: "stub", parameters: { type: "object", properties: {}, required: [] }, execute: async () => "abc1234" });
      sdk.registerTool("dc_apply_accept", { description: "stub", parameters: { type: "object", properties: {}, required: [] }, execute: async () => "accepted" });
      sdk.setToolPolicy({ mode: "whitelist", tools: ["pi_agent_step", "dc_verify_run", "dc_apply_snapshot", "dc_apply_accept"] });

      const events = [];
      for await (const event of sdk.runDML(skill, { workspacePath: cwd, args: ["c", "apply"] })) events.push(event);
      const answer = events.find((event) => event.type === "answer")?.content ?? "";
      const output = events.filter((event) => event.type === "output").map((event) => event.content ?? "");
      expect(output.some((line) => line.includes("1 remaining"))).toBe(true);
      expect(answer).toContain("2/2 tasks verified");
      expect(answer).toContain("status: OK");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("Task 1.2");
    } finally {
      await sdk.dispose();
    }
  });
});
