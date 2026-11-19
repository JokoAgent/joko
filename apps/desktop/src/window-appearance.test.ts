import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWritePrivateFile } from "@joko/device-peer/private-files";
import { expect, it, vi } from "vitest";
import { desktopWindowBackground, openDesktopWindowAppearance } from "./window-appearance.js";

vi.mock("@joko/device-peer/private-files", async importOriginal => {
  const files = await importOriginal<typeof import("@joko/device-peer/private-files")>();
  return { ...files, atomicWritePrivateFile: vi.fn(files.atomicWritePrivateFile) };
});

it("reads the saved window mode before creation and resolves system appearance at window creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joko-window-appearance-"));
  const path = join(directory, "window-appearance.txt");
  try {
    const initial = await openDesktopWindowAppearance(path);
    expect(initial.theme()).toBe("dark");
    await initial.save("light", () => undefined);
    const cold = await openDesktopWindowAppearance(path);
    expect(desktopWindowBackground(cold.theme(), true)).toBe("#f2f2f2");
    const rejected = cold.save("dark", () => { throw new Error("Window retired"); });
    const following = cold.save("system", () => undefined);
    await expect(rejected).rejects.toThrow("Window retired");
    await following;
    const system = await openDesktopWindowAppearance(path);
    expect(system.theme()).toBe("system");
    expect(desktopWindowBackground(system.theme(), false)).toBe("#f2f2f2");
    expect(desktopWindowBackground(system.theme(), true)).toBe("#0d0d0d");
    await writeFile(path, "corrupt preference");
    expect((await openDesktopWindowAppearance(path)).theme()).toBe("dark");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== "win32")("retries a busy Windows theme mirror within its original window authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joko-window-appearance-retry-"));
  const path = join(directory, "window-appearance.txt");
  const write = vi.mocked(atomicWritePrivateFile);
  const busy = Object.assign(new Error("The Windows mirror is busy."), { code: "EPERM" });
  try {
    const mirror = await openDesktopWindowAppearance(path);
    await mirror.save("dark", () => undefined);
    write.mockClear();
    write.mockRejectedValueOnce(busy);
    await mirror.save("light", () => undefined);
    expect(write).toHaveBeenCalledTimes(2);
    expect((await openDesktopWindowAppearance(path)).theme()).toBe("light");

    write.mockClear();
    let retired = false;
    write.mockImplementationOnce(async () => { retired = true; throw busy; });
    const cancelled = mirror.save("dark", () => { if (retired) throw new Error("Window retired"); });
    const next = mirror.save("system", () => undefined);
    await expect(cancelled).rejects.toThrow("Window retired");
    await next;
    expect(write.mock.calls.map(([, bytes]) => Buffer.from(bytes).toString("utf8"))).toEqual(["dark\n", "system\n"]);
    expect((await openDesktopWindowAppearance(path)).theme()).toBe("system");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
