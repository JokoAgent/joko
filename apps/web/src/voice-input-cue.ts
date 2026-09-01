export type VoiceInputCueKind = "start" | "stop";

interface VoiceCueAudioContext {
  readonly currentTime: number;
  createOscillator(): OscillatorNode;
  createGain(): GainNode;
  close(): Promise<void>;
  readonly destination: AudioDestinationNode;
}

/** A short synthesized cue avoids shipping or loading a network audio asset. */
export function playVoiceInputCue(
  kind: VoiceInputCueKind,
  createContext: () => VoiceCueAudioContext = () => new AudioContext()
): void {
  let context: VoiceCueAudioContext;
  try { context = createContext(); }
  catch { return; }
  try {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const startAt = context.currentTime;
    const duration = 0.075;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(kind === "start" ? 720 : 520, startAt);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.08, startAt + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.addEventListener("ended", () => { void context.close().catch(() => undefined); }, { once: true });
    oscillator.start(startAt);
    oscillator.stop(startAt + duration);
  } catch {
    void context.close().catch(() => undefined);
  }
}
