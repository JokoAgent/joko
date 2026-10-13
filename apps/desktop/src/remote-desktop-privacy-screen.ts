import { app, BrowserWindow, dialog, screen, session } from "electron";

import { watchDesktopRemoteDesktopPrivacyInput, type PrivacyInputMonitor } from "./remote-desktop-privacy-input.js";

interface MaskOwner {
  readonly token: object;
  readonly current: () => boolean;
  readonly signal: AbortSignal;
  readonly windows: BrowserWindow[];
  monitor?: PrivacyInputMonitor;
  starting?: Promise<PrivacyInputMonitor>;
  confirming: boolean;
  ready: boolean;
  localPending: boolean;
  generation: number;
}

export interface DesktopRemoteDesktopPrivacyScreenDependencies {
  excluded(owner: object, ids: readonly number[]): void;
  cleared(owner: object): void;
  prepare(owner: object, displayId: string, current: () => boolean, signal: AbortSignal): Promise<void>;
  stopped(owner: object): Promise<void>;
  suspendInput(current: () => boolean, signal: AbortSignal): Promise<() => Promise<void>>;
  watchInput?: typeof watchDesktopRemoteDesktopPrivacyInput;
}

/** Ephemeral passive physical masks. No product preload, persistent data or network. */
export class DesktopRemoteDesktopPrivacyScreen {
  readonly #dependencies: DesktopRemoteDesktopPrivacyScreenDependencies;
  #owner: MaskOwner | undefined;
  readonly #retiring = new Map<object, Promise<void>>();
  #partitionConfigured = false;

