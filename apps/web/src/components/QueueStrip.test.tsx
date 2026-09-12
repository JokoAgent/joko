// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import type { QueueItemView } from "../model.js";
import { SELECTION_QUOTE_BLOCK_MARKER_LINE } from "../selection-quote.js";
import { QueueStrip } from "./QueueStrip.js";
import type { RunAction } from "./types.js";

let root: Root | undefined;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  Reflect.deleteProperty(document, "elementFromPoint");
  vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren();
});
const item = (id: string, ordinal: number): QueueItemView => ({ id, ordinal, sessionId: "task", revision: 1n, generation: 1n,
  source: "user", mode: "followUp", text: `Queued ${id}`, state: "accepted", editLocked: false, createdAt: ordinal });
const initial = [item("first", 0), item("second", 1)];
const api = () => ({
  setQueueItemEditLock: vi.fn< AppController["setQueueItemEditLock"]>().mockResolvedValue(undefined),
  setQueueInteractionLock: vi.fn< AppController["setQueueInteractionLock"]>().mockResolvedValue(undefined),
  editQueueItem: vi.fn< AppController["editQueueItem"]>().mockResolvedValue(undefined),
  reorderQueueItem: vi.fn< AppController["reorderQueueItem"]>().mockResolvedValue(undefined),
  cancelQueueItem: vi.fn< AppController["cancelQueueItem"]>().mockResolvedValue(undefined),
  steerQueueItemNow: vi.fn< AppController["steerQueueItemNow"]>().mockResolvedValue(undefined),
  pauseQueue: vi.fn< AppController["pauseQueue"]>().mockResolvedValue(undefined),
  resumeQueue: vi.fn< AppController["resumeQueue"]>().mockResolvedValue(undefined)
});
async function fixture() {
  const controller = api();
  const failures: unknown[] = [];
  const runAction: RunAction = (_key, action) => { void action().catch((error: unknown) => failures.push(error)); };
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  const render = async (items = initial, owner = controller) => act(async () => root!.render(<QueueStrip sessionId="task" items={items}
    controller={owner as unknown as AppController} supportedDispositions={["followUp", "steer"]} runAction={runAction} t={(key) => key}
    expanded={false} onExpandedChange={vi.fn()} />));
  await render();
  const row = (id = "first") => host.querySelector<HTMLElement>(`[data-queue-item-id="${id}"]`)!;
  const button = (label: string, id = "first") => [...row(id).querySelectorAll<HTMLButtonElement>("button")].find((value) => value.getAttribute("aria-label") === label || value.textContent === label)!;
  return { host, controller, failures, render, row, button };
}
async function change(textarea: HTMLTextAreaElement, text: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function transactionalChange(textarea: HTMLTextAreaElement, text: string, selectionStart: number, selectionEnd: number, inputType: string) {
  await act(async () => {
    textarea.setSelectionRange(selectionStart, selectionEnd);
    textarea.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType }));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType }));
  });
}
function pointer(target: HTMLElement, type: string, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: y });
  Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "touch" } });
  target.dispatchEvent(event);
}
function capture(handle: HTMLButtonElement) {
  let captured = false;
  handle.setPointerCapture = () => { captured = true; };
  handle.hasPointerCapture = () => captured;
  handle.releasePointerCapture = () => { captured = false; };
}

it("renews an edit across projection updates and preserves the draft, lock identity and focus through renewal and save failures", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await act(async () => f.button("queue.edit").click());
  const textarea = f.host.querySelector<HTMLTextAreaElement>("textarea")!;
  await change(textarea, "Unsaved wording");
  const token = f.controller.setQueueItemEditLock.mock.calls[0]![1];
  for (let round = 0; round < 9; round += 1) {
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    await f.render(initial.map((entry) => ({ ...entry, revision: BigInt(round + 2) })));
  }
  expect(f.controller.setQueueItemEditLock.mock.calls.filter((call) => call[2])).toHaveLength(4);
  f.controller.setQueueItemEditLock.mockRejectedValueOnce(new Error("renewal acknowledgement lost"));
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(textarea.value).toBe("Unsaved wording");
  expect(f.host.querySelector('[role="alert"]')?.textContent).toBe("queue.editLockLost");
  expect(f.button("common.save").disabled).toBe(true);
  await act(async () => f.button("queue.reacquireEditLock").click());
  expect(f.controller.setQueueItemEditLock).toHaveBeenLastCalledWith("first", token, true);
  expect(f.button("common.save").disabled).toBe(false);
  let rejectSave!: (reason: Error) => void;
  f.controller.editQueueItem.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject; }));
  textarea.focus();
  await act(async () => textarea.form!.requestSubmit());
  expect(f.controller.editQueueItem).toHaveBeenCalledWith("first", {
    text: "Unsaved wording",
    mentionRanges: [],
    pastedTextRanges: [],
    textSplices: [{ start: 0, end: "Queued first".length, replacementText: "Unsaved wording" }]
  }, "followUp", token);
  expect(textarea.disabled).toBe(true);
  document.body.focus();
  await act(async () => rejectSave(new Error("save failed")));
  expect(textarea.value).toBe("Unsaved wording");
  expect(document.activeElement).toBe(textarea);
  expect(f.controller.setQueueItemEditLock).toHaveBeenLastCalledWith("first", token, true);
  await act(async () => f.button("common.cancel").click());
  expect(f.host.querySelector("textarea")).toBeNull();
  expect(f.controller.setQueueItemEditLock).toHaveBeenLastCalledWith("first", token, false);
  expect(document.activeElement).toBe(f.button("queue.edit"));
});

