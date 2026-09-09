import { describe, expect, it } from "vitest";

import { composerMentionsFromRanges, restoreComposerInlineMentionRanges } from "./components/composer-inline-mention.js";
import { LocalState } from "./local-state.js";
import type { ComposerMentionDraft } from "./model.js";

describe("durable composer mention inventory", () => {
  it("atomically rejects stale replacement and rollback writes even when the draft text returns to its previous value", async () => {
    const state = memoryLocalState();
    const draft = { text: "Original", deliveryMode: "prompt" as const, mentions: [], attachments: [] };
    expect(await state.readDraftSnapshot("server", "session")).toEqual({ revision: 0 });
    await state.saveDraft("server", "session", draft);
    const initial = await state.readDraftSnapshot("server", "session");
    const replacement = await state.saveDraftIfRevision("server", "session", { ...draft, text: "Edited" }, initial.revision);
    expect(replacement).toBe(2);
    await state.saveDraft("server", "session", { ...draft, text: "New user draft" });
    expect(await state.saveDraftIfRevision("server", "session", draft, replacement!)).toBeUndefined();
    expect((await state.readDraft("server", "session"))?.text).toBe("New user draft");
    await state.saveDraft("server", "session", draft);
    expect(await state.saveDraftIfRevision("server", "session", { ...draft, text: "Stale" }, initial.revision)).toBeUndefined();
    const current = await state.readDraftSnapshot("server", "session");
    const writes = await Promise.all([state.saveDraftIfRevision("server", "session", draft, current.revision), state.saveDraftIfRevision("server", "session", draft, current.revision)]);
    expect(writes.filter((value) => value !== undefined)).toHaveLength(1);
  });

  it("isolates equal task IDs on different servers and preserves each server's draft", async () => {
    const state = memoryLocalState();
    const draft = { text: "First server", deliveryMode: "prompt" as const, mentions: [], attachments: [] };
    await state.saveDraft("server-one", "same-session", draft);
    expect(await state.readDraft("server-two", "same-session")).toBeUndefined();
    await state.saveDraft("server-two", "same-session", { ...draft, text: "Second server" });
    expect((await state.readDraft("server-one", "same-session"))?.text).toBe("First server");
    expect((await state.readDraft("server-two", "same-session"))?.text).toBe("Second server");
  });

  it("round-trips more than 500 workspace and message mentions without losing send semantics", async () => {
    const workspaceMentions = Array.from({ length: 501 }, (_, index): ComposerMentionDraft => ({
      id: `workspace:w:src/file-${index}.ts`,
      kind: "workspace",
      reference: `src/file-${index}.ts`,
      label: `file-${index}.ts`,
      token: `@src/file-${index}.ts`,
      workspaceId: "w"
    }));
    const messageMentions = Array.from({ length: 501 }, (_, index): ComposerMentionDraft => ({
      id: `message:s:m-${index}`,
      kind: "message",
      reference: `m-${index}`,
      label: `Message ${index}`,
      sessionId: "s",
      role: index % 2 === 0 ? "assistant" : "user",
      sourceEventId: `e-${index}`
    }));
    const mentions = [...workspaceMentions, ...messageMentions];
    const text = workspaceMentions.map((mention) => mention.kind === "message" ? "" : mention.token).join(" ");
    const state = memoryLocalState();

    await state.saveDraft("server", "session", {
      text,
      deliveryMode: "prompt",
      mentions,
      attachments: []
    });
    const restored = await state.readDraft("server", "session");

    expect(restored?.mentions).toEqual(mentions);
    const ranges = restoreComposerInlineMentionRanges(restored?.text ?? "", restored?.mentions ?? []);
    expect(ranges).toHaveLength(workspaceMentions.length);
    expect(ranges.at(-1)?.mentionId).toBe(workspaceMentions.at(-1)?.id);
    expect(composerMentionsFromRanges(restored?.mentions ?? [], ranges)).toEqual(mentions);
  });
});

function memoryLocalState(): LocalState {
  const drafts = new Map<IDBValidKey, unknown>();
  const database = {
    transaction(): IDBTransaction {
      const transaction = {
        error: null as DOMException | null,
        oncomplete: null as ((event: Event) => void) | null,
        onabort: null as ((event: Event) => void) | null,
        onerror: null as ((event: Event) => void) | null,
        objectStore(): IDBObjectStore {
          return {
            put(value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
              if (key === undefined) throw new Error("The in-memory draft store requires a key.");
              drafts.set(key, value);
              queueMicrotask(() => transaction.oncomplete?.(new Event("complete")));
              return {} as IDBRequest<IDBValidKey>;
            },
            get(key: IDBValidKey): IDBRequest<unknown> {
              const request = {
                result: undefined as unknown,
                error: null as DOMException | null,
                onsuccess: null as ((event: Event) => void) | null,
                onerror: null as ((event: Event) => void) | null
              };
              queueMicrotask(() => {
                request.result = drafts.get(key);
                request.onsuccess?.(new Event("success"));
                queueMicrotask(() => transaction.oncomplete?.(new Event("complete")));
              });
              return request as unknown as IDBRequest<unknown>;
            }
          } as IDBObjectStore;
        }
      };
      return transaction as unknown as IDBTransaction;
    }
  };
  const LocalStateConstructor = LocalState as unknown as new (database: IDBDatabase) => LocalState;
  return new LocalStateConstructor(database as unknown as IDBDatabase);
}
