import { expect, it, vi } from "vitest";
import { NativeInputHandoffMethod as Method, type HandoffDriver } from "@joko/contracts";
vi.mock("electron", () => ({ app: {}, nativeImage: {}, screen: {}, systemPreferences: {} }));
const { executeNativeInputHandoffCommand: execute } = await import("../src/input-handoff-native-host.js");
const payload = (value: unknown) => Buffer.from(JSON.stringify(value));

it("dispatches only the exact bounded private native command without forwarding extra target selectors", async () => {
  const act = vi.fn(async () => ({ ok: true })), windows = vi.fn(async () => []);
  const driver = { act, windows } as unknown as HandoffDriver;
  const value = { pid: 7, window: { index: 0, title: "Sign in" }, ref: "field", fp: "observed", kind: "text", value: "synthetic-value" };
  await expect(execute({ method: Method.ACT, payload: payload(value) }, driver)).resolves.toMatchObject({ ok: true });
  expect(act).toHaveBeenCalledWith(value);
  for (const body of [{ ...value, root: true }, { ...value, pid: -1 }, { ...value, value: "x".repeat(4097) }, { ...value, window: { ...value.window, windowId: 9 } }]) {
    await expect(execute({ method: Method.ACT, payload: payload(body) }, driver)).rejects.toThrow("invalid");
  }
  await expect(execute({ method: Method.WINDOWS, payload: payload({ pid: 7 }) }, driver)).rejects.toThrow("invalid");
  expect(act).toHaveBeenCalledOnce(); expect(windows).not.toHaveBeenCalled();
});

it("accepts the Source's absolute point only inside its reviewed image area", async () => {
  const pointer = vi.fn(async () => ({ ok: true })), driver = { pointer } as unknown as HandoffDriver;
  const value = { kind: "tap", pid: 7, window: { index: 0, title: "Sign in" }, windowFrame: [100, 200, 800, 600], area: [120, 220, 300, 200], point: [300, 300] };
  await expect(execute({ method: Method.POINTER, payload: payload(value) }, driver)).resolves.toMatchObject({ ok: true });
  await expect(execute({ method: Method.POINTER, payload: payload({ ...value, point: [90, 300] }) }, driver)).rejects.toThrow("invalid");
  await expect(execute({ method: Method.POINTER, payload: payload({ ...value, area: [120, 220, 0, 200] }) }, driver)).rejects.toThrow("invalid");
  expect(pointer).toHaveBeenCalledOnce();
});
