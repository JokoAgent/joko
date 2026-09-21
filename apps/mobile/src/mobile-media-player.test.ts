import { describe, expect, it } from "vitest";
import {
  buildMobileMediaPlayerCommand,
  buildMobileMediaPlayerHtml,
  parseMobileMediaPlayerStatus
} from "./mobile-media-player";

describe("mobile media player protocol and HTML", () => {
  it("builds an offline file-only player with escaped title and exact local source", () => {
    const html = buildMobileMediaPlayerHtml({
      instanceId: "lease-1",
      kind: "video",
      locale: "en",
      mediaType: "video/mp4",
      title: "Demo <clip>",
      uri: "file:///cache/demo&one.mp4",
      background: "#f7f6f3",
      surface: "#ffffff",
      ink: "#15191d"
    });
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("media-src file:");
    expect(html).toContain("Demo &lt;clip&gt;");
    expect(html).toContain("file:///cache/demo&amp;one.mp4");
    expect(html).toContain("<video controls playsinline preload=\"metadata\"");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
  });

  it("rejects remote URIs and mismatched player kinds", () => {
    const base = {
      instanceId: "lease-1",
      kind: "audio" as const,
      locale: "en" as const,
      mediaType: "audio/mpeg",
      title: "Voice",
      background: "#000000",
      surface: "#111111",
      ink: "#ffffff"
    };
    expect(() => buildMobileMediaPlayerHtml({ ...base, uri: "https://node.example/blob" })).toThrow(/URI/u);
    expect(() => buildMobileMediaPlayerHtml({ ...base, kind: "video", uri: "file:///cache/voice.mp3" }))
      .toThrow(/kind/u);
  });

  it("uses strict instance-bound commands and status messages", () => {
    expect(JSON.parse(buildMobileMediaPlayerCommand("lease-1", "pause"))).toEqual({
      type: "joko-media-player/command",
      instanceId: "lease-1",
      command: "pause"
    });
    expect(JSON.parse(buildMobileMediaPlayerCommand("lease-1", "play"))).toMatchObject({
      type: "joko-media-player/command",
      instanceId: "lease-1",
      command: "play"
    });
    const status = JSON.stringify({
      type: "joko-media-player/status",
      instanceId: "lease-1",
      state: "playing",
      currentTime: 1.25,
      duration: 8,
      error: null
    });
    expect(parseMobileMediaPlayerStatus(status, "lease-1")).toMatchObject({ state: "playing", currentTime: 1.25 });
    expect(parseMobileMediaPlayerStatus(status, "lease-2")).toBeUndefined();
    expect(parseMobileMediaPlayerStatus(JSON.stringify({ ...JSON.parse(status), authority: "forged" }), "lease-1"))
      .toBeUndefined();
    expect(parseMobileMediaPlayerStatus(JSON.stringify({ ...JSON.parse(status), currentTime: -1 }), "lease-1"))
      .toBeUndefined();
    expect(parseMobileMediaPlayerStatus("not json", "lease-1")).toBeUndefined();
  });
});
