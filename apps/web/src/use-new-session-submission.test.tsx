// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { AppController, AppRoute } from "./controller.js";
import type { ComposerDraft } from "./model.js";
import type { DelayedNewSessionDraft } from "./new-session-flow.js";
import { useNewSessionSubmission } from "./use-new-session-submission.js";

let root: Root | undefined;
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { if (root !== undefined) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); });
const draft: DelayedNewSessionDraft = { selection: { kind: "target", targetId: "target" }, name: "Task", nativeStart: { kind: "fresh" }, providerId: "provider", modelId: "model", fastMode: false, permissionMode: "ask", planMode: false };
const input: ComposerDraft = { text: "Final dictated text", attachments: [], mentions: [], deliveryMode: "prompt" };
const describe = (error: unknown) => (error as Error).message;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function api() {
  return {
    state: { route: { kind: "newSession" }, connectionState: "connected", activeProfile: { id: "profile" }, navigationRevision: 0 },
    createSession: vi.fn(async () => ({ sessionId: "created", generation: 4n })),
    send: vi.fn(async () => undefined),
    clearNewSessionDraft: vi.fn(async () => undefined),
    navigate: vi.fn()
  } as unknown as AppController;
}

async function mount(controller: AppController) {
  let submit!: ReturnType<typeof useNewSessionSubmission>;
  let error: string | undefined;
  let busy: string | undefined;
  function Probe({ value }: { value: AppController }) {
    const [message, setMessage] = useState<string>();
    const [action, setAction] = useState<string>();
    error = message;
    busy = action;
    submit = useNewSessionSubmission(value, setMessage, setAction, describe);
    return null;
  }
  root = createRoot(document.body.appendChild(document.createElement("div")));
  const render = async (value: AppController) => act(async () => root!.render(<Probe value={value} />));
  await render(controller);
  return { render, submit: (...args: Parameters<typeof submit>) => submit(...args), error: () => error, busy: () => busy };
}

it.each(["draft", "route", "pagehide"] as const)("keeps accepted creation on its original API while retiring %s presentation", async (cause) => {
  const original = api();
  const creation = deferred<{ sessionId: string; generation: bigint }>();
  vi.mocked(original.createSession).mockReturnValue(creation.promise);
  const probe = await mount(original);
  let current = true;
  const lifetime = new AbortController();
  let pending!: Promise<void>;
  await act(async () => { pending = probe.submit(draft, input, { ownerDocument: document, signal: lifetime.signal, isCurrent: () => current }); });
  if (cause === "draft") await act(async () => { current = false; lifetime.abort(); });
  if (cause === "route") {
    await probe.render({ ...original, state: { ...original.state, route: { kind: "settings" } } });
    await probe.render(original);
  }
  if (cause === "pagehide") await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(probe.busy()).toBeUndefined();
  await act(async () => { creation.resolve({ sessionId: "created", generation: 4n }); await pending; });
  expect(original.send).toHaveBeenCalledExactlyOnceWith("created", input, { expectedGeneration: 4n });
  expect(original.clearNewSessionDraft).not.toHaveBeenCalled();
  expect(original.navigate).not.toHaveBeenCalled();
  expect(probe.error()).toBeUndefined();
  expect(probe.busy()).toBeUndefined();
});

it("shows a send failure on the task it revealed, but a later route never adopts the old result", async () => {
  const original = api();
  const send = deferred<void>();
  vi.mocked(original.send).mockReturnValue(send.promise);
  const probe = await mount(original);
  let current = true;
  const lifetime = new AbortController();
  let pending!: Promise<void>;
  let failure!: Promise<unknown>;
  await act(async () => {
    pending = probe.submit(draft, input, { ownerDocument: document, signal: lifetime.signal, isCurrent: () => current });
    failure = pending.catch((error: unknown) => error);
  });
  expect(original.navigate).toHaveBeenCalledExactlyOnceWith({ kind: "session", sessionId: "created" });
  current = false;
  await act(async () => lifetime.abort());
  const createdRoute: AppRoute = { kind: "session", sessionId: "created", profileId: "profile" };
  await probe.render({ ...original, state: { ...original.state, route: createdRoute, navigationRevision: 1 } });
  await act(async () => { send.reject(new Error("Upload failed")); await failure; });
  expect(probe.error()).toBe("Upload failed");
  expect(original.clearNewSessionDraft).toHaveBeenCalledTimes(1);
  expect(probe.busy()).toBeUndefined();
});

it("does not borrow a replacement connection or overwrite its newer creation state", async () => {
  const original = api();
  const oldCreation = deferred<{ sessionId: string; generation: bigint }>();
  vi.mocked(original.createSession).mockReturnValue(oldCreation.promise);
  vi.mocked(original.send).mockRejectedValue(new Error("Original connection closed"));
  const probe = await mount(original);
  const owner = { ownerDocument: document, signal: new AbortController().signal, isCurrent: () => true };
  let oldFailure!: Promise<unknown>;
  await act(async () => { oldFailure = probe.submit(draft, input, owner).catch((error: unknown) => error); });
  const replacement = api();
  const newCreation = deferred<{ sessionId: string; generation: bigint }>();
  vi.mocked(replacement.createSession).mockReturnValue(newCreation.promise);
  await probe.render(replacement);
  let next!: Promise<void>;
  await act(async () => { next = probe.submit(draft, input, owner); });
  const newBusy = probe.busy();
  await act(async () => { oldCreation.resolve({ sessionId: "old", generation: 6n }); await oldFailure; });
  expect(original.send).toHaveBeenCalledExactlyOnceWith("old", input, { expectedGeneration: 6n });
  expect(replacement.send).not.toHaveBeenCalled();
  expect(replacement.clearNewSessionDraft).not.toHaveBeenCalled();
  expect(probe.error()).toBeUndefined();
  expect(probe.busy()).toBe(newBusy);
  await act(async () => { newCreation.resolve({ sessionId: "new", generation: 8n }); await next; });
  expect(replacement.send).toHaveBeenCalledExactlyOnceWith("new", input, { expectedGeneration: 8n });
  expect(replacement.navigate).toHaveBeenCalledExactlyOnceWith({ kind: "session", sessionId: "new" });
});

it("rechecks the draft after its clear completes and never navigates a retired owner", async () => {
  const original = api();
  const clear = deferred<void>();
  vi.mocked(original.clearNewSessionDraft).mockReturnValue(clear.promise);
  const probe = await mount(original);
  let current = true;
  let pending!: Promise<void>;
  await act(async () => { pending = probe.submit(draft, input, { ownerDocument: document, signal: new AbortController().signal, isCurrent: () => current }); });
  expect(original.clearNewSessionDraft).toHaveBeenCalledTimes(1);
  current = false;
  await act(async () => { clear.resolve(); await pending; });
  expect(original.navigate).not.toHaveBeenCalled();
  expect(original.send).toHaveBeenCalledExactlyOnceWith("created", input, { expectedGeneration: 4n });
});
