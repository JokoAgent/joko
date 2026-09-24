import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MacSimulatorRecordingRuntime } from "./recording-runtime.js";

const UDID = "A0123456-1234-1234-1234-123456789ABC";
const MOV = Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 113, 116, 32, 32, 0, 0, 0, 0]);

function fakeGuardian(calls: Array<{ command: string; args: readonly string[];
  env: Record<string, string | undefined>; messages: string[] }>, movie = MOV) {
  return ((command: string, args: readonly string[], options: {
    env: Record<string, string | undefined> }) => {
    const child = new EventEmitter() as EventEmitter & { connected: boolean; exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      send: (message: { type: string }) => boolean };
    const call = { command, args, env: options.env, messages: [] as string[] };
    calls.push(call);
    child.connected = true;
    child.exitCode = null;
    child.signalCode = null;
    const directory = join(args[3]!, args[4]!);
    void mkdir(directory, { recursive: false }).then(() => child.emit("message", { type: "ready" }));
    child.send = message => {
      call.messages.push(message.type);
      if (message.type === "stop") {
        void writeFile(join(directory, "recording.mov"), movie).then(() =>
          child.emit("message", { type: "finalized" }));
      } else if (message.type === "release" || message.type === "discard") {
        queueMicrotask(() => { child.exitCode = 0; child.emit("exit", 0); });
      }
      return true;
    };
    return child;
  }) as never;
}

it("uses an exact-device IPC guardian, validates finalized MOV and releases it", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-recording-runtime-"));
  const calls: Array<{ command: string; args: readonly string[];
    env: Record<string, string | undefined>; messages: string[] }> = [];
  try {
    const runtime = new MacSimulatorRecordingRuntime({ rootDirectory: root, platform: "darwin",
      executablePath: "/private/node", guardianPath: "/private/recording-guardian.js",
      spawn: fakeGuardian(calls) });
    const handle = await runtime.start(UDID);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("/private/node");
    expect(calls[0]?.args).toEqual(["/private/recording-guardian.js", "--guardian", UDID,
      root, handle.recordingId]);
    expect(Object.keys(calls[0]!.env).sort()).toEqual(["HOME", "PATH", "TMPDIR"]);
    const result = await runtime.stop(handle);
    expect(result.byteLength).toBe(MOV.byteLength);
    await result.file.close();
    await runtime.release(handle);
    expect(calls[0]?.messages).toEqual(["stop", "release"]);
    await runtime.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("fails closed off macOS without spawning a recorder", async () => {
  const calls: Array<{ command: string; args: readonly string[];
    env: Record<string, string | undefined>; messages: string[] }> = [];
  const runtime = new MacSimulatorRecordingRuntime({ rootDirectory: "/private/recordings",
    platform: "win32", spawn: fakeGuardian(calls) });
  await expect(runtime.start(UDID)).rejects.toMatchObject({ code: "RECORDING_UNAVAILABLE" });
  expect(calls).toHaveLength(0);
});

it("discards an invalid finalized container without exposing an output handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-recording-invalid-"));
  const calls: Array<{ command: string; args: readonly string[];
    env: Record<string, string | undefined>; messages: string[] }> = [];
  try {
    const runtime = new MacSimulatorRecordingRuntime({ rootDirectory: root, platform: "darwin",
      spawn: fakeGuardian(calls, Buffer.from("not-a-movie")) });
    const handle = await runtime.start(UDID);
    await expect(runtime.stop(handle)).rejects.toMatchObject({ code: "RECORDING_INVALID" });
    expect(calls[0]?.messages).toEqual(["stop", "discard"]);
    expect(runtime.isActive(handle)).toBe(false);
    await runtime.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
