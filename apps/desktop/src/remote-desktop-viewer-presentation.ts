import type { BrowserWindow } from "electron";

const OPEN_TIMEOUT_MS = 5_000;
const RECOVERY_STABILITY_MS = 30_000;
const LEAVE_TIMEOUT_MS = 2_000;
const MAX_AUTOMATIC_RECOVERY_ATTEMPTS = 1;

/** Local shell readiness and native visibility never depend on a remote first frame. */
export class DesktopRemoteDesktopViewerPresentation {
  #window?: BrowserWindow;
  #ready = false;
  #loading = true;
  #visible = false;
  #pendingOpen = false;
  #disposed = false;
  #automaticRecoveryAttempts = 0;
  #visibilityGeneration = 0;
  #enteringNativeFullscreen = false;
  #nativeFullscreenTarget?: boolean;
  #hiding = false;
  #openTimer?: ReturnType<typeof setTimeout>;
  #stabilityTimer?: ReturnType<typeof setTimeout>;
  #leaveTimer?: ReturnType<typeof setTimeout>;
  #leaveListener?: () => void;

  constructor(window: BrowserWindow, private readonly deps: {
    readonly create: () => BrowserWindow;
    readonly created: (window: BrowserWindow) => void;
    readonly current: () => boolean;
    readonly retire: (deferNativeCleanup?: boolean) => void;
    readonly changed: () => void;
    readonly platform: NodeJS.Platform;
    readonly observeNativeCleanup?: (stage: string) => void;
  }) { this.#window = window; this.#bind(window); }

  get active(): boolean { return this.#visible && !this.#disposed; }
  owns(window: BrowserWindow): boolean { return this.#window === window && !this.#disposed; }
  #current(window: BrowserWindow): boolean {
    return this.owns(window) && !window.isDestroyed() && this.deps.current();
  }

  prewarm(): void {
    if (!this.#disposed && this.deps.current()) this.#ensureWindow();
  }

  open(): void {
    if (this.#disposed || !this.deps.current()) return;
    this.#nativeFullscreenTarget = undefined;
    this.#automaticRecoveryAttempts = 0;
    this.#clearStability(); this.#clearLeave();
    ++this.#visibilityGeneration;
    this.#pendingOpen = true;
    const window = this.#ensureWindow();
    if (!window) return;
    if (this.#ready && !this.#loading) this.#show(window);
    else this.#scheduleOpen(window);
  }

  ready(window: BrowserWindow): void {
    if (!this.#current(window)) return;
    this.#ready = true;
    if (!this.#loading) {
      this.#scheduleStability(window);
      if (this.#pendingOpen) this.#show(window);
    }
  }

  loaded(window: BrowserWindow): void {
    if (!this.#current(window)) return;
    this.#loading = false;
    if (this.#ready) {
      this.#scheduleStability(window);
      if (this.#pendingOpen) this.#show(window);
    }
    this.deps.changed();
  }

  fullscreen(enabled: boolean): void {
    const window = this.#window;
    if (!window || !this.#current(window)) return;
    this.#enteringNativeFullscreen = this.deps.platform === "darwin" && enabled;
    this.#nativeFullscreenTarget = this.deps.platform === "darwin" && this.#visible &&
      (window.isFullScreen() !== enabled || this.#nativeFullscreenTarget !== undefined) ? enabled : undefined;
    window.setFullScreen(enabled);
  }

  reload(window: BrowserWindow): void {
    if (!this.#current(window) || this.#loading) return;
    this.#nativeFullscreenTarget = undefined;
    const reopen = this.#visible || this.#pendingOpen;
    this.#clearOpen(); this.#clearStability(); this.#clearLeave();
    ++this.#visibilityGeneration;
    this.#ready = false; this.#loading = true; this.#visible = false; this.#pendingOpen = reopen;
    this.deps.retire();
    this.#hiding = true;
    if (window.isVisible()) window.hide();
    this.#hiding = false;
    if (reopen) this.#scheduleOpen(window);
  }

  failed(window: BrowserWindow, deferNativeCleanup = false): void {
    this.#observeNativeCleanup("viewer_presentation_failed_entered");
    if (!this.#current(window)) { this.#observeNativeCleanup("viewer_presentation_failed_inactive"); return; }
    this.#nativeFullscreenTarget = undefined;
    const reopen = this.#visible || this.#pendingOpen;
    this.#clearOpen(); this.#clearStability(); this.#clearLeave();
    ++this.#visibilityGeneration;
    this.#ready = false; this.#loading = true; this.#visible = false; this.#pendingOpen = false;
    this.#enteringNativeFullscreen = false;
    this.#window = undefined;
    this.#observeNativeCleanup("viewer_failed_authority_retire_started");
    this.deps.retire(deferNativeCleanup);
    this.#observeNativeCleanup("viewer_failed_authority_retire_completed");
    this.#destroyNativeWindow(window, deferNativeCleanup, "failed");
    if (!reopen || this.#disposed || !this.deps.current()
      || this.#automaticRecoveryAttempts >= MAX_AUTOMATIC_RECOVERY_ATTEMPTS) return;
    ++this.#automaticRecoveryAttempts;
    this.#pendingOpen = true;
    const replacement = this.#ensureWindow();
    if (replacement) this.#scheduleOpen(replacement);
  }

  close(): void {
    const window = this.#window;
    if (!window || !this.#current(window)) return;
    this.#nativeFullscreenTarget = undefined;
    this.#clearOpen(); this.#clearStability(); this.#clearLeave();
    this.#pendingOpen = false; this.#visible = false;
    const generation = ++this.#visibilityGeneration;
    this.deps.retire();
    const hide = (): void => {
      if (!this.#current(window) || generation !== this.#visibilityGeneration) return;
      this.#clearLeave(); ++this.#visibilityGeneration;
      this.#hiding = true;
      if (window.isVisible()) window.hide();
      this.#hiding = false; this.deps.changed();
    };
    if (this.deps.platform === "darwin" && (this.#enteringNativeFullscreen || window.isFullScreen())) {
      this.#leaveListener = hide;
      window.once("leave-full-screen", hide);
      window.setFullScreen(false);
      this.#leaveTimer = setTimeout(hide, LEAVE_TIMEOUT_MS);
      this.#leaveTimer.unref?.();
    } else hide();
  }

  dispose(deferNativeCleanup = false): void {
    this.#observeNativeCleanup("viewer_native_dispose_entered");
    if (this.#disposed) { this.#observeNativeCleanup("viewer_native_dispose_already_disposed"); return; }
    this.#nativeFullscreenTarget = undefined;
    this.#clearOpen(); this.#clearStability(); this.#clearLeave();
    this.#disposed = true; ++this.#visibilityGeneration;
    this.#pendingOpen = false; this.#visible = false; this.#enteringNativeFullscreen = false;
    const window = this.#window; this.#window = undefined;
    if (window) this.#destroyNativeWindow(window, deferNativeCleanup, "dispose");
    this.#observeNativeCleanup("viewer_native_dispose_returned");
  }

  #destroyNativeWindow(window: BrowserWindow, deferred: boolean, source: "failed" | "dispose"): void {
    const destroy = (): void => {
      this.#observeNativeCleanup(`viewer_${source}_native_state_check_started`);
      const destroyed = window.isDestroyed();
      this.#observeNativeCleanup(`viewer_${source}_native_state_check_completed`);
      if (!destroyed) {
        this.#observeNativeCleanup(`viewer_${source}_native_destroy_started`);
        window.destroy();
        this.#observeNativeCleanup(`viewer_${source}_native_destroy_returned`);
      }
    };
    // Authority is already retired. Keep Chromium's gone callback free of
    // native destruction, and retain only the original window for cleanup.
    if (deferred) setImmediate(destroy); else destroy();
  }

  #observeNativeCleanup(stage: string): void {
    try { this.deps.observeNativeCleanup?.(stage); } catch { /* Diagnostics never own native cleanup. */ }
  }

  #ensureWindow(): BrowserWindow | undefined {
    if (this.#window && !this.#window.isDestroyed()) return this.#window;
    let window: BrowserWindow;
    try { window = this.deps.create(); }
    catch { this.#pendingOpen = false; return; }
    this.#window = window; this.#ready = false; this.#loading = true; this.#visible = false;
    this.#bind(window); this.deps.created(window);
    return window;
  }

  #bind(window: BrowserWindow): void {
    window.on("hide", () => this.#hidden(window));
    window.on("minimize", () => this.#hidden(window));
    const shown = (): void => {
      if (!this.#current(window) || !this.#ready || this.#loading) return;
      this.#visible = true; this.deps.changed();
    };
    window.on("show", shown); window.on("restore", shown);
    const fullscreenSettled = (enabled: boolean): void => {
      if (!this.#current(window)) return;
      this.#enteringNativeFullscreen = false;
      if (this.#nativeFullscreenTarget === enabled) this.#nativeFullscreenTarget = undefined;
    };
    window.on("enter-full-screen", () => fullscreenSettled(true));
    window.on("leave-full-screen", () => fullscreenSettled(false));
    window.on("closed", () => {
      if (!this.owns(window)) return;
      this.#clearOpen(); this.#clearStability(); this.#clearLeave();
      this.#window = undefined; this.#ready = false; this.#visible = false; this.#pendingOpen = false;
      this.#nativeFullscreenTarget = undefined;
      this.#enteringNativeFullscreen = false;
      this.deps.retire();
    });
  }

  #hidden(window: BrowserWindow): void {
    if (!this.#current(window) || this.#hiding) return;
    // A requested macOS space transition can notify hide while this exact
    // native window remains visible. Real hide/minimize still retires authority.
    if (this.deps.platform === "darwin" && this.#nativeFullscreenTarget !== undefined &&
      this.#visible && window.isVisible() && !window.isMinimized()) return;
    this.#nativeFullscreenTarget = undefined;
    this.#clearOpen(); this.#clearStability(); this.#clearLeave();
    ++this.#visibilityGeneration;
    const wasActive = this.#visible || this.#pendingOpen;
    this.#visible = false; this.#pendingOpen = false;
    if (wasActive) this.deps.retire();
    else this.deps.changed();
  }

  #show(window: BrowserWindow): void {
    if (!this.#current(window) || !this.#ready) return;
    this.#clearOpen(); this.#clearLeave();
    if (!window.isVisible()) this.#enteringNativeFullscreen = false;
    ++this.#visibilityGeneration;
    this.#pendingOpen = false; this.#visible = true;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus(); this.deps.changed();
  }

  #scheduleOpen(window: BrowserWindow): void {
    this.#clearOpen();
    this.#openTimer = setTimeout(() => {
      this.#openTimer = undefined;
      if (!this.#current(window) || !this.#pendingOpen) return;
      if (this.#ready) this.#show(window);
      else this.failed(window);
    }, OPEN_TIMEOUT_MS);
    this.#openTimer.unref?.();
  }

  #scheduleStability(window: BrowserWindow): void {
    if (this.#automaticRecoveryAttempts === 0 || this.#stabilityTimer !== undefined) return;
    this.#stabilityTimer = setTimeout(() => {
      this.#stabilityTimer = undefined;
      if (this.#current(window) && this.#ready && !this.#loading) this.#automaticRecoveryAttempts = 0;
    }, RECOVERY_STABILITY_MS);
    this.#stabilityTimer.unref?.();
  }

  #clearOpen(): void { clearTimeout(this.#openTimer); this.#openTimer = undefined; }
  #clearStability(): void { clearTimeout(this.#stabilityTimer); this.#stabilityTimer = undefined; }
  #clearLeave(): void {
    clearTimeout(this.#leaveTimer); this.#leaveTimer = undefined;
    if (this.#window && this.#leaveListener) this.#window.removeListener("leave-full-screen", this.#leaveListener);
    this.#leaveListener = undefined;
  }
}
