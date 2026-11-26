import { createHash, randomUUID } from "node:crypto";
import { Agent, ProxyAgent, WebSocket } from "undici";
import type { DesktopRealtimePlaybackPosition } from "@joko/contracts";
import { createSocks5Dispatcher } from "@joko/outbound-network";
import type { RealtimeConnection } from "./models.js";

export type RealtimeDial = (binding: RealtimeConnection, signal: AbortSignal, assertCurrent: () => void) => Promise<WebSocket>;
export function realtimeDial(resolveProxy?: (url: string, signal: AbortSignal) => Promise<string | undefined | null>): RealtimeDial {
  return async (binding, signal, assertCurrent) => {
    const target = new URL(binding.url); target.protocol = target.protocol === "wss:" ? "https:" : "http:";
    const proxy = await resolveProxy?.(target.href, signal); signal.throwIfAborted(); assertCurrent();
    const webSocket = { maxPayloadSize: 2 * 1024 * 1024 };
    const dispatcher = !proxy ? new Agent({ webSocket }) : /^socks5h?:/.test(proxy) ? createSocks5Dispatcher(proxy) : new ProxyAgent({ uri: proxy, webSocket });
    try {
      const socket = new WebSocket(binding.url, { headers: { ...binding.headers }, dispatcher });
      socket.addEventListener("close", () => { void dispatcher.destroy().catch(() => {}); }, { once: true });
      return socket;
    } catch (error) { void dispatcher.destroy().catch(() => {}); throw error; }
  };
}

type PlaybackPosition = Pick<DesktopRealtimePlaybackPosition, "itemId" | "contentIndex" | "sampleOffset">;
interface AudioRead {
  pcm: Uint8Array; audioSequence: bigint; audioInterrupted: boolean; sampleRate: number;
  realtimePlayback?: PlaybackPosition; interruptThroughResponse?: number;
}
interface OutputItem {
  response: string; generation: number; itemId: string; contentIndex: number;
  samples: number; delivered: number; done: boolean; reconciled: boolean;
}
type Transcript = (id: string, role: "user" | "assistant", text: string) => void;
/** One socket and two monotonic PCM streams per authenticated call. Audio lives in memory. */
export class RealtimeVoiceSession {
  readonly #lifetime = new AbortController();
  #socket?: WebSocket;
  #ready = false;
  #wake?: () => void;
  #inputSequence = 0n;
  #lastInput = "";
  #outputSequence = 0n;
  #lastRead?: AudioRead;
  #reading = false;
  #chunks: { item: OutputItem; pcm: Buffer }[] = [];
  #bytes = 0;
  #interrupted = false;
  #response?: string;
  #responseGeneration = 0;
  #silencedThrough = 0;
  #lastReadGeneration = 0;
  #interruptThrough?: number;
  readonly #outputs = new Map<string, OutputItem>();
  readonly #deletedItems = new Set<string>();
  readonly #cancelEvents = new Map<string, string>();
  #lastSample?: number;
  #resamplePosition = 0;
  readonly #inputs = new Set<string>();
  constructor(readonly binding: RealtimeConnection, readonly selectedVoice: string, readonly instructions: string,
    readonly assertCurrent: () => void, readonly transcript: Transcript, readonly dial: RealtimeDial) {}

