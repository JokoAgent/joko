import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, type Client } from "@connectrpc/connect";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as contract from "@joko/contracts";
import { CredentialVault } from "./credential-vault.js";
import { TaskSharingHome, type TaskSharingHomeAuthority, type TaskSharingHomeRemote } from "./task-sharing-home.js";
import { mkdtemp } from "./test-paths.js";

const invitation = contract.buildTaskShareInvitation({ hostOrigin: "http://127.0.0.1:34567", hostServerId: "host-server",
  shareId: "share-one", shareGeneration: 1n, inviteSecret: "a".repeat(43) });
function authority(): TaskSharingHomeAuthority {
  const controller = new AbortController();
  return { deviceId: "home-device", signal: controller.signal, assertCurrent: () => controller.signal.throwIfAborted() };
}
function fixture() {
  const share = create(contract.TaskShareSchema, { shareId: "share-one", shareGeneration: 1n, revision: 1n,
    sessionId: "remote-session", hostOrigin: "http://127.0.0.1:34567", hostServerId: "host-server", status: "active", title: "A shared task" });
  const member = create(contract.TaskShareMemberSchema, { memberId: "member-one", memberGeneration: 1n, status: "active", displayName: "Guest" });
  let claimedDigest = "";
  const inspect = vi.fn(async () => ({ share }));
  const accept = vi.fn(async (request: { credentialSha256Hex: string }) => { claimedDigest = request.credentialSha256Hex; return { share, member }; });
  const lookup = vi.fn(async (request: { credentialSha256Hex: string }, options: { headers: { authorization: string } }) => {
    expect(request.credentialSha256Hex).toBe(claimedDigest);
    const secret = options.headers.authorization.slice("TaskShareGuest ".length);
    expect(createHash("sha256").update(secret).digest("hex")).toBe(claimedDigest);
    return { share, member };
  });
  const snapshot = vi.fn(async () => ({ state: create(contract.TaskShareSnapshotSchema, { share, member,
    snapshot: { scope: { kind: { case: "session", value: { sessionId: share.sessionId } } }, sessions: [{ sessionId: share.sessionId }] } }) }));
  const invoke = vi.fn(async (request: { method: contract.TaskShareMethod; requestBytes: Uint8Array }) => {
    if (request.method !== contract.TaskShareMethod.GET_OPERATION) throw new ConnectError("Response lost.", Code.Unavailable);
    const operationId = fromBinary(contract.GetOperationRequestSchema, request.requestBytes).operationId;
    return { responseBytes: toBinary(contract.GetOperationResponseSchema, create(contract.GetOperationResponseSchema, { operation: { operationId } })) };
  });
  const leave = vi.fn(async () => ({ share, member: create(contract.TaskShareMemberSchema, { ...member, status: "left", memberGeneration: 2n }) }));
  const verify = vi.fn(async (serverId: string) => { expect(serverId).toBe("host-server"); });
  const remote: TaskSharingHomeRemote = { verify, guest: { inspectTaskShareInvitation: inspect, acceptTaskShareJoin: accept,
    getTaskShareJoinReceipt: lookup, getSharedTaskSnapshot: snapshot, invokeSharedTask: invoke, leaveSharedTask: leave } as unknown as Client<typeof contract.TaskSharingGuestService> };
  return { remote, inspect, accept, lookup, snapshot, invoke, leave, verify };
}
async function owner(remote: TaskSharingHomeRemote) {
  const directory = await mkdtemp(join(tmpdir(), "joko-task-sharing-home-"));
  const vault = await CredentialVault.open(join(directory, "master.key"));
  const home = new TaskSharingHome({ directory, vault, serverId: "home-server", connect: () => remote });
  await home.initialize(); return { directory, vault, home };
}

