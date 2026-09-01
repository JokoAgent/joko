import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants as osConstants } from "node:os";
import { connect as connectTcp } from "node:net";
import { posix as remotePath } from "node:path";
import type { Duplex, Readable, Writable } from "node:stream";
import ssh2, {
  type ClientChannel,
  type ClientErrorExtensions,
  type ConnectConfig,
  type FileEntryWithStats,
  type SFTPWrapper,
  type Stats
} from "ssh2";
import { isRemoteSshError, RemoteSshError } from "./errors.js";
import type {
  AgentAuthConnection,
  AgentAuthExecutionRequest,
  AgentAuthExecutionResult,
  RemoteDirectoryEntry,
  RemoteFileReadRequest,
  RemoteFileStat,
  RemoteFileTransportPort,
  RemoteFileWriteRequest,
  RemoteForwardingTransportPort,
  RemoteForwardRequest,
  RemoteReverseForwardHandle,
  RemoteReverseForwardRequest,
  RemoteProcessHandle,
  RemoteProcessStartRequest,
  RemoteProcessTransportPort,
  RemoteSshTransportCapabilities,
  ResolvedAgentAuthConnectorPort,
  ResolvedAgentAuthConnectorRequest
} from "./types.js";
import { AgentAuthConnectorFailure } from "./types.js";

const { Client, utils } = ssh2;

const MAXIMUM_FILE_TRANSFER_BYTES = 64 * 1_024 * 1_024;
const MAXIMUM_DIRECTORY_ENTRIES = 10_000;
const MAXIMUM_DIRECTORY_DEPTH = 128;
const MAXIMUM_PROCESS_ARGUMENT_BYTES = 256 * 1_024;
const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 10_000;
const DEFAULT_KEEPALIVE_COUNT_MAX = 3;

const SSH2_CAPABILITIES: RemoteSshTransportCapabilities = Object.freeze({
  commandExecution: true,
  processStreaming: true,
  fileTransfer: true,
  tcpForwarding: true
});

export interface Ssh2ResolvedAgentAuthConnectorOptions {
  /** Service-owned agent endpoint. It is never projected through public contracts. */
  readonly systemAgentEndpoint?: string;
  readonly readyTimeoutMs?: number;
  readonly keepaliveIntervalMs?: number;
  readonly keepaliveCountMax?: number;
}

/**
 * Production SSH transport. All thrown errors are stable and intentionally
 * omit server text, commands, paths, credentials, and stream contents.
 */
export class Ssh2ResolvedAgentAuthConnector implements ResolvedAgentAuthConnectorPort {
  readonly capabilities = SSH2_CAPABILITIES;
  readonly #systemAgentEndpoint: string | undefined;
  readonly #readyTimeoutMs: number;
  readonly #keepaliveIntervalMs: number;
  readonly #keepaliveCountMax: number;

