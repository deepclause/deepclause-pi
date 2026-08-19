import { readdir } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DMLEvent } from "deepclause-sdk";
import { buildInitialMessages } from "./context.js";
import { loadConfig, type ContextMode } from "./config.js";
import { executeDml } from "./runtime.js";
import { getPaths, initializeWorkspace, resolveDmlPath } from "./workspace.js";

const AUTHORING_INSTRUCTION = `DeepClause programs live in .pi/deepclause/skills/. You may create and edit those DML files directly. Before changing DML, consult .pi/deepclause/AGENTS.md and .pi/deepclause/DML_REFERENCE.md. DeepClause compilation is unavailable, so generated content must already be valid DML. Execution is user-triggered through /dc-run; never invoke a compiler or create .deepclause/.`;
const STATUS_KEY = "deepclause";
const WIDGET_KEY = "deepclause-stream";

export interface ParsedRun {
  target: string;
  args: string[];
  contextMode?: ContextMode;
  verbose: boolean;
  debug: boolean;
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

function publishResult(pi: ExtensionAPI, content: string, details: Record<string, unknown>): void {
  pi.sendMessage({ customType: "deepclause-result", content, display: true, details });
}

export default function deepClauseExtension(pi: ExtensionAPI) {
  let activeController: AbortController | undefined;
  let activeDescription: string | undefined;

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${AUTHORING_INSTRUCTION}`,
  }));

  pi.on("session_shutdown", () => {
    activeController?.abort(new Error("Pi session changed or closed"));
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
        `Context: ${config.contextMode} (verbose default: ${config.verbose})`,
        "Commands:",
        "  /dc-list",
        "  /dc-run <skill|path> [args] [--context=turn|branch|isolated]",
        "  /dc-run <skill|path> --verbose   show lifecycle events",
        "  /dc-run <skill|path> --debug     show full event payloads and SDK diagnostics",
        "  /dc-cancel",
      ].join("\n");
      ctx.ui.notify(message, "info");
    },
  });

  pi.registerCommand("dc-list", {
    description: "List DeepClause DML skills",
    handler: async (_args, ctx) => {
      const paths = getPaths(ctx.cwd);
      const files = await listDmlFiles(paths.skills);
      ctx.ui.notify(files.length ? files.join("\n") : "No DML skills found. Run /dc to initialize DeepClause.", "info");
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
