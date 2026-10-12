import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { toProtoTimestamp, toProtoRevision, fromProtoRevision } from "./proto-mapper.js";
import { PartnerSessionTaskError, type PartnerSessionTaskManager, type PartnerSessionTaskRecord } from "./partner-session-tasks.js";

const statuses = { preparing: contract.PartnerSessionTaskStatus.PREPARING, queued: contract.PartnerSessionTaskStatus.QUEUED,
  running: contract.PartnerSessionTaskStatus.RUNNING, waiting: contract.PartnerSessionTaskStatus.WAITING, completed: contract.PartnerSessionTaskStatus.COMPLETED,
  failed: contract.PartnerSessionTaskStatus.FAILED, cancelled: contract.PartnerSessionTaskStatus.CANCELLED, "timed-out": contract.PartnerSessionTaskStatus.TIMED_OUT, unknown: contract.PartnerSessionTaskStatus.UNKNOWN };
const controls = { active: contract.PartnerSessionTaskControl.ACTIVE, pausing: contract.PartnerSessionTaskControl.PAUSING,
  paused: contract.PartnerSessionTaskControl.PAUSED, cancelling: contract.PartnerSessionTaskControl.CANCELLING };
export function toProtoSessionTask(manager: PartnerSessionTaskManager, task: PartnerSessionTaskRecord) {
  return create(contract.PartnerSessionTaskSchema, { id: task.id, partnerId: task.partnerId, sessionId: task.sessionId ?? "", title: task.title,
    status: statuses[task.status], control: controls[task.control], revision: toProtoRevision(manager.store.getSetting("service", "partner.session-tasks", task.id).revision),
    deadlineAt: toProtoTimestamp(task.deadlineAt), result: task.result ?? "", error: task.error ?? "" });
}
export function createPartnerSessionTaskControl(manager: PartnerSessionTaskManager | undefined, authenticate: (context: HandlerContext) => unknown) {
  return async (request: contract.ControlPartnerSessionTaskRequest, context: HandlerContext) => {
    authenticate(context);
    if (!manager) throw new ConnectError("Independent tasks are unavailable.", Code.Unimplemented);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,230}$/u.test(request.requestId)) throw new ConnectError("A valid task control identity is required.", Code.InvalidArgument);
    const revision = fromProtoRevision(request.expectedPartnerRevision, "expected_partner_revision"), taskRevision = fromProtoRevision(request.expectedTaskRevision, "expected_task_revision");
    if (![contract.PartnerSessionTaskAction.PAUSE, contract.PartnerSessionTaskAction.RESUME, contract.PartnerSessionTaskAction.CANCEL].includes(request.action)) throw new ConnectError("A valid task action is required.", Code.InvalidArgument);
    try {
      return await manager.partners.runOwnedManagement(request.partnerId, revision, async () => {
        const profile = manager.partners.getPartner(request.partnerId), sessionId = profile.canonicalSessionId!;
        const setting = manager.store.getSetting<PartnerSessionTaskRecord>("service", "partner.session-tasks", request.taskId);
        if (setting.revision !== taskRevision || setting.value.partnerId !== profile.id) throw new ConnectError("The independent task changed. Refresh before continuing.", Code.Aborted);
        const assertCurrent = () => {
          authenticate(context);
          if (manager.partners.canonicalCaller(sessionId).revision !== revision) throw new ConnectError("The Partner changed.", Code.Aborted);
        };
        const operationId = `partner-task-client:${request.requestId}`;
        const task = request.action === contract.PartnerSessionTaskAction.RESUME
          ? await manager.message(sessionId, request.taskId, operationId, { mode: "resume" }, assertCurrent)
          : await manager.stop(sessionId, request.taskId, operationId, request.action === contract.PartnerSessionTaskAction.PAUSE ? "pause" : "cancel", assertCurrent);
        assertCurrent(); return create(contract.ControlPartnerSessionTaskResponseSchema, { task: toProtoSessionTask(manager, task) });
      });
    } catch (error) {
      if (error instanceof ConnectError) throw error;
      throw new ConnectError(error instanceof PartnerSessionTaskError ? error.message : "Independent task control could not be confirmed. Refresh the task before another action.", Code.FailedPrecondition);
    }
  };
}
