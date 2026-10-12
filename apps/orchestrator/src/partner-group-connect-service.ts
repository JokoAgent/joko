import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as wire from "@joko/contracts";
import type { PartnerGroupAttachment, PartnerGroupChangeNotice, PartnerGroupDetail, PartnerGroupMessage, PartnerGroupPlan, PartnerGroupSummary } from "@joko/core";
import { PartnerGroupStoreError, type ConnectionRecord, type OperationalStore } from "@joko/store";
import { PartnerGroupError, type PartnerGroupManager } from "./partner-group-manager.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { WorkspaceService } from "./workspace-service.js";
import { fromProtoBlobRef, fromProtoRevision, toProtoBlobRef, toProtoInteraction, toProtoRevision, toProtoTimestamp } from "./proto-mapper.js";

const replyModes = ["all", "mentioned"] as const, speakingModes = ["auto", "sequential"] as const;
const memberStates = ["active", "paused", "error", "archived", "deleting", "missing"] as const;
const messageKinds = ["message", "round-end", "notice", "plan", "plan-end"] as const, authors = ["user", "partner", "system"] as const;
const notices = ["member-failed", "member-timeout", "member-unavailable", "plan-failed", "plan-stopped", "workdir-unavailable"] as const;
const categories = ["image", "pdf", "text", "office", "file"] as const, planStates = ["proposed", "running", "waiting", "done", "stopped", "dismissed", "superseded"] as const;
const stepStates = ["pending", "running", "done", "failed"] as const, activities = ["reply", "planning", "step"] as const;
const changes = ["created", "updated", "deleted", "messages", "round", "plan", "read"] as const;
const planActions = ["start", "dismiss", "continue", "retry"] as const, editActions = ["reassign", "remove"] as const;

