import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { mobileSecureStorage } from "../storage";
import { mobileVoiceCaptureRuntime } from "../mobile-realtime-audio";
import { createOnnxSpeakerEnrollmentEngine, createOnnxSpeakerGateEngine } from "./onnx-engine";
import { base64ToFloat32, isSpeakerOnnxAvailable, nativeSpeakerOnnxRunner, packFloat32 } from "./native";
import { prepareMobileSpeakerModels } from "./models";
import { buildSpeakerEnrollment, SPEAKER_ENROLLMENT_CLIP_COUNT, SPEAKER_ENROLLMENT_MAX_CLIP_SEC,
  DEFAULT_SPEAKER_GATE_STRICTNESS, isSpeakerGateStrictness, SPEAKER_EMBEDDING_SHA256, SPEAKER_GATE_SAMPLE_RATE,
  SPEAKER_GATE_STRICTNESS_THRESHOLDS, SpeakerGate, type SpeakerGateStrictness } from "@joko/voice-speaker";

interface SpeakerProfile {
  readonly version: 1;
  readonly model: string;
  readonly embedding: string;
  readonly enabled: boolean;
  readonly strictness?: SpeakerGateStrictness;
}

export type MobileSpeakerNotice = "filtered" | "unavailable";

function profileKey(owner: string): string {
  return `joko.mobile.voiceprint.v1.${bytesToHex(sha256(new TextEncoder().encode(owner)))}`;
}

async function readProfile(owner: string): Promise<SpeakerProfile | undefined> {
  const raw = await mobileSecureStorage.getItem(profileKey(owner));
  if (raw === null || raw.length > 2_048) return;
  try {
    const profile = JSON.parse(raw) as Partial<SpeakerProfile>;
    if (profile.version !== 1 || profile.model !== SPEAKER_EMBEDDING_SHA256
      || typeof profile.embedding !== "string" || profile.embedding.length !== 1024
      || profile.strictness !== undefined && !isSpeakerGateStrictness(profile.strictness)) return;
    return { version: 1, model: profile.model, embedding: profile.embedding, enabled: profile.enabled === true,
      ...(profile.strictness === undefined ? {} : { strictness: profile.strictness }) };
  } catch { return undefined; }
}

export async function readMobileSpeakerSettings(owner: string) {
  return settingsFor(await readProfile(owner));
}

function settingsFor(profile: SpeakerProfile | undefined) {
  return { enrolled: profile !== undefined, enabled: profile?.enabled ?? false,
    strictness: profile?.strictness ?? DEFAULT_SPEAKER_GATE_STRICTNESS, strictnessOverride: profile?.strictness };
}

const profileWrites = new Map<string, Promise<SpeakerProfile | undefined>>();

async function updateProfile(owner: string, signal: AbortSignal, update: (current: SpeakerProfile | undefined) => SpeakerProfile | undefined) {
  const key = profileKey(owner);
  const previous = profileWrites.get(key);
  const pending = (async () => {
    await previous?.catch(() => undefined);
    signal.throwIfAborted();
    const current = await readProfile(owner);
    signal.throwIfAborted();
    const next = update(current);
    if (next) await mobileSecureStorage.setItem(key, JSON.stringify(next));
    else await mobileSecureStorage.removeItem(key);
    return next;
  })();
  profileWrites.set(key, pending);
  try { return settingsFor(await pending); }
  finally { if (profileWrites.get(key) === pending) profileWrites.delete(key); }
}

export function writeMobileSpeakerSettings(owner: string, change: {
  readonly enabled?: boolean;
  readonly strictness?: SpeakerGateStrictness | null;
}, signal: AbortSignal) {
  return updateProfile(owner, signal, profile => {
    if (!profile) throw new Error("A voiceprint is required.");
    const strictness = change.strictness === undefined ? profile.strictness : change.strictness ?? undefined;
    return { ...profile, enabled: change.enabled ?? profile.enabled, strictness };
  });
}

export function removeMobileSpeakerProfile(owner: string, signal: AbortSignal) {
  return updateProfile(owner, signal, () => undefined);
}

