import { describe, expect, it } from "vitest";

import { composerMentionsFromRanges, restoreComposerInlineMentionRanges } from "./components/composer-inline-mention.js";
import { LocalState } from "./local-state.js";
import type { ComposerMentionDraft } from "./model.js";

describe("durable composer mention inventory", () => {
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

    await state.saveDraft("session", {
      text,
      deliveryMode: "prompt",
      mentions,
      attachments: []
    });
    const restored = await state.readDraft("session");

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
