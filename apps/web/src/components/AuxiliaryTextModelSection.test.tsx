// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { emptySnapshot, type AuxiliaryTextSettingsView, type ModelRouteRefView } from "../model.js";
import { AuxiliaryTextModelSection } from "./AuxiliaryTextModelSection.js";

const a = route("first");
const b = route("second");
const c = route("third");
const t = (key: Parameters<typeof translate>[1]) => translate("en", key);
const roots: Root[] = [];
beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("Auxiliary text model chain", () => {
  it("starts Custom as a draft, submits one complete ordered chain, rejects duplicates, compresses removals, and resets with an empty chain", async () => {
    const fixture = owner(settings([], 0n));
    const mounted = await mount(fixture);
    await choose(mounted.host, "Model selection", "custom");
    expect(fixture.save).not.toHaveBeenCalled();
    expect(select(mounted.host, "Preferred model").value).toBe(key(a));
    await choose(mounted.host, "Model selection", "automatic");
    expect(fixture.save).not.toHaveBeenCalled();
    await choose(mounted.host, "Model selection", "custom");
    const pending = deferred<void>();
    fixture.save.mockReturnValueOnce(pending.promise);
    await choose(mounted.host, "Preferred model", key(b));
    await choose(mounted.host, "Preferred model", key(c));
    expect(fixture.save).toHaveBeenCalledExactlyOnceWith([b], 0n);
    await mounted.render({ ...fixture, value: { ...fixture.value, state: { ...fixture.value.state } } });
    expect(select(mounted.host, "Preferred model").disabled).toBe(true);
    await act(async () => pending.resolve());
    expect(mounted.host.textContent).toContain("Waiting for the current settings");
    expect(mounted.host.textContent).toContain("Automatic");
    await mounted.publish(settings([b], 1n));
    expect(mounted.host.textContent).not.toContain("Draft — not applied");

    await choose(mounted.host, "First fallback", key(a));
    expect(fixture.save).toHaveBeenLastCalledWith([b, a], 1n);
    await mounted.publish(settings([b, a], 2n));
    const third = select(mounted.host, "Second fallback");
    expect([...third.options].find((option) => option.value === key(a))?.disabled).toBe(true);
    await choose(mounted.host, "Second fallback", key(a));
    expect(fixture.save).toHaveBeenCalledTimes(2);
    await choose(mounted.host, "Second fallback", key(c));
    expect(fixture.save).toHaveBeenLastCalledWith([b, a, c], 2n);
    await mounted.publish(settings([b, a, c], 3n));
    await choose(mounted.host, "First fallback", "");
    expect(fixture.save).toHaveBeenLastCalledWith([b, c], 3n);
    await mounted.publish(settings([b, c], 4n));
    select(mounted.host, "Preferred model").focus();
    await choose(mounted.host, "Preferred model", "");
    expect(fixture.save).toHaveBeenLastCalledWith([], 4n);
    await mounted.publish(settings([], 5n));
    expect(select(mounted.host, "Model selection").value).toBe("automatic");
    expect(document.activeElement).toBe(select(mounted.host, "Model selection"));
    expect(mounted.host.textContent).toContain("Current automatic chain");
  });

  it("keeps failed drafts separate from newer settings and requires an explicit conflict retry or reload", async () => {
    const fixture = owner(settings([], 0n));
    const mounted = await mount(fixture);
    fixture.save.mockRejectedValueOnce(new Error("conflict"));
    await choose(mounted.host, "Model selection", "custom");
    await choose(mounted.host, "Preferred model", key(c));
    expect(mounted.host.textContent).toContain("Your draft is kept");
    expect(select(mounted.host, "Preferred model").value).toBe(key(c));
    await mounted.publish(settings([b], 2n));
    expect(select(mounted.host, "Preferred model").value).toBe(key(c));
    expect(mounted.host.textContent).toContain("settings changed elsewhere");
    expect(fixture.save).toHaveBeenCalledTimes(1);
    const retry = deferred<void>();
    fixture.save.mockReturnValueOnce(retry.promise);
    await click(mounted.host, "Save draft with latest settings");
    expect(fixture.save).toHaveBeenLastCalledWith([c], 2n);
    await mounted.publish(settings([a], 4n));
    await act(async () => retry.resolve());
    expect(mounted.host.textContent).toContain("settings changed elsewhere");
    await click(mounted.host, "Reload saved chain");
    expect(select(mounted.host, "Preferred model").value).toBe(key(a));
    await mounted.publish(settings([b], 3n));
    expect(select(mounted.host, "Preferred model").value).toBe(key(a));
    expect(mounted.host.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps late saves out of a new profile or Document, including a return to the original profile", async () => {
    const original = owner(settings([], 0n), "profile-a");
    const pending = deferred<void>();
    original.save.mockReturnValueOnce(pending.promise);
    const mounted = await mount(original);
    await choose(mounted.host, "Model selection", "custom");
    await choose(mounted.host, "Preferred model", key(c));
    await mounted.render(owner(settings([b], 5n), "profile-b"));
    await mounted.render(original);
    await act(async () => pending.reject(new Error("old failure")));
    expect(select(mounted.host, "Model selection").value).toBe("automatic");
    expect(mounted.host.querySelector('[role="alert"]')).toBeNull();
    const oldDocumentSave = deferred<void>();
    original.save.mockReturnValueOnce(oldDocumentSave.promise);
    await choose(mounted.host, "Model selection", "custom");
    await choose(mounted.host, "Preferred model", key(b));
    const iframe = document.body.appendChild(document.createElement("iframe"));
    const other = iframe.contentDocument!.body.appendChild(iframe.contentDocument!.createElement("div"));
    await mounted.render(original, other);
    await act(async () => oldDocumentSave.reject(new Error("retired document")));
    expect(select(other, "Model selection").value).toBe("automatic");
    expect(other.querySelector('[role="alert"]')).toBeNull();
    expect(other.querySelector("select")?.ownerDocument).toBe(iframe.contentDocument);
  });

  it("shows loading, retry, missing selected routes, and a searchable exact-route catalog without saving during search", async () => {
    const fixture = owner(settings([], 0n));
    const mounted = await mount({ ...fixture, value: { ...fixture.value, state: { ...fixture.value.state, connectionState: "connecting" } } });
    expect(mounted.host.textContent).toContain("Loading");
    await mounted.render({ ...fixture, snapshotRevision: 0n, value: { ...fixture.value, state: { ...fixture.value.state, error: "load failed" } } });
    expect(mounted.host.textContent).toContain("Could not load auxiliary");
    await click(mounted.host, "Retry");
    expect(fixture.refresh).toHaveBeenCalledOnce();
    await mounted.render({ ...fixture, settings: { ...fixture.settings, runtimeRevision: "", available: false, unavailableReason: "Auxiliary text is unavailable on this node." } });
    expect(mounted.host.textContent).toContain("Auxiliary text is unavailable on this node");
    expect(mounted.host.querySelector('[role="alert"]')).toBeNull();
    expect(select(mounted.host, "Model selection").disabled).toBe(true);
    expect([...mounted.host.querySelectorAll("button")].some((button) => button.textContent === "Retry")).toBe(false);
    const missing = route("removed");
    await mounted.render({ ...fixture, settings: { ...settings([missing], 1n), available: false, unavailableReason: "Selected route is no longer configured." } });
    expect(select(mounted.host, "Preferred model").textContent).toContain("removed");
    expect(mounted.host.textContent).toContain("Selected route is no longer configured");
    const search = mounted.host.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "second");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...select(mounted.host, "First fallback").options].map((option) => option.value)).toEqual(["", key(b)]);
    expect(select(mounted.host, "Preferred model").value).toBe(key(missing));
    expect(fixture.save).not.toHaveBeenCalled();
  });

  it("admits a fresh connection's lower revision and retires runtime requests while keeping the draft", async () => {
    const first = owner(settings([a], 50n));
    const mounted = await mount(first);
    const next = owner(settings([a], 50n));
    await mounted.render({ ...next, value: { ...next.value, state: { ...next.value.state, connectionState: "connecting" } } });
    const authoritative = { ...settings([b], 20n), runtimeRevision: "runtime-two" };
    await mounted.render({ ...next, settings: authoritative });
    expect(select(mounted.host, "Preferred model").value).toBe(key(b));
    const old = deferred<void>();
    next.save.mockReturnValueOnce(old.promise);
    await choose(mounted.host, "Preferred model", key(c));
    await mounted.publish({ ...authoritative, runtimeRevision: "runtime-three" });
    expect(select(mounted.host, "Preferred model").value).toBe(key(c));
    expect(select(mounted.host, "Preferred model").disabled).toBe(false);
    const retry = deferred<void>();
    next.save.mockReturnValueOnce(retry.promise);
    await click(mounted.host, "Retry");
    await act(async () => old.reject(new Error("late prior route failure")));
    expect(mounted.host.querySelector('[role="alert"]')).toBeNull();
    expect(select(mounted.host, "Preferred model").disabled).toBe(true);
    await mounted.publish({ ...settings([c], 21n), runtimeRevision: "runtime-four" });
    await act(async () => retry.resolve());
    expect(select(mounted.host, "Preferred model").value).toBe(key(c));
    expect(mounted.host.textContent).not.toContain("Draft — not applied");
    const reset = deferred<void>();
    next.save.mockReturnValueOnce(reset.promise);
    select(mounted.host, "Preferred model").focus();
    await choose(mounted.host, "Preferred model", "");
    await mounted.publish({ ...settings([c], 21n), runtimeRevision: "runtime-five" });
    await mounted.publish({ ...settings([], 22n), runtimeRevision: "runtime-six" });
    await act(async () => reset.resolve());
    expect(document.activeElement).not.toBe(select(mounted.host, "Model selection"));
    await mounted.render({ ...next, settings: { ...settings([a], 1n), runtimeRevision: "restarted-runtime" }, snapshotGeneration: 2n });
    expect(select(mounted.host, "Preferred model").value).toBe(key(a));
  });
});

