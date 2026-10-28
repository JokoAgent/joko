import { create, fromBinary, toBinary, type MessageInitShape } from '@bufbuild/protobuf';
import { DesktopVoiceConversationAction, ControlDesktopVoiceConversationRequestSchema, ControlDesktopVoiceConversationResponseSchema } from '@joko/contracts';
import type { OperationApi } from './model.js';
import { VoiceInputMediaSession } from './voice-input-media.js';
import { WebAudioVoicePcmCapture } from './voice-input-pcm.js';
import { readVoiceInputPreferences, voiceInputLocale, voiceInputRecognitionContext } from './voice-input-preferences.js';

type Request = MessageInitShape<typeof ControlDesktopVoiceConversationRequestSchema>;
export class DesktopVoiceClient {
  #live = true;
  #epoch = 0;
  constructor(readonly host: { control(serverId: string, bytes: Uint8Array): Promise<Uint8Array> }, readonly serverId: string,
    readonly sessionId: string, readonly generation: bigint) {}
  async control(action: DesktopVoiceConversationAction, input: Request = {}) {
    if (!this.#live) throw new Error('Voice owner retired.');
    const epoch = this.#epoch;
    const bytes = await this.host.control(this.serverId, toBinary(ControlDesktopVoiceConversationRequestSchema,
      create(ControlDesktopVoiceConversationRequestSchema, { ...input, sessionId: this.sessionId, sessionGeneration: this.generation, action })));
    if (!this.#live || epoch !== this.#epoch) throw new Error('Voice owner retired.');
    return fromBinary(ControlDesktopVoiceConversationResponseSchema, bytes);
  }
  close(): void { this.#live = false; this.#epoch++; }
  activate(): void { this.#live = true; this.#epoch++; }
}

/** Sequential PCM playback with a two-second scheduling budget. Cancellation
 * closes the actual AudioContext and retires every late read and scheduled node. */
export class DesktopSpeechPlayer {
  #epoch = 0;
  #context?: AudioContext;
  #paused = false;
  async play(client: DesktopVoiceClient, callId: string, requestId: string, text: string): Promise<void> {
    this.stop(); const epoch = this.#epoch;
    let opened;
    try { opened = await client.control(DesktopVoiceConversationAction.SPEAK, { callId, speechRequestId: requestId, text }); }
    catch (error) { if (epoch !== this.#epoch) return; throw error; }
    if (epoch !== this.#epoch) return;
    if (opened.sampleRate !== 24_000) throw new Error('Unsupported speech format.');
    const context = new AudioContext({ latencyHint: 'interactive' }); this.#context = context;
    if (!this.#paused) await context.resume(); else await context.suspend();
    let nextAt = context.currentTime, carry: number | undefined;
    const current = () => epoch === this.#epoch && this.#context === context;
    try {
      for (;;) {
        if (!current()) return;
        const reply = await client.control(DesktopVoiceConversationAction.READ_SPEECH,
          { callId, speechRequestId: requestId, operationId: crypto.randomUUID() });
        if (!current()) return;
        const raw = reply.pcm, bytes = carry === undefined ? raw : new Uint8Array([carry, ...raw]); carry = undefined;
        if (bytes.byteLength % 2) carry = bytes[bytes.byteLength - 1];
        const even = bytes.byteLength - bytes.byteLength % 2;
        const view = new DataView(bytes.buffer, bytes.byteOffset, even);
        for (let offset = 0; offset < even; offset += 24_000) {
          while (current() && nextAt - context.currentTime > 2) await pause(40);
          if (!current()) return;
          const samples = Math.min(12_000, (even - offset) / 2), buffer = context.createBuffer(1, samples, 24_000), channel = buffer.getChannelData(0);
          for (let i = 0; i < samples; i++) channel[i] = view.getInt16(offset + i * 2, true) / 32768;
          const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
          nextAt = Math.max(nextAt, context.currentTime); source.start(nextAt); nextAt += samples / 24_000;
        }
        if (reply.speechDone) {
          if (carry !== undefined) throw new Error('Incomplete speech sample.');
          while (current() && context.currentTime < nextAt) await pause(40);
          return;
        }
      }
    } catch (error) { if (current()) throw error; }
    finally {
      if (this.#context === context) this.#context = undefined;
      if (context.state !== 'closed') await context.close().catch(() => undefined);
    }
  }
  pause(): void { this.#paused = true; if (this.#context && this.#context.state !== 'closed') void this.#context.suspend().catch(() => undefined); }
  resume(): void { this.#paused = false; if (this.#context && this.#context.state !== 'closed') void this.#context.resume().catch(() => undefined); }
  stop(): void { this.#epoch++; this.#paused = false; const context = this.#context; this.#context = undefined; if (context && context.state !== 'closed') void context.close().catch(() => undefined); }
}

/** Reuses the selected ASR, its bounded PCM capture and exact native session
 * recovery. A stable silence closes one utterance; only its final success is sent. */
export class ContinuousVoiceListener {
  #epoch = 0;
  #media?: VoiceInputMediaSession;
  #timer?: ReturnType<typeof setTimeout>;
  #draft = '';
  constructor(readonly options: { readonly api: OperationApi; readonly onSpeech: () => void;
    readonly onText: (id: string, text: string) => void; readonly onState: (state: string) => void; readonly onFailure: (draft: string) => void;
    readonly onEmpty?: () => void; readonly onDraft?: (text: string) => void }) {}
  async start(): Promise<void> {
    this.stop(); const epoch = this.#epoch;
    const capability = await this.options.api.getVoiceInputCapabilities();
    if (epoch !== this.#epoch) return;
    if (capability.support !== 'supported' || !capability.limits.supportedMimeTypes.includes('audio/pcm')) throw new Error('Continuous PCM input is unavailable.');
    this.#listen(epoch);
  }
  #listen(epoch: number): void {
    if (epoch !== this.#epoch) return;
    this.#draft = '';
    const preferences = readVoiceInputPreferences(), locale = voiceInputLocale(preferences);
    let voicedAt = 0, heard = false, finishing = false, accepted = false;
    const media = new VoiceInputMediaSession({ api: this.options.api, ownerWindow: window,
      subscribeMicrophoneRelease: window.jokoDesktop?.microphone?.onRelease,
      preferences: { ...(locale === undefined ? {} : { locale }), ...(preferences.deviceId ? { deviceId: preferences.deviceId } : {}),
        recognitionContext: voiceInputRecognitionContext(preferences), playInteractionSound: false },
      pcmCaptureFactory: () => {
        const capture = new WebAudioVoicePcmCapture(window.AudioContext);
        return { start: (stream, onChunk) => capture.start(stream, chunk => {
          if (epoch !== this.#epoch || this.#media !== media || finishing) return;
          if (chunk.voiced) {
            voicedAt = Date.now(); if (!heard) { heard = true; this.options.onSpeech(); }
          }
          onChunk(chunk);
          if (heard && !chunk.voiced && Date.now() - voicedAt >= 900) { finishing = true; void media.stop().catch(() => this.#fail(epoch)); }
        }), stop: () => capture.stop() };
      },
      onUpdate: update => {
        if (epoch !== this.#epoch || this.#media !== media) return;
        this.options.onState(update.state);
        if (update.state !== 'error') this.#draft = update.session?.draft?.text ?? '';
        this.options.onDraft?.(this.#draft);
        if (update.state === 'done' || update.session?.outcome === 'noSpeech') {
          if (heard && update.session?.outcome === 'success' && update.session.result?.text.trim() && !accepted) {
            accepted = true; this.options.onText(update.session.id, update.session.result.text);
          } else this.options.onEmpty?.();
          this.#media = undefined; void media.dispose();
          clearTimeout(this.#timer); this.#timer = setTimeout(() => this.#listen(epoch), 100);
        } else if (update.state === 'error') this.#fail(epoch);
      } });
    this.#media = media;
    void media.start().then(() => {
      if (epoch !== this.#epoch || this.#media !== media) return;
      this.#timer = setTimeout(() => { if (epoch === this.#epoch && this.#media === media) { finishing = true; void media.stop().catch(() => this.#fail(epoch)); } }, 30_000);
    }).catch(() => this.#fail(epoch));
  }
  #fail(epoch: number): void { if (epoch !== this.#epoch) return; const draft = this.#draft; this.stop(); this.options.onFailure(draft); }
  stop(): void { this.#epoch++; clearTimeout(this.#timer); this.#timer = undefined; const media = this.#media; this.#media = undefined; void media?.dispose(); }
  get draft(): string { return this.#draft; }
}

/** Whole-utterance controls only. Negation, quotes, questions and extra clauses
 * must continue to the ordinary call rather than discarding a work request. */
export function voiceExitIntent(text: string): 'command' | 'farewell' | null {
  const phrase = text.normalize('NFKC').trim().toLowerCase().replace(/[。.!！]+$/u, '').trim().replace(/\s+/gu, ' ');
  if (/^(?:请|請)?(?:结束|結束|退出|关闭|關閉)语音(?:模式|对话)?$/u.test(phrase)
    || /^(?:請)?(?:結束|退出|關閉)語音(?:模式|對話)?$/u.test(phrase)
    || /^(?:end|exit|close) (?:voice mode|voice chat)$/u.test(phrase)) return 'command';
  return ['再见', '再見', '拜拜', 'bye', 'bye bye', 'goodbye'].includes(phrase) ? 'farewell' : null;
}
export function spokenSentences(text: string): string[] {
  return text.match(/[^。！？.!?]*[。！？.!?]+|[^。！？.!?]+$/gu)?.map(value => value.trim()).filter(Boolean) ?? [text];
}
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
