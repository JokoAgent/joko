import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: {} }));
import {
  linuxRemoteDesktopDisplay, linuxRemoteDesktopInputMapping, readDesktopRemoteDesktopLinuxSessionState,
  readDesktopRemoteDesktopLinuxLockSessionState,
  readDesktopRemoteDesktopLinuxMonitors, readDesktopRemoteDesktopLinuxInputSupport,
  readDesktopRemoteDesktopLinuxCursorSupport, supportsDesktopRemoteDesktopLinuxCapture,
  type DesktopRemoteDesktopLinuxRuntime, type DesktopRemoteDesktopLinuxHelperRuntime
} from "../src/remote-desktop-linux.js";

const signal = new AbortController().signal;
const monitor = { name: "DP-1", width: 1920, height: 1080, x: -960, y: 0, scale: 2, transform: 0, solitaryBlockedBy: [] };
function runtime(): DesktopRemoteDesktopLinuxRuntime {
  return {
    platform: "linux", environment: { XDG_SESSION_TYPE: "wayland", XDG_SESSION_ID: "4", HYPRLAND_INSTANCE_SIGNATURE: "local" },
    uid: () => 1000, effectiveUid: () => 1000, executable: () => true, trustedExecutable: async () => true,
    execute: vi.fn(async (file) => file.endsWith("loginctl")
      ? "User=1000\nActive=yes\nRemote=no\nType=wayland\nLockedHint=no\n" : JSON.stringify([monitor]))
  };
}
describe("Linux owned session and physical layout", () => {
  it("mirror keeps active capture/input distinct from the all-output physical source directory", async () => {
    const native = runtime(), mirror = { ...monitor, name: "JokoRemote-0123456789abcdef", x: 0, scale: 1 };
    vi.mocked(native.execute).mockImplementation(async (_file, args) => JSON.stringify(args.includes("all") ? [monitor, mirror] : [mirror]));
    const capture = await readDesktopRemoteDesktopLinuxMonitors(signal, native);
    const directory = await readDesktopRemoteDesktopLinuxMonitors(signal, native, true);
    expect(capture.map(m => m.name)).toEqual([mirror.name]); expect(directory.map(m => m.name)).toEqual([monitor.name, mirror.name]);
    expect(linuxRemoteDesktopInputMapping(capture, `hyprland:${mirror.name}`)(0, 0)).toEqual({ x: 0, y: 0 });
    expect(native.execute).toHaveBeenCalledWith("/usr/bin/hyprctl", ["-j", "monitors", "all"], signal, 128000, 2000);
  });
  it("requires actual owned local active Wayland login plus fresh compositor state", async () => {
    const native = runtime();
    await expect(readDesktopRemoteDesktopLinuxSessionState(signal, native)).resolves.toBe("unlocked");
    expect(native.execute).toHaveBeenCalledWith("/usr/bin/hyprctl", ["-j", "monitors"], signal, 128000, 2000);
    vi.mocked(native.execute).mockImplementation(async file => file.endsWith("loginctl")
      ? "User=1000\nActive=yes\nRemote=no\nType=wayland\nLockedHint=no\n"
      : JSON.stringify([{ ...monitor, solitaryBlockedBy: ["LOCK"] }]));
    await expect(readDesktopRemoteDesktopLinuxSessionState(signal, native)).resolves.toBe("locked-logged-in");
  });
  it.each(["User=2000", "Active=no", "Remote=yes", "Type=x11"])("rejects %s even when compositor reports unlocked", async invalid => {
    const native = runtime(); const key = invalid.split("=")[0]!;
    vi.mocked(native.execute).mockResolvedValue(`User=1000\nActive=yes\nRemote=no\nType=wayland\nLockedHint=no\n`.replace(new RegExp(`${key}=[^\n]+`, "u"), invalid));
    await expect(readDesktopRemoteDesktopLinuxSessionState(signal, native)).resolves.toBe("unsupported");
    expect(native.execute).toHaveBeenCalledTimes(1);
  });
  it("rejects root, effective UID mismatch and an untrusted system executable before reading", async () => {
    const native = runtime();
    for (const changed of [{ uid: () => 0 }, { effectiveUid: () => 2000 }, { trustedExecutable: async () => false }]) {
      await expect(readDesktopRemoteDesktopLinuxSessionState(signal, { ...native, ...changed })).resolves.toBe("unsupported");
    }
    expect(native.execute).not.toHaveBeenCalled();
  });
  it("does not adopt a missing compositor LOCK proof from LockedHint or environment", async () => {
    const native = runtime(); vi.mocked(native.execute).mockImplementation(async file => file.endsWith("loginctl")
      ? "User=1000\nActive=yes\nRemote=no\nType=wayland\nLockedHint=yes\n"
      : JSON.stringify([{ ...monitor, solitaryBlockedBy: undefined }]));
    await expect(readDesktopRemoteDesktopLinuxSessionState(signal, native)).resolves.toBe("unknown");
  });
  it("admits only unlocked portal viewing and never native capability on generic Wayland", async () => {
    const native = { ...runtime(), environment: { XDG_SESSION_TYPE: "wayland", XDG_SESSION_ID: "4" } };
    expect(supportsDesktopRemoteDesktopLinuxCapture(native)).toBe(false);
    await expect(readDesktopRemoteDesktopLinuxSessionState(signal, native)).resolves.toBe("unlocked");
    vi.mocked(native.execute).mockResolvedValue("User=1000\nActive=yes\nRemote=no\nType=wayland\nLockedHint=yes\n");
    await expect(readDesktopRemoteDesktopLinuxSessionState(signal, native)).resolves.toBe("unsupported");
  });
  it("admits a fresh owned X11 desktop without compositor or native capture authority", async () => {
    const native = { ...runtime(), environment: { XDG_SESSION_TYPE: "x11", XDG_SESSION_ID: "4",
      DISPLAY: ":0", HYPRLAND_INSTANCE_SIGNATURE: "stale" } };
    vi.mocked(native.execute).mockResolvedValue("User=1000\nActive=yes\nRemote=no\nType=x11\nLockedHint=no\n");
    expect(supportsDesktopRemoteDesktopLinuxCapture(native)).toBe(false);
    await expect(readDesktopRemoteDesktopLinuxSessionState(signal, native)).resolves.toBe("unlocked");
    expect(native.execute).toHaveBeenCalledOnce();
    expect(native.execute).toHaveBeenCalledWith("/usr/bin/loginctl", ["show-session", "4", "-p", "User", "-p", "Active",
      "-p", "Remote", "-p", "Type", "-p", "LockedHint"], signal, 4096, 2000);
    vi.mocked(native.execute).mockResolvedValue("User=1000\nActive=yes\nRemote=no\nType=x11\nLockedHint=yes\n");
    await expect(readDesktopRemoteDesktopLinuxSessionState(signal, native)).resolves.toBe("unsupported");
    await expect(readDesktopRemoteDesktopLinuxLockSessionState(signal, native)).resolves.toBe("unsupported");
  });
  it.each(["User=2000", "Active=no", "Remote=yes", "Type=wayland", "LockedHint=unknown"])(
    "rejects X11 session %s without reading compositor state", async invalid => {
      const native = { ...runtime(), environment: { XDG_SESSION_TYPE: "x11", XDG_SESSION_ID: "4", DISPLAY: ":0" } };
      const key = invalid.split("=")[0]!;
      vi.mocked(native.execute).mockResolvedValue("User=1000\nActive=yes\nRemote=no\nType=x11\nLockedHint=no\n"
        .replace(new RegExp(`${key}=[^\n]+`, "u"), invalid));
      await expect(readDesktopRemoteDesktopLinuxSessionState(signal, native)).resolves.toBe("unsupported");
      expect(native.execute).toHaveBeenCalledOnce();
    });
  it("uses logind's locked receipt only for an owned portal terminal lock", async () => {
    const native = { ...runtime(), environment: { XDG_SESSION_TYPE: "wayland", XDG_SESSION_ID: "4" } };
    vi.mocked(native.execute).mockResolvedValue("User=1000\nActive=yes\nRemote=no\nType=wayland\nLockedHint=yes\n");
    await expect(readDesktopRemoteDesktopLinuxLockSessionState(signal, native)).resolves.toBe("locked-logged-in");
    await expect(readDesktopRemoteDesktopLinuxSessionState(signal, native)).resolves.toBe("unsupported");
    vi.mocked(native.execute).mockResolvedValue("User=2000\nActive=yes\nRemote=no\nType=wayland\nLockedHint=yes\n");
    await expect(readDesktopRemoteDesktopLinuxLockSessionState(signal, native)).resolves.toBe("unsupported");
  });
  it("does not adopt an actual probe received after abort", async () => {
    const native = runtime(); const canceled = new AbortController();
    vi.mocked(native.execute).mockImplementation(async () => { canceled.abort(new Error("retired")); return ""; });
    await expect(readDesktopRemoteDesktopLinuxSessionState(canceled.signal, native)).rejects.toThrow("retired");
  });
  it("projects rotated HiDPI outputs into the complete layout including negative origins", async () => {
    const native = runtime(); const rotated = { ...monitor, name: "DP-2", x: 0, y: -960, transform: 1 };
    vi.mocked(native.execute).mockResolvedValue(JSON.stringify([monitor, rotated]));
    const monitors = await readDesktopRemoteDesktopLinuxMonitors(signal, native);
    expect(monitors.map(linuxRemoteDesktopDisplay)).toEqual([
      { id: "hyprland:DP-1", name: "DP-1", width: 960, height: 540 },
      { id: "hyprland:DP-2", name: "DP-2", width: 540, height: 960 }
    ]);
    const point = linuxRemoteDesktopInputMapping(monitors, "hyprland:DP-2")(0, 0);
    expect(point).toEqual({ x: 960 / 1500, y: 0 });
    expect(() => linuxRemoteDesktopInputMapping(monitors, "hyprland:missing")).toThrow("DISPLAY_MISSING");
  });
  it.each([[], [{ ...monitor, name: "../../file" }], [{ ...monitor, scale: 0 }], [monitor, monitor]].map(value => ({ value })))
    ("refuses invalid catalog $value", async ({ value }) => {
    const native = runtime(); vi.mocked(native.execute).mockResolvedValue(JSON.stringify(value));
    await expect(readDesktopRemoteDesktopLinuxMonitors(signal, native)).rejects.toThrow("DISPLAY_MISSING");
  });
});
describe("Linux actual registry probes", () => {
  it("uses only bounded fixed input/cursor commands and accepts exact ready", async () => {
    const native: DesktopRemoteDesktopLinuxHelperRuntime = { supported: () => true, resolveBinary: vi.fn(async kind => `/trusted/${kind}`), execute: vi.fn(async () => "ready\n") };
    await expect(readDesktopRemoteDesktopLinuxInputSupport(signal, native)).resolves.toBe(true);
    await expect(readDesktopRemoteDesktopLinuxCursorSupport(signal, native)).resolves.toBe(true);
    expect(native.execute).toHaveBeenNthCalledWith(1, "/trusted/input", "--check", signal);
    expect(native.execute).toHaveBeenNthCalledWith(2, "/trusted/capture", "--cursor-check", signal);
    vi.mocked(native.execute).mockResolvedValue("unsupported");
    await expect(readDesktopRemoteDesktopLinuxInputSupport(signal, native)).resolves.toBe(false);
  });
  it("does not create input devices or resolve a helper on an unsupported route", async () => {
    const native: DesktopRemoteDesktopLinuxHelperRuntime = { supported: () => false, resolveBinary: vi.fn(), execute: vi.fn() };
    await expect(readDesktopRemoteDesktopLinuxInputSupport(signal, native)).resolves.toBe(false);
    expect(native.resolveBinary).not.toHaveBeenCalled();
  });
});
