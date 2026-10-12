import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import type { AdapterContext, NativeSessionBinding, PromptInput } from "@joko/core";
import {
  OperationalStore,
  PartnerStore,
  PartnerStoreError,
  type PartnerCapabilitiesRecord,
  type PartnerProfileRecord
} from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { PartnerManager, partnerSessionRuntimeFallback, type PartnerManagerOptions } from "./partner-manager.js";
import { SessionHost } from "./session-host.js";

const cleanups: Array<() => Promise<void> | void> = [];
const PARTNER_PROFILE = {
  ...PI_LIKE_PROFILE,
  capabilities: [
    ...PI_LIKE_PROFILE.capabilities.map((capability) => capability.key === "permission.modes"
      ? { key: "permission.modes", supported: true, options: ["ask", "auto", "bypassPermissions"] }
      : capability),
    { key: "permission.change", supported: true }
  ]
} as const;
const EFFORTLESS_PARTNER_PROFILE = {
  ...PARTNER_PROFILE,
  id: "fake-effortless-partner",
  displayName: "Effortless Partner Fake",
  models: [{
    ...PARTNER_PROFILE.models[0]!,
    thinkingLevels: []
  }]
} as const;

class OffSentinelFakeBackendAdapter extends FakeBackendAdapter {
  override async inspectSession(...args: Parameters<FakeBackendAdapter["inspectSession"]>) {
    return { ...await super.inspectSession(...args), effort: "off" };
  }
}

class UserEchoFakeBackendAdapter extends FakeBackendAdapter {
  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    await context.emit({ type: "message_complete", role: "user", blocks: [{ kind: "text", text: input.text }] });
    await super.send(input, context);
  }
}

