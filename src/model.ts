import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";

export interface TextCompletion {
  text: string;
  usage?: Usage;
}

/**
 * One-shot text completion through pi's active model and credentials. Used by
 * diagram grading; it never requests API keys or mutates provider state.
 */
export async function completeTextWithPiModel(
  ctx: ExtensionContext,
  options: { systemPrompt?: string; prompt: string; maxTokens: number; signal?: AbortSignal },
): Promise<TextCompletion> {
  const model = ctx.model;
  if (!model) throw new Error("Select a pi model before generating a diagram grade");
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(`Pi has no configured authentication for ${model.provider}/${model.id}`);
  }

  const response = await ctx.modelRegistry.complete(
    model,
    {
      systemPrompt: options.systemPrompt,
      messages: [{ role: "user", content: options.prompt, timestamp: Date.now() }],
    },
    {
      signal: options.signal,
      maxTokens: options.maxTokens,
      cacheRetention: "none",
    },
  );

  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage || `Pi model request ${response.stopReason}`);
  }

  const text = response.content
    .filter((content): content is Extract<typeof response.content[number], { type: "text" }> => content.type === "text")
    .map((content) => content.text)
    .join("");

  return { text, usage: response.usage };
}
