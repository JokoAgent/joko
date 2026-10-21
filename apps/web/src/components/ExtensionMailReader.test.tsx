// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { ExtensionMailReaderProvider, useExtensionMailLinkHandler } from "./ExtensionMailReader.js";

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false }))); });
const roots: Array<{ root: Root; element: HTMLElement }> = [];
afterEach(async () => { for (const { root, element } of roots.splice(0)) { await act(async () => root.unmount()); element.remove(); } });
const message = (id: string) => ({ accountId: "account", messageId: id, from: "Sender", to: "Owner", cc: "", bcc: "", subject: id, date: "Today", bodyText: `Body ${id}`, bodyHtml: "", attachments: [] });
function fixture(server = "first") {
  const previewMail = vi.fn(async ({ url, read }: { url: string; read: boolean }) => ({ supported: true, messageJson: read ? JSON.stringify(message(url.split("/").at(-1)!)) : "" }));
  const controller = { state: { connectionState: "connected", connectionGeneration: 1, navigationRevision: 1, route: { kind: "session", sessionId: "task" },
    activeProfile: { id: "owner", serverId: server, origin: `https://${server}.example.test` } }, extensionCardApi: () => ({ previewMail }), openHttpLink: vi.fn(async () => {}) } as unknown as AppController;
  const fallback = vi.fn(async () => {}), failures: unknown[] = [];
  function Links() { const open = useExtensionMailLinkHandler(fallback)!; return <>
    <button onClick={() => void open("https://mail.example.test/one").catch(error => failures.push(error))}>First link</button>
    <button onClick={() => void open("https://mail.example.test/two").catch(error => failures.push(error))}>Second link</button>
    <button onClick={() => void open("https://mail.example.test/external", { forceExternal: true })}>External link</button>
  </>; }
  const element = document.body.appendChild(document.createElement("div")), root = createRoot(element); roots.push({ root, element });
  const render = (view = controller) => root.render(<ExtensionMailReaderProvider controller={view} sessionId="task" t={key => translate("en", key)}><Links /></ExtensionMailReaderProvider>);
  return { root, element, render, controller, fallback, previewMail, failures };
}
it("reads a mail message only after its explicit opening and leaves external-link intent with the browser", async () => {
  const f = fixture(); await act(async () => f.render());
  expect(f.previewMail).not.toHaveBeenCalled();
  await act(async () => [...f.element.querySelectorAll("button")].find(button => button.textContent === "External link")!.click());
  expect(f.fallback).toHaveBeenCalledWith("https://mail.example.test/external", { forceExternal: true }); expect(f.previewMail).not.toHaveBeenCalled();
  await act(async () => [...f.element.querySelectorAll("button")].find(button => button.textContent === "First link")!.click());
  expect(f.previewMail.mock.calls.map(([request]) => request.read)).toEqual([false, true]);
  expect(f.previewMail).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "task", opened: true }), expect.any(Object));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Body one"); expect(document.querySelector('[role="dialog"] input')).toBeNull();
  expect(f.fallback).toHaveBeenCalledTimes(1);
});
it("does not let an older link probe replace a newer opened message", async () => {
  const f = fixture(), completions = new Map<string, (value: { supported: boolean; messageJson: string }) => void>();
  f.previewMail.mockImplementation(async ({ read, url }) => read ? { supported: true, messageJson: JSON.stringify(message(url.split("/").at(-1)!)) }
    : new Promise(resolve => completions.set(url, resolve)));
  await act(async () => f.render());
  await act(async () => { [...f.element.querySelectorAll("button")].find(button => button.textContent === "First link")!.click(); [...f.element.querySelectorAll("button")].find(button => button.textContent === "Second link")!.click(); });
  await act(async () => completions.get("https://mail.example.test/two")!({ supported: true, messageJson: "" }));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Body two");
  await act(async () => completions.get("https://mail.example.test/one")!({ supported: true, messageJson: "" }));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Body two"); expect(f.previewMail.mock.calls.filter(([request]) => request.read)).toHaveLength(1);
});
it("fences a pending opening when its node changes", async () => {
  const f = fixture(); let finish!: (value: { supported: boolean; messageJson: string }) => void;
  f.previewMail.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => f.render()); await act(async () => [...f.element.querySelectorAll("button")].find(button => button.textContent === "First link")!.click());
  const next = { ...f.controller, state: { ...f.controller.state, activeProfile: { ...f.controller.state.activeProfile!, serverId: "second" } } };
  await act(async () => f.render(next)); await act(async () => finish({ supported: true, messageJson: "" }));
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(f.failures).toHaveLength(1); expect(f.fallback).not.toHaveBeenCalled();
});
