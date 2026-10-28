import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationalStore, PartnerStore, operationBodyHash } from '@joko/store';
import { FakeBackendAdapter, PI_LIKE_PROFILE } from '@joko/testkit';
import type { MessagingInboundMessage } from '@joko/messaging';
import { JokoError } from '@joko/core';
import { ArtifactStore } from './artifact-store.js';
import { OperationalArtifactRepository } from './artifact-repository.js';
import { CredentialManager } from './credential-manager.js';
import { CredentialVault } from './credential-vault.js';
import { SessionHost } from './session-host.js';
import { PartnerManager } from './partner-manager.js';
import { MessagingManager } from './messaging-manager.js';
import { PartnerMessagingRuntime, PartnerMessagingTools, messageToolNeedsConfirmation } from './partner-messaging.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'joko-partner-im-')), store = new OperationalStore(join(root, 'operations.db'));
  const profiles = new PartnerStore(join(root, 'partners.db'));
  const artifacts = new ArtifactStore({ rootDirectory: join(root, 'artifacts'), repository: new OperationalArtifactRepository(store), ingestRoots: [root] });
  await artifacts.initialize(); const vault = await CredentialVault.open(join(root, 'vault.key'));
  const credentials = new CredentialManager({ vault, storagePath: join(root, 'credentials.json') }); await credentials.initialize();
  const adapter = new FakeBackendAdapter(PI_LIKE_PROFILE); let runtime: PartnerMessagingRuntime | undefined, activeMessaging: MessagingManager | undefined;
  const host = new SessionHost(store, artifacts, [adapter], { partnerSessionRestarting: id => runtime?.isRestarting(id) === true,
    onServiceRunSettled: input => activeMessaging?.onRunSettled(input) }); await host.initialize();
  const partners = new PartnerManager({ store: profiles, operationalStore: store, sessionHost: host, homesRoot: join(root, 'homes'),
    workspaceService: { register: async input => input, unregister: () => undefined } });
  const created = await partners.createPartner({ requestId: 'im-partner-create', expectedDirectoryRevision: profiles.directoryState().revision,
    displayName: 'Ada', avatar: 'orbit', identitySource: 'Full personal identity for every real channel lane.', templateId: 'general', usesDirectoryDefaults: false,
    capabilities: { modelChain: [{ backendId: adapter.id, providerId: 'test', modelId: 'text', effort: 'medium', fastMode: false }], permissionMode: 'ask', planMode: false } });
  const partner = partners.getPartner(created.id), owner = store.createConnection({ id: 'im-ui-owner', name: 'Owner', authKeyDigest: 'im-ui-owner-auth' });
  const messaging = new MessagingManager({ store, credentials, contextVault: vault, sessionHost: host, artifacts }); await messaging.initialize();
  activeMessaging = messaging;
  runtime = new PartnerMessagingRuntime({ store, profiles, partners, host, messaging, pauseGoal: async () => undefined });
  messaging.setPartnerRuntime(runtime); host.setMessagingQueueGuard(item => runtime!.assertQueueCurrent(item));
  const connect = async () => {
    const initial = messaging.createTelegramConnection({ ownerProviderUserId: '123456' });
    const input = { operationId: `bind:${initial.id}`, owner, connectionId: initial.id, expectedConnectionRevision: initial.revision,
      expectedConnectionGeneration: initial.generation, expectedBindingRevision: 0, partnerId: partner.id, expectedPartnerRevision: partner.revision };
    const saved = await runtime!.setBinding(input);
    const enabled = store.replaceMessagingCredential({ connectionId: initial.id, expectedRevision: saved.connection.revision,
      expectedGeneration: saved.connection.generation, credentialReferenceId: `im-credential:${initial.id}`, credentialGeneration: 'a'.repeat(64), enable: true });
    return { connection: enabled, input, saved };
  };
  const event = (connectionId: string, address = '123456', thread: string | null = null, kind: 'direct' | 'group' = 'direct', isOwner = true): MessagingInboundMessage => ({
    kind: 'message', messageId: `message:${address}:${thread ?? ''}`, providerRequestIds: [`request:${address}:${thread ?? ''}`],
    address: { channel: 'telegram', connectionId, providerConversationId: address, providerThreadId: thread, conversationKind: kind },
    speaker: { providerUserId: isOwner ? '123456' : '654321', displayName: isOwner ? 'Owner' : 'Visitor', username: null, isBot: false, isOwner },
    occurredAt: Date.now(), text: 'Remember only this actual owner utterance.', ambient: false, protectedContent: false, attachments: [], unsupported: [], replyContext: null
  });
  const resolve = async (message: MessagingInboundMessage) => {
    const connection = store.getMessagingConnection(message.address.connectionId);
    const conversation = store.ensureMessagingConversation({ connectionId: connection.id, expectedChannelGeneration: connection.generation,
      providerConversationId: message.address.providerConversationId, ...(message.address.providerThreadId ? { providerThreadId: message.address.providerThreadId } : {}),
      conversationKind: message.address.conversationKind });
    return (await runtime!.resolve(conversation, message))!;
  };
  cleanups.push(async () => { await messaging.close(); await host.dispose(); profiles.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, profiles, artifacts, adapter, host, partners, partner, owner, messaging, runtime, connect, event, resolve };
}

