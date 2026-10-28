import { clone, create, toBinary } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import {
  BlobDisposition, BlobRefSchema, CapabilitySupport, ConnectionSchema, ConnectionState, DeviceKind, DeviceSchema,
  JOKO_API_VERSION, OperationMutationSchema, OperationSchema, OperationState, PermissionMode,
  QueueDeliveryMode, SessionState, SnapshotSchema, SnapshotScopeSchema, TargetState, WorkspaceKind, capabilityNames,
  extensionCardFormDeliveryScope, releaseExtensionCardFormDelivery, trackExtensionCardFormDelivery,
  type Operation
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileClient } from "./mobile-client";
import { MobileComposerDraftStore } from "./composer-draft-store";
import { createMobileStorage, profileFromCredential, type MobilePlainStorageDriver } from "./connection-storage";
import { MobileAttachmentFiles, type MobileAttachmentFileDriver } from "./mobile-attachment-files";
import { emptyMobileComposerDraft, insertMobilePastedText, plainTextMobileComposerDraft } from "./mobile-composer-document";
import { mobileIncomingShareStorageId, parseMobileIncomingSharePartIdentity } from "./mobile-incoming-share-order";
import { MobileOfflineCache } from "./mobile-offline-cache";
import { MobileTaskOutboxStore, type MobileTaskOutboxRecord } from "./mobile-task-outbox";
import { projectMobilePendingOutboxRows } from "./mobile-pending-send";
import { rebalanceSuggestionFixture } from "./test/provider-group-rebalance";
import type { MobileNetwork, NodeIdentity, PairedCredential } from "./network";

const credential: PairedCredential = { profileId: "phone", origin: "http://192.168.1.20:4318", serverId: "node",
  connectionId: "connection", deviceId: "device", displayName: "Phone", authKey: "protected-credential" };
const node: NodeIdentity = { serverId: credential.serverId, displayName: "Node", version: "1.0.0",
  apiVersion: JOKO_API_VERSION, health: 1, pairingEnabled: true };
const serviceEpoch = 123n, nativeGeneration = 8n;
const clients: MobileClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); });

function receipt(operationId: string, state = OperationState.SUCCEEDED): Operation {
  return create(OperationSchema, { operationId, connectionId: credential.connectionId, state,
    ...(state === OperationState.SUCCEEDED ? { result: { payload: { case: "queueItem", value: {
      queueItemId: `queue-${operationId}`, sessionId: "session", backendId: "backend", targetId: "target"
    } } } } : { error: { message: "Rejected by current task policy" } }) });
}

