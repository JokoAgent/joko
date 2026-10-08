import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const project = new URL("../", import.meta.url);
const swift = readFileSync(new URL(
  "modules/joko-remote-presentation/ios/JokoRemotePresentationModule.swift",
  project
), "utf8");
const binding = readFileSync(new URL(
  "modules/joko-remote-presentation/src/index.ts",
  project
), "utf8");
const plugin = readFileSync(new URL("with-joko-remote-desktop-presentation.cjs", project), "utf8");
const app = JSON.parse(readFileSync(new URL("app.json", project), "utf8")).expo;

describe("native Remote Desktop presentation boundary", () => {
  it("owns and conditionally restores only its exact playback audio session", () => {
    expect(binding).toContain("playback?(enabled: boolean)");
    expect(swift).toContain("import AVFoundation");
    expect(swift).toContain('AsyncFunction("playback")');
    expect(swift).toContain("self.previousAudio == nil");
    expect(swift).toContain(".playback, mode: .moviePlayback, options: [.mixWithOthers]");
    expect(swift).toContain("session.category == .playback && session.mode == .moviePlayback");
    expect(swift).toContain("session.categoryOptions == [.mixWithOthers]");
    expect(swift).toContain(".notifyOthersOnDeactivation");
  });

  it("adds only the PiP audio background mode and keeps Expo audio foreground-only", () => {
    expect(plugin).toContain('"audio"');
    expect(app.plugins).toContain("./with-joko-remote-desktop-presentation.cjs");
    const expoAudio = app.plugins.find((entry) => Array.isArray(entry) && entry[0] === "expo-audio");
    expect(expoAudio?.[1]).toMatchObject({
      enableBackgroundPlayback: false,
      enableBackgroundRecording: false
    });
    expect(app.plugins.indexOf("./with-joko-remote-desktop-presentation.cjs"))
      .toBeGreaterThan(app.plugins.indexOf(expoAudio));
  });
});