  constructor(options: Ssh2ResolvedAgentAuthConnectorOptions = {}) {
    this.#systemAgentEndpoint = options.systemAgentEndpoint;
    this.#readyTimeoutMs = boundedInteger(
      options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      "ready timeout",
      1,
      120_000
    );
    this.#keepaliveIntervalMs = boundedInteger(
      options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS,
      "keepalive interval",
      0,
      120_000
    );
    this.#keepaliveCountMax = boundedInteger(
      options.keepaliveCountMax ?? DEFAULT_KEEPALIVE_COUNT_MAX,
      "keepalive count",
      1,
      100
    );
  }

  async connect(request: ResolvedAgentAuthConnectorRequest): Promise<AgentAuthConnection> {
    const host = boundedText(request.hostname, "hostname", 1_024);
    const username = boundedText(request.user, "user", 256);
    const port = boundedInteger(request.port, "port", 1, 65_535);
    if (request.signal.aborted) throw abortedError();

    const privateKey = request.authentication.kind === "private_key"
      ? Buffer.from(request.authentication.privateKey)
      : undefined;
    const passphrase = request.authentication.kind === "private_key" && request.authentication.passphrase !== undefined
      ? Buffer.from(request.authentication.passphrase)
      : undefined;

    try {
      if (privateKey !== undefined) {
        if (
          privateKey.byteLength === 0 || privateKey.byteLength > 1_024 * 1_024 ||
          passphrase !== undefined && passphrase.byteLength > 64 * 1_024
        ) throw new AgentAuthConnectorFailure("AUTHENTICATION_FAILED");
        const parsed = utils.parseKey(privateKey, passphrase);
        if (parsed instanceof Error || !parsed.isPrivateKey()) {
          throw new AgentAuthConnectorFailure("AUTHENTICATION_FAILED");
        }
      }

      const agentEndpoint = request.authentication.kind === "system_agent"
        ? resolveSystemAgentEndpoint(request.authentication.endpoint, this.#systemAgentEndpoint)
        : undefined;
      if (request.authentication.kind === "system_agent" && agentEndpoint === undefined) {
        throw new AgentAuthConnectorFailure("AUTHENTICATION_FAILED");
      }

      return await new Promise<AgentAuthConnection>((resolve, reject) => {
        const client = new Client();
        let settled = false;
        let hostVerificationAttempted = false;
        let authenticationReported = false;
        let verificationFailure: unknown;

        const cleanupBeforeReady = (): void => {
          request.signal.removeEventListener("abort", onAbort);
          client.removeListener("ready", onReady);
          client.removeListener("error", onError);
          client.removeListener("close", onClose);
        };
        const fail = (error: unknown): void => {
          if (settled) return;
          settled = true;
          cleanupBeforeReady();
          client.destroy();
          reject(safeConnectFailure(error));
        };
        const onAbort = (): void => fail(abortedError());
        const onError = (error: Error & ClientErrorExtensions): void => {
          fail(verificationFailure ?? connectorFailure(error));
        };
        const onClose = (): void => fail(verificationFailure ?? new AgentAuthConnectorFailure("CONNECTION_FAILED"));
        const onReady = (): void => {
          if (!hostVerificationAttempted || !authenticationReported) {
            fail(new RemoteSshError(
              "CONNECTOR_PROTOCOL",
              "The SSH connector did not complete the required verification lifecycle.",
              false
            ));
            return;
          }
          if (request.signal.aborted) {
            fail(abortedError());
            return;
          }
          settled = true;
          cleanupBeforeReady();
          resolve(new Ssh2AgentAuthConnection(client));
        };

        request.signal.addEventListener("abort", onAbort, { once: true });
        client.once("ready", onReady);
        client.once("error", onError);
        client.once("close", onClose);

        const config: ConnectConfig = {
          host,
          port,
          username,
          readyTimeout: this.#readyTimeoutMs,
          keepaliveInterval: this.#keepaliveIntervalMs,
          keepaliveCountMax: this.#keepaliveCountMax,
          strictVendor: true,
          authHandler: request.authentication.kind === "private_key" ? ["publickey"] : ["agent"],
          ...(privateKey === undefined ? {} : { privateKey }),
          ...(passphrase === undefined ? {} : { passphrase }),
          ...(agentEndpoint === undefined ? {} : { agent: agentEndpoint }),
          hostVerifier: (key: Buffer, done: (accepted: boolean) => void): void => {
            hostVerificationAttempted = true;
            let algorithm: string;
            try {
              const parsed = utils.parseKey(key);
              if (parsed instanceof Error) throw parsed;
              algorithm = parsed.type;
            } catch {
              verificationFailure = new RemoteSshError(
                "HOST_KEY_INVALID",
                "The SSH server presented an invalid host key.",
                false
              );
              done(false);
              return;
            }
            const publicKey = Buffer.from(key);
            void Promise.resolve(request.verifyHostKey({ algorithm, key: publicKey }))
              .then(() => {
                if (request.signal.aborted || settled) {
                  done(false);
                  return;
                }
                try {
                  request.onAuthenticating();
                  authenticationReported = true;
                  done(true);
                } catch {
                  verificationFailure = new RemoteSshError(
                    "CONNECTOR_PROTOCOL",
                    "The SSH connector authentication lifecycle failed safely.",
                    false
                  );
                  done(false);
                }
              })
              .catch((error: unknown) => {
                verificationFailure = error;
                done(false);
              });
          }
        };

        try {
          client.connect(config);
        } catch (error) {
          fail(error);
        }
      });
    } finally {
      privateKey?.fill(0);
      passphrase?.fill(0);
    }
  }
}

