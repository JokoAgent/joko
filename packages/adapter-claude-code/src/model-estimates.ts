import type { ProviderModel } from "@joko/core";

export interface ClaudeModelEstimate {
  readonly contextWindow?: number;
  readonly maximumOutputTokens?: number;
  readonly supportsImages?: boolean;
  readonly defaultVisible?: boolean;
  readonly thinkingLevels?: readonly string[];
  readonly defaultEffort?: string;
  readonly fastModeMultiplier?: NonNullable<ProviderModel["pricing"]>["fastModeMultiplier"];
  readonly updatedAt?: number;
  readonly price?: ProviderModel["cost"];
}

const MODEL_ESTIMATES: Readonly<Record<string, ClaudeModelEstimate>> = Object.freeze({
  "claude-opus-5-5": {
    contextWindow: 1_000_000,
    maximumOutputTokens: 128_000,
    supportsImages: true,
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    fastModeMultiplier: 2,
    updatedAt: Date.UTC(2026, 8, 23),
    price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }
  },
  "claude-sonnet-5-5": {
    contextWindow: 1_000_000,
    maximumOutputTokens: 128_000,
    supportsImages: true,
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium"
  },
  "claude-haiku-5-5": {
    contextWindow: 1_000_000,
    maximumOutputTokens: 128_000,
    supportsImages: true,
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium"
  },
  "claude-fable-5": { defaultVisible: false },
  "claude-opus-5": { defaultVisible: false },
  "claude-opus-4-8": { defaultVisible: false }
});

export function claudeModelEstimate(modelId: string): ClaudeModelEstimate | undefined {
  return MODEL_ESTIMATES[modelId.trim().toLocaleLowerCase()];
}
