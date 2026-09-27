import { EventEmitter } from "node:events";
import { connect as connectTcp, type Socket } from "node:net";
import { Duplex, PassThrough, Writable } from "node:stream";

import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import type {
  DevicePeerCapabilityPorts,
  DevicePeerDirectoryEntry,
  DevicePeerFileKind,
  DevicePeerFileReadRequest,
  DevicePeerFileStat,
  DevicePeerFileTransportPort,
  DevicePeerFileWriteRequest,
  DevicePeerForwardRequest,
  DevicePeerForwardingTransportPort,
  DevicePeerLoopbackHost,
  DevicePeerMultiplexEvent,
  DevicePeerProcessHandle,
  DevicePeerProcessStartRequest,
  DevicePeerProcessTransportPort,
  DevicePeerResponseFrame,
  DevicePeerReverseForwardHandle,
  DevicePeerReverseForwardRequest,
  DevicePeerStreamEventFrame,
  DevicePeerTerminalExit,
  DevicePeerTerminalHandle,
  DevicePeerTerminalStartRequest,
  DevicePeerTerminalTransportPort
} from "@joko/device-peer";

import type {
  DevicePeerAuthority,
  DevicePeerOwner,
  DevicePeerStreamLease
} from "./device-peer-owner.js";

const MAXIMUM_FILE_BYTES = 64 * 1024 * 1024;
const MAXIMUM_STREAM_CHUNK_BYTES = 1024 * 1024;
const MAXIMUM_ARGUMENTS = 256;
const MAXIMUM_ENVIRONMENT_ENTRIES = 256;
const MAXIMUM_TEXT_BYTES = 1024 * 1024;
const MAXIMUM_PROCESS_TEXT_BYTES = 256 * 1024;

export class DevicePeerExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly stateMayHaveChanged = false
  ) {
    super(message);
    this.name = "DevicePeerExecutionError";
  }
}

/**
 * Adapts one exact controller/relation/route snapshot to the capability-neutral
 * ports consumed by Workspace, Backends, Terminal, and loopback forwarding.
 * The authority is rechecked by DevicePeerOwner immediately before and after
 * every command; no route secret or generation is persisted by these ports.
 */
export function createDevicePeerCapabilityPorts(input: {
  readonly owner: DevicePeerOwner;
  readonly authority: DevicePeerAuthority;
}): DevicePeerCapabilityPorts {
  return Object.freeze({
    files: new PeerFiles(input.owner, input.authority),
    processes: new PeerProcesses(input.owner, input.authority),
    terminals: new PeerTerminals(input.owner, input.authority),
    forwarding: new PeerForwarding(input.owner, input.authority)
  });
}

class PeerFiles implements DevicePeerFileTransportPort {
  constructor(
    private readonly owner: DevicePeerOwner,
    private readonly authority: DevicePeerAuthority
  ) {}

  async realpath(path: string, signal?: AbortSignal): Promise<string> {
    const value = await dispatch(this.owner, this.authority, command(
      contract.DevicePeerCapabilityKind.FILES,
      contract.DevicePeerEffectKind.READ_ONLY,
      "realpath",
      create(contract.DevicePeerRealpathActionSchema, { path: peerPath(path) })
    ), signal, "realpath");
    return requiredText(value, "path");
  }

  async stat(path: string, signal?: AbortSignal): Promise<DevicePeerFileStat> {
    const value = await dispatch(this.owner, this.authority, command(
      contract.DevicePeerCapabilityKind.FILES,
      contract.DevicePeerEffectKind.READ_ONLY,
      "statFile",
      create(contract.DevicePeerStatFileActionSchema, { path: peerPath(path) })
    ), signal, "fileStat") as contract.DevicePeerFileStatResult;
    return Object.freeze({
      kind: fileKind(value.kind),
      size: safeNumber(value.size, "file size"),
      modifiedAt: timestampMillis(value.modifiedAt),
      mode: boundedInteger(value.mode, 0, 0xffffffff, "file mode")
    });
  }

  async list(path: string, signal?: AbortSignal): Promise<readonly DevicePeerDirectoryEntry[]> {
    const value = await dispatch(this.owner, this.authority, command(
      contract.DevicePeerCapabilityKind.FILES,
      contract.DevicePeerEffectKind.READ_ONLY,
      "listFiles",
      create(contract.DevicePeerListFilesActionSchema, { path: peerPath(path) })
    ), signal, "fileList") as contract.DevicePeerFileListResult;
    if (!Array.isArray(value.entries)) throw protocolFailure("The peer returned an invalid file list.");
    return Object.freeze(value.entries.map((entry) => Object.freeze({
      name: safeName(entry.name),
      kind: fileKind(entry.kind)
    })));
  }

