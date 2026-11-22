import { createRequire } from "node:module";
import { parentPort } from "node:worker_threads";
import { SPEAKER_GATE_SAMPLE_RATE, SPEAKER_GATE_VAD_FRAME } from "@joko/voice-speaker";

export type VoiceSpeakerWork =
  | { kind: "load"; vad: string; embedding: string }
  | { kind: "speech" | "embed"; samples: Float32Array }
  | { kind: "reset" | "release"; session: number }
  | { kind: "detect"; session: number; samples: Float32Array };

export type VoiceSpeakerWorkResult = void | Float32Array | boolean[] | null;

type Vad = {
  acceptWaveform(samples: Float32Array): void;
  isDetected(): boolean;
  isEmpty(): boolean;
  front(external: boolean): { samples: Float32Array };
  pop(): void;
  flush(): void;
  reset(): void;
};
type Stream = {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
  inputFinished(): void;
};
type Extractor = {
  createStream(): Stream;
  isReady(stream: Stream): boolean;
  compute(stream: Stream, external: boolean): Float32Array;
};
type Sherpa = {
  Vad: new (options: unknown, bufferSeconds: number) => Vad;
  SpeakerEmbeddingExtractor: new (options: unknown) => Extractor;
};

const port = parentPort;
if (!port) throw new Error("Speaker inference needs a worker thread.");
const require = createRequire(import.meta.url);
let sherpa: Sherpa;
let vadPath: string;
let extractor: Extractor;
const sessions = new Map<number, Vad>();

function createVad(): Vad {
  return new sherpa.Vad({
    sileroVad: { model: vadPath, threshold: 0.5, minSpeechDuration: 0.25, minSilenceDuration: 0.25,
      maxSpeechDuration: 20, windowSize: SPEAKER_GATE_VAD_FRAME },
    sampleRate: SPEAKER_GATE_SAMPLE_RATE, numThreads: 1, debug: 0
  }, 30);
}

function feed(vad: Vad, samples: Float32Array, visit?: (detected: boolean) => void, speech?: Float32Array[]): void {
  for (let offset = 0; offset < samples.length; offset += SPEAKER_GATE_VAD_FRAME) {
    vad.acceptWaveform(samples.subarray(offset, offset + SPEAKER_GATE_VAD_FRAME));
    visit?.(vad.isDetected());
    drain(vad, speech);
  }
}

function drain(vad: Vad, speech?: Float32Array[]): void {
  while (!vad.isEmpty()) {
    if (speech) speech.push(Float32Array.from(vad.front(false).samples));
    vad.pop();
  }
}

function perform(work: VoiceSpeakerWork): VoiceSpeakerWorkResult {
  switch (work.kind) {
    case "load":
      sherpa = require("sherpa-onnx-node") as Sherpa;
      vadPath = work.vad;
      extractor = new sherpa.SpeakerEmbeddingExtractor({ model: work.embedding, numThreads: 1, debug: 0, provider: "cpu" });
      createVad();
      return;
    case "reset":
      sessions.set(work.session, createVad());
      return;
    case "release":
      sessions.delete(work.session);
      return;
    case "detect": {
      const vad = sessions.get(work.session);
      if (!vad) throw new Error("Speaker VAD session ended.");
      const flags: boolean[] = [];
      feed(vad, work.samples, detected => flags.push(detected));
      return flags;
    }
    case "speech": {
      const vad = createVad(), parts: Float32Array[] = [];
      feed(vad, work.samples, undefined, parts);
      vad.flush();
      drain(vad, parts);
      const joined = new Float32Array(parts.reduce((length, part) => length + part.length, 0));
      let offset = 0;
      for (const part of parts) {
        joined.set(part, offset);
        offset += part.length;
      }
      return joined;
    }
    case "embed": {
      const stream = extractor.createStream();
      stream.acceptWaveform({ sampleRate: SPEAKER_GATE_SAMPLE_RATE, samples: work.samples });
      stream.inputFinished();
      return extractor.isReady(stream) ? Float32Array.from(extractor.compute(stream, false)) : null;
    }
  }
}

port.on("message", ({ id, work }: { id: number; work: VoiceSpeakerWork }) => {
  try { port.postMessage({ id, ok: true, value: perform(work) }); }
  catch { port.postMessage({ id, ok: false }); }
  finally { if ("samples" in work) work.samples.fill(0); }
});
