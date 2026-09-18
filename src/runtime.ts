import { realpath, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDeepClause } from "deepclause-sdk";
import type {
  DMLEvent,
  LLMBackend,
  LLMBackendMessage,
  LLMUsage,
  MemoryMessage,
  DeepClauseSDK,
} from "deepclause-sdk";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { DeepClauseConfig } from "./config.js";
import { PI_AGENT_STEP_TOOL } from "./planner.js";

export const PI_WORKSPACE_LIST_TOOL = "pi_workspace_list";
export const PI_BASH_TOOL = "pi_bash";
export const DC_VERIFY_RUN_TOOL = "dc_verify_run";
export const DC_APPLY_SNAPSHOT_TOOL = "dc_apply_snapshot";
export const DC_APPLY_ACCEPT_TOOL = "dc_apply_accept";
export const DC_APPLY_RESTORE_TOOL = "dc_apply_restore";

async function readChangeJson(changeJsonPath: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(changeJsonPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function patchChangeJson(changeJsonPath: string, patch: Record<string, unknown>): Promise<void> {
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(changeJsonPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
  } catch {
    // start a fresh manifest
  }
  await writeFile(changeJsonPath, `${JSON.stringify({ ...existing, ...patch }, null, 2)}\n`, "utf8");
}

/**
 * Record a git snapshot ref, refusing a dirty working tree. If an apply is already
 * in progress for this change, the existing ref is returned so the run resumes
 * instead of starting over or rejecting the (intentionally) dirty tree.
 */
export async function gitSnapshot(pi: Pick<ExtensionAPI, "exec">, cwd: string, changeJsonPath: string): Promise<string> {
  const existing = await readChangeJson(changeJsonPath);
  const resumable = typeof existing.snapshot === "string" && existing.snapshot && existing.applyState === "in_progress";
  if (resumable) return existing.snapshot as string;

  const status = await pi.exec("git", ["status", "--porcelain"], { cwd });
  if (status.code !== 0) throw new Error("git is unavailable or this is not a repository");
  if (status.stdout.trim()) throw new Error("working tree is dirty; commit or stash before applying, or resume with /dc-apply (which preserves an interrupted apply)");
  const head = await pi.exec("git", ["rev-parse", "HEAD"], { cwd });
  if (head.code !== 0) throw new Error("could not read git HEAD");
  const ref = head.stdout.trim();
  await patchChangeJson(changeJsonPath, { snapshot: ref, applyState: "in_progress" });
  return ref;
}

/** Restore the recorded snapshot (hard reset plus clean of untracked files). */
export async function gitRestore(pi: Pick<ExtensionAPI, "exec">, cwd: string, changeJsonPath: string): Promise<string | null> {
  const existing = await readChangeJson(changeJsonPath);
  const ref = typeof existing.snapshot === "string" && existing.snapshot ? existing.snapshot : null;
  if (!ref) return null;
  await pi.exec("git", ["reset", "--hard", ref], { cwd });
  await pi.exec("git", ["clean", "-fd"], { cwd });
  await patchChangeJson(changeJsonPath, { snapshot: null, applyState: "aborted" });
  return ref;
}

/** Mark the apply accepted and clear the snapshot. */
export async function gitAccept(changeJsonPath: string): Promise<void> {
  await patchChangeJson(changeJsonPath, { snapshot: null, applyState: "done" });
}

export type BashApproval = (command: string, signal: AbortSignal) => Promise<boolean>;

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function registerPiRuntimeTools(
  sdk: DeepClauseSDK,
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  signal: AbortSignal,
  approveBash: BashApproval = async () => false,
): void {
  sdk.registerTool(PI_WORKSPACE_LIST_TOOL, {
    description: "List the direct children of a directory inside pi's active workspace. Read-only; paths cannot escape the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative directory path, such as . or src" },
      },
      required: ["path"],
    },
    execute: async (args) => {
      const requestedPath = typeof args.path === "string" ? args.path : ".";
      if (path.isAbsolute(requestedPath)) throw new Error("pi_workspace_list requires a relative path");
      const workspace = await realpath(cwd);
      const candidate = await realpath(path.resolve(workspace, requestedPath));
      if (!isInside(workspace, candidate)) throw new Error("pi_workspace_list path escapes the active workspace");

      const commandResult = await pi.exec(
        "find",
        [candidate, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\\n"],
        { cwd: workspace, signal, timeout: 10_000 },
      );
      if (commandResult.code !== 0) {
        throw new Error(commandResult.stderr.trim() || `find exited with code ${commandResult.code}`);
      }
      return {
        path: requestedPath,
        entries: commandResult.stdout.split("\n").filter(Boolean).sort(),
        host: "pi.exec",
      };
    },
  });

  sdk.registerTool(PI_BASH_TOOL, {
    description: "Run an executable with an argument array, or a bash command string, in pi's active workspace after explicit user approval. Returns stdout, stderr, exitCode, and killed.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Executable name in argv mode, or exact bash command in shell mode" },
        args: { type: "array", description: "Optional argument strings. When provided, executes command directly without shell parsing." },
      },
      required: ["command"],
    },
    execute: async (args) => {
      const command = typeof args.command === "string" ? args.command.trim() : "";
      if (!command) throw new Error("pi_bash requires a non-empty command");
      const commandArgs = Array.isArray(args.args) ? args.args.map((arg) => String(arg)) : undefined;
      const displayCommand = commandArgs
        ? [command, ...commandArgs].map((part) => JSON.stringify(part)).join(" ")
        : command;
      if (!await approveBash(displayCommand, signal)) throw new Error("pi_bash command was not approved");

      const workspace = await realpath(cwd);
      const commandResult = await pi.exec(commandArgs ? command : "bash", commandArgs ?? ["-lc", command], {
        cwd: workspace,
        signal,
        timeout: 60_000,
      });
      return {
        command,
        args: commandArgs,
        stdout: commandResult.stdout,
        stderr: commandResult.stderr,
        exitCode: commandResult.code,
        killed: commandResult.killed,
        host: "pi.exec",
      };
    },
  });
}

const emptyUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function toPiMessages(messages: LLMBackendMessage[], model: NonNullable<ExtensionContext["model"]>): Message[] {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (message.role === "assistant" && message.providerData) {
        return message.providerData as AssistantMessage;
      }
      if (message.role === "user") {
        return { role: "user" as const, content: message.content, timestamp: Date.now() };
      }
      if (message.role === "tool") {
        return {
          role: "toolResult" as const,
          toolCallId: message.toolCallId ?? "unknown",
          toolName: message.toolName ?? "unknown",
          content: [{ type: "text" as const, text: message.content }],
          isError: false,
          timestamp: Date.now(),
        };
      }
      return {
        role: "assistant" as const,
        content: [
          ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
          ...(message.toolCalls ?? []).map((call) => ({
            type: "toolCall" as const,
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          })),
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        stopReason: message.toolCalls?.length ? "toolUse" as const : "stop" as const,
        timestamp: Date.now(),
      };
    });
}

function createPiBackend(
  ctx: ExtensionContext,
  maxTokens: number,
  onDiagnostic: (message: string, details?: unknown) => void,
): LLMBackend {
  const model = ctx.model;
  if (!model) throw new Error("Pi has no active model");
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(`Pi has no configured authentication for ${model.provider}/${model.id}`);
  }

  return {
    async complete(request) {
      const systemPrompt = request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
      onDiagnostic("model request", {
        model: `${model.provider}/${model.id}`,
        messages: request.messages.length,
        messagePreview: request.messages.map((message) => ({
          role: message.role,
          content: message.content.slice(0, 1_000),
          toolCalls: message.toolCalls?.map((call) => call.name),
        })),
        tools: request.tools?.map((tool) => tool.name) ?? [],
        maxTokens: request.maxTokens ?? maxTokens,
      });
      const response = await ctx.modelRegistry.complete(
        model,
        {
          systemPrompt: systemPrompt || undefined,
          messages: toPiMessages(request.messages, model),
          tools: request.tools?.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters as never,
          })),
        },
        {
          signal: request.signal,
          maxTokens: request.maxTokens ?? maxTokens,
          cacheRetention: "none",
        },
      );

      onDiagnostic("model response", {
        stopReason: response.stopReason,
        error: response.errorMessage,
        contentTypes: response.content.map((content) => content.type),
        usage: response.usage,
      });
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(response.errorMessage || `Pi model request ${response.stopReason}`);
      }

      const text = response.content
        .filter((content): content is Extract<typeof response.content[number], { type: "text" }> => content.type === "text")
        .map((content) => content.text)
        .join("");
      if (text) request.onText?.(text);

      return {
        text,
        toolCalls: response.content
          .filter((content): content is Extract<typeof response.content[number], { type: "toolCall" }> => content.type === "toolCall")
          .map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
        usage: {
          inputTokens: response.usage.input,
          outputTokens: response.usage.output,
          totalTokens: response.usage.totalTokens,
          cacheReadTokens: response.usage.cacheRead || undefined,
          cacheWriteTokens: response.usage.cacheWrite || undefined,
          reasoningTokens: response.usage.reasoning,
        },
        finishReason: response.stopReason === "toolUse"
          ? "tool_use"
          : response.stopReason === "length"
            ? "length"
            : "stop",
          providerData: response,
      };
    },
  };
}

