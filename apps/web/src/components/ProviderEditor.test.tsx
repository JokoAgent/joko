// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot, BackendView, ProviderConfigurationView } from "../model.js";
import { emptyProviderRuntime } from "../provider-runtime-draft.js";
import { translate } from "../i18n.js";
import { ProviderEditor } from "./ProviderEditor.js";

const roots: Root[] = [];
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.replaceChildren(); Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); });
const backends: readonly BackendView[] = ["Alpha", "Beta"].map((name) => ({ id: name.toLowerCase(), name: `${name} runtime`, version: "1", health: "healthy",
  capabilities: new Map([["provider.managed_catalog", { name: "provider.managed_catalog", supported: true, options: [] }]]),
  providerRuntimeSupport: { protocols: ["openaiResponses"], fields: ["headers", "keyless", "authHeader", "modelLimits"] } }));
const credentials: AppSnapshot["settings"]["credentials"] = ["source-key", "target-key", "old-header", "replacement-key", "replacement-header"].map((id) => ({ id, name: id, kind: "apiKey", providerId: "", configured: true }));
function provider(): ProviderConfigurationView {
  return { id: "custom", name: "Custom", kind: "customEndpoint", enabled: true, revision: 4n, runtimes: backends.map((backend, index) => {
    const empty = emptyProviderRuntime(backend);
    return { ...empty, endpoint: "https://route.example/v1", credentialId: index === 0 ? "source-key" : "target-key", credentialOrigin: "https://route.example", environmentName: "ROUTE_KEY",
      models: [{ ...empty.models[0]!, modelId: "text-model", name: "Text model" }] };
  }) };
}
async function render(configuration: ProviderConfigurationView) {
  const saveCredential = vi.fn(async () => undefined); const saveProvider = vi.fn(async () => undefined);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); roots.push(root);
  const updateBackends = async (available: readonly BackendView[]) => act(async () => root.render(<ProviderEditor open provider={configuration} backends={available} credentials={credentials} providerIds={[configuration.id]}
    saveCredential={saveCredential} saveProvider={saveProvider} onClose={() => undefined} onSaved={() => undefined} t={(key, values) => translate("en", key, values)} />));
  await updateBackends(backends);
  return { saveCredential, saveProvider, updateBackends };
}
function button(label: string): HTMLButtonElement {
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
  if (!result) throw new Error(`Missing button: ${label}`); return result;
}
function control<T extends HTMLElement>(label: string, selector: string): T {
  const owner = [...document.querySelectorAll("label")].find((item) => item.querySelector("span")?.textContent === label);
  const result = owner?.querySelector<T>(selector); if (!result) throw new Error(`Missing field: ${label}`); return result;
}
async function fill(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function select(control: HTMLButtonElement, label: string): Promise<void> {
  await act(async () => control.click()); const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent === label);
  if (!option) throw new Error(`Missing option: ${label}`); await act(async () => option.click());
}

