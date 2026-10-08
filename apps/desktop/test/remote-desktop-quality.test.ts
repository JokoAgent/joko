import { describe, expect, it } from "vitest";

import {
  REMOTE_DESKTOP_MOTION,
  desktopRemoteDesktopFrameChange,
  desktopRemoteDesktopVideoFramerate,
  desktopRemoteDesktopVideoProfile,
  withDesktopRemoteDesktopBitrateHints
} from "../src/remote-desktop-quality.js";

const OFFER = [
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "m=video 9 UDP/TLS/RTP/SAVPF 96 97 100 101",
  "a=rtpmap:96 H264/90000",
  "a=fmtp:96 packetization-mode=1;x-google-min-bitrate=30",
  "a=rtpmap:97 rtx/90000",
  "a=fmtp:97 apt=96",
  "a=rtpmap:100 VP8/90000",
  "a=rtpmap:101 rtx/90000",
  "a=fmtp:101 apt=100",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  ""
].join("\r\n");

describe("Desktop Remote Desktop quality tiers", () => {
  it("keeps concrete capture and encoding choices host-owned", () => {
    expect(desktopRemoteDesktopVideoProfile().degradation).toBe("maintain-framerate");
    expect(desktopRemoteDesktopVideoProfile({ fps: 60, quality: "hd", audio: false }))
      .toMatchObject({ degradation: "maintain-resolution", sharpWhenStill: false });
    expect(desktopRemoteDesktopVideoFramerate({ fps: 60, quality: "saver", audio: false }))
      .toBe(30);
    expect(desktopRemoteDesktopVideoFramerate({ fps: 60, quality: "auto", audio: false }))
      .toBe(60);
    for (const quality of ["auto", "saver", "hd"] as const) {
      const profile = desktopRemoteDesktopVideoProfile({ fps: 30, quality, audio: false });
      expect(profile.minBitrateKbps).toBeLessThanOrEqual(profile.startBitrateKbps);
      expect(profile.startBitrateKbps * 1_000).toBeLessThanOrEqual(profile.maxBitrate);
    }
  });

  it("adds bandwidth hints to each video media codec only", () => {
    const profile = desktopRemoteDesktopVideoProfile({ fps: 30, quality: "saver", audio: false });
    const lines = withDesktopRemoteDesktopBitrateHints(OFFER, profile).split("\r\n");
    const hints = "x-google-start-bitrate=1500;x-google-min-bitrate=500;x-google-max-bitrate=2000";
    expect(lines).toContain(`a=fmtp:96 packetization-mode=1;${hints}`);
    expect(lines).toContain(`a=fmtp:100 ${hints}`);
    expect(lines).toContain("a=fmtp:97 apt=96");
    expect(lines).toContain("a=fmtp:101 apt=100");
    expect(lines).toContain("a=fmtp:111 minptime=10;useinbandfec=1");
    expect(lines.indexOf(`a=fmtp:100 ${hints}`))
      .toBeLessThan(lines.indexOf("m=application 9 UDP/DTLS/SCTP webrtc-datachannel"));
    expect(lines.at(-1)).toBe("");
  });

  it("rewrites an fmtp line that precedes its rtpmap without duplicating it", () => {
    const reordered = [
      "m=video 9 UDP/TLS/RTP/SAVPF 100",
      "a=fmtp:100 x-google-min-bitrate=30",
      "a=rtpmap:100 VP8/90000",
      ""
    ].join("\n");
    const lines = withDesktopRemoteDesktopBitrateHints(
      reordered,
      desktopRemoteDesktopVideoProfile()
    ).split("\n");
    expect(lines.filter((line) => line.startsWith("a=fmtp:100"))).toEqual([
      "a=fmtp:100 x-google-start-bitrate=4000;x-google-min-bitrate=1000;x-google-max-bitrate=20000"
    ]);
    expect(lines.at(-1)).toBe("");
  });

  it("separates large screen changes from localized activity", () => {
    const frame = (fill: number): Uint8ClampedArray => new Uint8ClampedArray(64 * 36 * 4).fill(fill);
    const still = frame(100);
    expect(desktopRemoteDesktopFrameChange(still, frame(100))).toBe(0);
    const caret = frame(100);
    caret.set([255, 255, 255, 255], 4 * 500);
    expect(desktopRemoteDesktopFrameChange(still, caret)).toBeLessThan(REMOTE_DESKTOP_MOTION.changedShare);
    const scrolled = frame(100);
    scrolled.fill(140, 0, scrolled.length / 4);
    expect(desktopRemoteDesktopFrameChange(still, scrolled)).toBeGreaterThan(REMOTE_DESKTOP_MOTION.changedShare);
    expect(desktopRemoteDesktopFrameChange(still, new Uint8ClampedArray(4))).toBe(1);
  });
});
