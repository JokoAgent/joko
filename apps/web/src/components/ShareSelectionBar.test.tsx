// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserActionContext } from "../browser-action.js";
import type { TimelineItemView } from "../model.js";
import type { Translator } from "./types.js";
import { ShareSelectionBar } from "./ShareSelectionBar.js";

const images = vi.hoisted(() => ({ build: vi.fn(), copy: vi.fn(), download: vi.fn() }));
vi.mock("./share-selection-image.js", async (original) => ({ ...await original<typeof import("./share-selection-image.js")>(), buildShareSelectionImagePng: images.build, copyShareSelectionImagePng: images.copy, downloadShareSelectionImagePng: images.download }));

const roots: Root[] = [];
const t: Translator = (key) => key;
const messages: readonly TimelineItemView[] = [{ id: "one", kind: "assistant", text: "First", sequence: 1n, createdAt: 0 }, { id: "two", kind: "user", text: "Second", sequence: 2n, createdAt: 1 }];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  images.build.mockReset().mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  images.copy.mockReset().mockResolvedValue(undefined);
  images.download.mockReset().mockResolvedValue("dispatched");
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("generated selection image ownership", () => {
  it("admits once, preserves equivalent renders, and retires selection ABA without disturbing new work", async () => {
    const old = deferred<Blob>();
    const next = deferred<Blob>();
    images.build.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const view = mount();
    await act(async () => { button(view.host, "Copy").click(); button(view.host, "Copy").click(); });
    expect(images.build).toHaveBeenCalledOnce();
    const oldAction = images.build.mock.calls[0]![1] as BrowserActionContext;
    await act(async () => view.render("one"));
    expect(oldAction.signal.aborted).toBe(false);
    await act(async () => view.render("two"));
    await act(async () => view.render("one"));
    expect(oldAction.signal.aborted).toBe(true);
    await act(async () => button(view.host, "Copy").click());
    await act(async () => old.resolve(new Blob(["old"])));
    expect(images.copy).not.toHaveBeenCalled();
    expect(button(view.host, "Copy").disabled).toBe(true);
    await act(async () => next.reject(new Error("private error")));
    expect(view.host.querySelector('[role="alert"]')?.textContent).toBe("timeline.shareSelectionClipboardFailed");
    expect(button(view.host, "Copy").disabled).toBe(false);
    await act(async () => button(view.host, "Copy").click());
    expect(images.copy).toHaveBeenCalledOnce();
    expect(view.host.querySelector('[role="status"]')?.textContent).toBe("timeline.shareSelectionCopied");
  });

  it("allows explicit cancel during encoding and suppresses late dispatch after unmount", async () => {
    const pending = deferred<Blob>();
    images.build.mockReturnValueOnce(pending.promise);
    const view = mount();
    await act(async () => button(view.host, "Download").click());
    const action = images.build.mock.calls[0]![1] as BrowserActionContext;
    const cancel = view.host.querySelector<HTMLButtonElement>('button:not([disabled])')!;
    expect(cancel.textContent).toContain("common.cancel");
    await act(async () => cancel.click());
    expect(view.onCancel).toHaveBeenCalledOnce();
    expect(action.signal.aborted).toBe(true);
    await act(async () => view.root.unmount());
    roots.splice(roots.indexOf(view.root), 1);
    await act(async () => pending.resolve(new Blob(["late"])));
    expect(images.download).not.toHaveBeenCalled();
    expect(view.onCancel).toHaveBeenCalledOnce();
  });

  it("uses the containing Document and releases pending work and success timers on pagehide", async () => {
    vi.useFakeTimers();
    const frame = document.body.appendChild(document.createElement("iframe"));
    const owner = frame.contentWindow!;
    const view = mount(owner.document);
    const old = deferred<Blob>();
    images.build.mockReturnValueOnce(old.promise);
    await act(async () => button(view.host, "Download").click());
    const action = images.build.mock.calls[0]![1] as BrowserActionContext;
    expect(action.ownerDocument).toBe(owner.document);
    await act(async () => owner.dispatchEvent(new Event("pagehide")));
    expect(action.signal.aborted).toBe(true);
    expect(button(view.host, "Download").disabled).toBe(false);
    await act(async () => button(view.host, "Download").click());
    expect(images.download.mock.calls[0]?.[3]).toMatchObject({ ownerDocument: owner.document });
    await act(async () => old.reject(new Error("old encoding")));
    expect(view.host.querySelector('[role="status"]')?.textContent).toBe("timeline.shareDownloaded");
    await act(async () => owner.dispatchEvent(new Event("pagehide")));
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(view.onCancel).not.toHaveBeenCalled();
    await act(async () => button(view.host, "Copy").click());
    await act(async () => vi.advanceTimersByTime(900));
    expect(view.onCancel).toHaveBeenCalledOnce();
  });

  it("retires success close timers before a new request or a profile change", async () => {
    vi.useFakeTimers();
    const view = mount();
    await act(async () => button(view.host, "Copy").click());
    const pending = deferred<Blob>();
    images.build.mockReturnValueOnce(pending.promise);
    await act(async () => button(view.host, "Download").click());
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(view.onCancel).not.toHaveBeenCalled();
    const action = images.build.mock.calls[1]![1] as BrowserActionContext;
    await act(async () => view.render("one", "next-profile"));
    expect(action.signal.aborted).toBe(true);
    await act(async () => pending.resolve(new Blob(["late"])));
    expect(images.download).not.toHaveBeenCalled();
    expect(view.host.querySelector('[role="status"]')).toBeNull();
  });
});

function button(host: HTMLElement, kind: "Copy" | "Download"): HTMLButtonElement {
  return Array.from(host.querySelectorAll("button")).find((element) => element.textContent?.includes(`timeline.shareSelection${kind}`))!;
}

function mount(ownerDocument: Document = document) {
  const host = ownerDocument.body.appendChild(ownerDocument.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  const onCancel = vi.fn();
  const render = (selected = "one", ownerKey = "profile") => root.render(<ShareSelectionBar ownerKey={ownerKey} sessionName="Task" messages={[...messages]} selectedIds={new Set([selected])} locale="en" t={t} onToggleAll={() => undefined} onCancel={onCancel} />);
  act(() => render());
  return { host, root, render, onCancel };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
