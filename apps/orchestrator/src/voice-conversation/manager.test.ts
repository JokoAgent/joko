import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { Code, createClient, createRouterTransport } from '@connectrpc/connect';
import * as contract from '@joko/contracts';
import { DESKTOP_HOST_AUTHORIZATION_HEADER } from '@joko/contracts/desktop-bootstrap';
import { OperationalStore } from '@joko/store';
import { FakeBackendAdapter, PI_LIKE_PROFILE } from '@joko/testkit';
import { expect, it, vi } from 'vitest';
import { ArtifactStore } from '../artifact-store.js';
import { OperationalArtifactRepository } from '../artifact-repository.js';
import { ConnectionManager } from '../connection-manager.js';
import { SessionHost } from '../session-host.js';
import type { ModelRouteCatalog } from '../personalization-inference.js';
import { createDesktopVoiceConversationService } from './connect-service.js';
import { DesktopVoiceConversationManager } from './manager.js';
import { SpeechModelCatalog } from './models.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'joko-voice-call-')), store = new OperationalStore(':memory:'), connections = new ConnectionManager(store);
  const desktop = connections.issueTrustedDesktopConnection({ desktopInstanceId: randomUUID(), desktopDeviceId: randomUUID(), defaultDeviceName: 'Desktop',
    platform: process.platform, appVersion: '0.1.0', desktopHostAuthKey: 'h'.repeat(43) });
  connections.confirmTrustedDesktopConnection(desktop.connection.id, desktop.authKey);
  const headers = { authorization: `Bearer ${desktop.authKey}`, [DESKTOP_HOST_AUTHORIZATION_HEADER]: `Bearer ${'h'.repeat(43)}` };
  const artifacts = new ArtifactStore({ rootDirectory: join(root, 'artifacts'), repository: new OperationalArtifactRepository(store), ingestRoots: [root] });
  await artifacts.initialize();
  const adapter = new FakeBackendAdapter(PI_LIKE_PROFILE), host = new SessionHost(store, artifacts, [adapter]); await host.initialize();
  await host.registerTarget({ id: 'workspace', backendId: adapter.id, displayName: 'Workspace', workspaceRoot: root, trusted: true, managed: true });
  const model = PI_LIKE_PROFILE.models[0]!;
  const sessionId = (await host.createSession({ operationId: 'create-call-task', connection: desktop.connection, targetId: 'workspace', title: 'Call task',
    providerId: model.providerId, modelId: model.modelId, permissionMode: 'ask', planMode: false, fastMode: false })).value.sessionId;
  let credentialGeneration = 'original', enabled = true;
  const reference = { backendId: adapter.id, providerId: model.providerId, modelId: model.modelId };
  const routes: ModelRouteCatalog = { list: () => enabled ? [{ ...reference, credentialRoute: true, supportsImages: false }] : [],
    resolve: value => enabled && value.backendId === reference.backendId && value.providerId === reference.providerId && value.modelId === reference.modelId ? { ...reference, generationId: credentialGeneration,
      api: 'openai-completions', baseUrl: 'https://provider.test/prefix/v1', authorization: 'Bearer private-speech-key', headers: {}, supportsImages: false } : undefined };
  const infer = vi.fn<ConstructorParameters<typeof DesktopVoiceConversationManager>[0]['infer']>(async () => '{"say":"Hello from the call."}');
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'audio/pcm' } }));
  const companion = () => ({ identity: 'My companion', token: 'original-profile' });
  let manager = new DesktopVoiceConversationManager({ store, host, models: new SpeechModelCatalog(store, routes), companion, infer, fetch: fetcher });
  const rpc = () => createClient(contract.DesktopVoiceConversationService, createRouterTransport(router => router.service(contract.DesktopVoiceConversationService,
    createDesktopVoiceConversationService(manager, connections))));
  const base = { windowId: 'desktop-window-one', sessionId, sessionGeneration: BigInt(store.getSession(sessionId).descriptor.binding.generation) };
  const speech = create(contract.DesktopSpeechSelectionSchema, { ...reference, protocol: 'openai', voice: 'alloy' });
  const control = (action: contract.DesktopVoiceConversationAction, input: MessageInitShape<typeof contract.ControlDesktopVoiceConversationRequestSchema> = {}) =>
    rpc().controlDesktopVoiceConversation({ ...base, action, ...input }, { headers });
  const start = (callId = 'call-one', playbackOnly = false) => control(contract.DesktopVoiceConversationAction.START,
    { callId, operationId: `start-${callId}`, selection: speech, playbackOnly });
  return { root, store, connections, desktop, host, adapter, reference, headers, base, speech, infer, fetcher, control, start, rpc,
    rotate: () => { credentialGeneration = 'replacement'; }, disable: () => { enabled = false; },
    restart: () => { manager.close(); manager = new DesktopVoiceConversationManager({ store, host, models: new SpeechModelCatalog(store, routes), companion, infer, fetch: fetcher }); },
    close: async () => { manager.close(); await host.dispose(); store.close(); await rm(root, { recursive: true, force: true }); } };
}

