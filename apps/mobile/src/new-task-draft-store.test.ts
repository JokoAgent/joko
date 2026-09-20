import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobilePlainStorageDriver } from "./connection-storage";
import {
  MobileNewTaskDraftStore,
  mobileNewTaskDraftTesting,
  type MobileNewTaskDraftIdentity
} from "./new-task-draft-store";
import {
  insertMobileResourceMention,
  insertMobileSessionMention,
  insertMobileWorkspaceMention,
  plainTextMobileComposerDraft,
  type MobileComposerDraft
} from "./mobile-composer-document";

const first = { profileId: "profile-one" } satisfies MobileNewTaskDraftIdentity;
const second = { profileId: "profile-two" } satisfies MobileNewTaskDraftIdentity;

const authority = {
  connectionId: "connection-one",
  serverId: "server-one",
  backendId: "backend-one",
  targetRevision: "7",
  targetRevisionEtag: "target-r7",
  model: { providerId: "provider-one", modelId: "vision-one", effortId: "high", fastMode: false },
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

function input(text: string) {
  return plainTextMobileComposerDraft(text);
}

function structuredInput() {
  const session = insertMobileSessionMention(
    input("Review"),
    { start: 6, end: 6 },
    { sessionId: "session-history", displayText: "History" },
    "mention-session"
  );
  return insertMobileWorkspaceMention(
    session.draft,
    session.selection,
    { workspaceId: "workspace-one", relativePath: "src", displayText: "src", directory: true },
    "mention-workspace"
  ).draft;
}

function attachedInput(state: "local" | "uploaded" = "local"): MobileComposerDraft {
  const attachment = {
    attachmentId: "attachment-one",
    kind: "image" as const,
    fileName: "pixel.png",
    mediaType: "image/png",
    byteSize: 4,
    sha256Hex: "a".repeat(64),
    capturedAtUnixMs: 100
  };
  return state === "local"
    ? { ...input(""), attachments: [{ ...attachment, state: "local" }] }
    : { ...input(""), attachments: [{ ...attachment, state: "uploaded", blobId: "blob-one" }] };
}

describe("mobile new-task retained draft store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces editable drafts independently for each exact connection profile", async () => {
    const memory = memoryDriver();
    const store = new MobileNewTaskDraftStore(memory.driver);
    store.save(first, { targetId: "target-one", name: "One", input: input("older") });
    store.save(first, { targetId: "target-one", name: "One", input: input("latest") });
    store.save(second, { targetId: "target-two", name: "Two", input: input("other") });

    await vi.advanceTimersByTimeAsync(mobileNewTaskDraftTesting.persistDebounceMilliseconds);
    await store.flush();

    const restoredFirst = await new MobileNewTaskDraftStore(memory.driver).read(first);
    const restoredSecond = await new MobileNewTaskDraftStore(memory.driver).read(second);
    expect(restoredFirst).toEqual({ targetId: "target-one", name: "One", input: input("latest") });
    expect(restoredSecond).toEqual({ targetId: "target-two", name: "Two", input: input("other") });
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
    edited.save(first, { targetId: "target-one", name: "", input: input("typed while loading") });
    resolveFirst(JSON.stringify({
      version: 2,
      identity: first,
      draft: { targetId: "target-one", name: "", input: input("stale") }
    }));
    await expect(firstRead).resolves.toMatchObject({ input: { text: "typed while loading" } });

    const cleared = new MobileNewTaskDraftStore(driver);
    const secondRead = cleared.read(second);
    const clearing = cleared.clear(second);
    resolveSecond(JSON.stringify({
      version: 2,
      identity: second,
      draft: { targetId: "target-two", name: "", input: input("must not return") }
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
      input: structuredInput()
    }, authority);
    expect(creating).toMatchObject({
      phase: "creating",
      targetId: "target-one",
      displayName: "Release task",
      input: structuredInput(),
      targetRevision: "7",
      targetRevisionEtag: "target-r7",
      model: { providerId: "provider-one", modelId: "vision-one", effortId: "high", fastMode: false }
    });
    store.save(first, { targetId: "target-two", name: "Changed", input: input("changed after submit") });
    expect(store.readSync(first)).toMatchObject({
      targetId: "target-one",
      name: "  Release task  ",
      input: structuredInput()
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
      input: structuredInput()
    });
  });

  it("atomically replaces a v3 attachment identity in both editable and frozen submission input", async () => {
    const memory = memoryDriver();
    const store = new MobileNewTaskDraftStore(memory.driver);
    const local = attachedInput("local");
    const uploaded = attachedInput("uploaded");
    await store.beginSubmission(first, { targetId: "target-one", name: "Attachment", input: local }, authority);
    await store.advanceToSending(first, authority.createOperationId, "session-one", 11n);

    await expect(store.replaceSubmissionInput(
      first, authority.createOperationId, local, uploaded
    )).resolves.toMatchObject({ phase: "sending", input: uploaded });

    expect(store.readSync(first)).toMatchObject({ input: uploaded, submission: { input: uploaded } });
    await expect(store.replaceSubmissionInput(
      first, authority.createOperationId, local, attachedInput("uploaded")
    )).rejects.toThrow(/changed while it was being committed/u);
    const raw = memory.values.get(mobileNewTaskDraftTesting.storageKey(first))!;
    expect(raw).toContain('"version":3');
    expect(raw).not.toContain("content://");
    expect(raw).not.toContain("file://");
  });

  it("releases only the matching operation while retaining the editable creation draft", async () => {
    const memory = memoryDriver();
    const store = new MobileNewTaskDraftStore(memory.driver);
    await store.beginSubmission(first, { targetId: "target-one", name: "Name", input: input("First") }, authority);
    await expect(store.clearSubmission(first, "another-operation")).rejects.toThrow(/changed/);
    await expect(store.clearSubmission(first, "operation-create")).resolves.toEqual({
      targetId: "target-one", name: "Name", input: input("First")
    });
    expect((await new MobileNewTaskDraftStore(memory.driver).read(first))?.submission).toBeUndefined();
  });

  it("rejects damaged, oversized, legacy, and cross-profile records", async () => {
    const memory = memoryDriver();
    const key = mobileNewTaskDraftTesting.storageKey(first);
    const store = new MobileNewTaskDraftStore(memory.driver);
    memory.values.set(key, JSON.stringify({ targetId: "legacy", text: "old shape" }));
    await expect(store.read(first)).rejects.toThrow(/could not be read/);

    memory.values.set(key, JSON.stringify({
      version: 1,
      identity: first,
      draft: { targetId: "target-one", name: "", text: "old v1 text" }
    }));
    await expect(new MobileNewTaskDraftStore(memory.driver).read(first)).rejects.toThrow(/could not be read/);

    const crossProfile = new MobileNewTaskDraftStore(memory.driver);
    memory.values.set(key, JSON.stringify({
      version: 2,
      identity: second,
      draft: { targetId: "target-one", name: "", input: input("cross owner") }
    }));
    await expect(crossProfile.read(first)).rejects.toThrow(/could not be read/);

    memory.values.set(key, JSON.stringify({
      version: 3,
      identity: first,
      draft: {
        targetId: "target-one",
        name: "",
        input: input("missing frozen model"),
        submission: {
          phase: "creating",
          connectionId: "connection-one",
          serverId: "server-one",
          backendId: "backend-one",
          targetId: "target-one",
          targetRevision: "7",
          createOperationId: "operation-create",
          displayName: "New task"
        }
      }
    }));
    await expect(new MobileNewTaskDraftStore(memory.driver).read(first)).rejects.toThrow(/could not be read/);

    const oversized = new MobileNewTaskDraftStore(memory.driver);
    expect(() => oversized.save(first, { targetId: "target-one", name: "", input: input("x".repeat(1_000_001)) }))
      .toThrow(/too large/);

    const runtimeResource = insertMobileResourceMention(
      input("Use"),
      { start: 3, end: 3 },
      {
        resourceId: "resource",
        displayText: "Skill",
        discoveredRevision: "sha256:resource",
        resourceVersion: "1",
        runtimeGeneration: "2"
      },
      "resource-occurrence"
    ).draft;
    expect(() => oversized.save(first, { targetId: "target-one", name: "", input: runtimeResource }))
      .toThrow(/not runtime Resources or Artifacts/u);
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
      targetId: "target-one", name: "", input: input("keep this")
    }, authority)).rejects.toThrow(/could not be written/);
    expect(store.readSync(first)?.submission).toMatchObject({ createOperationId: "operation-create" });
    expect(errors.at(-1)?.message).toContain("could not be written");

    writable = true;
    await store.flush(first);
    expect(values.get(mobileNewTaskDraftTesting.storageKey(first))).toContain("keep this");
  });
});
