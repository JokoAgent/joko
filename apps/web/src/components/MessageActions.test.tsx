// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageActions, sessionMessageDeepLink } from "./Timeline.js";
import type { Translator } from "./types.js";
import type { BrowserActionContext } from "../browser-action.js";

const sharing = vi.hoisted(() => ({ build: vi.fn(), deliver: vi.fn() }));
vi.mock("./share-message-image.js", async (original) => ({ ...await original<typeof import("./share-message-image.js")>(), buildShareMessageImagePng: sharing.build, deliverShareMessageImage: sharing.deliver }));

const roots: Root[] = [];
const t: Translator = (key) => key;
let clipboardDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  sharing.build.mockReset().mockResolvedValue(new Blob(["image"], { type: "image/png" }));
  sharing.deliver.mockReset().mockResolvedValue("dispatched");
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  if (clipboardDescriptor === undefined) Reflect.deleteProperty(navigator, "clipboard");
  else Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  vi.restoreAllMocks();
});

describe("message clipboard actions", () => {
  it("reports failure, retries and copies the canonical message link while restoring menu focus", async () => {
    const first = deferred();
    const writeText = vi.fn<(value: string) => Promise<void>>().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { host } = mount();
    const copy = host.querySelector<HTMLButtonElement>('button[aria-label="timeline.copy"]')!;
    await act(async () => { copy.click(); copy.click(); });
    expect(writeText).toHaveBeenCalledExactlyOnceWith("Message text");
    expect(copy.disabled).toBe(true);
    await act(async () => first.reject(new Error("private clipboard failure")));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("timeline.blockCopyFailed");
    expect(copy.disabled).toBe(false);
    await act(async () => copy.click());
    expect(host.querySelector('[role="status"]')?.textContent).toBe("timeline.blockCopied");
    expect(copy.ariaLabel).toBe("timeline.blockCopied");

    const menu = host.querySelector("details")!;
    const summary = menu.querySelector("summary")!;
    const link = menu.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    await act(async () => { menu.open = true; link.focus(); link.click(); });
    expect(writeText).toHaveBeenLastCalledWith(sessionMessageDeepLink("task", "message", "event", window.location.href));
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(summary);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("timeline.linkCopied");

    writeText.mockRejectedValueOnce(new Error("denied"));
    await act(async () => { menu.open = true; link.click(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("timeline.linkCopyFailed");
    Reflect.deleteProperty(navigator, "clipboard");
    await act(async () => copy.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("timeline.blockCopyFailed");
    expect(host.textContent).not.toContain("private clipboard failure");
  });

  it("ignores late clipboard replies after changing task or unmounting and clears feedback timers", async () => {
    const old = deferred();
    const closing = deferred();
    const writeText = vi.fn<(value: string) => Promise<void>>().mockImplementationOnce(() => old.promise).mockResolvedValueOnce(undefined).mockImplementationOnce(() => closing.promise);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { host, root } = mount();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="timeline.copy"]')!.click());
    await act(async () => root.render(actions("task", "Message text", "another-profile")));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    const copy = host.querySelector<HTMLButtonElement>('button[aria-label="timeline.copy"]')!;
    expect(copy.disabled).toBe(false);
    await act(async () => copy.click());
    await act(async () => old.reject(new Error("late failure")));
    expect(host.querySelector('[role="status"]')?.textContent).toBe("timeline.blockCopied");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    await act(async () => copy.click());
    expect(clearTimeout).toHaveBeenCalled();
    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    await act(async () => closing.resolve());
    expect(host.childElementCount).toBe(0);
  });

  it("uses the clipboard and feedback timer of the document containing the controls", async () => {
    const wrongClipboard = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: wrongClipboard } });
    const frame = document.body.appendChild(document.createElement("iframe"));
    const owner = frame.contentWindow!;
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(owner.navigator, "clipboard", { configurable: true, value: { writeText } });
    const timer = vi.spyOn(owner, "setTimeout");
    const clear = vi.spyOn(owner, "clearTimeout");
    const { host, root } = mount(owner.document);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="timeline.copy"]')!.click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith("Message text");
    expect(wrongClipboard).not.toHaveBeenCalled();
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 2_400);
    const feedbackTimer = timer.mock.results.at(-1)!.value;
    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    expect(clear).toHaveBeenCalledWith(feedbackTimer);
  });

  it("keeps the newest copy or share feedback without cancelling an earlier authorized share", async () => {
    const delivered = deferredValue<string>();
    sharing.deliver.mockReturnValueOnce(delivered.promise);
    const writeText = vi.fn<(value: string) => Promise<void>>().mockRejectedValueOnce(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { host } = mount();
    const share = host.querySelector<HTMLButtonElement>('button[aria-label="timeline.shareAsImage"]')!;
    const copy = host.querySelector<HTMLButtonElement>('button[aria-label="timeline.copy"]')!;
    await act(async () => share.click());
    expect(sharing.deliver).toHaveBeenCalledOnce();
    await act(async () => copy.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("timeline.blockCopyFailed");
    await act(async () => delivered.resolve("dispatched"));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("timeline.blockCopyFailed");

    const pendingCopy = deferred();
    writeText.mockImplementationOnce(() => pendingCopy.promise);
    await act(async () => copy.click());
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="timeline.shareAsImage"]')!.click());
    expect(sharing.deliver).toHaveBeenCalledTimes(2);
    expect(host.querySelector('.message-share-feedback[role="status"]')?.textContent).toBe("timeline.shareDownloaded");
    await act(async () => pendingCopy.reject(new Error("old copy failure")));
    expect(host.querySelector('.message-share-feedback[role="status"]')?.textContent).toBe("timeline.shareDownloaded");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(sharing.deliver).toHaveBeenCalledTimes(2);
    expect(copy.disabled).toBe(false);
  });

  it("admits sharing once and retires source/profile ABA before late encoding can dispatch", async () => {
    const old = deferredValue<Blob>();
    const next = deferredValue<Blob>();
    sharing.build.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const { host, root } = mount();
    const share = host.querySelector<HTMLButtonElement>('button[aria-label="timeline.shareAsImage"]')!;
    await act(async () => { share.click(); share.click(); });
    expect(sharing.build).toHaveBeenCalledOnce();
    const oldAction = sharing.build.mock.calls[0]![1] as BrowserActionContext;
    await act(async () => root.render(actions()));
    expect(oldAction.signal.aborted).toBe(false);
    await act(async () => root.render(actions("task", "Message text", "other-profile")));
    await act(async () => root.render(actions()));
    expect(oldAction.signal.aborted).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="timeline.shareAsImage"]')!.click());
    await act(async () => old.resolve(new Blob(["old"])));
    expect(sharing.deliver).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="timeline.shareGenerating"]')?.disabled).toBe(true);
    await act(async () => next.resolve(new Blob(["new"])));
    expect(sharing.deliver).toHaveBeenCalledOnce();
    expect(host.querySelector('.message-share-feedback[role="status"]')?.textContent).toBe("timeline.shareDownloaded");
  });

  it("captures the containing Document and releases share pending state on pagehide and unmount", async () => {
    const pending = deferredValue<Blob>();
    sharing.build.mockReturnValueOnce(pending.promise);
    const frame = document.body.appendChild(document.createElement("iframe"));
    const owner = frame.contentWindow!;
    const { host, root } = mount(owner.document);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="timeline.shareAsImage"]')!.click());
    const action = sharing.build.mock.calls[0]![1] as BrowserActionContext;
    expect(action.ownerDocument).toBe(owner.document);
    await act(async () => owner.dispatchEvent(new Event("pagehide")));
    expect(action.signal.aborted).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="timeline.shareAsImage"]')?.disabled).toBe(false);
    sharing.deliver.mockRejectedValueOnce(new Error("unknown native outcome"));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="timeline.shareAsImage"]')!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("timeline.shareFailed");
    await act(async () => pending.resolve(new Blob(["old"])));
    expect(sharing.deliver).toHaveBeenCalledOnce();
    const closing = deferredValue<Blob>();
    sharing.build.mockReturnValueOnce(closing.promise);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="timeline.shareAsImage"]')!.click());
    const closeAction = sharing.build.mock.calls[2]![1] as BrowserActionContext;
    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    expect(closeAction.signal.aborted).toBe(true);
    await act(async () => closing.resolve(new Blob(["late"])));
    expect(sharing.deliver).toHaveBeenCalledOnce();
  });
});

function actions(sessionId = "task", text = "Message text", ownerKey = "profile") {
  return <MessageActions ownerKey={ownerKey} sessionId={sessionId} sessionName="Task" item={{ id: "message", sourceEventId: "event", kind: "assistant", sequence: 1n, createdAt: 0, text }} text={text} align="left" locale="en" t={t} forking={false} editable={false} />;
}

function mount(ownerDocument: Document = document) {
  const host = ownerDocument.body.appendChild(ownerDocument.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(actions()));
  return { host, root };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function deferredValue<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
