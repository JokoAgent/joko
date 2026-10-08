import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";

import { create } from "@bufbuild/protobuf";
import {
  DevicePeerCapabilityKind,
  type DevicePeerCommand,
  DevicePeerCommandSchema,
  DevicePeerCreateRemoteDesktopOfferActionSchema,
  DevicePeerEffectKind,
  DevicePeerExchangeRemoteDesktopIceActionSchema,
  DevicePeerFailureCode,
  DevicePeerGetRemoteDesktopCapabilitiesActionSchema,
  DevicePeerGetRemoteDesktopFrameActionSchema,
  DevicePeerGetRemoteDesktopPermissionsActionSchema,
  DevicePeerHeartbeatRemoteDesktopActionSchema,
  DevicePeerListRecentDirectoriesActionSchema,
  DevicePeerOpenTerminalActionSchema,
  DevicePeerRealpathActionSchema,
  DevicePeerResponsePhase,
  DevicePeerSendRemoteDesktopInputActionSchema,
  DevicePeerSetRemoteDesktopControlActionSchema,
  DevicePeerShowRemoteDesktopPermissionGuideActionSchema,
  DevicePeerStartRemoteDesktopActionSchema,
  DevicePeerStartProcessActionSchema,
  DevicePeerStopRemoteDesktopActionSchema,
  RemoteDesktopCapabilitiesSchema,
  RemoteDesktopControlStateSchema,
  RemoteDesktopDisplaySchema,
  RemoteDesktopFailureReason,
  RemoteDesktopFrameResultSchema,
  RemoteDesktopFrameSchema,
  RemoteDesktopIceCandidateSchema,
  RemoteDesktopIceExchangeResultSchema,
  RemoteDesktopInputEventSchema,
  RemoteDesktopLeaseSchema,
  RemoteDesktopOfferResultSchema,
  RemoteDesktopPermissionsSchema,
  RemoteDesktopPermissionStatus,
  RemoteDesktopPointerMoveInputSchema,
  RemoteDesktopTextInputSchema,
  RemoteDesktopStartMode
} from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  NodeDevicePeerAgentExecutor,
  type NodeDevicePeerAgentEmission
} from "./node-agent-executor.js";
import { DevicePeerRemoteDesktopHostError } from "./ports.js";
import type {
  DevicePeerProcessHandle,
  DevicePeerProcessTransportPort,
  DevicePeerRemoteDesktopHostPort,
  DevicePeerTerminalExit,
  DevicePeerTerminalHandle,
  DevicePeerTerminalTransportPort
} from "./ports.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Node Device peer recent project ownership", () => {
  it("records the canonical cwd of a successfully owned process", async () => {
    const root = await testRoot();
    const cwd = join(root, "project");
    await mkdir(cwd);
    const process = new TestProcessHandle();
    const executor = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "private", "recent.json"),
      processes: { open: async () => process }
    });

    await execute(executor, startProcess(cwd), (result) => {
      if (result.payload.case === "processStarted") setTimeout(() => process.finish(), 0);
    });
    const recent = await execute(executor, listRecentDirectories());

    expect(recent.at(-1)).toMatchObject({
      phase: DevicePeerResponsePhase.COMPLETED,
      payload: {
        case: "recentDirectories",
        value: { directories: [expect.objectContaining({ path: cwd, name: "project" })] }
      }
    });
    await executor.retire();
  });

  it("does not record a process or Terminal whose runtime open fails", async () => {
    const root = await testRoot();
    const cwd = join(root, "project");
    await mkdir(cwd);
    const executor = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "private", "recent.json"),
      processes: { open: async () => { throw new Error("process open failed"); } },
      terminals: { open: async () => { throw new Error("Terminal open failed"); } }
    });

    await execute(executor, startProcess(cwd));
    await execute(executor, openTerminal(cwd));
    const recent = await execute(executor, listRecentDirectories());

    expect(recent.at(-1)).toMatchObject({
      phase: DevicePeerResponsePhase.COMPLETED,
      payload: { case: "recentDirectories", value: { directories: [] } }
    });
    await executor.retire();
  });

  it("does not let private recent-history failure cancel an owned process or Terminal", async () => {
    const root = await testRoot();
    const cwd = join(root, "project");
    const unsafeParent = join(root, "not-a-directory");
    await mkdir(cwd);
    await writeFile(unsafeParent, "regular file", "utf8");
    const process = new TestProcessHandle();
    const terminal = new TestTerminalHandle();
    const processes: DevicePeerProcessTransportPort = { open: async () => process };
    const terminals: DevicePeerTerminalTransportPort = { open: async () => terminal };
    const executor = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: join(unsafeParent, "recent.json"),
      processes,
      terminals
    });

    const processResults = await execute(executor, startProcess(cwd), (result) => {
      if (result.payload.case === "processStarted") setTimeout(() => process.finish(), 0);
    });
    const terminalResults = await execute(executor, openTerminal(cwd), (result) => {
      if (result.payload.case === "terminalOpened") setTimeout(() => terminal.finish(), 0);
    });

    expect(processResults.map(result => result.payload.case)).toEqual([
      "acknowledgement",
      "processStarted",
      "processExited"
    ]);
    expect(terminalResults.map(result => result.payload.case)).toEqual([
      "acknowledgement",
      "terminalOpened",
      "terminalExited"
    ]);
    await executor.retire();
  });
});