export interface ExecutionCallbacks {
  onEvent(event: DMLEvent): void;
  onInput(prompt: string, signal: AbortSignal): Promise<string>;
  onDiagnostic?(message: string, details?: unknown): void;
}

export interface PiAgentStepRequest {
  instruction: string;
  tools: string[];
  expected: string;
  skills: string[];
}

export interface PiAgentStepResult {
  success: boolean;
  summary: string;
  toolsUsed: string[];
  errors: string[];
}

export interface ExecutionResult {
  answer?: string;
  errors: string[];
  usage: LLMUsage;
}

export async function executeDml(
  filePath: string,
  args: string[],
  initialMessages: MemoryMessage[],
  config: DeepClauseConfig,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  controller: AbortController,
  callbacks: ExecutionCallbacks,
  runPiAgentStep?: (request: PiAgentStepRequest, signal: AbortSignal) => Promise<PiAgentStepResult>,
  verifyCommands: string[] = [],
  applyChangeJsonPath?: string,
): Promise<ExecutionResult> {
  const model = ctx.model;
  if (!model) throw new Error("Select a pi model before running DeepClause");
  const backend = createPiBackend(ctx, config.maxTokens, callbacks.onDiagnostic ?? (() => {}));
  const sdk = await createDeepClause({
    model: model.id,
    maxTokens: config.maxTokens,
    streaming: true,
    debug: config.verbose,
    llmBackend: backend,
  });
  registerPiRuntimeTools(
    sdk,
    pi,
    ctx.cwd,
    controller.signal,
    async (command, signal) => {
      if (!ctx.hasUI) return false;
      return ctx.ui.confirm(
        "Approve DeepClause bash command?",
        `The DML program requests execution in ${ctx.cwd}:\n\n${command}`,
        { signal },
      );
    },
  );
  if (runPiAgentStep) {
    sdk.registerTool(PI_AGENT_STEP_TOOL, {
      description: "Delegate one bounded plan step to pi using its current session context, skills, active tools, UI, approvals, and extension hooks.",
      parameters: {
        type: "object",
        properties: {
          instruction: { type: "string" },
          tools: { type: "array", description: "Exact active pi tool names allowed for this step" },
          expected: { type: "string" },
          skills: { type: "array", description: "Relevant loaded pi skill names" },
        },
        required: ["instruction", "tools", "expected", "skills"],
      },
      execute: async (args) => {
        const result = await runPiAgentStep({
          instruction: typeof args.instruction === "string" ? args.instruction : "",
          tools: Array.isArray(args.tools) ? args.tools.map(String) : [],
          expected: typeof args.expected === "string" ? args.expected : "",
          skills: Array.isArray(args.skills) ? args.skills.map(String) : [],
        }, controller.signal);
        if (!result.success) {
          throw new Error(result.errors.join("; ") || result.summary || "Delegated pi plan step failed");
        }
        return result.summary;
      },
    });
  }
  if (verifyCommands.length > 0) {
    sdk.registerTool(DC_VERIFY_RUN_TOOL, {
      description: "Run one of the change's pre-approved verification commands in the workspace and return its exit code, stdout and stderr.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Exact approved command string" },
        },
        required: ["command"],
      },
      execute: async (args) => {
        const command = typeof args.command === "string" ? args.command.trim() : "";
        if (!verifyCommands.includes(command)) {
          throw new Error(`verification command was not approved for this run: ${command}`);
        }
        const result = await pi.exec("bash", ["-lc", command], {
          cwd: ctx.cwd,
          signal: controller.signal,
          timeout: 120_000,
        });
        return { command, stdout: result.stdout, stderr: result.stderr, exitCode: result.code, killed: result.killed };
      },
    });
  }

  if (applyChangeJsonPath) {
    const changeJsonPath = applyChangeJsonPath;
    sdk.registerTool(DC_APPLY_SNAPSHOT_TOOL, {
      description: "Record a git snapshot of the workspace before applying tasks. Refuses a dirty working tree.",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => gitSnapshot(pi, ctx.cwd, changeJsonPath),
    });
    sdk.registerTool(DC_APPLY_ACCEPT_TOOL, {
      description: "Accept the apply so the working tree is not restored.",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => {
        await gitAccept(changeJsonPath);
        return "accepted";
      },
    });
    sdk.registerTool(DC_APPLY_RESTORE_TOOL, {
      description: "Restore the recorded snapshot, discarding task changes.",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => (await gitRestore(pi, ctx.cwd, changeJsonPath)) ?? "none",
    });
  }

  sdk.setToolPolicy({
    mode: "whitelist",
    tools: [
      PI_WORKSPACE_LIST_TOOL,
      PI_BASH_TOOL,
      ...(runPiAgentStep ? [PI_AGENT_STEP_TOOL] : []),
      ...(verifyCommands.length > 0 ? [DC_VERIFY_RUN_TOOL] : []),
      ...(applyChangeJsonPath ? [DC_APPLY_SNAPSHOT_TOOL, DC_APPLY_ACCEPT_TOOL, DC_APPLY_RESTORE_TOOL] : []),
    ],
  });

  const result: ExecutionResult = {
    errors: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };

  try {
    const code = await readFile(filePath, "utf8");
    for await (const event of sdk.runDML(code, {
      args,
      workspacePath: ctx.cwd,
      gasLimit: config.gasLimit,
      signal: controller.signal,
      initialMessages,
      onUserInput: (prompt) => callbacks.onInput(prompt, controller.signal),
    })) {
      callbacks.onEvent(event);
      if (event.type === "answer") result.answer = event.content;
      if (event.type === "error" && event.content) result.errors.push(event.content);
      if (event.type === "usage" && event.usage) {
        result.usage.inputTokens += event.usage.inputTokens;
        result.usage.outputTokens += event.usage.outputTokens;
        result.usage.totalTokens += event.usage.totalTokens;
        result.usage.cacheReadTokens = (result.usage.cacheReadTokens ?? 0) + (event.usage.cacheReadTokens ?? 0);
        result.usage.cacheWriteTokens = (result.usage.cacheWriteTokens ?? 0) + (event.usage.cacheWriteTokens ?? 0);
        result.usage.reasoningTokens = (result.usage.reasoningTokens ?? 0) + (event.usage.reasoningTokens ?? 0);
      }
    }
  } finally {
    await sdk.dispose();
  }
  return result;
}
