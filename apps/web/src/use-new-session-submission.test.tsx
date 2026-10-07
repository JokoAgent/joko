// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { AppController, AppRoute } from "./controller.js";
import type { ComposerDraft } from "./model.js";
import { emptySnapshot } from "./model.js";
import type { DelayedNewSessionDraft } from "./new-session-flow.js";
import { useNewSessionSubmission } from "./use-new-session-submission.js";

let root: Root | undefined;
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { if (root !== undefined) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); });
const draft: DelayedNewSessionDraft = { selection: { kind: "target", targetId: "target" }, expectedTargetRevision: 1n, name: "Task", nativeStart: { kind: "fresh" }, providerId: "provider", modelId: "model", fastMode: false, permissionMode: "ask", planMode: false };
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
    state: { route: { kind: "newSession" }, connectionState: "connected", activeProfile: { id: "profile" }, navigationRevision: 0,
      snapshot: { ...emptySnapshot(), targets: [{ id: "target", workspaceId: "workspace", backendId: "backend", name: "Project",
        workspaceName: "Project", revision: 1n, trusted: true, pinned: false, archived: false }],
        workspaces: [{ id: "workspace", targetId: "target", name: "Project", kind: "userProject", serverPath: "/srv/project",
          trusted: true, dirty: false, entries: [] }] } },
    createSession: vi.fn(async () => ({ sessionId: "created", generation: 4n })),
    createTarget: vi.fn(async () => "dialogue-target"),
    refresh: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    listCommands: vi.fn(async () => []),
    startSkillLearning: vi.fn(async () => ({
      id: "skill_learning_0123456789abcdef0123456789abcdef", revision: 1n, state: "distilling",
      sourceKind: "session", backendId: "backend", targetId: "target", sourceSessionId: "created",
      distillationSessionId: "distilled", summary: "Learning", createdAt: 1, updatedAt: 1, expiresAt: 2
    })),
    restoreFirstInputDraft: vi.fn(async () => undefined),
    clearNewSessionDraft: vi.fn(async () => undefined),
    recordRecentProject: vi.fn(async () => []),
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
  expect(original.recordRecentProject).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ targetId: "target", workspaceId: "workspace", serverPath: "/srv/project" }));
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
  expect(original.restoreFirstInputDraft).toHaveBeenCalledExactlyOnceWith("created", input);
  expect(original.recordRecentProject).toHaveBeenCalledOnce();
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

it("does not record a recent project before Session creation or for a managed dialogue", async () => {
  const original = api();
  vi.mocked(original.createSession).mockRejectedValueOnce(new Error("Creation failed"));
  const probe = await mount(original);
  const owner = { ownerDocument: document, signal: new AbortController().signal, isCurrent: () => true };
  await act(async () => { await expect(probe.submit(draft, input, owner)).rejects.toThrow("Creation failed"); });
  expect(original.recordRecentProject).not.toHaveBeenCalled();

  await act(async () => { await probe.submit({ ...draft, selection: { kind: "dialogue", backendId: "backend" }, expectedTargetRevision: undefined }, input, owner); });
  expect(original.createTarget).toHaveBeenCalledOnce();
  expect(original.recordRecentProject).not.toHaveBeenCalled();
});

it("forwards the first-runtime guard and records usage only after actual input acceptance", async () => {
  const original = api();
  const probe = await mount(original);
  const beforeFirstInput = vi.fn(async (_sessionId: string) => { throw new Error("Runtime command changed"); });
  const accepted = vi.fn(() => { throw new Error("Usage history failed"); });
  const owner = { ownerDocument: document, signal: new AbortController().signal, isCurrent: () => true,
    beforeFirstInput, onFirstInputAccepted: accepted };
  await act(async () => { await expect(probe.submit(draft, input, owner)).rejects.toThrow("Runtime command changed"); });
  expect(beforeFirstInput).toHaveBeenCalledExactlyOnceWith("created");
  expect(original.navigate).toHaveBeenCalledExactlyOnceWith({ kind: "session", sessionId: "created" });
  expect(original.send).not.toHaveBeenCalled();
  expect(original.restoreFirstInputDraft).toHaveBeenCalledExactlyOnceWith("created", input);
  expect(accepted).not.toHaveBeenCalled();
  await act(async () => { await probe.submit(draft, input, { ...owner, beforeFirstInput: async () => undefined }); });
  expect(original.send).toHaveBeenCalledOnce(); expect(accepted).toHaveBeenCalledOnce();
});

