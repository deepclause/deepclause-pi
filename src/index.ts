import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import type { DMLEvent } from "deepclause-sdk";
import { Type } from "typebox";
import { buildInitialMessages } from "./context.js";
import { loadConfig, setModelToolEnabled, type ContextMode } from "./config.js";
import { renderDml, renderSequence } from "./diagram/extract.js";
import { polishDiagram, resolveGrade, type DiagramGrade } from "./diagram/grade.js";
import { findChrome, validateMermaid, type MermaidView } from "./diagram/validate.js";
import {
  buildViewer,
  openViewerInBrowser,
  writeSidecar,
} from "./diagram/viewer.js";
import {
  collectDiagramTargets,
  diagramNameFor,
  displayPath,
  ensureDiagramDir,
  resolveDiagramSource,
} from "./diagram/workspace.js";
import { completeTextWithPiModel } from "./model.js";
import { executeDml } from "./runtime.js";
import { getPaths, initializeWorkspace, resolveDmlPath } from "./workspace.js";
import {
  assemblePlanDml,
  buildPlanningPrompt,
  DC_PLAN_COMMIT_TOOL,
  isContextualPlan,
  PI_AGENT_STEP_TOOL,
  readPlanRequiredTools,
  validateGeneratedPlan,
  validatePlanSpec,
  writePlanNonDestructively,
  type PlanningSnapshot,
} from "./planner.js";

const DC_RUN_TOOL = "dc_run";
const DC_DIAGRAM_TOOL = "dc_diagram";
const AUTHORING_INSTRUCTION = `DeepClause programs live in .pi/deepclause/skills/ and executable generated plans live in .pi/deepclause/plans/. You may create and edit DML skills directly after consulting .pi/deepclause/AGENTS.md and DML_REFERENCE.md. Use /dc-plan when the user asks pi to design a contextual executable plan; finish that planning turn with dc_plan_commit. When the user asks for a diagram, flowchart, or visual of a .dml file, call the dc_diagram tool with the exact path and the requested grade (presentation or specification); it writes the viewer under .pi/deepclause/diagrams/ and opens it, so do not hand-write Mermaid. DeepClause compilation is unavailable, so generated content must already be valid DML. Users execute programs through /dc-run. If the opt-in dc_run tool is active, you may execute an ordinary skill with it, but contextual plans requiring pi_agent_step must be started by the user. Never invoke a compiler or create .deepclause/.`;
const STATUS_KEY = "deepclause";
const WIDGET_KEY = "deepclause-stream";

export interface ParsedRun {
  target: string;
  args: string[];
  contextMode?: ContextMode;
  verbose: boolean;
  debug: boolean;
}

interface ParsedPlan {
  request: string;
  name?: string;
  debug: boolean;
}

interface PlanningTransaction {
  snapshot: PlanningSnapshot;
  nameOverride?: string;
  committed: boolean;
  startedAt: number;
}

interface PendingAgentStep {
  previousTools: string[];
  toolsUsed: string[];
  errors: string[];
  summary?: string;
  cleanup: () => void;
  resolve: (value: { success: boolean; summary: string; toolsUsed: string[]; errors: string[] }) => void;
  reject: (error: Error) => void;
}

export function splitArguments(input: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        result.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Unterminated quoted argument");
  if (current) result.push(current);
  return result;
}

export function parseRun(input: string): ParsedRun {
  const tokens = splitArguments(input);
  const target = tokens.shift();
  if (!target) throw new Error("Usage: /dc-run <skill|path> [args] [--context=MODE] [--verbose|--debug]");
  let contextMode: ContextMode | undefined;
  let verbose = false;
  let debug = false;
  const args: string[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const contextValue = token.startsWith("--context=") ? token.slice("--context=".length) : undefined;
    if (token === "--verbose" || token === "-v") {
      verbose = true;
    } else if (token === "--debug" || token === "-d") {
      verbose = true;
      debug = true;
    } else if (contextValue !== undefined) {
      if (contextValue !== "turn" && contextValue !== "branch" && contextValue !== "isolated") {
        throw new Error("--context must be turn, branch, or isolated");
      }
      contextMode = contextValue;
    } else if (token === "--context") {
      const value = tokens[++index];
      if (value !== "turn" && value !== "branch" && value !== "isolated") {
        throw new Error("--context must be turn, branch, or isolated");
      }
      contextMode = value;
    } else {
      args.push(token);
    }
  }
  return { target, args, contextMode, verbose, debug };
}

