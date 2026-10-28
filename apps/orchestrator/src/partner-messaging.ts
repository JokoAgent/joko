import { createHash } from 'node:crypto';
import type { PromptInput, SessionDescriptor } from '@joko/core';
import type { MessagingInboundEvent, MessagingInboundMessage } from '@joko/messaging';
import { StoreError, NotFoundError, type ConnectionRecord, type MessagingConnectionRecord, type MessagingConversationRecord,
  type OperationalStore, type PartnerStore, type QueueItemRecord, type MessagingDeliveryRecord } from '@joko/store';
import type { PartnerManager } from './partner-manager.js';
import type { SessionHost } from './session-host.js';
import type { MessagingManager } from './messaging-manager.js';
import type { BridgeToolProvider, BridgeToolCallContext, McpToolDescriptor } from './mcp-router.js';

const SCOPE = 'partner.messaging.v1';
export interface PartnerMessagingBinding {
  readonly connectionId: string; readonly partnerId?: string; readonly revision: number; readonly connectionGeneration: number;
}
interface BindingValue { readonly version: 1; readonly partnerId?: string; readonly revision: number }
export interface PartnerMessagingLane {
  readonly conversationId: string; readonly sessionId: string; readonly generation: number;
  readonly kind: 'owner_dm' | 'group' | 'topic' | 'guest_dm'; readonly title: string;
  readonly running: boolean; readonly failed: boolean; readonly lastActivityAt: number; readonly contextMessageCount: number; readonly canRestart: boolean;
}
export interface PartnerMessagingRestart {
  readonly version: 1; readonly operationId: string; readonly ownerConnectionId: string; readonly ownerAuthDigest: string;
  readonly connectionId: string; readonly conversationId: string; readonly sessionId: string;
  readonly sourceGeneration: number; readonly sourceBindingFingerprint: string; readonly partnerId: string; readonly profileRevision: string;
  readonly bindingRevision: number; readonly phase: 'closing' | 'ready' | 'failed'; readonly failureCode?: string;
  readonly closeOperationId?: string;
  readonly channelOwner?: { readonly generation: number; readonly credentialGeneration: string; readonly providerUserId: string };
}
export interface PartnerMessageDeliveryOrigin {
  readonly partnerId: string; readonly profileRevision: string; readonly sessionId: string;
  readonly queueItemId: string; readonly generation: number; readonly bindingFingerprint: string; readonly bindingRevision: number;
}

/** Uses the existing channel worker and Partner/Host owners. Binding never
 * copies credentials or starts an additional provider consumer. */
export class PartnerMessagingRuntime {
  readonly #flights = new Map<string, Promise<PartnerMessagingRestart>>();
  readonly #closingSessions = new Set<string>();
  constructor(readonly options: { readonly store: OperationalStore; readonly profiles: PartnerStore; readonly partners: PartnerManager;
    readonly host: Pick<SessionHost, 'restartPartnerSession' | 'canRestartPartnerSession'>; readonly messaging: MessagingManager;
    readonly pauseGoal: (sessionId: string, operationId: string) => Promise<void> }) {}

  binding(connectionId: string): PartnerMessagingBinding {
    const connection = this.options.store.getMessagingConnection(connectionId);
    const value = this.options.store.findSetting<BindingValue>('service', SCOPE, `binding:${connection.id}`)?.value;
    if (value && (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1
      || value.partnerId !== undefined && (!value.partnerId || value.partnerId.length > 256))) throw new StoreError('The Partner message binding is invalid.');
    return { connectionId: connection.id, ...(value?.partnerId ? { partnerId: value.partnerId } : {}),
      revision: value?.revision ?? 0, connectionGeneration: connection.generation };
  }
  listBindings(): readonly PartnerMessagingBinding[] { return this.options.store.listMessagingConnections().map(row => this.binding(row.id)); }
  clientOwner(connectionId: string): ConnectionRecord {
    const owner = this.options.store.getConnection(connectionId);
    this.options.store.authorizeConnection(owner.id, owner.authKeyDigest); return owner;
  }

  async lifecycle(partnerId: string, state: 'active' | 'paused' | 'archived' | 'deleted'): Promise<void> {
    for (const binding of this.listBindings().filter(row => row.partnerId === partnerId)) {
      const key = `paused:${partnerId}:${binding.connectionId}`, connection = this.options.store.getMessagingConnection(binding.connectionId);
      if (state === 'deleted') {
        await this.options.messaging.retirePartnerConnection(connection.id, store => {
          const current = this.binding(connection.id);
          if (current.partnerId !== partnerId || current.revision !== binding.revision) throw new StoreError('The Partner channel changed during deletion.');
          store.setSetting('service', SCOPE, `binding:${connection.id}`, { version: 1, revision: current.revision + 1 });
          store.deleteSetting('service', SCOPE, key);
        });
      } else if ((state === 'paused' || state === 'archived') && connection.enabled) {
        // The existing Partner pause owner already closes all linked native
        // tasks. Stop this one provider worker without a second reply effect.
        const stopped = await this.options.messaging.retirePartnerConnection(connection.id, () => undefined, false);
        this.options.store.setSetting('service', SCOPE, key, { version: 1, bindingRevision: binding.revision,
          connectionRevision: stopped.revision.toString(), generation: stopped.generation });
      } else if (state === 'active') {
        const saved = this.options.store.findSetting<{ bindingRevision: number; connectionRevision: string; generation: number }>('service', SCOPE, key)?.value;
        if (saved && saved.bindingRevision === binding.revision && saved.connectionRevision === connection.revision.toString()
          && saved.generation === connection.generation && !connection.enabled) await this.options.messaging.setEnabled({ connectionId: connection.id,
            expectedRevision: connection.revision, expectedGeneration: connection.generation, enabled: true });
        this.options.store.deleteSetting('service', SCOPE, key);
      }
    }
  }

