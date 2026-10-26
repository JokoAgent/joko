import { createServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer, type ServerOptions as HttpsOptions } from "node:https";
import type { Socket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { acceptWebSocket } from "@jokoagent/linkspan-noise";
import { serveHttp } from "@jokoagent/linkspan-http/node";
import type { OrchestratorApplication } from "./application.js";
import { ConnectionAuthenticationError } from "./connection-manager.js";
import type { ByteChannel } from "@jokoagent/linkspan-core";

/** All carriers share these exact application handlers and revocation gates. */
export function serveLinkspanChannel(application: OrchestratorApplication, channel: ByteChannel, backendOrigin: string, signal: AbortSignal): Promise<void> {
  return serveHttp(channel, { origin: backendOrigin, signal, authorize: ({ headers }) => {
    const authorization = headers.get("authorization");
    if (authorization === null) return;
    let connection;
    try { connection = application.connections.authenticate(authorization); }
    catch (error) { if (error instanceof ConnectionAuthenticationError) return; throw error; }
    const dispose = application.connections.onRevoked(connection.id, () => channel.abort(new Error("Connection was revoked.")));
    try { application.connections.authenticate(authorization); } catch (error) { dispose(); throw error; }
    return dispose;
  } });
}

/** This listener never serves application HTML, business HTTP, or a redirect. */
export function createLinkspanIngress(application: OrchestratorApplication, input: {
  readonly backendOrigin: string;
  readonly server?: HttpServer | HttpsServer;
  readonly tls?: HttpsOptions;
}) {
  const identity = application.linkspanIdentity;
  if (identity === undefined) throw new Error("The endpoint identity is unavailable.");
  const ownsServer = input.server === undefined;
  if (input.server !== undefined && input.tls !== undefined) throw new Error("The host already owns this listener's TLS configuration.");
  const encryptedOnly: import("node:http").RequestListener = (_request, response) => {
    response.writeHead(404, { "cache-control": "no-store", "content-type": "text/plain" });
    response.end("Encrypted endpoint only.");
  };
  const server = input.server ?? (input.tls === undefined ? createServer(encryptedOnly) : createHttpsServer(input.tls, encryptedOnly));
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
  const active = new Set<WebSocket>();
  const shutdown = new AbortController();
  let closePromise: Promise<void> | undefined;
  const upgrade = (request: import("node:http").IncomingMessage, socket: Socket, head: Buffer): void => {
    if (shutdown.signal.aborted || request.url !== "/_linkspan" || active.size >= 128) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroy());
      return;
    }
    webSockets.handleUpgrade(request, socket, head, ws => {
      active.add(ws);
      ws.once("close", () => active.delete(ws));
      void (async () => {
        const channel = await acceptWebSocket(ws, { identity, signal: shutdown.signal, deadline: Date.now() + 10_000 });
        await serveLinkspanChannel(application, channel, input.backendOrigin, shutdown.signal);
      })().catch(() => { ws.terminate(); });
    });
  };
  server.on("upgrade", upgrade);
  return {
    server,
    async listen(options: { readonly host: string; readonly port: number }): Promise<string> {
      if (!ownsServer) throw new Error("The host owns this listener.");
      shutdown.signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host, () => { server.removeListener("error", reject); resolve(); });
      });
      if (shutdown.signal.aborted) {
        await new Promise<void>(resolve => server.close(() => resolve()));
        throw new Error("Endpoint startup was interrupted.");
      }
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("The endpoint did not acquire a port.");
      return `${input.tls === undefined ? "http" : "https"}://${options.host.includes(":") ? `[${options.host}]` : options.host}:${address.port}`;
    },
    close(): Promise<void> {
      closePromise ??= (async () => {
        shutdown.abort();
        server.removeListener("upgrade", upgrade);
        for (const ws of active) ws.terminate();
        await new Promise<void>(resolve => { webSockets.close(() => resolve()); });
        if (ownsServer) await new Promise<void>((resolve, reject) => {
          server.close(error => error === undefined || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING" ? resolve() : reject(error));
          server.closeAllConnections();
        });
      })();
      return closePromise;
    }
  };
}
