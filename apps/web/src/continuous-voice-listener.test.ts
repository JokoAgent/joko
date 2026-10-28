// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { OperationApi, VoiceInputSessionView } from './model.js';
import type { VoiceMediaSessionOptions } from './voice-input-media.js';
import { ContinuousVoiceListener } from './desktop-voice-conversation.js';

const media = vi.hoisted(() => ({ sessions: [] as Array<{ options: VoiceMediaSessionOptions; dispose: ReturnType<typeof vi.fn> }> }));
vi.mock('./voice-input-media.js', () => ({ VoiceInputMediaSession: class {
  readonly dispose = vi.fn(async () => undefined);
  constructor(readonly options: VoiceMediaSessionOptions) { media.sessions.push(this); }
  async start() { this.options.onUpdate?.({ state: 'listening' }); }
  async stop() { return undefined; }
} }));
afterEach(() => { media.sessions.splice(0); vi.useRealTimers(); });

it('rotates a silent ASR session without ending continuous listening or sending an utterance', async () => {
  vi.useFakeTimers();
  const onText = vi.fn(), onEmpty = vi.fn(), onFailure = vi.fn();
  const listener = createListener({ onText, onEmpty, onFailure });
  await listener.start();
  media.sessions[0]!.options.onUpdate?.({ state: 'error', session: voiceSession({ state: 'done', outcome: 'noSpeech' }) });
  await vi.advanceTimersByTimeAsync(100);
  expect(media.sessions).toHaveLength(2);
  expect(onEmpty).toHaveBeenCalledOnce(); expect(onText).not.toHaveBeenCalled(); expect(onFailure).not.toHaveBeenCalled();
  listener.stop();
  media.sessions[1]!.options.onUpdate?.({ state: 'error' });
  await vi.advanceTimersByTimeAsync(31_000);
  expect(media.sessions).toHaveLength(2); expect(onFailure).not.toHaveBeenCalled();
});

it('returns the unfinished draft on capture failure without treating it as a final utterance', async () => {
  const onText = vi.fn(), onFailure = vi.fn(), listener = createListener({ onText, onFailure });
  await listener.start();
  const source = media.sessions[0]!;
  source.options.onUpdate?.({ state: 'listening', session: voiceSession({ draft: { text: 'Unfinished original answer', source: 'partial' } }) });
  source.options.onUpdate?.({ state: 'error' });
  expect(onFailure).toHaveBeenCalledExactlyOnceWith('Unfinished original answer');
  expect(onText).not.toHaveBeenCalled(); expect(source.dispose).toHaveBeenCalledOnce();
  listener.stop();
});

function createListener(callbacks: Partial<ConstructorParameters<typeof ContinuousVoiceListener>[0]>) {
  return new ContinuousVoiceListener({ api: { getVoiceInputCapabilities: async () => ({ support: 'supported', limits: { supportedMimeTypes: ['audio/pcm'] } }) } as unknown as OperationApi,
    onSpeech: vi.fn(), onText: vi.fn(), onState: vi.fn(), onFailure: vi.fn(), ...callbacks });
}
function voiceSession(patch: Partial<VoiceInputSessionView> = {}): VoiceInputSessionView {
  return { id: 'voice-one', state: 'listening', nextChunkSequence: 1n, acceptedAudioBytes: 0, acceptedAudioDurationMs: 0,
    createdAt: 1000, updatedAt: 1000, recoveryAttempts: 0, stallWarning: false, ...patch };
}
