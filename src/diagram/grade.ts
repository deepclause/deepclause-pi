import type { CheckResult, MermaidView } from "./validate.js";

export type DiagramGrade = "presentation" | "specification";
export type RequestedGrade = DiagramGrade | "both";

export const GRADE_SYSTEM_PROMPT =
  "You are a meticulous Mermaid v11 diagram editor. You output only valid Mermaid source, never wrapped in code fences, and you keep all facts and decision logic accurate. Never invent or drop a rule, threshold, or outcome.";

export const GRADE_PROMPTS: Record<DiagramGrade, string> = {
  presentation:
    "Produce a PRESENTATION-GRADE version: about 8-12 nodes, plain non-technical language, NO function names or framework jargon, highlight the headline numbers, the main steps and the headline decision, and add 1-2 short callouts. Keep it accurate but simple enough for a general audience; you may compress the detailed logic but must not change the final decision or omit a rule that flips it.",
  specification:
    "Produce a SPECIFICATION-GRADE (detailed engineering) version: keep the technical detail (function names, task/tool roles, post-conditions, seed data) AND the domain decision logic. Preserve the decision predicates from the seed's `LOGIC` section — each with its exact conditions, thresholds and outcomes — and every `RULES` fact table. You may group or collapse pure arithmetic, date and formatting helpers, but never drop or alter a domain rule, threshold or outcome. Expand each retained logic block from the DML source. Improve labels, grouping and readability so an engineer can trace every domain decision precisely.",
};

/**
 * Map free-form user/tool wording onto a supported grade. Returns undefined when
 * nothing matches so the caller can apply its default.
 */
export function resolveGrade(text: string): RequestedGrade | undefined {
  const value = text.toLowerCase();
  if (/\bboth\b/.test(value)) return "both";
  if (/(specification|spec\b|detailed|technical|engineering|developer)/.test(value)) return "specification";
  if (/(presentation|present|simple|executive|slide|high[- ]level|overview)/.test(value)) return "presentation";
  return undefined;
}

export function stripFences(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("```"))
    .join("\n")
    .trim();
}

function buildPrompt(grade: DiagramGrade, view: MermaidView, source: string, seed: string, feedback: string): string {
  const syntax = view === "sequence" ? "sequenceDiagram" : "flowchart TD";
  return [
    GRADE_PROMPTS[grade],
    "",
    `Rules: output ONLY Mermaid v11 source (no code fences); keep it a '${syntax}' diagram; keep the facts and decision logic accurate; preserve the seed's domain LOGIC blocks (conditions, thresholds, outcomes) and RULES facts instead of collapsing them into generic nodes, while grouping pure arithmetic/date/format helpers; do not use reserved words such as 'end' as node ids or class names.`,
    "",
    "DML source:",
    source,
    "",
    "Current diagram:",
    seed,
    "",
    feedback,
  ].join("\n");
}

export interface CompleteOptions {
  systemPrompt: string;
  prompt: string;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface PolishOptions {
  grade: DiagramGrade;
  view: MermaidView;
  source: string;
  seed: string;
  maxTokens: number;
  maxRounds?: number;
  signal?: AbortSignal;
  complete: (options: CompleteOptions) => Promise<{ text: string }>;
  validate: (code: string) => Promise<CheckResult>;
  onProgress?: (message: string) => void;
}

export interface PolishResult {
  code: string;
  rounds: number;
}

/**
 * Ask the active pi model to rewrite the deterministic seed in the requested
 * grade, validating each attempt and feeding failures back until it parses or
 * the round budget is exhausted.
 */
export async function polishDiagram(options: PolishOptions): Promise<PolishResult> {
  const maxRounds = Math.max(1, Math.min(options.maxRounds ?? 3, 6));
  let feedback = `This is the first attempt at the ${options.grade} grade.`;
  for (let round = 1; round <= maxRounds; round++) {
    options.onProgress?.(`Generating ${options.grade} diagram (attempt ${round}/${maxRounds})…`);
    const response = await options.complete({
      systemPrompt: GRADE_SYSTEM_PROMPT,
      prompt: buildPrompt(options.grade, options.view, options.source, options.seed, feedback),
      maxTokens: options.maxTokens,
      signal: options.signal,
    });
    const candidate = stripFences(response.text);
    if (!candidate) {
      feedback = "Your previous attempt was empty. Return only Mermaid source.";
      continue;
    }
    const check = await options.validate(candidate);
    if (check.ok) return { code: candidate, rounds: round };
    feedback = `Your previous attempt failed validation: ${check.error}. Fix exactly that and return only Mermaid source.`;
  }
  throw new Error(`Could not produce a valid ${options.grade} diagram after ${maxRounds} attempts (${feedback})`);
}
