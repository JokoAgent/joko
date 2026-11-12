import { NativeInputHandoffMethod } from "@joko/contracts";
import { expect, it, vi } from "vitest";

import { createMacHandoffDriver } from "./input-handoff-macos-driver.js";
import { executeNativeInputHandoffCommand } from "./input-handoff-native-host.js";

vi.mock("electron", () => ({ app: {}, nativeImage: {}, screen: {}, systemPreferences: {} }));

it("runs the signed Main field probe for an exact focus or point and keeps the owner field read", async () => {
  const focusedField = vi.fn(async () => ({ editable: true, secure: false }));
  const driver = { ...createMacHandoffDriver(), focusedField };
  const check = vi.fn(async () => true);
  const run = (value: unknown) => executeNativeInputHandoffCommand({ method: NativeInputHandoffMethod.FOCUSED_FIELD,
    payload: Buffer.from(JSON.stringify(value)) }, driver, check);

  await expect(run({ pid: 7, secureOnly: true })).resolves.toBe(true);
  await expect(run({ pid: 7, secureOnly: true, point: [-10, 24] })).resolves.toBe(true);
  expect(check.mock.calls).toEqual([[{ pid: 7 }], [{ pid: 7, point: { x: -10, y: 24 } }]]);
  expect(focusedField).not.toHaveBeenCalled();

  await expect(run({ pid: 7, secureOnly: true, point: [1] })).rejects.toThrow("invalid");
  await expect(run({ pid: 7, secureOnly: true, text: "unadmitted field" })).rejects.toThrow("invalid");
  await expect(run({ pid: 2 ** 31, secureOnly: true })).rejects.toThrow("invalid");
  expect(check).toHaveBeenCalledTimes(2);

  await expect(run({ pid: 7 })).resolves.toEqual({ editable: true, secure: false });
  expect(focusedField).toHaveBeenCalledWith(7);
});
