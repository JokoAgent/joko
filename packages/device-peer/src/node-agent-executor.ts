import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  constants,
  type Dirent,
  type Stats
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { clone, create, toBinary } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  DevicePeerAcknowledgementSchema,
  DevicePeerCapabilityKind,
  type DevicePeerCommand,
  DevicePeerDirectoriesResultSchema,
  DevicePeerDirectoryAvailability,
  DevicePeerDirectoryCreatedResultSchema,
  DevicePeerDirectoryInspectionResultSchema,
  DevicePeerDirectoryKind,
  DevicePeerEffectKind,
  DevicePeerFailureCode,
  DevicePeerFailureSchema,
  DevicePeerFileKind,
  DevicePeerFileListResultSchema,
  DevicePeerFileMutationResultSchema,
  DevicePeerFileReadResultSchema,
  DevicePeerFileStatResultSchema,
  DevicePeerLoopbackForwardClosedResultSchema,
  DevicePeerLoopbackForwardDataResultSchema,
  DevicePeerLoopbackForwardOpenedResultSchema,
  DevicePeerLoopbackHost,
  DevicePeerLoopbackListenerClosedResultSchema,
  DevicePeerLoopbackListenerOpenedResultSchema,
  DevicePeerProcessExitedResultSchema,
  DevicePeerProcessOutputResultSchema,
  DevicePeerProcessOutputStream,
  DevicePeerProcessSignal,
  DevicePeerProcessStartedResultSchema,
  DevicePeerRealpathResultSchema,
  DevicePeerRecentDirectoriesResultSchema,
  DevicePeerResponsePhase,
  type DevicePeerSendRemoteDesktopInputAction,
  DevicePeerSendRemoteDesktopInputActionSchema,
  type DevicePeerAgentResult,
  DevicePeerAgentResultSchema,
  DevicePeerReverseForwardConnectionClosedResultSchema,
  DevicePeerReverseForwardConnectionOpenedResultSchema,
  DevicePeerReverseForwardDataResultSchema,
  DevicePeerTerminalExitedResultSchema,
  DevicePeerTerminalOpenedResultSchema,
  DevicePeerTerminalOutputResultSchema,
  type RemoteDesktopClipboardContent,
  RemoteDesktopClipboardContentResultSchema,
  type RemoteDesktopClipboardContentRequest,
  type RemoteDesktopClipboardTextRequest,
  RemoteDesktopClipboardTextResultSchema,
  type RemoteDesktopCapabilities,
  RemoteDesktopCapabilitiesSchema,
  type RemoteDesktopControlState,
  RemoteDesktopControlStateSchema,
  type RemoteDesktopCursor,
  type RemoteDesktopDisplay,
  type RemoteDesktopDisplayMode,
  DevicePeerRemoteDesktopDisplayModesResultSchema,
  RemoteDesktopFailureReason,
  RemoteDesktopFailureSchema,
  type RemoteDesktopFrameResult,
  RemoteDesktopFrameResultSchema,
  type RemoteDesktopIceCandidate,
  RemoteDesktopIceCandidateSchema,
  type RemoteDesktopIceExchangeResult,
  RemoteDesktopIceExchangeResultSchema,
  type RemoteDesktopInputEvent,
  RemoteDesktopInputEventSchema,
  type RemoteDesktopLease,
  RemoteDesktopLeaseSchema,
  RemoteDesktopMouseButton,
  type RemoteDesktopOfferResult,
  RemoteDesktopOfferResultSchema,
  type RemoteDesktopPermissions,
  RemoteDesktopPermissionsSchema,
  RemoteDesktopPermissionStatus,
  type RemoteDesktopPresentationProof,
  RemoteDesktopPresentationProofSchema,
  RemoteDesktopStartMode,
  type RemoteDesktopVideoSettings,
  RemoteDesktopVideoQuality,
  RemoteDesktopVideoSettingsSchema
} from "@joko/contracts";
import {
  DevicePeerRemoteDesktopHostError,
  type DevicePeerRemoteDesktopHostPort,
  type DevicePeerFileStat,
  type DevicePeerFileTransportPort,
  type DevicePeerProcessHandle,
  type DevicePeerProcessStartRequest,
  type DevicePeerProcessTransportPort,
  type DevicePeerTerminalHandle,
  type DevicePeerTerminalTransportPort
} from "./ports.js";
import { atomicWritePrivateFile, readPrivateFile, sameFileIdentity, sameStableFile } from "./private-files.js";
import {
  isBoundedRemoteDesktopCursorPng,
  parseRemoteDesktopClipboardContentJson,
  REMOTE_DESKTOP_CLIPBOARD_CHUNK_CHARACTERS,
  REMOTE_DESKTOP_CLIPBOARD_MAX_CHARACTERS,
  REMOTE_DESKTOP_CLIPBOARD_TRANSFER_IDLE_MS,
  REMOTE_DESKTOP_MAX_CLIPBOARD_TEXT_CHARACTERS,
  stringifyRemoteDesktopClipboardContent
} from "./remote-desktop.js";

const MAXIMUM_PATH_BYTES = 16_384;
const MAXIMUM_PATH_COMPONENTS = 256;
const MAXIMUM_DIRECTORY_ENTRIES = 10_000;
const MAXIMUM_BROWSE_SCAN = 4_096;
const MAXIMUM_BROWSE_RESULTS = 200;
const MAXIMUM_FILE_BYTES = 64 * 1_024 * 1_024;
const MAXIMUM_PROCESS_ARGUMENTS = 512;
const MAXIMUM_PROCESS_ARGUMENT_BYTES = 256 * 1_024;
const MAXIMUM_PROCESS_ENVIRONMENT_ENTRIES = 256;
const MAXIMUM_PROCESS_ENVIRONMENT_BYTES = 256 * 1_024;
const MAXIMUM_PROCESS_INPUT_BYTES = 1 * 1_024 * 1_024;
const MAXIMUM_STREAM_FRAME_BYTES = 64 * 1_024;
const MAXIMUM_ACTIVE_PROCESSES = 64;
const MAXIMUM_ACTIVE_TERMINALS = 64;
const MAXIMUM_ACTIVE_FORWARDS = 128;
const MAXIMUM_ACTIVE_LISTENERS = 32;
const MAXIMUM_REVERSE_CONNECTIONS = 256;
const MAXIMUM_RECENT_DIRECTORIES = 100;
const MAXIMUM_REMOVE_DEPTH = 128;
const MAXIMUM_REMOTE_DESKTOP_DISPLAYS = 32;
const MAXIMUM_REMOTE_DESKTOP_DISPLAY_ID_CHARACTERS = 128;
const MAXIMUM_REMOTE_DESKTOP_DISPLAY_NAME_CHARACTERS = 256;
const MAXIMUM_REMOTE_DESKTOP_PLATFORM_CHARACTERS = 64;
const MAXIMUM_REMOTE_DESKTOP_LEASE_ID_CHARACTERS = 128;
const MAXIMUM_REMOTE_DESKTOP_ATTEMPT_ID_CHARACTERS = 128;
const MAXIMUM_REMOTE_DESKTOP_SDP_BYTES = 64 * 1_024;
const MAXIMUM_REMOTE_DESKTOP_INPUT_EVENTS = 64;
const MAXIMUM_REMOTE_DESKTOP_INPUT_BYTES = 16_384;
const MAXIMUM_REMOTE_DESKTOP_TEXT_CHARACTERS = 4_096;
const MAXIMUM_REMOTE_DESKTOP_SCROLL_DELTA = 2_000;
const MAXIMUM_REMOTE_DESKTOP_ICE_CANDIDATES = 16;
const MAXIMUM_REMOTE_DESKTOP_ICE_TOTAL = 128;
const MAXIMUM_REMOTE_DESKTOP_ICE_CANDIDATE_CHARACTERS = 2_048;
const MAXIMUM_REMOTE_DESKTOP_ICE_MID_CHARACTERS = 128;
const MAXIMUM_REMOTE_DESKTOP_ICE_USERNAME_FRAGMENT_CHARACTERS = 256;
const MAXIMUM_REMOTE_DESKTOP_FRAME_BYTES = 180_000;
const MAXIMUM_REMOTE_DESKTOP_DIMENSION = 32_768;
const MAXIMUM_REMOTE_DESKTOP_DISPLAY_MODES = 256;
const MAXIMUM_REMOTE_DESKTOP_CURSOR_DIMENSION = 256;
const RESOURCE_RETIRE_TIMEOUT_MS = 5_000;
const REMOTE_DESKTOP_KEY_CODES = new Set([
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((key) => `Key${key}`),
  ..."0123456789".split("").map((key) => `Digit${key}`),
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
  "Enter", "Escape", "Tab", "Space", "Backspace", "Delete", "Insert",
  "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "ShiftLeft", "ControlLeft", "AltLeft", "MetaLeft", "Minus", "Equal", "BracketLeft",
  "BracketRight", "Backslash", "Semicolon", "Quote", "Backquote", "Comma", "Period", "Slash"
]);

type AgentPayload = DevicePeerAgentResult["payload"];

export interface NodeDevicePeerAgentEmission extends DevicePeerAgentResult {}

export interface NodeDevicePeerAgentExecutorOptions {
  /** Target-owned private file; it is never exposed to renderer or controller. */
  readonly recentDirectoriesPath: string;
  readonly files?: DevicePeerFileTransportPort;
  readonly processes?: DevicePeerProcessTransportPort;
  /** Omit when the packaged runtime has no audited native PTY. */
  readonly terminals?: DevicePeerTerminalTransportPort;
  /** Omit outside the trusted Desktop Main host or while local opt-in is off. */
  readonly remoteDesktop?: DevicePeerRemoteDesktopHostPort;
  /** Process-local executable identities. Reserved runtime tokens are resolved
   * only here and are never persisted in Target or Session bindings. */
  readonly runtimeExecutables?: NodeDevicePeerRuntimeExecutableMap;
}

export const DEVICE_PEER_RUNTIME_EXECUTABLES = Object.freeze({
  node: "joko-runtime:node",
  pi: "joko-runtime:pi",
  codex: "joko-runtime:codex",
  claude: "joko-runtime:claude"
} as const);

export type DevicePeerRuntimeExecutableName = keyof typeof DEVICE_PEER_RUNTIME_EXECUTABLES;

export interface NodeDevicePeerRuntimeExecutable {
  readonly executable: string;
  readonly argumentPrefix?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
}

export type NodeDevicePeerRuntimeExecutableMap = Readonly<
  Partial<Record<DevicePeerRuntimeExecutableName, NodeDevicePeerRuntimeExecutable>>
>;

export type NodeDevicePeerAgentEmitter = (
  result: NodeDevicePeerAgentEmission
) => void | Promise<void>;

/**
 * Main/service-owned target executor. It consumes only generated commands and
 * emits generated results; no command, process data, environment, or route
 * credential is persisted or logged.
 */
export class NodeDevicePeerAgentExecutor {
  readonly #recentDirectories: NodeDevicePeerRecentDirectoryStore;
  readonly #files: DevicePeerFileTransportPort;
  readonly #processes: DevicePeerProcessTransportPort;
  readonly #terminals: DevicePeerTerminalTransportPort | undefined;
  readonly #remoteDesktop: DevicePeerRemoteDesktopHostPort | undefined;
  readonly #runtimeExecutables: NodeDevicePeerRuntimeExecutableMap;
  readonly #activeProcesses = new Map<string, DevicePeerProcessHandle>();
  readonly #activeTerminals = new Map<string, DevicePeerTerminalHandle>();
  readonly #activeForwards = new Map<string, Socket>();
  readonly #activeListeners = new Map<string, ReverseListener>();
  readonly #reverseConnections = new Map<string, Socket>();
  #remoteDesktopClipboardTransfer: RemoteDesktopClipboardTransferState | undefined;
  #remoteDesktopClipboardBusy = false;
  #retired = false;

  constructor(options: NodeDevicePeerAgentExecutorOptions) {
    this.#recentDirectories = new NodeDevicePeerRecentDirectoryStore(options.recentDirectoriesPath);
    this.#files = options.files ?? new LocalDevicePeerFileTransport();
    this.#processes = options.processes ?? new LocalDevicePeerProcessTransport();
    this.#terminals = options.terminals;
    this.#remoteDesktop = options.remoteDesktop;
    this.#runtimeExecutables = validateRuntimeExecutables(options.runtimeExecutables ?? {});
  }

