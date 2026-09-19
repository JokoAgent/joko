import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MobileComposerDraftStore,
  mobileComposerDraftTesting,
  type MobileComposerDraftIdentity
} from "./composer-draft-store";
import type { MobilePlainStorageDriver } from "./connection-storage";

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

  it("debounces the latest text independently for each exact profile and task", async () => {
    const memory = memoryDriver();
    const store = new MobileComposerDraftStore(memory.driver);
    store.save(first, "one");
    store.save(first, "one latest");
    store.save(second, "two");

    await vi.advanceTimersByTimeAsync(mobileComposerDraftTesting.persistDebounceMilliseconds);
    await store.flush();

    expect(memory.values.get(mobileComposerDraftTesting.storageKey(first))).toBe("one latest");
    expect(memory.values.get(mobileComposerDraftTesting.storageKey(second))).toBe("two");
    expect(memory.writes.filter((write) => write.value === "one")).toHaveLength(0);
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
    store.save(first, "typed while loading");
    resolveRead("older stored text");

    await expect(reading).resolves.toBe("typed while loading");
    expect(store.readSync(first)).toBe("typed while loading");
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
    resolveRead("stale text");

    await clearing;
    await expect(reading).resolves.toBeNull();
    expect(store.readSync(first)).toBeNull();
  });

  it("flushes pending text immediately and empty text removes only the exact draft", async () => {
    const memory = memoryDriver();
    const store = new MobileComposerDraftStore(memory.driver);
    store.save(first, "one");
    store.save(second, "two");
    await store.flush();
    store.save(first, "");
    await store.flush(first);

    expect(memory.values.has(mobileComposerDraftTesting.storageKey(first))).toBe(false);
    expect(memory.values.get(mobileComposerDraftTesting.storageKey(second))).toBe("two");
    expect(store.readSync(second)).toBe("two");
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
    store.save(first, "kept");
    await vi.advanceTimersByTimeAsync(mobileComposerDraftTesting.persistDebounceMilliseconds);
    await expect(store.flush(first)).rejects.toThrow("could not be written");

    expect(store.readSync(first)).toBe("kept");
    expect(errors[0]?.message).toContain("could not be read");
    expect(errors.slice(1).every((error) => error.message.includes("could not be written"))).toBe(true);
    writable = true;
    await store.flush(first);
    expect(values.get(mobileComposerDraftTesting.storageKey(first))).toBe("kept");
  });
});