describe("Node Device peer account-home ownership", () => {
  it("resolves only dot as the target account home while rejecting other relative paths", async () => {
    const root = await testRoot();
    const executor = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "private", "recent.json")
    });

    const results = await execute(executor, realpathCommand("."));
    expect(results.at(-1)).toMatchObject({
      phase: DevicePeerResponsePhase.COMPLETED,
      payload: {
        case: "realpath",
        value: { path: resolve(await realpath(homedir())) }
      }
    });
    await expect(execute(executor, realpathCommand("project"))).rejects.toBeDefined();
    await executor.retire();
  });
});

describe("Node Device peer Remote Desktop host ownership", () => {
  it("advertises only an installed host port and maps every typed action and result", async () => {
    const root = await testRoot();
    const withoutHost = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "without-host.json")
    });
    expect(withoutHost.capabilities).not.toContain(DevicePeerCapabilityKind.REMOTE_DESKTOP);
    await expect(execute(withoutHost, remoteDesktopCommands()[0]!.command)).rejects.toBeDefined();
    await withoutHost.retire();

    const fixture = remoteDesktopHost();
    const executor = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "with-host.json"),
      remoteDesktop: fixture.port
    });
    expect(executor.capabilities).toContain(DevicePeerCapabilityKind.REMOTE_DESKTOP);

    const commands = remoteDesktopCommands();
    for (const item of commands) {
      const results = await execute(executor, item.command);
      expect(results.map((result) => result.payload.case)).toEqual(["acknowledgement", item.payload]);
      expect(results.at(-1)?.phase).toBe(DevicePeerResponsePhase.COMPLETED);
    }
    expect(fixture.state.calls.map((call) => call.method)).toEqual(commands.map((item) => item.method));
    expect(fixture.state.calls.every((call) => call.request.controllerDeviceId === "controller-device")).toBe(true);

    await executor.retire();
    await executor.retire();
    expect(fixture.state.retireCalls).toBe(1);
  });

  it("rejects over-bound commands before host dispatch and fails closed on over-bound host results", async () => {
    const root = await testRoot();
    const fixture = remoteDesktopHost({
      getFrame: async () => create(RemoteDesktopFrameResultSchema, {
        frame: create(RemoteDesktopFrameSchema, { jpeg: new Uint8Array(180_001) })
      })
    });
    const executor = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "bounded-host.json"),
      remoteDesktop: fixture.port
    });
    const oversizedOffer = remoteDesktopCommand({
      case: "createRemoteDesktopOffer",
      value: create(DevicePeerCreateRemoteDesktopOfferActionSchema, {
        leaseId: "lease-1",
        attemptId: "attempt-1",
        offerSdp: "界".repeat(22_000)
      })
    }, DevicePeerEffectKind.SIDE_EFFECT);
    const zeroSequence = remoteDesktopCommand({
      case: "sendRemoteDesktopInput",
      value: create(DevicePeerSendRemoteDesktopInputActionSchema, {
        leaseId: "lease-1",
        sequence: 0n
      })
    }, DevicePeerEffectKind.SIDE_EFFECT);
    const oversizedInput = remoteDesktopCommand({
      case: "sendRemoteDesktopInput",
      value: create(DevicePeerSendRemoteDesktopInputActionSchema, {
        leaseId: "lease-1",
        sequence: 1n,
        events: Array.from({ length: 2 }, () => create(RemoteDesktopInputEventSchema, {
          event: {
            case: "text",
            value: create(RemoteDesktopTextInputSchema, { text: "界".repeat(3_000) })
          }
        }))
      })
    }, DevicePeerEffectKind.SIDE_EFFECT);

    await expect(execute(executor, oversizedOffer)).rejects.toBeDefined();
    await expect(execute(executor, zeroSequence)).rejects.toBeDefined();
    await expect(execute(executor, oversizedInput)).rejects.toBeDefined();
    expect(fixture.state.calls).toEqual([]);

    const frame = remoteDesktopCommands().find((item) => item.method === "getFrame")!;
    const results = await execute(executor, frame.command);
    expect(results.at(-1)).toMatchObject({
      phase: DevicePeerResponsePhase.FAILED,
      payload: {
        case: "failure",
        value: { code: DevicePeerFailureCode.INTERNAL, retryable: false }
      }
    });
    await executor.retire();
  });

  it("preserves a bounded typed Remote Desktop domain failure", async () => {
    const root = await testRoot();
    const fixture = remoteDesktopHost({
      start: async () => {
        throw new DevicePeerRemoteDesktopHostError(RemoteDesktopFailureReason.BUSY, true);
      }
    });
    const executor = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "failure-host.json"),
      remoteDesktop: fixture.port
    });
    const start = remoteDesktopCommands().find((item) => item.method === "start")!;

    const results = await execute(executor, start.command);
    expect(results.at(-1)).toMatchObject({
      phase: DevicePeerResponsePhase.FAILED,
      payload: {
        case: "failure",
        value: {
          code: DevicePeerFailureCode.CONFLICT,
          retryable: true,
          remoteDesktop: { reason: RemoteDesktopFailureReason.BUSY, retryable: true }
        }
      }
    });
    await executor.retire();
  });
});

