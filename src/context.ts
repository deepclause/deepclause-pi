import type { MemoryMessage } from "deepclause-sdk";
import type { ContextMode } from "./config.js";

type SessionEntry = {
  type?: string;
  message?: { role?: string; content?: unknown };
  summary?: string;
};

type ContentBlock = { type?: string; text?: string };

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is ContentBlock => Boolean(block) && typeof block === "object")
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function entryToMessage(entry: SessionEntry): MemoryMessage | undefined {
  if (entry.type === "compaction" && typeof entry.summary === "string") {
    return { role: "system", content: `Compacted pi session context:\n${entry.summary}` };
  }
  if (entry.type !== "message" || !entry.message) return undefined;
  if (entry.message.role !== "user" && entry.message.role !== "assistant") return undefined;
  const content = textContent(entry.message.content).trim();
  return content ? { role: entry.message.role, content } : undefined;
}

export function buildInitialMessages(
  entries: readonly unknown[],
  mode: ContextMode,
  branchMessageLimit: number,
): MemoryMessage[] {
  if (mode === "isolated") return [];
  const messages = (entries as SessionEntry[])
    .map(entryToMessage)
    .filter((message): message is MemoryMessage => message !== undefined);

  if (mode === "branch") return messages.slice(-branchMessageLimit);

  const immediate: MemoryMessage[] = [];
  for (let index = messages.length - 1; index >= 0 && immediate.length < 2; index--) {
    const message = messages[index];
    if (message) immediate.unshift(message);
  }
  return immediate;
}
