import { createConnection, createServer } from "node:net";
import { mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  DevicePeerCapabilityKind,
  DevicePeerCommandSchema,
  DevicePeerDirectoryAvailability,
  DevicePeerEffectKind,
  DevicePeerFailureCode,
  DevicePeerLoopbackHost,
  DevicePeerResponsePhase,
  type DevicePeerAgentResult
} from "@joko/contracts";
import type {
  DevicePeerTerminalExit,
  DevicePeerTerminalHandle,
  DevicePeerTerminalTransportPort
} from "@joko/device-peer";
import { DEVICE_PEER_RUNTIME_EXECUTABLES } from "@joko/device-peer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopDevicePeerAgentExecutor } from "./device-peer-agent.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Desktop Device peer agent", () => {
  it("rejects a mismatched capability/effect before acceptance", async () => {
    const root = await temporaryRoot();
    const executor = new DesktopDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "state", "recent.json") });
    const results: DevicePeerAgentResult[] = [];
    await expect(executor.execute(create(DevicePeerCommandSchema, {
      capability: DevicePeerCapabilityKind.FILES,
      effect: DevicePeerEffectKind.SIDE_EFFECT,
      action: { case: "listFiles", value: { path: root } }
    }), new AbortController().signal, (result) => { results.push(result); })).rejects.toMatchObject({
      code: DevicePeerFailureCode.INVALID_REQUEST
    });

    expect(results).toEqual([]);
  });

  it("accepts before a bounded canonical directory effect and preserves strict result sequence", async () => {
    const root = await temporaryRoot();
    const destination = join(root, "project", "nested");
    const executor = new DesktopDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "state", "recent.json") });
    const observed: Array<{ readonly phase: DevicePeerResponsePhase; readonly exists: boolean }> = [];
    const results: DevicePeerAgentResult[] = [];
    await executor.execute(create(DevicePeerCommandSchema, {
      capability: DevicePeerCapabilityKind.FILES,
      effect: DevicePeerEffectKind.SIDE_EFFECT,
      action: { case: "createDirectory", value: { path: destination, recursive: true } }
    }), new AbortController().signal, async (result) => {
      results.push(result);
      observed.push({ phase: result.phase, exists: await stat(destination).then(() => true, () => false) });
    });

    expect(observed).toEqual([
      { phase: DevicePeerResponsePhase.ACCEPTED, exists: false },
      { phase: DevicePeerResponsePhase.COMPLETED, exists: true }
    ]);
    expect(results.map((result) => result.sequence)).toEqual([1n, 2n]);
    expect(results[1]?.payload.case).toBe("directoryCreated");
    if (results[1]?.payload.case === "directoryCreated") {
      expect(results[1].payload.value.path).toBe(await realpath(destination));
    }
  });

  it("owns and revalidates recent directories on the target device", async () => {
    const root = await temporaryRoot();
    const project = join(root, "project-one");
    await mkdir(project);
    const executor = new DesktopDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "state", "recent.json") });
    await executor.recordRecentDirectory(project, "Project one");
    const command = create(DevicePeerCommandSchema, {
      capability: DevicePeerCapabilityKind.FILES,
      effect: DevicePeerEffectKind.READ_ONLY,
      action: { case: "listRecentDirectories", value: { maximumEntries: 10 } }
    });

    const first = await execute(executor, command);
    expect(recentAvailability(first)).toBe(DevicePeerDirectoryAvailability.EXISTS);

    await rm(project, { recursive: true });
    const second = await execute(executor, command);
    expect(recentAvailability(second)).toBe(DevicePeerDirectoryAvailability.MISSING);
  });

  it("maps the bounded local file surface without following an unvalidated path shape", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source.txt");
    const destination = join(root, "destination.txt");
    const executor = new DesktopDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "state", "recent.json") });

    expect((await execute(executor, create(DevicePeerCommandSchema, {
      capability: DevicePeerCapabilityKind.FILES,
      effect: DevicePeerEffectKind.SIDE_EFFECT,
      action: {
        case: "writeFile",
        value: { path: source, content: new TextEncoder().encode("abcdef"), atomic: true }
      }
    }))).at(-1)?.payload.case).toBe("fileMutation");

    const statResults = await execute(executor, create(DevicePeerCommandSchema, {
      capability: DevicePeerCapabilityKind.FILES,
      effect: DevicePeerEffectKind.READ_ONLY,
      action: { case: "statFile", value: { path: source } }
    }));
    const fileStat = statResults.at(-1);
    if (fileStat?.payload.case !== "fileStat") throw new Error("file stat missing");
    expect(fileStat.payload.value.size).toBe(6n);

    const listResults = await execute(executor, create(DevicePeerCommandSchema, {
      capability: DevicePeerCapabilityKind.FILES,
      effect: DevicePeerEffectKind.READ_ONLY,
      action: { case: "listFiles", value: { path: root } }
    }));
    const fileList = listResults.at(-1);
    if (fileList?.payload.case !== "fileList") throw new Error("file list missing");
    expect(fileList.payload.value.entries).toContainEqual(expect.objectContaining({ name: "source.txt" }));

    const refusedRead = await execute(executor, create(DevicePeerCommandSchema, {
      capability: DevicePeerCapabilityKind.FILES,
      effect: DevicePeerEffectKind.READ_ONLY,
      action: { case: "readFile", value: { path: source, maximumBytes: 3n, allowTruncated: false } }
    }));
    expect(refusedRead.at(-1)?.phase).toBe(DevicePeerResponsePhase.FAILED);

    const readResults = await execute(executor, create(DevicePeerCommandSchema, {
      capability: DevicePeerCapabilityKind.FILES,
      effect: DevicePeerEffectKind.READ_ONLY,
      action: { case: "readFile", value: { path: source, maximumBytes: 3n, allowTruncated: true } }
    }));
    const fileRead = readResults.at(-1);
    if (fileRead?.payload.case !== "fileRead") throw new Error("file read missing");
    expect(new TextDecoder().decode(fileRead.payload.value.content)).toBe("abc");
    expect(fileRead.payload.value.truncated).toBe(true);

    await execute(executor, create(DevicePeerCommandSchema, {
      capability: DevicePeerCapabilityKind.FILES,
      effect: DevicePeerEffectKind.SIDE_EFFECT,
      action: { case: "renameFile", value: { sourcePath: source, destinationPath: destination } }
    }));
    const canonicalResults = await execute(executor, create(DevicePeerCommandSchema, {
      capability: DevicePeerCapabilityKind.FILES,
      effect: DevicePeerEffectKind.READ_ONLY,
      action: { case: "realpath", value: { path: destination } }
    }));
    const canonical = canonicalResults.at(-1);
    if (canonical?.payload.case !== "realpath") throw new Error("realpath missing");
    expect(canonical.payload.value.path).toBe(await realpath(destination));

    await execute(executor, create(DevicePeerCommandSchema, {
      capability: DevicePeerCapabilityKind.FILES,
      effect: DevicePeerEffectKind.SIDE_EFFECT,
      action: { case: "removeFile", value: { path: destination, recursive: false } }
    }));
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });

    const unnormalized = `${root}${process.platform === "win32" ? "\\" : "/"}child${process.platform === "win32" ? "\\" : "/"}..`;
    const invalid: DevicePeerAgentResult[] = [];
    await expect(executor.execute(create(DevicePeerCommandSchema, {
      capability: DevicePeerCapabilityKind.FILES,
      effect: DevicePeerEffectKind.READ_ONLY,
      action: { case: "statFile", value: { path: unnormalized } }
    }), new AbortController().signal, (result) => { invalid.push(result); })).rejects.toMatchObject({
      code: DevicePeerFailureCode.INVALID_REQUEST
    });
    expect(invalid).toEqual([]);
  });

  it("streams an admitted local process and terminates with the exact exit", async () => {
    const root = await temporaryRoot();
    const executor = new DesktopDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "state", "recent.json") });
    const results = await execute(executor, create(DevicePeerCommandSchema, {
      capability: DevicePeerCapabilityKind.PROCESS,
      effect: DevicePeerEffectKind.SIDE_EFFECT,
      action: {
        case: "startProcess",
        value: {
          executable: process.execPath,
          arguments: ["-e", "process.stdout.write('peer-output')"],
          workingDirectory: root,
          environment: []
        }
      }
    }));

    expect(results.map((result) => result.phase)).toEqual([
      DevicePeerResponsePhase.ACCEPTED,
      DevicePeerResponsePhase.COMPLETED,
      DevicePeerResponsePhase.STARTED,
      DevicePeerResponsePhase.STARTED
    ]);
    const output = results.find((result) => result.payload.case === "processOutput");
    expect(output?.payload.case).toBe("processOutput");
    if (output?.payload.case === "processOutput") {
      expect(new TextDecoder().decode(output.payload.value.data)).toBe("peer-output");
    }
    const terminal = results.at(-1);
    expect(terminal?.payload.case).toBe("processExited");
    if (terminal?.payload.case === "processExited") {
      expect(terminal.payload.value.exitCode).toBe(0);
    }
    expect(results.map((result) => result.sequence)).toEqual([1n, 2n, 3n, 4n]);
  });

  it("resolves reserved runtime identities without consulting PATH and rejects legacy aliases", async () => {
    const root = await temporaryRoot();
    const executor = new DesktopDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "state", "recent.json"),
      runtimeExecutables: {
        node: {
          executable: process.execPath,
          argumentPrefix: ["-e", "process.stdout.write(process.env.JOKO_PEER_LOCATOR ?? '')"],
          environment: { JOKO_PEER_LOCATOR: "located-node" }
        }
      }
    });
    const located = await execute(executor, create(DevicePeerCommandSchema, {
      capability: DevicePeerCapabilityKind.PROCESS,
      effect: DevicePeerEffectKind.SIDE_EFFECT,
      action: {
        case: "startProcess",
        value: {
          executable: DEVICE_PEER_RUNTIME_EXECUTABLES.node,
          arguments: [],
          workingDirectory: root,
          environment: [{
            name: process.platform === "win32" ? "joko_peer_locator" : "JOKO_PEER_LOCATOR",
            utf8Value: new TextEncoder().encode("untrusted")
          }]
        }
      }
    }));
    const output = located.find((result) => result.payload.case === "processOutput");
    if (output?.payload.case !== "processOutput") throw new Error("located process output missing");
    expect(new TextDecoder().decode(output.payload.value.data)).toBe("located-node");

    const legacy = await execute(executor, create(DevicePeerCommandSchema, {
      capability: DevicePeerCapabilityKind.PROCESS,
      effect: DevicePeerEffectKind.SIDE_EFFECT,
      action: {
        case: "startProcess",
        value: { executable: "node", arguments: [], workingDirectory: root, environment: [] }
      }
    }));
    const failure = legacy.at(-1);
    expect(failure?.payload.case).toBe("failure");
    if (failure?.payload.case === "failure") {
      expect(failure.payload.value.code).toBe(DevicePeerFailureCode.CAPABILITY_UNAVAILABLE);
      expect(failure.payload.value.retryable).toBe(false);
    }
  });

  it("maps PTY stream/control only when the main-process terminal capability exists", async () => {
    const root = await temporaryRoot();
    const terminal = new FakeTerminal();
    const port: DevicePeerTerminalTransportPort = { open: vi.fn(async () => terminal) };
    const executor = new DesktopDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "state", "recent.json"),
      terminals: port
    });
    expect(executor.capabilities).toContain(DevicePeerCapabilityKind.TERMINAL);
    let terminalId = "";
    let resolveOpened!: () => void;
    const opened = new Promise<void>((resolvePromise) => { resolveOpened = resolvePromise; });
    const openResults: DevicePeerAgentResult[] = [];
    const pending = executor.execute(create(DevicePeerCommandSchema, {
      capability: DevicePeerCapabilityKind.TERMINAL,
      effect: DevicePeerEffectKind.SIDE_EFFECT,
      action: {
        case: "openTerminal",
        value: { executable: process.execPath, arguments: [], workingDirectory: root, columns: 80, rows: 24 }
      }
    }), new AbortController().signal, (result) => {
      openResults.push(result);
      if (result.payload.case === "terminalOpened") {
        terminalId = result.payload.value.terminalId;
        resolveOpened();
      }
    });
    await opened;
    const writeResults = await execute(executor, create(DevicePeerCommandSchema, {
      capability: DevicePeerCapabilityKind.TERMINAL,
      effect: DevicePeerEffectKind.SIDE_EFFECT,
      action: { case: "writeTerminal", value: { terminalId, data: new TextEncoder().encode("typed") } }
    }));
    terminal.emitData("terminal-output");
    terminal.emitExit({ exitCode: 0, processExitConfirmed: true });
    await pending;

    expect(terminal.write).toHaveBeenCalledWith("typed");
    expect(writeResults.at(-1)?.payload.case).toBe("acknowledgement");
    expect(openResults.map((result) => result.payload.case)).toEqual([
      "acknowledgement", "terminalOpened", "terminalOutput", "terminalExited"
    ]);
  });

  it("opens only an enum-representable target loopback forward and streams its closure", async () => {
    const root = await temporaryRoot();
    const server = createServer((socket) => socket.end("loopback-data"));
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test listener unavailable");
    const executor = new DesktopDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "state", "recent.json") });
    try {
      const results = await execute(executor, create(DevicePeerCommandSchema, {
        capability: DevicePeerCapabilityKind.FORWARDING,
        effect: DevicePeerEffectKind.SIDE_EFFECT,
        action: {
          case: "openLoopbackForward",
          value: { destinationHost: DevicePeerLoopbackHost.IPV4, destinationPort: address.port }
        }
      }));
      expect(results.map((result) => result.payload.case)).toEqual([
        "acknowledgement", "loopbackForwardOpened", "loopbackForwardData", "loopbackForwardClosed"
      ]);
      const data = results.find((result) => result.payload.case === "loopbackForwardData");
      if (data?.payload.case !== "loopbackForwardData") throw new Error("forward data missing");
      expect(new TextDecoder().decode(data.payload.value.data)).toBe("loopback-data");
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("multiplexes reverse listener connections by listener and connection identity", async () => {
    const root = await temporaryRoot();
    const executor = new DesktopDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "state", "recent.json") });
    const listenResults: DevicePeerAgentResult[] = [];
    let resolveListener!: (value: { readonly id: string; readonly port: number }) => void;
    let resolveConnection!: (value: string) => void;
    let resolvePeerData!: (value: string) => void;
    const listenerOpened = new Promise<{ readonly id: string; readonly port: number }>((resolvePromise) => {
      resolveListener = resolvePromise;
    });
    const connectionOpened = new Promise<string>((resolvePromise) => { resolveConnection = resolvePromise; });
    const peerData = new Promise<string>((resolvePromise) => { resolvePeerData = resolvePromise; });
    const listenPending = executor.execute(create(DevicePeerCommandSchema, {
      capability: DevicePeerCapabilityKind.FORWARDING,
      effect: DevicePeerEffectKind.SIDE_EFFECT,
      action: {
        case: "listenLoopbackForward",
        value: {
          serviceDestinationHost: DevicePeerLoopbackHost.IPV4,
          serviceDestinationPort: 65_535,
          peerListenHost: DevicePeerLoopbackHost.IPV4,
          peerListenPort: 0
        }
      }
    }), new AbortController().signal, (result) => {
      listenResults.push(result);
      if (result.payload.case === "loopbackListenerOpened") {
        resolveListener({ id: result.payload.value.listenerId, port: result.payload.value.peerListenPort });
      } else if (result.payload.case === "reverseForwardConnectionOpened") {
        resolveConnection(result.payload.value.connectionId);
      } else if (result.payload.case === "reverseForwardData") {
        resolvePeerData(new TextDecoder().decode(result.payload.value.data));
      }
    });

    const listener = await listenerOpened;
    const client = createConnection({ host: "127.0.0.1", port: listener.port });
    await new Promise<void>((resolveConnect, rejectConnect) => {
      client.once("connect", resolveConnect);
      client.once("error", rejectConnect);
    });
    const connectionId = await connectionOpened;
    client.write("from-peer");
    expect(await peerData).toBe("from-peer");

    const controllerData = new Promise<string>((resolveData) => {
      client.once("data", (data) => resolveData(data.toString("utf8")));
    });
    await execute(executor, create(DevicePeerCommandSchema, {
      capability: DevicePeerCapabilityKind.FORWARDING,
      effect: DevicePeerEffectKind.SIDE_EFFECT,
      action: {
        case: "writeReverseForward",
        value: {
          listenerId: listener.id,
          connectionId,
          data: new TextEncoder().encode("from-controller"),
          closeWrite: false
        }
      }
    }));
    expect(await controllerData).toBe("from-controller");

    await execute(executor, create(DevicePeerCommandSchema, {
      capability: DevicePeerCapabilityKind.FORWARDING,
      effect: DevicePeerEffectKind.SIDE_EFFECT,
      action: { case: "closeReverseForwardConnection", value: { listenerId: listener.id, connectionId } }
    }));
    client.destroy();
    await execute(executor, create(DevicePeerCommandSchema, {
      capability: DevicePeerCapabilityKind.FORWARDING,
      effect: DevicePeerEffectKind.SIDE_EFFECT,
      action: { case: "closeLoopbackListener", value: { listenerId: listener.id } }
    }));
    await listenPending;

    expect(listenResults.map((result) => result.payload.case)).toEqual([
      "acknowledgement",
      "loopbackListenerOpened",
      "reverseForwardConnectionOpened",
      "reverseForwardData",
      "reverseForwardConnectionClosed",
      "loopbackListenerClosed"
    ]);
    expect(listenResults.map((result) => result.sequence)).toEqual([1n, 2n, 3n, 4n, 5n, 6n]);
  });
});

