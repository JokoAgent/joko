import { describe, expect, it } from "vitest";

import {
  desktopSupportsSystemAudio,
  parseDesktopRemoteDesktopVideoSettings
} from "../src/remote-desktop-media-settings.js";

describe("Desktop Remote Desktop media settings", () => {
  it("accepts only the fixed frame-rate and bitrate choices", () => {
    expect(parseDesktopRemoteDesktopVideoSettings({
      fps: 30,
      bitrate: 0,
      audio: false
    })).toEqual({ fps: 30, bitrate: 0, audio: false });
    expect(parseDesktopRemoteDesktopVideoSettings({
      fps: 60,
      bitrate: 20_000_000,
      audio: true
    })).toEqual({ fps: 60, bitrate: 20_000_000, audio: true });
    expect(() => parseDesktopRemoteDesktopVideoSettings({
      fps: 24,
      bitrate: 8_000_000,
      audio: false
    })).toThrowError("video settings are invalid");
    expect(() => parseDesktopRemoteDesktopVideoSettings({
      fps: 60,
      bitrate: 4_000_000,
      audio: false
    })).toThrowError("video settings are invalid");
  });

  it("limits system audio to Windows and macOS 14.2 or newer", () => {
    expect(desktopSupportsSystemAudio("win32")).toBe(true);
    expect(desktopSupportsSystemAudio("darwin", "14.1.9")).toBe(false);
    expect(desktopSupportsSystemAudio("darwin", "14.2.0")).toBe(true);
    expect(desktopSupportsSystemAudio("darwin", "15.0.0")).toBe(true);
    expect(desktopSupportsSystemAudio("darwin", "unknown")).toBe(false);
    expect(desktopSupportsSystemAudio("linux", "99.0")).toBe(false);
  });
});