  async read(request: DevicePeerFileReadRequest): Promise<Uint8Array> {
    const maximumBytes = boundedInteger(request.maximumBytes, 1, MAXIMUM_FILE_BYTES, "maximum file bytes");
    const value = await dispatch(this.owner, this.authority, command(
      contract.DevicePeerCapabilityKind.FILES,
      contract.DevicePeerEffectKind.READ_ONLY,
      "readFile",
      create(contract.DevicePeerReadFileActionSchema, {
        path: peerPath(request.path),
        maximumBytes: BigInt(maximumBytes),
        allowTruncated: request.allowTruncated === true
      })
    ), request.signal, "fileRead") as contract.DevicePeerFileReadResult;
    if (!(value.content instanceof Uint8Array) || value.content.byteLength > maximumBytes) {
      throw protocolFailure("The peer returned an invalid file payload.");
    }
    if (value.truncated && request.allowTruncated !== true) {
      throw protocolFailure("The peer truncated a file without permission.");
    }
    return new Uint8Array(value.content);
  }

  async write(request: DevicePeerFileWriteRequest): Promise<void> {
    if (!(request.content instanceof Uint8Array) || request.content.byteLength > MAXIMUM_FILE_BYTES) {
      throw invalid("The peer file payload exceeds its limit.");
    }
    await dispatch(this.owner, this.authority, command(
      contract.DevicePeerCapabilityKind.FILES,
      contract.DevicePeerEffectKind.SIDE_EFFECT,
      "writeFile",
      create(contract.DevicePeerWriteFileActionSchema, {
        path: peerPath(request.path),
        content: new Uint8Array(request.content),
        ...(request.mode === undefined ? {} : { mode: boundedInteger(request.mode, 0, 0o7777, "file mode") }),
        createParents: request.createParents === true,
        atomic: request.atomic === true
      })
    ), request.signal, "fileMutation");
  }

  async mkdir(
    path: string,
    options?: { readonly recursive?: boolean; readonly mode?: number; readonly signal?: AbortSignal }
  ): Promise<void> {
    await dispatch(this.owner, this.authority, command(
      contract.DevicePeerCapabilityKind.FILES,
      contract.DevicePeerEffectKind.SIDE_EFFECT,
      "createDirectory",
      create(contract.DevicePeerCreateDirectoryActionSchema, {
        path: peerPath(path),
        recursive: options?.recursive === true,
        ...(options?.mode === undefined ? {} : { mode: boundedInteger(options.mode, 0, 0o7777, "directory mode") })
      })
    ), options?.signal, "directoryCreated");
  }

  async rename(sourcePath: string, destinationPath: string, signal?: AbortSignal): Promise<void> {
    await dispatch(this.owner, this.authority, command(
      contract.DevicePeerCapabilityKind.FILES,
      contract.DevicePeerEffectKind.SIDE_EFFECT,
      "renameFile",
      create(contract.DevicePeerRenameFileActionSchema, {
        sourcePath: peerPath(sourcePath),
        destinationPath: peerPath(destinationPath)
      })
    ), signal, "fileMutation");
  }

  async remove(
    path: string,
    options?: { readonly recursive?: boolean; readonly signal?: AbortSignal }
  ): Promise<void> {
    await dispatch(this.owner, this.authority, command(
      contract.DevicePeerCapabilityKind.FILES,
      contract.DevicePeerEffectKind.SIDE_EFFECT,
      "removeFile",
      create(contract.DevicePeerRemoveFileActionSchema, {
        path: peerPath(path),
        recursive: options?.recursive === true
      })
    ), options?.signal, "fileMutation");
  }
}

class PeerProcesses implements DevicePeerProcessTransportPort {
  constructor(
    private readonly owner: DevicePeerOwner,
    private readonly authority: DevicePeerAuthority
  ) {}

  async open(request: DevicePeerProcessStartRequest): Promise<DevicePeerProcessHandle> {
    validateProcessStart(request);
    const handle = new PeerProcessHandle(this.owner, this.authority);
    const stream = await dispatchStream(this.owner, this.authority, command(
      contract.DevicePeerCapabilityKind.PROCESS,
      contract.DevicePeerEffectKind.SIDE_EFFECT,
      "startProcess",
      create(contract.DevicePeerStartProcessActionSchema, {
        executable: request.executable,
        arguments: [...request.args],
        workingDirectory: peerPath(request.cwd),
        environment: Object.entries(request.env ?? {}).map(([name, value]) => create(
          contract.DevicePeerProcessEnvironmentVariableSchema,
          { name, utf8Value: Buffer.from(value, "utf8") }
        )),
        initialStandardInput: new Uint8Array()
      })
    ), request.signal, (event) => handle.accept(event));
    const started = completedPayload(stream.response, "processStarted") as contract.DevicePeerProcessStartedResult;
    handle.attach(requiredIdentifier(started.processId, "process id"), stream);
    return handle;
  }
}

