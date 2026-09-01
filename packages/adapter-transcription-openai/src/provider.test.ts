import { describe, expect, it, vi } from "vitest";
import type { AsrEvent } from "@joko/voice-input";
import {
  OpenAiTranscriptionError,
  OpenAiTranscriptionProvider,
  openAiTranscriptionLanguage,
  validateOpenAiTranscriptionRoute
} from "./provider.js";

describe("OpenAiTranscriptionProvider", () => {
  it("uploads bounded captured audio and emits one stable transcript", async () => {
    let requestUrl = "";
    let request: RequestInit | undefined;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(url);
      request = init;
      return new Response(JSON.stringify({ text: "  hello from voice  " }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const provider = new OpenAiTranscriptionProvider({
      endpoint: "https://speech.example/v1/audio/transcriptions",
      model: "whisper-1",
      apiKey: "private-key",
      mimeType: "audio/webm",
      locale: "en-US",
      fetch: fetch as typeof globalThis.fetch
    });
    const events: AsrEvent[] = [];
    provider.onEvent((event) => events.push(event));

    await provider.start({ runId: "voice-1", mimeType: "audio/webm", locale: "en-US" });
    provider.appendAudio({ data: Uint8Array.of(1, 2, 3).buffer, durationMs: 250, voiced: true });
    await provider.flushAudio();
    await provider.stop();

    expect(requestUrl).toBe("https://speech.example/v1/audio/transcriptions");
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer private-key");
    const form = request?.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("language")).toBe("en");
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect((form.get("file") as Blob).type).toBe("audio/webm");
    expect(events).toEqual([
      { type: "connected" },
      { type: "stable", text: "hello from voice" },
      { type: "disconnected", recoverable: false }
    ]);
    expect(JSON.stringify(events)).not.toContain("private-key");
  });

  it("maps upstream failures without exposing response or credential text", async () => {
    const provider = new OpenAiTranscriptionProvider({
      endpoint: "https://speech.example/v1/audio/transcriptions",
      model: "whisper-1",
      apiKey: "never-expose-this",
      mimeType: "audio/ogg",
      fetch: async () => new Response(JSON.stringify({ error: { message: "sensitive upstream detail" } }), { status: 401 })
    });
    const events: AsrEvent[] = [];
    provider.onEvent((event) => events.push(event));
    await provider.start({ runId: "voice-2", mimeType: "audio/ogg" });
    provider.appendAudio({ data: Uint8Array.of(1).buffer, durationMs: 1, voiced: true });

    await expect(provider.flushAudio()).rejects.toEqual(new OpenAiTranscriptionError("authentication"));
    expect(events.at(-1)).toEqual({ type: "error", category: "authentication", recoverable: false });
    expect(JSON.stringify(events)).not.toMatch(/never-expose|sensitive upstream/iu);
  });

  it("wraps streamed PCM16 in a mono WAV for batch fallback", async () => {
    let uploaded: Blob | undefined;
    const provider = new OpenAiTranscriptionProvider({
      endpoint: "https://speech.example/v1/audio/transcriptions",
      model: "whisper-1",
      apiKey: "private-key",
      mimeType: "audio/pcm",
      inputPcmSampleRate: 16_000,
      fetch: async (_url, init) => {
        uploaded = (init?.body as FormData).get("file") as Blob;
        return new Response(JSON.stringify({ text: "pcm result" }), { status: 200 });
      }
    });
    await provider.start({ runId: "voice-pcm", mimeType: "audio/pcm" });
    provider.appendAudio({ data: new Uint8Array([1, 0, 2, 0]).buffer, durationMs: 1, voiced: true });
    await provider.flushAudio();

    const bytes = new Uint8Array(await uploaded!.arrayBuffer());
    expect(uploaded?.type).toBe("audio/wav");
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(new DataView(bytes.buffer).getUint32(40, true)).toBe(4);
    expect([...bytes.slice(44)]).toEqual([1, 0, 2, 0]);
  });

  it("accepts HTTPS and loopback HTTP while rejecting unsafe routes", () => {
    expect(validateOpenAiTranscriptionRoute({ endpoint: "https://speech.example/transcribe", model: "model-a" }).endpoint)
      .toBe("https://speech.example/transcribe");
    expect(validateOpenAiTranscriptionRoute({ endpoint: "http://127.0.0.1:9000/transcribe", model: "model-a" }).endpoint)
      .toBe("http://127.0.0.1:9000/transcribe");
    expect(() => validateOpenAiTranscriptionRoute({ endpoint: "http://speech.example/transcribe", model: "model-a" }))
      .toThrow("unsafe");
    expect(() => validateOpenAiTranscriptionRoute({ endpoint: "https://speech.example/transcribe?key=value", model: "model-a" }))
      .toThrow("unsafe");
  });

  it("maps UI locales to provider language codes", () => {
    expect(openAiTranscriptionLanguage("zh-TW")).toBe("zh");
    expect(openAiTranscriptionLanguage("en-US")).toBe("en");
    expect(openAiTranscriptionLanguage("ja")).toBe("ja");
    expect(openAiTranscriptionLanguage("auto")).toBeUndefined();
  });
});