it("keeps accepted input atoms static, steers by queue identity and closes an untouched edit without mutation", async () => {
  const f = await fixture();
  const text = `${SELECTION_QUOTE_BLOCK_MARKER_LINE}\n> Selected line\n\nUse @report`;
  const mentionStart = text.indexOf("@report");
  const structured: QueueItemView = {
    ...item("structured", 0),
    text,
    quotesEncoded: true,
    inputMentions: [{ kind: "artifact", artifactId: "artifact-1", displayText: "@report" }],
    mentionRanges: [{ start: mentionStart, end: mentionStart + "@report".length, mentionIndex: 0 }],
    attachments: [{ kind: "file", label: "notes.txt" }]
  };
  await f.render([structured]);

  const preview = f.row("structured").querySelector<HTMLElement>(".queue-input-preview")!;
  expect(preview.querySelector("[data-selection-quote-chip]")?.textContent).toContain("Selected line");
  expect(preview.querySelector("[data-queue-mention-kind=artifact] [data-queue-chip-label]")?.textContent).toBe("@report");
  expect(preview.querySelector("[data-queue-attachment-kind=file] [data-queue-chip-label]")?.textContent).toBe("notes.txt");
  expect(preview.querySelector("button, a, [tabindex]")).toBeNull();

  await act(async () => f.button("queue.steerNow", "structured").click());
  const steerToken = f.controller.setQueueItemEditLock.mock.calls.find((call) => call[0] === "structured" && call[2])![1];
  expect(f.controller.steerQueueItemNow).toHaveBeenCalledExactlyOnceWith("structured", steerToken);

  await act(async () => f.button("queue.edit", "structured").click());
  const textarea = f.host.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(textarea.value).toBe("> Selected line\n\nUse @report");
  await act(async () => textarea.form!.requestSubmit());
  expect(f.controller.editQueueItem).not.toHaveBeenCalled();
  expect(f.host.querySelector("textarea")).toBeNull();
});

it("carries only untouched same-label references through the textarea's actual edit receipt", async () => {
  const f = await fixture();
  const structured: QueueItemView = {
    ...item("same-labels", 0),
    text: "@same @same",
    inputMentions: [
      { kind: "artifact", artifactId: "first", displayText: "same" },
      { kind: "workspace", workspaceId: "workspace", relativePath: "second.ts", displayText: "same", directory: false }
    ],
    mentionRanges: [
      { start: 0, end: 5, mentionIndex: 0 },
      { start: 6, end: 11, mentionIndex: 1 }
    ]
  };
  await f.render([structured]);
  await act(async () => f.button("queue.edit", "same-labels").click());
  const textarea = f.host.querySelector<HTMLTextAreaElement>("textarea")!;
  await transactionalChange(textarea, "@same", 0, 6, "deleteContentForward");
  await act(async () => textarea.form!.requestSubmit());
  const token = f.controller.setQueueItemEditLock.mock.calls.find((call) => call[0] === "same-labels" && call[2])![1];
  expect(f.controller.editQueueItem).toHaveBeenCalledExactlyOnceWith("same-labels", {
    text: "@same",
    mentionRanges: [{ start: 0, end: 5, mentionIndex: 1 }],
    pastedTextRanges: [],
    textSplices: [{ start: 0, end: 6, replacementText: "" }]
  }, "followUp", token);
});