async function testRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "joko-device-peer-recents-"));
  roots.push(root);
  return root;
}

async function execute(
  executor: NodeDevicePeerAgentExecutor,
  command: DevicePeerCommand,
  observe?: (result: NodeDevicePeerAgentEmission) => void
): Promise<NodeDevicePeerAgentEmission[]> {
  const results: NodeDevicePeerAgentEmission[] = [];
  await executor.execute(command, new AbortController().signal, (result) => {
    results.push(result);
    observe?.(result);
  });
  return results;
}

function startProcess(cwd: string): DevicePeerCommand {
  return create(DevicePeerCommandSchema, {
    capability: DevicePeerCapabilityKind.PROCESS,
    effect: DevicePeerEffectKind.SIDE_EFFECT,
    action: {
      case: "startProcess",
      value: create(DevicePeerStartProcessActionSchema, {
        executable: process.execPath,
        workingDirectory: cwd
      })
    }
  });
}

function openTerminal(cwd: string): DevicePeerCommand {
  return create(DevicePeerCommandSchema, {
    capability: DevicePeerCapabilityKind.TERMINAL,
    effect: DevicePeerEffectKind.SIDE_EFFECT,
    action: {
      case: "openTerminal",
      value: create(DevicePeerOpenTerminalActionSchema, {
        executable: process.execPath,
        workingDirectory: cwd,
        columns: 80,
        rows: 24
      })
    }
  });
}

function listRecentDirectories(): DevicePeerCommand {
  return create(DevicePeerCommandSchema, {
    capability: DevicePeerCapabilityKind.FILES,
    effect: DevicePeerEffectKind.READ_ONLY,
    action: {
      case: "listRecentDirectories",
      value: create(DevicePeerListRecentDirectoriesActionSchema, { maximumEntries: 100 })
    }
  });
}

function realpathCommand(path: string): DevicePeerCommand {
  return create(DevicePeerCommandSchema, {
    capability: DevicePeerCapabilityKind.FILES,
    effect: DevicePeerEffectKind.READ_ONLY,
    action: {
      case: "realpath",
      value: create(DevicePeerRealpathActionSchema, { path })
    }
  });
}