  async setBinding(input: { readonly operationId: string; readonly owner: ConnectionRecord; readonly connectionId: string;
    readonly expectedConnectionRevision: bigint; readonly expectedConnectionGeneration: number; readonly expectedBindingRevision: number;
    readonly partnerId?: string; readonly expectedPartnerRevision?: bigint }): Promise<{ readonly binding: PartnerMessagingBinding; readonly connection: MessagingConnectionRecord }> {
    return this.options.messaging.mutatePartnerBinding(input, store => {
      const before = this.binding(input.connectionId);
      if (before.revision !== input.expectedBindingRevision) throw new StoreError('The message destination changed. Refresh before saving.');
      if (input.partnerId !== undefined) {
        const partner = this.options.partners.getPartner(input.partnerId);
        if (partner.revision !== input.expectedPartnerRevision || partner.lifecycle !== 'active' || partner.initializationState !== 'ready'
          || !partner.canonicalSessionId || partner.pauseCleanupPending) throw new StoreError('The selected Partner is not ready.');
        this.options.partners.canonicalCaller(partner.canonicalSessionId);
      }
      const next: BindingValue = { version: 1, revision: before.revision + 1, ...(input.partnerId ? { partnerId: input.partnerId } : {}) };
      store.setSetting('service', SCOPE, `binding:${input.connectionId}`, next);
      return next;
    });
  }

  async resolve(conversation: MessagingConversationRecord, event: MessagingInboundEvent): Promise<MessagingConversationRecord | undefined> {
    const binding = this.binding(conversation.connectionId);
    if (!binding.partnerId) return undefined;
    const partner = this.options.partners.getPartner(binding.partnerId), connection = this.options.store.getMessagingConnection(binding.connectionId);
    const assertCurrent = () => {
      const latest = this.binding(binding.connectionId), live = this.options.store.getMessagingConnection(binding.connectionId);
      const profile = this.options.partners.getPartner(partner.id);
      if (latest.partnerId !== partner.id || latest.revision !== binding.revision || live.generation !== connection.generation
        || !live.enabled || live.credentialGeneration !== connection.credentialGeneration || profile.revision !== partner.revision
        || profile.lifecycle !== 'active' || profile.initializationState !== 'ready' || profile.pauseCleanupPending) throw new StoreError('The Partner message destination changed.');
    };
    assertCurrent();
    const ownerDm = conversation.conversationKind === 'direct' && event.speaker.isOwner && event.speaker.providerUserId === connection.ownerProviderUserId;
    let session: SessionDescriptor;
    if (ownerDm) {
      if (!partner.canonicalSessionId) throw new StoreError('The Partner has no current private task.');
      this.options.partners.canonicalCaller(partner.canonicalSessionId);
      session = this.options.store.getSession(partner.canonicalSessionId).descriptor;
    } else {
      const key = `im:${digest([connection.channel, connection.id, binding.revision, conversation.id])}`;
      session = await this.options.partners.ensureChannel({ partnerId: partner.id, key,
        title: `${connection.channel} ${conversation.providerThreadId ? 'topic' : conversation.conversationKind === 'direct' ? event.speaker.displayName : conversation.providerConversationId}`,
        assertCurrent });
    }
    assertCurrent();
    const current = this.options.store.getMessagingConversation(conversation.id);
    if (current.status === 'active' && current.sessionId === session.id && current.sessionGeneration === session.binding.generation
      && current.partnerId === partner.id && current.partnerBindingRevision === binding.revision) return current;
    return this.options.store.bindPartnerMessagingConversation({ conversationId: current.id, expectedRevision: current.revision,
      expectedChannelGeneration: connection.generation, sessionId: session.id, expectedSessionGeneration: session.binding.generation,
      partnerId: partner.id, bindingRevision: binding.revision, targetId: partner.homeTargetId });
  }

