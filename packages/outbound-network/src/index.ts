import { connect as netConnect, type Socket, type TcpNetConnectOpts } from "node:net";

import { Agent, buildConnector, type Dispatcher } from "undici";

const SOCKS_VERSION = 0x05;
const AUTHENTICATION_NONE = 0x00;
const AUTHENTICATION_USERNAME_PASSWORD = 0x02;
const CONNECT_COMMAND = 0x01;
const DOMAIN_ADDRESS = 0x03;
const HANDSHAKE_TIMEOUT_MS = 15_000;

interface Socks5ProxyTarget {
  readonly hostname: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  readonly safeUrl: string;
}

/** Create an undici dispatcher whose SOCKS5 CONNECT request always carries the upstream hostname. */
export function createSocks5Dispatcher(proxyUrl: string): Dispatcher {
  const proxy = parseSocks5Proxy(proxyUrl);
  const tlsConnector = buildConnector({ timeout: HANDSHAKE_TIMEOUT_MS });
  const connect: buildConnector.connector = (options, callback) => {
      const protocol = options.protocol === "https:" ? "https:" : "http:";
      const port = Number(options.port) || (protocol === "https:" ? 443 : 80);
      connectSocks5Target(proxy, stripIpv6Brackets(options.hostname), port)
        .then((socket) => {
          if (protocol === "http:") {
            callback(null, socket);
            return;
          }
          tlsConnector({ ...options, httpSocket: socket }, callback);
        })
        .catch((error: unknown) => callback(
          error instanceof Error ? error : new Error("The SOCKS5 connection failed."),
          null
        ));
  };
  return new Agent({ connect });
}

/** Testable private transport primitive; destination DNS is deliberately delegated to the proxy. */
export async function connectSocks5Tunnel(
  proxyUrl: string,
  destinationHostname: string,
  destinationPort: number
): Promise<Socket> {
  return connectSocks5Target(parseSocks5Proxy(proxyUrl), destinationHostname, destinationPort);
}

async function connectSocks5Target(
  proxy: Socks5ProxyTarget,
  destinationHostname: string,
  destinationPort: number
): Promise<Socket> {
  const destination = encodeDestination(destinationHostname, destinationPort, proxy.safeUrl);
  const socket = netConnect({
    host: proxy.hostname,
    port: proxy.port,
    autoSelectFamilyAttemptTimeout: 2_500
  } as TcpNetConnectOpts & { autoSelectFamilyAttemptTimeout: number });
  socket.setNoDelay(true);
  const reader = socketReader(socket, proxy.safeUrl);
  const timeout = setTimeout(() => {
    const error = new Error(`SOCKS5 proxy ${proxy.safeUrl} handshake timed out.`);
    reader.fail(error);
    socket.destroy(error);
  }, HANDSHAKE_TIMEOUT_MS);
  timeout.unref?.();
  try {
    await waitForConnect(socket, proxy.safeUrl);
    const methods = proxy.username === undefined
      ? [AUTHENTICATION_NONE]
      : [AUTHENTICATION_NONE, AUTHENTICATION_USERNAME_PASSWORD];
    socket.write(Buffer.from([SOCKS_VERSION, methods.length, ...methods]));
    const greeting = await reader.read(2);
    if (greeting[0] !== SOCKS_VERSION) throw protocolError(proxy.safeUrl);
    if (greeting[1] === AUTHENTICATION_USERNAME_PASSWORD) {
      if (proxy.username === undefined) throw protocolError(proxy.safeUrl);
      const username = Buffer.from(proxy.username, "utf8");
      const password = Buffer.from(proxy.password ?? "", "utf8");
      socket.write(Buffer.concat([
        Buffer.from([0x01, username.byteLength]),
        username,
        Buffer.from([password.byteLength]),
        password
      ]));
      const authenticated = await reader.read(2);
      if (authenticated[0] !== 0x01 || authenticated[1] !== 0x00) {
        throw new Error(`SOCKS5 proxy ${proxy.safeUrl} rejected authentication.`);
      }
    } else if (greeting[1] !== AUTHENTICATION_NONE) {
      throw new Error(`SOCKS5 proxy ${proxy.safeUrl} has no supported authentication method.`);
    }

    socket.write(Buffer.concat([
      Buffer.from([SOCKS_VERSION, CONNECT_COMMAND, 0x00]),
      destination
    ]));
    const reply = await reader.read(4);
    if (reply[0] !== SOCKS_VERSION || reply[2] !== 0x00) throw protocolError(proxy.safeUrl);
    if (reply[1] !== 0x00) {
      throw new Error(`SOCKS5 proxy ${proxy.safeUrl} rejected the CONNECT request.`);
    }
    switch (reply[3]) {
      case 0x01:
        await reader.read(6);
        break;
      case DOMAIN_ADDRESS: {
        const length = (await reader.read(1))[0] ?? 0;
        await reader.read(length + 2);
        break;
      }
      case 0x04:
        await reader.read(18);
        break;
      default:
        throw protocolError(proxy.safeUrl);
    }
    clearTimeout(timeout);
    reader.release();
    return socket;
  } catch (error) {
    clearTimeout(timeout);
    reader.release();
    socket.on("error", () => undefined);
    socket.destroy();
    throw error instanceof Error ? error : new Error(`SOCKS5 proxy ${proxy.safeUrl} failed.`);
  }
}

