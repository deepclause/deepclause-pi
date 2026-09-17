import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderDml, renderSequence } from "../src/diagram/extract.js";
import { resolveGrade, stripFences } from "../src/diagram/grade.js";
import { structuralCheck } from "../src/diagram/validate.js";
import { buildViewer, writeSidecar } from "../src/diagram/viewer.js";
import { diagramNameFor, resolveDiagramSource } from "../src/diagram/workspace.js";
import deepClauseExtension from "../src/index.js";
import { EXAMPLE_DML } from "../src/workspace.js";

const TEMPLATE = fileURLToPath(new URL("../src/assets/viewer.template.html", import.meta.url));
const VENDOR = fileURLToPath(new URL("../src/assets/vendor/mermaid.min.js", import.meta.url));

const VALID_FLOW = "flowchart TD\n  n1([\"start\"]):::start --> n2[\"tool/2 capabilities\"]:::det\n  classDef start fill:#e8f5e9;";

function extensionHarness(cwd: string) {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const eventHandlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: unknown }> }>();
  let activeTools = ["read", "bash"];
  const execCalls: Array<{ command: string; args: string[] }> = [];
  const completed: string[] = [];
  const pi = {
    registerCommand(name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, definition);
    },
    registerTool(definition: { name: string }) {
      tools.set(definition.name, definition as never);
    },
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      eventHandlers.set(name, handler);
    },
    getActiveTools: () => [...activeTools],
    getAllTools: () => [
      { name: "read", description: "Read", parameters: { type: "object" }, sourceInfo: { source: "core" } },
      ...[...tools.values()].map((tool) => ({ name: (tool as { name: string }).name, description: "", parameters: {}, sourceInfo: { source: "extension" } })),
    ],
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
    getThinkingLevel: () => "medium",
    sendMessage() {},
    sendUserMessage() {},
    async exec(command: string, args: string[]) {
      execCalls.push({ command, args });
      // `which` reports "not found" so Chrome validation stays off in tests.
      return command === "which"
        ? { stdout: "", stderr: "", code: 1, killed: false }
        : { stdout: "", stderr: "", code: 0, killed: false };
    },
  };
  const ctx = {
    cwd,
    model: { provider: "test", id: "model" },
    modelRegistry: {
      hasConfiguredAuth: () => true,
      async complete(_model: unknown, request: { messages: Array<{ content: string }> }) {
        completed.push(request.messages[0]?.content ?? "");
        return {
          stopReason: "stop",
          errorMessage: undefined,
          content: [{ type: "text", text: VALID_FLOW }],
          usage: { input: 3, output: 5, totalTokens: 8, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
      },
    },
    sessionManager: { getBranch: () => [] },
    thinkingLevel: "medium",
    isIdle: () => true,
    hasUI: true,
    abort() {},
    getSystemPrompt: () => "",
    getSystemPromptOptions: () => ({ skills: [], contextFiles: [] }),
    ui: {
      notify() {},
      async input() { return undefined; },
      async confirm() { return true; },
      setStatus() {},
      setWidget() {},
    },
  };
  deepClauseExtension(pi as never);
  return { commands, eventHandlers, tools, pi, ctx, activeTools: () => activeTools, execCalls, completed };
}

describe("diagram extractor", () => {
  it("renders a flow graph from the seeded example", () => {
    const graph = renderDml(".pi/deepclause/skills/example.dml", EXAMPLE_DML, { hideOutput: true });
    expect(graph).toContain("flowchart TD");
    expect(graph).toContain("agent_main/0");
    expect(graph).toContain("classDef llm");
    expect(graph).toContain("subgraph ph");
    expect(graph).toContain("exec<br/>pi_bash");
    expect(graph).not.toContain("output:");
  });

  it("renders a sequence view", () => {
    const sequence = renderSequence("example.dml", EXAMPLE_DML);
    expect(sequence).toContain("sequenceDiagram");
    expect(sequence).toContain("actor U as User");
  });
});

describe("diagram grade resolution", () => {
  it("maps wording to grades", () => {
    expect(resolveGrade("presentation grade")).toBe("presentation");
    expect(resolveGrade("make it simple")).toBe("presentation");
    expect(resolveGrade("specification grade")).toBe("specification");
    expect(resolveGrade("detailed technical")).toBe("specification");
    expect(resolveGrade("both please")).toBe("both");
    expect(resolveGrade("")).toBeUndefined();
  });

  it("strips code fences", () => {
    expect(stripFences("```mermaid\nflowchart TD\n A-->B\n```")).toBe("flowchart TD\n A-->B");
  });
});

describe("diagram validation", () => {
  it("accepts a structurally valid flowchart", () => {
    expect(structuralCheck(VALID_FLOW, "flow").ok).toBe(true);
  });

  it("rejects wrong headers, unbalanced blocks, and reserved ids", () => {
    expect(structuralCheck("sequenceDiagram\n A->>B: hi", "flow").ok).toBe(false);
    expect(structuralCheck("flowchart TD\n subgraph x\n A-->B", "flow")).toMatchObject({ ok: false });
    expect(structuralCheck('flowchart TD\n A["unterminated]', "flow")).toMatchObject({ ok: false });
    expect(structuralCheck("flowchart TD\n end[bad]\n A-->B", "flow")).toMatchObject({ ok: false });
  });
});

describe("diagram workspace paths", () => {
  it("resolves DML files anywhere and rejects bad input", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "deepclause-diagram-paths-"));
    await mkdir(path.join(cwd, "notes"), { recursive: true });
    const file = path.join(cwd, "notes", "flow.dml");
    await writeFile(file, "agent_main :- answer(\"ok\").\n", "utf8");

    expect(await resolveDiagramSource(cwd, "notes/flow.dml")).toBe(file);
    expect(await resolveDiagramSource(cwd, "@notes/flow.dml")).toBe(file);
    expect(await resolveDiagramSource(cwd, file)).toBe(file);
    await expect(resolveDiagramSource(cwd, "notes/missing.dml")).rejects.toThrow("not found");
    await writeFile(path.join(cwd, "notes", "readme.txt"), "x", "utf8");
    await expect(resolveDiagramSource(cwd, "notes/readme.txt")).rejects.toThrow(".dml");
  });

  it("disambiguates same-named files in different directories", () => {
    const cwd = "/workspace";
    const paths = ["/workspace/a/flow.dml", "/workspace/b/flow.dml"];
    const first = diagramNameFor(paths[0]!, paths, cwd);
    const second = diagramNameFor(paths[1]!, paths, cwd);
    expect(first).not.toBe(second);
    expect(first.startsWith("flow-")).toBe(true);
    expect(second.startsWith("flow-")).toBe(true);
  });
});