class PeerProcessHandle extends EventEmitter implements DevicePeerProcessHandle {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly #owner: DevicePeerOwner;
  readonly #authority: DevicePeerAuthority;
  #processId?: string;
  #stream?: DevicePeerStreamLease;
  #terminal = false;
  #inputTail: Promise<void> = Promise.resolve();
  readonly #earlyEvents: DevicePeerMultiplexEvent[] = [];

  constructor(owner: DevicePeerOwner, authority: DevicePeerAuthority) {
    super();
    this.#owner = owner;
    this.#authority = authority;
    this.stdin = new Writable({
      write: (chunk: Buffer | string, encoding, callback) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        this.#writeInput(bytes, false).then(() => callback(), callback);
      },
      final: (callback) => this.#writeInput(new Uint8Array(), true).then(() => callback(), callback)
    });
  }

  attach(processId: string, stream: DevicePeerStreamLease): void {
    this.#processId = processId;
    this.#stream = stream;
    for (const event of this.#earlyEvents.splice(0)) this.accept(event);
  }

  accept(event: DevicePeerMultiplexEvent): void {
    if (this.#processId === undefined) {
      this.#earlyEvents.push(event);
      return;
    }
    if (event.kind === "route_closed") {
      this.#fail(new DevicePeerExecutionError("route_closed", "The Device peer process route closed.", true));
      return;
    }
    if (event.streamId !== this.#processId || event.requestId !== this.#stream?.requestId) {
      this.#fail(protocolFailure("The peer process stream identity changed."));
      return;
    }
    if (event.channel === "process_stdout") this.stdout.write(event.data);
    else if (event.channel === "process_stderr") this.stderr.write(event.data);
    else if (event.channel === "process_exit") this.#finish(event.exitCode, signalName(event.signal));
    else this.#fail(protocolFailure("The peer emitted an invalid process stream event."));
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.#terminal || this.#processId === undefined) return false;
    const mapped = processSignal(signal);
    void dispatch(this.#owner, this.#authority, command(
      contract.DevicePeerCapabilityKind.PROCESS,
      contract.DevicePeerEffectKind.SIDE_EFFECT,
      "signalProcess",
      create(contract.DevicePeerSignalProcessActionSchema, { processId: this.#processId, signal: mapped })
    ), undefined, "acknowledgement").catch((error: unknown) => this.#fail(executionError(error)));
    return true;
  }

  #writeInput(bytes: Uint8Array, close: boolean): Promise<void> {
    if (bytes.byteLength > MAXIMUM_STREAM_CHUNK_BYTES) return Promise.reject(invalid("The process input chunk is too large."));
    if (this.#terminal || this.#processId === undefined) return Promise.reject(invalid("The peer process is closed."));
    this.#inputTail = this.#inputTail.then(async () => {
      await dispatch(this.#owner, this.#authority, command(
        contract.DevicePeerCapabilityKind.PROCESS,
        contract.DevicePeerEffectKind.SIDE_EFFECT,
        "writeProcess",
        create(contract.DevicePeerWriteProcessActionSchema, {
          processId: this.#processId!,
          standardInput: new Uint8Array(bytes),
          closeStandardInput: close
        })
      ), undefined, "acknowledgement");
    });
    return this.#inputTail;
  }

  #finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#terminal) return;
    this.#terminal = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.#stream?.close();
    this.emit("exit", code, signal);
  }

  #fail(error: Error): void {
    if (this.#terminal) return;
    this.#terminal = true;
    this.stdout.destroy(error);
    this.stderr.destroy(error);
    this.#stream?.close();
    this.emit("error", error);
  }
}

class PeerTerminals implements DevicePeerTerminalTransportPort {
  constructor(
    private readonly owner: DevicePeerOwner,
    private readonly authority: DevicePeerAuthority
  ) {}

  async open(request: DevicePeerTerminalStartRequest): Promise<DevicePeerTerminalHandle> {
    validateText(request.executable, "terminal executable");
    validateArguments(request.args);
    const cols = boundedInteger(request.cols, 1, 1000, "terminal columns");
    const rows = boundedInteger(request.rows, 1, 1000, "terminal rows");
    const handle = new PeerTerminalHandle(this.owner, this.authority);
    const stream = await dispatchStream(this.owner, this.authority, command(
      contract.DevicePeerCapabilityKind.TERMINAL,
      contract.DevicePeerEffectKind.SIDE_EFFECT,
      "openTerminal",
      create(contract.DevicePeerOpenTerminalActionSchema, {
        executable: request.executable,
        arguments: [...request.args],
        workingDirectory: peerPath(request.cwd),
        columns: cols,
        rows
      })
    ), request.signal, (event) => handle.accept(event));
    const opened = completedPayload(stream.response, "terminalOpened") as contract.DevicePeerTerminalOpenedResult;
    handle.attach(requiredIdentifier(opened.terminalId, "terminal id"), stream);
    return handle;
  }
}

