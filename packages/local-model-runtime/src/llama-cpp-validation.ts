import { createHash } from "node:crypto";
import type { LlamaCppModel, LlamaCppSelection } from "./llama-cpp-types.js";
import { LLAMA_CPP_DEFAULT_CONTEXT, LlamaCppRuntimeError } from "./llama-cpp-types.js";

export function validLlamaCppRepository(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/u.test(value);
}
export function validLlamaCppFile(value: unknown): value is string {
  return typeof value === "string" && value.length <= 240
    && value.split("/").every(part => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(part))
    && value.endsWith(".gguf") && !/^(mmproj|mtp|dflash)[-_.]/iu.test(value.split("/").at(-1)!);
}
export function assertLlamaCppSelection(value: LlamaCppSelection): void {
  if (!validLlamaCppRepository(value.repository) || !validLlamaCppFile(value.file)) {
    throw new LlamaCppRuntimeError("MODEL_INVALID", "INVALID_MODEL", "Choose a valid GGUF repository and file.");
  }
}
export function llamaCppModelId(selection: LlamaCppSelection): string {
  return `model-${createHash("sha256").update(`${selection.repository}/${selection.file.replace(/-\d{5}-of-\d{5}\.gguf$/u, ".gguf")}`).digest("hex").slice(0, 24)}`;
}
export function llamaCppContextSize(model: Pick<LlamaCppModel, "repository">): number {
  return model.repository === "bartowski/Qwen3.8-Flash-Next-GGUF" ? 262144 : LLAMA_CPP_DEFAULT_CONTEXT;
}
export function llamaCppMaximumContext(model: Pick<LlamaCppModel, "repository">): number {
  return model.repository === "bartowski/Qwen3.8-Flash-Next-GGUF" ? 1_000_000 : LLAMA_CPP_DEFAULT_CONTEXT;
}
export function llamaCppModelPreset(model: LlamaCppModel, limits: readonly number[]): readonly string[] {
  if (limits.some(value => !Number.isSafeInteger(value) || value < 1000 || value > llamaCppMaximumContext(model))) {
    throw new LlamaCppRuntimeError("MODEL_INVALID", "INVALID_CONTEXT", "The model context budget is unavailable.");
  }
  const context = Math.max(llamaCppContextSize(model), ...limits), extended = context > 262144;
  return [`[${model.id}]`, `ctx-size = ${context}`,
    ...(extended ? ["rope-scaling = yarn", "rope-scale = 4", "yarn-orig-ctx = 262144"] : [])];
}
export function sameLlamaCppSelection(left: LlamaCppSelection | undefined, right: LlamaCppSelection | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && left.repository === right.repository && left.file === right.file;
}
