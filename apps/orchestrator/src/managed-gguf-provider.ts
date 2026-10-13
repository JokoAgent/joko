import { LLAMA_CPP_OPENAI_BASE_URL } from "@joko/local-model-runtime";
import type { PiManagedProvider } from "@joko/adapter-pi";

export const MANAGED_GGUF_PROVIDER_ID = "joko-local-llama-cpp";
export const MANAGED_GGUF_MARKER = "joko-local-gguf-v1";
export function isOwnedGgufProvider(descriptor: {
  readonly provider: PiManagedProvider; readonly kind: string; readonly credentialReferenceIds: readonly string[];
}): boolean {
  const provider = descriptor.provider;
  return provider.id === MANAGED_GGUF_PROVIDER_ID && descriptor.kind === "local_keyless" && !descriptor.credentialReferenceIds.length
    && provider.baseUrl === LLAMA_CPP_OPENAI_BASE_URL && provider.api === "openai-completions" && provider.keyless === true
    && provider.apiKeyEnv === undefined && !Object.keys(provider.headers ?? {}).length && provider.compat?.["jokoManagedRuntime"] === MANAGED_GGUF_MARKER;
}
