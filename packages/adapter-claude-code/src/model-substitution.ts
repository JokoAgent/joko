interface ModelUsage {
  readonly model: string;
  readonly tokens: readonly number[];
}

function family(model: string): string {
  return model.trim().toLowerCase().replace(/\[[^\]]*\]\s*$/u, "").trim()
    .replace(/-\d{8}$/u, "").replace(/-latest$/u, "")
    .replace(/^(?:us\.|eu\.)?anthropic\./u, "").replace(/^codex\//u, "")
    .replace(/\./gu, "-").replace(/^claude-/u, "");
}
const nativeFamily = (value: string): boolean => /^(opus|sonnet|haiku|fable)(-|$)/u.test(value);
const modelId = (value: string): boolean => value.length > 0 && value.length <= 256
  && !/[\u0000-\u0020\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value);
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Query-local cumulative observations. Only models with new native usage participate in this result. */
export class NativeModelUsageObserver {
  #previous = new Map<string, readonly number[]>();
  #observed = new Map<string, readonly number[]>();

  observeAssistant(value: unknown): void {
    const message = record(value);
    const model = message?.["model"];
    const usage = record(message?.["usage"]);
    if (typeof model !== "string" || !modelId(model) || !usage || this.#observed.size >= 256 && !this.#observed.has(model)) return;
    const tokens = [usage["input_tokens"], usage["output_tokens"], usage["cache_read_input_tokens"] ?? 0, usage["cache_creation_input_tokens"] ?? 0];
    if (tokens.some(value => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) return;
    const previous = this.#observed.get(model);
    this.#observed.set(model, (tokens as number[]).map((value, index) => value + (previous?.[index] ?? 0)));
  }

  observe(value: unknown, selectedModel: string | undefined): { readonly selectedModelId: string; readonly actualModelId: string } | undefined {
    const observed = this.#observed;
    this.#observed = new Map();
    const models = record(value);
    if (!models || Object.keys(models).length > 256) { this.#previous.clear(); return undefined; }
    const deltas: ModelUsage[] = [];
    for (const [model, raw] of Object.entries(models)) {
      const usage = record(raw);
      if (!modelId(model) || !usage) continue;
      if (this.#previous.size >= 256 && !this.#previous.has(model)) continue;
      const tokens = [usage["inputTokens"], usage["outputTokens"], usage["cacheReadInputTokens"] ?? 0, usage["cacheCreationInputTokens"] ?? 0];
      if (tokens.some(value => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) continue;
      const current = tokens as number[];
      const previous = this.#previous.get(model);
      const unbaselined = previous === undefined || current.some((count, index) => count < previous[index]!);
      // A resumed Query may report historical totals on its first result. Current assistant usage
      // proves the occurrence without assigning those historical models to this user turn.
      const delta = unbaselined ? observed.get(model) ?? [0, 0, 0, 0]
        : current.map((count, index) => Math.max(0, count - previous[index]!));
      this.#previous.set(model, current);
      if (delta.some(value => value > 0)) deltas.push({ model, tokens: delta });
    }
    // A missing selected family is meaningful only within an explicit native model-usage observation.
    if (!selectedModel || !modelId(selectedModel) || !nativeFamily(family(selectedModel))) return undefined;
    const candidates = deltas.filter(entry => nativeFamily(family(entry.model)));
    if (!candidates.length || candidates.some(entry => family(entry.model) === family(selectedModel))) return undefined;
    const actual = candidates.reduce((largest, entry) => entry.tokens[1]! > largest.tokens[1]! ? entry : largest);
    return { selectedModelId: selectedModel, actualModelId: actual.model };
  }
}