  origin(conversation: MessagingConversationRecord, event: MessagingInboundMessage, requestId: string): NonNullable<PromptInput['messagingOrigin']> | undefined {
    const binding = this.binding(conversation.connectionId);
    if (!binding.partnerId) return undefined;
    const connection = this.options.store.getMessagingConnection(conversation.connectionId);
    return { connectionId: connection.id, channelGeneration: connection.generation, credentialGeneration: connection.credentialGeneration ?? '',
      bindingRevision: binding.revision, partnerId: binding.partnerId, conversationId: conversation.id, requestId,
      channel: connection.channel, providerUserId: event.speaker.providerUserId,
      isOwner: event.speaker.isOwner && event.speaker.providerUserId === connection.ownerProviderUserId, userText: event.text };
  }

  assertQueueCurrent(item: QueueItemRecord): void {
    const origin = item.body.messagingOrigin;
    if (!origin) return;
    const binding = this.binding(origin.connectionId), connection = this.options.store.getMessagingConnection(origin.connectionId);
    const conversation = this.options.store.getMessagingConversation(origin.conversationId), request = this.options.store.getMessagingInboundRequest(origin.requestId);
    const profile = this.options.partners.getPartner(origin.partnerId), session = this.options.store.getSession(item.sessionId).descriptor;
    const link = this.options.profiles.getSessionLink(item.sessionId);
    if (!connection.enabled || connection.generation !== origin.channelGeneration || (connection.credentialGeneration ?? '') !== origin.credentialGeneration
      || connection.channel !== origin.channel || binding.revision !== origin.bindingRevision || binding.partnerId !== origin.partnerId
      || conversation.connectionId !== connection.id || conversation.status !== 'active' || conversation.channelGeneration !== connection.generation
      || conversation.sessionId !== item.sessionId
      || conversation.partnerId !== profile.id || conversation.partnerBindingRevision !== binding.revision
      || request.conversationId !== conversation.id || this.options.store.findMessagingInboundRequestByRunId(item.runId)?.id !== request.id
      || request.connectionId !== connection.id || request.channelGeneration !== origin.channelGeneration
      || profile.lifecycle !== 'active' || profile.initializationState !== 'ready' || profile.pauseCleanupPending
      || profile.homeTargetId !== session.targetId || session.archived || session.deletedAt !== undefined
      || link?.partnerId !== profile.id || !['canonical', 'channel'].includes(link.role)
      || link.role === 'canonical' && profile.canonicalSessionId !== session.id
      || origin.isOwner && connection.ownerProviderUserId !== origin.providerUserId) throw new StoreError('The originating Partner message channel is no longer authorized.');
    if (conversation.sessionGeneration !== session.binding.generation) {
      const current = this.options.store.getQueueItem(item.id), attempt = current.attemptId ? this.options.store.getAttempt(current.attemptId).descriptor : undefined;
      // A held source is checked both before and after an authorized native handoff.
      // Only its real dispatched descendant can advance the recipient's generation.
      if (attempt?.runId === item.runId && attempt.generation === session.binding.generation) this.options.store.refreshMessagingConversationGeneration({
        conversationId: conversation.id, requestId: request.id, runId: item.runId });
    }
  }
  reviewTool(item: QueueItemRecord, request: import('@joko/core').NativeToolAuthorizationRequest): import('@joko/core').NativeToolAuthorizationDecision {
    request.signal.throwIfAborted(); this.assertQueueCurrent(item);
    return messageToolNeedsConfirmation(request.toolName, request.input)
      ? { verdict: 'ask', reason: 'Writes, commands and external actions from this message channel require confirmation.' }
      : { verdict: 'default' };
  }
  connectionsForSession(sessionId: string, targetId: string, channel: string): readonly MessagingConnectionRecord[] {
    const link = this.options.profiles.getSessionLink(sessionId); if (!link || !['canonical', 'channel'].includes(link.role)) return [];
    const profile = this.options.partners.getPartner(link.partnerId);
    let session: SessionDescriptor | undefined;
    try { session = this.options.store.getSession(sessionId).descriptor; } catch (error) { if (!(error instanceof NotFoundError)) throw error; }
    if (profile.lifecycle !== 'active' || profile.initializationState !== 'ready' || profile.pauseCleanupPending || profile.homeTargetId !== targetId
      || session && (session.targetId !== targetId || session.archived || session.deletedAt !== undefined)
      || link.role === 'canonical' && profile.canonicalSessionId !== sessionId) return [];
    return this.listBindings().filter(binding => binding.partnerId === profile.id).flatMap(binding => {
      const connection = this.options.store.getMessagingConnection(binding.connectionId);
      if (connection.channel !== channel || !connection.enabled || !connection.credentialReferenceId || !connection.credentialGeneration) return [];
      if (link.role === 'channel' && !this.options.store.listMessagingConversations({ connectionId: connection.id, statuses: ['observed', 'active'] })
        .some(conversation => conversation.channelGeneration === connection.generation
          && link.channelKey === `im:${digest([connection.channel, connection.id, binding.revision, conversation.id])}`
          && (conversation.status === 'observed' || conversation.sessionId === sessionId && conversation.partnerId === profile.id && conversation.partnerBindingRevision === binding.revision))) return [];
      return [connection];
    });
  }