describe("TaskSharingHome", () => {
  it("recovers a lost Join response after restart with the sealed original secret and no second Join", async () => {
    const fixtureValue = fixture(), original = fixtureValue.accept.getMockImplementation()!;
    fixtureValue.accept.mockImplementationOnce(async request => { await original(request); throw new ConnectError("Response lost.", Code.Unavailable); });
    const { home, directory, vault } = await owner(fixtureValue.remote), auth = authority();
    const first = await home.join("join-operation", invitation, "Guest", auth);
    expect(first.status).toBe("unknown"); expect(fixtureValue.accept).toHaveBeenCalledTimes(1);
    const disk = await readFile(join(directory, "home.json"), "utf8");
    expect(disk).not.toContain(invitation); expect(disk).not.toContain("TaskShareGuest "); expect(disk).not.toContain('"secret"');
    await home.dispose();
    const restarted = new TaskSharingHome({ directory, vault, serverId: "home-server", connect: () => fixtureValue.remote }); await restarted.initialize();
    const recovered = await restarted.lookup("join-operation", auth);
    expect(recovered.status).toBe("joined"); expect(recovered.joined?.member?.memberId).toBe("member-one");
    expect(fixtureValue.accept).toHaveBeenCalledTimes(1); expect(fixtureValue.lookup).toHaveBeenCalledTimes(1);
    expect(restarted.list().joined).toHaveLength(1); await restarted.dispose();
  });
  it("verifies the Host identity before opening any foreign credential", async () => {
    const value = fixture(), { home, vault } = await owner(value.remote), auth = authority();
    const joined = await home.join("join-operation", invitation, "Guest", auth);
    const openCredential = vi.spyOn(vault, "open");
    value.verify.mockRejectedValueOnce(new ConnectError("Different server.", Code.PermissionDenied));
    await expect(home.snapshot(joined.joined!.joinId, auth)).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(openCredential).not.toHaveBeenCalled(); expect(value.snapshot).not.toHaveBeenCalled(); await home.dispose();
  });
  it("queries an unknown mutation's original Operation rather than dispatching it again", async () => {
    const value = fixture(), { home } = await owner(value.remote), auth = authority();
    const joined = await home.join("join-operation", invitation, "Guest", auth), joinId = joined.joined!.joinId;
    const bytes = toBinary(contract.SubmitOperationRequestSchema, create(contract.SubmitOperationRequestSchema, { operationId: "input-operation" }));
    await expect(home.invoke(joinId, contract.TaskShareMethod.SUBMIT_OPERATION, bytes, auth)).rejects.toMatchObject({ code: Code.Unavailable });
    const response = await home.invoke(joinId, contract.TaskShareMethod.SUBMIT_OPERATION, bytes, auth);
    expect(fromBinary(contract.SubmitOperationResponseSchema, response).operation?.operationId).toBe("input-operation");
    expect(value.invoke.mock.calls.map(([request]) => request.method)).toEqual([contract.TaskShareMethod.SUBMIT_OPERATION, contract.TaskShareMethod.GET_OPERATION]);
    await home.dispose();
  });
  it("persists a confirmed Leave receipt and accepts the retired member generation without reissuing it", async () => {
    const value = fixture(), { home, directory, vault } = await owner(value.remote), auth = authority();
    const joined = await home.join("join-operation", invitation, "Guest", auth), joinId = joined.joined!.joinId;
    expect((await home.leave("leave-operation", joinId, auth)).status).toBe("left");
    expect((await home.lookupAction("leave-operation"))?.status).toBe("applied"); await home.dispose();
    const restarted = new TaskSharingHome({ directory, vault, serverId: "home-server", connect: () => value.remote }); await restarted.initialize();
    expect((await restarted.leave("leave-operation", joinId, auth)).status).toBe("left");
    expect(value.leave).toHaveBeenCalledTimes(1);
    await expect(restarted.snapshot(joinId, auth)).rejects.toMatchObject({ code: Code.PermissionDenied }); await restarted.dispose();
  });
  it("keeps a valid member after a single forbidden action and an unavailable membership recheck", async () => {
    const value = fixture(), { home } = await owner(value.remote), auth = authority();
    const joined = await home.join("join-operation", invitation, "Guest", auth), joinId = joined.joined!.joinId;
    value.invoke.mockRejectedValueOnce(new ConnectError("Forbidden action.", Code.PermissionDenied));
    const request = toBinary(contract.GetOperationRequestSchema, create(contract.GetOperationRequestSchema, { operationId: "other-operation" }));
    await expect(home.invoke(joinId, contract.TaskShareMethod.GET_OPERATION, request, auth)).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(home.list().joined[0]?.status).toBe("active");
    value.invoke.mockRejectedValueOnce(new ConnectError("Forbidden action.", Code.PermissionDenied));
    value.snapshot.mockRejectedValueOnce(new ConnectError("Network unavailable.", Code.Unavailable));
    await expect(home.invoke(joinId, contract.TaskShareMethod.GET_OPERATION, request, auth)).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(home.list().joined[0]?.status).toBe("active");
    await expect(home.snapshot(joinId, auth)).resolves.toBeDefined();
    expect(value.invoke).toHaveBeenCalledTimes(2); await home.dispose();
  });
  it("locally leaves confirmed revoked membership without opening its credential or sending a Host mutation", async () => {
    const value = fixture(), { home, vault, directory } = await owner(value.remote), auth = authority();
    const joined = await home.join("join-operation", invitation, "Guest", auth), joinId = joined.joined!.joinId;
    value.snapshot.mockRejectedValueOnce(new ConnectError("Membership removed.", Code.PermissionDenied));
    value.snapshot.mockRejectedValueOnce(new ConnectError("Membership removed.", Code.PermissionDenied));
    await expect(home.snapshot(joinId, auth)).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(home.list().joined[0]?.status).toBe("revoked");
    const unseal = vi.spyOn(vault, "open"), beforeCalls = value.verify.mock.calls.length;
    expect((await home.leave("leave-revoked", joinId, auth)).status).toBe("left");
    expect(unseal).not.toHaveBeenCalled(); expect(value.verify).toHaveBeenCalledTimes(beforeCalls); expect(value.leave).not.toHaveBeenCalled();
    expect((await home.lookupAction("leave-revoked"))?.status).toBe("applied");
    const disk = JSON.parse(await readFile(join(directory, "home.json"), "utf8"));
    expect(vault.open(disk.joined[0].sealed, disk.joined[0].credentialReference)).toBe("{}"); await home.dispose();
  });
  it("recovers a lost Leave response through only its original retired-member receipt after restart", async () => {
    const value = fixture(), original = value.leave.getMockImplementation()!;
    value.leave.mockImplementationOnce(async () => { await original(); throw new ConnectError("Response lost.", Code.Unavailable); });
    const getSharedTaskLeaveReceipt = vi.fn(async (request, options) => {
      expect(request.operationId).toBe("leave-lost"); expect(request.scope.memberGeneration).toBe(1n);
      expect(options.headers.authorization.startsWith("TaskShareGuest ")).toBe(true); return { applied: true };
    });
    (value.remote.guest as unknown as { getSharedTaskLeaveReceipt: typeof getSharedTaskLeaveReceipt }).getSharedTaskLeaveReceipt = getSharedTaskLeaveReceipt;
    const { home, vault, directory } = await owner(value.remote), auth = authority();
    const joined = await home.join("join-operation", invitation, "Guest", auth), joinId = joined.joined!.joinId;
    await expect(home.leave("leave-lost", joinId, auth)).rejects.toMatchObject({ code: Code.Unavailable });
    await expect(home.snapshot(joinId, auth)).rejects.toMatchObject({ code: Code.FailedPrecondition }); await home.dispose();
    const restarted = new TaskSharingHome({ directory, vault, serverId: "home-server", connect: () => value.remote }); await restarted.initialize();
    expect((await restarted.lookupAction("leave-lost", auth))?.status).toBe("applied");
    expect(restarted.list().joined[0]?.status).toBe("left"); expect(value.leave).toHaveBeenCalledTimes(1);
    expect(getSharedTaskLeaveReceipt).toHaveBeenCalledTimes(1); await restarted.dispose();
  });
  it("refreshes unopened joined directory metadata, preserves temporary disconnection, and confirms revocation", async () => {
    const value = fixture(), { home } = await owner(value.remote), auth = authority();
    await home.join("join-operation", invitation, "Guest", auth);
    value.snapshot.mockRejectedValueOnce(new ConnectError("Network unavailable.", Code.Unavailable));
    await home.refreshDirectory(auth); expect(home.list().joined[0]?.status).toBe("disconnected");
    const fresh = await value.snapshot(); fresh.state.share!.title = "Renamed task";
    value.snapshot.mockResolvedValueOnce(fresh);
    await home.refreshDirectory(auth);
    expect(home.list().joined[0]).toMatchObject({ status: "active", share: { title: "Renamed task" } });
    value.snapshot.mockRejectedValueOnce(new ConnectError("Member revoked.", Code.Unauthenticated));
    await home.refreshDirectory(auth); expect(home.list().joined[0]?.status).toBe("revoked");
    expect(value.invoke).not.toHaveBeenCalled(); expect(value.leave).not.toHaveBeenCalled(); await home.dispose();
  });
});
