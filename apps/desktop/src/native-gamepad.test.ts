import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createNativeGamepadRuntime,
  parseNativeGamepadHelperLine,
  resolveNativeGamepadDirectory,
  verifyNativeGamepadHelper
} from "./native-gamepad.js";

const directories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("native gamepad helper protocol", () => {
  it("resolves development and packaged helper roots without crossing resource boundaries", () => {
    const resourcesPath = join(tmpdir(), "packaged", "resources");
    const developmentSource = join(tmpdir(), "workspace", "apps", "desktop", "dist");
    expect(resolveNativeGamepadDirectory({
      packaged: false,
      resourcesPath,
      sourceDirectory: developmentSource
    })).toBe(join(developmentSource, "native-gamepad"));
    expect(resolveNativeGamepadDirectory({
      packaged: true,
      resourcesPath,
      sourceDirectory: join(resourcesPath, "app", "dist")
    })).toBe(join(resourcesPath, "native-gamepad"));
  });

  it("requires exact messages and projects GameController input into Browser Gamepad order", () => {
    const frame = parseNativeGamepadHelperLine(JSON.stringify(helperFrame({
      axes: { lx: 0.25, ly: 0.5, rx: -0.75, ry: -1 },
      ltAnalog: 0.4,
      rtAnalog: 0.8
    })));
    expect(frame).toEqual({
      kind: "frame",
      family: "xbox",
      buttons: [1, 0, 0, 0, 0, 1, 0.4, 0.8, 0, 1, 0, 0, 1, 0, 0, 1, 0],
      axes: [0.25, -0.5, -0.75, 1]
    });
    expect(Object.isFrozen(frame)).toBe(true);
    if (frame?.kind !== "frame") throw new Error("Expected a frame.");
    expect(Object.isFrozen(frame.buttons)).toBe(true);
    expect(Object.isFrozen(frame.axes)).toBe(true);

    expect(parseNativeGamepadHelperLine(JSON.stringify({ ...helperFrame(), extra: true }))).toBeUndefined();
    expect(parseNativeGamepadHelperLine(JSON.stringify(helperFrame({ axes: { lx: 2, ly: 0, rx: 0, ry: 0 } })))).toBeUndefined();
    expect(parseNativeGamepadHelperLine(JSON.stringify({ kind: "presence", present: false, family: "xbox" })))
      .toEqual({
        kind: "presence", present: false, family: "xbox", name: null, category: null,
        transport: "unknown", batteryPercentage: null, batteryState: "unknown"
      });
    expect(parseNativeGamepadHelperLine("not-json")).toBeUndefined();
    expect(parseNativeGamepadHelperLine("x".repeat(65 * 1024))).toBeUndefined();
  });

  it("admits only the exact current helper manifest and SHA-256", () => {
    const directory = artifact();
    expect(verifyNativeGamepadHelper({ directory, platform: "darwin", architecture: "arm64" }))
      .toBe(join(directory, "joko-macos-gamepad-helper"));
    expect(verifyNativeGamepadHelper({ directory, platform: "win32", architecture: "arm64" })).toBeUndefined();
    expect(verifyNativeGamepadHelper({ directory, platform: "darwin", architecture: "ia32" })).toBeUndefined();

    const wrongCpuDirectory = artifact();
    const wrongCpuBytes = readHelper(wrongCpuDirectory);
    writeFileSync(join(wrongCpuDirectory, "manifest.json"), JSON.stringify({
      architecture: "x64",
      helper: "joko-macos-gamepad-helper",
      platform: "darwin",
      protocolVersion: 1,
      sha256: createHash("sha256").update(wrongCpuBytes).digest("hex")
    }));
    expect(verifyNativeGamepadHelper({
      directory: wrongCpuDirectory, platform: "darwin", architecture: "x64"
    })).toBeUndefined();

    if (process.platform !== "win32") {
      const nonExecutableDirectory = artifact();
      chmodSync(join(nonExecutableDirectory, "joko-macos-gamepad-helper"), 0o644);
      expect(verifyNativeGamepadHelper({
        directory: nonExecutableDirectory, platform: "darwin", architecture: "arm64"
      })).toBeUndefined();
    }

    writeFileSync(join(directory, "manifest.json"), JSON.stringify({
      architecture: "arm64",
      helper: "joko-macos-gamepad-helper",
      platform: "darwin",
      protocolVersion: 1,
      sha256: "0".repeat(64)
    }));
    expect(verifyNativeGamepadHelper({ directory, platform: "darwin", architecture: "arm64" })).toBeUndefined();
  });
});