  assertOutboundCurrent(delivery: MessagingDeliveryRecord): void {
    if (!delivery.payload || typeof delivery.payload !== 'object' || Array.isArray(delivery.payload)) return;
    const source = (delivery.payload as Record<string, unknown>)['partnerDeliveryOrigin'];
    if (source === undefined) return;
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new StoreError('The message delivery origin is invalid.');
    const origin = source as Record<string, unknown>;
    if (typeof origin['partnerId'] !== 'string' || typeof origin['sessionId'] !== 'string' || typeof origin['queueItemId'] !== 'string') throw new StoreError('The message delivery origin is invalid.');
    const profile = this.options.partners.getPartner(origin['partnerId']), session = this.options.store.getSession(origin['sessionId']).descriptor;
    const queue = this.options.store.getQueueItem(origin['queueItemId']), binding = this.binding(delivery.connectionId);
    if (profile.lifecycle !== 'active' || profile.initializationState !== 'ready' || profile.pauseCleanupPending
      || profile.revision.toString() !== origin['profileRevision'] || profile.homeTargetId !== session.targetId
      || session.binding.generation !== origin['generation'] || digest(session.binding.opaqueRef) !== origin['bindingFingerprint']
      || session.archived || session.deletedAt !== undefined || queue.sessionId !== session.id
      || binding.partnerId !== profile.id || binding.revision !== origin['bindingRevision']) throw new StoreError('The approved Partner message delivery was retired.');
    if (queue.body.messagingOrigin) this.assertQueueCurrent(queue);
    const conversation = this.options.store.getMessagingConversation(delivery.conversationId);
    if (conversation.status !== 'active' || conversation.partnerId !== profile.id || conversation.partnerBindingRevision !== binding.revision
      || conversation.channelGeneration !== delivery.channelGeneration) throw new StoreError('The original message recipient changed.');
  }
  outboundSourceConnection(delivery: MessagingDeliveryRecord): { readonly connectionId: string; readonly generation: number } | undefined {
    this.assertOutboundCurrent(delivery);
    if (!delivery.payload || typeof delivery.payload !== 'object' || Array.isArray(delivery.payload)) return undefined;
    const value = delivery.payload as Record<string, unknown>, origin = value['partnerDeliveryOrigin'];
    if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return undefined;
    const source = this.options.store.getQueueItem(String((origin as Record<string, unknown>)['queueItemId'])).body.messagingOrigin;
    return source ? { connectionId: source.connectionId, generation: source.channelGeneration } : undefined;
  }

  lanes(connectionId: string): readonly PartnerMessagingLane[] {
    const binding = this.binding(connectionId);
    if (!binding.partnerId) return [];
    const profile = this.options.partners.getPartner(binding.partnerId);
    return this.options.store.listMessagingConversations({ connectionId, statuses: ['active'] }).flatMap(conversation => {
      if (conversation.partnerId !== profile.id || conversation.partnerBindingRevision !== binding.revision || !conversation.sessionId) return [];
      const session = this.options.store.getSession(conversation.sessionId).descriptor;
      if (session.deletedAt !== undefined || session.archived || session.targetId !== profile.homeTargetId) return [];
      const runs = this.options.store.listRuns({ sessionId: session.id, limit: 1 });
      const events = this.options.store.listEvents({ sessionId: session.id, order: 'desc', limit: 1, activeNativeTimeline: true });
      let count = 0, cursor = 0n;
      if (this.options.store.findPendingContextRebuild(session.id)?.reason !== 'manual_restart') for (;;) {
        const page = this.options.store.listEvents({ sessionId: session.id, afterCursor: cursor, order: 'asc', limit: 1000, activeNativeTimeline: true });
        count += page.filter(event => event.generation === session.binding.generation && event.payload.type === 'message_complete').length;
        if (page.length < 1000) break; cursor = page.at(-1)!.globalCursor;
      }
      return [{ conversationId: conversation.id, sessionId: session.id, generation: session.binding.generation,
        kind: session.id === profile.canonicalSessionId ? 'owner_dm' as const : conversation.providerThreadId ? 'topic' as const
          : conversation.conversationKind === 'direct' ? 'guest_dm' as const : 'group' as const,
        title: session.title, running: this.options.store.listRuns({ sessionId: session.id, activeOnly: true, limit: 1 }).length > 0,
        failed: runs[0]?.descriptor.state === 'failed', lastActivityAt: events[0]?.emittedAt ?? conversation.updatedAt,
        contextMessageCount: count, canRestart: profile.lifecycle === 'active' && !this.#closingSessions.has(session.id)
          && this.options.host.canRestartPartnerSession(session.id) }];
    });
  }

