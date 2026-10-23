import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, toBinary } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { afterEach, expect, it, vi } from "vitest";
import { TaskSharingHost, type TaskSharingRuntimePort } from "./task-sharing-host.js";
import { ConnectionManager } from "./connection-manager.js";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { TaskSharingReads } from "./task-sharing-reads.js";
import type { ConnectServiceDependencies } from "./connect-services.js";
import { createTaskSharingRuntime } from "./task-sharing-runtime.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "joko-task-sharing-host-")), store = new OperationalStore(join(directory, "store.sqlite"));
  store.upsertBackend({ id: "backend", displayName: "Backend", version: "test", health: "healthy", adapterKind: "fixture", instanceGeneration: 0,
    installationState: "installed", authenticationState: "not_required", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "target", backendId: "backend", displayName: "Target", workspaceRoot: directory, managed: false, trusted: true });
  for (const id of ["session", "other-session"]) store.createSession({ id, backendId: "backend", targetId: "target", title: id, binding: { opaqueRef: id, generation: 1 },
    pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
  const artifacts = new ArtifactStore({ rootDirectory: join(directory, "artifacts"), ingestRoots: [directory], repository: new OperationalArtifactRepository(store) });
  await artifacts.initialize();
  const prepare = vi.fn<TaskSharingRuntimePort["prepareOperation"]>(() => ({ kind: "transactional", commit: () => Uint8Array.of(1, 2) }));
  const runtime: TaskSharingRuntimePort = { canShare: () => true, snapshot: async lease => create(contract.SnapshotSchema, {
    scope: { kind: { case: "session", value: { sessionId: lease.scope.sessionId } } } }), read: async () => new Uint8Array(), prepareOperation: prepare,
    projectEvent: () => undefined };
  const host = new TaskSharingHost({ store, artifacts, serverId: "host", origin: "http://127.0.0.1:4327", generation: () => 3n, runtime });
  const share = host.create({ operationId: "create", sessionId: "session" }), invitation = host.invite({ operationId: "invite", shareId: share.shareId }).invitation;
  const member = (suffix: string) => {
    const secret = suffix.repeat(43), digest = createHash("sha256").update(secret).digest("hex");
    const joined = host.acceptJoin({ intentId: `join-${suffix}`, invitation, credentialSha256Hex: digest, displayName: `Member ${suffix}`, homeServerId: "home", homeDeviceId: `device-${suffix}` });
    return { ...joined, secret, lease: host.authenticate(`TaskShareGuest ${secret}`) };
  };
  cleanups.push(() => { host.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, artifacts, host, prepare, member, share };
}
const signal = () => new AbortController().signal;
function operation(operationId: string, sessionId = "session") {
  return toBinary(contract.SubmitOperationRequestSchema, create(contract.SubmitOperationRequestSchema, { operationId,
    mutation: { payload: { case: "resumeSession", value: { sessionId } } } }));
}
it("keeps guest credentials outside ordinary authentication and validates receipt proof", async () => {
  const f = await fixture(), member = f.member("a"), other = f.member("b");
  const ordinary = new ConnectionManager(f.store);
  expect(() => ordinary.authenticate(`TaskShareGuest ${member.secret}`)).toThrow();
  expect(() => ordinary.authenticate(`Bearer ${member.secret}`)).toThrow();
  expect(() => f.host.getJoinReceipt({ intentId: "join-a", credentialSha256Hex: member.lease.proof.credentialSha256Hex }, other.lease)).toThrow(/another participant/);
  expect(f.store.listConnections()).toHaveLength(0);
});
it("does not let a task guest dispatch, resume, approve or switch through an owner remote Agent source", async () => {
  const f = await fixture(), guest = f.member("a");
  const local = f.store.getBackend("backend").descriptor;
  f.store.upsertBackend({ ...local, id: "remote-source", capabilities: new Map([["model.remote_execution", { key: "model.remote_execution", supported: true }]]) });
  const runtime = createTaskSharingRuntime({ store: f.store, sessionHost: {} } as unknown as ConnectServiceDependencies, {
    snapshot: f.host.readSnapshot.bind(f.host), read: async () => new Uint8Array(), projectEvent: () => undefined
  } as unknown as Pick<TaskSharingRuntimePort, "snapshot" | "read" | "projectEvent">);
  const switchSource = create(contract.SubmitOperationRequestSchema, { operationId: "guest-select-remote", mutation: { payload: {
    case: "setSessionRuntime", value: { sessionId: "session", backendId: "remote-source", expectedRuntimeGeneration: 1n, providerId: "provider", modelId: "model" }
  } } });
  expect(() => runtime.prepareOperation(guest.lease, switchSource)).toThrow(/not available/);
  f.store.upsertBackend({ ...local, capabilities: new Map([["model.remote_execution", { key: "model.remote_execution", supported: true }]]) });
  const requests = [
    create(contract.SubmitOperationRequestSchema, { operationId: "guest-resume", mutation: { payload: { case: "resumeSession", value: { sessionId: "session" } } } }),
    create(contract.SubmitOperationRequestSchema, { operationId: "guest-prompt", mutation: { payload: { case: "sendInput", value: { sessionId: "session" } } } }),
    create(contract.SubmitOperationRequestSchema, { operationId: "guest-queue", mutation: { payload: { case: "resumeQueue", value: { sessionId: "session" } } } }),
    create(contract.SubmitOperationRequestSchema, { operationId: "guest-approve", mutation: { payload: { case: "resolveInteraction", value: { interactionId: "owner-permission", interactionGeneration: 1n } } } })
  ];
  for (const request of requests) {
    expect(() => runtime.prepareOperation(guest.lease, request)).toThrow(/not available/);
    expect(f.store.findOperation(request.operationId)).toBeUndefined();
  }
  expect(f.store.listQueueItems()).toHaveLength(0);
});
it("shares only public application history for the exact task", async () => {
  const f = await fixture(), guest = f.member("a");
  const event = f.store.appendEvent({ id: "app-history", sessionId: "session", targetId: "target", backendId: "backend", generation: 1,
    traceId: "app", payload: { type: "mcp_app_changed", card: { id: "card", sessionId: "session", title: "Example", text: "Public result", pending: false,
      cancelled: false, isError: false, updatedAt: 1 } } });
  const reads = new TaskSharingReads({ store: f.store } as ConnectServiceDependencies, () => 3n);
  const projected = reads.projectEvent(guest.lease, event);
  expect(projected?.payload?.kind).toMatchObject({ case: "mcpAppChanged", value: { card: { title: "Example", text: "Public result" } } });
  if (event.payload.type !== "mcp_app_changed") throw new Error("Missing application history");
  expect(reads.projectEvent(guest.lease, { ...event, sessionId: "other-session", payload: event.payload })).toBeUndefined();
});
it("replays only an exact durable member receipt and denies it immediately after removal", async () => {
  const f = await fixture(), member = f.member("a"), request = operation("request");
  expect(Array.from(await f.host.invoke(member.lease, contract.TaskShareMethod.SUBMIT_OPERATION, request, signal()))).toEqual([1, 2]);
  expect(Array.from(await f.host.invoke(member.lease, contract.TaskShareMethod.SUBMIT_OPERATION, request, signal()))).toEqual([1, 2]);
  expect(f.prepare).toHaveBeenCalledTimes(1);
  expect(f.host.shares.getAuthorForOperation("request")).toEqual(member.lease.author);
  f.host.remove({ operationId: "remove", shareId: f.share.shareId, memberId: member.member.memberId, memberGeneration: member.member.memberGeneration });
  expect(member.lease.signal.aborted).toBe(true);
  await expect(f.host.invoke(member.lease, contract.TaskShareMethod.SUBMIT_OPERATION, request, signal())).rejects.toThrow();
  expect(f.prepare).toHaveBeenCalledTimes(1);
});
it("rolls failed synchronous admission back and never repeats an admitted unknown effect", async () => {
  const f = await fixture(), member = f.member("a");
  f.prepare.mockReturnValueOnce({ kind: "transactional", commit: () => { throw new Error("controlled failure"); } });
  await expect(f.host.invoke(member.lease, contract.TaskShareMethod.SUBMIT_OPERATION, operation("rollback"), signal())).rejects.toThrow("controlled failure");
  expect(f.host.shares.getAuthorForOperation("rollback")).toBeUndefined();
  f.prepare.mockReturnValueOnce({ kind: "effect", execute: async () => { throw new Error("lost native reply"); } });
  await expect(f.host.invoke(member.lease, contract.TaskShareMethod.SUBMIT_OPERATION, operation("unknown"), signal())).rejects.toThrow("lost native reply");
  await expect(f.host.invoke(member.lease, contract.TaskShareMethod.SUBMIT_OPERATION, operation("unknown"), signal())).rejects.toThrow(/will not be replayed/);
  expect(f.prepare).toHaveBeenCalledTimes(2);
});
it("rejects a forged task, host-only mutation and late snapshot after membership retirement", async () => {
  const f = await fixture(), member = f.member("a");
  await expect(f.host.invoke(member.lease, contract.TaskShareMethod.SUBMIT_OPERATION, operation("foreign", "other-session"), signal())).rejects.toThrow(/another task/);
  const forbidden = toBinary(contract.SubmitOperationRequestSchema, create(contract.SubmitOperationRequestSchema, { operationId: "delete",
    mutation: { payload: { case: "deleteSession", value: { sessionId: "session" } } } }));
  await expect(f.host.invoke(member.lease, contract.TaskShareMethod.SUBMIT_OPERATION, forbidden, signal())).rejects.toThrow(/task owner/);
  for (const entity of [{ kind: contract.EntityKind.SESSION, id: "other-session" }, { kind: contract.EntityKind.TARGET, id: "target" }]) {
    const foreignPrecondition = create(contract.SubmitOperationRequestSchema, { operationId: `precondition-${entity.kind}`,
      mutation: { preconditions: [{ entity, expectedRevision: { value: 1n } }], payload: { case: "resumeSession", value: { sessionId: "session" } } } });
    await expect(f.host.invoke(member.lease, contract.TaskShareMethod.SUBMIT_OPERATION,
      toBinary(contract.SubmitOperationRequestSchema, foreignPrecondition), signal())).rejects.toThrow(/precondition is outside/);
    expect(f.host.shares.getAuthorForOperation(foreignPrecondition.operationId)).toBeUndefined();
  }
  expect(f.prepare).not.toHaveBeenCalled();
  const pending = f.host.readSnapshot(member.lease, signal());
  f.host.end({ operationId: "end", shareId: f.share.shareId });
  await expect(pending).rejects.toThrow();
});
it("streams finite attachment chunks with exact bytes and rejects other members, foreign blobs and revocation", async () => {
  const f = await fixture(), member = f.member("a"), other = f.member("b"), bytes = Buffer.from("shared attachment bytes");
  const begin = create(contract.TaskShareAttachmentTransferSchema, { action: { case: "begin", value: {
    operationId: "upload", name: "note.txt", mediaType: "text/plain", sizeBytes: BigInt(bytes.length), sha256Hex: createHash("sha256").update(bytes).digest("hex") } } });
  const ticket = await f.host.transfer(member.lease, begin, signal());
  const write = create(contract.TaskShareAttachmentTransferSchema, { action: { case: "write", value: { ticketId: ticket.ticketId, offset: 0n, data: bytes, finish: true } } });
  await expect(f.host.transfer(other.lease, write, signal())).rejects.toThrow(/this participant/);
  const completed = await f.host.transfer(member.lease, write, signal());
  expect(completed.complete).toBe(true); expect(completed.blob?.sha256Hex).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect((await f.host.transfer(member.lease, write, signal())).blob).toEqual(completed.blob);
  const read = create(contract.TaskShareAttachmentTransferSchema, { action: { case: "read", value: { blobId: completed.blob!.blobId, offset: 0n, maximumBytes: 5 } } });
  expect(Buffer.from((await f.host.transfer(member.lease, read, signal())).data).toString()).toBe("share");
  await expect(f.host.transfer(other.lease, read, signal())).rejects.toThrow(/does not belong/);
  const foreign = await f.artifacts.ingestBytes(Buffer.from("unrelated"), { fileName: "other.txt" });
  await expect(f.host.transfer(member.lease, create(contract.TaskShareAttachmentTransferSchema, { action: { case: "read", value: { blobId: foreign.id, maximumBytes: 5 } } }), signal())).rejects.toThrow(/does not belong/);
  f.host.remove({ operationId: "remove", shareId: f.share.shareId, memberId: member.member.memberId, memberGeneration: member.member.memberGeneration });
  await expect(f.host.transfer(member.lease, read, signal())).rejects.toThrow();
});
it("lets only the original retired member verify its exact Leave receipt without regaining task access", async () => {
  const f = await fixture(), member = f.member("a"), other = f.member("b"), input = { scope: member.lease.scope, operationId: "leave-original" };
  expect(() => f.host.lookupLeave(`TaskShareGuest ${member.secret}`, input)).toThrow(/No task leave was admitted/);
  f.host.leave(member.lease, input.operationId);
  expect(() => f.host.authenticate(`TaskShareGuest ${member.secret}`)).toThrow(/revoked/);
  expect(f.host.lookupLeave(`TaskShareGuest ${member.secret}`, input)).toBe(true);
  expect(() => f.host.lookupLeave(`TaskShareGuest ${other.secret}`, input)).toThrow(/another participant/);
  expect(() => f.host.lookupLeave(`TaskShareGuest ${member.secret}`, { ...input, scope: create(contract.TaskShareScopeSchema, {
    ...input.scope, memberGeneration: input.scope.memberGeneration + 1n }) })).toThrow(/another participant/);
  expect(() => f.host.lookupLeave(`TaskShareGuest ${member.secret}`, { ...input, operationId: "create" })).toThrow(/another participant/);
});