function route(modelId: string): ModelRouteRefView { return { backendId: "backend", providerId: "provider", modelId }; }
function key(value: ModelRouteRefView): string { return JSON.stringify([value.backendId, value.providerId, value.modelId]); }
function settings(models: readonly ModelRouteRefView[], revision: bigint): AuxiliaryTextSettingsView {
  return { models, revision, automaticModels: [a], options: [a, b, c].map((route) => ({ route, available: true, unavailableReason: "" })), available: true, unavailableReason: "", runtimeRevision: "runtime-one" };
}
function owner(value: AuxiliaryTextSettingsView, profileId = "profile") {
  const save = vi.fn<AppController["updateAuxiliaryTextSettings"]>().mockResolvedValue(undefined);
  const refresh = vi.fn<AppController["refresh"]>().mockResolvedValue(undefined);
  const controller = { state: { ready: true, connectionState: "connected", activeProfile: { id: profileId, serverId: "server" } }, getArtifactUrl: vi.fn(), updateAuxiliaryTextSettings: save, refresh } as unknown as AppController;
  return { settings: value, value: controller, save, refresh, snapshotRevision: 1n, snapshotGeneration: 1n };
}
async function mount(initial: ReturnType<typeof owner>) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  let current = initial;
  const render = async (next: ReturnType<typeof owner>, target = host) => {
    current = next;
    const snapshot = emptySnapshot();
    await act(async () => root.render(createPortal(<StrictMode><AuxiliaryTextModelSection controller={next.value} snapshot={{ ...snapshot, revision: next.snapshotRevision, generation: next.snapshotGeneration, settings: { ...snapshot.settings, auxiliaryText: next.settings } }} t={t} /></StrictMode>, target)));
  };
  await render(initial);
  return { host, render, publish: (settings: AuxiliaryTextSettingsView) => render({ ...current, settings }) };
}
function select(host: HTMLElement, label: string): HTMLSelectElement { return host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; }
async function choose(host: HTMLElement, label: string, value: string): Promise<void> {
  await act(async () => { const control = select(host, label); control.value = value; control.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function click(host: HTMLElement, label: string): Promise<void> {
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === label)!.click());
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
