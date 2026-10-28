import { createHash } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import * as contract from '@joko/contracts';
import type { NativeTextInferenceInput } from '@joko/core';
import type { ConnectionRecord, OperationalStore } from '@joko/store';
import { NotFoundError } from '@joko/store';
import type { SessionHost } from '../session-host.js';
import { VoiceCallContext, type VoiceCallRecord } from './call-context.js';
import { SpeechModelCatalog, type SpeechSelection } from './models.js';
import { SpeechSynthesisSession } from './speech.js';
import { loadSpeechVoices } from './voices.js';
import { classifyVoiceExit } from './semantic-exit.js';

const SCOPE = 'desktop.voice-conversation.v1';
const CALL_SCOPE = 'runtime.desktop-voice-call:';
interface Preference { readonly conversation?: SpeechSelection; readonly playback?: SpeechSelection; readonly sentencePlayback: boolean; readonly revision: number; }
interface SavedCall { readonly format: 1; readonly sessionId: string; readonly generation: number; readonly kind: 'conversation' | 'playback'; readonly record: VoiceCallRecord; }
export interface DesktopVoiceAuthority { readonly connection: ConnectionRecord; readonly assertCurrent: () => void; }
interface Call {
  readonly id: string; readonly operationId: string; readonly owner: string; readonly sessionId: string; readonly generation: number;
  readonly kind: SavedCall['kind']; readonly context: VoiceCallContext; readonly selection: SpeechSelection;
  readonly authority: DesktopVoiceAuthority; readonly speech: SpeechSynthesisSession;
  readonly assertCurrent: () => void; readonly speechIds: Map<string, string>;
  readonly dispatches: Map<string, { runId: string; queueItemId: string; cursor: bigint; text: string }>;
  readonly reads: Map<string, { pcm: Uint8Array; done: boolean }>;
  readonly readIds: Set<string>;
  readonly inputs: Map<string, string>;
  readonly exitJudgments: Map<string, { readonly text: string; readonly result: Promise<string> }>;
  readonly inferExit: (text: string) => Promise<string>;
  speechId?: string; speechReadId?: string; touchedAt: number;
}
/** One local Desktop call lease. Model context has no tools. Transcripts are
 * durable product records; only explicitly handed off utterances enter Queue. */
