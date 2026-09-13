const TARGET_PCM_SAMPLE_RATE = 16_000;
const PROCESSOR_BUFFER_SIZE = 4_096;
const VOICED_RMS_THRESHOLD = 0.012;

export interface VoicePcmChunk {
  readonly audio: Uint8Array;
  readonly durationMs: number;
  readonly voiced: boolean;
}

export interface VoicePcmCapture {
  start(stream: MediaStream, onChunk: (chunk: VoicePcmChunk) => void): Promise<void>;
  stop(): Promise<void>;
}

export type VoicePcmCaptureFactory = () => VoicePcmCapture;

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

export function hasVoicePcmCapture(): boolean {
  return voiceAudioContextConstructor() !== undefined;
}

/** Browser-local mono PCM16 capture used by streaming transcription routes. */
export class WebAudioVoicePcmCapture implements VoicePcmCapture {
  readonly #AudioContextClass: AudioContextConstructor;
  #context: AudioContext | undefined;
  #source: MediaStreamAudioSourceNode | undefined;
  #processor: ScriptProcessorNode | undefined;
  #sink: GainNode | undefined;
  #resampler: StreamingPcm16Resampler | undefined;
  #onChunk: ((chunk: VoicePcmChunk) => void) | undefined;

  constructor(AudioContextClass = voiceAudioContextConstructor()) {
    if (AudioContextClass === undefined) throw new Error("Web Audio capture is unavailable.");
    this.#AudioContextClass = AudioContextClass;
  }

  async start(stream: MediaStream, onChunk: (chunk: VoicePcmChunk) => void): Promise<void> {
    if (this.#context !== undefined) throw new Error("PCM capture has already started.");
    const context = new this.#AudioContextClass({ latencyHint: "interactive" });
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
    const sink = context.createGain();
    sink.gain.value = 0;
    const resampler = new StreamingPcm16Resampler(context.sampleRate, TARGET_PCM_SAMPLE_RATE);
    this.#context = context;
    this.#source = source;
    this.#processor = processor;
    this.#sink = sink;
    this.#resampler = resampler;
    this.#onChunk = onChunk;
    processor.onaudioprocess = (event) => {
      const samples = mixToMono(event.inputBuffer);
      const encoded = resampler.push(samples);
      if (encoded.byteLength === 0) return;
      this.#onChunk?.({
        audio: encoded,
        durationMs: Math.max(1, Math.round(encoded.byteLength / 2 / TARGET_PCM_SAMPLE_RATE * 1_000)),
        voiced: rootMeanSquare(samples) >= VOICED_RMS_THRESHOLD
      });
    };
    source.connect(processor);
    processor.connect(sink);
    sink.connect(context.destination);
    if (context.state === "suspended") await context.resume();
  }

  async stop(): Promise<void> {
    const context = this.#context;
    this.#onChunk = undefined;
    if (this.#processor !== undefined) this.#processor.onaudioprocess = null;
    try { this.#source?.disconnect(); } catch { /* already detached */ }
    try { this.#processor?.disconnect(); } catch { /* already detached */ }
    try { this.#sink?.disconnect(); } catch { /* already detached */ }
    this.#context = undefined;
    this.#source = undefined;
    this.#processor = undefined;
    this.#sink = undefined;
    this.#resampler = undefined;
    if (context !== undefined && context.state !== "closed") await context.close().catch(() => undefined);
  }
}

export class StreamingPcm16Resampler {
  readonly #ratio: number;
  #pending = new Float32Array(0);
  #position = 0;

  constructor(sourceSampleRate: number, targetSampleRate = TARGET_PCM_SAMPLE_RATE) {
    if (
      !Number.isFinite(sourceSampleRate) || sourceSampleRate < 8_000 || sourceSampleRate > 192_000
      || !Number.isFinite(targetSampleRate) || targetSampleRate < 8_000 || targetSampleRate > 96_000
    ) throw new RangeError("PCM sample rate is invalid.");
    this.#ratio = sourceSampleRate / targetSampleRate;
  }

  push(input: Float32Array): Uint8Array {
    if (input.length === 0) return new Uint8Array();
    const merged = new Float32Array(this.#pending.length + input.length);
    merged.set(this.#pending);
    merged.set(input, this.#pending.length);
    const values: number[] = [];
    while (this.#position < merged.length - 1) {
      const left = Math.floor(this.#position);
      const right = Math.min(merged.length - 1, left + 1);
      const fraction = this.#position - left;
      values.push(merged[left]! * (1 - fraction) + merged[right]! * fraction);
      this.#position += this.#ratio;
    }
    const consumed = Math.min(merged.length - 1, Math.floor(this.#position));
    this.#pending = merged.slice(consumed);
    this.#position -= consumed;
    const bytes = new Uint8Array(values.length * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < values.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, values[index]!));
      const pcm = sample < 0 ? Math.round(sample * 32_768) : Math.round(sample * 32_767);
      view.setInt16(index * 2, pcm, true);
    }
    return bytes;
  }
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  const channels = Math.max(1, buffer.numberOfChannels);
  const output = new Float32Array(buffer.length);
  for (let channel = 0; channel < channels; channel += 1) {
    const values = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
    for (let index = 0; index < output.length; index += 1) {
      output[index] = output[index]! + values[index]! / channels;
    }
  }
  return output;
}

function rootMeanSquare(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

function voiceAudioContextConstructor(): AudioContextConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  const scope = window as typeof window & { readonly webkitAudioContext?: AudioContextConstructor };
  return scope.AudioContext ?? scope.webkitAudioContext;
}
