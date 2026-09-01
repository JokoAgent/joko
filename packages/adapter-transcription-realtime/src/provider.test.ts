import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import type { AsrEvent } from "@joko/voice-input";
import {
  RealtimeTranscriptionProvider,
  buildSessionUpdateMessage,
  probeRealtimeTranscriptionRoute,
  resamplePcm16,
  validateRealtimeTranscriptionRoute
} from "./provider.js";

const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    for (const client of server.clients) client.terminate();
    server.close(() => resolve());
  })));
});

describe("RealtimeTranscriptionProvider", () => {
  it("runs the OpenAI-compatible handshake, streams PCM, and publishes partial and stable text", async () => {
    const server = await testServer();
    const inbound: Array<Record<string, unknown>> = [];
    let authorization = "";
    server.on("connection", (socket, request) => {
      authorization = request.headers.authorization ?? "";
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        inbound.push(message);
        if (message["type"] === "session.update") socket.send(JSON.stringify({ type: "session.updated" }));
        if (message["type"] === "input_audio_buffer.append") {
          socket.send(JSON.stringify({
            type: "conversation.item.input_audio_transcription.delta",
            item_id: "item-1",
            delta: "hello"
          }));
        }
        if (message["type"] === "input_audio_buffer.commit") {
          socket.send(JSON.stringify({
            type: "conversation.item.input_audio_transcription.completed",
            item_id: "item-1",
            transcript: "hello world"
          }));
        }
      });
    });
    const events: AsrEvent[] = [];
    const provider = new RealtimeTranscriptionProvider({
      protocol: "openaiRealtime",
      endpoint: endpoint(server),
      model: "realtime-model",
      apiKey: "secret-key",
      locale: "en-US",
      connectTimeoutMs: 2_000,
      flushTimeoutMs: 2_000
    });
    provider.onEvent((event) => events.push(event));

    await provider.start({ runId: "run-1", mimeType: "audio/pcm", locale: "en-US" });
    provider.appendAudio({ data: pcmArrayBuffer(1_600), durationMs: 100, voiced: true });
    await provider.flushAudio();
    await provider.stop();

    expect(authorization).toBe("Bearer secret-key");
    expect(inbound[0]).toEqual(buildSessionUpdateMessage("realtime-model", "en", 24_000, "openaiRealtime"));
    expect(inbound.map((message) => message["type"])).toContain("input_audio_buffer.append");
    expect(inbound.map((message) => message["type"])).toContain("input_audio_buffer.commit");
    expect(events).toContainEqual({ type: "partial", text: "hello" });
    expect(events).toContainEqual({ type: "stable", text: "hello world" });
  });

  it("uses the Qwen-compatible model query, full-hypothesis text, and server-VAD finish", async () => {
    const server = await testServer();
    let requestUrl = "";
    const inbound: Array<Record<string, unknown>> = [];
    server.on("connection", (socket, request) => {
      requestUrl = request.url ?? "";
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        inbound.push(message);
        if (message["type"] === "session.update") socket.send(JSON.stringify({ type: "session.updated" }));
        if (message["type"] === "input_audio_buffer.append") {
          socket.send(JSON.stringify({
            type: "conversation.item.input_audio_transcription.text",
            item_id: "item-1",
            text: "你好",
            stash: "呀"
          }));
        }
        if (message["type"] === "session.finish") socket.send(JSON.stringify({ type: "session.finished" }));
      });
    });
    const events: AsrEvent[] = [];
    const provider = new RealtimeTranscriptionProvider({
      protocol: "qwenRealtime",
      endpoint: `${endpoint(server)}?model=stale`,
      model: "fresh-model",
      apiKey: "secret-key",
      connectTimeoutMs: 2_000,
      flushTimeoutMs: 2_000
    });
    provider.onEvent((event) => events.push(event));

    await provider.start({ runId: "run-1", mimeType: "audio/pcm" });
    provider.appendAudio({ data: pcmArrayBuffer(1_600), durationMs: 100, voiced: true });
    await provider.flushAudio();
    await provider.stop();

    expect(requestUrl).toContain("model=fresh-model");
    expect(inbound.map((message) => message["type"])).not.toContain("input_audio_buffer.commit");
    expect(inbound.map((message) => message["type"])).toContain("session.finish");
    expect(events).toContainEqual({ type: "partial", text: "你好呀" });
  });

  it("classifies a rejected handshake without exposing response text", async () => {
    const server = new WebSocketServer({ port: 0, verifyClient: (_info, done) => done(false, 401, "secret body") });
    servers.push(server);
    await listening(server);
    await expect(probeRealtimeTranscriptionRoute({
      protocol: "openaiRealtime",
      endpoint: endpoint(server),
      model: "model",
      apiKey: "bad-key",
      connectTimeoutMs: 2_000
    })).resolves.toEqual({ ok: false, reason: "authenticationFailed" });
  });

  it("rejects unsafe routes and deterministically resamples PCM16", () => {
    expect(() => validateRealtimeTranscriptionRoute({
      protocol: "openaiRealtime",
      endpoint: "ws://example.com/realtime",
      model: "model"
    })).toThrowError(TypeError);
    expect(() => validateRealtimeTranscriptionRoute({
      protocol: "qwenRealtime",
      endpoint: "wss://example.com/realtime?api_key=secret",
      model: "model"
    })).toThrowError(TypeError);
    expect(resamplePcm16(pcm(160), 16_000, 24_000).byteLength).toBe(480);
  });
});

async function testServer(): Promise<WebSocketServer> {
  const server = new WebSocketServer({ port: 0 });
  servers.push(server);
  await listening(server);
  return server;
}

function listening(server: WebSocketServer): Promise<void> {
  if (server.address() !== null) return Promise.resolve();
  return new Promise((resolve) => server.once("listening", resolve));
}

function endpoint(server: WebSocketServer): string {
  const address = server.address() as AddressInfo;
  return `ws://127.0.0.1:${address.port}/v1/realtime`;
}

function pcm(sampleCount: number): Buffer {
  const output = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) output.writeInt16LE(index % 32_767, index * 2);
  return output;
}

function pcmArrayBuffer(sampleCount: number): ArrayBuffer {
  const value = pcm(sampleCount);
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}
