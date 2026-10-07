import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { createDedicatedHardwareNativeUsbAdapter } from "./native-usb-adapter.js";
import { createDefaultDedicatedHardwareSettings } from "./settings.js";

describe("native USB hardware transport", () => {
  it("connects input and lighting, reports SDK-only models unavailable, and fences the stopped child", async () => {
    const helper = controlledHelper();
    const sink = { publishState: vi.fn(), publishInput: vi.fn() };
    const adapter = createDedicatedHardwareNativeUsbAdapter({ executablePath: "controlled-helper", sink,
      spawnHelper: () => helper.child });
    try {
      const result = await adapter.setDesiredState("codex-micro", {
        settings: { ...createDefaultDedicatedHardwareSettings("codex-micro"), enabled: true }, preview: false
      });
      expect(result).toMatchObject({ status: "connected", transport: "usb", firmwareVersion: "1.2.3",
        batteryPercent: 72, keymapDeviceFirmwareIdentity: null });
      helper.emit({ kind: "hid", event: { key: "AG00", act: 1 } });
      helper.emit({ kind: "hid", event: { key: "ENC_CW", act: 2 } });
      helper.emit({ kind: "joystick", event: { angle: 0, distance: 1 } });
      expect(sink.publishInput.mock.calls).toEqual([
        ["codex-micro", { kind: "key", key: "AG00", pressed: true }],
        ["codex-micro", { kind: "encoder", delta: 1, pressed: false }],
        ["codex-micro", { kind: "stick", x: 1, y: 0, pressed: true }]
      ]);
      adapter.setLightingState("codex-micro", { version: 1,
        taskSlots: [{ phase: "running", attention: false }, null, null, null, null, null], revealOccurrence: "1", primaryVisible: true });
      await vi.waitFor(() => expect(helper.requests.some(request => request.kind === "apply")).toBe(true));
      expect(await adapter.setDesiredState("creator-micro-2", {
        settings: { ...createDefaultDedicatedHardwareSettings("creator-micro-2"), enabled: true }, preview: false
      })).toMatchObject({ status: "unavailable", reason: "sdk-unavailable" });
      await expect(adapter.creatorKeymap.readDeviceFirmwareIdentity()).rejects.toThrow("require the device SDK");
      await adapter.setDesiredState("codex-micro", {
        settings: createDefaultDedicatedHardwareSettings("codex-micro"), preview: false
      });
      const inputCount = sink.publishInput.mock.calls.length;
      helper.emit({ kind: "hid", event: { key: "AG00", act: 0 } });
      expect(sink.publishInput).toHaveBeenCalledTimes(inputCount);
      expect(helper.requests.at(-1)).toEqual({ kind: "stop" });
      expect(helper.child.kill).not.toHaveBeenCalled();
    } finally { await adapter.stop(); }
  });

  it("enumerates without enabling device input and terminates an oversized helper stream", async () => {
    const first = controlledHelper();
    const second = controlledHelper();
    const sink = { publishState: vi.fn(), publishInput: vi.fn() };
    const fatal = vi.fn();
    const spawnHelper = vi.fn().mockReturnValueOnce(first.child).mockReturnValueOnce(second.child);
    const adapter = createDedicatedHardwareNativeUsbAdapter({ executablePath: "controlled-helper", sink,
      spawnHelper, onFatalError: fatal });
    try {
      expect(await adapter.probe("codex-micro")).toMatchObject({ status: "disabled", devicePresent: true });
      expect(first.requests).toEqual([{ kind: "discover" }, { kind: "stop" }]);
      await adapter.setDesiredState("codex-micro", {
        settings: { ...createDefaultDedicatedHardwareSettings("codex-micro"), enabled: true }, preview: false
      });
      second.child.stdout.emit("data", "x".repeat(65_537));
      expect(second.child.kill).toHaveBeenCalledOnce();
      expect(fatal).toHaveBeenCalledOnce();
      expect(sink.publishState).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error", reason: "host-crash" }));
      second.emit({ kind: "hid", event: { key: "AG00", act: 1 } });
      expect(sink.publishInput).not.toHaveBeenCalled();
    } finally { await adapter.stop(); }
  });
});

function controlledHelper() {
  const requests: Array<Record<string, unknown>> = [];
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const emit = (message: unknown) => stdout.write(`${JSON.stringify(message)}\n`);
  const child = Object.assign(emitter, {
    stdout, stderr: new PassThrough(),
    kill: vi.fn(() => { queueMicrotask(() => emitter.emit("exit", 1)); return true; }),
    stdin: new Writable({ write(chunk: Buffer, _encoding, callback) {
      const request = JSON.parse(chunk.toString().trim()) as Record<string, unknown>;
      requests.push(request);
      queueMicrotask(() => {
        if (request.kind === "probe") {
          emit({ kind: "device", device: { deviceType: "codex-micro", isUsbConnection: true,
            firmwareVersion: "1.2.3", batteryPercentage: 71.5, isCharging: false } });
          emit({ kind: "state", status: "connected" });
        }
        if (request.kind === "discover") emit({ kind: "presence", present: true });
        if (request.kind === "stop") emitter.emit("exit", 0);
      });
      callback();
    } })
  }) as unknown as ChildProcessWithoutNullStreams;
  return { requests, child, emit };
}
