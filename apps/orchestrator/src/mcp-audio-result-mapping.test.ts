import { describe, expect, it, vi } from "vitest";

import {
  McpAudioResultMappingError,
  PinnedHttpsAudioResultDownloader,
  isPublicAudioResultAddress,
  parseMcpAudioResultMapping
} from "./mcp-audio-result-mapping.js";

const URL_MAPPING = {
  version: 1,
  tracks: [{
    trackPath: ["tracks", "*"],
    audio: {
      path: ["audioUrl"],
      encoding: "url",
      mimeType: "audio/wav",
      allowedUrlHosts: ["media.example.test"]
    },
    kind: "music"
  }]
} as const;

describe("MCP structured audio result mapping", () => {
  it("accepts only bounded explicit paths, encodings, media types and DNS suffixes", () => {
    expect(parseMcpAudioResultMapping(URL_MAPPING)).toEqual(URL_MAPPING);
    for (const invalid of [
      { ...URL_MAPPING, extra: true },
      { ...URL_MAPPING, version: 2 },
      { ...URL_MAPPING, tracks: [] },
      { ...URL_MAPPING, tracks: [{ ...URL_MAPPING.tracks[0], kind: "generated" }] },
      { ...URL_MAPPING, tracks: [{ ...URL_MAPPING.tracks[0], trackPath: ["__proto__"] }] },
      { ...URL_MAPPING, tracks: [{ ...URL_MAPPING.tracks[0], audio: { ...URL_MAPPING.tracks[0].audio, allowedUrlHosts: ["127.0.0.1"] } }] },
      { ...URL_MAPPING, tracks: [{ ...URL_MAPPING.tracks[0], audio: { path: ["audio"], encoding: "base64", allowedUrlHosts: ["media.example.test"] } }] },
      { ...URL_MAPPING, tracks: [{ ...URL_MAPPING.tracks[0], audio: { path: ["audio"], encoding: "base64" } }] },
      { ...URL_MAPPING, tracks: [{ ...URL_MAPPING.tracks[0], audio: { path: ["audio"], encoding: "base64", mimeType: "image/png" } }] }
    ]) expect(() => parseMcpAudioResultMapping(invalid)).toThrow(McpAudioResultMappingError);
  });

  it("pins public DNS and reauthorizes every declared HTTPS redirect", async () => {
    const resolutions: string[] = [];
    const requests: string[] = [];
    const downloader = new PinnedHttpsAudioResultDownloader({
      resolveAddresses: async (hostname) => {
        resolutions.push(hostname);
        return hostname === "media.example.test" ? ["8.8.8.8"] : ["2001:4860:4860::8888"];
      },
      request: async ({ url, address }) => {
        requests.push(`${url.hostname}@${address}`);
        return url.hostname === "media.example.test"
          ? { status: 302, headers: { location: "https://cdn.example.test/result.wav?signature=one" }, bytes: new Uint8Array() }
          : { status: 200, headers: {}, bytes: Uint8Array.from([1, 2, 3]) };
      }
    });
    const bytes = await downloader.download({
      url: "https://media.example.test/start",
      allowedHosts: ["media.example.test", "cdn.example.test"],
      maximumBytes: 16,
      guard: () => undefined
    });
    expect(bytes).toEqual(Uint8Array.from([1, 2, 3]));
    expect(resolutions).toEqual(["media.example.test", "cdn.example.test"]);
    expect(requests).toEqual([
      "media.example.test@8.8.8.8",
      "cdn.example.test@2001:4860:4860::8888"
    ]);
  });

  it("rejects credentials, non-HTTPS routes, undeclared redirects and private DNS before bytes are accepted", async () => {
    const request = vi.fn(async () => ({
      status: 302,
      headers: { location: "https://undeclared.example.test/result.wav" },
      bytes: new Uint8Array()
    }));
    const downloader = new PinnedHttpsAudioResultDownloader({
      resolveAddresses: async () => ["8.8.8.8"],
      request
    });
    const input = {
      allowedHosts: ["media.example.test"],
      maximumBytes: 16,
      guard: () => undefined
    } as const;
    for (const url of [
      "http://media.example.test/result.wav",
      "https://user:password@media.example.test/result.wav",
      "https://media.example.test:444/result.wav",
      "https://other.example.test/result.wav"
    ]) await expect(downloader.download({ ...input, url })).rejects.toThrow(McpAudioResultMappingError);
    await expect(downloader.download({ ...input, url: "https://media.example.test/result.wav" }))
      .rejects.toThrow(McpAudioResultMappingError);

    const privateRequest = vi.fn();
    const privateDownloader = new PinnedHttpsAudioResultDownloader({
      resolveAddresses: async () => ["10.0.0.4", "1.1.1.1"],
      request: privateRequest
    });
    await expect(privateDownloader.download({ ...input, url: "https://media.example.test/result.wav" }))
      .rejects.toThrow(McpAudioResultMappingError);
    expect(privateRequest).not.toHaveBeenCalled();
  });

  it("classifies public result addresses without admitting local, reserved or mapped-private ranges", () => {
    expect(isPublicAudioResultAddress("8.8.8.8")).toBe(true);
    expect(isPublicAudioResultAddress("2001:4860:4860::8888")).toBe(true);
    for (const address of ["127.0.0.1", "10.0.0.1", "169.254.1.1", "192.168.1.1", "192.0.2.1", "198.51.100.2", "203.0.113.3", "::1", "2001:db8::1", "::ffff:127.0.0.1"]) {
      expect(isPublicAudioResultAddress(address)).toBe(false);
    }
  });
});
