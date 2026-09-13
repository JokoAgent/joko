import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { gzipSync, gunzipSync } from "node:zlib";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AsrEvent } from "@joko/voice-input";
import { SaucTranscriptionProvider, probeSaucTranscriptionRoute, validateSaucTranscriptionConfiguration, validateSaucTranscriptionRoute } from "./provider.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Packet = { type: number; sequence?: number; data: Buffer };
function decode(data: Buffer): Packet {
  expect(data[0]).toBe(0x11);
  expect(data[3]).toBe(0);
  const type = data[1]! >> 4;
  const flags = data[1]! & 15;
  const offset = (flags & 1) === 1 ? 8 : 4;
  expect(data[2]).toBe(type === 1 ? 0x11 : 0x01);
  expect(data.readUInt32BE(offset)).toBe(data.length - offset - 4);
  return { type, sequence: offset === 8 ? data.readInt32BE(4) : undefined, data: gunzipSync(data.subarray(offset + 4)) };
}
function response(payload: unknown, sequence: number | undefined = 1, last = false, compression = 1): Buffer {
  const content = Buffer.from(JSON.stringify(payload));
  const data = compression === 1 ? gzipSync(content) : content;
  const header = Buffer.alloc(sequence === undefined ? 8 : 12);
  header.set([0x11, 0x90 | (sequence === undefined ? (last ? 2 : 0) : (last ? 3 : 1)), 0x10 | compression, 0]);
  if (sequence !== undefined) header.writeInt32BE(last ? -sequence : sequence, 4);
  header.writeUInt32BE(data.length, header.length - 4);
  return Buffer.concat([header, data]);
}
function result(text: string, stableLength = text.length): unknown {
  const stable = text.slice(0, stableLength);
  const partial = text.slice(stableLength);
  return { result: { text, utterances: [
    ...(stable === "" ? [] : [{ text: stable, start_time: 0, end_time: 100, definite: true }]),
    ...(partial === "" ? [] : [{ text: partial, start_time: 100, end_time: 200, definite: false }])
  ] } };
}
function audio(ms: number, value = 1) { return { data: new Uint8Array(ms * 32).fill(value).buffer, durationMs: ms, voiced: value !== 0 }; }
async function fixture(onConnection: (socket: WebSocket, request: IncomingMessage, index: number, packets: Packet[]) => void, autoReady = true) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  let index = 0;
  server.on("connection", (socket, request) => {
    const packets: Packet[] = [];
    socket.on("message", (raw, binary) => {
      expect(binary).toBe(true);
      const packet = decode(Buffer.from(raw as Buffer));
      packets.push(packet);
      if (packet.type === 1 && autoReady) socket.send(response({}));
    });
    onConnection(socket, request, index++, packets);
  });
  cleanups.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Missing test socket address.");
  return { endpoint: `ws://127.0.0.1:${address.port}/api/v3/sauc/bigmodel_async`, resourceId: "volc.seedasr.sauc.duration",
    apiKey: "ephemeral-test-key", connectTimeoutMs: 1_000, flushTimeoutMs: 500 };
}
function provider(route: ConstructorParameters<typeof SaucTranscriptionProvider>[0]) {
  const instance = new SaucTranscriptionProvider(route);
  cleanups.push(() => instance.stop());
  const events: AsrEvent[] = [];
  instance.onEvent((event) => events.push(event));
  return { instance, events };
}
async function roundTrip(socket: WebSocket): Promise<void> {
  const pong = once(socket, "pong");
  socket.ping();
  await pong;
}
async function flushWithResult(instance: SaucTranscriptionProvider, packets: Packet[], socket: WebSocket, text: string): Promise<void> {
  const flush = instance.flushAudio();
  await vi.waitFor(() => expect(packets.at(-1)?.sequence).toBeLessThan(0));
  socket.send(response(result(text), Math.abs(packets.at(-1)!.sequence!), true));
  await flush;
}

