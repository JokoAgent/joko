import { Worker } from "node:worker_threads";
import type { SpeakerEnrollmentEngine, SpeakerGateEngine } from "@joko/voice-speaker";
import type { VoiceSpeakerWork, VoiceSpeakerWorkResult } from "./voice-speaker-worker.js";

const WORK_TIMEOUT_MS = 15_000;
type ModelPaths = { vad: string; embedding: string };
type Reply = { id: number; ok: boolean; value?: VoiceSpeakerWorkResult };

export class DesktopSpeakerEngine {
  #worker?: Worker;
  #ready?: Promise<void>;
  #idle?: ReturnType<typeof setTimeout>;
  #nextId = 0;
  #pending = new Map<number, (reply?: Reply) => void>();

  load(paths: ModelPaths): Promise<void> {
    if (this.#ready) return this.#ready;
    const worker = new Worker(new URL("./voice-speaker-worker.js", import.meta.url));
    this.#worker = worker;
    worker.on("message", (reply: Reply) => {
      if (this.#worker === worker) this.#pending.get(reply.id)?.(reply);
    });
    const gone = () => { if (this.#worker === worker) this.dispose(); };
    worker.once("error", gone);
    worker.once("exit", gone);
    worker.unref();
    this.#ready = this.#send<void>({ kind: "load", ...paths }).catch(error => { gone(); throw error; });
    return this.#ready;
  }

  gate(session: number): SpeakerGateEngine {
    const worker = this.#worker;
    const send = <T extends VoiceSpeakerWorkResult>(work: VoiceSpeakerWork) => this.#send<T>(work, worker);
    return {
      resetVad: () => send<void>({ kind: "reset", session }),
      detectSpeech: samples => send<boolean[]>({ kind: "detect", session, samples: samples.slice() }),
      embed: samples => send<Float32Array | null>({ kind: "embed", samples: samples.slice() })
    };
  }

  enrollment(): SpeakerEnrollmentEngine {
    const worker = this.#worker;
    return {
      extractSpeech: samples => this.#send<Float32Array>({ kind: "speech", samples: samples.slice() }, worker),
      embed: samples => this.#send<Float32Array | null>({ kind: "embed", samples: samples.slice() }, worker)
    };
  }

  release(session: number): void {
    void this.#send<void>({ kind: "release", session }).catch(() => undefined);
  }

  dispose(): void {
    clearTimeout(this.#idle);
    const worker = this.#worker;
    this.#worker = undefined;
    this.#ready = undefined;
    for (const finish of this.#pending.values()) finish();
    void worker?.terminate();
  }

  #send<T extends VoiceSpeakerWorkResult>(work: VoiceSpeakerWork, worker = this.#worker): Promise<T> {
    if (!worker || worker !== this.#worker) return Promise.reject(new Error("Speaker inference is unavailable."));
    const id = ++this.#nextId;
    clearTimeout(this.#idle);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.dispose(), WORK_TIMEOUT_MS);
      timer.unref();
      this.#pending.set(id, reply => {
        clearTimeout(timer);
        this.#pending.delete(id);
        if (reply?.ok) resolve(reply.value as T);
        else reject(new Error("Speaker inference failed."));
        if (this.#worker === worker && this.#pending.size === 0) {
          this.#idle = setTimeout(() => this.dispose(), 10 * 60_000);
          this.#idle.unref();
        }
      });
      try { worker.postMessage({ id, work }, "samples" in work ? [work.samples.buffer as ArrayBuffer] : []); }
      catch { this.dispose(); }
    });
  }
}
