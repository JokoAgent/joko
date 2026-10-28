import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationalStore } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { afterEach, expect, it, vi } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { SessionHost } from "./session-host.js";
import { ExtensionTasks, type ExtensionTaskOwner } from "./extension-tasks.js";
import { ExtensionTargets } from "./extension-targets.js";
import type { ExtensionCatalogDescriptor } from "./extension-catalog.js";
import type { PartnerProfileRecord } from "@joko/store";

const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-plugin-targets-"))), store = new OperationalStore(join(root, "store.db"));
  const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] });
  await artifacts.initialize();
  const adapter = new FakeBackendAdapter({ ...PI_LIKE_PROFILE, streamDelayMs: 1 }), host = new SessionHost(store, artifacts, [adapter]); await host.initialize();
  await host.registerTarget({ id: "project", backendId: adapter.id, displayName: "Project", workspaceRoot: root, trusted: true, managed: false });
  const model = PI_LIKE_PROFILE.models.find(model => model.supportsImages)!;
  const route = { backendId: adapter.id, providerId: model.providerId, modelId: model.modelId, effort: "", fastMode: false };
  const connection = store.createConnection({ id: "owner", name: "Owner", authKeyDigest: createHash("sha256").update("owner").digest("hex") });
  const taskId = (await host.createSession({ operationId: "existing-task", connection, targetId: "project", title: "Existing owner task", ...route,
    permissionMode: "ask", planMode: false })).value.sessionId;
  let granted = true, enabled = true, revision = 1n;
  const extensionId = "extension_0123456789abcdef0123456789abcdef";
  const descriptor = () => ({ id: extensionId, revision, installed: true, enabled, name: "Target delivery", owner: { kind: "resource", resourceId: "resource", resourceVersion: 1n, discoveredRevision: `sha256:${"a".repeat(64)}` },
    permissions: [{ id: "runtime-managed-tasks", required: true, granted: true }, { id: "runtime-targets", required: true, granted }],
    runtime: { tasks: {}, targets: true }, setup: { state: "not_required" } } as unknown as ExtensionCatalogDescriptor);
  const catalog = { get: () => descriptor() }, tasks = new ExtensionTasks({ store, host, artifacts, catalog, defaults: { current: () => route }, rootDirectory: join(root, "tasks"), redact: text => text });
  const owner: ExtensionTaskOwner = { extensionId, resourceId: "resource", installation: tasks.installation(extensionId, "resource"), signal: new AbortController().signal, assertCurrent: () => {} };
  const partners: PartnerProfileRecord[] = [];
  const options = { store, host, tasks, catalog, artifacts, partners: { listPartners: () => partners,
    getPartner: (id: string) => { const partner = partners.find(value => value.id === id); if (!partner) throw new Error("Missing partner"); return partner; } }, redact: (text: string) => text };
  const targets = new ExtensionTargets(options);
  host.setExtensionTaskQueueGuard(item => { if (!targets.assertQueueCurrent(item)) tasks.assertQueueCurrent(item); });
  cleanups.push(async () => { await targets.drain(); await host.dispose(); store.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const request = (value: Record<string, unknown>, targetService = targets) => targetService.request(owner, { type: "targets-request", ...value });
  const pause = () => store.setQueuePaused({ sessionId: taskId, paused: true, reason: "Wait for owner", traceId: "test" });
  return { root, store, artifacts, host, tasks, targets, taskId, route, owner, partners, options, request, pause,
    grant: (value: boolean) => { granted = value; revision++; }, disable: () => { enabled = false; revision++; } };
}

it("lists only eligible local metadata and requires independent host target approval", async () => {
  const f = await fixture();
  const task = f.store.getSession(f.taskId).descriptor;
  f.store.createSession({ ...task, id: "hidden", hidden: true, binding: { opaqueRef: "hidden", generation: 1 } });
  f.store.upsertTarget({ id: "untrusted", backendId: task.backendId, displayName: "Untrusted", workspaceRoot: f.root, managed: false, trusted: false });
  expect(await f.request({ kind: "list", targetKind: "task" })).toEqual({ targets: [{ kind: "task", id: f.taskId, label: "Existing owner task", detail: f.root }], nextCursor: null });
  expect(await f.request({ kind: "list", targetKind: "project" })).toEqual({ targets: [{ kind: "project", id: "project", label: "Project", detail: f.root }], nextCursor: null });
  await expect(f.request({ kind: "resolve", target: { kind: "task", id: "hidden" } })).rejects.toMatchObject({ code: "TARGET_UNAVAILABLE" });
  await expect(f.request({ kind: "readMessages", target: { kind: "task", id: f.taskId } })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  f.grant(false);
  await expect(f.request({ kind: "list", targetKind: "task" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
});

it("adopts plugin-supplied image bytes with the original Queue input and never duplicates a replay", async () => {
  const f = await fixture(); f.pause();
  const request = { kind: "send", requestKey: "one-image", target: { kind: "task", id: f.taskId }, text: "Inspect this image", attachments: [{ base64: pixel, name: "pixel.png" }], delivery: "steer" };
  const result = await f.request(request) as { taskId: string; runId: string; queueItemId: string; delivery: string };
  expect(result).toMatchObject({ taskId: f.taskId, delivery: "queue", accepted: true });
  const queue = f.store.getQueueItem(result.queueItemId);
  expect(queue.body.text).toContain("external application data"); expect(queue.body.images).toHaveLength(1);
  const artifact = f.store.getArtifact(queue.body.images[0]!.blob.id);
  expect(artifact).toMatchObject({ sessionId: f.taskId, runId: result.runId, blob: { mimeType: "image/png" } });
  expect((artifact.metadata as { expiresAt?: number }).expiresAt).toBeUndefined();
  expect(Buffer.from((await f.artifacts.readBlob(artifact.blob)).data).toString("base64")).toBe(pixel);
  expect(await f.request(request)).toEqual(result);
  expect(f.store.listQueueItems({ sessionId: f.taskId })).toHaveLength(1);
  await expect(f.request({ ...request, text: "Different content" })).rejects.toMatchObject({ code: "REQUEST_KEY_CONFLICT" });
  expect(JSON.stringify(f.store.listOperations(), (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)).not.toContain(pixel);
  expect(await f.request({ kind: "cancel", requestKey: request.requestKey })).toEqual({ cancelled: true, runningWorkMayHaveStarted: false });
  expect(f.store.getQueueItem(queue.id).state).toBe("cancelled");
  await expect(f.request(request)).rejects.toMatchObject({ code: "SUPERSEDED" });
});

it("creates one visible project task through normal plugin ownership and dispatches its input", async () => {
  const f = await fixture();
  const request = { kind: "send", requestKey: "new-project-task", target: { kind: "project", id: "project" }, title: "Plugin project task", text: "Summarize the selected project", route: f.route };
  const result = await f.request(request) as { taskId: string; runId: string };
  expect(result.taskId).not.toBe(f.taskId);
  expect(f.store.getSession(result.taskId).descriptor).toMatchObject({ targetId: "project", title: "Plugin project task" });
  expect(f.store.getSession(result.taskId).descriptor.hidden).not.toBe(true);
  expect(await f.tasks.request(f.owner, { kind: "get", taskId: result.taskId })).toMatchObject({ taskId: result.taskId });
  await vi.waitFor(() => expect(f.store.getRun(result.runId).descriptor.state).toBe("completed"));
  expect(await f.request(request)).toEqual(result);
  expect(f.store.listSessions()).toHaveLength(2);
});

it("blocks old queued input after approval is revoked and regranted", async () => {
  const f = await fixture(); f.pause();
  const result = await f.request({ kind: "send", requestKey: "old-grant", target: { kind: "task", id: f.taskId }, text: "Old delegated input" }) as { queueItemId: string };
  const queue = f.store.getQueueItem(result.queueItemId); expect(f.targets.assertQueueCurrent(queue)).toBe(true);
  const continued = f.host.enqueueServiceInput({ operationId: "target-native-retry", sessionId: f.taskId, source: "system", parentRunId: queue.runId, prompt: queue.body });
  const next = f.store.getQueueItem(continued.value.queueItemId); expect(f.targets.assertQueueCurrent(next)).toBe(true);
  f.grant(false); f.grant(true);
  expect(() => f.targets.assertQueueCurrent(queue)).toThrow("approval changed");
  expect(() => f.targets.assertQueueCurrent(next)).toThrow("approval changed");
  const recovered = new ExtensionTargets(f.options);
  expect(() => recovered.assertQueueCurrent(queue)).toThrow("approval changed");
});
it("resolves a partner's unique current canonical task without listing it as an ordinary task", async () => {
  const f = await fixture(); f.pause();
  f.partners.push({ id: "partner", canonicalSessionId: f.taskId, homeTargetId: "project", displayName: "Partner", description: "Local partner",
    lifecycle: "active", initializationState: "ready" } as PartnerProfileRecord);
  expect(await f.request({ kind: "list", targetKind: "task" })).toEqual({ targets: [], nextCursor: null });
  expect(await f.request({ kind: "resolve", target: { kind: "partner", id: "partner" } })).toEqual({ kind: "partner", id: "partner", label: "Partner", detail: "Local partner" });
  const result = await f.request({ kind: "send", requestKey: "partner-input", target: { kind: "partner", id: "partner" }, text: "One delegated message" }) as { queueItemId: string };
  expect(f.store.getQueueItem(result.queueItemId).sessionId).toBe(f.taskId);
  f.partners[0] = { ...f.partners[0]!, lifecycle: "paused" };
  expect(() => f.targets.assertQueueCurrent(f.store.getQueueItem(result.queueItemId))).toThrow("unavailable");
});

it("cancels during image staging without sending or stopping the target task", async () => {
  const f = await fixture(); let release!: () => void, staged = false;
  const delayed = new ExtensionTargets({ ...f.options, artifacts: { ingestBytes: async (...args) => {
    const artifact = await f.artifacts.ingestBytes(...args); staged = true; await new Promise<void>(resolve => { release = resolve; }); return artifact;
  } } });
  const pending = f.request({ kind: "send", requestKey: "cancel-staging", target: { kind: "task", id: f.taskId }, text: "Do not send", attachments: [{ base64: pixel }] }, delayed).then(() => null, error => error);
  await vi.waitFor(() => expect(staged).toBe(true));
  expect(await f.request({ kind: "cancel", requestKey: "cancel-staging" }, delayed)).toMatchObject({ cancelled: true });
  release(); expect(await pending).toMatchObject({ code: "SUPERSEDED" });
  expect(f.store.listQueueItems({ sessionId: f.taskId })).toHaveLength(0);
  expect(f.store.getSession(f.taskId).descriptor.archived).toBe(false);
});

it("keeps a lost project creation reply unknown across runtime restart", async () => {
  const f = await fixture(); let creates = 0;
  const delayedOptions = { ...f.options, tasks: { assertOwner: (owner: ExtensionTaskOwner) => f.tasks.assertOwner(owner),
    createForTarget: async (...args: Parameters<ExtensionTasks["createForTarget"]>) => { creates++; await f.tasks.createForTarget(...args); throw new Error("Reply lost"); } } };
  const first = new ExtensionTargets(delayedOptions), request = { kind: "send", requestKey: "unknown-project", target: { kind: "project", id: "project" }, text: "Start once", route: f.route };
  await expect(f.request(request, first)).rejects.toThrow("Reply lost");
  await expect(f.request(request, new ExtensionTargets(delayedOptions))).rejects.toMatchObject({ code: "DELIVERY_UNCERTAIN" });
  expect(creates).toBe(1); expect(f.store.listSessions()).toHaveLength(2);
  expect(f.store.listQueueItems({ sessionId: f.taskId })).toHaveLength(0);
});