describe('Partner message routing', () => {
  it('forces confirmation for writes hidden by dispatch wrappers and keeps known reads in the original policy', () => {
    expect(messageToolNeedsConfirmation('Read', {})).toBe(false);
    expect(messageToolNeedsConfirmation('mcp__tools__call_tool', { name: 'Read', args: { path: 'notes.md' } })).toBe(false);
    expect(messageToolNeedsConfirmation('call_tool', { toolParams: { name: 'call_tool', args: { name: 'overwrite', args: { path: 'notes.md' } } } })).toBe(true);
    expect(messageToolNeedsConfirmation('mcp__browser__navigate', {})).toBe(true);
    expect(messageToolNeedsConfirmation('schedule_resume', {})).toBe(true);
  });
  it('shares only owner DMs with the canonical task and isolates real groups, topics and visitor DMs', async () => {
    const f = await fixture(), a = await f.connect(), b = await f.connect();
    const dm = await f.resolve(f.event(a.connection.id)), otherDm = await f.resolve(f.event(b.connection.id));
    expect(dm.sessionId).toBe(f.partner.canonicalSessionId); expect(otherDm.sessionId).toBe(dm.sessionId);
    expect(f.store.findMessagingConversationBySessionId(dm.sessionId!)).toBeUndefined();
    const main = await f.resolve(f.event(a.connection.id, '-100', null, 'group'));
    const topic = await f.resolve(f.event(a.connection.id, '-100', '7', 'group'));
    const second = await f.resolve(f.event(a.connection.id, '-100', '8', 'group'));
    const visitor = await f.resolve(f.event(a.connection.id, '654321', null, 'direct', false));
    expect(new Set([dm.sessionId, main.sessionId, topic.sessionId, second.sessionId, visitor.sessionId]).size).toBe(5);
    expect((await f.resolve(f.event(a.connection.id, '-100', '7', 'group'))).sessionId).toBe(topic.sessionId);
    const linked = f.profiles.getSessionLink(topic.sessionId!)!;
    expect(linked.role).toBe('channel'); expect(f.store.getSession(linked.sessionId).descriptor.hidden).toBe(true);
    expect(f.partners.listSessions(f.partner.id).some(row => row.link.role === 'channel')).toBe(false);
    expect(f.partners.listSessions(f.partner.id, true).filter(row => row.link.role === 'channel')).toHaveLength(4);
    expect(f.runtime!.lanes(a.connection.id)).toHaveLength(5);
  });
  it('keeps the binding save receipt and rejects source work after exact credential or binding retirement', async () => {
    const f = await fixture(), source = await f.connect();
    expect(await f.runtime!.setBinding(source.input)).toEqual(source.saved);
    const message = f.event(source.connection.id), conversation = await f.resolve(message);
    const inbound = f.store.createMessagingInboundRequest({ connectionId: source.connection.id, expectedChannelGeneration: source.connection.generation,
      conversationId: conversation.id, providerRequestIds: message.providerRequestIds, providerMessageId: message.messageId,
      bodyHash: operationBodyHash(message), protectedContent: false, occurredAt: Date.now(), receivedAt: Date.now() }).request;
    const origin = f.runtime!.origin(conversation, message, inbound.id)!;
    f.store.setQueuePaused({ sessionId: conversation.sessionId!, paused: true, traceId: 'hold-source' });
    const admission = f.host.enqueueServiceInput({ operationId: `messaging-input-${inbound.id}`, sessionId: conversation.sessionId!, source: 'system',
      prompt: { text: 'Untrusted group and quote context\n\nActual owner utterance.', mentions: [], images: [], files: [], disposition: 'prompt', messagingOrigin: origin },
      onAdmitted: (store, admitted) => store.bindMessagingInboundAdmission({ requestId: inbound.id, expectedRevision: inbound.revision, conversationId: conversation.id,
        operationId: `messaging-input-${inbound.id}`, runId: admitted.runId, attemptId: admitted.attemptId, queueItemId: admitted.queueItemId }) });
    const queue = f.store.getQueueItem(admission.value.queueItemId); expect(() => f.runtime!.assertQueueCurrent(queue)).not.toThrow();
    expect(queue.body.messagingOrigin?.userText).toBe(message.text);
    const current = f.store.getMessagingConnection(source.connection.id);
    f.store.replaceMessagingCredential({ connectionId: current.id, expectedRevision: current.revision, expectedGeneration: current.generation,
      credentialReferenceId: `im-credential:${current.id}`, credentialGeneration: 'b'.repeat(64), enable: true });
    expect(() => f.runtime!.assertQueueCurrent(queue)).toThrow('no longer authorized');
    expect(f.runtime!.binding(current.id).partnerId).toBe(f.partner.id);
  });
  it('uses the original Host close/rebuild, keeps native-close failure visible, and retries the same owner', async () => {
    const f = await fixture(), source = await f.connect(), conversation = await f.resolve(f.event(source.connection.id, '-100', '9', 'group'));
    const session = f.store.getSession(conversation.sessionId!).descriptor, close = vi.spyOn(f.adapter, 'closeSession').mockRejectedValueOnce(new Error('Close unconfirmed'));
    const request = { operationId: 'restart-original-im-lane', owner: f.owner, connectionId: source.connection.id, conversationId: conversation.id,
      expectedBindingRevision: f.runtime!.binding(source.connection.id).revision, expectedSessionGeneration: session.binding.generation };
    expect((await f.runtime!.restart(request)).phase).toBe('failed');
    expect(f.runtime!.isRestarting(session.id)).toBe(true);
    expect((await f.runtime!.retry(request.operationId, f.owner)).phase).toBe('ready');
    expect(f.runtime!.isRestarting(session.id)).toBe(false);
    expect(f.store.findPendingContextRebuild(session.id)?.reason).toBe('manual_restart');
    expect(f.runtime!.lanes(source.connection.id).find(row => row.sessionId === session.id)?.contextMessageCount).toBe(0);
    expect((await f.runtime!.restart(request)).phase).toBe('ready'); expect(close).toHaveBeenCalledTimes(2);
    const stranger = f.store.createConnection({ id: 'different-ui-owner', name: 'Other device', authKeyDigest: 'different-auth' });
    expect(() => f.runtime!.getRestart(request.operationId, stranger)).toThrow('another connection');
  });
  it('routes a safe native overflow recovery to the same inbound owner after the original Queue generation renews', async () => {
    const f = await fixture(), source = await f.connect(), message = f.event(source.connection.id, '-100', 'overflow', 'group');
    const conversation = await f.resolve(message);
    const inbound = f.store.createMessagingInboundRequest({ connectionId: source.connection.id, expectedChannelGeneration: source.connection.generation,
      conversationId: conversation.id, providerRequestIds: message.providerRequestIds, providerMessageId: message.messageId,
      bodyHash: operationBodyHash(message), protectedContent: false, occurredAt: Date.now(), receivedAt: Date.now() }).request;
    const origin = f.runtime!.origin(conversation, message, inbound.id)!, firstGeneration = f.store.getSession(conversation.sessionId!).descriptor.binding.generation;
    vi.spyOn(f.adapter, 'send').mockRejectedValueOnce(new JokoError({ code: 'CONTEXT_OVERFLOW', message: 'Context is full', phase: 'dispatch',
      retryable: false, stateMayHaveChanged: false, recovery: 'Rebuild the context before retrying.' }));
    const admission = f.host.enqueueServiceInput({ operationId: `messaging-input-${inbound.id}`, sessionId: conversation.sessionId!, source: 'system',
      prompt: { text: message.text, mentions: [], images: [], files: [], disposition: 'prompt', messagingOrigin: origin },
      onAdmitted: (store, result) => { store.bindMessagingInboundAdmission({ requestId: inbound.id, expectedRevision: inbound.revision,
        conversationId: conversation.id, operationId: `messaging-input-${inbound.id}`, runId: result.runId, queueItemId: result.queueItemId, attemptId: result.attemptId }); } });
    await vi.waitFor(() => expect(f.store.getMessagingInboundRequest(inbound.id).status).toBe('completed'), { timeout: 5000 });
    const replay = f.store.listQueueItems({ sessionId: conversation.sessionId! }).find(row => row.id !== admission.value.queueItemId)!;
    expect(f.store.getOperation(replay.operationId).kind).toBe('context_overflow_replay'); expect(replay.body.messagingOrigin).toEqual(origin);
    expect(f.store.findMessagingInboundRequestByRunId(replay.runId)?.id).toBe(inbound.id);
    expect(f.store.getMessagingConversation(conversation.id).sessionGeneration).toBeGreaterThan(firstGeneration);
    expect(f.store.listMessagingDeliveries().filter(row => row.kind === 'text')).toContainEqual(expect.objectContaining({ conversationId: conversation.id }));
  });
  it('mounts only actual bound outbound tools and queues an approved own-task file once through the original outbox', async () => {
    const f = await fixture(), a = await f.connect(), b = await f.connect(), direct = await f.resolve(f.event(a.connection.id));
    const channel = await f.resolve(f.event(a.connection.id, '-100', 'channel', 'group'));
    const tools = new PartnerMessagingTools(f.runtime!, 'telegram'), foreign = new PartnerMessagingTools(f.runtime!, 'feishu');
    const session = f.store.getSession(f.partner.canonicalSessionId!).descriptor;
    expect(tools.includeForSession(session.id, session.targetId)).toBe(true); expect(foreign.includeForSession(session.id, session.targetId)).toBe(false);
    expect(f.runtime!.connectionsForSession(channel.sessionId!, session.targetId, 'telegram').map(row => row.id)).toEqual([a.connection.id]);
    f.store.createRun({ id: 'explicit-send-run', sessionId: session.id, source: 'user', state: 'running', createdAt: Date.now() });
    f.store.createAttempt({ id: 'explicit-send-attempt', runId: 'explicit-send-run', ordinal: 1, generation: session.binding.generation, startedAt: Date.now() });
    f.store.runOperation({ id: 'explicit-send-input', kind: 'prompt', body: {} }, store => {
      store.enqueueQueueItem({ id: 'explicit-send-queue', sessionId: session.id, runId: 'explicit-send-run', attemptId: 'explicit-send-attempt',
        operationId: 'explicit-send-input', disposition: 'prompt', body: { text: 'Send this report.', images: [], files: [], mentions: [], disposition: 'prompt' } }); return {};
    });
    f.store.claimNextQueueItem({ sessionId: session.id, backendInstanceGeneration: 0, traceId: 'explicit-send-dispatch' });
    const staged = await f.artifacts.ingestBytes(new Uint8Array([1, 2, 3]), { fileName: 'report.txt', mimeType: 'text/plain' });
    const owned = f.store.adoptSessionArtifact({ blob: staged, sessionId: session.id, runId: 'explicit-send-run' });
    const caller = { sessionId: session.id, targetId: session.targetId, generation: session.binding.generation,
      effectIdentity: 'e'.repeat(64), assertNativeRoot: () => undefined, assertCurrent: () => undefined };
    const input = { connection_id: a.connection.id, conversation_id: direct.id, text: 'The requested report.', artifact_ids: [owned.blob.id] };
    const result = await tools.callTool('send_message', input, undefined, caller);
    expect(result.isError).toBe(false); expect((await tools.callTool('send_message', input, undefined, caller)).isError).toBe(false);
    const deliveries = f.store.listMessagingDeliveries(); expect(deliveries).toHaveLength(2);
    expect(deliveries.every(row => row.connectionId === a.connection.id && row.conversationId === direct.id)).toBe(true);
    expect(tools.tools.find(row => row.name === 'send_message')).toMatchObject({ requiresPermission: true, requiresNativeRoot: true });
    const sessionCaller = { ...caller, sessionId: channel.sessionId!, generation: f.store.getSession(channel.sessionId!).descriptor.binding.generation };
    expect((await tools.callTool('send_message', { ...input, connection_id: b.connection.id }, undefined, sessionCaller)).isError).toBe(true);
    const current = f.store.getMessagingConnection(a.connection.id);
    f.store.setMessagingConnectionEnabled({ connectionId: current.id, expectedRevision: current.revision, expectedGeneration: current.generation, enabled: false });
    expect(() => f.runtime!.assertOutboundCurrent(deliveries[0]!)).toThrow();
  });
});
