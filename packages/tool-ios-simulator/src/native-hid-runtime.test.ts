import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { expect, it } from "vitest";
import { MacSimulatorNativeHidRuntime } from "./native-hid-runtime.js";
import { normalizeSimulatorTouchPath } from "./native-touch-path.js";

const identity = { simulatorUdid: "A0123456-1234-1234-1234-123456789ABC", generation: 3 };
const viewport = { width: 400, height: 800, orientation: "PORTRAIT" as const };
const path = normalizeSimulatorTouchPath([
  { phase: "down", x: 4, y: 8 }, { phase: "move", x: 40, y: 80, dtMs: 16 },
  { phase: "up", x: 100, y: 200, dtMs: 16 }
], viewport);

function fakeSpawn(result: { readonly code: string; readonly status: number } | null,
  calls: Array<{ command: string; args: readonly string[]; env: Record<string, string | undefined>;
    body: string; kills: string[] }>) {
  return ((command: string, args: readonly string[], options: { env: Record<string, string | undefined> }) => {
    const process = new EventEmitter() as EventEmitter & { stdin: Writable; stdout: PassThrough;
      kill: (signal: string) => boolean };
    const call = { command, args, env: options.env, body: "", kills: [] as string[] };
    calls.push(call);
    process.stdout = new PassThrough();
    process.stdin = new Writable({ write(chunk: Buffer, _encoding, callback) {
      call.body += chunk.toString("utf8"); callback();
    } });
    process.kill = signal => { call.kills.push(signal); queueMicrotask(() => process.emit("close", null));
      return true; };
    process.stdin.on("finish", () => {
      if (!result) return;
      queueMicrotask(() => { process.stdout.write(`${JSON.stringify({ code: result.code })}\n`);
        process.emit("close", result.status); });
    });
    return process;
  }) as never;
}

it("executes only an exact-device, bounded native helper with filtered environment", async () => {
  const calls: Array<{ command: string; args: readonly string[]; env: Record<string, string | undefined>;
    body: string; kills: string[] }> = [];
  const runtime = new MacSimulatorNativeHidRuntime({ helperPath: "/private/joko-simulator-hid",
    platform: "darwin", developerDir: "/Applications/Xcode.app/Contents/Developer",
    verifyHelper: async () => true, spawn: fakeSpawn({ code: "OK", status: 0 }, calls) });
  expect(await runtime.probe(identity)).toBe(true);
  await expect(runtime.touch(identity, path)).resolves.toBeUndefined();
  expect(calls).toHaveLength(2);
  expect(calls.map(call => call.args)).toEqual([
    ["--simulator-udid", identity.simulatorUdid, "--generation", "3", "--probe"],
    ["--simulator-udid", identity.simulatorUdid, "--generation", "3", "--touch"]
  ]);
  expect(calls[1]?.command).toBe("/private/joko-simulator-hid");
  const submitted = JSON.parse(calls[1]!.body) as { simulatorUdid: string; generation: number;
    first: readonly { phase: string; x: number; y: number }[] };
  expect(submitted).toMatchObject({ simulatorUdid: identity.simulatorUdid, generation: 3 });
  expect(submitted.first[0]).toMatchObject({ phase: "down", x: 0.01, y: 0.01 });
  expect(Object.keys(calls[1]!.env).sort()).toEqual(["DEVELOPER_DIR", "HOME", "PATH", "TMPDIR"]);
});

it("fails closed without a helper and treats cancelled dispatched touch as unknown", async () => {
  const calls: Array<{ command: string; args: readonly string[]; env: Record<string, string | undefined>;
    body: string; kills: string[] }> = [];
  const absent = new MacSimulatorNativeHidRuntime({ helperPath: "/private/missing", platform: "win32",
    verifyHelper: async () => true, spawn: fakeSpawn({ code: "OK", status: 0 }, calls) });
  expect(await absent.probe(identity)).toBe(false);
  await expect(absent.touch(identity, path)).rejects.toMatchObject({ code: "NATIVE_INPUT_UNAVAILABLE" });
  expect(calls).toHaveLength(0);
  const runtime = new MacSimulatorNativeHidRuntime({ helperPath: "/private/joko-simulator-hid",
    platform: "darwin", developerDir: "/Applications/Xcode.app/Contents/Developer",
    verifyHelper: async () => true, spawn: fakeSpawn(null, calls) });
  const controller = new AbortController();
  const pending = runtime.touch(identity, path, undefined, controller.signal);
  await new Promise<void>(resolve => setImmediate(resolve));
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "INPUT_OUTCOME_UNKNOWN" });
  expect(calls[0]?.kills).toEqual(["SIGTERM"]);
});

it("keeps one exact-device HID contact across live begin, move and end", async () => {
  const calls: Array<{ args: readonly string[]; messages: unknown[]; kills: string[] }> = [];
  const spawn = ((_command: string, args: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdin: Writable; stdout: PassThrough;
      kill: (signal: string) => boolean };
    const call = { args, messages: [] as unknown[], kills: [] as string[] };
    calls.push(call);
    child.stdout = new PassThrough();
    child.stdin = new Writable({ write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString("utf8").trim().split("\n")) {
        const message = JSON.parse(line) as { phase: string; sequence: number };
        call.messages.push(message);
        queueMicrotask(() => { child.stdout.write(`${JSON.stringify({ code: "OK",
          sequence: message.sequence })}\n`);
          if (message.phase === "end") child.emit("close", 0); });
      }
      callback();
    } });
    child.kill = signal => { call.kills.push(signal); queueMicrotask(() => child.emit("close", null));
      return true; };
    queueMicrotask(() => child.stdout.write('{"code":"READY"}\n'));
    return child;
  }) as never;
  const runtime = new MacSimulatorNativeHidRuntime({ helperPath: "/private/joko-simulator-hid",
    platform: "darwin", developerDir: "/Applications/Xcode.app/Contents/Developer",
    verifyHelper: async () => true, spawn });
  const gestureId = "A0123456-1234-1234-1234-123456789ABC";
  const contact = await runtime.beginLiveTouch(identity, gestureId, { x: 0.1, y: 0.2 });
  await contact.move({ x: 0.3, y: 0.4 }, 1);
  await contact.end({ x: 0.5, y: 0.6 }, 2);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.args).toEqual(["--simulator-udid", identity.simulatorUdid,
    "--generation", "3", "--live-touch"]);
  expect(calls[0]?.messages).toMatchObject([
    { gestureId, phase: "begin", sequence: 0, x: 0.1, y: 0.2 },
    { gestureId, phase: "move", sequence: 1, x: 0.3, y: 0.4 },
    { gestureId, phase: "end", sequence: 2, x: 0.5, y: 0.6 }
  ]);
  expect(calls[0]?.kills).toEqual([]);
});
