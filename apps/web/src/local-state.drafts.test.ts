import { describe, expect, it, vi } from "vitest";
import { LocalState } from "./local-state.js";
import type { ComposerDraft, PendingSideChatDraft, SideChatOperationView } from "./model.js";
import { recoverSideChatDraft } from "./side-chat-draft-recovery.js";

describe("durable composer draft surfaces", () => {
  it("cold-recovers a selected Side Chat quote from its original operation without creating another task", async () => {
    const database = draftDatabase(), before = local(database.value);
    const receipt: PendingSideChatDraft = { operationId: "side-chat-original", sourceSessionId: "source", sourceGeneration: "4", backendId: "native", targetId: "project",
      quote: { id: "quote", sessionId: "source", kind: "message", text: "Frozen selected answer", messageId: "message", sourceEventId: "event", role: "assistant" } };
    await expect(before.compareAndSetPendingSideChat("node", "profile", "source", undefined, receipt)).resolves.toBe(true);
    const open = vi.fn(async (_sessionId: string, _generation: bigint, options?: { readonly operationId?: string; readonly beforeDispatch?: (operationId: string) => Promise<void> }) => {
      expect(await before.readPendingSideChat("node", "profile", "source")).toEqual(receipt);
      await options?.beforeDispatch?.(receipt.operationId); throw new Error("lost original response");
    });
    const check = vi.fn(async (): Promise<SideChatOperationView> => ({ state: "pending" }));
    const api = (state: LocalState) => ({ openSideChat: open, readSideChatOperation: check,
      readPendingSideChat: (source: string) => state.readPendingSideChat("node", "profile", source),
      savePendingSideChat: (source: string, previous: PendingSideChatDraft | undefined, next: PendingSideChatDraft | undefined) => state.compareAndSetPendingSideChat("node", "profile", source, previous, next),
      adoptPendingSideChat: (expected: PendingSideChatDraft, child: string, append: boolean, current: () => boolean) => state.adoptPendingSideChat("node", "profile", expected, child, "application", "application", append, current) });
    await expect(recoverSideChatDraft(api(before), receipt, { isCurrent: () => true, dispatch: true })).rejects.toThrow("lost original");
    const restarted = local(database.value), retained = await restarted.readPendingSideChat("node", "profile", "source");
    expect(retained).toEqual(receipt); expect(await restarted.readPendingSideChat("node", "other-profile", "source")).toBeUndefined();
    check.mockResolvedValueOnce({ state: "succeeded", sessionId: "exact-child" });
    await expect(recoverSideChatDraft(api(restarted), retained!, { isCurrent: () => true })).resolves.toEqual({ state: "adopted", sessionId: "exact-child" });
    expect(open).toHaveBeenCalledOnce(); expect(await restarted.readPendingSideChat("node", "profile", "source")).toBeUndefined();
    const child = await local(database.value).readDraft("node", "profile", "exact-child");
    expect(JSON.stringify(child?.editorDocument)).toContain("Frozen selected answer");
    expect(JSON.stringify(child?.editorDocument)).toContain('"sourceEventId":"event"');
  });

  it("CAS-adopts into the exact task-window child slot and retains an existing draft until explicit insertion", async () => {
    const database = draftDatabase(), state = local(database.value);
    const receipt: PendingSideChatDraft = { operationId: "side-chat-slot", sourceSessionId: "source", sourceGeneration: "2", backendId: "native", targetId: "project",
      quote: { id: "file-quote", sessionId: "source", kind: "file", sourcePath: "src/a.ts", startLine: 2, endLine: 3, text: "Selected source lines" } };
    await state.compareAndSetPendingSideChat("node", "profile", "source", undefined, receipt, "task-window:2");
    await state.saveDraft("node", "profile", "child", draft("User's current draft"), "task-window:2");
    await state.saveDraft("node", "profile", "child", draft("Other repeated window"), "task-window:1");
    await state.saveDraft("node", "profile", "child", draft("Application window"));
    await expect(state.adoptPendingSideChat("node", "profile", receipt, "child", "task-window:2", "task-window:2")).resolves.toBe("existing");
    expect(await state.readPendingSideChat("node", "profile", "source", "task-window:2")).toEqual(receipt);
    await expect(state.adoptPendingSideChat("node", "profile", receipt, "child", "task-window:2", "task-window:2", true, () => false)).resolves.toBe("stale");
    expect((await state.readDraft("node", "profile", "child", "task-window:2"))?.text).toBe("User's current draft");
    await expect(state.adoptPendingSideChat("node", "profile", receipt, "child", "task-window:2", "task-window:2", true)).resolves.toBe("adopted");
    const child = await state.readDraft("node", "profile", "child", "task-window:2");
    expect(child?.text).toContain("User's current draft"); expect(JSON.stringify(child?.editorDocument)).toContain("Selected source lines");
    expect((await state.readDraft("node", "profile", "child", "task-window:1"))?.text).toBe("Other repeated window");
    expect((await state.readDraft("node", "profile", "child"))?.text).toBe("Application window");
    await expect(state.adoptPendingSideChat("node", "profile", receipt, "child", "task-window:2", "task-window:2", true)).resolves.toBe("stale");
  });
  it("cold-restores a content-free native preparation receipt only for its original node and connection", async () => {
    const database = draftDatabase(), state = local(database.value);
    const preparation = { draftId: "original_draft_incarnation", operationId: "prepare-original", configurationKey: "[project,account,model]",
      sessionId: "prepared-task", discardOperationId: "discard-original" };
    const value = { selection: { kind: "target" as const, targetId: "project" }, nativeStart: { kind: "fresh" as const },
      providerId: "account", modelId: "model", fastMode: false, permissionMode: "ask" as const, planMode: false,
      text: "First input stays here", editorDocument: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "First input stays here" }] }] },
      mentions: [], attachments: [], preparation };
    await state.saveNewSessionDraft("node\u0000connection", value);
    expect((await local(database.value).readNewSessionDraft("node\u0000connection"))?.preparation).toEqual(preparation);
    expect(await state.readNewSessionDraft("node\u0000other")).toBeUndefined();
    expect(await state.readNewSessionDraft("other-node\u0000connection")).toBeUndefined();
  });
  it("persists creator intent only with its exact leading invocation and keeps owners independent", async () => {
    const database = draftDatabase(), state = local(database.value);
    const creator: ComposerDraft = { ...draft("/joko-plugin-creator Build a timer"), builtinSkillIntent: "plugin_creator" };
    await state.saveDraft("server", "profile", "session", creator);
    expect(await local(database.value).readDraft("server", "profile", "session")).toMatchObject(creator);
    expect(await state.readDraft("server", "other", "session")).toBeUndefined();
    await state.saveDraft("server", "profile", "session", { ...creator, text: "Ordinary draft" });
    expect((await state.readDraft("server", "profile", "session"))?.builtinSkillIntent).toBeUndefined();
  });

  it("keeps application and repeated task-window slots independent across save, CAS, clear and reopen", async () => {
    const database = draftDatabase(), application = local(database.value), first = local(database.value), second = local(database.value);
    await application.saveDraft("server", "profile", "session", draft("Main"));
    await Promise.all([
      first.saveDraft("server", "profile", "session", draft("First"), "task-window:0"),
      second.saveDraft("server", "profile", "session", draft("Second"), "task-window:1")
    ]);
    expect(database.keys().map(key => JSON.parse(key))).toEqual([
      ["server", "profile", "session", "application"], ["server", "profile", "session", "task-window:0"], ["server", "profile", "session", "task-window:1"]
    ]);
    const old = await first.readDraftSnapshot("server", "profile", "session", "task-window:0");
    expect(old.revision).toBe(1);
    await expect(first.saveDraftIfRevision("server", "profile", "session", draft("First current"), old.revision, "task-window:0")).resolves.toBe(2);
    await expect(first.saveDraftIfRevision("server", "profile", "session", draft("Stale"), old.revision, "task-window:0")).resolves.toBeUndefined();
    await expect(second.saveDraftIfRevision("server", "profile", "session", draft("Second current"), 1, "task-window:1")).resolves.toBe(2);
    await first.saveDraft("server", "profile", "session", draft(""), "task-window:0");
    const reopened = local(database.value);
    expect((await reopened.readDraft("server", "profile", "session", "task-window:0"))?.text).toBe("");
    expect((await reopened.readDraft("server", "profile", "session", "task-window:1"))?.text).toBe("Second current");
    expect((await reopened.readDraft("server", "profile", "session"))?.text).toBe("Main");
    expect((await reopened.readDraftSnapshot("server", "other-profile", "session", "task-window:1")).revision).toBe(0);
  });

  it("reads only current four-part keys and rejects malformed surface identities", async () => {
    const database = draftDatabase(), state = local(database.value);
    database.seed(JSON.stringify(["server", "profile", "session"]), { revision: 5, draft: draft("Old three-part value") });
    await expect(state.readDraft("server", "profile", "session")).resolves.toBeUndefined();
    await expect(state.readDraft("server", "profile", "session", "task-window:0")).resolves.toBeUndefined();
    await expect(state.saveDraft("server", "profile", "session", draft("Current"))).resolves.toBeUndefined();
    expect(database.keys()).toHaveLength(2);
    for (const surface of ["task-window:-1", "task-window:01", "task-window:1.5", "task-window:9007199254740992", "other"]) {
      await expect(state.readDraft("server", "profile", "session", surface as "application")).rejects.toThrow("valid server");
    }
  });
});

