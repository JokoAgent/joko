import { describe, expect, it } from "vitest";
import { LocalState } from "./local-state.js";
import type { ComposerDraft } from "./model.js";

describe("durable composer draft surfaces", () => {
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
    let settled = false, written = false;
    const transaction = {
      oncomplete: null as (() => void) | null, onabort: null as (() => void) | null, onerror: null as (() => void) | null,
      objectStore: () => ({
        get(key: string) {
          const request = { result: undefined as unknown, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
          queueMicrotask(() => { request.result = records.get(key); request.onsuccess?.();
            queueMicrotask(() => { if (!settled && !written) { settled = true; transaction.oncomplete?.(); } }); });
          return request;
        },
        put(record: unknown, key: string) { written = true;
          queueMicrotask(() => { if (settled) return; records.set(key, record); settled = true; transaction.oncomplete?.(); }); return {}; },
      }),
      abort() { if (!settled) { settled = true; transaction.onabort?.(); } }
    };
    return transaction;
  } } as unknown as IDBDatabase;
  return { value, keys: () => [...records.keys()], seed: (key: string, record: unknown) => records.set(key, record) };
}
