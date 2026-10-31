// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { readModelConfiguration, readModelPickerOwnerPreferences, resetModelPickerPreferencesForTests, setModelConfiguration } from "../model-picker-preferences.js";
import { emptySnapshot, type AppSnapshot, type ManagedModelRuntimeView, type ModelPriceOverrideView, type ModelView, type ModelWorkingContextView, type ProviderConfigurationView, type ProviderModelConfigurationView } from "../model.js";
import { ProviderSettings } from "./SettingsPage.js";

const roots: Root[] = [];
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); window.localStorage.clear(); resetModelPickerPreferencesForTests(); });
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); resetModelPickerPreferencesForTests(); });

describe("ProviderSettings model advanced journey", () => {
  it("shows a saved override and its conflict after reference prices disappear", async () => {
    const get = vi.fn(async (): Promise<ModelPriceOverrideView> => ({
      backendId: "a", providerId: "provider", modelId: "model-primary",
      reference: { currency: "USD" }, effective: { currency: "USD", inputPerMillion: 3, outputPerMillion: 6 },
      override: { inputPerMillion: 3 }, conflict: true, referenceAvailable: false, allowedCurrencies: ["USD"]
    }));
    await mount({ getModelPriceOverride: get }, undefined, { pricingKnown: false });
    await open();
    expect(get).toHaveBeenCalledWith("a", "provider", "model-primary", expect.any(AbortSignal));
    const drawer = required(document.querySelector(".model-advanced-drawer"));
    expect(drawer.textContent).toContain("3 USD / 1M");
    expect(drawer.textContent).toContain("6 USD / 1M");
    expect(drawer.textContent).toContain("reference price has changed");
  });

  it("opens published tariffs with date/token boundaries and distinct one-hour cache prices", async () => {
    await mount({}, undefined, { referenceTariffs: [{ currencyCode: "USD", variant: "fast", inputPerMillion: 8,
      outputPerMillion: 40, cacheWritePerMillion: 10, cacheWrite1hPerMillion: 16, minInputTokens: 272001,
      effectiveFrom: "2026-09-22", effectiveUntil: "2027-01-01", sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing", verifiedAt: "2026-09-23" }] });
    await open();
    const details = required([...document.querySelectorAll(".model-advanced-drawer details")].find(element => element.textContent?.includes("Reference tariffs")));
    await act(async () => details.querySelector("summary")?.click());
    expect(details.textContent).toContain("2027-01-01 (exclusive)");
    expect(details.textContent).toContain("272001 ≤ tokens");
    expect(details.textContent).toContain("16 USD / 1M");
    expect(details.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
  });
  it("opens the actual row into complete declared facts, route differences and keyboard close", async () => {
    const mounted = await mount(); await open();
    const dialog = required(document.querySelector<HTMLElement>(".model-advanced-drawer"));
    expect(document.activeElement?.tagName).toBe("H2");
    expect(dialog.textContent).toContain("A declared description");
    expect(dialog.textContent).toContain("Native protocol");
    expect(dialog.textContent).toContain("Protocol compatibility conversion");
    expect(dialog.textContent).toContain("100,123");
    expect(dialog.textContent).toContain("Estimated");
    expect(dialog.textContent).toContain("Model specifications");
    expect(dialog.textContent).toContain("Image input");
    expect(dialog.textContent).toContain("Not declared");
    expect(dialog.querySelector("code")?.textContent).toBe("model-primary");
    expect(dialog.querySelectorAll(".model-advanced-drawer__columns > div")).toHaveLength(2);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector(".model-advanced-drawer")).toBeNull();
    expect(document.activeElement).toBe(mounted.container.querySelector(".provider-model-advanced-button"));
  });

  it("applies one effort intent to exact routes, keeps Fast and clears only the effort override", async () => {
    setModelConfiguration("node", "a", "provider", "model-primary", { effort: "high", fast: true });
    setModelConfiguration("node", "b", "provider", "model-secondary", { effort: "low" });
    const mounted = await mount(); await open();
    expect(document.body.textContent).toContain("Runtime defaults differ");
    const displayOnly = required([...document.querySelectorAll<HTMLButtonElement>(".model-advanced-efforts button")].find(item => item.textContent === "ultra"));
    expect(displayOnly.disabled).toBe(true);
    await clickText("high", ".model-advanced-efforts");
    expect(readModelConfiguration(readModelPickerOwnerPreferences("node"), "a", "provider", "model-primary")).toEqual({ effort: "high", fast: true });
    expect(readModelConfiguration(readModelPickerOwnerPreferences("node"), "b", "provider", "model-secondary")).toEqual({ effort: "medium" });
    await clickText("Restore recommended effort");
    expect(readModelConfiguration(readModelPickerOwnerPreferences("node"), "a", "provider", "model-primary")).toEqual({ fast: true });
    expect(readModelConfiguration(readModelPickerOwnerPreferences("node"), "b", "provider", "model-secondary")).toBeUndefined();
    expect(mounted.api.updateBackendSettings).not.toHaveBeenCalled();
  });

  it("preserves exact unedited K values and saves one grouped context above declared capacity", async () => {
    const mounted = await mount(); await open();
    const input = contextInput();
    expect(input.value).toBe("100");
    await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(mounted.api.setModelWorkingContext).not.toHaveBeenCalled();
    await edit(input, "100.5"); await clickText("Save", ".model-working-context");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(mounted.api.setModelWorkingContext).not.toHaveBeenCalled();
    await edit(input, "150"); await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(mounted.api.setModelWorkingContext).toHaveBeenCalledTimes(1);
    expect(mounted.api.setModelWorkingContext).toHaveBeenCalledWith({ backendId: "a", providerId: "provider", modelId: "model-primary", relatedTargets: [{ backendId: "b", providerId: "provider", modelId: "model-secondary" }] }, expect.objectContaining({ revision: 7n, sourceRevision: "source-7" }), 150_000, expect.any(AbortSignal));
    expect(document.body.textContent).toContain("exceeds the declared model window");
    expect(document.body.textContent).toContain("100,123");
    await clickText("Restore default context", ".model-working-context");
    expect(mounted.api.resetModelWorkingContext).toHaveBeenCalledTimes(1);
  });

  it("reads back the committed context after a failed write and keeps a visible retry", async () => {
    let reads = 0;
    const mounted = await mount({ getModelWorkingContext: vi.fn(async () => ++reads === 1 ? context() : context({ limitTokens: 120_000, effectiveContextWindowTokens: 120_000, revision: 8n })), setModelWorkingContext: vi.fn(async () => { throw new Error("Refresh failed"); }) });
    await open(); await edit(contextInput(), "150"); await clickText("Save", ".model-working-context");
    expect(mounted.api.getModelWorkingContext).toHaveBeenCalledTimes(2);
    expect(contextInput().value).toBe("120");
    expect(document.querySelector(".model-working-context [role='alert']")?.textContent).toContain("could not be saved or loaded");
    await clickText("Retry", ".model-working-context");
    expect(mounted.api.getModelWorkingContext).toHaveBeenCalledTimes(3);
    expect(mounted.api.setModelWorkingContext).toHaveBeenCalledTimes(1);
  });

  it("shows a load failure, retries explicitly and leaves a capability readonly budget visible", async () => {
    const get = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(context({ canConfigure: false }));
    await mount({ getModelWorkingContext: get }); await open();
    await clickText("Retry", ".model-working-context");
    expect(contextInput().disabled).toBe(true);
    expect(document.body.textContent).toContain("cannot be changed on this route");
    expect(document.body.textContent).toContain("Routes have different overrides");
  });

  it("edits only an advertised manual protocol through full Provider CAS and shows failures", async () => {
    const saveProvider = vi.fn().mockRejectedValueOnce(new Error("CAS conflict")).mockResolvedValue(undefined);
    const mounted = await mount({ saveProvider }); await open();
    const select = required(document.querySelector<HTMLButtonElement>('[aria-label="Runtime a · Model API override"]'));
    await selectProtocol(select, "Anthropic Messages");
    expect(saveProvider).toHaveBeenCalledWith(expect.objectContaining({ revision: 2n, runtimes: [expect.objectContaining({ backendId: "a", endpoint: "https://provider.invalid/v1", models: [expect.objectContaining({ modelId: "model-primary", compatibility: "anthropic" })] }), expect.objectContaining({ backendId: "b", models: [expect.objectContaining({ modelId: "model-secondary" })] })] }), expect.any(AbortSignal));
    expect(document.body.textContent).toContain("The change failed");
    await selectProtocol(select, "OpenAI Chat Completions");
    expect(saveProvider).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain("The change failed");
    const toggle = required(document.querySelector<HTMLButtonElement>('[aria-label="Show model on Runtime a"]'));
    await act(async () => toggle.click());
    await clickText("Restore default visibility");
    expect(readModelPickerOwnerPreferences("node").visibility).toEqual({});
    await clickText("Disable model");
    expect(mounted.api.updateBackendSettings).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".model-advanced-drawer")).toBeNull();
  });

  it.each(["read", "write"] as const)("retires a late %s when the connection occurrence changes", async kind => {
    let finish!: (value: ModelWorkingContextView) => void;
    let signal: AbortSignal | undefined;
    const delayed = vi.fn((_target: unknown, _observedOrSignal: unknown, _tokens?: number, requestSignal?: AbortSignal) => { signal = kind === "read" ? _observedOrSignal as AbortSignal : requestSignal; return new Promise<ModelWorkingContextView>(resolve => { finish = resolve; }); });
    const mounted = await mount(kind === "read" ? { getModelWorkingContext: delayed } : { setModelWorkingContext: delayed });
    await open();
    if (kind === "write") { await edit(contextInput(), "150"); await clickText("Save", ".model-working-context"); }
    await act(async () => { mounted.api.state.connectionGeneration = 2; mounted.root.render(mounted.element()); });
    expect(signal?.aborted).toBe(true);
    expect(document.querySelector(".model-advanced-drawer")).toBeNull();
    await act(async () => finish(context({ limitTokens: 180_000 })));
    expect(document.querySelector(".model-advanced-drawer")).toBeNull();
  });

  it("reuses the existing repository context with owner blocking and no local delete action", async () => {
    const mounted = await mount({}, repositoryRuntime()); const priorReads = mounted.api.getManagedModelContext.mock.calls.length; await open();
    expect(mounted.api.getModelWorkingContext).not.toHaveBeenCalled();
    expect(mounted.api.getManagedModelContext).toHaveBeenCalledTimes(priorReads + 1);
    expect(document.querySelector(".managed-model-runtime-context input")?.hasAttribute("disabled")).toBe(true);
    expect(document.querySelectorAll(".model-advanced-engine select")).toHaveLength(0);
    expect(document.querySelector(".model-advanced-drawer__actions")?.textContent).not.toContain("Delete local model");
  });

  it("uses advertised local routes for delete confirmation without guessing a runtime identity", async () => {
    const runtime = repositoryRuntime();
    const deleteManagedModel = vi.fn(async () => runtime);
    await mount({ deleteManagedModel }, { ...runtime, capabilities: { ...runtime.capabilities, canConfigure: true, supportsRepositoryModels: false, canDeleteModels: true } });
    await open(); await clickText("Delete local model");
    expect(deleteManagedModel).not.toHaveBeenCalled();
    await clickText("Delete");
    expect(deleteManagedModel).toHaveBeenCalledExactlyOnceWith("repository", "model-primary");
    expect(document.querySelector(".model-advanced-drawer")).toBeNull();
  });

  it("retires a background write and rechecks in foreground without replacing the dirty draft", async () => {
    let finish!: (value: ModelWorkingContextView) => void;
    let signal: AbortSignal | undefined;
    const mounted = await mount({ setModelWorkingContext: vi.fn((_target: unknown, _observed: unknown, _tokens: number, requestSignal: AbortSignal) => { signal = requestSignal; return new Promise<ModelWorkingContextView>(resolve => { finish = resolve; }); }) });
    await open(); await edit(contextInput(), "150"); await clickText("Save", ".model-working-context");
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(signal?.aborted).toBe(true);
    expect(contextInput().disabled).toBe(true);
    await act(async () => finish(context({ limitTokens: 180_000 })));
    expect(contextInput().value).toBe("150");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(mounted.api.getModelWorkingContext).toHaveBeenCalledTimes(2);
    expect(contextInput().value).toBe("150");
    expect(contextInput().disabled).toBe(false);
    expect(mounted.api.setModelWorkingContext).toHaveBeenCalledTimes(1);
  });

  it("opens the existing price editor from the Drawer and rereads its saved current price", async () => {
    let value: ModelPriceOverrideView = { backendId: "a", providerId: "provider", modelId: "model-primary", reference: { currency: "USD", inputPerMillion: 1, outputPerMillion: 2 }, effective: { currency: "USD", inputPerMillion: 3, outputPerMillion: 6 }, override: { currency: "USD", inputPerMillion: 3, outputPerMillion: 6 }, allowedCurrencies: ["USD"], referenceAvailable: true, revision: 1n };
    const get = vi.fn(async () => value);
    const set = vi.fn(async (_backend: string, _provider: string, _model: string, desired: typeof value.effective) => { value = { ...value, effective: desired, override: desired, revision: 2n }; return value; });
    await mount({ getModelPriceOverride: get, setModelPriceOverride: set }, undefined, { pricingKnown: true, pricingSource: "providerReference" });
    await open();
    expect(document.querySelector(".model-advanced-drawer del")?.textContent).toBe("1 USD");
    await clickText("Edit API estimate");
    const priceDialog = required(document.querySelector<HTMLElement>(".model-price-dialog"));
    const input = required(priceDialog.querySelector<HTMLInputElement>("input"));
    await edit(input, "4");
    await act(async () => required(priceDialog.querySelector("form")).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(set).toHaveBeenCalledWith("a", "provider", "model-primary", { currency: "USD", inputPerMillion: 4, outputPerMillion: 6 });
    expect(document.querySelector(".model-price-dialog")).toBeNull();
    expect(document.querySelector(".model-advanced-drawer")?.textContent).toContain("4 USD / 1M");
    expect(get).toHaveBeenCalledTimes(3);
  });
});

async function mount(overrides: Record<string, unknown> = {}, managed?: ManagedModelRuntimeView, modelOverrides: Partial<ModelView> = {}) {
  const config = configuration();
  const snapshot: AppSnapshot = { ...emptySnapshot(), models: [model("a", "model-primary", modelOverrides), model("b", "model-secondary", { efforts: ["low", "medium"], metadata: { defaultEffort: "medium", outboundProtocol: "anthropic-messages", protocolMode: "compatibility" } })],
    backends: ["a", "b"].map(id => ({ id, name: `Runtime ${id}`, version: "1", health: "healthy", capabilities: new Map(), providerRuntimeSupport: { protocols: ["openaiChat", "anthropic"], fields: ["modelCompatibility"] } })),
    providers: ["a", "b"].map(backendId => ({ backendId, id: "provider", name: "Provider", kind: "customEndpoint", compatibility: "openaiChat", authenticationState: "notRequired", endpoint: "https://provider.invalid/v1", ownerManaged: true, supportsLogin: false, supportsLogout: false, supportsRefresh: false, supportsModelRefresh: false, capabilities: new Set(), credentialSurfaces: [], loginMethods: [], routingEnabled: true })),
    ...(managed === undefined ? {} : { managedModelRuntimes: [managed] }), settings: { ...emptySnapshot().settings, providers: [config] }
  };
  const api = { state: { activeProfile: { id: "profile", serverId: "node", name: "Node", origin: "https://node.invalid" }, connectionState: "connected", connectionGeneration: 1, effectiveLocale: "en", preferences: { locale: "en" }, snapshot },
    refreshProviderModels: vi.fn(async () => undefined), refreshManagedModelRuntimes: vi.fn(async () => undefined), saveProvider: vi.fn(async () => undefined), updateBackendSettings: vi.fn(async () => undefined),
    getModelWorkingContext: vi.fn(async () => context()), setModelWorkingContext: vi.fn(async (_target: unknown, _observed: unknown, tokens?: number) => context({ limitTokens: tokens, effectiveContextWindowTokens: tokens, revision: 8n })), resetModelWorkingContext: vi.fn(async () => context({ limitTokens: undefined, customized: false, mixed: false })),
    getManagedModelContext: vi.fn(async () => ({ defaultContextWindowTokens: 32_000, effectiveContextWindowTokens: 32_000, maximumContextWindowTokens: 262_144, presets: [262_144], customized: false, canConfigure: false, pendingApply: false })),
    getModelPriceOverride: vi.fn(async (backendId: string, providerId: string, modelId: string): Promise<ModelPriceOverrideView> => ({
      backendId, providerId, modelId, reference: { currency: "USD" }, effective: { currency: "USD" }, referenceAvailable: false, allowedCurrencies: ["USD", "CNY"]
    })), ...overrides
  };
  const controller = api as unknown as AppController;
  const container = document.body.appendChild(document.createElement("div")); const root = createRoot(container); roots.push(root);
  const element = () => <ProviderSettings controller={controller} snapshot={snapshot} runAction={(_key, action) => { void action(); }} t={(key, values) => translate("en", key, values)} />;
  await act(async () => root.render(element())); return { root, container, api, element };
}
function context(overrides: Partial<ModelWorkingContextView> = {}): ModelWorkingContextView { return { target: { backendId: "a", providerId: "provider", modelId: "model-primary" }, defaultContextWindowTokens: 100_123, effectiveContextWindowTokens: 100_123, customized: true, mixed: true, revision: 7n, sourceRevision: "source-7", canConfigure: true, ...overrides }; }
function model(backendId: string, modelId: string, overrides: Partial<ModelView> = {}): ModelView { return { backendId, providerId: "provider", providerName: "Provider", modelId, logicalId: "logical-model", name: "Advanced Model", available: true, routingEnabled: true, supportsImages: false, inputModalities: ["text"], outputModalities: ["text"], supportsFast: true, efforts: ["low", "high"], contextWindow: 100_123, maximumOutputTokens: 4_096, inputCostMicrosPerMillion: 0, outputCostMicrosPerMillion: 0, currencyCode: "USD", metadata: { description: "A declared description", defaultEffort: "high", displayEfforts: ["ultra"], fastMode: false, imageInput: undefined, contextWindowSource: "declared", maxOutputTokensSource: "estimated", outboundProtocol: "openai-responses", referenceProtocol: "openai-responses", protocolMode: "matching" }, ...overrides }; }
function configuration(): ProviderConfigurationView { return { id: "provider", name: "Provider", kind: "customEndpoint", enabled: true, revision: 2n, runtimes: ["a", "b"].map((backendId, index) => ({ backendId, compatibility: "openaiChat", endpoint: "https://provider.invalid/v1", credentialId: "", credentialOrigin: "", keyless: true, authHeader: false, environmentName: "", headers: [], models: [configuredModel(index === 0 ? "model-primary" : "model-secondary")] })) }; }
function configuredModel(modelId: string): ProviderModelConfigurationView { return { modelId, name: "Advanced Model", reasoning: true, inputModalities: ["text"], contextWindowTokens: 100_123, maximumOutputTokens: 4_096, inputCostMicrosPerMillion: 0, outputCostMicrosPerMillion: 0, cacheReadCostMicrosPerMillion: 0, cacheWriteCostMicrosPerMillion: 0, thinkingLevels: [], supportsFastMode: false }; }
function repositoryRuntime(): ManagedModelRuntimeView { return { id: "repository", name: "Repository runtime", state: "ready", source: "running", revision: 1n, capabilities: { canInstall: true, canCancelInstall: false, canStart: false, canListModels: true, canPullModels: true, canDeleteModels: false, canPausePulls: true, canResumePulls: true, canCancelPulls: true, supportsCustomModels: true, supportsCuratedCatalog: true, supportsModelPreflight: true, supportsRepositoryModels: true, canConfigure: false }, installPreflight: { allowed: true, memory: "sufficient", disk: "sufficient", requiredDiskBytes: 1 }, installedModels: [{ name: "model-primary", displayName: "Advanced Model", sizeBytes: 1, contextWindowTokens: 32_000, supportsTools: true, supportsImages: false, repositoryModel: { repository: "Owner/Model", file: "Model.gguf" } }], catalog: [], transfers: [], providerRoutes: [{ backendId: "a", providerId: "provider" }, { backendId: "b", providerId: "provider" }] }; }
async function open(): Promise<void> { await act(async () => { const button = required(document.querySelector<HTMLButtonElement>(".provider-model-advanced-button")); button.focus(); button.click(); }); }
async function clickText(text: string, scope = ".model-advanced-drawer"): Promise<void> { const button = required([...required(document.querySelector(scope)).querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text)); await act(async () => button.click()); }
async function selectProtocol(trigger: HTMLButtonElement, label: string): Promise<void> { await act(async () => trigger.click()); const option = required([...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent === label)); await act(async () => option.click()); }
function contextInput(): HTMLInputElement { return required(document.querySelector<HTMLInputElement>(".model-working-context input")); }
async function edit(input: HTMLInputElement, value: string): Promise<void> { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); }
function required<T>(value: T | null | undefined): T { if (value === undefined || value === null) throw new Error("Required mounted element is absent"); return value; }