  async open(): Promise<void> {
    const signal = this.#lifetime.signal;
    const timeout = setTimeout(() => this.close(), 15_000);
    try {
      const socket = await this.dial(this.binding, signal, this.assertCurrent);
      if (signal.aborted) { socket.close(); throw new Error("realtime_unavailable"); }
      this.#socket = socket;
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(new Error("realtime_unavailable"));
        signal.addEventListener("abort", aborted, { once: true });
        const opened = () => {
          try {
            const turn = { type: "server_vad", silence_duration_ms: 500 };
            const session = this.binding.protocol === "openai-realtime" ? {
              type: "realtime", instructions: this.instructions, output_modalities: ["audio"],
              audio: { input: { format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "gpt-4o-mini-transcribe" },
                turn_detection: { ...turn, create_response: true, interrupt_response: true } },
                output: { format: { type: "audio/pcm", rate: 24000 }, voice: this.selectedVoice } }
            } : { instructions: this.instructions, voice: this.selectedVoice, modalities: ["text", "audio"], input_audio_format: "pcm",
              output_audio_format: "pcm", turn_detection: { ...turn, threshold: 0.5 } };
            this.#send({ type: "session.update", session });
          } catch { this.close(); }
        };
        socket.addEventListener("open", opened, { once: true });
        socket.addEventListener("close", () => this.close(), { once: true });
        socket.addEventListener("error", () => this.close(), { once: true });
        socket.addEventListener("message", event => {
          try {
            if (signal.aborted) return;
            this.assertCurrent();
            if (typeof event.data !== "string" || event.data.length > 2 * 1024 * 1024) throw new Error("realtime_message");
            const item = JSON.parse(event.data);
            if (item.type === "session.updated") { this.#ready = true; signal.removeEventListener("abort", aborted); resolve(); }
            else if (item.type === "error") {
              if (!this.#isCancellationReply(item.error)) throw new Error("realtime_failed");
            }
            else if (this.#ready) this.#event(item);
          } catch { this.close(); }
        });
        if (socket.readyState === WebSocket.OPEN) opened();
        else if (socket.readyState !== WebSocket.CONNECTING) this.close();
      });
    } finally { clearTimeout(timeout); }
  }

