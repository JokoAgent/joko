import { join } from "node:path";
import { BrowserWindow, ipcMain, clipboard, nativeImage, nativeTheme, screen, type IpcMainInvokeEvent, type WebContents } from "electron";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { RemoteDesktopService, parseDesktopRemoteDesktopViewerOwner, sameDesktopRemoteDesktopViewerOwner,
  type DesktopRemoteDesktopViewerOwner, type DesktopRemoteDesktopViewerState,
  type RemoteDesktopClipboardContentResult, type GetRemoteDesktopLockStateResponse, type RequestRemoteDesktopCredentialsResponse } from "@joko/contracts";
import { DesktopRemoteDesktopViewerConnection } from "./remote-desktop-viewer-connection.js";
import { DesktopRemoteDesktopViewerPresentation } from "./remote-desktop-viewer-presentation.js";
import type { DesktopRemoteDesktopViewerPreferencesStore } from "./remote-desktop-viewer-preferences.js";
import { parseClipboardContent } from "./remote-desktop-clipboard.js";
import { DesktopRemoteDesktopViewerClipboardSync, nativeClipboard, type DesktopViewerSyncClipboard } from "./remote-desktop-viewer-clipboard-sync.js";
import { DesktopRemoteDesktopViewerCredentials, type DesktopViewerCredentialNative } from "./remote-desktop-viewer-credentials.js";
import { isAllowedRemoteDesktopViewerNavigation, remoteDesktopViewerEntryUrl, isAllowedRendererNetworkUrl, type DesktopNavigationPolicy } from "./security.js";

const PREFIX = "joko:remote-desktop-viewer:";
export const REMOTE_DESKTOP_VIEWER_CHANNELS = Object.freeze({ bind: PREFIX + "bind", retire: PREFIX + "retire",
  open: PREFIX + "open", state: PREFIX + "state", ready: PREFIX + "ready", request: PREFIX + "request",
  clipboard: PREFIX + "clipboard", close: PREFIX + "close", closeRequested: PREFIX + "close-requested",
  minimize: PREFIX + "minimize", fullscreen: PREFIX + "fullscreen", preferences: PREFIX + "preferences", resize: PREFIX + "resize",
  retryClipboardSync: PREFIX + "retry-clipboard-sync", credential: PREFIX + "credential" });

interface ViewerBinding {
  readonly source: WebContents;
  readonly owner: DesktopRemoteDesktopViewerOwner;
  readonly target: { readonly deviceId: string; readonly name: string };
  connection: DesktopRemoteDesktopViewerConnection;
  closing: boolean;
  clipboardPending: boolean;
  clipboardAbort?: AbortController;
  readonly clipboard: DesktopViewerSyncClipboard;
  inputRevision: number;
  clipboardSync?: DesktopRemoteDesktopViewerClipboardSync;
  syncSuspensions: number;
  syncExitFailed: boolean;
  credentials?: DesktopRemoteDesktopViewerCredentials;
}

interface ViewerWindow {
  window: BrowserWindow;
  generation: number;
  ready: boolean;
  loading: boolean;
  load: Promise<void>;
  presentation: DesktopRemoteDesktopViewerPresentation;
  disposed: boolean;
  binding?: ViewerBinding;
}

type BoundViewerWindow = ViewerWindow & { readonly binding: ViewerBinding };

/** Independent, credential-free renderer; the current primary document owns its authenticated route. */
export class DesktopRemoteDesktopViewerWindows {
  #owners = new Map<WebContents, DesktopRemoteDesktopViewerOwner>();
  #generations = new Map<WebContents, number>();
  #viewers = new Set<ViewerWindow>();
  #spare?: ViewerWindow;
  constructor(private readonly options: {
    readonly sourceDirectory: string;
    readonly entryUrl: string;
    readonly navigation: DesktopNavigationPolicy;
    readonly assertSource: (event: IpcMainInvokeEvent, occurrence: unknown) => void;
    readonly readAuthKey: (profileId: string) => Promise<string | undefined>;
    readonly preferences: DesktopRemoteDesktopViewerPreferencesStore;
    readonly locale: () => DesktopRemoteDesktopViewerState["locale"];
    readonly quitting: () => boolean;
    readonly syncClipboard?: () => DesktopViewerSyncClipboard;
    readonly credentialNative?: () => DesktopViewerCredentialNative;
    readonly credentialPlatform?: string;
    readonly preloadPath?: string;
    readonly windowPlatform?: NodeJS.Platform;
    readonly onOwnerRetired?: () => void;
  }) {}

