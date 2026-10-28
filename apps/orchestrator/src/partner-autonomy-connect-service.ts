import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { ConnectionRecord } from "@joko/store";
import { toProtoRevision, toProtoTimestamp } from "./proto-mapper.js";
import type { PartnerAutonomyChoice, PartnerAutonomyManager, PartnerAutonomySettings, PartnerObservedPhase } from "./partner-autonomy.js";

export function createPartnerAutonomyConnectMethods(manager: PartnerAutonomyManager | undefined,
  authenticate: (context: HandlerContext) => unknown): Pick<ServiceImpl<typeof contract.PartnerService>,
    "getPartnerAutonomySettings" | "updatePartnerAutonomySettings" | "getPartnerGlance"> {
  const owner = () => { if (!manager) throw new ConnectError("Partner task observation is unavailable.", Code.Unimplemented); return manager; };
  const current = (context: HandlerContext) => { context.signal.throwIfAborted(); authenticate(context); };
  return {
    getPartnerAutonomySettings: (_request, context) => {
      current(context); return create(contract.GetPartnerAutonomySettingsResponseSchema, { settings: toSettings(owner().settings()) });
    },
    updatePartnerAutonomySettings: (request, context) => {
      current(context); const connection = authenticate(context) as ConnectionRecord | undefined;
      if (!connection?.id || !connection.authKeyDigest) throw new ConnectError("The follow-up settings owner is unavailable.", Code.Unauthenticated);
      const revision = request.expectedRevision?.value ?? 0n;
      if (revision < 1n || revision > BigInt(Number.MAX_SAFE_INTEGER) || !request.operationId || request.operationId.length > 256) throw new ConnectError("The settings request identity is invalid.", Code.InvalidArgument);
      let choice: PartnerAutonomyChoice;
      switch (request.choice.case) {
        case "schedulerPartnerId": choice = { schedulerPartnerId: request.choice.value }; break;
        case "disabled": if (!request.choice.value) throw invalid(); choice = { disabled: true }; break;
        case "reset": if (!request.choice.value) throw invalid(); choice = { reset: true }; break;
        case "fallback": choice = { fallback: { partnerId: request.choice.value.partnerId, allow: request.choice.value.allow } }; break;
        default: throw invalid();
      }
      const settings = owner().update({ operationId: request.operationId, connection, expectedRevision: Number(revision), choice,
        assertCurrent: () => current(context) });
      current(context); return create(contract.UpdatePartnerAutonomySettingsResponseSchema, { settings: toSettings(settings) });
    },
    getPartnerGlance: (request, context) => {
      current(context);
      const result = owner().glance(request.partnerId, request.snapshotToken, request.offset);
      current(context);
      return create(contract.GetPartnerGlanceResponseSchema, { partnerId: result.partnerId, partnerRevision: toProtoRevision(result.partnerRevision),
        allTasks: result.allTasks, snapshotToken: result.snapshotToken, nextOffset: result.nextOffset,
        waitingCount: result.waitingCount, workingCount: result.workingCount, doneToday: result.doneToday,
        observedAt: toProtoTimestamp(result.observedAt), rows: result.rows.map(row => ({ sessionId: row.sessionId,
          generation: BigInt(row.generation), targetId: row.targetId, title: row.title, phase: phase(row.phase),
          phaseSince: toProtoTimestamp(row.phaseSince), ...(row.startedAt === undefined ? {} : { startedAt: toProtoTimestamp(row.startedAt) }),
          question: row.question, creatorPartnerId: row.creatorPartnerId, followerPartnerId: row.followerPartnerId,
          interactionId: row.interactionId, readOnly: row.readOnly, deviceId: row.deviceId, deviceName: row.deviceName, online: row.online })) });
    }
  };
}
function toSettings(value: PartnerAutonomySettings) {
  return create(contract.PartnerAutonomySettingsSchema, { revision: toProtoRevision(BigInt(value.revision)), customized: value.customized,
    schedulerPartnerId: value.schedulerPartnerId, schedulerFallbackPartnerIds: [...value.schedulerFallbackPartnerIds] });
}
function invalid(): ConnectError { return new ConnectError("Choose a follow-up setting explicitly.", Code.InvalidArgument); }
function phase(value: PartnerObservedPhase): contract.PartnerGlancePhase {
  switch (value) {
    case "running": return contract.PartnerGlancePhase.RUNNING;
    case "waiting-permission": return contract.PartnerGlancePhase.WAITING_PERMISSION;
    case "waiting-answer": return contract.PartnerGlancePhase.WAITING_ANSWER;
    case "errored": return contract.PartnerGlancePhase.ERRORED;
    case "usage-limit": return contract.PartnerGlancePhase.USAGE_LIMIT;
    default: throw new Error("A finished task is not an active observation row.");
  }
}
