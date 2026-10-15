import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { DevelopmentState, PersonalDevelopmentOwner } from "@joko/personal-development";
import { describe, expect, it, vi } from "vitest";

import { createPersonalDevelopmentConnectService } from "./personal-development-connect-service.js";
import type { PersonalDevelopmentCoordinator, PersonalDevelopmentView, PersonalTaskIntent } from "./personal-development-coordinator.js";
import type { PersonalDevelopmentDoctor } from "./personal-development-doctor.js";

function state(): DevelopmentState { return { format: 1, generation: 1, environment: { status: "ready", checks: [
  { id: "node", status: "ready", version: "v22.0.0", executable: "D:\\private-tool\\node.exe" }
] }, source: { status: "ready", channel: "release", version: "0.1.0", commit: "a".repeat(40) }, tasks: {}, history: [],
  versions: { selected: "original", switching: false }, operations: {} }; }
function fixture(available = true) {
  const view: PersonalDevelopmentView = { generation: 1, state: state(), preparations: [], taskStates: {} };
  const build = vi.fn(() => new Promise(() => undefined));
  const prepareSource = vi.fn(() => new Promise(() => undefined));
  const recoverUnknownWriters = vi.fn(() => new Promise(() => undefined));
  const refreshSourceStatus = vi.fn(() => new Promise(() => undefined));
  const owner = { build, prepareSource, recoverUnknownWriters, refreshSourceStatus } as unknown as PersonalDevelopmentOwner;
  const admit = vi.fn(async (id: string, action: () => Promise<unknown>) => { void action().catch(() => undefined); return id; });
  const coordinator = { availability: () => ({ available, reason: available ? "" : "native-host-unavailable" }),
    snapshot: () => view, sourceTarget: async () => ({ channel: "release", version: "0.1.0" }), admit } as unknown as PersonalDevelopmentCoordinator;
  const authenticateLocal = vi.fn();
  const service = createPersonalDevelopmentConnectService({ coordinator: () => coordinator, owner: () => owner, authenticateLocal });
  const controller = new AbortController(), context = { signal: controller.signal } as HandlerContext;
  return { view, coordinator, owner, build, prepareSource, recoverUnknownWriters, refreshSourceStatus, admit, authenticateLocal, service, context, controller };
}

