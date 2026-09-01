import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  AndroidProcessError,
  BoundedAndroidCommandRunner,
  safeAndroidEnvironment,
  type AndroidSpawn
} from "./process-runner.js";

describe("BoundedAndroidCommandRunner", () => {
  it("never invokes a shell, hides Windows children, and strips credential environment", async () => {
    const child = new FakeChild();
    let observed: {
      readonly command: string;
      readonly arguments: readonly string[];
      readonly options: SpawnOptions;
    } | undefined;
    const spawn: AndroidSpawn = (command, arguments_, options) => {
      observed = { command, arguments: arguments_, options };
      queueMicrotask(() => {
        child.emit("spawn");
        child.stdout.write("Android Debug Bridge\n");
        child.stderr.write("token=do-not-return\n");
        child.emit("close", 0, null);
      });
      return child as unknown as ChildProcess;
    };
    const onSpawn = vi.fn();
    const runner = new BoundedAndroidCommandRunner({
      platform: "win32",
      environment: {
        PATH: "C:\\tools",
        SYSTEMROOT: "C:\\Windows",
        ANDROID_ADB_SERVER_PORT: "6040",
        OPENAI_API_KEY: "not-inherited",
        ADB_VENDOR_KEYS: "not-inherited"
      },
      spawn
    });

    const result = await runner.run({
      command: "adb.exe",
      arguments: ["version"],
      timeoutMs: 1_000,
      onSpawn
    });

    expect(observed).toMatchObject({
      command: "adb.exe",
      arguments: ["version"],
      options: {
        shell: false,
        windowsHide: true,
        env: {
          PATH: "C:\\tools",
          SYSTEMROOT: "C:\\Windows",
          ANDROID_ADB_SERVER_PORT: "6040"
        }
      }
    });
    expect((observed?.options.env as NodeJS.ProcessEnv | undefined)?.OPENAI_API_KEY).toBeUndefined();
    expect((observed?.options.env as NodeJS.ProcessEnv | undefined)?.ADB_VENDOR_KEYS).toBeUndefined();
    expect(onSpawn).toHaveBeenCalledWith(731);
    expect(result.stdout).toBe("Android Debug Bridge\n");
    expect(result.stderr).toBe("token=[REDACTED]\n");
  });

  it("bounds text and preserves only explicitly requested binary bytes", async () => {
    const textChild = new FakeChild();
    const binaryChild = new FakeChild();
    const spawn = vi.fn<AndroidSpawn>()
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          textChild.stdout.end("abcdefgh");
          textChild.stderr.end("123456");
          textChild.emit("close", 0, null);
        });
        return textChild as unknown as ChildProcess;
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          binaryChild.stdout.end(Buffer.from([0x89, 0x50, 0x00, 0xff]));
          binaryChild.emit("close", 0, null);
        });
        return binaryChild as unknown as ChildProcess;
      });
    const runner = new BoundedAndroidCommandRunner({
      spawn,
      maximumStdoutBytes: 5,
      maximumStderrBytes: 4
    });

    await expect(runner.run({ command: "adb", timeoutMs: 1_000 })).resolves.toMatchObject({
      stdout: "abcde",
      stderr: "1234",
      stdoutTruncated: true,
      stderrTruncated: true
    });
    const binary = await runner.run({ command: "adb", timeoutMs: 1_000, stdoutMode: "binary" });
    expect(binary.stdout).toBe("");
    expect(binary.stdoutBuffer).toEqual(Buffer.from([0x89, 0x50, 0x00, 0xff]));
  });

  it("kills timed-out and aborted children", async () => {
    const timedOut = new FakeChild();
    const aborted = new FakeChild();
    const spawn = vi.fn<AndroidSpawn>()
      .mockReturnValueOnce(timedOut as unknown as ChildProcess)
      .mockReturnValueOnce(aborted as unknown as ChildProcess);
    const runner = new BoundedAndroidCommandRunner({ spawn });

    await expect(runner.run({ command: "adb", timeoutMs: 10 })).rejects.toMatchObject({
      name: "AndroidProcessError",
      kind: "timeout"
    });
    expect(timedOut.killed).toBe(true);

    const controller = new AbortController();
    const pending = runner.run({ command: "adb", timeoutMs: 1_000, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(aborted.killed).toBe(true);
  });

  it("rejects invalid requests before spawning", () => {
    const runner = new BoundedAndroidCommandRunner({ spawn: vi.fn<AndroidSpawn>() });
    expect(() => runner.run({ command: "", timeoutMs: 1 })).toThrow(TypeError);
    expect(() => runner.run({ command: "adb", arguments: ["bad\0arg"], timeoutMs: 1 })).toThrow(TypeError);
    expect(() => runner.run({ command: "adb", timeoutMs: 0 })).toThrow(RangeError);
  });

  it("turns synchronous spawn failures into typed errors", async () => {
    const runner = new BoundedAndroidCommandRunner({
      spawn: () => {
        throw new Error("missing");
      }
    });
    await expect(runner.run({ command: "adb", timeoutMs: 1_000 })).rejects.toBeInstanceOf(AndroidProcessError);
  });
});

describe("safeAndroidEnvironment", () => {
  it("uses a fixed POSIX allowlist", () => {
    expect(safeAndroidEnvironment({
      HOME: "/home/person",
      PATH: "/bin",
      ANDROID_ADB_SERVER_PORT: "6040",
      AWS_SECRET_ACCESS_KEY: "secret",
      HTTPS_PROXY: "https://person:secret@example.test",
      ADB_VENDOR_KEYS: "/private/key"
    }, "linux")).toEqual({
      HOME: "/home/person",
      PATH: "/bin",
      ANDROID_ADB_SERVER_PORT: "6040"
    });
    expect(safeAndroidEnvironment({ ANDROID_ADB_SERVER_PORT: "invalid" }, "linux"))
      .toEqual({});
  });
});

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = 731;
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}