class Ssh2AgentAuthConnection implements AgentAuthConnection {
  readonly capabilities = SSH2_CAPABILITIES;
  readonly processes: RemoteProcessTransportPort;
  readonly files: RemoteFileTransportPort;
  readonly forwarding: RemoteForwardingTransportPort;
  readonly #client: InstanceType<typeof Client>;
  readonly #reverseForwards = new Map<number, {
    readonly remoteHost: "127.0.0.1" | "::1" | "localhost";
    readonly localHost: "127.0.0.1" | "::1" | "localhost";
    readonly localPort: number;
  }>();
  #closed = false;
  #sftpPromise: Promise<SFTPWrapper> | undefined;

  constructor(client: InstanceType<typeof Client>) {
    this.#client = client;
    this.processes = Object.freeze({
      open: (request: RemoteProcessStartRequest) => this.openProcess(request)
    });
    this.files = new Ssh2RemoteFileTransport(
      (signal) => this.sftp(signal),
      () => this.invalidateSftp()
    );
    this.forwarding = Object.freeze({
      open: (request: RemoteForwardRequest) => this.openForward(request),
      listen: (request: RemoteReverseForwardRequest) => this.openReverseForward(request)
    });
    client.on("tcp connection", (details, accept, reject) => {
      const route = this.#reverseForwards.get(details.destPort);
      if (route === undefined) {
        reject();
        return;
      }
      let channel: ClientChannel;
      try {
        channel = accept();
      } catch {
        reject();
        return;
      }
      const socket = connectTcp({ host: route.localHost, port: route.localPort });
      socket.once("error", () => channel.destroy());
      channel.once("error", () => socket.destroy());
      channel.once("close", () => socket.destroy());
      socket.once("close", () => channel.destroy());
      channel.pipe(socket).pipe(channel);
    });
    client.once("close", () => {
      this.#closed = true;
      this.#sftpPromise = undefined;
    });
  }

  async execute(request: AgentAuthExecutionRequest): Promise<AgentAuthExecutionResult> {
    this.assertOpen();
    if (request.signal.aborted) throw abortedError();
    const command = request.cwd === undefined
      ? request.command
      : `cd -- ${quotePosix(request.cwd)} && ${request.command}`;
    return new Promise<AgentAuthExecutionResult>((resolve, reject) => {
      let channel: ClientChannel | undefined;
      let settled = false;
      let exitCode: number | null = null;
      let signal: string | undefined;
      let outputCapped = false;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;

      const cleanup = (): void => {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        closeChannel(channel);
        reject(isRemoteSshError(error)
          ? error
          : new RemoteSshError("EXECUTION_FAILED", "The SSH command failed safely.", true));
      };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(Object.freeze({
          stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
          stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
          exitCode,
          ...(signal === undefined ? {} : { signal }),
          outputCapped
        }));
      };
      const capStream = (chunks: Buffer[], bytes: number, chunk: Buffer | string): number => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = request.maxOutputBytes - bytes;
        if (remaining > 0) {
          const accepted = value.byteLength > remaining ? value.subarray(0, remaining) : value;
          chunks.push(Buffer.from(accepted));
          bytes += accepted.byteLength;
        }
        if (value.byteLength > remaining) {
          outputCapped = true;
          closeChannel(channel);
        }
        return bytes;
      };
      const onAbort = (): void => fail(abortedError());
      const timer = setTimeout(
        () => fail(new RemoteSshError("EXECUTION_TIMEOUT", "The SSH command timed out.", true)),
        request.timeoutMs
      );
      timer.unref?.();
      request.signal.addEventListener("abort", onAbort, { once: true });

      try {
        this.#client.exec(command, (error, stream) => {
          if (error || stream === undefined) {
            fail(error);
            return;
          }
          channel = stream;
          if (settled) {
            closeChannel(stream);
            return;
          }
          stream.on("data", (chunk: Buffer | string) => {
            stdoutBytes = capStream(stdout, stdoutBytes, chunk);
          });
          stream.stderr.on("data", (chunk: Buffer | string) => {
            stderrBytes = capStream(stderr, stderrBytes, chunk);
          });
          stream.once("error", fail);
          stream.stderr.once("error", fail);
          stream.once("exit", (code: number | null, exitSignal?: string) => {
            exitCode = code;
            signal = typeof exitSignal === "string" && exitSignal.length <= 64 ? exitSignal : undefined;
          });
          stream.once("close", finish);
          if (request.input === undefined) stream.end();
          else stream.end(request.input, "utf8");
        });
      } catch (error) {
        fail(error);
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const client = this.#client;
    this.invalidateSftp();
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.removeListener("close", finish);
        resolve();
      };
      const timer = setTimeout(() => {
        client.destroy();
        finish();
      }, 1_000);
      timer.unref?.();
      client.once("close", finish);
      try {
        client.end();
      } catch {
        client.destroy();
        finish();
      }
    });
  }

  private async openProcess(request: RemoteProcessStartRequest): Promise<RemoteProcessHandle> {
    this.assertOpen();
    const command = processCommand(request);
    if (request.signal?.aborted === true) throw abortedError();
    return new Promise<RemoteProcessHandle>((resolve, reject) => {
      const fail = (): void => reject(new RemoteSshError(
        "EXECUTION_FAILED",
        "The remote process could not be started safely.",
        true
      ));
      try {
        this.#client.exec(command, (error, stream) => {
          if (error || stream === undefined) {
            fail();
            return;
          }
          const handle = new Ssh2RemoteProcessHandle(stream, request.signal);
          resolve(handle);
        });
      } catch {
        fail();
      }
    });
  }

  private async openForward(request: RemoteForwardRequest): Promise<Duplex> {
    this.assertOpen();
    const destinationHost = request.destinationHost;
    if (destinationHost !== "127.0.0.1" && destinationHost !== "::1" && destinationHost !== "localhost") {
      throw new RemoteSshError("INVALID_ARGUMENT", "TCP forwarding is restricted to remote loopback.", false);
    }
    const destinationPort = boundedInteger(request.destinationPort, "destination port", 1, 65_535);
    if (request.signal?.aborted === true) throw abortedError();
    return new Promise<Duplex>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => request.signal?.removeEventListener("abort", onAbort);
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(abortedError());
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.#client.forwardOut("127.0.0.1", 0, destinationHost, destinationPort, (error, stream) => {
          if (settled) {
            stream?.destroy();
            return;
          }
          settled = true;
          cleanup();
          if (error || stream === undefined) {
            reject(new RemoteSshError("FORWARDING_FAILED", "The SSH TCP forward failed safely.", true));
            return;
          }
          if (request.signal?.aborted === true) {
            stream.destroy();
            reject(abortedError());
            return;
          }
          const onStreamAbort = (): void => { stream.destroy(); };
          request.signal?.addEventListener("abort", onStreamAbort, { once: true });
          stream.once("close", () => request.signal?.removeEventListener("abort", onStreamAbort));
          resolve(stream);
        });
      } catch {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new RemoteSshError("FORWARDING_FAILED", "The SSH TCP forward failed safely.", true));
        }
      }
    });
  }

  private async openReverseForward(
    request: RemoteReverseForwardRequest
  ): Promise<RemoteReverseForwardHandle> {
    this.assertOpen();
    const localHost = loopbackHost(request.localDestinationHost, "local destination");
    const localPort = boundedInteger(request.localDestinationPort, "local destination port", 1, 65_535);
    const remoteHost = loopbackHost(request.remoteListenHost ?? "127.0.0.1", "remote listen");
    if (request.signal?.aborted === true) throw abortedError();
    const remotePort = await new Promise<number>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => request.signal?.removeEventListener("abort", onAbort);
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(abortedError());
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.#client.forwardIn(remoteHost, 0, (error, assignedPort) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error || assignedPort === undefined) {
            reject(new RemoteSshError("FORWARDING_FAILED", "The SSH reverse forward failed safely.", true));
            return;
          }
          resolve(assignedPort);
        });
      } catch {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new RemoteSshError("FORWARDING_FAILED", "The SSH reverse forward failed safely.", true));
        }
      }
    });
    this.#reverseForwards.set(remotePort, { remoteHost, localHost, localPort });
    let closed = false;
    const handle: RemoteReverseForwardHandle = Object.freeze({
      remoteHost,
      remotePort,
      close: async (): Promise<void> => {
        if (closed) return;
        closed = true;
        this.#reverseForwards.delete(remotePort);
        if (this.#closed) return;
        await new Promise<void>((resolve) => {
          try {
            this.#client.unforwardIn(remoteHost, remotePort, () => resolve());
          } catch {
            resolve();
          }
        });
      }
    });
    const closeOnAbort = (): void => { void handle.close(); };
    request.signal?.addEventListener("abort", closeOnAbort, { once: true });
    return handle;
  }

  private async sftp(signal?: AbortSignal): Promise<SFTPWrapper> {
    this.assertOpen();
    if (signal?.aborted === true) throw abortedError();
    if (this.#sftpPromise !== undefined) return this.#sftpPromise;
    const operation = new Promise<SFTPWrapper>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.#sftpPromise = undefined;
        reject(abortedError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.#client.sftp((error, sftp) => {
          if (settled) {
            sftp?.end();
            return;
          }
          settled = true;
          cleanup();
          if (error || sftp === undefined) {
            this.#sftpPromise = undefined;
            reject(new RemoteSshError(
              "FILE_TRANSFER_UNAVAILABLE",
              "The SSH server does not provide the required file transport.",
              false
            ));
            return;
          }
          sftp.once("close", () => {
            if (this.#sftpPromise === operation) this.#sftpPromise = undefined;
          });
          resolve(sftp);
        });
      } catch {
        settled = true;
        cleanup();
        this.#sftpPromise = undefined;
        reject(new RemoteSshError(
          "FILE_TRANSFER_UNAVAILABLE",
          "The SSH server does not provide the required file transport.",
          false
        ));
      }
    });
    this.#sftpPromise = operation;
    return operation;
  }

  private invalidateSftp(): void {
    const current = this.#sftpPromise;
    this.#sftpPromise = undefined;
    void current?.then((sftp) => {
      try { sftp.end(); } catch {}
    }, () => undefined);
  }

  private assertOpen(): void {
    if (this.#closed) {
      throw new RemoteSshError("CONNECTION_FAILED", "The SSH connection is closed.", true);
    }
  }
}