  constructor(dependencies: DesktopRemoteDesktopPrivacyScreenDependencies) { this.#dependencies = dependencies; }
  get active(): boolean { return this.#owner !== undefined; }

  #valid(owner: MaskOwner, generation = owner.generation): boolean {
    return this.#owner === owner && owner.generation === generation && owner.current() && !owner.signal.aborted;
  }

  async #disconnect(owner: MaskOwner, generation: number): Promise<void> {
    if (!this.#valid(owner, generation)) return;
    const ending = ++owner.generation;
    try {
      // Keep physical coverage and capture exclusions until actual hook removal
      // and the captured lease's terminal lock/stop have completed.
      await owner.monitor?.stop();
      if (!this.#valid(owner, ending)) return;
      await this.#dependencies.stopped(owner.token);
    } catch { /* The old lease remains terminal even if its lock failed. */ }
    finally { if (this.#owner === owner && owner.generation === ending) await this.release(owner.token); }
  }

  async #confirmExit(owner: MaskOwner, window: BrowserWindow, generation: number): Promise<void> {
    if (owner.confirming || !this.#valid(owner, generation) || window.isDestroyed()) return;
    owner.confirming = true;
    let resumeInput: (() => Promise<void>) | undefined;
    try {
      resumeInput = await this.#dependencies.suspendInput(() => this.#valid(owner, generation), owner.signal);
      if (!this.#valid(owner, generation) || owner.monitor === undefined) return;
      await owner.monitor.confirm();
      if (!this.#valid(owner, generation)) return;
      window.setFocusable(true);
      window.setIgnoreMouseEvents(false);
      app.focus({ steal: true });
      window.focus();
      const labels = privacyLabels(app.getLocale());
      const { response } = await dialog.showMessageBox(window, {
        type: "question", title: "Joko", message: labels.title, detail: labels.detail,
        buttons: [labels.cancel, labels.disconnect], defaultId: 0, cancelId: 0, noLink: true
      });
      if (response === 1 && this.#valid(owner, generation)) {
        resumeInput = undefined;
        await this.#disconnect(owner, generation);
      }
    } catch {
      if (this.#valid(owner, generation)) {
        resumeInput = undefined;
        await this.#disconnect(owner, generation);
      }
    } finally {
      if (this.#valid(owner, generation)) {
        window.setIgnoreMouseEvents(true);
        window.setFocusable(false);
        try {
          // Restore the remote helper while injected input is still fenced.
          await resumeInput?.();
          resumeInput = undefined;
          if (this.#valid(owner, generation)) {
            owner.confirming = false;
            await owner.monitor?.resume();
          }
        } catch { if (this.#valid(owner, generation)) await this.#disconnect(owner, generation); }
      }
      await resumeInput?.();
    }
  }

  async set(token: object, displayId: string, current: () => boolean, signal: AbortSignal): Promise<void> {
    await Promise.all(this.#retiring.values());
    if (!current() || signal.aborted) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
    if (this.#owner !== undefined) {
      if (this.#owner.token === token) return;
      throw new Error("REMOTE_DESKTOP_PRIVACY_FAILED");
    }
    const owner: MaskOwner = { token, current, signal, windows: [], confirming: false, ready: false, localPending: false, generation: 1 };
    this.#owner = owner;
    const generation = owner.generation;
    const partition = session.fromPartition("joko-remote-desktop-privacy", { cache: false });
    if (!this.#partitionConfigured) {
      partition.setPermissionCheckHandler(() => false);
      partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      partition.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("data:") }));
      this.#partitionConfigured = true;
    }
    const displays = screen.getAllDisplays();
    const abort = () => { void this.release(token); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      for (const display of displays) {
        const window = new BrowserWindow({
          ...display.bounds, show: false, frame: false, roundedCorners: false,
          enableLargerThanScreen: true, acceptFirstMouse: true, focusable: false,
          resizable: false, movable: false, minimizable: false, maximizable: false,
          fullscreenable: false, skipTaskbar: true, hasShadow: false, backgroundColor: "#000000",
          webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false,
            nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webSecurity: true,
            allowRunningInsecureContent: false, experimentalFeatures: false, plugins: false,
            navigateOnDragDrop: false, devTools: false }
        });
        owner.windows.push(window);
        const relayout = (_event: unknown, changed: Electron.Display): void => {
          if (window.isDestroyed() || changed.id !== display.id) return;
          try { window.setBounds(changed.bounds, false); }
          catch { void this.#disconnect(owner, generation); }
        };
        screen.on("display-metrics-changed", relayout);
        window.on("closed", () => {
          screen.removeListener("display-metrics-changed", relayout);
          void this.#disconnect(owner, generation);
        });
        window.setMenuBarVisibility(false);
        const labels = privacyLabels(app.getLocale());
        await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(privacyHtml(labels.status, labels.hint))}`);
        if (!this.#valid(owner, generation)) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-navigate", (event) => event.preventDefault());
        window.webContents.on("render-process-gone", () => { void this.#disconnect(owner, generation); });
        window.setContentProtection(true);
        window.setIgnoreMouseEvents(true);
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        window.setAlwaysOnTop(true, "screen-saver", 1);
      }
      if (!this.#valid(owner, generation)) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
      const ids = owner.windows.map((window) => Number(window.getMediaSourceId().split(":")[1]));
      if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("REMOTE_DESKTOP_PRIVACY_FAILED");
      this.#dependencies.excluded(token, ids);
      owner.starting = (this.#dependencies.watchInput ?? watchDesktopRemoteDesktopPrivacyInput)(
        () => {
          if (!this.#valid(owner, generation)) return;
          if (owner.ready) void this.#confirmExit(owner, owner.windows[0]!, generation);
          else owner.localPending = true;
        },
        () => { void this.#disconnect(owner, generation); }, signal
      );
      const monitor = await owner.starting;
      owner.monitor = monitor;
      if (!this.#valid(owner, generation)) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
      for (const [index, window] of owner.windows.entries()) {
        const target = screen.getAllDisplays().find((display) => display.id === displays[index]?.id)?.bounds;
        if (target === undefined) throw new Error("REMOTE_DESKTOP_PRIVACY_FAILED");
        window.showInactive();
        window.setBounds(target, false);
      }
      await this.#dependencies.prepare(token, displayId, () => this.#valid(owner, generation), signal);
      if (!this.#valid(owner, generation)) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
      owner.ready = true;
      if (owner.localPending) setImmediate(() => { void this.#confirmExit(owner, owner.windows[0]!, generation); });
    } catch (error) {
      await this.release(token);
      throw error;
    } finally { signal.removeEventListener("abort", abort); }
  }

  release(token: object): Promise<void> {
    const pending = this.#retiring.get(token);
    if (pending !== undefined) return pending;
    const owner = this.#owner;
    if (owner?.token !== token) return Promise.resolve();
    owner.generation += 1;
    this.#owner = undefined;
    const restore = (async () => {
      const monitor = owner.monitor ?? await owner.starting?.catch(() => undefined);
      await monitor?.stop();
      for (const window of owner.windows) if (!window.isDestroyed()) window.destroy();
      this.#dependencies.cleared(token);
    })();
    this.#retiring.set(token, restore);
    void restore.then(() => { if (this.#retiring.get(token) === restore) this.#retiring.delete(token); }, () => undefined);
    return restore;
  }
}

function privacyHtml(status: string, hint: string): string {
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{margin:0;width:100%;height:100%;background:#000;color:#fff}body{display:grid;place-content:center;text-align:center;font-family:system-ui;padding:32px;box-sizing:border-box}h1{font-size:28px}p{font-size:16px;color:#bbb}</style></head><body><h1>Joko</h1><p>${escape(status)}</p><p>${escape(hint)}</p></body></html>`;
}

function privacyLabels(locale: string) {
  const chinese = locale.toLowerCase().startsWith("zh");
  return chinese ? { status: "此屏幕已隐藏，远程查看仍在继续。", hint: "按键或点击以断开远程查看。", title: "断开远程查看？", detail: "断开后此屏幕将恢复显示。若已启用退出锁屏，系统也将锁定。", cancel: "取消", disconnect: "断开" }
    : { status: "This screen is hidden while remote viewing continues.", hint: "Press a key or click to disconnect remote viewing.", title: "Disconnect remote viewing?", detail: "Disconnecting restores this screen. The system also locks if lock on exit is enabled.", cancel: "Cancel", disconnect: "Disconnect" };
}