describe("Provider runtime editor", () => {
  it.each([false, true])("reviews overwrites and replaces a target draft key when copying authentication (keyless=%s)", async (keyless) => {
    const initial = provider(); const configuration = { ...initial, runtimes: initial.runtimes.map((runtime, index) => index !== 0 || !keyless ? keyless
      ? { ...runtime, headers: [{ headerName: "X-Header", credentialId: "old-header", environmentName: "HEADER_KEY" }] } : runtime
      : { ...runtime, keyless: true, authHeader: false, credentialId: "", environmentName: "", credentialOrigin: "" }) };
    const { saveProvider, saveCredential } = await render(configuration);
    expect(control<HTMLButtonElement>("Upstream protocol", '[role="combobox"]').textContent).toBe("OpenAI Responses");
    await act(async () => button("Beta runtime").click()); await fill(document.querySelector<HTMLInputElement>('input[type="password"]')!, "unsubmitted-target-key");
    await act(async () => { const tab = button("Beta runtime"); tab.focus(); tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
    expect(document.activeElement?.textContent).toBe("Alpha runtime");
    const launch = button("Copy to other runtimes"); await act(async () => { launch.focus(); launch.click(); });
    expect(document.body.textContent).not.toContain("unsubmitted-target-key");
    const auth = document.querySelector<HTMLElement>('[aria-label="Beta runtime · Authentication and API key"]')!;
    expect(auth.getAttribute("aria-checked")).toBe("false");
    await act(async () => auth.click()); await act(async () => button("Review overwrite").click());
    expect(saveProvider).not.toHaveBeenCalled(); expect(document.body.textContent).toContain("Confirm configuration overwrite");
    if (keyless) expect(document.body.textContent).toContain("will remove these 1 header bindings");
    await act(async () => button("Confirm and apply to draft").click());
    expect(document.activeElement).toBe(launch);
    await act(async () => button("Beta runtime").click());
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')?.value ?? "").toBe("");
    await act(async () => button("Save").click()); expect(saveCredential).not.toHaveBeenCalled();
    expect(saveProvider).toHaveBeenCalledWith(expect.objectContaining({ revision: 4n, runtimes: expect.arrayContaining([
      expect.objectContaining({ backendId: "beta", keyless, credentialId: keyless ? "" : "source-key", headers: [] })
    ]) }), expect.any(AbortSignal));
  });

  it("does not authorize unrelated stored credentials through a single credential selector", async () => {
    const initial = provider(); const { saveProvider } = await render({ ...initial, runtimes: initial.runtimes.map((runtime, index) => index ? runtime : {
      ...runtime, environmentName: "", headers: [{ headerName: "X-Route", credentialId: "old-header", environmentName: "HEADER_KEY" }]
    }) });
    await fill(control<HTMLInputElement>("Base URL", "input"), "https://changed.example/v1");
    await select(control<HTMLButtonElement>("Saved credential", '[role="combobox"]'), "replacement-key");
    expect(button("Save").disabled).toBe(true);
    await select(control<HTMLButtonElement>("Credential reference", '[role="combobox"]'), "replacement-header");
    expect(button("Save").disabled).toBe(true); expect(document.body.textContent).toContain("The endpoint origin changed");
    await act(async () => button("Authorize credentials for this endpoint").click()); expect(button("Save").disabled).toBe(false);
    await act(async () => button("Save").click());
    expect(saveProvider).toHaveBeenCalledWith(expect.objectContaining({ runtimes: expect.arrayContaining([expect.objectContaining({ backendId: "alpha", credentialId: "replacement-key",
      credentialOrigin: "https://changed.example", headers: [expect.objectContaining({ credentialId: "replacement-header" })] })]) }), expect.any(AbortSignal));
  });

  it("retires an overwrite review when a runtime changes and preserves the unmodified draft", async () => {
    const { saveProvider, updateBackends } = await render(provider());
    await act(async () => button("Copy to other runtimes").click());
    await act(async () => document.querySelector<HTMLElement>('[aria-label="Beta runtime · Authentication and API key"]')!.click());
    await act(async () => button("Review overwrite").click());
    await updateBackends(backends.map(backend => ({ ...backend, providerRuntimeSupport: { ...backend.providerRuntimeSupport! } })));
    expect(document.body.textContent).toContain("Confirm configuration overwrite");
    await updateBackends(backends.map(backend => ({ ...backend, instanceGeneration: 2 })));
    expect(document.body.textContent).not.toContain("Confirm configuration overwrite");
    expect(saveProvider).not.toHaveBeenCalled();
    await act(async () => button("Save").click());
    expect(saveProvider).toHaveBeenCalledWith(expect.objectContaining({ revision: 4n, runtimes: expect.arrayContaining([
      expect.objectContaining({ backendId: "beta", credentialId: "target-key" })
    ]) }), expect.any(AbortSignal));
  });
});