it("reveals the created task, accepts local learning without a message, then opens its distillation task", async () => {
  const original = api();
  const probe = await mount(original);
  const accepted = vi.fn(() => { throw new Error("Usage history failed"); });
  const draftLifetime = new AbortController();
  const owner = {
    ownerDocument: document,
    signal: draftLifetime.signal,
    isCurrent: () => true,
    firstInputDisposition: {
      kind: "learn" as const,
      requestId: "new-task-learn",
      backendId: "backend",
      instruction: "",
      evidence: "createdSession" as const,
      application: { kind: "eligible" as const }
    },
    onFirstInputAccepted: accepted
  };
  vi.mocked(original.navigate).mockImplementation((route) => {
    if (route.kind === "session" && route.sessionId === "created") draftLifetime.abort();
  });

  await act(async () => { await probe.submit(draft, { ...input, text: "/learn" }, owner); });

  expect(original.navigate).toHaveBeenNthCalledWith(1, { kind: "session", sessionId: "created" });
  expect(original.navigate).toHaveBeenNthCalledWith(2, { kind: "session", sessionId: "distilled" });
  const commandSignal = vi.mocked(original.listCommands).mock.calls[0]?.[1];
  expect(commandSignal).toBeInstanceOf(AbortSignal);
  expect(commandSignal).not.toBe(owner.signal);
  expect(original.listCommands).toHaveBeenCalledExactlyOnceWith("created", commandSignal);
  expect(original.startSkillLearning).toHaveBeenCalledExactlyOnceWith({
    requestId: "new-task-learn", targetId: "target", instruction: "", sourceSessionId: "created"
  }, commandSignal);
  expect(original.send).not.toHaveBeenCalled();
  expect(original.restoreFirstInputDraft).not.toHaveBeenCalled();
  expect(accepted).toHaveBeenCalledWith(expect.objectContaining({ kind: "learned", sessionId: "created" }));
});

it("does not re-dispatch local learning after its owner retires while durable creation is pending", async () => {
  const original = api();
  const creation = deferred<{ sessionId: string; generation: bigint }>();
  vi.mocked(original.createSession).mockReturnValue(creation.promise);
  const probe = await mount(original);
  let current = true;
  const lifetime = new AbortController();
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = probe.submit(draft, { ...input, text: "/learn keep this" }, {
      ownerDocument: document,
      signal: lifetime.signal,
      isCurrent: () => current,
      firstInputDisposition: {
        kind: "learn", requestId: "retired-learn", backendId: "backend", instruction: "keep this", evidence: "freeText",
        application: { kind: "eligible" }
      }
    }).catch((error: unknown) => error);
  });
  await act(async () => { current = false; lifetime.abort(); });
  let result: unknown;
  await act(async () => { creation.resolve({ sessionId: "created", generation: 4n }); result = await pending; });

  expect(result).toMatchObject({ name: "AbortError" });
  expect(original.listCommands).not.toHaveBeenCalled();
  expect(original.startSkillLearning).not.toHaveBeenCalled();
  expect(original.send).not.toHaveBeenCalled();
  expect(original.restoreFirstInputDraft).toHaveBeenCalledExactlyOnceWith("created", expect.objectContaining({ text: "/learn keep this" }));
  expect(original.navigate).not.toHaveBeenCalled();
});

it("aborts fresh runtime reconciliation on an unexpected route and restores the complete invocation", async () => {
  const original = api();
  const catalog = deferred<readonly []>();
  vi.mocked(original.listCommands).mockImplementation(async (_sessionId, signal) => {
    return await new Promise<readonly []>((resolve, reject) => {
      const abort = (): void => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      if (signal?.aborted === true) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      void catalog.promise.then(resolve, reject);
    });
  });
  const probe = await mount(original);
  const invocation = { ...input, text: "/learn keep this" };
  const owner = {
    ownerDocument: document,
    signal: new AbortController().signal,
    isCurrent: () => true,
    firstInputDisposition: {
      kind: "learn" as const,
      requestId: "route-retired-learn",
      backendId: "backend",
      instruction: "keep this",
      evidence: "freeText" as const,
      application: { kind: "eligible" as const }
    }
  };
  let failure!: Promise<unknown>;
  await act(async () => {
    failure = probe.submit(draft, invocation, owner).catch((error: unknown) => error);
  });
  expect(original.navigate).toHaveBeenCalledWith({ kind: "session", sessionId: "created" });
  await probe.render({ ...original, state: { ...original.state, route: { kind: "settings" }, navigationRevision: 1 } });
  let result: unknown;
  await act(async () => { result = await failure; });

  expect(result).toMatchObject({ name: "AbortError" });
  expect(original.startSkillLearning).not.toHaveBeenCalled();
  expect(original.send).not.toHaveBeenCalled();
  expect(original.restoreFirstInputDraft).toHaveBeenCalledExactlyOnceWith("created", invocation);
});
