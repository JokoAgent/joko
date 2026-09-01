export interface CodexModelEstimate {
  readonly contextWindow: number;
  readonly maximumOutputTokens: number;
  readonly price?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
  };
}

export const CODEX_MODEL_ESTIMATES_UPDATED_AT = Date.UTC(2026, 7, 29, 1, 20);

const MODEL_ESTIMATES: Readonly<Record<string, CodexModelEstimate>> = Object.freeze({
  "gpt-5.6-sol": estimate(272_000, 128_000, 4, 20, 0.4, 5),
  "gpt-5.6-terra": estimate(272_000, 128_000, 2, 12, 0.2, 2.5),
  "gpt-5.6-luna": estimate(272_000, 128_000, 0.2, 1.2, 0.02, 0.25),
  "gpt-5.5": estimate(272_000, 128_000, 5, 30, 0.5),
  "gpt-5.4": estimate(272_000, 128_000, 2.5, 15, 0.25),
  "gpt-5.4-mini": estimate(272_000, 128_000, 0.75, 4.5, 0.075),
  "gpt-5.4-nano": estimate(400_000, 128_000, 0.2, 1.25, 0.02),
  "gpt-5.4-pro": estimate(1_050_000, 128_000),
  "gpt-5.5-pro": estimate(1_050_000, 128_000),
  "gpt-5.6-cyber": estimate(400_000, 128_000),
  "gpt-5.3-codex-spark": estimate(272_000, 128_000),
  "gpt-reserve": estimate(272_000, 128_000),
  "codex-auto-review": estimate(272_000, 128_000)
});

export function codexModelEstimate(modelId: string): CodexModelEstimate | undefined {
  return MODEL_ESTIMATES[modelId.trim().toLocaleLowerCase()];
}

function estimate(
  contextWindow: number,
  maximumOutputTokens: number,
  input?: number,
  output?: number,
  cacheRead?: number,
  cacheWrite?: number
): CodexModelEstimate {
  return {
    contextWindow,
    maximumOutputTokens,
    ...(input === undefined || output === undefined ? {} : {
      price: {
        input,
        output,
        ...(cacheRead === undefined ? {} : { cacheRead }),
        ...(cacheWrite === undefined ? {} : { cacheWrite })
      }
    })
  };
}