export function parsePlan(input: string): ParsedPlan {
  const tokens = splitArguments(input);
  let name: string | undefined;
  let debug = false;
  const requestParts: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "--debug" || token === "-d") debug = true;
    else if (token.startsWith("--name=")) name = token.slice("--name=".length);
    else if (token === "--name") name = tokens[++index];
    else requestParts.push(token);
  }
  const request = requestParts.join(" ").trim();
  if (!request) throw new Error("Usage: /dc-plan <request> [--name=slug] [--debug]");
  if (name !== undefined && !name.trim()) throw new Error("--name requires a non-empty slug");
  return { request, name: name?.trim(), debug };
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type?: string; text?: string } => Boolean(part) && typeof part === "object")
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function elapsedSeconds(startedAt: number): string {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

function eventSummary(event: DMLEvent, debug: boolean): string {
  if (debug) return JSON.stringify(event);
  switch (event.type) {
    case "output": return `output: ${event.content ?? ""}`;
    case "log": return `log: ${event.content ?? ""}`;
    case "answer": return "answer received";
    case "finished": return "runtime finished";
    case "error": return `error: ${event.content ?? "unknown error"}`;
    case "input_required": return `input required: ${event.prompt ?? ""}`;
    case "stream": return event.done ? "model stream completed" : "model stream update";
    case "tool_call": return `tool ${event.toolState ?? "call"}: ${event.toolName ?? "unknown"}`;
    case "usage": return `usage: ${event.usage?.inputTokens ?? 0} in / ${event.usage?.outputTokens ?? 0} out`;
    case "task_activity": return `task ${event.taskState ?? "active"}: ${event.taskDescription ?? event.taskId ?? "task"}`;
    case "memory_compaction": return `compaction ${event.compactionAction ?? "event"}`;
  }
}

async function listDmlFiles(directory: string, prefix = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listDmlFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile() && entry.name.endsWith(".dml")) files.push(relative);
  }
  return files.sort();
}

function modelLabel(ctx: ExtensionCommandContext): string {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none selected";
}

async function bundledViewerTemplate(): Promise<string> {
  return readFile(fileURLToPath(new URL("./assets/viewer.template.html", import.meta.url)), "utf8");
}

function viewerVendorAssetPath(): string {
  return fileURLToPath(new URL("./assets/vendor/mermaid.min.js", import.meta.url));
}

function publishResult(pi: ExtensionAPI, content: string, details: Record<string, unknown>): void {
  pi.sendMessage({ customType: "deepclause-result", content, display: true, details });
}

