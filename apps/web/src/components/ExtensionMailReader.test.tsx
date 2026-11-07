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
type Preview = { supported: boolean; messageJson: string; error?: string; readerChoices?: readonly { selectionId: string; displayName: string }[] };
function fixture(server = "first") {
  const previewMail = vi.fn(async ({ url, read }: { url: string; read: boolean; readerSelectionId?: string }): Promise<Preview> => ({ supported: true, messageJson: read ? JSON.stringify(message(url.split("/").at(-1)!)) : "" }));
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
it("reads an overlapping mail link only through the explicitly selected current plugin", async () => {
  const f = fixture(), initial = [{ selectionId: "retired", displayName: "First plugin" }, { selectionId: "alternate", displayName: "Second plugin" }];
  f.previewMail.mockImplementation(async ({ read, readerSelectionId }) => {
    if (!read) return { supported: true, messageJson: "" };
    if (readerSelectionId === undefined) return { supported: true, messageJson: "", error: "MAIL_PROVIDER_AMBIGUOUS", readerChoices: initial };
    if (readerSelectionId === "retired") return { supported: true, messageJson: "", error: "MAIL_PROVIDER_CHANGED", readerChoices: [initial[1]!] };
    return { supported: true, messageJson: JSON.stringify(message("from the second plugin")) };
  });
  const button = (label: string) => [...document.querySelectorAll("button")].find(item => item.textContent === label)!;
  const dialog = () => document.querySelector('[role="dialog"]');
  await act(async () => f.render());
  await act(async () => button("First link").click());
  expect(dialog()?.textContent).toContain("Choose a plugin to read this message");
  expect(f.previewMail.mock.calls.map(([request]) => request.readerSelectionId)).toEqual([undefined, undefined]);
  await act(async () => button("First plugin").click());
  expect(dialog()?.textContent).toContain("The selected plugin changed");
  expect(f.previewMail).toHaveBeenCalledTimes(3);
  await act(async () => button("Second plugin").click());
  expect(f.previewMail).toHaveBeenLastCalledWith({ sessionId: "task", url: "https://mail.example.test/one", read: true, opened: true,
    readerSelectionId: "alternate" }, expect.any(Object));
  expect(dialog()?.textContent).toContain("Body from the second plugin");
  expect(f.fallback).not.toHaveBeenCalled();
});
it("fences a pending opening when its node changes", async () => {
  const f = fixture(); let finish!: (value: { supported: boolean; messageJson: string }) => void;
  f.previewMail.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => f.render()); await act(async () => [...f.element.querySelectorAll("button")].find(button => button.textContent === "First link")!.click());
  const next = { ...f.controller, state: { ...f.controller.state, activeProfile: { ...f.controller.state.activeProfile!, serverId: "second" } } };
  await act(async () => f.render(next)); await act(async () => finish({ supported: true, messageJson: "" }));
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(f.failures).toHaveLength(1); expect(f.fallback).not.toHaveBeenCalled();
});