function remoteDesktopHost(overrides: Partial<DevicePeerRemoteDesktopHostPort> = {}): {
  readonly port: DevicePeerRemoteDesktopHostPort;
  readonly state: {
    readonly calls: { readonly method: string; readonly request: { readonly controllerDeviceId: string } }[];
    retireCalls: number;
  };
} {
  const state = {
    calls: [] as { readonly method: string; readonly request: { readonly controllerDeviceId: string } }[],
    retireCalls: 0
  };
  const display = create(RemoteDesktopDisplaySchema, {
    displayId: "display-1",
    name: "Primary display",
    width: 1920,
    height: 1080
  });
  const permissions = create(RemoteDesktopPermissionsSchema, {
    screenRecording: RemoteDesktopPermissionStatus.GRANTED,
    accessibility: RemoteDesktopPermissionStatus.GRANTED
  });
  const record = (method: string, request: { readonly controllerDeviceId: string }): void => {
    state.calls.push({ method, request });
  };
  const port: DevicePeerRemoteDesktopHostPort = {
    async getCapabilities(request) {
      record("getCapabilities", request);
      return create(RemoteDesktopCapabilitiesSchema, {
        protocolVersion: 1,
        enabled: true,
        canControl: true,
        platform: "test",
        displays: [display],
        permissions,
        automaticReconnect: true,
        connectionTakeover: true,
        webrtcVideo: true,
        trickleIce: true,
        jpegFallback: true
      });
    },
    async getPermissions(request) {
      record("getPermissions", request);
      return permissions;
    },
    async showPermissionGuide(request) { record("showPermissionGuide", request); },
    async start(request) {
      record("start", request);
      return create(RemoteDesktopLeaseSchema, { leaseId: "lease-1", display, controlling: true });
    },
    async heartbeat(request) {
      record("heartbeat", request);
      return create(RemoteDesktopControlStateSchema, { controlling: true });
    },
    async stop(request) { record("stop", request); },
    async setControl(request) {
      record("setControl", request);
      return create(RemoteDesktopControlStateSchema, { controlling: request.enabled });
    },
    async sendInput(request) { record("sendInput", request); },
    async createOffer(request) {
      record("createOffer", request);
      return create(RemoteDesktopOfferResultSchema, {
        attemptId: request.attemptId,
        answerSdp: "v=0\r\n"
      });
    },
    async exchangeIce(request) {
      record("exchangeIce", request);
      return create(RemoteDesktopIceExchangeResultSchema, {
        attemptId: request.attemptId,
        candidates: [remoteDesktopIceCandidate()],
        next: request.after + 1,
        complete: false
      });
    },
    async getFrame(request) {
      record("getFrame", request);
      return create(RemoteDesktopFrameResultSchema, {
        frame: create(RemoteDesktopFrameSchema, { jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) })
      });
    },
    async retire() { state.retireCalls += 1; },
    ...overrides
  };
  return { port, state };
}