describe("diagram viewer build", () => {
  it("writes the viewer, manifest, markdown, and sidecars", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "deepclause-diagram-viewer-"));
    const skills = path.join(cwd, ".pi", "deepclause", "skills");
    await mkdir(skills, { recursive: true });
    const dml = path.join(skills, "sample.dml");
    await writeFile(dml, 'agent_main :-\n  output("Phase 1/1: go..."),\n  task("Summarize", string(Result)),\n  answer(Result).\n', "utf8");

    const templateText = await readFile(TEMPLATE, "utf8");
    const first = await buildViewer({ cwd, templateText, vendorAssetPath: VENDOR, extraPaths: [dml] });
    expect(first.entries.map((entry) => entry.name)).toContain("sample");
    expect(await readFile(path.join(first.diagramsDir, "index.json"), "utf8")).toContain("sample");
    expect(await readFile(first.viewerPath, "utf8")).toContain("DML flowcharts");
    expect(await readFile(path.join(first.diagramsDir, "sample.md"), "utf8")).toContain("## Sequence");

    await writeSidecar(first.diagramsDir, "sample", "presentation", VALID_FLOW);
    const second = await buildViewer({ cwd, templateText, vendorAssetPath: VENDOR, extraPaths: [dml] });
    const entry = second.entries.find((candidate) => candidate.name === "sample");
    expect(entry?.presentation).toBe(VALID_FLOW);
    expect(await readFile(second.viewerPath, "utf8")).toContain("presentation");
  });
});

describe("dc_diagram tool", () => {
  it("is active after session start and generates a diagram for a file outside .pi/deepclause", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "deepclause-diagram-tool-"));
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const dml = path.join(cwd, "src", "outside.dml");
    await writeFile(dml, 'agent_main :-\n  output("Phase 1/1: go..."),\n  task("Summarize", string(Result)),\n  answer(Result).\n', "utf8");

    const harness = extensionHarness(cwd);
    await harness.eventHandlers.get("session_start")?.({}, harness.ctx);
    expect(harness.tools.has("dc_diagram")).toBe(true);
    expect(harness.activeTools()).toContain("dc_diagram");

    const tool = harness.tools.get("dc_diagram")!;
    const result = await tool.execute(
      "call-1",
      { dml: "src/outside.dml", grade: "presentation" },
      new AbortController().signal,
      undefined,
      harness.ctx,
    ) as { content: Array<{ text: string }>; details: Record<string, unknown> };

    expect(result.details).toMatchObject({ success: true, dml: "src/outside.dml", grades: ["presentation"], opened: true });
    expect(result.content[0]?.text).toContain("presentation-grade diagram");
    expect(harness.completed.length).toBeGreaterThan(0);
    expect(harness.execCalls.some((call) => call.command === "xdg-open" || call.command === "open")).toBe(true);
    const sidecar = await readFile(path.join(cwd, ".pi", "deepclause", "diagrams", "outside.presentation.mmd"), "utf8");
    expect(sidecar).toContain("flowchart TD");
  });

  it("reports a missing file without calling the model", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "deepclause-diagram-missing-"));
    const harness = extensionHarness(cwd);
    await harness.eventHandlers.get("session_start")?.({}, harness.ctx);
    const result = await harness.tools.get("dc_diagram")!.execute(
      "call-2",
      { dml: "nope.dml" },
      new AbortController().signal,
      undefined,
      harness.ctx,
    ) as { details: Record<string, unknown> };
    expect(result.details).toMatchObject({ success: false });
    expect(harness.completed).toHaveLength(0);
  });
});
