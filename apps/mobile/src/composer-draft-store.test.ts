import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MobileComposerDraftStore,
  mobileComposerDraftTesting,
  type MobileComposerDraftIdentity
} from "./composer-draft-store";
import type { MobilePlainStorageDriver } from "./connection-storage";
import { insertMobileSessionMention, plainTextMobileComposerDraft } from "./mobile-composer-document";

const first = { profileId: "profile-one", sessionId: "session-one" } satisfies MobileComposerDraftIdentity;
const second = { profileId: "profile-one", sessionId: "session-two" } satisfies MobileComposerDraftIdentity;

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

describe("mobile composer draft store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces the latest structured draft independently for each exact profile and task", async () => {
    const memory = memoryDriver();
    const store = new MobileComposerDraftStore(memory.driver);
    store.save(first, plainTextMobileComposerDraft("one"));
    store.save(first, plainTextMobileComposerDraft("one latest"));
    store.save(second, plainTextMobileComposerDraft("two"));

    await vi.advanceTimersByTimeAsync(mobileComposerDraftTesting.persistDebounceMilliseconds);
    await store.flush();

    expect(memory.values.get(mobileComposerDraftTesting.storageKey(first))).toContain('"text":"one latest"');
    expect(memory.values.get(mobileComposerDraftTesting.storageKey(second))).toContain('"text":"two"');
    expect(memory.writes.filter((write) => write.value?.includes('"text":"one"'))).toHaveLength(0);
  });

  it("lets a newer in-memory edit win over a late storage read", async () => {
    let resolveRead!: (value: string | null) => void;
    const driver: MobilePlainStorageDriver = {
      getItem: () => new Promise((resolve) => { resolveRead = resolve; }),
      async setItem() {},
      async removeItem() {}
    };
    const store = new MobileComposerDraftStore(driver);
    const reading = store.read(first);
    store.save(first, plainTextMobileComposerDraft("typed while loading"));
    resolveRead(JSON.stringify({
      version: 2,
      identity: first,
      draft: plainTextMobileComposerDraft("older stored text")
    }));

    await expect(reading).resolves.toEqual(plainTextMobileComposerDraft("typed while loading"));
    expect(store.readSync(first)).toEqual(plainTextMobileComposerDraft("typed while loading"));
  });

  it("does not revive a cleared draft when an older read completes", async () => {
    let resolveRead!: (value: string | null) => void;
    const driver: MobilePlainStorageDriver = {
      getItem: () => new Promise((resolve) => { resolveRead = resolve; }),
      async setItem() {},
      async removeItem() {}
    };
    const store = new MobileComposerDraftStore(driver);
    const reading = store.read(first);
    const clearing = store.clear(first);
    resolveRead(JSON.stringify({ version: 2, identity: first, draft: plainTextMobileComposerDraft("stale text") }));

    await clearing;
    await expect(reading).resolves.toBeNull();
    expect(store.readSync(first)).toBeNull();
  });

  it("flushes pending content immediately and an empty document removes only the exact draft", async () => {
    const memory = memoryDriver();
    const store = new MobileComposerDraftStore(memory.driver);
    store.save(first, plainTextMobileComposerDraft("one"));
    store.save(second, plainTextMobileComposerDraft("two"));
    await store.flush();
    store.save(first, plainTextMobileComposerDraft(""));
    await store.flush(first);

    expect(memory.values.has(mobileComposerDraftTesting.storageKey(first))).toBe(false);
    expect(memory.values.get(mobileComposerDraftTesting.storageKey(second))).toContain('"text":"two"');
    expect(store.readSync(second)).toEqual(plainTextMobileComposerDraft("two"));
  });

  it("round-trips structured occurrences and clears only the exact submitted version", async () => {
    const memory = memoryDriver();
    const store = new MobileComposerDraftStore(memory.driver);
    const submitted = insertMobileSessionMention(
      plainTextMobileComposerDraft("Use "),
      { start: 4, end: 4 },
      { sessionId: "source", displayText: "Task" },
      "mention-one"
    ).draft;
    store.save(first, submitted);
    await store.flush(first);
    await expect(new MobileComposerDraftStore(memory.driver).read(first)).resolves.toEqual(submitted);

    const newer = { ...submitted, text: `${submitted.text} later` };
    store.save(first, newer);
    await expect(store.clearIfEqual(first, submitted)).resolves.toBe(false);
    expect(store.readSync(first)).toEqual(newer);
    await expect(store.clearIfEqual(first, newer)).resolves.toBe(true);
    expect(store.readSync(first)).toBeNull();
  });

  it("rejects the previous plain-text shape, damaged mention ranges, and cross-owner records", async () => {
    const memory = memoryDriver();
    const key = mobileComposerDraftTesting.storageKey(first);
    memory.values.set(key, "legacy plain text");
    await expect(new MobileComposerDraftStore(memory.driver).read(first)).rejects.toThrow(/could not be read/);

    memory.values.set(key, JSON.stringify({
      version: 2,
      identity: first,
      draft: {
        text: "@Task",
        mentions: [{ kind: "session", mentionId: "mention", sessionId: "source", displayText: "Task", start: 1, end: 5 }]
      }
    }));
    await expect(new MobileComposerDraftStore(memory.driver).read(first)).rejects.toThrow(/could not be read/);

    memory.values.set(key, JSON.stringify({
      version: 2,
      identity: second,
      draft: plainTextMobileComposerDraft("cross owner")
    }));
    await expect(new MobileComposerDraftStore(memory.driver).read(first)).rejects.toThrow(/could not be read/);
  });

  it("reports storage failures without discarding the current in-memory text", async () => {
    const failure = new Error("disk unavailable");
    let writable = false;
    const values = new Map<string, string>();
    const driver: MobilePlainStorageDriver = {
      async getItem() { throw failure; },
      async setItem(key, value) {
        if (!writable) throw failure;
        values.set(key, value);
      },
      async removeItem(key) {
        if (!writable) throw failure;
        values.delete(key);
      }
    };
    const store = new MobileComposerDraftStore(driver);
    const errors: Error[] = [];
    store.subscribeErrors((_identity, error) => errors.push(error));

    await expect(store.read(first)).rejects.toThrow("could not be read");
    store.save(first, plainTextMobileComposerDraft("kept"));
    await vi.advanceTimersByTimeAsync(mobileComposerDraftTesting.persistDebounceMilliseconds);
    await expect(store.flush(first)).rejects.toThrow("could not be written");

    expect(store.readSync(first)).toEqual(plainTextMobileComposerDraft("kept"));
    expect(errors[0]?.message).toContain("could not be read");
    expect(errors.slice(1).every((error) => error.message.includes("could not be written"))).toBe(true);
    writable = true;
    await store.flush(first);
    expect(values.get(mobileComposerDraftTesting.storageKey(first))).toContain('"text":"kept"');
  });
});