function loopbackHost(
  value: string,
  label: string
): "127.0.0.1" | "::1" | "localhost" {
  if (value !== "127.0.0.1" && value !== "::1" && value !== "localhost") {
    throw new RemoteSshError("INVALID_ARGUMENT", `${label} forwarding is restricted to loopback.`, false);
  }
  return value;
}

class Ssh2RemoteProcessHandle extends EventEmitter implements RemoteProcessHandle {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly #channel: ClientChannel;
  readonly #signal: AbortSignal | undefined;
  #exited = false;

  constructor(channel: ClientChannel, signal?: AbortSignal) {
    super();
    this.#channel = channel;
    this.stdin = channel;
    this.stdout = channel;
    this.stderr = channel.stderr;
    this.#signal = signal;
    const onAbort = (): void => closeChannel(channel);
    signal?.addEventListener("abort", onAbort, { once: true });
    channel.once("error", (error: Error) => this.emit("error", safeProcessError(error)));
    channel.once("exit", (code: number | null, remoteSignal?: string) => {
      this.exitCode = code;
      this.signalCode = normalizeSignal(remoteSignal);
    });
    channel.once("close", () => {
      signal?.removeEventListener("abort", onAbort);
      this.finish();
    });
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.#exited) return false;
    try {
      this.#channel.signal(signalName(signal));
      return true;
    } catch {
      closeChannel(this.#channel);
      return false;
    }
  }

  private finish(): void {
    if (this.#exited) return;
    this.#exited = true;
    this.emit("exit", this.exitCode, this.signalCode);
  }
}

class Ssh2RemoteFileTransport implements RemoteFileTransportPort {
  readonly #getSftp: (signal?: AbortSignal) => Promise<SFTPWrapper>;
  readonly #invalidate: () => void;

  constructor(getSftp: (signal?: AbortSignal) => Promise<SFTPWrapper>, invalidate: () => void) {
    this.#getSftp = getSftp;
    this.#invalidate = invalidate;
  }

  async realpath(path: string, signal?: AbortSignal): Promise<string> {
    const accepted = absoluteRemotePath(path);
    return this.withSftp(signal, (sftp) => callbackOperation(
      signal,
      (done) => sftp.realpath(accepted, done),
      this.#invalidate
    ));
  }

  async stat(path: string, signal?: AbortSignal): Promise<RemoteFileStat> {
    const accepted = absoluteRemotePath(path);
    const stats = await this.withSftp(signal, (sftp) => callbackOperation<Stats>(
      signal,
      (done) => sftp.lstat(accepted, done),
      this.#invalidate
    ));
    return statProjection(stats);
  }

  async list(path: string, signal?: AbortSignal): Promise<readonly RemoteDirectoryEntry[]> {
    const accepted = absoluteRemotePath(path);
    const entries = await this.withSftp(signal, (sftp) => callbackOperation<FileEntryWithStats[]>(
      signal,
      (done) => sftp.readdir(accepted, done),
      this.#invalidate
    ));
    if (entries.length > MAXIMUM_DIRECTORY_ENTRIES) throw fileFailure();
    return Object.freeze(entries
      .filter((entry) => entry.filename !== "." && entry.filename !== "..")
      .map((entry) => Object.freeze({
        name: directoryName(entry.filename),
        kind: statKind(entry.attrs)
      })));
  }

  async read(request: RemoteFileReadRequest): Promise<Uint8Array> {
    const path = absoluteRemotePath(request.path);
    const maximumBytes = boundedInteger(
      request.maximumBytes,
      "maximum file bytes",
      1,
      MAXIMUM_FILE_TRANSFER_BYTES
    );
    return this.withSftp(request.signal, async (sftp) => {
      const info = await callbackOperation<Stats>(
        request.signal,
        (done) => sftp.lstat(path, done),
        this.#invalidate
      );
      if (
        !info.isFile() || info.size < 0 ||
        (info.size > maximumBytes && request.allowTruncated !== true)
      ) throw fileFailure();
      return new Promise<Uint8Array>((resolve, reject) => {
        const stream = sftp.createReadStream(path, request.allowTruncated === true
          ? { start: 0, end: maximumBytes - 1 }
          : undefined);
        const chunks: Buffer[] = [];
        let bytes = 0;
        let settled = false;
        const cleanup = (): void => request.signal?.removeEventListener("abort", onAbort);
        const fail = (error: unknown): void => {
          if (settled) return;
          settled = true;
          cleanup();
          stream.destroy();
          reject(isRemoteSshError(error) ? error : fileFailure());
        };
        const onAbort = (): void => {
          this.#invalidate();
          fail(abortedError());
        };
        request.signal?.addEventListener("abort", onAbort, { once: true });
        stream.on("data", (chunk: Buffer | string) => {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += value.byteLength;
          if (bytes > maximumBytes) {
            fail(fileFailure());
            return;
          }
          chunks.push(Buffer.from(value));
        });
        stream.once("error", fail);
        stream.once("end", () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(Buffer.concat(chunks, bytes));
        });
      });
    });
  }

  async write(request: RemoteFileWriteRequest): Promise<void> {
    const path = absoluteRemotePath(request.path);
    if (!(request.content instanceof Uint8Array) || request.content.byteLength > MAXIMUM_FILE_TRANSFER_BYTES) {
      throw new RemoteSshError("INVALID_ARGUMENT", "Remote file content is invalid.", false);
    }
    const mode = request.mode === undefined ? 0o600 : boundedInteger(request.mode, "file mode", 0, 0o777);
    const content = Buffer.from(request.content);
    try {
      if (request.createParents === true) {
        await this.mkdir(remotePath.dirname(path), { recursive: true, mode: 0o700, signal: request.signal });
      }
      await this.withSftp(request.signal, async (sftp) => {
        if (request.atomic !== true) {
          await callbackOperation<void>(
            request.signal,
            (done) => sftp.writeFile(path, content, { mode, flag: "w" }, done),
            this.#invalidate
          );
          return;
        }
        const temporaryPath = `${path}.joko-${randomBytes(12).toString("hex")}.tmp`;
        try {
          await callbackOperation<void>(
            request.signal,
            (done) => sftp.writeFile(temporaryPath, content, { mode, flag: "wx" }, done),
            this.#invalidate
          );
          await atomicSftpRename(sftp, temporaryPath, path, request.signal, this.#invalidate);
        } catch (error) {
          await callbackOperation<void>(undefined, (done) => sftp.unlink(temporaryPath, done), () => undefined)
            .catch(() => undefined);
          throw error;
        }
      });
    } finally {
      content.fill(0);
    }
  }

  async mkdir(
    path: string,
    options: { readonly recursive?: boolean; readonly mode?: number; readonly signal?: AbortSignal } = {}
  ): Promise<void> {
    const accepted = absoluteRemotePath(path);
    const mode = options.mode === undefined ? 0o700 : boundedInteger(options.mode, "directory mode", 0, 0o777);
    await this.withSftp(options.signal, async (sftp) => {
      const paths = options.recursive === true ? ancestorPaths(accepted) : [accepted];
      for (const current of paths) {
        try {
          await callbackOperation<void>(
            options.signal,
            (done) => sftp.mkdir(current, { mode }, done),
            this.#invalidate
          );
        } catch {
          const info = await callbackOperation<Stats>(
            options.signal,
            (done) => sftp.lstat(current, done),
            this.#invalidate
          ).catch(() => undefined);
          if (info === undefined || !info.isDirectory()) throw fileFailure();
        }
      }
    });
  }

  async rename(sourcePath: string, destinationPath: string, signal?: AbortSignal): Promise<void> {
    const source = absoluteRemotePath(sourcePath);
    const destination = absoluteRemotePath(destinationPath);
    await this.withSftp(signal, (sftp) => atomicSftpRename(
      sftp,
      source,
      destination,
      signal,
      this.#invalidate
    ));
  }

  async remove(
    path: string,
    options: { readonly recursive?: boolean; readonly signal?: AbortSignal } = {}
  ): Promise<void> {
    const accepted = absoluteRemotePath(path);
    if (accepted === "/") throw new RemoteSshError("INVALID_ARGUMENT", "The remote filesystem root cannot be removed.", false);
    await this.withSftp(options.signal, async (sftp) => {
      const counter = { value: 0 };
      await removeEntry(sftp, accepted, options.recursive === true, options.signal, this.#invalidate, 0, counter);
    });
  }

  private async withSftp<T>(
    signal: AbortSignal | undefined,
    operation: (sftp: SFTPWrapper) => Promise<T>
  ): Promise<T> {
    if (signal?.aborted === true) throw abortedError();
    try {
      return await operation(await this.#getSftp(signal));
    } catch (error) {
      if (isRemoteSshError(error)) throw error;
      throw fileFailure();
    }
  }
}

async function removeEntry(
  sftp: SFTPWrapper,
  path: string,
  recursive: boolean,
  signal: AbortSignal | undefined,
  invalidate: () => void,
  depth: number,
  counter: { value: number }
): Promise<void> {
  if (depth > MAXIMUM_DIRECTORY_DEPTH || ++counter.value > MAXIMUM_DIRECTORY_ENTRIES) throw fileFailure();
  const info = await callbackOperation<Stats>(signal, (done) => sftp.lstat(path, done), invalidate);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    await callbackOperation<void>(signal, (done) => sftp.unlink(path, done), invalidate);
    return;
  }
  if (!recursive) {
    await callbackOperation<void>(signal, (done) => sftp.rmdir(path, done), invalidate);
    return;
  }
  const entries = await callbackOperation<FileEntryWithStats[]>(
    signal,
    (done) => sftp.readdir(path, done),
    invalidate
  );
  for (const entry of entries) {
    if (entry.filename === "." || entry.filename === "..") continue;
    await removeEntry(
      sftp,
      remotePath.join(path, directoryName(entry.filename)),
      true,
      signal,
      invalidate,
      depth + 1,
      counter
    );
  }
  await callbackOperation<void>(signal, (done) => sftp.rmdir(path, done), invalidate);
}

async function atomicSftpRename(
  sftp: SFTPWrapper,
  source: string,
  destination: string,
  signal: AbortSignal | undefined,
  invalidate: () => void
): Promise<void> {
  try {
    await callbackOperation<void>(
      signal,
      (done) => sftp.ext_openssh_rename(source, destination, done),
      invalidate
    );
    return;
  } catch (extensionError) {
    // SFTP v3 rename is atomic for a new destination. It has no portable,
    // atomic replacement guarantee, so existing destinations remain closed
    // unless the OpenSSH extension succeeded.
    const destinationExists = await callbackOperation<Stats>(
      signal,
      (done) => sftp.lstat(destination, done),
      invalidate
    ).then(() => true, () => false);
    if (destinationExists) throw extensionError;
  }
  await callbackOperation<void>(
    signal,
    (done) => sftp.rename(source, destination, done),
    invalidate
  );
}

function callbackOperation<T>(
  signal: AbortSignal | undefined,
  start: (done: (error?: Error | null, value?: T) => void) => void,
  invalidate: () => void
): Promise<T> {
  if (signal?.aborted === true) return Promise.reject(abortedError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      invalidate();
      reject(abortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      start((error, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(fileFailure());
        else resolve(value as T);
      });
    } catch {
      if (!settled) {
        settled = true;
        cleanup();
        reject(fileFailure());
      }
    }
  });
}

function processCommand(request: RemoteProcessStartRequest): string {
  const executable = boundedProcessValue(request.executable, "executable");
  const cwd = absoluteRemotePath(request.cwd);
  if (!Array.isArray(request.args) || request.args.length > 4_096) {
    throw new RemoteSshError("INVALID_ARGUMENT", "Remote process arguments are invalid.", false);
  }
  let argumentBytes = 0;
  const args = request.args.map((argument) => {
    const accepted = boundedProcessValue(argument, "argument", true);
    argumentBytes += Buffer.byteLength(accepted, "utf8");
    return quotePosix(accepted);
  });
  if (argumentBytes > MAXIMUM_PROCESS_ARGUMENT_BYTES) {
    throw new RemoteSshError("INVALID_ARGUMENT", "Remote process arguments are invalid.", false);
  }
  const environment: string[] = [];
  if (request.env !== undefined) {
    const entries = Object.entries(request.env);
    if (entries.length > 1_024) throw new RemoteSshError("INVALID_ARGUMENT", "Remote process environment is invalid.", false);
    for (const [name, value] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
        throw new RemoteSshError("INVALID_ARGUMENT", "Remote process environment is invalid.", false);
      }
      environment.push(quotePosix(`${name}=${boundedProcessValue(value, "environment", true)}`));
    }
  }
  const envPrefix = environment.length === 0 ? "" : `env ${environment.join(" ")} `;
  return `cd -- ${quotePosix(cwd)} && ${envPrefix}exec ${quotePosix(executable)}${args.length === 0 ? "" : ` ${args.join(" ")}`}`;
}

function statProjection(stats: Stats): RemoteFileStat {
  if (!Number.isSafeInteger(stats.size) || stats.size < 0 || !Number.isFinite(stats.mtime)) throw fileFailure();
  return Object.freeze({
    kind: statKind(stats),
    size: stats.size,
    modifiedAt: Math.trunc(stats.mtime * 1_000),
    mode: stats.mode & 0o7777
  });
}

function statKind(stats: Stats): RemoteFileStat["kind"] {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symbolic_link";
  return "other";
}

function ancestorPaths(path: string): string[] {
  if (path === "/") return [];
  const segments = path.split("/").filter(Boolean);
  const paths: string[] = [];
  let current = "";
  for (const segment of segments) {
    current += `/${segment}`;
    paths.push(current);
  }
  return paths;
}

function absoluteRemotePath(value: string): string {
  const accepted = boundedText(value, "remote path", 16_384, true);
  if (!accepted.startsWith("/") || remotePath.normalize(accepted) !== accepted || accepted.includes("\u0000")) {
    throw new RemoteSshError("INVALID_ARGUMENT", "The remote path is invalid.", false);
  }
  return accepted;
}

function directoryName(value: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 4_096 ||
    value.includes("/") || value.includes("\u0000")
  ) throw fileFailure();
  return value;
}

