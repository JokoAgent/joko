// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ConnectionScreenController, ConnectionScreenNode, ConnectionScreenProfile, ConnectionScreenState } from "../connection-contract.js";
import type { Translator } from "./types.js";
import { ConnectionScreen } from "./ConnectionScreen.js";

const mounted: { root: Root; container: HTMLDivElement }[] = [];
const t: Translator = (key) => key;
const profile: ConnectionScreenProfile = {
  id: "saved-one", deviceId: "phone-one", serverId: "node-one", name: "Saved node", origin: "https://node.example"
};
const node: ConnectionScreenNode = {
  serverId: "node-one", name: "Inspected node", origin: profile.origin, version: "0.1.0", apiVersion: "v1",
  pairingEnabled: true, lastSeenAt: 1, source: "current", transport: "https", identityLabel: "Verified node-one"
};

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false }) });
});
afterEach(async () => {
  for (const view of mounted.splice(0)) {
    await act(async () => view.root.unmount());
    view.container.remove();
  }
});
afterAll(() => {
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.deleteProperty(window, "matchMedia");
});

describe("the single connection page and host capabilities", () => {
  it("keeps the Web artwork interactions and explicitly recovers a failed theme action without duplicate dispatch", async () => {
    const host = fixture();
    const theme = deferred();
    vi.mocked(host.controller.setTheme).mockImplementationOnce(() => theme.promise);
    await host.render();
    const artwork = element<HTMLButtonElement>(host.container, ".connection-hero__artwork");
    expect(artwork.dataset.artwork).toBe("jogging");
    await click(artwork);
    expect(artwork.dataset.artwork).toBe("jogging-alt");
    await click(artwork);
    expect(artwork.dataset.artwork).toBe("jogging");

    const icon = element<HTMLButtonElement>(host.container, ".connection-title-icon");
    await act(async () => { icon.click(); icon.click(); });
    expect(host.controller.setTheme).toHaveBeenCalledExactlyOnceWith("dark");
    expect(artwork.dataset.artwork).toBe("acrobat");
    expect(icon.disabled).toBe(true);
    expect(host.container.textContent).not.toContain("common.cancel");
    await act(async () => theme.reject(new Error("Theme could not be saved. Try again.")));
    expect(host.container.textContent).toContain("Theme could not be saved. Try again.");
    expect(icon.disabled).toBe(false);
    expect(host.controller.setTheme).toHaveBeenCalledTimes(1);
    await click(element<HTMLButtonElement>(host.container, ".connection-theme-toggle"));
    expect(host.controller.setTheme).toHaveBeenCalledTimes(2);
    expect(artwork.dataset.artwork).toBe("acrobat");
    expect(host.container.textContent).not.toContain("Theme could not be saved. Try again.");

    await click(element<HTMLButtonElement>(host.container, ".connection-tabs button:last-child"));
    expect(host.controller.cancelAutomaticConnectionAttempt).toHaveBeenCalledTimes(1);
    expect(host.container.querySelectorAll("form.pair-form")).toHaveLength(1);
    expect(host.container.textContent).not.toContain("Inspect identity");
  });

  it("retains each Saved automatic choice and exposes Cancel before an active profile has been adopted", async () => {
    const host = fixture({
      initialMode: "saved", defaultDeviceName: "Actual phone", capabilities: { challengePairing: true, recheckSaved: true, back: true },
      profiles: [{ ...profile, automatic: false, credentialState: "available", statusLabel: "Credential available", pendingCount: 1, pendingLabel: "Retained operation one" },
        { ...profile, id: "saved-two", name: "Second node", automatic: true, credentialState: "offline", statusLabel: "Node offline" }]
    });
    const connection = deferred();
    vi.mocked(host.controller.connect).mockImplementationOnce(async () => {
      host.patch({ connectionState: "connecting", busy: true });
      await connection.promise;
    });
    vi.mocked(host.controller.disconnect).mockImplementation(async () => { host.patch({ connectionState: "disconnected", busy: false }); });
    await host.render();
    expect(host.container.textContent).toContain("Retained operation one");
    const choices = [...host.container.querySelectorAll<HTMLInputElement>(".profile-card .connection-auto-choice input")];
    expect(choices.map((input) => input.checked)).toEqual([false, true]);
    await click(choices[0]!);
    await click(choices[1]!);
    const connect = button(host.container.querySelector(".profile-card")!, "connection.connect");
    await act(async () => { connect.click(); connect.click(); });
    expect(host.controller.connect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "saved-one" }), { automatic: true });
    await host.render();
    expect(host.state.activeProfile).toBeUndefined();
    expect(host.container.querySelector(".connecting-state")?.textContent).toContain("Saved node");
    await click(button(host.container, "common.cancel"));
    expect(host.controller.disconnect).toHaveBeenCalledTimes(1);
    await host.render();
    await act(async () => connection.reject(new Error("Retired connection failure")));
    expect(host.container.textContent).not.toContain("Retired connection failure");
    expect([...host.container.querySelectorAll<HTMLInputElement>(".profile-card .connection-auto-choice input")].map((input) => input.checked)).toEqual([true, false]);
    await click(button(host.container, "Recheck saved"));
    expect(host.controller.recheckSavedProfiles).toHaveBeenCalledTimes(1);
    await click(button(host.container, "Back to Joko"));
    expect(host.controller.goBack).toHaveBeenCalledTimes(1);
  });

  it("uses one scoped challenge form, cancels inspect/request waits, and retries pairing with its preserved draft", async () => {
    const host = fixture({ initialMode: "pair", defaultDeviceName: "Actual phone", capabilities: { challengePairing: true }, profiles: [] });
    vi.mocked(host.controller.inspect!).mockImplementation(async () => { host.patch({ candidate: { origin: node.origin, node } }); });
    vi.mocked(host.controller.requestPairing!).mockImplementation(async (origin, deviceName) => { host.patch({ challenge: { origin, deviceName } }); });
    vi.mocked(host.controller.cancelPairing!).mockImplementation(() => { host.patch({ busy: false, candidate: undefined, challenge: undefined }); });
    const firstInspect = deferred();
    vi.mocked(host.controller.inspect!).mockImplementationOnce(() => firstInspect.promise);
    await host.render();
    expect(host.container.querySelectorAll("form")).toHaveLength(1);
    const origin = element<HTMLInputElement>(host.container, 'input[type="url"]');
    await input(origin, node.origin);
    await click(button(host.container, "Inspect identity"));
    expect(origin.disabled).toBe(true);
    await click(button(host.container, "common.cancel"));
    await host.render();
    await act(async () => firstInspect.reject(new Error("Retired inspection failure")));
    expect(host.container.textContent).not.toContain("Retired inspection failure");
    expect(origin.disabled).toBe(false);

    await click(button(host.container, "Inspect identity"));
    await host.render();
    expect(host.container.textContent).toContain("Verified node-one");
    const cancelledRequest = deferred();
    vi.mocked(host.controller.requestPairing!).mockImplementationOnce(() => cancelledRequest.promise);
    await click(button(host.container, "Request pairing"));
    await click(button(host.container, "common.cancel"));
    await host.render();
    await act(async () => cancelledRequest.reject(new Error("Retired request failure")));
    expect(host.container.textContent).not.toContain("Retired request failure");
    expect(host.container.querySelector('input[autocomplete="one-time-code"]')).toBeNull();

    await click(button(host.container, "Inspect identity"));
    await host.render();
    await click(button(host.container, "Request pairing"));
    await host.render();
    await input(element(host.container, 'input[autocomplete="one-time-code"]'), "123456");
    await input(element(host.container, 'input[autocomplete="off"]'), "Manual phone");
    await host.render();
    expect(host.container.querySelector('input[autocomplete="one-time-code"]')).toBeNull();
    expect(host.controller.pair).not.toHaveBeenCalled();
    await click(button(host.container, "Inspect identity"));
    await host.render();
    await click(button(host.container, "Request pairing"));
    await host.render();
    const code = element<HTMLInputElement>(host.container, 'input[autocomplete="one-time-code"]');
    expect(code.value).toBe("");
    await input(code, "654321");
    const pair = deferred();
    vi.mocked(host.controller.pair).mockImplementationOnce(() => pair.promise);
    const submit = element<HTMLButtonElement>(host.container, ".pair-form__submit");
    await act(async () => { submit.click(); submit.click(); });
    expect(host.controller.pair).toHaveBeenCalledExactlyOnceWith(node.origin, "654321", "Manual phone", { automatic: false });
    await act(async () => pair.reject(new Error("Pairing failed. Retry explicitly.")));
    expect(code.value).toBe("654321");
    expect(host.container.textContent).toContain("Pairing failed. Retry explicitly.");
    expect(host.controller.pair).toHaveBeenCalledTimes(1);
    await click(submit);
    expect(host.controller.pair).toHaveBeenCalledTimes(2);
    expect(code.value).toBe("");
    expect(host.container.querySelectorAll("form.pair-form")).toHaveLength(1);
  });

  it("immediately persists turning off the remembered native entry and retains its choice on failure", async () => {
    const host = fixture({
      initialMode: "saved", capabilities: { challengePairing: true },
      preferences: { theme: "light", automaticConnectionTarget: { kind: "profile", profileId: profile.id } },
      profiles: [{ ...profile, automatic: true, credentialState: "available" }],
      labels: { automaticEntry: "Automatic entry", turnOff: "Turn off" }
    });
    const disable = deferred();
    vi.mocked(host.controller.setAutomaticConnectionEnabled).mockImplementationOnce(() => disable.promise);
    await host.render();
    const choice = element<HTMLInputElement>(host.container, ".profile-card .connection-auto-choice input");
    expect(choice.checked).toBe(true);
    const notice = element(host.container, "[data-automatic-connection]");
    expect(notice.textContent).toContain("Saved node");
    const turnOff = button(notice, "Turn off");
    await act(async () => { turnOff.click(); turnOff.click(); });
    expect(host.controller.setAutomaticConnectionEnabled).toHaveBeenCalledExactlyOnceWith(false);
    expect(turnOff.disabled).toBe(true);
    await act(async () => disable.reject(new Error("Automatic entry could not be saved.")));
    expect(host.container.textContent).toContain("Automatic entry could not be saved.");
    expect(choice.checked).toBe(true);
    expect(turnOff.disabled).toBe(false);
    expect(host.container.querySelector("[data-automatic-connection]")).not.toBeNull();
    vi.mocked(host.controller.setAutomaticConnectionEnabled).mockImplementation(async () => { host.patch({ preferences: { theme: "light" } }); });
    await click(turnOff);
    expect(host.controller.setAutomaticConnectionEnabled).toHaveBeenCalledTimes(2);
    await host.render();
    expect(host.container.querySelector("[data-automatic-connection]")).toBeNull();
    expect(host.container.textContent).not.toContain("Automatic entry could not be saved.");
  });
});