function remoteDesktopCommands(): readonly {
  readonly method: string;
  readonly payload: NodeDevicePeerAgentEmission["payload"]["case"];
  readonly command: DevicePeerCommand;
}[] {
  return [
    {
      method: "getCapabilities",
      payload: "remoteDesktopCapabilities",
      command: remoteDesktopCommand({
        case: "getRemoteDesktopCapabilities",
        value: create(DevicePeerGetRemoteDesktopCapabilitiesActionSchema)
      }, DevicePeerEffectKind.READ_ONLY)
    },
    {
      method: "getPermissions",
      payload: "remoteDesktopPermissions",
      command: remoteDesktopCommand({
        case: "getRemoteDesktopPermissions",
        value: create(DevicePeerGetRemoteDesktopPermissionsActionSchema)
      }, DevicePeerEffectKind.READ_ONLY)
    },
    {
      method: "showPermissionGuide",
      payload: "acknowledgement",
      command: remoteDesktopCommand({
        case: "showRemoteDesktopPermissionGuide",
        value: create(DevicePeerShowRemoteDesktopPermissionGuideActionSchema)
      }, DevicePeerEffectKind.SIDE_EFFECT)
    },
    {
      method: "start",
      payload: "remoteDesktopLease",
      command: remoteDesktopCommand({
        case: "startRemoteDesktop",
        value: create(DevicePeerStartRemoteDesktopActionSchema, {
          displayId: "display-1",
          mode: RemoteDesktopStartMode.NEW
        })
      }, DevicePeerEffectKind.SIDE_EFFECT)
    },
    {
      method: "heartbeat",
      payload: "remoteDesktopControlState",
      command: remoteDesktopCommand({
        case: "heartbeatRemoteDesktop",
        value: create(DevicePeerHeartbeatRemoteDesktopActionSchema, { leaseId: "lease-1" })
      }, DevicePeerEffectKind.SIDE_EFFECT)
    },
    {
      method: "stop",
      payload: "acknowledgement",
      command: remoteDesktopCommand({
        case: "stopRemoteDesktop",
        value: create(DevicePeerStopRemoteDesktopActionSchema, { leaseId: "lease-1" })
      }, DevicePeerEffectKind.SIDE_EFFECT)
    },
    {
      method: "setControl",
      payload: "remoteDesktopControlState",
      command: remoteDesktopCommand({
        case: "setRemoteDesktopControl",
        value: create(DevicePeerSetRemoteDesktopControlActionSchema, { leaseId: "lease-1", enabled: false })
      }, DevicePeerEffectKind.SIDE_EFFECT)
    },
    {
      method: "sendInput",
      payload: "acknowledgement",
      command: remoteDesktopCommand({
        case: "sendRemoteDesktopInput",
        value: create(DevicePeerSendRemoteDesktopInputActionSchema, {
          leaseId: "lease-1",
          sequence: 1n,
          events: [create(RemoteDesktopInputEventSchema, {
            event: {
              case: "move",
              value: create(RemoteDesktopPointerMoveInputSchema, { x: 0.25, y: 0.75 })
            }
          })]
        })
      }, DevicePeerEffectKind.SIDE_EFFECT)
    },
    {
      method: "createOffer",
      payload: "remoteDesktopOffer",
      command: remoteDesktopCommand({
        case: "createRemoteDesktopOffer",
        value: create(DevicePeerCreateRemoteDesktopOfferActionSchema, {
          leaseId: "lease-1",
          attemptId: "attempt-1",
          offerSdp: "v=0\r\n"
        })
      }, DevicePeerEffectKind.SIDE_EFFECT)
    },
    {
      method: "exchangeIce",
      payload: "remoteDesktopIce",
      command: remoteDesktopCommand({
        case: "exchangeRemoteDesktopIce",
        value: create(DevicePeerExchangeRemoteDesktopIceActionSchema, {
          leaseId: "lease-1",
          attemptId: "attempt-1",
          candidates: [remoteDesktopIceCandidate()],
          after: 0
        })
      }, DevicePeerEffectKind.SIDE_EFFECT)
    },
    {
      method: "getFrame",
      payload: "remoteDesktopFrame",
      command: remoteDesktopCommand({
        case: "getRemoteDesktopFrame",
        value: create(DevicePeerGetRemoteDesktopFrameActionSchema, { leaseId: "lease-1" })
      }, DevicePeerEffectKind.READ_ONLY)
    }
  ];
}

function remoteDesktopCommand(
  action: DevicePeerCommand["action"],
  effect: DevicePeerEffectKind
): DevicePeerCommand {
  return create(DevicePeerCommandSchema, {
    capability: DevicePeerCapabilityKind.REMOTE_DESKTOP,
    effect,
    controllerDeviceId: "controller-device",
    action
  });
}

function remoteDesktopIceCandidate() {
  return create(RemoteDesktopIceCandidateSchema, {
    candidate: "candidate:1 1 UDP 2122260223 192.0.2.1 5000 typ host",
    sdpMid: "0",
    sdpMLineIndex: 0,
    usernameFragment: "fragment"
  });
}

class TestProcessHandle extends EventEmitter implements DevicePeerProcessHandle {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 1;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(): boolean {
    this.finish();
    return true;
  }

  finish(): void {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", 0, null);
  }
}

class TestTerminalHandle implements DevicePeerTerminalHandle {
  readonly pid = 2;
  readonly #data = new Set<(data: string) => void>();
  readonly #exit = new Set<(event: DevicePeerTerminalExit) => void>();
  #finished = false;

  onData(listener: (data: string) => void): { dispose(): void } {
    this.#data.add(listener);
    return { dispose: () => { this.#data.delete(listener); } };
  }

  onExit(listener: (event: DevicePeerTerminalExit) => void): { dispose(): void } {
    this.#exit.add(listener);
    return { dispose: () => { this.#exit.delete(listener); } };
  }

  write(): Promise<void> { return Promise.resolve(); }
  resize(): Promise<void> { return Promise.resolve(); }
  pause(): void {}
  resume(): void {}
  kill(): Promise<void> { this.finish(); return Promise.resolve(); }

  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    for (const listener of this.#exit) listener({ exitCode: 0, processExitConfirmed: true });
  }
}
