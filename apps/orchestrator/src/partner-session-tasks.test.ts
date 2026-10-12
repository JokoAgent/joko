import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { OperationalStore, PartnerStore } from "@joko/store";
import type { AdapterContext, PromptInput } from "@joko/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, Code } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import * as contract from "@joko/contracts";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { SessionHost } from "./session-host.js";
import { PartnerManager } from "./partner-manager.js";
import { PartnerSessionTaskManager } from "./partner-session-tasks.js";
import { PartnerSessionTaskTools } from "./partner-session-task-tools.js";
import { ConnectionManager } from "./connection-manager.js";
import { AppDefaultModelCoordinator } from "./app-default-model.js";
import { createPublicServer } from "./server.js";
import type { OrchestratorApplication } from "./application.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const profile = { ...PI_LIKE_PROFILE, streamDelayMs: 30_000, capabilities: [...PI_LIKE_PROFILE.capabilities.map(capability => capability.key === "permission.modes"
  ? { key: "permission.modes", supported: true, options: ["ask", "auto", "bypassPermissions"] } : capability), { key: "permission.change", supported: true }],
  models: [...PI_LIKE_PROFILE.models, { ...PI_LIKE_PROFILE.models[0]!, modelId: "backup" }] };
class RecordedAdapter extends FakeBackendAdapter {
  readonly inputs: Array<{ input: PromptInput; context: AdapterContext }> = [];
  override async send(input: PromptInput, context: AdapterContext) { this.inputs.push({ input, context }); return super.send(input, context); }
  async complete(sessionId: string, text: string) {
    const context = this.inputs.filter(item => item.context.sessionId === sessionId).at(-1)!.context;
    await context.emit({ type: "message_complete", role: "assistant", blocks: [{ kind: "text", text }] });
    await context.emit({ type: "done", outcome: "completed" });
  }
}
describe("Partner independent Session tasks", () => {
  it("creates one visible task, freezes a cross-Backend preference and returns adopted artifacts once", async () => {
    const f = await fixture(), selected = await f.partners.updatePartner(f.partner.id, f.partner.revision, { taskModelOverride: f.route });
    const created = await f.tasks.start(f.parent, "task:first", { instruction: "Produce the report", title: "Report", workingDir: f.project }, () => undefined);
    const child = f.store.getSession(created.sessionId!).descriptor;
    expect(child).toMatchObject({ backendId: f.secondary.id, providerId: "test", modelId: "text", effort: "medium", permissionMode: "ask", planMode: false });
    expect(f.store.listSessions()).toHaveLength(2); expect(f.store.getSession(f.parent).descriptor.backendId).toBe(f.primary.id);
    expect(f.store.listQueueItems({ sessionId: child.id })).toHaveLength(1); expect(f.partnerStore.getSessionLink(child.id)).toBeUndefined();
    await f.partners.updatePartner(f.partner.id, selected.revision, { taskModelOverride: null });
    expect((await f.tasks.start(f.parent, "task:first", { instruction: "Produce the report", title: "Report", workingDir: f.project }, () => undefined)).sessionId).toBe(child.id);
    await expect(f.tasks.start(f.parent, "task:first", { instruction: "Different request" }, () => undefined)).rejects.toThrow("different request");
    await vi.waitFor(() => expect(f.secondary.inputs).toHaveLength(1));
    const artifact = await f.artifacts.ingestBytes(new TextEncoder().encode("Report"), { fileName: "report.txt", mimeType: "text/plain", expiresAt: Date.now() + 60_000 });
    f.store.transaction(store => store.adoptSessionArtifact({ sessionId: child.id, blob: store.getArtifact(artifact.id).blob }));
    await f.secondary.complete(child.id, "Report ready.");
    await vi.waitFor(() => expect(f.tasks.list(f.partner.id)[0]).toMatchObject({ status: "completed", result: "Report ready.", deliveredExecution: 1 }));
    expect(f.tasks.view(f.tasks.list(f.partner.id)[0]!)).toMatchObject({ artifacts: [{ id: artifact.id, name: "report.txt" }] });
    const returned = f.store.listQueueItems({ sessionId: f.parent }); expect(returned).toHaveLength(1); expect(returned[0]!.body.text).toContain(artifact.id);
    await f.tasks.message(f.parent, created.id, "task:followup", { mode: "queue", message: "Add a summary" }, () => undefined);
    await f.tasks.message(f.parent, created.id, "task:followup", { mode: "queue", message: "Add a summary" }, () => undefined);
    expect(f.store.listSessions()).toHaveLength(2); expect(f.store.getSession(child.id).descriptor.backendId).toBe(f.secondary.id);
    expect(f.store.listQueueItems({ sessionId: child.id })).toHaveLength(2); expect(f.tasks.list(f.partner.id)[0]!.execution).toBe(2);
    expect(f.tasks.inspectRoute.bind(f.tasks, f.parent, created.id)).toThrow();
  });
  it("preserves the pending queue across pause/restart and resumes without replaying the original objective", async () => {
    const f = await fixture(); const created = await f.tasks.start(f.parent, "task:pause", { instruction: "Implement the change", workingDir: f.project }, () => undefined);
    await vi.waitFor(() => expect(f.primary.inputs.some(item => item.context.sessionId === created.sessionId)).toBe(true));
    await f.tasks.message(f.parent, created.id, "task:pending", { mode: "queue", message: "Also document it" }, () => undefined);
    const paused = await f.tasks.stop(f.parent, created.id, "task:hold", "pause", () => undefined);
    expect(paused.control).toBe("paused"); expect(f.store.getQueueControl(created.sessionId!).paused).toBe(true);
    const queued = f.store.listQueueItems({ sessionId: created.sessionId!, states: ["accepted"] }); expect(queued).toHaveLength(1);
    await f.tasks.close(); f.tasks = new PartnerSessionTaskManager(f.store, f.partners, f.host, f.workspaces, f.managed, f.now); await f.tasks.initialize();
    expect(f.tasks.isHeld(created.sessionId!)).toBe(true);
    await expect(f.tasks.message(f.parent, created.id, "task:blocked", { mode: "queue", message: "Repeat it" }, () => undefined)).rejects.toThrow("Resume");
    f.advance(10_000);
    const resumed = await f.tasks.message(f.parent, created.id, "task:resume", { mode: "resume" }, () => undefined);
    expect(resumed.control).toBe("active"); expect(resumed.deadlineAt).toBe(created.deadlineAt + 10_000);
    expect(f.store.listQueueItems({ sessionId: created.sessionId! })).toHaveLength(2);
    expect(f.store.listQueueItems({ sessionId: created.sessionId! }).filter(item => item.body.text === "Implement the change")).toHaveLength(1);
  });
  it("uses the owned queue boundary for edits and rejects consuming input and unavailable steer", async () => {
    const f = await fixture(), created = await f.tasks.start(f.parent, "task:queue", { instruction: "Do work" }, () => undefined);
    await vi.waitFor(() => expect(f.primary.inputs).toHaveLength(1));
    await f.tasks.message(f.parent, created.id, "task:queued", { mode: "queue", message: "Pending" }, () => undefined);
    const own = f.tasks.view(await f.tasks.check(f.parent, created.id)).queue.find(item => item.state === "accepted")!;
    await f.tasks.message(f.parent, created.id, "task:edit", { mode: "edit", queuedMessageId: own.id, message: "Edited" }, () => undefined);
    expect(f.store.getQueueItem(own.id).body.text).toBe("Edited");
    await f.tasks.message(f.parent, created.id, "task:withdraw", { mode: "withdraw", queuedMessageId: own.id }, () => undefined);
    expect(f.store.getQueueItem(own.id).state).toBe("cancelled");
    await expect(f.tasks.message(f.parent, created.id, "task:edit-consumed", { mode: "edit", queuedMessageId: f.store.listQueueItems({ sessionId: created.sessionId! }).find(item => item.state !== "cancelled")!.id, message: "Unsafe" }, () => undefined)).rejects.toThrow("unconsumed");
    const foreign = f.host.enqueueServiceInput({ sessionId: created.sessionId!, operationId: "task:user-origin", prompt: { text: "User input", images: [], files: [], mentions: [], disposition: "prompt" }, source: "system" });
    await expect(f.tasks.message(f.parent, created.id, "task:edit-foreign", { mode: "withdraw", queuedMessageId: foreign.value.queueItemId }, () => undefined)).rejects.toThrow("own unconsumed");
    await f.tasks.stop(f.parent, created.id, "task:cancel", "cancel", () => undefined);
    const before = f.store.listQueueItems({ sessionId: created.sessionId! }).length;
    await expect(f.tasks.message(f.parent, created.id, "task:steer-idle", { mode: "steer", message: "Urgent" }, () => undefined)).rejects.toThrow("no queued fallback");
    expect(f.store.listQueueItems({ sessionId: created.sessionId! })).toHaveLength(before);
  });
  it("observes unknown dispatch after recovery without creating or resending anything", async () => {
    const f = await fixture(); const original = f.primary.send.bind(f.primary);
    vi.spyOn(f.primary, "send").mockImplementation(async (input, context) => { f.primary.injectFault(context.sessionId, "dispatch_unknown"); return original(input, context); });
    const created = await f.tasks.start(f.parent, "task:unknown", { instruction: "One attempt only" }, () => undefined);
    await vi.waitFor(() => expect(f.tasks.list(f.partner.id)[0]!.status).toBe("unknown"));
    await f.tasks.close(); f.tasks = new PartnerSessionTaskManager(f.store, f.partners, f.host, f.workspaces, f.managed, f.now); await f.tasks.initialize();
    await f.tasks.check(f.parent, created.id); await f.tasks.start(f.parent, created.id, { instruction: "One attempt only" }, () => undefined);
    expect(f.primary.send).toHaveBeenCalledOnce(); expect(f.store.listSessions()).toHaveLength(2); expect(f.store.listQueueItems({ sessionId: created.sessionId! })).toHaveLength(1);
  });
  it("keeps the original timeout budget when reopening an ended task and times out only that execution", async () => {
    const f = await fixture(), created = await f.tasks.start(f.parent, "task:deadline", { instruction: "Bounded task", timeoutMs: 1000 }, () => undefined);
    await vi.waitFor(() => expect(f.primary.inputs).toHaveLength(1)); f.advance(1001);
    const ended = await f.tasks.check(f.parent, created.id); expect(ended.status).toBe("timed-out"); expect(ended.control).toBe("active");
    await f.tasks.message(f.parent, created.id, "task:new-execution", { mode: "queue", message: "Continue completed work" }, () => undefined);
    const reopened = f.tasks.list(f.partner.id)[0]!; expect(reopened.deadlineAt).toBe(f.now() + 1000); expect(reopened.timeoutMs).toBe(1000); expect(reopened.sessionId).toBe(created.sessionId);
  });
  it("advances only a frozen configured route after terminal state and explicit selection has no backup", async () => {
    const f = await fixture(), current = await f.partners.updatePartner(f.partner.id, f.partner.revision, { capabilities: { ...f.partner.capabilities,
      modelChain: [...f.partner.capabilities.modelChain, { ...f.partner.capabilities.modelChain[0]!, modelId: "backup" }] } });
    const created = await f.tasks.start(f.parent, "task:routes", { instruction: "Work" }, () => undefined); await vi.waitFor(() => expect(f.primary.inputs).toHaveLength(1));
    await f.primary.complete(created.sessionId!, "Done"); await vi.waitFor(() => expect(f.tasks.list(f.partner.id)[0]!.status).toBe("completed"));
    const inspected = f.tasks.inspectRoute(f.parent, created.id); expect(inspected.next?.modelId).toBe("backup");
    await expect(f.tasks.advanceRoute(f.parent, created.id, inspected.generation, "0".repeat(64), () => undefined)).rejects.toThrow("changed");
    await f.tasks.advanceRoute(f.parent, created.id, inspected.generation, inspected.selection_token!, () => undefined);
    expect(f.host.getSessionRuntimeControl(created.sessionId!).effective?.modelId).toBe("backup");
    await f.partners.updatePartner(f.partner.id, current.revision, { taskModelOverride: f.route });
    const explicit = await f.tasks.start(f.parent, "task:explicit", { instruction: "Selected" }, () => undefined); await vi.waitFor(() => expect(f.secondary.inputs).toHaveLength(1));
    await f.secondary.complete(explicit.sessionId!, "Done"); await vi.waitFor(() => expect(f.tasks.list(f.partner.id).find(task => task.id === explicit.id)!.status).toBe("completed"));
    expect(f.tasks.inspectRoute(f.parent, explicit.id).next).toBeUndefined();
  });
  it("advances a frozen mixed Backend chain on the same independent task at its next send", async () => {
    const f = await fixture();
    await f.partners.updatePartner(f.partner.id, f.partner.revision, { capabilities: { ...f.partner.capabilities,
      modelChain: [...f.partner.capabilities.modelChain, f.route] } });
    const task = await f.tasks.start(f.parent, "task:mixed", { instruction: "Start here", workingDir: f.project }, () => undefined);
    await vi.waitFor(() => expect(f.primary.inputs).toHaveLength(1));
    const original = f.store.getSession(task.sessionId!).descriptor;
    expect(f.tasks.fallback({ sessionId: original.id, current: f.host.getSessionRuntimeControl(original.id).effective!,
      visitedRoutes: [], currentHop: 0 })).toEqual({ owned: true, candidate: f.route });
    await f.primary.complete(task.sessionId!, "Initial work done.");
    await vi.waitFor(() => expect(f.tasks.list(f.partner.id)[0]!.status).toBe("completed"));
    const route = f.tasks.inspectRoute(f.parent, task.id);
    expect(route.next?.backendId).toBe(f.secondary.id);
    await f.tasks.advanceRoute(f.parent, task.id, route.generation, route.selection_token!, () => undefined);
    expect(f.host.getSessionRuntimeControl(task.sessionId!).pending?.profile.backendId).toBe(f.secondary.id);
    await f.tasks.message(f.parent, task.id, "task:mixed-next", { mode: "queue", message: "Continue there" }, () => undefined);
    await vi.waitFor(() => expect(f.secondary.inputs).toHaveLength(1));
    expect(f.store.getSession(task.sessionId!).descriptor).toMatchObject({ id: original.id, targetId: original.targetId,
      backendId: f.secondary.id, permissionMode: original.permissionMode });
    expect(f.secondary.inputs[0]!.input.text).toContain("Initial work done.");
    expect(f.store.listSessions()).toHaveLength(2);
  });
  it("binds tools to the actual canonical Caller and accepts only discovered explicit routes", async () => {
    const f = await fixture(), tools = new PartnerSessionTaskTools(f.tasks), descriptor = f.store.getSession(f.parent).descriptor;
    const context = { sessionId: f.parent, targetId: descriptor.targetId, generation: descriptor.binding.generation, providerGeneration: 1, effectIdentity: "a".repeat(64) };
    const directory = JSON.parse((await tools.callTool("get_session_task_models", {}, undefined, context)).content[0]!.text!);
    const route = directory.available.find((entry: { backendId: string; efforts: string[] }) => entry.backendId === f.secondary.id && entry.efforts.includes("high"));
    const reply = await tools.callTool("start_session_task", { instruction: "Independent", model_selection: { id: route.id, effort: "high" } }, undefined, context);
    expect(reply.isError, reply.content[0]!.text).toBe(false); const task = JSON.parse(reply.content[0]!.text!);
    expect(f.store.getSession(task.session_id).descriptor).toMatchObject({ backendId: f.secondary.id, effort: "high" });
    expect((await tools.callTool("check_session_task", { task_id: task.task_id }, undefined, { ...context, generation: context.generation + 1 })).isError).toBe(true);
    expect((await tools.callTool("start_session_task", { instruction: "Unavailable", model_selection: { id: "guessed-route" } }, undefined, { ...context, effectIdentity: "b".repeat(64) })).isError).toBe(true);
    expect((await tools.callTool("start_session_task", { instruction: "Invalid", model_selection: { id: route.id, harness: "guess" } }, undefined, context)).isError).toBe(true);
    expect(f.store.listSessions()).toHaveLength(2);
  });
  it("fails an unavailable isolated-worktree preparation before dispatch without shared-directory fallback", async () => {
    const f = await fixture(), created = await f.tasks.start(f.parent, "task:worktree", { instruction: "Isolated work", workingDir: f.project, useWorktree: true }, () => undefined);
    expect(created.status).toBe("failed"); expect(f.primary.inputs).toEqual([]); expect(f.store.listQueueItems()).toEqual([]);
    expect(f.tasks.list(f.partner.id)[0]!.useWorktree).toBe(true);
  });
  it("returns an exact open permission to the requester and accepts only its current decision", async () => {
    const f = await fixture(), task = await f.tasks.start(f.parent, "task:decision", { instruction: "Work with permission" }, () => undefined);
    await vi.waitFor(() => expect(f.primary.inputs).toHaveLength(1));
    const context = f.primary.inputs[0]!.context;
    const pending = context.requestInteraction({ id: "task-permission", kind: "permission", title: "Execute command", toolName: "command", summary: "Run the required command", risk: "low", choices: ["allow_once", "deny_once"] });
    await vi.waitFor(() => expect(f.store.listQueueItems({ sessionId: f.parent })).toHaveLength(1));
    await vi.waitFor(() => expect(f.primary.inputs.some(item => item.context.sessionId === f.parent)).toBe(true));
    expect(f.store.listQueueItems({ sessionId: f.parent })[0]!.body.text).toContain("task-permission");
    const interaction = f.store.listInteractions({ sessionId: task.sessionId!, status: "open" })[0]!;
    const paused = await f.tasks.stop(f.parent, task.id, "task:pause-decision", "pause", () => undefined);
    expect(paused.control).toBe("paused"); expect(f.store.getInteraction(interaction.id).status).toBe("open");
    expect(f.tasks.view(paused).stop_confirmed).toBe(false);
    expect(() => f.host.resolveInteraction(interaction.id, interaction.generation, { kind: "permission", decision: "allow_once" }, "human-paused-answer")).toThrow("Resume");
    await f.tasks.message(f.parent, task.id, "task:resume-decision", { mode: "resume" }, () => undefined);
    const tools = new PartnerSessionTaskTools(f.tasks), parent = f.store.getSession(f.parent).descriptor;
    const caller = { sessionId: f.parent, targetId: parent.targetId, generation: parent.binding.generation, providerGeneration: 1, effectIdentity: "c".repeat(64) };
    expect((await tools.callTool("message_session_task", { task_id: task.id, interaction_id: interaction.id, interaction_generation: interaction.generation + 1, decision: "allow_once" }, undefined, caller)).isError).toBe(true);
    const answered = await tools.callTool("message_session_task", { task_id: task.id, interaction_id: interaction.id, interaction_generation: interaction.generation, decision: "allow_once" }, undefined, caller);
    expect(answered.isError, answered.content[0]!.text).toBe(false);
    expect(await pending).toMatchObject({ kind: "selected", value: "allow_once" });
    expect(f.store.listQueueItems({ sessionId: f.parent })).toHaveLength(1);
  });
  it("includes cross-Backend independent work in Partner pause and deletion ownership", async () => {
    const f = await fixture(), selected = await f.partners.updatePartner(f.partner.id, f.partner.revision, { taskModelOverride: f.route });
    const task = await f.tasks.start(f.parent, "task:lifecycle", { instruction: "Independent work" }, () => undefined);
    await vi.waitFor(() => expect(f.secondary.inputs).toHaveLength(1));
    await f.tasks.message(f.parent, task.id, "task:lifecycle-pending", { mode: "queue", message: "Pending input" }, () => undefined);
    const paused = await f.partners.setLifecycle(f.partner.id, selected.revision, "paused");
    expect(f.store.countQueueItems({ sessionId: task.sessionId!, states: ["accepted", "dispatching", "backend_accepted", "dispatch_unknown"] })).toBe(0);
    expect(f.tasks.isHeld(task.sessionId!)).toBe(true);
    const deletion = await f.partners.deletePartner({ requestId: "delete-own-tasks", partnerId: f.partner.id, expectedRevision: paused.revision, confirmName: paused.displayName });
    expect(deletion.phase).toBe("completed"); expect(f.store.getSession(task.sessionId!).descriptor.archived).toBe(true);
    expect(f.tasks.list(f.partner.id)).toEqual([]);
  });
  it("authenticates generated HTTP task lists and controls against SQLite and the real Host queue", async () => {
    const f = await fixture(), task = await f.tasks.start(f.parent, "task:http", { instruction: "Visible task" }, () => undefined);
    await vi.waitFor(() => expect(f.primary.inputs).toHaveLength(1));
    const connections = new ConnectionManager(f.store), challenge = connections.issuePairing("Task observer");
    const paired = connections.completePairing({ challengeId: challenge.id, code: challenge.code, connectionName: "Task observer" });
    const server = await createPublicServer({ config: { publicOrigin: "http://127.0.0.1", allowInsecureLoopback: true, allowInsecureLan: false, corsOrigins: [], webDirectory: join(f.root, "no-web"), dataDirectory: f.managed },
      store: f.store, connections, artifacts: {}, blobTransfers: {}, artifactRepository: {}, workspaces: f.workspaces, workspaceChanges: {}, scheduler: {}, adapters: [f.primary, f.secondary], browserActivity: [],
      sessionHost: f.host, partners: f.partners, partnerSessionTasks: f.tasks } as unknown as OrchestratorApplication); server.log.level = "silent";
    try {
      const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
      const transport = createConnectTransport({ baseUrl, httpVersion: "1.1", interceptors: [next => request => { request.header.set("authorization", `Bearer ${paired.authKey}`); return next(request); }] });
      const client = createClient(contract.PartnerService, transport), listed = await client.listPartnerSessions({ partnerId: f.partner.id });
      expect(listed.tasks).toMatchObject([{ id: task.id, sessionId: task.sessionId, status: contract.PartnerSessionTaskStatus.RUNNING }]);
      const paused = await client.controlPartnerSessionTask({ requestId: "human-pause", partnerId: f.partner.id, taskId: task.id, expectedPartnerRevision: { value: f.partner.revision }, expectedTaskRevision: listed.tasks[0]!.revision, action: contract.PartnerSessionTaskAction.PAUSE });
      expect(paused.task?.control).toBe(contract.PartnerSessionTaskControl.PAUSED); expect(f.store.getQueueControl(task.sessionId!).paused).toBe(true);
      await expect(client.controlPartnerSessionTask({ requestId: "stale-control", partnerId: f.partner.id, taskId: task.id, expectedPartnerRevision: { value: f.partner.revision }, expectedTaskRevision: listed.tasks[0]!.revision, action: contract.PartnerSessionTaskAction.RESUME })).rejects.toMatchObject({ code: Code.Aborted });
      const unauthenticated = createClient(contract.PartnerService, createConnectTransport({ baseUrl, httpVersion: "1.1" }));
      await expect(unauthenticated.listPartnerSessions({ partnerId: f.partner.id })).rejects.toMatchObject({ code: Code.Unauthenticated });
    } finally { await server.close(); }
  });
  it("hands off a canonical Partner after a generated authenticated HTTP profile change and publishes the durable boundary", async () => {
    const f = await fixture(0);
    const connections = new ConnectionManager(f.store), challenge = connections.issuePairing("Runtime observer");
    const paired = connections.completePairing({ challengeId: challenge.id, code: challenge.code, connectionName: "Runtime observer" });
    const server = await createPublicServer({ config: { publicOrigin: "http://127.0.0.1", allowInsecureLoopback: true, allowInsecureLan: false, corsOrigins: [], webDirectory: join(f.root, "no-web"), dataDirectory: f.managed },
      store: f.store, connections, artifacts: {}, blobTransfers: {}, artifactRepository: {}, workspaces: f.workspaces, workspaceChanges: {}, scheduler: {}, adapters: [f.primary, f.secondary], browserActivity: [],
      sessionHost: f.host, partners: f.partners, partnerSessionTasks: f.tasks } as unknown as OrchestratorApplication); server.log.level = "silent";
    try {
      const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
      const transport = createConnectTransport({ baseUrl, httpVersion: "1.1", interceptors: [next => request => { request.header.set("authorization", `Bearer ${paired.authKey}`); return next(request); }] });
      const client = createClient(contract.PartnerService, transport);
      const changed = await client.updatePartner({ partnerId: f.partner.id, expectedRevision: { value: f.partner.revision },
        patch: { description: "Profile configured through authenticated HTTP", modelChain: { routes: [f.route, ...f.partner.capabilities.modelChain] }, permissionMode: contract.PermissionMode.ASK, planMode: false } });
      expect(changed.partner?.canonicalSessionId).toBe(f.parent);
      expect(changed.partner?.description).toBe("Profile configured through authenticated HTTP");
      expect(f.store.getSession(f.parent).descriptor.backendId).toBe(f.primary.id);
      const sent = f.host.enqueueServiceInput({ operationId: "http-handoff-send", sessionId: f.parent, source: "system",
        prompt: { text: "Continue through the public profile", images: [], files: [], mentions: [], disposition: "prompt" } }).value;
      await vi.waitFor(() => expect(f.store.getRun(sent.runId).descriptor.state).toBe("completed"));
      expect((await client.getPartner({ partnerId: f.partner.id })).partner?.capabilities?.modelChain[0]?.backendId).toBe(f.secondary.id);
      expect((await client.getPartner({ partnerId: f.partner.id })).partner?.description).toBe("Profile configured through authenticated HTTP");
      expect(f.store.getSession(f.parent).descriptor.backendId).toBe(f.secondary.id);
      expect(f.store.listEvents({ sessionId: f.parent }).some(event => event.payload.type === "runtime_handoff")).toBe(true);
      expect(f.store.getQueueItem(sent.queueItemId).body.text).toBe("Continue through the public profile");
    } finally { await server.close(); }
  });
  it("confirms UI-owned defaults through authenticated HTTP and follows only uncustomized Partner models", async () => {
    let defaults: AppDefaultModelCoordinator | undefined;
    const f = await fixture(0, () => { const route = defaults?.current(); if (!route) return undefined; const { effort, ...base } = route; return { ...base, ...(effort ? { effort } : {}) }; });
    defaults = new AppDefaultModelCoordinator(f.store, () => f.host.appDefaultModelChoices(), () => f.partners.followAppDefaultModel(), f.now);
    const connections = new ConnectionManager(f.store), challenge = connections.issuePairing("Default picker");
    const paired = connections.completePairing({ challengeId: challenge.id, code: challenge.code, connectionName: "Default picker" });
    const server = await createPublicServer({ config: { publicOrigin: "http://127.0.0.1", allowInsecureLoopback: true, allowInsecureLan: false, corsOrigins: [], webDirectory: join(f.root, "no-web"), dataDirectory: f.managed },
      store: f.store, connections, artifacts: {}, blobTransfers: {}, artifactRepository: {}, workspaces: f.workspaces, workspaceChanges: {}, scheduler: {}, adapters: [f.primary, f.secondary], browserActivity: [],
      sessionHost: f.host, partners: f.partners, partnerSessionTasks: f.tasks, appDefaultModels: defaults } as unknown as OrchestratorApplication); server.log.level = "silent";
    const abort = new AbortController();
    try {
      const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
      const transport = createConnectTransport({ baseUrl, httpVersion: "1.1", interceptors: [next => request => { request.header.set("authorization", `Bearer ${paired.authKey}`); return next(request); }] });
      const ui = createClient(contract.AppDefaultModelService, transport), owner = "current-default-picker";
      const watch = ui.watchAppDefaultModel({ uiOwnerId: owner }, { signal: abort.signal })[Symbol.asyncIterator]();
      expect((await watch.next()).value?.ready).toBe(true);
      const primary = defaults.read().available.find(item => item.backendId === f.primary.id && item.modelId === "text")!;
      const secondary = defaults.read().available.find(item => item.backendId === f.secondary.id && item.modelId === "text")!;
      expect(primary).toBeDefined(); expect(secondary).toBeDefined();
      expect((await ui.syncAppDefaultModel({ uiOwnerId: owner, current: primary })).accepted).toBe(true);
      const capabilities = f.partners.directory().state.defaultCapabilities!;
      const following = await f.partners.createPartner({ requestId: "following-create", expectedDirectoryRevision: f.partnerStore.directoryState().revision,
        displayName: "Following default", avatar: "orbit", identitySource: "Keep the configured modes.", templateId: "general", capabilities, usesDirectoryDefaults: true });
      const selected = defaults.select({ sessionId: f.parent, id: secondary.id, assertCaller: () => undefined });
      const requested = (await watch.next()).value!.requestId;
      expect(f.store.listEvents({ sessionId: f.parent }).at(-1)?.payload).toMatchObject({ type: "app_default_model_requested", requestId: requested });
      const claim = await ui.claimAppDefaultModel({ uiOwnerId: owner, requestId: requested });
      expect(claim.remainingMs).toBeGreaterThan(0); expect(claim.expected?.backendId).toBe(f.primary.id);
      await expect(ui.claimAppDefaultModel({ uiOwnerId: owner, requestId: requested })).rejects.toThrow();
      await ui.syncAppDefaultModel({ uiOwnerId: owner, current: claim.requested, confirmedRequestId: requested });
      expect((await selected).current.backendId).toBe(f.secondary.id);
      expect(f.partnerStore.directoryState().defaultCapabilities).toBeUndefined();
      expect(f.partners.getPartner(following.id)).toMatchObject({ usesDirectoryDefaults: true, capabilities: { modelChain: [{ backendId: f.secondary.id }], permissionMode: capabilities.permissionMode, planMode: capabilities.planMode } });
      expect(f.host.getSessionRuntimeControl(following.canonicalSessionId!).pending?.profile.backendId).toBe(f.secondary.id);
      expect(f.partners.getPartner(f.partner.id)).toEqual(f.partner); expect(f.store.getSession(f.parent).descriptor.backendId).toBe(f.primary.id);
      await f.partners.updateDirectoryDefaults(f.partnerStore.directoryState().revision, capabilities);
      const frozen = f.partners.getPartner(following.id);
      await ui.syncAppDefaultModel({ uiOwnerId: owner, current: primary });
      await vi.waitFor(() => expect(defaults!.read().current?.backendId).toBe(f.primary.id));
      expect(f.partners.getPartner(following.id)).toEqual(frozen); expect(f.partnerStore.directoryState().defaultCapabilities).toEqual(capabilities);
      await ui.syncAppDefaultModel({ uiOwnerId: owner, current: primary, hiddenRouteIds: [secondary.id] });
      await expect(defaults.select({ sessionId: f.parent, id: secondary.id, assertCaller: () => undefined })).rejects.toThrow("enabled model");
      await ui.syncAppDefaultModel({ uiOwnerId: owner, current: primary });
      const lateAbort = new AbortController(), expired = defaults.select({ sessionId: f.parent, id: secondary.id, assertCaller: () => undefined, signal: lateAbort.signal }).catch(error => error);
      const lateId = (await watch.next()).value!.requestId; f.advance(5_001);
      await expect(ui.claimAppDefaultModel({ uiOwnerId: owner, requestId: lateId })).rejects.toThrow(); lateAbort.abort();
      expect(await expired).toBeInstanceOf(Error);
      const disconnected = defaults.select({ sessionId: f.parent, id: secondary.id, assertCaller: () => undefined }).catch(error => error);
      await watch.next(); abort.abort(); await watch.return?.();
      expect(await disconnected).toBeInstanceOf(Error);
      expect(defaults.read().current?.backendId).toBe(f.primary.id);
      await expect(defaults.select({ sessionId: f.parent, id: secondary.id, assertCaller: () => undefined })).rejects.toThrow("not confirmed");
      expect(new AppDefaultModelCoordinator(f.store, () => f.host.appDefaultModelChoices(), async () => undefined).read().current).toBeNull();
      await expect(ui.claimAppDefaultModel({ uiOwnerId: owner, requestId: requested })).rejects.toThrow();
      const anonymous = createClient(contract.AppDefaultModelService, createConnectTransport({ baseUrl, httpVersion: "1.1" }));
      await expect(anonymous.syncAppDefaultModel({ uiOwnerId: owner, current: primary })).rejects.toThrow();
    } finally { abort.abort(); await server.close(); }
  });
});
async function fixture(streamDelayMs = 30_000, appDefaultModel?: () => { backendId: string; providerId: string; modelId: string; effort?: string; fastMode: boolean } | undefined) {
  const root = mkdtempSync(join(tmpdir(), "joko-session-task-")), managed = join(root, "managed"), project = join(root, "project"); mkdirSync(managed); mkdirSync(project);
  const store = new OperationalStore(join(managed, "operational.db")), partnerStore = new PartnerStore(join(managed, "partners.db"));
  const artifacts = new ArtifactStore({ rootDirectory: join(managed, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] }); await artifacts.initialize();
  const primary = new RecordedAdapter({ ...profile, streamDelayMs }), secondary = new RecordedAdapter({ ...profile, streamDelayMs, id: "task-secondary" }); let tasks!: PartnerSessionTaskManager;
  const host = new SessionHost(store, artifacts, [primary, secondary], { partnerSessionPaused: sessionId => partnerStore.isPartnerSessionPaused(sessionId) || tasks?.isHeld(sessionId) === true,
    partnerSessionRetiring: sessionId => partnerStore.isPartnerSessionRetiring(sessionId) || tasks?.isRetiring(sessionId) === true,
    partnerTargetRetired: targetId => partnerStore.isPartnerTargetRetired(targetId),
    serviceSessionRuntimeFallback: input => tasks?.fallback(input) ?? { owned: false } }); await host.initialize();
  const workspaces = { register: vi.fn(async (input: { id: string; root: string; displayName: string; trusted: boolean }) => input), unregister: vi.fn() };
  const partners = new PartnerManager({ store: partnerStore, operationalStore: store, sessionHost: host, workspaceService: workspaces, homesRoot: join(managed, "partner-homes"),
    ...(appDefaultModel === undefined ? {} : { appDefaultModel }),
    ownedIndependentSessions: partnerId => tasks?.ownedSessions(partnerId) ?? [], forgetIndependentTasks: partnerId => tasks?.forgetPartner(partnerId) });
  const partner = await partners.createPartner({ requestId: "task-partner-create", expectedDirectoryRevision: partnerStore.directoryState().revision, displayName: "Aster", avatar: "orbit", identitySource: "You help with projects.", templateId: "general", usesDirectoryDefaults: false,
    capabilities: { modelChain: [{ backendId: primary.id, providerId: "test", modelId: "text", effort: "medium", fastMode: false }], permissionMode: "ask", planMode: false } });
  let now = Date.now(); const clock = () => now;
  tasks = new PartnerSessionTaskManager(store, partners, host, workspaces, managed, clock); await tasks.initialize();
  cleanups.push(async () => { await tasks.close(); await host.dispose(); partnerStore.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, managed, project, store, partnerStore, artifacts, primary, secondary, host, partners, partner, parent: partner.canonicalSessionId!, workspaces,
    get tasks() { return tasks; }, set tasks(value: PartnerSessionTaskManager) { tasks = value; }, now: clock, advance(milliseconds: number) { now += milliseconds; },
    route: { backendId: secondary.id, providerId: "test", modelId: "text", effort: "medium", fastMode: false } };
}