it('requires the private committed Desktop proof and never makes an ordinary bearer a voice host', async () => {
  const f = await fixture();
  try {
    const request = { ...f.base, action: contract.DesktopVoiceConversationAction.SNAPSHOT };
    await expect(f.rpc().controlDesktopVoiceConversation(request, { headers: { authorization: f.headers.authorization } })).rejects.toBeDefined();
    await expect(f.rpc().controlDesktopVoiceConversation(request, { headers: { ...f.headers, [DESKTOP_HOST_AUTHORIZATION_HEADER]: 'Bearer wrong' } })).rejects.toBeDefined();
    expect((await f.control(contract.DesktopVoiceConversationAction.SNAPSHOT)).models).toHaveLength(1);
    f.connections.revoke(f.desktop.connection.id);
    await expect(f.control(contract.DesktopVoiceConversationAction.SNAPSHOT)).rejects.toBeDefined();
  } finally { await f.close(); }
});

it('keeps casual conversation out of Queue and hands off the exact utterance once through the real host', async () => {
  const f = await fixture();
  try {
    await f.start();
    const submit = { callId: 'call-one', inputId: 'utterance-one', text: 'Hello in this call.' };
    await f.control(contract.DesktopVoiceConversationAction.SUBMIT, submit);
    await vi.waitFor(() => expect(f.infer).toHaveBeenCalledOnce());
    expect(f.store.listQueueItems({ sessionId: f.base.sessionId })).toHaveLength(0);
    await expect(f.control(contract.DesktopVoiceConversationAction.SUBMIT, { ...submit, text: 'Different text' })).rejects.toMatchObject({ code: Code.AlreadyExists });
    await f.control(contract.DesktopVoiceConversationAction.PROMOTE, { callId: 'call-one', inputId: 'utterance-one' });
    await f.control(contract.DesktopVoiceConversationAction.PROMOTE, { callId: 'call-one', inputId: 'utterance-one' });
    const queue = f.store.listQueueItems({ sessionId: f.base.sessionId }); expect(queue).toHaveLength(1); expect(queue[0]!.body.text).toBe(submit.text);
    await vi.waitFor(async () => expect((await f.control(contract.DesktopVoiceConversationAction.SNAPSHOT)).call?.handoffs[0]?.state).toBe('completed'));
    await f.control(contract.DesktopVoiceConversationAction.END, { callId: 'call-one' });
    expect(f.store.listQueueItems({ sessionId: f.base.sessionId })).toHaveLength(1);
    const disk = JSON.stringify(f.store.listSettings().map(row => row.value)); expect(disk).not.toContain('private-speech-key'); expect(disk).not.toContain('Bearer ');
  } finally { await f.close(); }
});