export default function deepClauseExtension(pi: ExtensionAPI) {
  let activeController: AbortController | undefined;
  let activeDescription: string | undefined;
  let modelToolRegistered = false;
  let diagramToolRegistered = false;
  let planCommitRegistered = false;
  let planningTransaction: PlanningTransaction | undefined;
  let pendingAgentStep: PendingAgentStep | undefined;

  const setPlanCommitActive = (enabled: boolean) => {
    if (enabled && !planCommitRegistered) {
      pi.registerTool({
        name: DC_PLAN_COMMIT_TOOL,
        label: "Commit DeepClause Plan",
        description: "Commit a structured executable DeepClause plan after inspecting the current pi context, skills, workspace, and active tools. Available only during /dc-plan.",
        promptSnippet: "Commit the structured DML plan requested by /dc-plan",
        promptGuidelines: [
          "Call dc_plan_commit exactly once after gathering enough context to create a concrete executable plan.",
          "Use only exact active pi tool names, and choose dml steps when no pi capability is required.",
        ],
        parameters: Type.Object({
          slug: Type.String(),
          title: Type.String(),
          objective: Type.String(),
          assumptions: Type.Array(Type.String()),
          steps: Type.Array(Type.Object({
            id: Type.String(),
            title: Type.String(),
            instruction: Type.String(),
            executor: StringEnum(["pi", "dml"] as const),
            requiredTools: Type.Array(Type.String()),
            relevantSkills: Type.Array(Type.String()),
            expectedResult: Type.String(),
          }), { minItems: 1, maxItems: 12 }),
          finalSynthesis: Type.Optional(Type.String()),
          failureMessage: Type.String(),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const transaction = planningTransaction;
          if (!transaction) {
            return {
              content: [{ type: "text", text: "No /dc-plan transaction is active." }],
              details: { success: false, error: "no_planning_transaction" },
            };
          }
          if (transaction.committed) {
            return {
              content: [{ type: "text", text: "This planning transaction has already committed a plan." }],
              details: { success: false, error: "plan_already_committed" },
            };
          }

          try {
            const plan = validatePlanSpec(params, transaction.snapshot, transaction.nameOverride);
            const preview = [
              plan.spec.title,
              `Objective: ${plan.spec.objective}`,
              `Steps: ${plan.spec.steps.length}`,
              `Pi tools: ${plan.requiredTools.join(", ") || "none"}`,
              ...plan.spec.steps.map((step, index) => `${index + 1}. [${step.executor}] ${step.title}`),
            ].join("\n");
            if (!ctx.hasUI || !await ctx.ui.confirm("Create executable DeepClause plan?", preview)) {
              return {
                content: [{ type: "text", text: "Plan creation was not approved." }],
                details: { success: false, error: "plan_not_approved" },
              };
            }

            const paths = await initializeWorkspace(ctx.cwd);
            const dml = assemblePlanDml(plan, transaction.snapshot);
            await validateGeneratedPlan(dml);
            const filePath = await writePlanNonDestructively(paths, plan.spec.slug, dml);
            transaction.committed = true;
            setPlanCommitActive(false);
            const relativePath = path.relative(paths.root, filePath).split(path.sep).join("/");
            const text = [
              `Created executable DML plan: .pi/deepclause/${relativePath}`,
              `Run it with: /dc-run ${relativePath}`,
              plan.warnings.length ? `Warnings:\n${plan.warnings.join("\n")}` : "",
            ].filter(Boolean).join("\n\n");
            return {
              content: [{ type: "text", text }],
              details: {
                success: true,
                path: relativePath,
                contextual: plan.spec.steps.some((step) => step.executor === "pi"),
                requiredTools: plan.requiredTools,
                warnings: plan.warnings,
              },
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: "text", text: `Plan commit failed: ${message}` }],
              details: { success: false, error: message },
            };
          }
        },
      });
      planCommitRegistered = true;
    }

    const activeTools = pi.getActiveTools();
    const isActive = activeTools.includes(DC_PLAN_COMMIT_TOOL);
    if (enabled !== isActive) {
      pi.setActiveTools(enabled
        ? [...new Set([...activeTools, DC_PLAN_COMMIT_TOOL])]
        : activeTools.filter((name) => name !== DC_PLAN_COMMIT_TOOL));
    }
  };

  const runPiAgentStep = async (
    request: { instruction: string; tools: string[]; expected: string; skills: string[] },
    signal: AbortSignal,
    ctx: ExtensionContext,
  ) => {
    if (pendingAgentStep) throw new Error("Another delegated pi plan step is active");
    if (!request.instruction.trim()) throw new Error("pi_agent_step requires a non-empty instruction");
    const requestedTools = [...new Set(request.tools)];
    const recursiveTools = new Set([DC_RUN_TOOL, DC_PLAN_COMMIT_TOOL, PI_AGENT_STEP_TOOL]);
    if (requestedTools.some((name) => recursiveTools.has(name))) {
      throw new Error("A contextual plan cannot request DeepClause control tools");
    }
    const knownTools = new Set(pi.getAllTools().map((tool) => tool.name));
    const previousTools = pi.getActiveTools();
    const activeTools = new Set(previousTools);
    for (const toolName of requestedTools) {
      if (!knownTools.has(toolName)) throw new Error(`Required pi tool is no longer installed: ${toolName}`);
      if (!activeTools.has(toolName)) throw new Error(`Required pi tool is not active: ${toolName}`);
    }
    if (!ctx.isIdle()) throw new Error("Pi must be idle before a contextual plan step starts");

    const correlationId = `dc-step-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    pi.setActiveTools(requestedTools);
    return new Promise<{ success: boolean; summary: string; toolsUsed: string[]; errors: string[] }>((resolve, reject) => {
      const onAbort = () => {
        ctx.abort();
        if (pendingAgentStep) {
          pendingAgentStep.cleanup();
          pendingAgentStep = undefined;
        }
        reject(signal.reason instanceof Error ? signal.reason : new Error("Contextual pi plan step cancelled"));
      };
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        pi.setActiveTools(previousTools);
      };
      pendingAgentStep = {
        previousTools,
        toolsUsed: [],
        errors: [],
        cleanup,
        resolve,
        reject,
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        pi.sendUserMessage([
          `[DeepClause contextual plan step]`,
          `Internal correlation: ${correlationId}`,
          `Instruction: ${request.instruction}`,
          `Expected result: ${request.expected}`,
          `Relevant skills: ${request.skills.join(", ") || "none specified"}`,
          `Active tools for this step: ${requestedTools.join(", ") || "none"}`,
          "Execute this bounded step using the current pi context and skills. Do not invoke DeepClause planning or execution controls. Finish with a concise summary of actions, concrete results, validation, and remaining errors.",
        ].join("\n\n"));
      } catch (error) {
        pendingAgentStep = undefined;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const setModelToolActive = (enabled: boolean) => {
    if (enabled && !modelToolRegistered) {
      pi.registerTool({
        name: DC_RUN_TOOL,
        label: "Run DeepClause Skill",
        description: "Execute an existing DML program under .pi/deepclause/ with pi's active model and return its final answer, errors, and usage.",
        promptSnippet: "Run an existing DeepClause DML skill from .pi/deepclause/",
        promptGuidelines: [
          "Use dc_run only for existing DML programs when their deterministic logic, constraints, or specialized orchestration is useful; do not use dc_run to compile natural language or create a skill.",
          "Do not call dc_run while another DeepClause execution is active, and do not claim success unless dc_run returns an answer without errors.",
        ],
        parameters: Type.Object({
          skill: Type.String({ description: "Skill name such as example, or a DML path relative to .pi/deepclause/." }),
          args: Type.Optional(Type.Array(Type.String(), { description: "Positional arguments passed to agent_main/N." })),
          context: Type.Optional(StringEnum(["turn", "branch", "isolated"] as const, {
            description: "Optional session-context override for this execution.",
          })),
        }),
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          if (activeController) {
            return {
              content: [{ type: "text", text: "DeepClause execution rejected: another execution is already active." }],
              details: { success: false, error: "execution_already_active" },
            };
          }

          const paths = await initializeWorkspace(ctx.cwd);
          const config = await loadConfig(paths.config);
          if (!config.modelToolEnabled || !pi.getActiveTools().includes(DC_RUN_TOOL)) {
            return {
              content: [{ type: "text", text: "The dc_run tool is disabled. The user can enable it with /dc-tool enable." }],
              details: { success: false, error: "tool_disabled" },
            };
          }

          const mode = params.context ?? config.contextMode;
          const filePath = await resolveDmlPath(paths, params.skill);
          if (await isContextualPlan(filePath)) {
            return {
              content: [{ type: "text", text: "Contextual DML plans must be started by the user with /dc-run; they cannot start a nested pi agent turn from dc_run." }],
              details: { success: false, error: "interactive_plan_requires_user_run" },
            };
          }
          const skillName = path.relative(paths.root, filePath);
          const initialMessages = buildInitialMessages(
            ctx.sessionManager.getBranch(),
            mode,
            config.branchMessageLimit,
          );
          const controller = new AbortController();
          const cancel = () => controller.abort(signal?.reason ?? new Error("dc_run cancelled"));
          if (signal?.aborted) cancel();
          else signal?.addEventListener("abort", cancel, { once: true });
          activeController = controller;
          activeDescription = `model tool running ${skillName}`;
          const startedAt = Date.now();
          const progress: string[] = [];

          try {
            const result = await executeDml(
              filePath,
              params.args ?? [],
              initialMessages,
              config,
              pi,
              ctx,
              controller,
              {
                onEvent: (event) => {
                  if (event.type === "output" && event.content) progress.push(event.content);
                  else if (event.type === "task_activity") progress.push(`Task ${event.taskState ?? "active"}: ${event.taskDescription ?? event.taskId ?? "task"}`);
                  else if (event.type === "tool_call") progress.push(`Tool ${event.toolState ?? "call"}: ${event.toolName ?? "unknown"}`);
                  else if (event.type === "input_required") progress.push(`Waiting for user input: ${event.prompt ?? ""}`);
                  else return;
                  onUpdate?.({
                    content: [{ type: "text", text: progress.slice(-4).join("\n") }],
                    details: { skill: skillName, contextMode: mode, elapsedMs: Date.now() - startedAt },
                  });
                },
                onDiagnostic: () => {},
                onInput: async (prompt, inputSignal) => {
                  if (!ctx.hasUI) throw new Error("dc_run cannot request user input without interactive UI");
                  const answer = await ctx.ui.input("DeepClause input", prompt, { signal: inputSignal });
                  if (answer === undefined) throw new Error("Input cancelled");
                  return answer;
                },
              },
            );
            const success = result.errors.length === 0 && result.answer !== undefined;
            const text = result.answer ?? (result.errors.length > 0
              ? `DeepClause execution failed:\n${result.errors.join("\n")}`
              : "DeepClause execution finished without an answer.");
            return {
              content: [{ type: "text", text }],
              details: {
                success,
                skill: skillName,
                contextMode: mode,
                elapsedMs: Date.now() - startedAt,
                answer: result.answer,
                errors: result.errors,
                usage: result.usage,
              },
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: "text", text: `DeepClause execution failed: ${message}` }],
              details: { success: false, skill: skillName, contextMode: mode, error: message },
            };
          } finally {
            signal?.removeEventListener("abort", cancel);
            activeController = undefined;
            activeDescription = undefined;
          }
        },
      });
      modelToolRegistered = true;
    }

    const activeTools = pi.getActiveTools();
    const isActive = activeTools.includes(DC_RUN_TOOL);
    if (enabled !== isActive) {
      pi.setActiveTools(enabled
        ? [...new Set([...activeTools, DC_RUN_TOOL])]
        : activeTools.filter((name) => name !== DC_RUN_TOOL));
    }
  };

  const setDiagramToolActive = () => {
    if (!diagramToolRegistered) {
      pi.registerTool({
        name: DC_DIAGRAM_TOOL,
        label: "Create DeepClause Diagram",
        description: "Create a presentation-grade or specification-grade Mermaid diagram from any .dml file, write a self-contained offline viewer under .pi/deepclause/diagrams/, and open it.",
        promptSnippet: "Create a presentation- or specification-grade diagram from a DML file",
        promptGuidelines: [
          "Use dc_diagram whenever the user asks for a diagram, flowchart, or visual of a .dml file; pass the exact path the user named.",
          "Choose grade=presentation for slides and overviews and grade=specification for engineering detail; use grade=both only when the user asks for both.",
          "Do not hand-write Mermaid or run diagram tools yourself; call dc_diagram and report the viewer result.",
        ],
        parameters: Type.Object({
          dml: Type.String({ description: "Path to a .dml file, relative to the workspace or absolute. A leading @ is ignored." }),
          grade: Type.Optional(Type.String({ description: "presentation (default), specification, or both. Synonyms such as detailed or technical map to specification." })),
          view: Type.Optional(StringEnum(["flow", "sequence"] as const, { description: "Base layout used to seed the grade; default flow." })),
        }),
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          if (activeController) {
            return {
              content: [{ type: "text", text: "Another DeepClause operation is already active; wait for it to finish." }],
              details: { success: false, error: "execution_already_active" },
            };
          }

          const requested = resolveGrade(String(params.grade ?? "")) ?? "presentation";
          const grades: DiagramGrade[] = requested === "both" ? ["presentation", "specification"] : [requested];
          const view: MermaidView = params.view === "sequence" ? "sequence" : "flow";

          let sourcePath: string;
          try {
            sourcePath = await resolveDiagramSource(ctx.cwd, params.dml);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { content: [{ type: "text", text: `dc_diagram failed: ${message}` }], details: { success: false, error: message } };
          }
          if (!ctx.model) {
            return {
              content: [{ type: "text", text: "dc_diagram requires an active pi model. Select one and try again." }],
              details: { success: false, error: "no_model" },
            };
          }

          const config = await loadConfig(getPaths(ctx.cwd).config);
          const source = await readFile(sourcePath, "utf8");
          const display = displayPath(ctx.cwd, sourcePath);
          const seed = view === "sequence"
            ? renderSequence(display, source)
            : renderDml(display, source, { hideOutput: true });
          const targets = await collectDiagramTargets(ctx.cwd, [sourcePath]);
          const name = diagramNameFor(sourcePath, targets, ctx.cwd);
          const { diagrams, vendor } = await ensureDiagramDir(ctx.cwd, viewerVendorAssetPath());
          const templateText = await bundledViewerTemplate();

          const controller = new AbortController();
          const cancel = () => controller.abort(signal?.reason ?? new Error("dc_diagram cancelled"));
          if (signal?.aborted) cancel();
          else signal?.addEventListener("abort", cancel, { once: true });
          activeController = controller;
          activeDescription = `diagram ${name} (${grades.join("+")})`;

          const run = (command: string, args: string[], options?: { timeout?: number }) => pi.exec(command, args, options);
          let chrome: string | undefined;
          let chromeResolved = false;

          try {
            for (const grade of grades) {
              const result = await polishDiagram({
                grade,
                view,
                source,
                seed,
                maxTokens: config.maxTokens,
                signal: controller.signal,
                complete: (options) => completeTextWithPiModel(ctx, options),
                validate: async (code) => {
                  if (!chromeResolved) {
                    chrome = await findChrome(run);
                    chromeResolved = true;
                  }
                  const outcome = await validateMermaid(code, view, { run, vendorDir: vendor, chrome: chrome ?? null });
                  return outcome.result;
                },
                onProgress: (message) => onUpdate?.({
                  content: [{ type: "text", text: message }],
                  details: { dml: display, grades, name },
                }),
              });
              await writeSidecar(diagrams, name, grade, result.code);
            }

            const build = await buildViewer({
              cwd: ctx.cwd,
              templateText,
              vendorAssetPath: viewerVendorAssetPath(),
              extraPaths: [sourcePath],
            });
            const opened = ctx.hasUI
              ? await openViewerInBrowser(pi, build.viewerPath, name, grades[0] ?? "presentation")
              : false;
            const viewer = displayPath(ctx.cwd, build.viewerPath);
            const text = `Created ${grades.join(" + ")}-grade diagram for ${display}. Viewer: ${viewer}${opened ? " (opened in your browser)" : ""}`;
            return {
              content: [{ type: "text", text }],
              details: { success: true, dml: display, grades, name, viewer, opened, chrome: Boolean(chrome) },
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { content: [{ type: "text", text: `dc_diagram failed: ${message}` }], details: { success: false, error: message } };
          } finally {
            signal?.removeEventListener("abort", cancel);
            activeController = undefined;
            activeDescription = undefined;
          }
        },
      });
      diagramToolRegistered = true;
    }

    const activeTools = pi.getActiveTools();
    if (!activeTools.includes(DC_DIAGRAM_TOOL)) {
      pi.setActiveTools([...activeTools, DC_DIAGRAM_TOOL]);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    const config = await loadConfig(getPaths(ctx.cwd).config);
    setModelToolActive(config.modelToolEnabled);
    setDiagramToolActive();
  });

  pi.on("tool_execution_start", (event) => {
    if (pendingAgentStep && !pendingAgentStep.toolsUsed.includes(event.toolName)) {
      pendingAgentStep.toolsUsed.push(event.toolName);
    }
  });

  pi.on("tool_execution_end", (event) => {
    if (pendingAgentStep && event.isError) pendingAgentStep.errors.push(`${event.toolName} failed`);
  });

  pi.on("agent_end", (event) => {
    if (!pendingAgentStep) return;
    for (let index = event.messages.length - 1; index >= 0; index--) {
      const text = messageText(event.messages[index]);
      if (text) {
        pendingAgentStep.summary = text;
        break;
      }
    }
  });

  pi.on("agent_settled", () => {
    if (pendingAgentStep) {
      const pending = pendingAgentStep;
      pendingAgentStep = undefined;
      pending.cleanup();
      const summary = pending.summary?.trim() ?? "";
      pending.resolve({
        // Tool failures are normal, recoverable events in a pi agent loop. The
        // delegated step succeeds when pi settles with a textual summary; the
        // collected failures remain available as diagnostics.
        success: summary.length > 0,
        summary: summary || "Pi completed the delegated turn without a textual summary.",
        toolsUsed: pending.toolsUsed,
        errors: pending.errors,
      });
      return;
    }
    if (planningTransaction) {
      const committed = planningTransaction.committed;
      planningTransaction = undefined;
      setPlanCommitActive(false);
      if (!committed) console.error("[deepclause] /dc-plan turn settled without committing a plan");
    }
  });

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${AUTHORING_INSTRUCTION}`,
  }));

  pi.on("session_shutdown", () => {
    activeController?.abort(new Error("Pi session changed or closed"));
    if (pendingAgentStep) {
      const pending = pendingAgentStep;
      pendingAgentStep = undefined;
      pending.cleanup();
      pending.reject(new Error("Pi session changed or closed"));
    }
    planningTransaction = undefined;
    setPlanCommitActive(false);
    activeController = undefined;
    activeDescription = undefined;
  });

  pi.registerCommand("dc", {
    description: "Show DeepClause runtime help and status",
    handler: async (_args, ctx) => {
      const paths = await initializeWorkspace(ctx.cwd);
      const config = await loadConfig(paths.config);
      const message = [
        "DeepClause pi runtime",
        `Model: ${modelLabel(ctx)}`,
        `Status: ${activeDescription ?? "idle"}`,
        `Root: ${path.relative(ctx.cwd, paths.root)}`,
        `Skills: ${path.relative(ctx.cwd, paths.skills)}`,
        `Plans: ${path.relative(ctx.cwd, paths.plans)}`,
        `Context: ${config.contextMode} (verbose default: ${config.verbose})`,
        `Model tool (${DC_RUN_TOOL}): ${config.modelToolEnabled && pi.getActiveTools().includes(DC_RUN_TOOL) ? "enabled" : "disabled"}`,
        `Model tool (${DC_DIAGRAM_TOOL}): ${pi.getActiveTools().includes(DC_DIAGRAM_TOOL) ? "enabled" : "disabled"}`,
        "Ask pi for a presentation-grade or specification-grade diagram of any .dml file;",
        "it writes the viewer under .pi/deepclause/diagrams/ and opens it.",
        "Commands:",
        "  /dc-list",
        "  /dc-plan <request> [--name=slug]   create an executable contextual DML plan",
        "  /dc-run <skill|path> [args] [--context=turn|branch|isolated]",
        "  /dc-run <skill|path> --verbose   show lifecycle events",
        "  /dc-run <skill|path> --debug     show full event payloads and SDK diagnostics",
        "  /dc-tool enable|disable|status   control the model-callable dc_run tool",
        "  /dc-cancel",
      ].join("\n");
      ctx.ui.notify(message, "info");
    },
  });

  pi.registerCommand("dc-plan", {
    description: "Create an executable DML plan using pi's current context, skills, and active tools",
    handler: async (rawArgs, ctx) => {
      if (activeController || pendingAgentStep || planningTransaction || !ctx.isIdle()) {
        ctx.ui.notify("DeepClause or pi is already active; wait before starting /dc-plan", "warning");
        return;
      }
      try {
        const parsed = parsePlan(rawArgs);
        if (!ctx.model) throw new Error("Select a pi model before creating a plan");
        const paths = await initializeWorkspace(ctx.cwd);
        const promptOptions = ctx.getSystemPromptOptions();
        const snapshot: PlanningSnapshot = {
          model: `${ctx.model.provider}/${ctx.model.id}`,
          thinkingLevel: String(ctx.thinkingLevel ?? pi.getThinkingLevel()),
          activeTools: pi.getActiveTools().filter((name) => name !== DC_PLAN_COMMIT_TOOL),
          allTools: pi.getAllTools().filter((tool) => tool.name !== DC_PLAN_COMMIT_TOOL && tool.name !== PI_AGENT_STEP_TOOL),
          skillNames: (promptOptions.skills ?? []).map((skill) => skill.name),
          contextFiles: (promptOptions.contextFiles ?? []).map((file) => file.path),
          existingSkills: await listDmlFiles(paths.skills),
          existingPlans: await listDmlFiles(paths.plans),
        };
        planningTransaction = {
          snapshot,
          nameOverride: parsed.name,
          committed: false,
          startedAt: Date.now(),
        };
        setPlanCommitActive(true);
        ctx.ui.notify("Starting a contextual pi planning turn. Review the generated plan before it is written.", "info");
        pi.sendUserMessage(buildPlanningPrompt(parsed.request, snapshot, parsed.name));
      } catch (error) {
        planningTransaction = undefined;
        setPlanCommitActive(false);
        const message = error instanceof Error ? error.message : String(error);
        if (rawArgs.includes("--debug") || rawArgs.includes("-d")) console.error(`[deepclause:plan] ${message}`);
        ctx.ui.notify(message, "error");
      }
    },
  });

  pi.registerCommand("dc-tool", {
    description: "Enable, disable, or inspect the model-callable dc_run tool",
    handler: async (rawArgs, ctx) => {
      const action = rawArgs.trim().toLowerCase() || "status";
      if (action !== "enable" && action !== "on" && action !== "disable" && action !== "off" && action !== "status") {
        ctx.ui.notify("Usage: /dc-tool enable|disable|status", "warning");
        return;
      }

      const paths = await initializeWorkspace(ctx.cwd);
      if (action === "enable" || action === "on") {
        await setModelToolEnabled(paths.config, true);
        setModelToolActive(true);
        ctx.ui.notify("dc_run is enabled for this workspace and is now callable by the model", "warning");
      } else if (action === "disable" || action === "off") {
        await setModelToolEnabled(paths.config, false);
        setModelToolActive(false);
        ctx.ui.notify("dc_run is disabled for this workspace", "info");
      } else {
        const config = await loadConfig(paths.config);
        const active = config.modelToolEnabled && pi.getActiveTools().includes(DC_RUN_TOOL);
        ctx.ui.notify(`dc_run model tool: ${active ? "enabled" : "disabled"}`, "info");
      }
    },
  });

  pi.registerCommand("dc-list", {
    description: "List DeepClause DML skills and generated plans",
    handler: async (_args, ctx) => {
      const paths = getPaths(ctx.cwd);
      const [skills, plans] = await Promise.all([listDmlFiles(paths.skills), listDmlFiles(paths.plans)]);
      const message = [
        "Skills:",
        ...(skills.length ? skills.map((file) => `  ${file}`) : ["  none"]),
        "",
        "Plans:",
        ...(plans.length ? plans.map((file) => `  ${file}`) : ["  none"]),
      ].join("\n");
      ctx.ui.notify(message, "info");
    },
  });

  pi.registerCommand("dc-cancel", {
    description: "Cancel the active DeepClause execution",
    handler: async (_args, ctx) => {
      if (!activeController) {
        ctx.ui.notify("No DeepClause execution is active", "info");
        return;
      }
      activeController.abort(new Error("Cancelled by user"));
      ctx.ui.notify("Cancelling DeepClause execution", "warning");
    },
  });

  pi.registerCommand("dc-run", {
    description: "Run a DML skill with pi's active model",
    handler: async (rawArgs, ctx) => {

      if (activeController) {
        ctx.ui.notify("A DeepClause execution is already active", "warning");
        return;
      }

      try {
        const parsed = parseRun(rawArgs);
        const paths = await initializeWorkspace(ctx.cwd);
        const config = await loadConfig(paths.config);
        const filePath = await resolveDmlPath(paths, parsed.target);
        const contextualPlan = await isContextualPlan(filePath);
        if (contextualPlan) {
          const requiredTools = await readPlanRequiredTools(filePath);
          const knownTools = new Set(pi.getAllTools().map((tool) => tool.name));
          const activeTools = new Set(pi.getActiveTools());
          const missingTools = requiredTools.filter((name) => !knownTools.has(name));
          const inactiveTools = requiredTools.filter((name) => knownTools.has(name) && !activeTools.has(name));
          if (missingTools.length) throw new Error(`Contextual plan requires missing pi tools: ${missingTools.join(", ")}`);
          if (inactiveTools.length) throw new Error(`Contextual plan requires inactive pi tools: ${inactiveTools.join(", ")}`);
          if (!ctx.hasUI || !await ctx.ui.confirm(
            "Run contextual DeepClause plan?",
            [
              "This plan may delegate bounded steps to pi using the current session context, skills, and explicitly named active tools.",
              `Preflight tools: ${requiredTools.join(", ") || "none declared"}`,
              "Tool-specific approvals still apply.",
            ].join("\n\n"),
          )) {
            ctx.ui.notify("Contextual plan execution was not approved", "warning");
            return;
          }
        }
        const mode = parsed.contextMode ?? config.contextMode;
        const initialMessages = buildInitialMessages(
          ctx.sessionManager.getBranch(),
          mode,
          config.branchMessageLimit,
        );
        const controller = new AbortController();
        activeController = controller;
        const outputLines: string[] = [];
        const recentEvents: string[] = [];
        const events: Array<Record<string, unknown>> = [];
        const startedAt = Date.now();
        const skillName = path.relative(paths.root, filePath);
        const verbose = parsed.verbose || config.verbose;
        let phase = "starting runtime";
        let inputTokens = 0;
        let outputTokens = 0;
        activeDescription = `running ${skillName} (${elapsedSeconds(startedAt)})`;

        const renderExecution = () => {
          const header = `DeepClause  RUNNING  ${skillName}  ${elapsedSeconds(startedAt)}`;
          const metadata = `${modelLabel(ctx)}  |  context=${mode}  |  ${parsed.debug ? "debug" : verbose ? "verbose" : "normal"}`;
          const lines = [header, metadata, `Phase: ${phase}`, `Usage: ${inputTokens} input / ${outputTokens} output tokens`];
          if (outputLines.length > 0) lines.push("", "Output:", ...outputLines.slice(-5));
          if (verbose && recentEvents.length > 0) lines.push("", "Recent events:", ...recentEvents.slice(parsed.debug ? -8 : -5));
          ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
          ctx.ui.setStatus(STATUS_KEY, `${skillName}: ${phase} (${elapsedSeconds(startedAt)})`);
          activeDescription = `running ${skillName}: ${phase} (${elapsedSeconds(startedAt)})`;
        };
        renderExecution();
        const statusTimer = setInterval(renderExecution, 250);

        const onEvent = (event: DMLEvent) => {
          const summary = eventSummary(event, parsed.debug);
          if (parsed.debug) console.error(`[deepclause:event] ${summary}`);
          recentEvents.push(summary.length > 300 ? `${summary.slice(0, 297)}...` : summary);
          if (event.type === "task_activity") {
            const label = event.taskDescription ?? event.taskId ?? "task";
            phase = `${event.taskState ?? "running"} task: ${label.slice(0, 100)}`;
          } else if (event.type === "stream" && event.content) {
            phase = "receiving model response";
            outputLines.push(...event.content.split("\n").filter(Boolean));
          } else if (event.type === "output" && event.content) {
            phase = event.content;
            outputLines.push(event.content);
          } else if (event.type === "tool_call") {
            phase = `tool ${event.toolState ?? "call"}: ${event.toolName ?? "unknown"}`;
          } else if (event.type === "input_required") {
            phase = `waiting for input: ${event.prompt ?? ""}`;
          } else if (event.type === "usage" && event.usage) {
            inputTokens += event.usage.inputTokens;
            outputTokens += event.usage.outputTokens;
          } else if (event.type === "answer") {
            phase = "answer received";
          } else if (event.type === "finished") {
            phase = "finishing";
          } else if (event.type === "error" && event.content) {
            phase = `error: ${event.content}`;
            ctx.ui.notify(event.content, "error");
          }
          if (parsed.debug || event.type === "task_activity" || event.type === "tool_call" || event.type === "error") {
            events.push(parsed.debug ? { ...event } : { type: event.type, state: event.taskState ?? event.toolState, name: event.taskDescription ?? event.toolName, error: event.content });
          }
          renderExecution();
        };

        const onDiagnostic = (message: string, details?: unknown) => {
          const rendered = details === undefined ? message : `${message}: ${JSON.stringify(details)}`;
          recentEvents.push(rendered.length > 300 ? `${rendered.slice(0, 297)}...` : rendered);
          if (parsed.debug) console.error(`[deepclause] ${rendered}`);
          renderExecution();
        };

        try {
          const result = await executeDml(
            filePath,
            parsed.args,
            initialMessages,
            { ...config, verbose: config.verbose || parsed.debug },
            pi,
            ctx,
            controller,
            {
              onEvent,
              onDiagnostic,
              onInput: async (prompt, signal) => {
                const answer = await ctx.ui.input("DeepClause input", prompt, { signal });
                if (answer === undefined) throw new Error("Input cancelled");
                return answer;
              },
            },
            contextualPlan ? (request, signal) => runPiAgentStep(request, signal, ctx) : undefined,
          );

          const answer = result.answer ?? (result.errors.length ? result.errors.join("\n") : "DML execution finished without an answer.");
          publishResult(pi, answer, {
            skill: skillName,
            contextMode: mode,
            model: modelLabel(ctx),
            elapsedMs: Date.now() - startedAt,
            verbosity: parsed.debug ? "debug" : verbose ? "verbose" : "normal",
            usage: result.usage,
            events,
          });
          if (result.errors.length === 0) ctx.ui.notify(`DeepClause execution complete in ${elapsedSeconds(startedAt)}`, "info");
        } finally {
          clearInterval(statusTimer);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (rawArgs.includes("--debug") || rawArgs.includes("-d")) console.error(`[deepclause] execution failed: ${message}`);
        publishResult(pi, `DeepClause execution failed: ${message}`, { error: message });
        ctx.ui.notify(message, activeController?.signal.aborted ? "warning" : "error");
      } finally {
        activeController = undefined;
        activeDescription = undefined;
        ctx.ui.setStatus(STATUS_KEY, undefined);
        ctx.ui.setWidget(WIDGET_KEY, undefined);
      }
    },
  });
}
