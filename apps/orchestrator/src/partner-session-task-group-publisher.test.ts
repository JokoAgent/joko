import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { BlobRef } from "@joko/core";
import { OperationalStore, PartnerNetworkStore, networkHash, type ArtifactRecord } from "@joko/store";
import { afterEach, expect, it, vi } from "vitest";
import { PartnerNetworkHost } from "./partner-network-host.js";
import { PartnerSessionTaskGroupPublisher, type PartnerSessionTaskGroupOrigin, type PartnerSessionTaskGroupPort } from "./partner-session-task-group-publisher.js";
import type { PartnerSessionTaskRecord } from "./partner-session-tasks.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-task-group-publish-")), store = new OperationalStore(":memory:");
  const host = new PartnerNetworkHost({ storage: new PartnerNetworkStore(store), serverId: "task-home", origin: "http://127.0.0.1", endpointPublicKey: `ed25519:${"a".repeat(64)}`, mediaDirectory: join(root, "media"),
    partner: id => ({ id, name: "Aster", description: "Partner" }) });
  const room = host.create(create(contract.CreatePartnerNetworkRequestSchema, { operationId: "group-create", name: "Project", displayName: "Owner", partnerIds: ["aster"] }));
  const actor = room.members.find(member => member.kind === "partner")!;
  const origin: PartnerSessionTaskGroupOrigin = { version: 1, roomId: room.id, joinId: "", hostServerId: "task-home", actorId: actor.id,
    ownerId: actor.ownerId, sourceMessageId: "source-message", accessRevision: "1", fallbackSessionId: "original-private" };
  let now = Date.now(); const bytes = new Map<string, Uint8Array>(); let files: BlobRef[] = [];
  vi.spyOn(store, "listArtifacts").mockImplementation(options => files.slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? 500)).map(blob => ({ blob } as ArtifactRecord)));
  const port: PartnerSessionTaskGroupPort = { capture: vi.fn(() => { throw new Error("Completed tasks must not revive an execution lease."); }), homeServerId: () => "task-home",
    publish: async (_origin, request) => host.publish(request, origin.ownerId),
    media: async (_origin, request, signal) => host.media(request, origin.ownerId, { signal, assertCurrent() { signal.throwIfAborted(); } }),
    readArtifact: async blob => { const data = bytes.get(blob.id); if (!data) throw new Error("The local file is unreadable."); return data; } };
  const publisher = () => new PartnerSessionTaskGroupPublisher(store, port, () => now);
  const task: PartnerSessionTaskRecord = { version: 1, id: "owned-task", partnerId: "aster", parentSessionId: "group-lane", requestFingerprint: "a".repeat(64),
    title: "Public title", objective: "PRIVATE_GOAL_DO_NOT_PUBLISH", contextRefs: [], targetId: "task-target", directory: root, realDirectory: root, useWorktree: false,
    route: { backendId: "native", providerId: "provider", modelId: "model", fastMode: false }, routes: [{ backendId: "native", providerId: "provider", modelId: "model", fastMode: false }],
    explicitModel: false, permissionMode: "ask", planMode: false, timeoutMs: 30000, deadlineAt: now + 30000, createdAt: now, updatedAt: now, execution: 1,
    executionRunIds: ["task-run"], runId: "task-run", sessionId: "task-session", status: "running", control: "active", group: origin };
  const add = (name: string, data: Uint8Array) => { const blob = { id: `artifact-${files.length}`, fileName: name, mimeType: "text/plain", byteLength: data.length, sha256: createHash("sha256").update(data).digest("hex") };
    files.push(blob); bytes.set(blob.id, data); return blob; };
  cleanups.push(async () => { await host.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { store, host, room, origin, port, publisher, task, add, advance: (milliseconds: number) => { now += milliseconds; },
    allFiles: () => files, messages: () => host.storage.messages(room.id), setFiles: (value: BlobRef[]) => { files = value; } };
}

it("persists multipart terminal output, adopts every valid file and recovers a lost publication reply without waking any task", async () => {
  const f = await fixture(); for (let index = 0; index < 25; index++) f.add(`report-${index}.txt`, new TextEncoder().encode(`Report ${index}`));
  f.add("empty.txt", new Uint8Array()); f.setFiles([...f.allFiles(), { ...f.allFiles()[0]!, id: "too-large", byteLength: 100 * 1024 * 1024 + 1 }, { ...f.allFiles()[0]!, id: "unreadable" }]);
  const original = f.port.publish; let lost = false;
  f.port.publish = async (...args) => { const result = await original(...args); if (!lost) { lost = true; throw new ConnectError("Reply lost", Code.Unavailable); } return result; };
  const text = "Result line. ".repeat(4200), ended = { ...f.task, status: "completed" as const, result: text };
  const first = f.publisher(); expect(await first.terminal(ended)).toBe("retry"); expect(f.messages()).toHaveLength(1); first.close();
  f.advance(1001); const recovered = f.publisher(); expect(await recovered.terminal(ended)).toBe("delivered");
  expect(f.messages()).toHaveLength(3); expect(f.messages().map(message => message.text).join("")).toBe(text);
  expect(f.messages().map(message => message.attachments.length)).toEqual([20, 5, 0]); expect(f.messages().filter(message => message.task)).toHaveLength(1);
  expect(f.messages()[0]?.task).toMatchObject({ title: f.task.title, status: "completed", sessionId: f.task.sessionId, execution: 1 });
  expect(JSON.stringify(f.messages())).not.toContain(f.task.objective); expect(f.host.storage.executions(f.room.id)).toEqual([]); expect(f.store.listQueueItems()).toEqual([]);
  const saved = f.store.listSettings("service", "partner.session-task-group-deliveries")[0]!.value as { files: { skipped?: string }[] };
  expect(saved.files.filter(file => file.skipped)).toHaveLength(3); expect(f.port.capture).not.toHaveBeenCalled();
  expect(await recovered.terminal(ended)).toBe("delivered"); expect(f.messages()).toHaveLength(3); recovered.close();
});

it("resumes a chunk whose successful receipt was lost from the room's actual persisted offset", async () => {
  const f = await fixture(); f.add("large.txt", new Uint8Array(600000).fill(65));
  const media = f.port.media, writes: bigint[] = []; let lost = false;
  f.port.media = async (...args) => { const result = await media(...args); if (args[1].action === "write") { writes.push(args[1].offset);
    if (!lost) { lost = true; throw new ConnectError("Reply lost", Code.Unavailable); } } return result; };
  const ended = { ...f.task, status: "completed" as const, result: "Ready" }, first = f.publisher();
  expect(await first.terminal(ended)).toBe("retry"); first.close(); f.advance(1001);
  const recovered = f.publisher(); expect(await recovered.terminal(ended)).toBe("delivered");
  expect(writes).toEqual([0n, 262144n, 524288n]); expect(f.messages()).toHaveLength(1); expect(f.messages()[0]?.attachments[0]?.sizeBytes).toBe(600000); recovered.close();
});

it("skips a server-refused file, sanitizes approval cards and never sends a delayed running card after completion", async () => {
  const f = await fixture(), publisher = f.publisher(), publish = f.port.publish;
  f.port.publish = async () => { throw new ConnectError("Temporary", Code.Unavailable); };
  expect(await publisher.running(f.task)).toBe("retry");
  f.port.publish = publish; f.add("refused.txt", new TextEncoder().encode("refused")); f.add("accepted.txt", new TextEncoder().encode("accepted"));
  const media = f.port.media; f.port.media = async (...args) => { if (args[1].name === "refused.txt") throw new ConnectError("File refused", Code.InvalidArgument); return media(...args); };
  expect(await publisher.interaction(f.task, { id: "approval", generation: 1, payload: { id: "approval", kind: "permission", title: "Read secret", toolName: "PRIVATE_TOOL", summary: "PRIVATE_PARAMETERS", risk: "high", choices: ["allow"] } })).toBe("delivered");
  expect(JSON.stringify(f.messages())).not.toContain("PRIVATE_TOOL"); expect(JSON.stringify(f.messages())).not.toContain("PRIVATE_PARAMETERS");
  expect(f.messages()[0]?.task).toMatchObject({ interactionKind: "permission", question: "" });
  expect(await publisher.terminal({ ...f.task, status: "timed-out", error: "The original time budget ended." })).toBe("delivered");
  expect(f.messages().map(message => message.task?.status)).toEqual(["waiting", "timed-out"]); expect(f.messages()[1]?.attachments).toHaveLength(1);
  expect(publisher.nextAttempt(f.task.id)).toBeUndefined(); publisher.close();
});

it("retries the original task file after its begin request stops immediately after file creation", async () => {
  const f = await fixture(); f.add("report.txt", new TextEncoder().encode("complete result"));
  const normalMedia = f.port.media; let interrupted = false;
  f.port.media = async (origin, request, signal) => {
    if (request.action !== "begin" || interrupted) return normalMedia(origin, request, signal);
    interrupted = true;
    const id = `media:${networkHash([origin.ownerId, request.operationId])}`;
    const path = join(f.host.options.mediaDirectory, request.roomId, id.replace(":", "-"));
    const abort = new AbortController(), requestSignal = AbortSignal.any([signal, abort.signal]);
    try {
      return await f.host.media(request, origin.ownerId, { signal: requestSignal, assertCurrent() {
        if (existsSync(path)) abort.abort();
        requestSignal.throwIfAborted();
      } });
    } catch { throw new ConnectError("The original upload request disconnected.", Code.Unavailable); }
  };
  const completed = { ...f.task, status: "completed" as const, result: "Finished" };
  const first = f.publisher(); expect(await first.terminal(completed)).toBe("retry"); first.close();
  expect(f.messages()).toEqual([]);
  f.advance(1001);
  const recovered = f.publisher();
  try {
    expect(await recovered.terminal(completed)).toBe("delivered");
    const attachment = f.messages()[0]!.attachments[0]!;
    expect(f.messages()).toHaveLength(1);
    expect(attachment.name).toBe("report.txt");
    expect(await readFile(join(f.host.options.mediaDirectory, f.room.id, attachment.id.replace(":", "-")), "utf8")).toBe("complete result");
    expect(await recovered.terminal(completed)).toBe("delivered");
    expect(f.messages()).toHaveLength(1);
  } finally { recovered.close(); }
});

it("returns a definitive archived-room refusal for private fallback, including a previously accepted message receipt", async () => {
  const f = await fixture(), publisher = f.publisher();
  expect(await publisher.running(f.task)).toBe("delivered");
  const room = f.host.storage.get(f.room.id);
  f.host.storage.manage({ operationId: "archive-room", roomId: room.id, actorId: f.origin.ownerId, expectedRevision: room.revision, action: "archive", targetId: "", value: "", throughSequence: 0 });
  expect(await publisher.terminal({ ...f.task, status: "completed", result: "Completed result" })).toBe("fallback");
  expect(f.messages()).toHaveLength(1); expect(f.messages()[0]?.task?.status).toBe("running"); publisher.close();
});

it("drops resolved pending questions, preserves the current question text and localizes a pure running fallback", async () => {
  const f = await fixture(), publisher = f.publisher(), publish = f.port.publish;
  f.port.publish = async () => { throw new ConnectError("Temporary", Code.Unavailable); };
  const question = { id: "question", generation: 1, payload: { id: "question", kind: "question" as const, title: "Choose", prompt: "Which report should be published?", fields: [{ id: "choice", kind: "text" as const, label: "Report name", required: true, multiline: false }] } };
  expect(await publisher.interaction(f.task, question)).toBe("retry"); publisher.synchronizeProgress(f.task, []); expect(publisher.nextAttempt(f.task.id)).toBeUndefined();
  f.port.publish = publish; f.port.locale = () => "zh-CN";
  expect(await publisher.running(f.task)).toBe("delivered"); expect(f.messages()[0]?.text).toBe(`${f.task.title} — 任务进行中`);
  expect(await publisher.interaction(f.task, { ...question, id: "current-question" })).toBe("delivered");
  expect(f.messages()[1]?.task?.question).toBe("Choose\nWhich report should be published?\nReport name");
  expect(f.messages()[1]?.text).toBe(`${f.task.title} — 等你确认`); publisher.close();
});