  #send(message: Record<string, unknown>): void {
    this.assertCurrent();
    const socket = this.#socket;
    if (this.#lifetime.signal.aborted || socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 512_000) throw new Error("realtime_unavailable");
    socket.send(JSON.stringify(message));
  }
  #isCancellationReply(error?: { code?: string; type?: string; param?: string; event_id?: string }): boolean {
    if (!error) return false;
    for (const [responseId, eventId] of this.#cancelEvents) {
      if (eventId === error.event_id) {
        this.#cancelEvents.delete(responseId);
        return error.code === "response_cancel_not_active" || error.type === "invalid_request_error";
      }
    }
    // A completed response can race a cancel on the same socket. Some providers omit the event ID.
    const cancelled = error.code === "response_cancel_not_active" || (!error.event_id && this.#cancelEvents.size > 0
      && error.type === "invalid_request_error" && error.param === "response.cancel");
    if (cancelled && !error.event_id && this.#cancelEvents.size === 1) this.#cancelEvents.clear();
    return cancelled;
  }
  #event(event: { type?: string; item_id?: string; content_index?: number; response_id?: string; response?: { id?: string; status?: string }; delta?: string; transcript?: string }): void {
    const { type, item_id: id, response_id: responseId } = event;
    if (type === "response.created" && event.response?.id && event.response.id !== this.#response) {
      if (++this.#responseGeneration > 2000) throw new Error("realtime_limit");
      this.#response = event.response.id;
    } else if (type === "response.done" && event.response?.id) {
      if (event.response.status === "cancelled") this.#cancelEvents.delete(event.response.id);
      for (const item of this.#outputs.values()) {
        if (item.response !== event.response.id) continue;
        item.done = true;
        if (item.reconciled) this.#deleteQwenItem(item);
      }
      if (event.response.id === this.#response) {
        if (event.response.status === "failed") throw new Error("realtime_failed");
        this.#response = undefined;
      }
    } else if (type === "input_audio_buffer.speech_started") {
      this.#interruptThrough = this.#responseGeneration;
      this.#dropAudio(this.#responseGeneration);
      this.#interrupted = true;
      this.#wake?.();
    }
    else if (type === "input_audio_buffer.committed" && typeof id === "string" && id.length <= 256) {
      if (this.#inputs.size >= 2000) throw new Error("realtime_limit");
      this.#inputs.add(id);
    } else if (type === "conversation.item.input_audio_transcription.completed" && id && this.#inputs.delete(id) && event.transcript) {
      this.transcript(id, "user", event.transcript);
    } else if (responseId && responseId === this.#response && this.#responseGeneration > this.#silencedThrough) {
      if (type === "response.audio.delta" || type === "response.output_audio.delta") {
        if (typeof event.delta !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.delta)) throw new Error("realtime_audio");
        const bytes = Buffer.from(event.delta, "base64");
        if (bytes.length % 2 || this.#bytes + bytes.length > 2 * 1024 * 1024) throw new Error("realtime_limit");
        if (bytes.length) {
          const contentIndex = event.content_index ?? 0;
          if ((id !== undefined && (typeof id !== "string" || id.length > 256)) || !Number.isSafeInteger(contentIndex)
            || contentIndex < 0 || contentIndex > 0xffffffff) throw new Error("realtime_audio");
          const key = JSON.stringify([id || null, contentIndex, id ? null : responseId]);
          let item = this.#outputs.get(key);
          if (!item) {
            if (this.#outputs.size >= 2000) throw new Error("realtime_limit");
            item = { response: responseId, generation: this.#responseGeneration, itemId: id ?? "", contentIndex,
              samples: 0, delivered: 0, done: false, reconciled: false };
            this.#outputs.set(key, item);
          }
          if (item.response !== responseId || item.samples + bytes.length / 2 > 0xffffffff) throw new Error("realtime_audio");
          item.samples += bytes.length / 2;
          this.#chunks.push({ item, pcm: bytes }); this.#bytes += bytes.length; this.#wake?.();
        }
      } else if ((type === "response.audio_transcript.done" || type === "response.output_audio_transcript.done") && id && event.transcript) {
        this.transcript(id, "assistant", event.transcript);
      }
    }
  }
  input(sequence: bigint, pcm: Uint8Array): void {
    this.check();
    if (!pcm.length || pcm.length % 2 || pcm.length > 32000) throw new Error("realtime_audio");
    const digest = createHash("sha256").update(pcm).digest("hex");
    if (sequence === this.#inputSequence && digest === this.#lastInput) return;
    if (sequence !== this.#inputSequence + 1n) throw new Error("realtime_sequence");
    let bytes = Buffer.from(pcm);
    if (this.binding.protocol === "openai-realtime") {
      const samples: number[] = this.#lastSample === undefined ? [] : [this.#lastSample];
      for (let i = 0; i < bytes.length; i += 2) samples.push(bytes.readInt16LE(i));
      const output = Buffer.alloc(Math.ceil(samples.length * 1.5) * 2);
      let count = 0, position = this.#resamplePosition;
      while (Math.floor(position / 3) + 1 < samples.length) {
        const index = Math.floor(position / 3), fraction = (position % 3) / 3;
        output.writeInt16LE(Math.round(samples[index]! * (1 - fraction) + samples[index + 1]! * fraction), count++ * 2); position += 2;
      }
      this.#resamplePosition = position - (samples.length - 1) * 3; this.#lastSample = samples.at(-1);
      bytes = output.subarray(0, count * 2);
    }
    if (bytes.length) this.#send({ type: "input_audio_buffer.append", audio: bytes.toString("base64") });
    this.#inputSequence = sequence; this.#lastInput = digest;
  }
  async read(sequence: bigint): Promise<AudioRead> {
    this.check();
    if (this.#lastRead?.audioSequence === sequence) return this.#lastRead;
    if (this.#reading || sequence !== this.#outputSequence + 1n) throw new Error("realtime_sequence");
    this.#reading = true;
    try {
      if (!this.#bytes && !this.#interrupted) await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 350); this.#wake = () => { clearTimeout(timer); resolve(); };
      });
      this.check();
      const item = this.#chunks[0]?.item;
      const pcm = Buffer.alloc(Math.min(this.#bytes, 48_000));
      const position = item?.itemId ? { itemId: item.itemId, contentIndex: item.contentIndex, sampleOffset: item.delivered } : undefined;
      let offset = 0;
      while (offset < pcm.length && this.#chunks[0]?.item === item) {
        const chunk = this.#chunks[0]!, size = Math.min(chunk.pcm.length, pcm.length - offset);
        chunk.pcm.copy(pcm, offset, 0, size); offset += size; this.#bytes -= size;
        if (size === chunk.pcm.length) this.#chunks.shift(); else chunk.pcm = chunk.pcm.subarray(size);
      }
      if (item) item.delivered += offset / 2;
      this.#lastRead = { pcm: pcm.subarray(0, offset), sampleRate: 24_000, audioSequence: sequence, audioInterrupted: this.#interrupted,
        realtimePlayback: position, interruptThroughResponse: this.#interruptThrough };
      this.#lastReadGeneration = item?.generation ?? this.#responseGeneration;
      this.#outputSequence = sequence; this.#interrupted = false; this.#interruptThrough = undefined;
      return this.#lastRead;
    } finally { this.#wake = undefined; this.#reading = false; }
  }
  interrupt(position?: PlaybackPosition, throughResponse?: number): void {
    this.check();
    const through = throughResponse ?? this.#responseGeneration;
    if (through > this.#responseGeneration) throw new Error("realtime_sequence");
    if (this.#response && this.#responseGeneration <= through) {
      const eventId = "cancel_" + randomUUID();
      this.#send({ type: "response.cancel", event_id: eventId });
      this.#cancelEvents.set(this.#response, eventId);
      this.#response = undefined;
    }
    let afterPlaying = false;
    for (const item of this.#outputs.values()) {
      if (item.generation > through || item.reconciled || !item.itemId) continue;
      const playing = position?.itemId === item.itemId && position.contentIndex === item.contentIndex;
      if (playing) afterPlaying = true;
      if (item.done && item.delivered === item.samples && (!afterPlaying || (playing && position.sampleOffset >= item.samples))) continue;
      if (this.binding.protocol === "openai-realtime") {
        const heard = playing ? Math.min(position.sampleOffset, item.delivered) : 0;
        this.#send({ type: "conversation.item.truncate", item_id: item.itemId, content_index: item.contentIndex, audio_end_ms: Math.floor(heard / 24) });
      } else this.#deleteQwenItem(item);
      item.reconciled = true;
    }
    this.#dropAudio(through);
    if (throughResponse === undefined) { this.#interrupted = true; this.#wake?.(); }
  }
  #deleteQwenItem(item: OutputItem): void {
    if (this.binding.protocol !== "qwen-audio-realtime" || !item.done || this.#deletedItems.has(item.itemId)) return;
    this.#send({ type: "conversation.item.delete", item_id: item.itemId });
    this.#deletedItems.add(item.itemId);
  }
  #dropAudio(through: number): void {
    this.#silencedThrough = Math.max(this.#silencedThrough, through);
    this.#chunks = this.#chunks.filter(chunk => chunk.item.generation > through);
    this.#bytes = this.#chunks.reduce((total, chunk) => total + chunk.pcm.length, 0);
    if (this.#lastReadGeneration <= through) this.#lastRead = undefined;
  }
  check(): void { this.assertCurrent(); if (!this.#ready || this.#lifetime.signal.aborted) throw new Error("realtime_unavailable"); }
  close(): void {
    if (this.#lifetime.signal.aborted) return;
    this.#lifetime.abort(); this.#wake?.(); this.#chunks = []; this.#bytes = 0; this.#lastRead = undefined;
    this.#outputs.clear(); this.#deletedItems.clear(); this.#inputs.clear(); this.#cancelEvents.clear(); this.#socket?.close(); this.#socket = undefined;
  }
}