it("revokes a same-label occurrence after a same-content native replacement", async () => {
  const f = await fixture();
  const structured: QueueItemView = {
    ...item("same-replacement", 0),
    text: "@same @same",
    inputMentions: [
      { kind: "session", sessionId: "first-task", displayText: "same" },
      { kind: "session", sessionId: "second-task", displayText: "same" }
    ],
    mentionRanges: [
      { start: 0, end: 5, mentionIndex: 0 },
      { start: 6, end: 11, mentionIndex: 1 }
    ]
  };
  await f.render([structured]);
  await act(async () => f.button("queue.edit", "same-replacement").click());
  const textarea = f.host.querySelector<HTMLTextAreaElement>("textarea")!;
  await transactionalChange(textarea, textarea.value, 0, 5, "insertReplacementText");
  await act(async () => textarea.form!.requestSubmit());
  const token = f.controller.setQueueItemEditLock.mock.calls
    .find((call) => call[0] === "same-replacement" && call[2])![1];
  expect(f.controller.editQueueItem).toHaveBeenCalledExactlyOnceWith("same-replacement", {
    text: "@same @same",
    mentionRanges: [{ start: 6, end: 11, mentionIndex: 1 }],
    pastedTextRanges: [],
    textSplices: [{ start: 0, end: 5, replacementText: "@same" }]
  }, "followUp", token);
});

it("releases a late acquisition through its original owner and never opens an editor in the replacement connection", async () => {
  const f = await fixture();
  let acknowledge!: () => void;
  f.controller.setQueueItemEditLock.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
  await act(async () => f.button("queue.edit").click());
  await act(async () => f.button("queue.edit", "second").click());
  expect(f.controller.setQueueItemEditLock).toHaveBeenCalledTimes(1);
  const replacement = api();
  await f.render(initial, replacement);
  await act(async () => acknowledge());
  expect(f.host.querySelector("textarea")).toBeNull();
  expect(f.controller.setQueueItemEditLock.mock.calls.map((call) => call[2])).toEqual([true, false]);
  expect(replacement.setQueueItemEditLock).not.toHaveBeenCalled();
});

it("reorders from a touch handle after acquiring and renewing its interaction lease", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const handle = f.row().querySelector<HTMLButtonElement>(".queue-strip__drag-handle")!;
  capture(handle);
  const target = f.row("second");
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: 40, height: 40 } as DOMRect);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
  await act(async () => pointer(handle, "pointerdown", 10));
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(f.controller.setQueueInteractionLock.mock.calls.map((call) => call[2])).toEqual([true, true]);
  await act(async () => pointer(handle, "pointermove", 70));
  expect(target.classList.contains("is-drag-target")).toBe(true);
  await act(async () => pointer(handle, "pointerup", 70));
  const token = f.controller.setQueueInteractionLock.mock.calls[0]![1];
  expect(f.controller.reorderQueueItem).toHaveBeenCalledExactlyOnceWith("first", "after", "second", token);
  expect(f.controller.setQueueInteractionLock).toHaveBeenLastCalledWith("task", token, false);
  expect(handle.hasPointerCapture(7)).toBe(false);
});

it.each(["cancel", "unknown", "acquire failure"] as const)("does not dispatch a touch reorder after %s retires a pending interaction", async (outcome) => {
  const f = await fixture();
  const handle = f.row().querySelector<HTMLButtonElement>(".queue-strip__drag-handle")!;
  capture(handle);
  const target = f.row("second");
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: 40, height: 40 } as DOMRect);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
  let acknowledge!: () => void;
  let reject!: (reason: Error) => void;
  f.controller.setQueueInteractionLock.mockImplementationOnce(() => new Promise((resolve, rejectPromise) => { acknowledge = resolve; reject = rejectPromise; }));
  await act(async () => pointer(handle, "pointerdown", 10));
  await act(async () => pointer(handle, "pointermove", 70));
  if (outcome === "cancel") await act(async () => pointer(handle, "pointercancel", 70));
  else {
    await act(async () => pointer(handle, "pointerup", 70));
    if (outcome === "unknown") await f.render(initial.map((entry) => entry.id === "first" ? { ...entry, state: "dispatchUnknown" } : entry));
  }
  await act(async () => outcome === "acquire failure" ? reject(new Error("Lock acknowledgement lost")) : acknowledge());
  expect(f.controller.reorderQueueItem).not.toHaveBeenCalled();
  expect(f.controller.setQueueInteractionLock.mock.calls.map((call) => call[2])).toEqual([true, false]);
});

it("cancels pointer capture and prevents a drop after the interaction lease cannot renew", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const handle = f.row().querySelector<HTMLButtonElement>(".queue-strip__drag-handle")!;
  capture(handle);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => f.row("second") });
  await act(async () => pointer(handle, "pointerdown", 10));
  await act(async () => pointer(handle, "pointermove", 70));
  f.controller.setQueueInteractionLock.mockRejectedValueOnce(new Error("Lease expired"));
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(handle.hasPointerCapture(7)).toBe(false);
  expect(f.row().classList.contains("is-dragging")).toBe(false);
  await act(async () => pointer(handle, "pointerup", 70));
  expect(f.controller.reorderQueueItem).not.toHaveBeenCalled();
  expect(f.controller.setQueueInteractionLock.mock.calls.map((call) => call[2])).toEqual([true, true, false]);
});
