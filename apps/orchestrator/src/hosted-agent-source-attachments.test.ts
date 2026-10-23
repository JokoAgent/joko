import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { AdapterContext, BlobRef, PromptInput } from "@joko/core";
import { OperationalStore } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { afterEach, expect, it } from "vitest";
import { mkdtemp } from "./test-paths.js";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { createArtifactMentionResolver } from "./artifact-mention-resolver.js";
import { HostedAgentSourceAttachments } from "./hosted-agent-source-attachments.js";
import { HostedAgentSourceResources } from "./hosted-agent-source-resources.js";
import { prepareSourceWorkspaceInput } from "./hosted-agent-source-input.js";
import { HostedAgentExecutor } from "./hosted-agent-executor.js";
import { snapshotSourceInputFile } from "./hosted-agent-input-snapshot.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-source-attachment-"))), workspace = join(root, "workspace"); await mkdir(workspace);
  const store = new OperationalStore(join(root, "store.db")), backend = new FakeBackendAdapter(PI_LIKE_PROFILE), descriptor = await backend.describe(); store.upsertBackend(descriptor);
  const target = { id: "project", backendId: backend.id, displayName: "Original", workspaceRoot: workspace, managed: false, trusted: true }; store.upsertTarget(target);
  for (const id of ["task", "origin"]) store.createSession({ id, backendId: backend.id, targetId: target.id, title: id, binding: { opaqueRef: `native-${id}`, generation: 1 },
    pinned: false, archived: false, permissionMode: "bypassPermissions", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
  const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] }); await artifacts.initialize();
  const resolveArtifactMention = createArtifactMentionResolver({ store, artifacts, resolveTarget: session => store.getTarget(session.descriptor.targetId).descriptor, assertBackendCurrent: () => {} });
  let current = true;
  const assertContext = (context: AdapterContext) => { const session = store.getSession(context.sessionId).descriptor;
    if (!current || session.binding.generation !== context.generation || session.deletedAt !== undefined || session.archived) throw new Error("The original task authority changed."); };
  const options = { store, root: join(root, "inputs"), resolveFile: (blob: BlobRef) => artifacts.resolveBlobPath(blob), resolveArtifactMention, assertContext };
  let attachments = new HostedAgentSourceAttachments(options), ordinal = 0;
  const enqueue = (body: PromptInput) => {
    const id = `item-${++ordinal}`, session = store.getSession("task").descriptor;
    store.runOperation({ id: `operation-${id}`, kind: "input.enqueue", body: {} }, transaction => {
      transaction.createRun({ id: `run-${id}`, sessionId: "task", source: "user", state: "queued", createdAt: 1 });
      transaction.createAttempt({ id: `attempt-${id}`, runId: `run-${id}`, ordinal: 1, generation: session.binding.generation, startedAt: 1 });
      transaction.enqueueQueueItem({ id, sessionId: "task", runId: `run-${id}`, attemptId: `attempt-${id}`, operationId: `operation-${id}`, body, disposition: "prompt" });
      return {};
    });
    const item = store.claimNextQueueItem({ sessionId: "task", backendInstanceGeneration: descriptor.instanceGeneration })!; expect(item.id).toBe(id);
    const context: AdapterContext = { sessionId: "task", generation: session.binding.generation, backendInstanceGeneration: descriptor.instanceGeneration, target, binding: session.binding,
      inputQueueItemId: id, operationId: item.operationId, ...(body.artifactReferenceSnapshots ? { artifactReferenceSnapshots: body.artifactReferenceSnapshots } : {}), signal: new AbortController().signal,
      emit: async () => {}, requestInteraction: async () => ({ kind: "cancelled" }), artifactCapacityBytes: 256 * 1024 * 1024,
      storeArtifact: async () => { throw new Error("No generated output in this test."); } };
    return context;
  };
  const prepare = async (body: PromptInput) => {
    const context = enqueue(body); await attachments.capture(context); const resources = new HostedAgentSourceResources();
    const prepared = await prepareSourceWorkspaceInput(body, context, { shadow: "/native/workspace", workspaceId: target.id, resources,
      assertCurrent: () => assertContext(context), attachments: attachments.begin(context, "/native/workspace") });
    return { context, prepared };
  };
  const executor = (context: AdapterContext, shadow = "/native/workspace") => {
    const value = new HostedAgentExecutor({ context, virtualRoot: shadow, aliases: attachments.authority(context, shadow).aliases, assertCurrent: () => assertContext(context),
      inputFiles: () => attachments.authority(context, shadow).files,
      readPolicy: () => ({ revision: attachments.authority(context, shadow).revision, permissionMode: "bypassPermissions", planMode: false, confirmCredentials: true,
        approvedRoots: attachments.authority(context, shadow).files.map((file, index) => ({ id: `input-${index}`, path: file.path, access: "read_only" })) }) });
    cleanup.push(async () => value.dispose()); return value;
  };
  cleanup.push(async () => { store.close(); if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe cleanup."); await rm(root, { recursive: true, force: true }); });
  return { root, store, artifacts, workspace, options, prepare, executor, get attachments() { return attachments; },
    recreate: () => { attachments = new HostedAgentSourceAttachments(options); }, retire: () => { current = false; } };
}
const body = (blob: BlobRef): PromptInput => ({ text: "Read the selected input.", files: [{ blob }], images: [], mentions: [], disposition: "prompt" });
const blobFor = (f: Awaited<ReturnType<typeof fixture>>, id: string) => f.store.getArtifact(id).blob;
async function read(executor: HostedAgentExecutor, path: string, id: string) {
  await executor.execute({ format: 1, callId: id, requestId: `${id}:1`, operation: "tool.begin", payload: { name: "read", input: { path } } });
  return executor.execute({ format: 1, callId: id, requestId: `${id}:2`, operation: "fs.read", payload: { path } });
}

it("uses exact private input copies, protects them even in Full Access, and restores accepted bytes without exposing the Blob store", async () => {
  const f = await fixture(), uploaded = await f.artifacts.ingestBytes(Buffer.from("SELECTED_INPUT_BYTES"), { fileName: "selected.txt", mimeType: "text/plain" });
  const other = await f.artifacts.ingestBytes(Buffer.from("OTHER_PRIVATE_BYTES"), { fileName: "other.txt", mimeType: "text/plain" });
  const { context, prepared } = await f.prepare(body(blobFor(f, uploaded.id))), path = /\nPath: ([^\r\n]+)/u.exec(prepared.input.text)![1]!;
  expect(prepared.input.files).toEqual([]); expect(prepared.input.text).not.toContain(uploaded.storagePath);
  const executor = f.executor(context), result = await read(executor, path, "first"); expect(Buffer.from(String(result.data), "base64").toString()).toBe("SELECTED_INPUT_BYTES");
  await expect(executor.execute({ format: 1, callId: "write", requestId: "write:1", operation: "tool.begin", payload: { name: "write", input: { path, content: "bad" } } })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  const parent = path.slice(0, path.lastIndexOf("/"));
  await expect(read(executor, `${parent}/unknown.txt`, "unknown")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect(f.attachments.authority(context, "/native/workspace").files.some(file => file.path === other.storagePath)).toBe(false);
  await prepared.commit!({ inputFingerprint: "a".repeat(64), nativeHistory: { events: [], activeLineage: [] } });
  f.store.updateSession("task", { binding: { ...context.binding!, generation: 2 } }); f.recreate();
  const restored = { ...context, generation: 2, binding: f.store.getSession("task").descriptor.binding, operationId: "resume", inputQueueItemId: undefined, signal: new AbortController().signal };
  await f.attachments.capture(restored); const second = f.executor(restored, "/another/native/workspace"), next = path.replace("/native/workspace", "/another/native/workspace");
  const continuation = await prepareSourceWorkspaceInput({ text: "Continue", images: [], files: [], mentions: [], disposition: "prompt" }, restored,
    { shadow: "/another/native/workspace", workspaceId: "project", resources: new HostedAgentSourceResources(), assertCurrent: () => f.options.assertContext(restored), attachments: f.attachments.begin(restored, "/another/native/workspace") });
  expect(continuation.input.text).toContain(next); expect(continuation.commit).toBeUndefined();
  expect(Buffer.from(String((await read(second, next, "restored")).data), "base64").toString()).toBe("SELECTED_INPUT_BYTES");
  await f.attachments.forget("task"); expect(await readFile(uploaded.storagePath, "utf8")).toBe("SELECTED_INPUT_BYTES");
});

it("keeps cross-task Artifact authority through dispatch and then retains only the already accepted input incarnation", async () => {
  const f = await fixture(), artifact = await f.artifacts.ingestBytes(Buffer.from("ORIGINAL_ARTIFACT_BYTES"), { fileName: "report.txt", mimeType: "text/plain", expiresAt: Date.now() + 60_000 });
  f.store.transaction(() => f.store.adoptSessionArtifact({ blob: blobFor(f, artifact.id), sessionId: "origin" }));
  const snapshot = f.store.captureArtifactReferenceSnapshot("task", "origin", artifact.id, 0);
  const input: PromptInput = { text: "Read the report.", images: [], files: [], disposition: "prompt",
    mentions: [{ kind: "artifact", reference: artifact.id, sourceSessionId: "origin", label: "Report" }], artifactReferenceSnapshots: [snapshot] };
  const { context, prepared } = await f.prepare(input), path = /\nPath: ([^\r\n]+)/u.exec(prepared.input.text)![1]!;
  await prepared.commit!({ inputFingerprint: "b".repeat(64), nativeHistory: { events: [], activeLineage: [] } });
  f.store.deleteArtifact(artifact.id);
  const executor = f.executor(context); expect(Buffer.from(String((await read(executor, path, "accepted")).data), "base64").toString()).toBe("ORIGINAL_ARTIFACT_BYTES");
  f.retire(); await expect(read(executor, path, "revoked")).rejects.toMatchObject({ code: "STALE_AUTHORITY" });
});

it("does not publish a file receipt when the original Artifact is withdrawn before the dispatch fence", async () => {
  const f = await fixture(), artifact = await f.artifacts.ingestBytes(Buffer.from("WITHDRAWN_INPUT"), { fileName: "withdrawn.txt", mimeType: "text/plain" });
  const { prepared } = await f.prepare(body(blobFor(f, artifact.id))); f.store.deleteArtifact(artifact.id);
  expect(prepared.assertCurrent).toThrow();
  await expect(prepared.commit!({ inputFingerprint: "c".repeat(64), nativeHistory: { events: [], activeLineage: [] } })).rejects.toThrow();
  expect(f.store.listSettingsByKeyPrefix("service", "hosted-inputs.v1", "")).toEqual([]);
});

it("fails closed on mismatched bytes and never reopens a tampered accepted input as another file", async () => {
  const f = await fixture(), artifact = await f.artifacts.ingestBytes(Buffer.from("ORIGINAL_BYTES"), { fileName: "input.txt", mimeType: "text/plain" });
  const { context, prepared } = await f.prepare(body(blobFor(f, artifact.id))); await prepared.commit!({ inputFingerprint: "d".repeat(64), nativeHistory: { events: [], activeLineage: [] } });
  const copy = f.attachments.authority(context, "/native/workspace").files.find(file => !file.namespace)!; await writeFile(copy.path, "TAMPERED_BYTES");
  expect(copy.assertCurrent).toThrow(); f.recreate(); await f.attachments.capture(context);
  expect(f.attachments.authority(context, "/native/workspace").files).toHaveLength(1);
  expect(await readFile(artifact.storagePath, "utf8")).toBe("ORIGINAL_BYTES");
});

it("checks workspace attachment bytes against the selected Blob rather than reading a replacement project file", async () => {
  const f = await fixture(), artifact = await f.artifacts.ingestBytes(Buffer.from("ORIGINAL_BYTES"), { fileName: "input.txt", mimeType: "text/plain" });
  await writeFile(join(f.workspace, "input.txt"), "REPLACED_BYTES");
  await expect(f.prepare({ ...body(blobFor(f, artifact.id)), files: [{ blob: blobFor(f, artifact.id), workspacePath: "input.txt" }] })).rejects.toThrow(/integrity|verification/u);
  expect(f.store.listSettingsByKeyPrefix("service", "hosted-inputs.v1", "")).toEqual([]);
});

it("removes its partial file when original input capture is cancelled", async () => {
  const f = await fixture(), artifact = await f.artifacts.ingestBytes(Buffer.alloc(256 * 1024, 42), { fileName: "large.txt", mimeType: "text/plain" });
  const directory = join(f.root, "cancelled"), abort = new AbortController(); let checks = 0;
  await expect(snapshotSourceInputFile(artifact.storagePath, join(directory, "input.txt"), blobFor(f, artifact.id), abort.signal,
    () => { if (++checks === 6) abort.abort(); abort.signal.throwIfAborted(); })).rejects.toThrow();
  expect(await readdir(directory)).toEqual([]);
  expect((await readFile(artifact.storagePath)).byteLength).toBe(256 * 1024);
});
