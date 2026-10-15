import { clone, create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import {
  ActorKind, JoinedTaskShareSchema, OperationSchema, OperationService, GetOperationResponseSchema,
  SessionService, SettingsService, SnapshotSchema, TaskShareSnapshotSchema, BlobRefSchema,
  TaskShareAttachmentResultSchema, type TaskSharingApi
} from "@joko/contracts";
import { createJoinedTaskPort } from "./task-sharing-api.js";
import { sha256Hex } from "./web-crypto.js";

const joined = create(JoinedTaskShareSchema, { joinId: "join", status: "active", share: {
  shareId: "share", shareGeneration: 2n, sessionId: "same-task", hostServerId: "host", hostOrigin: "https://host.example", status: "active"
}, member: { memberId: "member", memberGeneration: 3n, status: "active", displayName: "Participant" } });
const journal = () => ({ pending: vi.fn().mockResolvedValue([]), begin: vi.fn().mockResolvedValue(undefined), finish: vi.fn().mockResolvedValue(undefined) });
describe("shared task generated transport", () => {
  it("uses the closed descriptor list and rejects ordinary Home APIs and streams", async () => {
    const api = { invoke: vi.fn().mockResolvedValue({}) } as unknown as TaskSharingApi;
    const port = createJoinedTaskPort(api, joined, new AbortController().signal, journal());
    await expect(createClient(SettingsService, port.transport).getSettings({})).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(api.invoke).not.toHaveBeenCalled();
    await createClient(SessionService, port.transport).getSession({ sessionId: "same-task" });
    expect(api.invoke).toHaveBeenCalledOnce();
    await expect(port.transport.stream(SessionService.method.getSession as never, undefined, undefined, undefined, {} as never)).rejects.toMatchObject({ code: Code.PermissionDenied });
  });
  it("accepts only receipts with this immutable participant and complete share generation", async () => {
    const operation = create(OperationSchema, { operationId: "op", connectionId: "", actor: { kind: ActorKind.TASK_PARTICIPANT, id: "member" },
      sharedTaskAuthor: { shareId: "share", shareGeneration: 2n, sessionId: "same-task", memberId: "member", memberGeneration: 3n, displayName: "Participant" } });
    const api = { invoke: vi.fn().mockResolvedValue(create(GetOperationResponseSchema, { operation })) } as unknown as TaskSharingApi;
    const port = createJoinedTaskPort(api, joined, new AbortController().signal, journal());
    const client = createClient(OperationService, port.transport);
    expect((await client.getOperation({ operationId: "op" })).operation?.operationId).toBe("op");
    for (const change of [ (value: typeof operation) => { value.connectionId = "home"; },
      (value: typeof operation) => { value.sharedTaskAuthor!.memberGeneration = 4n; },
      (value: typeof operation) => { value.actor!.kind = ActorKind.CONNECTION; } ]) {
      const wrong = clone(OperationSchema, operation); change(wrong);
      vi.mocked(api.invoke).mockResolvedValueOnce(create(GetOperationResponseSchema, { operation: wrong }) as never);
      await expect(client.getOperation({ operationId: "op" })).rejects.toMatchObject({ code: Code.PermissionDenied });
    }
  });
  it("rejects widened snapshots and changed membership instead of borrowing Home authority", async () => {
    const snapshot = create(SnapshotSchema, { server: { serverId: "host" }, scope: { kind: { case: "session", value: { sessionId: "same-task" } } }, sessions: [{ sessionId: "same-task" }] });
    const state = clone(TaskShareSnapshotSchema, create(TaskShareSnapshotSchema, { share: joined.share, member: joined.member, snapshot }));
    const api = { snapshot: vi.fn().mockResolvedValue(state) } as unknown as TaskSharingApi;
    const port = createJoinedTaskPort(api, joined, new AbortController().signal, journal());
    expect(await port.snapshot(new AbortController().signal)).toBe(state.snapshot);
    state.snapshot!.sessions.push(create(SessionService.method.getSession.output).session!);
    await expect(port.snapshot(new AbortController().signal)).rejects.toMatchObject({ code: Code.PermissionDenied });
    state.snapshot!.sessions.pop(); state.member!.status = "revoked";
    await expect(port.snapshot(new AbortController().signal)).rejects.toMatchObject({ code: Code.PermissionDenied });
  });
  it("verifies actual attachment chunk acknowledgments, size and digest before exposing media", async () => {
    const bytes = new TextEncoder().encode("Shared attachment"), digest = await sha256Hex(bytes.buffer);
    const blob = create(BlobRefSchema, { blobId: "blob", byteSize: BigInt(bytes.byteLength), sha256Hex: digest, mediaType: "text/plain" });
    const api = { transfer: vi.fn().mockResolvedValue(create(TaskShareAttachmentResultSchema, { offset: BigInt(bytes.byteLength), data: bytes, complete: true, blob })) } as unknown as TaskSharingApi;
    const port = createJoinedTaskPort(api, joined, new AbortController().signal, journal());
    expect(await (await port.download("blob", new AbortController().signal)).text()).toBe("Shared attachment");
    vi.mocked(api.transfer).mockResolvedValueOnce(create(TaskShareAttachmentResultSchema, { offset: 0n, data: bytes, complete: true, blob }));
    await expect(port.download("blob", new AbortController().signal)).rejects.toThrow("incomplete");
    vi.mocked(api.transfer).mockResolvedValueOnce(create(TaskShareAttachmentResultSchema, { offset: BigInt(bytes.byteLength), data: bytes, complete: true, blob: { ...blob, sha256Hex: "0".repeat(64) } }));
    await expect(port.download("blob", new AbortController().signal)).rejects.toThrow("identity");
  });
});
