import { win32 } from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { DESKTOP_CHANNELS, type DesktopLoginItemState } from "./channels.js";

interface LoginItemApplication {
  readonly isPackaged: boolean;
  getLoginItemSettings(options: { readonly path?: string; readonly args?: string[] }): {
    readonly openAtLogin: boolean;
    readonly status?: string;
    readonly launchItems?: readonly { readonly name: string; readonly scope: string; readonly args: readonly string[]; readonly enabled: boolean }[];
  };
  setLoginItemSettings(options: { readonly openAtLogin: boolean; readonly path?: string; readonly args?: string[]; readonly name?: string; readonly enabled?: boolean }): void;
}

/** The OS owns this choice. Reading or starting Joko never registers or restores a login item. */
export function createDesktopLoginItemSettings(options: {
  readonly app: LoginItemApplication; readonly platform: string; readonly executable: string;
}) {
  const { app, platform, executable } = options;
  const windows = platform === "win32";
  const name = win32.basename(executable, ".exe");
  // Electron parses the Windows lookup as a command line, while registration quotes the path itself.
  const query = windows ? { path: `"${executable}"`, args: [] as string[] } : {};
  const read = (): DesktopLoginItemState => {
    const unavailableReason = platform !== "win32" && platform !== "darwin" ? "platform"
      : !app.isPackaged ? "development" : undefined;
    if (unavailableReason) return { available: false, enabled: false, requiresApproval: false, unavailableReason };
    try {
      const current = app.getLoginItemSettings(query);
      const enabled = windows ? current.launchItems?.some(item => item.name === name && item.scope === "user"
        && item.args.length === 0 && item.enabled) : current.openAtLogin;
      if (typeof enabled !== "boolean") throw new Error();
      return { available: true, enabled, requiresApproval: !windows && current.status === "requires-approval" };
    } catch { throw new Error("Could not read login startup settings."); }
  };
  const set = (enabled: unknown): DesktopLoginItemState => {
    if (typeof enabled !== "boolean") throw new TypeError("Login startup requires one boolean.");
    if (!read().available) throw new Error("Login startup requires an installed Windows or macOS app.");
    try { app.setLoginItemSettings({ openAtLogin: enabled, ...(windows ? { path: executable, args: [], name, enabled } : {}) }); }
    catch { throw new Error("Could not update login startup settings."); }
    const current = read();
    if (enabled ? !current.enabled && !current.requiresApproval : current.enabled || current.requiresApproval) {
      throw new Error("The system did not apply the login startup setting.");
    }
    return current;
  };
  return { read, set };
}

/** Local trusted application IPC; no service credential or remote-node capability can register startup. */
export function registerDesktopLoginItemIpc(options: Parameters<typeof createDesktopLoginItemSettings>[0] & {
  readonly ipc: Pick<IpcMain, "handle">; readonly assertSource: (event: IpcMainInvokeEvent) => void;
}): void {
  const settings = createDesktopLoginItemSettings(options);
  options.ipc.handle(DESKTOP_CHANNELS.loginItemGet, (event, ...parameters: unknown[]) => {
    options.assertSource(event);
    if (parameters.length !== 0) throw new TypeError("Login startup get does not accept parameters.");
    return settings.read();
  });
  options.ipc.handle(DESKTOP_CHANNELS.loginItemSet, (event, ...parameters: unknown[]) => {
    options.assertSource(event);
    if (parameters.length !== 1) throw new TypeError("Login startup set requires one boolean.");
    return settings.set(parameters[0]);
  });
}
