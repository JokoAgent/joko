// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { emptySnapshot, type ProviderLoginFlowView } from "../model.js";
import { ProviderLoginDialog } from "./ProviderLoginDialog.js";

const roots: Root[] = [];
const provider = { id: "source-one", name: "Source one", kind: "oauth" as const };
const pending: ProviderLoginFlowView = { id: "flow-one", providerId: provider.id, method: "deviceCode", state: "pending", updatedAt: 1 };

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("Provider login ownership", () => {
  it.each(["close", "provider", "connection"] as const)("retires pending sign-in on %s without opening a late verification page", async (change) => {
    const begin = deferred<ProviderLoginFlowView>();
    const api = controller({ beginProviderLogin: vi.fn(() => begin.promise) });
    const onClose = vi.fn();
    const render = await mount(api, onClose);
    await act(async () => { button("providerLogin.start").click(); button("providerLogin.start").click(); });
    expect(api.beginProviderLogin).toHaveBeenCalledExactlyOnceWith("backend-one", provider.id, "deviceCode");
    if (change === "close") {
      await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(onClose).toHaveBeenCalledOnce();
    } else if (change === "provider") await render(api, { ...provider, id: "source-two", name: "Source two" });
    else await render(controller({ state: { ...api.state, activeProfile: { ...api.state.activeProfile!, id: "connection-two", serverId: "node-two" } } }));
    await act(async () => begin.resolve({ ...pending, verificationUri: "https://provider.example/verify" }));
    expect(api.openHttpLink).not.toHaveBeenCalled();
    expect(api.cancelProviderLogin).toHaveBeenCalledExactlyOnceWith(pending.id);
    expect(document.body.textContent).not.toContain("providerLogin.openVerification");
  });

  it("keeps a live flow across equivalent snapshot renders and retries a failed refresh without repeating authorization", async () => {
    const refresh = vi.fn().mockRejectedValueOnce(new Error("Refresh unavailable")).mockResolvedValue(undefined);
    const api = controller({ refresh, beginProviderLogin: vi.fn(async () => ({ ...pending, verificationUri: "https://provider.example/verify" })) });
    const onClose = vi.fn();
    const render = await mount(api, onClose);
    await act(async () => button("providerLogin.start").click());
    expect(api.openHttpLink).toHaveBeenCalledExactlyOnceWith("https://provider.example/verify", { forceExternal: true });
    const next = { ...api, getProviderLoginFlow: vi.fn(async () => ({ ...pending, state: "completed" as const })) };
    await render(next);
    expect(document.body.textContent).toContain("providerLogin.pending");
    await act(async () => { vi.advanceTimersByTime(1_250); });
    expect(next.getProviderLoginFlow).toHaveBeenCalledExactlyOnceWith(pending.id);
    expect(document.body.textContent).toContain("Refresh unavailable");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => button("common.retry").click());
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(api.beginProviderLogin).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("clears a sensitive pending prompt and ignores its late submission after a source change", async () => {
    const submitted = deferred<ProviderLoginFlowView>();
    const api = controller({ beginProviderLogin: vi.fn(async () => ({ ...pending,
      pendingPrompt: { id: "prompt-one", kind: "secret" as const, message: "Verification input", placeholder: "", options: [] }
    })), submitProviderLoginInput: vi.fn(() => submitted.promise) });
    const render = await mount(api);
    await act(async () => button("providerLogin.start").click());
    const input = document.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "test verification input");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await render(api, { ...provider, id: "source-two", name: "Source two" });
    expect(api.cancelProviderLogin).toHaveBeenCalledExactlyOnceWith(pending.id);
    expect(document.querySelector('input[type="password"]')).toBeNull();
    await act(async () => submitted.resolve({ ...pending, state: "completed" }));
    expect(api.refresh).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("providerLogin.start");
  });
});

async function mount(api: AppController, onClose = vi.fn()) {
  const root = createRoot(document.body.appendChild(document.createElement("div"))); roots.push(root);
  const render = async (next: AppController, source = provider) => act(async () => root.render(<ProviderLoginDialog
    controller={next} backendId="backend-one" provider={source} loginMethods={["deviceCode"]}
    t={(key) => key} onClose={onClose} />));
  await render(api); return render;
}

function controller(overrides: Partial<AppController> = {}): AppController {
  return { state: { connectionState: "connected", snapshot: emptySnapshot(), activeProfile: {
    id: "connection-one", serverId: "node-one", deviceId: "device-one", name: "Node one", origin: "https://node.example"
  } }, beginProviderLogin: vi.fn(async () => pending), getProviderLoginFlow: vi.fn(async () => pending),
  cancelProviderLogin: vi.fn(async () => ({ ...pending, state: "cancelled" })), submitProviderLoginInput: vi.fn(async () => pending),
  openHttpLink: vi.fn(async () => undefined), refresh: vi.fn(async () => undefined), ...overrides } as unknown as AppController;
}

function button(label: string): HTMLButtonElement {
  const value = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
  if (value === undefined) throw new Error(`Missing ${label}`); return value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
