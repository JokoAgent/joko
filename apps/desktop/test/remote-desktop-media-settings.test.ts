import { describe, expect, it } from "vitest";

import {
  desktopSupportsSystemAudio,
  parseDesktopRemoteDesktopVideoSettings
} from "../src/remote-desktop-media-settings.js";

describe("Desktop Remote Desktop media settings", () => {
  it("accepts only the fixed frame-rate and host-owned quality choices", () => {
    expect(parseDesktopRemoteDesktopVideoSettings({
      fps: 30,
      quality: "auto",
      audio: false
    })).toEqual({ fps: 30, quality: "auto", audio: false });
    expect(parseDesktopRemoteDesktopVideoSettings({
      fps: 60,
      quality: "hd",
      audio: true
    })).toEqual({ fps: 60, quality: "hd", audio: true });
    expect(() => parseDesktopRemoteDesktopVideoSettings({
      fps: 24,
      quality: "saver",
      audio: false
    })).toThrowError("video settings are invalid");
    expect(() => parseDesktopRemoteDesktopVideoSettings({
      fps: 60,
      quality: "ultra",
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
