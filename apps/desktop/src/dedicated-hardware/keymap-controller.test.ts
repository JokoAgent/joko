import { describe, expect, it, vi } from "vitest";

import { buildCreatorManagedKeymap, readCreatorManagedHidMapping } from "./creator-keymap.js";
import {
  createDedicatedHardwareKeymapController,
  type DedicatedHardwareKeymapAdapter
} from "./keymap-controller.js";
import type { DedicatedHardwarePhysicalKey } from "./settings.js";

const ORIGINAL = JSON.stringify({ profiles: [{ layers: [{ name: "factory", layout: { keymap: [["A"]] } }] }] });
const IDENTITY = "creator-a@firmware-1";

function managed(original: string, taskKeys: readonly DedicatedHardwarePhysicalKey[]): string {
  const value = JSON.parse(original) as Record<string, unknown>;
  return JSON.stringify({ ...value, jokoManagedTaskKeys: [...taskKeys] });
}

function adapterFixture(options: { backup?: string; current?: string } = {}) {
  let current = options.current ?? ORIGINAL;
  let identity = IDENTITY;
  const backups = new Map<string, { version: 1; deviceFirmwareIdentity: string; contents: string }>();
  if (options.backup !== undefined) {
    backups.set(identity, { version: 1, deviceFirmwareIdentity: identity, contents: options.backup });
  }
  let writeCall = 0;
  let failWrites = new Set<number>();
  let failBackupCleanup = false;
  const order: string[] = [];
  const adapter: DedicatedHardwareKeymapAdapter = {
    readDeviceFirmwareIdentity: vi.fn(async () => { order.push("read-identity"); return identity; }),
    readCurrent: vi.fn(async (expected) => {
      order.push("read-current");
      if (expected !== identity) throw new Error("identity changed");
      return current;
    }),
    buildManaged: vi.fn((original, taskKeys) => { order.push("build-managed"); return managed(original, taskKeys); }),
    writeCurrent: vi.fn(async (expected, contents) => {
      writeCall += 1;
      order.push(`write-${writeCall}`);
      if (expected !== identity) throw new Error("identity changed");
      current = contents;
      if (failWrites.has(writeCall)) throw new Error("write failed");
    }),
    reload: vi.fn(async (expected) => {
      order.push("reload");
      if (expected !== identity) throw new Error("identity changed");
    }),
    listBackups: vi.fn(async () => { order.push("list-backups"); return [...backups.values()]; }),
    readBackup: vi.fn(async (expected) => { order.push("read-backup"); return backups.get(expected); }),
    saveBackup: vi.fn(async (value) => {
      order.push("save-backup");
      if (backups.has(value.deviceFirmwareIdentity)) throw new Error("already exists");
      backups.set(value.deviceFirmwareIdentity, value);
    }),
    clearBackup: vi.fn(async (expected) => {
      order.push("clear-backup");
      if (failBackupCleanup) throw new Error("cleanup failed");
      backups.delete(expected);
    })
  };
  return {
    adapter,
    order,
    failWriteCalls: (...calls: number[]) => { failWrites = new Set(calls); },
    failBackupCleanup: (fail = true) => { failBackupCleanup = fail; },
    setIdentity: (value: string) => { identity = value; },
    current: () => current,
    backup: (expected = IDENTITY) => backups.get(expected)?.contents,
    backupIdentities: () => [...backups.keys()]
  };
}

