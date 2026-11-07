import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ServerInfoSchema } from "@joko/contracts";
import type { AdapterContext } from "@joko/core";
import { OperationalStore } from "@joko/store";
import { DEFAULT_COLLABORATION_SETTINGS } from "@joko/runtime-governance";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { afterEach, expect, it, vi } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { SessionHost } from "./session-host.js";
import { SnapshotProjector } from "./snapshot-projector.js";
import { CollaborationGoalManager } from "./collaboration-goal-manager.js";
import { ExtensionTasks, type ExtensionTaskOwner } from "./extension-tasks.js";
import { resourceExtensionIds, type ExtensionCatalogDescriptor } from "./extension-catalog.js";
import { PiResourceManager } from "./resource-manager.js";
import { ExtensionProjectPolicies, extensionProjectForTarget } from "./extension-project-policy.js";
import { projectNativeHistory } from "./native-history.js";
import { SessionHelperToolBridgeProvider } from "./session-helper-tool-provider.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(options: { readonly edits?: boolean; readonly review?: ConstructorParameters<typeof ExtensionTasks>[0]["reviewNativeTool"] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "joko-plugin-tasks-")), store = new OperationalStore(join(root, "store.db"));
  const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] });
  await artifacts.initialize();
  const permissionModes = options.edits ? [...PI_LIKE_PROFILE.permissionModes, "acceptEdits" as const] : PI_LIKE_PROFILE.permissionModes;
  const adapter = new FakeBackendAdapter({ ...PI_LIKE_PROFILE, permissionModes, capabilities: PI_LIKE_PROFILE.capabilities.map(capability => capability.key === "permission.modes"
    ? { ...capability, options: [...permissionModes] } : capability).concat({ key: "permission.change", supported: true }) });
  const host = new SessionHost(store, artifacts, [adapter]); await host.initialize();
  await host.registerTarget({ id: "workspace", backendId: adapter.id, displayName: "Approved directory", workspaceRoot: root, trusted: true, managed: true });
  let enabled = true, installed = true, installation = "installation-one", hiddenAllowed = true;
  const extensionId = "extension_0123456789abcdef0123456789abcdef";
  const descriptor = () => ({ id: extensionId, installed, enabled, name: "Task workflow", owner: { kind: "resource", resourceId: "resource" },
    permissions: [], runtime: { tasks: hiddenAllowed ? { hidden: true } : {}, text: { oneshot: true } }, setup: { state: "not_required" } } as unknown as ExtensionCatalogDescriptor);
  const model = PI_LIKE_PROFILE.models[0]!, route = { backendId: adapter.id, providerId: model.providerId, modelId: model.modelId, fastMode: false };
  const teams = new CollaborationGoalManager({ store, sessionHost: host, readSettings: () => DEFAULT_COLLABORATION_SETTINGS,
    assertWorkerAdmission: lead => tasks.assertTeamWorkerCurrent(lead) });
  const projects = new ExtensionProjectPolicies(store);
  const tasks = new ExtensionTasks({ store, host, artifacts, catalog: { get: () => descriptor() }, projects, defaults: { current: () => ({ ...route, effort: "" }) }, rootDirectory: join(root, "tasks"), redact: value => value, teams, reviewNativeTool: options.review });
  await teams.initialize();
  installation = tasks.installation(extensionId, "resource");
  host.setExtensionTaskQueueGuard(item => tasks.assertQueueCurrent(item));
  const owner: ExtensionTaskOwner = { extensionId, resourceId: "resource", installation, signal: new AbortController().signal,
    assertCurrent: () => { if (!enabled || !installed || installation !== owner.installation) throw new Error("Retired source"); } };
  cleanups.push(async () => { await teams.close(); await host.dispose(); store.close(); await rm(root, { recursive: true, force: true }); });
  const request = (value: Record<string, unknown>) => tasks.request(owner, { type: "tasks-request", ...value });
  return { root, store, host, adapter, artifacts, teams, tasks, owner, extensionId, route, request, projects, descriptor, disable: () => { enabled = false; }, uninstall: () => { installed = false; }, reinstall: () => { installed = true; enabled = true; installation = tasks.installation(extensionId, "resource"); }, removeHidden: () => { hiddenAllowed = false; } };
}
it("adopts bounded plugin images through its own task Queue and preserves input-key replay", async () => {
  const f = await fixture(), model = PI_LIKE_PROFILE.models.find(model => model.supportsImages)!;
  f.tasks.updatePreferences(f.extensionId, 0n, { model: { ...f.route, providerId: model.providerId, modelId: model.modelId }, permissionMode: "ask" }, () => {});
  const task = await f.request({ kind: "create", requestKey: "image-task", title: "Plugin images" }) as { taskId: string; revision: string };
  f.store.setQueuePaused({ sessionId: task.taskId, paused: true, reason: "Owner wait", traceId: "test" });
  const fresh = await f.request({ kind: "get", taskId: task.taskId }) as { revision: string };
  const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=";
  const input = { kind: "send", taskId: task.taskId, expectedRevision: fresh.revision, requestKey: "image-input", text: "Inspect the supplied image", attachments: [{ base64: pixel }] };
  const result = await f.request(input) as { runId: string };
  const queue = f.store.findQueueItemByRunId(task.taskId, result.runId)!;
  expect(queue.body.images).toHaveLength(1);
  expect(f.store.getArtifact(queue.body.images[0]!.blob.id)).toMatchObject({ sessionId: task.taskId, runId: result.runId });
  expect(await f.request(input)).toMatchObject({ runId: result.runId });
  await expect(f.request({ ...input, attachments: [{ base64: pixel, name: "different.png" }] })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});
it("checks project exceptions for new plugin tasks and subsequent access to an existing task", async () => {
  const f = await fixture();
  f.tasks.updatePreferences(f.extensionId, 0n, { model: f.route, targetId: "workspace", permissionMode: "ask" }, () => {});
  const task = await f.request({ kind: "create", requestKey: "before-disable", title: "Existing task" }) as { taskId: string };
  const project = extensionProjectForTarget(f.store.getTarget("workspace").descriptor);
  f.projects.setEnabled(project.id, "connection", f.descriptor(), false, 0n);
  const count = f.store.listSessions().length;
  await expect(f.request({ kind: "get", taskId: task.taskId })).rejects.toThrow("disabled");
  await expect(f.request({ kind: "create", requestKey: "after-disable", title: "Denied task" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  expect(f.store.listSessions()).toHaveLength(count);
  f.projects.setEnabled(project.id, "connection", f.descriptor(), true, f.projects.state(project.id, "connection").revision);
  expect(await f.request({ kind: "get", taskId: task.taskId })).toMatchObject({ taskId: task.taskId });
});
it("creates an isolated plugin task in a fresh managed directory without a Git project", async () => {
  const f = await fixture();
  const createNative = vi.spyOn(f.adapter, "createSession");
  const request = { kind: "create", requestKey: "isolated-first", title: "Isolated task", isolatedWorkspace: true };
  const first = await f.request(request) as { taskId: string };
  const firstSession = f.store.getSession(first.taskId).descriptor;
  const firstTarget = f.store.getTarget(firstSession.targetId).descriptor;
  expect(firstTarget.managed).toBe(true);
  expect(firstSession.worktree).toBeUndefined();
  const managedRoot = await realpath(join(f.root, "tasks"));
  expect(firstTarget.workspaceRoot).toBe(join(managedRoot, firstTarget.id.slice("extension-target-".length)));
  expect(await readdir(firstTarget.workspaceRoot)).toEqual([]);
  await writeFile(join(firstTarget.workspaceRoot, "first-task.txt"), "Only the first task");

  const second = await f.request({ ...request, requestKey: "isolated-second" }) as { taskId: string };
  const secondSession = f.store.getSession(second.taskId).descriptor;
  const secondTarget = f.store.getTarget(secondSession.targetId).descriptor;
  expect(secondSession.worktree).toBeUndefined();
  expect(secondTarget.workspaceRoot).not.toBe(firstTarget.workspaceRoot);
  expect(await readdir(secondTarget.workspaceRoot)).toEqual([]);
  expect(await f.request(request)).toMatchObject({ taskId: first.taskId });
  expect(createNative.mock.calls.map(([input, context]) => [input.target.workspaceRoot, context.target.workspaceRoot]))
    .toEqual([[firstTarget.workspaceRoot, firstTarget.workspaceRoot], [secondTarget.workspaceRoot, secondTarget.workspaceRoot]]);
});
it("adopts hidden ordinary Sessions atomically, dispatches one durable Run, and replays original input keys", async () => {
  const f = await fixture();
  const observed: boolean[] = [];
  f.store.subscribe(event => { if (event.payload.type === "session_changed" && event.sessionId) observed.push(f.store.getSession(event.sessionId).descriptor.hidden === true); });
  const input = { kind: "create", requestKey: "create-one", title: "Grade a document", hidden: true };
  const task = await f.request(input) as { taskId: string; revision: string; hidden: boolean };
  expect(task.hidden).toBe(true); expect(observed.every(Boolean)).toBe(true);
  expect(f.store.listSessions({ excludeHidden: true })).toHaveLength(0);
  const projector = new SnapshotProjector(f.store, { server: create(ServerInfoSchema, { serverId: "node" }) });
  expect(projector.projectOwnerSnapshot().sessions).toHaveLength(0);
  expect(projector.projectSessionSnapshot({ sessionId: task.taskId }).sessions[0]?.hidden).toBe(true);
  expect(await f.request({ ...input })).toMatchObject({ taskId: task.taskId });
  await expect(f.request({ ...input, hidden: false })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  const send = { kind: "send", taskId: task.taskId, expectedRevision: task.revision, requestKey: "send-one", text: "Return a short assessment." };
  const run = await f.request(send) as { runId: string };
  await vi.waitFor(() => expect(f.store.getRun(run.runId).descriptor.state).toBe("completed"));
  expect(await f.request(send)).toMatchObject({ runId: run.runId });
  expect(f.store.listRuns({ sessionId: task.taskId })).toHaveLength(1);
  expect(f.store.listQueueItems({ sessionId: task.taskId })).toHaveLength(1);
  expect(await f.request({ kind: "listRuns", taskId: task.taskId })).toMatchObject({ items: [{ runId: run.runId }], nextCursor: null });
  expect(f.store.searchSessionMessages({ query: "assessment", scope: { owner: true } }).matches).toHaveLength(0);
  expect(f.tasks.backgroundTasks(f.extensionId)).toHaveLength(1);
  const messages = await f.request({ kind: "readMessages", taskId: task.taskId }) as { items: unknown[] };
  expect(messages.items.length).toBeGreaterThan(0);
  f.tasks.reveal(f.extensionId, task.taskId, () => {});
  expect(f.store.searchSessionMessages({ query: "assessment", scope: { owner: true } }).matches.length).toBeGreaterThan(0);
});
it("reads only the current native branch of a plugin-owned task", async () => {
  const f = await fixture();
  const { taskId } = await f.request({ kind: "create", requestKey: "native-branch", title: "Branch history" }) as { taskId: string };
  const { backendId, targetId, binding } = f.store.getSession(taskId).descriptor;
  const scope = { backendId, targetId, sessionId: taskId, generation: binding.generation, traceId: "native-branch" };
  const nativeMessage = (nativeEntryId: string, nativeParentEntryId: string | undefined, role: "assistant" | "user", text: string) => ({
    nativeEntryId, ...(nativeParentEntryId === undefined ? {} : { nativeParentEntryId }), projectionKind: "message", contentIndex: 0,
    payload: { type: "message_complete" as const, role, blocks: [{ kind: "text" as const, text }] }
  });
  const projected = projectNativeHistory(taskId, binding.opaqueRef, { activeEntryId: "reply", events: [
    nativeMessage("kept", undefined, "assistant", "Kept answer"),
    nativeMessage("prompt", "kept", "user", "Rewound prompt"),
    nativeMessage("reply", "prompt", "assistant", "Rewound answer")
  ] });
  for (const event of projected) f.store.appendEvent({ ...scope, ...event });
  const nativeLeaf = (leafId: string) => f.store.appendEvent({ ...scope, id: `leaf-${leafId}`,
    payload: { type: "native_session_changed", opaqueRef: binding.opaqueRef, leafId } });
  nativeLeaf("reply");
  f.store.appendEvent({ ...scope, id: "product-message", payload: { type: "message_complete", role: "assistant",
    blocks: [{ kind: "text", text: "Product-owned message" }] } });
  const read = async (after?: string) => await f.request({ kind: "readMessages", taskId, limit: 100, ...(after === undefined ? {} : { after }) }) as {
    items: { id: string; cursor: string }[]; nextCursor: string | null;
  };
  const before = await read();
  expect(before.items.map(item => item.id)).toEqual([...projected.map(event => event.id), "product-message"]);

  nativeLeaf("kept");
  const after = await read();
  expect(after.items.map(item => item.id)).toEqual([projected[0]!.id, "product-message"]);
  expect(await read(before.items[0]!.cursor)).toEqual({ items: [after.items[1]], nextCursor: null });
  expect(f.store.listEvents({ sessionId: taskId }).some(event => event.id === projected[2]!.id)).toBe(true);
});
it("keeps the original plugin run ID attached to its durably admitted Provider Group continuation", async () => {
  const f = await fixture();
  const task = await f.request({ kind: "create", requestKey: "group-task", title: "Group task" }) as { taskId: string; revision: string };
  const { taskId } = task;
  f.adapter.injectFault(taskId, "crash");
  const input = { kind: "send", taskId, expectedRevision: task.revision, requestKey: "group-input", text: "Run once across a handoff" };
  const original = await f.request(input) as { runId: string; acceptedAt: number };
  const receipt = { runId: original.runId, acceptedAt: original.acceptedAt };
  await vi.waitFor(() => expect(f.store.getRun(original.runId).descriptor.state).toBe("failed"));
  f.adapter.clearFault(taskId);
  expect(await f.request({ kind: "getRun", runId: original.runId })).toMatchObject({ status: "failed" });

  const send = vi.spyOn(f.adapter, "send").mockResolvedValue(undefined);
  const abortRun = vi.spyOn(f.host, "abort");
  const abort = vi.spyOn(f.adapter, "abort");
  const stable = (prefix: string, value: string) => `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
  const resume = f.host.enqueueServiceInput({ operationId: stable("provider-group-continue", `${taskId}:${original.runId}`),
    sessionId: taskId, source: "system", parentRunId: original.runId,
    prompt: { text: "Continue the original task", images: [], files: [], mentions: [], disposition: "prompt",
      automaticContinuation: { recoveryId: stable("provider-group-recovery", original.runId), sourceRunId: original.runId,
        attempt: 1, maximumAttempts: 5, sessionTotal: 1 } } });
  await vi.waitFor(() => expect(f.store.getQueueItem(resume.value.queueItemId).state).toBe("backend_accepted"));
  f.store.setQueuePaused({ sessionId: taskId, paused: true, reason: "Keep the independent input queued", traceId: "test" });
  const unrelated = f.host.enqueueServiceInput({ operationId: "unrelated-service-input", sessionId: taskId, source: "system",
    prompt: { text: "Another input", images: [], files: [], mentions: [], disposition: "prompt" } });

  expect(await f.request({ kind: "getRun", runId: original.runId })).toMatchObject({ ...receipt, status: "running", queueState: "backend_accepted" });
  expect(await f.request(input)).toMatchObject({ ...receipt, status: "running" });
  const generation = f.store.getSession(taskId).descriptor.binding.generation;
  await f.request({ kind: "cancel", runId: original.runId });
  expect(abortRun).toHaveBeenCalledExactlyOnceWith(taskId, resume.value.runId, expect.any(Function));
  expect(abort).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    sessionId: taskId, generation, assertRunControlCurrent: expect.any(Function)
  }));
  expect(send).toHaveBeenCalledOnce();
  expect(f.store.getRun(original.runId).descriptor.state).toBe("failed");
  await vi.waitFor(() => expect(f.store.getRun(resume.value.runId).descriptor.state).toBe("aborted"));
  expect(f.store.getQueueItem(unrelated.value.queueItemId).state).toBe("accepted");
  expect(await f.request({ kind: "cancel", runId: original.runId })).toMatchObject({ ...receipt, status: "aborted" });
  expect(abort).toHaveBeenCalledOnce();
});
it("approves explicit Auto through the original host interaction and refuses a changed configuration", async () => {
  const f = await fixture(), task = await f.request({ kind: "create", requestKey: "write", title: "Approved actions", hidden: true }) as { taskId: string };
  await expect(f.request({ kind: "requestWriteAccess", taskId: task.taskId })).rejects.toMatchObject({ code: "UNSUPPORTED_PERMISSION_MODE" });
  const result = f.request({ kind: "requestWriteAccess", taskId: task.taskId, mode: "auto" });
  await vi.waitFor(() => expect(f.store.listInteractions({ sessionId: task.taskId, status: "open" })).toHaveLength(1));
  const interaction = f.store.listInteractions({ sessionId: task.taskId, status: "open" })[0]!;
  const owner = new SnapshotProjector(f.store, { server: create(ServerInfoSchema, { serverId: "node" }) }).projectOwnerSnapshot();
  expect(owner.sessions).toHaveLength(0); expect(owner.interactions.some(value => value.interactionId === interaction.id)).toBe(true);
  f.host.resolveInteraction(interaction.id, interaction.generation, { kind: "permission", decision: "allow_once" }, "approve-plugin-write");
  await expect(result).resolves.toMatchObject({ granted: true });
  expect(f.store.getSession(task.taskId).descriptor.permissionMode).toBe("auto");
  expect(f.tasks.preferences(f.extensionId).config.permissionMode).toBe("auto");

  const other = await f.request({ kind: "create", requestKey: "changed", title: "Changed" }) as { taskId: string };
  f.store.updateSession(other.taskId, { permissionMode: "ask" });
  const changed = f.request({ kind: "requestWriteAccess", taskId: other.taskId, mode: "auto" });
  await vi.waitFor(() => expect(f.store.listInteractions({ sessionId: other.taskId, status: "open" })).toHaveLength(1));
  const pending = f.store.listInteractions({ sessionId: other.taskId, status: "open" })[0]!;
  f.store.updateSession(other.taskId, { planMode: true });
  f.host.resolveInteraction(pending.id, pending.generation, { kind: "permission", decision: "allow_once" }, "approve-stale-plugin-write");
  await expect(changed).resolves.toMatchObject({ granted: false });
  expect(f.store.getSession(other.taskId).descriptor.permissionMode).toBe("ask");
  f.store.updateSession(other.taskId, { planMode: false });
  await expect(f.request({ kind: "requestWriteAccess", taskId: other.taskId, mode: "auto" })).resolves.toMatchObject({ granted: false });
  expect(f.store.listInteractions({ sessionId: other.taskId, status: "open" })).toHaveLength(0);
});
it("restores the durable permission on the native task when plugin preferences tighten after the setter", async () => {
  const f = await fixture();
  const task = await f.request({ kind: "create", requestKey: "stale-native-write", title: "Original Ask task" }) as { taskId: string };
  const before = f.store.getSession(task.taskId).descriptor;
  const preferences = f.tasks.updatePreferences(f.extensionId, 0n, { model: f.route, permissionMode: "auto" }, () => undefined);
  const inspect = f.adapter.inspectSession.bind(f.adapter);
  let nativeChanged!: () => void, release!: () => void;
  const observed = new Promise<void>(resolve => { nativeChanged = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(f.adapter, "inspectSession").mockImplementation(async (...input) => {
    const state = await inspect(...input);
    if (state.permissionMode === "auto") { nativeChanged(); await pending; }
    return state;
  });
  const setters = vi.spyOn(f.adapter, "setPermissionMode");
  const request = f.request({ kind: "requestWriteAccess", taskId: task.taskId, mode: "auto" });
  const rejected = expect(request).rejects.toMatchObject({ code: "STALE_REVISION" });
  try {
    await vi.waitFor(() => expect(f.store.listInteractions({ sessionId: task.taskId, status: "open" })).toHaveLength(1));
    const approval = f.store.listInteractions({ sessionId: task.taskId, status: "open" })[0]!;
    f.host.resolveInteraction(approval.id, approval.generation, { kind: "permission", decision: "allow_once" }, "approve-before-preference-tightens");
    await observed;
    expect(f.store.getSession(task.taskId).descriptor.permissionMode).toBe("ask");
    f.tasks.updatePreferences(f.extensionId, preferences.revision, { model: f.route, permissionMode: "ask" }, () => undefined);
  } finally { release(); }
  await rejected;
  expect(setters.mock.calls.map(([mode]) => mode)).toEqual(["auto", "ask"]);
  await expect(f.host.inspect(task.taskId)).resolves.toMatchObject({ permissionMode: "ask", binding: before.binding });
  expect(f.store.getSession(task.taskId).descriptor.permissionMode).toBe("ask");
});
it("retires an unconfirmed permission runtime before dispatching the original queued input", async () => {
  const f = await fixture();
  const task = await f.request({ kind: "create", requestKey: "unconfirmed-native-write", title: "Original Ask task" }) as { taskId: string };
  const before = f.store.getSession(task.taskId).descriptor;
  const preferences = f.tasks.updatePreferences(f.extensionId, 0n, { model: f.route, permissionMode: "auto" }, () => undefined);
  const inspect = f.adapter.inspectSession.bind(f.adapter), setMode = f.adapter.setPermissionMode.bind(f.adapter);
  const applying = vi.fn(), restoring = vi.fn();
  let releaseApply!: () => void, releaseRestore!: () => void;
  const applyHold = new Promise<void>(resolve => { releaseApply = resolve; });
  const restoreHold = new Promise<void>(resolve => { releaseRestore = resolve; });
  vi.spyOn(f.adapter, "inspectSession").mockImplementation(async (...args) => {
    const state = await inspect(...args);
    if (state.permissionMode === "auto" && state.binding.generation === before.binding.generation) {
      applying(); await applyHold;
    }
    return state;
  });
  vi.spyOn(f.adapter, "setPermissionMode").mockImplementation(async (mode, context) => {
    if (mode === "ask" && context.generation === before.binding.generation) {
      restoring(); await restoreHold; throw new Error("Could not restore the original policy.");
    }
    return setMode(mode, context);
  });
  const close = vi.spyOn(f.adapter, "closeSession");
  const send = f.adapter.send.bind(f.adapter);
  let modeAtDispatch: string | undefined;
  let closedBeforeDispatch = false;
  const sends = vi.spyOn(f.adapter, "send").mockImplementation(async (input, context) => {
    closedBeforeDispatch = close.mock.calls.length === 1;
    modeAtDispatch = (await inspect(context.binding!, context)).permissionMode;
    await send(input, context);
  });
  const connection = f.store.createConnection({ id: "approval-owner", name: "Owner", authKeyDigest: "approval-owner-digest" });
  const request = f.request({ kind: "requestWriteAccess", taskId: task.taskId, mode: "auto" });
  const rejected = expect(request).rejects.toMatchObject({ code: "STALE_REVISION" });
  let queueItemId: string;
  try {
    await vi.waitFor(() => expect(f.store.listInteractions({ sessionId: task.taskId, status: "open" })).toHaveLength(1));
    const approval = f.store.listInteractions({ sessionId: task.taskId, status: "open" })[0]!;
    f.host.resolveInteraction(approval.id, approval.generation, { kind: "permission", decision: "allow_once" }, "approve-before-restore-failure");
    await vi.waitFor(() => expect(applying).toHaveBeenCalled());
    f.tasks.updatePreferences(f.extensionId, preferences.revision, { model: f.route, permissionMode: "ask" }, () => undefined);
    releaseApply();
    await vi.waitFor(() => expect(restoring).toHaveBeenCalledOnce());
    queueItemId = f.host.enqueueInput({ operationId: "queue-during-policy-recovery", sessionId: task.taskId, connection,
      prompt: { text: "Continue the original task", images: [], files: [], mentions: [], disposition: "prompt" } }).value.queueItemId;
    expect(f.store.getQueueItem(queueItemId).state).toBe("accepted");
    expect(sends).not.toHaveBeenCalled();
  } finally { releaseApply(); releaseRestore(); }
  await rejected;
  await vi.waitFor(() => {
    const item = f.store.getQueueItem(queueItemId);
    expect(item.state, f.store.getRun(item.runId).descriptor.error?.message).toBe("completed");
  });
  expect(sends).toHaveBeenCalledOnce();
  const [, dispatched] = sends.mock.calls[0]!;
  expect(dispatched.generation).toBeGreaterThan(before.binding.generation);
  expect(dispatched.binding?.opaqueRef).toBe(before.binding.opaqueRef);
  expect(closedBeforeDispatch).toBe(true);
  expect(close).toHaveBeenCalledExactlyOnceWith(before.binding, expect.objectContaining({ sessionId: task.taskId, generation: before.binding.generation }));
  expect(modeAtDispatch).toBe("ask");
  expect(f.store.getSession(task.taskId).descriptor.permissionMode).toBe("ask");
});
it("supports an unplanned team within its approved task root and refuses an unrelated trusted target", async () => {
  const f = await fixture(); f.tasks.updatePreferences(f.extensionId, 0n, { model: f.route, permissionMode: "auto" }, () => {});
  const task = await f.request({ kind: "create", requestKey: "unplanned", title: "Team without registered plan" }) as { taskId: string };
  const team = await f.request({ kind: "startTeam", taskId: task.taskId }) as ReturnType<CollaborationGoalManager["getTree"]>;
  const input = { operationId: "outside-worker", goalId: team.goal.id, callerLeadSessionId: task.taskId, expectedGoalRevision: team.goal.revision,
    label: "Reader", role: "Read", assignment: "Read the task directory.", route: { ...f.route, targetId: "workspace", permissionMode: "auto" as const, planMode: false } };
  await expect(f.teams.createWorker(input)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  const target = f.store.getSession(task.taskId).descriptor.targetId;
  const result = await f.teams.createWorker({ ...input, operationId: "inside-worker", route: { ...input.route, targetId: target } });
  expect(result.worker.sessionId).toBeDefined();
  await vi.waitFor(() => expect(f.store.listRuns({ sessionId: result.worker.sessionId! })[0]?.descriptor.state).toBe("completed"));
});
it("requests file edits by default only for an unstarted supported task, and lets the host explicitly retry one refusal", async () => {
  const f = await fixture({ edits: true }), task = await f.request({ kind: "create", requestKey: "edit-task", title: "Write a draft" }) as { taskId: string };
  const pending = f.request({ kind: "requestWriteAccess", taskId: task.taskId });
  await vi.waitFor(() => expect(f.store.listInteractions({ sessionId: task.taskId, status: "open" })).toHaveLength(1));
  const interaction = f.store.listInteractions({ sessionId: task.taskId, status: "open" })[0]!;
  expect(interaction.payload.kind === "permission" && interaction.payload.title).toContain("file edits");
  f.host.resolveInteraction(interaction.id, interaction.generation, { kind: "permission", decision: "deny_once" }, "deny-edits");
  await expect(pending).resolves.toMatchObject({ granted: false });
  await expect(f.request({ kind: "requestWriteAccess", taskId: task.taskId, mode: "auto" })).resolves.toMatchObject({ granted: false });
  expect(f.tasks.preferences(f.extensionId).writeRequests).toEqual([{ taskId: task.taskId, title: "Write a draft", mode: "acceptEdits" }]);
  const retry = f.tasks.retryWriteAccess(f.extensionId, task.taskId, new AbortController().signal, () => {});
  await vi.waitFor(() => expect(f.store.listInteractions({ sessionId: task.taskId, status: "open" })).toHaveLength(1));
  const retried = f.store.listInteractions({ sessionId: task.taskId, status: "open" })[0]!;
  f.host.resolveInteraction(retried.id, retried.generation, { kind: "permission", decision: "allow_once" }, "retry-edits");
  await expect(retry).resolves.toMatchObject({ granted: true });
  expect(f.store.getSession(task.taskId).descriptor.permissionMode).toBe("acceptEdits");
  expect(f.tasks.preferences(f.extensionId).config.permissionMode).toBe("acceptEdits");
  expect(f.tasks.preferences(f.extensionId).writeRequests).toEqual([]);
  const second = await f.request({ kind: "create", requestKey: "started-edit-task", title: "Started draft" }) as { taskId: string; revision: string };
  const input = await f.request({ kind: "send", taskId: second.taskId, expectedRevision: second.revision, requestKey: "started-edit-input", text: "Read first" }) as { runId: string };
  await vi.waitFor(() => expect(f.store.getRun(input.runId).descriptor.state).toBe("completed"));
  f.store.updateSession(second.taskId, { permissionMode: "ask" });
  await expect(f.request({ kind: "requestWriteAccess", taskId: second.taskId })).rejects.toMatchObject({ code: "TASK_BUSY" });
});
it("does not consume a task's automatic permission attempt while another host request is pending", async () => {
  const f = await fixture(), first = await f.request({ kind: "create", requestKey: "gate-first", title: "First" }) as { taskId: string }, second = await f.request({ kind: "create", requestKey: "gate-second", title: "Second" }) as { taskId: string };
  const request = f.request({ kind: "requestWriteAccess", taskId: first.taskId, mode: "auto" });
  await vi.waitFor(() => expect(f.store.listInteractions({ sessionId: first.taskId, status: "open" })).toHaveLength(1));
  await expect(f.request({ kind: "requestWriteAccess", taskId: second.taskId, mode: "auto" })).rejects.toMatchObject({ code: "TASK_BUSY" });
  const firstPrompt = f.store.listInteractions({ sessionId: first.taskId, status: "open" })[0]!;
  f.host.resolveInteraction(firstPrompt.id, firstPrompt.generation, { kind: "permission", decision: "deny_once" }, "deny-first"); await request;
  const next = f.request({ kind: "requestWriteAccess", taskId: second.taskId, mode: "auto" });
  await vi.waitFor(() => expect(f.store.listInteractions({ sessionId: second.taskId, status: "open" })).toHaveLength(1));
  const secondPrompt = f.store.listInteractions({ sessionId: second.taskId, status: "open" })[0]!;
  f.host.resolveInteraction(secondPrompt.id, secondPrompt.generation, { kind: "permission", decision: "deny_once" }, "deny-second"); await next;
});
it("reviews safe native reads against the registered task and revalidates approval during a pending review", async () => {
  let release!: () => void, scope: unknown;
  const reviewer = vi.fn(async (value: unknown) => { scope = value; await new Promise<void>(resolve => { release = resolve; }); return { verdict: "allow" as const }; });
  const f = await fixture({ review: reviewer }); f.tasks.updatePreferences(f.extensionId, 0n, { model: f.route, targetId: "workspace", permissionMode: "auto" }, () => {});
  const task = await f.request({ kind: "create", requestKey: "native-read", title: "Review project" }) as { taskId: string };
  await f.request({ kind: "setTeamPlan", taskId: task.taskId, plan: { concurrency: 1, task: "Review only README", items: [{ label: "Reader", workingDir: f.root, route: f.route, task: "Read README" }] } });
  const authority = f.tasks.nativeToolAuthorization(task.taskId)!, revision = authority.capture();
  const result = authority.review({ toolName: "Read", input: { file_path: join(f.root, "README.md") }, signal: new AbortController().signal });
  await vi.waitFor(() => expect(reviewer).toHaveBeenCalledOnce());
  expect(scope).toMatchObject({ role: "coordinator", task: "Review only README", userInstructions: [], route: f.route });
  f.tasks.updatePreferences(f.extensionId, f.tasks.preferences(f.extensionId).revision, { model: f.route, targetId: "workspace", permissionMode: "ask" }, () => {});
  release(); await expect(result).resolves.toMatchObject({ verdict: "block" });
  expect(() => authority.assertCurrent(revision)).toThrow();
});
it("creates real hidden team workers only in the approved immutable plan and reveals them on uninstall", async () => {
  const f = await fixture();
  f.tasks.updatePreferences(f.extensionId, 0n, { model: f.route, targetId: "workspace", permissionMode: "auto" }, () => {});
  const task = await f.request({ kind: "create", requestKey: "team", title: "Task team", hidden: true }) as { taskId: string };
  const plan = { concurrency: 1, task: "Review the approved project", items: [{ label: "Reviewer", workingDir: f.root, route: f.route, task: "Review the project." }] };
  await f.request({ kind: "setTeamPlan", taskId: task.taskId, plan });
  await expect(f.request({ kind: "setTeamPlan", taskId: task.taskId, plan: { ...plan, concurrency: 2 } })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  const team = await f.request({ kind: "startTeam", taskId: task.taskId }) as ReturnType<CollaborationGoalManager["getTree"]>;
  const target = f.store.listTargets().find(value => value.descriptor.id.startsWith("extension-team-target-"))!;
  const input = { operationId: "create-plugin-worker", goalId: team.goal.id, callerLeadSessionId: task.taskId, expectedGoalRevision: team.goal.revision,
    label: "Reviewer", role: "Review", assignment: "Review the project.", route: { ...f.route, targetId: target.descriptor.id, permissionMode: "auto" as const, planMode: false } };
  await expect(f.teams.createWorker({ ...input, operationId: "invalid-label", label: "Other" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  const { worker } = await f.teams.createWorker(input);
  expect(f.store.getSession(worker.sessionId!).descriptor.hidden).toBe(true);
  await vi.waitFor(() => expect(f.store.listRuns({ sessionId: worker.sessionId! })[0]?.descriptor.state).toBe("completed"));
  expect(f.store.listSessions({ excludeHidden: true })).toHaveLength(0);
  expect(f.store.listQueueItems({ sessionId: worker.sessionId! })).toHaveLength(1);
  const current = f.store.getCollaborationWorker(worker.id);
  expect(() => f.teams.updateWorker({ operationId: "rename-plugin-worker", workerId: worker.id, callerLeadSessionId: task.taskId, expectedRevision: current.revision, label: "Outside plan" })).toThrow();
  f.store.upsertTarget({ ...target.descriptor, trusted: false });
  await expect(f.teams.sendMessage({ operationId: "revoked-directory", goalId: team.goal.id, workerId: worker.id, callerLeadSessionId: task.taskId,
    expectedWorkerRevision: f.store.getCollaborationWorker(worker.id).revision, expectedSessionGeneration: worker.sessionGeneration!, message: "Continue" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  f.store.transaction(store => f.tasks.uninstall(store, "resource")); f.uninstall();
  expect(f.store.listSessions({ excludeHidden: true })).toHaveLength(2);
  expect(() => f.tasks.assertTeamWorkerCurrent(task.taskId)).toThrow();
});
it("returns the completed Worker Run timestamp so a plugin can release its plan slot", async () => {
  const f = await fixture();
  f.tasks.updatePreferences(f.extensionId, 0n, { model: f.route, targetId: "workspace", permissionMode: "auto" }, () => undefined);
  const { taskId } = await f.request({ kind: "create", requestKey: "release-team", title: "Release team" }) as { taskId: string };
  const first = { label: "First", workingDir: f.root, route: f.route, task: "Review the first document." };
  const second = { ...first, label: "Second", task: "Review the second document." };
  await f.request({ kind: "setTeamPlan", taskId, plan: { concurrency: 1, task: "Review two documents in order", items: [first, second] } });
  const team = await f.request({ kind: "startTeam", taskId }) as ReturnType<CollaborationGoalManager["getTree"]>;
  const target = f.store.listTargets().find(value => value.descriptor.id.startsWith("extension-team-target-"))!.descriptor;
  const route = { ...f.route, targetId: target.id, permissionMode: "auto" as const, planMode: false };
  const settle = f.store.updateQueueState.bind(f.store);
  vi.spyOn(f.store, "updateQueueState").mockImplementation(input => {
    if (input.state !== "completed") return settle(input);
    const run = f.store.getRun(f.store.getQueueItem(input.queueItemId).runId).descriptor;
    return settle({ ...input, at: Math.max(input.at ?? Date.now(), run.endedAt! + 1) });
  });
  const base = { goalId: team.goal.id, callerLeadSessionId: taskId, route, role: "Reviewer" };
  const { worker } = await f.teams.createWorker({ ...base, operationId: "first-serial-worker", expectedGoalRevision: team.goal.revision,
    label: first.label, assignment: first.task });
  await vi.waitFor(() => expect(f.store.listQueueItems({ sessionId: worker.sessionId! })[0]?.state).toBe("completed"));
  const endedAt = f.store.listRuns({ sessionId: worker.sessionId!, limit: 1 })[0]!.descriptor.endedAt;
  const queueCompletedAt = f.store.listQueueItems({ sessionId: worker.sessionId! })[0]!.completedAt;
  expect(queueCompletedAt).toBeGreaterThan(endedAt!);
  await expect(f.teams.createWorker({ ...base, operationId: "second-before-release", expectedGoalRevision: f.teams.getTree(team.goal.id).goal.revision,
    label: second.label, assignment: second.task })).rejects.toMatchObject({ code: "TASK_BUSY" });
  const read = await f.request({ kind: "getTeam", taskId }) as { workers: readonly { id: string; completedAt?: number }[] };
  const completedAt = read.workers.find(value => value.id === worker.id)?.completedAt;
  expect(completedAt).toBe(endedAt);
  const release = { kind: "releaseWorker", taskId, workerId: worker.id };
  await expect(f.request({ ...release, completedAt: queueCompletedAt })).rejects.toMatchObject({ code: "STALE_REVISION" });
  await expect(f.request({ ...release, completedAt })).resolves.toMatchObject({ worker: { id: worker.id, runtimeReleased: true } });

  const current = f.teams.getTree(team.goal.id).goal;
  await expect(f.teams.createWorker({ ...base, operationId: "second-serial-worker", expectedGoalRevision: current.revision,
    label: second.label, assignment: second.task })).resolves.toMatchObject({ worker: { label: second.label } });
});
it("keeps account-wide history closed while an uninstalled plugin's Worker still runs behind a queued human input", async () => {
  const f = await fixture();
  f.tasks.updatePreferences(f.extensionId, 0n, { model: f.route, targetId: "workspace", permissionMode: "auto" }, () => undefined);
  const lead = await f.request({ kind: "create", requestKey: "active-orca-lead", title: "Plugin lead" }) as { taskId: string };
  await f.request({ kind: "setTeamPlan", taskId: lead.taskId, plan: { concurrency: 1, task: "Review one document",
    items: [{ label: "Reader", workingDir: f.root, route: f.route, task: "Read the document." }] } });
  const team = await f.request({ kind: "startTeam", taskId: lead.taskId }) as ReturnType<CollaborationGoalManager["getTree"]>;
  const target = f.store.listTargets().find(value => value.descriptor.id.startsWith("extension-team-target-"))!.descriptor;
  const { worker } = await f.teams.createWorker({ operationId: "active-orca-worker", goalId: team.goal.id,
    callerLeadSessionId: lead.taskId, expectedGoalRevision: team.goal.revision, label: "Reader", role: "Read", assignment: "Read the document.",
    route: { ...f.route, targetId: target.id, permissionMode: "auto", planMode: false } });
  const workerId = worker.sessionId!;
  await vi.waitFor(() => expect(f.store.listRuns({ sessionId: workerId, limit: 1 })[0]?.descriptor.state).toBe("completed"));
  const connection = f.store.createConnection({ id: "worker-owner", name: "Owner", authKeyDigest: "worker-owner-digest" });
  const user = (operationId: string, text: string) => f.host.enqueueInput({ operationId, connection, sessionId: workerId,
    prompt: { text, images: [], files: [], mentions: [], disposition: "prompt" } }).value;
  const earlier = user("worker-earlier-owner-input", "Earlier approved human input");
  await vi.waitFor(() => expect(f.store.getRun(earlier.runId).descriptor.state).toBe("completed"));
  const send = f.adapter.send.bind(f.adapter);
  let running: AdapterContext | undefined;
  vi.spyOn(f.adapter, "send").mockImplementation(async (input, context) => {
    if (context.operationId === "held-orca-input") { running = context; return; }
    await send(input, context);
  });
  const live = f.store.getCollaborationWorker(worker.id);
  const { dispatch } = await f.teams.sendMessage({ operationId: "held-orca-input", goalId: team.goal.id, workerId: worker.id,
    callerLeadSessionId: lead.taskId, expectedWorkerRevision: live.revision, expectedSessionGeneration: live.sessionGeneration!,
    message: "Hold original system assignment" });
  const active = f.store.getQueueItem(dispatch.queueItemId!);
  await vi.waitFor(() => expect(f.store.getQueueItem(active.id).state).toBe("backend_accepted"));
  expect(running).toBeDefined();
  f.store.transaction(store => f.tasks.uninstall(store, "resource")); f.uninstall();
  const next = user("worker-queued-after-uninstall", "New human input");
  expect(f.store.getRun(next.runId).descriptor.state).toBe("queued");
  expect(f.store.getRun(active.runId).descriptor).toMatchObject({ state: "running", source: "system" });
  const leadSession = f.store.getSession(lead.taskId).descriptor;
  f.store.appendEvent({ id: "outside-worker-history", backendId: leadSession.backendId, targetId: leadSession.targetId,
    sessionId: leadSession.id, generation: leadSession.binding.generation, traceId: "history-fixture",
    payload: { type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "Original account history marker" }] } });
  const helpers = new SessionHelperToolBridgeProvider({ store: f.store, host: () => f.host });
  const history = () => helpers.callTool("call_tool", { name: "get_chat_history", args: { session_ids: [lead.taskId] } }, undefined,
    { sessionId: workerId, targetId: target.id, generation: live.sessionGeneration! });
  expect(f.tasks.nativeToolAuthorization(workerId)).toBeDefined();
  const blocked = await history();
  expect(blocked.isError).toBe(true);
  expect(JSON.stringify(blocked)).toContain("PERMISSION_DENIED");
  expect(JSON.stringify(blocked)).not.toContain("Original account history marker");
  await running!.emit({ type: "done", outcome: "completed" });
  await vi.waitFor(() => expect(f.store.getRun(next.runId).descriptor.state).toBe("completed"));
  const allowed = await history();
  expect(allowed.isError).toBe(false);
  expect(JSON.stringify(allowed)).toContain("Original account history marker");
});
it("preserves user takeover after a declaration is removed and reveals before uninstall revokes ownership", async () => {
  const f = await fixture();
  const task = await f.request({ kind: "create", requestKey: "one", title: "Background work", hidden: true }) as { taskId: string };
  f.removeHidden();
  await expect(f.request({ kind: "setHidden", taskId: task.taskId, hidden: false })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  expect(f.tasks.backgroundTasks(f.extensionId)).toHaveLength(1);
  f.disable(); f.tasks.reveal(f.extensionId, task.taskId, () => {});
  expect(f.store.getSession(task.taskId).descriptor.hidden).toBeUndefined();
  f.store.updateSession(task.taskId, { hidden: true });
  f.store.transaction(store => f.tasks.uninstall(store, "resource")); f.uninstall();
  expect(f.store.listSessions({ excludeHidden: true })).toHaveLength(1);
  f.reinstall(); await expect(f.request({ kind: "get", taskId: task.taskId })).rejects.toThrow();
});
it("reveals the retired facet's hidden tasks only when the package replacement commits", async () => {
  const f = await fixture(), source = join(f.root, "workflow-package");
  await mkdir(source);
  const writePackage = async (version: string, entry: string) => {
    await writeFile(join(source, entry), "export default function workflow() {}\n");
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "workflow-package", version, type: "module", pi: { extensions: [`./${entry}`] } }));
  };
  await writePackage("1.0.0", "worker.js");
  const resources = new PiResourceManager({ store: f.store, managedRoot: join(f.root, "installed-packages") });
  await resources.initialize();
  const discovered = await resources.discoverPackage({ id: "workflow-package", backendId: f.adapter.id, scope: "global", source: { kind: "local", path: source } });
  await resources.approve(discovered.id, discovered.discoveredRevision, "connection-owner");
  const installed = await resources.install(discovered.id);
  const extensionId = [...resourceExtensionIds(installed)][0]!;
  const tasks = new ExtensionTasks({ ...f.tasks.options, catalog: { get: id => {
    const current = resources.get(installed.id);
    if (!resourceExtensionIds(current).has(id)) throw new Error("The installed extension is unavailable.");
    return { ...f.descriptor(), id, owner: { kind: "resource", resourceId: current.id,
      discoveredRevision: current.discoveredRevision, resourceVersion: current.versionNumber } };
  } } });
  resources.setExtensionTaskPackageChange((transaction, resource) => tasks.reconcilePackageTasks(transaction, [resource]));
  const owner = { ...f.owner, extensionId, resourceId: installed.id, installation: tasks.installation(extensionId, installed.id) };
  const request = (value: Record<string, unknown>, identity = owner) => tasks.request(identity, { type: "tasks-request", ...value });
  const task = await request({ kind: "create", requestKey: "old-work", title: "Old background task", hidden: true }) as { taskId: string };
  const other = await f.request({ kind: "create", requestKey: "other-work", title: "Unrelated background task", hidden: true }) as { taskId: string };
  expect(tasks.backgroundTasks(extensionId).map(item => item.taskId)).toEqual([task.taskId]);

  await writePackage("2.0.0", "worker-v2.js");
  const failed = await resources.prepareUpdate(installed.id, { approvedByConnectionId: "connection-owner" });
  await expect(resources.completePreparedMutation(failed, finalize => f.store.transaction(store => {
    finalize(store);
    throw new Error("Package receipt was rolled back.");
  }))).rejects.toThrow("Package receipt was rolled back.");
  expect(tasks.backgroundTasks(extensionId).map(item => item.taskId)).toEqual([task.taskId]);
  await expect(request({ kind: "get", taskId: task.taskId })).resolves.toMatchObject({ taskId: task.taskId });

  const updated = await resources.update(installed.id, { approvedByConnectionId: "connection-owner" });
  const replacement = [...resourceExtensionIds(updated)][0]!;
  expect(updated.id).toBe(installed.id);
  expect(replacement).toBeDefined();
  expect(replacement).not.toBe(extensionId);
  expect(f.store.listSessions({ excludeHidden: true }).map(item => item.descriptor.id)).toEqual([task.taskId]);
  expect(f.store.getSession(other.taskId).descriptor.hidden).toBe(true);
  expect(tasks.backgroundTasks(replacement)).toEqual([]);
  const installation = tasks.installation(replacement, installed.id);
  expect(installation).toBe(owner.installation);
  await expect(request({ kind: "get", taskId: task.taskId }, { ...owner, extensionId: replacement, installation })).rejects.toThrow();
});
it("rejects another installation, invalid model tuning, stale settings and hidden declaration escalation", async () => {
  const f = await fixture(), prefs = f.tasks.preferences(f.extensionId);
  const updated = f.tasks.updatePreferences(f.extensionId, prefs.revision, { model: f.route, targetId: "workspace", permissionMode: "ask" }, () => {});
  expect(updated.config.targetId).toBe("workspace");
  expect(() => f.tasks.updatePreferences(f.extensionId, prefs.revision, { permissionMode: "auto" }, () => {})).toThrow();
  expect(() => f.tasks.updatePreferences(f.extensionId, updated.revision, { model: { ...f.route, fastMode: true }, permissionMode: "ask" }, () => {})).toThrow();
  const task = await f.request({ kind: "create", requestKey: "one", title: "Own task" }) as { taskId: string };
  await expect(f.tasks.request({ ...f.owner, installation: "another" }, { kind: "get", taskId: task.taskId })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  f.removeHidden(); await expect(f.request({ kind: "create", requestKey: "two", title: "Hidden task", hidden: true })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
});