describe("native gamepad runtime", () => {
  it("aggregates ephemeral client interest, streams strict snapshots and stops the helper boundedly", () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const snapshots: unknown[] = [];
    const runtime = createNativeGamepadRuntime<string>({
      platform: "darwin",
      architecture: "arm64",
      directory: artifact(),
      spawnProcess: () => child.process,
      onSnapshot: (snapshot) => snapshots.push(snapshot)
    });
    expect(runtime.snapshot()).toEqual({ version: 1, revision: 0, status: "idle", devices: [] });
    expect(runtime.probe().status).toBe("idle");

    expect(runtime.setClientState("input", { version: 1, enabled: true, preview: false }).status).toBe("waiting");
    expect(child.input).toBe("switch2-usb on\n");
    runtime.setClientState("preview", { version: 1, enabled: false, preview: true });
    child.output({
      kind: "presence",
      present: true,
      family: "xbox",
      name: "Wireless Controller",
      category: "Xbox",
      transport: "bluetooth",
      batteryPercentage: 75,
      batteryState: "discharging"
    });
    child.output(helperFrame());
    expect(runtime.snapshot()).toMatchObject({
      version: 1,
      status: "connected",
      devices: [{
        family: "xbox",
        name: "Wireless Controller",
        category: "Xbox",
        transport: "bluetooth",
        batteryPercentage: 75,
        batteryState: "discharging",
        axes: [0, 0, 0, 0]
      }]
    });
    expect(runtime.snapshot().devices[0]?.buttons).toHaveLength(17);
    expect(Object.isFrozen(runtime.snapshot())).toBe(true);
    expect(Object.isFrozen(runtime.snapshot().devices)).toBe(true);

    child.output({ kind: "presence", present: false, family: "xbox" });
    expect(runtime.snapshot()).toMatchObject({ status: "waiting", devices: [] });
    child.output({
      kind: "presence",
      present: true,
      family: "xbox",
      name: "Replacement Controller",
      category: "Xbox",
      transport: "usb",
      batteryState: "unknown"
    });
    expect(runtime.snapshot().devices[0]).toMatchObject({
      name: "Replacement Controller",
      buttons: Array<number>(17).fill(0),
      axes: Array<number>(4).fill(0)
    });

    runtime.retireClient("input");
    expect(runtime.snapshot().status).toBe("connected");
    runtime.retireClient("preview");
    expect(runtime.snapshot().status).toBe("idle");
    expect(child.input).toContain("switch2-usb off\nstop\n");
    expect(child.killed).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(child.killed).toBe(true);
    expect(snapshots.length).toBeGreaterThanOrEqual(4);
  });

  it("fails closed on malformed output and bounds automatic restart attempts", () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const runtime = createNativeGamepadRuntime<string>({
      platform: "darwin",
      architecture: "arm64",
      directory: artifact(),
      spawnProcess: () => {
        const child = new FakeChild();
        children.push(child);
        return child.process;
      }
    });
    runtime.setClientState("client", { version: 1, enabled: true, preview: false });
    expect(children).toHaveLength(1);
    children[0]!.stdout.write('{"kind":"frame"}\n');
    expect(runtime.snapshot().status).toBe("error");

    for (const delay of [1_000, 2_000, 4_000]) {
      vi.advanceTimersByTime(delay);
      const current = children.at(-1)!;
      expect(runtime.snapshot().status).toBe("waiting");
      current.crash();
      expect(runtime.snapshot().status).toBe("error");
    }
    expect(children).toHaveLength(4);
    vi.advanceTimersByTime(60_000);
    expect(children).toHaveLength(4);

    runtime.probe();
    expect(children).toHaveLength(5);
    expect(runtime.snapshot().status).toBe("waiting");
    children[4]!.stderr.emit("error", new Error("stderr failed"));
    expect(runtime.snapshot().status).toBe("error");
  });

  it("fences every late event from a stopped helper generation", () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const runtime = createNativeGamepadRuntime<string>({
      platform: "darwin",
      architecture: "arm64",
      directory: artifact(),
      spawnProcess: () => {
        const child = new FakeChild();
        children.push(child);
        return child.process;
      }
    });
    runtime.setClientState("client", { version: 1, enabled: true, preview: false });
    const retired = children[0]!;
    runtime.setClientState("client", { version: 1, enabled: false, preview: false });
    runtime.setClientState("client", { version: 1, enabled: true, preview: false });
    expect(children).toHaveLength(1);
    expect(runtime.snapshot().status).toBe("starting");

    retired.crash();
    expect(children).toHaveLength(2);
    expect(runtime.snapshot().status).toBe("waiting");
    retired.stdout.write('{"kind":"frame"}\n');
    retired.stdout.emit("error", new Error("late stdout failure"));
    retired.stderr.emit("error", new Error("late stderr failure"));
    retired.emit("error", new Error("late child failure"));
    vi.advanceTimersByTime(5_000);
    expect(children).toHaveLength(2);
    expect(runtime.snapshot().status).toBe("waiting");
  });

  it("does not restart after a helper failure until the failed child has actually retired", () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const runtime = createNativeGamepadRuntime<string>({
      platform: "darwin",
      architecture: "arm64",
      directory: artifact(),
      spawnProcess: () => {
        const child = new FakeChild(children.length !== 0);
        children.push(child);
        return child.process;
      }
    });
    runtime.setClientState("client", { version: 1, enabled: true, preview: false });
    const failed = children[0]!;
    failed.stdout.emit("error", new Error("stdout failed"));
    expect(runtime.snapshot().status).toBe("error");
    expect(failed.killed).toBe(true);
    expect(() => failed.stdout.emit("error", new Error("late stdout failure"))).not.toThrow();
    expect(() => failed.stderr.emit("error", new Error("late stderr failure"))).not.toThrow();
    expect(() => failed.stdin.emit("error", new Error("late stdin failure"))).not.toThrow();
    expect(() => failed.emit("error", new Error("late child failure"))).not.toThrow();

    vi.advanceTimersByTime(1_000);
    expect(children).toHaveLength(1);
    expect(runtime.snapshot().status).toBe("starting");

    failed.crash();
    expect(children).toHaveLength(2);
    expect(runtime.snapshot().status).toBe("waiting");
  });

  it("awaits confirmed helper retirement and shares the terminal dispose barrier", async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
    const runtime = createNativeGamepadRuntime<string>({
      platform: "darwin",
      architecture: "arm64",
      directory: artifact(),
      spawnProcess: () => child.process
    });
    runtime.setClientState("client", { version: 1, enabled: true, preview: false });

    let settled = false;
    const first = runtime.dispose();
    const second = runtime.dispose();
    void first.finally(() => { settled = true; });

    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.killed).toBe(true);
    expect(settled).toBe(false);

    child.crash();
    await expect(first).resolves.toBeUndefined();
    expect(settled).toBe(true);
    expect(() => child.emit("close", 1, null)).not.toThrow();
  });

  it("rejects complete retirement when SIGKILL is never confirmed", async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
    const runtime = createNativeGamepadRuntime<string>({
      platform: "darwin",
      architecture: "arm64",
      directory: artifact(),
      spawnProcess: () => child.process
    });
    runtime.setClientState("client", { version: 1, enabled: true, preview: false });

    const disposal = runtime.dispose();
    const rejection = expect(disposal).rejects.toThrow(/did not confirm exit after SIGKILL/u);
    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;
  });

  it("recovers retained client interest after an aborted complete exit without overlapping helpers", async () => {
    const children: FakeChild[] = [];
    const runtime = createNativeGamepadRuntime<string>({
      platform: "darwin",
      architecture: "arm64",
      directory: artifact(),
      spawnProcess: () => {
        const child = new FakeChild(false);
        children.push(child);
        return child.process;
      }
    });
    runtime.setClientState("client", { version: 1, enabled: true, preview: false });
    const retiring = children[0]!;

    const stopped = runtime.stop();
    runtime.recover();
    expect(children).toHaveLength(1);
    expect(runtime.snapshot().status).toBe("starting");

    retiring.crash();
    await expect(stopped).resolves.toBeUndefined();
    expect(children).toHaveLength(2);
    expect(runtime.snapshot().status).toBe("waiting");
  });

  it("reports unavailable without spawning outside admitted macOS artifacts", () => {
    const spawnProcess = vi.fn();
    const runtime = createNativeGamepadRuntime<string>({
      platform: "win32",
      architecture: "x64",
      directory: join(tmpdir(), "missing-native-gamepad"),
      spawnProcess
    });
    expect(runtime.snapshot()).toEqual({ version: 1, revision: 0, status: "unavailable", devices: [] });
    expect(runtime.setClientState("client", { version: 1, enabled: true, preview: true }).status)
      .toBe("unavailable");
    runtime.probe();
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  input = "";

  constructor(private readonly exitWhenKilled = true) {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string | Buffer) => { this.input += chunk.toString(); });
  }

  get process(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    if (this.exitWhenKilled) this.emit("exit", null, "SIGTERM");
    return true;
  }

  crash(): void {
    this.emit("exit", 1, null);
  }

  output(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }
}

