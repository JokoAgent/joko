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
  DevicePeerEffectKind,
  DevicePeerListRecentDirectoriesActionSchema,
  DevicePeerOpenTerminalActionSchema,
  DevicePeerRealpathActionSchema,
  DevicePeerResponsePhase,
  DevicePeerStartProcessActionSchema
} from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  NodeDevicePeerAgentExecutor,
  type NodeDevicePeerAgentEmission
} from "./node-agent-executor.js";
import type {
  DevicePeerProcessHandle,
  DevicePeerProcessTransportPort,
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
