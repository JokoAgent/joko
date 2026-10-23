import { create } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import type { Transport } from "@connectrpc/connect";
import {
  PartnerDelegationStatus,
  PartnerInitializationState,
  PartnerInvitationStage,
  PartnerLifecycle,
  PartnerPrivateMessageDeliveryStatus,
  PartnerPrivateThreadCloseReason,
  PartnerPrivateThreadStatus,
  PartnerSessionRole,
  PermissionMode
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway, mapSnapshot } from "./gateway.js";
import * as contract from "@joko/contracts";

describe("Partner gateway", () => {
  it("keeps the private-input switch independent of tool settings through generated owner requests", async () => {
    const requests: Array<{ method: string; input: any; signal?: AbortSignal }> = []; let inputHandoff: boolean | undefined;
    const gateway = connectedGateway(partnerTransport(method => {
      const result = partnerResponse(method);
      return ["getPartner", "createPartner", "updatePartner"].includes(method)
        ? { ...result, partner: { ...profile(), capabilities: { ...capabilities(), inputHandoff } } } : result;
    }, requests));
    await gateway.connect(); expect((await gateway.getPartner("partner-one")).capabilities.inputHandoff).toBe(true);
    inputHandoff = false;
    expect((await gateway.getPartner("partner-one")).capabilities.inputHandoff).toBe(false);
    await gateway.updatePartner("partner-one", 8n, { inputHandoff: false });
    expect(requests.find(request => request.method === "updatePartner")?.input.patch).toMatchObject({ inputHandoff: false });
    await gateway.updatePartnerDefaults(4n, { ...capabilities(), permissionMode: "ask", inputHandoff: false });
    expect(requests.find(request => request.method === "updatePartnerDefaults")?.input.capabilities.inputHandoff).toBe(false);
    gateway.disconnect();
  });
  it("strictly roundtrips Partner permission values for defaults create and profile writes", async () => {
    const requests: Array<{ method: string; input: any; signal?: AbortSignal }> = [];
    let mode = PermissionMode.ASK;
    const gateway = connectedGateway(partnerTransport(method => {
      const result = partnerResponse(method);
      if (["getPartnerDirectory", "updatePartnerDefaults"].includes(method)) return { ...result, directory: { ...directory(), defaultCapabilities: { ...capabilities(), permissionMode: mode } }, affectedPartners: [] };
      if (["getPartner", "createPartner", "updatePartner"].includes(method)) return { ...result, partner: { ...profile(), capabilities: { ...capabilities(), permissionMode: mode } } };
      return result;
    }, requests));
    await gateway.connect();
    for (const [wire, ui] of [[PermissionMode.ASK, "ask"], [PermissionMode.ACCEPT_EDITS, "acceptEdits"], [PermissionMode.AUTO, "auto"], [PermissionMode.BYPASS_PERMISSIONS, "bypassPermissions"]] as const) {
      mode = wire;
      const caps = { ...capabilities(), permissionMode: ui };
      expect((await gateway.getPartnerDirectory()).defaultCapabilities?.permissionMode).toBe(ui);
      expect((await gateway.getPartner("partner-one")).capabilities.permissionMode).toBe(ui);
      await gateway.updatePartnerDefaults(4n, caps);
      await gateway.createPartner(4n, { displayName: "Aster", avatar: "orbit", identitySource: "You are Aster.", templateId: "general", capabilities: caps, usesDirectoryDefaults: false }, `permission-request-${ui}`);
      await gateway.updatePartner("partner-one", 8n, { permissionMode: ui });
      expect(requests.filter(request => request.method === "updatePartnerDefaults").at(-1)?.input.capabilities.permissionMode).toBe(wire);
      expect(requests.filter(request => request.method === "createPartner").at(-1)?.input.draft.capabilities.permissionMode).toBe(wire);
      expect(requests.filter(request => request.method === "updatePartner").at(-1)?.input.patch.permissionMode).toBe(wire);
    }
    gateway.disconnect();
  });

  it("rejects unknown Partner permission output and trusted alias input without dispatch", async () => {
    const requests: Array<{ method: string; input: any }> = [];
    const gateway = connectedGateway(partnerTransport(method => method === "getPartner"
      ? { partner: { ...profile(), capabilities: { ...capabilities(), permissionMode: 99 } } } : partnerResponse(method), requests));
    await gateway.connect();
    await expect(gateway.getPartner("partner-one")).rejects.toThrow("unsupported Partner permission mode");
    await expect(gateway.updatePartner("partner-one", 8n, { permissionMode: "trusted" as never })).rejects.toThrow("permission mode is invalid");
    expect(requests.some(request => request.method === "updatePartner")).toBe(false);
    gateway.disconnect();
  });

  it("projects and sends one typed task model preference independently of primary defaults", async () => {
    const task = { backendId: "task-backend", providerId: "task-provider", modelId: "task-model", effort: "medium", fastMode: false };
    const requests: Array<{ method: string; input: any; signal?: AbortSignal }> = [];
    const current = { ...profile(), taskModelOverride: task };
    const gateway = connectedGateway(partnerTransport(method => method === "getPartner" ? { partner: current }
      : method === "updatePartner" ? { partner: current, directory: directory() } : partnerResponse(method), requests));
    await gateway.connect();
    await expect(gateway.getPartner("partner-one")).resolves.toMatchObject({ taskModelOverride: task });
    await gateway.updatePartner("partner-one", 8n, { usesDirectoryDefaults: true, taskModelOverride: task });
    await gateway.updatePartner("partner-one", 8n, { taskModelOverride: null });
    const updates = requests.filter(request => request.method === "updatePartner");
    expect(updates[0]!.input.patch).toMatchObject({ usesDirectoryDefaults: true, taskModelPreference: { case: "taskModelOverride", value: task } });
    expect(updates[0]!.input.patch.modelChain).toBeUndefined();
    expect(updates[1]!.input.patch.taskModelPreference).toEqual({ case: "inheritTaskModel", value: true });
    gateway.disconnect();
  });

  afterEach(() => vi.restoreAllMocks());
  it("projects strict paused metadata and sends a revision-fenced resume through the generated lifecycle service", async () => {
    let current = { ...profile(), lifecycle: contract.PartnerLifecycle.PAUSED, pauseCleanupPending: false as boolean | undefined };
    const requests: Array<{ method: string; input: any; signal?: AbortSignal }> = [];
    const gateway = connectedGateway(partnerTransport(method => method === "getPartner" ? { partner: current }
      : method === "setPartnerLifecycle" ? { partner: current = { ...current, lifecycle: contract.PartnerLifecycle.ACTIVE,
        pauseCleanupPending: undefined, revision: { ...current.revision!, value: 9n } }, directory: directory() }
        : method === "listPartners" ? { partners: [current], directory: directory() } : partnerResponse(method), requests));
    await gateway.connect(); expect((await gateway.listPartners("paused")).partners[0]).toMatchObject({ lifecycle: "paused", pauseCleanupPending: false });
    expect(requests.find(entry => entry.method === "listPartners")?.input.lifecycle).toBe(contract.PartnerLifecycle.PAUSED);
    const resumed = await gateway.setPartnerLifecycle("partner-one", 8n, "active"); expect(resumed.partner.lifecycle).toBe("active");
    expect(requests.find(entry => entry.method === "setPartnerLifecycle")?.input).toMatchObject({ partnerId: "partner-one", expectedRevision: { value: 8n }, lifecycle: contract.PartnerLifecycle.ACTIVE });
    current = { ...current, lifecycle: contract.PartnerLifecycle.PAUSED }; await expect(gateway.getPartner("partner-one")).rejects.toThrow(/pause state/u);
    gateway.disconnect();
  });

  it("uses current Host restart controls and exact revision-fenced, body-free restart receipts", async () => {
    const requestId = "restart-web-gateway-intent";
    const restart = { requestId, partnerId: "partner-one", phase: contract.PartnerRestartPhase.CLOSING,
      runtimeClosePending: true, createdAt: timestamp(1n), updatedAt: timestamp(2n) };
    let mode: "valid" | "identity" | "phase" | "retired" | "delayed" = "valid"; let finish!: (value: object) => void;
    const requests: Array<{ method: string; input: any; signal?: AbortSignal }> = [];
    const gateway = connectedGateway(partnerTransport((method) => {
      if (method === "getPartnerRestartControls") return { revision: { value: 8n }, available: true };
      if (method === "listPartners") return { ...partnerResponse(method), pendingRestarts: [restart] };
      if (!["restartPartner", "getPartnerRestart", "retryPartnerRestart", "retirePartnerRestart"].includes(method)) return partnerResponse(method);
      if (mode === "delayed") return new Promise<object>((resolve) => { finish = resolve; });
      if (mode === "retired") return { retired: true };
      return { restart: { ...restart, ...(mode === "identity" ? { partnerId: "another-partner" } : {}),
        ...(mode === "phase" ? { phase: contract.PartnerRestartPhase.UNSPECIFIED } : {}) } };
    }, requests));
    await gateway.connect(); expect(await gateway.getPartnerRestartControls("partner-one")).toEqual({ revision: 8n, available: true });
    expect((await gateway.listPartners()).pendingRestarts?.[0]).toMatchObject({ requestId, phase: "closing", runtimeClosePending: true });
    expect(await gateway.restartPartner(requestId, "partner-one", 8n)).toMatchObject({ requestId, phase: "closing" });
    expect(requests.find((request) => request.method === "restartPartner")?.input).toMatchObject({ requestId, partnerId: "partner-one", expectedRevision: { value: 8n } });
    expect(await gateway.retryPartnerRestart(requestId)).toMatchObject({ requestId });
    mode = "identity"; await expect(gateway.restartPartner(requestId, "partner-one", 8n)).rejects.toThrow(/owner/u);
    mode = "phase"; await expect(gateway.getPartnerRestart(requestId)).rejects.toThrow(/state/u);
    mode = "retired"; expect(await gateway.retirePartnerRestart(requestId)).toEqual({ retired: true });
    mode = "delayed"; const pending = gateway.getPartnerRestart(requestId); const rejected = expect(pending).rejects.toThrow();
    gateway.disconnect(); finish({ restart }); await rejected;
  });
  it("uses revision-fenced deletion RPCs and rejects malformed or late owner receipts", async () => {
    const requestId = "deletion-web-gateway-intent";
    const deletion = { requestId, partnerId: "partner-one", phase: contract.PartnerDeletionPhase.CLOSING,
      failure: contract.PartnerDeletionFailure.RUNTIME_CLOSE_PENDING, createdAt: timestamp(1n), updatedAt: timestamp(2n) };
    let mode: "valid" | "identity" | "phase" | "absent" | "retired" | "contradiction" | "delayed" = "valid";
    let finish!: (value: object) => void;
    const requests: Array<{ method: string; input: any; signal?: AbortSignal }> = [];
    const gateway = connectedGateway(partnerTransport((method) => {
      if (method === "listPartners") return { ...partnerResponse(method), pendingDeletions: [deletion] };
      if (!["deletePartner", "getPartnerDeletion", "retryPartnerDeletion", "retirePartnerDeletion"].includes(method)) return partnerResponse(method);
      if (mode === "delayed") return new Promise<object>((resolve) => { finish = resolve; });
      if (mode === "absent") return {};
      if (mode === "retired") return { retired: true };
      return { deletion: { ...deletion, ...(mode === "identity" ? { partnerId: "another-partner" } : {}),
        ...(mode === "phase" ? { phase: contract.PartnerDeletionPhase.UNSPECIFIED } : {}) }, retired: mode === "contradiction" };
    }, requests));
    await gateway.connect();
    expect((await gateway.listPartners()).pendingDeletions?.[0]).toMatchObject({ requestId, phase: "closing", failure: "runtime_close_pending" });
    expect(await gateway.deletePartner(requestId, "partner-one", 8n, "Partner One")).toMatchObject({ requestId, phase: "closing" });
    expect(requests.find((request) => request.method === "deletePartner")?.input).toMatchObject({ requestId, partnerId: "partner-one",
      expectedRevision: { value: 8n }, confirmName: "Partner One" });
    expect(await gateway.retryPartnerDeletion(requestId)).toMatchObject({ requestId });
    mode = "identity"; await expect(gateway.deletePartner(requestId, "partner-one", 8n, "Partner One")).rejects.toThrow(/owner/u);
    mode = "phase"; await expect(gateway.getPartnerDeletion(requestId)).rejects.toThrow(/state/u);
    mode = "contradiction"; await expect(gateway.retirePartnerDeletion(requestId)).rejects.toThrow(/invalid/u);
    mode = "absent"; expect(await gateway.getPartnerDeletion(requestId)).toEqual({ retired: false });
    await expect(gateway.retirePartnerDeletion(requestId)).rejects.toThrow(/invalid/u);
    mode = "retired"; expect(await gateway.retirePartnerDeletion(requestId)).toEqual({ retired: true });
    mode = "delayed"; const pending = gateway.getPartnerDeletion(requestId); const rejected = expect(pending).rejects.toThrow();
    gateway.disconnect(); finish({ deletion }); await rejected;
  });

  it("projects the exact active Attempt and uses an authenticated, fenced working-caption RPC", async () => {
    const facts = { sessionId: "session-one", targetId: "partner-home-one", backendId: "backend-1", generation: 3n,
      runId: "run-one", attemptId: "attempt-one", phase: contract.PartnerWorkingPhase.READING_FILE, caption: "Considering file structure" };
    const wire = create(contract.SnapshotSchema, { generation: 1n, sessions: [{ sessionId: facts.sessionId, targetId: facts.targetId,
      backendId: facts.backendId, location: { kind: { case: "serviceNode", value: {} } }, state: contract.SessionState.RUNNING,
      nativeBinding: { runtimeGeneration: 3n } }], runs: [{ runId: facts.runId, sessionId: facts.sessionId, targetId: facts.targetId,
      backendId: facts.backendId, state: contract.RunState.RUNNING, activeAttemptId: facts.attemptId, version: { generation: 3n } }] });
    expect(mapSnapshot(wire).sessions[0]).toMatchObject({ activeRunId: facts.runId, activeAttemptId: facts.attemptId });
    wire.runs[0]!.version!.generation = 4n;
    expect(mapSnapshot(wire).sessions[0]?.activeAttemptId).toBeUndefined();
    let mode: "valid" | "nil" | "attempt" | "phase" | "invalid" | "delayed" = "valid";
    let finish!: (value: object) => void;
    const requests: Array<{ method: string; input: any; signal?: AbortSignal }> = [];
    const gateway = connectedGateway(partnerTransport((method) => {
      if (method === "getPartner") return { partner: { ...profile(), activity: { ...activity(), latestReplyPreview: "Public reply", workingStatus: facts } } };
      if (method !== "readPartnerWorkingStatus") return partnerResponse(method);
      if (mode === "nil") return {};
      if (mode === "delayed") return new Promise<object>((resolve) => { finish = resolve; });
      return { workingStatus: { ...facts, ...(mode === "attempt" ? { attemptId: "old-attempt" } : {}),
        ...(mode === "phase" ? { phase: contract.PartnerWorkingPhase.CHECKING } : {}),
        ...(mode === "invalid" ? { caption: "Reading D:/private/file" } : {}) } };
    }, requests));
    await gateway.connect();
    const status = (await gateway.getPartner("partner-one")).activity.workingStatus!;
    expect(status).toMatchObject({ phase: "reading-file", attemptId: facts.attemptId });
    expect(await gateway.readPartnerWorkingStatus("partner-one", status, "zh-CN")).toBe(facts.caption);
    expect(requests.find((request) => request.method === "readPartnerWorkingStatus")?.input).toMatchObject({ partnerId: "partner-one",
      sessionId: facts.sessionId, generation: 3n, runId: facts.runId, attemptId: facts.attemptId, phase: facts.phase, locale: "zh-CN" });
    for (const invalid of ["attempt", "phase", "invalid"] as const) {
      mode = invalid; await expect(gateway.readPartnerWorkingStatus("partner-one", status, "en")).rejects.toThrow();
    }
    mode = "nil"; expect(await gateway.readPartnerWorkingStatus("partner-one", status, "en")).toBeUndefined();
    mode = "delayed"; const abort = new AbortController();
    const pending = gateway.readPartnerWorkingStatus("partner-one", status, "en", abort.signal);
    const rejected = expect(pending).rejects.toThrow();
    abort.abort(); finish({ workingStatus: facts }); await rejected;
    gateway.disconnect();
  });

  it("reads only a current typed image and verifies its metadata and SHA before rendering", async () => {
    const bytes = new Uint8Array([255, 216, 255, 219]);
    const image = { sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/jpeg" as const, byteLength: bytes.length };
    let invalid = false;
    const requests: Array<{ method: string; input: any; signal?: AbortSignal }> = [];
    const gateway = connectedGateway(partnerTransport((method) => method === "readPartnerAvatar"
      ? { image: { ...image, byteLength: BigInt(image.byteLength) }, content: invalid ? new Uint8Array([255, 216, 255, 220]) : bytes }
      : partnerResponse(method), requests));
    await gateway.connect();
    expect(await gateway.readPartnerAvatar("partner-one", 8n, image)).toBe("data:image/jpeg;base64,/9j/2w==");
    expect(requests.find((request) => request.method === "readPartnerAvatar")?.input).toMatchObject({ partnerId: "partner-one",
      expectedRevision: { value: 8n }, sha256: image.sha256 });
    invalid = true; await expect(gateway.readPartnerAvatar("partner-one", 8n, image)).rejects.toThrow(/verification/u);
    gateway.disconnect();
  });

  it("uses generated workbench RPCs and rejects stale owners, revisions, details and unknown states", async () => {
    const owner = { partnerId: "partner-one", profileVersion: 2n, sessionId: "session-one", sessionGeneration: 1n, targetId: "home-one" };
    let mismatch: "owner" | "revision" | "task" | "state" | "routine" | "routine-status" | "pr-reference" | "pr-state" | "stop-reason" | "next-run" | undefined;
    const task = () => ({ id: mismatch === "task" ? "task:other" : "task:one", kind: contract.PartnerWorkbenchTaskKind.SESSION, project: "D:/project", title: "Draft",
      state: mismatch === "state" ? contract.PartnerWorkbenchTaskState.UNSPECIFIED : contract.PartnerWorkbenchTaskState.STOPPED, group: contract.PartnerWorkbenchGroup.WAITING, updatedAt: timestamp(3n), sourceLabel: "Task",
      stopReason: mismatch === "stop-reason" ? contract.PartnerWorkbenchStopReason.UNSPECIFIED : contract.PartnerWorkbenchStopReason.FAILED,
      ...(mismatch === "next-run" ? { nextRunAt: timestamp(15n) } : {}),
      pullRequest: { reference: { referenceKey: "code.example/acme/work#42", host: "code.example", repositoryOwner: "acme", repositoryName: "work", number: 42n,
        webUrl: mismatch === "pr-reference" ? "https://user:secret@code.example/acme/work/pull/42" : "https://code.example/acme/work/pull/42" },
        observed: true, state: mismatch === "pr-state" ? contract.CodeHostPullRequestState.UNSPECIFIED : contract.CodeHostPullRequestState.MERGED,
        draft: false, title: "Change", headBranch: "topic", observedAt: timestamp(10n) } });
    const workbench = () => ({ owner: { ...owner, profileVersion: mismatch === "owner" ? 3n : owner.profileVersion }, revision: revision(mismatch === "revision" ? 1n : 2n), tasks: [task(), {
      id: "routine:standing", kind: contract.PartnerWorkbenchTaskKind.AUTOMATION, project: "", title: "Standing review", state: contract.PartnerWorkbenchTaskState.AUTOMATION, group: contract.PartnerWorkbenchGroup.DONE, nextRunAt: timestamp(15n),
      routine: { id: mismatch === "routine" ? "other" : "standing", enabled: true, triggers: [{ id: "time", kind: { case: "interval", value: { intervalMs: 3_600_000n } } }],
        lastRunStatus: mismatch === "routine-status" ? contract.RoutineRunStatus.UNSPECIFIED : contract.RoutineRunStatus.SUCCESS, lastRunSummary: "Reviewed" }
    }], projects: [{ path: "D:/project", name: "project", exists: true }] });
    const requests: Array<{ method: string; input: any; signal?: AbortSignal }> = [];
    const gateway = connectedGateway(partnerTransport((method) => {
      if (method === "getPartnerWorkbenchDetail") return { detail: { task: task(), transcript: [{ role: "assistant", text: "Private reply", privateMessageOrigin: { messageId: "message", threadId: "thread", senderPartnerId: "sender", recipientPartnerId: owner.partnerId, senderDisplayName: "Sender" } }] } };
      if (method === "resolvePartnerWorkbenchReference") return { kind: "file", value: "D:/project/README.md", workspaceId: "read-only", relativePath: "README.md" };
      if (method === "readPartnerWorkbenchDocument") return { path: "D:/project/README.md", text: "Context" };
      if (method.includes("Workbench")) return { workbench: workbench(), acceptedProject: "D:/project" };
      return partnerResponse(method);
    }, requests));
    await gateway.connect();
    const view = await gateway.getPartnerWorkbench(owner.partnerId);
    expect(view.tasks[0]).toMatchObject({ state: "stopped", group: "waiting", stopReason: "failed", pullRequest: { number: 42, projection: { state: "merged" } } });
    expect(view.tasks[1]?.nextRunAt).toBe(15_000);
    expect(view.tasks[1]).toMatchObject({ routine: { id: "standing", enabled: true, triggers: [{ kind: { case: "interval", value: { intervalMs: 3_600_000n } } }], lastRunSummary: "Reviewed" } });
    expect(await gateway.addPartnerWorkbenchProject(owner, 1n, "D:/project")).toMatchObject({ acceptedProject: "D:/project" });
    await gateway.removePartnerWorkbenchProject(owner, 1n, "D:/project");
    await gateway.setPartnerWorkbenchJudgment(owner, 1n, { taskId: "task:one", project: "D:/project", title: "Draft", verdict: "unfinished", next: "Finish" });
    expect((await gateway.getPartnerWorkbenchDetail(owner, "task:one")).transcript[0]?.privateMessageOrigin).toMatchObject({ threadId: "thread", senderDisplayName: "Sender" });
    expect(await gateway.resolvePartnerWorkbenchReference(owner, "D:/project/README.md")).toMatchObject({ workspaceId: "read-only" });
    expect(await gateway.readPartnerWorkbenchDocument(owner, "D:/project/README.md")).toMatchObject({ text: "Context" });
    expect(requests.filter((request) => request.method.includes("Workbench")).map((request) => request.method)).toEqual(["getPartnerWorkbench", "addPartnerWorkbenchProject", "removePartnerWorkbenchProject", "setPartnerWorkbenchJudgment", "getPartnerWorkbenchDetail", "resolvePartnerWorkbenchReference", "readPartnerWorkbenchDocument"]);
    mismatch = "owner"; await expect(gateway.addPartnerWorkbenchProject(owner, 1n, "D:/project")).rejects.toThrow();
    mismatch = "revision"; await expect(gateway.removePartnerWorkbenchProject(owner, 2n, "D:/project")).rejects.toThrow();
    mismatch = "task"; await expect(gateway.getPartnerWorkbenchDetail(owner, "task:one")).rejects.toThrow();
    mismatch = "state"; await expect(gateway.getPartnerWorkbench(owner.partnerId)).rejects.toThrow();
    mismatch = "routine"; await expect(gateway.getPartnerWorkbench(owner.partnerId)).rejects.toThrow();
    mismatch = "routine-status"; await expect(gateway.getPartnerWorkbench(owner.partnerId)).rejects.toThrow();
    for (const invalid of ["pr-reference", "pr-state", "stop-reason", "next-run"] as const) {
      mismatch = invalid; await expect(gateway.getPartnerWorkbench(owner.partnerId)).rejects.toThrow();
    }
    gateway.disconnect();
  });

  it("uses every generated Partner RPC and preserves revisions, inheritance, and model axes", async () => {
    const requests: Array<{ readonly method: string; readonly input: any; readonly signal?: AbortSignal }> = [];
    const transport = partnerTransport((method) => partnerResponse(method), requests);
    const gateway = connectedGateway(transport);
    await gateway.connect();
    const signal = new AbortController().signal;

    await expect(gateway.getPartnerDirectory(signal)).resolves.toMatchObject({
      revision: 4n,
      activeCount: 1,
      defaultCapabilities: { permissionMode: "ask", modelChain: [{ modelId: "model-1", effort: "medium" }] }
    });
    await expect(gateway.listPartners("active", signal)).resolves.toMatchObject({
      partners: [{ id: "partner-one", lifecycle: "active", initializationState: "ready", canonicalSessionId: "session-one" }]
    });
    await expect(gateway.getPartner("partner-one", signal)).resolves.toMatchObject({ id: "partner-one", profileVersion: 2n });
    await gateway.createPartner(4n, {
      displayName: "Aster",
      avatar: "orbit",
      identitySource: "You are Aster.",
      templateId: "general",
      usesDirectoryDefaults: true
    }, "creation-request-gateway", signal);
    await expect(gateway.getPartnerCreation("creation-request-gateway", signal)).resolves.toMatchObject({ partner: { id: "partner-one" } });
    await expect(gateway.retirePartnerCreation("creation-request-gateway", signal)).resolves.toMatchObject({ partner: { id: "partner-one" } });
    await gateway.updatePartner("partner-one", 8n, {
      displayName: "Aster Prime",
      modelChain: [{ backendId: "backend-1", providerId: "provider-1", modelId: "model-2", effort: "high", fastMode: true }],
      permissionMode: "auto",
      planMode: true,
      usesDirectoryDefaults: false
    }, signal);
    await gateway.setPartnerLifecycle("partner-one", 8n, "archived", signal);
    await gateway.retryPartnerInitialization("partner-one", 8n, signal);
    await gateway.updatePartnerDefaults(4n, {
      modelChain: [{ backendId: "backend-1", providerId: "provider-1", modelId: "model-1", effort: "medium", fastMode: false }],
      permissionMode: "ask",
      planMode: false
    }, signal);
    await expect(gateway.listPartnerSessions("partner-one", signal)).resolves.toEqual([
      expect.objectContaining({ sessionId: "session-one", role: "canonical", readOnly: false })
    ]);
    await expect(gateway.markPartnerRead("partner-one", 12n, signal)).resolves.toMatchObject({
      readThroughCursor: 12n,
      unreadReplyCount: 0
    });
    await expect(gateway.listPartnerPrivateThreads("partner-one", signal)).resolves.toEqual([
      expect.objectContaining({ id: "thread-one", status: "closed", closeReason: "messageLimit" })
    ]);
    await expect(gateway.getPartnerPrivateThread("partner-one", "thread-one", signal)).resolves.toMatchObject({
      thread: { id: "thread-one" },
      messages: [{ id: "message-one", deliveryStatus: "delivered" }]
    });
    await expect(gateway.markPartnerPrivateThreadRead("partner-one", "thread-one", 1, signal))
      .resolves.toMatchObject({ throughSequence: 1 });
    await expect(gateway.listPartnerDelegations("partner-one", signal)).resolves.toEqual([
      expect.objectContaining({ id: "delegation-one", status: "running" })
    ]);
    await expect(gateway.getPartnerDelegation("partner-one", "delegation-one", signal))
      .resolves.toMatchObject({ id: "delegation-one", childSessionId: "session-child" });
    await expect(gateway.cancelPartnerDelegation("partner-one", "delegation-one", 3n, signal))
      .resolves.toMatchObject({ id: "delegation-one" });

    const methods = [
      "getPartnerDirectory", "listPartners", "getPartner", "createPartner", "getPartnerCreation", "retirePartnerCreation", "updatePartner",
      "setPartnerLifecycle", "retryPartnerInitialization", "updatePartnerDefaults",
      "listPartnerSessions", "markPartnerRead", "listPartnerPrivateThreads", "getPartnerPrivateThread",
      "markPartnerPrivateThreadRead", "listPartnerDelegations", "getPartnerDelegation", "cancelPartnerDelegation"
    ];
    expect(requests.filter((entry) => methods.includes(entry.method)).map((entry) => entry.method)).toEqual(methods);
    expect(requests.find((entry) => entry.method === "listPartners")?.input).toEqual({ lifecycle: PartnerLifecycle.ACTIVE });
    expect(requests.find((entry) => entry.method === "createPartner")?.input).toMatchObject({
      requestId: "creation-request-gateway",
      expectedDirectoryRevision: { value: 4n },
      draft: { displayName: "Aster", usesDirectoryDefaults: true }
    });
    expect(requests.find((entry) => entry.method === "createPartner")?.input.draft.capabilities).toBeUndefined();
    expect(requests.find((entry) => entry.method === "updatePartner")?.input).toMatchObject({
      partnerId: "partner-one",
      expectedRevision: { value: 8n },
      patch: {
        displayName: "Aster Prime",
        modelChain: { routes: [{ modelId: "model-2", effort: "high", fastMode: true }] },
        permissionMode: PermissionMode.AUTO,
        planMode: true,
        usesDirectoryDefaults: false
      }
    });
    expect(requests.find((entry) => entry.method === "setPartnerLifecycle")?.input.lifecycle).toBe(PartnerLifecycle.ARCHIVED);
    expect(requests.filter((entry) => methods.includes(entry.method)).every((entry) => entry.signal instanceof AbortSignal && !entry.signal.aborted)).toBe(true);
    gateway.disconnect();
  });

  it("rejects inconsistent creation retirement receipts and retires late lookup results on disconnect", async () => {
    let mode: "inconsistent" | "absent" | "late" = "inconsistent";
    let release!: (value: ReturnType<typeof partnerResponse>) => void;
    const pending = new Promise<ReturnType<typeof partnerResponse>>((resolve) => { release = resolve; });
    const gateway = connectedGateway(partnerTransport((method) => {
      if (method === "retirePartnerCreation") return { retired: true, directory: directory(), ...(mode === "inconsistent" ? { partner: profile() } : {}) };
      if (method === "getPartnerCreation" && mode === "late") return pending;
      return partnerResponse(method);
    }));
    await gateway.connect();
    await expect(gateway.retirePartnerCreation("creation-request-gateway")).rejects.toThrow(/inconsistent/iu);
    mode = "absent";
    await expect(gateway.retirePartnerCreation("creation-request-gateway")).resolves.toMatchObject({ directory: { revision: 4n } });
    mode = "late";
    const lookup = gateway.getPartnerCreation("creation-request-gateway");
    const assertion = expect(lookup).rejects.toThrow();
    gateway.disconnect();
    release(partnerResponse("getPartnerCreation"));
    await assertion;
  });

  it("projects all five routes and rejects a sixth at the generated Partner boundary", async () => {
    const modelChain = Array.from({ length: 5 }, (_, index) => ({ ...capabilities().modelChain[0]!, modelId: `model-${index + 1}` }));
    let profileValue = { ...profile(), capabilities: { ...capabilities(), modelChain } };
    const gateway = connectedGateway(partnerTransport(method => method === "listPartners"
      ? { partners: [profileValue], directory: directory() } : partnerResponse(method)));
    await gateway.connect();
    expect((await gateway.listPartners()).partners[0]?.capabilities.modelChain).toEqual(modelChain);
    profileValue = { ...profileValue, capabilities: { ...profileValue.capabilities,
      modelChain: [...modelChain, { ...modelChain[0]!, modelId: "model-6" }] } };
    await expect(gateway.listPartners()).rejects.toThrow(/model chain/iu);
    gateway.disconnect();
  });

  it("fails closed for unknown enums and duplicate model-chain identities", async () => {
    let profileValue = profile();
    const transport = partnerTransport((method) => {
      if (method === "listPartners") return { partners: [profileValue], directory: directory() };
      return partnerResponse(method);
    });
    const gateway = connectedGateway(transport);
    await gateway.connect();

    profileValue = { ...profile(), lifecycle: PartnerLifecycle.UNSPECIFIED };
    await expect(gateway.listPartners()).rejects.toThrow(/unknown Partner lifecycle/iu);
    profileValue = {
      ...profile(),
      capabilities: {
        ...capabilities(),
        modelChain: [capabilities().modelChain[0]!, capabilities().modelChain[0]!]
      }
    };
    await expect(gateway.listPartners()).rejects.toThrow(/inconsistent Partner model chain/iu);
    profileValue = { ...profile(), canonicalSessionId: "" };
    await expect(gateway.listPartners()).rejects.toThrow(/incomplete Partner profile/iu);
    gateway.disconnect();
  });

  it("fails closed when private-thread or delegation ownership drifts", async () => {
    let mode: "thread" | "delegation" | "state" = "thread";
    const transport = partnerTransport((method) => {
      if (method === "getPartnerPrivateThread" && mode === "thread") {
        return {
          thread: privateThread(),
          messages: [{ ...privateMessage(), senderPartnerId: "partner-other" }],
          readState: privateReadState()
        };
      }
      if (method === "listPartnerDelegations" && mode === "delegation") {
        return { delegations: [{ ...delegation(), requesterPartnerId: "partner-other" }] };
      }
      if (method === "getPartnerDelegation" && mode === "state") {
        return {
          delegation: {
            ...delegation(),
            status: PartnerDelegationStatus.COMPLETED,
            completedAt: timestamp(6n)
          }
        };
      }
      return partnerResponse(method);
    });
    const gateway = connectedGateway(transport);
    await gateway.connect();

    await expect(gateway.getPartnerPrivateThread("partner-one", "thread-one"))
      .rejects.toThrow(/mismatched Partner private thread/iu);
    mode = "delegation";
    await expect(gateway.listPartnerDelegations("partner-one"))
      .rejects.toThrow(/owned by another Partner/iu);
    mode = "state";
    await expect(gateway.getPartnerDelegation("partner-one", "delegation-one"))
      .rejects.toThrow(/inconsistent Partner delegation/iu);
    gateway.disconnect();
  });
});

function connectedGateway(transport: Transport) {
  return createOrchestratorGateway(
    { id: "profile", deviceId: "device", name: "Node", origin: "https://service.example", serverId: "node" },
    "fixture-auth",
    {},
    () => transport
  );
}

function partnerTransport(
  value: (method: string) => object | Promise<object>,
  requests: Array<{ readonly method: string; readonly input: any; readonly signal?: AbortSignal }> = []
): Transport {
  return {
    unary: vi.fn(async (method: any, signal: AbortSignal | undefined, _timeout: unknown, _headers: unknown, input: any) => {
      requests.push({ method: method.localName, input, signal });
      return response(method, create(method.output, await value(method.localName)));
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
}

function partnerResponse(method: string): object {
  if (method === "getSnapshot") return { snapshot: {} };
  if (method === "getPartnerDirectory") return { directory: directory() };
  if (method === "listPartners") return { partners: [profile()], directory: directory() };
  if (method === "getPartner") return { partner: profile() };
  if (method === "retirePartnerCreation") return { retired: false, partner: profile(), directory: directory() };
  if (method === "updatePartnerDefaults") return { directory: directory(), affectedPartners: [profile()] };
  if (method === "listPartnerSessions") return { sessions: [partnerSession()] };
  if (method === "markPartnerRead") return { activity: activity(12n, 0n) };
  if (method === "listPartnerPrivateThreads") return { threads: [privateThread()] };
  if (method === "getPartnerPrivateThread") {
    return { thread: privateThread(), messages: [privateMessage()], readState: privateReadState() };
  }
  if (method === "markPartnerPrivateThreadRead") return { readState: privateReadState() };
  if (method === "listPartnerDelegations") return { delegations: [delegation()] };
  if (method === "getPartnerDelegation" || method === "cancelPartnerDelegation") return { delegation: delegation() };
  if (["createPartner", "getPartnerCreation", "updatePartner", "setPartnerLifecycle", "retryPartnerInitialization"].includes(method)) {
    return { partner: profile(), directory: directory() };
  }
  throw new Error(`Unexpected RPC ${method}`);
}

function revision(value: bigint) { return { value }; }
function timestamp(seconds: bigint) { return { seconds, nanos: 0 }; }
function capabilities() {
  return {
    modelChain: [{ backendId: "backend-1", providerId: "provider-1", modelId: "model-1", effort: "medium", fastMode: false }],
    permissionMode: PermissionMode.ASK,
    planMode: false
  };
}
function directory() {
  return {
    revision: revision(4n),
    activeCount: 1,
    archivedCount: 0,
    errorCount: 0,
    updatedAt: timestamp(4n),
    templates: [{ templateId: "general", displayName: "General", description: "Everyday work", identitySource: "You are a partner." }],
    avatarPresets: ["orbit", "spark"],
    defaultCapabilities: capabilities()
  };
}
function profile() {
  return {
    partnerId: "partner-one",
    revision: revision(8n),
    profileVersion: 2n,
    displayName: "Aster",
    avatar: { value: { case: "presetId" as const, value: "orbit" } },
    identitySource: "You are Aster.",
    templateId: "general",
    lifecycle: PartnerLifecycle.ACTIVE,
    initializationState: PartnerInitializationState.READY,
    invitationStage: PartnerInvitationStage.READY,
    homeTargetId: "partner-home-one",
    canonicalSessionId: "session-one",
    capabilities: capabilities(),
    createdAt: timestamp(1n),
    updatedAt: timestamp(3n),
    usesDirectoryDefaults: true,
    activity: activity(4n, 2n)
  };
}
function activity(readThrough = 4n, unread = 2n) {
  return {
    partnerId: "partner-one",
    unreadReplyCount: unread,
    latestReplyCursor: revision(12n),
    latestReplyAt: timestamp(6n),
    artifactCount: 3n,
    activeDelegationCount: 1n,
    readThroughCursor: revision(readThrough),
    readUpdatedAt: timestamp(5n)
  };
}
function partnerSession() {
  return {
    sessionId: "session-one",
    partnerId: "partner-one",
    role: PartnerSessionRole.CANONICAL,
    profileVersion: 2n,
    displayName: "Aster",
    available: true,
    readOnly: false,
    archived: false,
    deleted: false,
    createdAt: timestamp(1n),
    lastActivityAt: timestamp(6n)
  };
}
function privateThread() {
  return {
    threadId: "thread-one",
    firstPartnerId: "partner-one",
    secondPartnerId: "partner-two",
    status: PartnerPrivateThreadStatus.CLOSED,
    closeReason: PartnerPrivateThreadCloseReason.MESSAGE_LIMIT,
    messageCount: 1,
    maxMessages: 12,
    expiresAt: timestamp(20n),
    blockedUntil: timestamp(20n),
    createdAt: timestamp(2n),
    updatedAt: timestamp(3n),
    closedAt: timestamp(3n)
  };
}
function privateMessage() {
  return {
    messageId: "message-one",
    threadId: "thread-one",
    sequence: 1n,
    senderPartnerId: "partner-one",
    recipientPartnerId: "partner-two",
    content: "Please inspect the boundary.",
    deliveryStatus: PartnerPrivateMessageDeliveryStatus.DELIVERED,
    createdAt: timestamp(2n),
    deliveredAt: timestamp(2n)
  };
}
function privateReadState() {
  return {
    threadId: "thread-one",
    partnerId: "partner-one",
    throughSequence: 1n,
    updatedAt: timestamp(4n)
  };
}
function delegation() {
  return {
    delegationId: "delegation-one",
    revision: revision(3n),
    requesterPartnerId: "partner-one",
    targetPartnerId: "partner-two",
    parentSessionId: "session-one",
    targetProfileVersion: 2n,
    title: "Inspect retry safety",
    objective: "Inspect the retry boundary.",
    status: PartnerDelegationStatus.RUNNING,
    childSessionId: "session-child",
    runId: "run-child",
    artifactCount: 2n,
    createdAt: timestamp(4n),
    updatedAt: timestamp(5n),
    startedAt: timestamp(5n)
  };
}
function response(method: any, message: any, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}
async function* idleStream(): AsyncIterable<never> { await new Promise<never>(() => undefined); }
