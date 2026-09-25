import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { MacSimulatorNativeH264Runtime } from "./native-h264-runtime.js";

const identity = { simulatorUdid: "11111111-2222-3333-4444-555555555555", generation: 7 };
const profile = { framesPerSecond: 20, scalingPercent: 70, orientation: "PORTRAIT" } as const;

function encodedFrame(): Uint8Array {
  const metadata = new TextEncoder().encode(JSON.stringify({ sequence: 1, width: 16,
    height: 12, timestampMicros: 1_000, keyFrame: true, format: "annex-b" }));
  const bytes = new Uint8Array([0, 0, 0, 1, 0x65, 0x88]);
  const length = 2 + metadata.byteLength + bytes.byteLength;
  const result = new Uint8Array(4 + length);
  result[0] = length & 0xff;
  result[1] = length >> 8 & 0xff;
  result[2] = length >> 16 & 0xff;
  result[3] = length >> 24 & 0xff;
  result[4] = metadata.byteLength & 0xff;
  result[5] = metadata.byteLength >> 8 & 0xff;
  result.set(metadata, 6);
  result.set(bytes, 6 + metadata.byteLength);
  return result;
}

function fakeProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = vi.fn(() => { child.stdout.end(); child.emit("close", null); return true; });
  return child;
}

it("starts only an exact-device bounded helper and stops it on visibility cancellation", async () => {
  const child = fakeProcess();
  const spawn = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
  const runtime = new MacSimulatorNativeH264Runtime({ helperPath: "/private/joko-simulator-h264",
    platform: "darwin", verifyHelper: async () => true, spawn, developerDir: "/Applications/Xcode.app" });
  const controller = new AbortController();
  const stream = runtime.stream(identity, profile, controller.signal);
  const next = stream.next();
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  expect(spawn).toHaveBeenCalledWith("/private/joko-simulator-h264", [
    "--simulator-udid", identity.simulatorUdid, "--generation", "7", "--stream-h264",
    "--fps", "20", "--scale", "70", "--orientation", "PORTRAIT"
  ], expect.objectContaining({ shell: false, stdio: ["pipe", "pipe", "ignore"],
    env: expect.objectContaining({ DEVELOPER_DIR: "/Applications/Xcode.app" }) }));
  child.stdout.write(encodedFrame());
  expect((await next).value).toMatchObject({ sequence: 1, width: 16,
    height: 12, keyFrame: true });
  controller.abort();
  expect((await stream.next()).done).toBe(true);
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
});

it("rejects invalid platform/profile and treats malformed helper output as lost", async () => {
  const absent = new MacSimulatorNativeH264Runtime({ helperPath: "/private/missing",
    platform: "win32", verifyHelper: async () => true });
  await expect(absent.stream(identity, profile).next()).rejects.toThrow("unavailable");
  const child = fakeProcess();
  const runtime = new MacSimulatorNativeH264Runtime({ helperPath: "/private/joko-simulator-h264",
    platform: "darwin", verifyHelper: async () => true,
    developerDir: "/Applications/Xcode.app",
    spawn: vi.fn(() => child) as unknown as typeof import("node:child_process").spawn });
  const next = runtime.stream(identity, profile).next();
  await vi.waitFor(() => expect(child.stdin.writableEnded).toBe(true));
  child.stdout.write(new Uint8Array([0xff, 0xff, 0xff, 0x7f]));
  await expect(next).rejects.toThrow("invalid or disconnected");
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
});

it("requires an exact helper probe result without stdout", async () => {
  const child = fakeProcess();
  const runtime = new MacSimulatorNativeH264Runtime({ helperPath: "/private/joko-simulator-h264",
    platform: "darwin", verifyHelper: async () => true,
    developerDir: "/Applications/Xcode.app",
    spawn: vi.fn(() => child) as unknown as typeof import("node:child_process").spawn });
  const result = runtime.probe(identity);
  await vi.waitFor(() => expect(child.stdin.writableEnded).toBe(true));
  child.stdout.end();
  child.emit("close", 0);
  expect(await result).toBe(true);
  expect(await runtime.probe({ ...identity, generation: 0 })).toBe(false);
});
