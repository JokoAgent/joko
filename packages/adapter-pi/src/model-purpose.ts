import type { PiManagedModel } from "./config.js";

// Exact catalog identities and aliases. This metadata never grants membership,
// credentials, endpoint support, or permission to use a model.
const SPEECH_MODELS = new Set([
  ["openai/gpt-4o-mini-tts", "gpt-4o-mini-tts"],
  ["openai/tts-1", "tts-1"],
  ["openai/tts-1-hd", "tts-1-hd"],
  ["openai/gpt-4o-mini-tts-2025-03-20", "gpt-4o-mini-tts-2025-03-20"],
  ["openai/gpt-4o-mini-tts-2025-12-15", "gpt-4o-mini-tts-2025-12-15"],
  ["elevenlabs/eleven_v4", "eleven_v4"],
  ["elevenlabs/eleven_v4_turbo", "eleven_v4_turbo"],
  ["elevenlabs/eleven_v3", "eleven_v3"],
  ["elevenlabs/eleven_v3_conversational", "eleven_v3_conversational"],
  ["elevenlabs/eleven_multilingual_v2", "eleven_multilingual_v2"],
  ["elevenlabs/eleven_flash_v2_5", "eleven_flash_v2_5"],
  ["elevenlabs/eleven_flash_v2", "eleven_flash_v2"],
  ["elevenlabs/eleven_turbo_v2_5", "eleven_turbo_v2_5"],
  ["elevenlabs/eleven_turbo_v2", "eleven_turbo_v2"],
  ["minimax/speech-2.8-hd", "speech-2.8-hd"],
  ["minimax/speech-2.8-turbo", "speech-2.8-turbo"],
  ["minimax/speech-2.6-hd", "speech-2.6-hd"],
  ["minimax/speech-2.6-turbo", "speech-2.6-turbo"],
  ["minimax/speech-02-hd", "speech-02-hd"],
  ["minimax/speech-02-turbo", "speech-02-turbo"],
  ["minimax/speech-01-hd", "speech-01-hd"],
  ["minimax/speech-01-turbo", "speech-01-turbo"],
  ["qwen/qwen3-tts-flash", "qwen3-tts-flash"],
  ["qwen/qwen3-tts-flash-realtime", "qwen3-tts-flash-realtime"],
  ["qwen/qwen-audio-3.0-tts-plus", "qwen-audio-3.0-tts-plus"],
  ["qwen/qwen-audio-3.0-tts-flash", "qwen-audio-3.0-tts-flash"],
  ["alibaba/cosyvoice-v3.5-plus", "cosyvoice-v3.5-plus"],
  ["alibaba/cosyvoice-v3.5-flash", "cosyvoice-v3.5-flash"],
  ["alibaba/cosyvoice-v3-plus", "cosyvoice-v3-plus"],
  ["alibaba/cosyvoice-v3-flash", "cosyvoice-v3-flash"],
  ["alibaba/cosyvoice-v2", "cosyvoice-v2"]
].flat());

export function managedModelMode(model: PiManagedModel): string | undefined {
  return model.mode ?? model.discoveredMetadata?.mode ?? (SPEECH_MODELS.has(model.id) ? "audio_speech" : undefined);
}

export function isManagedChatModel(model: PiManagedModel): boolean {
  const mode = managedModelMode(model);
  return mode === undefined || mode === "chat";
}

export function isManagedSpeechModel(model: PiManagedModel): boolean {
  if (managedModelMode(model) !== "audio_speech") return false;
  const input = model.declaredInputModalities ?? model.discoveredMetadata?.inputModalities ?? model.input;
  const output = model.declaredOutputModalities ?? model.discoveredMetadata?.outputModalities;
  return (input === undefined || input.includes("text")) && (output === undefined || output.includes("audio"));
}