export function createPartnerGroupConnectService(manager: PartnerGroupManager | undefined, store: OperationalStore,
  authenticate: (context: HandlerContext) => ConnectionRecord, onRevoked: (connectionId: string, callback: () => void) => () => void,
  files?: { readonly workspaces: WorkspaceService; readonly artifacts: ArtifactStore }): ServiceImpl<typeof wire.PartnerGroupService> {
  const owner = () => { if (!manager) throw new ConnectError("Partner groups are unavailable.", Code.Unimplemented); return manager; };
  const scope = (context: HandlerContext) => {
    context.signal.throwIfAborted(); const connection = authenticate(context), deviceId = connection.deviceId;
    const controller = store.getDevice(deviceId).kind === "mobile";
    const assertRequest = () => { context.signal.throwIfAborted(); const current = authenticate(context);
      if (current.id !== connection.id || current.deviceId !== deviceId) throw new ConnectError("The group controller changed.", Code.Aborted); };
    const visible = (groupId: string) => { assertRequest(); if (controller && !owner().list(deviceId, true).groups.some(group => group.id === groupId)) throw new ConnectError("Group not found.", Code.NotFound); };
    return { connection, deviceId, controller, assertRequest, visible };
  };
  const invoke = async <T>(context: HandlerContext, action: (value: ReturnType<typeof scope>) => T | Promise<T>): Promise<T> => {
    const value = scope(context); try { const result = await action(value); value.assertRequest(); return result; } catch (error) { throw failure(error); }
  };
  const summary = (groupId: string, value: ReturnType<typeof scope>) => toGroup(owner().detail(groupId, value.deviceId, value.controller));
  return {
    listPartnerGroups: (_request, context) => invoke(context, value => {
      const result = owner().list(value.deviceId, value.controller);
      return create(wire.ListPartnerGroupsResponseSchema, { revision: revision(result.revision), groups: result.groups.map(toGroup), changeSequence: BigInt(owner().options.storage.latestChangeSequence()) });
    }),
    createPartnerGroup: (request, context) => invoke(context, value => {
      const group = owner().create({ requestId: request.requestId, expectedDirectoryRevision: numberRevision(request.expectedDirectoryRevision), name: request.name, memberIds: request.memberIds });
      value.visible(group.id); return create(wire.CreatePartnerGroupResponseSchema, { group: summary(group.id, value) });
    }),
    getPartnerGroup: (request, context) => invoke(context, value => {
      value.visible(request.groupId);
      const result = owner().detail(request.groupId, value.deviceId, value.controller, request.beforeSequence === undefined ? undefined : safeNumber(request.beforeSequence));
      const interactions = owner().options.storage.lanes(request.groupId).flatMap(lane => {
        if (!lane.sessionId || lane.phase !== "ready") return [];
        const session = store.getSession(lane.sessionId).descriptor; if (session.archived || session.deletedAt !== undefined) return [];
        const pending = store.listInteractions({ sessionId: session.id, status: "open" }); if (!pending.length) return [];
        return [create(wire.PartnerGroupInteractionSchema, { partnerId: lane.partnerId, sessionId: session.id, backendId: session.backendId, targetId: session.targetId,
          generation: BigInt(session.binding.generation), interactions: pending.map(item => toProtoInteraction(item, { backendId: session.backendId, targetId: session.targetId })) })];
      });
      return create(wire.GetPartnerGroupResponseSchema, { detail: toDetail(result), interactions });
    }),
    updatePartnerGroup: (request, context) => invoke(context, async value => {
      value.visible(request.groupId);
      if (request.organizerSelection.case === "clearOrganizer" && request.organizerSelection.value !== true
        || request.projectSelection.case === "clearProjectDir" && request.projectSelection.value !== true) invalid();
      await owner().update(request.groupId, numberRevision(request.expectedRevision), {
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.replyMode === undefined ? {} : { replyMode: readEnum(request.replyMode, replyModes) }),
        ...(request.speakingMode === undefined ? {} : { speakingMode: readEnum(request.speakingMode, speakingModes) }),
        ...(request.organizerSelection.case === undefined ? {} : { organizerPartnerId: request.organizerSelection.case === "organizerPartnerId" ? request.organizerSelection.value : null }),
        ...(request.projectSelection.case === undefined ? {} : { projectDir: request.projectSelection.case === "projectDir" ? request.projectSelection.value : null })
      }, value.assertRequest, value.controller);
      return create(wire.UpdatePartnerGroupResponseSchema, { group: summary(request.groupId, value) });
    }),
    setPartnerGroupMembers: (request, context) => invoke(context, async value => {
      value.visible(request.groupId); await owner().setMembers(request.groupId, numberRevision(request.expectedRevision), request.memberIds, value.assertRequest);
      return create(wire.SetPartnerGroupMembersResponseSchema, { group: summary(request.groupId, value) });
    }),
    deletePartnerGroup: (request, context) => invoke(context, async value => {
      value.visible(request.groupId); await owner().delete(request.groupId, numberRevision(request.expectedRevision), value.assertRequest); return create(wire.DeletePartnerGroupResponseSchema);
    }),
    sendPartnerGroupMessage: (request, context) => invoke(context, async value => {
      value.visible(request.groupId); const message = await owner().send({ groupId: request.groupId, expectedRevision: numberRevision(request.expectedRevision), clientId: request.clientId,
        text: request.text, mentions: request.mentions ? { all: request.mentions.all, partnerIds: request.mentions.partnerIds } : null, division: request.division,
        attachments: request.attachments.map(fromAttachment), deviceId: value.deviceId, assertRequest: value.assertRequest });
      return create(wire.SendPartnerGroupMessageResponseSchema, { message: toMessage(message) });
    }),
    continuePartnerGroup: (request, context) => invoke(context, async value => { value.visible(request.groupId); await owner().continueRound(request.groupId, value.assertRequest); return create(wire.ContinuePartnerGroupResponseSchema); }),
    stopPartnerGroup: (request, context) => invoke(context, async value => { value.visible(request.groupId); await owner().stop(request.groupId, value.assertRequest); return create(wire.StopPartnerGroupResponseSchema); }),
    markPartnerGroupRead: (request, context) => invoke(context, value => { value.visible(request.groupId); owner().markRead(request.groupId, value.deviceId, safeNumber(request.throughSequence)); return create(wire.MarkPartnerGroupReadResponseSchema); }),
    actPartnerGroupPlan: (request, context) => invoke(context, async value => { value.visible(request.groupId);
      await owner().planAction(request.groupId, request.planId, numberRevision(request.expectedRevision), readEnum(request.action, planActions), value.assertRequest); return create(wire.ActPartnerGroupPlanResponseSchema); }),
    editPartnerGroupPlan: (request, context) => invoke(context, async value => { value.visible(request.groupId);
      await owner().editPlan(request.groupId, request.planId, numberRevision(request.expectedRevision), request.position, readEnum(request.action, editActions), request.partnerId, value.assertRequest); return create(wire.EditPartnerGroupPlanResponseSchema); }),
    getPartnerGroupCreation: (request, context) => invoke(context, value => {
      const result = owner().creation(request.requestId); if (result.group) value.visible(result.group.id);
      return create(wire.GetPartnerGroupCreationResponseSchema, { retired: result.retired, ...(result.group ? { group: summary(result.group.id, value) } : {}) });
    }),
    retirePartnerGroupCreation: (request, context) => invoke(context, async value => {
      const existing = owner().creation(request.requestId); if (existing.group) value.visible(existing.group.id);
      const result = await owner().retireCreation(request.requestId, value.assertRequest);
      return create(wire.RetirePartnerGroupCreationResponseSchema, { retired: result.retired, ...(result.group ? { group: summary(result.group.id, value) } : {}) });
    }),
    readPartnerGroupFile: (request, context) => invoke(context, async value => {
      value.visible(request.groupId); if (value.controller) throw new ConnectError("Handoff files are named on mobile and opened on the host.", Code.PermissionDenied);
      if (!files) throw new ConnectError("Group files are unavailable.", Code.Unimplemented);
      const storage = owner().options.storage, group = storage.get(request.groupId), message = storage.findMessage(group.id, request.messageId);
      if (!message?.planId || !message.files.includes(request.relativePath)) throw new ConnectError("Group file not found.", Code.NotFound);
      const plan = storage.getPlan(message.planId); if (plan.groupId !== group.id || !plan.workDir) invalid();
      const location = await owner().options.work.prepare(group, plan, value.assertRequest);
      const lane = storage.lanes(group.id).find(item => item.planId === plan.id && item.sessionId !== null);
      if (!lane?.sessionId) throw new ConnectError("The file workspace is unavailable.", Code.FailedPrecondition);
      const session = store.getSession(lane.sessionId).descriptor, target = store.getTarget(session.targetId);
      if (!target.descriptor.trusted || target.descriptor.remoteWorkspace !== undefined || target.descriptor.workspaceRoot !== location.path) invalid();
      const workspaceId = target.metadata !== null && typeof target.metadata === "object" && "workspaceId" in target.metadata && typeof target.metadata.workspaceId === "string" ? target.metadata.workspaceId : target.descriptor.id;
      const preview = await files.workspaces.preview(workspaceId, request.relativePath, 1); value.assertRequest();
      if (preview.entry.size > files.artifacts.maximumBlobBytes) throw new ConnectError("The handoff file exceeds the existing download limit.", Code.ResourceExhausted);
      const blob = await files.workspaces.materializeFile(workspaceId, request.relativePath, preview.entry.revision, (handle, options) => files.artifacts.ingestFileHandle(handle, {
        ...options, fileName: request.relativePath.split("/").at(-1)!, mimeType: preview.mediaType, expiresAt: Date.now() + 5 * 60_000,
        beforeFinalize: async digest => { value.assertRequest(); if (storage.find(group.id)?.lifecycle !== "active") invalid(); await options.beforeFinalize(digest); }
      }), context.signal);
      value.assertRequest(); return create(wire.ReadPartnerGroupFileResponseSchema, { blob: toProtoBlobRef(blob) });
    }),
    streamPartnerGroupChanges: async function* (request, context) {
      const value = scope(context), storage = owner().options.storage; let cursor = safeNumber(request.afterSequence), epoch = 0;
      if (cursor > storage.latestChangeSequence()) invalid();
      const controller = new AbortController(), signal = AbortSignal.any([context.signal, controller.signal]); let wake: (() => void) | undefined;
      const unsubscribe = storage.subscribe(() => { epoch++; wake?.(); });
      const stopRevocation = onRevoked(value.connection.id, () => { controller.abort(); wake?.(); });
      const stopWait = () => wake?.(); signal.addEventListener("abort", stopWait);
      try {
        while (!signal.aborted) {
          value.assertRequest(); const observed = epoch, page = storage.changes(cursor);
          for (const notice of page) {
            value.assertRequest(); cursor = notice.sequence;
            const visible = !value.controller || owner().list(value.deviceId, true).groups.some(group => group.id === notice.groupId);
            yield create(wire.StreamPartnerGroupChangesResponseSchema, { notice: toNotice(notice, visible) });
          }
          if (page.length === 100) continue;
          await new Promise<void>(resolve => { wake = resolve; if (epoch !== observed || signal.aborted) resolve(); }); wake = undefined;
        }
      } catch (error) { if (!signal.aborted) throw failure(error); }
      finally { unsubscribe(); stopRevocation(); signal.removeEventListener("abort", stopWait); }
    }
  };
}
function enumValue<T extends string>(value: T, values: readonly T[]): number { const index = values.indexOf(value); if (index < 0) invalid(); return index + 1; }
function readEnum<T extends string>(value: number, values: readonly T[]): T { const result = values[value - 1]; if (!Number.isInteger(value) || result === undefined) invalid(); return result; }
function safeNumber(value: bigint): number { if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) invalid(); return Number(value); }
function numberRevision(value: wire.Revision | undefined): number { const result = safeNumber(fromProtoRevision(value)); if (result < 1) invalid(); return result; }
function revision(value: number) { return toProtoRevision(BigInt(value)); }
function fromAttachment(value: wire.PartnerGroupAttachment): PartnerGroupAttachment {
  if (!value.blob) invalid(); return { id: value.id, name: value.name, category: readEnum(value.category, categories), blob: fromProtoBlobRef(value.blob), annotated: value.annotated };
}
function toAttachment(value: PartnerGroupAttachment) { return create(wire.PartnerGroupAttachmentSchema, { id: value.id, name: value.name, category: enumValue(value.category, categories), blob: toProtoBlobRef(value.blob), annotated: value.annotated }); }
export function toGroup(value: PartnerGroupSummary) {
  return create(wire.PartnerGroupSummarySchema, { id: value.id, revision: revision(value.revision), name: value.name, deleting: value.lifecycle === "deleting",
    replyMode: enumValue(value.replyMode, replyModes), speakingMode: enumValue(value.speakingMode, speakingModes), organizerPartnerId: value.organizerPartnerId ?? undefined,
    projectDir: value.projectDir ?? undefined, projectDirName: value.projectDirName ?? undefined,
    members: value.members.map(member => create(wire.PartnerGroupMemberSchema, { partnerId: member.partnerId, name: member.name, status: enumValue(member.status, memberStates) })),
    lastMessage: value.lastMessage ? create(wire.PartnerGroupPreviewSchema, { ...value.lastMessage, authorKind: enumValue(value.lastMessage.authorKind, authors), createdAt: toProtoTimestamp(value.lastMessage.createdAt) }) : undefined,
    lastReplyAt: value.lastReplyAt === null ? undefined : toProtoTimestamp(value.lastReplyAt), unread: value.unread, planningPartnerId: value.planningPartnerId ?? undefined,
    speakers: value.speakers.map(speaker => create(wire.PartnerGroupSpeakerSchema, { partnerId: speaker.partnerId, sessionId: speaker.sessionId ?? undefined, activity: enumValue(speaker.activity, activities) })),
    openPlan: value.openPlan ? toPlan(value.openPlan) : undefined, createdAt: toProtoTimestamp(value.createdAt), updatedAt: toProtoTimestamp(value.updatedAt) });
}
function toMessage(value: PartnerGroupMessage) {
  return create(wire.PartnerGroupMessageSchema, { id: value.id, sequence: BigInt(value.sequence), kind: enumValue(value.kind, messageKinds), authorKind: enumValue(value.authorKind, authors),
    authorPartnerId: value.authorPartnerId ?? undefined, authorName: value.authorName, content: value.content, mentions: create(wire.PartnerGroupMentionSchema, { all: value.mentions.all, partnerIds: [...value.mentions.partnerIds] }),
    noticeCode: value.noticeCode === null ? wire.PartnerGroupNoticeCode.UNSPECIFIED : enumValue(value.noticeCode, notices), planId: value.planId ?? undefined, files: [...value.files],
    attachments: value.attachments.map(toAttachment), createdAt: toProtoTimestamp(value.createdAt) });
}
function toPlan(value: PartnerGroupPlan) {
  return create(wire.PartnerGroupPlanSchema, { id: value.id, groupId: value.groupId, revision: revision(value.revision), status: enumValue(value.status, planStates), requestText: value.requestText,
    attachments: value.attachments.map(toAttachment), organizerPartnerId: value.organizerPartnerId, organizerName: value.organizerName,
    steps: value.steps.map(step => create(wire.PartnerGroupPlanStepSchema, { position: step.position, partnerId: step.partnerId, partnerName: step.partnerName, task: step.task,
      status: enumValue(step.status, stepStates), resultMessageId: step.resultMessageId ?? undefined, startedAt: step.startedAt === null ? undefined : toProtoTimestamp(step.startedAt), finishedAt: step.finishedAt === null ? undefined : toProtoTimestamp(step.finishedAt) })),
    currentStep: value.currentStep ?? undefined, workDir: value.workDir ?? undefined, branch: value.branch ?? undefined,
    createdAt: toProtoTimestamp(value.createdAt), updatedAt: toProtoTimestamp(value.updatedAt) });
}
function toDetail(value: PartnerGroupDetail) { return create(wire.PartnerGroupDetailSchema, { group: toGroup(value), messages: value.messages.map(toMessage), hasMoreBefore: value.hasMoreBefore,
  roundRunning: value.round.status === "running", canContinue: value.round.canContinue, plans: value.plans.map(toPlan) }); }
function toNotice(value: PartnerGroupChangeNotice, visible: boolean) { return create(wire.PartnerGroupChangeNoticeSchema, { sequence: BigInt(value.sequence), groupId: visible ? value.groupId : undefined,
  groupRevision: visible ? revision(value.groupRevision) : undefined, directoryRevision: revision(value.directoryRevision), change: enumValue(value.change, changes), createdAt: toProtoTimestamp(value.createdAt) }); }
function invalid(): never { throw new ConnectError("The group action is invalid.", Code.InvalidArgument); }
function failure(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  if (error instanceof PartnerGroupError || error instanceof PartnerGroupStoreError) return new ConnectError(error.message,
    error.code === "invalid" ? Code.InvalidArgument : error.code === "changed" ? Code.Aborted : error.code === "not_found" ? Code.NotFound : Code.FailedPrecondition);
  return new ConnectError("The group action could not be confirmed. Read the current state before retrying.", Code.FailedPrecondition);
}
