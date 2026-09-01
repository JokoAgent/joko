import { describe, expect, it, vi } from "vitest";
import { probeOpenAiTranscriptionRoute } from "./probe.js";

describe("probeOpenAiTranscriptionRoute", () => {
  it("posts only a bounded silent WAV and reports a reachable authenticated route", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-key");
      const form = init?.body as FormData;
      expect(form.get("model")).toBe("whisper-1");
      const file = form.get("file") as Blob;
      expect(file.type).toBe("audio/wav");
      expect(file.size).toBeGreaterThan(44);
      expect(file.size).toBeLessThan(4_000);
      return new Response(JSON.stringify({ text: "" }), { status: 200 });
    });

    await expect(probeOpenAiTranscriptionRoute({
      endpoint: "https://speech.example/v1/audio/transcriptions",
      model: "whisper-1",
      apiKey: "private-key",
      fetch: fetch as typeof globalThis.fetch
    })).resolves.toEqual({ ok: true });
  });

  it("classifies failures without exposing an upstream body", async () => {
    const route = { endpoint: "https://speech.example/v1/audio/transcriptions", model: "whisper-1" } as const;
    await expect(probeOpenAiTranscriptionRoute({ ...route, fetch: async () => new Response("secret", { status: 401 }) }))
      .resolves.toEqual({ ok: false, reason: "authenticationFailed" });
    await expect(probeOpenAiTranscriptionRoute({ ...route, fetch: async () => new Response("secret", { status: 404 }) }))
      .resolves.toEqual({ ok: false, reason: "routeUnavailable" });
    await expect(probeOpenAiTranscriptionRoute({ ...route, fetch: async () => { throw new Error("private network detail"); } }))
      .resolves.toEqual({ ok: false, reason: "network" });
  });
});
