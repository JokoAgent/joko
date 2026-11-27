import { capabilityNames, publicModelNativeApi, publicModelRecommendedBackend, publicProviderModel, providerInterfaceProfiles } from "@joko/contracts";
import { expect, it } from "vitest";
import type { BackendView } from "./model.js";
import { discoveredProviderModelInterface, providerModelInterfaceOptions, providerPresetMatches, providerPresetName, providerPresetRuntime, providerPresets, updateProviderPresetEndpoint } from "./provider-presets.js";

const base: Omit<BackendView, "id" | "name"> = {
  version: "1", health: "healthy", capabilities: new Map([[capabilityNames.providerManagedCatalog, { name: capabilityNames.providerManagedCatalog, supported: true, options: [] }]])
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

it("keeps both regional routes together and identifies each MiMo plan before selection", () => {
  const ids = providerPresets.map(preset => preset.id);
  expect(ids.indexOf("zhipu-glm-cn")).toBe(ids.indexOf("zhipu-glm-global") + 1);
  expect(ids.indexOf("zhipu-coding-plan-cn")).toBe(ids.indexOf("zai-coding-plan-global") + 1);
  const mainland = providerPresets.find(preset => preset.id === "xiaomi-mimo-token-plan-cn")!;
  expect(providerPresetName(mainland, "en-US")).toBe("Xiaomi MiMo Token Plan (Mainland China)");
  expect(providerPresetName(mainland, "zh-CN")).toBe("小米 MiMo Token Plan (中国大陆)");
  expect(providerPresetMatches(mainland, "mainland china")).toBe(true);
  expect(providerPresetMatches(providerPresets.find(preset => preset.id === "xiaomi-token-plan-sgp")!, "新加坡")).toBe(true);
});

it("keeps provider defaults specific to the Backend and selects exact model interfaces within that origin", () => {
  expect(providerPresets.length).toBeGreaterThan(38);
  expect(providerInterfaceProfiles).toHaveLength(88);
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

it("discovers Token Rhythm models on the selected Backend and limits coding-plan models to their declared engines", () => {
  const token = providerPresets.find(preset => preset.id === "tokenrhythm")!;
  for (const [backend, compatibility, api] of [[claude, "anthropic", "anthropic-messages"], [codex, "openaiResponses", "openai-responses"],
    [pi, "openaiCompletions", "openai-completions"]] as const) {
    const endpoint = backend.id === "claude-code" ? "https://tokenrhythm.studio" : "https://tokenrhythm.studio/v1";
    const enabled: BackendView = { ...backend, providerRuntimeSupport: { ...backend.providerRuntimeSupport!, fields: [...backend.providerRuntimeSupport!.fields, "modelsEndpoint"] } };
    expect(providerPresetRuntime(token, enabled)).toMatchObject({ endpoint, compatibility, modelsEndpoint: "https://tokenrhythm.studio/v1/models", models: [] });
    expect(discoveredProviderModelInterface("discovered", enabled, endpoint)?.api).toBe(api);
    for (const id of ["zai-coding-plan-global", "zhipu-coding-plan-cn"]) {
      const models = providerPresetRuntime(providerPresets.find(preset => preset.id === id)!, backend)!.models;
      expect(models.filter(model => model.modelId.startsWith("glm-5.4")).map(model => model.modelId))
        .toEqual([backend.id === "claude-code" ? "glm-5.4[1m]" : "glm-5.4"]);
    }
  }
  const gemini = providerPresetRuntime(providerPresets.find(preset => preset.id === "google-gemini-api")!, pi)!;
  expect(gemini.models.find(model => model.modelId === "gemini-4-neon")).toMatchObject({ contextWindowTokens: 1_048_576, maximumOutputTokens: 65_536 });
  expect(gemini.models.find(model => model.modelId === "gemini-3.5-flash")?.defaultVisible).toBe(false);
});

it("finds published Groq and Nous presets without borrowing a different origin or unsupported runtime", () => {
  const groq = providerPresets.find(preset => providerPresetMatches(preset, "groq"))!;
  const nous = providerPresets.find(preset => providerPresetMatches(preset, "nous"))!;
  expect(providerPresetRuntime(groq, pi)).toMatchObject({ endpoint: "https://api.groq.com/openai/v1", compatibility: "openaiCompletions",
    credentialId: "", models: expect.arrayContaining([expect.objectContaining({ modelId: "llama-3.1-8b-instant", defaultVisible: false })]) });
  expect(providerPresetRuntime(groq, pi)?.models).toHaveLength(7);
  expect(providerPresetRuntime(groq, { ...pi, providerRuntimeSupport: { protocols: ["anthropic"], fields: [] } })).toBeUndefined();
  expect(providerPresetRuntime(nous, pi)).toMatchObject({ endpoint: "https://inference-api.nousresearch.com/v1", models: [] });
  expect(providerPresets.some(preset => preset.id === "openai-codex")).toBe(false);
  const router = providerPresets.find(preset => preset.id === "openrouter")!;
  expect(providerPresetRuntime(router, pi)!.models.length).toBeGreaterThan(router.models.length);
  expect(providerPresetRuntime({ ...groq, runtimes: { pi: { baseUrl: "https://relay.example/v1", wireProtocol: "openai-chat" } } }, pi)?.models).toEqual([]);
});

it("offers portable presets through the protocols and credentials supported by the selected Claude Backend", () => {
  const enabled: BackendView = { ...claude, providerRuntimeSupport: { protocols: ["anthropic", "openaiResponses", "openaiCompletions"],
    fields: ["keyless", "modelEndpoint", "modelLimits", "modelsEndpoint"] } };
  const runtime = (id: string, backend = enabled) => providerPresetRuntime(providerPresets.find(preset => preset.id === id)!, backend);
  const gemini = runtime("google-gemini-api")!;
  expect(gemini).toMatchObject({ backendId: "claude-code", compatibility: "openaiCompletions", keyless: false,
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai", modelsEndpoint: "https://generativelanguage.googleapis.com/v1beta/openai/models" });
  expect(gemini.models.find(model => model.modelId === "gemini-4-neon")).toMatchObject({ contextWindowTokens: 1_048_576 });
  expect(runtime("iflytek-maas")?.models.map(model => model.modelId)).toContain("spark-x2.6");
  expect(runtime("litellm")).toMatchObject({ endpoint: "http://127.0.0.1:4000", compatibility: "anthropic", keyless: true });
  expect(runtime("llamacpp")).toMatchObject({ endpoint: "http://127.0.0.1:8080/v1", compatibility: "openaiCompletions", keyless: true });
  expect(runtime("vllm")).toMatchObject({ endpoint: "http://127.0.0.1:8000/v1", keyless: true });
  expect(runtime("open-design")?.modelsEndpoint).toBe("https://amr-link.open-design.ai/v1/models");
  expect(runtime("litellm", claude)).toBeUndefined();
  expect(runtime("google-gemini-api", { ...enabled, providerRuntimeSupport: { protocols: ["anthropic"], fields: [] } })).toBeUndefined();
});
it("uses declared capabilities and advisory defaults without inferring an unrelated native protocol", () => {
  const kimi = providerPresets.find(item => item.id === "moonshot-kimi-code")!;
  const kimiPi = providerPresetRuntime(kimi, pi)!;
  expect(kimiPi).toMatchObject({ compatibility: "anthropic", endpoint: "https://api.kimi.com/coding" });
  expect(kimiPi.models.find(model => model.modelId === "k3.1-pro")).toMatchObject({
    compatibility: undefined, contextWindowTokens: 262_144, maximumOutputTokens: 262_144, defaultEffort: "max", inputModalities: ["text", "image"]
  });
  expect(discoveredProviderModelInterface("k3.1-pro", claude, "https://api.kimi.com/coding/v1")).toMatchObject({
    api: "anthropic-messages", baseUrl: "https://api.kimi.com/coding"
  });
  expect(publicModelNativeApi("openai", "chatgpt/gpt-unlisted[1m]")).toBe("openai-responses");
  expect(publicProviderModel("openai", "gpt-5.6-sol")).toMatchObject({ status: "active", baseDefaults: { maxOutputTokens: 128_000 } });
  expect(publicProviderModel("openai", "chatgpt/gpt-5.6-sol[1m]")).toMatchObject({ status: "deprecated", defaults: { contextWindow: 1_000_000 } });
  expect(publicModelNativeApi("openai", "gpt-unlisted-audio", "audio_speech")).toBeUndefined();
  expect(publicModelNativeApi("anthropic", "claude-unlisted")).toBe("anthropic-messages");
  expect(publicModelNativeApi("xai", "grok-unlisted")).toBe("openai-responses");
  expect(publicModelNativeApi("arbitrary-proxy", "openai/gpt-unlisted")).toBeUndefined();
  expect(publicModelRecommendedBackend("openrouter", "qwen/qwen3.8-flash")).toBe("claude-code");
});
