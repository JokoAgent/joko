import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer as createTcpServer, connect as connectTcp, type AddressInfo, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ssh2, {
  type Attributes,
  type Connection,
  type FileEntry,
  type ServerChannel,
  type SFTPWrapper
} from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteSshError } from "./errors.js";
import { Ssh2ResolvedAgentAuthConnector } from "./ssh2-connector.js";

const { Server, utils } = ssh2;

const hostPrivateKey = rsaPrivateKey();
const userPrivateKey = rsaPrivateKey();
const otherPrivateKey = rsaPrivateKey();
const allowedUserKey = parsedPrivateKey(userPrivateKey);

interface TestSshServer {
  readonly port: number;
  readonly commands: string[];
  openForwarded(remotePort: number): Promise<ServerChannel>;
  close(): Promise<void>;
}

const servers: TestSshServer[] = [];
const tcpServers: TcpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tcpServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("Ssh2ResolvedAgentAuthConnector", () => {
  it("performs a real private-key handshake, async host verification, bounded exec, streaming process, and close", async () => {
    const server = await startSshServer();
    const authenticationStates: string[] = [];
    const presented: Array<{ algorithm: string; key: Uint8Array }> = [];
    const connector = new Ssh2ResolvedAgentAuthConnector({ readyTimeoutMs: 2_000, keepaliveIntervalMs: 0 });
    const connection = await connector.connect({
      hostname: "127.0.0.1",
      port: server.port,
      user: "maker",
      authentication: { kind: "private_key", privateKey: Buffer.from(userPrivateKey) },
      signal: new AbortController().signal,
      verifyHostKey: async (key) => {
        await Promise.resolve();
        presented.push(key);
      },
      onAuthenticating: () => authenticationStates.push("authenticating")
    });

    expect(authenticationStates).toEqual(["authenticating"]);
    expect(presented).toHaveLength(1);
    expect(presented[0]?.algorithm).toBe("ssh-rsa");
    expect(connection.capabilities).toEqual({
      commandExecution: true,
      processStreaming: true,
      fileTransfer: true,
      tcpForwarding: true
    });

    const command = await connection.execute!({
      command: "bounded-output",
      cwd: "/workspace with quote'",
      timeoutMs: 1_000,
      maxOutputBytes: 8,
      signal: new AbortController().signal
    });
    expect(command).toMatchObject({ stdout: "abcdefgh", stderr: "warning", outputCapped: true });
    expect(server.commands[0]).toBe("cd -- '/workspace with quote'\"'\"'' && bounded-output");

    const process = await connection.processes!.open({
      executable: "/opt/runtime bin/node",
      args: ["rpc", "one'arg"],
      cwd: "/workspace",
      env: { SAFE_VALUE: "a b" }
    });
    const stdout = collect(process.stdout);
    process.stdin.end("request\n");
    const [exitCode, exitSignal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      process.once("exit", (code, signal) => resolve([code, signal]));
    });
    expect([exitCode, exitSignal]).toEqual([0, null]);
    expect(await stdout).toBe("request\n");
    expect(server.commands[1]).toBe(
      "cd -- '/workspace' && env 'SAFE_VALUE=a b' exec '/opt/runtime bin/node' 'rpc' 'one'\"'\"'arg'"
    );

    await connection.close();
    await expect(connection.execute!({
      command: "after-close",
      timeoutMs: 100,
      maxOutputBytes: 8,
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: "CONNECTION_FAILED" });
  });

  it("fails authentication without retry and never exposes key material", async () => {
    const server = await startSshServer();
    const connector = new Ssh2ResolvedAgentAuthConnector({ readyTimeoutMs: 1_000 });
    const secret = Buffer.from(otherPrivateKey);
    let error: unknown;
    try {
      await connector.connect({
        hostname: "127.0.0.1",
        port: server.port,
        user: "maker",
        authentication: { kind: "private_key", privateKey: secret },
        signal: new AbortController().signal,
        verifyHostKey: async () => undefined,
        onAuthenticating: () => undefined
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "AUTHENTICATION_FAILED", retryable: false });
    expect(JSON.stringify(error)).not.toContain(secret.subarray(0, 32).toString("utf8"));
  });

  it("authenticates through a real service-owned SSH agent endpoint", async () => {
    const endpoint = process.platform === "win32"
      ? `\\\\.\\pipe\\joko-ssh-agent-${randomUUID()}`
      : join(tmpdir(), `joko-ssh-agent-${randomUUID()}.sock`);
    const agent = createTcpServer((socket) => {
      const protocol = new ssh2.AgentProtocol(false);
      protocol.on("identities", (request) => protocol.getIdentitiesReply(request, [allowedUserKey]));
      protocol.on("sign", (request, publicKey, data, options) => {
        if (!publicKey.getPublicSSH().equals(allowedUserKey.getPublicSSH())) {
          protocol.failureReply(request);
          return;
        }
        protocol.signReply(request, allowedUserKey.sign(data, options.hash));
      });
      socket.pipe(protocol).pipe(socket);
    });
    tcpServers.push(agent);
    await new Promise<void>((resolve, reject) => {
      agent.once("error", reject);
      agent.listen(endpoint, resolve);
    });
    const server = await startSshServer();
    const connector = new Ssh2ResolvedAgentAuthConnector({ systemAgentEndpoint: endpoint, readyTimeoutMs: 2_000 });
    const connection = await connector.connect({
      hostname: "127.0.0.1",
      port: server.port,
      user: "maker",
      authentication: { kind: "system_agent" },
      signal: new AbortController().signal,
      verifyHostKey: async () => undefined,
      onAuthenticating: () => undefined
    });
    expect((await connection.execute!({
      command: "bounded-output",
      timeoutMs: 1_000,
      maxOutputBytes: 16,
      signal: new AbortController().signal
    })).stdout).toBe("abcdefghijklmnop");
    await connection.close();
  });

  it("preserves a fail-closed host-key verifier error", async () => {
    const server = await startSshServer();
    const connector = new Ssh2ResolvedAgentAuthConnector({ readyTimeoutMs: 1_000 });
    await expect(connector.connect({
      hostname: "127.0.0.1",
      port: server.port,
      user: "maker",
      authentication: { kind: "private_key", privateKey: Buffer.from(userPrivateKey) },
      signal: new AbortController().signal,
      verifyHostKey: async () => {
        throw new RemoteSshError("HOST_KEY_CHANGED", "The remote host key changed. Connection was refused.", false);
      },
      onAuthenticating: () => {
        throw new Error("must not authenticate");
      }
    })).rejects.toMatchObject({ code: "HOST_KEY_CHANGED", retryable: false });
  });

  it("closes an executing channel on timeout or abort", async () => {
    const server = await startSshServer();
    const connection = await connect(server.port);
    await expect(connection.execute!({
      command: "never-complete",
      timeoutMs: 20,
      maxOutputBytes: 1_024,
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: "EXECUTION_TIMEOUT" });
    const abort = new AbortController();
    const operation = connection.execute!({
      command: "never-complete",
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      signal: abort.signal
    });
    abort.abort();
    await expect(operation).rejects.toMatchObject({ code: "ABORTED" });
    await connection.close();
  });

  it("opens only remote-loopback forwarding over the authenticated connection", async () => {
    const target = createTcpServer((socket) => socket.pipe(socket));
    tcpServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetPort = (target.address() as AddressInfo).port;
    const server = await startSshServer();
    const connection = await connect(server.port);

    const stream = await connection.forwarding!.open({
      destinationHost: "127.0.0.1",
      destinationPort: targetPort
    });
    const reply = once(stream, "data");
    stream.write("forwarded");
    expect(String((await reply)[0])).toBe("forwarded");
    stream.end();
    await expect(connection.forwarding!.open({
      destinationHost: "0.0.0.0" as "127.0.0.1",
      destinationPort: targetPort
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await connection.close();
  });

  it("reverse-forwards a remote loopback listener to a service-node loopback endpoint", async () => {
    const localTarget = createTcpServer((socket) => socket.pipe(socket));
    tcpServers.push(localTarget);
    await new Promise<void>((resolve) => localTarget.listen(0, "127.0.0.1", resolve));
    const localPort = (localTarget.address() as AddressInfo).port;
    const server = await startSshServer();
    const connection = await connect(server.port);

    const listener = await connection.forwarding!.listen({
      localDestinationHost: "127.0.0.1",
      localDestinationPort: localPort,
      remoteListenHost: "127.0.0.1"
    });
    const remoteStream = await server.openForwarded(listener.remotePort);
    const reply = once(remoteStream, "data");
    remoteStream.write("reverse-forwarded");
    expect(String((await reply)[0])).toBe("reverse-forwarded");
    remoteStream.end();

    await listener.close();
    await connection.close();
  });

  it("uses a real SFTP subsystem for bounded atomic workspace file operations", async () => {
    const server = await startSshServer();
    const connection = await connect(server.port);
    const files = connection.files!;

    await expect(files.mkdir("/workspace/nested", { recursive: true, mode: 0o700 })).resolves.toBeUndefined();
    await expect(files.write({
      path: "/workspace/nested/note.txt",
      content: Buffer.from("remote content"),
      mode: 0o600,
      atomic: true
    })).resolves.toBeUndefined();
    expect(await files.realpath("/workspace/nested/note.txt")).toBe("/workspace/nested/note.txt");
    expect(await files.stat("/workspace/nested/note.txt")).toMatchObject({
      kind: "file",
      size: 14,
      mode: 0o600
    });
    expect(await files.list("/workspace/nested")).toEqual([
      { name: "note.txt", kind: "file" }
    ]);
    expect(Buffer.from(await files.read({
      path: "/workspace/nested/note.txt",
      maximumBytes: 64
    })).toString("utf8")).toBe("remote content");
    await expect(files.read({
      path: "/workspace/nested/note.txt",
      maximumBytes: 4
    })).rejects.toMatchObject({ code: "FILE_TRANSFER_FAILED" });
    expect(Buffer.from(await files.read({
      path: "/workspace/nested/note.txt",
      maximumBytes: 4,
      allowTruncated: true
    })).toString("utf8")).toBe("remo");

    await files.rename("/workspace/nested/note.txt", "/workspace/nested/renamed.txt");
    await files.remove("/workspace", { recursive: true });
    await expect(files.stat("/workspace")).rejects.toMatchObject({ code: "FILE_TRANSFER_FAILED" });
    await connection.close();
  });
});

async function connect(port: number) {
  const connector = new Ssh2ResolvedAgentAuthConnector({ readyTimeoutMs: 2_000 });
  return connector.connect({
    hostname: "127.0.0.1",
    port,
    user: "maker",
    authentication: { kind: "private_key", privateKey: Buffer.from(userPrivateKey) },
    signal: new AbortController().signal,
    verifyHostKey: async () => undefined,
    onAuthenticating: () => undefined
  });
}

async function startSshServer(): Promise<TestSshServer> {
  const commands: string[] = [];
  const clients = new Set<Connection>();
  let readyClient: Connection | undefined;
  let nextForwardedPort = 40_000;
  const server = new Server({ hostKeys: [hostPrivateKey] }, (client) => {
    clients.add(client);
    client.on("error", () => undefined);
    client.once("close", () => clients.delete(client));
    client.on("authentication", (context) => {
      if (context.username !== "maker" || context.method !== "publickey") {
        context.reject();
        return;
      }
      const allowed = context.key.algo === allowedUserKey.type &&
        context.key.data.equals(allowedUserKey.getPublicSSH()) &&
        (context.signature === undefined ||
          allowedUserKey.verify(context.blob!, context.signature, context.hashAlgo) === true);
      if (allowed) context.accept();
      else context.reject();
    });
    client.on("ready", () => {
      readyClient = client;
      client.on("request", (accept, reject, name, info) => {
        if (
          (info.bindAddr !== "127.0.0.1" && info.bindAddr !== "::1" && info.bindAddr !== "localhost") ||
          (name === "tcpip-forward" && info.bindPort !== 0)
        ) {
          reject?.();
          return;
        }
        if (name === "tcpip-forward") accept?.(nextForwardedPort++);
        else accept?.();
      });
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          commands.push(info.command);
          const stream = acceptExec();
          if (info.command.endsWith("never-complete")) return;
          if (info.command.endsWith("bounded-output")) {
            stream.stderr.write("warning");
            stream.write("abcdefghijklmnop");
            stream.exit(0);
            stream.end();
            return;
          }
          echoProcess(stream);
        });
        session.on("sftp", (acceptSftp) => installMemorySftp(acceptSftp()));
      });
      client.on("tcpip", (acceptForward, reject, info) => {
        if (
          (info.destIP !== "127.0.0.1" && info.destIP !== "::1" && info.destIP !== "localhost") ||
          info.srcIP !== "127.0.0.1"
        ) {
          reject();
          return;
        }
        const destination = connectTcp(info.destPort, info.destIP === "localhost" ? "127.0.0.1" : info.destIP);
        destination.once("connect", () => {
          const channel = acceptForward();
          channel.pipe(destination).pipe(channel);
        });
        destination.once("error", () => reject());
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const result: TestSshServer = {
    port: (server.address() as AddressInfo).port,
    commands,
    openForwarded: async (remotePort) => new Promise<ServerChannel>((resolve, reject) => {
      if (readyClient === undefined) {
        reject(new Error("SSH test client is not ready."));
        return;
      }
      readyClient.forwardOut(
        "127.0.0.1",
        remotePort,
        "127.0.0.1",
        45_000,
        (error, stream) => error === undefined ? resolve(stream) : reject(error)
      );
    }),
    close: async () => {
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
  servers.push(result);
  return result;
}

function echoProcess(stream: ServerChannel): void {
  stream.on("data", (chunk: Buffer | string) => stream.write(chunk));
  stream.once("end", () => {
    stream.exit(0);
    stream.end();
  });
  stream.on("signal", () => {
    stream.exit("TERM");
    stream.end();
  });
}

interface MemoryFile {
  readonly kind: "file" | "directory";
  content: Buffer;
  mode: number;
  modifiedAt: number;
}

interface MemoryHandle {
  readonly path: string;
  readonly kind: "file" | "directory";
  sent?: boolean;
}

function installMemorySftp(sftp: SFTPWrapper): void {
  const { OPEN_MODE, STATUS_CODE } = ssh2.utils.sftp;
  const files = new Map<string, MemoryFile>([[
    "/",
    { kind: "directory", content: Buffer.alloc(0), mode: 0o700, modifiedAt: Date.now() }
  ]]);
  const handles = new Map<number, MemoryHandle>();
  let nextHandle = 1;
  const okay = (requestId: number): void => sftp.status(requestId, STATUS_CODE.OK);
  const missing = (requestId: number): void => sftp.status(requestId, STATUS_CODE.NO_SUCH_FILE);
  const failure = (requestId: number): void => sftp.status(requestId, STATUS_CODE.FAILURE);
  const allocate = (requestId: number, handle: MemoryHandle): void => {
    const id = nextHandle++;
    handles.set(id, handle);
    const value = Buffer.alloc(4);
    value.writeUInt32BE(id);
    sftp.handle(requestId, value);
  };
  const resolveHandle = (handle: Buffer): MemoryHandle | undefined =>
    handle.byteLength === 4 ? handles.get(handle.readUInt32BE(0)) : undefined;

  sftp.on("REALPATH", (requestId: number, value: string) => {
    const path = memoryPath(value);
    if (path === undefined || !files.has(path)) {
      missing(requestId);
      return;
    }
    sftp.name(requestId, [{
      filename: path,
      longname: path,
      attrs: { mode: 0, size: 0, atime: 0, mtime: 0, uid: 0, gid: 0 }
    }]);
  });
  const sendStats = (requestId: number, value: string): void => {
    const path = memoryPath(value);
    const entry = path === undefined ? undefined : files.get(path);
    if (entry === undefined) {
      missing(requestId);
      return;
    }
    sftp.attrs(requestId, memoryAttrs(entry));
  };
  sftp.on("LSTAT", sendStats);
  sftp.on("STAT", sendStats);
  sftp.on("OPEN", (requestId: number, value: string, flags: number, attrs: Attributes) => {
    const path = memoryPath(value);
    if (path === undefined || !files.has(memoryParent(path))) {
      missing(requestId);
      return;
    }
    let entry = files.get(path);
    if (entry?.kind === "directory") {
      failure(requestId);
      return;
    }
    if (entry === undefined) {
      if ((flags & OPEN_MODE.CREAT) === 0) {
        missing(requestId);
        return;
      }
      entry = {
        kind: "file",
        content: Buffer.alloc(0),
        mode: typeof attrs.mode === "number" ? attrs.mode & 0o777 : 0o600,
        modifiedAt: Date.now()
      };
      files.set(path, entry);
    } else if ((flags & OPEN_MODE.EXCL) !== 0 && (flags & OPEN_MODE.CREAT) !== 0) {
      failure(requestId);
      return;
    }
    if ((flags & OPEN_MODE.TRUNC) !== 0) entry.content = Buffer.alloc(0);
    allocate(requestId, { path, kind: "file" });
  });
  sftp.on("READ", (requestId: number, handle: Buffer, offset: number, length: number) => {
    const opened = resolveHandle(handle);
    const entry = opened?.kind === "file" ? files.get(opened.path) : undefined;
    if (entry?.kind !== "file") {
      failure(requestId);
      return;
    }
    if (offset >= entry.content.byteLength) {
      sftp.status(requestId, STATUS_CODE.EOF);
      return;
    }
    sftp.data(requestId, entry.content.subarray(offset, Math.min(offset + length, entry.content.byteLength)));
  });
  sftp.on("WRITE", (requestId: number, handle: Buffer, offset: number, data: Buffer) => {
    const opened = resolveHandle(handle);
    const entry = opened?.kind === "file" ? files.get(opened.path) : undefined;
    if (entry?.kind !== "file") {
      failure(requestId);
      return;
    }
    const required = offset + data.byteLength;
    if (entry.content.byteLength < required) {
      const expanded = Buffer.alloc(required);
      entry.content.copy(expanded);
      entry.content = expanded;
    }
    data.copy(entry.content, offset);
    entry.modifiedAt = Date.now();
    okay(requestId);
  });
  sftp.on("CLOSE", (requestId: number, handle: Buffer) => {
    if (handle.byteLength !== 4 || !handles.delete(handle.readUInt32BE(0))) {
      failure(requestId);
      return;
    }
    okay(requestId);
  });
  sftp.on("OPENDIR", (requestId: number, value: string) => {
    const path = memoryPath(value);
    if (path === undefined || files.get(path)?.kind !== "directory") {
      missing(requestId);
      return;
    }
    allocate(requestId, { path, kind: "directory" });
  });
  sftp.on("READDIR", (requestId: number, handle: Buffer) => {
    const opened = resolveHandle(handle);
    if (opened?.kind !== "directory") {
      failure(requestId);
      return;
    }
    if (opened.sent === true) {
      sftp.status(requestId, STATUS_CODE.EOF);
      return;
    }
    opened.sent = true;
    const entries: FileEntry[] = [];
    for (const [path, entry] of files) {
      if (path === opened.path || memoryParent(path) !== opened.path) continue;
      const filename = path.slice(opened.path === "/" ? 1 : opened.path.length + 1);
      entries.push({ filename, longname: filename, attrs: memoryAttrs(entry) });
    }
    if (entries.length === 0) sftp.status(requestId, STATUS_CODE.EOF);
    else sftp.name(requestId, entries);
  });
  sftp.on("MKDIR", (requestId: number, value: string, attrs: Attributes) => {
    const path = memoryPath(value);
    if (path === undefined || files.has(path) || files.get(memoryParent(path))?.kind !== "directory") {
      failure(requestId);
      return;
    }
    files.set(path, {
      kind: "directory",
      content: Buffer.alloc(0),
      mode: typeof attrs.mode === "number" ? attrs.mode & 0o777 : 0o700,
      modifiedAt: Date.now()
    });
    okay(requestId);
  });
  sftp.on("REMOVE", (requestId: number, value: string) => {
    const path = memoryPath(value);
    if (path === undefined || files.get(path)?.kind !== "file") {
      missing(requestId);
      return;
    }
    files.delete(path);
    okay(requestId);
  });
  sftp.on("RMDIR", (requestId: number, value: string) => {
    const path = memoryPath(value);
    if (
      path === undefined || path === "/" || files.get(path)?.kind !== "directory" ||
      [...files.keys()].some((candidate) => candidate !== path && memoryParent(candidate) === path)
    ) {
      failure(requestId);
      return;
    }
    files.delete(path);
    okay(requestId);
  });
  const rename = (requestId: number, sourceValue: string, destinationValue: string): void => {
    const source = memoryPath(sourceValue);
    const destination = memoryPath(destinationValue);
    const entry = source === undefined ? undefined : files.get(source);
    if (source === undefined || destination === undefined || entry === undefined || !files.has(memoryParent(destination))) {
      missing(requestId);
      return;
    }
    files.delete(source);
    files.set(destination, entry);
    okay(requestId);
  };
  sftp.on("RENAME", rename);
  sftp.on("EXTENDED", (requestId: number, name: string, data: Buffer) => {
    if (name !== "posix-rename@openssh.com") {
      sftp.status(requestId, STATUS_CODE.OP_UNSUPPORTED);
      return;
    }
    const decoded = decodeTwoSshStrings(data);
    if (decoded === undefined) {
      failure(requestId);
      return;
    }
    rename(requestId, decoded[0], decoded[1]);
  });
}

function memoryAttrs(entry: MemoryFile): Attributes {
  const seconds = Math.trunc(entry.modifiedAt / 1_000);
  return {
    mode: (entry.kind === "directory" ? 0o040000 : 0o100000) | entry.mode,
    size: entry.content.byteLength,
    atime: seconds,
    mtime: seconds,
    uid: 1_000,
    gid: 1_000
  };
}

function memoryPath(value: string): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\u0000")) return undefined;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "..")) return undefined;
  const normalized = `/${segments.filter(Boolean).join("/")}`;
  return normalized === "" ? "/" : normalized;
}

function memoryParent(value: string): string {
  const offset = value.lastIndexOf("/");
  return offset <= 0 ? "/" : value.slice(0, offset);
}

function decodeTwoSshStrings(value: Buffer): readonly [string, string] | undefined {
  if (value.byteLength < 8) return undefined;
  const firstLength = value.readUInt32BE(0);
  const secondOffset = 4 + firstLength;
  if (secondOffset + 4 > value.byteLength) return undefined;
  const secondLength = value.readUInt32BE(secondOffset);
  if (secondOffset + 4 + secondLength !== value.byteLength) return undefined;
  return [
    value.subarray(4, secondOffset).toString("utf8"),
    value.subarray(secondOffset + 4).toString("utf8")
  ];
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function rsaPrivateKey(): Buffer {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
  return Buffer.from(privateKey.export({ format: "pem", type: "pkcs1" }));
}

function parsedPrivateKey(value: Buffer) {
  const parsed = utils.parseKey(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}
