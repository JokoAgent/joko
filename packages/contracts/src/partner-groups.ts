import type { DescMessage, MessageInitShape, MessageShape } from "@bufbuild/protobuf";
import type { Interaction, InteractionResolutionSchema } from "./gen/joko/v1/interaction_pb.js";
import type { BlobRef } from "./gen/joko/v1/common_pb.js";
import {
  PartnerGroupService, type PartnerGroupSummary, type PartnerGroupPlan, type PartnerGroupMessage,
  type ListPartnerGroupsResponse, type GetPartnerGroupResponse, type PartnerGroupChangeNotice,
  type GetPartnerGroupCreationResponse, type RetirePartnerGroupCreationResponse,
  UpdatePartnerGroupRequestSchema, SendPartnerGroupMessageRequestSchema, PartnerGroupPlanAction, PartnerGroupPlanEditAction
} from "./gen/joko/v1/partner_group_pb.js";

export type PartnerGroupSettingsPatch = Omit<MessageInitShape<typeof UpdatePartnerGroupRequestSchema>, "$typeName" | "groupId" | "expectedRevision">;
export type PartnerGroupSendInput = Omit<MessageInitShape<typeof SendPartnerGroupMessageRequestSchema>, "$typeName" | "groupId" | "expectedRevision" | "clientId">;
type GroupMethod<M extends { readonly input: DescMessage; readonly output: DescMessage; readonly methodKind: string }> =
  (request: MessageInitShape<M["input"]>, options: { readonly signal: AbortSignal }) =>
    M["methodKind"] extends "server_streaming" ? AsyncIterable<MessageShape<M["output"]>> : Promise<MessageShape<M["output"]>>;
