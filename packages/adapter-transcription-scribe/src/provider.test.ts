import { once } from "node:events";
import { type IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AsrEvent } from "@joko/voice-input";
import { ScribeTranscriptionProvider, probeScribeTranscriptionRoute, validateScribeTranscriptionRoute } from "./provider.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(onConnection: (socket: WebSocket, request: IncomingMessage, index: number) => void) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  let index = 0;
  server.on("connection", (socket, request) => onConnection(socket, request, index++));
  cleanups.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Missing test socket address.");
  return { endpoint: `ws://127.0.0.1:${address.port}/v1/speech-to-text/realtime`, model: "scribe_v2_realtime", connectTimeoutMs: 1_500, flushTimeoutMs: 1_000 };
}

function ready(socket: WebSocket, commitStrategy?: string): void {
  socket.send(JSON.stringify({ message_type: "session_started", config: { model_id: "scribe_v2_realtime", audio_format: "pcm_16000", sample_rate: 16_000,
    ...(commitStrategy === undefined ? {} : { commit_strategy: commitStrategy }) } }));
}
function transcript(socket: WebSocket, type: "partial_transcript" | "committed_transcript" | "committed_transcript_with_timestamps", text: string): void {
  socket.send(JSON.stringify({ message_type: type, text }));
}
function audio(ms: number, voiced = true) {
  return { data: new Uint8Array(ms * 32).fill(voiced ? 1 : 0).buffer, durationMs: ms, voiced };
}
function provider(route: ConstructorParameters<typeof ScribeTranscriptionProvider>[0]) {
  const instance = new ScribeTranscriptionProvider(route);
  cleanups.push(() => instance.stop());
  const events: AsrEvent[] = [];
  instance.onEvent((event) => events.push(event));
  return { instance, events };
}
type Input = { message_type: string; audio_base_64: string; sample_rate: number; commit: boolean };
function record(socket: WebSocket, onCommit?: (index: number) => void): Input[] {
  const messages: Input[] = [];
  let commits = 0;
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as Input;
    messages.push(message);
    if (message.commit) onCommit?.(commits++);
  });
  return messages;
}
function size(messages: readonly Input[]): number {
  return messages.reduce((total, message) => total + Buffer.from(message.audio_base_64, "base64").length, 0);
}
async function roundTrip(socket: WebSocket): Promise<void> {
  const pong = once(socket, "pong");
  socket.ping();
  await pong;
}