describe("personal development authenticated service", () => {
  it("acknowledges full Settings checks and preparation without waiting for probes and projects the complete environment job", async () => {
    const f = fixture(), operation = { id: "settings-check", kind: "settings-environment-check", inputHash: "private-hash", status: "running" as const, stage: "native", startedAt: 1 };
    Object.assign(f.view, { environment: { status: "checking", platform: "win32", arch: "x64", operation,
      checks: ["platform", "git", "gitLfs", "node", "pnpm", "python", "native", "storage"].map(id => ({ id, status: id === "native" ? "checking" : "ready",
        ...(id === "git" ? { source: "managed", progress: { loaded: 40, total: 80, percent: 50 } } : {}) })) }, environmentOperations: [operation] });
    Object.assign(f.view.state, { operations: { [operation.id]: { ...operation, status: "succeeded" } } });
    const runSettingsEnvironment = vi.fn((input: { operationId: string }) => input.operationId);
    const service = createPersonalDevelopmentConnectService({ coordinator: () => f.coordinator, owner: () => f.owner, authenticateLocal: f.authenticateLocal,
      doctor: () => ({ runSettingsEnvironment }) as unknown as PersonalDevelopmentDoctor });
    const result = await service.runPersonalDevelopmentAction(create(contract.RunPersonalDevelopmentActionRequestSchema,
      { operationId: operation.id, action: { case: "checkEnvironment", value: {} } }), f.context);
    expect(runSettingsEnvironment).toHaveBeenCalledExactlyOnceWith({ operationId: operation.id, mode: "check" }); expect(f.admit).not.toHaveBeenCalled();
    expect(result.state?.environment).toMatchObject({ status: "checking", platform: "win32", arch: "x64", operation: { id: operation.id, status: "running", stage: "native" } });
    expect(result.state?.environment?.checks?.find(check => check.id === "git")).toMatchObject({ source: "managed", progress: { loaded: 40n, total: 80n, percent: 50 } });
    expect(result.state?.environment?.checks).toHaveLength(8); expect(result.state?.operations).toMatchObject([{ id: operation.id, status: "running" }]);
    expect(result.state?.environment?.operation).not.toHaveProperty("inputHash");
    await service.runPersonalDevelopmentAction(create(contract.RunPersonalDevelopmentActionRequestSchema,
      { operationId: "settings-prepare", action: { case: "prepareEnvironment", value: {} } }), f.context);
    expect(runSettingsEnvironment).toHaveBeenLastCalledWith({ operationId: "settings-prepare", mode: "prepare" });
  });

  it("accepts only generated directory choices and rechecks the local authority after the native effect", async () => {
    const f = fixture(), openDirectory = vi.fn(async () => undefined);
    const service = createPersonalDevelopmentConnectService({ coordinator: () => f.coordinator, owner: () => f.owner, authenticateLocal: f.authenticateLocal, openDirectory });
    await expect(service.runPersonalDevelopmentAction(create(contract.RunPersonalDevelopmentActionRequestSchema,
      { operationId: "invalid-directory", action: { case: "openDirectory", value: { directory: 99 as contract.PersonalDevelopmentDirectoryKind } } }), f.context)).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(openDirectory).not.toHaveBeenCalled();
    const result = await service.runPersonalDevelopmentAction(create(contract.RunPersonalDevelopmentActionRequestSchema,
      { operationId: "open-source", action: { case: "openDirectory", value: { directory: contract.PersonalDevelopmentDirectoryKind.SOURCE } } }), f.context);
    expect(result.operationId).toBe("open-source"); expect(openDirectory).toHaveBeenCalledExactlyOnceWith("source", f.controller.signal);
    openDirectory.mockImplementationOnce(async () => { f.authenticateLocal.mockImplementation(() => { throw new ConnectError("Retired local connection.", Code.PermissionDenied); }); });
    await expect(service.runPersonalDevelopmentAction(create(contract.RunPersonalDevelopmentActionRequestSchema,
      { operationId: "open-tools", action: { case: "openDirectory", value: { directory: contract.PersonalDevelopmentDirectoryKind.TOOLS } } }), f.context)).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(openDirectory).toHaveBeenCalledTimes(2); expect(f.admit).not.toHaveBeenCalled();
  });

  it("returns durable operation admission without holding the RPC for the build and omits private executable paths", async () => {
    const f = fixture();
    const response = await f.service.runPersonalDevelopmentAction(create(contract.RunPersonalDevelopmentActionRequestSchema,
      { operationId: "build-personal", action: { case: "build", value: { entryIds: [] } } }), f.context);
    expect(response).toHaveProperty("$typeName", "joko.v1.RunPersonalDevelopmentActionResponse");
    expect(response.operationId).toBe("build-personal");
    expect(f.build).toHaveBeenCalledExactlyOnceWith({ entryIds: [], operationId: "build-personal" });
    expect(f.admit).toHaveBeenCalledOnce();
    expect(response.state?.environment?.checks).toMatchObject([{ id: "node", status: "ready", version: "v22.0.0" }]);
    expect(response.state?.environment?.checks?.[0]).not.toHaveProperty("executable");
    expect(f.authenticateLocal).toHaveBeenCalledWith(f.context);
  });

  it("uses only the verified native source target and reports unavailable instead of inventing a ready host", async () => {
    const f = fixture();
    await expect(f.service.runPersonalDevelopmentAction(create(contract.RunPersonalDevelopmentActionRequestSchema, {
      operationId: "forged-source", action: { case: "prepareSource", value: { channel: "dev", version: "99.0.0" } }
    }), f.context)).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(f.prepareSource).not.toHaveBeenCalled();
    await f.service.runPersonalDevelopmentAction(create(contract.RunPersonalDevelopmentActionRequestSchema, {
      operationId: "verified-source", action: { case: "prepareSource", value: {} }
    }), f.context);
    expect(f.prepareSource).toHaveBeenCalledExactlyOnceWith({ channel: "release", version: "0.1.0", operationId: "verified-source" });
    const unavailable = fixture(false);
    const unavailableState = await unavailable.service.getPersonalDevelopmentState(create(contract.GetPersonalDevelopmentStateRequestSchema), unavailable.context);
    expect(unavailableState).toMatchObject({ $typeName: "joko.v1.GetPersonalDevelopmentStateResponse", available: false, unavailableReason: "native-host-unavailable" });
    expect(unavailableState.state).toBeUndefined();
    await expect(unavailable.service.runPersonalDevelopmentAction(create(contract.RunPersonalDevelopmentActionRequestSchema,
      { operationId: "unavailable-build", action: { case: "build", value: {} } }), unavailable.context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(unavailable.build).not.toHaveBeenCalled();
  });

  it("uses the task control response identity and keeps unavailable watch replies distinct from Get", async () => {
    const f = fixture(), controlTask = vi.fn(async (input: { operationId: string }) => input.operationId);
    Object.assign(f.coordinator, { controlTask });
    const controlled = await f.service.controlPersonalDevelopmentTask(create(contract.ControlPersonalDevelopmentTaskRequestSchema,
      { operationId: "end-task", taskId: "personal-task", action: "end" }), f.context);
    expect(controlled).toMatchObject({ $typeName: "joko.v1.ControlPersonalDevelopmentTaskResponse", operationId: "end-task" });
    expect(controlTask).toHaveBeenCalledExactlyOnceWith({ operationId: "end-task", taskId: "personal-task", action: "end" });
    const unavailable = fixture(false);
    const iterator = unavailable.service.watchPersonalDevelopmentState(create(contract.WatchPersonalDevelopmentStateRequestSchema), unavailable.context)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ $typeName: "joko.v1.WatchPersonalDevelopmentStateResponse", available: false,
      unavailableReason: "native-host-unavailable" });
    expect((await iterator.next()).done).toBe(true);
  });

  it("rejects a paired connection before reading state or admitting effects", async () => {
    const f = fixture();
    f.authenticateLocal.mockImplementation(() => { throw new ConnectError("Committed Desktop connection required.", Code.PermissionDenied); });
    await expect(f.service.getPersonalDevelopmentState(create(contract.GetPersonalDevelopmentStateRequestSchema), f.context))
      .rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(f.service.runPersonalDevelopmentAction(create(contract.RunPersonalDevelopmentActionRequestSchema,
      { operationId: "denied-build", action: { case: "build", value: {} } }), f.context)).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(f.build).not.toHaveBeenCalled(); expect(f.admit).not.toHaveBeenCalled();
  });

  it("acknowledges the cancel request identity while cancelling the exact durable job", async () => {
    const f = fixture(); const cancel = vi.fn(() => true); Object.assign(f.coordinator, { cancel });
    const response = await f.service.runPersonalDevelopmentAction(create(contract.RunPersonalDevelopmentActionRequestSchema,
      { operationId: "cancel-request", action: { case: "cancel", value: { operationId: "building-job" } } }), f.context);
    expect(cancel).toHaveBeenCalledExactlyOnceWith("building-job");
    expect(response.operationId).toBe("cancel-request");
  });

  it("admits proof-only writer recovery under its own identity without replaying or completing the unknown action", async () => {
    const f = fixture(); Object.assign(f.view.state, { operations: { "unknown-build": { id: "unknown-build", kind: "personal-build", inputHash: "0".repeat(64),
      status: "unknown", stage: "building", error: "PROCESS_UNKNOWN", startedAt: 1 } } });
    const response = await f.service.runPersonalDevelopmentAction(create(contract.RunPersonalDevelopmentActionRequestSchema,
      { operationId: "recover-retired-writers", action: { case: "recoverProcesses", value: {} } }), f.context);
    expect(response.operationId).toBe("recover-retired-writers");
    expect(f.recoverUnknownWriters).toHaveBeenCalledExactlyOnceWith({ operationId: "recover-retired-writers" });
    expect(f.admit).toHaveBeenCalledOnce(); expect(f.build).not.toHaveBeenCalled();
    expect(response.state?.operations).toMatchObject([{ id: "unknown-build", status: "unknown", error: "PROCESS_UNKNOWN" }]);
    f.controller.abort(); expect(f.recoverUnknownWriters).toHaveBeenCalledOnce();
    const denied = fixture(); denied.authenticateLocal.mockImplementation(() => { throw new ConnectError("Committed Desktop connection required.", Code.PermissionDenied); });
    await expect(denied.service.runPersonalDevelopmentAction(create(contract.RunPersonalDevelopmentActionRequestSchema,
      { operationId: "denied-recovery", action: { case: "recoverProcesses", value: {} } }), denied.context)).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(denied.recoverUnknownWriters).not.toHaveBeenCalled(); expect(denied.admit).not.toHaveBeenCalled();
  });

  it("projects durable task preparation and only the exact current Owner attempt's progress", async () => {
    const f = fixture();
    const intent: PersonalTaskIntent = { format: 1, ownerId: "personal-owner", taskId: "personal-task", operationId: "start-task", requestHash: "0".repeat(64),
      input: { operationId: "start-task", title: "Personal change", request: "Improve this application", targetId: "local-route", fastMode: false, permissionMode: "ask", planMode: false },
      sourceTargetId: "source-target", creationOperationId: "create-task", sessionId: "code-session", preparationOperationId: "current-attempt",
      status: "running", stage: "preparing-dependencies", startedAt: 1 };
    Object.assign(f.view, { preparations: [intent] });
    Object.assign(f.view.state, { tasks: { "personal-task": { taskId: "personal-task", sessionId: "code-session", leaseId: "task-lease", path: "D:\\private-task",
      branch: "task-branch", baseCommit: "a".repeat(40), request: intent.input.request, title: intent.input.title, status: "preparing", createdAt: 1 } }, operations: {
      "current-attempt": { id: "current-attempt", kind: "task-prepare", inputHash: "0".repeat(64), status: "running", stage: "installing-task-dependencies", startedAt: 1,
        dependencyProgress: { resolved: 121, reused: 80, downloaded: 12, added: 11 } },
      "unrelated-operation": { id: "unrelated-operation", kind: "source-prepare", inputHash: "1".repeat(64), status: "running", stage: "cloning", startedAt: 2, percent: 83 }
    } });
    const first = await f.service.getPersonalDevelopmentState(create(contract.GetPersonalDevelopmentStateRequestSchema), f.context);
    expect(first).toHaveProperty("$typeName", "joko.v1.GetPersonalDevelopmentStateResponse");
    expect(first.state?.tasks?.[0]).toMatchObject({ taskId: "personal-task", sessionId: "code-session", stage: "preparing-dependencies", error: "",
      operation: { id: "current-attempt", stage: "installing-task-dependencies", dependencyProgress: { resolved: 121n, reused: 80n, downloaded: 12n, added: 11n } } });
    expect(first.state?.tasks?.[0]).not.toHaveProperty("path");
    Object.assign(f.view, { preparations: [{ ...intent, status: "failed", stage: "preparation-failed", error: "ENVIRONMENT_NOT_READY", preparationOperationId: "next-attempt" }] });
    Object.assign(f.view.state, { tasks: {} });
    const failed = await f.service.getPersonalDevelopmentState(create(contract.GetPersonalDevelopmentStateRequestSchema), f.context);
    expect(failed.state?.tasks?.[0]).toMatchObject({ taskId: "personal-task", sessionId: "code-session", status: "failed", stage: "preparation-failed", error: "ENVIRONMENT_NOT_READY" });
    expect(failed.state?.tasks?.[0]?.operation).toBeUndefined();
  });

  it("refreshes fixed source status and preserves known zero counts while unavailable comparisons stay absent", async () => {
    const f = fixture(); Object.assign(f.view.state.source, { currentBranch: "joko-personal", baseCommit: "b".repeat(40), mainCommit: "c".repeat(40),
      mainRemoteCommit: "d".repeat(40), mainAhead: 0, personalAhead: 2, latestVersion: { status: "unavailable", channel: "release", checkedAt: 9 } });
    Object.assign(f.view.state.environment.checks[0]!, { source: "managed", status: "extracting", progress: { loaded: 4096, total: null, percent: null } });
    const response = await f.service.runPersonalDevelopmentAction(create(contract.RunPersonalDevelopmentActionRequestSchema,
      { operationId: "refresh-source-card", action: { case: "refreshSourceStatus", value: {} } }), f.context);
    expect(f.refreshSourceStatus).toHaveBeenCalledExactlyOnceWith({ operationId: "refresh-source-card" });
    expect(response.state?.source).toMatchObject({ currentBranch: "joko-personal", baseCommit: "b".repeat(40), mainCommit: "c".repeat(40),
      mainRemoteCommit: "d".repeat(40), mainAhead: 0n, personalAhead: 2n, latestVersion: { status: "unavailable", channel: "release", checkedAtMs: 9n } });
    expect(response.state?.source?.mainBehind).toBeUndefined(); expect(response.state?.source?.personalBehind).toBeUndefined();
    expect(response.state?.source?.latestVersion?.ahead).toBeUndefined(); expect(response.state?.source?.latestVersion?.behind).toBeUndefined();
    const check = response.state?.environment?.checks?.[0];
    expect(check).toMatchObject({ id: "node", source: "managed", status: "extracting", progress: { loaded: 4096n } });
    expect(check?.progress?.total).toBeUndefined(); expect(check?.progress?.percent).toBeUndefined(); expect(check).not.toHaveProperty("executable");
  });

  it("coalesces state by monotonic generation and closes the subscription on cancellation", async () => {
    const f = fixture(); let publish!: (view: PersonalDevelopmentView) => void;
    const unsubscribe = vi.fn();
    Object.assign(f.coordinator, { subscribe: (listener: typeof publish) => { publish = listener; listener({ ...f.view, generation: 3 }); return unsubscribe; } });
    const iterator = f.service.watchPersonalDevelopmentState(create(contract.WatchPersonalDevelopmentStateRequestSchema, { afterGeneration: 2n }), f.context)[Symbol.asyncIterator]();
    const first = (await iterator.next()).value;
    expect(first).toHaveProperty("$typeName", "joko.v1.WatchPersonalDevelopmentStateResponse");
    expect(first?.state?.generation).toBe(3n);
    publish({ ...f.view, generation: 5 }); publish({ ...f.view, generation: 4 });
    expect((await iterator.next()).value?.state?.generation).toBe(5n);
    Object.assign(f.coordinator, { availability: () => ({ available: false, reason: "native-host-unavailable" }) });
    publish({ ...f.view, generation: 6 });
    expect((await iterator.next()).value).toMatchObject({ $typeName: "joko.v1.WatchPersonalDevelopmentStateResponse", available: false,
      unavailableReason: "native-host-unavailable" });
    f.controller.abort(); expect((await iterator.next()).done).toBe(true); expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
