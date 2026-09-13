import type { RuntimePublicErrorCode } from "./types.js";

export class LocalRuntimeError extends Error {
  constructor(readonly code: RuntimePublicErrorCode, message: string) {
    super(message);
    this.name = "LocalRuntimeError";
  }
}

export function publicRuntimeError(error: unknown): LocalRuntimeError {
  if (error instanceof LocalRuntimeError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new LocalRuntimeError("OPERATION_CANCELLED", "The operation was cancelled.");
  }
  return new LocalRuntimeError("RUNTIME_ERROR", "The local model runtime operation failed.");
}

export function pullError(error: unknown, modelName: string): LocalRuntimeError {
  if (error instanceof LocalRuntimeError) return error;
  const text = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (modelName.toLowerCase().startsWith("hf.co/") && /mlx/u.test(modelName) && !/gguf/u.test(modelName)) {
    return new LocalRuntimeError("MODEL_INCOMPATIBLE", "The selected repository does not contain a compatible GGUF model.");
  }
  if (/not gguf|not compatible with llama\.cpp/u.test(text)) {
    return new LocalRuntimeError("MODEL_INCOMPATIBLE", "The selected model is incompatible with this runtime.");
  }
  if (/\b401\b|unauthorized|gated|access denied/u.test(text)) {
    return new LocalRuntimeError("MODEL_UNAUTHORIZED", "The selected model requires access that the runtime does not have.");
  }
  if (/\b404\b|not found|does not exist/u.test(text)) {
    return new LocalRuntimeError("MODEL_NOT_FOUND", "The selected model could not be found.");
  }
  if (/abort/u.test(text)) {
    return new LocalRuntimeError("OPERATION_CANCELLED", "The operation was cancelled.");
  }
  if (/refused|not reachable|econnreset/u.test(text)) {
    return new LocalRuntimeError("RUNTIME_UNREACHABLE", "The local model runtime is not reachable.");
  }
  return new LocalRuntimeError("RUNTIME_ERROR", "The local model operation failed.");
}