class PeerTerminalHandle implements DevicePeerTerminalHandle {
  readonly pid = undefined;
  readonly #owner: DevicePeerOwner;
  readonly #authority: DevicePeerAuthority;
  readonly #data = new Set<(data: string) => void>();
  readonly #exit = new Set<(event: DevicePeerTerminalExit) => void>();
  readonly #earlyEvents: DevicePeerMultiplexEvent[] = [];
  #terminalId?: string;
  #stream?: DevicePeerStreamLease;
  #closed = false;

  constructor(owner: DevicePeerOwner, authority: DevicePeerAuthority) {
    this.#owner = owner;
    this.#authority = authority;
  }

  attach(terminalId: string, stream: DevicePeerStreamLease): void {
    this.#terminalId = terminalId;
    this.#stream = stream;
    for (const event of this.#earlyEvents.splice(0)) this.accept(event);
  }

  accept(event: DevicePeerMultiplexEvent): void {
    if (this.#terminalId === undefined) {
      this.#earlyEvents.push(event);
      return;
    }
    if (event.kind === "route_closed") {
      this.#finish({ exitCode: -1, failureCode: "route_closed", processExitConfirmed: false });
      return;
    }
    if (event.streamId !== this.#terminalId || event.requestId !== this.#stream?.requestId) {
      this.#finish({ exitCode: -1, failureCode: "identity_mismatch", processExitConfirmed: false });
      return;
    }
    if (event.channel === "terminal_data") {
      for (const listener of this.#data) safely(() => listener(event.data));
    } else if (event.channel === "terminal_exit") {
      this.#finish({
        exitCode: event.exitCode,
        ...(event.signal === null ? {} : { signal: event.signal }),
        ...(event.failureCode === null ? {} : { failureCode: event.failureCode }),
        processExitConfirmed: event.processExitConfirmed
      });
    } else {
      this.#finish({ exitCode: -1, failureCode: "protocol_error", processExitConfirmed: false });
    }
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.#data.add(listener);
    return disposable(this.#data, listener);
  }

  onExit(listener: (event: DevicePeerTerminalExit) => void): { dispose(): void } {
    this.#exit.add(listener);
    return disposable(this.#exit, listener);
  }

  async write(data: string): Promise<void> {
    const bytes = Buffer.from(data, "utf8");
    if (bytes.byteLength > MAXIMUM_STREAM_CHUNK_BYTES) throw invalid("The terminal input chunk is too large.");
    await this.#control("writeTerminal", create(contract.DevicePeerWriteTerminalActionSchema, {
      terminalId: this.#requireOpen(), data: bytes
    }));
  }

  async resize(cols: number, rows: number): Promise<void> {
    await this.#control("resizeTerminal", create(contract.DevicePeerResizeTerminalActionSchema, {
      terminalId: this.#requireOpen(),
      columns: boundedInteger(cols, 1, 1000, "terminal columns"),
      rows: boundedInteger(rows, 1, 1000, "terminal rows")
    }));
  }

  async kill(): Promise<void> {
    await this.#control("killTerminal", create(contract.DevicePeerKillTerminalActionSchema, {
      terminalId: this.#requireOpen()
    }));
  }

  pause(): void {
    void this.#control("pauseTerminal", create(contract.DevicePeerPauseTerminalActionSchema, {
      terminalId: this.#requireOpen()
    })).catch(() => undefined);
  }

  resume(): void {
    void this.#control("resumeTerminal", create(contract.DevicePeerResumeTerminalActionSchema, {
      terminalId: this.#requireOpen()
    })).catch(() => undefined);
  }

  async #control(
    action: Exclude<contract.DevicePeerCommand["action"]["case"], undefined>,
    value: object
  ): Promise<void> {
    await dispatch(this.#owner, this.#authority, command(
      contract.DevicePeerCapabilityKind.TERMINAL,
      contract.DevicePeerEffectKind.SIDE_EFFECT,
      action,
      value
    ), undefined, "acknowledgement");
  }

  #requireOpen(): string {
    if (this.#closed || this.#terminalId === undefined) throw invalid("The peer terminal is closed.");
    return this.#terminalId;
  }

  #finish(event: DevicePeerTerminalExit): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stream?.close();
    for (const listener of this.#exit) safely(() => listener(Object.freeze(event)));
    this.#data.clear();
    this.#exit.clear();
  }
}

class PeerForwarding implements DevicePeerForwardingTransportPort {
  constructor(
    private readonly owner: DevicePeerOwner,
    private readonly authority: DevicePeerAuthority
  ) {}

