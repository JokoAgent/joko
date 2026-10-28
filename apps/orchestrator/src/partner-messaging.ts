import { createHash } from 'node:crypto';
import type { PromptInput, SessionDescriptor } from '@joko/core';
import type { MessagingInboundEvent, MessagingInboundMessage } from '@joko/messaging';
import { StoreError, type ConnectionRecord, type MessagingConnectionRecord, type MessagingConversationRecord,
  type OperationalStore, type PartnerStore, type QueueItemRecord } from '@joko/store';
import type { PartnerManager } from './partner-manager.js';
import type { SessionHost } from './session-host.js';
import type { MessagingManager } from './messaging-manager.js';

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

/** Uses the existing channel worker and Partner/Host owners. Binding never
 * copies credentials or starts an additional provider consumer. */
export class PartnerMessagingRuntime {
  readonly #flights = new Map<string, Promise<PartnerMessagingRestart>>();
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

  async lifecycle(partnerId: string, state: 'active' | 'paused' | 'deleted'): Promise<void> {
    for (const binding of this.listBindings().filter(row => row.partnerId === partnerId)) {
      const key = `paused:${partnerId}:${binding.connectionId}`, connection = this.options.store.getMessagingConnection(binding.connectionId);
      if (state === 'deleted') {
        await this.options.messaging.retirePartnerConnection(connection.id, store => {
          const current = this.binding(connection.id);
          if (current.partnerId !== partnerId || current.revision !== binding.revision) throw new StoreError('The Partner channel changed during deletion.');
          store.setSetting('service', SCOPE, `binding:${connection.id}`, { version: 1, revision: current.revision + 1 });
          store.deleteSetting('service', SCOPE, key);
        });
      } else if (state === 'paused' && connection.enabled) {
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
      || conversation.sessionId !== item.sessionId || conversation.sessionGeneration !== session.binding.generation
      || conversation.partnerId !== profile.id || conversation.partnerBindingRevision !== binding.revision
      || request.conversationId !== conversation.id || request.runId !== item.runId || request.queueItemId !== item.id
      || request.connectionId !== connection.id || request.channelGeneration !== origin.channelGeneration
      || profile.lifecycle !== 'active' || profile.initializationState !== 'ready' || profile.pauseCleanupPending
      || profile.homeTargetId !== session.targetId || session.archived || session.deletedAt !== undefined
      || link?.partnerId !== profile.id || !['canonical', 'channel'].includes(link.role)
      || link.role === 'canonical' && profile.canonicalSessionId !== session.id
      || origin.isOwner && connection.ownerProviderUserId !== origin.providerUserId) throw new StoreError('The originating Partner message channel is no longer authorized.');
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
        contextMessageCount: count, canRestart: profile.lifecycle === 'active' && ![...this.#flights.values()].length
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
    })().finally(() => { if (this.#flights.get(receipt.operationId) === task) this.#flights.delete(receipt.operationId); });
    this.#flights.set(receipt.operationId, task); return task;
  }
}

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