  get capabilities(): readonly DevicePeerCapabilityKind[] {
    return Object.freeze([
      DevicePeerCapabilityKind.FILES,
      DevicePeerCapabilityKind.PROCESS,
      ...(this.#terminals === undefined ? [] : [DevicePeerCapabilityKind.TERMINAL]),
      DevicePeerCapabilityKind.FORWARDING,
      ...(this.#remoteDesktop === undefined ? [] : [DevicePeerCapabilityKind.REMOTE_DESKTOP])
    ]);
  }

  /** Records only a successfully adopted peer project directory. */
  recordRecentDirectory(path: string, name?: string): Promise<void> {
    this.#assertActive();
    return this.#recentDirectories.record(path, name);
  }

  async execute(command: DevicePeerCommand, signal: AbortSignal, emit: NodeDevicePeerAgentEmitter): Promise<void> {
    const output = new AgentOutput(emit);
    this.#assertActive();
    signal.throwIfAborted();
    const specification = commandSpecification(
      command,
      this.#terminals !== undefined,
      this.#remoteDesktop !== undefined
    );
    validateCommandInput(command);

    await output.emit(DevicePeerResponsePhase.ACCEPTED, {
      case: "acknowledgement",
      value: create(DevicePeerAcknowledgementSchema)
    });
    try {
      signal.throwIfAborted();
      const payload = await this.#perform(command, signal, output);
      if (payload !== undefined) await output.emit(DevicePeerResponsePhase.COMPLETED, payload);
    } catch (error) {
      if (output.dispatchCompleted) throw error;
      // Validation happens before ACCEPTED. Any failure here is an admitted
      // request terminal; route loss is handled by the transport owner.
      await output.terminalFailure(error, specification.effect === DevicePeerEffectKind.SIDE_EFFECT);
    }
  }

  async retire(): Promise<void> {
    if (this.#retired) return;
    this.#retired = true;
    this.#resetRemoteDesktopClipboardTransfer();
    const terminals = [...this.#activeTerminals.values()];
    const listeners = [...this.#activeListeners.values()];
    for (const process of this.#activeProcesses.values()) process.kill("SIGTERM");
    for (const socket of this.#activeForwards.values()) socket.destroy();
    for (const socket of this.#reverseConnections.values()) socket.destroy();
    await Promise.race([
      Promise.allSettled([
        ...terminals.map((terminal) => terminal.kill()),
        ...(this.#remoteDesktop === undefined
          ? []
          : [Promise.resolve().then(() => this.#remoteDesktop!.retire())]),
        ...listeners.map(async (listener) => {
          for (const key of listener.connections) this.#reverseConnections.get(key)?.destroy();
          await closeServer(listener.server);
          await Promise.allSettled([...listener.pumps]);
        })
      ]),
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, RESOURCE_RETIRE_TIMEOUT_MS))
    ]);
    for (const process of this.#activeProcesses.values()) process.kill("SIGKILL");
    this.#activeProcesses.clear();
    this.#activeTerminals.clear();
    this.#activeForwards.clear();
    this.#activeListeners.clear();
    this.#reverseConnections.clear();
  }

  async #perform(
    command: DevicePeerCommand,
    signal: AbortSignal,
    output: AgentOutput
  ): Promise<AgentPayload | undefined> {
    switch (command.action.case) {
      case "listRecentDirectories":
        return {
          case: "recentDirectories",
          value: create(DevicePeerRecentDirectoriesResultSchema,
            await this.#recentDirectories.list(command.action.value.maximumEntries, signal))
        };
      case "listDirectories":
        return {
          case: "directories",
          value: create(DevicePeerDirectoriesResultSchema,
            mutableDirectoryListing(
              await listProjectDirectories(command.action.value.path, command.action.value.maximumEntries, signal)
            ))
        };
      case "inspectDirectory":
        return {
          case: "directoryInspection",
          value: create(DevicePeerDirectoryInspectionResultSchema,
            await inspectProjectDirectory(command.action.value.path, signal))
        };
      case "createDirectory": {
        const path = localPath(command.action.value.path);
        await this.#files.mkdir(path, {
          recursive: command.action.value.recursive,
          ...(command.action.value.mode === undefined ? {} : { mode: command.action.value.mode }),
          signal
        });
        return {
          case: "directoryCreated",
          value: create(DevicePeerDirectoryCreatedResultSchema, { path: await canonicalDirectory(path) })
        };
      }
      case "realpath":
        return {
          case: "realpath",
          value: create(DevicePeerRealpathResultSchema, { path: await this.#files.realpath(command.action.value.path, signal) })
        };
      case "statFile": {
        const information = await this.#files.stat(command.action.value.path, signal);
        return {
          case: "fileStat",
          value: create(DevicePeerFileStatResultSchema, {
            kind: protoFileKind(information.kind),
            size: BigInt(information.size),
            modifiedAt: timestampFromDate(new Date(information.modifiedAt)),
            mode: information.mode
          })
        };
      }
      case "listFiles": {
        const entries = await this.#files.list(command.action.value.path, signal);
        return {
          case: "fileList",
          value: create(DevicePeerFileListResultSchema, {
            entries: entries.map((entry) => ({ name: entry.name, kind: protoFileKind(entry.kind) }))
          })
        };
      }
      case "readFile": {
        const maximumBytes = boundedInteger(command.action.value.maximumBytes, 1, MAXIMUM_FILE_BYTES, "maximumBytes");
        const content = await this.#files.read({
          path: command.action.value.path,
          maximumBytes,
          allowTruncated: command.action.value.allowTruncated,
          signal
        });
        const information = await this.#files.stat(command.action.value.path, signal);
        return {
          case: "fileRead",
          value: create(DevicePeerFileReadResultSchema, {
            content,
            truncated: command.action.value.allowTruncated && information.size > content.byteLength
          })
        };
      }
      case "writeFile":
        await this.#files.write({
          path: command.action.value.path,
          content: command.action.value.content,
          ...(command.action.value.mode === undefined ? {} : { mode: command.action.value.mode }),
          createParents: command.action.value.createParents,
          atomic: command.action.value.atomic,
          signal
        });
        return mutationResult();
      case "renameFile":
        await this.#files.rename(command.action.value.sourcePath, command.action.value.destinationPath, signal);
        return mutationResult();
      case "removeFile":
        await this.#files.remove(command.action.value.path, { recursive: command.action.value.recursive, signal });
        return mutationResult();
      case "startProcess":
        return this.#startProcess(command.action.value, signal, output);
      case "writeProcess": {
        const process = requiredResource(this.#activeProcesses, command.action.value.processId, "process");
        const bytes = boundedBytes(command.action.value.standardInput, MAXIMUM_PROCESS_INPUT_BYTES, "process input");
        if (bytes.byteLength > 0) await writeToStream(process.stdin, bytes, signal);
        if (command.action.value.closeStandardInput) process.stdin.end();
        return acknowledgement();
      }
      case "signalProcess": {
        const process = requiredResource(this.#activeProcesses, command.action.value.processId, "process");
        if (!process.kill(processSignal(command.action.value.signal))) {
          throw agentError(DevicePeerFailureCode.CONFLICT, false);
        }
        return acknowledgement();
      }
      case "openTerminal":
        return this.#openTerminal(command.action.value, signal, output);
      case "writeTerminal": {
        const terminal = requiredResource(this.#activeTerminals, command.action.value.terminalId, "terminal");
        await terminal.write(decodeUtf8(boundedBytes(command.action.value.data, MAXIMUM_PROCESS_INPUT_BYTES, "terminal input")));
        return acknowledgement();
      }
      case "resizeTerminal": {
        const terminal = requiredResource(this.#activeTerminals, command.action.value.terminalId, "terminal");
        await terminal.resize(
          boundedInteger(command.action.value.columns, 1, 1_000, "terminal columns"),
          boundedInteger(command.action.value.rows, 1, 1_000, "terminal rows")
        );
        return acknowledgement();
      }
      case "killTerminal":
        await requiredResource(this.#activeTerminals, command.action.value.terminalId, "terminal").kill();
        return acknowledgement();
      case "pauseTerminal":
        requiredResource(this.#activeTerminals, command.action.value.terminalId, "terminal").pause();
        return acknowledgement();
      case "resumeTerminal":
        requiredResource(this.#activeTerminals, command.action.value.terminalId, "terminal").resume();
        return acknowledgement();
      case "openLoopbackForward":
        return this.#openForward(command.action.value.destinationHost, command.action.value.destinationPort, signal, output);
      case "writeLoopbackForward": {
        const socket = requiredResource(this.#activeForwards, command.action.value.forwardId, "forward");
        await writeToSocket(socket, boundedBytes(command.action.value.data, MAXIMUM_PROCESS_INPUT_BYTES, "forward input"), signal);
        if (command.action.value.closeWrite) socket.end();
        return acknowledgement();
      }
      case "closeLoopbackForward":
        requiredResource(this.#activeForwards, command.action.value.forwardId, "forward").destroy();
        return acknowledgement();
      case "listenLoopbackForward":
        return this.#listenForward(command.action.value, signal, output);
      case "writeReverseForward": {
        const socket = requiredReverseConnection(
          this.#reverseConnections,
          command.action.value.listenerId,
          command.action.value.connectionId
        );
        await writeToSocket(socket, boundedBytes(command.action.value.data, MAXIMUM_PROCESS_INPUT_BYTES, "reverse input"), signal);
        if (command.action.value.closeWrite) socket.end();
        return acknowledgement();
      }
      case "closeReverseForwardConnection":
        requiredReverseConnection(
          this.#reverseConnections,
          command.action.value.listenerId,
          command.action.value.connectionId
        ).destroy();
        return acknowledgement();
      case "closeLoopbackListener":
      {
        const listener = requiredResource(this.#activeListeners, command.action.value.listenerId, "listener");
        for (const key of listener.connections) this.#reverseConnections.get(key)?.destroy();
        listener.server.close();
        return acknowledgement();
      }
      case "getRemoteDesktopCapabilities": {
        const value = await this.#requireRemoteDesktop().getCapabilities({
          controllerDeviceId: command.controllerDeviceId,
          signal
        });
        validateRemoteDesktopCapabilities(value);
        return {
          case: "remoteDesktopCapabilities",
          value: clone(RemoteDesktopCapabilitiesSchema, value)
        };
      }
      case "getRemoteDesktopPermissions": {
        const value = await this.#requireRemoteDesktop().getPermissions({
          controllerDeviceId: command.controllerDeviceId,
          signal
        });
        validateRemoteDesktopPermissions(value);
        return {
          case: "remoteDesktopPermissions",
          value: clone(RemoteDesktopPermissionsSchema, value)
        };
      }
      case "showRemoteDesktopPermissionGuide":
        await this.#requireRemoteDesktop().showPermissionGuide({
          controllerDeviceId: command.controllerDeviceId,
          signal
        });
        return acknowledgement();
      case "startRemoteDesktop": {
        this.#resetRemoteDesktopClipboardTransfer();
        const value = await this.#requireRemoteDesktop().start({
          controllerDeviceId: command.controllerDeviceId,
          displayId: command.action.value.displayId,
          mode: command.action.value.mode,
          signal
        });
        validateRemoteDesktopLease(value);
        return {
          case: "remoteDesktopLease",
          value: clone(RemoteDesktopLeaseSchema, value)
        };
      }
      case "heartbeatRemoteDesktop": {
        const value = await this.#requireRemoteDesktop().heartbeat({
          controllerDeviceId: command.controllerDeviceId,
          leaseId: command.action.value.leaseId,
          signal
        });
        validateRemoteDesktopControlState(value);
        this.#resetRemoteDesktopClipboardTransferForChangedControl(
          command.action.value.leaseId,
          value.controlGeneration
        );
        return {
          case: "remoteDesktopControlState",
          value: clone(RemoteDesktopControlStateSchema, value)
        };
      }
      case "stopRemoteDesktop":
        this.#resetRemoteDesktopClipboardTransferForLease(command.action.value.leaseId);
        await this.#requireRemoteDesktop().stop({
          controllerDeviceId: command.controllerDeviceId,
          leaseId: command.action.value.leaseId,
          signal
        });
        return acknowledgement();
      case "setRemoteDesktopControl": {
        this.#resetRemoteDesktopClipboardTransferForLease(command.action.value.leaseId);
        const value = await this.#requireRemoteDesktop().setControl({
          controllerDeviceId: command.controllerDeviceId,
          leaseId: command.action.value.leaseId,
          enabled: command.action.value.enabled,
          signal
        });
        validateRemoteDesktopControlState(value);
        return {
          case: "remoteDesktopControlState",
          value: clone(RemoteDesktopControlStateSchema, value)
        };
      }
      case "setRemoteDesktopPresentation": {
        if (command.action.value.enabled) {
          this.#resetRemoteDesktopClipboardTransferForLease(command.action.value.leaseId);
        }
        const value = await this.#requireRemoteDesktop().setPresentation({
          controllerDeviceId: command.controllerDeviceId,
          leaseId: command.action.value.leaseId,
          enabled: command.action.value.enabled,
          signal
        });
        validateRemoteDesktopControlState(value);
        return {
          case: "remoteDesktopControlState",
          value: clone(RemoteDesktopControlStateSchema, value)
        };
      }
      case "probeRemoteDesktopPresentation": {
        const value = await this.#requireRemoteDesktop().probePresentation({
          controllerDeviceId: command.controllerDeviceId,
          leaseId: command.action.value.leaseId,
          signal
        });
        validateRemoteDesktopPresentationProof(value, command.action.value.leaseId);
        return {
          case: "remoteDesktopPresentationProof",
          value: clone(RemoteDesktopPresentationProofSchema, value)
        };
      }
      case "sendRemoteDesktopInput":
        await this.#requireRemoteDesktop().sendInput({
          controllerDeviceId: command.controllerDeviceId,
          leaseId: command.action.value.leaseId,
          sequence: command.action.value.sequence,
          events: command.action.value.events.map((event) => clone(RemoteDesktopInputEventSchema, event)),
          signal
        });
        return acknowledgement();
      case "createRemoteDesktopOffer": {
        const value = await this.#requireRemoteDesktop().createOffer({
          controllerDeviceId: command.controllerDeviceId,
          leaseId: command.action.value.leaseId,
          attemptId: command.action.value.attemptId,
          offerSdp: command.action.value.offerSdp,
          ...(command.action.value.settings === undefined
            ? {}
            : { settings: clone(RemoteDesktopVideoSettingsSchema, command.action.value.settings) }),
          cursorOverlay: command.action.value.cursorOverlay,
          signal
        });
        validateRemoteDesktopOffer(value, command.action.value.attemptId);
        return {
          case: "remoteDesktopOffer",
          value: clone(RemoteDesktopOfferResultSchema, value)
        };
      }
      case "exchangeRemoteDesktopIce": {
        const value = await this.#requireRemoteDesktop().exchangeIce({
          controllerDeviceId: command.controllerDeviceId,
          leaseId: command.action.value.leaseId,
          attemptId: command.action.value.attemptId,
          candidates: command.action.value.candidates.map((candidate) =>
            clone(RemoteDesktopIceCandidateSchema, candidate)),
          after: command.action.value.after,
          signal
        });
        validateRemoteDesktopIceExchange(value, command.action.value.attemptId, command.action.value.after);
        return {
          case: "remoteDesktopIce",
          value: clone(RemoteDesktopIceExchangeResultSchema, value)
        };
      }
      case "getRemoteDesktopFrame": {
        const value = await this.#requireRemoteDesktop().getFrame({
          controllerDeviceId: command.controllerDeviceId,
          leaseId: command.action.value.leaseId,
          cursorOverlay: command.action.value.cursorOverlay,
          signal
        });
        validateRemoteDesktopFrameResult(value);
        return {
          case: "remoteDesktopFrame",
          value: clone(RemoteDesktopFrameResultSchema, value)
        };
      }
      case "listRemoteDesktopDisplayModes": {
        const value = await this.#requireRemoteDesktop().listDisplayModes({
          controllerDeviceId: command.controllerDeviceId,
          leaseId: command.action.value.leaseId,
          signal
        });
        validateRemoteDesktopDisplayModes(value);
        return {
          case: "remoteDesktopDisplayModes",
          value: create(DevicePeerRemoteDesktopDisplayModesResultSchema, { modes: [...value] })
        };
      }
      case "setRemoteDesktopDisplayMode":
        this.#resetRemoteDesktopClipboardTransferForLease(command.action.value.leaseId);
        await this.#requireRemoteDesktop().setDisplayMode({
          controllerDeviceId: command.controllerDeviceId,
          leaseId: command.action.value.leaseId,
          controlGeneration: command.action.value.controlGeneration,
          modeId: command.action.value.modeId,
          signal
        });
        return acknowledgement();
      case "transferRemoteDesktopClipboardText":
      {
        const request = command.action.value as RemoteDesktopClipboardTextRequest;
        return this.#withRemoteDesktopClipboard(async () => {
          const common = {
            controllerDeviceId: command.controllerDeviceId,
            leaseId: request.leaseId,
            controlGeneration: request.controlGeneration,
            signal
          };
          switch (request.action.case) {
            case "copy": {
              const text = await this.#requireRemoteDesktop().copyClipboardText(common);
              if (!validRemoteDesktopClipboardText(text)) throw invalidRemoteDesktopHostResult();
              return {
                case: "remoteDesktopClipboardText" as const,
                value: create(RemoteDesktopClipboardTextResultSchema, { text })
              };
            }
            case "paste":
              await this.#requireRemoteDesktop().pasteClipboardText({
                ...common,
                text: request.action.value.text
              });
              return {
                case: "remoteDesktopClipboardText" as const,
                value: create(RemoteDesktopClipboardTextResultSchema)
              };
            case undefined:
              throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
          }
        });
      }
      case "transferRemoteDesktopClipboardContent":
      {
        const request = command.action.value as RemoteDesktopClipboardContentRequest;
        return this.#withRemoteDesktopClipboard(() => this.#transferRemoteDesktopClipboardContent(
          command.controllerDeviceId,
          request,
          signal
        ));
      }
      default:
        throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
    }
  }

  async #transferRemoteDesktopClipboardContent(
    controllerDeviceId: string,
    request: RemoteDesktopClipboardContentRequest,
    signal: AbortSignal
  ): Promise<AgentPayload> {
    const common = {
      controllerDeviceId,
      leaseId: request.leaseId,
      controlGeneration: request.controlGeneration,
      signal
    };
    // Re-read the target host's exact authority before touching transfer
    // state. A locally advanced control generation must fence even when the
    // service has not observed the next heartbeat yet.
    if (!this.#requireRemoteDesktop().isControlCurrent(common)) {
      throw new DevicePeerRemoteDesktopHostError(
        RemoteDesktopFailureReason.CLIPBOARD_EXPIRED,
        false
      );
    }
    switch (request.action.case) {
      case "copy": {
        this.#resetRemoteDesktopClipboardTransfer();
        const content = await this.#requireRemoteDesktop().copyClipboardContent(common);
        const data = stringifyRemoteDesktopClipboardContent(content);
        const state = this.#createRemoteDesktopClipboardTransfer({
          controllerDeviceId,
          leaseId: request.leaseId,
          controlGeneration: request.controlGeneration,
          direction: "copy",
          length: data.length,
          data
        });
        return remoteDesktopClipboardContentResult({
          transferId: state.transferId,
          length: state.length
        });
      }
      case "begin": {
        this.#resetRemoteDesktopClipboardTransfer();
        const state = this.#createRemoteDesktopClipboardTransfer({
          controllerDeviceId,
          leaseId: request.leaseId,
          controlGeneration: request.controlGeneration,
          direction: "paste",
          length: request.action.value.length,
          data: ""
        });
        return remoteDesktopClipboardContentResult({ transferId: state.transferId });
      }
      case "read": {
        const state = this.#requireRemoteDesktopClipboardTransfer(
          controllerDeviceId,
          request,
          request.action.value.transferId,
          "copy"
        );
        if (request.action.value.offset >= state.length) {
          throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
        }
        this.#refreshRemoteDesktopClipboardTransfer(state);
        return remoteDesktopClipboardContentResult({
          data: state.data.slice(
            request.action.value.offset,
            request.action.value.offset + REMOTE_DESKTOP_CLIPBOARD_CHUNK_CHARACTERS
          )
        });
      }
      case "write": {
        const state = this.#requireRemoteDesktopClipboardTransfer(
          controllerDeviceId,
          request,
          request.action.value.transferId,
          "paste"
        );
        if (request.action.value.offset !== state.data.length
          || state.data.length + request.action.value.data.length > state.length) {
          throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
        }
        state.data += request.action.value.data;
        this.#refreshRemoteDesktopClipboardTransfer(state);
        return remoteDesktopClipboardContentResult({});
      }
      case "commit": {
        const state = this.#requireRemoteDesktopClipboardTransfer(
          controllerDeviceId,
          request,
          request.action.value.transferId,
          "paste"
        );
        // Consume before the external clipboard/paste side effect. A repeated
        // or outcome-unknown commit can never paste the same transfer twice.
        this.#resetRemoteDesktopClipboardTransfer();
        if (state.data.length !== state.length) {
          throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
        }
        let content: RemoteDesktopClipboardContent;
        try {
          content = parseRemoteDesktopClipboardContentJson(state.data);
        } catch (error) {
          throw new DevicePeerRemoteDesktopHostError(
            error instanceof Error && error.message === "REMOTE_DESKTOP_CLIPBOARD_TOO_LARGE"
              ? RemoteDesktopFailureReason.CLIPBOARD_TOO_LARGE
              : RemoteDesktopFailureReason.CLIPBOARD_UNSUPPORTED,
            false
          );
        }
        await this.#requireRemoteDesktop().pasteClipboardContent({ ...common, content });
        return remoteDesktopClipboardContentResult({});
      }
      case "cancel":
        this.#requireRemoteDesktopClipboardTransfer(
          controllerDeviceId,
          request,
          request.action.value.transferId
        );
        this.#resetRemoteDesktopClipboardTransfer();
        return remoteDesktopClipboardContentResult({});
      case undefined:
        throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
    }
  }

  async #withRemoteDesktopClipboard<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#remoteDesktopClipboardBusy) {
      throw new DevicePeerRemoteDesktopHostError(RemoteDesktopFailureReason.CLIPBOARD_BUSY, true);
    }
    this.#remoteDesktopClipboardBusy = true;
    try {
      return await operation();
    } finally {
      this.#remoteDesktopClipboardBusy = false;
    }
  }

  #createRemoteDesktopClipboardTransfer(input: Omit<
    RemoteDesktopClipboardTransferState,
    "transferId" | "expiresAt" | "timer"
  >): RemoteDesktopClipboardTransferState {
    const state: RemoteDesktopClipboardTransferState = {
      ...input,
      transferId: randomUUID(),
      expiresAt: Date.now() + REMOTE_DESKTOP_CLIPBOARD_TRANSFER_IDLE_MS,
      timer: setTimeout(() => undefined, REMOTE_DESKTOP_CLIPBOARD_TRANSFER_IDLE_MS)
    };
    clearTimeout(state.timer);
    state.timer = this.#remoteDesktopClipboardTimer(state);
    this.#remoteDesktopClipboardTransfer = state;
    return state;
  }

  #requireRemoteDesktopClipboardTransfer(
    controllerDeviceId: string,
    request: RemoteDesktopClipboardContentRequest,
    transferId: string,
    direction?: "copy" | "paste"
  ): RemoteDesktopClipboardTransferState {
    const state = this.#remoteDesktopClipboardTransfer;
    if (state !== undefined && state.expiresAt <= Date.now()) this.#resetRemoteDesktopClipboardTransfer();
    if (state === undefined
      || this.#remoteDesktopClipboardTransfer !== state
      || state.transferId !== transferId
      || state.controllerDeviceId !== controllerDeviceId
      || state.leaseId !== request.leaseId
      || state.controlGeneration !== request.controlGeneration
      || direction !== undefined && state.direction !== direction) {
      throw new DevicePeerRemoteDesktopHostError(RemoteDesktopFailureReason.CLIPBOARD_EXPIRED, false);
    }
    return state;
  }

  #refreshRemoteDesktopClipboardTransfer(state: RemoteDesktopClipboardTransferState): void {
    if (this.#remoteDesktopClipboardTransfer !== state) return;
    clearTimeout(state.timer);
    state.expiresAt = Date.now() + REMOTE_DESKTOP_CLIPBOARD_TRANSFER_IDLE_MS;
    state.timer = this.#remoteDesktopClipboardTimer(state);
  }

  #remoteDesktopClipboardTimer(state: RemoteDesktopClipboardTransferState): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      if (this.#remoteDesktopClipboardTransfer === state) this.#resetRemoteDesktopClipboardTransfer();
    }, REMOTE_DESKTOP_CLIPBOARD_TRANSFER_IDLE_MS);
    timer.unref?.();
    return timer;
  }

  #resetRemoteDesktopClipboardTransferForLease(leaseId: string): void {
    if (this.#remoteDesktopClipboardTransfer?.leaseId === leaseId) {
      this.#resetRemoteDesktopClipboardTransfer();
    }
  }

  #resetRemoteDesktopClipboardTransferForChangedControl(leaseId: string, controlGeneration: bigint): void {
    const state = this.#remoteDesktopClipboardTransfer;
    if (state?.leaseId === leaseId && state.controlGeneration !== controlGeneration) {
      this.#resetRemoteDesktopClipboardTransfer();
    }
  }

  #resetRemoteDesktopClipboardTransfer(): void {
    if (this.#remoteDesktopClipboardTransfer !== undefined) {
      clearTimeout(this.#remoteDesktopClipboardTransfer.timer);
      this.#remoteDesktopClipboardTransfer = undefined;
    }
  }

  async #startProcess(
    action: Extract<DevicePeerCommand["action"], { case: "startProcess" }>["value"],
    signal: AbortSignal,
    output: AgentOutput
  ): Promise<undefined> {
    if (this.#activeProcesses.size >= MAXIMUM_ACTIVE_PROCESSES) {
      throw agentError(DevicePeerFailureCode.UNAVAILABLE, true);
    }
    const request = resolveRuntimeProcessRequest(
      processRequest(action),
      this.#runtimeExecutables
    );
    const cwd = await canonicalDirectory(request.cwd);
    const handle = await this.#processes.open({ ...request, cwd, signal });
    const processId = randomUUID();
    this.#activeProcesses.set(processId, handle);
    // Recent project history is a convenience projection, not runtime
    // admission. Record only after the process handle is owned, and never let
    // private-history I/O failure cancel an otherwise valid peer process.
    void this.#recentDirectories.record(cwd).catch(() => undefined);
    const exited = processExit(handle);
    let resolveAborted!: () => void;
    const abortedRequest = new Promise<void>((resolvePromise) => { resolveAborted = resolvePromise; });
    const abort = (): void => { handle.kill("SIGTERM"); resolveAborted(); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      if (action.initialStandardInput.byteLength > 0) {
        await writeToStream(handle.stdin, action.initialStandardInput, signal);
      }
      await output.emit(DevicePeerResponsePhase.COMPLETED, {
        case: "processStarted",
        value: create(DevicePeerProcessStartedResultSchema, { processId })
      });
      const completion = Promise.all([
        pumpReadable(handle.stdout, (data) => output.emit(DevicePeerResponsePhase.STARTED, {
          case: "processOutput",
          value: create(DevicePeerProcessOutputResultSchema, {
            processId,
            stream: DevicePeerProcessOutputStream.STANDARD_OUTPUT,
            data
          })
        })),
        pumpReadable(handle.stderr, (data) => output.emit(DevicePeerResponsePhase.STARTED, {
          case: "processOutput",
          value: create(DevicePeerProcessOutputResultSchema, {
            processId,
            stream: DevicePeerProcessOutputStream.STANDARD_ERROR,
            data
          })
        })),
        exited
      ]);
      let result: Awaited<typeof exited>;
      if (signal.aborted) {
        const settled = await settleValueWithin(completion, RESOURCE_RETIRE_TIMEOUT_MS);
        if (settled === undefined) {
          handle.kill("SIGKILL");
          const forced = await settleValueWithin(completion, RESOURCE_RETIRE_TIMEOUT_MS);
          if (forced === undefined) throw unknownAgentError(DevicePeerFailureCode.CANCELLED);
          result = forced[2];
        } else result = settled[2];
      } else {
        try {
          result = (await Promise.race([
            completion,
            abortedRequest.then(async () => {
              handle.kill("SIGTERM");
              const settled = await settleValueWithin(completion, RESOURCE_RETIRE_TIMEOUT_MS);
              if (settled !== undefined) return settled;
              handle.kill("SIGKILL");
              const forced = await settleValueWithin(completion, RESOURCE_RETIRE_TIMEOUT_MS);
              if (forced === undefined) throw unknownAgentError(DevicePeerFailureCode.CANCELLED);
              return forced;
            })
          ]))[2];
        } catch (error) {
          handle.kill("SIGKILL");
          throw error;
        }
      }
      await output.emit(DevicePeerResponsePhase.STARTED, {
        case: "processExited",
        value: create(DevicePeerProcessExitedResultSchema, {
          processId,
          ...(result.code === null ? {} : { exitCode: result.code }),
          ...(result.signal === null ? {} : { signalName: result.signal })
        })
      });
      return undefined;
    } finally {
      signal.removeEventListener("abort", abort);
      if (!output.dispatchCompleted) handle.kill("SIGKILL");
      this.#activeProcesses.delete(processId);
    }
  }

  async #openTerminal(
    action: Extract<DevicePeerCommand["action"], { case: "openTerminal" }>["value"],
    signal: AbortSignal,
    output: AgentOutput
  ): Promise<undefined> {
    const port = this.#terminals;
    if (port === undefined) throw agentError(DevicePeerFailureCode.CAPABILITY_UNAVAILABLE, false);
    if (this.#activeTerminals.size >= MAXIMUM_ACTIVE_TERMINALS) {
      throw agentError(DevicePeerFailureCode.UNAVAILABLE, true);
    }
    const executable = executableValue(action.executable);
    const args = processArguments(action.arguments);
    const cwd = await canonicalDirectory(action.workingDirectory);
    const terminal = await port.open({
      executable,
      args,
      cwd,
      cols: boundedInteger(action.columns, 1, 1_000, "terminal columns"),
      rows: boundedInteger(action.rows, 1, 1_000, "terminal rows"),
      signal
    });
    const terminalId = randomUUID();
    this.#activeTerminals.set(terminalId, terminal);
    void this.#recentDirectories.record(cwd).catch(() => undefined);
    await output.emit(DevicePeerResponsePhase.COMPLETED, {
      case: "terminalOpened",
      value: create(DevicePeerTerminalOpenedResultSchema, { terminalId })
    });
    let resolveExit!: (value: TerminalExit) => void;
    const exited = new Promise<TerminalExit>((resolveExitPromise) => { resolveExit = resolveExitPromise; });
    const dataSubscription = terminal.onData((data) => {
      for (const chunk of splitUtf8(data, MAXIMUM_STREAM_FRAME_BYTES)) {
        void output.emit(DevicePeerResponsePhase.STARTED, {
          case: "terminalOutput",
          value: create(DevicePeerTerminalOutputResultSchema, { terminalId, data: new TextEncoder().encode(chunk) })
        }).catch(() => terminal.kill().catch(() => undefined));
      }
    });
    const exitSubscription = terminal.onExit((event) => resolveExit(event));
    let resolveAborted!: () => void;
    const abortedRequest = new Promise<void>((resolvePromise) => { resolveAborted = resolvePromise; });
    const abort = (): void => { void terminal.kill().catch(() => undefined); resolveAborted(); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      const result = signal.aborted
        ? await settleValueWithin(exited, RESOURCE_RETIRE_TIMEOUT_MS)
        : await Promise.race([
          exited,
          abortedRequest.then(() => settleValueWithin(exited, RESOURCE_RETIRE_TIMEOUT_MS))
        ]);
      if (result === undefined) throw unknownAgentError(DevicePeerFailureCode.CANCELLED);
      await output.drain();
      await output.emit(DevicePeerResponsePhase.STARTED, {
        case: "terminalExited",
        value: create(DevicePeerTerminalExitedResultSchema, {
          terminalId,
          exitCode: result.exitCode,
          ...(result.signal === undefined ? {} : { signal: result.signal })
        })
      });
      return undefined;
    } finally {
      signal.removeEventListener("abort", abort);
      dataSubscription.dispose();
      exitSubscription.dispose();
      this.#activeTerminals.delete(terminalId);
    }
  }

  async #openForward(
    destination: DevicePeerLoopbackHost,
    port: number,
    signal: AbortSignal,
    output: AgentOutput
  ): Promise<undefined> {
    if (this.#activeForwards.size >= MAXIMUM_ACTIVE_FORWARDS) {
      throw agentError(DevicePeerFailureCode.UNAVAILABLE, true);
    }
    const socket = createConnection({ host: loopbackHost(destination), port: tcpPort(port) });
    await socketConnected(socket, signal);
    const forwardId = randomUUID();
    this.#activeForwards.set(forwardId, socket);
    await output.emit(DevicePeerResponsePhase.COMPLETED, {
      case: "loopbackForwardOpened",
      value: create(DevicePeerLoopbackForwardOpenedResultSchema, { forwardId })
    });
    const abort = (): void => { socket.destroy(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      try {
        for await (const chunk of socket) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          for (const frame of splitBytes(bytes, MAXIMUM_STREAM_FRAME_BYTES)) {
            await output.emit(DevicePeerResponsePhase.STARTED, {
              case: "loopbackForwardData",
              value: create(DevicePeerLoopbackForwardDataResultSchema, { forwardId, data: frame })
            });
          }
        }
      } catch (error) {
        if (!signal.aborted && !socket.destroyed) throw error;
      }
      await output.emit(DevicePeerResponsePhase.STARTED, {
        case: "loopbackForwardClosed",
        value: create(DevicePeerLoopbackForwardClosedResultSchema, { forwardId })
      });
      return undefined;
    } finally {
      signal.removeEventListener("abort", abort);
      socket.destroy();
      this.#activeForwards.delete(forwardId);
    }
  }

  async #listenForward(
    action: Extract<DevicePeerCommand["action"], { case: "listenLoopbackForward" }>["value"],
    signal: AbortSignal,
    output: AgentOutput
  ): Promise<undefined> {
    if (this.#activeListeners.size >= MAXIMUM_ACTIVE_LISTENERS) {
      throw agentError(DevicePeerFailureCode.UNAVAILABLE, true);
    }
    // Validate the service endpoint even though the controller performs that
    // half of the tunnel. Keeping it in the admitted command prevents an
    // arbitrary destination from being smuggled into a later bridge.
    loopbackHost(action.serviceDestinationHost);
    tcpPort(action.serviceDestinationPort);
    const peerHost = loopbackHost(action.peerListenHost);
    const peerPort = action.peerListenPort === 0 ? 0 : tcpPort(action.peerListenPort);
    const server = createServer({ pauseOnConnect: true });
    await listen(server, peerHost, peerPort, signal);
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw agentError(DevicePeerFailureCode.INTERNAL, false);
    }
    const listenerId = randomUUID();
    const listener: ReverseListener = { server, connections: new Set(), pumps: new Set() };
    this.#activeListeners.set(listenerId, listener);
    await output.emit(DevicePeerResponsePhase.COMPLETED, {
      case: "loopbackListenerOpened",
      value: create(DevicePeerLoopbackListenerOpenedResultSchema, {
        listenerId,
        peerListenHost: action.peerListenHost,
        peerListenPort: address.port
      })
    });
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolveClosedPromise) => { resolveClosed = resolveClosedPromise; });
    server.once("close", resolveClosed);
    server.on("connection", (socket) => {
      if (this.#reverseConnections.size >= MAXIMUM_REVERSE_CONNECTIONS || this.#retired) {
        socket.destroy();
        return;
      }
      const connectionId = randomUUID();
      const key = reverseConnectionKey(listenerId, connectionId);
      listener.connections.add(key);
      this.#reverseConnections.set(key, socket);
      const pump = this.#pumpReverseConnection(listenerId, connectionId, socket, output)
        .catch(() => { server.close(); })
        .finally(() => {
          listener.connections.delete(key);
          this.#reverseConnections.delete(key);
          listener.pumps.delete(pump);
        });
      listener.pumps.add(pump);
      void pump;
      socket.resume();
    });
    const abort = (): void => {
      for (const key of listener.connections) this.#reverseConnections.get(key)?.destroy();
      server.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await closed;
      for (const key of listener.connections) this.#reverseConnections.get(key)?.destroy();
      await Promise.allSettled([...listener.pumps]);
      await output.drain();
      await output.emit(DevicePeerResponsePhase.STARTED, {
        case: "loopbackListenerClosed",
        value: create(DevicePeerLoopbackListenerClosedResultSchema, { listenerId })
      });
      return undefined;
    } finally {
      signal.removeEventListener("abort", abort);
      server.close();
      this.#activeListeners.delete(listenerId);
    }
  }

  async #pumpReverseConnection(
    listenerId: string,
    connectionId: string,
    socket: Socket,
    output: AgentOutput
  ): Promise<void> {
    await output.emit(DevicePeerResponsePhase.STARTED, {
      case: "reverseForwardConnectionOpened",
      value: create(DevicePeerReverseForwardConnectionOpenedResultSchema, { listenerId, connectionId })
    });
    try {
      for await (const chunk of socket) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        for (const frame of splitBytes(bytes, MAXIMUM_STREAM_FRAME_BYTES)) {
          await output.emit(DevicePeerResponsePhase.STARTED, {
            case: "reverseForwardData",
            value: create(DevicePeerReverseForwardDataResultSchema, { listenerId, connectionId, data: frame })
          });
        }
      }
    } finally {
      socket.destroy();
      await output.emit(DevicePeerResponsePhase.STARTED, {
        case: "reverseForwardConnectionClosed",
        value: create(DevicePeerReverseForwardConnectionClosedResultSchema, { listenerId, connectionId })
      });
    }
  }

  #requireRemoteDesktop(): DevicePeerRemoteDesktopHostPort {
    if (this.#remoteDesktop === undefined) {
      throw agentError(DevicePeerFailureCode.CAPABILITY_UNAVAILABLE, false);
    }
    return this.#remoteDesktop;
  }

  #assertActive(): void {
    if (this.#retired) throw agentError(DevicePeerFailureCode.UNAVAILABLE, false);
  }
}