describe("SAUC native transcription", () => {
  it("negotiates before audio, segments copied PCM, retains only definite prefixes, and waits for the last response", async () => {
    let socket!: WebSocket;
    let request!: IncomingMessage;
    let packets!: Packet[];
    const route = await fixture((connected, handshake, _index, sent) => { socket = connected; request = handshake; packets = sent; }, false);
    const { instance, events } = provider(route);
    const started = instance.start({ runId: "private-run", mimeType: "audio/pcm", locale: "ja-JP" });
    const captured = audio(500, 7);
    instance.appendAudio(captured);
    new Uint8Array(captured.data).fill(8);
    await vi.waitFor(() => expect(packets).toHaveLength(1));
    expect(events).toEqual([]);
    expect(request.headers["x-api-key"]).toBe(route.apiKey);
    expect(request.headers["x-api-resource-id"]).toBe(route.resourceId);
    expect(request.headers["x-api-sequence"]).toBe("-1");
    expect(request.headers["x-api-connect-id"]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(request.headers["x-api-request-id"]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(request.headers["authorization"]).toBeUndefined();
    expect(request.headers["x-api-access-key"]).toBeUndefined();
    expect(request.headers["x-api-app-key"]).toBeUndefined();
    expect(request.url).toBe("/api/v3/sauc/bigmodel_async");
    expect(JSON.parse(packets[0]!.data.toString())).toEqual({
      audio: { format: "pcm", codec: "raw", rate: 16_000, bits: 16, channel: 1 },
      request: { model_name: "bigmodel", result_type: "full", show_utterances: true, enable_nonstream: true,
        end_window_size: 300, enable_punc: true, enable_itn: true }
    });
    socket.send(response({}));
    await started;
    socket.send(response(result("first draft", 5), 2));
    await vi.waitFor(() => expect(events.slice(-2)).toEqual([{ type: "stable", text: "first" }, { type: "partial", text: "first draft" }]));
    socket.send(response(result("first"), 3));
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "stable", text: "first" }));
    let finished = false;
    const flush = instance.flushAudio();
    expect(instance.flushAudio()).toBe(flush);
    void flush.then(() => { finished = true; });
    await vi.waitFor(() => expect(packets.at(-1)?.sequence).toBe(-4));
    expect(packets.slice(1).map((packet) => packet.data.length)).toEqual([6_400, 6_400, 3_200]);
    expect(Buffer.concat(packets.slice(1).map((packet) => packet.data))).toEqual(Buffer.alloc(16_000, 7));
    socket.send(response(result("first corrected"), 3));
    await roundTrip(socket);
    expect(finished).toBe(false);
    socket.send(response(result("first corrected"), 4, true));
    await flush;
    expect(events.filter((event) => event.type === "stable")).toEqual([
      { type: "stable", text: "first" }, { type: "stable", text: "first" }, { type: "stable", text: "first corrected" }
    ]);
    expect(events.some((event) => event.type === "error" || event.type === "disconnected")).toBe(false);
  });

  it("handles documented no-sequence last packets and explicit empty recognition without fabricating speech", async () => {
    let socket!: WebSocket; let packets!: Packet[];
    const route = await fixture((connected, _request, _index, sent) => { socket = connected; packets = sent; });
    const { instance, events } = provider(route);
    await instance.start({ runId: "run", mimeType: "audio/pcm" });
    instance.appendAudio(audio(100, 0));
    socket.send(response(result("withdrawn draft", 0), 2));
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "partial", text: "withdrawn draft" }));
    socket.send(response(result("", 0), 3));
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "stable", text: "" }));
    socket.send(response(result("withdrawn final draft", 0), 4));
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "partial", text: "withdrawn final draft" }));
    const flush = instance.flushAudio();
    await vi.waitFor(() => expect(packets.at(-1)?.sequence).toBe(-2));
    socket.send(response(result(""), undefined, true, 0));
    await flush;
    expect(events).toEqual([{ type: "connected" }, { type: "partial", text: "withdrawn draft" },
      { type: "stable", text: "" }, { type: "partial", text: "withdrawn final draft" }, { type: "stable", text: "" }]);
  });

  it("replays the complete bounded capture on the same route, shields old stable text, and drains a stop during recovery", async () => {
    const sockets: WebSocket[] = []; const captures: Packet[][] = []; const headers: IncomingMessage["headers"][] = [];
    const route = await fixture((socket, request, _index, packets) => { sockets.push(socket); captures.push(packets); headers.push(request.headers); });
    const { instance, events } = provider(route);
    await instance.start({ runId: "run", mimeType: "audio/pcm" });
    instance.appendAudio(audio(200, 1));
    await vi.waitFor(() => expect(captures[0]).toHaveLength(2));
    sockets[0]!.send(response(result("hello"), 2));
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "stable", text: "hello" }));
    sockets[0]!.send(response(result("hello withdrawn", 5), 3));
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "partial", text: "hello withdrawn" }));
    sockets[0]!.terminate();
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "disconnected", recoverable: true }));
    instance.appendAudio(audio(100, 2));
    const recovering = instance.recover();
    expect(instance.recover()).toBe(recovering);
    await vi.waitFor(() => expect(captures[1]?.length).toBeGreaterThanOrEqual(2));
    instance.appendAudio(audio(100, 3));
    const stopping = instance.flushAudio();
    sockets[1]!.send(response(result("hel", 0), 2));
    await roundTrip(sockets[1]!);
    expect(events.filter((event) => event.type === "partial")).toEqual([{ type: "partial", text: "hello withdrawn" }]);
    sockets[1]!.send(response(result("hello", 0), 3));
    await roundTrip(sockets[1]!);
    expect(events.filter((event) => event.type === "partial")).toEqual([{ type: "partial", text: "hello withdrawn" }]);
    sockets[1]!.send(response(result("hello"), 4));
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "stable", text: "hello" }));
    sockets[1]!.send(response(result("hello new", 5), 3));
    await recovering;
    await vi.waitFor(() => expect(captures[1]!.at(-1)?.sequence).toBeLessThan(0));
    const replay = captures[1]!.slice(1);
    expect(Buffer.concat(replay.map((packet) => packet.data))).toEqual(Buffer.concat([Buffer.alloc(6_400, 1), Buffer.alloc(3_200, 2), Buffer.alloc(3_200, 3)]));
    expect(headers[1]!["x-api-key"]).toBe(headers[0]!["x-api-key"]);
    expect(headers[1]!["x-api-connect-id"]).not.toBe(headers[0]!["x-api-connect-id"]);
    sockets[1]!.send(response(result("hello new"), Math.abs(replay.at(-1)!.sequence!), true));
    await stopping;
    expect(events.filter((event) => event.type === "stable")).toEqual([{ type: "stable", text: "hello" },
      { type: "stable", text: "hello" }, { type: "stable", text: "hello new" }]);
  });

  it("rejects a divergent confirmed replay instead of joining guessed transcript overlap", async () => {
    const sockets: WebSocket[] = [];
    const route = await fixture((socket) => sockets.push(socket));
    const { instance, events } = provider(route);
    await instance.start({ runId: "run", mimeType: "audio/pcm" });
    instance.appendAudio(audio(200));
    sockets[0]!.send(response(result("known"), 2));
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "stable", text: "known" }));
    sockets[0]!.terminate();
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("disconnected"));
    const recovery = expect(instance.recover()).rejects.toMatchObject({ code: "protocol" });
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await roundTrip(sockets[1]!);
    sockets[1]!.send(response(result("different"), 2));
    await recovery;
    expect(events.filter((event) => event.type === "stable")).toEqual([{ type: "stable", text: "known" }]);
    expect(events.at(-1)).toEqual({ type: "error", category: "protocol", recoverable: false });
  });

  it("caps recovery attempts without crossing to another connection or leaving sockets alive", async () => {
    const sockets: WebSocket[] = [];
    const route = await fixture((socket) => sockets.push(socket));
    const { instance, events } = provider(route);
    await instance.start({ runId: "run", mimeType: "audio/pcm" });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      sockets[attempt]!.terminate();
      await vi.waitFor(() => expect(events.at(-1)?.type).toBe("disconnected"));
      await instance.recover();
    }
    sockets[3]!.terminate();
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "disconnected", recoverable: false }));
    await expect(instance.recover()).rejects.toMatchObject({ code: "network" });
    expect(sockets).toHaveLength(4);
  });

  it("disables recovery when total capture exceeds 60 seconds, instead of retaining only a recent tail", async () => {
    let socket!: WebSocket;
    const route = await fixture((connected) => { socket = connected; });
    const { instance, events } = provider(route);
    await instance.start({ runId: "run", mimeType: "audio/pcm" });
    for (let index = 0; index < 6; index += 1) instance.appendAudio(audio(10_000));
    instance.appendAudio(audio(100));
    expect(events).toEqual([{ type: "connected" }]);
    socket.terminate();
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "disconnected", recoverable: false }));
    await expect(instance.recover()).rejects.toMatchObject({ code: "network" });
  });

  it("fails bounded startup audio backlog and rejects forged PCM duration", async () => {
    const route = await fixture(() => {}, false);
    const { instance, events } = provider(route);
    const started = expect(instance.start({ runId: "run", mimeType: "audio/pcm" })).rejects.toMatchObject({ code: "protocol" });
    for (let index = 0; index < 7; index += 1) instance.appendAudio(audio(10_000));
    await started;
    expect(events.at(-1)).toEqual({ type: "error", category: "protocol", recoverable: false });
    const second = provider(await fixture(() => {}));
    await second.instance.start({ runId: "run", mimeType: "audio/pcm" });
    second.instance.appendAudio({ ...audio(100), durationMs: 10 });
    expect(second.events.at(-1)).toEqual({ type: "error", category: "protocol", recoverable: false });
  });

  it.each(["startup", "flush", "recovery"] as const)("cancels %s and fences late provider results", async (stage) => {
    const sockets: WebSocket[] = []; const sent: Packet[][] = [];
    const route = await fixture((socket, _request, _index, packets) => { sockets.push(socket); sent.push(packets); }, stage !== "startup");
    const { instance, events } = provider(route);
    let pending: Promise<void>;
    if (stage === "startup") pending = instance.start({ runId: "run", mimeType: "audio/pcm" });
    else {
      await instance.start({ runId: "run", mimeType: "audio/pcm" });
      instance.appendAudio(audio(200));
      if (stage === "recovery") {
        sockets[0]!.send(response(result("known"), 2));
        await vi.waitFor(() => expect(events.at(-1)?.type).toBe("stable"));
        sockets[0]!.terminate();
        await vi.waitFor(() => expect(events.at(-1)?.type).toBe("disconnected"));
        pending = instance.recover();
        await vi.waitFor(() => expect(sent[1]?.length).toBeGreaterThanOrEqual(2));
      } else {
        pending = instance.flushAudio();
        await vi.waitFor(() => expect(sent[0]!.at(-1)?.sequence).toBeLessThan(0));
      }
    }
    const rejected = expect(pending).rejects.toMatchObject({ code: "stopped" });
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    const before = [...events];
    sockets.at(-1)!.send(response(result("late"), 10, true));
    await instance.stop();
    await rejected;
    await vi.waitFor(() => expect(sockets.every((socket) => socket.readyState === 3)).toBe(true));
    expect(events).toEqual(before);
    expect(sockets).toHaveLength(stage === "recovery" ? 2 : 1);
  });

  it("times out unacknowledged finalization without promoting a partial transcript", async () => {
    let socket!: WebSocket;
    const route = await fixture((connected) => { socket = connected; });
    const { instance, events } = provider({ ...route, flushTimeoutMs: 250 });
    await instance.start({ runId: "run", mimeType: "audio/pcm" });
    instance.appendAudio(audio(100));
    socket.send(response(result("unconfirmed", 0), 2));
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("partial"));
    await expect(instance.flushAudio()).rejects.toMatchObject({ code: "timeout" });
    expect(events.filter((event) => event.type === "stable")).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "error", category: "transport", recoverable: false });
  });

  it("requires a binary protocol acknowledgement even when the WebSocket upgrade succeeds", async () => {
    const route = await fixture(() => {}, false);
    const { instance, events } = provider({ ...route, connectTimeoutMs: 250 });
    await expect(instance.start({ runId: "run", mimeType: "audio/pcm" })).rejects.toMatchObject({ code: "timeout" });
    expect(events).toEqual([{ type: "error", category: "transport", recoverable: false }]);
  });

  it.each([
    ["text JSON", () => JSON.stringify({ result: { text: "wrong transport" } })],
    ["unknown version", () => { const packet = response({}); packet[0] = 0x21; return packet; }],
    ["truncated payload", () => response({}).subarray(0, 10)],
    ["unbounded inflate", () => response({ result: { text: "x".repeat(270_000) } })],
    ["oversized WebSocket message", () => response({ result: { text: "x".repeat(270_000) } }, 1, false, 0)],
    ["guessed transcript alias", () => response({ transcript: "not a result" })],
    ["guessed array shape", () => response({ result: [{ text: "not an object" }] })],
    ["wrong sequence sign", () => { const packet = response({}); packet[1] = 0x93; return packet; }],
    ["undocumented ACK", () => { const packet = response({}); packet[1] = 0xb1; return packet; }]
  ] as const)("rejects %s without treating it as a ready session", async (_label, packet) => {
    const route = await fixture((socket) => socket.once("message", () => socket.send(packet())), false);
    const { instance, events } = provider(route);
    await expect(instance.start({ runId: "run", mimeType: "audio/pcm" })).rejects.toMatchObject({ code: "protocol" });
    expect(events).toEqual([{ type: "error", category: "protocol", recoverable: false }]);
  });

  it("classifies native service errors without exposing provider payloads", async () => {
    let socket!: WebSocket;
    const route = await fixture((connected) => { socket = connected; });
    const { instance, events } = provider(route);
    await instance.start({ runId: "run", mimeType: "audio/pcm" });
    const data = Buffer.from("secret-key raw transcript diagnostic");
    const header = Buffer.alloc(12);
    header.set([0x11, 0xf0, 0, 0]);
    header.writeUInt32BE(45000001, 4);
    header.writeUInt32BE(data.length, 8);
    socket.send(Buffer.concat([header, data]));
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "error", category: "protocol", recoverable: false }));
    expect(JSON.stringify(events)).not.toContain("secret-key");
  });

  it("validates public configuration independently and never accepts empty or header-injected secrets", () => {
    const publicRoute = { endpoint: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async", resourceId: "volc.seedasr.sauc.duration" };
    expect(validateSaucTranscriptionConfiguration(publicRoute)).toEqual(publicRoute);
    expect(() => validateSaucTranscriptionRoute({ ...publicRoute, apiKey: "" })).toThrow();
    for (const apiKey of ["x\r\nAuthorization: stolen", " ", "x".repeat(8_193)]) {
      expect(() => validateSaucTranscriptionRoute({ ...publicRoute, apiKey })).toThrow();
    }
    for (const endpoint of ["ws://example.com/api/v3/sauc/bigmodel_async", `${publicRoute.endpoint}?key=secret`, `${publicRoute.endpoint}#secret`,
      "wss://key@example.com/api/v3/sauc/bigmodel_async", "wss://example.com/api/v3/sauc/bigmodel_nostream", "wss://example.com/api/v3/sauc/bigmodel"]) {
      expect(() => validateSaucTranscriptionConfiguration({ ...publicRoute, endpoint })).toThrow();
    }
    expect(() => validateSaucTranscriptionConfiguration({ ...publicRoute, resourceId: "guessed-model" })).toThrow();
  });

  it("sanitizes HTTP failures, refuses redirects, and probes readiness without sending audio", async () => {
    let status = 403; let handshakes = 0;
    const server = createServer((_request, response) => {
      handshakes += 1;
      response.writeHead(status, { location: "ws://127.0.0.1:1/credential-recipient" });
      response.end("provider secret diagnostics");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("Missing test HTTP address.");
    const route = { endpoint: `ws://127.0.0.1:${address.port}/api/v3/sauc/bigmodel_async`, resourceId: "volc.seedasr.sauc.duration", apiKey: "key" };
    expect(await probeSaucTranscriptionRoute(route)).toEqual({ ok: false, reason: "authenticationFailed" });
    status = 302;
    expect(await probeSaucTranscriptionRoute(route)).toEqual({ ok: false, reason: "serviceError" });
    status = 404;
    expect(await probeSaucTranscriptionRoute(route)).toEqual({ ok: false, reason: "routeUnavailable" });
    expect(handshakes).toBe(3);
    let sent!: Packet[];
    const valid = await fixture((_socket, _request, _index, packets) => { sent = packets; });
    expect(await probeSaucTranscriptionRoute(valid)).toEqual({ ok: true });
    expect(sent.map((packet) => packet.type)).toEqual([1]);
  });
});