describe("dedicated hardware exclusive keymap controller", () => {
  it("backs up a nondefault active layer, rolls a failed real layout update back, and restores the exact original", async () => {
    const original = JSON.stringify({
      retained: "document",
      profiles: [
        { layers: [{ layout: { keymap: [["other profile"]] } }] },
        { layers: [
          { layout: { keymap: [["other layer"]] } },
          { id: 7, layout: { keymap: [["factory"]], retain: "layout" } }
        ] }
      ]
    }, null, 2);
    const context = { profileIndex: 1, layerIndex: 2 };
    const fixture = adapterFixture({ current: original });
    vi.mocked(fixture.adapter.buildManaged).mockImplementation((value, taskKeys) =>
      buildCreatorManagedKeymap(value, taskKeys, context));
    const controller = createDedicatedHardwareKeymapController(fixture.adapter);
    await controller.occupy(["AG00", "ACT07"], IDENTITY);
    const confirmed = fixture.current();
    expect(fixture.backup()).toBe(original);
    expect(readCreatorManagedHidMapping(confirmed, context)?.get("AG01")).toBe("ACT07");
    expect(fixture.order.indexOf("save-backup")).toBeLessThan(fixture.order.indexOf("write-1"));
    fixture.failWriteCalls(2);
    await expect(controller.occupy(["AG03"], IDENTITY)).rejects.toThrow("apply");
    expect(fixture.current()).toBe(confirmed);
    expect(readCreatorManagedHidMapping(fixture.current(), context)?.get("AG01")).toBe("ACT07");
    expect(fixture.backup()).toBe(original);
    await controller.release();
    expect(fixture.current()).toBe(original);
    expect(fixture.backup()).toBeUndefined();
    expect(controller.getState()).toEqual({ phase: "idle", backupAvailable: false, failure: null });
  });

  it("keeps a retained A recovery visible and prevents B from consuming or bypassing it", async () => {
    const fixture = adapterFixture({ backup: ORIGINAL, current: managed(ORIGINAL, ["AG00"]) });
    const controller = createDedicatedHardwareKeymapController(fixture.adapter);

    await controller.initialize();
    expect(controller.getState()).toEqual({
      phase: "error", backupAvailable: true, failure: "recovery-required"
    });
    expect(fixture.adapter.writeCurrent).not.toHaveBeenCalled();

    fixture.setIdentity("creator-b@firmware-2");
    await expect(controller.recover()).rejects.toThrow("recovery-required");
    await expect(controller.occupy(["AG01"], "creator-b@firmware-2")).rejects.toThrow("recovery-required");
    expect(fixture.adapter.writeCurrent).not.toHaveBeenCalled();
    expect(fixture.adapter.clearBackup).not.toHaveBeenCalled();
    expect(fixture.backup()).toBe(ORIGINAL);
    expect(fixture.backup("creator-b@firmware-2")).toBeUndefined();
    expect(fixture.backupIdentities()).toEqual([IDENTITY]);
    expect(controller.getState()).toEqual({
      phase: "error", backupAvailable: true, failure: "recovery-required"
    });
  });

  it("backs up before applying, updates from the original, and restores on release", async () => {
    const fixture = adapterFixture();
    const controller = createDedicatedHardwareKeymapController(fixture.adapter);
    const states: string[] = [];
    controller.subscribe((state) => states.push(`${state.phase}:${state.failure ?? "ok"}`));

    await controller.occupy(["AG00", "AG01"]);
    expect(fixture.order.slice(0, 7)).toEqual([
      "read-identity", "list-backups", "read-current", "save-backup", "build-managed", "read-identity", "write-1"
    ]);
    expect(fixture.backup()).toBe(ORIGINAL);
    expect(fixture.current()).toBe(managed(ORIGINAL, ["AG00", "AG01"]));
    expect(controller.getState()).toEqual({ phase: "occupied", backupAvailable: true, failure: null });

    await controller.occupy(["AG00", "AG01", "AG02"]);
    expect(fixture.adapter.buildManaged).toHaveBeenLastCalledWith(ORIGINAL, ["AG00", "AG01", "AG02"]);
    expect(fixture.current()).toBe(managed(ORIGINAL, ["AG00", "AG01", "AG02"]));

    await controller.release();
    expect(fixture.current()).toBe(ORIGINAL);
    expect(fixture.backup()).toBeUndefined();
    expect(controller.getState()).toEqual({ phase: "idle", backupAvailable: false, failure: null });
    expect(states).toContain("restoring:ok");
  });

  it("rolls an initially failed write back before clearing its backup", async () => {
    const fixture = adapterFixture();
    fixture.failWriteCalls(1);
    const controller = createDedicatedHardwareKeymapController(fixture.adapter);

    await expect(controller.occupy(["AG00"])).rejects.toThrow("apply");
    expect(fixture.adapter.writeCurrent).toHaveBeenCalledTimes(2);
    expect(fixture.adapter.writeCurrent).toHaveBeenNthCalledWith(2, IDENTITY, ORIGINAL);
    expect(fixture.current()).toBe(ORIGINAL);
    expect(fixture.backup()).toBeUndefined();
    expect(controller.getState()).toEqual({ phase: "error", backupAvailable: false, failure: "apply" });
  });

  it("rolls a failed reconfiguration back to the prior managed map without losing the factory backup", async () => {
    const fixture = adapterFixture();
    const controller = createDedicatedHardwareKeymapController(fixture.adapter);
    await controller.occupy(["AG00"]);
    const previous = fixture.current();
    fixture.failWriteCalls(2);

    await expect(controller.occupy(["AG00", "AG01"])).rejects.toThrow("apply");
    expect(fixture.adapter.writeCurrent).toHaveBeenNthCalledWith(3, IDENTITY, previous);
    expect(fixture.current()).toBe(previous);
    expect(fixture.backup()).toBe(ORIGINAL);
    expect(controller.getState()).toEqual({ phase: "occupied", backupAvailable: true, failure: "apply" });
  });

  it("keeps the backup recoverable when both apply and rollback fail", async () => {
    const fixture = adapterFixture();
    fixture.failWriteCalls(1, 2);
    const controller = createDedicatedHardwareKeymapController(fixture.adapter);

    await expect(controller.occupy(["AG00"])).rejects.toThrow("rollback");
    expect(controller.getState()).toEqual({ phase: "error", backupAvailable: true, failure: "rollback" });
    expect(fixture.backup()).toBe(ORIGINAL);
    expect(fixture.adapter.writeCurrent).toHaveBeenCalledTimes(2);
    expect(fixture.adapter.saveBackup).toHaveBeenCalledOnce();

    await expect(controller.occupy(["AG01"])).rejects.toThrow("recovery-required");
    await expect(controller.release()).rejects.toThrow("recovery-required");
    expect(fixture.adapter.writeCurrent).toHaveBeenCalledTimes(2);
    expect(fixture.adapter.saveBackup).toHaveBeenCalledOnce();

    fixture.failWriteCalls();
    await controller.recover();
    expect(fixture.current()).toBe(ORIGINAL);
    expect(fixture.backup()).toBeUndefined();
  });

  it("requires explicit recovery for a persisted pre-crash backup before accepting a new occupancy", async () => {
    const stranded = managed(ORIGINAL, ["AG00"]);
    const fixture = adapterFixture({ backup: ORIGINAL, current: stranded });
    const controller = createDedicatedHardwareKeymapController(fixture.adapter);

    await expect(controller.occupy(["AG01"])).rejects.toThrow("recovery-required");
    expect(controller.getState()).toEqual({
      phase: "error", backupAvailable: true, failure: "recovery-required"
    });
    expect(fixture.current()).toBe(stranded);
    expect(fixture.adapter.writeCurrent).not.toHaveBeenCalled();
    expect(fixture.adapter.saveBackup).not.toHaveBeenCalled();
    expect(fixture.adapter.clearBackup).not.toHaveBeenCalled();

    await expect(controller.occupy(["AG02"])).rejects.toThrow("recovery-required");
    expect(fixture.adapter.writeCurrent).not.toHaveBeenCalled();
    expect(fixture.adapter.saveBackup).not.toHaveBeenCalled();

    await controller.recover();
    expect(fixture.adapter.writeCurrent).toHaveBeenNthCalledWith(1, IDENTITY, ORIGINAL);
    expect(fixture.current()).toBe(ORIGINAL);
    expect(controller.getState().phase).toBe("idle");

    await controller.occupy(["AG01"]);
    expect(fixture.adapter.clearBackup).toHaveBeenCalledBefore(fixture.adapter.saveBackup as ReturnType<typeof vi.fn>);
    expect(fixture.current()).toBe(managed(ORIGINAL, ["AG01"]));
  });

  it("does not overwrite a backup after restore fails and permits only explicit recovery", async () => {
    const fixture = adapterFixture();
    const controller = createDedicatedHardwareKeymapController(fixture.adapter);
    await controller.occupy(["AG00"]);
    fixture.failWriteCalls(2);

    await expect(controller.release()).rejects.toThrow("restore");
    expect(controller.getState()).toEqual({ phase: "error", backupAvailable: true, failure: "restore" });
    expect(fixture.adapter.writeCurrent).toHaveBeenCalledTimes(2);
    expect(fixture.adapter.saveBackup).toHaveBeenCalledOnce();

    await expect(controller.occupy(["AG01"])).rejects.toThrow("recovery-required");
    await expect(controller.release()).rejects.toThrow("recovery-required");
    expect(fixture.adapter.writeCurrent).toHaveBeenCalledTimes(2);
    expect(fixture.adapter.saveBackup).toHaveBeenCalledOnce();

    fixture.failWriteCalls();
    await controller.recover();
    expect(fixture.backup()).toBeUndefined();
    expect(controller.getState()).toEqual({ phase: "idle", backupAvailable: false, failure: null });
  });

  it("does not rewrite an already restored keymap when backup cleanup must be retried", async () => {
    const fixture = adapterFixture();
    const controller = createDedicatedHardwareKeymapController(fixture.adapter);
    await controller.occupy(["AG00"]);
    fixture.failBackupCleanup();

    await expect(controller.release()).rejects.toThrow("backup-cleanup");
    expect(fixture.current()).toBe(ORIGINAL);
    expect(fixture.adapter.writeCurrent).toHaveBeenCalledTimes(2);
    expect(fixture.adapter.saveBackup).toHaveBeenCalledOnce();
    await expect(controller.occupy(["AG01"])).rejects.toThrow("recovery-required");
    expect(fixture.adapter.writeCurrent).toHaveBeenCalledTimes(2);
    expect(fixture.adapter.saveBackup).toHaveBeenCalledOnce();

    fixture.failBackupCleanup(false);
    await controller.recover();
    expect(fixture.adapter.writeCurrent).toHaveBeenCalledTimes(2);
    expect(fixture.adapter.reload).toHaveBeenCalledTimes(2);
    expect(fixture.backup()).toBeUndefined();
    await controller.occupy(["AG01"]);
    expect(fixture.current()).toBe(managed(ORIGINAL, ["AG01"]));
  });

  it("rejects invalid task order and invalid or oversized keymap documents without writing", async () => {
    const invalidAdapter = adapterFixture({ current: "{}" });
    const invalidController = createDedicatedHardwareKeymapController(invalidAdapter.adapter);
    await expect(invalidController.occupy(["AG01", "AG00"])).rejects.toThrow(TypeError);
    await expect(invalidController.occupy(["AG00"])).rejects.toThrow("read");
    expect(invalidAdapter.adapter.writeCurrent).not.toHaveBeenCalled();

    const oversized = adapterFixture({ current: JSON.stringify({ profiles: [{ layers: [{}] }], padding: "x".repeat(513 * 1024) }) });
    await expect(createDedicatedHardwareKeymapController(oversized.adapter).occupy([])).rejects.toThrow("read");
    expect(oversized.adapter.writeCurrent).not.toHaveBeenCalled();
  });
});
