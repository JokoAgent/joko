import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobilePlainStorageDriver } from "./connection-storage";
import {
  MobileNewTaskDraftStore,
  mobileNewTaskDraftTesting,
  type MobileNewTaskDraftIdentity
} from "./new-task-draft-store";

const first = { profileId: "profile-one" } satisfies MobileNewTaskDraftIdentity;
const second = { profileId: "profile-two" } satisfies MobileNewTaskDraftIdentity;

const authority = {
  connectionId: "connection-one",
  serverId: "server-one",
  backendId: "backend-one",
  targetRevision: "7",
  targetRevisionEtag: "target-r7",
  createOperationId: "operation-create"
};

function memoryDriver() {
  const values = new Map<string, string>();
  const writes: Array<{ readonly key: string; readonly value?: string }> = [];
  const driver: MobilePlainStorageDriver = {
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { values.set(key, value); writes.push({ key, value }); },
    async removeItem(key) { values.delete(key); writes.push({ key }); }
  };
  return { driver, values, writes };
}

describe("mobile new-task retained draft store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces editable drafts independently for each exact connection profile", async () => {
    const memory = memoryDriver();
    const store = new MobileNewTaskDraftStore(memory.driver);
    store.save(first, { targetId: "target-one", name: "One", text: "older" });
    store.save(first, { targetId: "target-one", name: "One", text: "latest" });
    store.save(second, { targetId: "target-two", name: "Two", text: "other" });

    await vi.advanceTimersByTimeAsync(mobileNewTaskDraftTesting.persistDebounceMilliseconds);
    await store.flush();

    const restoredFirst = await new MobileNewTaskDraftStore(memory.driver).read(first);
    const restoredSecond = await new MobileNewTaskDraftStore(memory.driver).read(second);
    expect(restoredFirst).toEqual({ targetId: "target-one", name: "One", text: "latest" });
    expect(restoredSecond).toEqual({ targetId: "target-two", name: "Two", text: "other" });
    expect(memory.writes.some((write) => write.value?.includes("older"))).toBe(false);
  });

  it("lets a newer edit win over a late read and never revives a cleared draft", async () => {
    let resolveFirst!: (value: string | null) => void;
    let resolveSecond!: (value: string | null) => void;
    let reads = 0;
    const driver: MobilePlainStorageDriver = {
      getItem: () => new Promise((resolve) => { if (reads++ === 0) resolveFirst = resolve; else resolveSecond = resolve; }),
      async setItem() {},
      async removeItem() {}
    };
    const edited = new MobileNewTaskDraftStore(driver);
    const firstRead = edited.read(first);
    edited.save(first, { targetId: "target-one", name: "", text: "typed while loading" });
    resolveFirst(JSON.stringify({
      version: 1,
      identity: first,
      draft: { targetId: "target-one", name: "", text: "stale" }
    }));
    await expect(firstRead).resolves.toMatchObject({ text: "typed while loading" });

    const cleared = new MobileNewTaskDraftStore(driver);
    const secondRead = cleared.read(second);
    const clearing = cleared.clear(second);
    resolveSecond(JSON.stringify({
      version: 1,
      identity: second,
      draft: { targetId: "target-two", name: "", text: "must not return" }
    }));
    await clearing;
    await expect(secondRead).resolves.toBeNull();
    expect(cleared.readSync(second)).toBeNull();
  });

  it("persists the create-to-send workflow immediately and freezes editable fields", async () => {
    const memory = memoryDriver();
    const store = new MobileNewTaskDraftStore(memory.driver);
    const creating = await store.beginSubmission(first, {
      targetId: "target-one",
      name: "  Release task  ",
      text: "  ship this safely  "
    }, authority);
    expect(creating).toMatchObject({
      phase: "creating",
      targetId: "target-one",
      displayName: "Release task",
      inputText: "ship this safely",
      targetRevision: "7",
      targetRevisionEtag: "target-r7"
    });
    store.save(first, { targetId: "target-two", name: "Changed", text: "changed after submit" });
    expect(store.readSync(first)).toMatchObject({
      targetId: "target-one",
      name: "  Release task  ",
      text: "  ship this safely  "
    });

    const sending = await store.advanceToSending(first, "operation-create", "session-one", 11n);
    expect(sending).toMatchObject({ phase: "sending", sessionId: "session-one", runtimeGeneration: "11" });
    await store.setSendOperation(first, "operation-create", "operation-send");

    const restored = await new MobileNewTaskDraftStore(memory.driver).read(first);
    expect(restored?.submission).toMatchObject({
      phase: "sending",
      createOperationId: "operation-create",
      sendOperationId: "operation-send",
      sessionId: "session-one",
      runtimeGeneration: "11",
      inputText: "ship this safely"
    });
  });

  it("releases only the matching operation while retaining the editable creation draft", async () => {
    const memory = memoryDriver();
    const store = new MobileNewTaskDraftStore(memory.driver);
    await store.beginSubmission(first, { targetId: "target-one", name: "Name", text: "First" }, authority);
    await expect(store.clearSubmission(first, "another-operation")).rejects.toThrow(/changed/);
    await expect(store.clearSubmission(first, "operation-create")).resolves.toEqual({
      targetId: "target-one", name: "Name", text: "First"
    });
    expect((await new MobileNewTaskDraftStore(memory.driver).read(first))?.submission).toBeUndefined();
  });

  it("rejects damaged, oversized, legacy, and cross-profile records", async () => {
    const memory = memoryDriver();
    const key = mobileNewTaskDraftTesting.storageKey(first);
    const store = new MobileNewTaskDraftStore(memory.driver);
    memory.values.set(key, JSON.stringify({ targetId: "legacy", text: "old shape" }));
    await expect(store.read(first)).rejects.toThrow(/could not be read/);

    const crossProfile = new MobileNewTaskDraftStore(memory.driver);
    memory.values.set(key, JSON.stringify({
      version: 1,
      identity: second,
      draft: { targetId: "target-one", name: "", text: "cross owner" }
    }));
    await expect(crossProfile.read(first)).rejects.toThrow(/could not be read/);

    const oversized = new MobileNewTaskDraftStore(memory.driver);
    expect(() => oversized.save(first, { targetId: "target-one", name: "", text: "x".repeat(1_000_001) }))
      .toThrow(/too large/);
  });

  it("reports write failures without discarding the in-memory workflow and can flush it later", async () => {
    let writable = false;
    const values = new Map<string, string>();
    const driver: MobilePlainStorageDriver = {
      async getItem(key) { return values.get(key) ?? null; },
      async setItem(key, value) {
        if (!writable) throw new Error("disk unavailable");
        values.set(key, value);
      },
      async removeItem(key) {
        if (!writable) throw new Error("disk unavailable");
        values.delete(key);
      }
    };
    const store = new MobileNewTaskDraftStore(driver);
    const errors: Error[] = [];
    store.subscribeErrors((_identity, error) => errors.push(error));

    await expect(store.beginSubmission(first, {
      targetId: "target-one", name: "", text: "keep this"
    }, authority)).rejects.toThrow(/could not be written/);
    expect(store.readSync(first)?.submission).toMatchObject({ createOperationId: "operation-create" });
    expect(errors.at(-1)?.message).toContain("could not be written");

    writable = true;
    await store.flush(first);
    expect(values.get(mobileNewTaskDraftTesting.storageKey(first))).toContain("keep this");
  });
});
