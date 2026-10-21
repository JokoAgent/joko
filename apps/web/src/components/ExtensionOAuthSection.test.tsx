// @vitest-environment jsdom
import { StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { ExtensionOAuthStateSchema, ExtensionOAuthServiceGetResponseSchema } from "@joko/contracts";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import type { ExtensionCatalogEntryView, ExtensionOAuthApi } from "../model.js";
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
  const controller = { extensionOAuthApi: () => api } as unknown as AppController, onChanged = vi.fn(async () => {});
  await act(async () => root.render(<StrictMode><ExtensionOAuthSection controller={controller} extension={{ id: "extension-one", revision: 1n } as ExtensionCatalogEntryView} disabled={false} t={(key, values) => translate("en", key, values)} onChanged={onChanged} /></StrictMode>));
  return { container, root, onChanged };
}
function button(container: ParentNode, label: string) { const found = [...container.querySelectorAll("button")].find(button => button.textContent === label); if (!found) throw new Error("Missing button"); return found; }
function input(container: ParentNode, index: number, value: string) { const field = container.querySelectorAll(".extension-network__form input")[index]!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); }

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
