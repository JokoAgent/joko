import { createServer, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { connectSocks5Tunnel } from "./index.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("SOCKS5 dispatcher", () => {
  it("delegates destination DNS to the proxy using a domain CONNECT request", async () => {
    let requestedHost = "";
    let requestedPort = 0;
    const server = createServer((socket) => acceptAnonymousTunnel(socket, (host, port) => {
      requestedHost = host;
      requestedPort = port;
    }));
    servers.push(server);
    const port = await listen(server);

    const socket = await connectSocks5Tunnel(
      `socks5://127.0.0.1:${port}`,
      "remote-dns-only.example",
      443
    );
    socket.destroy();

    expect(requestedHost).toBe("remote-dns-only.example");
    expect(requestedPort).toBe(443);
  });

  it("never includes explicit SOCKS credentials in transport errors", async () => {
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.write(Buffer.from([0x05, 0x02]));
        socket.once("data", () => socket.write(Buffer.from([0x01, 0x01])));
      });
    });
    servers.push(server);
    const port = await listen(server);

    const failure = await connectSocks5Tunnel(
      `socks5://proxy-user:proxy-secret@127.0.0.1:${port}`,
      "remote-dns-only.example",
      443
    ).catch((error: unknown) => error);

    expect(String(failure)).toContain(`socks5://127.0.0.1:${port}`);
    expect(String(failure)).not.toContain("proxy-user");
    expect(String(failure)).not.toContain("proxy-secret");
  });
});

function acceptAnonymousTunnel(
  socket: Socket,
  onRequest: (hostname: string, port: number) => void
): void {
  socket.once("data", () => {
    socket.write(Buffer.from([0x05, 0x00]));
    socket.once("data", (request: Buffer) => {
      const domainLength = request[4] ?? 0;
      onRequest(
        request.subarray(5, 5 + domainLength).toString("utf8"),
        request.readUInt16BE(5 + domainLength)
      );
      socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
    });
  });
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (typeof address === "object" && address !== null) resolve(address.port);
      else reject(new Error("SOCKS5 test server did not bind."));
    });
  });
}