export async function enrollMobileSpeaker(owner: string, clips: Float32Array[], signal: AbortSignal) {
  if (clips.length !== SPEAKER_ENROLLMENT_CLIP_COUNT) throw new Error("Three recordings are required.");
  const original = await readProfile(owner);
  signal.throwIfAborted();
  await prepareMobileSpeakerModels();
  signal.throwIfAborted();
  const engine = createOnnxSpeakerEnrollmentEngine(nativeSpeakerOnnxRunner);
  const result = await buildSpeakerEnrollment({
    extractSpeech: samples => { signal.throwIfAborted(); return engine.extractSpeech(samples); },
    embed: samples => { signal.throwIfAborted(); return engine.embed(samples); }
  }, clips);
  if (!result.ok) { signal.throwIfAborted(); return result; }
  try {
    signal.throwIfAborted();
    if (result.embedding.length !== 192) throw new Error("The voiceprint has an unexpected shape.");
    const bytes = packFloat32([result.embedding]);
    const embedding = btoa(String.fromCharCode(...bytes));
    bytes.fill(0);
    await updateProfile(owner, signal, current => {
      if (current?.embedding !== original?.embedding) throw new Error("The saved voiceprint changed during enrollment.");
      return { version: 1, model: SPEAKER_EMBEDDING_SHA256, embedding, enabled: current?.enabled ?? false,
        strictness: current?.strictness };
    });
    return { ok: true } as const;
  } finally { result.embedding.fill(0); }
}

export async function warmMobileSpeakerFilter(owner: string): Promise<void> {
  if (isSpeakerOnnxAvailable() && (await readProfile(owner))?.enabled) await prepareMobileSpeakerModels();
}

export async function mobileSpeakerGate(owner: string, notice: (event: MobileSpeakerNotice) => void, signal: AbortSignal) {
  try {
    const profile = await readProfile(owner);
    if (!profile?.enabled || signal.aborted) return;
    if (!isSpeakerOnnxAvailable()) throw new Error("Speaker filtering is unavailable in this build.");
    await prepareMobileSpeakerModels();
    if (signal.aborted) return;
    const embedding = base64ToFloat32(profile.embedding);
    if (embedding.length !== 192 || !embedding.every(Number.isFinite) || !embedding.some(value => value !== 0)) {
      throw new Error("The stored voiceprint is invalid.");
    }
    return new SpeakerGate({ engine: createOnnxSpeakerGateEngine(nativeSpeakerOnnxRunner), enrolledEmbedding: embedding,
      ...SPEAKER_GATE_STRICTNESS_THRESHOLDS[profile.strictness ?? DEFAULT_SPEAKER_GATE_STRICTNESS],
      onDecision: event => { if (!event.accepted && !signal.aborted) notice("filtered"); },
      onPassthrough: () => { if (!signal.aborted) notice("unavailable"); }
    });
  } catch {
    if (!signal.aborted) notice("unavailable");
    return undefined;
  }
}

export async function startMobileSpeakerClip(signal: AbortSignal): Promise<() => Promise<Float32Array>> {
  const capture = mobileVoiceCaptureRuntime;
  const permission = await capture.ensurePermission(signal);
  signal.throwIfAborted();
  if (!permission.granted) throw new Error("Microphone permission is required.");
  const samples = new Float32Array(SPEAKER_GATE_SAMPLE_RATE * SPEAKER_ENROLLMENT_MAX_CLIP_SEC);
  let offset = 0;
  let error: Error | undefined;
  const clear = () => samples.fill(0);
  signal.addEventListener("abort", clear, { once: true });
  try {
    const stop = await capture.start(chunk => {
      if (signal.aborted || offset === samples.length) return;
      const audio = new DataView(chunk.audio.buffer, chunk.audio.byteOffset, chunk.audio.byteLength);
      const limit = Math.min(samples.length - offset, Math.floor(chunk.audio.byteLength / 2));
      for (let i = 0; i < limit; i++) samples[offset++] = audio.getInt16(i * 2, true) / 32768;
    }, failure => { error = failure; }, signal);
    return async () => {
      try {
        await stop();
        signal.throwIfAborted();
        if (error !== undefined) throw error;
        return samples.slice(0, offset);
      } finally { clear(); signal.removeEventListener("abort", clear); }
    };
  } catch (error) {
    clear();
    signal.removeEventListener("abort", clear);
    throw error;
  }
}
