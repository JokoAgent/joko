import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { NativeHandoffInputOwnership } from "./native-input-ownership.js";
import { isHumanDesktopInputActive, withAgentDesktopInput } from "./input-ownership.js";
const owners: NativeHandoffInputOwnership[] = [];
afterEach(() => { for (const owner of owners.splice(0)) owner.close(); vi.useRealTimers(); });
const host = () => ({ instanceId: "main-instance", deviceId: "main-device", token: {} });
const gestures = (value: unknown) => Buffer.from(JSON.stringify(value));
it("reserves human priority before waiting for a real Agent primitive, then releases only after native acknowledgement", async () => {
  vi.useFakeTimers(); const owner = new NativeHandoffInputOwnership(); owners.push(owner); const identity = host(), id = randomUUID();
  let release!: () => void, assertAgent!: () => void;
  const running = withAgentDesktopInput(async check => { assertAgent = check; await new Promise<void>(resolve => { release = resolve; }); });
  let admitted = false;
  const beginning = owner.begin(identity, id, "window", gestures([{ kind: "text", text: "" }]), () => {}, new AbortController().signal).then(value => { admitted = true; return value; });
  expect(isHumanDesktopInputActive()).toBe(true); expect(admitted).toBe(false); expect(() => assertAgent()).toThrow("yielded");
  release(); await running; const batch = await beginning;
  expect(isHumanDesktopInputActive()).toBe(true);
  owner.finish(identity, id, "window", batch, false); await vi.advanceTimersByTimeAsync(301);
  expect(isHumanDesktopInputActive()).toBe(false);
});
it("holds gestures across batches and permits cleanup only for the exact old helper owner", async () => {
  vi.useFakeTimers(); const owner = new NativeHandoffInputOwnership(); owners.push(owner); const identity = host(), id = randomUUID();
  const first = await owner.begin(identity, id, "window", gestures([{ kind: "key", code: "ShiftLeft", down: true }]), () => {}, new AbortController().signal);
  owner.finish(identity, id, "window", first, false); await vi.advanceTimersByTimeAsync(301); expect(isHumanDesktopInputActive()).toBe(true);
  expect(() => owner.finish({ ...identity, deviceId: "other" }, id, "window", "", true)).toThrow();
  owner.retireHost(identity.token);
  await expect(owner.begin({ ...identity, token: {} }, id, "window", gestures([{ kind: "release" }]), () => {}, new AbortController().signal)).rejects.toThrow();
  owner.finish(identity, id, "window", "", true); expect(isHumanDesktopInputActive()).toBe(false);
});
it("does not accept secret text or absolute pointer coordinates in the ownership channel", async () => {
  const owner = new NativeHandoffInputOwnership(); owners.push(owner); const identity = host();
  for (const event of [{ kind: "text", text: "synthetic-private" }, { kind: "button", down: true, button: 0, x: .5, y: .5 }]) {
    await expect(owner.begin(identity, randomUUID(), "window", gestures([event]), () => {}, new AbortController().signal)).rejects.toThrow();
  }
  expect(isHumanDesktopInputActive()).toBe(false);
});
