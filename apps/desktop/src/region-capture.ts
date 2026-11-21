import { BrowserWindow, clipboard, desktopCapturer, dialog, nativeImage, powerMonitor, screen, session, systemPreferences,
  type DesktopCapturerSource, type Display, type IpcMain, type IpcMainInvokeEvent, type NativeImage, type Rectangle, type Session } from "electron";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const MAX_IMAGE_PIXELS = 36_000_000;
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_RECORDING_BYTES = 36 * 1024 * 1024;
const MAX_PINS = 4;
const FREEZE_TIMEOUT = 5_000;
const SELECTION_TIMEOUT = 5 * 60_000;
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type RegionCaptureNode = {
  readonly documentOccurrence: string;
  readonly owner: string;
};

interface CaptureOptions {
  readonly entryUrl: () => string;
  readonly preload: string;
  readonly locale: () => "en" | "zh-CN";
  readonly dark: () => boolean;
  readonly node: () => RegionCaptureNode | undefined;
  readonly installResources: (partition: Session) => void;
  readonly canStopByShortcut: () => boolean;
  readonly deliver: (owner: RegionCaptureNode, file: { id: string; bytes: Uint8Array; name: string }) => boolean;
}

interface CaptureImage {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
}

interface CaptureSurface {
  readonly window: BrowserWindow;
  readonly image: NativeImage;
  readonly mode: "screen" | "pin";
  readonly display?: Display;
  selected?: NativeImage;
  selection?: UnitRect;
  output?: { readonly mode: "scroll" | "gif" | "video"; readonly width: number; readonly height: number };
}

export const REGION_CAPTURE_IPC = {
  read: "joko:region-capture:read", select: "joko:region-capture:select", listWindows: "joko:region-capture:list-windows",
  selectWindow: "joko:region-capture:select-window", action: "joko:region-capture:action", cancel: "joko:region-capture:cancel",
  startLive: "joko:region-capture:live:start", showLive: "joko:region-capture:live:show", endLive: "joko:region-capture:live:end",
  saveRecording: "joko:region-capture:recording:action", stopLive: "joko:region-capture:live:stop"
} as const;