function boundedProcessValue(value: string, field: string, allowEmpty = false): string {
  return boundedText(value, field, 256 * 1_024, allowEmpty);
}

function boundedText(value: string, field: string, maximumBytes: number, allowEmpty = false): string {
  if (
    typeof value !== "string" || (!allowEmpty && value.length === 0) ||
    value.includes("\u0000") || Buffer.byteLength(value, "utf8") > maximumBytes
  ) throw new RemoteSshError("INVALID_ARGUMENT", `${field} is invalid.`, false);
  return value;
}

function boundedInteger(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RemoteSshError("INVALID_ARGUMENT", `${field} is invalid.`, false);
  }
  return value;
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function resolveSystemAgentEndpoint(requestEndpoint: string | undefined, configuredEndpoint: string | undefined): string | undefined {
  const endpoint = requestEndpoint ?? configuredEndpoint ?? process.env.SSH_AUTH_SOCK ??
    (process.platform === "win32" ? "\\\\.\\pipe\\openssh-ssh-agent" : undefined);
  if (endpoint === undefined) return undefined;
  return boundedText(endpoint, "agent endpoint", 4_096);
}

function connectorFailure(error: Error & ClientErrorExtensions): AgentAuthConnectorFailure {
  return new AgentAuthConnectorFailure(
    error.level === "client-authentication" ? "AUTHENTICATION_FAILED" : "CONNECTION_FAILED"
  );
}

