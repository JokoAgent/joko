import { describe, expect, it, vi } from "vitest";

import {
  desktopUpdateManifestUrl,
  fetchDesktopUpdateManifestVersion
} from "../src/update-manifest.js";

describe("desktop startup update manifest", () => {
  it("uses the electron-builder generic-provider manifest names per target", () => {
    expect(desktopUpdateManifestUrl("https://updates.example.com/joko", "win32", "x64"))
      .toBe("https://updates.example.com/joko/latest.yml");
    expect(desktopUpdateManifestUrl("https://updates.example.com/joko/", "darwin", "arm64"))
      .toBe("https://updates.example.com/joko/latest-mac.yml");
    expect(desktopUpdateManifestUrl("https://updates.example.com/joko", "linux", "x64"))
      .toBe("https://updates.example.com/joko/latest-linux.yml");
    expect(desktopUpdateManifestUrl("https://updates.example.com/joko", "linux", "arm64"))
      .toBe("https://updates.example.com/joko/latest-linux-arm64.yml");
  });

  it("fetches a bounded strict-SemVer manifest without credentials or redirects", async () => {
    const fetch = vi.fn(async () => new Response("version: 2.3.4-beta.1\nfiles: []\n", {
      status: 200,
      headers: { "content-type": "application/yaml" }
    }));
    await expect(fetchDesktopUpdateManifestVersion({
      feedUrl: "https://updates.example.com/joko",
      platform: "win32",
      architecture: "x64",
      fetch
    })).resolves.toBe("2.3.4-beta.1");
    expect(fetch).toHaveBeenCalledWith("https://updates.example.com/joko/latest.yml", expect.objectContaining({
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: expect.any(AbortSignal)
    }));
  });

  it.each([
    ["http://updates.example.com/joko", "version: 2.0.0\n"],
    ["https://user:secret@updates.example.com/joko", "version: 2.0.0\n"],
    ["https://updates.example.com/joko?token=secret", "version: 2.0.0\n"],
    ["https://updates.example.com/joko", "version: latest\n"],
    ["https://updates.example.com/joko", "version: 01.0.0\n"],
    ["https://updates.example.com/joko", "version: ' 2.0.0'\n"]
  ])("fails unsafe feeds or invalid versions closed: %s", async (feedUrl, body) => {
    await expect(fetchDesktopUpdateManifestVersion({
      feedUrl,
      platform: "win32",
      architecture: "x64",
      fetch: async () => new Response(body, { status: 200 })
    })).resolves.toBeNull();
  });

  it("rejects non-success and oversized manifests without parsing them", async () => {
    await expect(fetchDesktopUpdateManifestVersion({
      feedUrl: "https://updates.example.com/joko",
      platform: "win32",
      architecture: "x64",
      fetch: async () => new Response("not found", { status: 404 })
    })).resolves.toBeNull();
    await expect(fetchDesktopUpdateManifestVersion({
      feedUrl: "https://updates.example.com/joko",
      platform: "win32",
      architecture: "x64",
      fetch: async () => new Response("version: 2.0.0\n", {
        status: 200,
        headers: { "content-length": String(256 * 1024 + 1) }
      })
    })).resolves.toBeNull();
  });

  it("accepts a manifest at 7.9s but aborts at the 8s startup boundary", async () => {
    vi.useFakeTimers();
    try {
      const beforeBoundary = fetchDesktopUpdateManifestVersion({
        feedUrl: "https://updates.example.com/joko",
        platform: "win32",
        architecture: "x64",
        fetch: async () => new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response("version: 2.0.0\n", { status: 200 })), 7_900);
        })
      });
      await vi.advanceTimersByTimeAsync(7_900);
      await expect(beforeBoundary).resolves.toBe("2.0.0");

      const atBoundary = fetchDesktopUpdateManifestVersion({
        feedUrl: "https://updates.example.com/joko",
        platform: "win32",
        architecture: "x64",
        fetch: async (_url, init) => new Promise<Response>((resolve, reject) => {
          const responseTimer = setTimeout(() => resolve(new Response("version: 3.0.0\n", { status: 200 })), 8_000);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(responseTimer);
            reject(new Error("aborted"));
          }, { once: true });
        })
      });
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(atBoundary).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