async function fixture() {
  const values = new Map<string, string>(), protectedValues = new Map<string, string>();
  let rejectOutboxWrite = false;
  let beforeOutboxWrite: ((value: string) => Promise<void>) | undefined;
  const plain: MobilePlainStorageDriver = {
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) {
      if (rejectOutboxWrite && key === "joko.mobile.task-outbox.v1") throw new Error("Local storage is full");
      values.set(key, value);
      if (key === "joko.mobile.task-outbox.v1") await beforeOutboxWrite?.(value);
    },
    async removeItem(key) { values.delete(key); }
  };
  const storage = createMobileStorage(plain, { async isAvailable() { return true; },
    async getItem(key) { return protectedValues.get(key) ?? null; },
    async setItem(key, value) { protectedValues.set(key, value); }, async removeItem(key) { protectedValues.delete(key); } });
  await storage.saveConnection(credential);
  await storage.saveSelection(credential.profileId, "session");
  await storage.saveAutomaticProfile(credential.profileId);
  const connection = create(ConnectionSchema, { connectionId: credential.connectionId, connectionProfileId: credential.profileId,
    deviceId: credential.deviceId, state: ConnectionState.CONNECTED, version: { revision: { value: 4n } } });
  const device = create(DeviceSchema, { deviceId: credential.deviceId, kind: DeviceKind.MOBILE, displayName: "Phone",
    connectionIds: [credential.connectionId], version: { revision: { value: 5n } } });
  const owner = create(SnapshotSchema, { snapshotId: "owner-snapshot", generation: serviceEpoch,
    scope: { kind: { case: "owner", value: {} } }, resumeCursor: { opaqueToken: "cursor", sequence: 10n, generation: serviceEpoch },
    server: node, connections: [connection], devices: [device], backends: [{ backendId: "backend", capabilities: {
      capabilities: [{ name: capabilityNames.inputText, support: CapabilitySupport.SUPPORTED },
        { name: capabilityNames.inputFile, support: CapabilitySupport.SUPPORTED,
          options: { kind: { case: "input", value: { mediaTypes: ["text/plain"], maximumBytes: 1_024n, maximumItems: 4 } } } }]
    } }], targets: [{ targetId: "target", backendId: "backend", state: TargetState.ACTIVE,
      version: { revision: { value: 3n } } }], workspaces: [{ workspaceId: "workspace", targetId: "target",
      kind: WorkspaceKind.USER_PROJECT }], sessions: [{ sessionId: "session", backendId: "backend", targetId: "target",
      state: SessionState.IDLE, permissionMode: PermissionMode.ASK, nativeBinding: { runtimeGeneration: nativeGeneration },
      version: { revision: { value: 9n } } }] });
  const detail = clone(SnapshotSchema, owner);
  detail.snapshotId = "session-snapshot";
  detail.scope = create(SnapshotScopeSchema, {
    kind: { case: "session", value: { sessionId: "session", recentTimelineItems: 120 } }
  });
  let sequence = 0, online = false, clock = 2_000;
  const cache = new MobileOfflineCache({ ...plain, async getAllKeys() { return [...values.keys()]; },
    async multiRemove(keys) { for (const key of keys) values.delete(key); } }, () => 1_500, () => `cache-${++sequence}`);
  await cache.save(profileFromCredential(credential), node, owner, detail);
  const blobs = new Map<string, Uint8Array>();
  const fileKey = (profile: string, id: string) => `${profile}/${id}`;
  const fileSnapshot = (key: string) => {
    const bytes = blobs.get(key); if (!bytes) throw new Error("Missing retained attachment");
    return { uri: `file:///${key}`, bytes: Uint8Array.from(bytes), byteSize: bytes.byteLength };
  };
  const fileDriver: MobileAttachmentFileDriver = {
    async pick() { return { canceled: true, files: [] }; }, async stage() { throw new Error("Unexpected picker"); },
    async stageBytes(profile, id, bytes) { const key = fileKey(profile, id); blobs.set(key, Uint8Array.from(bytes)); return fileSnapshot(key); },
    async read(profile, id) { return fileSnapshot(fileKey(profile, id)); },
    async remove(profile, id) { blobs.delete(fileKey(profile, id)); },
    async clearProfile(profile) { for (const key of blobs.keys()) if (key.startsWith(`${profile}/`)) blobs.delete(key); }
  };
  const files = new MobileAttachmentFiles(fileDriver, async bytes => createHash("sha256").update(bytes).digest("hex"), () => 2_000);
  const network = {
    inspect: vi.fn(async () => { if (!online) throw new Error("Network is offline"); return node; }),
    readOwner: vi.fn(async (_credential: PairedCredential) => ({ connection, device, snapshot: owner })),
    readSession: vi.fn(async () => detail),
    streamOwner: vi.fn(async function* (_credential: PairedCredential, _cursor: unknown, signal: AbortSignal) {
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    }),
    submit: vi.fn(async (_credential: PairedCredential, operationId: string, mutation: Parameters<MobileNetwork["submit"]>[2]) => {
      toBinary(OperationMutationSchema, mutation); return receipt(operationId);
    }),
    getOperation: vi.fn(async (_credential: PairedCredential, _operationId: string): Promise<Operation | undefined> => undefined),
    uploadBlob: vi.fn(async (_credential: PairedCredential, source: Parameters<MobileNetwork["uploadBlob"]>[1]) => create(BlobRefSchema, {
      blobId: `blob-${++sequence}`, fileName: source.fileName, mediaType: source.mediaType,
      byteSize: BigInt(source.byteSize), sha256Hex: source.sha256Hex, disposition: BlobDisposition.ATTACHMENT
    }))
  };
  const makeClient = () => {
    const drafts = new MobileComposerDraftStore(plain);
    const client = new MobileClient(network as unknown as MobileNetwork, storage, { async scan() { return []; } },
      () => `00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`, "android", () => clock, undefined, undefined, drafts, files,
      undefined, undefined, undefined, undefined, cache);
    clients.push(client); return { client, drafts };
  };
  return { makeClient, storage, plain, values, owner, detail, network, files, blobs, fileKey,
    online() { online = true; }, setClock(value: number) { clock = value; }, failWrite(value: boolean) { rejectOutboxWrite = value; },
    interceptWrite(value?: (body: string) => Promise<void>) { beforeOutboxWrite = value; } };
}

