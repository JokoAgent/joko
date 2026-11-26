// @vitest-environment jsdom
import { StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { ExtensionOAuthAccountSchema, ExtensionOAuthStateSchema, ExtensionOAuthServiceGetResponseSchema } from "@joko/contracts";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { emptySnapshot, type ExtensionCatalogEntryView, type ExtensionOAuthApi } from "../model.js";
import { translate } from "../i18n.js";
import { ExtensionOAuthSection } from "./ExtensionOAuthSection.js";

const roots: Root[] = [];
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.replaceChildren(); });
const state = () => create(ExtensionOAuthStateSchema, { extensionId: "extension-one", revision: { value: 1n }, slots: [{ key: "account", label: "Mail", clientConfigured: true,
  authorizeOrigin: "https://auth.example.test", tokenOrigin: "https://auth.example.test", scopes: ["mail.read", "mail.send"], accounts: [] }] });
async function render(patch: Partial<ExtensionOAuthApi> = {}) {
  const current = state(), api: ExtensionOAuthApi = { canAuthorize: true, get: async () => create(ExtensionOAuthServiceGetResponseSchema, { state: current }), change: vi.fn(), saveClient: vi.fn(), authorize: vi.fn(), ...patch };
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); roots.push(root);
  const onChanged = vi.fn(async () => {});
  const extension = { id: "extension-one", revision: 1n } as ExtensionCatalogEntryView;
  const renderRevision = (oauthRevision: bigint, revision = 1n, connectionGeneration = 1) => {
    const controller = { state: { connectionState: "connected", connectionGeneration, snapshot: { ...emptySnapshot(), revision },
      activeProfile: { id: "profile", serverId: "node", deviceId: "desktop", origin: "https://node.example" } }, extensionOAuthApi: () => api } as unknown as AppController;
    return act(async () => root.render(<StrictMode><ExtensionOAuthSection controller={controller} extension={extension}
      oauthRevision={oauthRevision} disabled={false} t={(key, values) => translate("en", key, values)} onChanged={onChanged} /></StrictMode>));
  };
  await renderRevision(0n);
  return { container, root, onChanged, renderRevision };
}
function button(container: ParentNode, label: string) { const found = [...container.querySelectorAll("button")].find(button => button.textContent === label); if (!found) throw new Error("Missing button"); return found; }
function input(container: ParentNode, index: number, value: string) { const field = container.querySelectorAll(".extension-network__form input")[index]!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); }

it("shows the original account's expiry while its settings stay mounted", async () => {
  let expired = false;
  const get = vi.fn<ExtensionOAuthApi["get"]>(async () => {
    const accountState = state();
    accountState.slots[0]!.accounts = [create(ExtensionOAuthAccountSchema, { accountId: "original-account", label: "Original account", isDefault: true, expired })];
    return create(ExtensionOAuthServiceGetResponseSchema, { state: accountState });
  });
  const { container, renderRevision, onChanged } = await render({ get });
  const originalRow = container.querySelector(".extension-network__row");
  expect(originalRow?.textContent).toContain(translate("en", "extensions.oauth.connected"));
  const reads = get.mock.calls.length;
  expired = true;
  await renderRevision(1n);
  expect(container.querySelector(".extension-network__row")).toBe(originalRow);
  expect(originalRow?.textContent).toContain(translate("en", "extensions.oauth.expired"));
  expect(get).toHaveBeenCalledTimes(reads + 1);
  expect(onChanged).not.toHaveBeenCalled();
});

it("retains failed client configuration without replaying it and clears private input after an explicit successful save", async () => {
  let fail = true;
  const saveClient = vi.fn<ExtensionOAuthApi["saveClient"]>(async () => { if (fail) throw new Error("Unavailable"); return state(); });
  const { container, onChanged } = await render({ saveClient });
  await act(async () => { input(container, 0, "user-client"); input(container, 1, "private-client-secret-fixture"); });
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(container.querySelector('[role="alert"]')).not.toBeNull(); expect(saveClient).toHaveBeenCalledOnce(); expect(onChanged).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("private-client-secret-fixture");
  fail = false;
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(saveClient).toHaveBeenCalledTimes(2); expect(onChanged).toHaveBeenCalledOnce(); expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
});
it("requests only selected permissions and cancels the original authorization when the user cancels", async () => {
  let signal!: AbortSignal;
  const authorize = vi.fn<ExtensionOAuthApi["authorize"]>(async (_request, original) => { signal = original; return await new Promise((_resolve, reject) => original.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true })); });
  const { container } = await render({ authorize });
  await act(async () => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.click());
  await act(async () => button(container, "Connect account").click());
  expect(authorize.mock.calls[0]![0]).toMatchObject({ expectedRevision: { value: 1n }, scopes: ["mail.read"] }); expect(signal.aborted).toBe(false);
  expect(button(container, "Connect account").disabled).toBe(true);
  await act(async () => button(container, "Cancel").click()); expect(signal.aborted).toBe(true); expect(authorize).toHaveBeenCalledOnce(); expect(container.querySelector('[role="status"]')).toBeNull();
});
it("keeps authorization unavailable without a Desktop controller and retires pending work when the view closes", async () => {
  const unavailable = await render({ canAuthorize: false }); expect(button(unavailable.container, "Connect account").disabled).toBe(true); expect(unavailable.container.textContent).toContain("Open Joko Desktop");
  let signal!: AbortSignal;
  const active = await render({ authorize: async (_request, original) => { signal = original; return await new Promise((_resolve, reject) => original.addEventListener("abort", () => reject(new Error("Retired")), { once: true })); } });
  await act(async () => button(active.container, "Connect account").click());
  await act(async () => active.root.unmount()); roots.splice(roots.indexOf(active.root), 1); expect(signal.aborted).toBe(true);
});

it("keeps the browser authorization across same-connection snapshots and aborts it on a new connection generation", async () => {
  const authorize = vi.fn<ExtensionOAuthApi["authorize"]>(async (_request, signal) => new Promise((_resolve, reject) =>
    signal.addEventListener("abort", () => reject(new Error("Retired")), { once: true })));
  const view = await render({ authorize });
  await act(async () => button(view.container, "Connect account").click());
  const signal = authorize.mock.calls[0]![1];
  await view.renderRevision(0n, 2n);
  expect(signal.aborted).toBe(false);
  expect(view.container.querySelector('[role="status"]')).not.toBeNull();
  expect(button(view.container, "Connect account").disabled).toBe(true);
  await act(async () => button(view.container, "Connect account").click());
  expect(authorize).toHaveBeenCalledOnce();
  await view.renderRevision(0n, 2n, 2);
  expect(signal.aborted).toBe(true);
  expect(view.container.querySelector('[role="status"]')).toBeNull();
  expect(button(view.container, "Connect account").disabled).toBe(false);
  expect(view.onChanged).not.toHaveBeenCalled();
});
