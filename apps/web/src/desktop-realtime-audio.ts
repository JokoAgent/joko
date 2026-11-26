import { DesktopVoiceConversationAction as Action, type DesktopRealtimePlaybackPosition, type DesktopSpeakerApi, type DesktopSpeakerPcm } from "@joko/contracts";
import type { DesktopVoiceClient } from "./desktop-voice-conversation.js";
import { readVoiceInputPreferences } from "./voice-input-preferences.js";
import { WebAudioVoicePcmCapture } from "./voice-input-pcm.js";

type PlaybackPosition = Pick<DesktopRealtimePlaybackPosition, "itemId" | "contentIndex" | "sampleOffset">;

/** The window owns capture and playback. Only PCM crosses its private Main channel. */
export class DesktopRealtimeAudio {
  readonly #capture = new WebAudioVoicePcmCapture();
  #stream?: MediaStream;
  #context?: AudioContext;
  #speakerRun?: string;
  #release?: () => void;
  #closed = false;
  #input = 0n;
  #output = 0n;
  #queuedBytes = 0;
  #outgoing = Promise.resolve();
  #playAt = 0;
  #playbackEpoch = 0;
  #lastPlayed?: PlaybackPosition;
  readonly #sources = new Map<AudioBufferSourceNode, { start: number; samples: number; position?: PlaybackPosition }>();
  constructor(readonly client: DesktopVoiceClient, readonly callId: string, readonly onFailure: () => void,
    readonly speaker?: { api: DesktopSpeakerApi; profileId: string }) {}
  async start(): Promise<void> {
    this.#release = window.jokoDesktop?.microphone?.onRelease(() => this.#fail());
    const deviceId = readVoiceInputPreferences().deviceId;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true,
      noiseSuppression: true, autoGainControl: true, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, video: false });
    if (this.#closed) { stream.getTracks().forEach(track => track.stop()); return; }
    this.#stream = stream;
    for (const track of stream.getAudioTracks()) track.addEventListener("ended", () => this.#fail(), { once: true });
    if (this.speaker) {
      const run = await this.speaker.api.begin(this.speaker.profileId);
      if (run.mode === "active") {
        if (this.#closed) { await this.speaker.api.cancel(run.id); return; }
        this.#speakerRun = run.id;
      }
      if (run.mode === "unavailable") throw new Error("Speaker filter unavailable.");
    }
    if (this.#closed) return;
    const context = new AudioContext({ latencyHint: "interactive" }); this.#context = context;
    await context.resume();
    if (this.#closed) return;
    await this.#capture.start(stream, chunk => this.#enqueue(chunk));
    void this.#listen().catch(() => this.#fail());
  }
  #enqueue(chunk: DesktopSpeakerPcm): void {
    if (this.#closed) return;
    this.#queuedBytes += chunk.audio.byteLength;
    if (this.#queuedBytes > 64_000) { this.#fail(); return; }
    this.#outgoing = this.#outgoing.then(async () => {
      if (this.#closed) return;
      const output = this.speaker && this.#speakerRun ? await this.speaker.api.push(this.#speakerRun, chunk) : { chunks: [chunk] };
      if (output.notice === "unavailable") throw new Error("Speaker filter unavailable.");
      for (const filtered of output.chunks) {
        for (let offset = 0; offset < filtered.audio.length; offset += 16_000) {
          if (this.#closed) return;
          const sequence = ++this.#input;
          const receipt = await this.client.control(Action.REALTIME_INPUT, { callId: this.callId, audioSequence: sequence,
            microphonePcm: filtered.audio.subarray(offset, offset + 16_000) });
          if (!receipt.accepted || receipt.audioSequence !== sequence) throw new Error("Realtime microphone receipt changed.");
        }
      }
    }).catch(() => this.#fail()).finally(() => { this.#queuedBytes -= chunk.audio.byteLength; });
  }
  async #listen(): Promise<void> {
    const context = this.#context!;
    while (!this.#closed) {
      const epoch = this.#playbackEpoch, sequence = ++this.#output;
      const result = await this.client.control(Action.REALTIME_READ, { callId: this.callId, audioSequence: sequence });
      if (this.#closed) return;
      if (result.audioSequence !== sequence || result.sampleRate !== 24_000 || result.pcm.length % 2 || result.pcm.length > 48_000) throw new Error("Realtime audio changed.");
      if (result.audioInterrupted && epoch === this.#playbackEpoch) {
        const position = this.interrupt();
        if (result.interruptThroughResponse !== undefined) {
          await this.client.control(Action.INTERRUPT, { callId: this.callId, realtimePlayback: position,
            interruptThroughResponse: result.interruptThroughResponse });
          if (this.#closed || this.#playbackEpoch !== epoch + 1) continue;
        }
      } else if (epoch !== this.#playbackEpoch) continue;
      if (!result.pcm.length) continue;
      const buffer = context.createBuffer(1, result.pcm.length / 2, 24000), channel = buffer.getChannelData(0);
      const view = new DataView(result.pcm.buffer, result.pcm.byteOffset, result.pcm.byteLength);
      for (let i = 0; i < channel.length; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
      const source = context.createBufferSource();
      source.buffer = buffer; source.connect(context.destination);
      const start = Math.max(this.#playAt, context.currentTime), position = result.realtimePlayback;
      this.#sources.set(source, { start, samples: channel.length, position });
      source.onended = () => {
        if (position) this.#lastPlayed = { ...position, sampleOffset: position.sampleOffset + channel.length };
        this.#sources.delete(source); source.disconnect();
      };
      source.start(start); this.#playAt = start + buffer.duration;
      while (!this.#closed && this.#playAt > context.currentTime + 0.35) await new Promise<void>(done => setTimeout(done, 30));
    }
  }
  interrupt(): PlaybackPosition | undefined {
    const now = this.#context?.currentTime ?? 0;
    let played = this.#lastPlayed;
    this.#playbackEpoch++; this.#playAt = 0;
    for (const [source, chunk] of this.#sources) {
      if (chunk.position && (now >= chunk.start || !played)) {
        const samples = Math.max(0, Math.min(chunk.samples, Math.floor((now - chunk.start) * 24_000)));
        played = { ...chunk.position, sampleOffset: chunk.position.sampleOffset + samples };
      }
      source.onended = null; source.stop(); source.disconnect();
    }
    this.#sources.clear(); this.#lastPlayed = undefined;
    return played;
  }
  mute(muted: boolean): void { for (const track of this.#stream?.getAudioTracks() ?? []) track.enabled = !muted; }
  #fail(): void { if (!this.#closed) { this.close(); this.onFailure(); } }
  close(): void {
    if (this.#closed) return;
    this.#closed = true; this.#release?.(); this.interrupt();
    this.#stream?.getTracks().forEach(track => track.stop()); void this.#capture.stop();
    if (this.#speakerRun) void this.speaker?.api.cancel(this.#speakerRun).catch(() => {});
    if (this.#context && this.#context.state !== "closed") void this.#context.close().catch(() => {});
  }
}
