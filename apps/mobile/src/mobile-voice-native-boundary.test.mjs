import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const project = new URL("../", import.meta.url);
const swift = readFileSync(new URL("modules/joko-mobile-realtime-audio/ios/JokoMobileRealtimeAudioModule.swift", project), "utf8");
const moduleConfig = JSON.parse(readFileSync(new URL("modules/joko-mobile-realtime-audio/expo-module.config.json", project), "utf8"));
const runtime = readFileSync(new URL("src/mobile-realtime-audio.ts", project), "utf8");
const cue = readFileSync(new URL("src/mobile-voice-cue.ts", project), "utf8");
const hook = readFileSync(new URL("src/use-mobile-voice-input.ts", project), "utf8");

describe("mobile native voice boundary", () => {
  it("autolinks the Joko-owned Apple module under one exact native name", () => {
    expect(moduleConfig).toEqual({
      platforms: ["apple"],
      apple: {
        podspecPath: "./ios/JokoMobileRealtimeAudio.podspec",
        modules: ["JokoMobileRealtimeAudioModule"]
      }
    });
    expect(swift).toContain('Name("JokoMobileRealtimeAudio")');
    expect(runtime).toContain('requireNativeModule<NativeRealtimeAudioModule>("JokoMobileRealtimeAudio")');
  });

  it("captures foreground-only 16 kHz mono PCM and tears down every system interruption", () => {
    expect(swift).toContain("private var targetSampleRate = 16_000.0");
    expect(swift).toContain("mono /= Float(channelCount)");
    expect(swift).toContain("var sample = Int16(clamped * Float(Int16.max)).littleEndian");
    expect(swift).toContain("OnAppEntersBackground");
    expect(swift).toContain("OnDestroy");
    expect(swift.match(/stopCapture\(deactivateImmediately: true\)/gu)?.length).toBeGreaterThanOrEqual(4);
    expect(swift).toContain("AVAudioSession.interruptionNotification");
    expect(swift).toContain("AVAudioSession.routeChangeNotification");
    expect(swift).toContain("AVAudioSession.RouteChangeReason.oldDeviceUnavailable");
  });

  it("uses Expo AudioStream only as a released, watched foreground PCM fallback", () => {
    expect(runtime).toContain('new module.AudioStream({ sampleRate: TARGET_SAMPLE_RATE, channels: 1, encoding: "int16" })');
    expect(runtime).toContain('stream.addListener("audioStreamBuffer"');
    expect(runtime).toContain('stream.addListener("audioStreamStatus"');
    expect(runtime).toContain("event.sampleRate !== TARGET_SAMPLE_RATE");
    expect(runtime).toContain("event.chunkIndex !== nextChunkIndex");
    expect(runtime).toContain("stream?.release()");
    expect(runtime).toContain("STREAM_STALL_TIMEOUT_MS");
    expect(runtime).toContain("await releaseMobileRealtimeAudio()");
  });

  it("plays only a released post-capture cue so iOS recording is never stalled by playback", () => {
    expect(cue).toContain("playMobileVoiceInputEndCue");
    expect(cue).toContain("data:audio/wav;base64,");
    expect(cue).toContain("player?.release()");
    expect(cue).not.toContain("StartCue");
    expect(hook).toContain("onCaptureStopped: playMobileVoiceInputEndCue");
  });
});