  register(): void {
    const c = REMOTE_DESKTOP_VIEWER_CHANNELS;
    ipcMain.handle(c.bind, (event, occurrence: unknown, value: unknown) => {
      this.options.assertSource(event, occurrence);
      if (this.options.quitting()) throw new Error("Desktop is closing.");
      const owner = parseDesktopRemoteDesktopViewerOwner(value);
      if (!isAllowedRendererNetworkUrl(owner.origin)) throw new TypeError("Viewer node origin is unavailable.");
      if (owner.connectionGeneration < (this.#generations.get(event.sender) ?? 0)) throw new Error("Viewer connection retired.");
      this.#generations.set(event.sender, owner.connectionGeneration);
      const previous = this.#owners.get(event.sender);
      if (previous !== undefined && !sameDesktopRemoteDesktopViewerOwner(previous, owner)) this.retireOwner(event.sender);
      this.#owners.set(event.sender, owner);
    });
    ipcMain.handle(c.retire, (event, occurrence: unknown, value: unknown) => {
      this.options.assertSource(event, occurrence);
      const owner = parseDesktopRemoteDesktopViewerOwner(value);
      if (sameDesktopRemoteDesktopViewerOwner(this.#owners.get(event.sender), owner)) this.retireOwner(event.sender);
    });
    ipcMain.handle(c.open, async (event, occurrence: unknown, value: unknown, target: unknown) => {
      this.options.assertSource(event, occurrence);
      if (this.options.quitting()) throw new Error("Desktop is closing.");
      const owner = parseDesktopRemoteDesktopViewerOwner(value);
      if (!sameDesktopRemoteDesktopViewerOwner(owner, this.#owners.get(event.sender))) throw new Error("Viewer connection retired.");
      if (typeof target !== "object" || target === null || Array.isArray(target) ||
        Object.keys(target).sort().join(",") !== "deviceId,name") throw new TypeError("Invalid viewer target.");
      const record = target as Record<string, unknown>;
      if (typeof record["deviceId"] !== "string" || !record["deviceId"] || record["deviceId"].length > 256 ||
        record["deviceId"] === owner.deviceId || typeof record["name"] !== "string" ||
        !record["name"] || record["name"].length > 256 || /[\u0000-\u001f\u007f]/u.test(record["name"])) {
        throw new TypeError("Invalid viewer target.");
      }
      return this.open(event.sender, owner, { deviceId: record["deviceId"], name: record["name"] });
    });
    ipcMain.handle(c.state, (event) => this.state(this.localSender(event)));
    ipcMain.handle(c.ready, (event, generation: unknown) => {
      if (!Number.isSafeInteger(generation) || (generation as number) < 0) throw new TypeError("Invalid viewer generation.");
      const entry = this.localSender(event, generation);
      entry.ready = true; entry.presentation.ready(entry.window); this.publish(entry);
    });
    ipcMain.handle(c.request, (event, generation: unknown, name: unknown, bytes: unknown) => {
      const entry = this.sender(event, generation);
      if (!this.active(entry) || typeof name !== "string" || !(bytes instanceof Uint8Array)) throw new Error("Viewer is inactive.");
      if (name === "getRemoteDesktopLockState" || name === "requestRemoteDesktopCredentials") {
        throw new Error("Native credentials belong to the dedicated viewer owner.");
      }
      if (name === "transferRemoteDesktopClipboardText" || name === "transferRemoteDesktopClipboardContent" ||
        name === "setRemoteDesktopClipboardSync" || name === "getRemoteDesktopClipboardVersion") {
        throw new Error("Clipboard content belongs to the native viewer owner.");
      }
      if (name === "stopRemoteDesktop" && (bytes.byteLength > 100_000 ||
        fromBinary(RemoteDesktopService.method.stopRemoteDesktop.input, bytes).lockScreen)) {
        throw new Error("Lock on exit belongs to the dedicated close owner.");
      }
      const input = name === "sendRemoteDesktopInput" || name === "setRemoteDesktopControl" || name === "setRemoteDesktopHostMute";
      const hostMute = name === "setRemoteDesktopHostMute" ? (() => {
        if (bytes.byteLength > 100_000) throw new TypeError("Invalid host mute request.");
        const value = fromBinary(RemoteDesktopService.method.setRemoteDesktopHostMute.input, bytes).request;
        if (value === undefined) throw new TypeError("Missing host mute request.");
        return value;
      })() : undefined;
      const privacy = name === "setRemoteDesktopPrivacyScreen" ? (() => {
        if (bytes.byteLength > 100_000) throw new TypeError("Invalid privacy screen request.");
        const value = fromBinary(RemoteDesktopService.method.setRemoteDesktopPrivacyScreen.input, bytes).request;
        if (value === undefined) throw new TypeError("Missing privacy screen request.");
        return value;
      })() : undefined;
      if (["setRemoteDesktopDisplayMode", "setRemoteDesktopViewerDisplay", "restoreRemoteDesktopViewerDisplay"].includes(name)) entry.binding.inputRevision++;
      const inputRevision = entry.binding.inputRevision;
      const connection = entry.binding.connection;
      const suspendSync = ["setRemoteDesktopControl", "stopRemoteDesktop", "setRemoteDesktopDisplayMode", "setRemoteDesktopViewerDisplay", "restoreRemoteDesktopViewerDisplay", "startRemoteDesktop"].includes(name);
      if (suspendSync) { entry.binding.syncSuspensions++; entry.binding.clipboardSync?.refresh(); }
      return connection.request(name, bytes, () => {
        if (entry.binding.connection !== connection || !this.active(entry) || entry.generation !== generation ||
          (input && (!entry.window.isFocused() || entry.binding.inputRevision !== inputRevision))) throw new ConnectError("Viewer request authority retired.", Code.Canceled);
        if (hostMute !== undefined && hostMute.enabled !== this.options.preferences.get(entry.binding.owner, entry.binding.target.deviceId).hostMute) {
          throw new ConnectError("Host mute preference changed.", Code.Canceled);
        }
        if (privacy !== undefined) {
          const preferences = this.options.preferences.get(entry.binding.owner, entry.binding.target.deviceId);
          if (privacy.enabled !== preferences.privacyScreen || privacy.lockOnExit !== preferences.lockOnExit) {
            throw new ConnectError("Privacy screen preference changed.", Code.Canceled);
          }
        }
      }).then((reply) => {
        if (name === "startRemoteDesktop" && reply.ok) entry.binding.syncExitFailed = false;
        return reply;
      }).finally(() => {
        if (suspendSync) entry.binding.syncSuspensions--;
        entry.binding.clipboardSync?.refresh();
      });
    });
    ipcMain.handle(c.credential, (event, generation: unknown, action: unknown, enabled: unknown) => {
      if (!Number.isSafeInteger(generation) || (generation as number) < 1) throw new TypeError("Invalid viewer generation.");
      const entry = this.sender(event, generation), connection = entry.binding.connection;
      const check = (): void => {
        if (entry.binding.connection !== connection || entry.generation !== generation || !this.active(entry)) {
          throw new ConnectError("Native credential authority retired.", Code.Canceled);
        }
      };
      check();
      return entry.binding.credentials!.run(connection.caps?.platform, connection.caps?.nativeCredentials === true, action, enabled, check);
    });
    ipcMain.handle(c.clipboard, (event, generation: unknown, action: unknown) => {
      const entry = this.sender(event, generation);
      if (action !== "copy" && action !== "paste") throw new TypeError("Invalid clipboard action.");
      return this.transferClipboard(entry, action);
    });
    ipcMain.handle(c.retryClipboardSync, (event, generation: unknown) => {
      const entry = this.sender(event, generation);
      if (entry.generation !== generation || !this.active(entry) || !entry.window.isFocused() ||
        !entry.binding.connection.lease?.controlling || !this.options.preferences.get(entry.binding.owner, entry.binding.target.deviceId).clipboardSync) {
        throw new Error("Clipboard sync retry authority retired.");
      }
      entry.binding.clipboardSync?.retry();
    });
    ipcMain.handle(c.preferences, async (event, generation: unknown, patch: unknown) => {
      const entry = this.sender(event, generation);
      if (entry.generation !== generation) throw new Error("Viewer document retired.");
      if (patch === undefined) return this.options.preferences.get(entry.binding.owner, entry.binding.target.deviceId);
      if (typeof patch !== "object" || patch === null || Array.isArray(patch) || Object.keys(patch).length !== 1 ||
        Object.entries(patch).some(([key, value]) => !["audio", "hostMute", "lockOnExit", "clipboardSync", "privacyScreen"].includes(key) || typeof value !== "boolean")) {
        throw new TypeError("Invalid viewer preference.");
      }
      const connection = entry.binding.connection;
      const check = (): void => {
        if (entry.binding.connection !== connection || entry.generation !== generation || !this.active(entry)) throw new Error("Viewer preference authority retired.");
      };
      check();
      const value = "audio" in patch
        ? await this.options.preferences.setAudio(entry.binding.owner, entry.binding.target.deviceId, (patch as { audio: boolean }).audio, check)
        : "hostMute" in patch ? await this.options.preferences.setHostMute(entry.binding.owner, entry.binding.target.deviceId, (patch as { hostMute: boolean }).hostMute, check)
        : "lockOnExit" in patch ? await this.options.preferences.setLockOnExit(entry.binding.owner, entry.binding.target.deviceId, (patch as { lockOnExit: boolean }).lockOnExit, check)
        : "clipboardSync" in patch ? await this.options.preferences.setClipboardSync(entry.binding.owner, entry.binding.target.deviceId, (patch as { clipboardSync: boolean }).clipboardSync, check)
        : await this.options.preferences.setPrivacyScreen(entry.binding.owner, entry.binding.target.deviceId, (patch as { privacyScreen: boolean }).privacyScreen, check);
      check(); entry.binding.clipboardSync?.refresh(); this.publish(entry);
      return value;
    });
    ipcMain.handle(c.resize, (event, generation: unknown, width: unknown, height: unknown) => {
      const entry = this.sender(event, generation);
      if (entry.generation !== generation) throw new Error("Viewer document retired.");
      if (![width, height].every((value) => Number.isInteger(value) && (value as number) > 0 && (value as number) <= 32768)) {
        throw new TypeError("Invalid viewer size.");
      }
      if (!this.active(entry)) throw new Error("Viewer is inactive.");
      const connection = entry.binding.connection, window = entry.window;
      const current = (): boolean => entry.binding.connection === connection && entry.generation === generation && this.active(entry);
      const resize = (): void => {
        if (!current()) return;
        const bounds = window.getBounds(), content = window.getContentBounds();
        const area = screen.getDisplayMatching(bounds).workArea;
        const [minWidth = 640, minHeight = 420] = window.getMinimumSize();
        const w = Math.min(area.width, Math.max(minWidth, (width as number) + bounds.width - content.width));
        const h = Math.min(area.height, Math.max(minHeight, (height as number) + bounds.height - content.height));
        window.setBounds({ width: w, height: h,
          x: Math.round(Math.max(area.x, Math.min(area.x + area.width - w, bounds.x + (bounds.width - w) / 2))),
          y: Math.round(Math.max(area.y, Math.min(area.y + area.height - h, bounds.y + (bounds.height - h) / 2))) });
      };
      const restore = (): void => {
        if (!current()) return;
        if (window.isMaximized()) { window.once("unmaximize", () => { setImmediate(resize); }); window.unmaximize(); }
        else resize();
      };
      if (window.isFullScreen()) { window.once("leave-full-screen", () => { setImmediate(restore); }); window.setFullScreen(false); }
      else restore();
    });
    ipcMain.handle(c.close, async (event, generation: unknown) => {
      const entry = this.sender(event, generation);
      if (entry.generation !== generation) throw new Error("Viewer document retired.");
      const connection = entry.binding.connection;
      entry.binding.credentials?.retire();
      const lockScreen = this.active(entry) && connection.caps?.lockOnExit === true &&
        this.options.preferences.get(entry.binding.owner, entry.binding.target.deviceId).lockOnExit;
      const check = (): void => {
        if (entry.binding.connection !== connection || entry.generation !== generation || !connection.current ||
          entry.window.isDestroyed() || (lockScreen && (!entry.ready || !entry.window.isVisible() || entry.window.isMinimized()))) {
          throw new Error("Viewer close authority retired.");
        }
      };
      entry.binding.closing = true;
      entry.binding.clipboardSync?.refresh();
      try { await connection.stop(lockScreen, check); check(); entry.presentation.close(); }
      catch {
        if (entry.binding.connection === connection && entry.generation === generation && !entry.window.isDestroyed()) {
          entry.binding.closing = false; entry.binding.syncExitFailed = true; entry.binding.clipboardSync?.refresh(); this.publish(entry);
        }
        throw new Error("Remote Desktop could not confirm disconnection.");
      }
    });
    ipcMain.handle(c.minimize, (event) => this.sender(event).window.minimize());
    ipcMain.handle(c.fullscreen, (event) => {
      const entry = this.sender(event), window = entry.window;
      entry.presentation.fullscreen(!window.isFullScreen()); return window.isFullScreen();
    });
  }

  private connection(entry: Pick<ViewerBinding, "owner" | "source" | "target">): DesktopRemoteDesktopViewerConnection {
    return new DesktopRemoteDesktopViewerConnection(entry.owner, entry.target.deviceId, {
      current: () => this.options.quitting() || entry.source.isDestroyed() ? undefined : this.#owners.get(entry.source),
      readAuthKey: this.options.readAuthKey
    });
  }

  prewarm(): void {
    if (this.options.quitting()) return;
    if (this.#spare && !this.#spare.disposed && !this.#spare.window.isDestroyed()) return;
    if (this.#spare) this.destroy(this.#spare);
    try { this.#spare = this.createShell(); }
    catch { /* A local preload failure cannot authorize or block a later explicit open. */ }
  }

  private async open(source: WebContents, owner: DesktopRemoteDesktopViewerOwner,
    target: ViewerBinding["target"]): Promise<{ readonly focusedExisting: boolean }> {
    const existing = [...this.#viewers].find((item) => item.binding?.source === source && item.binding.target.deviceId === target.deviceId);
    if (existing !== undefined) {
      const focusedExisting = !existing.window.isDestroyed();
      existing.presentation.open(); this.prewarm(); return { focusedExisting };
    }
    const spare = this.#spare && !this.#spare.window.isDestroyed() ? this.#spare : undefined;
    if (this.#spare && !spare) this.destroy(this.#spare);
    const entry = spare ?? this.createShell();
    this.#spare = undefined;
    try { this.bindShell(entry, source, owner, target); }
    catch (error) { this.destroy(entry); throw error; }
    this.publish(entry);
    entry.presentation.open();
    this.prewarm();
    await entry.load;
    if (entry.disposed || this.options.quitting() || !sameDesktopRemoteDesktopViewerOwner(owner, this.#owners.get(source)) || source.isDestroyed()) {
      this.destroy(entry); throw new Error("Viewer connection retired while opening.");
    }
    return { focusedExisting: spare !== undefined };
  }

  private createShell(): ViewerWindow {
    const window = this.createWindow(null);
    const entry: ViewerWindow = { window, generation: 0, ready: false, loading: true,
      load: Promise.resolve(), disposed: false, presentation: undefined! };
    this.#viewers.add(entry);
    this.attachWindow(entry, window);
    entry.presentation = new DesktopRemoteDesktopViewerPresentation(window, {
      platform: this.options.windowPlatform ?? process.platform,
      current: () => this.current(entry),
      create: () => {
        const replacement = this.createWindow(entry.binding?.target ?? null);
        entry.window = replacement; entry.ready = false; entry.loading = true;
        this.attachWindow(entry, replacement); return replacement;
      },
      created: replacement => { entry.load = this.loadWindow(entry, replacement); },
      retire: () => this.deactivate(entry), changed: () => this.publish(entry)
    });
    entry.presentation.prewarm();
    entry.load = this.loadWindow(entry, window);
    return entry;
  }

  private bindShell(entry: ViewerWindow, source: WebContents, owner: DesktopRemoteDesktopViewerOwner,
    target: ViewerBinding["target"]): void {
    const binding: ViewerBinding = { source, owner, target, connection: this.connection({ source, owner, target }),
      closing: false, clipboardPending: false, inputRevision: 0,
      clipboard: this.options.syncClipboard?.() ?? nativeClipboard(), syncSuspensions: 0, syncExitFailed: false };
    entry.binding = binding; entry.generation++; entry.ready = false;
    entry.window.setTitle(target.name);
    binding.credentials = new DesktopRemoteDesktopViewerCredentials({ native: this.options.credentialNative?.(),
      platform: this.options.credentialPlatform ?? process.platform, owner, target: target.deviceId, locale: this.options.locale,
      theme: () => nativeTheme.shouldUseDarkColors ? "dark" : "light",
      lockState: async (check) => {
        const result = await binding.connection.credentialRequest("getRemoteDesktopLockState", {}, check) as GetRemoteDesktopLockStateResponse;
        if (!result.result) throw new Error("CREDENTIAL_INVALID_MESSAGE");
        return result.result.state;
      },
      remote: async (request, check) => {
        const result = await binding.connection.credentialRequest("requestRemoteDesktopCredentials", { request }, check) as RequestRemoteDesktopCredentialsResponse;
        if (!result.result) throw new Error("CREDENTIAL_INVALID_MESSAGE");
        return result.result;
      }
    });
    binding.clipboardSync = new DesktopRemoteDesktopViewerClipboardSync({
      scope: () => ({ connection: binding.connection, generation: entry.generation, focusRevision: binding.inputRevision,
        desired: this.options.preferences.get(owner, target.deviceId).clipboardSync,
        eligible: this.active(entry) && entry.window.isFocused() && !binding.clipboardPending && binding.syncSuspensions === 0 && !binding.syncExitFailed }),
      changed: () => this.publish(entry), clipboard: binding.clipboard
    });
  }

  private current(entry: ViewerWindow): boolean {
    const binding = entry.binding;
    return !entry.disposed && !this.options.quitting() && (binding === undefined ||
      (!binding.source.isDestroyed() && sameDesktopRemoteDesktopViewerOwner(binding.owner, this.#owners.get(binding.source))));
  }

  private createWindow(target: ViewerBinding["target"] | null): BrowserWindow {
    return new BrowserWindow({ width: 1120, height: 760, minWidth: 640, minHeight: 420,
      title: target?.name ?? "Remote Desktop", show: false, autoHideMenuBar: true,
      ...((this.options.windowPlatform ?? process.platform) === "darwin" ? { titleBarStyle: "hiddenInset" as const } : { frame: false }),
      webPreferences: { preload: this.options.preloadPath ?? join(this.options.sourceDirectory, "remote-desktop-viewer-preload.cjs"),
        contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, sandbox: true,
        webSecurity: true, webviewTag: false, navigateOnDragDrop: false, spellcheck: false } });
  }

  private attachWindow(entry: ViewerWindow, window: BrowserWindow): void {
    const current = (): boolean => !entry.disposed && entry.window === window && !window.isDestroyed();
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const allowed = (value: string): boolean => isAllowedRemoteDesktopViewerNavigation(value, this.options.navigation);
    window.webContents.on("will-navigate", (event, url) => { if (!allowed(url)) event.preventDefault(); });
    window.webContents.on("will-redirect", (event, url) => { if (!allowed(url)) event.preventDefault(); });
    window.webContents.on("page-title-updated", (event) => event.preventDefault());
    window.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
      if (current() && !inPlace && mainFrame) { entry.loading = true; entry.ready = false; entry.presentation.reload(window); }
    });
    window.webContents.on("did-finish-load", () => { if (current()) { entry.loading = false; entry.presentation.loaded(window); } });
    window.webContents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
      if (current() && mainFrame && code !== -3) entry.presentation.failed(window);
    });
    window.webContents.on("render-process-gone", () => { if (current()) entry.presentation.failed(window); });
    window.on("blur", () => {
      if (!current() || entry.binding === undefined) return;
      entry.binding.inputRevision++;
      entry.binding.clipboardAbort?.abort();
      entry.binding.clipboardSync?.refresh();
      const lease = entry.binding.connection.lease;
      if (!entry.binding.closing && lease?.controlling) void entry.binding.connection.call("setRemoteDesktopControl", { leaseId: lease.leaseId, enabled: false }).catch(() => undefined);
    });
    window.on("focus", () => { if (current()) entry.binding?.clipboardSync?.refresh(); });
    window.on("close", (event) => {
      if (!current() || entry.binding?.closing || this.options.quitting()) return;
      event.preventDefault();
      if (entry.binding === undefined || !entry.ready) { this.destroy(entry); return; }
      window.webContents.send(REMOTE_DESKTOP_VIEWER_CHANNELS.closeRequested, entry.generation);
    });
  }

  private async loadWindow(entry: ViewerWindow, window: BrowserWindow): Promise<void> {
    try { await window.loadURL(remoteDesktopViewerEntryUrl(this.options.entryUrl)); }
    catch { if (!entry.disposed && entry.window === window) entry.presentation.failed(window); }
  }

  private active(entry: ViewerWindow): boolean {
    return entry.binding !== undefined && entry.ready && !entry.loading && entry.presentation.active &&
      entry.binding.connection.current && !entry.binding.closing && !entry.window.isDestroyed() &&
      entry.window.isVisible() && !entry.window.isMinimized();
  }
  private state(entry: ViewerWindow): DesktopRemoteDesktopViewerState {
    const binding = entry.binding;
    if (binding === undefined) return { generation: 0, active: false, target: null, locale: this.options.locale(),
      audio: true, hostMute: false, lockOnExit: false, clipboardSync: false, privacyScreen: false,
      clipboardSyncState: { available: false, active: false, pending: false } };
    const preferences = this.options.preferences.get(binding.owner, binding.target.deviceId);
    return { generation: entry.generation, active: this.active(entry), target: binding.target, locale: this.options.locale(), ...preferences,
      clipboardSyncState: binding.clipboardSync?.snapshot ?? { available: false, active: false, pending: false } };
  }
  private publish(entry: ViewerWindow): void {
    if (!entry.disposed && !entry.binding?.closing && !entry.window.isDestroyed()) entry.window.webContents.send(REMOTE_DESKTOP_VIEWER_CHANNELS.state, this.state(entry));
  }
  private deactivate(entry: ViewerWindow): void {
    const binding = entry.binding;
    if (binding === undefined) { this.destroy(entry); return; }
    binding.clipboardAbort?.abort();
    binding.credentials?.retire();
    binding.connection.retire(); binding.connection = this.connection(binding);
    binding.closing = false; binding.syncExitFailed = false; entry.generation++; binding.clipboardSync?.refresh(); this.publish(entry);
  }
  private localSender(event: IpcMainInvokeEvent, generation?: unknown): ViewerWindow {
    const entry = [...this.#viewers].find((item) => !item.window.isDestroyed() && item.window.webContents === event.sender);
    if (entry === undefined || !this.current(entry) || entry.binding?.closing ||
      (entry.binding !== undefined && !entry.binding.connection.current) || event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame.url !== remoteDesktopViewerEntryUrl(this.options.entryUrl) ||
      (generation !== undefined && generation !== entry.generation)) throw new Error("Viewer document retired.");
    return entry;
  }
  private sender(event: IpcMainInvokeEvent, generation?: unknown): BoundViewerWindow {
    const entry = this.localSender(event, generation);
    if (entry.binding === undefined) throw new Error("Viewer document is unbound.");
    return entry as BoundViewerWindow;
  }
  private destroy(entry: ViewerWindow): void {
    if (entry.disposed) return;
    entry.disposed = true;
    if (this.#spare === entry) this.#spare = undefined;
    const binding = entry.binding;
    if (binding !== undefined) {
      binding.clipboardAbort?.abort(); binding.credentials?.retire();
      binding.closing = true; binding.clipboardSync?.retire(); binding.connection.retire();
    }
    this.#viewers.delete(entry); entry.presentation.dispose();
  }
  retireSource(source: WebContents): void {
    this.#generations.delete(source);
    this.retireOwner(source);
  }
  refreshLocale(): void { for (const entry of this.#viewers) this.publish(entry); }
  private retireOwner(source: WebContents): void {
    if (this.#owners.has(source)) this.options.onOwnerRetired?.();
    this.#owners.delete(source);
    for (const entry of [...this.#viewers]) if (entry.binding === undefined || entry.binding.source === source) this.destroy(entry);
  }
  dispose(): void { for (const entry of [...this.#viewers]) this.destroy(entry); this.#owners.clear(); this.#generations.clear(); }

  private async transferClipboard(entry: BoundViewerWindow, action: "copy" | "paste"): Promise<void> {
    const connection = entry.binding.connection;
    const lease = connection.lease;
    const generation = entry.generation;
    const inputRevision = entry.binding.inputRevision;
    const check = (): void => {
      if (entry.binding.connection !== connection || entry.generation !== generation || !this.active(entry) ||
        entry.binding.inputRevision !== inputRevision ||
        !entry.window.isFocused() || lease === undefined || !lease.controlling ||
        connection.lease?.controlGeneration !== lease.controlGeneration) throw new Error("Clipboard authority retired.");
    };
    check();
    if (entry.binding.clipboardPending) throw new Error("Clipboard transfer already pending.");
    entry.binding.clipboardPending = true;
    const abort = new AbortController(); entry.binding.clipboardAbort = abort;
    const current = (): boolean => {
      try { check(); return !abort.signal.aborted; } catch { return false; }
    };
    const localRead = async (): Promise<ReturnType<typeof parseClipboardContent>> => {
      if (!entry.binding.clipboard.available) throw new Error("Clipboard unavailable.");
      const data = await entry.binding.clipboard.read(current, abort.signal); check();
      return parseClipboardContent(JSON.parse(data));
    };
    const localWrite = async (content: ReturnType<typeof parseClipboardContent>): Promise<void> => {
      if (!entry.binding.clipboard.available) throw new Error("Clipboard unavailable.");
      const version = await entry.binding.clipboard.version(abort.signal, current); check();
      await entry.binding.clipboard.write(JSON.stringify(content), version, current, abort.signal); check();
    };
    let transferId: string | undefined;
    const call = async (payload: object): Promise<RemoteDesktopClipboardContentResult> => {
      check();
      const method = RemoteDesktopService.method.transferRemoteDesktopClipboardContent;
      const reply = await connection.request(method.localName, toBinary(method.input, create(method.input, {
        transfer: { leaseId: lease!.leaseId, controlGeneration: lease!.controlGeneration, ...payload }
      })), check);
      check();
      if (!reply.ok) throw new Error("Clipboard transfer failed.");
      const result = fromBinary(method.output, reply.bytes).result;
      if (result === undefined) throw new Error("Clipboard result missing.");
      return result;
    };
    try {
      await entry.binding.clipboardSync?.pause(); check();
      if (!connection.caps?.clipboardContent) {
        if (!connection.caps?.clipboardText) throw new Error("Clipboard unavailable.");
        const method = RemoteDesktopService.method.transferRemoteDesktopClipboardText;
        const local = action === "paste" && entry.binding.clipboard.platform === "linux" ? await localRead() : undefined;
        const text = action === "paste" ? local === undefined ? clipboard.readText() : local.text ?? local.url : undefined;
        if (action === "paste" && (text === undefined || !text.length || text.length > 16384 || text.includes("\0"))) throw new Error("Clipboard text unavailable.");
        const reply = await connection.request(method.localName, toBinary(method.input, create(method.input, { transfer: {
          leaseId: lease!.leaseId, controlGeneration: lease!.controlGeneration,
          action: action === "copy" ? { case: "copy", value: {} } : { case: "paste", value: { text: text! } }
        } })), check);
        check(); if (!reply.ok) throw new Error("Clipboard transfer failed.");
        const copied = fromBinary(method.output, reply.bytes).result?.text;
        if (action === "copy") {
          if (!copied || copied.length > 16384 || copied.includes("\0")) throw new Error("Clipboard text unavailable.");
          if (entry.binding.clipboard.platform === "linux") await localWrite({ text: copied });
          else clipboard.writeText(copied);
        }
        return;
      }
      if (action === "copy") {
        const started = await call({ action: { case: "copy", value: {} } });
        transferId = started.transferId;
        if (!transferId || !started.length || started.length > 32 * 1024 * 1024) throw new Error("Invalid clipboard transfer.");
        let data = "";
        while (data.length < started.length) {
          const part = await call({ action: { case: "read", value: { transferId, offset: data.length } } });
          if (!part.data || part.data.length > 65536 || data.length + part.data.length > started.length) throw new Error("Invalid clipboard chunk.");
          data += part.data;
        }
        let content: ReturnType<typeof parseClipboardContent>;
        try { content = parseClipboardContent(JSON.parse(data)); } catch { throw new Error("Clipboard content invalid."); }
        check();
        if (entry.binding.clipboard.platform === "linux") { await localWrite(content); return; }
        const image = content.png === undefined ? undefined : nativeImage.createFromBuffer(Buffer.from(content.png, "base64"));
        if (image?.isEmpty()) throw new Error("Clipboard image invalid.");
        clipboard.write({ ...((content.text ?? content.url) === undefined ? {} : { text: content.text ?? content.url }),
          ...(content.html === undefined ? {} : { html: content.html }),
          ...(content.rtf === undefined ? {} : { rtf: content.rtf }), ...(image === undefined ? {} : { image }) });
      } else {
        let content: ReturnType<typeof parseClipboardContent>;
        if (entry.binding.clipboard.platform === "linux") content = await localRead();
        else {
          const fileBacked = clipboard.availableFormats().some((format) => /file-url|filenames|hdrop|filecontents|filegroupdescriptor|uri-list/iu.test(format));
          const image = clipboard.readImage();
          const raw = { ...(fileBacked ? {} : {
            ...(clipboard.readText() ? { text: clipboard.readText() } : {}),
            ...(clipboard.readHTML() ? { html: clipboard.readHTML() } : {}),
            ...(clipboard.readRTF() ? { rtf: clipboard.readRTF() } : {}) }),
            ...(image.isEmpty() ? {} : { png: image.toPNG().toString("base64") }) };
          content = parseClipboardContent(raw);
        }
        const data = JSON.stringify(content);
        const started = await call({ action: { case: "begin", value: { length: data.length } } });
        transferId = started.transferId;
        if (!transferId) throw new Error("Clipboard transfer missing.");
        for (let offset = 0; offset < data.length; offset += 65536) {
          await call({ action: { case: "write", value: { transferId, offset, data: data.slice(offset, offset + 65536) } } });
        }
        await call({ action: { case: "commit", value: { transferId } } });
      }
    } finally {
      if (transferId && connection.current) {
        await call({ action: { case: "cancel", value: { transferId } } }).catch(() => undefined);
      }
      entry.binding.clipboardPending = false;
      if (entry.binding.clipboardAbort === abort) entry.binding.clipboardAbort = undefined;
      entry.binding.clipboardSync?.refresh(true);
    }
  }
}