function draft(text: string): ComposerDraft { return { text, mentions: [], attachments: [], deliveryMode: "prompt" }; }
function local(database: IDBDatabase): LocalState {
  return new (LocalState as unknown as new (database: IDBDatabase) => LocalState)(database);
}
function draftDatabase() {
  const records = new Map<string, unknown>();
  const value = { transaction() {
    let settled = false, pending = 0, sequence = 0;
    const writes = new Map<string, unknown>(), deletions = new Set<string>();
    const idle = () => {
      const epoch = ++sequence;
      queueMicrotask(() => queueMicrotask(() => {
        if (settled || pending > 0 || epoch !== sequence) return;
        for (const key of deletions) records.delete(key);
        for (const [key, record] of writes) records.set(key, record);
        settled = true; transaction.oncomplete?.();
      }));
    };
    const transaction = {
      oncomplete: null as (() => void) | null, onabort: null as (() => void) | null, onerror: null as (() => void) | null,
      objectStore: () => ({
        get(key: string) {
          pending++; sequence++;
          const request = { result: undefined as unknown, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
          queueMicrotask(() => { request.result = deletions.has(key) ? undefined : writes.has(key) ? writes.get(key) : records.get(key);
            request.onsuccess?.(); pending--; idle(); });
          return request;
        },
        put(record: unknown, key: string) { writes.set(key, record); deletions.delete(key); idle(); return {}; },
        delete(key: string) { writes.delete(key); deletions.add(key); idle(); return {}; },
      }),
      abort() { if (!settled) { settled = true; transaction.onabort?.(); } }
    };
    return transaction;
  } } as unknown as IDBDatabase;
  return { value, keys: () => [...records.keys()], seed: (key: string, record: unknown) => records.set(key, record) };
}
