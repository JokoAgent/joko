import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import type { PiProcessHandle } from "@joko/adapter-pi";
import { expect, it } from "vitest";

import { ControlledPiProcess } from "./controlled-pi-process.js";

it("forwards the native input write failure through the exposed process input", async () => {
  const failure = Object.assign(new Error("write EPIPE"), { code: "EPIPE", syscall: "write" });
  const nativeErrors: Error[] = [];
  const exposedErrors: Error[] = [];
  const nativeInput = new Writable({
    write(_chunk, _encoding, callback) { callback(failure); }
  });
  // Observe the deliberately failing destination so the regression reports the
  // missing public error instead of throwing outside this controlled test.
  nativeInput.on("error", (error) => nativeErrors.push(error));
  const native: PiProcessHandle = Object.assign(new EventEmitter(), {
    stdin: nativeInput,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => true
  });
  const controlled = new ControlledPiProcess(native, 0, () => false, () => {
    throw new Error("No prompt fault is armed for this input write.");
  });
  controlled.stdin.on("error", (error) => exposedErrors.push(error));
  try {
    controlled.stdin.write('{"type":"get_state","id":"broken-pipe-request"}\n');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(nativeErrors).toEqual([failure]);
    expect(exposedErrors).toEqual([failure]);
    expect(controlled.stdin.errored).toBe(failure);
    expect(controlled.stdin.destroyed).toBe(true);
  } finally {
    controlled.stdin.destroy();
    controlled.stdout.destroy();
    native.stdin.destroy();
    native.stdout.destroy();
    native.stderr.destroy();
  }
});
