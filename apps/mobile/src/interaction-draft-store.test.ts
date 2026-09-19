import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobilePlainStorageDriver } from "./connection-storage";
import {
  MobileInteractionDraftStore,
  mobileInteractionDraftTesting,
  type MobileInteractionDraftIdentity
} from "./interaction-draft-store";

const first = {
  profileId: "profile-one",
  sessionId: "session-one",
  interactionId: "interaction-one",
  kind: "question",
  generation: 3n,
  revision: 7n
} satisfies MobileInteractionDraftIdentity;
const second = {
  ...first,
  interactionId: "interaction-two",
  kind: "plan",
  revision: 8n
} satisfies MobileInteractionDraftIdentity;

function memoryDriver() {
  const values = new Map<string, string>();
  const writes: Array<{ key: string; value?: string }> = [];
  const driver: MobilePlainStorageDriver = {
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { values.set(key, value); writes.push({ key, value }); },
    async removeItem(key) { values.delete(key); writes.push({ key }); }
  };
  return { driver, values, writes };
}

describe("mobile interaction draft store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces independent exact interaction versions and returns defensive copies", async () => {
    const memory = memoryDriver();
    const store = new MobileInteractionDraftStore(memory.driver);
    store.save(first, { kind: "question", fieldIndex: 0, answers: { answer: { kind: "text", value: "one" } } });
    store.save(first, { kind: "question", fieldIndex: 1, answers: { answer: { kind: "text", value: "latest" } } });
    store.save(second, { kind: "plan", feedback: "change scope" });
    await vi.advanceTimersByTimeAsync(mobileInteractionDraftTesting.persistDebounceMilliseconds);
    await store.flush();

    expect(memory.writes).toHaveLength(2);
    expect(store.readSync(first)).toEqual({ kind: "question", fieldIndex: 1, answers: { answer: { kind: "text", value: "latest" } } });
    const copy = store.readSync(first);
    if (copy?.kind === "question") (copy.answers.answer as { value: string }).value = "mutated";
    expect(store.readSync(first)).toMatchObject({ answers: { answer: { value: "latest" } } });
  });

  it("lets newer memory and clear markers beat late storage reads", async () => {
    let resolveRead!: (value: string | null) => void;
    const driver: MobilePlainStorageDriver = {
      getItem: () => new Promise((resolve) => { resolveRead = resolve; }),
      async setItem() {},
      async removeItem() {}
    };
    const store = new MobileInteractionDraftStore(driver);
    const reading = store.read(first);
    store.save(first, { kind: "question", fieldIndex: 0, answers: { answer: { kind: "text", value: "new" } } });
    resolveRead(JSON.stringify({ version: 1, identity: {
      profileId: first.profileId, sessionId: first.sessionId, interactionId: first.interactionId,
      kind: first.kind, generation: "3", revision: "7"
    }, draft: { kind: "question", fieldIndex: 0, answers: { answer: { kind: "text", value: "old" } } } }));
    await expect(reading).resolves.toMatchObject({ answers: { answer: { value: "new" } } });

    const otherStore = new MobileInteractionDraftStore(driver);
    const stale = otherStore.read(first);
    const clearing = otherStore.clear(first);
    resolveRead("not used");
    await clearing;
    await expect(stale).resolves.toBeNull();
  });

  it("rejects damaged or cross-authority records without restoring them", async () => {
    const memory = memoryDriver();
    memory.values.set(mobileInteractionDraftTesting.storageKey(first), JSON.stringify({
      version: 1,
      identity: { profileId: first.profileId, sessionId: "another", interactionId: first.interactionId, kind: first.kind, generation: "3", revision: "7" },
      draft: { kind: "question", fieldIndex: 0, answers: {} }
    }));
    const store = new MobileInteractionDraftStore(memory.driver);
    await expect(store.read(first)).rejects.toThrow(/could not be read/u);
    expect(store.readSync(first)).toBeNull();
  });

  it("keeps the in-memory response dirty after a write failure and retries on flush", async () => {
    const values = new Map<string, string>();
    let writable = false;
    const driver: MobilePlainStorageDriver = {
      async getItem() { return null; },
      async setItem(key, value) {
        if (!writable) throw new Error("unavailable");
        values.set(key, value);
      },
      async removeItem(key) {
        if (!writable) throw new Error("unavailable");
        values.delete(key);
      }
    };
    const store = new MobileInteractionDraftStore(driver);
    const errors: Error[] = [];
    store.subscribeErrors((_identity, error) => errors.push(error));
    store.save(second, { kind: "plan", feedback: "kept" });
    await vi.advanceTimersByTimeAsync(mobileInteractionDraftTesting.persistDebounceMilliseconds);
    await expect(store.flush(second)).rejects.toThrow(/could not be written/u);
    expect(store.readSync(second)).toEqual({ kind: "plan", feedback: "kept" });
    expect(errors.length).toBeGreaterThan(0);
    writable = true;
    await store.flush(second);
    expect(values.has(mobileInteractionDraftTesting.storageKey(second))).toBe(true);
    await store.clear(second);
    expect(values.has(mobileInteractionDraftTesting.storageKey(second))).toBe(false);
  });
});