function fixture(initial: Partial<ConnectionScreenState> = {}) {
  let state: ConnectionScreenState = {
    connectionState: "disconnected", profiles: [profile], discoveredNodes: [], discoveryState: "ready",
    automaticConnectionAvailable: true, preferences: { theme: "light" }, effectiveLocale: "en",
    labels: { inspect: "Inspect identity", requestPairing: "Request pairing", recheckSaved: "Recheck saved", back: "Back to Joko" },
    ...initial
  };
  const controller: ConnectionScreenController = {
    get state() { return state; },
    connect: vi.fn(async () => undefined), pair: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
    forgetProfile: vi.fn(async () => undefined), refreshDiscoveredNodes: vi.fn(async () => undefined),
    retryManagedOrchestrator: vi.fn(async () => undefined), cancelAutomaticConnectionAttempt: vi.fn(),
    setAutomaticConnectionEnabled: vi.fn(async () => undefined), setTheme: vi.fn(async () => undefined),
    inspect: vi.fn(async () => undefined), requestPairing: vi.fn(async () => undefined), cancelPairing: vi.fn(),
    recheckSavedProfiles: vi.fn(async () => undefined), goBack: vi.fn(async () => undefined), selectMode: vi.fn()
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  return {
    controller, container, get state() { return state; },
    patch(next: Partial<ConnectionScreenState>) { state = { ...state, ...next }; },
    async render() { await act(async () => root.render(<ConnectionScreen controller={controller} t={t} />)); }
  };
}

function element<T extends HTMLElement>(container: ParentNode, selector: string): T {
  const result = container.querySelector<T>(selector);
  if (!result) throw new Error(`Missing UI element: ${selector}`);
  return result;
}
function button(container: ParentNode, label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
  if (!result) throw new Error(`Missing UI button: ${label}`);
  return result;
}
async function click(element: HTMLElement): Promise<void> { await act(async () => element.click()); }
async function input(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
