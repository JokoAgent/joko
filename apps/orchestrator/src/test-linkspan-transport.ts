import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { acceptWebSocket, type Identity } from "@jokoagent/linkspan-noise";
import { serveHttp } from "@jokoagent/linkspan-http/node";

/** Real encrypted carrier around an existing loopback business test listener. */
export function attachTestLinkspanTransport(server: Server, backendOrigin: string, identity: Identity): () => Promise<void> {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
  const lifetime = new AbortController();
  const upgrade = (request: import("node:http").IncomingMessage, socket: import("node:net").Socket, head: Buffer): void => {
    if (request.url !== "/_linkspan") return;
    sockets.handleUpgrade(request, socket, head, ws => {
      void acceptWebSocket(ws, { identity, signal: lifetime.signal })
        .then(channel => serveHttp(channel, { origin: backendOrigin, signal: lifetime.signal }))
        .catch(() => ws.terminate());
    });
  };
  server.on("upgrade", upgrade);
  return async () => {
    lifetime.abort();
    server.removeListener("upgrade", upgrade);
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
  };
}
