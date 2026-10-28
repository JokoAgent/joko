import type { MessageInitShape } from '@bufbuild/protobuf';
import type { GetMessagingSettingsResponse, ListPartnerMessagingLanesResponse, SetPartnerMessagingBindingRequestSchema,
  SetPartnerMessagingBindingResponse, RestartPartnerMessagingLaneRequestSchema, RestartPartnerMessagingLaneResponse,
  GetPartnerMessagingRestartResponse, RetryPartnerMessagingRestartResponse, PartnerMessagingRestart } from './gen/joko/v1/messaging_pb.js';

export type PartnerMessagingBindingRequest = MessageInitShape<typeof SetPartnerMessagingBindingRequestSchema>;
export type PartnerMessagingRestartRequest = MessageInitShape<typeof RestartPartnerMessagingLaneRequestSchema>;
export interface PartnerMessagingApi {
  readonly ownerKey: string; newOperationId(): string;
  settings(signal: AbortSignal): Promise<GetMessagingSettingsResponse>;
  save(request: PartnerMessagingBindingRequest, signal: AbortSignal): Promise<SetPartnerMessagingBindingResponse>;
  lanes(connectionId: string, signal: AbortSignal): Promise<ListPartnerMessagingLanesResponse>;
  restart(request: PartnerMessagingRestartRequest, signal: AbortSignal): Promise<PartnerMessagingRestart>;
  lookup(operationId: string, signal: AbortSignal): Promise<PartnerMessagingRestart>;
  retry(operationId: string, signal: AbortSignal): Promise<PartnerMessagingRestart>;
}
interface Rpc {
  getMessagingSettings(request: object, options: { signal: AbortSignal }): Promise<GetMessagingSettingsResponse>;
  setPartnerMessagingBinding(request: PartnerMessagingBindingRequest, options: { signal: AbortSignal }): Promise<SetPartnerMessagingBindingResponse>;
  listPartnerMessagingLanes(request: { connectionId: string }, options: { signal: AbortSignal }): Promise<ListPartnerMessagingLanesResponse>;
  restartPartnerMessagingLane(request: PartnerMessagingRestartRequest, options: { signal: AbortSignal }): Promise<RestartPartnerMessagingLaneResponse>;
  getPartnerMessagingRestart(request: { operationId: string }, options: { signal: AbortSignal }): Promise<GetPartnerMessagingRestartResponse>;
  retryPartnerMessagingRestart(request: { operationId: string }, options: { signal: AbortSignal }): Promise<RetryPartnerMessagingRestartResponse>;
}
export function createPartnerMessagingApi(input: { readonly rpc: Rpc; readonly ownerKey: string; readonly newOperationId: () => string;
  readonly assertCurrent: (signal: AbortSignal) => void }): PartnerMessagingApi {
  const invoke = async <T>(signal: AbortSignal, action: () => Promise<T>) => {
    signal.throwIfAborted(); input.assertCurrent(signal); const value = await action(); input.assertCurrent(signal); signal.throwIfAborted(); return value;
  };
  const receipt = (operationId: string | undefined, value: PartnerMessagingRestart | undefined) => {
    if (!value || !operationId || value.operationId !== operationId || !value.connectionId || !value.conversationId || !value.sessionId || value.phase === 0) throw new Error('The message restart receipt is invalid.');
    return value;
  };
  return { ownerKey: input.ownerKey, newOperationId: input.newOperationId,
    settings: signal => invoke(signal, () => input.rpc.getMessagingSettings({}, { signal })),
    save: (request, signal) => invoke(signal, async () => {
      const value = await input.rpc.setPartnerMessagingBinding(request, { signal });
      if (!value.binding || !value.connection || value.binding.connectionId !== request.connectionId || value.connection.connectionId !== request.connectionId
        || value.binding.revision !== (request.expectedBindingRevision ?? 0n) + 1n
        || value.binding.partnerId !== (request.destination?.case === 'partnerId' ? request.destination.value : undefined)) throw new Error('The message destination receipt is invalid.');
      return value;
    }),
    lanes: (connectionId, signal) => invoke(signal, async () => {
      const value = await input.rpc.listPartnerMessagingLanes({ connectionId }, { signal });
      if (value.binding?.connectionId !== connectionId || value.lanes.some(row => !row.sessionId || !row.conversationId || row.kind === 0)) throw new Error('The message lane source is invalid.');
      return value;
    }),
    restart: (request, signal) => invoke(signal, async () => receipt(request.operationId, (await input.rpc.restartPartnerMessagingLane(request, { signal })).restart)),
    lookup: (operationId, signal) => invoke(signal, async () => receipt(operationId, (await input.rpc.getPartnerMessagingRestart({ operationId }, { signal })).restart)),
    retry: (operationId, signal) => invoke(signal, async () => receipt(operationId, (await input.rpc.retryPartnerMessagingRestart({ operationId }, { signal })).restart)) };
}

export const partnerMessagingMessages = (locale?: string) => locale?.startsWith('zh') ? {
  title: '消息平台', destination: '消息交给', personal: '个人任务', save: '保存', retry: '重试原操作', refresh: '刷新', remove: '解除伙伴绑定',
  scope: '主人私聊接续这位伙伴的主会话；群聊、话题和访客使用各自上下文。渠道中的写入和外部动作仍需确认。切换后停止旧渠道工作。',
  lanes: '查看会话', empty: '还没有接收到消息。', owner_dm: '主人私聊', group: '群聊', topic: '话题', guest_dm: '访客私聊',
  restart: '重启上下文', confirm: '重启将停止这个会话的运行。历史保留，下次输入建立新上下文。',
  unknown: '尚未确认保存结果。重试沿用原操作。', failed: '无法读取消息平台，请刷新重试。', ready: '上下文已重启，等待新输入。', closing: '正在等待原上下文关闭。',
  run: '运行中', error: '运行失败', messages: '条消息', close: '关闭'
} : {
  title: 'Message platforms', destination: 'Send messages to', personal: 'Personal tasks', save: 'Save', retry: 'Retry original operation', refresh: 'Refresh', remove: 'Remove Partner binding',
  scope: 'Owner DMs continue this Partner’s main conversation. Groups, topics and visitors use separate contexts. Writes and external actions still need confirmation. Switching stops old channel work.',
  lanes: 'View conversations', empty: 'No messages received yet.', owner_dm: 'Owner DM', group: 'Group', topic: 'Topic', guest_dm: 'Visitor DM',
  restart: 'Restart context', confirm: 'Restart stops this conversation’s running work. History remains; the next input creates a new context.',
  unknown: 'The save result is unconfirmed. Retry keeps the original operation.', failed: 'Could not read message platforms. Refresh to retry.', ready: 'Context restarted; waiting for new input.', closing: 'Waiting for the original context to close.',
  run: 'Running', error: 'Run failed', messages: 'messages', close: 'Close'
};