function artifact(): string {
  const directory = mkdtempSync(join(tmpdir(), "joko-native-gamepad-"));
  directories.push(directory);
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeed_facf, 0);
  bytes.writeUInt32LE(0x0100_000c, 4);
  bytes.writeUInt32LE(0, 8);
  bytes.writeUInt32LE(2, 12);
  bytes.writeUInt32LE(0, 16);
  bytes.writeUInt32LE(0, 20);
  const helper = join(directory, "joko-macos-gamepad-helper");
  writeFileSync(helper, bytes);
  chmodSync(helper, 0o755);
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({
    architecture: "arm64",
    helper: "joko-macos-gamepad-helper",
    platform: "darwin",
    protocolVersion: 1,
    sha256: createHash("sha256").update(bytes).digest("hex")
  }));
  return directory;
}

function readHelper(directory: string): Buffer {
  return readFileSync(join(directory, "joko-macos-gamepad-helper"));
}

function helperFrame(overrides: {
  readonly axes?: { readonly lx: number; readonly ly: number; readonly rx: number; readonly ry: number };
  readonly ltAnalog?: number;
  readonly rtAnalog?: number;
} = {}): Record<string, unknown> {
  return {
    kind: "frame",
    family: "xbox",
    buttons: {
      a: true, b: false, x: false, y: false, lb: false, rb: true, lt: false, rt: true,
      view: false, menu: true, xbox: false, ls: false, rs: false,
      dpadUp: true, dpadDown: false, dpadLeft: false, dpadRight: true
    },
    axes: overrides.axes ?? { lx: 0, ly: 0, rx: 0, ry: 0 },
    ltAnalog: overrides.ltAnalog ?? 0,
    rtAnalog: overrides.rtAnalog ?? 1
  };
}