/** Target-side private recent-directory owner. */
export class NodeDevicePeerRecentDirectoryStore {
  readonly #path: string;
  #mutations: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = localPath(path);
  }

  async list(maximumEntries: number, signal: AbortSignal): Promise<{
    readonly directories: Array<{
      readonly name: string;
      readonly path: string;
      readonly availability: DevicePeerDirectoryAvailability;
      readonly lastUsedAt: ReturnType<typeof timestampFromDate>;
    }>;
    readonly truncated: boolean;
  }> {
    const maximum = boundedInteger(maximumEntries, 1, MAXIMUM_RECENT_DIRECTORIES, "maximumEntries");
    await this.#mutations;
    signal.throwIfAborted();
    const state = await this.#read();
    const directories = [];
    for (const record of state.directories) {
      signal.throwIfAborted();
      directories.push({
        name: record.name,
        path: record.path,
        availability: await directoryAvailability(record.path),
        lastUsedAt: timestampFromDate(new Date(record.lastUsedAt))
      });
    }
    return { directories: directories.slice(0, maximum), truncated: directories.length > maximum };
  }

  record(path: string, name?: string): Promise<void> {
    const mutation = this.#mutations.then(async () => {
      const canonical = await canonicalDirectory(path);
      const displayName = recentDirectoryName(name ?? (basename(canonical) || canonical));
      const state = await this.#read();
      const next = [{ path: canonical, name: displayName, lastUsedAt: Date.now() },
        ...state.directories.filter((entry) => !samePath(entry.path, canonical))]
        .slice(0, MAXIMUM_RECENT_DIRECTORIES);
      await atomicWritePrivateFile(this.#path, new TextEncoder().encode(JSON.stringify({ version: 1, directories: next })));
    });
    this.#mutations = mutation.catch(() => undefined);
    return mutation;
  }

  async #read(): Promise<RecentDirectoryState> {
    const bytes = await readPrivateFile(this.#path);
    if (bytes === undefined) return { version: 1, directories: [] };
    try {
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!isRecord(parsed) || !exactKeys(parsed, ["version", "directories"])
        || parsed.version !== 1 || !Array.isArray(parsed.directories)
        || parsed.directories.length > MAXIMUM_RECENT_DIRECTORIES) {
        throw agentError(DevicePeerFailureCode.INTERNAL, false);
      }
      const directories = parsed.directories.map((entry) => recentDirectoryRecord(entry));
      if (new Set(directories.map((entry) => pathKey(entry.path))).size !== directories.length) {
        throw agentError(DevicePeerFailureCode.INTERNAL, false);
      }
      return { version: 1, directories };
    } catch (error) {
      if (error instanceof DevicePeerAgentError) throw error;
      throw agentError(DevicePeerFailureCode.INTERNAL, false);
    } finally {
      bytes.fill(0);
    }
  }
}

