import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  BoundedCommandRunner,
  safeComputerEnvironment,
  type ComputerSpawn
} from "./process-runner.js";

describe("BoundedCommandRunner", () => {
  it("spawns without a shell, hides Windows children, strips credential environment, and bounds output", async () => {
    const child = new FakeChild();
    let observed: { readonly command: string; readonly arguments: readonly string[]; readonly options: SpawnOptions } | undefined;
    const spawn: ComputerSpawn = (command, arguments_, options) => {
      observed = { command, arguments: arguments_, options };
      queueMicrotask(() => {
        child.emit("spawn");
        child.stdout.write("abcdefgh");
        child.stderr.write("123456");
        child.emit("close", 0, null);
      });
      return child as unknown as ChildProcess;
    };
    const onSpawn = vi.fn();
    const runner = new BoundedCommandRunner({
      platform: "win32",
      environment: {
        PATH: "C:\\tools",
        SYSTEMROOT: "C:\\Windows",
        OPENAI_API_KEY: "must-not-be-inherited"
      },
      spawn,
      maximumStdoutBytes: 5,
      maximumStderrBytes: 4
    });

    const result = await runner.run({
      command: "program.exe",
      arguments: ["status"],
      timeoutMs: 1_000,
      onSpawn
    });

    expect(observed).toMatchObject({
      command: "program.exe",
      arguments: ["status"],
      options: {
        shell: false,
        windowsHide: true,
        env: { PATH: "C:\\tools", SYSTEMROOT: "C:\\Windows" }
      }
    });
    expect((observed?.options.env as NodeJS.ProcessEnv | undefined)?.OPENAI_API_KEY).toBeUndefined();
    expect(onSpawn).toHaveBeenCalledWith(4242);
    expect(result).toMatchObject({
      stdout: "abcde",
      stderr: "1234",
      stdoutTruncated: true,
      stderrTruncated: true,
      exitCode: 0
    });
  });

  it("kills a timed-out child and returns only bounded partial output", async () => {
    const child = new FakeChild();
    const runner = new BoundedCommandRunner({
      spawn: () => {
        queueMicrotask(() => {
          child.emit("spawn");
          child.stdout.write("partial");
        });
        return child as unknown as ChildProcess;
      },
      maximumStdoutBytes: 4
    });

    await expect(runner.run({ command: "program", timeoutMs: 15 })).rejects.toMatchObject({
      name: "ComputerProcessError",
      kind: "timeout",
      result: { stdout: "part", stdoutTruncated: true }
    });
    expect(child.killed).toBe(true);
  });

  it("fails on installer inactivity before the independent hard cap", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const runner = new BoundedCommandRunner({
        spawn: () => {
          queueMicrotask(() => child.emit("spawn"));
          return child as unknown as ChildProcess;
        }
      });

      const pending = runner.run({
        command: "installer",
        timeoutMs: 5_000,
        idleTimeoutMs: 1_000
      });
      const rejected = expect(pending).rejects.toMatchObject({
        name: "ComputerProcessError",
        kind: "idle_timeout"
      });
      await vi.advanceTimersByTimeAsync(1_001);
      await rejected;
      expect(child.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats changing process-tree or file fingerprints as installer activity", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      let spawnOptions: SpawnOptions | undefined;
      let sample = 0;
      const onProcessActivity = vi.fn();
      const runner = new BoundedCommandRunner({
        platform: "linux",
        spawn: (_command, _arguments, options) => {
          spawnOptions = options;
          queueMicrotask(() => child.emit("spawn"));
          return child as unknown as ChildProcess;
        }
      });

      const pending = runner.run({
        command: "installer",
        timeoutMs: 5_000,
        idleTimeoutMs: 1_000,
        activityPollMs: 100,
        killProcessTree: true,
        sampleProcessActivity: async () => ({ fingerprint: String(sample += 1) }),
        onProcessActivity
      });
      await vi.advanceTimersByTimeAsync(2_500);
      child.emit("close", 0, null);

      await expect(pending).resolves.toMatchObject({ exitCode: 0 });
      expect(onProcessActivity).toHaveBeenCalled();
      expect(spawnOptions?.detached).toBe(true);
      expect(child.killed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors AbortSignal before and after spawn", async () => {
    const spawn = vi.fn<ComputerSpawn>();
    const before = new AbortController();
    before.abort();
    const runner = new BoundedCommandRunner({ spawn });
    await expect(runner.run({ command: "program", timeoutMs: 1_000, signal: before.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(spawn).not.toHaveBeenCalled();

    const child = new FakeChild();
    spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcess;
    });
    const during = new AbortController();
    const request = runner.run({ command: "program", timeoutMs: 1_000, signal: during.signal });
    during.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(child.killed).toBe(true);
  });

  it("allows only a validated pinned driver version as explicit installer environment", async () => {
    const child = new FakeChild();
    let environment: NodeJS.ProcessEnv | undefined;
    const runner = new BoundedCommandRunner({
      platform: "linux",
      environment: { PATH: "/bin", PRIVATE_TOKEN: "never" },
      spawn: (_command, _arguments, options) => {
        environment = options.env as NodeJS.ProcessEnv;
        queueMicrotask(() => child.emit("close", 0, null));
        return child as unknown as ChildProcess;
      }
    });

    await runner.run({
      command: "installer",
      timeoutMs: 1_000,
      extraEnvironment: { CUA_DRIVER_RS_VERSION: "1.2.3" }
    });
    expect(environment).toEqual({ PATH: "/bin", CUA_DRIVER_RS_VERSION: "1.2.3" });
    expect(() => runner.run({
      command: "installer",
      timeoutMs: 1_000,
      extraEnvironment: { PRIVATE_TOKEN: "never" }
    })).toThrow(/extra environment/u);
  });
});

describe("safeComputerEnvironment", () => {
  it("uses a fixed platform allowlist", () => {
    expect(safeComputerEnvironment({
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      DISPLAY: ":0",
      HOME: "/home/joko",
      PATH: "/bin",
      SHELL: "() { unsafe; }",
      WAYLAND_DISPLAY: "wayland-0",
      XAUTHORITY: "/home/joko/.Xauthority",
      XDG_RUNTIME_DIR: "/run/user/1000",
      XDG_SESSION_TYPE: "wayland",
      AWS_SECRET_ACCESS_KEY: "secret",
      HTTPS_PROXY: "https://credential@example.test"
    }, "linux")).toEqual({
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      DISPLAY: ":0",
      HOME: "/home/joko",
      PATH: "/bin",
      WAYLAND_DISPLAY: "wayland-0",
      XAUTHORITY: "/home/joko/.Xauthority",
      XDG_RUNTIME_DIR: "/run/user/1000",
      XDG_SESSION_TYPE: "wayland"
    });
  });
});

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = 4242;
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}