describe("Scribe realtime protocol", () => {
  it("waits for the negotiated session, streams mutable tails, and commits short audio once on stop", async () => {
    let socket!: WebSocket;
    let request!: IncomingMessage;
    let sent!: Input[];
    const route = await fixture((connected, handshake) => {
      socket = connected; request = handshake;
      sent = record(socket, () => transcript(socket, "committed_transcript", "hello"));
    });
    const { instance, events } = provider({ ...route, apiKey: "temporary-protocol-key" });
    const started = instance.start({ runId: "run", mimeType: "audio/pcm", locale: "zh-CN" });
    let connected = false;
    void started.then(() => { connected = true; });
    await vi.waitFor(() => expect(socket).toBeDefined());
    expect(connected).toBe(false);
    expect(events).toEqual([]);
    const url = new URL(request.url!, "http://127.0.0.1");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ model_id: "scribe_v2_realtime", audio_format: "pcm_16000", commit_strategy: "manual", language_code: "zh" });
    expect(request.headers["xi-api-key"]).toBe("temporary-protocol-key");
    expect(request.headers["authorization"]).toBeUndefined();
    const captured = audio(100);
    instance.appendAudio(captured);
    new Uint8Array(captured.data).fill(2);
    expect(sent).toEqual([]);
    ready(socket);
    await started;
    transcript(socket, "partial_transcript", "hel");
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "partial", text: "hel" }));
    const flush = instance.flushAudio();
    expect(instance.flushAudio()).toBe(flush);
    await flush;
    expect(events.filter((event) => event.type === "stable")).toEqual([{ type: "stable", text: "hello" }]);
    expect(sent.filter((message) => message.commit)).toHaveLength(1);
    expect(size(sent)).toBe(2_100 * 32);
    expect(Buffer.from(sent[0]!.audio_base_64, "base64")).toEqual(Buffer.alloc(100 * 32, 1));
    expect(sent.every((message) => message.sample_rate === 16_000 && message.message_type === "input_audio_chunk")).toBe(true);
  });

  it("drains each delayed historical commit before sending the next segment and resolving the stop barrier", async () => {
    let socket!: WebSocket;
    let sent!: Input[];
    const route = await fixture((connected) => { socket = connected; sent = record(socket); ready(socket); });
    const { instance, events } = provider(route);
    await instance.start({ runId: "run", mimeType: "audio/pcm" });
    instance.appendAudio(audio(1_000));
    instance.appendAudio(audio(1_500, false));
    instance.appendAudio(audio(1_000));
    instance.appendAudio(audio(1_500, false));
    instance.appendAudio(audio(100));
    let finished = false;
    const flush = instance.flushAudio().then(() => { finished = true; });
    await roundTrip(socket);
    expect(sent.filter((message) => message.commit)).toHaveLength(1);
    expect(size(sent)).toBe(2_500 * 32);
    transcript(socket, "committed_transcript", "first");
    await vi.waitFor(() => expect(sent.filter((message) => message.commit)).toHaveLength(2));
    expect(finished).toBe(false);
    expect(size(sent)).toBe(5_000 * 32);
    transcript(socket, "committed_transcript_with_timestamps", "first");
    transcript(socket, "partial_transcript", "sec");
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "partial", text: "first sec" }));
    expect(finished).toBe(false);
    transcript(socket, "committed_transcript", "second");
    await vi.waitFor(() => expect(sent.filter((message) => message.commit)).toHaveLength(3));
    expect(finished).toBe(false);
    expect(size(sent)).toBe(7_100 * 32);
    transcript(socket, "committed_transcript", "tail");
    await flush;
    expect(events.filter((event) => event.type === "stable")).toEqual([
      { type: "stable", text: "first" }, { type: "stable", text: "first second" }, { type: "stable", text: "first second tail" }
    ]);
  });

  it.each(["spoken", "empty"] as const)("retires confirmed PCM after %s commits and keeps captured tails beyond sixty seconds", async (confirmation) => {
    const sockets: WebSocket[] = [];
    const received: Input[][] = [];
    const route = await fixture((socket, _request, index) => {
      sockets.push(socket);
      received[index] = record(socket, index === 0 ? undefined : () => transcript(socket, "committed_transcript", "tail"));
      ready(socket, "manual");
    });
    const { instance, events } = provider(route);
    await instance.start({ runId: "run", mimeType: "audio/pcm" });
    let prefix = "";
    const beforeAck = audio(100); new Uint8Array(beforeAck.data).fill(7);
    for (let segment = 0; segment < 3; segment += 1) {
      instance.appendAudio(audio(10_000, confirmation === "spoken"));
      instance.appendAudio(audio(10_000, confirmation === "spoken"));
      await vi.waitFor(() => expect(received[0]!.filter(message => message.commit)).toHaveLength(segment + 1));
      if (segment === 2) instance.appendAudio(beforeAck);
      const text = confirmation === "spoken" ? `confirmed-${segment}` : "";
      prefix = [prefix, text].filter(Boolean).join(" ");
      transcript(sockets[0]!, "committed_transcript", text);
      await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "stable", text: prefix }));
    }
    const afterAck = audio(100); new Uint8Array(afterAck.data).fill(8);
    instance.appendAudio(afterAck);
    await roundTrip(sockets[0]!);
    sockets[0]!.terminate();
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("disconnected"));
    await instance.recover();
    expect(received.map(size)).toEqual([60_200 * 32, 2_100 * 32]);
    expect(received[1]!.filter((message) => message.commit)).toHaveLength(1);
    expect(Buffer.concat(received[1]!.map(message => Buffer.from(message.audio_base_64, "base64")))).toEqual(
      Buffer.concat([Buffer.alloc(100 * 32, 7), Buffer.alloc(100 * 32, 8), Buffer.alloc(1_900 * 32)]));
    await instance.flushAudio();
    expect(events.at(-1)).toEqual({ type: "stable", text: [prefix, "tail"].filter(Boolean).join(" ") });
    expect(events.filter((event) => event.type === "stable")).toHaveLength(4);
  });

  it("keeps confirmed text when reconnecting with no unconfirmed PCM and appends only new recognition", async () => {
    const sockets: WebSocket[] = [];
    const received: Input[][] = [];
    const route = await fixture((socket, _request, index) => {
      sockets.push(socket);
      received[index] = record(socket, () => transcript(socket, "committed_transcript", index > 0 ? "different" : "confirmed"));
      ready(socket);
    });
    const { instance, events } = provider(route);
    await instance.start({ runId: "run", mimeType: "audio/pcm" });
    instance.appendAudio(audio(1_000));
    instance.appendAudio(audio(1_500, false));
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "stable", text: "confirmed" }));
    await instance.recover();
    expect(received[1]).toEqual([]);
    expect(events.filter((event) => "text" in event)).toEqual([{ type: "stable", text: "confirmed" }]);
    instance.appendAudio(audio(100));
    await instance.flushAudio();
    expect(events.filter((event) => event.type === "stable")).toEqual([
      { type: "stable", text: "confirmed" }, { type: "stable", text: "confirmed different" }
    ]);
  });

  it("stops startup promptly and does not accept a late handshake", async () => {
    let socket!: WebSocket;
    const route = await fixture((connected) => { socket = connected; });
    const { instance, events } = provider(route);
    const started = instance.start({ runId: "run", mimeType: "audio/pcm" });
    const rejected = expect(started).rejects.toMatchObject({ code: "stopped" });
    await vi.waitFor(() => expect(socket).toBeDefined());
    await instance.stop();
    await rejected;
    expect(events).toEqual([]);
    await expect(instance.recover()).rejects.toMatchObject({ code: "network" });
  });

  it("bounds recovery by actual audio bytes while allowing longer uninterrupted dictation", async () => {
    let sent!: Input[];
    const route = await fixture((socket) => {
      sent = record(socket, (index) => transcript(socket, "committed_transcript", `segment-${index}`));
      ready(socket);
    });
    const { instance, events } = provider(route);
    await instance.start({ runId: "run", mimeType: "audio/pcm" });
    for (let index = 0; index < 61; index += 1) instance.appendAudio(audio(1_000));
    expect(events).toEqual([{ type: "connected" }]);
    await expect(instance.recover()).rejects.toMatchObject({ code: "network" });
    await instance.flushAudio();
    const segments: number[] = [];
    let pending = 0;
    for (const message of sent) {
      pending += size([message]);
      if (message.commit) { segments.push(pending); pending = 0; }
    }
    expect(segments).toEqual([20_000, 20_000, 20_000, 2_100].map((ms) => ms * 32));
    expect(events.at(-1)).toEqual({ type: "stable", text: "segment-0 segment-1 segment-2 segment-3" });
  });

  it.each([true, false])("fails an unacknowledged flush within its bound, including silent audio (voiced=%s)", async (voiced) => {
    let socket!: WebSocket;
    const route = await fixture((connected) => { socket = connected; ready(socket); });
    const { instance, events } = provider({ ...route, flushTimeoutMs: 250 });
    await instance.start({ runId: "run", mimeType: "audio/pcm" });
    instance.appendAudio(audio(100, voiced));
    transcript(socket, "partial_transcript", "unfinished");
    await expect(instance.flushAudio()).rejects.toMatchObject({ code: "timeout" });
    expect(events.filter((event) => event.type === "stable")).toEqual([]);
  });

  it("does not commit empty input and accepts an explicitly acknowledged silent tail", async () => {
    const inputs: Input[][] = [];
    const route = await fixture((socket, _request, index) => {
      inputs[index] = record(socket, () => transcript(socket, "committed_transcript", ""));
      ready(socket);
    });
    const empty = provider(route);
    await empty.instance.start({ runId: "empty", mimeType: "audio/pcm" });
    await empty.instance.flushAudio();
    expect(inputs[0]).toEqual([]);
    const silent = provider(route);
    await silent.instance.start({ runId: "silent", mimeType: "audio/pcm" });
    silent.instance.appendAudio(audio(100, false));
    await silent.instance.flushAudio();
    expect(size(inputs[1]!)).toBe(2_100 * 32);
    expect(silent.events.at(-1)).toEqual({ type: "stable", text: "" });
  });

  it("does not commit a short pause before enough audio has reached the transcriber", async () => {
    let socket!: WebSocket;
    let sent!: Input[];
    const route = await fixture((connected) => { socket = connected; sent = record(socket); ready(socket); });
    const { instance } = provider(route);
    await instance.start({ runId: "run", mimeType: "audio/pcm" });
    instance.appendAudio(audio(100));
    instance.appendAudio(audio(1_500, false));
    await roundTrip(socket);
    expect(sent.filter((message) => message.commit)).toEqual([]);
    instance.appendAudio(audio(500, false));
    await roundTrip(socket);
    expect(sent.filter((message) => message.commit)).toHaveLength(1);
    expect(size(sent)).toBe(2_100 * 32);
  });

  it("bounds queued audio while a commit is unacknowledged", async () => {
    const route = await fixture((socket) => { ready(socket); });
    const { instance, events } = provider(route);
    await instance.start({ runId: "run", mimeType: "audio/pcm" });
    for (let index = 0; index < 9; index += 1) instance.appendAudio(audio(10_000));
    expect(events.at(-1)).toEqual({ type: "error", category: "transport", recoverable: false });
    await expect(instance.flushAudio()).rejects.toMatchObject({ code: "network" });
    await expect(instance.recover()).rejects.toMatchObject({ code: "network" });
  });

  it("bounds tiny queued chunks before startup completes", async () => {
    const route = await fixture(() => undefined);
    const { instance } = provider(route);
    const rejected = expect(instance.start({ runId: "run", mimeType: "audio/pcm" })).rejects.toMatchObject({ code: "network" });
    for (let index = 0; index < 4_097; index += 1) instance.appendAudio(audio(1 / 16));
    await rejected;
  });

  it("rejects a pending stop barrier and discards late commit frames after stop", async () => {
    let socket!: WebSocket;
    let sent!: Input[];
    const route = await fixture((connected) => { socket = connected; sent = record(socket); ready(socket); });
    const { instance, events } = provider(route);
    await instance.start({ runId: "run", mimeType: "audio/pcm" });
    instance.appendAudio(audio(1_000));
    instance.appendAudio(audio(1_500, false));
    instance.appendAudio(audio(100));
    const rejected = expect(instance.flushAudio()).rejects.toMatchObject({ code: "stopped" });
    await roundTrip(socket);
    await instance.stop();
    transcript(socket, "committed_transcript", "late");
    await rejected;
    expect(sent.filter((message) => message.commit)).toHaveLength(1);
    expect(events).toEqual([{ type: "connected" }]);
  });

  it.each(["capture", "replay"] as const)("replays a lost %s commit with its padding, then drains new capture before the stop barrier", async (lostAt) => {
    const sockets: WebSocket[] = [];
    const sent: Input[][] = [];
    const route = await fixture((socket, _request, index) => {
      sockets.push(socket);
      sent[index] = record(socket);
      if (index === 0) ready(socket);
    });
    const { instance, events } = provider(route);
    await instance.start({ runId: "run", mimeType: "audio/pcm" });
    for (let segment = 0; segment < 3; segment += 1) {
      instance.appendAudio(audio(10_000)); instance.appendAudio(audio(10_000));
      await vi.waitFor(() => expect(sent[0]!.filter(message => message.commit)).toHaveLength(segment + 1));
      transcript(sockets[0]!, "committed_transcript", `confirmed-${segment}`);
      await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "stable", text: Array.from({ length: segment + 1 }, (_, index) => `confirmed-${index}`).join(" ") }));
    }
    if (lostAt === "capture") {
      instance.appendAudio(audio(1_000)); instance.appendAudio(audio(1_500, false)); instance.appendAudio(audio(100));
    } else instance.appendAudio(audio(100));
    await roundTrip(sockets[0]!);
    sockets[0]!.terminate();
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("disconnected"));
    let connection = 1;
    if (lostAt === "replay") {
      const failed = expect(instance.recover()).rejects.toMatchObject({ code: "network" });
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      ready(sockets[1]!);
      await vi.waitFor(() => expect(sent[1]!.filter(message => message.commit)).toHaveLength(1));
      expect(size(sent[1]!)).toBe(2_100 * 32);
      sockets[1]!.terminate();
      await failed;
      connection = 2;
    }
    const recovery = instance.recover();
    await vi.waitFor(() => expect(sockets).toHaveLength(connection + 1));
    instance.appendAudio(audio(100));
    let finished = false;
    const flush = instance.flushAudio().then(() => { finished = true; });
    ready(sockets[connection]!);
    await vi.waitFor(() => expect(sent[connection]!.filter((message) => message.commit)).toHaveLength(1));
    expect(size(sent[connection]!)).toBe((lostAt === "capture" ? 2_500 : 2_100) * 32);
    if (lostAt === "replay") expect(sent[connection]).toEqual(sent[1]);
    transcript(sockets[connection]!, "committed_transcript", "first");
    await vi.waitFor(() => expect(sent[connection]!.filter((message) => message.commit)).toHaveLength(2));
    expect(finished).toBe(false);
    expect(size(sent[connection]!)).toBe((lostAt === "capture" ? 4_600 : 4_200) * 32);
    transcript(sockets[connection]!, "committed_transcript", "tail");
    await recovery;
    await flush;
    expect(events.at(-1)).toEqual({ type: "stable", text: "confirmed-0 confirmed-1 confirmed-2 first tail" });
  });

  it("fails a recovery whose replay receives no acknowledgement", async () => {
    const route = await fixture((socket) => ready(socket));
    const { instance } = provider({ ...route, connectTimeoutMs: 250, flushTimeoutMs: 250 });
    await instance.start({ runId: "run", mimeType: "audio/pcm" });
    instance.appendAudio(audio(100));
    await expect(instance.recover()).rejects.toMatchObject({ code: "timeout" });
    await expect(instance.flushAudio()).rejects.toMatchObject({ code: "network" });
  });

  it("rejects unsolicited commits instead of treating them as a future stop acknowledgement", async () => {
    let socket!: WebSocket;
    const route = await fixture((connected) => { socket = connected; ready(socket); });
    const { instance, events } = provider(route);
    await instance.start({ runId: "run", mimeType: "audio/pcm" });
    instance.appendAudio(audio(100));
    transcript(socket, "committed_transcript", "unexpected");
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "error", category: "protocol", recoverable: false }));
    expect(events.filter((event) => event.type === "stable")).toEqual([]);
    await expect(instance.flushAudio()).rejects.toMatchObject({ code: "network" });
  });

  it.each([
    ["auth_error", "authenticationFailed"], ["quota_exceeded", "serviceError"], ["transcriber_error", "network"]
  ] as const)("sanitizes %s during the actual protocol probe", async (type, reason) => {
    const route = await fixture((socket) => socket.send(JSON.stringify({ message_type: type, error: "private-provider-response" })));
    expect(await probeScribeTranscriptionRoute({ ...route, apiKey: "private-api-key" })).toEqual({ ok: false, reason });
  });

  it.each([
    ["PCM format", { model_id: "scribe_v2_realtime", audio_format: "pcm_24000", sample_rate: 24_000 }],
    ["commit strategy", { model_id: "scribe_v2_realtime", audio_format: "pcm_16000", sample_rate: 16_000, commit_strategy: "vad" }]
  ])("rejects an incompatible negotiated %s", async (_kind, config) => {
    const route = await fixture((socket) => socket.send(JSON.stringify({ message_type: "session_started", config })));
    expect(await probeScribeTranscriptionRoute(route)).toEqual({ ok: false, reason: "serviceError" });
  });

  it.each(["ws://speech.example/realtime", "wss://user:secret@speech.example/realtime", "wss://speech.example/realtime?token=secret", "wss://speech.example/realtime#secret"])("rejects unsafe endpoint %s before a socket exists", (endpoint) => {
    expect(() => validateScribeTranscriptionRoute({ endpoint, model: "scribe_v2_realtime" })).toThrow("protocol");
  });
});