  isRestarting(sessionId: string): boolean {
    return this.options.store.listSettings('service', SCOPE).some(row => {
      const receipt = row.value as PartnerMessagingRestart;
      if (!row.key.startsWith('restart:') || receipt.sessionId !== sessionId || receipt.phase === 'ready') return false;
      const binding = this.binding(receipt.connectionId);
      const profile = this.options.partners.getPartner(receipt.partnerId), session = this.options.store.getSession(sessionId).descriptor;
      return binding.partnerId === receipt.partnerId && binding.revision === receipt.bindingRevision && profile.lifecycle === 'active'
        && profile.revision.toString() === receipt.profileRevision && session.binding.generation === receipt.sourceGeneration
        && digest(session.binding.opaqueRef) === receipt.sourceBindingFingerprint;
    });
  }
  getRestart(operationId: string, owner: ConnectionRecord): PartnerMessagingRestart | undefined {
    this.options.store.authorizeConnection(owner.id, owner.authKeyDigest);
    const receipt = this.options.store.findSetting<PartnerMessagingRestart>('service', SCOPE, `restart:${operationId}`)?.value;
    if (receipt && (receipt.version !== 1 || receipt.ownerConnectionId !== owner.id || receipt.ownerAuthDigest !== owner.authKeyDigest)) throw new StoreError('This channel restart belongs to another connection.');
    return receipt;
  }
  async restart(input: { readonly operationId: string; readonly owner: ConnectionRecord; readonly connectionId: string;
    readonly conversationId: string; readonly expectedBindingRevision: number; readonly expectedSessionGeneration: number }): Promise<PartnerMessagingRestart> {
    const result = this.options.store.runAuthorizedOperation(input.owner.id, input.owner.authKeyDigest,
      { id: input.operationId, kind: 'partner_messaging_restart', body: { connectionId: input.connectionId, conversationId: input.conversationId,
        expectedBindingRevision: input.expectedBindingRevision, expectedSessionGeneration: input.expectedSessionGeneration } }, store => {
        const binding = this.binding(input.connectionId), lane = this.lanes(input.connectionId).find(row => row.conversationId === input.conversationId);
        if (!binding.partnerId || binding.revision !== input.expectedBindingRevision || !lane?.canRestart || lane.generation !== input.expectedSessionGeneration) throw new StoreError('The original message lane cannot restart.');
        const session = store.getSession(lane.sessionId).descriptor, profile = this.options.partners.getPartner(binding.partnerId);
        const pending = this.#pendingRestart(lane.sessionId);
        const receipt: PartnerMessagingRestart = { version: 1, operationId: input.operationId, ownerConnectionId: input.owner.id,
          ownerAuthDigest: input.owner.authKeyDigest, connectionId: input.connectionId, conversationId: input.conversationId,
          sessionId: lane.sessionId, sourceGeneration: lane.generation, sourceBindingFingerprint: digest(session.binding.opaqueRef),
          partnerId: profile.id, profileRevision: profile.revision.toString(), bindingRevision: binding.revision, phase: 'closing',
          ...(pending ? { closeOperationId: pending.closeOperationId ?? pending.operationId } : {}) };
        store.setSetting('service', SCOPE, `restart:${input.operationId}`, receipt); return receipt;
      });
    const receipt = this.getRestart(result.value.operationId, input.owner)!;
    return receipt.phase === 'closing' ? this.#advance(receipt) : receipt;
  }
  async restartFromMessage(connection: MessagingConnectionRecord, conversation: MessagingConversationRecord,
    event: MessagingInboundMessage, requestId: string): Promise<void> {
    if (!event.speaker.isOwner || connection.ownerProviderUserId !== event.speaker.providerUserId) throw new StoreError('Only the channel owner can restart a Partner context.');
    const operationId = `im-command-restart:${digest([connection.id, connection.generation, requestId])}`;
    const execution = this.options.store.runOperation({ id: operationId, kind: 'partner_messaging_restart', body: {
      connectionId: connection.id, generation: connection.generation, conversationId: conversation.id, providerUserId: event.speaker.providerUserId } }, store => {
      const binding = this.binding(connection.id), lane = this.lanes(connection.id).find(row => row.conversationId === conversation.id);
      if (!binding.partnerId || binding.partnerId !== conversation.partnerId || !lane?.canRestart) throw new StoreError('The original Partner channel cannot restart.');
      const profile = this.options.partners.getPartner(binding.partnerId), session = store.getSession(lane.sessionId).descriptor;
      const pending = this.#pendingRestart(lane.sessionId);
      const receipt: PartnerMessagingRestart = { version: 1, operationId, ownerConnectionId: '', ownerAuthDigest: '',
        connectionId: connection.id, conversationId: conversation.id, sessionId: lane.sessionId, sourceGeneration: lane.generation,
        sourceBindingFingerprint: digest(session.binding.opaqueRef), partnerId: profile.id, profileRevision: profile.revision.toString(),
        bindingRevision: binding.revision, phase: 'closing', ...(pending ? { closeOperationId: pending.closeOperationId ?? pending.operationId } : {}),
        channelOwner: { generation: connection.generation, credentialGeneration: connection.credentialGeneration ?? '', providerUserId: event.speaker.providerUserId } };
      store.setSetting('service', SCOPE, `restart:${operationId}`, receipt); return receipt;
    });
    const current = this.options.store.findSetting<PartnerMessagingRestart>('service', SCOPE, `restart:${execution.value.operationId}`)!.value;
    const settled = current.phase === 'ready' ? current : await this.#advance(current);
    if (settled.phase !== 'ready') throw new StoreError('The original Partner context is still awaiting confirmed shutdown. Retry from Message platforms.');
  }

