import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  DESKTOP_APPLICATION_ID,
  installWindowsApplicationIdentity
} from "../src/desktop-identity.js";

const builder = JSON.parse(readFileSync(new URL("../electron-builder.json", import.meta.url), "utf8")) as {
  readonly appId?: string;
};
describe("Desktop packaged application identity", () => {
  it("uses the packaged app id as the Windows runtime AppUserModelId", () => {
    expect(DESKTOP_APPLICATION_ID).toBe("app.joko.desktop");
    expect(builder.appId).toBe(DESKTOP_APPLICATION_ID);
  });

  it("sets the exact identity on Windows and is side-effect free elsewhere", () => {
    const setApplicationId = vi.fn();
    expect(installWindowsApplicationIdentity("linux", setApplicationId)).toBe(false);
    expect(installWindowsApplicationIdentity("darwin", setApplicationId)).toBe(false);
    expect(setApplicationId).not.toHaveBeenCalled();

    expect(installWindowsApplicationIdentity("win32", setApplicationId)).toBe(true);
    expect(setApplicationId).toHaveBeenCalledOnce();
    expect(setApplicationId).toHaveBeenCalledWith(DESKTOP_APPLICATION_ID);
  });
});
