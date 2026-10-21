// @vitest-environment jsdom
import { create } from "@bufbuild/protobuf";
import { ExtensionNetworkConnectionSchema, ExtensionNetworkServiceGetResponseSchema, ExtensionNetworkServiceChangeResponseSchema, ExtensionNetworkStateSchema } from "@joko/contracts";
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import type { ExtensionCatalogEntryView, ExtensionNetworkApi } from "../model.js";
import { translate } from "../i18n.js";
import { ExtensionNetworkSection } from "./ExtensionNetworkSection.js";
import type { Translator } from "./types.js";

const roots: Root[] = [], t: Translator = (key, values) => translate("en", key, values);
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.replaceChildren(); });
const state = () => create(ExtensionNetworkStateSchema, { extensionId: "extension-one", revision: { value: 1n }, slots: [{ key: "service", label: "Service", maximumConnections: 2,
  connections: [{ connectionId: "one", host: "one.example.test", isDefault: true, configured: true }] }] });
async function render(api: ExtensionNetworkApi) {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); roots.push(root);
  const onChanged = vi.fn(async () => {}), controller = { extensionNetworkApi: () => api } as unknown as AppController;
  await act(async () => root.render(<StrictMode><ExtensionNetworkSection controller={controller} extension={{ id: "extension-one", revision: 1n } as ExtensionCatalogEntryView} disabled={false} t={t} onChanged={onChanged} /></StrictMode>));
  return { container, onChanged };
}
function button(container: ParentNode, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(row => row.textContent === text); if (!found) throw new Error(`Missing ${text}`); return found;
}
function input(container: ParentNode, index: number, value: string) {
  const field = container.querySelectorAll("input")[index]!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true }));
}

it("keeps failed connection edits visible without retrying a mutation and clears the secret only after success", async () => {
  let current = state(), fail = true;
  const get = vi.fn(async () => create(ExtensionNetworkServiceGetResponseSchema, { state: current }));
  const save = vi.fn<ExtensionNetworkApi["save"]>(async () => {
    if (fail) throw new Error("Delivery unavailable");
    current = structuredClone(current); current.revision!.value = 2n;
    current.slots[0]!.connections.push(create(ExtensionNetworkConnectionSchema, { connectionId: "two", host: "two.example.test", label: "Second", configured: true, isDefault: false })); return current;
  });
  const { container, onChanged } = await render({ get, save, change: vi.fn() });
  await act(async () => { input(container, 0, "two.example.test"); input(container, 1, "Second"); input(container, 2, "test-private-token"); });
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("never resent automatically");
  expect([...container.querySelectorAll("input")].map(row => row.value)).toEqual(["two.example.test", "Second", "test-private-token"]);
  expect(save).toHaveBeenCalledTimes(1); expect(onChanged).not.toHaveBeenCalled();
  fail = false;
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(save).toHaveBeenCalledTimes(2); expect(onChanged).toHaveBeenCalledOnce(); expect(container.textContent).toContain("Second");
  expect([...container.querySelectorAll("input")].map(row => row.value)).toEqual(["", "", ""]);
  expect(save.mock.calls[0]!.slice(0, 2)).toMatchObject([{ extensionId: "extension-one", expectedRevision: { value: 1n }, slotKey: "service", host: "two.example.test", label: "Second" }, "test-private-token"]);
  expect(button(container, "Add connection").disabled).toBe(true);
});

it("updates a fixed existing host and submits explicit default and removal actions", async () => {
  let current = state(); current.slots[0]!.connections.push({ ...current.slots[0]!.connections[0]!, connectionId: "two", host: "two.example.test", isDefault: false });
  const change = vi.fn<ExtensionNetworkApi["change"]>(async () => create(ExtensionNetworkServiceChangeResponseSchema, { state: current }));
  const { container } = await render({ get: async () => create(ExtensionNetworkServiceGetResponseSchema, { state: current }), save: vi.fn(), change });
  await act(async () => button(container, "Set as default").click());
  expect(change.mock.calls[0]![0]).toMatchObject({ extensionId: "extension-one", slotKey: "service", expectedRevision: { value: 1n }, action: { case: "defaultConnectionId", value: "two" } });
  await act(async () => container.querySelectorAll<HTMLButtonElement>(".extension-network__row button")[0]!.click());
  expect(container.querySelector("input")!.readOnly).toBe(true); expect(container.querySelector("input")!.value).toBe("one.example.test");
  await act(async () => button(container, "Cancel").click()); expect(container.querySelector("input")!.readOnly).toBe(false);
  const remove = [...container.querySelectorAll("button")].find(row => row.textContent === "Remove")!;
  await act(async () => remove.click()); expect(change.mock.calls[1]![0].action).toEqual({ case: "removeConnectionId", value: "one" });
});