class FakeTerminal implements DevicePeerTerminalHandle {
  readonly write = vi.fn(async (_data: string) => undefined);
  readonly resize = vi.fn(async (_columns: number, _rows: number) => undefined);
  readonly kill = vi.fn(async () => undefined);
  readonly pause = vi.fn();
  readonly resume = vi.fn();
  readonly #data = new Set<(data: string) => void>();
  readonly #exit = new Set<(event: DevicePeerTerminalExit) => void>();

  onData(listener: (data: string) => void): { dispose(): void } {
    this.#data.add(listener);
    return { dispose: () => { this.#data.delete(listener); } };
  }

  onExit(listener: (event: DevicePeerTerminalExit) => void): { dispose(): void } {
    this.#exit.add(listener);
    return { dispose: () => { this.#exit.delete(listener); } };
  }

  emitData(data: string): void { for (const listener of this.#data) listener(data); }
  emitExit(event: DevicePeerTerminalExit): void { for (const listener of this.#exit) listener(event); }
}

async function temporaryRoot(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "joko-device-peer-agent-")));
  roots.push(path);
  return path;
}

async function execute(
  executor: DesktopDevicePeerAgentExecutor,
  command: Parameters<DesktopDevicePeerAgentExecutor["execute"]>[0]
): Promise<DevicePeerAgentResult[]> {
  const results: DevicePeerAgentResult[] = [];
  await executor.execute(command, new AbortController().signal, (result) => { results.push(result); });
  return results;
}

function recentAvailability(results: readonly DevicePeerAgentResult[]): DevicePeerDirectoryAvailability | undefined {
  const completed = results.at(-1);
  return completed?.payload.case === "recentDirectories"
    ? completed.payload.value.directories[0]?.availability
    : undefined;
}