  async open(request: DevicePeerForwardRequest): Promise<Duplex> {
    const forward = new PeerForward(this.owner, this.authority);
    const stream = await dispatchStream(this.owner, this.authority, command(
      contract.DevicePeerCapabilityKind.FORWARDING,
      contract.DevicePeerEffectKind.SIDE_EFFECT,
      "openLoopbackForward",
      create(contract.DevicePeerOpenLoopbackForwardActionSchema, {
        destinationHost: loopbackHost(request.destinationHost),
        destinationPort: port(request.destinationPort)
      })
    ), request.signal, (event) => forward.accept(event));
    const opened = completedPayload(stream.response, "loopbackForwardOpened") as contract.DevicePeerLoopbackForwardOpenedResult;
    forward.attach(requiredIdentifier(opened.forwardId, "forward id"), stream);
    return forward;
  }

  async listen(request: DevicePeerReverseForwardRequest): Promise<DevicePeerReverseForwardHandle> {
    const listener = new PeerReverseForward(this.owner, this.authority, request);
    const stream = await dispatchStream(this.owner, this.authority, command(
      contract.DevicePeerCapabilityKind.FORWARDING,
      contract.DevicePeerEffectKind.SIDE_EFFECT,
      "listenLoopbackForward",
      create(contract.DevicePeerListenLoopbackForwardActionSchema, {
        serviceDestinationHost: loopbackHost(request.localDestinationHost),
        serviceDestinationPort: port(request.localDestinationPort),
        peerListenHost: loopbackHost(request.remoteListenHost ?? "127.0.0.1"),
        peerListenPort: 0
      })
    ), request.signal, (event) => listener.accept(event));
    const opened = completedPayload(stream.response, "loopbackListenerOpened") as contract.DevicePeerLoopbackListenerOpenedResult;
    listener.attach(
      requiredIdentifier(opened.listenerId, "listener id"),
      loopbackHostValue(opened.peerListenHost),
      port(opened.peerListenPort),
      stream
    );
    return listener;
  }
}

class PeerForward extends Duplex {
  readonly #owner: DevicePeerOwner;
  readonly #authority: DevicePeerAuthority;
  readonly #earlyEvents: DevicePeerMultiplexEvent[] = [];
  #forwardId?: string;
  #stream?: DevicePeerStreamLease;
  #remoteClosed = false;

  constructor(owner: DevicePeerOwner, authority: DevicePeerAuthority) {
    super();
    this.#owner = owner;
    this.#authority = authority;
  }

  attach(forwardId: string, stream: DevicePeerStreamLease): void {
    this.#forwardId = forwardId;
    this.#stream = stream;
    for (const event of this.#earlyEvents.splice(0)) this.accept(event);
  }

  accept(event: DevicePeerMultiplexEvent): void {
    if (this.#forwardId === undefined) {
      this.#earlyEvents.push(event);
      return;
    }
    if (event.kind === "route_closed") {
      this.destroy(new DevicePeerExecutionError("route_closed", "The Device peer forward route closed.", true));
      return;
    }
    if (event.requestId !== this.#stream?.requestId || event.streamId !== this.#forwardId) {
      this.destroy(protocolFailure("The peer forward stream identity changed."));
      return;
    }
    if (event.channel === "forward_data") this.push(Buffer.from(event.data));
    else if (event.channel === "forward_close") {
      this.#remoteClosed = true;
      if (event.errorCode === null) this.push(null);
      else this.destroy(new DevicePeerExecutionError(event.errorCode, "The Device peer forward closed."));
    } else this.destroy(protocolFailure("The peer emitted an invalid forward stream event."));
  }

  override _read(): void {}

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    if (bytes.byteLength > MAXIMUM_STREAM_CHUNK_BYTES) {
      callback(invalid("The forwarding chunk is too large."));
      return;
    }
    this.#write(bytes, false).then(() => callback(), callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#write(new Uint8Array(), true).then(() => callback(), callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    const forwardId = this.#forwardId;
    this.#stream?.close();
    if (forwardId === undefined || this.#remoteClosed) {
      callback(error);
      return;
    }
    dispatch(this.#owner, this.#authority, command(
      contract.DevicePeerCapabilityKind.FORWARDING,
      contract.DevicePeerEffectKind.SIDE_EFFECT,
      "closeLoopbackForward",
      create(contract.DevicePeerCloseLoopbackForwardActionSchema, { forwardId })
    ), undefined, "acknowledgement").then(() => callback(error), () => callback(error));
  }

  #write(bytes: Uint8Array, closeWrite: boolean): Promise<unknown> {
    if (this.#forwardId === undefined) return Promise.reject(invalid("The peer forward is not open."));
    return dispatch(this.#owner, this.#authority, command(
      contract.DevicePeerCapabilityKind.FORWARDING,
      contract.DevicePeerEffectKind.SIDE_EFFECT,
      "writeLoopbackForward",
      create(contract.DevicePeerWriteLoopbackForwardActionSchema, {
        forwardId: this.#forwardId,
        data: new Uint8Array(bytes),
        closeWrite
      })
    ), undefined, "acknowledgement");
  }
}