it('retains independent conversation/playback preferences and original save receipts', async () => {
  const f = await fixture();
  try {
    const preference = create(contract.DesktopVoiceConversationPreferenceSchema, { revision: 0n, conversation: f.speech,
      playback: { ...f.speech, voice: 'nova' }, sentencePlayback: false });
    const input = { operationId: 'save-voices', preference };
    await f.control(contract.DesktopVoiceConversationAction.SAVE_PREFERENCE, input);
    const replay = await f.control(contract.DesktopVoiceConversationAction.SAVE_PREFERENCE, input);
    expect(replay.preference).toMatchObject({ conversation: { voice: 'alloy' }, playback: { voice: 'nova' }, sentencePlayback: false, revision: 1n });
    await expect(f.control(contract.DesktopVoiceConversationAction.SAVE_PREFERENCE, { ...input, preference: { ...preference, sentencePlayback: true } })).rejects.toBeDefined();
    await f.control(contract.DesktopVoiceConversationAction.SAVE_PREFERENCE, { operationId: 'reset-voices', preference: create(contract.DesktopVoiceConversationPreferenceSchema, { revision: 1n, sentencePlayback: true }) });
    const reset = (await f.control(contract.DesktopVoiceConversationAction.SNAPSHOT)).preference;
    expect(reset).toMatchObject({ sentencePlayback: true, revision: 2n });
    expect(reset?.conversation).toBeUndefined(); expect(reset?.playback).toBeUndefined();
    expect((await f.control(contract.DesktopVoiceConversationAction.SAVE_PREFERENCE, input)).preference).toEqual(reset);
    await expect(f.control(contract.DesktopVoiceConversationAction.SAVE_PREFERENCE, { ...input, operationId: 'stale-voices' })).rejects.toMatchObject({ code: Code.Aborted });
  } finally { await f.close(); }
});

it('fences competing windows, freezes exact credentials, and never repeats an uncertain synthesis', async () => {
  const f = await fixture();
  try {
    await f.start('read-one', true);
    await expect(f.control(contract.DesktopVoiceConversationAction.START, { callId: 'other-call', operationId: 'start-other', windowId: 'other-window', selection: f.speech, playbackOnly: true })).rejects.toMatchObject({ code: Code.ResourceExhausted });
    const input = { callId: 'read-one', speechRequestId: 'speech-one', text: 'Speak exactly once.' };
    await f.control(contract.DesktopVoiceConversationAction.SPEAK, input);
    await f.control(contract.DesktopVoiceConversationAction.SPEAK, input); expect(f.fetcher).toHaveBeenCalledOnce();
    await f.control(contract.DesktopVoiceConversationAction.READ_SPEECH, { callId: 'read-one', speechRequestId: 'speech-one', operationId: 'read-one-1' });
    f.rotate();
    await expect(f.control(contract.DesktopVoiceConversationAction.READ_SPEECH, { callId: 'read-one', speechRequestId: 'speech-one', operationId: 'read-one-2' })).rejects.toBeDefined();
    expect(f.fetcher).toHaveBeenCalledOnce();
    f.restart();
    expect((await f.control(contract.DesktopVoiceConversationAction.SNAPSHOT)).history[0]?.endedAtMs).toBeTypeOf('bigint');
  } finally { await f.close(); }
});

it('rejects original-generation call activity after a task reset', async () => {
  const f = await fixture();
  try {
    await f.start(); const session = f.store.getSession(f.base.sessionId).descriptor;
    f.store.updateSession(session.id, { binding: { ...session.binding, generation: session.binding.generation + 1 } });
    await expect(f.control(contract.DesktopVoiceConversationAction.SUBMIT, { callId: 'call-one', inputId: 'late-input', text: 'Late' })).rejects.toBeDefined();
    expect(f.infer).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
it('keeps exit classification stateless, exact-route-bound and idempotent without dispatching task work', async () => {
  const f = await fixture();
  try {
    await f.start(); f.infer.mockResolvedValue('SUBMIT_THEN_EXIT');
    const input = { callId: 'call-one', inputId: 'exit-input', text: 'Research this, then exit voice chat.' };
    const first = await f.control(contract.DesktopVoiceConversationAction.CLASSIFY_EXIT, input);
    expect(first.exitDecision).toBe('submit_then_exit');
    expect((await f.control(contract.DesktopVoiceConversationAction.CLASSIFY_EXIT, input)).exitDecision).toBe('submit_then_exit');
    expect(f.infer).toHaveBeenCalledOnce(); expect(f.infer.mock.calls[0]?.[1].user).toBe(JSON.stringify(input.text));
    expect((await f.control(contract.DesktopVoiceConversationAction.SNAPSHOT)).call?.turns).toHaveLength(0);
    expect(f.store.listQueueItems({ sessionId: f.base.sessionId })).toHaveLength(0);
    expect(JSON.stringify(f.store.listSettings().map(row => row.value))).not.toContain(input.text);
  } finally { await f.close(); }
});
