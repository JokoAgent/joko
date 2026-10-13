import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AdapterContext } from "@joko/core";
import { atomicWriteJson } from "./config.js";
import { piError } from "./errors.js";

export function readPiWorkingContext(context: AdapterContext, providerId: string | undefined, modelId: string | undefined): number | undefined {
  if (providerId === undefined || modelId === undefined || context.resolveModelWorkingContext === undefined) return undefined;
  const tokens = context.resolveModelWorkingContext({ providerId, modelId });
  if (tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens < 1_000 || tokens > 100_000_000)) {
    throw piError("PI_WORKING_CONTEXT_INVALID", "The committed model working context is invalid", "provision");
  }
  return tokens;
}

/** Only the exact process-private model/configuration is changed. Public capacity stays in the catalog. */
export async function writePiWorkingContext(agentHome: string, selection: { providerId: string; modelId: string }, budget: number,
  capacity: number, thresholdPercent: number): Promise<number> {
  const nativeWindow = Math.max(capacity, budget);
  const models = JSON.parse(await readFile(join(agentHome, "models.json"), "utf8")) as {
    providers: Record<string, { models?: Record<string, unknown>[]; modelOverrides?: Record<string, Record<string, unknown>> }>;
  };
  const provider = models.providers[selection.providerId] ?? {};
  models.providers[selection.providerId] = provider;
  const model = provider.models?.find((candidate) => candidate["id"] === selection.modelId);
  if (model !== undefined) model["contextWindow"] = nativeWindow;
  else provider.modelOverrides = {
    ...provider.modelOverrides,
    [selection.modelId]: { ...provider.modelOverrides?.[selection.modelId], contextWindow: nativeWindow }
  };
  const settings = JSON.parse(await readFile(join(agentHome, "settings.json"), "utf8")) as Record<string, unknown>;
  const previous = settings["compaction"];
  settings["compaction"] = {
    ...(previous !== null && typeof previous === "object" && !Array.isArray(previous) ? previous : {}),
    reserveTokens: Math.max(0, nativeWindow - Math.floor(budget * thresholdPercent / 100))
  };
  await atomicWriteJson(join(agentHome, "models.json"), models);
  await atomicWriteJson(join(agentHome, "settings.json"), settings);
  return nativeWindow;
}
