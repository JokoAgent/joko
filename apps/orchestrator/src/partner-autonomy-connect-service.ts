import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { toProtoRevision, toProtoTimestamp } from "./proto-mapper.js";
import type { PartnerAutonomyManager, PartnerObservedTask } from "./partner-autonomy.js";

export function createPartnerAutonomyConnectMethods(manager: PartnerAutonomyManager | undefined,
  authenticate: (context: HandlerContext) => unknown): Pick<ServiceImpl<typeof contract.PartnerService>,
    "getPartnerAutonomySettings" | "updatePartnerAutonomySettings" | "getPartnerGlance"> {
  const owner = () => { if (!manager) throw new ConnectError("Partner task observation is unavailable.", Code.Unimplemented); return manager; };
  const current = (context: HandlerContext) => { context.signal.throwIfAborted(); authenticate(context); };
  const retired = (_request: unknown, context: HandlerContext): never => {
    current(context);
    throw new ConnectError("Automatic Partner follow-up has been retired.", Code.Unimplemented);
  };
  return {
    getPartnerAutonomySettings: retired,
    updatePartnerAutonomySettings: retired,
    getPartnerGlance: (request, context) => {
      current(context);
      const result = owner().glance(request.partnerId, request.snapshotToken, request.offset);
      current(context);
      return create(contract.GetPartnerGlanceResponseSchema, { partnerId: result.partnerId, partnerRevision: toProtoRevision(result.partnerRevision),
        snapshotToken: result.snapshotToken, waitingCount: result.waitingCount, workingCount: result.workingCount,
        observedAt: toProtoTimestamp(result.observedAt), rows: result.rows.map(row => ({ sessionId: row.sessionId,
          generation: BigInt(row.generation), targetId: row.targetId, title: row.title, phase: phase(row.phase),
          phaseSince: toProtoTimestamp(row.phaseSince), ...(row.startedAt === undefined ? {} : { startedAt: toProtoTimestamp(row.startedAt) }),
          question: row.question, creatorPartnerId: row.creatorPartnerId,
          interactionId: row.interactionId, readOnly: row.readOnly, deviceId: row.deviceId, deviceName: row.deviceName, online: row.online })) });
    }
  };
}
function phase(value: PartnerObservedTask["phase"]): contract.PartnerGlancePhase {
  switch (value) {
    case "running": return contract.PartnerGlancePhase.RUNNING;
    case "waiting-permission": return contract.PartnerGlancePhase.WAITING_PERMISSION;
    case "waiting-answer": return contract.PartnerGlancePhase.WAITING_ANSWER;
    case "errored": return contract.PartnerGlancePhase.ERRORED;
    case "usage-limit": return contract.PartnerGlancePhase.USAGE_LIMIT;
    case "idle": return contract.PartnerGlancePhase.UNSPECIFIED;
  }
}
