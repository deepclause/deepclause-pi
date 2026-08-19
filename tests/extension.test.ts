import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDeepClause } from "deepclause-sdk";
import type { LLMBackend } from "deepclause-sdk";
import { buildInitialMessages } from "../src/context.js";
import { parseRun, splitArguments } from "../src/index.js";
import { registerPiRuntimeTools } from "../src/runtime.js";
import { EXAMPLE_DML, initializeWorkspace, resolveDmlPath } from "../src/workspace.js";

describe("DeepClause pi extension helpers", () => {
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
    await writeFile(paths.agents, "user-owned\n", "utf8");
    await initializeWorkspace(cwd);

    expect(await readFile(paths.agents, "utf8")).toBe("user-owned\n");
    await expect(readFile(path.join(cwd, ".deepclause", "config.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(paths.skills, "example.dml"), "utf8")).toContain("agent_main");
    expect(await readFile(path.join(paths.skills, "deep_research.dml"), "utf8")).toContain('pi_bash("curl", CurlArgs)');
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
