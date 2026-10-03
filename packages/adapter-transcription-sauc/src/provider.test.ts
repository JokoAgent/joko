import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { gzipSync, gunzipSync } from "node:zlib";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAXIMUM_AUDIO_BYTES, type AsrEvent } from "@joko/voice-input";
import { SAUC_SUPPORTED_LOCALES, SaucTranscriptionProvider, probeSaucTranscriptionRoute, validateSaucLocale,
  validateSaucTranscriptionConfiguration, validateSaucTranscriptionRoute, type SaucAuthentication,
  type SaucTranscriptionMode, type SaucTranscriptionRoute } from "./provider.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

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
    mode: "asyncTwoPass" as const, authentication: { type: "apiKey" as const, apiKey: "ephemeral-test-key" },
    connectTimeoutMs: 1_000, flushTimeoutMs: 500 };
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
  it.each((["asyncTwoPass", "bidirectional", "streamInput"] as const).flatMap((mode) =>
    (["apiKey", "accessToken"] as const).map((authenticationType) => ({ mode, authenticationType }))
  ))("negotiates $mode with $authenticationType, freezes its text context, and waits for the last response", async ({ mode, authenticationType }) => {
    let socket!: WebSocket;
    let request!: IncomingMessage;
    let packets!: Packet[];
    const initial = await fixture((connected, handshake, _index, sent) => { socket = connected; request = handshake; packets = sent; }, false);
    const path = mode === "asyncTwoPass" ? "bigmodel_async" : mode === "bidirectional" ? "bigmodel" : "bigmodel_nostream";
    const authentication: SaucAuthentication = authenticationType === "apiKey" ? { type: "apiKey", apiKey: "frozen-key" }
      : { type: "accessToken", appId: "application-123", accessToken: "frozen-access-token" };
    const corpus = { boostingTableName: "专用词表", boostingTableId: "boost-id", correctTableName: "correction-name", correctTableId: "correct-id" };
    const recognitionContext = { hotwords: ["VoiceKit"], contextData: [{ text: "A deliberately supplied context." }] };
    const route: SaucTranscriptionRoute = { ...initial, endpoint: initial.endpoint.replace("bigmodel_async", path),
      mode, authentication, corpus, recognitionContext };
    const { instance, events } = provider(route);
    Object.assign(authentication, authenticationType === "apiKey" ? { apiKey: "changed-key" } : { accessToken: "changed-token", appId: "changed-application" });
    corpus.boostingTableName = "changed table";
    recognitionContext.hotwords[0] = "changed hotword";
    recognitionContext.contextData[0]!.text = "changed context";
    const started = instance.start({ runId: "private-run", mimeType: "audio/pcm", locale: "ja-JP" });
    const captured = audio(500, 7);
    instance.appendAudio(captured);
    new Uint8Array(captured.data).fill(8);
    await vi.waitFor(() => expect(packets).toHaveLength(1));
    expect(events).toEqual([]);
    expect(request.headers["x-api-key"]).toBe(authenticationType === "apiKey" ? "frozen-key" : undefined);
    expect(request.headers["x-api-resource-id"]).toBe(route.resourceId);
    expect(request.headers["x-api-sequence"]).toBe("-1");
    expect(request.headers["x-api-connect-id"]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(request.headers["x-api-request-id"]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(request.headers["authorization"]).toBeUndefined();
    expect(request.headers["x-api-access-key"]).toBe(authenticationType === "accessToken" ? "frozen-access-token" : undefined);
    expect(request.headers["x-api-app-key"]).toBe(authenticationType === "accessToken" ? "application-123" : undefined);
    expect(request.headers["x-api-app-id"]).toBeUndefined();
    expect(request.url).toBe(`/api/v3/sauc/${path}`);
    expect(JSON.parse(packets[0]!.data.toString())).toEqual({
      audio: { format: "pcm", codec: "raw", rate: 16_000, bits: 16, channel: 1,
        ...(mode === "streamInput" ? { language: "ja-JP" } : {}) },
      request: { model_name: "bigmodel", result_type: "full", show_utterances: true,
        ...(mode === "asyncTwoPass" ? { enable_nonstream: true, end_window_size: 300 } : {}),
        enable_punc: true, enable_itn: true, corpus: {
          boosting_table_name: "专用词表", boosting_table_id: "boost-id", correct_table_name: "correction-name", correct_table_id: "correct-id",
          context: JSON.stringify({ hotwords: [{ word: "VoiceKit" }], context_type: "dialog_ctx",
            context_data: [{ text: "A deliberately supplied context." }] })
        } }
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

  it("replays capture beyond sixty seconds from one owner, replaces the old recognition, and drains a stop during recovery", async () => {
    const sockets: WebSocket[] = []; const captures: Packet[][] = []; const headers: IncomingMessage["headers"][] = [];
    const initial = await fixture((socket, request, index, packets) => {
      sockets.push(socket); captures.push(packets); headers.push(request.headers);
      if (index === 0) socket.once("message", () => socket.send(response({})));
    }, false);
    const recognitionContext = { hotwords: ["VoiceKit"], contextData: [{ text: "Frozen recording context." }] };
    const route: SaucTranscriptionRoute = { ...initial, authentication: { type: "accessToken", appId: "original-application", accessToken: "original-token" }, recognitionContext };
    const { instance, events } = provider(route);
    Object.assign(route.authentication, { appId: "changed-application", accessToken: "changed-token" });
    recognitionContext.hotwords[0] = "changed-hotword";
    recognitionContext.contextData[0]!.text = "Changed recording context.";
    await instance.start({ runId: "run", mimeType: "audio/pcm" });
    const expected: Buffer[] = [];
    for (let index = 0; index < 6; index += 1) {
      const captured = audio(10_000, index + 1);
      instance.appendAudio(captured);
      expected.push(Buffer.alloc(320_000, index + 1));
      new Uint8Array(captured.data).fill(254);
    }
    instance.appendAudio(audio(1_000, 7)); expected.push(Buffer.alloc(32_000, 7));
    await vi.waitFor(() => expect(captures[0]).toHaveLength(2));
    sockets[0]!.send(response(result("hello"), 2));
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "stable", text: "hello" }));
    sockets[0]!.send(response(result("hello withdrawn", 5), 3));
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "partial", text: "hello withdrawn" }));
    sockets[0]!.terminate();
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "disconnected", recoverable: true }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const recovering = instance.recover();
    expect(instance.recover()).toBe(recovering);
    await vi.waitFor(() => expect(captures[1]).toHaveLength(1));
    expect(events.at(-1)).toEqual({ type: "stable", text: "" });
    instance.appendAudio(audio(100, 8)); expected.push(Buffer.alloc(3_200, 8));
    let stopped = false;
    const stopping = instance.flushAudio().then(() => { stopped = true; });
    sockets[1]!.send(response({}));
    await roundTrip(sockets[1]!);
    sockets[1]!.send(response(result("revised draft", 7), 2));
    await roundTrip(sockets[1]!);
    expect(events.at(-1)).toEqual({ type: "partial", text: "revised draft" });
    for (let tick = 0; captures[1]!.at(-1)?.sequence! >= 0 && tick < 310; tick += 1) {
      await vi.advanceTimersByTimeAsync(200);
      await roundTrip(sockets[1]!);
    }
    await recovering;
    expect(captures[1]!.at(-1)?.sequence).toBeLessThan(0);
    expect(stopped).toBe(false);
    const replay = captures[1]!.slice(1);
    expect(Buffer.concat(replay.map((packet) => packet.data))).toEqual(Buffer.concat(expected));
    expect(replay.every((packet) => packet.data.length <= 6_400)).toBe(true);
    expect(headers.map((header) => header["x-api-app-key"])).toEqual(["original-application", "original-application"]);
    expect(headers.map((header) => header["x-api-access-key"])).toEqual(["original-token", "original-token"]);
    expect(headers.every((header) => header["x-api-key"] === undefined)).toBe(true);
    expect(captures[1]![0]!.data).toEqual(captures[0]![0]!.data);
    expect(JSON.parse(captures[1]![0]!.data.toString()).request.corpus.context).toBe(JSON.stringify({
      hotwords: [{ word: "VoiceKit" }], context_type: "dialog_ctx", context_data: [{ text: "Frozen recording context." }]
    }));
    expect(headers[1]!["x-api-connect-id"]).not.toBe(headers[0]!["x-api-connect-id"]);
    sockets[1]!.send(response(result("revised complete recording"), Math.abs(replay.at(-1)!.sequence!), true));
    await stopping;
    expect(events.filter((event) => event.type === "stable")).toEqual([{ type: "stable", text: "hello" },
      { type: "stable", text: "" }, { type: "stable", text: "revised" }, { type: "stable", text: "revised complete recording" }]);
  }, 15_000);

  it("allows a new recognition to revise the old prefix and rejects divergent stable text within that generation", async () => {
    const sockets: WebSocket[] = [];
    const route = await fixture((socket) => sockets.push(socket));
    const { instance, events } = provider(route);
    await instance.start({ runId: "run", mimeType: "audio/pcm" });
    instance.appendAudio(audio(200));
    sockets[0]!.send(response(result("known"), 2));
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "stable", text: "known" }));
    sockets[0]!.terminate();
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("disconnected"));
    const recovery = instance.recover();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await roundTrip(sockets[1]!);
    sockets[1]!.send(response(result("different"), 2));
    await recovery;
    await roundTrip(sockets[1]!);
    expect(events.filter((event) => event.type === "stable")).toEqual([{ type: "stable", text: "known" },
      { type: "stable", text: "" }, { type: "stable", text: "different" }]);
    sockets[1]!.send(response(result("conflicting"), 3));
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("error"));
    expect(events.at(-1)).toEqual({ type: "error", category: "protocol", recoverable: false });
  });

  it("allocates PCM only for capture, retains one private owner across recovery, and zeroes it on terminal receipt", async () => {
    const allocate = Buffer.alloc;
    const owners: Buffer[] = [];
    vi.spyOn(Buffer, "alloc").mockImplementation((size, fill, encoding) => {
      const buffer = allocate(size, fill, encoding);
      if (size >= 1024 * 1024) owners.push(buffer);
      return buffer;
    });
    const sockets: WebSocket[] = []; const sent: Packet[][] = [];
    const route = await fixture((socket, _request, _index, packets) => { sockets.push(socket); sent.push(packets); });
    const unused = provider(route);
    const { instance, events } = provider(route);
    expect(await probeSaucTranscriptionRoute(route)).toEqual({ ok: true });
    await instance.start({ runId: "run", mimeType: "audio/pcm" });
    expect(owners.length).toBe(0);
    instance.appendAudio(audio(200, 9));
    expect(owners).toHaveLength(1);
    expect(owners[0]).toHaveLength(MAXIMUM_AUDIO_BYTES);
    sockets[1]!.terminate();
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("disconnected"));
    await instance.recover();
    expect(owners).toHaveLength(1);
    await flushWithResult(instance, sent[2]!, sockets[2]!, "complete");
    expect(owners[0]!.every(byte => byte === 0)).toBe(true);
    await unused.instance.stop();
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

  it("fails cumulative capture overflow and rejects forged PCM duration", async () => {
    const route = await fixture(() => {}, false);
    const { instance, events } = provider(route);
    const started = expect(instance.start({ runId: "run", mimeType: "audio/pcm" })).rejects.toMatchObject({ code: "protocol" });
    for (let index = 0; index < 60; index += 1) instance.appendAudio(audio(10_000));
    expect(events).toEqual([]);
    instance.appendAudio(audio(10_000));
    await started;
    expect(events.at(-1)).toEqual({ type: "error", category: "protocol", recoverable: false });
    const second = provider(await fixture(() => {}));
    await second.instance.start({ runId: "run", mimeType: "audio/pcm" });
    second.instance.appendAudio({ ...audio(100), durationMs: 10 });
    expect(second.events.at(-1)).toEqual({ type: "error", category: "protocol", recoverable: false });
  });

  it.each((["startup", "flush", "recovery"] as const).flatMap((stage) =>
    (["stop", "retire"] as const).map((action) => ({ stage, action }))
  ))("$action during $stage fences late provider results", async ({ stage, action }) => {
    const allocate = Buffer.alloc;
    let capture: Buffer | undefined;
    vi.spyOn(Buffer, "alloc").mockImplementation((size, fill, encoding) => {
      const buffer = allocate(size, fill, encoding);
      if (size === MAXIMUM_AUDIO_BYTES) capture = buffer;
      return buffer;
    });
    const sockets: WebSocket[] = []; const sent: Packet[][] = [];
    const route = await fixture((socket, _request, _index, packets) => { sockets.push(socket); sent.push(packets); }, stage !== "startup");
    let current = true;
    const { instance, events } = provider({ ...route, isCurrent: () => current });
    let pending: Promise<void>;
    if (stage === "startup") {
      pending = instance.start({ runId: "run", mimeType: "audio/pcm" });
      instance.appendAudio(audio(200));
    }
    else {
      await instance.start({ runId: "run", mimeType: "audio/pcm" });
      instance.appendAudio(audio(stage === "recovery" ? 400 : 200));
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
    if (action === "retire") current = false;
    sockets.at(-1)!.send(response(result("late"), 10, true));
    if (action === "stop") await instance.stop();
    await rejected;
    expect(capture?.subarray(0, 400 * 32).every(byte => byte === 0)).toBe(true);
    await vi.waitFor(() => expect(sockets.every((socket) => socket.readyState === 3)).toBe(true));
    expect(events).toEqual(before);
    expect(sockets).toHaveLength(stage === "recovery" ? 2 : 1);
    await expect(instance.recover()).rejects.toMatchObject({ code: action === "retire" ? "stopped" : "network" });
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
    const publicRoute = { endpoint: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async", resourceId: "volc.seedasr.sauc.duration", mode: "asyncTwoPass" as const };
    expect(validateSaucTranscriptionConfiguration(publicRoute)).toEqual(publicRoute);
    for (const secret of ["", "x\r\nAuthorization: stolen", " ", "x".repeat(8_193)]) {
      for (const authentication of [{ type: "apiKey", apiKey: secret }, { type: "accessToken", appId: "application", accessToken: secret }] as const) {
        expect(() => validateSaucTranscriptionRoute({ ...publicRoute, authentication })).toThrow();
      }
    }
    for (const authentication of [undefined, null, { type: "apiKey", apiKey: "valid", appId: "mixed" },
      { type: "accessToken", appId: "application", accessToken: "valid", apiKey: "mixed" },
      { type: "accessToken", appId: "", accessToken: "valid" }, { type: "accessToken", appId: "x\r\nX-Api-Key: stolen", accessToken: "valid" },
      { type: "apiKey" }, { type: "accessToken", appId: "application" }, { type: "guessed", apiKey: "valid" }]) {
      expect(() => validateSaucTranscriptionRoute({ ...publicRoute, authentication } as SaucTranscriptionRoute)).toThrow();
    }
    for (const extra of [{ apiKey: "old-shape" }, { authentication: { type: "apiKey", apiKey: "valid" }, apiKey: "mixed-shape" }]) {
      expect(() => validateSaucTranscriptionRoute({ ...publicRoute, ...extra } as unknown as SaucTranscriptionRoute)).toThrow();
    }
    for (const corpus of [null, { context: "untyped" }, { regexCorrectTableId: "outside-scope" }, { boostingTableId: "" },
      { boostingTableId: " leading" }, { correctTableName: "x\u0085invalid" }, { correctTableId: "x".repeat(257) }]) {
      expect(() => validateSaucTranscriptionConfiguration({ ...publicRoute, corpus } as SaucTranscriptionRoute)).toThrow();
    }
    for (const endpoint of ["ws://example.com/api/v3/sauc/bigmodel_async", `${publicRoute.endpoint}?key=secret`, `${publicRoute.endpoint}#secret`,
      "wss://key@example.com/api/v3/sauc/bigmodel_async", "wss://example.com/api/v3/sauc/bigmodel_nostream", "wss://example.com/api/v3/sauc/bigmodel"]) {
      expect(() => validateSaucTranscriptionConfiguration({ ...publicRoute, endpoint })).toThrow();
    }
    expect(() => validateSaucTranscriptionConfiguration({ ...publicRoute, resourceId: "guessed-model" })).toThrow();
    expect(() => validateSaucTranscriptionConfiguration({ ...publicRoute, mode: "guessed" as SaucTranscriptionMode })).toThrow();
    expect(SAUC_SUPPORTED_LOCALES).toHaveLength(25);
    expect(SAUC_SUPPORTED_LOCALES.map(validateSaucLocale)).toEqual(SAUC_SUPPORTED_LOCALES);
    expect(validateSaucLocale(undefined)).toBeUndefined();
    for (const locale of [null, "en", "zh-TW", "ja-jp", "", " ja-JP", "ro-R0"]) expect(() => validateSaucLocale(locale)).toThrow();
  });

  it("rejects retired starts or recovery and unsupported stream-input locales before opening a socket", async () => {
    let connections = 0;
    let socket!: WebSocket;
    const route = await fixture((connected) => { connections += 1; socket = connected; });
    const retired = provider({ ...route, isCurrent: () => false });
    await expect(retired.instance.start({ runId: "retired", mimeType: "audio/pcm" })).rejects.toMatchObject({ code: "stopped" });
    expect(retired.events).toEqual([]);
    const locale = provider({ ...route, mode: "streamInput", endpoint: route.endpoint.replace("bigmodel_async", "bigmodel_nostream") });
    await expect(locale.instance.start({ runId: "unsupported-locale", mimeType: "audio/pcm", locale: "zh-TW" })).rejects.toMatchObject({ code: "protocol" });
    expect(connections).toBe(0);
    let current = true;
    const active = provider({ ...route, isCurrent: () => current });
    await active.instance.start({ runId: "initially-current", mimeType: "audio/pcm" });
    socket.terminate();
    await vi.waitFor(() => expect(active.events.at(-1)).toEqual({ type: "disconnected", recoverable: true }));
    current = false;
    await expect(active.instance.recover()).rejects.toMatchObject({ code: "stopped" });
    expect(connections).toBe(1);
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
    const route: SaucTranscriptionRoute = { endpoint: `ws://127.0.0.1:${address.port}/api/v3/sauc/bigmodel_async`, resourceId: "volc.seedasr.sauc.duration",
      mode: "asyncTwoPass", authentication: { type: "apiKey", apiKey: "key" } };
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

  it("aborts only the original readiness probe and closes its socket before the deadline", async () => {
    const sockets: WebSocket[] = []; const packets: Packet[][] = [];
    const route = { ...await fixture((socket, _request, _index, sent) => { sockets.push(socket); packets.push(sent); }, false), connectTimeoutMs: 5_000 };
    const cancellation = new AbortController();
    const canceled = probeSaucTranscriptionRoute(route, { signal: cancellation.signal });
    await vi.waitFor(() => expect(packets[0]).toHaveLength(1));
    const sibling = probeSaucTranscriptionRoute(route);
    await vi.waitFor(() => expect(packets[1]).toHaveLength(1));
    cancellation.abort();
    await expect(canceled).resolves.toEqual({ ok: false, reason: "serviceError" });
    await vi.waitFor(() => expect(sockets[0]!.readyState).toBe(3));
    expect(sockets[1]!.readyState).toBe(1);
    sockets[1]!.send(response({}));
    await expect(sibling).resolves.toEqual({ ok: true });
    expect(packets.map((sent) => sent.map((packet) => packet.type))).toEqual([[1], [1]]);
  });
});