export type PartnerGroupRpc = { readonly [K in keyof typeof PartnerGroupService.method]: GroupMethod<(typeof PartnerGroupService.method)[K]> };
export interface PartnerGroupApi {
  readonly ownerKey: string;
  newRequestId(): string;
  list(signal: AbortSignal): Promise<ListPartnerGroupsResponse>;
  create(revision: bigint, name: string, memberIds: readonly string[], requestId: string, signal: AbortSignal): Promise<PartnerGroupSummary>;
  get(groupId: string, beforeSequence: bigint | undefined, signal: AbortSignal): Promise<GetPartnerGroupResponse>;
  update(group: PartnerGroupSummary, patch: PartnerGroupSettingsPatch, signal: AbortSignal): Promise<PartnerGroupSummary>;
  members(group: PartnerGroupSummary, memberIds: readonly string[], signal: AbortSignal): Promise<PartnerGroupSummary>;
  remove(group: PartnerGroupSummary, signal: AbortSignal): Promise<void>;
  send(group: PartnerGroupSummary, input: PartnerGroupSendInput, clientId: string, signal: AbortSignal): Promise<PartnerGroupMessage>;
  continue(groupId: string, signal: AbortSignal): Promise<void>;
  stop(groupId: string, signal: AbortSignal): Promise<void>;
  markRead(groupId: string, throughSequence: bigint, signal: AbortSignal): Promise<void>;
  planAction(groupId: string, plan: PartnerGroupPlan, action: PartnerGroupPlanAction, signal: AbortSignal): Promise<void>;
  planEdit(groupId: string, plan: PartnerGroupPlan, position: number, action: PartnerGroupPlanEditAction, partnerId: string | undefined, signal: AbortSignal): Promise<void>;
  lookup(requestId: string, signal: AbortSignal): Promise<GetPartnerGroupCreationResponse>;
  retire(requestId: string, signal: AbortSignal): Promise<RetirePartnerGroupCreationResponse>;
  changes(afterSequence: bigint, signal: AbortSignal): AsyncIterable<PartnerGroupChangeNotice>;
  respond(groupId: string, interaction: Interaction, decision: NonNullable<MessageInitShape<typeof InteractionResolutionSchema>["decision"]>, signal: AbortSignal): Promise<void>;
  file(groupId: string, messageId: string, path: string, signal: AbortSignal): Promise<BlobRef>;
}
/** One authenticated node owns this directory and all of its group actions. */
export function createPartnerGroupApi(input: { readonly rpc: PartnerGroupRpc; readonly ownerKey: string;
  readonly newRequestId: () => string; readonly assertCurrent: (signal: AbortSignal) => void;
  readonly respond: (interaction: Interaction, decision: NonNullable<MessageInitShape<typeof InteractionResolutionSchema>["decision"]>, signal: AbortSignal) => Promise<void> }): PartnerGroupApi {
  const { rpc } = input;
  const check = (signal: AbortSignal) => { signal.throwIfAborted(); input.assertCurrent(signal); };
  const invoke = async <T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> => { check(signal); const result = await action(); check(signal); return result; };
  const group = (value: PartnerGroupSummary | undefined, expected?: string) => {
    if (!value || !value.id || expected !== undefined && value.id !== expected || !value.revision || value.revision.value < 1n
      || new Set(value.members.map(member => member.partnerId)).size !== value.members.length) throw new Error("The group response owner is invalid."); return value;
  };
  const planOwner = (groupId: string, plan: PartnerGroupPlan) => { if (!plan.id || plan.groupId !== groupId || !plan.revision || plan.revision.value < 1n) throw new Error("The plan response owner is invalid."); };
  return {
    ownerKey: input.ownerKey, newRequestId: input.newRequestId,
    list: signal => invoke(signal, async () => { const result = await rpc.listPartnerGroups({}, { signal });
      if (!result.revision || result.revision.value < 1n || new Set(result.groups.map(item => group(item).id)).size !== result.groups.length) throw new Error("The group directory is invalid."); return result; }),
    create: (revision, name, memberIds, requestId, signal) => invoke(signal, async () => group((await rpc.createPartnerGroup({ requestId, name, memberIds: [...memberIds], expectedDirectoryRevision: { value: revision } }, { signal })).group)),
    get: (groupId, beforeSequence, signal) => invoke(signal, async () => {
      const result = await rpc.getPartnerGroup({ groupId, beforeSequence }, { signal }); group(result.detail?.group, groupId);
      if (!result.detail || result.detail.messages.some((message, index, all) => !message.id || message.sequence < 1n || index > 0 && message.sequence <= all[index - 1]!.sequence)) throw new Error("The group timeline is invalid.");
      for (const plan of result.detail.plans) planOwner(groupId, plan); return result;
    }),
    update: (selected, patch, signal) => invoke(signal, async () => group((await rpc.updatePartnerGroup({ ...patch, groupId: group(selected).id, expectedRevision: selected.revision }, { signal })).group, selected.id)),
    members: (selected, memberIds, signal) => invoke(signal, async () => group((await rpc.setPartnerGroupMembers({ groupId: group(selected).id, expectedRevision: selected.revision, memberIds: [...memberIds] }, { signal })).group, selected.id)),
    remove: (selected, signal) => invoke(signal, async () => { await rpc.deletePartnerGroup({ groupId: group(selected).id, expectedRevision: selected.revision }, { signal }); }),
    send: (selected, body, clientId, signal) => invoke(signal, async () => {
      const result = await rpc.sendPartnerGroupMessage({ ...body, groupId: group(selected).id, expectedRevision: selected.revision, clientId }, { signal });
      if (!result.message?.id || result.message.sequence < 1n) throw new Error("The group message receipt is invalid."); return result.message;
    }),
    continue: (groupId, signal) => invoke(signal, async () => { await rpc.continuePartnerGroup({ groupId }, { signal }); }),
    stop: (groupId, signal) => invoke(signal, async () => { await rpc.stopPartnerGroup({ groupId }, { signal }); }),
    markRead: (groupId, throughSequence, signal) => invoke(signal, async () => { await rpc.markPartnerGroupRead({ groupId, throughSequence }, { signal }); }),
    planAction: (groupId, plan, action, signal) => invoke(signal, async () => { planOwner(groupId, plan); await rpc.actPartnerGroupPlan({ groupId, planId: plan.id, expectedRevision: plan.revision, action }, { signal }); }),
    planEdit: (groupId, plan, position, action, partnerId, signal) => invoke(signal, async () => { planOwner(groupId, plan); await rpc.editPartnerGroupPlan({ groupId, planId: plan.id, expectedRevision: plan.revision, position, action, partnerId }, { signal }); }),
    lookup: (requestId, signal) => invoke(signal, async () => { const result = await rpc.getPartnerGroupCreation({ requestId }, { signal }); if (result.group) group(result.group); return result; }),
    retire: (requestId, signal) => invoke(signal, async () => { const result = await rpc.retirePartnerGroupCreation({ requestId }, { signal }); if (result.group) group(result.group); return result; }),
    changes: async function* (afterSequence, signal) {
      check(signal); let cursor = afterSequence;
      for await (const result of rpc.streamPartnerGroupChanges({ afterSequence }, { signal })) {
        check(signal); if (!result.notice || result.notice.sequence <= cursor) throw new Error("The group change cursor is invalid.");
        cursor = result.notice.sequence; yield result.notice;
      }
    },
    file: (groupId, messageId, relativePath, signal) => invoke(signal, async () => { const result = await rpc.readPartnerGroupFile({ groupId, messageId, relativePath }, { signal });
      if (!result.blob?.blobId) throw new Error("The group handoff receipt is invalid."); return result.blob; }),
    respond: (groupId, interaction, decision, signal) => invoke(signal, async () => {
      const current = await rpc.getPartnerGroup({ groupId }, { signal }); group(current.detail?.group, groupId); check(signal);
      const owned = current.interactions.flatMap(context => context.interactions).find(item => item.interactionId === interaction.interactionId);
      if (!owned || owned.sessionId !== interaction.sessionId || owned.generation !== interaction.generation || owned.version?.revision?.value !== interaction.version?.revision?.value) throw new Error("The group decision owner changed.");
      await input.respond(owned, decision, signal);
    })
  };
}
