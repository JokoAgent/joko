import { expect, it, vi } from "vitest";
import { AsyncInputGate } from "./async-input-gate.js";

it.each(["reader first", "offer first"] as const)("withdraws a rejected authority without losing the SDK reader when %s", async (order) => {
  const gate = new AsyncInputGate<string>();
  const denied = new Error("The original resource is unavailable.");
  const onConsumed = vi.fn();
  const assertCurrent = () => { throw denied; };
  let reading: Promise<IteratorResult<string>>;
  if (order === "reader first") reading = gate.next();
  const offered = gate.offer("denied", onConsumed, undefined, assertCurrent);
  const rejected = expect(offered).rejects.toBe(denied);
  if (order === "offer first") reading = gate.next();
  await rejected;
  expect(onConsumed).not.toHaveBeenCalled();
  await gate.offer("current");
  await expect(reading!).resolves.toEqual({ value: "current", done: false });

  const closingRead = gate.next();
  await expect(gate.offer("denied again", onConsumed, undefined, assertCurrent)).rejects.toBe(denied);
  gate.close();
  await expect(closingRead).resolves.toEqual({ value: undefined, done: true });
  expect(onConsumed).not.toHaveBeenCalled();
});
