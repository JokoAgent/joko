const VOICED_RMS_THRESHOLD = 0.012;

type ResampleState = {
  sourceSampleRate: number;
  sourceChannels: number;
  targetSampleRate: number;
  sourceFramesConsumed: number;
  outputFramesProduced: number;
};

export function mobilePcmIsVoiced(audio: Uint8Array): boolean {
  if (audio.byteLength < 2 || audio.byteLength % 2 !== 0) return false;
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  let squareSum = 0;
  const samples = audio.byteLength / 2;
  for (let offset = 0; offset < audio.byteLength; offset += 2) {
    const normalized = view.getInt16(offset, true) / 32_768;
    squareSum += normalized * normalized;
  }
  return Math.sqrt(squareSum / samples) >= VOICED_RMS_THRESHOLD;
}

export function decodeBase64Pcm(base64: string): Uint8Array {
  if (typeof base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/u.test(base64) || base64.length % 4 !== 0) {
    throw new Error("Native voice capture returned invalid base64 PCM.");
  }
  const binary = typeof atob === "function" ? atob(base64) : decodeBase64(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytes.byteLength < 2 || bytes.byteLength % 2 !== 0) throw new Error("Native voice capture returned invalid PCM bytes.");
  return bytes;
}

export function createPcm16Converter(targetSampleRate: number) {
  const state: ResampleState = {
    sourceSampleRate: 0,
    sourceChannels: 0,
    targetSampleRate,
    sourceFramesConsumed: 0,
    outputFramesProduced: 0
  };
  return (input: ArrayBuffer, sourceSampleRate: number, sourceChannels: number): Uint8Array =>
    convertPcm16(input, sourceSampleRate, sourceChannels, targetSampleRate, state);
}

export function convertPcm16(
  input: ArrayBuffer,
  sourceSampleRate: number,
  sourceChannels: number,
  targetSampleRate: number,
  state?: ResampleState
): Uint8Array {
  if (!Number.isFinite(sourceSampleRate) || sourceSampleRate < 8_000 || sourceSampleRate > 192_000
    || !Number.isInteger(sourceChannels) || sourceChannels < 1 || sourceChannels > 32
    || !Number.isFinite(targetSampleRate) || targetSampleRate < 8_000 || targetSampleRate > 96_000) {
    throw new RangeError("Realtime PCM format is invalid.");
  }
  const current = state ?? {
    sourceSampleRate,
    sourceChannels,
    targetSampleRate,
    sourceFramesConsumed: 0,
    outputFramesProduced: 0
  };
  if (current.sourceSampleRate !== sourceSampleRate || current.sourceChannels !== sourceChannels
    || current.targetSampleRate !== targetSampleRate) {
    current.sourceSampleRate = sourceSampleRate;
    current.sourceChannels = sourceChannels;
    current.targetSampleRate = targetSampleRate;
    current.sourceFramesConsumed = 0;
    current.outputFramesProduced = 0;
  }
  const bytesPerFrame = sourceChannels * 2;
  const sourceFrames = Math.floor(input.byteLength / bytesPerFrame);
  if (sourceFrames === 0) return new Uint8Array();
  const sourceStart = current.sourceFramesConsumed;
  const sourceEnd = sourceStart + sourceFrames;
  const outputEnd = Math.ceil(sourceEnd * targetSampleRate / sourceSampleRate);
  const outputFrames = outputEnd - current.outputFramesProduced;
  if (sourceChannels === 1 && sourceSampleRate === targetSampleRate) {
    current.sourceFramesConsumed = sourceEnd;
    current.outputFramesProduced = outputEnd;
    return new Uint8Array(input.slice(0, sourceFrames * bytesPerFrame));
  }
  const source = new DataView(input);
  const output = new Uint8Array(outputFrames * 2);
  const target = new DataView(output.buffer);
  for (let outputIndex = 0; outputIndex < outputFrames; outputIndex += 1) {
    const globalOutputIndex = current.outputFramesProduced + outputIndex;
    const sourceIndex = Math.floor(globalOutputIndex * sourceSampleRate / targetSampleRate) - sourceStart;
    if (sourceIndex < 0 || sourceIndex >= sourceFrames) throw new RangeError("Realtime PCM resampling phase is invalid.");
    let mono = 0;
    for (let channel = 0; channel < sourceChannels; channel += 1) {
      mono += source.getInt16((sourceIndex * sourceChannels + channel) * 2, true);
    }
    target.setInt16(outputIndex * 2, Math.max(-32_768, Math.min(32_767, Math.round(mono / sourceChannels))), true);
  }
  current.sourceFramesConsumed = sourceEnd;
  current.outputFramesProduced = outputEnd;
  return output;
}

function decodeBase64(base64: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = base64.replace(/=+$/u, "");
  let buffer = 0;
  let bits = 0;
  let output = "";
  for (const character of clean) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error("Native voice capture returned invalid base64 PCM.");
    buffer = buffer << 6 | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode(buffer >> bits & 0xff);
    }
  }
  return output;
}