function safeConnectFailure(error: unknown): Error {
  if (isRemoteSshError(error) || error instanceof AgentAuthConnectorFailure) return error;
  return new AgentAuthConnectorFailure("CONNECTION_FAILED");
}

function abortedError(): RemoteSshError {
  return new RemoteSshError("ABORTED", "The SSH operation was aborted.", true);
}

function fileFailure(): RemoteSshError {
  return new RemoteSshError("FILE_TRANSFER_FAILED", "The SSH file operation failed safely.", true);
}

function safeProcessError(_error: unknown): RemoteSshError {
  return new RemoteSshError("EXECUTION_FAILED", "The remote process failed safely.", true);
}

function closeChannel(channel: ClientChannel | undefined): void {
  if (channel === undefined) return;
  try { channel.close(); } catch {
    try { channel.destroy(); } catch {}
  }
}

function signalName(signal: NodeJS.Signals | number): string {
  if (typeof signal === "string" && /^SIG[A-Z0-9]+$/u.test(signal)) return signal;
  if (typeof signal === "number") {
    for (const [name, number] of Object.entries(osConstants.signals)) {
      if (number === signal) return name;
    }
  }
  throw new RemoteSshError("INVALID_ARGUMENT", "The remote process signal is invalid.", false);
}

function normalizeSignal(signal: string | undefined): NodeJS.Signals | null {
  if (signal === undefined) return null;
  const normalized = signal.startsWith("SIG") ? signal : `SIG${signal}`;
  return Object.prototype.hasOwnProperty.call(osConstants.signals, normalized)
    ? normalized as NodeJS.Signals
    : null;
}
