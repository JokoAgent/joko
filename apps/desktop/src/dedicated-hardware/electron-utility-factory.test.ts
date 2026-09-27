import { EventEmitter } from "node:events";
import type { UtilityProcess } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  createDedicatedHardwareUtilityEnvironment,
  createElectronDedicatedHardwareUtilityFactory
} from "./electron-utility-factory.js";

class FakeUtilityProcess extends EventEmitter {
  readonly messages: unknown[] = [];
  killed = false;

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe("Electron dedicated hardware utility factory", () => {
  it("passes only a bounded non-credential environment", () => {
    const environment = createDedicatedHardwareUtilityEnvironment({
      SystemRoot: "C:\\Windows",
      Path: "C:\\Windows\\System32",
      TEMP: "C:\\Temp",
      OPENAI_API_KEY: "secret",
      JOKO_PROVIDER_TOKEN: "secret-2",
      NODE_OPTIONS: "--require injected.js"
    });
    expect(environment).toEqual({
      SystemRoot: "C:\\Windows",
      Path: "C:\\Windows\\System32",
      TEMP: "C:\\Temp"
    });
    expect(JSON.stringify(environment)).not.toContain("secret");
  });

  it("uses isolated stdio, forwards structured messages, and reports the exact process exit", async () => {
    const child = new FakeUtilityProcess();
    const fork = vi.fn(() => child as unknown as UtilityProcess);
    const factory = createElectronDedicatedHardwareUtilityFactory({
      entryPath: "D:\\joko\\apps\\desktop\\dist\\dedicated-hardware\\utility-entry.js",
      cwd: "D:\\joko",
      fork
    });
    const onMessage = vi.fn();
    const onExit = vi.fn();
    const spawning = factory.spawn({ generation: 1, onMessage, onExit });
    expect(fork).toHaveBeenCalledWith(
      "D:\\joko\\apps\\desktop\\dist\\dedicated-hardware\\utility-entry.js",
      [],
      expect.objectContaining({
        cwd: "D:\\joko",
        stdio: "ignore",
        execArgv: [],
        serviceName: "Joko hardware input",
        allowLoadingUnsignedLibraries: false,
        disclaim: false
      })
    );
    child.emit("spawn");
    const connection = await spawning;
    connection.send({ version: 1, generation: 1, requestId: "g1:1", kind: "shutdown" });
    expect(child.messages).toEqual([{ version: 1, generation: 1, requestId: "g1:1", kind: "shutdown" }]);
    child.emit("message", { version: 1, generation: 1, requestId: "g1:1", kind: "stopped" });
    expect(onMessage).toHaveBeenCalledWith({ version: 1, generation: 1, requestId: "g1:1", kind: "stopped" });
    child.emit("exit", 0);
    expect(onExit).toHaveBeenCalledOnce();
    connection.terminate();
    expect(child.killed).toBe(true);
  });

  it("rejects unsafe paths and startup exits without exposing process reports", async () => {
    expect(() => createElectronDedicatedHardwareUtilityFactory({ entryPath: "relative.js" })).toThrow(TypeError);
    const child = new FakeUtilityProcess();
    const factory = createElectronDedicatedHardwareUtilityFactory({
      entryPath: "D:\\joko\\utility-entry.js",
      fork: vi.fn(() => child as unknown as UtilityProcess)
    });
    const spawning = factory.spawn({ generation: 1, onMessage: vi.fn(), onExit: vi.fn() });
    child.emit("exit", 1);
    await expect(spawning).rejects.toThrow("exited during startup");
  });
});