  #pendingRestart(sessionId: string): PartnerMessagingRestart | undefined {
    return this.options.store.listSettings('service', SCOPE).flatMap(row => {
      const receipt = row.value as PartnerMessagingRestart;
      if (!row.key.startsWith('restart:') || receipt.sessionId !== sessionId || receipt.phase === 'ready') return [];
      const binding = this.binding(receipt.connectionId), session = this.options.store.getSession(sessionId).descriptor;
      return receipt.partnerId === binding.partnerId && receipt.bindingRevision === binding.revision && receipt.sourceGeneration === session.binding.generation
        && receipt.sourceBindingFingerprint === digest(session.binding.opaqueRef) ? [receipt] : [];
    })[0];
  }
  async retry(operationId: string, owner: ConnectionRecord): Promise<PartnerMessagingRestart> {
    const receipt = this.getRestart(operationId, owner);
    if (!receipt) throw new StoreError('The original channel restart was not found.');
    return receipt.phase === 'ready' ? receipt : this.#advance(receipt);
  }
  #advance(receipt: PartnerMessagingRestart): Promise<PartnerMessagingRestart> {
    const previous = this.#flights.get(receipt.operationId); if (previous) return previous;
    this.#closingSessions.add(receipt.sessionId);
    const task = (async () => {
      const assertCurrent = () => {
        if (receipt.channelOwner) {
          const channel = this.options.store.getMessagingConnection(receipt.connectionId);
          if (!channel.enabled || channel.generation !== receipt.channelOwner.generation || channel.ownerProviderUserId !== receipt.channelOwner.providerUserId
            || (channel.credentialGeneration ?? '') !== receipt.channelOwner.credentialGeneration) throw new StoreError('The original channel owner authorization changed.');
        } else this.options.store.authorizeConnection(receipt.ownerConnectionId, receipt.ownerAuthDigest);
        const binding = this.binding(receipt.connectionId), profile = this.options.partners.getPartner(receipt.partnerId);
        const conversation = this.options.store.getMessagingConversation(receipt.conversationId), session = this.options.store.getSession(receipt.sessionId).descriptor;
        if (binding.revision !== receipt.bindingRevision || binding.partnerId !== receipt.partnerId || profile.revision.toString() !== receipt.profileRevision
          || profile.lifecycle !== 'active' || conversation.status !== 'active' || conversation.sessionId !== receipt.sessionId
          || conversation.partnerBindingRevision !== receipt.bindingRevision || session.binding.generation !== receipt.sourceGeneration
          || session.archived || session.deletedAt !== undefined || digest(session.binding.opaqueRef) !== receipt.sourceBindingFingerprint) throw new StoreError('The original channel restart owner changed.');
      };
      const save = (phase: PartnerMessagingRestart['phase'], failureCode?: string) => {
        const { failureCode: _oldFailure, ...original } = receipt;
        const next: PartnerMessagingRestart = { ...original, phase, ...(failureCode ? { failureCode } : {}) };
        this.options.store.setSetting('service', SCOPE, `restart:${receipt.operationId}`, next); return next;
      };
      try {
        assertCurrent(); save('closing');
        const closeId = receipt.closeOperationId ?? receipt.operationId;
        await this.options.host.restartPartnerSession({ sessionId: receipt.sessionId, operationId: `im-restart:${digest(closeId)}`,
          assertCurrent, pauseGoal: () => this.options.pauseGoal(receipt.sessionId, `im-restart:${digest(closeId)}:goal`) });
        assertCurrent();
        for (const row of this.options.store.listSettings('service', SCOPE)) {
          const prior = row.value as PartnerMessagingRestart;
          if (row.key.startsWith('restart:') && prior.sessionId === receipt.sessionId && prior.bindingRevision === receipt.bindingRevision
            && (prior.closeOperationId ?? prior.operationId) === closeId) this.options.store.setSetting('service', SCOPE, row.key, { ...prior, phase: 'ready' });
        }
        return save('ready');
      } catch { return save('failed', 'CHANNEL_CLOSE_PENDING'); }
    })().finally(() => { if (this.#flights.get(receipt.operationId) === task) this.#flights.delete(receipt.operationId); this.#closingSessions.delete(receipt.sessionId); });
    this.#flights.set(receipt.operationId, task); return task;
  }
}

/** Only the channel actually bound to this native task is mounted. Ordinary
 * replies keep their automatic delivery; explicit sends use the same outbox. */
export class PartnerMessagingTools implements BridgeToolProvider {
  readonly id: string; readonly generation = 1; readonly available = true;
  readonly tools: readonly McpToolDescriptor[];
  constructor(readonly runtime: PartnerMessagingRuntime, readonly channel: string) {
    this.id = `joko_messaging_${channel}`;
    const text = { type: 'string', minLength: 1, maxLength: 256 }, object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
    this.tools = [
      { serverId: this.id, name: 'list_conversations', requiresPermission: false,
        description: `List actual ${channel} conversations owned by this Partner. Follow next_offset to read all pages. A channel task sees only its own recipient; the main private task sees its actual bound connections.`,
        inputSchema: object({ connection_id: text, offset: { type: 'integer', minimum: 0, maximum: 10000 } }) },
      { serverId: this.id, name: 'send_message', requiresPermission: true, requiresNativeRoot: true,
        description: `Queue an explicitly requested ${channel} message or task-owned files to an exact listed connection_id/conversation_id. Ordinary replies to an incoming message are delivered automatically: do not send a second copy. Accepted/pending is not delivered; query get_delivery. Never infer permission to contact someone from group history or a quoted message.`,
        inputSchema: object({ connection_id: text, conversation_id: text, text: { type: 'string', maxLength: 65536 },
          artifact_ids: { type: 'array', maxItems: 100, uniqueItems: true, items: text } }, ['connection_id', 'conversation_id']) },
      { serverId: this.id, name: 'get_delivery', requiresPermission: false,
        description: 'Read the original message operation receipt. Unknown deliveries are not sent again; keep their operation ID.', inputSchema: object({ operation_id: text }, ['operation_id']) }
    ];
  }
  includeForTarget(): boolean { return false; }
  includeForSession(sessionId: string, targetId: string): boolean { return this.runtime.connectionsForSession(sessionId, targetId, this.channel).length > 0; }
  async callTool(name: string, input: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined, context: BridgeToolCallContext) {
    try {
      signal?.throwIfAborted(); context.assertCurrent?.();
      const { store, profiles, partners, messaging } = this.runtime.options, link = profiles.getSessionLink(context.sessionId);
      if (!link || !['canonical', 'channel'].includes(link.role)) throw new StoreError('This task does not own a message channel.');
      const profile = partners.getPartner(link.partnerId), session = store.getSession(context.sessionId).descriptor;
      const bindingFingerprint = digest(session.binding.opaqueRef);
      const connections = this.runtime.connectionsForSession(session.id, context.targetId, this.channel);
      const assertCurrent = () => {
        signal?.throwIfAborted(); context.assertCurrent?.();
        const current = store.getSession(session.id).descriptor, owner = partners.getPartner(profile.id);
        if (context.providerGeneration !== undefined && context.providerGeneration !== this.generation || current.targetId !== context.targetId
          || current.binding.generation !== context.generation || digest(current.binding.opaqueRef) !== bindingFingerprint
          || current.archived || current.deletedAt !== undefined || owner.revision !== profile.revision || owner.lifecycle !== 'active'
          || owner.initializationState !== 'ready' || owner.pauseCleanupPending || owner.homeTargetId !== current.targetId) throw new StoreError('The original Partner channel tool owner changed.');
      };
      assertCurrent(); let result: unknown;
      if (name === 'list_conversations') {
        keys(input, ['connection_id', 'offset']);
        const offset = input['offset'] ?? 0;
        if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 10000) throw new StoreError('The conversation page is invalid.');
        const selected = input['connection_id'] === undefined ? connections : connections.filter(connection => connection.id === input['connection_id']);
        const rows = selected.flatMap(connection => store.listMessagingConversations({ connectionId: connection.id, statuses: ['active'] })
          .filter(row => row.partnerId === profile.id && row.partnerBindingRevision === this.runtime.binding(connection.id).revision
            && (link.role === 'canonical' || row.sessionId === session.id))
          .map(row => ({ connection_id: connection.id, conversation_id: row.id, kind: row.providerThreadId ? 'topic' : row.conversationKind,
            title: row.sessionId ? store.getSession(row.sessionId).descriptor.title : row.providerConversationId, last_activity_at: row.updatedAt })));
        result = { conversations: rows.slice(Number(offset), Number(offset) + 50), total: rows.length,
          ...(rows.length > Number(offset) + 50 ? { next_offset: Number(offset) + 50 } : {}) };
      } else if (name === 'get_delivery') {
        keys(input, ['operation_id']); const id = field(input['operation_id']);
        const operation = store.getOperation(id), body = operation.body as Record<string, unknown>, receipt = operation.response as { deliveryIds?: unknown } | undefined;
        if (operation.kind !== 'partner_messaging_send' || body['partnerId'] !== profile.id || !Array.isArray(receipt?.deliveryIds)
          || !connections.some(connection => connection.id === body['connectionId'])) throw new StoreError('The message operation does not belong to this channel.');
        result = { operation_id: id, deliveries: receipt.deliveryIds.map(value => {
          if (typeof value !== 'string') throw new StoreError('The message receipt is invalid.');
          const delivery = store.getMessagingDelivery(value);
          return { delivery_id: delivery.id, status: delivery.status, ...(delivery.errorCode ? { error_code: delivery.errorCode } : {}) };
        }) };
      } else if (name === 'send_message') {
        keys(input, ['connection_id', 'conversation_id', 'text', 'artifact_ids']);
        if (!context.assertNativeRoot || !/^[a-f0-9]{64}$/u.test(context.effectIdentity ?? '')) throw new StoreError('Sending requires its original native tool approval.');
        context.assertNativeRoot();
        const connection = connections.find(row => row.id === field(input['connection_id'])), conversation = store.getMessagingConversation(field(input['conversation_id']));
        if (!connection || conversation.connectionId !== connection.id || conversation.status !== 'active' || conversation.partnerId !== profile.id
          || link.role === 'channel' && conversation.sessionId !== session.id) throw new StoreError('The message recipient is outside this task’s bound channel.');
        const binding = this.runtime.binding(connection.id), queues = store.listQueueItems({ sessionId: session.id, states: ['dispatching', 'backend_accepted'], limit: 2 });
        if (queues.length !== 1) throw new StoreError('The original message tool turn is unavailable.');
        const queue = queues[0]!;
        if (queue.body.messagingOrigin) this.runtime.assertQueueCurrent(queue);
        const text = input['text'] ?? '', artifactIds = input['artifact_ids'] ?? [];
        if (typeof text !== 'string' || text.length > 65536 || !Array.isArray(artifactIds) || artifactIds.length > 100 || new Set(artifactIds).size !== artifactIds.length) throw new StoreError('The message text or file list is invalid.');
        const attachments = artifactIds.map(id => {
          const artifact = store.getArtifact(field(id));
          if (artifact.sessionId !== session.id || artifact.metadata && typeof artifact.metadata === 'object' && 'expiresAt' in artifact.metadata) throw new StoreError('Only committed artifacts owned by this task can be sent.');
          return { kind: artifact.blob.mimeType.startsWith('image/') ? 'image' as const : 'file' as const, blob: artifact.blob,
            fileName: artifact.blob.fileName ?? `attachment-${artifact.blob.id}` };
        });
        const origin: PartnerMessageDeliveryOrigin = { partnerId: profile.id, profileRevision: profile.revision.toString(), sessionId: session.id,
          queueItemId: queue.id, generation: session.binding.generation, bindingFingerprint, bindingRevision: binding.revision };
        const accepted = messaging.enqueuePartnerMessage({ operationId: `partner-message:${context.effectIdentity}`, partnerId: profile.id,
          connectionId: connection.id, conversationId: conversation.id, expectedConnectionGeneration: connection.generation, text, attachments, origin,
          assertCurrent: () => { assertCurrent(); context.assertNativeRoot!();
            const latest = this.runtime.binding(connection.id), live = store.getMessagingConnection(connection.id);
            if (latest.partnerId !== profile.id || latest.revision !== binding.revision || live.generation !== connection.generation
              || live.credentialGeneration !== connection.credentialGeneration || !live.enabled) throw new StoreError('The approved message channel changed.');
            if (queue.body.messagingOrigin) this.runtime.assertQueueCurrent(queue);
          } });
        result = { operation_id: accepted.operationId, delivery_ids: accepted.deliveryIds, status: 'accepted' };
      } else throw new StoreError('The message tool is unavailable.');
      assertCurrent(); return { isError: false, content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) {
      signal?.throwIfAborted(); return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message.slice(0, 400) : 'The message operation failed.' }] };
    }
  }
}

