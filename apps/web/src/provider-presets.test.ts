import { capabilityNames, publicModelNativeApi, publicModelRecommendedBackend, providerInterfaceProfiles } from "@joko/contracts";
import { expect, it } from "vitest";
import type { BackendView } from "./model.js";
import { discoveredProviderModelInterface, providerModelInterfaceOptions, providerPresetRuntime, providerPresets, updateProviderPresetEndpoint } from "./provider-presets.js";

const base: Omit<BackendView, "id" | "name"> = {
  version: "1", health: "healthy", capabilities: new Map([[capabilityNames.providerManagedCatalog, { name: capabilityNames.providerManagedCatalog, supported: true }]])
};
const claude: BackendView = { ...base, id: "claude-code", name: "Claude Code", providerRuntimeSupport: {
  protocols: ["anthropic", "openaiResponses", "openaiCompletions"], fields: ["modelEndpoint", "modelLimits", "modelInputModalities", "modelThinkingLevels"]
} };
const pi: BackendView = { ...base, id: "pi", name: "Pi", providerRuntimeSupport: {
  protocols: ["anthropic", "openaiResponses", "openaiCompletions", "google"], fields: ["modelEndpoint", "modelCompatibility", "modelLimits", "modelInputModalities", "modelThinkingLevels"]
} };
const codex: BackendView = { ...base, id: "codex", name: "Codex", providerRuntimeSupport: {
  protocols: ["openaiResponses", "openaiCompletions"], fields: ["modelEndpoint", "modelInputModalities"]
} };

it("keeps provider defaults specific to the Backend and selects exact model interfaces within that origin", () => {
  expect(providerPresets).toHaveLength(38);
  expect(providerInterfaceProfiles).toHaveLength(85);
  const router = providerPresets.find(item => item.id === "openrouter")!;
  expect(providerPresetRuntime(router, claude)).toMatchObject({ endpoint: "https://openrouter.ai/api", compatibility: "anthropic" });
  expect(providerPresetRuntime(router, codex)).toMatchObject({ endpoint: "https://openrouter.ai/api/v1", compatibility: "openaiResponses" });
  expect(providerPresetRuntime(router, pi)).toMatchObject({ endpoint: "https://openrouter.ai/api/v1", compatibility: "openaiCompletions" });
  const go = providerPresets.find(item => item.id === "opencode-go")!;
  const original = providerPresetRuntime(go, pi)!;
  expect(original.models.find(model => model.modelId === "minimax-m3")).toMatchObject({ endpoint: "https://opencode.ai/zen/go", compatibility: "anthropic" });
  expect(discoveredProviderModelInterface("gpt-5.6-luna", pi, original.endpoint)).toMatchObject({ api: "openai-responses", baseUrl: "https://opencode.ai/zen/go/v1" });
  expect(discoveredProviderModelInterface("glm-5.3-flash", claude, "https://opencode.ai/zen/go")).toMatchObject({ api: "openai-completions", baseUrl: original.endpoint });
  expect(providerModelInterfaceOptions(codex, original.endpoint, "minimax-m3")).toEqual([]);
  const edited = updateProviderPresetEndpoint(go, original, pi, "https://relay.example.test/v1");
  expect(edited.models.find(model => model.modelId === "minimax-m3")?.endpoint).toBeUndefined();
  expect(providerModelInterfaceOptions(pi, edited.endpoint, "minimax-m3")).toEqual([]);
});

it("uses declared capabilities and advisory defaults without inferring an unrelated native protocol", () => {
  const kimi = providerPresets.find(item => item.id === "moonshot-kimi-code")!;
  expect(providerPresetRuntime(kimi, pi)!.models.find(model => model.modelId === "k3.1-pro")).toMatchObject({
    compatibility: "anthropic", contextWindowTokens: 262_144, maximumOutputTokens: 262_144, defaultEffort: "max", inputModalities: ["text", "image"]
  });
  expect(discoveredProviderModelInterface("k3.1-pro", claude, "https://api.kimi.com/coding/v1")).toMatchObject({
    api: "anthropic-messages", baseUrl: "https://api.kimi.com/coding"
  });
  expect(publicModelNativeApi("openai", "chatgpt/gpt-unlisted[1m]")).toBe("openai-responses");
  expect(publicModelNativeApi("openai", "gpt-unlisted-audio", "audio_speech")).toBeUndefined();
  expect(publicModelNativeApi("anthropic", "claude-unlisted")).toBe("anthropic-messages");
  expect(publicModelNativeApi("xai", "grok-unlisted")).toBe("openai-responses");
  expect(publicModelNativeApi("arbitrary-proxy", "openai/gpt-unlisted")).toBeUndefined();
  expect(publicModelRecommendedBackend("openrouter", "qwen/qwen3.8-flash")).toBe("claude-code");
});
