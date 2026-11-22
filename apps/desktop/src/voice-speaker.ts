import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { IpcMain, IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron";
import type { DesktopSpeakerEnrollment, DesktopSpeakerNotice, DesktopSpeakerOutput, DesktopSpeakerPcm,
  DesktopSpeakerRun, DesktopSpeakerStatus, DesktopSpeakerStrength } from "@joko/contracts";
import { buildSpeakerEnrollment, DEFAULT_SPEAKER_GATE_STRICTNESS, isSpeakerGateStrictness, pcm16ToFloat,
  SPEAKER_EMBEDDING_SHA256, SPEAKER_ENROLLMENT_CLIP_COUNT, SPEAKER_ENROLLMENT_MAX_CLIP_SEC, SPEAKER_GATE_SAMPLE_RATE,
  SPEAKER_GATE_STRICTNESS_THRESHOLDS, SpeakerGate } from "@joko/voice-speaker";
import { DesktopSpeakerEngine } from "./voice-speaker-engine.js";
import { DesktopSpeakerModels } from "./voice-speaker-models.js";

const supportedTargets = new Set(["darwin-arm64", "darwin-x64", "win32-x64", "linux-arm64", "linux-x64"]);
const maximumClipBytes = SPEAKER_GATE_SAMPLE_RATE * SPEAKER_ENROLLMENT_MAX_CLIP_SEC * 2;
const maxRuns = 4;
const maxPcmChunk = 64_000;
const maxRunBytes = 32_000 * 600;
const require = createRequire(import.meta.url);

interface Profile {
  readonly version: 1;
  readonly model: string;
  readonly embedding: string;
  readonly enabled: boolean;
  readonly strength?: DesktopSpeakerStrength;
}

interface Capture {
  readonly id: string;
  readonly session: number;
  readonly document: AbortSignal;
  readonly gate: SpeakerGate;
  readonly embedding: Float32Array;
  readonly chunks: DesktopSpeakerPcm[];
  readonly retire: () => void;
  notice?: DesktopSpeakerNotice;
  bytes: number;
  busy: boolean;
}

export interface DesktopSpeakerHostOptions {
  directory(): string;
  assertSource(event: IpcMainInvokeEvent): void;
  hasProfile(profileId: string): Promise<boolean>;
  storageAvailable(): boolean;
  encrypt(text: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

export function registerDesktopSpeakerIpc(ipc: Pick<IpcMain, "handle">, options: DesktopSpeakerHostOptions): void {
  const service = new DesktopSpeakerFilter(options);
  const documents = new Map<WebContents, { frame: WebFrameMain; lifetime: AbortController; retire: () => void }>();
  ipc.handle("joko:voice-speaker", async (event, action: unknown, key: unknown, value?: unknown) => {
    options.assertSource(event);
    const frame = event.senderFrame;
    if (!frame) throw new Error("Voice window has ended.");
    const contents = event.sender;
    let entry = documents.get(contents);
    if (entry?.frame !== frame) {
      entry?.retire();
      const lifetime = new AbortController();
      const retire = () => {
        contents.removeListener("destroyed", retire);
        contents.removeListener("render-process-gone", retire);
        contents.removeListener("did-start-navigation", navigate);
        if (documents.get(contents)?.lifetime === lifetime) documents.delete(contents);
        lifetime.abort();
      };
      const navigate = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
        if (mainFrame && !inPlace) retire();
      };
      contents.once("destroyed", retire);
      contents.once("render-process-gone", retire);
      contents.on("did-start-navigation", navigate);
      entry = { frame, lifetime, retire };
      documents.set(contents, entry);
    }
    const signal = entry.lifetime.signal;
    if (typeof key !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/u.test(key)) throw new Error("Invalid voice filter identifier.");
    if (action === "push" || action === "finish" || action === "cancel") {
      return service.capture(action, key, value, signal);
    }
    if (!await options.hasProfile(key)) throw new Error("The paired voice filter profile is unavailable.");
    signal.throwIfAborted();
    options.assertSource(event);
    switch (action) {
      case "status": return service.status(key);
      case "download": return service.download(key, signal);
      case "enroll": return service.enroll(key, value, signal);
      case "configure": return service.configure(key, value, signal);
      case "remove": return service.remove(key, signal);
      case "begin": return service.begin(key, signal);
      default: throw new Error("Unknown voice filter action.");
    }
  });
}

class DesktopSpeakerFilter {
  readonly #engine = new DesktopSpeakerEngine();
  readonly #models: DesktopSpeakerModels;
  readonly #runs = new Map<string, Capture>();
  readonly #writes = new Set<string>();
  #sequence = 0;

  constructor(private readonly options: DesktopSpeakerHostOptions) {
    this.#models = new DesktopSpeakerModels(() => join(options.directory(), "voice-models-v1"));
  }

  #supported(): boolean {
    if (!supportedTargets.has(`${process.platform}-${process.arch}`) || !this.options.storageAvailable()) return false;
    try {
      const packageName = `sherpa-onnx-${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
      createRequire(require.resolve("sherpa-onnx-node")).resolve(`${packageName}/sherpa-onnx.node`);
      return true;
    } catch { return false; }
  }

  async status(profileId: string): Promise<DesktopSpeakerStatus> {
    const supported = this.#supported();
    const profile = this.options.storageAvailable() ? await this.#read(profileId) : undefined;
    return { supported, modelsReady: supported && (await this.#models.paths()) !== undefined, enrolled: profile !== undefined,
      enabled: profile?.enabled ?? false, ...(profile?.strength === undefined ? {} : { strength: profile.strength }) };
  }

  async download(profileId: string, signal: AbortSignal): Promise<DesktopSpeakerStatus> {
    if (!this.#supported()) throw new Error("Speaker filtering is unavailable on this desktop.");
    await this.#models.download(signal);
    await this.#prepare();
    signal.throwIfAborted();
    return this.status(profileId);
  }

  async enroll(profileId: string, value: unknown, signal: AbortSignal): Promise<DesktopSpeakerEnrollment> {
    if (!Array.isArray(value) || value.length !== SPEAKER_ENROLLMENT_CLIP_COUNT
      || value.some(clip => !(clip instanceof Uint8Array) || clip.byteLength < 2
        || clip.byteLength > maximumClipBytes || clip.byteLength % 2 !== 0)) throw new Error("Invalid voiceprint recording.");
    const clips = (value as Uint8Array[]).map(clip => pcm16ToFloat(Uint8Array.from(clip).buffer));
    try {
      return await this.#write(profileId, async () => {
        if (!this.#supported()) throw new Error("Speaker filtering is unavailable on this desktop.");
        const current = await this.#read(profileId);
        await this.#prepare();
        signal.throwIfAborted();
        const engine = this.#engine.enrollment();
        const result = await buildSpeakerEnrollment({
          extractSpeech: samples => { signal.throwIfAborted(); return engine.extractSpeech(samples); },
          embed: samples => { signal.throwIfAborted(); return engine.embed(samples); }
        }, clips);
        if (!result.ok) return { ok: false, ...(result.clipIndex === undefined ? {} : { clipIndex: result.clipIndex }) };
        try {
          if (result.embedding.length !== 192) throw new Error("Unexpected voiceprint shape.");
          const embedding = Buffer.from(result.embedding.buffer, result.embedding.byteOffset, result.embedding.byteLength).toString("base64");
          await this.#save(profileId, { version: 1, model: SPEAKER_EMBEDDING_SHA256, enabled: current?.enabled ?? false,
            strength: current?.strength, embedding }, signal);
          return { ok: true, status: await this.status(profileId) };
        } finally { result.embedding.fill(0); }
      });
    } finally { for (const clip of clips) clip.fill(0); }
  }

  async configure(profileId: string, value: unknown, signal: AbortSignal): Promise<DesktopSpeakerStatus> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid voice settings.");
    const { enabled, strength } = value as { enabled?: unknown; strength?: unknown };
    if (enabled !== undefined && typeof enabled !== "boolean"
      || strength !== undefined && strength !== null && !isSpeakerGateStrictness(strength)) throw new Error("Invalid voice settings.");
    return this.#write(profileId, async () => {
      const profile = await this.#read(profileId);
      if (!profile) throw new Error("A saved voiceprint is required.");
      if (enabled === true) { if (!this.#supported()) throw new Error("Speaker filtering is unavailable on this desktop."); await this.#prepare(); }
      await this.#save(profileId, { ...profile, enabled: enabled ?? profile.enabled,
        strength: strength === undefined ? profile.strength : strength ?? undefined }, signal);
      return this.status(profileId);
    });
  }

  async remove(profileId: string, signal: AbortSignal): Promise<DesktopSpeakerStatus> {
    return this.#write(profileId, async () => {
      signal.throwIfAborted();
      if (!await this.options.hasProfile(profileId)) throw new Error("The paired voice filter profile is unavailable.");
      signal.throwIfAborted();
      await rm(this.#profilePath(profileId), { force: true });
      return this.status(profileId);
    });
  }

  async begin(profileId: string, document: AbortSignal): Promise<DesktopSpeakerRun> {
    let profile: Profile | undefined;
    try {
      if (!this.options.storageAvailable()) {
        const saved = await lstat(this.#profilePath(profileId)).catch(() => undefined);
        return { mode: saved?.isFile() ? "unavailable" : "disabled" };
      }
      profile = await this.#read(profileId);
      if (!profile?.enabled) return { mode: "disabled" };
      if (!this.#supported()) return { mode: "unavailable" };
      await this.#prepare();
      document.throwIfAborted();
      if (!await this.options.hasProfile(profileId)) throw new Error("The paired voice filter profile is unavailable.");
      document.throwIfAborted();
    } catch {
      document.throwIfAborted();
      return { mode: "unavailable" };
    }
    if (this.#runs.size >= maxRuns || [...this.#runs.values()].some(run => run.document === document)) {
      throw new Error("The voice filter already has an active recording.");
    }
    const id = randomUUID(), session = ++this.#sequence;
    const embedding = new Float32Array(Uint8Array.from(Buffer.from(profile.embedding, "base64")).buffer);
    if (embedding.length !== 192 || !embedding.every(Number.isFinite) || !embedding.some(sample => sample !== 0)) {
      embedding.fill(0);
      return { mode: "unavailable" };
    }
    const gate = new SpeakerGate({
      engine: this.#engine.gate(session), enrolledEmbedding: embedding,
      ...SPEAKER_GATE_STRICTNESS_THRESHOLDS[profile.strength ?? DEFAULT_SPEAKER_GATE_STRICTNESS],
      onDecision: decision => { if (!decision.accepted) capture.notice = "filtered"; },
      onPassthrough: () => { capture.notice = "unavailable"; }
    });
    const retire = () => this.#end(capture);
    const capture: Capture = { id, session, gate, embedding, document, retire, chunks: [], bytes: 0, busy: false };
    document.addEventListener("abort", retire, { once: true });
    this.#runs.set(id, capture);
    gate.begin((pcm, trace) => {
      if (!trace || document.aborted || this.#runs.get(id) !== capture) return;
      const audio = new Uint8Array(pcm);
      capture.chunks.push({ audio, durationMs: trace.durationMs, voiced: trace.voiced && audio.some(byte => byte !== 0) });
    });
    return { mode: "active", id };
  }

  async capture(action: "push" | "finish" | "cancel", id: string, value: unknown,
    document: AbortSignal): Promise<DesktopSpeakerOutput | undefined> {
    const run = this.#runs.get(id);
    if (run?.document !== document || document.aborted) {
      if (action === "cancel") return;
      throw new Error("The voice recording has ended.");
    }
    if (action === "cancel") { this.#end(run); return; }
    if (run.busy) throw new Error("A voice filter command is already pending.");
    run.busy = true;
    try {
      if (action === "finish") await run.gate.finish();
      else {
        const chunk = parsePcm(value);
        run.bytes += chunk.audio.length;
        if (run.bytes > maxRunBytes) throw new Error("The voice recording exceeds its time limit.");
        run.gate.push(Uint8Array.from(chunk.audio).buffer, chunk);
        await run.gate.drain();
      }
      document.throwIfAborted();
      if (this.#runs.get(id) !== run) throw new Error("The voice recording has ended.");
      const output = { chunks: run.chunks.splice(0), ...(run.notice ? { notice: run.notice } : {}) };
      run.notice = undefined;
      if (action === "finish") this.#end(run);
      return output;
    } finally { run.busy = false; }
  }

  #end(run: Capture): void {
    if (this.#runs.get(run.id) !== run) return;
    this.#runs.delete(run.id);
    run.document.removeEventListener("abort", run.retire);
    run.gate.abort();
    run.embedding.fill(0);
    for (const chunk of run.chunks.splice(0)) chunk.audio.fill(0);
    this.#engine.release(run.session);
  }

  async #prepare(): Promise<void> {
    const models = await this.#models.paths();
    if (!models) throw new Error("Download the verified voice models first.");
    await this.#engine.load(models);
  }

  async #write<T>(profileId: string, work: () => Promise<T>): Promise<T> {
    if (this.#writes.has(profileId)) throw new Error("The voiceprint is already being updated.");
    this.#writes.add(profileId);
    try { return await work(); }
    finally { this.#writes.delete(profileId); }
  }

  #profilePath(profileId: string): string {
    return join(this.options.directory(), "voiceprints-v1", createHash("sha256").update(profileId).digest("hex"));
  }

  async #read(profileId: string): Promise<Profile | undefined> {
    const ciphertext = await readFile(this.#profilePath(profileId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!ciphertext) return undefined;
    if (ciphertext.length > 16_384) throw new Error("Invalid stored voiceprint.");
    const profile = JSON.parse(this.options.decrypt(ciphertext)) as Partial<Profile>;
    if (profile.version !== 1 || profile.model !== SPEAKER_EMBEDDING_SHA256 || typeof profile.embedding !== "string"
      || profile.embedding.length !== 1024 || typeof profile.enabled !== "boolean"
      || profile.strength !== undefined && !isSpeakerGateStrictness(profile.strength)) throw new Error("Invalid stored voiceprint.");
    return profile as Profile;
  }

  async #save(profileId: string, profile: Profile, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const directory = join(this.options.directory(), "voiceprints-v1");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, randomUUID());
    try {
      await writeFile(temporary, this.options.encrypt(JSON.stringify(profile)), { flag: "wx", mode: 0o600 });
      signal.throwIfAborted();
      if (!await this.options.hasProfile(profileId)) throw new Error("The paired voice filter profile is unavailable.");
      signal.throwIfAborted();
      await rename(temporary, this.#profilePath(profileId));
    } finally { await rm(temporary, { force: true }); }
  }
}

function parsePcm(value: unknown): DesktopSpeakerPcm {
  if (typeof value !== "object" || value === null) throw new Error("Invalid voice audio.");
  const { audio, durationMs, voiced } = value as DesktopSpeakerPcm;
  if (!(audio instanceof Uint8Array) || audio.length < 2 || audio.length > maxPcmChunk || audio.length % 2 !== 0
    || !Number.isInteger(durationMs) || durationMs < 1 || Math.abs(durationMs - audio.length / 32) > 1 || typeof voiced !== "boolean") {
    throw new Error("Invalid voice audio.");
  }
  return { audio, durationMs, voiced };
}