class PeerReverseForward implements DevicePeerReverseForwardHandle {
  remoteHost: DevicePeerLoopbackHost = "127.0.0.1";
  remotePort = 0;
  readonly #owner: DevicePeerOwner;
  readonly #authority: DevicePeerAuthority;
  readonly #request: DevicePeerReverseForwardRequest;
  readonly #sockets = new Map<string, { readonly socket: Socket; tail: Promise<void> }>();
  readonly #earlyEvents: DevicePeerMultiplexEvent[] = [];
  #listenerId?: string;
  #stream?: DevicePeerStreamLease;
  #closed = false;

  constructor(owner: DevicePeerOwner, authority: DevicePeerAuthority, request: DevicePeerReverseForwardRequest) {
    this.#owner = owner;
    this.#authority = authority;
    this.#request = request;
  }

  attach(listenerId: string, remoteHost: DevicePeerLoopbackHost, remotePort: number, stream: DevicePeerStreamLease): void {
    this.#listenerId = listenerId;
    this.remoteHost = remoteHost;
    this.remotePort = remotePort;
    this.#stream = stream;
    for (const event of this.#earlyEvents.splice(0)) this.accept(event);
  }

  accept(event: DevicePeerMultiplexEvent): void {
    if (this.#listenerId === undefined) {
      this.#earlyEvents.push(event);
      return;
    }
    if (event.kind === "route_closed") {
      void this.#retireSockets();
      return;
    }
    if (event.requestId !== this.#stream?.requestId) {
      void this.#retireSockets();
      return;
    }
    if (event.channel === "reverse_forward_open") this.#openSocket(event.streamId);
    else if (event.channel === "reverse_forward_data") this.#sockets.get(event.streamId)?.socket.write(event.data);
    else if (event.channel === "reverse_forward_close") this.#closeSocket(event.streamId);
    else if (event.channel === "forward_close" && event.streamId === this.#listenerId) void this.#retireSockets();
    else void this.#retireSockets();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const listenerId = this.#listenerId;
    await this.#retireSockets();
    this.#stream?.close();
    if (listenerId !== undefined) {
      await dispatch(this.#owner, this.#authority, command(
        contract.DevicePeerCapabilityKind.FORWARDING,
        contract.DevicePeerEffectKind.SIDE_EFFECT,
        "closeLoopbackListener",
        create(contract.DevicePeerCloseLoopbackListenerActionSchema, { listenerId })
      ), undefined, "acknowledgement");
    }
  }

  #openSocket(connectionId: string): void {
    if (this.#closed || this.#sockets.has(connectionId) || this.#listenerId === undefined) return;
    const socket = connectTcp({
      host: this.#request.localDestinationHost,
      port: this.#request.localDestinationPort
    });
    const entry = { socket, tail: Promise.resolve() };
    this.#sockets.set(connectionId, entry);
    socket.on("data", (data: Buffer) => {
      socket.pause();
      entry.tail = entry.tail.then(async () => {
        await dispatch(this.#owner, this.#authority, command(
          contract.DevicePeerCapabilityKind.FORWARDING,
          contract.DevicePeerEffectKind.SIDE_EFFECT,
          "writeReverseForward",
          create(contract.DevicePeerWriteReverseForwardActionSchema, {
            listenerId: this.#listenerId!, connectionId, data, closeWrite: false
          })
        ), undefined, "acknowledgement");
      }).then(() => { socket.resume(); }, () => { socket.destroy(); });
    });
    socket.once("end", () => this.#closeRemoteWrite(connectionId));
    socket.once("error", () => this.#closeRemoteConnection(connectionId));
    socket.once("close", () => this.#closeRemoteConnection(connectionId));
  }

  #closeRemoteWrite(connectionId: string): void {
    if (this.#listenerId === undefined) return;
    void dispatch(this.#owner, this.#authority, command(
      contract.DevicePeerCapabilityKind.FORWARDING,
      contract.DevicePeerEffectKind.SIDE_EFFECT,
      "writeReverseForward",
      create(contract.DevicePeerWriteReverseForwardActionSchema, {
        listenerId: this.#listenerId, connectionId, data: new Uint8Array(), closeWrite: true
      })
    ), undefined, "acknowledgement").catch(() => undefined);
  }

  #closeRemoteConnection(connectionId: string): void {
    if (!this.#sockets.delete(connectionId) || this.#listenerId === undefined) return;
    void dispatch(this.#owner, this.#authority, command(
      contract.DevicePeerCapabilityKind.FORWARDING,
      contract.DevicePeerEffectKind.SIDE_EFFECT,
      "closeReverseForwardConnection",
      create(contract.DevicePeerCloseReverseForwardConnectionActionSchema, {
        listenerId: this.#listenerId, connectionId
      })
    ), undefined, "acknowledgement").catch(() => undefined);
  }

  #closeSocket(connectionId: string): void {
    const entry = this.#sockets.get(connectionId);
    if (entry === undefined) return;
    this.#sockets.delete(connectionId);
    entry.socket.destroy();
  }