class PrivateOriginSpoofAdapter extends UserEchoFakeBackendAdapter {
  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    await super.send(input, { ...context, emit: (payload, options) => context.emit(payload.type !== "message_complete" ? payload : {
      ...payload, partnerPrivateOrigin: { messageId: "spoof", threadId: "spoof", senderPartnerId: "spoof-sender", recipientPartnerId: "spoof-recipient", senderDisplayName: "Spoof" }
    }, options) });
  }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("PartnerManager", () => {
  it("freezes independent task routes, rejects unavailable overrides and inherits the effective live model", async () => {
    const secondary = new FakeBackendAdapter({ ...PARTNER_PROFILE, id: "task-backend", models: [{ ...PARTNER_PROFILE.models[0]!, modelId: "task-model" }] });
    const primary = new FakeBackendAdapter({ ...PARTNER_PROFILE, models: [...PARTNER_PROFILE.models, { ...PARTNER_PROFILE.models[0]!, modelId: "live-model" }] });
    const f = await createFixture(undefined, primary, undefined, [secondary]);
    let profile = await f.manager.createPartner(createInput(f.partnerStore, "Task choices")); const sessionId = profile.canonicalSessionId!;
    const route = { backendId: secondary.id, providerId: "test", modelId: "task-model", effort: "medium", fastMode: false };
    profile = await f.manager.updatePartner(profile.id, profile.revision, { taskModelOverride: route });
    const frozen = f.manager.resolveTaskModel(sessionId); expect(frozen.route).toEqual(route);
    expect(f.operationalStore.getSession(sessionId).descriptor.backendId).toBe(primary.id);
    expect(f.sessionHost.getSessionRuntimeControl(sessionId).effective?.modelId).toBe("text");
    f.operationalStore.setSetting("service", "orchestrator", `settings.model_access.${secondary.id}`, { disabledProviderIds: ["test"], disabledModels: [] });
    expect(() => frozen.assertCurrent()).toThrow(); expect(() => f.manager.resolveTaskModel(sessionId)).toThrow();
    profile = await f.manager.updatePartner(profile.id, profile.revision, { taskModelOverride: null });
    await f.sessionHost.setSessionRuntimeControl({ sessionId, expectedGeneration: f.sessionHost.getSessionRuntimeControl(sessionId).generation,
      patch: { providerId: "test", modelId: "live-model", effort: "off", fastMode: false } });
    const inherited = f.manager.resolveTaskModel(sessionId); expect(inherited.route).toMatchObject({ modelId: "live-model", effort: "off" });
    expect(profile.capabilities.modelChain[0]?.modelId).toBe("text");
    await f.sessionHost.setSessionRuntimeControl({ sessionId, expectedGeneration: f.sessionHost.getSessionRuntimeControl(sessionId).generation,
      patch: { providerId: "test", modelId: "text", effort: "medium", fastMode: false } });
    expect(() => inherited.assertCurrent()).toThrow();
  });

  it("persists pause before closing work, keeps independent tasks and resumes the same history without replaying a stopped run", async () => {
    class PendingPause extends FakeBackendAdapter {
      release: () => void = () => undefined;
      override async send(input: PromptInput, context: AdapterContext): Promise<void> {
        if (input.text !== "pause current work") return super.send(input, context);
        await context.emit({ type: "text_delta", blockId: "partial", delta: "Retained partial reply" });
        await new Promise<void>(resolve => { this.release = resolve; });
      }
      override async closeSession(...args: Parameters<FakeBackendAdapter["closeSession"]>): Promise<void> {
        this.release(); await super.closeSession(...args);
      }
    }
    const adapter = new PendingPause(PARTNER_PROFILE); const f = await createFixture(undefined, adapter);
    const partner = await f.manager.createPartner(createInput(f.partnerStore, "Paused worker")); const sessionId = partner.canonicalSessionId!;
    const independent = await f.sessionHost.createServiceSession({ operationId: "pause-independent-task", serviceKind: "partner",
      targetId: partner.homeTargetId, title: "Independent task", providerId: "test", modelId: "text", fastMode: false, planMode: false, permissionMode: "ask" });
    const prompt = (text: string): PromptInput => ({ text, images: [], files: [], mentions: [], disposition: "prompt" });
    const sent = vi.spyOn(adapter, "send"); const nativeResume = vi.spyOn(adapter, "resumeSession"); const rebuild = vi.spyOn(adapter, "rebuildContext");
    const pending = f.sessionHost.enqueueServiceInput({ operationId: "pause-stopped-input", sessionId, source: "system", prompt: prompt("pause current work") });
    await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce());
    const queued = f.sessionHost.enqueueServiceInput({ operationId: "pause-retained-input", sessionId, source: "system", prompt: prompt("retained queue") });
    const original = adapter.closeSession.bind(adapter); const closed = vi.spyOn(adapter, "closeSession");
    closed.mockImplementation(async (...args) => {
      expect(f.manager.getPartner(partner.id)).toMatchObject({ lifecycle: "paused", pauseCleanupPending: true });
      expect(f.operationalStore.getQueueControl(sessionId).paused).toBe(true); await original(...args);
    });
    const paused = await f.manager.setLifecycle(partner.id, partner.revision, "paused");
    expect(paused).toMatchObject({ lifecycle: "paused", pauseCleanupPending: false, canonicalSessionId: sessionId });
    expect(closed).toHaveBeenCalledOnce();
    expect(f.operationalStore.getQueueItem(queued.value.queueItemId).state).toBe("accepted");
    expect(f.operationalStore.getRun(pending.value.runId).descriptor.state).toBe("aborted");
    expect(() => f.sessionHost.enqueueServiceInput({ operationId: "paused-denied-input", sessionId, source: "system", prompt: prompt("denied") })).toThrow(/Resume/u);
    expect(f.operationalStore.findPendingContextRebuild(sessionId)).toBeUndefined();
    expect(f.operationalStore.getSession(independent.value.sessionId).descriptor.deletedAt).toBeUndefined();
    const history = f.operationalStore.listEvents({ sessionId, limit: 1000 }).length;
    const resumed = await f.manager.setLifecycle(partner.id, paused.revision, "active");
    expect(resumed).toMatchObject({ lifecycle: "active", canonicalSessionId: sessionId, profileVersion: partner.profileVersion });
    expect(resumed.pauseCleanupPending).toBeUndefined(); expect(f.partnerStore.getPartnerPause(partner.id)).toBeUndefined();
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2));
    expect(sent.mock.calls.map(([input]) => input.text)).toEqual(["pause current work", "retained queue"]);
    expect(nativeResume).toHaveBeenCalledOnce(); expect(rebuild).not.toHaveBeenCalled();
    expect(f.operationalStore.listEvents({ sessionId, limit: 1000 }).length).toBeGreaterThanOrEqual(history);
  });
  it("cancels delegated child input before resume while preserving the other Partner canonical task", async () => {
    const f = await createFixture(); const requester = await f.manager.createPartner(createInput(f.partnerStore, "Pause requester"));
    const target = await f.manager.createPartner(createInput(f.partnerStore, "Unaffected target"));
    const child = await f.sessionHost.createServiceSession({ operationId: "pause-delegated-child", serviceKind: "partner", targetId: target.homeTargetId,
      title: "Delegated child", providerId: "test", modelId: "text", fastMode: false, planMode: false, permissionMode: "ask" });
    const delegation = f.partnerStore.createDelegation({ id: "pause-owned-delegation", requesterPartnerId: requester.id, targetPartnerId: target.id,
      parentSessionId: requester.canonicalSessionId!, title: "Owned task", objective: "Work which must stop on pause." });
    f.partnerStore.bindDelegationSession(delegation.id, delegation.revision, child.value.sessionId);
    f.operationalStore.setQueuePaused({ sessionId: child.value.sessionId, paused: true, traceId: "pause-delegated-queue" });
    const queued = f.sessionHost.enqueueServiceInput({ operationId: "pause-delegated-input", sessionId: child.value.sessionId, source: "system",
      prompt: { text: "Cancelled delegation input", images: [], files: [], mentions: [], disposition: "prompt" } });
    const sent = vi.spyOn(f.adapter, "send"); const paused = await f.manager.setLifecycle(requester.id, requester.revision, "paused");
    expect(f.partnerStore.getDelegation(delegation.id).status).toBe("cancelled");
    expect(f.operationalStore.getQueueItem(queued.value.queueItemId).state).toBe("cancelled");
    expect(f.operationalStore.getRun(queued.value.runId).descriptor.state).toBe("aborted");
    expect(f.partnerStore.isPartnerSessionPaused(target.canonicalSessionId!)).toBe(false);
    await f.manager.setLifecycle(requester.id, paused.revision, "active"); expect(sent).not.toHaveBeenCalled();
    expect(f.manager.getPartner(target.id)).toEqual(target);
  });

  it("keeps manual pauses, saves paused profile edits without starting a runtime and recovers a failed close before resuming", async () => {
    const f = await createFixture(); const partner = await f.manager.createPartner(createInput(f.partnerStore, "Manual paused partner"));
    const sessionId = partner.canonicalSessionId!; const nativeResume = vi.spyOn(f.adapter, "resumeSession"); const sent = vi.spyOn(f.adapter, "send");
    f.operationalStore.setQueuePaused({ sessionId, paused: true, traceId: "pause-user-preference" });
    const close = vi.spyOn(f.adapter, "closeSession").mockRejectedValueOnce(new Error("Private close diagnostic"));
    await expect(f.manager.setLifecycle(partner.id, partner.revision, "paused")).rejects.toThrow(/pending/u);
    const pending = f.manager.getPartner(partner.id); expect(pending).toMatchObject({ lifecycle: "paused", pauseCleanupPending: true });
    expect(f.partnerStore.getPartnerPause(partner.id)?.failure).toBe("runtime_close_pending");
    await expect(f.manager.setLifecycle(partner.id, partner.revision, "active")).rejects.toThrow(/changed/u);
    expect(() => f.sessionHost.enqueueServiceInput({ operationId: "pause-failure-denied", sessionId, source: "system",
      prompt: { text: "denied", images: [], files: [], mentions: [], disposition: "prompt" } })).toThrow(/Resume/u);
    await f.manager.recoverPending();
    const paused = f.manager.getPartner(partner.id); expect(paused.pauseCleanupPending).toBe(false); expect(close).toHaveBeenCalledTimes(2);
    const edited = await f.manager.updatePartner(partner.id, paused.revision, { displayName: "Changed while paused", identitySource: "Saved paused identity." });
    expect(edited).toMatchObject({ lifecycle: "paused", initializationState: "ready", displayName: "Changed while paused" });
    expect(nativeResume).not.toHaveBeenCalled(); expect(sent).not.toHaveBeenCalled();
    expect(f.operationalStore.getSession(sessionId).descriptor.appendSystemPrompt).toBe("Saved paused identity.");
    const resumed = await f.manager.setLifecycle(partner.id, edited.revision, "active"); expect(resumed.lifecycle).toBe("active");
    expect(f.operationalStore.getQueueControl(sessionId)).toMatchObject({ paused: true, resumeOnUserInput: false });
    expect(sent).not.toHaveBeenCalled(); expect(nativeResume).not.toHaveBeenCalled();
  });
  it("keeps paused ownership after resume commit failure and permits confirmed deletion without reopening the runtime", async () => {
    const f = await createFixture(); const partner = await f.manager.createPartner(createInput(f.partnerStore, "Paused cleanup"));
    const paused = await f.manager.setLifecycle(partner.id, partner.revision, "paused");
    const restore = vi.spyOn(f.sessionHost, "restorePartnerQueue").mockImplementationOnce(() => { throw new Error("Private commit error"); });
    await expect(f.manager.setLifecycle(partner.id, paused.revision, "active")).rejects.toThrow(/pending/u);
    expect(f.partnerStore.getPartnerPause(partner.id)).toMatchObject({ phase: "resuming", failure: "state_commit_pending" });
    expect(f.manager.getPartner(partner.id)).toMatchObject({ lifecycle: "paused", pauseCleanupPending: true }); expect(restore).toHaveBeenCalledOnce();
    const nativeResume = vi.spyOn(f.adapter, "resumeSession");
    const deletion = await f.manager.deletePartner({ requestId: "paused-delete-intent", partnerId: partner.id, expectedRevision: paused.revision, confirmName: paused.displayName });
    expect(deletion.phase).toBe("completed"); expect(f.partnerStore.getPartnerPause(partner.id)).toBeUndefined(); expect(nativeResume).not.toHaveBeenCalled();
  });
  it("fences a timed out pause until its old close settles and never lets a late close resume the Partner", async () => {
    const f = await createFixture(); const partner = await f.manager.createPartner(createInput(f.partnerStore, "Timed paused partner"));
    let enter!: () => void; let release!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; }); const original = f.adapter.closeSession.bind(f.adapter);
    const close = vi.spyOn(f.adapter, "closeSession").mockImplementationOnce(async (...args) => { enter(); await gate; await original(...args); });
    vi.useFakeTimers();
    const pending = f.manager.setLifecycle(partner.id, partner.revision, "paused").catch(() => undefined);
    try {
      await entered; await vi.advanceTimersByTimeAsync(30001); await pending;
      const paused = f.manager.getPartner(partner.id); expect(paused.pauseCleanupPending).toBe(true);
      await expect(f.manager.setLifecycle(partner.id, paused.revision, "active")).rejects.toThrow(/settling|pending/u); expect(close).toHaveBeenCalledOnce();
      release(); await vi.advanceTimersByTimeAsync(0);
      expect(f.manager.getPartner(partner.id).lifecycle).toBe("paused");
      expect(f.operationalStore.findPendingContextRebuild(partner.canonicalSessionId!)).toBeUndefined();
      expect((await f.manager.setLifecycle(partner.id, paused.revision, "active")).lifecycle).toBe("active");
    } finally { release(); vi.useRealTimers(); await pending; }
  });
  it.each(["native-rebuild", "native-create"] as const)("stops current work and rebuilds only after a user input through %s", async (path) => {
    class PendingRestart extends FakeBackendAdapter {
      createdBinding?: NativeSessionBinding;
      override async createSession(...args: Parameters<FakeBackendAdapter["createSession"]>): Promise<NativeSessionBinding> {
        const binding = await super.createSession(...args);
        this.createdBinding = { ...binding, opaqueRef: `${binding.opaqueRef}/native/${binding.nativeSessionId}` };
        return this.createdBinding;
      }
      override async inspectSession(...args: Parameters<FakeBackendAdapter["inspectSession"]>) {
        const state = await super.inspectSession(...args);
        const created = this.createdBinding;
        return created !== undefined && state.binding.nativeSessionId === created.nativeSessionId
          ? { ...state, binding: { ...created, generation: args[1].generation } } : state;
      }
      release: () => void = () => undefined;
      override async send(input: PromptInput, context: AdapterContext): Promise<void> {
        if (input.text !== "old work") return super.send(input, context);
        await context.emit({ type: "text_delta", blockId: "partial", delta: "Visible partial reply" });
        await new Promise<void>((resolve) => { this.release = resolve; });
      }
      override async closeSession(...args: Parameters<FakeBackendAdapter["closeSession"]>): Promise<void> {
        this.release(); await super.closeSession(...args);
      }
    }
    const adapter = new PendingRestart(PARTNER_PROFILE);
    if (path === "native-create") Object.defineProperty(adapter, "rebuildContext", { value: undefined });
    const f = await createFixture(undefined, adapter);
    const partner = await f.manager.createPartner(createInput(f.partnerStore, "Restarted partner"));
    const sessionId = partner.canonicalSessionId!;
    const prompt = (text: string): PromptInput => ({ text, images: [], files: [], mentions: [], disposition: "prompt" });
    const send = vi.spyOn(adapter, "send"); const close = vi.spyOn(adapter, "closeSession");
    const create = vi.spyOn(adapter, "createSession"); const resume = vi.spyOn(adapter, "resumeSession");
    const prior = f.sessionHost.enqueueServiceInput({ operationId: "restart-old-input", sessionId, source: "system", prompt: prompt("old work") });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const queued = f.sessionHost.enqueueServiceInput({ operationId: "restart-queued-input", sessionId, source: "system", prompt: prompt("kept queue") });
    const restart = await f.manager.restartPartner({ requestId: "restart-canonical-intent", partnerId: partner.id, expectedRevision: partner.revision });
    expect(restart.phase).toBe("ready"); expect(close).toHaveBeenCalledOnce(); expect(create).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
    expect(f.operationalStore.getQueueItem(queued.value.queueItemId).state).toBe("accepted");
    expect(f.operationalStore.getRun(prior.value.runId).descriptor.state).toBe("aborted");
    expect(f.operationalStore.getQueueControl(sessionId)).toMatchObject({ paused: true, resumeOnUserInput: true });
    expect(f.operationalStore.findPendingContextRebuild(sessionId)).toMatchObject({ reason: "manual_restart", replaySafe: false });
    expect(f.partnerStore.getPartner(partner.id)).toEqual(partner); expect(existsSync(f.homesRoot)).toBe(true);
    expect(await f.manager.restartPartner({ requestId: restart.requestId, partnerId: partner.id, expectedRevision: partner.revision })).toEqual(restart);
    expect(close).toHaveBeenCalledOnce();
    const connection = f.operationalStore.createConnection({ id: "restart-owner", name: "Owner", authKeyDigest: "restart-owner-key" });
    f.sessionHost.enqueueInput({ connection, operationId: "restart-user-input", sessionId, prompt: prompt("new user input") });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(f.operationalStore.getQueueControl(sessionId)).toMatchObject({ paused: false, resumeOnUserInput: false });
    const boundary = f.operationalStore.listEvents({ sessionId }).find((event) => event.payload.type === "context_rebuild");
    expect(boundary?.payload).toMatchObject({ reason: "manual_restart", handoff: expect.stringContaining("Visible partial reply"), replayScheduled: false });
    if (path === "native-create") {
      expect(create).toHaveBeenCalledOnce();
      expect(create.mock.calls[0]![0].appendSystemPrompt).toContain("Visible partial reply");
      expect(f.operationalStore.getSessionContextHandoff(sessionId)).toContain("Visible partial reply");
    }
  });
  it("keeps failed shutdown fenced and requires an explicit retry of the same restart receipt", async () => {
    const pauseGoal = vi.fn(async () => undefined); const f = await createFixture(undefined, undefined, pauseGoal);
    const partner = await f.manager.createPartner(createInput(f.partnerStore, "Restart recovery"));
    const close = vi.spyOn(f.adapter, "closeSession").mockImplementationOnce(async () => {
      expect(pauseGoal).toHaveBeenCalledOnce(); throw new Error("Private shutdown failure");
    });
    const input = { requestId: "restart-explicit-recovery", partnerId: partner.id, expectedRevision: partner.revision };
    const restart = await f.manager.restartPartner(input);
    expect(restart).toMatchObject({ phase: "closing", failure: "runtime_close_pending" });
    expect(JSON.stringify({ ...restart, profileRevision: String(restart.profileRevision) })).not.toContain("Private shutdown failure");
    expect(f.manager.restartControls(partner.id).available).toBe(false);
    expect(() => f.sessionHost.enqueueServiceInput({ operationId: "restart-closed-admission", sessionId: partner.canonicalSessionId!, source: "system",
      prompt: { text: "must not dispatch", images: [], files: [], mentions: [], disposition: "prompt" } })).toThrow();
    expect(await f.manager.restartPartner(input)).toEqual(restart); expect(close).toHaveBeenCalledOnce();
    expect(f.manager.retireRestart(input.requestId)).toEqual(restart);
    expect(await f.manager.retryRestart(input.requestId)).toMatchObject({ phase: "ready" });
    expect(close).toHaveBeenCalledTimes(2); expect(f.operationalStore.findPendingContextRebuild(partner.canonicalSessionId!)?.reason).toBe("manual_restart");
  });
  it("keeps a timed-out close fenced until settlement and never commits a late rebuild without retry", async () => {
    const f = await createFixture(); const partner = await f.manager.createPartner(createInput(f.partnerStore, "Timed close"));
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = f.adapter.closeSession.bind(f.adapter);
    const close = vi.spyOn(f.adapter, "closeSession").mockImplementationOnce(async (...args) => { enter(); await gate; await original(...args); });
    vi.useFakeTimers();
    const input = { requestId: "restart-timeout-fenced", partnerId: partner.id, expectedRevision: partner.revision };
    const pending = f.manager.restartPartner(input);
    try {
      await entered; await vi.advanceTimersByTimeAsync(30_001);
      expect(await pending).toMatchObject({ phase: "closing", failure: "runtime_close_pending" });
      expect(await f.manager.retryRestart(input.requestId)).toMatchObject({ phase: "closing" }); expect(close).toHaveBeenCalledOnce();
      release(); await vi.advanceTimersByTimeAsync(0);
      expect(f.operationalStore.findPendingContextRebuild(partner.canonicalSessionId!)).toBeUndefined();
      expect(f.manager.getRestart(input.requestId)?.phase).toBe("closing");
      expect(await f.manager.retryRestart(input.requestId)).toMatchObject({ phase: "ready" });
    } finally { release(); vi.useRealTimers(); await pending; }
  });
  it("preserves a manual queue pause after fresh user and service inputs", async () => {
    const f = await createFixture(); const partner = await f.manager.createPartner(createInput(f.partnerStore, "Manual pause"));
    const sessionId = partner.canonicalSessionId!; const send = vi.spyOn(f.adapter, "send");
    f.operationalStore.setQueuePaused({ sessionId, paused: true, traceId: "manual-pause" });
    await f.manager.restartPartner({ requestId: "restart-manual-pause-intent", partnerId: partner.id, expectedRevision: partner.revision });
    const prompt: PromptInput = { text: "wait", images: [], files: [], mentions: [], disposition: "prompt" };
    f.sessionHost.enqueueServiceInput({ operationId: "restart-manual-service", sessionId, source: "system", prompt });
    const connection = f.operationalStore.createConnection({ id: "manual-owner", name: "Owner", authKeyDigest: "manual-owner-key" });
    f.sessionHost.enqueueInput({ connection, operationId: "restart-manual-user", sessionId, prompt });
    await Promise.resolve(); expect(send).not.toHaveBeenCalled();
    expect(f.operationalStore.getQueueControl(sessionId)).toMatchObject({ paused: true, resumeOnUserInput: false });
    expect(f.operationalStore.listQueueItems({ sessionId, states: ["accepted"] })).toHaveLength(2);
  });
  it("settles an admitted runtime setting effect before closing the Partner runtime", async () => {
    const fixture = await createFixture(); const partner = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Runtime setting"));
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const applying = fixture.sessionHost.applyToActiveSessions({ backendId: fixture.adapter.id }, async () => { enter(); await gate; });
    await entered; const close = vi.spyOn(fixture.adapter, "closeSession");
    const deletion = fixture.manager.deletePartner({ requestId: "deletion-runtime-setting", partnerId: partner.id,
      expectedRevision: partner.revision, confirmName: partner.displayName });
    try {
      await vi.waitFor(() => expect(fixture.manager.getDeletion("deletion-runtime-setting")?.phase).toBe("closing"));
      expect(close).not.toHaveBeenCalled();
    } finally { release(); await Promise.allSettled([applying, deletion]); }
    await applying;
    expect(close).toHaveBeenCalledOnce(); expect(fixture.manager.getDeletion("deletion-runtime-setting")?.phase).toBe("completed");
  });
  it("interrupts an admitted native dispatch before waiting for settlement and removing Partner files", async () => {
    class PendingDispatch extends FakeBackendAdapter {
      release: () => void = () => undefined;
      override async send(): Promise<void> { await new Promise<void>((resolve) => { this.release = resolve; }); }
      override async closeSession(...args: Parameters<FakeBackendAdapter["closeSession"]>): Promise<void> { this.release(); await super.closeSession(...args); }
    }
    const adapter = new PendingDispatch(PARTNER_PROFILE); const fixture = await createFixture(undefined, adapter);
    const partner = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Pending turn"));
    const send = vi.spyOn(adapter, "send"); const close = vi.spyOn(adapter, "closeSession");
    fixture.sessionHost.enqueueServiceInput({ operationId: "pending-retirement-turn", sessionId: partner.canonicalSessionId!, source: "system",
      prompt: { text: "Pending native turn", images: [], files: [], mentions: [], disposition: "prompt" } });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const deletion = fixture.manager.deletePartner({ requestId: "deletion-pending-dispatch", partnerId: partner.id,
      expectedRevision: partner.revision, confirmName: partner.displayName });
    try { await vi.waitFor(() => expect(close).toHaveBeenCalledOnce(), { timeout: 200 }); }
    finally { adapter.release(); await deletion; }
    expect(fixture.manager.getDeletion("deletion-pending-dispatch")?.phase).toBe("completed"); expect(send).toHaveBeenCalledOnce();
  });
  it("closes and archives owned tasks, removes the managed home and preserves history and independent checkout files", async () => {
    const fixture = await createFixture();
    const partner = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Aster"));
    const home = join(fixture.homesRoot, readdirSync(fixture.homesRoot)[0]!);
    for (const directory of ["memory", "skills", "workspace"]) { mkdirSync(join(home, directory)); writeFileSync(join(home, directory, "private.txt"), "private material"); }
    writeFileSync(join(home, "workbench.json"), "private workbench");
    const independent = join(fixture.directory, "independent-checkout"); mkdirSync(independent); writeFileSync(join(independent, "kept.txt"), "keep me");
    const session = fixture.operationalStore.getSession(partner.canonicalSessionId!);
    const worktree = { leaseId: "independent-lease", workspaceId: "independent-workspace", path: independent,
      repositoryRoot: fixture.directory, branch: "codex/retained", sourceRef: "main", sourceCommit: "a".repeat(40),
      sourceStrategy: "head" as const, sourceRefreshed: false, state: "active" as const, acquiredAt: 1, updatedAt: 1 };
    fixture.sessionHost.enqueueServiceInput({ operationId: "retained-public-turn", sessionId: session.descriptor.id, source: "system",
      prompt: { text: "Preserve this task history", images: [], files: [], mentions: [], disposition: "prompt" } });
    await vi.waitFor(() => expect(fixture.manager.activity(partner.id).unreadReplyCount).toBe(1));
    const history = fixture.operationalStore.listEvents({ sessionId: session.descriptor.id }).map((event) => event.id);
    expect(history.length).toBeGreaterThan(0);
    const isolated = fixture.operationalStore.createSession({ ...session.descriptor, id: "retained-isolated-task",
      binding: { ...session.descriptor.binding, nativeSessionId: "retained-native", opaqueRef: "retained-native" }, worktree });
    const close = vi.spyOn(fixture.sessionHost, "closeIfActive"); const nativeDelete = vi.spyOn(fixture.sessionHost, "deleteNativeSession");
    const deletion = await fixture.manager.deletePartner({ requestId: "deletion-owned-history", partnerId: partner.id,
      expectedRevision: partner.revision, confirmName: partner.displayName });
    expect(deletion.phase).toBe("completed"); expect(close).toHaveBeenCalledTimes(2); expect(nativeDelete).not.toHaveBeenCalled();
    expect(existsSync(home)).toBe(false); expect(readFileSync(join(independent, "kept.txt"), "utf8")).toBe("keep me");
    expect(fixture.operationalStore.getSession(session.descriptor.id).descriptor.archived).toBe(true);
    expect(fixture.operationalStore.getSession(isolated.descriptor.id).descriptor).toMatchObject({ archived: true, worktree });
    expect(fixture.operationalStore.listEvents({ sessionId: session.descriptor.id }).map((event) => event.id)).toEqual(expect.arrayContaining(history));
    expect(fixture.workspaceService.unregister).toHaveBeenCalledWith(partner.homeTargetId);
    await expect(fixture.sessionHost.resume(session.descriptor.id)).rejects.toThrow();
    await expect(fixture.manager.setLifecycle(partner.id, partner.revision, "deleted")).rejects.toThrow();
    expect(() => fixture.partnerStore.getPartner(partner.id)).toThrow();
  });

  it("persists shutdown failure without cleaning files and resumes after a cold service restart without another turn", async () => {
    const fixture = await createFixture(); const partner = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Restart"));
    const home = join(fixture.homesRoot, readdirSync(fixture.homesRoot)[0]!);
    const close = vi.spyOn(fixture.sessionHost, "closeIfActive").mockRejectedValueOnce(new Error("private failure"));
    const input = { requestId: "deletion-restart-intent", partnerId: partner.id, expectedRevision: partner.revision, confirmName: partner.displayName };
    const failed = await fixture.manager.deletePartner(input);
    expect(failed).toMatchObject({ phase: "closing", failure: "runtime_close_pending" }); expect(existsSync(home)).toBe(true);
    expect(await fixture.manager.deletePartner(input)).toEqual(failed); expect(close).toHaveBeenCalledOnce();
    await fixture.sessionHost.dispose(); fixture.partnerStore.close(); fixture.operationalStore.close();
    const partners = new PartnerStore(join(fixture.directory, "partners.db")); const store = new OperationalStore(join(fixture.directory, "operational.db"));
    const repository = new OperationalArtifactRepository(store); const artifacts = new ArtifactStore({ rootDirectory: join(fixture.directory, "artifacts"), repository, ingestRoots: [fixture.directory] });
    await artifacts.initialize(); const adapter = new FakeBackendAdapter(PARTNER_PROFILE); const send = vi.spyOn(adapter, "send");
    const host = new SessionHost(store, artifacts, [adapter], { partnerSessionRetiring: (id) => partners.isPartnerSessionRetiring(id),
      partnerTargetRetired: (id) => partners.isPartnerTargetRetired(id) }); await host.initialize();
    const manager = new PartnerManager({ store: partners, operationalStore: store, sessionHost: host,
      workspaceService: fixture.workspaceService, homesRoot: fixture.homesRoot });
    cleanups.push(async () => { await host.dispose(); partners.close(); store.close(); });
    await manager.recoverPending(); expect(manager.getDeletion(input.requestId)).toMatchObject({ phase: "completed" });
    expect(store.getSession(partner.canonicalSessionId!).descriptor.archived).toBe(true); expect(existsSync(home)).toBe(false); expect(send).not.toHaveBeenCalled();
  });

  it("fails closed on a replaced managed home and retries only filesystem cleanup after runtime closure", async () => {
    const fixture = await createFixture(); const partner = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Guard"));
    const home = join(fixture.homesRoot, readdirSync(fixture.homesRoot)[0]!); const saved = join(fixture.directory, "saved-home");
    const external = join(fixture.directory, "external-project"); mkdirSync(external); writeFileSync(join(external, "kept.txt"), "outside data");
    renameSync(home, saved); symlinkSync(external, home, process.platform === "win32" ? "junction" : "dir");
    const close = vi.spyOn(fixture.sessionHost, "closeIfActive");
    const pending = await fixture.manager.deletePartner({ requestId: "deletion-guarded-home", partnerId: partner.id,
      expectedRevision: partner.revision, confirmName: partner.displayName });
    expect(pending).toMatchObject({ phase: "cleanup", failure: "home_cleanup_pending" });
    expect(readFileSync(join(external, "kept.txt"), "utf8")).toBe("outside data"); expect(close).toHaveBeenCalledOnce();
    rmSync(home, { force: true, recursive: true }); renameSync(saved, home);
    expect((await fixture.manager.retryDeletion(pending.requestId)).phase).toBe("completed");
    expect(close).toHaveBeenCalledOnce(); expect(existsSync(home)).toBe(false); expect(existsSync(join(external, "kept.txt"))).toBe(true);
  });

  it("freezes task creation before cleanup and keeps an admitted in-flight creation pending until it settles", async () => {
    const fixture = await createFixture(); const partner = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Admission"));
    const home = join(fixture.homesRoot, readdirSync(fixture.homesRoot)[0]!);
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const create = fixture.adapter.createSession.bind(fixture.adapter);
    const creation = vi.spyOn(fixture.adapter, "createSession").mockImplementationOnce(async (...args) => { await gate; return create(...args); });
    const pending = fixture.sessionHost.createServiceSession({ operationId: "admitted-partner-task", serviceKind: "partner", targetId: partner.homeTargetId,
      title: "Admitted before deletion", providerId: "test", modelId: "text", effort: "medium", fastMode: false, permissionMode: "ask", planMode: false });
    const observed = pending.then(() => undefined, () => undefined);
    await vi.waitFor(() => expect(creation).toHaveBeenCalledOnce());
    const deletion = await fixture.manager.deletePartner({ requestId: "deletion-creation-fence", partnerId: partner.id,
      expectedRevision: partner.revision, confirmName: partner.displayName });
    expect(deletion).toMatchObject({ phase: "closing", failure: "runtime_close_pending" }); expect(existsSync(home)).toBe(true);
    await expect(fixture.sessionHost.createServiceSession({ operationId: "late-partner-task", serviceKind: "partner", targetId: partner.homeTargetId,
      title: "Late task", providerId: "test", modelId: "text", effort: "medium", fastMode: false, permissionMode: "ask", planMode: false })).rejects.toThrow();
    expect(creation).toHaveBeenCalledOnce(); release(); await observed;
    expect((await fixture.manager.retryDeletion(deletion.requestId)).phase).toBe("completed"); expect(existsSync(home)).toBe(false);
    expect(creation).toHaveBeenCalledOnce();
  });
  it("returns the original creation result after edits without preparing another home or Session", async () => {
    const prepareAvatar = vi.fn(async () => undefined);
    const fixture = await createFixture(prepareAvatar);
    const input = createInput(fixture.partnerStore, "Aster");
    const first = await fixture.manager.createPartner(input);
    const updated = await fixture.manager.updatePartner(first.id, first.revision, { displayName: "Aster updated" });
    const effects = prepareAvatar.mock.calls.length;
    const homes = fixture.registerWorkspace.mock.calls.length;
    const sessions = fixture.operationalStore.getSnapshot().sessions.length;
    expect(await fixture.manager.createPartner(input)).toEqual(updated);
    expect(fixture.manager.getPartnerCreation(input.requestId)).toEqual(updated);
    expect(fixture.manager.retirePartnerCreation(input.requestId)).toEqual(updated);
    expect(prepareAvatar).toHaveBeenCalledTimes(effects);
    expect(fixture.registerWorkspace).toHaveBeenCalledTimes(homes);
    expect(fixture.operationalStore.getSnapshot().sessions).toHaveLength(sessions);
  });

  it("keeps concurrent replay attached to the pending creation and seals absent requests before effects", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const prepareAvatar = vi.fn(async () => gate);
    const fixture = await createFixture(prepareAvatar);
    const input = createInput(fixture.partnerStore, "Aster");
    const creating = fixture.manager.createPartner(input);
    const pending = await fixture.manager.createPartner(input);
    expect(pending.initializationState).toBe("pending");
    expect(fixture.manager.getPartnerCreation(input.requestId).id).toBe(pending.id);
    expect(fixture.manager.retirePartnerCreation(input.requestId)?.id).toBe(pending.id);
    release();
    const ready = await creating;
    expect(ready.id).toBe(pending.id);
    expect(prepareAvatar).toHaveBeenCalledTimes(1);
    const absentInput = createInput(fixture.partnerStore, "Beryl");
    expect(fixture.manager.retirePartnerCreation(absentInput.requestId)).toBeUndefined();
    await expect(fixture.manager.createPartner(absentInput)).rejects.toMatchObject({ code: "PARTNER_CREATION_RETIRED" });
    expect(prepareAvatar).toHaveBeenCalledTimes(1);
    expect(fixture.partnerStore.listPartners()).toHaveLength(1);
  });

  it("creates a durable home Target and exactly one canonical Session", async () => {
    const fixture = await createFixture();
    const created = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Aster"));

    expect(created).toMatchObject({
      displayName: "Aster",
      initializationState: "ready",
      invitationStage: "ready",
      profileVersion: 1
    });
    expect(created.canonicalSessionId).toBeDefined();
    const target = fixture.operationalStore.getTarget(created.homeTargetId).descriptor;
    expect(target).toMatchObject({ backendId: PI_LIKE_PROFILE.id, managed: true, trusted: true });
    expect(fixture.operationalStore.getTarget(created.homeTargetId).metadata).toMatchObject({
      kind: "partner_home",
      partnerId: created.id,
      workspaceId: created.homeTargetId
    });
    expect(fixture.registerWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      id: created.homeTargetId,
      displayName: "Aster home",
      trusted: true
    }));
    const session = fixture.operationalStore.getSession(created.canonicalSessionId!).descriptor;
    expect(session).toMatchObject({
      backendId: PI_LIKE_PROFILE.id,
      targetId: created.homeTargetId,
      title: "Aster",
      providerId: "test",
      modelId: "text",
      effort: "medium",
      permissionMode: "ask",
      planMode: false,
      archived: false
    });
    expect(session.appendSystemPrompt).toBe(created.identitySource);

    const updatedIdentity = "You are Aster's current version-two identity.";
    const updated = await fixture.manager.updatePartner(created.id, created.revision, {
      identitySource: updatedIdentity
    });
    expect(updated).toMatchObject({
      canonicalSessionId: created.canonicalSessionId,
      profileVersion: 2,
      initializationState: "ready"
    });
    expect(fixture.operationalStore.getSession(created.canonicalSessionId!).descriptor.appendSystemPrompt)
      .toBe(updatedIdentity);

    const homes = readdirSync(fixture.homesRoot);
    expect(homes).toHaveLength(1);
    const home = join(fixture.homesRoot, homes[0]!);
    expect(readFileSync(join(home, "IDENTITY.md"), "utf8")).toContain("version-two identity");
    expect(existsSync(join(home, "AVATAR.svg"))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, ".joko-partner.json"), "utf8"))).toMatchObject({
      format: 1,
      partnerId: created.id,
      profileVersion: 2,
      usesDirectoryDefaults: false
    });
  });

  it("accepts a disabled-effort native sentinel for a model without an effort axis", async () => {
    const fixture = await createFixture(
      undefined,
      new OffSentinelFakeBackendAdapter(EFFORTLESS_PARTNER_PROFILE)
    );
    const partnerCapabilities: PartnerCapabilitiesRecord = {
      modelChain: [{
        backendId: EFFORTLESS_PARTNER_PROFILE.id,
        providerId: "test",
        modelId: "text",
        fastMode: false
      }],
      permissionMode: "ask",
      planMode: false
    };
    const created = await fixture.manager.createPartner({
      expectedDirectoryRevision: fixture.partnerStore.directoryState().revision,
      requestId: "creation-request-plain",
      displayName: "Plain partner",
      avatar: "orbit",
      identitySource: "You are a durable plain-model partner.",
      templateId: "general",
      capabilities: partnerCapabilities,
      usesDirectoryDefaults: false
    });

    const updated = await fixture.manager.updatePartner(created.id, created.revision, {
      displayName: "Plain partner updated",
      identitySource: "You are the updated durable plain-model partner."
    });

    expect(updated).toMatchObject({
      canonicalSessionId: created.canonicalSessionId,
      initializationState: "ready",
      invitationStage: "ready",
      profileVersion: 2
    });
    const session = fixture.operationalStore.getSession(created.canonicalSessionId!).descriptor;
    expect(session).toMatchObject({
      title: "Plain partner updated",
      providerId: "test",
      modelId: "text",
      appendSystemPrompt: "You are the updated durable plain-model partner."
    });
    expect(session.effort).toBeUndefined();
  });

  it("surfaces avatar preparation failure and resumes the same profile without duplicating a Session", async () => {
    const fixture = await createFixture(async () => { throw new Error("avatar unavailable"); });
    const failed = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Mica"));
    expect(failed).toMatchObject({
      initializationState: "error",
      invitationStage: "failed",
      initializationErrorCode: "avatar_unavailable"
    });
    expect(failed.canonicalSessionId).toBeUndefined();
    expect(fixture.operationalStore.listSessions({ includeArchived: true, includeDeleted: true })).toEqual([]);

    const resumedManager = new PartnerManager({
      store: fixture.partnerStore,
      operationalStore: fixture.operationalStore,
      sessionHost: fixture.sessionHost,
      workspaceService: fixture.workspaceService,
      homesRoot: fixture.homesRoot
    });
    const ready = await resumedManager.retryInitialization(failed.id, failed.revision);
    expect(ready).toMatchObject({ initializationState: "ready", invitationStage: "ready" });
    expect(fixture.operationalStore.listSessions({ includeArchived: true, includeDeleted: true })).toHaveLength(1);
  });

  it("recovers an interrupted missing canonical Session from its exact profile fence", async () => {
    const fixture = await createFixture();
    const created = fixture.partnerStore.createPartner(createInput(fixture.partnerStore, "Nova"));
    const stale = fixture.partnerStore.bindCanonicalSession({
      partnerId: created.id,
      expectedRevision: created.revision,
      expectedProfileVersion: created.profileVersion,
      sessionId: "missing-session"
    });
    const ready = fixture.partnerStore.markReady(stale.id, stale.revision);
    fixture.partnerStore.prepareInitialization(ready.id, ready.revision);

    await fixture.manager.recoverPending();
    const recovered = fixture.partnerStore.getPartner(created.id);
    expect(recovered).toMatchObject({ initializationState: "ready", invitationStage: "ready" });
    expect(recovered.canonicalSessionId).not.toBe("missing-session");
    expect(fixture.operationalStore.getSession(recovered.canonicalSessionId!).descriptor.targetId)
      .toBe(recovered.homeTargetId);
    expect(fixture.operationalStore.listSessions({ includeArchived: true, includeDeleted: true })).toHaveLength(1);
    expect(fixture.partnerStore.listSessionLinks(recovered.id)).toEqual([
      expect.objectContaining({ sessionId: recovered.canonicalSessionId, role: "canonical" }),
      expect.objectContaining({ sessionId: "missing-session", role: "history" })
    ]);
  });

  it("applies directory defaults only to inheriting partners and preserves lifecycle Session isolation", async () => {
    const fixture = await createFixture();
    await fixture.manager.updateDirectoryDefaults(fixture.partnerStore.directoryState().revision, capabilities());
    const inherited = await fixture.manager.createPartner({
      ...createInput(fixture.partnerStore, "Aster"),
      usesDirectoryDefaults: true
    });
    const explicit = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Beryl"));
    const beforeExplicit = fixture.partnerStore.getPartner(explicit.id);
    const nextDefaults: PartnerCapabilitiesRecord = {
      modelChain: [{
        backendId: PI_LIKE_PROFILE.id,
        providerId: "vision",
        modelId: "multimodal",
        effort: "high",
        fastMode: false
      }],
      permissionMode: "auto",
      planMode: true
    };
    const affected = await fixture.manager.updateDirectoryDefaults(
      fixture.partnerStore.directoryState().revision,
      nextDefaults
    );
    expect(affected.map((profile) => profile.id)).toEqual([inherited.id]);
    expect(fixture.partnerStore.getPartner(inherited.id)).toMatchObject({
      capabilities: nextDefaults,
      usesDirectoryDefaults: true,
      initializationState: "ready"
    });
    expect(fixture.partnerStore.getPartner(explicit.id)).toEqual(beforeExplicit);

    const sessionId = inherited.canonicalSessionId!;
    const sessionBeforeLifecycle = fixture.operationalStore.getSession(sessionId).descriptor;
    const archived = await fixture.manager.setLifecycle(
      inherited.id,
      fixture.partnerStore.getPartner(inherited.id).revision,
      "archived"
    );
    const restored = await fixture.manager.setLifecycle(inherited.id, archived.revision, "active");
    const deleted = await fixture.manager.deletePartner({ requestId: "deletion-inherited-request", partnerId: inherited.id,
      expectedRevision: restored.revision, confirmName: restored.displayName });
    expect(deleted.phase).toBe("completed");
    expect(fixture.operationalStore.getSession(sessionId).descriptor).toEqual({
      ...sessionBeforeLifecycle,
      archived: true,
      providerId: "vision",
      modelId: "multimodal",
      effort: "high",
      permissionMode: "auto",
      planMode: true,
      updatedAt: expect.any(Number)
    });
  });

  it("rejects an unavailable model edit before changing the last usable profile", async () => {
    const fixture = await createFixture();
    const created = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Aster"));
    await expect(fixture.manager.updatePartner(created.id, created.revision, {
      capabilities: {
        ...created.capabilities,
        modelChain: [{
          backendId: PI_LIKE_PROFILE.id,
          providerId: "test",
          modelId: "missing",
          fastMode: false
        }]
      }
    })).rejects.toMatchObject({ code: "PARTNER_MODEL_UNAVAILABLE" });
    expect(fixture.partnerStore.getPartner(created.id)).toEqual(created);
  });

  it("validates a five-route Partner chain and follows all configured routes beyond the ordinary fallback budget", async () => {
    const models = Array.from({ length: 5 }, (_, index) => ({ ...PARTNER_PROFILE.models[0]!, modelId: `route-${index + 1}` }));
    const fixture = await createFixture(undefined, new FakeBackendAdapter({ ...PARTNER_PROFILE, models }));
    const modelChain = models.map(model => ({ ...capabilities().modelChain[0]!, modelId: model.modelId }));
    const partner = await fixture.manager.createPartner({ ...createInput(fixture.partnerStore, "Five routes"),
      capabilities: { ...capabilities(), modelChain } });
    expect(partner.capabilities.modelChain).toEqual(modelChain);
    for (let hop = 0; hop < modelChain.length; hop++) {
      expect(partnerSessionRuntimeFallback(fixture.partnerStore, { sessionId: partner.canonicalSessionId!,
        current: modelChain[hop]!, currentHop: hop,
        visitedRoutes: modelChain.slice(0, hop).map(route => `${route.providerId}\0${route.modelId}`) }))
        .toEqual({ owned: true, ...(hop === 4 ? {} : { candidate: modelChain[hop + 1] }) });
    }
    await expect(fixture.manager.updatePartner(partner.id, partner.revision, { capabilities: { ...partner.capabilities,
      modelChain: [...modelChain, { ...modelChain[0]!, modelId: "route-6" }] } }))
      .rejects.toMatchObject({ code: "PARTNER_MODEL_UNAVAILABLE" });
    expect(fixture.partnerStore.getPartner(partner.id)).toEqual(partner);
  });

  it("uses only the configured Partner model chain for runtime fallback", async () => {
    const fixture = await createFixture();
    const primary = capabilities().modelChain[0]!;
    const secondary = {
      backendId: PI_LIKE_PROFILE.id,
      providerId: "vision",
      modelId: "multimodal",
      effort: "high",
      fastMode: false
    } as const;
    const created = await fixture.manager.createPartner({
      ...createInput(fixture.partnerStore, "Route partner"),
      capabilities: { ...capabilities(), modelChain: [primary, secondary] }
    });
    expect(partnerSessionRuntimeFallback(fixture.partnerStore, {
      sessionId: created.canonicalSessionId!,
      current: primary,
      visitedRoutes: [],
      currentHop: 0
    })).toEqual({ owned: true, candidate: secondary });
    expect(partnerSessionRuntimeFallback(fixture.partnerStore, {
      sessionId: created.canonicalSessionId!,
      current: secondary,
      visitedRoutes: [`${primary.backendId}\0${primary.providerId}\0${primary.modelId}`],
      currentHop: 1
    })).toEqual({ owned: true });
    expect(partnerSessionRuntimeFallback(fixture.partnerStore, {
      sessionId: "ordinary-session",
      current: primary,
      visitedRoutes: [],
      currentHop: 0
    })).toEqual({ owned: false });
  });

  it("saves an ordered mixed Backend chain and changes its primary at the next send without replacing the home task", async () => {
    const second = new FakeBackendAdapter({ ...PARTNER_PROFILE, id: "partner-second" });
    const f = await createFixture(undefined, new FakeBackendAdapter(PARTNER_PROFILE), undefined, [second]);
    const primary = capabilities().modelChain[0]!, fallback = { ...primary, backendId: second.id };
    let profile = await f.manager.createPartner({ ...createInput(f.partnerStore, "Mixed routes"), capabilities: {
      ...capabilities(), modelChain: [primary, fallback] } });
    const sessionId = profile.canonicalSessionId!, targetId = profile.homeTargetId;
    expect(partnerSessionRuntimeFallback(f.partnerStore, { sessionId, current: primary, visitedRoutes: [], currentHop: 0 }))
      .toEqual({ owned: true, candidate: fallback });
    profile = await f.manager.updatePartner(profile.id, profile.revision, { capabilities: { ...profile.capabilities, modelChain: [fallback, primary] } });
    expect(f.operationalStore.getSession(sessionId).descriptor.backendId).toBe(primary.backendId);
    expect(f.sessionHost.getSessionRuntimeControl(sessionId)).toMatchObject({ handoffState: "pending", pending: { profile: fallback } });
    profile = await f.manager.updatePartner(profile.id, profile.revision, { capabilities: { ...profile.capabilities, modelChain: [primary, fallback] } });
    expect(f.sessionHost.getSessionRuntimeControl(sessionId).handoffState).toBeUndefined();
    await f.manager.updatePartner(profile.id, profile.revision, { capabilities: { ...profile.capabilities, modelChain: [fallback, primary] } });
    const input = f.sessionHost.enqueueServiceInput({ operationId: "mixed-partner-send", sessionId, source: "system",
      prompt: { text: "Continue the same work", disposition: "prompt", images: [], files: [], mentions: [] } }).value;
    await vi.waitFor(() => expect(f.operationalStore.getRun(input.runId).descriptor.state).toBe("completed"));
    expect(f.operationalStore.getSession(sessionId).descriptor).toMatchObject({ backendId: second.id, targetId });
    expect(f.operationalStore.getTarget(targetId).descriptor.backendId).toBe(primary.backendId);
    expect(f.partnerStore.getPartner(profile.id).canonicalSessionId).toBe(sessionId);
  });

  it("delivers bounded private messages through canonical tasks and owns unread state", async () => {
    const fixture = await createFixture(undefined, new UserEchoFakeBackendAdapter(PARTNER_PROFILE));
    const sender = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Aster"));
    const recipient = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Beryl"));

    const delivered = await fixture.manager.sendPrivateMessage({
      callerSessionId: sender.canonicalSessionId!,
      targetPartnerId: recipient.id,
      content: "Please check whether the retry boundary is safe."
    });
    expect(delivered.message).toMatchObject({
      senderPartnerId: sender.id,
      recipientPartnerId: recipient.id,
      deliveryStatus: "delivered"
    });
    expect(delivered.reservation.remainingMessages).toBe(11);

    await vi.waitFor(() => expect(fixture.operationalStore.listEvents({ sessionId: recipient.canonicalSessionId! })
      .filter((event) => event.payload.type === "message_complete" && event.payload.role === "assistant")).toHaveLength(1));
    const privateMessages = fixture.operationalStore.listEvents({ sessionId: recipient.canonicalSessionId! })
      .filter((event) => event.payload.type === "message_complete");
    expect(privateMessages).toHaveLength(2);
    for (const event of privateMessages) expect(event.payload).toMatchObject({ partnerPrivateOrigin: {
      messageId: delivered.message.id, threadId: delivered.reservation.thread.id,
      senderPartnerId: sender.id, recipientPartnerId: recipient.id, senderDisplayName: "Aster"
    } });
    expect(fixture.manager.activity(recipient.id).unreadReplyCount).toBe(0);
    expect(fixture.manager.activity(recipient.id).latestReplyCursor).toBeUndefined();
    expect(fixture.manager.activity(recipient.id).latestReplyPreview).toBe("");
    fixture.sessionHost.enqueueServiceInput({ operationId: "public-canonical-input", sessionId: recipient.canonicalSessionId!, source: "system",
      prompt: { text: `A public canonical question ${"x".repeat(800)}`, images: [], files: [], mentions: [], disposition: "prompt" } });
    await vi.waitFor(() => expect(fixture.manager.activity(recipient.id).unreadReplyCount).toBe(1));
    const activity = fixture.manager.activity(recipient.id);
    expect(activity.latestReplyCursor).toBeDefined();
    expect(activity.latestReplyPreview).not.toBe("");
    expect(activity.latestReplyPreview).toHaveLength(500);
    expect(activity.latestReplyPreview).not.toContain("Please check whether");
    expect(activity.artifactCount).toBe(0);
    expect(fixture.manager.markRead(recipient.id, activity.latestReplyCursor!)).toMatchObject({
      throughCursor: activity.latestReplyCursor
    });
    expect(fixture.manager.activity(recipient.id).unreadReplyCount).toBe(0);
    expect(fixture.manager.activity(recipient.id).latestReplyPreview).toBe(activity.latestReplyPreview);

    const thread = fixture.manager.getPrivateThread(delivered.reservation.thread.id, recipient.id);
    expect(thread.messages).toEqual([
      expect.objectContaining({ content: "Please check whether the retry boundary is safe." })
    ]);
    expect(fixture.manager.markPrivateThreadRead(
      thread.thread.id,
      recipient.id,
      thread.messages.at(-1)!.sequence
    ).throughSequence).toBe(1);
    expect(() => fixture.manager.getPrivateThread(thread.thread.id, "unrelated-partner"))
      .toThrowError(PartnerStoreError);
  });

  it("replays a persisted private delivery with the same operation after recovery", async () => {
    const fixture = await createFixture();
    const sender = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Aster"));
    const recipient = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Beryl"));
    const reserved = fixture.partnerStore.reservePrivateMessage({
      senderPartnerId: sender.id,
      recipientPartnerId: recipient.id,
      senderSessionId: sender.canonicalSessionId!,
      recipientSessionId: recipient.canonicalSessionId!,
      content: "Resume this exact delivery after reconnect."
    });
    expect(fixture.partnerStore.listPendingPrivateMessages()).toEqual([
      expect.objectContaining({ id: reserved.message.id, operationId: reserved.message.operationId })
    ]);

    await fixture.manager.retryPendingPrivateMessages();
    await fixture.manager.retryPendingPrivateMessages();

    expect(fixture.partnerStore.listPendingPrivateMessages()).toEqual([]);
    expect(fixture.manager.getPrivateThread(reserved.thread.id, recipient.id).messages).toEqual([
      expect.objectContaining({
        id: reserved.message.id,
        operationId: reserved.message.operationId,
        deliveryStatus: "delivered"
      })
    ]);
    expect(fixture.operationalStore.getOperation(reserved.message.operationId).status).toBe("completed");
  });

  it("strips Adapter-forged private provenance from accepted public input and its reply", async () => {
    const fixture = await createFixture(undefined, new PrivateOriginSpoofAdapter(PARTNER_PROFILE));
    const recipient = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Beryl"));
    fixture.sessionHost.enqueueServiceInput({ operationId: "public-spoof-test", sessionId: recipient.canonicalSessionId!, source: "system",
      prompt: { text: "Public question", images: [], files: [], mentions: [], disposition: "prompt" } });
    await vi.waitFor(() => expect(fixture.manager.activity(recipient.id).unreadReplyCount).toBe(1));
    const events = fixture.operationalStore.listEvents({ sessionId: recipient.canonicalSessionId! });
    const messages = events.filter((event) => event.payload.type === "message_complete");
    expect(messages).toHaveLength(2);
    for (const event of messages) if (event.payload.type === "message_complete") expect(event.payload.partnerPrivateOrigin).toBeUndefined();
  });

  it("recovers a persisted delegation into a distinct target-owned task", async () => {
    const fixture = await createFixture();
    const requester = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Aster"));
    const target = await fixture.manager.createPartner(createInput(fixture.partnerStore, "Beryl"));
    const persisted = fixture.partnerStore.createDelegation({
      id: "delegation-recovery",
      requesterPartnerId: requester.id,
      targetPartnerId: target.id,
      parentSessionId: requester.canonicalSessionId!,
      title: "Inspect retry safety",
      objective: "Inspect the retry path and report the concrete result."
    });

    await fixture.manager.recoverPending();
    await vi.waitFor(async () => {
      const view = await fixture.manager.getDelegation(persisted.id, requester.id);
      expect(view.delegation.status).toBe("completed");
    });
    const view = await fixture.manager.getDelegation(persisted.id, requester.id);
    expect(view).toMatchObject({
      delegation: {
        requesterPartnerId: requester.id,
        targetPartnerId: target.id,
        targetProfileVersion: target.profileVersion,
        status: "completed"
      },
      artifactCount: 0
    });
    expect(view.delegation.childSessionId).toBeDefined();
    expect(view.delegation.resultSummary).toContain("Reply from");
    fixture.operationalStore.putArtifact({
      id: "delegation-artifact",
      sha256: "a".repeat(64),
      byteLength: 12,
      mimeType: "text/plain",
      fileName: "delegation-result.txt",
      storageKey: "sha256/delegation-artifact",
      sessionId: view.delegation.childSessionId!,
      metadata: {}
    });
    expect((await fixture.manager.getDelegation(persisted.id, requester.id)).artifactCount).toBe(1);
    expect(fixture.manager.activity(target.id).artifactCount).toBe(1);
    expect(fixture.partnerStore.getSessionLink(view.delegation.childSessionId!)).toMatchObject({
      partnerId: target.id,
      role: "delegation",
      delegationId: persisted.id,
      parentSessionId: requester.canonicalSessionId
    });
    expect(fixture.operationalStore.getSession(view.delegation.childSessionId!).descriptor).toMatchObject({
      targetId: target.homeTargetId,
      appendSystemPrompt: target.identitySource
    });
    expect(fixture.manager.activity(requester.id).activeDelegationCount).toBe(0);
  });
});