type UnitRect = { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
type LiveMode = "scroll" | "gif" | "video";
interface RegionLiveCapture {
  readonly surface: CaptureSurface;
  readonly mode: LiveMode;
  readonly display: Display;
  readonly microphone: boolean;
  readonly systemAudio: boolean;
  readonly originalBounds: Rectangle;
  readonly controls?: Rectangle;
  grantAvailable: boolean;
}

export function regionCaptureCrop(value: unknown, image: { width: number; height: number }): Rectangle | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const rect = value as UnitRect;
  if (Object.keys(rect).sort().join(",") !== "bottom,left,right,top"
    || ![rect.left, rect.top, rect.right, rect.bottom].every(coordinate => Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1)
    || rect.left >= rect.right || rect.top >= rect.bottom
    || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width <= 0 || image.height <= 0) return undefined;
  const x = Math.floor(rect.left * image.width), y = Math.floor(rect.top * image.height);
  const width = Math.ceil(rect.right * image.width) - x, height = Math.ceil(rect.bottom * image.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

export function validRegionPngHeader(bytes: Uint8Array, expected: { width: number; height: number }): boolean {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return data.byteLength >= 33 && data.byteLength <= MAX_IMAGE_BYTES && data.subarray(0, 8).equals(PNG_HEADER)
    && data.readUInt32BE(8) === 13 && data.toString("ascii", 12, 16) === "IHDR"
    && data.readUInt32BE(16) === expected.width && data.readUInt32BE(20) === expected.height
    && expected.width > 0 && expected.height > 0 && expected.width * expected.height <= MAX_IMAGE_PIXELS;
}

export class DesktopRegionCapture {
  readonly #options: CaptureOptions;
  readonly #surfaces = new Map<number, CaptureSurface>();
  #partition: Session | undefined;
  #node: RegionCaptureNode | undefined;
  #selected: CaptureSurface | undefined;
  #windowChoices = new Map<string, DesktopCapturerSource>();
  #starting = false;
  #generation = 0;
  #deadline: NodeJS.Timeout | undefined;
  #disposed = false;
  #actionPending = false;
  #live: RegionLiveCapture | undefined;

  constructor(options: CaptureOptions) { this.#options = options; }

  register(ipc: IpcMain): void {
    ipc.handle(REGION_CAPTURE_IPC.read, event => {
      const surface = this.#requireSurface(event);
      return { ...captureImage(surface.image), mode: surface.mode, locale: this.#options.locale(), dark: this.#options.dark(),
        attachAvailable: surface.mode === "screen" && this.#ownedNode() !== undefined };
    });
    ipc.handle(REGION_CAPTURE_IPC.select, (event, rectangle: unknown) => {
      const surface = this.#requireScreen(event);
      const crop = regionCaptureCrop(rectangle, surface.image.getSize(1));
      if (!crop) throw new TypeError("The capture region is invalid.");
      const result = this.#select(surface, surface.image.crop(crop));
      surface.selection = rectangle as UnitRect;
      return result;
    });
    ipc.handle(REGION_CAPTURE_IPC.listWindows, event => this.#listWindows(this.#requireScreen(event)));
    ipc.handle(REGION_CAPTURE_IPC.selectWindow, (event, choice: unknown) => {
      const surface = this.#requireScreen(event);
      const source = typeof choice === "string" ? this.#windowChoices.get(choice) : undefined;
      if (!source || source.thumbnail.isEmpty()) throw new Error("The selected window is unavailable.");
      return this.#select(surface, source.thumbnail);
    });
    ipc.handle(REGION_CAPTURE_IPC.action, (event, action: unknown, bytes: unknown) => this.#perform(this.#requireScreen(event), action, bytes));
    ipc.handle(REGION_CAPTURE_IPC.startLive, (event, mode: unknown, microphone: unknown, audio: unknown) =>
      this.#startLive(this.#requireScreen(event), mode, microphone, audio));
    ipc.handle(REGION_CAPTURE_IPC.showLive, event => {
      const live = this.#requireLive(event);
      const window = live.surface.window;
      window.setContentProtection(true);
      if (live.controls === undefined) window.hide();
      else {
        window.setBounds(live.controls, false);
        window.showInactive();
      }
    });
    ipc.handle(REGION_CAPTURE_IPC.endLive, (event, keepOutput: unknown) => {
      const live = this.#requireLive(event);
      if (typeof keepOutput !== "boolean") throw new TypeError("Screen recording outcome is invalid.");
      this.#live = undefined;
      const window = live.surface.window;
      if (!keepOutput) live.surface.output = undefined;
      window.setBounds(live.originalBounds, false);
      window.setContentProtection(false);
      window.show();
    });
    ipc.handle(REGION_CAPTURE_IPC.saveRecording, (event, action: unknown, bytes: unknown) =>
      this.#recordingAction(this.#requireScreen(event), action, bytes));
    ipc.handle(REGION_CAPTURE_IPC.cancel, event => {
      const surface = this.#requireSurface(event);
      if (surface.mode === "pin") surface.window.destroy();
      else this.retireSelection();
    });
    powerMonitor.on("lock-screen", this.#retireAll);
    screen.on("display-added", this.#retireAll);
    screen.on("display-removed", this.#retireAll);
    screen.on("display-metrics-changed", this.#displayChanged);
  }

  async begin(): Promise<void> {
    if (this.#disposed || this.#starting) return;
    const live = this.#live;
    if (live !== undefined && !live.surface.window.isDestroyed()) {
      live.surface.window.webContents.send(REGION_CAPTURE_IPC.stopLive);
      return;
    }
    if (this.#selected !== undefined && !this.#selected.window.isDestroyed()) {
      this.#selected.window.focus();
      return;
    }
    this.retireSelection();
    const generation = this.#generation;
    this.#starting = true;
    this.#node = this.#options.node();
    try {
      const displays = screen.getAllDisplays();
      if (!displays.length) throw new Error("Screen capture is unavailable.");
      const capture = await readSources({ types: ["screen"], thumbnailSize: thumbnailSize(displays) });
      if (generation !== this.#generation || this.#disposed) return;
      const matched = displays.flatMap(display => {
        const source = capture.find(item => item.display_id === String(display.id))
          ?? (capture.length === 1 && displays.length === 1 ? capture[0] : undefined);
        return source === undefined || source.thumbnail.isEmpty() ? [] : [{ display, image: source.thumbnail }];
      });
      if (!matched.length) throw new Error("Screen capture is unavailable.");
      const first = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
      for (const { display, image } of matched) this.#open("screen", image, display.bounds, display, display.id === first);
      this.#deadline = setTimeout(() => this.retireSelection(), SELECTION_TIMEOUT);
    } catch {
      if (generation !== this.#generation || this.#disposed) return;
      this.retireSelection();
      const language = this.#options.locale();
      const denied = process.platform === "darwin" && ["denied", "restricted"].includes(systemPreferences.getMediaAccessStatus("screen"));
      await dialog.showMessageBox({
        type: "info", message: language === "zh-CN" ? "无法截取屏幕" : "Screen capture unavailable",
        detail: denied ? language === "zh-CN" ? "请在系统设置中允许 Joko 录制屏幕，然后重试。" : "Allow Joko to record your screen in System Settings, then retry." : undefined
      });
    } finally {
      this.#starting = false;
    }
  }

  retireSelection(): void {
    this.#generation++;
    if (this.#deadline) clearTimeout(this.#deadline);
    this.#deadline = undefined;
    this.#node = undefined;
    this.#selected = undefined;
    this.#live = undefined;
    this.#windowChoices.clear();
    for (const [id, surface] of this.#surfaces) if (surface.mode === "screen") {
      this.#surfaces.delete(id);
      if (!surface.window.isDestroyed()) surface.window.destroy();
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#retireAll();
    powerMonitor.off("lock-screen", this.#retireAll);
    screen.off("display-added", this.#retireAll);
    screen.off("display-removed", this.#retireAll);
    screen.off("display-metrics-changed", this.#displayChanged);
  }

  #retireAll = (): void => {
    this.retireSelection();
    for (const surface of this.#surfaces.values()) if (!surface.window.isDestroyed()) surface.window.destroy();
    this.#surfaces.clear();
  };

  #displayChanged = (_event: unknown, _display: Display, metrics: string[]): void => {
    if (metrics.some(metric => ["bounds", "scaleFactor", "rotation"].includes(metric))) this.#retireAll();
  };

  #ownedNode(): RegionCaptureNode | undefined {
    const expected = this.#node, current = this.#options.node();
    return expected && current?.owner === expected.owner && current.documentOccurrence === expected.documentOccurrence ? expected : undefined;
  }

  #requireSurface(event: IpcMainInvokeEvent): CaptureSurface {
    const surface = this.#surfaces.get(event.sender.id);
    if (!surface || surface.window.isDestroyed() || surface.window.webContents !== event.sender
      || event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== this.#options.entryUrl()
      || event.sender.getURL() !== this.#options.entryUrl()) throw new Error("Screen capture requires its own trusted window.");
    return surface;
  }

  #requireScreen(event: IpcMainInvokeEvent): CaptureSurface {
    const surface = this.#requireSurface(event);
    if (surface.mode !== "screen" || !surface.window.isFocused() || (this.#selected && this.#selected !== surface)) {
      throw new Error("Screen capture requires the focused selection.");
    }
    return surface;
  }

  #requireLive(event: IpcMainInvokeEvent): RegionLiveCapture {
    const surface = this.#requireSurface(event);
    const live = this.#live;
    if (live === undefined || live.surface !== surface) throw new Error("The selected screen recording is no longer active.");
    return live;
  }

  #startLive(surface: CaptureSurface, mode: unknown, microphone: unknown, systemAudio: unknown) {
    const { display, selection, selected } = surface;
    if ((mode !== "scroll" && mode !== "gif" && mode !== "video") || typeof microphone !== "boolean" || typeof systemAudio !== "boolean"
      || (mode !== "video" && (microphone || systemAudio)) || !display || !selection || !selected || this.#live !== undefined || this.#actionPending) {
      throw new Error("Select one display region before recording.");
    }
    const crop = regionCaptureCrop(selection, display.bounds);
    if (!crop) throw new Error("The display region changed.");
    const controls = regionCaptureControlBounds({ x: display.bounds.x + crop.x, y: display.bounds.y + crop.y, width: crop.width, height: crop.height },
      [display.workArea, ...screen.getAllDisplays().filter(candidate => candidate.id !== display.id).map(candidate => candidate.workArea)]);
    if (controls === undefined && !this.#options.canStopByShortcut()) throw new Error("The capture shortcut or room for recording controls is required.");
    const size = selected.getSize(1);
    const edge = mode === "gif" ? 960 : mode === "video" ? 1920 : 1600;
    const scale = Math.min(1, edge / Math.max(size.width, size.height));
    const width = Math.max(1, Math.round(size.width * scale)), height = Math.max(1, Math.round(size.height * scale));
    surface.output = { mode, width, height };
    this.#live = { surface, mode, display, microphone, systemAudio, originalBounds: surface.window.getBounds(), controls, grantAvailable: true };
    return { selection, width, height, shortcutStops: controls === undefined };
  }

  #select(surface: CaptureSurface, image: NativeImage): CaptureImage {
    const payload = captureImage(image);
    surface.selected = image;
    this.#selected = surface;
    for (const [id, sibling] of this.#surfaces) if (sibling.mode === "screen" && sibling !== surface) {
      this.#surfaces.delete(id);
      sibling.window.destroy();
    }
    this.#windowChoices.clear();
    return payload;
  }

  async #listWindows(surface: CaptureSurface): Promise<readonly { id: string; label: string }[]> {
    if (this.#selected) throw new Error("Finish the current selection first.");
    const generation = this.#generation;
    for (const entry of this.#surfaces.values()) if (entry.mode === "screen") entry.window.hide();
    try {
      const sources = await readSources({ types: ["window"], thumbnailSize: { width: 1920, height: 1080 } });
      if (generation !== this.#generation || surface.window.isDestroyed()) return [];
      this.#windowChoices = new Map(sources.filter(source => !source.thumbnail.isEmpty() && source.name.trim()).slice(0, 48)
        .map(source => [randomUUID(), source]));
      return [...this.#windowChoices].map(([id, source]) => ({ id, label: source.name.trim().slice(0, 160) }));
    } finally {
      if (generation === this.#generation && !surface.window.isDestroyed()) {
        for (const entry of this.#surfaces.values()) if (entry.mode === "screen") entry.window.showInactive();
        surface.window.focus();
      }
    }
  }

  async #perform(surface: CaptureSurface, action: unknown, bytes: unknown): Promise<boolean> {
    if (!surface.selected || this.#actionPending || this.#live || !(bytes instanceof Uint8Array)) throw new Error("The edited capture is unavailable.");
    const expected = surface.output?.mode === "scroll" && bytes.length >= 33
      ? { width: surface.output.width, height: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).readUInt32BE(20) }
      : surface.selected.getSize(1);
    if (!validRegionPngHeader(bytes, expected) || (surface.output?.mode === "scroll" && (expected.height < surface.output.height || expected.height > 16_000))) {
      throw new Error("The edited capture size changed.");
    }
    const edited = nativeImage.createFromBuffer(Buffer.from(bytes));
    if (edited.isEmpty()) throw new Error("The edited capture could not be decoded.");
    const generation = this.#generation;
    this.#actionPending = true;
    try {
      const image = captureImage(edited);
      const name = `Screenshot ${new Date().toISOString().slice(0, 19).replaceAll(":", "-").replace("T", " ")}.png`;
      if (action === "copy") clipboard.writeImage(edited);
      else if (action === "save") {
        const target = await dialog.showSaveDialog(surface.window, { defaultPath: name, filters: [{ name: "PNG", extensions: ["png"] }] });
        if (generation !== this.#generation || target.canceled || !target.filePath) return false;
        await writeFile(target.filePath, image.png);
      } else if (action === "attach") {
        const owner = this.#ownedNode();
        if (owner === undefined || !this.#options.deliver(owner, { id: randomUUID(), bytes: image.png, name })) return false;
      } else if (action === "pin") {
        if ([...this.#surfaces.values()].filter(item => item.mode === "pin").length >= MAX_PINS) return false;
        const display = surface.display ?? screen.getPrimaryDisplay();
        const area = display.workArea;
        const ratio = Math.min(1, area.width / image.width * 0.7, area.height / image.height * 0.7);
        this.#open("pin", edited, { x: area.x + 30, y: area.y + 30, width: Math.max(160, Math.round(image.width * ratio)),
          height: Math.max(96, Math.round(image.height * ratio)) }, undefined, true);
      } else throw new TypeError("Unknown screen capture action.");
      if (generation === this.#generation) this.retireSelection();
      return true;
    } finally {
      this.#actionPending = false;
    }
  }

  async #recordingAction(surface: CaptureSurface, action: unknown, bytes: unknown): Promise<boolean> {
    const output = surface.output;
    if (this.#live || this.#actionPending || !output || output.mode === "scroll" || !(bytes instanceof Uint8Array)
      || !validRegionRecording(bytes, output.mode, output)) throw new Error("The recording result is unavailable.");
    if (action !== "copy" && action !== "save") throw new TypeError("Unknown recording action.");
    const format = output.mode === "gif" ? "gif" : "webm", generation = this.#generation;
    this.#actionPending = true;
    try {
      if (action === "copy") clipboard.writeBuffer(format === "gif" ? "image/gif" : "video/webm", Buffer.from(bytes));
      else {
        const target = await dialog.showSaveDialog(surface.window, { defaultPath: `Screen recording ${Date.now()}.${format}`,
          filters: [{ name: format === "gif" ? "GIF" : "WebM", extensions: [format] }] });
        if (generation !== this.#generation || target.canceled || !target.filePath) return false;
        await writeFile(target.filePath, bytes);
      }
      if (generation === this.#generation) this.retireSelection();
      return true;
    } finally { this.#actionPending = false; }
  }

  #capturePartition(): Session {
    if (this.#partition) return this.#partition;
    const partition = session.fromPartition("joko-region-capture-local", { cache: false });
    this.#options.installResources(partition);
    const claimsOwner = (contents: Electron.WebContents | null, isMainFrame: boolean, frameUrl: string | undefined): boolean => {
      const window = this.#live?.surface.window;
      return window !== undefined && !window.isDestroyed() && contents === window.webContents && isMainFrame
        && frameUrl === this.#options.entryUrl() && contents?.getURL() === frameUrl;
    };
    partition.setPermissionCheckHandler((contents, permission, _origin, details) => {
      return claimsOwner(contents, details.isMainFrame, details.requestingUrl)
        && (permission === "display-capture" || permission === "media" && (details.mediaType === "unknown"
          || details.mediaType === "audio" && this.#live?.microphone === true));
    });
    partition.setPermissionRequestHandler((contents, permission, callback, details) => {
      const requestedMedia = "mediaTypes" in details ? details.mediaTypes : undefined;
      callback(claimsOwner(contents, details.isMainFrame, details.requestingUrl)
        && (permission === "display-capture" || permission === "media" && Array.isArray(requestedMedia) && (requestedMedia.length === 0
          || (requestedMedia.length === 1 && requestedMedia[0] === "audio" && this.#live?.microphone === true))));
    });
    partition.setDisplayMediaRequestHandler((request, callback) => {
      const live = this.#live, window = live?.surface.window;
      if (!live || !window || window.isDestroyed() || !live.grantAvailable || request.frame !== window.webContents.mainFrame
        || request.frame?.url !== this.#options.entryUrl() || !request.userGesture
        || !request.videoRequested || request.audioRequested !== live.systemAudio) {
        callback({});
        return;
      }
      live.grantAvailable = false;
      void readSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } }).then(sources => {
        const source = sources.find(item => item.display_id === String(live.display.id))
          ?? (sources.length === 1 && screen.getAllDisplays().length === 1 ? sources[0] : undefined);
        if (this.#live !== live || window.isDestroyed() || request.frame !== window.webContents.mainFrame || !source) callback({});
        else callback({ video: source, ...(live.systemAudio ? { audio: "loopback" as const } : {}) });
      }, () => callback({}));
    });
    partition.on("will-download", event => event.preventDefault());
    this.#partition = partition;
    return partition;
  }

  #open(mode: CaptureSurface["mode"], image: NativeImage, bounds: Rectangle, display: Display | undefined, focus: boolean): void {
    const url = this.#options.entryUrl();
    const window = new BrowserWindow({ ...bounds, title: "Joko", frame: false, show: false, skipTaskbar: true,
      hasShadow: mode === "pin", resizable: mode === "pin", fullscreenable: false, movable: mode === "pin",
      webPreferences: { preload: this.#options.preload, sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, navigateOnDragDrop: false, spellcheck: false, backgroundThrottling: false, session: this.#capturePartition() }
    });
    const contents = window.webContents, contentsId = contents.id;
    this.#surfaces.set(contentsId, { window, image, mode, ...(display === undefined ? {} : { display }) });
    window.setAlwaysOnTop(true, mode === "screen" ? "screen-saver" : "floating");
    if (process.platform === "darwin" && mode === "screen") window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", event => event.preventDefault());
    contents.on("will-redirect", event => event.preventDefault());
    contents.on("will-attach-webview", event => event.preventDefault());
    contents.once("render-process-gone", () => { if (!window.isDestroyed()) window.destroy(); });
    window.once("closed", () => {
      const removed = this.#surfaces.get(contentsId);
      this.#surfaces.delete(contentsId);
      if (removed?.mode === "screen") this.retireSelection();
    });
    window.once("ready-to-show", () => { if (!window.isDestroyed()) focus ? window.show() : window.showInactive(); });
    void window.loadURL(url).catch(() => { if (!window.isDestroyed()) window.destroy(); });
  }
}

export function regionCaptureControlBounds(selection: Rectangle, displays: readonly Rectangle[]): Rectangle | undefined {
  for (const area of displays) {
    const width = Math.min(460, area.width - 20), height = 71;
    if (width < 270 || area.height < height + 20) continue;
    const x = area.x + Math.round((area.width - width) / 2);
    for (const y of [area.y + 10, area.y + area.height - height - 10]) {
      if (x + width <= selection.x || x >= selection.x + selection.width || y + height <= selection.y || y >= selection.y + selection.height) {
        return { x, y, width, height };
      }
    }
  }
  return undefined;
}

export function validRegionRecording(bytes: Uint8Array, mode: "gif" | "video", size: { width: number; height: number }): boolean {
  if (bytes.byteLength < 16 || bytes.byteLength > MAX_RECORDING_BYTES) return false;
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mode === "gif") {
    return ["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6)) && data.readUInt16LE(6) === size.width
      && data.readUInt16LE(8) === size.height && data.at(-1) === 0x3b;
  }
  return data.readUInt32BE(0) === 0x1a45dfa3 && data.subarray(4, 128).includes(Buffer.from("webm", "ascii"));
}

function thumbnailSize(displays: readonly Display[]) {
  const width = Math.max(...displays.map(display => Math.round(display.bounds.width * display.scaleFactor)));
  const height = Math.max(...displays.map(display => Math.round(display.bounds.height * display.scaleFactor)));
  const ratio = Math.min(1, 7680 / width, 7680 / height, Math.sqrt(MAX_IMAGE_PIXELS / (width * height)));
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

async function readSources(options: Parameters<typeof desktopCapturer.getSources>[0]): Promise<DesktopCapturerSource[]> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([desktopCapturer.getSources(options), new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Timed out waiting for desktop pixels.")), FREEZE_TIMEOUT);
    })]);
  } finally { if (timeout) clearTimeout(timeout); }
}

function captureImage(image: NativeImage): CaptureImage {
  const { width, height } = image.getSize(1);
  if (!(width > 0 && height > 0) || width * height > MAX_IMAGE_PIXELS) throw new Error("The capture image size is unsupported.");
  const png = new Uint8Array(image.toPNG({ scaleFactor: 1 }));
  if (!validRegionPngHeader(png, { width, height })) throw new Error("The capture image exceeds the supported PNG size.");
  return { png, width, height };
}