  async #retireSockets(): Promise<void> {
    for (const entry of this.#sockets.values()) entry.socket.destroy();
    this.#sockets.clear();
  }
}

async function dispatch(
  owner: DevicePeerOwner,
  authority: DevicePeerAuthority,
  payload: contract.DevicePeerCommand,
  signal: AbortSignal | undefined,
  expectedCase: contract.DevicePeerAgentResult["payload"]["case"]
): Promise<unknown> {
  const response = await owner.dispatch(authority, {
    capability: capability(payload.capability),
    effectKind: effect(payload.effect),
    action: requiredAction(payload),
    payload,
    ...(signal === undefined ? {} : { signal })
  });
  return completedPayload(response, expectedCase);
}

async function dispatchStream(
  owner: DevicePeerOwner,
  authority: DevicePeerAuthority,
  payload: contract.DevicePeerCommand,
  signal: AbortSignal | undefined,
  listener: (event: DevicePeerMultiplexEvent) => void
): Promise<DevicePeerStreamLease> {
  return owner.dispatchStream(authority, {
    capability: capability(payload.capability),
    effectKind: effect(payload.effect),
    action: requiredAction(payload),
    payload,
    ...(signal === undefined ? {} : { signal })
  }, listener);
}

function completedPayload(
  response: DevicePeerResponseFrame,
  expectedCase: contract.DevicePeerAgentResult["payload"]["case"]
): unknown {
  if (response.outcome !== "completed") throw responseError(response);
  const payload = response.value;
  if (typeof payload !== "object" || payload === null || !("case" in payload) || !("value" in payload)
    || (payload as { case?: unknown }).case !== expectedCase) {
    throw protocolFailure("The Device peer returned an unexpected response payload.");
  }
  return (payload as { value: unknown }).value;
}

function responseError(response: Exclude<DevicePeerResponseFrame, { readonly outcome: "completed" }>): Error {
  if (response.outcome === "aborted") {
    const error = new DevicePeerExecutionError("aborted", "The Device peer request was cancelled.");
    error.name = "AbortError";
    return error;
  }
  return new DevicePeerExecutionError(
    response.errorCode,
    response.outcome === "outcome_unknown"
      ? "The Device peer effect may have completed; its outcome is unknown."
      : "The Device peer request failed.",
    response.outcome === "outcome_unknown"
  );
}

function command(
  capabilityValue: contract.DevicePeerCapabilityKind,
  effectValue: contract.DevicePeerEffectKind,
  actionCase: Exclude<contract.DevicePeerCommand["action"]["case"], undefined>,
  value: object
): contract.DevicePeerCommand {
  return create(contract.DevicePeerCommandSchema, {
    capability: capabilityValue,
    effect: effectValue,
    action: { case: actionCase, value } as contract.DevicePeerCommand["action"]
  });
}

function requiredAction(value: contract.DevicePeerCommand): string {
  if (value.action.case === undefined) throw invalid("A Device peer command action is required.");
  return value.action.case;
}

function capability(value: contract.DevicePeerCapabilityKind): "files" | "process" | "terminal" | "forwarding" {
  if (value === contract.DevicePeerCapabilityKind.FILES) return "files";
  if (value === contract.DevicePeerCapabilityKind.PROCESS) return "process";
  if (value === contract.DevicePeerCapabilityKind.TERMINAL) return "terminal";
  if (value === contract.DevicePeerCapabilityKind.FORWARDING) return "forwarding";
  throw invalid("A Device peer capability is required.");
}

function effect(value: contract.DevicePeerEffectKind): "read_only" | "side_effect" {
  if (value === contract.DevicePeerEffectKind.READ_ONLY) return "read_only";
  if (value === contract.DevicePeerEffectKind.SIDE_EFFECT) return "side_effect";
  throw invalid("A Device peer effect kind is required.");
}

function fileKind(value: contract.DevicePeerFileKind): DevicePeerFileKind {
  if (value === contract.DevicePeerFileKind.FILE) return "file";
  if (value === contract.DevicePeerFileKind.DIRECTORY) return "directory";
  if (value === contract.DevicePeerFileKind.SYMBOLIC_LINK) return "symbolic_link";
  if (value === contract.DevicePeerFileKind.OTHER) return "other";
  throw protocolFailure("The peer returned an invalid file kind.");
}

function loopbackHost(value: DevicePeerLoopbackHost): contract.DevicePeerLoopbackHost {
  if (value === "127.0.0.1") return contract.DevicePeerLoopbackHost.IPV4;
  if (value === "::1") return contract.DevicePeerLoopbackHost.IPV6;
  if (value === "localhost") return contract.DevicePeerLoopbackHost.LOCALHOST;
  throw invalid("Device peer forwarding is restricted to loopback.");
}

