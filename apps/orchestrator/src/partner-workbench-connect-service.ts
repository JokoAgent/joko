import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { PartnerWorkbenchTask, PartnerWorkbenchJudgment, PartnerWorkbenchProjectBrief } from "@joko/core";
import { PartnerWorkbenchStoreError } from "@joko/store";
import { PartnerWorkbenchError, type PartnerWorkbenchManager, type PartnerWorkbenchOwner, type PartnerWorkbenchStateView } from "./partner-workbench-manager.js";
import { PartnerWorkbenchProjectError } from "./partner-workbench-project.js";
import { fromProtoRevision, toProtoRevision, toProtoTimestamp } from "./proto-mapper.js";

type Methods = "getPartnerWorkbench" | "addPartnerWorkbenchProject" | "removePartnerWorkbenchProject" | "setPartnerWorkbenchJudgment"
  | "getPartnerWorkbenchDetail" | "resolvePartnerWorkbenchReference" | "readPartnerWorkbenchDocument";

export function createPartnerWorkbenchConnectMethods(manager: PartnerWorkbenchManager | undefined, authenticate: (context: HandlerContext) => unknown): Pick<ServiceImpl<typeof contract.PartnerService>, Methods> {
  const owner = (): PartnerWorkbenchManager => { if (manager === undefined) throw new ConnectError("Partner workbenches are unavailable.", Code.Unimplemented); return manager; };
  const rpc = async <T>(context: HandlerContext, action: () => Promise<T>): Promise<T> => {
    authenticate(context);
    try { const result = await action(); authenticate(context); return result; }
    catch (error) {
      if (error instanceof ConnectError) throw error;
      if (error instanceof PartnerWorkbenchStoreError) throw new ConnectError(error.message, error.code === "conflict" ? Code.Aborted : error.code === "invalid" ? Code.InvalidArgument : error.code === "resource_exhausted" ? Code.ResourceExhausted : Code.FailedPrecondition);
      if (error instanceof PartnerWorkbenchError) throw new ConnectError(error.message, error.code === "WORKBENCH_INVALID" ? Code.InvalidArgument : error.code === "WORKBENCH_OWNER_CHANGED" ? Code.Aborted : error.code === "WORKBENCH_TASK_NOT_FOUND" ? Code.NotFound : Code.FailedPrecondition);
      if (error instanceof PartnerWorkbenchProjectError) throw new ConnectError(error.message, error.code === "PROJECT_PATH_INVALID" ? Code.InvalidArgument : Code.FailedPrecondition);
      throw new ConnectError("The workbench source is unavailable. Refresh and retry.", Code.Unavailable);
    }
  };
  return {
    getPartnerWorkbench: (request, context) => rpc(context, async () => create(contract.GetPartnerWorkbenchResponseSchema, { workbench: toProtoWorkbench(await owner().readState(request.partnerId)) })),
    addPartnerWorkbenchProject: (request, context) => rpc(context, async () => {
      const view = await owner().addProject(fromProtoWorkbenchOwner(request.owner), fromProtoRevision(request.expectedRevision, "expected_revision"), request.path);
      return create(contract.AddPartnerWorkbenchProjectResponseSchema, { workbench: toProtoWorkbench(view), acceptedProject: view.acceptedProject });
    }),
    removePartnerWorkbenchProject: (request, context) => rpc(context, async () => create(contract.RemovePartnerWorkbenchProjectResponseSchema, { workbench: toProtoWorkbench(await owner().removeProject(fromProtoWorkbenchOwner(request.owner), fromProtoRevision(request.expectedRevision, "expected_revision"), request.path)) })),
    setPartnerWorkbenchJudgment: (request, context) => rpc(context, async () => {
      const judgment = request.judgment;
      if (judgment === undefined) throw new ConnectError("judgment is required.", Code.InvalidArgument);
      return create(contract.SetPartnerWorkbenchJudgmentResponseSchema, { workbench: toProtoWorkbench(await owner().setJudgment(fromProtoWorkbenchOwner(request.owner), fromProtoRevision(request.expectedRevision, "expected_revision"), {
        taskId: judgment.taskId, project: judgment.project, title: judgment.title, verdict: fromProtoVerdict(judgment.verdict), next: judgment.next ?? null,
        ...(judgment.ref === undefined ? {} : { ref: judgment.ref })
      })) });
    }),
    getPartnerWorkbenchDetail: (request, context) => rpc(context, async () => {
      const detail = await owner().readDetail(fromProtoWorkbenchOwner(request.owner), request.taskId);
      return create(contract.GetPartnerWorkbenchDetailResponseSchema, { detail: create(contract.PartnerWorkbenchDetailSchema, {
        task: toProtoTask(detail.task), truncated: detail.truncated, artifacts: detail.artifacts.map(toProtoArtifact),
        transcript: detail.transcript.map((item) => create(contract.PartnerWorkbenchTextSchema, { role: item.role, text: item.text, at: toProtoTimestamp(item.at),
          ...(item.privateMessageOrigin === undefined ? {} : { privateMessageOrigin: create(contract.PartnerPrivateMessageOriginSchema, item.privateMessageOrigin) }) }))
      }) });
    }),
    resolvePartnerWorkbenchReference: (request, context) => rpc(context, async () => create(contract.ResolvePartnerWorkbenchReferenceResponseSchema, await owner().resolveReference(fromProtoWorkbenchOwner(request.owner), request.ref))),
    readPartnerWorkbenchDocument: (request, context) => rpc(context, async () => create(contract.ReadPartnerWorkbenchDocumentResponseSchema, await owner().readProjectFile(fromProtoWorkbenchOwner(request.owner), request.path)))
  };
}

