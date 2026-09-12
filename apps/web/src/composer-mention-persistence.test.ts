import { describe, expect, it } from "vitest";

import { LocalState } from "./local-state.js";
import { plainTextToComposerDocument } from "./composer-quote-document.js";
import type { ComposerDraft, ComposerMentionDraft, NewSessionLocalDraft } from "./model.js";

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
    const mentions: ComposerMentionDraft[] = [{ id: "artifact:one", kind: "artifact", reference: "one", label: "Report", token: "@Report" }];
    const draft = { text: "First server @Report", deliveryMode: "prompt" as const, mentions, attachments: [],
      inlineMentionRanges: [{ mentionId: "artifact:one", from: 13, to: 20 }] };
    await state.saveDraft("server-one", "same-session", draft);
    expect(await state.readDraft("server-two", "same-session")).toBeUndefined();
    await state.saveDraft("server-two", "same-session", { ...draft, text: "Second server", mentions: [], inlineMentionRanges: [] });
    expect((await state.readDraft("server-one", "same-session"))?.text).toBe("First server @Report");
    expect((await state.readDraft("server-one", "same-session"))?.mentions).toEqual(mentions);
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
    let offset = 0;
    const inlineMentionRanges = workspaceMentions.map((mention) => {
      const length = mention.kind === "message" ? 0 : mention.token.length;
      const range = { mentionId: mention.id, from: offset, to: offset + length };
      offset += length + 1;
      return range;
    });

    await state.saveDraft("server", "session", {
      text,
      deliveryMode: "prompt",
      mentions,
      inlineMentionRanges,
      attachments: []
    });
    const restored = await state.readDraft("server", "session");

    expect(restored?.mentions).toEqual(mentions);
    const ranges = restored?.inlineMentionRanges ?? [];
    expect(ranges).toHaveLength(workspaceMentions.length);
    expect(ranges.at(-1)?.mentionId).toBe(workspaceMentions.at(-1)?.id);
    expect(ranges).toEqual(inlineMentionRanges);
  });

  it("persists exact repeated same-name identities independently of inventory order in task and delayed-create drafts", async () => {
    const state = memoryLocalState();
    const draft = occurrenceDraft();
    await state.saveDraft("server", "session", draft);
    expect((await state.readDraft("server", "session"))?.inlineMentionRanges).toEqual(draft.inlineMentionRanges);
    expect((await state.readDraft("server", "session"))?.mentions).toEqual(draft.mentions);
    const newDraft: NewSessionLocalDraft = { ...draft, editorDocument: plainTextToComposerDocument(draft.text),
      selection: { kind: "dialogue", backendId: "backend" }, nativeStart: { kind: "fresh" }, providerId: "", modelId: "",
      fastMode: false, planMode: false, permissionMode: "ask" };
    await state.saveNewSessionDraft("owner", newDraft);
    expect((await state.readNewSessionDraft("owner"))?.inlineMentionRanges).toEqual(draft.inlineMentionRanges);
    expect((await state.readNewSessionDraft("owner"))?.mentions).toEqual(draft.mentions);
  });

  it.each([
    ["missing occurrences", undefined],
    ["unrepresented identities", []],
    ["overlap", [{ mentionId: "artifact:a", from: 0, to: 2 }, { mentionId: "artifact:b", from: 0, to: 2 }]],
    ["unknown identity", [{ mentionId: "unknown", from: 0, to: 2 }]],
    ["message identity", [{ mentionId: "message:m", from: 0, to: 2 }]],
    ["fractional offset", [{ mentionId: "artifact:a", from: 0.5, to: 2 }]],
    ["out of bounds", [{ mentionId: "artifact:a", from: 0, to: 1_000 }]],
    ["wrong token", [{ mentionId: "artifact:a", from: 1, to: 3 }]],
    ["alternate shape", [{ mentionId: "artifact:a", from: 0, to: 2, start: 0 }]]
  ])("rejects %s without replacing a valid draft or guessing identities on read", async (_name, inlineMentionRanges) => {
    const records = new Map<IDBValidKey, unknown>();
    const state = memoryLocalState(records);
    const draft = occurrenceDraft();
    await state.saveDraft("server", "session", draft);
    const invalid = { ...draft, inlineMentionRanges } as ComposerDraft;
    await expect(state.saveDraft("server", "session", invalid)).rejects.toThrow("mention occurrences");
    expect((await state.readDraft("server", "session"))?.inlineMentionRanges).toEqual(draft.inlineMentionRanges);
    records.set(JSON.stringify(["server", "session"]), { revision: 1, draft: invalid });
    await expect(state.readDraft("server", "session")).rejects.toThrow("mention occurrences");
  });

  it("rejects duplicated identity records and treats unselected token spelling as ordinary prose", async () => {
    const state = memoryLocalState();
    const draft = occurrenceDraft();
    await expect(state.saveDraft("server", "session", { ...draft, mentions: [...draft.mentions, draft.mentions[0]!] })).rejects.toThrow("mention identities");
    await state.saveDraft("server", "session", { ...draft, mentions: draft.mentions.filter((mention) => mention.kind === "message"), inlineMentionRanges: undefined });
    expect((await state.readDraft("server", "session"))?.text).toBe(draft.text);
    expect((await state.readDraft("server", "session"))?.inlineMentionRanges).toBeUndefined();
  });
});

function occurrenceDraft(): ComposerDraft {
  return { text: "@X @X @X @src @Tool @Earlier", deliveryMode: "prompt", attachments: [], mentions: [
    { id: "artifact:b", kind: "artifact", reference: "b", label: "X", token: "@X" },
    { id: "workspace:w", kind: "workspace", reference: "src", label: "src", token: "@src", workspaceId: "w", directory: true },
    { id: "artifact:a", kind: "artifact", reference: "a", label: "X", token: "@X" },
    { id: "resource:r", kind: "resource", reference: "r", label: "Tool", token: "@Tool", discoveredRevision: "revision-r", resourceVersion: "4", runtimeGeneration: 2 },
    { id: "session:earlier", kind: "session", reference: "task/earlier", label: "Earlier", token: "@Earlier" },
    { id: "message:m", kind: "message", reference: "m", label: "Message", sessionId: "s", role: "assistant" }
  ], inlineMentionRanges: [
    { mentionId: "artifact:a", from: 0, to: 2 }, { mentionId: "artifact:b", from: 3, to: 5 },
    { mentionId: "artifact:a", from: 6, to: 8 }, { mentionId: "workspace:w", from: 9, to: 13 }, { mentionId: "resource:r", from: 14, to: 19 },
    { mentionId: "session:earlier", from: 20, to: 28 }
  ] };
}

function memoryLocalState(drafts = new Map<IDBValidKey, unknown>()): LocalState {
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
