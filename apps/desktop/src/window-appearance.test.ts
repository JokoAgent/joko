import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { desktopWindowBackground, openDesktopWindowAppearance } from "./window-appearance.js";

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