export function fromProtoWorkbenchOwner(value: contract.PartnerWorkbenchOwner | undefined): PartnerWorkbenchOwner {
  if (value === undefined || !value.partnerId || !value.sessionId || !value.targetId || value.profileVersion < 1n
    || value.profileVersion > BigInt(Number.MAX_SAFE_INTEGER) || value.sessionGeneration < 1n || value.sessionGeneration > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConnectError("An exact workbench owner is required.", Code.InvalidArgument);
  return { partnerId: value.partnerId, sessionId: value.sessionId, targetId: value.targetId, profileVersion: Number(value.profileVersion), sessionGeneration: Number(value.sessionGeneration) };
}
const VERDICTS = { unfinished: contract.PartnerWorkbenchVerdict.UNFINISHED, idea: contract.PartnerWorkbenchVerdict.IDEA, done: contract.PartnerWorkbenchVerdict.DONE } as const;
const KINDS = { session: contract.PartnerWorkbenchTaskKind.SESSION, external: contract.PartnerWorkbenchTaskKind.EXTERNAL, item: contract.PartnerWorkbenchTaskKind.ITEM, automation: contract.PartnerWorkbenchTaskKind.AUTOMATION } as const;
const STATES = { running: contract.PartnerWorkbenchTaskState.RUNNING, waiting: contract.PartnerWorkbenchTaskState.WAITING, queued: contract.PartnerWorkbenchTaskState.QUEUED,
  stopped: contract.PartnerWorkbenchTaskState.STOPPED, automation: contract.PartnerWorkbenchTaskState.AUTOMATION, done: contract.PartnerWorkbenchTaskState.DONE } as const;
const GROUPS = { waiting: contract.PartnerWorkbenchGroup.WAITING, running: contract.PartnerWorkbenchGroup.RUNNING, todo: contract.PartnerWorkbenchGroup.TODO, done: contract.PartnerWorkbenchGroup.DONE } as const;
function fromProtoVerdict(value: contract.PartnerWorkbenchVerdict): PartnerWorkbenchJudgment["verdict"] {
  for (const [key, enumValue] of Object.entries(VERDICTS)) if (enumValue === value) return key as PartnerWorkbenchJudgment["verdict"];
  throw new ConnectError("A valid workbench verdict is required.", Code.InvalidArgument);
}
function toProtoJudgment(item: PartnerWorkbenchJudgment): contract.PartnerWorkbenchJudgment {
  return create(contract.PartnerWorkbenchJudgmentSchema, { taskId: item.taskId, project: item.project, title: item.title, verdict: VERDICTS[item.verdict],
    ...(item.next === null ? {} : { next: item.next }), ...(item.ref === undefined ? {} : { ref: item.ref }), updatedAt: toProtoTimestamp(item.updatedAt) });
}
function toProtoTask(task: PartnerWorkbenchTask): contract.PartnerWorkbenchTask {
  const { judgment: _judgment, digest: _digest, updatedAt: _at, startedAt: _started, ...plain } = task;
  return create(contract.PartnerWorkbenchTaskSchema, { ...plain, kind: KINDS[task.kind], state: STATES[task.state], group: GROUPS[task.group], updatedAt: toProtoTimestamp(task.updatedAt),
    ...(task.startedAt === undefined ? {} : { startedAt: toProtoTimestamp(task.startedAt) }),
    ...(task.judgment === undefined ? {} : { judgment: toProtoJudgment(task.judgment) }), digest: create(contract.PartnerWorkbenchDigestSchema, {
      ...(task.digest.purpose === null ? {} : { purpose: task.digest.purpose }), recent: task.digest.recent.map((item) => create(contract.PartnerWorkbenchTextSchema, item))
    }) });
}
function toProtoBrief(brief: PartnerWorkbenchProjectBrief): contract.PartnerWorkbenchProjectBrief {
  return create(contract.PartnerWorkbenchProjectBriefSchema, { project: brief.project, docs: [...brief.docs], recent: brief.recent.map((item) => create(contract.PartnerWorkbenchRecentFileSchema, { path: item.path, modifiedAt: toProtoTimestamp(item.modifiedAt) })),
    ...(brief.git === undefined ? {} : { git: create(contract.PartnerWorkbenchGitBriefSchema, { ...brief.git, commits: brief.git.commits.map((item) => create(contract.PartnerWorkbenchCommitSchema, item)),
      branches: brief.git.branches.map((item) => create(contract.PartnerWorkbenchBranchSchema, item)), remotes: [...brief.git.remotes] }) }),
    codeHost: create(contract.PartnerWorkbenchCodeHostBriefSchema, { ...brief.codeHost,
      pullRequests: brief.codeHost.pullRequests.map((item) => create(contract.PartnerWorkbenchCodeHostItemSchema, { ...item, updatedAt: toProtoTimestamp(item.updatedAt) })),
      issues: brief.codeHost.issues.map((item) => create(contract.PartnerWorkbenchCodeHostItemSchema, { ...item, updatedAt: toProtoTimestamp(item.updatedAt) })) }) });
}
export function toProtoWorkbench(view: PartnerWorkbenchStateView): contract.PartnerWorkbenchSnapshot {
  return create(contract.PartnerWorkbenchSnapshotSchema, { owner: create(contract.PartnerWorkbenchOwnerSchema, { ...view.owner, profileVersion: BigInt(view.owner.profileVersion), sessionGeneration: BigInt(view.owner.sessionGeneration) }),
    revision: toProtoRevision(view.state.revision), projects: view.projects.map((item) => create(contract.PartnerWorkbenchProjectSchema, { ...item, addedAt: toProtoTimestamp(item.addedAt) })),
    judgments: view.state.judgments.map(toProtoJudgment), projectOptions: view.projectOptions.map((item) => create(contract.PartnerWorkbenchProjectOptionSchema, item)),
    tasks: view.tasks.map(toProtoTask), candidates: view.candidates.map(toProtoTask), briefs: view.briefs.map(toProtoBrief), outputs: view.outputs.map(toProtoArtifact), olderCount: view.olderCount, truncated: view.truncated, unavailableSources: [...view.unavailableSources] });
}
function toProtoArtifact(item: PartnerWorkbenchStateView["outputs"][number]): contract.PartnerWorkbenchArtifact {
  return create(contract.PartnerWorkbenchArtifactSchema, { ...item, byteSize: BigInt(item.byteSize) });
}