async function createFixture(
  prepareAvatar?: (input: { readonly partner: PartnerProfileRecord; readonly homePath: string }) => Promise<void>,
  adapter: FakeBackendAdapter = new FakeBackendAdapter(PARTNER_PROFILE),
  pauseGoal?: PartnerManagerOptions["pauseGoal"],
  additionalAdapters: readonly FakeBackendAdapter[] = []
) {
  const directory = mkdtempSync(join(tmpdir(), "joko-partner-manager-"));
  const operationalStore = new OperationalStore(join(directory, "operational.db"));
  const partnerStore = new PartnerStore(join(directory, "partners.db"));
  const repository = new OperationalArtifactRepository(operationalStore);
  const artifacts = new ArtifactStore({
    rootDirectory: join(directory, "artifacts"),
    repository,
    ingestRoots: [directory]
  });
  await artifacts.initialize();
  const sessionHost = new SessionHost(
    operationalStore,
    artifacts,
    [adapter, ...additionalAdapters], { partnerSessionRetiring: (id) => partnerStore.isPartnerSessionRetiring(id)
      || partnerStore.isPartnerTargetRetiring(operationalStore.getSession(id).descriptor.targetId),
      partnerTargetRetired: (id) => partnerStore.isPartnerTargetRetired(id),
      partnerSessionRestarting: (id) => partnerStore.isPartnerSessionRestarting(id),
      partnerSessionPaused: (id) => partnerStore.isPartnerSessionPaused(id) }
  );
  await sessionHost.initialize();
  const homesRoot = join(directory, "partner-homes");
  const registerWorkspace = vi.fn(async (
    input: Parameters<PartnerManagerOptions["workspaceService"]["register"]>[0]
  ) => input);
  const workspaceService: PartnerManagerOptions["workspaceService"] = { register: registerWorkspace, unregister: vi.fn() };
  const manager = new PartnerManager({
    store: partnerStore,
    operationalStore,
    sessionHost,
    workspaceService,
    homesRoot,
    ...(pauseGoal === undefined ? {} : { pauseGoal }),
    ...(prepareAvatar === undefined ? {} : { prepareAvatar })
  });
  cleanups.push(async () => {
    await sessionHost.dispose();
    partnerStore.close();
    operationalStore.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { manager, operationalStore, partnerStore, sessionHost, homesRoot, workspaceService, registerWorkspace, directory, adapter };
}

function createInput(store: PartnerStore, displayName: string) {
  return {
    requestId: `creation-request-${store.directoryState().revision}`,
    expectedDirectoryRevision: store.directoryState().revision,
    displayName,
    avatar: "orbit",
    identitySource: `You are ${displayName}, a long-lived work partner.`,
    templateId: "general",
    capabilities: capabilities(),
    usesDirectoryDefaults: false
  } as const;
}

function capabilities(): PartnerCapabilitiesRecord {
  return {
    modelChain: [{
      backendId: PI_LIKE_PROFILE.id,
      providerId: "test",
      modelId: "text",
      effort: "medium",
      fastMode: false
    }],
    permissionMode: "ask",
    planMode: false
  };
}