function loopbackHostValue(value: contract.DevicePeerLoopbackHost): DevicePeerLoopbackHost {
  if (value === contract.DevicePeerLoopbackHost.IPV4) return "127.0.0.1";
  if (value === contract.DevicePeerLoopbackHost.IPV6) return "::1";
  if (value === contract.DevicePeerLoopbackHost.LOCALHOST) return "localhost";
  throw protocolFailure("The peer returned an invalid loopback host.");
}

function processSignal(value: NodeJS.Signals | number): contract.DevicePeerProcessSignal {
  if (value === "SIGINT" || value === 2) return contract.DevicePeerProcessSignal.INTERRUPT;
  if (value === "SIGKILL" || value === 9) return contract.DevicePeerProcessSignal.KILL;
  if (value === "SIGTERM" || value === 15) return contract.DevicePeerProcessSignal.TERMINATE;
  throw invalid("Only interrupt, terminate, and kill are supported by Device peer processes.");
}

function signalName(value: string | null): NodeJS.Signals | null {
  if (value === null) return null;
  if (value === "SIGINT" || value === "SIGTERM" || value === "SIGKILL") return value;
  throw protocolFailure("The peer returned an invalid process signal.");
}

function validateProcessStart(value: DevicePeerProcessStartRequest): void {
  validateText(value.executable, "process executable");
  peerPath(value.cwd);
  validateArguments(value.args);
  const entries = Object.entries(value.env ?? {});
  if (entries.length > MAXIMUM_ENVIRONMENT_ENTRIES) throw invalid("The peer process environment is too large.");
  let bytes = 0;
  for (const [name, content] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw invalid("A peer process environment name is invalid.");
    bytes += Buffer.byteLength(name) + Buffer.byteLength(content);
  }
  if (bytes > MAXIMUM_PROCESS_TEXT_BYTES) throw invalid("The peer process environment is too large.");
}

function validateArguments(values: readonly string[]): void {
  if (values.length > MAXIMUM_ARGUMENTS) throw invalid("The peer process has too many arguments.");
  let bytes = 0;
  for (const value of values) {
    validateText(value, "process argument", true);
    bytes += Buffer.byteLength(value);
  }
  if (bytes > MAXIMUM_PROCESS_TEXT_BYTES) throw invalid("The peer process arguments are too large.");
}

function peerPath(value: string): string {
  validateText(value, "peer path");
  return value;
}

function validateText(value: string, label: string, allowEmpty = false): void {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.includes("\0")
    || Buffer.byteLength(value) > MAXIMUM_TEXT_BYTES) throw invalid(`The ${label} is invalid.`);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "object" || value === null || !(label in value)) throw protocolFailure("The peer response is incomplete.");
  const text = (value as Record<string, unknown>)[label];
  if (typeof text !== "string") throw protocolFailure("The peer response contains invalid text.");
  validateText(text, label);
  return text;
}

function requiredIdentifier(value: string, label: string): string {
  if (value.length < 1 || value.length > 256 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw protocolFailure(`The peer returned an invalid ${label}.`);
  }
  return value;
}

function safeName(value: string): string {
  if (value === "" || value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw protocolFailure("The peer returned an unsafe file name.");
  }
  return value;
}

function timestampMillis(value: { readonly seconds: bigint; readonly nanos: number } | undefined): number {
  if (value === undefined || value.seconds < 0n || value.nanos < 0 || value.nanos >= 1_000_000_000) {
    throw protocolFailure("The peer returned an invalid timestamp.");
  }
  const result = Number(value.seconds) * 1000 + Math.trunc(value.nanos / 1_000_000);
  if (!Number.isSafeInteger(result)) throw protocolFailure("The peer returned an invalid timestamp.");
  return result;
}

function safeNumber(value: bigint, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw protocolFailure(`The peer returned an invalid ${label}.`);
  return result;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalid(`The ${label} is invalid.`);
  return value;
}

function port(value: number): number {
  return boundedInteger(value, 1, 65535, "loopback port");
}

function invalid(message: string): DevicePeerExecutionError {
  return new DevicePeerExecutionError("invalid_request", message);
}

function protocolFailure(message: string): DevicePeerExecutionError {
  return new DevicePeerExecutionError("protocol_error", message, true);
}

function executionError(error: unknown): Error {
  return error instanceof Error ? error : new DevicePeerExecutionError("internal", "The Device peer request failed.");
}

function disposable<T>(set: Set<T>, value: T): { dispose(): void } {
  let disposed = false;
  return { dispose: () => { if (!disposed) { disposed = true; set.delete(value); } } };
}

function safely(effect: () => void): void {
  try { effect(); } catch { /* One observer cannot break a sibling stream observer. */ }
}

// Ensure stream variants remain exhaustively imported at this boundary.
void (undefined as DevicePeerStreamEventFrame | undefined);