describe("durable ordinary mobile task inputs", () => {
  it("retains multiple offline sends before clearing the composer, then restarts and dispatches their original operations in order", async () => {
    const f = await fixture(), first = f.makeClient(); await first.client.start();
    expect(first.client.state.status).toBe("offline"); expect(first.client.canQueueTaskInput()).toBe(true);
    await first.client.send(plainTextMobileComposerDraft("First"), { operationId: "offline-first" });
    await first.client.send(plainTextMobileComposerDraft("Second"), { operationId: "offline-second", deliveryMode: QueueDeliveryMode.FOLLOW_UP });
    expect(first.client.taskOutboxItems().map(item => item.input.text)).toEqual(["First", "Second"]);
    expect(await first.drafts.readDurable({ profileId: credential.profileId, sessionId: "session" })).toBeNull();
    expect(f.network.submit).not.toHaveBeenCalled();
    expect(f.values.get("joko.mobile.task-outbox.v1")).not.toContain(credential.authKey);
    first.client.dispose(); f.online(); const recovered = f.makeClient(); await recovered.client.start();
    expect(f.network.submit.mock.calls.map(call => call[1])).toEqual(["offline-first", "offline-second"]);
    expect(f.network.submit.mock.calls.map(call => call[2].preconditions[0]?.expectedGeneration)).toEqual([nativeGeneration, nativeGeneration]);
    expect(f.network.submit.mock.calls[1]?.[2].payload.value).toMatchObject({ deliveryMode: QueueDeliveryMode.FOLLOW_UP,
      overrides: { permissionMode: PermissionMode.ASK, planMode: false } });
    expect(recovered.client.taskOutboxItems()).toEqual([]);
  });

  it("leaves a durable editable composer and no queue item when the handoff write fails", async () => {
    const f = await fixture(), { client, drafts } = f.makeClient(); await client.start(); f.failWrite(true);
    await expect(client.send(plainTextMobileComposerDraft("Keep this input"))).rejects.toThrow("storage is full");
    expect(client.taskOutboxItems()).toEqual([]); expect(f.network.submit).not.toHaveBeenCalled();
    expect((await drafts.readDurable({ profileId: credential.profileId, sessionId: "session" }))?.text).toBe("Keep this input");
  });

  it("only queries the original operation after a lost response and blocks following messages until that result is confirmed", async () => {
    const f = await fixture(), { client } = f.makeClient(); await client.start();
    await client.send(plainTextMobileComposerDraft("First"), { operationId: "lost-result" });
    await client.send(plainTextMobileComposerDraft("Second"), { operationId: "after-result" });
    f.network.submit.mockRejectedValueOnce(new Error("Response lost after dispatch"));
    f.network.getOperation.mockRejectedValue(new Error("Operation query is unavailable"));
    f.online(); await client.refresh();
    expect(client.taskOutboxItems().map(item => item.state)).toEqual(["confirming", "queued"]);
    await client.reconcile(); await client.reconcile();
    expect(f.network.submit.mock.calls.map(call => call[1])).toEqual(["lost-result"]);
    expect(f.network.getOperation.mock.calls.map(call => call[1])).toEqual(["lost-result", "lost-result"]);
    await expect(client.retryTaskOutbox("lost-result")).rejects.toThrow("Only a failed");
    await expect(client.cancelTaskOutbox("lost-result")).rejects.toThrow("original operation");
    client.dispose(); const restarted = f.makeClient(); await restarted.client.start();
    expect(f.network.submit).toHaveBeenCalledTimes(1);
    f.network.getOperation.mockResolvedValue(receipt("lost-result")); await restarted.client.reconcile();
    expect(f.network.submit.mock.calls.map(call => call[1])).toEqual(["lost-result", "after-result"]);
    expect(restarted.client.taskOutboxItems()).toEqual([]);
  });

  it("keeps terminal rejection failed until an explicit retry allocates a new operation identity", async () => {
    const f = await fixture(), { client } = f.makeClient(); await client.start();
    await client.send(plainTextMobileComposerDraft("Review this"), { operationId: "rejected-input" });
    f.network.submit.mockResolvedValueOnce(receipt("rejected-input", OperationState.FAILED));
    f.online(); await client.refresh(); await client.reconcile();
    expect(client.taskOutboxItems()[0]).toMatchObject({ state: "failed", attempted: true, operationId: "rejected-input" });
    expect(f.network.submit).toHaveBeenCalledTimes(1);
    await client.retryTaskOutbox("rejected-input");
    expect(f.network.submit).toHaveBeenCalledTimes(2);
    expect(f.network.submit.mock.calls[1]?.[1]).not.toBe("rejected-input"); expect(client.taskOutboxItems()).toEqual([]);
  });

  it("recovers a persisted confirming record with no durable server operation for explicit retry using the original identity", async () => {
    const f = await fixture(), { client } = f.makeClient(); await client.start();
    await client.send(plainTextMobileComposerDraft("Original operation"), { operationId: "not-admitted" }); client.dispose();
    const store = new MobileTaskOutboxStore(f.plain); await store.load();
    await store.update(store.records[0]!, { state: "confirming", attempted: true });
    f.online(); const restarted = f.makeClient(); await restarted.client.start();
    expect(f.network.getOperation).toHaveBeenCalledWith(credential, "not-admitted", expect.any(AbortSignal));
    expect(f.network.submit).not.toHaveBeenCalled();
    expect(restarted.client.taskOutboxItems()[0]).toMatchObject({ state: "failed", failureKind: "not-admitted", attempted: true });
    await expect(restarted.client.editTaskOutbox("not-admitted")).rejects.toThrow("Only an unsent or rejected");
    await expect(restarted.client.cancelTaskOutbox("not-admitted")).rejects.toThrow("may have been accepted");
    await restarted.client.reconcile(); expect(f.network.submit).not.toHaveBeenCalled();
    await restarted.client.retryTaskOutbox("not-admitted");
    expect(f.network.submit.mock.calls.map(call => call[1])).toEqual(["not-admitted"]);
    expect(restarted.client.taskOutboxItems()).toEqual([]);
  });

  it("retains a failed unsubmitted record when backgrounding interrupts the durable dispatch marker", async () => {
    const f = await fixture(), { client } = f.makeClient(); await client.start();
    await client.send(plainTextMobileComposerDraft("Dispatch interrupted"), { operationId: "before-submit" });
    let release!: () => void, writing!: () => void;
    const written = new Promise<void>(resolve => { writing = resolve; });
    f.interceptWrite(async body => {
      if (!body.includes('"state":"confirming"')) return;
      writing(); await new Promise<void>(resolve => { release = resolve; });
    });
    f.online(); const connecting = client.refresh(); await written; client.setForeground(false);
    f.interceptWrite(); release(); await connecting;
    expect(f.network.submit).not.toHaveBeenCalled();
    const retained = new MobileTaskOutboxStore(f.plain); await retained.load();
    expect(retained.records[0]).toMatchObject({ state: "failed", attempted: false, failureKind: "preparation" });
    client.dispose(); const restarted = f.makeClient(); await restarted.client.start();
    expect(f.network.submit).not.toHaveBeenCalled();
    await restarted.client.retryTaskOutbox("before-submit");
    expect(f.network.submit.mock.calls.map(call => call[1])).toEqual(["before-submit"]);
  });

  it("rejects a changed native task generation without substituting the service epoch or silently retrying", async () => {
    const f = await fixture(), { client } = f.makeClient(); await client.start();
    await client.send(plainTextMobileComposerDraft("Original context"), { operationId: "old-native-context" });
    f.owner.sessions[0]!.nativeBinding!.runtimeGeneration = 9n; f.detail.sessions[0]!.nativeBinding!.runtimeGeneration = 9n;
    f.online(); await client.refresh(); await client.reconcile();
    expect(f.network.submit).not.toHaveBeenCalled();
    expect(client.taskOutboxItems()[0]).toMatchObject({ runtimeGeneration: "8", attempted: false, state: "failed" });
    expect(client.taskOutboxItems()[0]?.error).toContain("generation");
    await client.cancelTaskOutbox("old-native-context"); expect(client.taskOutboxItems()).toEqual([]);
  });

  it("retries an uncertain original operation with identical wire bytes even after the task's native runtime changes", async () => {
    const f = await fixture(), { client } = f.makeClient(); await client.start();
    await client.send(plainTextMobileComposerDraft("Original context"), { operationId: "uncertain-original" });
    f.network.submit.mockRejectedValueOnce(new Error("Response lost")); f.online(); await client.refresh();
    const original = toBinary(OperationMutationSchema, f.network.submit.mock.calls[0]![2]);
    await client.reconcile(); expect(client.taskOutboxItems()[0]?.failureKind).toBe("not-admitted");
    f.owner.sessions[0]!.nativeBinding!.runtimeGeneration = 9n; f.detail.sessions[0]!.nativeBinding!.runtimeGeneration = 9n;
    await client.retryTaskOutbox("uncertain-original");
    expect(f.network.submit.mock.calls.map(call => call[1])).toEqual(["uncertain-original", "uncertain-original"]);
    expect(toBinary(OperationMutationSchema, f.network.submit.mock.calls[1]![2])).toEqual(original);
  });

  it("requires the exact retained origin, server, connection, device and profile before resuming", async () => {
    const f = await fixture(), { client } = f.makeClient(); await client.start();
    await client.send(plainTextMobileComposerDraft("Bound to this node"), { operationId: "bound-input" });
    client.dispose(); const store = new MobileTaskOutboxStore(f.plain); await store.load();
    const original = store.records[0]!; await store.remove(original);
    for (const field of ["profileId", "origin", "serverId", "connectionId", "deviceId"] as const) {
      await store.add({ ...original, id: `foreign-${field}`, operationId: `foreign-${field}`,
        owner: { ...original.owner, [field]: field === "origin" ? "http://192.168.1.21:4318" : `other-${field}` } });
    }
    f.online(); const restarted = f.makeClient(); await restarted.client.start(); await restarted.client.reconcile();
    expect(f.network.submit).not.toHaveBeenCalled();
    const durable = new MobileTaskOutboxStore(f.plain); await durable.load(); expect(durable.records).toHaveLength(5);
  });

  it("copies attachment bytes per enqueue, verifies the copy and removes only that input's private files", async () => {
    const f = await fixture(), { client, drafts } = f.makeClient(); await client.start();
    const bytes = new TextEncoder().encode("Owned document"), hash = createHash("sha256").update(bytes).digest("hex");
    await f.files.stageOwnedBytes(credential.profileId, "composer-file", bytes, hash);
    const input = { ...plainTextMobileComposerDraft("Attached"), attachments: [{ state: "local" as const, attachmentId: "composer-file",
      kind: "file" as const, fileName: "note.txt", mediaType: "text/plain", byteSize: bytes.byteLength, sha256Hex: hash, capturedAtUnixMs: 1_000 }] };
    await client.send(input, { operationId: "attached-input" });
    const retained = client.taskOutboxItems()[0]!;
    expect(retained.storageIds).toHaveLength(1); expect(retained.storageIds[0]).not.toBe("composer-file");
    expect(f.blobs.has(f.fileKey(credential.profileId, "composer-file"))).toBe(false);
    const replacement = new TextEncoder().encode("New composer document"), replacementHash = createHash("sha256").update(replacement).digest("hex");
    await f.files.stageOwnedBytes(credential.profileId, "composer-file", replacement, replacementHash);
    drafts.save({ profileId: credential.profileId, sessionId: "session" }, plainTextMobileComposerDraft("New composer"));
    await drafts.flush({ profileId: credential.profileId, sessionId: "session" });
    await client.cancelTaskOutbox(retained.id);
    expect(f.blobs.has(f.fileKey(credential.profileId, retained.storageIds[0]!))).toBe(false);
    expect(f.blobs.get(f.fileKey(credential.profileId, "composer-file"))).toEqual(replacement);
    expect(drafts.readSync({ profileId: credential.profileId, sessionId: "session" })?.text).toBe("New composer");
  });

  it("revalidates the exact copied attachment digest before upload and retains a failed input for review", async () => {
    const f = await fixture(), { client } = f.makeClient(); await client.start();
    const bytes = new TextEncoder().encode("Owned bytes"), hash = createHash("sha256").update(bytes).digest("hex");
    await f.files.stageOwnedBytes(credential.profileId, "source", bytes, hash);
    await client.send({ ...plainTextMobileComposerDraft("Attached"), attachments: [{ state: "local", attachmentId: "source",
      kind: "file", fileName: "owned.txt", mediaType: "text/plain", byteSize: bytes.byteLength, sha256Hex: hash, capturedAtUnixMs: 1_000 }] },
    { operationId: "tampered-input" });
    const id = client.taskOutboxItems()[0]!.storageIds[0]!;
    f.blobs.set(f.fileKey(credential.profileId, id), Uint8Array.from(bytes, () => 0));
    f.online(); await client.refresh();
    expect(f.network.uploadBlob).not.toHaveBeenCalled(); expect(f.network.submit).not.toHaveBeenCalled();
    expect(client.taskOutboxItems()[0]).toMatchObject({ state: "failed", attempted: false });
    expect(client.taskOutboxItems()[0]?.error).toContain("SHA-256");
  });

  it("uploads the retained attachment after restart and cleans its owned bytes only after the original queue receipt", async () => {
    const f = await fixture(), { client } = f.makeClient(); await client.start();
    const bytes = new TextEncoder().encode("Owned document"), hash = createHash("sha256").update(bytes).digest("hex");
    await f.files.stageOwnedBytes(credential.profileId, "source", bytes, hash);
    await client.send({ ...plainTextMobileComposerDraft("Attached"), attachments: [{ state: "local", attachmentId: "source",
      kind: "file", fileName: "owned.txt", mediaType: "text/plain", byteSize: bytes.byteLength, sha256Hex: hash, capturedAtUnixMs: 1_000 }] },
    { operationId: "upload-after-restart" });
    const copiedId = client.taskOutboxItems()[0]!.storageIds[0]!; client.dispose();
    f.online(); const restarted = f.makeClient(); await restarted.client.start();
    expect(f.network.uploadBlob).toHaveBeenCalledWith(credential, expect.objectContaining({ uri: `file:///${credential.profileId}/${copiedId}`,
      sha256Hex: hash, fileName: "owned.txt", byteSize: bytes.byteLength }), expect.any(AbortSignal));
    expect(f.network.submit.mock.calls.map(call => call[1])).toEqual(["upload-after-restart"]);
    expect(restarted.client.taskOutboxItems()).toEqual([]);
    expect(f.blobs.has(f.fileKey(credential.profileId, copiedId))).toBe(false);
  });

  it("keeps file-before-text incoming-share ordering after making the outbox's private attachment copy", async () => {
    const f = await fixture(), { client } = f.makeClient(); await client.start();
    const batch = "10000000-0000-4000-8000-000000000001";
    const sourceId = mobileIncomingShareStorageId(batch, "20000000-0000-4000-8000-000000000002", 0);
    const textId = mobileIncomingShareStorageId(batch, "30000000-0000-4000-8000-000000000003", 1);
    const bytes = new TextEncoder().encode("Shared document"), hash = createHash("sha256").update(bytes).digest("hex");
    await f.files.stageOwnedBytes(credential.profileId, sourceId, bytes, hash);
    const draft = insertMobilePastedText(emptyMobileComposerDraft(), { start: 0, end: 0 }, "Following text", textId).draft;
    await client.send({ ...draft, attachments: [{ state: "local", attachmentId: sourceId, kind: "file", fileName: "shared.txt",
      mediaType: "text/plain", byteSize: bytes.byteLength, sha256Hex: hash, capturedAtUnixMs: 1_000 }] }, { operationId: "ordered-share" });
    const copyId = client.taskOutboxItems()[0]!.input.attachments[0]!.attachmentId;
    expect(copyId).not.toBe(sourceId);
    expect(parseMobileIncomingSharePartIdentity(copyId)).toEqual(parseMobileIncomingSharePartIdentity(sourceId));
    f.online(); await client.refresh();
    const mutation = f.network.submit.mock.calls[0]![2];
    expect(mutation.payload.case).toBe("sendInput");
    if (mutation.payload.case !== "sendInput") throw new Error("Expected sendInput");
    expect(mutation.payload.value.input?.parts.map(part => part.content.case)).toEqual(["file", "text"]);
  });

  it("waits for the same connection's pending extension-card edits before dispatch and retains failed form saves for review", async () => {
    const f = await fixture(), { client } = f.makeClient(); await client.start();
    await client.send(plainTextMobileComposerDraft("After form edit"), { operationId: "after-card-form" });
    let scope = "", settle!: (ok: boolean) => void;
    const delivery = new Promise<boolean>(resolve => { settle = resolve; });
    const ownerResult = { connection: f.owner.connections[0]!, device: f.owner.devices[0]!, snapshot: f.owner };
    f.network.readOwner.mockImplementationOnce(async current => {
      scope = extensionCardFormDeliveryScope(current, "session"); trackExtensionCardFormDelivery(scope, "form-edit", delivery);
      return ownerResult;
    });
    f.online(); const connecting = client.refresh();
    try {
      await vi.waitFor(() => expect(f.network.readOwner).toHaveBeenCalledTimes(3));
      expect(f.network.submit).not.toHaveBeenCalled(); settle(false); await connecting;
      expect(f.network.submit).not.toHaveBeenCalled();
      expect(client.taskOutboxItems()[0]).toMatchObject({ state: "failed", attempted: false, failureKind: "preparation" });
    } finally { settle(false); if (scope) releaseExtensionCardFormDelivery(scope, "form-edit"); }
  });

  it("recovers an interrupted durable composer handoff once, without clearing a newer composer or duplicating a restored draft", async () => {
    const f = await fixture(), { client, drafts } = f.makeClient(); await client.start();
    const queued = plainTextMobileComposerDraft("Retained input"), newer = plainTextMobileComposerDraft("Newer input");
    drafts.save({ profileId: credential.profileId, sessionId: "session" }, newer);
    await drafts.flush({ profileId: credential.profileId, sessionId: "session" }); client.dispose();
    const store = new MobileTaskOutboxStore(f.plain);
    const record: MobileTaskOutboxRecord = { id: "staged-input", operationId: "staged-input", owner: profileFromCredential(credential),
      sessionId: "session", backendId: "backend", targetId: "target", runtimeGeneration: "8", createdAt: 1_000,
      deliveryMode: QueueDeliveryMode.PROMPT, permissionMode: PermissionMode.ASK, planMode: false,
      input: queued, storageIds: [], sourceDraft: queued, state: "staging", attempted: false };
    await store.add(record);
    const recovered = f.makeClient(); await recovered.client.start();
    expect(recovered.client.taskOutboxItems()[0]?.state).toBe("queued");
    expect((await recovered.drafts.readDurable({ profileId: credential.profileId, sessionId: "session" }))?.text).toBe(newer.text);
    await recovered.client.editTaskOutbox(record.id);
    const restored = await recovered.drafts.readDurable({ profileId: credential.profileId, sessionId: "session" });
    expect(restored?.text).toContain(queued.text); expect(restored?.text).toContain(newer.text);
    recovered.client.dispose(); const final = f.makeClient(); await final.client.start();
    expect(final.client.taskOutboxItems()).toEqual([]);
    expect((await final.drafts.readDurable({ profileId: credential.profileId, sessionId: "session" }))?.text).toBe(restored?.text);
  });

  it("does not resume a staged old-owner handoff into a reused profile's composer", async () => {
    const f = await fixture(), { client, drafts } = f.makeClient(); await client.start();
    const input = plainTextMobileComposerDraft("Current owner's composer");
    drafts.save({ profileId: credential.profileId, sessionId: "session" }, input);
    await drafts.flush({ profileId: credential.profileId, sessionId: "session" }); client.dispose();
    const store = new MobileTaskOutboxStore(f.plain);
    await store.add({ id: "foreign-handoff", operationId: "foreign-handoff", owner: { ...profileFromCredential(credential), connectionId: "old-connection" },
      sessionId: "session", backendId: "backend", targetId: "target", runtimeGeneration: "8", createdAt: 1_000,
      deliveryMode: QueueDeliveryMode.PROMPT, permissionMode: PermissionMode.ASK, planMode: false,
      input: { ...input, text: "Previous owner's input" }, sourceDraft: input, storageIds: [], state: "staging", attempted: false });
    const recovered = f.makeClient(); await recovered.client.start();
    expect(recovered.client.taskOutboxItems()).toEqual([]);
    const retained = new MobileTaskOutboxStore(f.plain); await retained.load();
    expect(retained.records[0]).toMatchObject({ state: "staging", owner: { connectionId: "old-connection" } });
    expect((await recovered.drafts.readDurable({ profileId: credential.profileId, sessionId: "session" }))?.text).toBe(input.text);
  });

  it("finishes an interrupted return to the composer after restart without duplicating its restored input", async () => {
    const f = await fixture(), { client, drafts } = f.makeClient(); await client.start();
    await client.send(plainTextMobileComposerDraft("Return once"), { operationId: "return-to-composer" });
    drafts.save({ profileId: credential.profileId, sessionId: "session" }, plainTextMobileComposerDraft("Newer draft"));
    await drafts.flush({ profileId: credential.profileId, sessionId: "session" });
    f.interceptWrite(async body => { if (body.includes('"state":"restoring"')) f.failWrite(true); });
    await expect(client.editTaskOutbox("return-to-composer")).rejects.toThrow("storage is full");
    const restored = (await drafts.readDurable({ profileId: credential.profileId, sessionId: "session" }))!;
    expect(restored.text).toContain("Return once"); expect(restored.text).toContain("Newer draft");
    client.dispose(); f.interceptWrite(); f.failWrite(false); const restarted = f.makeClient(); await restarted.client.start();
    expect(restarted.client.taskOutboxItems()).toEqual([]);
    expect((await restarted.drafts.readDurable({ profileId: credential.profileId, sessionId: "session" }))?.text).toBe(restored.text);
    expect(f.network.submit).not.toHaveBeenCalled();
  });

  it("keeps the actual first-send time across slow staging and identifies only the failed upload slot after restart", async () => {
    const f = await fixture(), { client } = f.makeClient(); await client.start();
    const inputs = await Promise.all(["first", "second"].map(async (id, index) => {
      const bytes = new TextEncoder().encode(`Content ${index}`), hash = createHash("sha256").update(bytes).digest("hex");
      await f.files.stageOwnedBytes(credential.profileId, id, bytes, hash);
      return { state: "local" as const, attachmentId: id, kind: "file" as const, fileName: `${id}.txt`, mediaType: "text/plain",
        byteSize: bytes.byteLength, sha256Hex: hash, capturedAtUnixMs: 1_000 };
    }));
    const read = f.files.readOwnedBytes.bind(f.files);
    vi.spyOn(f.files, "readOwnedBytes").mockImplementation(async (...args) => { const result = await read(...args); f.setClock(9_000); return result; });
    const progress = vi.fn();
    await client.send({ ...plainTextMobileComposerDraft("Original input"), attachments: inputs }, { operationId: "partial-upload", onProgress: progress });
    const original = client.taskOutboxItems()[0]!;
    expect(original.createdAt).toBe(2_000); expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: "waiting", sentAt: 2_000 }));
    expect(projectMobilePendingOutboxRows([], [original], false)[0]?.pendingSend?.phase).toBe("waiting");
    expect(projectMobilePendingOutboxRows([], [original], true)[0]?.pendingSend?.phase).toBe("preparing");
    const upload = f.network.uploadBlob.getMockImplementation()!;
    f.network.uploadBlob.mockImplementationOnce(upload).mockRejectedValueOnce(new Error("Second file upload failed"));
    f.online(); await client.refresh();
    const failed = client.taskOutboxItems()[0]!;
    expect(failed).toMatchObject({ state: "failed", failureKind: "preparation", attempted: false, createdAt: 2_000,
      uploadAttachmentId: failed.input.attachments[1]!.attachmentId });
    expect(failed.input.attachments.map(item => item.state)).toEqual(["uploaded", "local"]);
    expect(projectMobilePendingOutboxRows([], [failed], true)[0]).toMatchObject({ startedAtMs: 2_000, pendingSend: {
      phase: "failed", attachmentId: failed.input.attachments[1]!.attachmentId } });
    expect(f.network.submit).not.toHaveBeenCalled(); client.dispose();
    const restored = f.makeClient(); await restored.client.start();
    expect(restored.client.taskOutboxItems()[0]).toMatchObject({ state: "failed", uploadAttachmentId: failed.input.attachments[1]!.attachmentId, createdAt: 2_000 });
    expect(f.network.uploadBlob).toHaveBeenCalledTimes(2);
    await restored.client.retryTaskOutbox("partial-upload");
    expect(f.network.uploadBlob.mock.calls.map(call => call[1].fileName)).toEqual(["first.txt", "second.txt", "second.txt"]);
    expect(f.network.submit.mock.calls.map(call => call[1])).toEqual(["partial-upload"]);
    expect(restored.client.taskOutboxItems()).toEqual([]);
  });

  it("persists the confirmed account choice with its queued input and never asks again while recovering original operations", async () => {
    const f = await fixture(), { client } = f.makeClient(); await client.start();
    await client.send(plainTextMobileComposerDraft("First input"), { operationId: "first-unknown" });
    f.network.submit.mockRejectedValueOnce(new Error("Original result lost")); f.network.getOperation.mockRejectedValue(new Error("Query temporarily unavailable"));
    f.online(); await client.refresh();
    const suggestionKey = `rebalance_${"c".repeat(64)}`;
    const read = vi.fn(async () => rebalanceSuggestionFixture(nativeGeneration, { suggestionKey }));
    (f.network as unknown as MobileNetwork).getTaskProviderGroupRebalance = read;
    const confirm = vi.fn(async () => ({ remember: true }));
    await client.send(plainTextMobileComposerDraft("Confirmed input"), { operationId: "second-confirmed", confirmRebalance: confirm });
    expect(client.taskOutboxItems()[1]?.providerGroupRebalance).toEqual({ suggestionKey, remember: true }); client.dispose();
    const restarted = f.makeClient(); await restarted.client.start();
    expect(restarted.client.taskOutboxItems()[1]?.providerGroupRebalance).toEqual({ suggestionKey, remember: true });
    f.network.getOperation.mockResolvedValue(receipt("first-unknown")); await restarted.client.reconcile();
    const sent = f.network.submit.mock.calls.find(call => call[1] === "second-confirmed")?.[2];
    expect(sent).toMatchObject({ payload: { case: "sendInput", value: { providerGroupRebalance: { suggestionKey, remember: true } } } });
    expect(read).toHaveBeenCalledOnce(); expect(confirm).toHaveBeenCalledOnce();
    expect(f.network.submit.mock.calls.map(call => call[1])).toEqual(["first-unknown", "second-confirmed"]);
  });
});
