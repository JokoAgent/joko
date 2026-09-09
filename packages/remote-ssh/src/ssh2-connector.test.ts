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
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteSshError } from "./errors.js";
import { SSH_UNICODE_CORPUS } from "./i18n/unicode.test-fixture.js";
import { Ssh2ResolvedAgentAuthConnector, type Ssh2ResolvedAgentAuthConnectorOptions } from "./ssh2-connector.js";
import type { RemoteTerminalExit, RemoteTerminalHandle } from "./types.js";

const { Server, utils } = ssh2;

const hostPrivateKey = rsaPrivateKey();
const userPrivateKey = rsaPrivateKey();
const otherPrivateKey = rsaPrivateKey();
const allowedUserKey = parsedPrivateKey(userPrivateKey);

interface TestSshServer {
  readonly port: number;
  readonly commands: string[];
  readonly terminalChannels: ServerChannel[];
  readonly terminalRequests: { term: string; cols: number; rows: number }[];
  readonly terminalSizes: { cols: number; rows: number }[];
  readonly terminalSignals: string[];
  readonly terminalEnvironmentRequests: string[];
  readonly pendingTerminals: (() => void)[];
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
      interactiveTerminal: true,
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
    const otherKey = parsedPrivateKey(otherPrivateKey);
    const offered = [otherKey, allowedUserKey];
    const signed: Buffer[] = [];
    const agent = createTcpServer((socket) => {
      const protocol = new ssh2.AgentProtocol(false);
      protocol.on("identities", (request) => protocol.getIdentitiesReply(request, offered));
      protocol.on("sign", (request, publicKey, data, options) => {
        if (!publicKey.getPublicSSH().equals(allowedUserKey.getPublicSSH())) {
          protocol.failureReply(request);
          return;
        }
        signed.push(publicKey.getPublicSSH());
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
    signed.length = 0;
    const selectedRequest = { hostname: "127.0.0.1", port: server.port, user: "maker", signal: new AbortController().signal, verifyHostKey: async () => undefined, onAuthenticating: () => undefined };
    const selected = await connector.connect({ ...selectedRequest, authentication: { kind: "agent_key", publicKey: allowedUserKey.getPublicSSH() } });
    await selected.close();
    expect(signed).toEqual([allowedUserKey.getPublicSSH()]);
    // The selected rejected key must not fall through to the allowed identity.
    await expect(connector.connect({ ...selectedRequest, authentication: { kind: "agent_key", publicKey: otherKey.getPublicSSH() } })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED", retryable: false });
    expect(signed).toHaveLength(1);
    offered.splice(1, 1);
    await expect(connector.connect({ ...selectedRequest, authentication: { kind: "agent_key", publicKey: allowedUserKey.getPublicSSH() } })).rejects.toMatchObject({ code: "NODE_KEY_UNAVAILABLE", retryable: false });
    expect(signed).toHaveLength(1);
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

describe("SSH interactive terminal transport", () => {
  const request = { executable: "/bin/sh", args: ["-l"], cwd: "/workspace", cols: 80, rows: 24 };

  it("requests a quoted PTY without environment forwarding and preserves streaming UTF-8, input, resize, and confirmed exit", async () => {
    const server = await startSshServer();
    const connection = await connect(server.port);
    const abort = new AbortController();
    const terminal = await connection.terminals!.open({ ...request, executable: "/shell with space", args: ["one'arg", "$(unsafe)"], cwd: "/space ' dir", signal: abort.signal });
    abort.abort(); // A completed creation request never owns the live PTY.
    expect(server.terminalRequests).toEqual([{ term: "xterm-256color", cols: 80, rows: 24 }]);
    expect(server.commands).toEqual(["cd -- '/space '\"'\"' dir' && exec '/shell with space' 'one'\"'\"'arg' '$(unsafe)'"]);
    const channel = server.terminalChannels[0]!;
    let output = "";
    terminal.onData((data) => { output += data; });
    const text = Buffer.from(SSH_UNICODE_CORPUS.text);
    channel.write(text.subarray(0, 3));
    await vi.waitFor(() => expect(output).toBe("A"));
    channel.write(text.subarray(3, 6));
    channel.write(text.subarray(6));
    await vi.waitFor(() => expect(output).toBe(SSH_UNICODE_CORPUS.text));
    terminal.pause();
    channel.write(" paused");
    await terminal.resize(120, 40);
    await vi.waitFor(() => expect(server.terminalSizes).toEqual([{ cols: 120, rows: 40 }]));
    expect(output).toBe(SSH_UNICODE_CORPUS.text);
    terminal.resume();
    await vi.waitFor(() => expect(output).toBe(SSH_UNICODE_CORPUS.paused));
    const input = once(channel, "data");
    await terminal.write("typed\r");
    expect(String((await input)[0])).toBe("typed\r");
    await expect(terminal.write("x".repeat(256 * 1_024 + 1))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(terminal.resize(0, 24)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(server.terminalEnvironmentRequests).toEqual([]);
    const exit = terminalExit(terminal);
    terminal.pause();
    channel.write(" final");
    channel.exit(7);
    channel.end();
    terminal.resume();
    expect(await exit).toEqual({ exitCode: 7, processExitConfirmed: true });
    expect(output).toBe(SSH_UNICODE_CORPUS.finished);
    await expect(terminal.kill()).resolves.toBeUndefined();
    await connection.close();
  });

  it.each(["channel", "connection"] as const)("does not invent success after %s loss", async (loss) => {
    const server = await startSshServer();
    const connection = await connect(server.port);
    const terminal = await connection.terminals!.open(request);
    const exit = terminalExit(terminal);
    if (loss === "channel") server.terminalChannels[0]!.close();
    else await connection.close();
    expect(await exit).toEqual({ exitCode: 1, failureCode: "TERMINAL_UNKNOWN", processExitConfirmed: false });
    await expect(terminal.kill()).rejects.toMatchObject({ code: "TERMINAL_UNKNOWN", details: { stateMayHaveChanged: true } });
    await connection.close();
  });

  it("delivers output sent after exit-status before publishing the final exit", async () => {
    const server = await startSshServer();
    const connection = await connect(server.port);
    const terminal = await connection.terminals!.open(request);
    const events: string[] = [];
    terminal.onData((data) => events.push(data));
    const exit = terminalExit(terminal).then((result) => { events.push("exit"); return result; });
    const channel = server.terminalChannels[0]!;
    channel.write("head");
    channel.exit(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events.join("")).toBe("head");
    channel.write("tail");
    channel.end();
    expect(await exit).toEqual({ exitCode: 0, processExitConfirmed: true });
    expect(events.join("")).toBe("headtailexit");
    await connection.close();
  });

  it("honors consumer pause until the full 96 KiB tail is delivered before final exit", async () => {
    const server = await startSshServer();
    const connection = await connect(server.port);
    const terminal = await connection.terminals!.open(request);
    let output = "";
    let pausedBytes = 0;
    let exited = false;
    terminal.onData((data) => {
      expect(exited).toBe(false);
      output += data;
      if (pausedBytes === 0) { pausedBytes = output.length; terminal.pause(); }
    });
    const exit = terminalExit(terminal).then((result) => { exited = true; return result; });
    const channel = server.terminalChannels[0]!;
    channel.write("x".repeat(96 * 1_024));
    channel.exit(0);
    channel.end();
    await vi.waitFor(() => expect(pausedBytes).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(output.length).toBe(pausedBytes);
    expect(exited).toBe(false);
    terminal.resume();
    expect(await exit).toEqual({ exitCode: 0, processExitConfirmed: true });
    expect(output).toBe("x".repeat(96 * 1_024));
    await connection.close();
  });

  it.each(["peer output remains open", "consumer remains paused"] as const)("reports confirmed process exit with failed output after the bounded drain deadline: %s", async (reason) => {
    const server = await startSshServer();
    const connection = await connect(server.port, { terminalDrainTimeoutMs: 150 });
    const terminal = await connection.terminals!.open(request);
    let output = "";
    terminal.onData((data) => { output += data; });
    const exit = terminalExit(terminal);
    const channel = server.terminalChannels[0]!;
    if (reason === "consumer remains paused") {
      terminal.pause();
      channel.write("undelivered");
    }
    channel.exit(0);
    if (reason === "consumer remains paused") channel.end();
    expect(await exit).toEqual({ exitCode: 0, failureCode: "TERMINAL_FAILED", processExitConfirmed: true });
    terminal.resume();
    expect(output).toBe("");
    await expect(terminal.kill()).resolves.toBeUndefined();
    await connection.close();
  });

  it.each([true, false])("waits for explicit stop confirmation (peer confirms: %s)", async (confirmed) => {
    const server = await startSshServer({ confirmTerminalStop: confirmed });
    const connection = await connect(server.port, { terminalStopTimeoutMs: 500 });
    const terminal = await connection.terminals!.open(request);
    const exit = terminalExit(terminal);
    if (confirmed) {
      await expect(terminal.kill()).resolves.toBeUndefined();
      expect(await exit).toMatchObject({ processExitConfirmed: true, signal: 15 });
    } else {
      await expect(terminal.kill()).rejects.toMatchObject({ code: "TERMINAL_UNKNOWN", retryable: false });
      expect(await exit).toMatchObject({ processExitConfirmed: false });
    }
    expect(server.terminalSignals).toContain("TERM");
    await connection.close();
  });

  it.each(["abort", "timeout"] as const)("bounds %s during creation and stops a late acquired PTY", async (outcome) => {
    const server = await startSshServer({ deferTerminal: true });
    const connection = await connect(server.port, { terminalOpenTimeoutMs: 400, terminalStopTimeoutMs: 500 });
    const aborted = new AbortController();
    aborted.abort();
    await expect(connection.terminals!.open({ ...request, signal: aborted.signal })).rejects.toMatchObject({ code: "ABORTED" });
    expect(server.commands).toHaveLength(0);
    const abort = new AbortController();
    const opening = connection.terminals!.open({ ...request, signal: abort.signal });
    const rejected = expect(opening).rejects.toMatchObject({ code: "TERMINAL_UNKNOWN", details: { stateMayHaveChanged: true } });
    await vi.waitFor(() => expect(server.pendingTerminals).toHaveLength(1));
    if (outcome === "abort") abort.abort();
    await rejected;
    server.pendingTerminals[0]!();
    await vi.waitFor(() => expect(server.terminalSignals).toContain("TERM"));
    await connection.close();
  });

  it("bounds output received before subscription and rejects unsafe start values before dispatch", async () => {
    const server = await startSshServer();
    const connection = await connect(server.port);
    for (const invalid of [{ ...request, cols: 0 }, { ...request, args: ["bad\0arg"] }]) {
      await expect(connection.terminals!.open(invalid)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
    expect(server.commands).toHaveLength(0);
    const terminal = await connection.terminals!.open(request);
    const exit = terminalExit(terminal);
    server.terminalChannels[0]!.write(Buffer.alloc(1_024 * 1_024 + 1, 65));
    expect(await exit).toMatchObject({ failureCode: "TERMINAL_UNKNOWN", processExitConfirmed: false });
    await connection.close();
  });

  it("bounds input waiting for the peer's SSH receive window", async () => {
    const server = await startSshServer({ confirmTerminalStop: false });
    const connection = await connect(server.port, { terminalOperationTimeoutMs: 200 });
    const terminal = await connection.terminals!.open(request);
    server.terminalChannels[0]!.pause();
    const exit = terminalExit(terminal);
    let failure: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await terminal.write("x".repeat(256 * 1_024)); }
      catch (error) { failure = error; break; }
    }
    expect(failure).toMatchObject({ code: "TERMINAL_UNKNOWN", details: { stateMayHaveChanged: true } });
    expect(await exit).toMatchObject({ processExitConfirmed: false });
    await connection.close();
  });
});

function terminalExit(terminal: RemoteTerminalHandle): Promise<RemoteTerminalExit> {
  return new Promise((resolve) => { terminal.onExit(resolve); });
}

async function connect(port: number, options: Ssh2ResolvedAgentAuthConnectorOptions = {}) {
  const connector = new Ssh2ResolvedAgentAuthConnector({ readyTimeoutMs: 2_000, ...options });
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

async function startSshServer(options: { deferTerminal?: boolean; confirmTerminalStop?: boolean } = {}): Promise<TestSshServer> {
  const commands: string[] = [];
  const terminalChannels: ServerChannel[] = [];
  const terminalRequests: { term: string; cols: number; rows: number }[] = [];
  const terminalSizes: { cols: number; rows: number }[] = [];
  const terminalSignals: string[] = [];
  const terminalEnvironmentRequests: string[] = [];
  const pendingTerminals: (() => void)[] = [];
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
        let terminal = false;
        let terminalChannel: ServerChannel | undefined;
        session.on("env", (acceptEnv, _reject, info) => {
          terminalEnvironmentRequests.push(info.key);
          acceptEnv?.();
        });
        session.on("pty", (acceptPty, _reject, info) => {
          terminal = true;
          terminalRequests.push({ term: (info as typeof info & { term: string }).term, cols: info.cols, rows: info.rows });
          acceptPty?.();
        });
        session.on("window-change", (acceptWindow, _reject, info) => {
          terminalSizes.push({ cols: info.cols, rows: info.rows });
          acceptWindow?.();
        });
        session.on("signal", (acceptSignal, _reject, info) => {
          terminalSignals.push(info.name);
          acceptSignal?.();
          if (options.confirmTerminalStop !== false && terminalChannel !== undefined) {
            terminalChannel.exit(info.name);
            terminalChannel.end();
          }
        });
        session.on("exec", (acceptExec, _reject, info) => {
          commands.push(info.command);
          if (terminal) {
            const open = (): void => {
              terminalChannel = acceptExec();
              terminalChannel.on("error", () => undefined);
              terminalChannels.push(terminalChannel);
            };
            if (options.deferTerminal) pendingTerminals.push(open);
            else open();
            return;
          }
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
    terminalChannels,
    terminalRequests,
    terminalSizes,
    terminalSignals,
    terminalEnvironmentRequests,
    pendingTerminals,
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