function parseSocks5Proxy(value: string): Socks5ProxyTarget {
  let proxy: URL;
  try {
    proxy = new URL(value);
  } catch {
    throw new TypeError("The SOCKS5 proxy URL is invalid.");
  }
  if (
    (proxy.protocol !== "socks5:" && proxy.protocol !== "socks5h:")
    || proxy.hostname === ""
    || (proxy.pathname !== "" && proxy.pathname !== "/")
    || proxy.search !== ""
    || proxy.hash !== ""
  ) throw new TypeError("The SOCKS5 proxy URL is invalid.");
  const port = proxy.port === "" ? 1080 : Number(proxy.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("The SOCKS5 proxy URL is invalid.");
  }
  const username = decodeUserInfo(proxy.username);
  const password = decodeUserInfo(proxy.password);
  if (username === "" && password !== "") throw new TypeError("The SOCKS5 proxy URL is invalid.");
  if (Buffer.byteLength(username, "utf8") > 255 || Buffer.byteLength(password, "utf8") > 255) {
    throw new TypeError("The SOCKS5 proxy credentials exceed the protocol limit.");
  }
  const hostname = stripIpv6Brackets(proxy.hostname);
  return {
    hostname,
    port,
    ...(username === "" ? {} : { username, password }),
    safeUrl: `socks5://${formatHost(hostname)}:${port}`
  };
}

function encodeDestination(hostname: string, port: number, safeProxyUrl: string): Buffer {
  const host = Buffer.from(stripIpv6Brackets(hostname), "utf8");
  if (
    host.byteLength < 1
    || host.byteLength > 255
    || !Number.isSafeInteger(port)
    || port < 1
    || port > 65_535
  ) throw new Error(`SOCKS5 proxy ${safeProxyUrl} received an invalid destination.`);
  const portBytes = Buffer.allocUnsafe(2);
  portBytes.writeUInt16BE(port);
  return Buffer.concat([Buffer.from([DOMAIN_ADDRESS, host.byteLength]), host, portBytes]);
}

function socketReader(socket: Socket, safeProxyUrl: string): {
  readonly read: (bytes: number) => Promise<Buffer>;
  readonly fail: (error: Error) => void;
  readonly release: () => void;
} {
  let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let terminalError: Error | undefined;
  let waiter: {
    readonly bytes: number;
    readonly resolve: (value: Buffer) => void;
    readonly reject: (error: Error) => void;
  } | undefined;
  const settle = (): void => {
    if (waiter === undefined || buffered.byteLength < waiter.bytes) return;
    const pending = waiter;
    waiter = undefined;
    const value = buffered.subarray(0, pending.bytes);
    buffered = buffered.subarray(pending.bytes);
    pending.resolve(value);
  };
  const onData = (chunk: Buffer): void => {
    buffered = buffered.byteLength === 0 ? chunk : Buffer.concat([buffered, chunk]);
    settle();
  };
  const fail = (error: Error): void => {
    terminalError ??= error;
    const pending = waiter;
    waiter = undefined;
    pending?.reject(error);
  };
  const onError = (): void => fail(new Error(`SOCKS5 proxy ${safeProxyUrl} connection failed.`));
  const onClose = (): void => fail(new Error(`SOCKS5 proxy ${safeProxyUrl} closed during handshake.`));
  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);
  return {
    read: (bytes) => new Promise<Buffer>((resolve, reject) => {
      if (terminalError !== undefined) {
        reject(terminalError);
        return;
      }
      if (!Number.isSafeInteger(bytes) || bytes < 1 || waiter !== undefined) {
        reject(protocolError(safeProxyUrl));
        return;
      }
      waiter = { bytes, resolve, reject };
      settle();
    }),
    fail,
    release: () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (buffered.byteLength > 0 && !socket.destroyed) socket.unshift(buffered);
    }
  };
}

function waitForConnect(socket: Socket, safeProxyUrl: string): Promise<void> {
  if (!socket.connecting) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onConnect = (): void => finish();
    const onFailure = (): void => finish(new Error(`SOCKS5 proxy ${safeProxyUrl} is unreachable.`));
    const finish = (error?: Error): void => {
      socket.off("connect", onConnect);
      socket.off("error", onFailure);
      socket.off("close", onFailure);
      if (error === undefined) resolve(); else reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onFailure);
    socket.once("close", onFailure);
  });
}

function decodeUserInfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new TypeError("The SOCKS5 proxy URL is invalid.");
  }
}

function protocolError(safeProxyUrl: string): Error {
  return new Error(`SOCKS5 proxy ${safeProxyUrl} returned an invalid handshake.`);
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function formatHost(hostname: string): string {
  return hostname.includes(":") ? `[${hostname}]` : hostname;
}
