import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { PersonalDevelopmentError, type DevelopmentOperationResult, type PersonalDevelopmentOwner } from "@joko/personal-development";

import { personalDevelopmentIdentity, type PersonalDevelopmentCoordinator, type PersonalDevelopmentView } from "./personal-development-coordinator.js";
import type { PersonalDevelopmentDoctor } from "./personal-development-doctor.js";
import { createPersonalDevelopmentDoctorConnectMethods, toProtoPersonalDevelopmentCheck, toProtoPersonalDevelopmentDoctorRun, toProtoPersonalDevelopmentOperation } from "./personal-development-doctor-connect.js";

/** Only the committed local Desktop connection can use this surface. The
 * renderer has no native host key and cannot choose service-side paths. */
export function createPersonalDevelopmentConnectService(options: {
  readonly coordinator: () => PersonalDevelopmentCoordinator | undefined;
  readonly owner: () => PersonalDevelopmentOwner | undefined;
  readonly authenticateLocal: (context: HandlerContext) => unknown;
  readonly doctor?: () => PersonalDevelopmentDoctor | undefined;
  readonly openDirectory?: (directory: "source" | "tools", signal: AbortSignal) => Promise<void>;
}): ServiceImpl<typeof contract.PersonalDevelopmentService> {
  const requireOwner = () => { const owner = options.owner(); if (owner === undefined) throw unavailable(); return owner; };
  const requireCoordinator = () => {
    const coordinator = options.coordinator();
    if (coordinator === undefined || !coordinator.availability().available) throw unavailable(); return coordinator;
  };
  const response = async (context: HandlerContext): Promise<{ readonly available: boolean; readonly unavailableReason: string; readonly state?: contract.PersonalDevelopmentState }> => {
    options.authenticateLocal(context);
    const coordinator = options.coordinator(), availability = coordinator?.availability();
    if (coordinator === undefined || availability?.available !== true) return { available: false, unavailableReason: availability?.reason ?? "native-host-unavailable" };
    const target = await coordinator.sourceTarget(); options.authenticateLocal(context);
    return { available: true, unavailableReason: "", state: toProtoPersonalDevelopmentState(coordinator.snapshot(), target) };
  };
  return {
    ...createPersonalDevelopmentDoctorConnectMethods(options),
    getPersonalDevelopmentState: (_request, context) => rpc(async () => create(contract.GetPersonalDevelopmentStateResponseSchema, await response(context))),
    watchPersonalDevelopmentState: async function* (request, context) {
      options.authenticateLocal(context);
      if (request.afterGeneration < 0n || request.afterGeneration > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConnectError("The personal state generation is invalid.", Code.InvalidArgument);
      const coordinator = options.coordinator();
      if (coordinator === undefined || !coordinator.availability().available) { yield create(contract.WatchPersonalDevelopmentStateResponseSchema, await response(context)); return; }
      let latest: PersonalDevelopmentView | undefined, wake: (() => void) | undefined;
      let after = Number(request.afterGeneration);
      const unsubscribe = coordinator.subscribe(view => { if (view.generation > Math.max(after, latest?.generation ?? after)) { latest = view; wake?.(); } });
      const abort = () => wake?.(); context.signal.addEventListener("abort", abort, { once: true });
      try {
        while (!context.signal.aborted) {
          if (latest === undefined) await new Promise<void>(resolveWait => { wake = resolveWait; if (latest !== undefined || context.signal.aborted) resolveWait(); });
          wake = undefined; if (context.signal.aborted) break;
          const view = latest; latest = undefined; if (view === undefined || view.generation <= after) continue;
          options.authenticateLocal(context);
          if (!coordinator.availability().available) { yield create(contract.WatchPersonalDevelopmentStateResponseSchema, await response(context)); continue; }
          const target = await coordinator.sourceTarget(); options.authenticateLocal(context);
          after = view.generation;
          yield create(contract.WatchPersonalDevelopmentStateResponseSchema, { available: true, state: toProtoPersonalDevelopmentState(view, target) });
        }
      } finally { unsubscribe(); context.signal.removeEventListener("abort", abort); }
    },
    runPersonalDevelopmentAction: (request, context) => rpc(async () => {
      options.authenticateLocal(context);
      personalDevelopmentIdentity(request.operationId);
      const action = request.action;
      if (action.case === "cancel") {
        const coordinator = options.coordinator(); if (coordinator === undefined) throw unavailable();
        coordinator.cancel(action.value.operationId);
        const state = await response(context); return create(contract.RunPersonalDevelopmentActionResponseSchema, { operationId: request.operationId, state: state.state });
      }
      const coordinator = requireCoordinator(), owner = requireOwner();
      if ((action.case === "checkEnvironment" || action.case === "prepareEnvironment") && options.doctor?.() !== undefined) {
        context.signal.throwIfAborted();
        const operationId = options.doctor!()!.runSettingsEnvironment({ operationId: request.operationId, mode: action.case === "checkEnvironment" ? "check" : "prepare" });
        const state = await response(context); return create(contract.RunPersonalDevelopmentActionResponseSchema, { operationId, state: state.state });
      }
      if (action.case === "openDirectory") {
        const directory = action.value.directory === contract.PersonalDevelopmentDirectoryKind.SOURCE ? "source"
          : action.value.directory === contract.PersonalDevelopmentDirectoryKind.TOOLS ? "tools" : undefined;
        if (directory === undefined) throw invalid(); if (!options.openDirectory) throw unavailable(); context.signal.throwIfAborted();
        await options.openDirectory(directory, context.signal); options.authenticateLocal(context); context.signal.throwIfAborted();
        const state = await response(context); return create(contract.RunPersonalDevelopmentActionResponseSchema, { operationId: request.operationId, state: state.state });
      }
      let run: () => Promise<DevelopmentOperationResult<unknown>>;
      switch (action.case) {
        case "checkEnvironment": run = () => owner.checkEnvironment({ operationId: request.operationId }); break;
        case "prepareEnvironment": run = () => owner.prepareEnvironment({ operationId: request.operationId }); break;
        case "prepareSource": {
          const target = await coordinator.sourceTarget(); options.authenticateLocal(context);
          if (action.value.channel !== "" && action.value.channel !== target.channel || action.value.version !== "" && action.value.version !== target.version) throw invalid();
          run = () => owner.prepareSource({ ...target, operationId: request.operationId }); break;
        }
        case "clearSource": run = () => owner.clearSource({ operationId: request.operationId }); break;
        case "refreshSourceStatus": run = () => owner.refreshSourceStatus({ operationId: request.operationId }); break;
        case "mergeSource": {
          const value = action.value.action; if (value !== "start" && value !== "resolve" && value !== "adopt" && value !== "cancel") throw invalid();
          const operationId = coordinator.mergeSource({ action: value, operationId: request.operationId,
            ...(action.value.targetId ? { targetId: action.value.targetId } : {}) });
          const state = await response(context); return create(contract.RunPersonalDevelopmentActionResponseSchema, { operationId, state: state.state });
        }
        case "history": {
          const value = action.value.action; if (value !== "integrate" && value !== "revert" && value !== "reapply" && value !== "hide") throw invalid();
          run = () => owner.actHistory({ entryId: personalDevelopmentIdentity(action.value.entryId), action: value, operationId: request.operationId }); break;
        }
        case "build": run = () => owner.build({ ...(action.value.taskId ? { taskId: personalDevelopmentIdentity(action.value.taskId) } : {}),
          entryIds: action.value.entryIds.map(personalDevelopmentIdentity), operationId: request.operationId }); break;
        case "recoverBuild": run = () => owner.recoverBuild({ operationId: request.operationId }); break;
        case "recoverProcesses": run = () => owner.recoverUnknownWriters({ operationId: request.operationId }); break;
        case "syncLatestBeforeBuild": run = () => owner.setSyncLatestBeforeBuild({ enabled: action.value.enabled, operationId: request.operationId }); break;
        case "version": {
          const id = action.value.id, value = action.value.action;
          if (id !== "original" && id !== "personal" || value !== "switch" && value !== "remove") throw invalid();
          run = () => owner.actVersion({ id, action: value, operationId: request.operationId }); break;
        }
        case "revealBuild": run = () => owner.revealBuild({ operationId: request.operationId }); break;
        default: throw invalid();
      }
      const operationId = await coordinator.admit(request.operationId, run);
      const state = await response(context); return create(contract.RunPersonalDevelopmentActionResponseSchema, { operationId, state: state.state });
    }),
    startPersonalDevelopmentTask: (request, context) => rpc(async () => {
      options.authenticateLocal(context); const coordinator = requireCoordinator();
      if (request.permissionMode !== "ask" && request.permissionMode !== "acceptEdits" && request.permissionMode !== "auto" && request.permissionMode !== "bypassPermissions") throw invalid();
      const intent = await coordinator.startTask({ operationId: request.operationId, request: request.request, title: request.title,
        targetId: request.targetId, fastMode: request.fastMode, permissionMode: request.permissionMode, planMode: request.planMode,
        ...(request.originSessionId ? { originSessionId: request.originSessionId } : {}), ...(request.providerId ? { providerId: request.providerId } : {}),
        ...(request.modelId ? { modelId: request.modelId } : {}), ...(request.effort ? { effort: request.effort } : {}) });
      const state = await response(context); return create(contract.StartPersonalDevelopmentTaskResponseSchema,
        { operationId: intent.operationId, taskId: intent.taskId, sessionId: intent.sessionId ?? "", state: state.state });
    }),
    controlPersonalDevelopmentTask: (request, context) => rpc(async () => {
      options.authenticateLocal(context);
      const action = request.action; if (action !== "continue" && action !== "end" && action !== "start_test" && action !== "stop_test" && action !== "retry_preparation") throw invalid();
      const operationId = await requireCoordinator().controlTask({ operationId: request.operationId, taskId: request.taskId,
        action, ...(request.message ? { message: request.message } : {}) });
      const state = await response(context); return create(contract.ControlPersonalDevelopmentTaskResponseSchema, { operationId, state: state.state });
    })
  } satisfies ServiceImpl<typeof contract.PersonalDevelopmentService>;
}

export function toProtoPersonalDevelopmentState(view: PersonalDevelopmentView, target: { readonly channel: string; readonly version: string }): contract.PersonalDevelopmentState {
  const state = view.state;
  const operations = Object.values(state.operations).map(toProtoPersonalDevelopmentOperation);
  const ownerOperations = new Map(operations.map(operation => [operation.id, operation]));
  for (const intent of view.preparations) if (!state.operations[intent.operationId]) operations.push(create(contract.PersonalDevelopmentOperationSchema, { id: intent.operationId, kind: "task-start",
    status: intent.status === "ended" ? "succeeded" : intent.status, stage: intent.stage, error: intent.error ?? "",
    startedAtMs: BigInt(intent.startedAt), finishedAtMs: 0n, diagnostics: [] }));
  for (const operation of view.mergeOperations ?? []) {
    const index = operations.findIndex(item => item.id === operation.id);
    const projection = create(contract.PersonalDevelopmentOperationSchema, { id: operation.id, kind: operation.kind, status: operation.status, stage: operation.stage, error: operation.error ?? "",
      startedAtMs: BigInt(operation.startedAt), finishedAtMs: BigInt(operation.finishedAt ?? 0), diagnostics: [] });
    if (index < 0) operations.push(projection); else operations[index] = projection;
  }
  for (const operation of view.environmentOperations ?? []) {
    const index = operations.findIndex(item => item.id === operation.id), projection = toProtoPersonalDevelopmentOperation(operation);
    if (index < 0) operations.push(projection); else operations[index] = projection;
  }
  const preparation = (taskId: string) => {
    const intent = view.preparations.find(value => value.taskId === taskId);
    const candidate = intent?.preparationOperationId === undefined ? undefined : ownerOperations.get(intent.preparationOperationId);
    const operation = candidate?.kind === "task-prepare" ? candidate : undefined;
    return { stage: intent?.stage ?? "", error: intent?.error ?? "", ...(operation === undefined ? {} : { operation }) };
  };
  const tasks = Object.values(state.tasks).map(task => create(contract.PersonalDevelopmentTaskSchema,
    { taskId: task.taskId, sessionId: task.sessionId, title: task.title, request: task.request,
      status: view.taskStates[task.taskId]?.editing === "unknown" ? "unknown"
        : view.taskStates[task.taskId]?.editing === "completing" ? "completing" : task.status,
      baseCommit: task.baseCommit, branch: task.branch, completionId: task.completionId ?? "", createdAtMs: BigInt(task.createdAt), ...preparation(task.taskId) }));
  for (const intent of view.preparations) if (!state.tasks[intent.taskId]) tasks.push(create(contract.PersonalDevelopmentTaskSchema,
    { taskId: intent.taskId, sessionId: intent.sessionId ?? "", title: intent.input.title, request: intent.input.request,
      status: intent.status === "running" ? "preparing" : intent.status, createdAtMs: BigInt(intent.startedAt), ...preparation(intent.taskId) }));
  return create(contract.PersonalDevelopmentStateSchema, {
    generation: BigInt(view.generation), environment: { status: (view.environment ?? state.environment).status,
      checks: (view.environment ?? state.environment).checks.map(toProtoPersonalDevelopmentCheck),
      ...(view.environment?.operation ? { operation: toProtoPersonalDevelopmentOperation(view.environment.operation) } : {}),
      platform: view.environment?.platform ?? "", arch: view.environment?.arch ?? "" },
    source: { status: state.source.status, channel: state.source.channel ?? "", version: state.source.version ?? "", ref: state.source.ref ?? "",
      commit: state.source.commit ?? "", upstreamCommit: state.source.upstreamCommit ?? "", error: state.source.error ?? "",
      targetChannel: target.channel, targetVersion: target.version,
      currentBranch: state.source.currentBranch ?? "", baseCommit: state.source.baseCommit ?? "",
      mainCommit: state.source.mainCommit ?? "", mainRemoteCommit: state.source.mainRemoteCommit ?? "",
      ...(state.source.mainAhead === undefined ? {} : { mainAhead: BigInt(state.source.mainAhead) }),
      ...(state.source.mainBehind === undefined ? {} : { mainBehind: BigInt(state.source.mainBehind) }),
      ...(state.source.personalAhead === undefined ? {} : { personalAhead: BigInt(state.source.personalAhead) }),
      ...(state.source.personalBehind === undefined ? {} : { personalBehind: BigInt(state.source.personalBehind) }),
      ...(state.source.latestVersion === undefined ? {} : { latestVersion: { status: state.source.latestVersion.status, channel: state.source.latestVersion.channel,
        ref: state.source.latestVersion.ref ?? "", commit: state.source.latestVersion.commit ?? "", checkedAtMs: BigInt(state.source.latestVersion.checkedAt),
        ...(state.source.latestVersion.ahead === undefined ? {} : { ahead: BigInt(state.source.latestVersion.ahead) }),
        ...(state.source.latestVersion.behind === undefined ? {} : { behind: BigInt(state.source.latestVersion.behind) }) } }) }, tasks,
    history: state.history.map(entry => ({ id: entry.id, taskId: entry.taskId, sessionId: entry.sessionId, title: entry.title,
      baseCommit: entry.baseCommit, tree: entry.tree, commit: entry.commit, state: entry.state, hidden: entry.hidden ?? false, createdAtMs: BigInt(entry.createdAt) })),
    versions: { selected: state.versions.selected, switching: state.versions.switching,
      currentId: state.versions.currentId ?? "", currentGeneration: state.versions.currentGeneration ?? "",
      originalVersion: state.versions.original?.version ?? "", originalDevelopment: state.versions.original?.development ?? false,
      pendingStatus: state.versions.pendingHandoff?.status ?? "",
      ...(state.versions.personal === undefined ? {} : { personal: { generation: state.versions.personal.id, commit: state.versions.personal.commit,
        tree: state.versions.personal.tree, createdAtMs: BigInt(state.versions.personal.createdAt) } }) },
    operations,
    ...(state.merge === undefined ? {} : { merge: { id: state.merge.id, status: state.merge.status,
      sessionId: view.mergeSessions?.find(session => session.mergeId === state.merge!.id)?.sessionId ?? "",
      baselineCommit: state.merge.baselineCommit, upstreamCommit: state.merge.upstreamCommit } }),
    tests: Object.entries(state.tests ?? {}).map(([taskId, test]) => ({ taskId, completionId: test.completionId, status: test.status })),
    syncLatestBeforeBuild: state.syncLatestBeforeBuild ?? false,
    doctorRuns: (view.doctorRuns ?? []).map(toProtoPersonalDevelopmentDoctorRun)
  });
}

function invalid() { return new ConnectError("The personal development action is invalid.", Code.InvalidArgument); }
function unavailable() { return new ConnectError("A verified local Desktop development host is required.", Code.FailedPrecondition); }
async function rpc<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error instanceof ConnectError) throw error;
    if (error instanceof PersonalDevelopmentError) throw new ConnectError(`Personal development action failed: ${error.code}.`,
      error.code === "INVALID_ARGUMENT" || error.code === "INVALID_VERSION" ? Code.InvalidArgument
        : error.code === "CANCELLED" ? Code.Canceled : error.code === "BUSY" ? Code.Aborted : Code.FailedPrecondition);
    throw new ConnectError("The personal development action could not be confirmed.", Code.Internal);
  }
}