function keys(value: object, allowed: readonly string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) throw new StoreError('The message tool arguments are invalid.'); }
function field(value: unknown): string { if (typeof value !== 'string' || !value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) throw new StoreError('The message identity is invalid.'); return value; }

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

const READ_ONLY_MESSAGE_TOOLS = new Set(['read', 'glob', 'grep', 'ls', 'notebookread', 'list_tools']);
/** A wrapper must not hide a write from a remote-channel confirmation. */
export function messageToolNeedsConfirmation(name: string, input: unknown, depth = 0): boolean {
  if (depth > 3) return true;
  const leaf = name.toLowerCase().split(/__|::|[:/]/u).at(-1) ?? '';
  if (!input || typeof input !== 'object' || Array.isArray(input)) return !READ_ONLY_MESSAGE_TOOLS.has(leaf);
  const record = input as Record<string, unknown>, inner: Array<{ name: string; input: unknown }> = [];
  const params = record['toolParams'];
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    const value = params as Record<string, unknown>;
    if (typeof value['name'] === 'string') inner.push({ name: value['name'], input: value['args'] ?? value });
  }
  if (['call_tool', 'tool_call', 'joko_call'].includes(leaf)) {
    const wrapped = typeof record['name'] === 'string' ? record['name'] : record['tool'];
    if (typeof wrapped === 'string') inner.push({ name: wrapped, input: record['args'] ?? record });
  }
  return inner.length ? inner.some(value => messageToolNeedsConfirmation(value.name, value.input, depth + 1)) : !READ_ONLY_MESSAGE_TOOLS.has(leaf);
}
