import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { assertHostedExecution, type HostedExecution } from "@joko/core";
import type { CodexHostedExecServerLease } from "@joko/adapter-codex";

const MAXIMUM_NATIVE_BYTES = 48 * 1024 * 1024;
const MAXIMUM_WIRE_BYTES = 64 * 1024 * 1024;
interface Connection {
  readonly id: string;
  readonly socket: WebSocket;
  readonly lifetime: AbortController;
  tail: Promise<void>;
  queuedBytes: number;
  opened: boolean;
  cleanup?: Promise<void>;
}

/** Private Model Host listener. It delegates every native record to the Source. */
export async function createHostedAgentCodexTunnel(execution: HostedExecution): Promise<CodexHostedExecServerLease> {
  assertHostedExecution(execution);
  return createCodexExecServerTunnel({ assertCurrent: () => assertHostedExecution(execution), execute: async (request, signal) => {
    const body = JSON.stringify(request);
    const response = await fetch(execution.channel.endpoint + "/execute", { method: "POST", redirect: "error", signal,
      headers: { authorization: "Bearer " + execution.channel.bearer, "content-type": "application/json" }, body });
    const chunks: Uint8Array[] = []; let bytes = 0;
    const reader = response.body?.getReader();
    if (reader) try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength; if (bytes > MAXIMUM_WIRE_BYTES) { await reader.cancel(); throw new Error("Native execution reply exceeds its limit."); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    assertHostedExecution(execution); signal.throwIfAborted();
    const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!response.ok || !decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("The task executor is unavailable.");
    const result = decoded as Record<string, unknown>;
    if (result.format !== 1 || result.ok !== true || !result.value || typeof result.value !== "object" || Array.isArray(result.value)) throw new Error("The task executor rejected the native operation.");
    return result.value as Record<string, unknown>;
  } });
}

/** Same private authenticated native listener for local and Source execution.
 * The execute port is in-memory service authority, never a public endpoint. */
export async function createCodexExecServerTunnel<Owner = unknown>(options: {
  readonly assertCurrent: () => void;
  /** Capture at wire ingress, before either delivery queue can change turns. */
  readonly capture?: () => Owner;
  readonly execute: (request: Readonly<Record<string, unknown>>, signal: AbortSignal, owner?: Owner) => Promise<Record<string, unknown>>;
}): Promise<CodexHostedExecServerLease> {
  options.assertCurrent();
  const bearer = randomBytes(32).toString("base64url"), expected = Buffer.from("Bearer " + bearer);
  const server = createServer((_request, response) => response.writeHead(404).end());
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAXIMUM_NATIVE_BYTES, perMessageDeflate: false });
  const lifetime = new AbortController(), connections = new Set<Connection>();
  let closing: Promise<void> | undefined;
  const assertCurrent = () => { lifetime.signal.throwIfAborted(); options.assertCurrent(); };
  const request = async (connection: Connection, kind: "open" | "message" | "poll" | "close", data?: string, owner?: Owner): Promise<Record<string, unknown>> => {
    assertCurrent();
    const signal = AbortSignal.any([lifetime.signal, connection.lifetime.signal, AbortSignal.timeout(kind === "poll" ? 60_000 : 10 * 60_000)]);
    const input = { format: 1, origin: "agent", callId: connection.id, requestId: randomUUID(),
      operation: "codex.exec_server", payload: { kind, connectionId: connection.id, ...(data === undefined ? {} : { data }) } };
    if (Buffer.byteLength(JSON.stringify(input)) > MAXIMUM_WIRE_BYTES) throw new Error("Native execution record exceeds its limit.");
    const result = await options.execute(input, signal, owner);
    assertCurrent(); signal.throwIfAborted(); return result;
  };
  const drop = (connection: Connection) => {
    connection.lifetime.abort(); connection.socket.terminate(); connections.delete(connection);
  };
  const closeSource = (connection: Connection): Promise<void> => connection.cleanup ??= (async () => {
    try { if (connection.opened && !connection.lifetime.signal.aborted && !lifetime.signal.aborted) await request(connection, "close"); }
    finally { drop(connection); }
  })();
  const pump = async (connection: Connection) => {
    try {
      while (!connection.lifetime.signal.aborted) {
        const value = await request(connection, "poll");
        if (!Array.isArray(value.messages) || value.messages.some(message => typeof message !== "string" || Buffer.byteLength(message) > MAXIMUM_NATIVE_BYTES)
          || typeof value.closed !== "boolean") throw new Error("The native executor returned an invalid output record.");
        for (const message of value.messages as string[]) {
          assertCurrent(); connection.lifetime.signal.throwIfAborted();
          if (connection.socket.bufferedAmount > MAXIMUM_WIRE_BYTES) throw new Error("The native process stopped reading its execution output.");
          await new Promise<void>((resolve, reject) => connection.socket.send(message, { binary: false }, error => error ? reject(error) : resolve()));
        }
        if (value.closed) { connection.socket.close(1000); return; }
      }
    } catch { drop(connection); }
  };
  server.on("upgrade", (incoming, socket, head) => {
    const supplied = Buffer.from(incoming.headers.authorization ?? "");
    try {
      assertCurrent();
      if (incoming.url !== "/ws/exec-server" || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)
        || connections.size >= 16) throw new Error();
      sockets.handleUpgrade(incoming, socket, head, websocket => sockets.emit("connection", websocket));
    } catch { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); socket.destroy(); }
  });
  sockets.on("connection", socket => {
    const connection: Connection = { id: randomUUID(), socket, lifetime: new AbortController(), tail: Promise.resolve(), queuedBytes: 0, opened: false };
    connections.add(connection);
    connection.tail = request(connection, "open").then(() => { connection.opened = true; void pump(connection); }).catch(() => drop(connection));
    socket.on("message", (data: RawData, binary: boolean) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (binary || connection.queuedBytes + bytes.byteLength > MAXIMUM_WIRE_BYTES || bytes.includes(0)) { drop(connection); return; }
      const text = bytes.toString("utf8");
      if (!Buffer.from(text).equals(bytes)) { drop(connection); return; }
      let owner: Owner | undefined;
      try { assertCurrent(); owner = options.capture?.(); } catch { drop(connection); return; }
      connection.queuedBytes += bytes.byteLength;
      connection.tail = connection.tail.then(async () => {
        if (!connection.opened) return;
        try { await request(connection, "message", text, owner); }
        finally { connection.queuedBytes -= bytes.byteLength; }
      }).catch(() => drop(connection));
    });
    socket.once("error", () => drop(connection));
    socket.once("close", () => {
      void closeSource(connection).catch(() => undefined);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
    assertCurrent();
  } catch { lifetime.abort(); server.closeAllConnections(); server.close(); throw new Error("The native execution tunnel could not start."); }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The native execution tunnel has no listener.");
  return { execServerUrl: `ws://127.0.0.1:${address.port}/ws/exec-server`, authBearerToken: bearer, assertCurrent,
    close() { return closing ??= (async () => {
      const opened = [...connections].filter(connection => connection.opened && !connection.lifetime.signal.aborted);
      // SourceController owns native executor retirement even after its ordinary
      // execution authority has been revoked. This lease owns the local listener.
      await Promise.allSettled(opened.map(connection => closeSource(connection)));
      lifetime.abort(); for (const connection of connections) drop(connection);
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    })(); }
  };
}
