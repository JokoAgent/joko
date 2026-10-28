import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { PersonalDevelopmentError, type DevelopmentOperation } from "@joko/personal-development";
import type { PersonalDevelopmentDoctor } from "./personal-development-doctor.js";
import type { DevelopmentDoctorCheck, DevelopmentDoctorRun } from "./personal-development-doctor-types.js";

export function toProtoPersonalDevelopmentCheck(check: DevelopmentDoctorCheck): contract.PersonalDevelopmentToolCheck {
  return create(contract.PersonalDevelopmentToolCheckSchema, { id: check.id, status: check.status, version: check.version ?? "", reason: check.reason ?? "",
    freeGib: check.freeGiB ?? 0, source: check.source ?? "", ...(check.progress ? { progress: { loaded: BigInt(check.progress.loaded),
      ...(check.progress.total === null ? {} : { total: BigInt(check.progress.total) }), ...(check.progress.percent === null ? {} : { percent: check.progress.percent }) } } : {}) });
}
export function toProtoPersonalDevelopmentOperation(operation: DevelopmentOperation): contract.PersonalDevelopmentOperation {
  return create(contract.PersonalDevelopmentOperationSchema, { id: operation.id, kind: operation.kind, status: operation.status, stage: operation.stage,
    error: operation.error ?? "", startedAtMs: BigInt(operation.startedAt), finishedAtMs: BigInt(operation.finishedAt ?? 0),
    ...(operation.percent === undefined ? {} : { percent: operation.percent }),
    ...(operation.dependencyProgress ? { dependencyProgress: { resolved: BigInt(operation.dependencyProgress.resolved), reused: BigInt(operation.dependencyProgress.reused),
      downloaded: BigInt(operation.dependencyProgress.downloaded), added: BigInt(operation.dependencyProgress.added) } } : {}),
    diagnostics: (operation.diagnostics ?? []).map(diagnostic => ({ stage: diagnostic.stage, code: diagnostic.code, ...(diagnostic.exitCode === undefined ? {} : { exitCode: diagnostic.exitCode }) })) });
}

export function toProtoPersonalDevelopmentDoctorRun(report: DevelopmentDoctorRun): contract.PersonalDevelopmentDoctorRun {
  return create(contract.PersonalDevelopmentDoctorRunSchema, { runId: report.runId, sessionId: report.sessionId, mode: report.mode, request: report.request,
    status: report.status, stage: report.stage, decision: report.decision ?? "", taskId: report.taskId ?? "", codeSessionId: report.codeSessionId ?? "",
    error: report.error ?? "", platform: report.platform, arch: report.arch, attempt: report.attempt,
    createdAtMs: BigInt(report.createdAt), updatedAtMs: BigInt(report.updatedAt),
    checks: report.checks.map(toProtoPersonalDevelopmentCheck),
    ...(report.source ? { source: { status: report.source.status, channel: report.source.channel ?? "", version: report.source.version ?? "",
      ref: report.source.ref ?? "", commit: report.source.commit ?? "", upstreamCommit: report.source.upstreamCommit ?? "", error: report.source.error ?? "" } } : {}),
    ...(report.operation ? { operation: toProtoPersonalDevelopmentOperation(report.operation) } : {}),
    ...(report.upstream ? { upstream: { status: report.upstream.status, items: report.upstream.items.map(item => ({ ...item })),
      terms: [...(report.upstream.terms ?? [])], ...(report.upstream.runtime ? { runtime: report.upstream.runtime } : {}),
      excludedIncluded: report.upstream.excludedIncluded ?? 0, hasMore: report.upstream.hasMore ?? false, failure: report.upstream.failure ?? "" } } : {}) });
}
export function createPersonalDevelopmentDoctorConnectMethods(options: {
  readonly doctor?: () => PersonalDevelopmentDoctor | undefined; readonly authenticateLocal: (context: HandlerContext) => unknown;
}): Pick<ServiceImpl<typeof contract.PersonalDevelopmentService>, "startPersonalDevelopmentDoctor" | "controlPersonalDevelopmentDoctor"> {
  const owner = () => { const value = options.doctor?.(); if (!value) throw new ConnectError("Local development diagnostics are unavailable.", Code.FailedPrecondition); return value; };
  return {
    startPersonalDevelopmentDoctor: (request, context) => rpc(async () => {
      options.authenticateLocal(context); context.signal.throwIfAborted();
      if (request.mode !== "check" && request.mode !== "prepare" || !["ask", "acceptEdits", "auto", "bypassPermissions"].includes(request.permissionMode)) throw new ConnectError("Invalid diagnostics request.", Code.InvalidArgument);
      const report = await owner().start({ operationId: request.operationId, ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        mode: request.mode, request: request.request, title: request.title, targetId: request.targetId,
        ...(request.providerId ? { providerId: request.providerId } : {}), ...(request.modelId ? { modelId: request.modelId } : {}), ...(request.effort ? { effort: request.effort } : {}),
        fastMode: contract.decodeModelSpeed(request), permissionMode: request.permissionMode as "ask", planMode: request.planMode });
      options.authenticateLocal(context); context.signal.throwIfAborted();
      return create(contract.StartPersonalDevelopmentDoctorResponseSchema, { operationId: request.operationId, report: toProtoPersonalDevelopmentDoctorRun(report) });
    }),
    controlPersonalDevelopmentDoctor: (request, context) => rpc(async () => {
      options.authenticateLocal(context); context.signal.throwIfAborted();
      if (request.action !== "cancel" && request.action !== "retry" && request.action !== "wait" && request.action !== "personal") throw new ConnectError("Invalid diagnostics action.", Code.InvalidArgument);
      const report = await owner().control({ operationId: request.operationId, runId: request.runId, action: request.action });
      options.authenticateLocal(context); context.signal.throwIfAborted();
      return create(contract.ControlPersonalDevelopmentDoctorResponseSchema, { operationId: request.operationId, report: toProtoPersonalDevelopmentDoctorRun(report) });
    })
  };
}
async function rpc<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error instanceof ConnectError) throw error;
    if (error instanceof PersonalDevelopmentError) throw new ConnectError(`Personal development diagnostics failed: ${error.code}.`,
      error.code === "INVALID_ARGUMENT" ? Code.InvalidArgument : error.code === "BUSY" ? Code.Aborted : Code.FailedPrecondition);
    throw new ConnectError("Personal development diagnostics could not be confirmed.", Code.Internal);
  }
}