/** Strict local implementation of the capability-neutral remote file port. */
export class LocalDevicePeerFileTransport implements DevicePeerFileTransportPort {
  async realpath(path: string, signal?: AbortSignal): Promise<string> {
    // SFTP defines realpath(".") as the connected account's home directory.
    // Preserve that single capability-neutral query for peer routes without
    // admitting any other controller-relative path on the target.
    const accepted = path === "." ? homedir() : localPath(path);
    signal?.throwIfAborted();
    const canonical = resolve(await realpath(accepted));
    signal?.throwIfAborted();
    return localPath(canonical);
  }

  async stat(path: string, signal?: AbortSignal): Promise<DevicePeerFileStat> {
    const accepted = localPath(path);
    signal?.throwIfAborted();
    const information = await lstat(accepted);
    signal?.throwIfAborted();
    return {
      kind: fileKind(information),
      size: boundedSafeSize(information.size),
      modifiedAt: information.mtimeMs,
      mode: information.mode & 0o777
    };
  }

  async list(path: string, signal?: AbortSignal): Promise<readonly { readonly name: string; readonly kind: ReturnType<typeof fileKind> }[]> {
    const accepted = await canonicalDirectory(path);
    signal?.throwIfAborted();
    const entries: Array<{ readonly name: string; readonly kind: ReturnType<typeof fileKind> }> = [];
    const stream = await opendir(accepted);
    for await (const entry of stream) {
      signal?.throwIfAborted();
      if (entries.length >= MAXIMUM_DIRECTORY_ENTRIES) {
        throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
      }
      entries.push({ name: directoryEntryName(entry.name), kind: direntKind(entry) });
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    return entries;
  }

  async read(request: Parameters<DevicePeerFileTransportPort["read"]>[0]): Promise<Uint8Array> {
    const path = localPath(request.path);
    const maximumBytes = boundedInteger(request.maximumBytes, 1, MAXIMUM_FILE_BYTES, "maximumBytes");
    request.signal?.throwIfAborted();
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw agentError(DevicePeerFailureCode.NOT_FOUND, false);
    if (before.size > maximumBytes && request.allowTruncated !== true) {
      throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
    }
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      const openedBefore = await handle.stat();
      if (!openedBefore.isFile() || openedBefore.isSymbolicLink() || !sameFileIdentity(before, openedBefore)) {
        throw agentError(DevicePeerFailureCode.CONFLICT, true);
      }
      const length = Math.min(openedBefore.size, maximumBytes);
      const content = Buffer.alloc(length);
      let offset = 0;
      while (offset < content.byteLength) {
        request.signal?.throwIfAborted();
        const result = await handle.read(content, offset, content.byteLength - offset, offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      const openedAfter = await handle.stat();
      const after = await lstat(path);
      if (offset !== length || !sameStableFile(openedBefore, openedAfter)
        || !sameStableFile(openedAfter, after)) {
        throw agentError(DevicePeerFailureCode.CONFLICT, true);
      }
      request.signal?.throwIfAborted();
      return new Uint8Array(content);
    } finally {
      await handle.close();
    }
  }

  async write(request: Parameters<DevicePeerFileTransportPort["write"]>[0]): Promise<void> {
    const path = localPath(request.path);
    const content = boundedBytes(request.content, MAXIMUM_FILE_BYTES, "file content");
    const mode = request.mode === undefined ? 0o600 : boundedInteger(request.mode, 0, 0o777, "mode");
    if (request.createParents) await this.mkdir(dirname(path), { recursive: true, mode: 0o700, signal: request.signal });
    await canonicalDirectory(dirname(path));
    request.signal?.throwIfAborted();
    const existing = await lstat(path).catch(missingAsUndefined);
    if (existing?.isSymbolicLink() || (existing !== undefined && !existing.isFile())) {
      throw agentError(DevicePeerFailureCode.CONFLICT, false);
    }
    if (!request.atomic) {
      await writeFile(path, content, { flag: "w", mode });
      return;
    }
    const temporary = `${path}.joko-${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { flag: "wx", mode });
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(ignoreMissing);
    }
  }

  async mkdir(
    path: string,
    options: { readonly recursive?: boolean; readonly mode?: number; readonly signal?: AbortSignal } = {}
  ): Promise<void> {
    const accepted = localPath(path);
    const mode = options.mode === undefined ? 0o700 : boundedInteger(options.mode, 0, 0o777, "mode");
    options.signal?.throwIfAborted();
    await assertCanonicalExistingAncestor(accepted);
    await mkdir(accepted, { recursive: options.recursive, mode });
    const information = await lstat(accepted);
    if (!information.isDirectory() || information.isSymbolicLink() || !samePath(await realpath(accepted), accepted)) {
      throw agentError(DevicePeerFailureCode.CONFLICT, false);
    }
  }

  async rename(sourcePath: string, destinationPath: string, signal?: AbortSignal): Promise<void> {
    const source = localPath(sourcePath);
    const destination = localPath(destinationPath);
    if (isFilesystemRoot(source) || isFilesystemRoot(destination)) {
      throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
    }
    signal?.throwIfAborted();
    await Promise.all([canonicalDirectory(dirname(source)), canonicalDirectory(dirname(destination))]);
    await lstat(source);
    const destinationInfo = await lstat(destination).catch(missingAsUndefined);
    if (destinationInfo?.isSymbolicLink()) throw agentError(DevicePeerFailureCode.CONFLICT, false);
    await rename(source, destination);
  }

  async remove(
    path: string,
    options: { readonly recursive?: boolean; readonly signal?: AbortSignal } = {}
  ): Promise<void> {
    const accepted = localPath(path);
    if (isFilesystemRoot(accepted)) throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
    await canonicalDirectory(dirname(accepted));
    const counter = { value: 0 };
    await removeEntry(accepted, options.recursive === true, options.signal, 0, counter);
  }
}

/** Main-process local child_process implementation; output remains ephemeral. */
export class LocalDevicePeerProcessTransport implements DevicePeerProcessTransportPort {
  async open(request: DevicePeerProcessStartRequest): Promise<DevicePeerProcessHandle> {
    request.signal?.throwIfAborted();
    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false
    });
    await childSpawned(child, request.signal);
    return child;
  }
}

class AgentOutput {
  readonly #emitResult: NodeDevicePeerAgentEmitter;
  #sequence = 0n;
  #pending: Promise<void> = Promise.resolve();
  #terminal = false;
  #dispatchCompleted = false;

  constructor(emit: NodeDevicePeerAgentEmitter) {
    this.#emitResult = emit;
  }

  get dispatchCompleted(): boolean { return this.#dispatchCompleted; }

  emit(phase: DevicePeerResponsePhase, payload: AgentPayload): Promise<void> {
    if (this.#terminal) return Promise.reject(new Error("The Device peer request is already terminal."));
    if (phase === DevicePeerResponsePhase.COMPLETED) {
      if (this.#dispatchCompleted) return Promise.reject(new Error("The Device peer dispatch is already complete."));
      this.#dispatchCompleted = true;
      if (!streamStartPayload(payload.case)) this.#terminal = true;
    } else if (phase === DevicePeerResponsePhase.FAILED || phase === DevicePeerResponsePhase.ABORTED
      || phase === DevicePeerResponsePhase.OUTCOME_UNKNOWN
      || phase === DevicePeerResponsePhase.STARTED && streamTerminalPayload(payload.case)) {
      this.#terminal = true;
    }
    const result = create(DevicePeerAgentResultSchema, { phase, sequence: ++this.#sequence, payload });
    const pending = this.#pending.then(() => this.#emitResult(result));
    this.#pending = pending.then(() => undefined);
    return pending;
  }

  async terminalFailure(error: unknown, admittedSideEffect = false): Promise<void> {
    if (this.#terminal) return;
    if (isAbortError(error)) {
      await this.emit(DevicePeerResponsePhase.ABORTED, {
        case: "failure",
        value: create(DevicePeerFailureSchema, { code: DevicePeerFailureCode.CANCELLED, retryable: false })
      });
      return;
    }
    if (error instanceof DevicePeerRemoteDesktopHostError && validRemoteDesktopFailureReason(error.reason)
      && typeof error.retryable === "boolean") {
      await this.emit(DevicePeerResponsePhase.FAILED, {
        case: "failure",
        value: create(DevicePeerFailureSchema, {
          code: remoteDesktopFailureCode(error.reason),
          retryable: error.retryable,
          remoteDesktop: create(RemoteDesktopFailureSchema, {
            reason: error.reason,
            retryable: error.retryable
          })
        })
      });
      return;
    }
    const failure = normalizeAgentError(error);
    await this.emit(
      failure.outcomeUnknown && admittedSideEffect
        ? DevicePeerResponsePhase.OUTCOME_UNKNOWN
        : DevicePeerResponsePhase.FAILED,
      { case: "failure", value: create(DevicePeerFailureSchema, { code: failure.code, retryable: failure.retryable }) }
    );
  }

  drain(): Promise<void> { return this.#pending; }
}

class DevicePeerAgentError extends Error {
  constructor(
    readonly code: DevicePeerFailureCode,
    readonly retryable: boolean,
    readonly outcomeUnknown = false
  ) {
    super("Device peer agent command failed.");
    this.name = "DevicePeerAgentError";
  }
}

interface CommandSpecification {
  readonly capability: DevicePeerCapabilityKind;
  readonly effect: DevicePeerEffectKind;
}

interface RecentDirectoryRecord {
  readonly path: string;
  readonly name: string;
  readonly lastUsedAt: number;
}

interface RecentDirectoryState {
  readonly version: 1;
  readonly directories: readonly RecentDirectoryRecord[];
}

interface ReverseListener {
  readonly server: Server;
  readonly connections: Set<string>;
  readonly pumps: Set<Promise<void>>;
}

interface TerminalExit {
  readonly exitCode: number;
  readonly signal?: number;
}

interface RemoteDesktopClipboardTransferState {
  readonly transferId: string;
  readonly controllerDeviceId: string;
  readonly leaseId: string;
  readonly controlGeneration: bigint;
  readonly direction: "copy" | "paste";
  readonly length: number;
  data: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

function commandSpecification(
  command: DevicePeerCommand,
  terminalAvailable: boolean,
  remoteDesktopAvailable: boolean
): CommandSpecification {
  const byAction: Partial<Record<NonNullable<DevicePeerCommand["action"]["case"]>, CommandSpecification>> = {
    listRecentDirectories: readOnly(DevicePeerCapabilityKind.FILES),
    listDirectories: readOnly(DevicePeerCapabilityKind.FILES),
    inspectDirectory: readOnly(DevicePeerCapabilityKind.FILES),
    createDirectory: effect(DevicePeerCapabilityKind.FILES),
    realpath: readOnly(DevicePeerCapabilityKind.FILES),
    statFile: readOnly(DevicePeerCapabilityKind.FILES),
    listFiles: readOnly(DevicePeerCapabilityKind.FILES),
    readFile: readOnly(DevicePeerCapabilityKind.FILES),
    writeFile: effect(DevicePeerCapabilityKind.FILES),
    renameFile: effect(DevicePeerCapabilityKind.FILES),
    removeFile: effect(DevicePeerCapabilityKind.FILES),
    startProcess: effect(DevicePeerCapabilityKind.PROCESS),
    writeProcess: effect(DevicePeerCapabilityKind.PROCESS),
    signalProcess: effect(DevicePeerCapabilityKind.PROCESS),
    openTerminal: effect(DevicePeerCapabilityKind.TERMINAL),
    writeTerminal: effect(DevicePeerCapabilityKind.TERMINAL),
    resizeTerminal: effect(DevicePeerCapabilityKind.TERMINAL),
    killTerminal: effect(DevicePeerCapabilityKind.TERMINAL),
    pauseTerminal: effect(DevicePeerCapabilityKind.TERMINAL),
    resumeTerminal: effect(DevicePeerCapabilityKind.TERMINAL),
    openLoopbackForward: effect(DevicePeerCapabilityKind.FORWARDING),
    writeLoopbackForward: effect(DevicePeerCapabilityKind.FORWARDING),
    closeLoopbackForward: effect(DevicePeerCapabilityKind.FORWARDING),
    listenLoopbackForward: effect(DevicePeerCapabilityKind.FORWARDING),
    writeReverseForward: effect(DevicePeerCapabilityKind.FORWARDING),
    closeReverseForwardConnection: effect(DevicePeerCapabilityKind.FORWARDING),
    closeLoopbackListener: effect(DevicePeerCapabilityKind.FORWARDING),
    getRemoteDesktopCapabilities: readOnly(DevicePeerCapabilityKind.REMOTE_DESKTOP),
    getRemoteDesktopPermissions: readOnly(DevicePeerCapabilityKind.REMOTE_DESKTOP),
    showRemoteDesktopPermissionGuide: effect(DevicePeerCapabilityKind.REMOTE_DESKTOP),
    startRemoteDesktop: effect(DevicePeerCapabilityKind.REMOTE_DESKTOP),
    heartbeatRemoteDesktop: effect(DevicePeerCapabilityKind.REMOTE_DESKTOP),
    stopRemoteDesktop: effect(DevicePeerCapabilityKind.REMOTE_DESKTOP),
    setRemoteDesktopControl: effect(DevicePeerCapabilityKind.REMOTE_DESKTOP),
    setRemoteDesktopPresentation: effect(DevicePeerCapabilityKind.REMOTE_DESKTOP),
    probeRemoteDesktopPresentation: readOnly(DevicePeerCapabilityKind.REMOTE_DESKTOP),
    sendRemoteDesktopInput: effect(DevicePeerCapabilityKind.REMOTE_DESKTOP),
    createRemoteDesktopOffer: effect(DevicePeerCapabilityKind.REMOTE_DESKTOP),
    exchangeRemoteDesktopIce: effect(DevicePeerCapabilityKind.REMOTE_DESKTOP),
    getRemoteDesktopFrame: readOnly(DevicePeerCapabilityKind.REMOTE_DESKTOP),
    listRemoteDesktopDisplayModes: readOnly(DevicePeerCapabilityKind.REMOTE_DESKTOP),
    setRemoteDesktopDisplayMode: effect(DevicePeerCapabilityKind.REMOTE_DESKTOP),
    transferRemoteDesktopClipboardText: effect(DevicePeerCapabilityKind.REMOTE_DESKTOP),
    transferRemoteDesktopClipboardContent: effect(DevicePeerCapabilityKind.REMOTE_DESKTOP)
  };
  const specification = command.action.case === undefined ? undefined : byAction[command.action.case];
  const unavailable = specification?.capability === DevicePeerCapabilityKind.TERMINAL && !terminalAvailable
    || specification?.capability === DevicePeerCapabilityKind.REMOTE_DESKTOP && !remoteDesktopAvailable;
  if (specification === undefined || command.capability !== specification.capability
    || command.effect !== specification.effect || unavailable) {
    throw agentError(unavailable
      ? DevicePeerFailureCode.CAPABILITY_UNAVAILABLE
      : DevicePeerFailureCode.INVALID_REQUEST, false);
  }
  return specification;
}

function validateCommandInput(command: DevicePeerCommand): void {
  switch (command.action.case) {
    case "listRecentDirectories":
      boundedInteger(command.action.value.maximumEntries, 1, MAXIMUM_RECENT_DIRECTORIES, "maximumEntries");
      return;
    case "listDirectories":
      if (command.action.value.path !== "") localPath(command.action.value.path);
      if (command.action.value.maximumEntries !== 0) {
        boundedInteger(command.action.value.maximumEntries, 1, MAXIMUM_BROWSE_RESULTS, "maximumEntries");
      }
      return;
    case "inspectDirectory":
    case "statFile":
    case "listFiles":
      localPath(command.action.value.path);
      return;
    case "realpath":
      if (command.action.value.path !== ".") localPath(command.action.value.path);
      return;
    case "createDirectory":
      localPath(command.action.value.path);
      if (command.action.value.mode !== undefined) boundedInteger(command.action.value.mode, 0, 0o777, "mode");
      return;
    case "readFile":
      localPath(command.action.value.path);
      boundedInteger(command.action.value.maximumBytes, 1, MAXIMUM_FILE_BYTES, "maximumBytes");
      return;
    case "writeFile":
      localPath(command.action.value.path);
      boundedBytes(command.action.value.content, MAXIMUM_FILE_BYTES, "file content");
      if (command.action.value.mode !== undefined) boundedInteger(command.action.value.mode, 0, 0o777, "mode");
      return;
    case "renameFile":
      localPath(command.action.value.sourcePath);
      localPath(command.action.value.destinationPath);
      return;
    case "removeFile":
      localPath(command.action.value.path);
      return;
    case "startProcess":
      processRequest(command.action.value);
      return;
    case "writeProcess":
      requireResourceId(command.action.value.processId);
      boundedBytes(command.action.value.standardInput, MAXIMUM_PROCESS_INPUT_BYTES, "process input");
      return;
    case "signalProcess":
      requireResourceId(command.action.value.processId);
      processSignal(command.action.value.signal);
      return;
    case "openTerminal":
      executableValue(command.action.value.executable);
      processArguments(command.action.value.arguments);
      localPath(command.action.value.workingDirectory);
      boundedInteger(command.action.value.columns, 1, 1_000, "terminal columns");
      boundedInteger(command.action.value.rows, 1, 1_000, "terminal rows");
      return;
    case "writeTerminal":
      requireResourceId(command.action.value.terminalId);
      boundedBytes(command.action.value.data, MAXIMUM_PROCESS_INPUT_BYTES, "terminal input");
      return;
    case "resizeTerminal":
      requireResourceId(command.action.value.terminalId);
      boundedInteger(command.action.value.columns, 1, 1_000, "terminal columns");
      boundedInteger(command.action.value.rows, 1, 1_000, "terminal rows");
      return;
    case "killTerminal":
    case "pauseTerminal":
    case "resumeTerminal":
      requireResourceId(command.action.value.terminalId);
      return;
    case "openLoopbackForward":
      loopbackHost(command.action.value.destinationHost);
      tcpPort(command.action.value.destinationPort);
      return;
    case "writeLoopbackForward":
      requireResourceId(command.action.value.forwardId);
      boundedBytes(command.action.value.data, MAXIMUM_PROCESS_INPUT_BYTES, "forward input");
      return;
    case "closeLoopbackForward":
      requireResourceId(command.action.value.forwardId);
      return;
    case "listenLoopbackForward":
      loopbackHost(command.action.value.serviceDestinationHost);
      tcpPort(command.action.value.serviceDestinationPort);
      loopbackHost(command.action.value.peerListenHost);
      if (command.action.value.peerListenPort !== 0) tcpPort(command.action.value.peerListenPort);
      return;
    case "writeReverseForward":
      requireResourceId(command.action.value.listenerId);
      requireResourceId(command.action.value.connectionId);
      boundedBytes(command.action.value.data, MAXIMUM_PROCESS_INPUT_BYTES, "reverse input");
      return;
    case "closeReverseForwardConnection":
      requireResourceId(command.action.value.listenerId);
      requireResourceId(command.action.value.connectionId);
      return;
    case "closeLoopbackListener":
      requireResourceId(command.action.value.listenerId);
      return;
    case "getRemoteDesktopCapabilities":
    case "getRemoteDesktopPermissions":
    case "showRemoteDesktopPermissionGuide":
      remoteDesktopControllerId(command.controllerDeviceId);
      return;
    case "startRemoteDesktop":
      remoteDesktopControllerId(command.controllerDeviceId);
      remoteDesktopDisplayId(command.action.value.displayId);
      remoteDesktopStartMode(command.action.value.mode);
      return;
    case "heartbeatRemoteDesktop":
    case "stopRemoteDesktop":
    case "getRemoteDesktopFrame":
    case "probeRemoteDesktopPresentation":
    case "listRemoteDesktopDisplayModes":
      remoteDesktopControllerId(command.controllerDeviceId);
      remoteDesktopLeaseId(command.action.value.leaseId);
      if (command.action.case === "getRemoteDesktopFrame"
        && typeof command.action.value.cursorOverlay !== "boolean") {
        throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
      }
      return;
    case "setRemoteDesktopDisplayMode":
      remoteDesktopControllerId(command.controllerDeviceId);
      remoteDesktopLeaseId(command.action.value.leaseId);
      remoteDesktopControlGeneration(command.action.value.controlGeneration);
      remoteDesktopDisplayModeId(command.action.value.modeId);
      return;
    case "setRemoteDesktopControl":
    case "setRemoteDesktopPresentation":
      remoteDesktopControllerId(command.controllerDeviceId);
      remoteDesktopLeaseId(command.action.value.leaseId);
      return;
    case "sendRemoteDesktopInput":
      remoteDesktopControllerId(command.controllerDeviceId);
      remoteDesktopLeaseId(command.action.value.leaseId);
      remoteDesktopSequence(command.action.value.sequence);
      remoteDesktopInput(command.action.value);
      return;
    case "createRemoteDesktopOffer":
      remoteDesktopControllerId(command.controllerDeviceId);
      remoteDesktopLeaseId(command.action.value.leaseId);
      remoteDesktopAttemptId(command.action.value.attemptId);
      remoteDesktopSdp(command.action.value.offerSdp);
      if (typeof command.action.value.cursorOverlay !== "boolean") {
        throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
      }
      if (command.action.value.settings !== undefined) {
        validateRemoteDesktopVideoSettings(command.action.value.settings);
      }
      return;
    case "exchangeRemoteDesktopIce":
      remoteDesktopControllerId(command.controllerDeviceId);
      remoteDesktopLeaseId(command.action.value.leaseId);
      remoteDesktopAttemptId(command.action.value.attemptId);
      remoteDesktopIceCandidates(command.action.value.candidates);
      boundedInteger(command.action.value.after, 0, MAXIMUM_REMOTE_DESKTOP_ICE_TOTAL, "Remote Desktop ICE cursor");
      if (command.action.value.after + command.action.value.candidates.length > MAXIMUM_REMOTE_DESKTOP_ICE_TOTAL) {
        throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
      }
      return;
    case "transferRemoteDesktopClipboardText":
      remoteDesktopControllerId(command.controllerDeviceId);
      remoteDesktopLeaseId(command.action.value.leaseId);
      remoteDesktopControlGeneration(command.action.value.controlGeneration);
      switch (command.action.value.action.case) {
        case "copy":
          return;
        case "paste":
          validateRemoteDesktopClipboardText(command.action.value.action.value.text);
          return;
        case undefined:
          throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
      }
    case "transferRemoteDesktopClipboardContent":
      remoteDesktopControllerId(command.controllerDeviceId);
      remoteDesktopLeaseId(command.action.value.leaseId);
      remoteDesktopControlGeneration(command.action.value.controlGeneration);
      validateRemoteDesktopClipboardContentRequest(command.action.value);
      return;
    default:
      throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
}

function readOnly(capability: DevicePeerCapabilityKind): CommandSpecification {
  return { capability, effect: DevicePeerEffectKind.READ_ONLY };
}

function effect(capability: DevicePeerCapabilityKind): CommandSpecification {
  return { capability, effect: DevicePeerEffectKind.SIDE_EFFECT };
}

function mutationResult(): AgentPayload {
  return { case: "fileMutation", value: create(DevicePeerFileMutationResultSchema) };
}

function acknowledgement(): AgentPayload {
  return { case: "acknowledgement", value: create(DevicePeerAcknowledgementSchema) };
}

function remoteDesktopClipboardContentResult(
  value: { readonly transferId?: string; readonly length?: number; readonly data?: string }
): AgentPayload {
  return {
    case: "remoteDesktopClipboardContent",
    value: create(RemoteDesktopClipboardContentResultSchema, value)
  };
}

function remoteDesktopControllerId(value: string): void {
  if (!validResourceId(value)) throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
}

function remoteDesktopDisplayId(value: string): void {
  if (!validRemoteDesktopIdentifier(value, MAXIMUM_REMOTE_DESKTOP_DISPLAY_ID_CHARACTERS)) {
    throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
}

function remoteDesktopDisplayModeId(value: string): void {
  if (typeof value !== "string" || !/^[0-9]{1,10}$/u.test(value)) {
    throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
}

function remoteDesktopLeaseId(value: string): void {
  if (!validRemoteDesktopIdentifier(value, MAXIMUM_REMOTE_DESKTOP_LEASE_ID_CHARACTERS)) {
    throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
}

function remoteDesktopAttemptId(value: string): void {
  if (typeof value !== "string" || value.length > MAXIMUM_REMOTE_DESKTOP_ATTEMPT_ID_CHARACTERS
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
}

function remoteDesktopStartMode(value: RemoteDesktopStartMode): void {
  if (value !== RemoteDesktopStartMode.NEW && value !== RemoteDesktopStartMode.RESUME
    && value !== RemoteDesktopStartMode.TAKEOVER) {
    throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
}

function remoteDesktopSequence(value: bigint): void {
  if (typeof value !== "bigint" || value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
}

function remoteDesktopControlGeneration(value: bigint): void {
  if (typeof value !== "bigint" || value < 1n) {
    throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
}

function validateRemoteDesktopClipboardText(value: string): void {
  if (!validRemoteDesktopClipboardText(value)) {
    throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
}

function validRemoteDesktopClipboardText(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= REMOTE_DESKTOP_MAX_CLIPBOARD_TEXT_CHARACTERS
    && !value.includes("\u0000");
}

function validateRemoteDesktopClipboardContentRequest(value: RemoteDesktopClipboardContentRequest): void {
  switch (value.action.case) {
    case "copy":
      return;
    case "begin":
      boundedInteger(
        value.action.value.length,
        1,
        REMOTE_DESKTOP_CLIPBOARD_MAX_CHARACTERS,
        "Remote Desktop clipboard length"
      );
      return;
    case "read":
      requireResourceId(value.action.value.transferId);
      boundedInteger(
        value.action.value.offset,
        0,
        REMOTE_DESKTOP_CLIPBOARD_MAX_CHARACTERS - 1,
        "Remote Desktop clipboard offset"
      );
      return;
    case "write":
      requireResourceId(value.action.value.transferId);
      boundedInteger(
        value.action.value.offset,
        0,
        REMOTE_DESKTOP_CLIPBOARD_MAX_CHARACTERS - 1,
        "Remote Desktop clipboard offset"
      );
      boundedText(
        value.action.value.data,
        1,
        REMOTE_DESKTOP_CLIPBOARD_CHUNK_CHARACTERS,
        "Remote Desktop clipboard chunk"
      );
      if (value.action.value.offset + value.action.value.data.length
        > REMOTE_DESKTOP_CLIPBOARD_MAX_CHARACTERS) {
        throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
      }
      return;
    case "commit":
    case "cancel":
      requireResourceId(value.action.value.transferId);
      return;
    case undefined:
      throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
}

function remoteDesktopInput(action: DevicePeerSendRemoteDesktopInputAction): void {
  let bytes: Uint8Array;
  try { bytes = toBinary(DevicePeerSendRemoteDesktopInputActionSchema, action); }
  catch { throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false); }
  if (bytes.byteLength > MAXIMUM_REMOTE_DESKTOP_INPUT_BYTES) {
    throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
  remoteDesktopInputEvents(action.events);
}

function remoteDesktopInputEvents(events: readonly RemoteDesktopInputEvent[]): void {
  if (!Array.isArray(events) || events.length > MAXIMUM_REMOTE_DESKTOP_INPUT_EVENTS) {
    throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
  for (const event of events) {
    switch (event.event.case) {
      case "move":
        if (!remoteDesktopUnit(event.event.value.x) || !remoteDesktopUnit(event.event.value.y)) {
          throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
        }
        break;
      case "button":
        if ((event.event.value.button !== RemoteDesktopMouseButton.LEFT
          && event.event.value.button !== RemoteDesktopMouseButton.MIDDLE
          && event.event.value.button !== RemoteDesktopMouseButton.RIGHT)
          || typeof event.event.value.down !== "boolean"
          || !remoteDesktopUnit(event.event.value.x) || !remoteDesktopUnit(event.event.value.y)) {
          throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
        }
        break;
      case "scroll":
        if (!remoteDesktopDelta(event.event.value.deltaX) || !remoteDesktopDelta(event.event.value.deltaY)) {
          throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
        }
        break;
      case "key":
        if (!REMOTE_DESKTOP_KEY_CODES.has(event.event.value.code)
          || typeof event.event.value.down !== "boolean") {
          throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
        }
        break;
      case "text":
        boundedText(event.event.value.text, 0, MAXIMUM_REMOTE_DESKTOP_TEXT_CHARACTERS, "Remote Desktop text input");
        break;
      case "release":
        break;
      case undefined:
        throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
    }
  }
}

function remoteDesktopIceCandidates(candidates: readonly RemoteDesktopIceCandidate[]): void {
  if (!Array.isArray(candidates) || candidates.length > MAXIMUM_REMOTE_DESKTOP_ICE_CANDIDATES) {
    throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
  for (const candidate of candidates) {
    if (typeof candidate.candidate !== "string" || !candidate.candidate.startsWith("candidate:")
      || candidate.candidate.length > MAXIMUM_REMOTE_DESKTOP_ICE_CANDIDATE_CHARACTERS
      || (candidate.sdpMid !== undefined
        && !validBoundedText(candidate.sdpMid, 0, MAXIMUM_REMOTE_DESKTOP_ICE_MID_CHARACTERS))
      || (candidate.sdpMLineIndex !== undefined
        && (!Number.isInteger(candidate.sdpMLineIndex) || candidate.sdpMLineIndex < 0
          || candidate.sdpMLineIndex >= 32))
      || (candidate.sdpMid === undefined && candidate.sdpMLineIndex === undefined)
      || (candidate.usernameFragment !== undefined
        && !validBoundedText(candidate.usernameFragment, 0, MAXIMUM_REMOTE_DESKTOP_ICE_USERNAME_FRAGMENT_CHARACTERS))) {
      throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
    }
  }
}

function validateRemoteDesktopCapabilities(value: RemoteDesktopCapabilities): void {
  if (value.protocolVersion !== 1 || typeof value.enabled !== "boolean" || typeof value.canControl !== "boolean"
    || !validBoundedText(value.platform, 1, MAXIMUM_REMOTE_DESKTOP_PLATFORM_CHARACTERS)
    || !Array.isArray(value.displays) || value.displays.length > MAXIMUM_REMOTE_DESKTOP_DISPLAYS
    || typeof value.automaticReconnect !== "boolean" || typeof value.connectionTakeover !== "boolean"
    || typeof value.webrtcVideo !== "boolean" || typeof value.trickleIce !== "boolean"
    || typeof value.jpegFallback !== "boolean" || typeof value.clipboardText !== "boolean"
    || typeof value.clipboardContent !== "boolean" || typeof value.videoSettings !== "boolean"
    || typeof value.systemAudio !== "boolean" || typeof value.backgroundViewing !== "boolean"
    || typeof value.displayModes !== "boolean" || typeof value.cursorOverlay !== "boolean"
    || value.permissions === undefined) {
    throw invalidRemoteDesktopHostResult();
  }
  if (value.platform !== "darwin" && (value.displayModes || value.cursorOverlay)) {
    throw invalidRemoteDesktopHostResult();
  }
  if (value.enabled && value.displays.length === 0) throw invalidRemoteDesktopHostResult();
  validateRemoteDesktopPermissions(value.permissions);
  const displayIds = new Set<string>();
  for (const display of value.displays) {
    validateRemoteDesktopDisplay(display);
    if (displayIds.has(display.displayId)) throw invalidRemoteDesktopHostResult();
    displayIds.add(display.displayId);
  }
}

function validateRemoteDesktopPermissions(value: RemoteDesktopPermissions): void {
  if (!validRemoteDesktopPermissionStatus(value.screenRecording)
    || !validRemoteDesktopPermissionStatus(value.accessibility)) {
    throw invalidRemoteDesktopHostResult();
  }
}

function validateRemoteDesktopDisplay(value: RemoteDesktopDisplay | undefined): asserts value is RemoteDesktopDisplay {
  if (value === undefined || !validRemoteDesktopIdentifier(value.displayId, MAXIMUM_REMOTE_DESKTOP_DISPLAY_ID_CHARACTERS)
    || !validBoundedText(value.name, 1, MAXIMUM_REMOTE_DESKTOP_DISPLAY_NAME_CHARACTERS)
    || !Number.isInteger(value.width) || value.width < 1 || value.width > MAXIMUM_REMOTE_DESKTOP_DIMENSION
    || !Number.isInteger(value.height) || value.height < 1 || value.height > MAXIMUM_REMOTE_DESKTOP_DIMENSION) {
    throw invalidRemoteDesktopHostResult();
  }
}

function validateRemoteDesktopLease(value: RemoteDesktopLease): void {
  if (!validRemoteDesktopIdentifier(value.leaseId, MAXIMUM_REMOTE_DESKTOP_LEASE_ID_CHARACTERS)
    || typeof value.controlling !== "boolean" || value.controlGeneration < 1n) {
    throw invalidRemoteDesktopHostResult();
  }
  validateRemoteDesktopDisplay(value.display);
}

function validateRemoteDesktopControlState(value: RemoteDesktopControlState): void {
  if (typeof value.controlling !== "boolean" || value.controlGeneration < 1n) {
    throw invalidRemoteDesktopHostResult();
  }
}

function validateRemoteDesktopPresentationProof(value: RemoteDesktopPresentationProof, expectedLeaseId: string): void {
  if (value.leaseId !== expectedLeaseId || value.proofSequence < 0n) {
    throw invalidRemoteDesktopHostResult();
  }
}

function validateRemoteDesktopVideoSettings(value: RemoteDesktopVideoSettings): void {
  if ((value.fps !== 30 && value.fps !== 60)
    || (value.quality !== RemoteDesktopVideoQuality.AUTO
      && value.quality !== RemoteDesktopVideoQuality.SAVER
      && value.quality !== RemoteDesktopVideoQuality.HD)
    || typeof value.audio !== "boolean") {
    throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
}

function validateRemoteDesktopOffer(value: RemoteDesktopOfferResult, expectedAttemptId: string): void {
  if (value.attemptId !== expectedAttemptId
    || !validRemoteDesktopSdp(value.answerSdp)) {
    throw invalidRemoteDesktopHostResult();
  }
}

function validateRemoteDesktopIceExchange(
  value: RemoteDesktopIceExchangeResult,
  expectedAttemptId: string,
  after: number
): void {
  try { remoteDesktopIceCandidates(value.candidates); }
  catch { throw invalidRemoteDesktopHostResult(); }
  if (value.attemptId !== expectedAttemptId
    || !Number.isInteger(value.next) || value.next < 0 || value.next > MAXIMUM_REMOTE_DESKTOP_ICE_TOTAL
    || value.next !== after + value.candidates.length || typeof value.complete !== "boolean") {
    throw invalidRemoteDesktopHostResult();
  }
}

function validateRemoteDesktopFrameResult(value: RemoteDesktopFrameResult): void {
  if (value.frame === undefined) return;
  if (!(value.frame.jpeg instanceof Uint8Array) || value.frame.jpeg.byteLength < 1
    || value.frame.jpeg.byteLength > MAXIMUM_REMOTE_DESKTOP_FRAME_BYTES) {
    throw invalidRemoteDesktopHostResult();
  }
  if (value.frame.cursor !== undefined) validateRemoteDesktopCursor(value.frame.cursor);
}

function validateRemoteDesktopDisplayModes(values: readonly RemoteDesktopDisplayMode[]): void {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAXIMUM_REMOTE_DESKTOP_DISPLAY_MODES) {
    throw invalidRemoteDesktopHostResult();
  }
  const ids = new Set<string>();
  let current = 0;
  for (const value of values) {
    if (!/^[0-9]{1,10}$/u.test(value.modeId)
      || !Number.isInteger(value.width) || value.width < 1 || value.width > MAXIMUM_REMOTE_DESKTOP_DIMENSION
      || !Number.isInteger(value.height) || value.height < 1 || value.height > MAXIMUM_REMOTE_DESKTOP_DIMENSION
      || typeof value.current !== "boolean" || typeof value.native !== "boolean"
      || ids.has(value.modeId)) {
      throw invalidRemoteDesktopHostResult();
    }
    ids.add(value.modeId);
    if (value.current) current += 1;
  }
  if (current !== 1) throw invalidRemoteDesktopHostResult();
}

function validateRemoteDesktopCursor(value: RemoteDesktopCursor): void {
  if (typeof value.visible !== "boolean"
    || !Number.isFinite(value.x) || value.x < 0 || value.x > 1
    || !Number.isFinite(value.y) || value.y < 0 || value.y > 1
    || !Number.isFinite(value.width) || value.width <= 0 || value.width > MAXIMUM_REMOTE_DESKTOP_CURSOR_DIMENSION
    || !Number.isFinite(value.height) || value.height <= 0 || value.height > MAXIMUM_REMOTE_DESKTOP_CURSOR_DIMENSION
    || !Number.isFinite(value.hotX) || value.hotX < 0 || value.hotX > value.width
    || !Number.isFinite(value.hotY) || value.hotY < 0 || value.hotY > value.height
    || !isBoundedRemoteDesktopCursorPng(value.png)) {
    throw invalidRemoteDesktopHostResult();
  }
}

function validRemoteDesktopPermissionStatus(value: RemoteDesktopPermissionStatus): boolean {
  return value === RemoteDesktopPermissionStatus.GRANTED
    || value === RemoteDesktopPermissionStatus.MISSING
    || value === RemoteDesktopPermissionStatus.UNKNOWN
    || value === RemoteDesktopPermissionStatus.NOT_REQUIRED;
}

function validRemoteDesktopFailureReason(value: RemoteDesktopFailureReason): boolean {
  return value === RemoteDesktopFailureReason.DISABLED
    || value === RemoteDesktopFailureReason.BUSY
    || value === RemoteDesktopFailureReason.STOPPED
    || value === RemoteDesktopFailureReason.LEASE_EXPIRED
    || value === RemoteDesktopFailureReason.DISPLAY_MISSING
    || value === RemoteDesktopFailureReason.SCREEN_PERMISSION_REQUIRED
    || value === RemoteDesktopFailureReason.ACCESSIBILITY_PERMISSION_REQUIRED
    || value === RemoteDesktopFailureReason.INPUT_UNAVAILABLE
    || value === RemoteDesktopFailureReason.INPUT_BUSY
    || value === RemoteDesktopFailureReason.VIEW_ONLY
    || value === RemoteDesktopFailureReason.VIDEO_UNAVAILABLE
    || value === RemoteDesktopFailureReason.VIDEO_BUSY
    || value === RemoteDesktopFailureReason.VIDEO_TIMEOUT
    || value === RemoteDesktopFailureReason.AUTHORITY_CHANGED
    || value === RemoteDesktopFailureReason.UNSUPPORTED
    || value === RemoteDesktopFailureReason.LOCKED_SESSION_UNSUPPORTED
    || value === RemoteDesktopFailureReason.CLIPBOARD_UNAVAILABLE
    || value === RemoteDesktopFailureReason.CLIPBOARD_BUSY
    || value === RemoteDesktopFailureReason.CLIPBOARD_EMPTY
    || value === RemoteDesktopFailureReason.CLIPBOARD_TOO_LARGE
    || value === RemoteDesktopFailureReason.CLIPBOARD_UNSUPPORTED
    || value === RemoteDesktopFailureReason.CLIPBOARD_EXPIRED
    || value === RemoteDesktopFailureReason.AUDIO_UNAVAILABLE
    || value === RemoteDesktopFailureReason.DISPLAY_MODES_UNAVAILABLE
    || value === RemoteDesktopFailureReason.DISPLAY_MODE_MISSING
    || value === RemoteDesktopFailureReason.DISPLAY_BUSY;
}

function remoteDesktopFailureCode(reason: RemoteDesktopFailureReason): DevicePeerFailureCode {
  switch (reason) {
    case RemoteDesktopFailureReason.DISABLED:
    case RemoteDesktopFailureReason.VIEW_ONLY:
    case RemoteDesktopFailureReason.UNSUPPORTED:
    case RemoteDesktopFailureReason.LOCKED_SESSION_UNSUPPORTED:
    case RemoteDesktopFailureReason.CLIPBOARD_UNAVAILABLE:
    case RemoteDesktopFailureReason.DISPLAY_MODES_UNAVAILABLE:
      return DevicePeerFailureCode.CAPABILITY_UNAVAILABLE;
    case RemoteDesktopFailureReason.BUSY:
    case RemoteDesktopFailureReason.INPUT_BUSY:
    case RemoteDesktopFailureReason.VIDEO_BUSY:
    case RemoteDesktopFailureReason.CLIPBOARD_BUSY:
    case RemoteDesktopFailureReason.DISPLAY_BUSY:
    case RemoteDesktopFailureReason.AUTHORITY_CHANGED:
      return DevicePeerFailureCode.CONFLICT;
    case RemoteDesktopFailureReason.STOPPED:
    case RemoteDesktopFailureReason.LEASE_EXPIRED:
    case RemoteDesktopFailureReason.DISPLAY_MISSING:
    case RemoteDesktopFailureReason.CLIPBOARD_EMPTY:
    case RemoteDesktopFailureReason.CLIPBOARD_EXPIRED:
    case RemoteDesktopFailureReason.DISPLAY_MODE_MISSING:
      return DevicePeerFailureCode.NOT_FOUND;
    case RemoteDesktopFailureReason.SCREEN_PERMISSION_REQUIRED:
    case RemoteDesktopFailureReason.ACCESSIBILITY_PERMISSION_REQUIRED:
      return DevicePeerFailureCode.PERMISSION_DENIED;
    case RemoteDesktopFailureReason.INPUT_UNAVAILABLE:
    case RemoteDesktopFailureReason.VIDEO_UNAVAILABLE:
    case RemoteDesktopFailureReason.AUDIO_UNAVAILABLE:
      return DevicePeerFailureCode.UNAVAILABLE;
    case RemoteDesktopFailureReason.VIDEO_TIMEOUT:
      return DevicePeerFailureCode.TIMEOUT;
    case RemoteDesktopFailureReason.CLIPBOARD_TOO_LARGE:
    case RemoteDesktopFailureReason.CLIPBOARD_UNSUPPORTED:
      return DevicePeerFailureCode.INVALID_REQUEST;
    case RemoteDesktopFailureReason.UNSPECIFIED:
      return DevicePeerFailureCode.INTERNAL;
  }
}

function invalidRemoteDesktopHostResult(): DevicePeerAgentError {
  return agentError(DevicePeerFailureCode.INTERNAL, false);
}

function validRemoteDesktopIdentifier(value: string, maximumCharacters: number): boolean {
  return validBoundedText(value, 1, maximumCharacters) && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validBoundedText(value: string, minimumCharacters: number, maximumCharacters: number): boolean {
  if (typeof value !== "string") return false;
  return value.length >= minimumCharacters && value.length <= maximumCharacters && !value.includes("\u0000");
}

function remoteDesktopSdp(value: string): void {
  if (!validRemoteDesktopSdp(value)) {
    throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
}

function validRemoteDesktopSdp(value: string): boolean {
  return typeof value === "string" && value.length >= 1 && !value.includes("\u0000")
    && Buffer.byteLength(value, "utf8") <= MAXIMUM_REMOTE_DESKTOP_SDP_BYTES;
}

function boundedText(value: string, minimumCharacters: number, maximumCharacters: number, _name: string): string {
  if (!validBoundedText(value, minimumCharacters, maximumCharacters)) {
    throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
  return value;
}

function remoteDesktopUnit(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function remoteDesktopDelta(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value)
    && Math.abs(value) <= MAXIMUM_REMOTE_DESKTOP_SCROLL_DELTA;
}

function protoFileKind(kind: DevicePeerFileStat["kind"]): DevicePeerFileKind {
  switch (kind) {
    case "file": return DevicePeerFileKind.FILE;
    case "directory": return DevicePeerFileKind.DIRECTORY;
    case "symbolic_link": return DevicePeerFileKind.SYMBOLIC_LINK;
    case "other": return DevicePeerFileKind.OTHER;
  }
}

async function listProjectDirectories(
  requestedPath: string,
  requestedMaximum: number,
  signal: AbortSignal
): Promise<{
  readonly path: string;
  readonly parentPath: string;
  readonly directories: readonly { readonly name: string; readonly path: string }[];
  readonly truncated: boolean;
}> {
  if (requestedPath !== "") localPath(requestedPath);
  const maximum = requestedMaximum === 0
    ? MAXIMUM_BROWSE_RESULTS
    : boundedInteger(requestedMaximum, 1, MAXIMUM_BROWSE_RESULTS, "maximumEntries");
  signal.throwIfAborted();
  const canonical = await canonicalDirectory(requestedPath === "" ? homedir() : requestedPath);
  const directories: Array<{ readonly name: string; readonly path: string }> = [];
  let scanned = 0;
  let truncated = false;
  const stream = await opendir(canonical);
  for await (const entry of stream) {
    signal.throwIfAborted();
    if (++scanned > MAXIMUM_BROWSE_SCAN) { truncated = true; break; }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const child = join(canonical, directoryEntryName(entry.name));
    try {
      const resolved = await realpath(child);
      if (!(await stat(resolved)).isDirectory()) continue;
      directories.push({ name: entry.name, path: localPath(resolve(resolved)) });
    } catch (error) {
      if (!isMissing(error) && !isPermissionDenied(error)) throw error;
    }
  }
  directories.sort((left, right) => left.name.localeCompare(right.name));
  if (directories.length > maximum) truncated = true;
  return { path: canonical, parentPath: dirname(canonical), directories: directories.slice(0, maximum), truncated };
}

function mutableDirectoryListing(value: Awaited<ReturnType<typeof listProjectDirectories>>): {
  readonly path: string;
  readonly parentPath: string;
  readonly directories: Array<{ readonly name: string; readonly path: string }>;
  readonly truncated: boolean;
} {
  return { ...value, directories: [...value.directories] };
}

async function inspectProjectDirectory(path: string, signal: AbortSignal): Promise<{
  readonly path: string;
  readonly kind: DevicePeerDirectoryKind;
}> {
  const accepted = localPath(path);
  signal.throwIfAborted();
  try {
    const canonical = resolve(await realpath(accepted));
    const information = await stat(canonical);
    signal.throwIfAborted();
    return {
      path: localPath(canonical),
      kind: information.isDirectory() ? DevicePeerDirectoryKind.DIRECTORY : DevicePeerDirectoryKind.FILE
    };
  } catch (error) {
    if (isMissing(error)) return { path: accepted, kind: DevicePeerDirectoryKind.MISSING };
    throw error;
  }
}

function processRequest(
  action: Extract<DevicePeerCommand["action"], { case: "startProcess" }>["value"]
): Omit<DevicePeerProcessStartRequest, "signal"> {
  const environment: Record<string, string> = {};
  let environmentBytes = 0;
  if (action.environment.length > MAXIMUM_PROCESS_ENVIRONMENT_ENTRIES) {
    throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
  for (const entry of action.environment) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry.name) || Object.hasOwn(environment, entry.name)) {
      throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
    }
    const value = decodeUtf8(entry.utf8Value);
    environmentBytes += Buffer.byteLength(entry.name) + entry.utf8Value.byteLength;
    if (environmentBytes > MAXIMUM_PROCESS_ENVIRONMENT_BYTES || value.includes("\u0000")) {
      throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
    }
    environment[entry.name] = value;
  }
  boundedBytes(action.initialStandardInput, MAXIMUM_PROCESS_INPUT_BYTES, "initialStandardInput");
  return {
    executable: executableValue(action.executable),
    args: processArguments(action.arguments),
    cwd: localPath(action.workingDirectory),
    env: environment
  };
}

function resolveRuntimeProcessRequest(
  request: Omit<DevicePeerProcessStartRequest, "signal">,
  executables: NodeDevicePeerRuntimeExecutableMap
): Omit<DevicePeerProcessStartRequest, "signal"> {
  const runtimeName = runtimeExecutableName(request.executable);
  if (runtimeName === undefined) {
    if (request.executable.startsWith("joko-runtime:") || pathDependentRuntimeAlias(request.executable)) {
      throw agentError(DevicePeerFailureCode.CAPABILITY_UNAVAILABLE, false);
    }
    return request;
  }
  const located = executables[runtimeName];
  if (located === undefined) throw agentError(DevicePeerFailureCode.CAPABILITY_UNAVAILABLE, false);
  const environment = { ...request.env };
  for (const locatedName of Object.keys(located.environment ?? {})) {
    const identity = environmentNameIdentity(locatedName);
    for (const requestName of Object.keys(environment)) {
      if (environmentNameIdentity(requestName) === identity) delete environment[requestName];
    }
  }
  return {
    ...request,
    executable: located.executable,
    args: processArguments([...(located.argumentPrefix ?? []), ...request.args]),
    // Locator-owned variables (for example Electron's Node mode) cannot be
    // overridden by an untrusted process command.
    env: { ...environment, ...(located.environment ?? {}) }
  };
}

function validateRuntimeExecutables(
  value: NodeDevicePeerRuntimeExecutableMap
): NodeDevicePeerRuntimeExecutableMap {
  const accepted = new Set<DevicePeerRuntimeExecutableName>(["node", "pi", "codex", "claude"]);
  const output: Partial<Record<DevicePeerRuntimeExecutableName, NodeDevicePeerRuntimeExecutable>> = {};
  for (const [rawName, rawDescriptor] of Object.entries(value)) {
    if (!accepted.has(rawName as DevicePeerRuntimeExecutableName)
      || typeof rawDescriptor !== "object" || rawDescriptor === null) {
      throw new TypeError("Device peer runtime executable locator is invalid.");
    }
    const name = rawName as DevicePeerRuntimeExecutableName;
    const descriptor = rawDescriptor as NodeDevicePeerRuntimeExecutable;
    const executable = descriptor.executable;
    if (!isAbsolute(executable) || resolve(executable) !== executable
      || Buffer.byteLength(executable) > MAXIMUM_PATH_BYTES
      || /[\u0000-\u001f\u007f]/u.test(executable)) {
      throw new TypeError("Device peer runtime executable locator is invalid.");
    }
    const argumentPrefix = processArguments(descriptor.argumentPrefix ?? []);
    const environment = runtimeExecutableEnvironment(descriptor.environment ?? {});
    output[name] = Object.freeze({
      executable,
      ...(argumentPrefix.length === 0 ? {} : { argumentPrefix: Object.freeze([...argumentPrefix]) }),
      ...(Object.keys(environment).length === 0 ? {} : { environment: Object.freeze(environment) })
    });
  }
  return Object.freeze(output);
}

function runtimeExecutableEnvironment(value: Readonly<Record<string, string>>): Record<string, string> {
  const output: Record<string, string> = {};
  let bytes = 0;
  const entries = Object.entries(value);
  if (entries.length > MAXIMUM_PROCESS_ENVIRONMENT_ENTRIES) {
    throw new TypeError("Device peer runtime executable locator is invalid.");
  }
  for (const [name, item] of entries) {
    bytes += Buffer.byteLength(name) + Buffer.byteLength(item);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || item.includes("\u0000")
      || bytes > MAXIMUM_PROCESS_ENVIRONMENT_BYTES) {
      throw new TypeError("Device peer runtime executable locator is invalid.");
    }
    output[name] = item;
  }
  return output;
}

function runtimeExecutableName(value: string): DevicePeerRuntimeExecutableName | undefined {
  for (const [name, token] of Object.entries(DEVICE_PEER_RUNTIME_EXECUTABLES)) {
    if (value === token) return name as DevicePeerRuntimeExecutableName;
  }
  return undefined;
}

function pathDependentRuntimeAlias(value: string): boolean {
  return /^(?:node|pi|codex|claude)(?:\.exe)?$/iu.test(value);
}

function environmentNameIdentity(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function executableValue(value: string): string {
  if (value.length < 1 || Buffer.byteLength(value) > MAXIMUM_PATH_BYTES || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
  return value;
}

function processArguments(values: readonly string[]): readonly string[] {
  if (values.length > MAXIMUM_PROCESS_ARGUMENTS) throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  let bytes = 0;
  for (const value of values) {
    bytes += Buffer.byteLength(value);
    if (value.includes("\u0000") || bytes > MAXIMUM_PROCESS_ARGUMENT_BYTES) {
      throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
    }
  }
  return values;
}

function processSignal(signal: DevicePeerProcessSignal): NodeJS.Signals {
  switch (signal) {
    case DevicePeerProcessSignal.INTERRUPT: return "SIGINT";
    case DevicePeerProcessSignal.TERMINATE: return "SIGTERM";
    case DevicePeerProcessSignal.KILL: return "SIGKILL";
    default: throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
}

async function canonicalDirectory(value: string): Promise<string> {
  const accepted = localPath(value);
  try {
    const canonical = localPath(resolve(await realpath(accepted)));
    const information = await lstat(canonical);
    if (!information.isDirectory() || information.isSymbolicLink()) {
      throw agentError(DevicePeerFailureCode.NOT_DIRECTORY, false);
    }
    return canonical;
  } catch (error) {
    if (error instanceof DevicePeerAgentError) throw error;
    throw mapFileError(error);
  }
}

function localPath(value: string): string {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value) > MAXIMUM_PATH_BYTES
    || !isAbsolute(value) || resolve(value) !== value || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
    || value.split(/[\\/]/u).filter(Boolean).length > MAXIMUM_PATH_COMPONENTS) {
    throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
  return value;
}

async function directoryAvailability(path: string): Promise<DevicePeerDirectoryAvailability> {
  try {
    await canonicalDirectory(path);
    return DevicePeerDirectoryAvailability.EXISTS;
  } catch (error) {
    if (error instanceof DevicePeerAgentError && error.code === DevicePeerFailureCode.NOT_FOUND) {
      return DevicePeerDirectoryAvailability.MISSING;
    }
    throw error;
  }
}

function recentDirectoryRecord(value: unknown): RecentDirectoryRecord {
  if (!isRecord(value) || !exactKeys(value, ["path", "name", "lastUsedAt"])
    || typeof value.path !== "string" || localPath(value.path) !== value.path
    || typeof value.name !== "string" || recentDirectoryName(value.name) !== value.name
    || typeof value.lastUsedAt !== "number" || !Number.isSafeInteger(value.lastUsedAt)
    || value.lastUsedAt < 0 || value.lastUsedAt > Date.now() + 60_000) {
    throw agentError(DevicePeerFailureCode.INTERNAL, false);
  }
  return { path: value.path, name: value.name, lastUsedAt: value.lastUsedAt };
}

function recentDirectoryName(value: string): string {
  if (value.length < 1 || value.length > 256 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  return value;
}

function fileKind(information: Stats): "file" | "directory" | "symbolic_link" | "other" {
  if (information.isSymbolicLink()) return "symbolic_link";
  if (information.isFile()) return "file";
  if (information.isDirectory()) return "directory";
  return "other";
}

function direntKind(entry: Dirent): ReturnType<typeof fileKind> {
  if (entry.isSymbolicLink()) return "symbolic_link";
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  return "other";
}

function directoryEntryName(value: string): string {
  if (value.length < 1 || Buffer.byteLength(value) > MAXIMUM_PATH_BYTES || value === "." || value === ".."
    || value.includes("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw agentError(DevicePeerFailureCode.INTERNAL, false);
  }
  return value;
}

async function assertCanonicalExistingAncestor(path: string): Promise<void> {
  let cursor = path;
  for (let depth = 0; depth <= MAXIMUM_PATH_COMPONENTS; depth += 1) {
    const information = await lstat(cursor).catch(missingAsUndefined);
    if (information !== undefined) {
      if (!information.isDirectory() || information.isSymbolicLink() || !samePath(await realpath(cursor), cursor)) {
        throw agentError(DevicePeerFailureCode.CONFLICT, false);
      }
      return;
    }
    const parent = dirname(cursor);
    if (samePath(parent, cursor)) break;
    cursor = parent;
  }
  throw agentError(DevicePeerFailureCode.NOT_FOUND, false);
}

async function removeEntry(
  path: string,
  recursive: boolean,
  signal: AbortSignal | undefined,
  depth: number,
  counter: { value: number }
): Promise<void> {
  signal?.throwIfAborted();
  if (depth > MAXIMUM_REMOVE_DEPTH || ++counter.value > MAXIMUM_DIRECTORY_ENTRIES) {
    throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
  const information = await lstat(path);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    await unlink(path);
    return;
  }
  if (!recursive) {
    await rmdir(path);
    return;
  }
  const stream = await opendir(path);
  for await (const entry of stream) {
    await removeEntry(join(path, directoryEntryName(entry.name)), true, signal, depth + 1, counter);
  }
  await rmdir(path);
}

function isFilesystemRoot(path: string): boolean {
  return samePath(parse(path).root, path);
}

function boundedSafeSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw agentError(DevicePeerFailureCode.INTERNAL, false);
  return value;
}

function boundedInteger(value: number | bigint, minimum: number, maximum: number, _name: string): number {
  const numeric = typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isSafeInteger(numeric) || numeric < minimum || numeric > maximum) {
    throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
  return numeric;
}

function boundedBytes(value: Uint8Array, maximum: number, _name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength > maximum) {
    throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
  return value;
}

function decodeUtf8(value: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
  catch { throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false); }
}

function splitBytes(value: Uint8Array, maximum: number): readonly Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < value.byteLength; offset += maximum) {
    chunks.push(value.slice(offset, Math.min(value.byteLength, offset + maximum)));
  }
  return chunks;
}

function splitUtf8(value: string, maximum: number): readonly string[] {
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maximum && current !== "") {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += character;
    bytes += size;
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

function loopbackHost(value: DevicePeerLoopbackHost): "127.0.0.1" | "::1" | "localhost" {
  switch (value) {
    case DevicePeerLoopbackHost.IPV4: return "127.0.0.1";
    case DevicePeerLoopbackHost.IPV6: return "::1";
    case DevicePeerLoopbackHost.LOCALHOST: return "localhost";
    default: throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
}

function tcpPort(value: number): number {
  return boundedInteger(value, 1, 65_535, "port");
}

async function socketConnected(socket: Socket, signal: AbortSignal): Promise<void> {
  if (signal.aborted) { socket.destroy(); signal.throwIfAborted(); }
  await new Promise<void>((resolveConnected, rejectConnected) => {
    const done = (error?: unknown): void => {
      signal.removeEventListener("abort", aborted);
      socket.removeListener("connect", connected);
      socket.removeListener("error", failed);
      if (error === undefined) resolveConnected(); else rejectConnected(error);
    };
    const connected = (): void => done();
    const failed = (): void => done(agentError(DevicePeerFailureCode.UNAVAILABLE, true));
    const aborted = (): void => { socket.destroy(); done(abortError()); };
    signal.addEventListener("abort", aborted, { once: true });
    socket.once("connect", connected);
    socket.once("error", failed);
  });
}

async function listen(server: Server, host: string, port: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) signal.throwIfAborted();
  await new Promise<void>((resolveListening, rejectListening) => {
    const done = (error?: unknown): void => {
      signal.removeEventListener("abort", aborted);
      server.removeListener("listening", listening);
      server.removeListener("error", failed);
      if (error === undefined) resolveListening(); else rejectListening(error);
    };
    const listening = (): void => done();
    const failed = (): void => done(agentError(DevicePeerFailureCode.UNAVAILABLE, true));
    const aborted = (): void => { server.close(); done(abortError()); };
    signal.addEventListener("abort", aborted, { once: true });
    server.once("listening", listening);
    server.once("error", failed);
    server.listen({ host, port, exclusive: true });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

function writeToSocket(socket: Socket, content: Uint8Array, signal: AbortSignal): Promise<void> {
  if (socket.destroyed) return Promise.reject(agentError(DevicePeerFailureCode.NOT_FOUND, false));
  return writeToStream(socket, content, signal);
}

function writeToStream(
  stream: NodeJS.WritableStream,
  content: Uint8Array,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolveWrite, rejectWrite) => {
    const aborted = (): void => done(abortError());
    const done = (error?: unknown): void => {
      signal.removeEventListener("abort", aborted);
      if (error === undefined) resolveWrite(); else rejectWrite(error);
    };
    signal.addEventListener("abort", aborted, { once: true });
    stream.write(Buffer.from(content), (error?: Error | null) => done(error ?? undefined));
  });
}

function childSpawned(
  child: ReturnType<typeof spawn>,
  signal: AbortSignal | undefined
): Promise<void> {
  if (signal?.aborted) { child.kill(); signal.throwIfAborted(); }
  return new Promise<void>((resolveSpawn, rejectSpawn) => {
    const done = (error?: unknown): void => {
      signal?.removeEventListener("abort", aborted);
      child.removeListener("spawn", spawned);
      child.removeListener("error", failed);
      if (error === undefined) resolveSpawn(); else rejectSpawn(error);
    };
    const spawned = (): void => done();
    const failed = (): void => done(agentError(DevicePeerFailureCode.PROCESS_FAILED, false));
    const aborted = (): void => { child.kill(); done(abortError()); };
    signal?.addEventListener("abort", aborted, { once: true });
    child.once("spawn", spawned);
    child.once("error", failed);
  });
}

function processExit(handle: DevicePeerProcessHandle): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  return new Promise((resolveExit, rejectExit) => {
    handle.once("exit", (code, signal) => resolveExit({ code, signal }));
    handle.once("error", () => rejectExit(agentError(DevicePeerFailureCode.PROCESS_FAILED, false)));
  });
}

async function pumpReadable(
  stream: NodeJS.ReadableStream & AsyncIterable<unknown>,
  emit: (data: Uint8Array) => Promise<void>
): Promise<void> {
  for await (const raw of stream) {
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    for (const frame of splitBytes(bytes, MAXIMUM_STREAM_FRAME_BYTES)) await emit(frame);
  }
}

function requiredResource<T>(map: ReadonlyMap<string, T>, id: string, _kind: string): T {
  requireResourceId(id);
  const resource = map.get(id);
  if (resource === undefined) throw agentError(DevicePeerFailureCode.NOT_FOUND, false);
  return resource;
}

function requireResourceId(value: string): void {
  if (!validResourceId(value)) throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
}

function requiredReverseConnection(
  map: ReadonlyMap<string, Socket>,
  listenerId: string,
  connectionId: string
): Socket {
  if (!validResourceId(listenerId) || !validResourceId(connectionId)) {
    throw agentError(DevicePeerFailureCode.INVALID_REQUEST, false);
  }
  const socket = map.get(reverseConnectionKey(listenerId, connectionId));
  if (socket === undefined) throw agentError(DevicePeerFailureCode.NOT_FOUND, false);
  return socket;
}

function validResourceId(value: string): boolean {
  return typeof value === "string" && value.length >= 1 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function reverseConnectionKey(listenerId: string, connectionId: string): string {
  return `${listenerId}\u0000${connectionId}`;
}

function streamStartPayload(value: AgentPayload["case"]): boolean {
  return value === "processStarted" || value === "terminalOpened"
    || value === "loopbackForwardOpened" || value === "loopbackListenerOpened";
}

function streamTerminalPayload(value: AgentPayload["case"]): boolean {
  return value === "processExited" || value === "terminalExited"
    || value === "loopbackForwardClosed" || value === "loopbackListenerClosed";
}

function agentError(code: DevicePeerFailureCode, retryable: boolean): DevicePeerAgentError {
  return new DevicePeerAgentError(code, retryable);
}

function unknownAgentError(code: DevicePeerFailureCode): DevicePeerAgentError {
  return new DevicePeerAgentError(code, false, true);
}

function abortError(): Error {
  return new DOMException("The Device peer command was aborted.", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

function normalizeAgentError(error: unknown): DevicePeerAgentError {
  if (error instanceof DevicePeerAgentError) return error;
  return mapFileError(error);
}

function mapFileError(error: unknown): DevicePeerAgentError {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") return agentError(DevicePeerFailureCode.NOT_FOUND, false);
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return agentError(DevicePeerFailureCode.PERMISSION_DENIED, false);
  }
  if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EBUSY") {
    return agentError(DevicePeerFailureCode.CONFLICT, false);
  }
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH" || code === "ETIMEDOUT") {
    return agentError(DevicePeerFailureCode.UNAVAILABLE, true);
  }
  return agentError(DevicePeerFailureCode.INTERNAL, false);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function isPermissionDenied(error: unknown): boolean {
  return isRecord(error) && (error.code === "EACCES" || error.code === "EPERM");
}

function missingAsUndefined(error: unknown): undefined {
  if (isMissing(error)) return undefined;
  throw error;
}

function ignoreMissing(error: unknown): void {
  if (!isMissing(error)) throw error;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function pathKey(path: string): string {
  return process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

async function settleValueWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolveTimeout) => setTimeout(() => resolveTimeout(undefined), timeoutMs))
  ]);
}