export class DesktopVoiceConversationManager {
  #call?: Call;
  readonly #timer: ReturnType<typeof setInterval>;
  constructor(readonly options: { readonly store: OperationalStore; readonly host: Pick<SessionHost, 'enqueueInput'>;
    readonly models: SpeechModelCatalog; readonly infer: (backendId: string, input: NativeTextInferenceInput) => Promise<string>;
    readonly companion: (sessionId: string) => { readonly identity: string; readonly token: string };
    readonly dictationActive?: (connectionId: string) => boolean;
    readonly fetch: typeof fetch; readonly now?: () => number }) {
    // Recovered calls have no live mic/model owner. End their exact records;
    // accepted task work retains its independent Queue ownership.
    for (const value of options.store.listSettings().filter(value => value.scopeType === 'session' && value.key.startsWith(CALL_SCOPE))) {
      const saved = value.value as SavedCall;
      if (saved?.format !== 1 || !saved.record?.callId || saved.sessionId !== value.scopeId || value.key !== `${CALL_SCOPE}${saved.record.callId}`) throw unavailable();
      if (saved.record.endedAt === undefined) options.store.setSetting('session', saved.sessionId, value.key,
        { ...saved, record: { ...saved.record, endedAt: this.#now() } });
    }
    this.#timer = setInterval(() => {
      const call = this.#call;
      if (!call) return;
      try {
        call.assertCurrent();
        if (call.touchedAt + 60_000 < this.#now()) { this.#end(call); return; }
        this.#collectResults(call);
      } catch { this.#end(call); }
    }, 1_000); this.#timer.unref();
  }
  close(): void { clearInterval(this.#timer); if (this.#call) this.#end(this.#call); }
  async control(request: contract.ControlDesktopVoiceConversationRequest, authority: DesktopVoiceAuthority): Promise<contract.ControlDesktopVoiceConversationResponse> {
    authority.assertCurrent();
    identity(request.windowId); identity(request.sessionId);
    const session = this.options.store.getSession(request.sessionId).descriptor;
    const generation = integer(request.sessionGeneration);
    if (session.deletedAt !== undefined || session.archived || session.remoteWorkspace !== undefined || session.binding.generation !== generation) throw unavailable();
    const companion = this.options.companion(session.id);
    const owner = JSON.stringify([authority.connection.id, request.windowId]);
    const action = request.action;
    if (action === contract.DesktopVoiceConversationAction.SNAPSHOT) {
      const own = this.#call?.owner === owner && this.#call.sessionId === request.sessionId && (!request.callId || request.callId === this.#call.id) ? this.#call : undefined;
      if (own) { own.assertCurrent(); own.touchedAt = this.#now(); this.#collectResults(own); }
      const saved = !own && request.callId ? this.options.store.findSetting<SavedCall>('session', request.sessionId, `${CALL_SCOPE}${identity(request.callId, 64)}`)?.value : undefined;
      return this.#snapshot(request.sessionId, generation, own, saved?.format === 1 && saved.record.endedAt !== undefined ? saved : undefined);
    }
    if (action === contract.DesktopVoiceConversationAction.SAVE_PREFERENCE) {
      const incoming = request.preference; if (!incoming) throw invalid();
      const previous = this.#preference(request.sessionId);
      const preference: Preference = { ...(incoming.conversation ? { conversation: selection(incoming.conversation) } : {}),
        ...(incoming.playback ? { playback: selection(incoming.playback) } : {}), sentencePlayback: incoming.sentencePlayback, revision: previous.revision + 1 };
      if (preference.conversation) this.options.models.resolve(preference.conversation);
      if (preference.playback) this.options.models.resolve(preference.playback);
      this.options.store.runAuthorizedOperation(authority.connection.id, authority.connection.authKeyDigest,
        { id: identity(request.operationId), kind: 'desktop_voice_preference', body: { sessionId: request.sessionId, expectedRevision: incoming.revision.toString(), preference: { ...preference, revision: 0 } } }, () => {
          authority.assertCurrent();
          if (BigInt(previous.revision) !== incoming.revision) throw new ConnectError('Voice preferences changed. Reload and retry.', Code.Aborted);
          this.options.store.setSetting('session', request.sessionId, SCOPE, preference); return true;
        });
      return this.#snapshot(request.sessionId, generation);
    }
    if (action === contract.DesktopVoiceConversationAction.VOICES) {
      const chosen = selection(request.selection), binding = this.options.models.resolve(chosen);
      const voices = await loadSpeechVoices(binding.connection, chosen.modelId, this.options.fetch, () => { authority.assertCurrent(); binding.assertCurrent(); });
      authority.assertCurrent(); binding.assertCurrent();
      return create(contract.ControlDesktopVoiceConversationResponseSchema, { voices: { ...voices, voices: voices.voices } });
    }
    if (action === contract.DesktopVoiceConversationAction.START) {
      const callId = identity(request.callId, 64), chosen = selection(request.selection);
      const previous = this.#call;
      if (previous?.id === callId) {
        if (previous.owner !== owner || previous.sessionId !== session.id || previous.generation !== generation || previous.operationId !== request.operationId
          || (previous.kind === 'playback') !== request.playbackOnly || JSON.stringify(previous.selection) !== JSON.stringify(chosen)) throw invalid();
        previous.assertCurrent(); return this.#snapshot(session.id, generation, previous);
      }
      if (previous) throw new ConnectError('Another call or speech preview owns audio.', Code.ResourceExhausted);
      if (this.options.dictationActive?.(authority.connection.id)) throw new ConnectError('Dictation already owns audio.', Code.ResourceExhausted);
      if (this.options.store.findSetting('session', session.id, `${CALL_SCOPE}${callId}`)) throw new ConnectError('This call already ended. Start a new call explicitly.', Code.FailedPrecondition);
      const binding = this.options.models.resolve(chosen);
      const backend = this.options.store.getBackend(session.backendId).descriptor;
      const providerId = session.providerId, modelId = session.modelId;
      if (!request.playbackOnly && (!providerId || !modelId || !backend.models.some(model => model.providerId === providerId && model.modelId === modelId))) throw unavailable();
      let call!: Call;
      const assertCurrent = () => {
        authority.assertCurrent();
        const current = this.options.store.getSession(session.id).descriptor;
        if (this.#call !== call || current.deletedAt !== undefined || current.archived || current.binding.generation !== generation
          || this.options.companion(session.id).token !== companion.token
          || !request.playbackOnly && (current.backendId !== session.backendId || current.providerId !== providerId || current.modelId !== modelId
            || this.options.store.getBackend(session.backendId).descriptor.instanceGeneration !== backend.instanceGeneration)) throw unavailable();
        binding.assertCurrent();
      };
      const context: VoiceCallContext = new VoiceCallContext({ callId, identity: `${companion.identity}\n${session.appendSystemPrompt ?? ''}`.slice(0, 32_000), reference: this.#reference(session.id),
        generate: async (user, system, signal) => {
          assertCurrent(); call.speech.cancel(); call.speechId = undefined;
          const result = await this.options.infer(session.backendId, { providerId: providerId!, modelId: modelId!, backendInstanceGeneration: backend.instanceGeneration,
            system, user, signal, timeoutMs: 60_000, maxTokens: 4096, assertCurrent,
            assertModelAllowed: (provider, model) => { assertCurrent(); if (provider !== providerId || model !== modelId) throw unavailable(); } });
          assertCurrent(); return result;
        },
        handoff: async ({ id, original }) => {
          assertCurrent();
          // Preserve the exact accepted user utterance. A model-authored
          // supplement is not a new user instruction or permission grant.
          const receipt = this.options.host.enqueueInput({ operationId: id, sessionId: session.id, connection: authority.connection,
            prompt: { text: original, images: [], files: [], mentions: [], disposition: 'prompt' } });
          const handoff = context.record.handoffs.find(handoff => handoff.id === id);
          if (handoff) { handoff.runId = receipt.value.runId; handoff.queueItemId = receipt.value.queueItemId; }
          call.dispatches.set(id, { runId: receipt.value.runId, queueItemId: receipt.value.queueItemId,
            cursor: this.options.store.listEvents({ sessionId: session.id, order: 'desc', limit: 1 })[0]?.globalCursor ?? 0n, text: '' }); return true;
        },
        changed: record => {
          // end() also saves after the live lease has been retired.
          try { authority.assertCurrent(); } catch { return; }
          if (this.options.store.getSession(session.id).descriptor.binding.generation !== generation) return;
          this.#save({ format: 1, sessionId: session.id, generation, kind: request.playbackOnly ? 'playback' : 'conversation', record });
        } });
      call = { id: callId, operationId: request.operationId, owner, sessionId: session.id, generation, kind: request.playbackOnly ? 'playback' : 'conversation', context, selection: chosen,
        authority, assertCurrent, touchedAt: this.#now(), speech: new SpeechSynthesisSession({ connection: () => binding.connection,
          fetch: this.options.fetch, assertCurrent }), speechIds: new Map(), dispatches: new Map(), reads: new Map(), readIds: new Set(), inputs: new Map(), exitJudgments: new Map(),
        inferExit: text => {
          // No fallback to a native Agent, another model, or an auxiliary chain.
          const route = providerId && modelId ? this.options.models.routes.resolve({ backendId: session.backendId, providerId, modelId }) : undefined;
          if (!route) return Promise.resolve('continue');
          return classifyVoiceExit({ text, current: () => { try { assertCurrent(); return true; } catch { return false; } },
            infer: (system, user, signal) => this.options.infer(session.backendId, { providerId: providerId!, modelId: modelId!,
              backendInstanceGeneration: backend.instanceGeneration, system, user, signal, maxTokens: 96, timeoutMs: 2000,
              assertCurrent: () => { assertCurrent(); if (this.options.models.routes.resolve(route)?.generationId !== route.generationId) throw unavailable(); },
              assertModelAllowed: (provider, model) => { assertCurrent(); if (provider !== providerId || model !== modelId) throw unavailable(); } }) });
        } };
      this.options.store.runAuthorizedOperation(authority.connection.id, authority.connection.authKeyDigest,
        { id: identity(request.operationId), kind: 'desktop_voice_start', body: { callId, sessionId: session.id, generation, chosen, kind: call.kind } }, () => {
          authority.assertCurrent(); this.#save({ format: 1, sessionId: session.id, generation, kind: call.kind, record: context.record }); return true;
        });
      this.#call = call; assertCurrent(); return this.#snapshot(session.id, generation, call);
    }
    const call = this.#call;
    if (!call || call.owner !== owner || call.id !== request.callId || call.sessionId !== session.id || call.generation !== generation) throw unavailable();
    call.assertCurrent(); call.touchedAt = this.#now();
    switch (action) {
      case contract.DesktopVoiceConversationAction.CLASSIFY_EXIT: {
        if (call.kind !== 'conversation') throw invalid();
        const inputId = identity(request.inputId, 128), text = bounded(request.text, 32_000);
        const previous = call.exitJudgments.get(inputId);
        if (previous && previous.text !== text) throw invalid();
        if (call.inputs.has(inputId) && call.inputs.get(inputId) !== text) throw invalid();
        if (call.exitJudgments.size >= 2000) throw unavailable();
        this.options.store.runAuthorizedOperation(authority.connection.id, authority.connection.authKeyDigest,
          { id: `voice-exit:${call.id}:${inputId}`, kind: 'desktop_voice_exit', body: { callId: call.id, sessionId: call.sessionId, generation, textDigest: createHash('sha256').update(text).digest('hex') } }, () => true);
        const result = previous?.result ?? call.inferExit(text);
        call.exitJudgments.set(inputId, { text, result });
        const decision = await result; call.assertCurrent();
        return create(contract.ControlDesktopVoiceConversationResponseSchema, { exitDecision: decision });
      }
      case contract.DesktopVoiceConversationAction.SUBMIT:
        if (call.kind !== 'conversation') throw invalid();
        bounded(request.text, 32_000); identity(request.inputId, 128);
        if (call.exitJudgments.has(request.inputId) && call.exitJudgments.get(request.inputId)!.text !== request.text) throw invalid();
        if (call.inputs.has(request.inputId) && call.inputs.get(request.inputId) !== request.text) throw new ConnectError('The original call input changed.', Code.AlreadyExists);
        if (call.context.record.turns.reduce((total, turn) => total + turn.text.length, 0) + request.text.length > 1_000_000) throw new ConnectError('This call reached its transcript limit. End it and start another call.', Code.ResourceExhausted);
        this.options.store.runAuthorizedOperation(authority.connection.id, authority.connection.authKeyDigest,
          { id: request.inputId, kind: 'desktop_voice_turn', body: { callId: call.id, sessionId: session.id, generation, text: request.text, forceHandoff: request.forceHandoff } }, () => true);
        call.inputs.set(request.inputId, request.text);
        call.speech.cancel(); call.speechId = undefined; call.context.interrupt();
        void call.context.submit(request.inputId, request.text, request.forceHandoff).catch(() => undefined);
        return this.#snapshot(session.id, generation, call);
      case contract.DesktopVoiceConversationAction.PROMOTE:
        await call.context.promote(identity(request.inputId, 128)); call.assertCurrent(); return this.#snapshot(session.id, generation, call);
      case contract.DesktopVoiceConversationAction.INTERRUPT:
        call.speech.cancel(); call.speechId = undefined; call.context.interrupt(); return this.#snapshot(session.id, generation, call);
      case contract.DesktopVoiceConversationAction.END:
        this.#end(call); return this.#snapshot(session.id, generation);
      case contract.DesktopVoiceConversationAction.SPEAK: {
        const id = identity(request.speechRequestId, 128), text = bounded(request.text, 32_000), digest = createHash('sha256').update(text).digest('hex');
        const previous = call.speechIds.get(id);
        if (previous && previous !== digest) throw new ConnectError('The original speech input changed.', Code.AlreadyExists);
        // A result-unknown billable request is never reissued with the same id.
        if (previous) {
          if (call.speechId !== id) throw new ConnectError('The original speech request ended or has an unknown outcome.', Code.FailedPrecondition);
          return create(contract.ControlDesktopVoiceConversationResponseSchema, { accepted: true, sampleRate: 24_000 });
        }
        if (call.speechIds.size >= 2000) throw unavailable();
        this.options.store.runAuthorizedOperation(authority.connection.id, authority.connection.authKeyDigest,
          { id, kind: 'desktop_voice_speak', body: { callId: call.id, sessionId: session.id, generation, digest } }, () => true);
        call.speechIds.set(id, digest); call.speechId = id; call.reads.clear(); call.readIds.clear();
        try {
          await call.speech.start({ requestId: id, modelId: call.selection.modelId, voice: call.selection.voice, text,
            ...(call.selection.speed === undefined ? {} : { speed: call.selection.speed }) });
        } catch (error) { if (call.speechId === id) call.speechId = undefined; throw error; }
        call.assertCurrent(); return create(contract.ControlDesktopVoiceConversationResponseSchema, { accepted: true, sampleRate: 24_000 });
      }
      case contract.DesktopVoiceConversationAction.READ_SPEECH: {
        const speechId = identity(request.speechRequestId, 128), readId = identity(request.operationId);
        if (call.speechId !== speechId) throw unavailable();
        const previous = call.reads.get(readId);
        if (previous) return create(contract.ControlDesktopVoiceConversationResponseSchema, { pcm: previous.pcm, speechDone: previous.done, sampleRate: 24_000 });
        if (call.speechReadId || call.readIds.has(readId) || call.readIds.size >= 20_000) throw unavailable();
        call.readIds.add(readId);
        call.speechReadId = readId;
        try {
          const result = await call.speech.read(speechId); call.assertCurrent();
          // Only the latest PCM reply is retained for exact read retries.
          call.reads.clear(); call.reads.set(readId, { pcm: new Uint8Array(result.pcm), done: result.done });
          return create(contract.ControlDesktopVoiceConversationResponseSchema, { pcm: new Uint8Array(result.pcm), speechDone: result.done, sampleRate: 24_000 });
        } finally { if (call.speechReadId === readId) call.speechReadId = undefined; }
      }
      default: throw invalid();
    }
  }
  #preference(sessionId: string): Preference {
    const value = this.options.store.findSetting<Preference>('session', sessionId, SCOPE)?.value;
    if (value === undefined) return { sentencePlayback: true, revision: 0 };
    if (!Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.sentencePlayback !== 'boolean') throw unavailable();
    return value;
  }
  #snapshot(sessionId: string, generation: number, call?: Call, selected?: SavedCall): contract.ControlDesktopVoiceConversationResponse {
    const preference = this.#preference(sessionId);
    const history = this.options.store.listSettingsByKeyPrefix('session', sessionId, CALL_SCOPE).map(value => value.value as SavedCall)
      .filter(value => value.format === 1 && value.sessionId === sessionId).sort((a, b) => b.record.startedAt - a.record.startedAt).slice(0, 20);
    return create(contract.ControlDesktopVoiceConversationResponseSchema, { preference: { ...preference, revision: BigInt(preference.revision) },
      models: this.options.models.list(), ...(call ? { call: publicRecord({ format: 1, sessionId, generation, kind: call.kind, record: call.context.record }) }
        : selected ? { call: publicRecord(selected) } : {}),
      history: history.map(value => publicRecord({ ...value, record: { ...value.record, turns: [], handoffs: [] } })) });
  }
  #reference(sessionId: string): string {
    return JSON.stringify(this.options.store.listEvents({ sessionId, activeNativeTimeline: true, order: 'desc', limit: 60 }).reverse()
      .flatMap(event => event.payload.type === 'message_complete' ? [{ role: event.payload.role,
        text: event.payload.blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('\n').slice(0, 8000) }] : []).slice(-12)).slice(-40_000);
  }
  #collectResults(call: Call): void {
    for (const [id, dispatch] of call.dispatches) {
      const run = this.options.store.getRun(dispatch.runId).descriptor;
      const events = this.options.store.listEvents({ sessionId: call.sessionId, afterCursor: dispatch.cursor, order: 'asc', limit: 1000 });
      for (const event of events) {
        dispatch.cursor = event.globalCursor;
        if (event.runId === dispatch.runId && event.payload.type === 'message_complete' && event.payload.role === 'assistant') {
          dispatch.text = (dispatch.text + '\n' + event.payload.blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('\n')).slice(-16_000);
        }
      }
      if (events.length === 1000 || !['completed', 'failed', 'aborted'].includes(run.state)) continue;
      call.dispatches.delete(id); call.context.deliverResult(id, dispatch.text.trim() || `Task ${run.state}.`);
    }
  }
  #end(call: Call): void {
    if (this.#call !== call) return;
    this.#call = undefined; call.speech.cancel(); call.context.end();
    this.#save({ format: 1, sessionId: call.sessionId, generation: call.generation, kind: call.kind, record: call.context.record });
  }
  #save(saved: SavedCall): void {
    let session: ReturnType<OperationalStore['getSession']>['descriptor'];
    try { session = this.options.store.getSession(saved.sessionId).descriptor; } catch (error) { if (error instanceof NotFoundError) return; throw error; }
    if (session.deletedAt !== undefined || session.binding.generation !== saved.generation) return;
    this.options.store.setSetting('session', saved.sessionId, `${CALL_SCOPE}${saved.record.callId}`, saved);
  }
  #now(): number { return this.options.now?.() ?? Date.now(); }
}
function selection(value: contract.DesktopSpeechSelection | undefined): SpeechSelection {
  if (!value) throw invalid();
  return { backendId: identity(value.backendId), providerId: bounded(value.providerId, 512), modelId: bounded(value.modelId, 512),
    protocol: bounded(value.protocol, 32), voice: bounded(value.voice, 256), ...(value.speed === undefined ? {} : { speed: value.speed }) };
}
function publicRecord(value: SavedCall): contract.DesktopVoiceCallRecord {
  const record = value.record;
  return create(contract.DesktopVoiceCallRecordSchema, { callId: record.callId, sessionId: value.sessionId, sessionGeneration: BigInt(value.generation), kind: value.kind,
    startedAtMs: BigInt(record.startedAt), ...(record.endedAt === undefined ? {} : { endedAtMs: BigInt(record.endedAt) }),
    turns: record.turns.map(turn => ({ ...turn, createdAtMs: BigInt(turn.createdAt) })), handoffs: record.handoffs.map(handoff => ({ ...handoff })) });
}
function integer(value: bigint): number { if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid(); return Number(value); }
function identity(value: string, limit = 255): string { if (value.length > limit || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) throw invalid(); return value; }
function bounded(value: string, limit: number): string { if (!value.trim() || value.length > limit || value.includes('\0')) throw invalid(); return value; }
function invalid(): ConnectError { return new ConnectError('Invalid Desktop voice request.', Code.InvalidArgument); }
function unavailable(): ConnectError { return new ConnectError('The original Desktop voice owner or model is unavailable.', Code.FailedPrecondition); }
