import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendAdapter, NativeTextInferenceInput } from "@joko/core";
import { OperationalStore } from "@joko/store";
import { AuxiliaryTextRouting } from "./auxiliary-text-routing.js";
import { createModelRouteCatalog, type ManagedTextInferenceInput } from "./personalization-inference.js";
import { HelpAssistant, parseHelpAnswer, truncateHelpMessages } from "./help-assistant.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const effect of cleanup.splice(0)) effect(); });

function setup(managed = true) {
  const store = new OperationalStore(":memory:");
  store.upsertBackend({ id: "runtime", adapterKind: "fixture", instanceGeneration: 4, displayName: "Runtime", version: "test",
    health: "healthy", installationState: "installed", authenticationState: "authenticated",
    capabilities: new Map([["provider.managed_catalog", { key: "provider.managed_catalog", supported: managed }]]),
    models: [{ providerId: "provider", modelId: "model", displayName: "Model", api: "openai-completions", contextWindow: 8192,
      maxOutputTokens: 2048, supportsImages: false, thinkingLevels: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }], tools: [], diagnostics: [] });
  const providers = { generation: 1, hasInferenceModel: () => managed,
    describeInferenceRoute: () => managed ? { generationId: "private-route" } : undefined,
    resolveInferenceRoute: (backendId: string, providerId: string, modelId: string) => managed ? {
      backendId, providerId, modelId, generationId: "private-route", baseUrl: "https://provider.invalid/v1", api: "openai-completions" as const,
      headers: {}, supportsImages: false } : undefined };
  const infer = vi.fn<(input: ManagedTextInferenceInput) => Promise<string>>();
  const routing = new AuxiliaryTextRouting({ store, routes: createModelRouteCatalog(store, providers), providers, infer });
  const native = vi.fn<(input: NativeTextInferenceInput) => Promise<string>>();
  const adapter = { id: "runtime", inferNativeText: native } as unknown as BackendAdapter;
  let adapters = [adapter];
  const help = new HelpAssistant({ store, auxiliary: routing, adapters: () => adapters });
  cleanup.push(() => { help.close(); routing.dispose(); store.close(); });
  return { store, routing, infer, native, help, replace: () => { adapters = []; } };
}

describe("HelpAssistant", () => {
  it("routes knowledge before answering and validates actions against current settings", async () => {
    const fixture = setup(); fixture.infer.mockResolvedValueOnce('["voice"]').mockResolvedValueOnce('Open voice settings. <action tab="voice" />');
    await expect(fixture.help.ask([{ role: "user", content: "How do I configure transcription?" }], "en", new AbortController().signal, () => {}))
      .resolves.toEqual({ text: "Open voice settings.", settingsSection: "voice" });
    expect(fixture.infer.mock.calls[1]![0].system).toContain("primary/fallback settings");
    expect(fixture.infer.mock.calls[1]![0].system).not.toContain("native catalog and portable task import workflows");
    expect(fixture.native).not.toHaveBeenCalled();
    expect(parseHelpAnswer('Answer <action tab="legacy" /><action tab="voice" />')).toEqual({ text: "Answer", settingsSection: "" });
    expect(parseHelpAnswer('<action tab="voice" />')).toBeUndefined();
  });

  it("uses only an authenticated native hook in auto mode and never crosses a custom chain", async () => {
    const automatic = setup(false); automatic.native.mockResolvedValueOnce('["general"]').mockResolvedValueOnce("Use General settings.");
    await expect(automatic.help.ask([{ role: "user", content: "Change theme" }], "en", new AbortController().signal, () => {}))
      .resolves.toMatchObject({ text: "Use General settings." });
    expect(automatic.native).toHaveBeenCalledTimes(2);
    expect(automatic.native.mock.calls[0]![0].backendInstanceGeneration).toBe(4);
    const custom = setup(); custom.routing.replace([{ backendId: "runtime", providerId: "provider", modelId: "model" }], 0n);
    custom.infer.mockRejectedValue(new Error("unavailable"));
    await expect(custom.help.ask([{ role: "user", content: "Help" }], "en", new AbortController().signal, () => {})).resolves.toBeUndefined();
    expect(custom.native).not.toHaveBeenCalled();
  });

  it("retires late managed and native answers after settings, connection or instance ownership changes", async () => {
    const fixture = setup(); let resolve!: (value: string) => void;
    fixture.infer.mockImplementationOnce(() => new Promise(accept => { resolve = accept; }));
    const running = fixture.help.ask([{ role: "user", content: "Help" }], "en", new AbortController().signal, () => {});
    await vi.waitFor(() => expect(fixture.infer).toHaveBeenCalled());
    fixture.routing.replace([], 0n); fixture.routing.invalidate(); resolve('["general"]');
    await expect(running).resolves.toBeUndefined();
    const native = setup(false); let pending!: (value: string) => void;
    native.native.mockImplementationOnce(() => new Promise(accept => { pending = accept; }));
    const active = native.help.ask([{ role: "user", content: "Help" }], "en", new AbortController().signal, () => {});
    await vi.waitFor(() => expect(native.native).toHaveBeenCalled());
    native.replace(); pending('["general"]');
    await expect(active).resolves.toBeUndefined();
    const aborted = setup(false), controller = new AbortController();
    aborted.native.mockImplementation(async input => { controller.abort(); input.assertCurrent(); return "Late"; });
    await expect(aborted.help.ask([{ role: "user", content: "Help" }], "en", controller.signal, () => {})).resolves.toBeUndefined();
  });

  it("keeps only twelve recent messages aligned at a user and rejects malformed request history", async () => {
    const messages = Array.from({ length: 15 }, (_, index) => ({ role: index % 2 === 0 ? "user" as const : "assistant" as const, content: String(index) }));
    const tail = truncateHelpMessages(messages);
    expect(tail).toHaveLength(11); expect(tail[0]).toEqual({ role: "user", content: "4" });
    const { help } = setup();
    await expect(help.ask([{ role: "assistant", content: "Invalid" }], "en", new AbortController().signal, () => {})).rejects.toThrow(RangeError);
  });

  it("continues after no-answer and accepts a previous answer at the shared message size limit", async () => {
    const { help, infer } = setup();
    infer.mockResolvedValueOnce('["general"]').mockResolvedValueOnce("Use General settings.");
    await expect(help.ask([{ role: "user", content: "Prior" }, { role: "assistant", content: "" },
      { role: "user", content: "Again" }, { role: "assistant", content: "x".repeat(24_000) }, { role: "user", content: "Follow up" }],
    "en", new AbortController().signal, () => {})).resolves.toMatchObject({ text: "Use General settings." });
  });
});
