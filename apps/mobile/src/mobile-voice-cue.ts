import { createAudioPlayer, type AudioPlayer } from "expo-audio";

interface MobileVoiceCue {
  readonly fromFrequency: number;
  readonly toFrequency: number;
  readonly rampAt: number;
  readonly duration: number;
  readonly volume: number;
  readonly delay?: number;
  readonly attack?: number;
}

const SAMPLE_RATE = 44_100;
const SILENCE_TAIL_SECONDS = 0.025;
const PLAYER_RELEASE_TIMEOUT_MS = 2_000;
const END_CUE = buildCueDataUri([
  {
    fromFrequency: 520,
    toFrequency: 660,
    rampAt: 0.045,
    duration: 0.11,
    volume: 0.095,
    attack: 0.006
  },
  {
    fromFrequency: 720,
    toFrequency: 920,
    rampAt: 0.045,
    duration: 0.11,
    volume: 0.095,
    delay: 0.16,
    attack: 0.006
  }
]);

/**
 * Plays best-effort local feedback only after capture has stopped. A start cue
 * through Expo Audio would reactivate the shared iOS audio session and can
 * stall the concurrent AVAudioEngine capture tap without an interruption.
 */
export function playMobileVoiceInputEndCue(): void {
  let player: AudioPlayer | undefined;
  let subscription: { remove(): void } | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    if (timeout !== undefined) clearTimeout(timeout);
    subscription?.remove();
    try { player?.release(); }
    catch { /* The feedback player may already have been released natively. */ }
  };
  try {
    player = createAudioPlayer(END_CUE, { updateInterval: 50 });
    subscription = player.addListener("playbackStatusUpdate", (status) => {
      if (status.didJustFinish) release();
    });
    timeout = setTimeout(release, PLAYER_RELEASE_TIMEOUT_MS);
    player.play();
  } catch {
    release();
  }
}

function buildCueDataUri(cues: readonly MobileVoiceCue[]): string {
  const duration = cues.reduce(
    (maximum, cue) => Math.max(maximum, (cue.delay ?? 0) + cue.duration),
    0
  ) + SILENCE_TAIL_SECONDS;
  const samples = new Int16Array(Math.max(1, Math.ceil(duration * SAMPLE_RATE)));
  for (const cue of cues) mixCue(samples, cue);
  return `data:audio/wav;base64,${encodeBase64(buildWav(samples))}`;
}

function mixCue(samples: Int16Array, cue: MobileVoiceCue): void {
  const startSample = Math.max(0, Math.floor((cue.delay ?? 0) * SAMPLE_RATE));
  const durationSamples = Math.max(1, Math.floor(cue.duration * SAMPLE_RATE));
  const rampSamples = Math.max(1, Math.floor(cue.rampAt * SAMPLE_RATE));
  const attackSamples = Math.max(1, Math.floor((cue.attack ?? 0.01) * SAMPLE_RATE));
  let phase = 0;
  for (let index = 0; index < durationSamples && startSample + index < samples.length; index += 1) {
    const frequencyProgress = Math.min(1, index / rampSamples);
    const frequency = cue.fromFrequency * ((cue.toFrequency / cue.fromFrequency) ** frequencyProgress);
    const attack = Math.min(1, (index + 1) / attackSamples);
    const release = Math.max(0, 1 - index / durationSamples);
    const envelope = Math.min(attack, release) * cue.volume;
    phase += (2 * Math.PI * frequency) / SAMPLE_RATE;
    const mixed = samples[startSample + index]! + Math.round(Math.sin(phase) * envelope * 32_767);
    samples[startSample + index] = Math.max(-32_768, Math.min(32_767, mixed));
  }
}

function buildWav(samples: Int16Array): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (const sample of samples) {
    view.setInt16(offset, sample, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  if (typeof btoa === "function") return btoa(binary);
  return encodeBase64Binary(binary);
}

function encodeBase64Binary(binary: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < binary.length; index += 3) {
    const byte1 = binary.charCodeAt(index);
    const byte2 = index + 1 < binary.length ? binary.charCodeAt(index + 1) : Number.NaN;
    const byte3 = index + 2 < binary.length ? binary.charCodeAt(index + 2) : Number.NaN;
    const triplet = (byte1 << 16)
      | ((Number.isNaN(byte2) ? 0 : byte2) << 8)
      | (Number.isNaN(byte3) ? 0 : byte3);
    output += alphabet[(triplet >> 18) & 0x3f];
    output += alphabet[(triplet >> 12) & 0x3f];
    output += Number.isNaN(byte2) ? "=" : alphabet[(triplet >> 6) & 0x3f];
    output += Number.isNaN(byte3) ? "=" : alphabet[triplet & 0x3f];
  }
  return output;
}
