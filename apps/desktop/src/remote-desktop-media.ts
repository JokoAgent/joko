import { randomUUID } from "node:crypto";

import {
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  nativeImage,
  screen,
  session,
  systemPreferences,
  type DesktopCapturerSource,
  type IpcMainInvokeEvent,
  type NativeImage,
  type Session,
  type WebContents
} from "electron";
import {
  REMOTE_DESKTOP_MAX_FRAME_BYTES,
  REMOTE_DESKTOP_MAX_FRAME_DIMENSION,
  REMOTE_DESKTOP_NETWORK,
  REMOTE_DESKTOP_OFFER_BUDGET,
  REMOTE_DESKTOP_STUN_SERVERS,
  parseRemoteDesktopIceCandidates,
  parseRemoteDesktopIceReply,
  parseRemoteDesktopRequest,
  type RemoteDesktopIceCandidate,
  type RemoteDesktopInput,
  type RemoteDesktopJpegFrame
} from "@joko/device-peer";

import {
  REMOTE_DESKTOP_CAPTURE_CHANNELS,
  type DesktopRemoteDesktopCaptureCommand,
  type DesktopRemoteDesktopCaptureReply
} from "./remote-desktop-capture-protocol.js";
import {
  parseDesktopRemoteDesktopVideoSettings,
  readDesktopSystemAudioSupport,
  type DesktopRemoteDesktopVideoSettings
} from "./remote-desktop-media-settings.js";
import {
  desktopRemoteDesktopVideoProfile,
  withDesktopRemoteDesktopBitrateHints
} from "./remote-desktop-quality.js";
import type { DesktopRemoteDesktopMediaPort } from "./remote-desktop-host.js";
import {
  DesktopRemoteDesktopNativeCapture,
  type DesktopRemoteDesktopNativeFrame
} from "./remote-desktop-native-capture.js";

const CAPTURE_URL = "https://remote-desktop.joko.invalid/capture";
const CAPTURE_HTML = "<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>";

interface PendingCaptureRequest {
  readonly id: string;
  readonly op: "offer" | "ice";
  readonly resolve: (value: DesktopRemoteDesktopCaptureReply) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Hidden, isolated WebRTC owner. It never loads the product renderer or network resources. */
export class DesktopRemoteDesktopMedia implements DesktopRemoteDesktopMediaPort {
  readonly #preloadPath: string;
  readonly #partition = `joko-remote-desktop-capture-${randomUUID()}`;
  #captureSession: Session | undefined;
  #window: BrowserWindow | undefined;
  #ready: {
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  } | undefined;
  #grant: {
    readonly source: DesktopCapturerSource;
    readonly leaseId: string;
    readonly attemptId: string;
    readonly requestId: string;
    readonly audio: boolean;
    readonly current: () => boolean;
  } | undefined;
  #pending: PendingCaptureRequest | undefined;
  #attempt: {
    readonly leaseId: string;
    readonly attemptId: string;
    readonly displayId: string;
    readonly nativeCapture: boolean;
    readonly cursorOverlay: boolean;
    readonly settings?: DesktopRemoteDesktopVideoSettings;
    readonly current: () => boolean;
  } | undefined;
  readonly #nativeCapture = new DesktopRemoteDesktopNativeCapture();
  #inputHandler: ((leaseId: string, sequence: number, events: readonly RemoteDesktopInput[]) => void) | undefined;
  #presentationPongHandler: ((leaseId: string) => void) | undefined;
  #presentationLease: string | undefined;
  #nativeOnly = false;
  #generation = 0;
  #retired = false;

  constructor(preloadPath: string) {
    this.#preloadPath = preloadPath;
    ipcMain.handle(REMOTE_DESKTOP_CAPTURE_CHANNELS.ready, (event) => this.#registered(event));
    ipcMain.handle(REMOTE_DESKTOP_CAPTURE_CHANNELS.reply, (event, id, reply) => {
      this.#receiveReply(event, id, reply);
    });
    ipcMain.handle(REMOTE_DESKTOP_CAPTURE_CHANNELS.input, (event, leaseId, sequence, events) => {
      this.#receiveInput(event, leaseId, sequence, events);
    });
    ipcMain.handle(
      REMOTE_DESKTOP_CAPTURE_CHANNELS.nativeFrame,
      (event, leaseId, attemptId) => this.#nativeFrame(event, leaseId, attemptId)
    );
    ipcMain.handle(
      REMOTE_DESKTOP_CAPTURE_CHANNELS.presentationPong,
      (event, leaseId, attemptId) => {
        this.#receivePresentationPong(event, leaseId, attemptId);
      }
    );
    ipcMain.handle(REMOTE_DESKTOP_CAPTURE_CHANNELS.stopped, (event) => {
      this.#assertSender(event);
      this.stop();
    });
  }

  setInputHandler(handler: (
    leaseId: string,
    sequence: number,
    events: readonly RemoteDesktopInput[]
  ) => void): () => void {
    if (this.#inputHandler !== undefined) throw new Error("Remote Desktop input handler is already installed.");
    this.#inputHandler = handler;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.#inputHandler === handler) this.#inputHandler = undefined;
    };
  }

  setPresentationPongHandler(handler: (leaseId: string) => void): () => void {
    if (this.#presentationPongHandler !== undefined) {
      throw new Error("Remote Desktop presentation pong handler is already installed.");
    }
    this.#presentationPongHandler = handler;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.#presentationPongHandler === handler) this.#presentationPongHandler = undefined;
    };
  }

  setSessionState(nativeOnly: boolean): void {
    this.stop();
    this.#nativeOnly = nativeOnly;
  }

  async frame(
    displayId: string,
    cursorOverlay: boolean,
    signal: AbortSignal
  ): Promise<RemoteDesktopJpegFrame | null> {
    this.#assertAvailable();
    assertCapturePermission();
    if (process.platform === "darwin" && (this.#nativeOnly || cursorOverlay)) {
      const frame = await this.#nativeCapture.frame(displayId, cursorOverlay, cursorOverlay);
      throwIfAborted(signal);
      return encodeNativeRelayFrame(frame);
    }
    try {
      const sources = await enumerateDesktopSources(true, signal);
      const source = exactDesktopSource(sources, displayId);
      throwIfAborted(signal);
      return source === null ? null : encodeDesktopFrame(source.thumbnail);
    } catch (error) {
      if (process.platform !== "darwin" || !capturePermissionGranted()) throw error;
      const frame = await this.#nativeCapture.frame(displayId, cursorOverlay, cursorOverlay);
      throwIfAborted(signal);
      return encodeNativeRelayFrame(frame);
    }
  }

  async offer(request: {
    readonly displayId: string;
    readonly leaseId: string;
    readonly attemptId: string;
    readonly offerSdp: string;
    readonly cursorOverlay: boolean;
    readonly settings?: DesktopRemoteDesktopVideoSettings;
    readonly current: () => boolean;
    readonly signal: AbortSignal;
  }): Promise<string> {
    this.#assertAvailable();
    if (this.#pending !== undefined) throw new Error("REMOTE_DESKTOP_VIDEO_BUSY");
    const settings = parseDesktopRemoteDesktopVideoSettings(request.settings);
    const profile = desktopRemoteDesktopVideoProfile(settings);
    assertCapturePermission();
    this.stop();
    const generation = this.#generation;
    if (settings?.audio === true && !readDesktopSystemAudioSupport()) {
      throw new Error("REMOTE_DESKTOP_AUDIO_UNAVAILABLE");
    }
    let source: DesktopCapturerSource | null = null;
    const nativeAvailable = process.platform === "darwin";
    const nativeVideo = nativeAvailable && (this.#nativeOnly || request.cursorOverlay);
    if (!nativeVideo || settings?.audio === true) {
      try {
        const sources = await enumerateDesktopSources(false, request.signal,
          nativeAvailable ? 2_000 : REMOTE_DESKTOP_OFFER_BUDGET.sourcesMs);
        source = exactDesktopSource(sources, request.displayId);
      } catch (error) {
        if (!nativeAvailable || !capturePermissionGranted()) throw error;
      }
    }
    if (source === null && !nativeAvailable) throw new Error("REMOTE_DESKTOP_VIDEO_UNAVAILABLE");
    throwIfAborted(request.signal);
    if (!request.current()) throw new Error("REMOTE_DESKTOP_VIDEO_STOPPED");
    await this.#startWindow(generation, request.signal);
    if (generation !== this.#generation || !request.current()) {
      throw new Error("REMOTE_DESKTOP_VIDEO_STOPPED");
    }
    const requestId = randomUUID();
    this.#grant = source === null || (nativeVideo && settings?.audio !== true) ? undefined : {
      source,
      leaseId: request.leaseId,
      attemptId: request.attemptId,
      requestId,
      audio: settings?.audio === true,
      current: request.current
    };
    this.#attempt = {
      leaseId: request.leaseId,
      attemptId: request.attemptId,
      displayId: request.displayId,
      nativeCapture: nativeAvailable,
      cursorOverlay: request.cursorOverlay && process.platform === "darwin",
      ...(settings === undefined ? {} : { settings }),
      current: request.current
    };
    try {
      const reply = await this.#command({
        op: "offer",
        id: requestId,
        leaseId: request.leaseId,
        attemptId: request.attemptId,
        offerSdp: settings === undefined
          ? request.offerSdp
          : withDesktopRemoteDesktopBitrateHints(request.offerSdp, profile),
        iceServers: REMOTE_DESKTOP_STUN_SERVERS.map((server) => ({ urls: server.urls })),
        nativeCapture: nativeAvailable,
        nativeVideo,
        chromiumCapture: this.#grant !== undefined,
        cursorOverlay: request.cursorOverlay && process.platform === "darwin",
        profile,
        ...(settings === undefined ? {} : { settings })
      }, REMOTE_DESKTOP_OFFER_BUDGET.hostMs, request.signal);
      if (reply.kind !== "offer" || Buffer.byteLength(reply.answerSdp, "utf8") > 64 * 1_024) {
        throw new Error("REMOTE_DESKTOP_VIDEO_UNAVAILABLE");
      }
      return reply.answerSdp;
    } catch (error) {
      if (generation === this.#generation) this.stop();
      throw error;
    }
  }

  setPresentation(leaseId: string, enabled: boolean): void {
    const attempt = this.#attempt;
    const owner = this.#window?.webContents;
    if (attempt?.leaseId !== leaseId || owner === undefined || owner.isDestroyed()) return;
    this.#presentationLease = enabled ? leaseId : undefined;
    try {
      owner.send(REMOTE_DESKTOP_CAPTURE_CHANNELS.command, {
        op: "presentation",
        leaseId,
        enabled
      } satisfies DesktopRemoteDesktopCaptureCommand);
    } catch {
      this.stop();
    }
  }

  async exchangeIce(request: {
    readonly leaseId: string;
    readonly attemptId: string;
    readonly candidates: readonly RemoteDesktopIceCandidate[];
    readonly after: number;
    readonly signal: AbortSignal;
  }) {
    this.#assertAvailable();
    const attempt = this.#attempt;
    if (attempt?.leaseId !== request.leaseId || attempt.attemptId !== request.attemptId) {
      throw new Error("REMOTE_DESKTOP_VIDEO_STOPPED");
    }
    const reply = await this.#command({
      op: "ice",
      id: randomUUID(),
      leaseId: request.leaseId,
      attemptId: request.attemptId,
      candidates: request.candidates,
      after: request.after
    }, 4_000, request.signal);
    if (reply.kind !== "ice") throw new Error("REMOTE_DESKTOP_VIDEO_STOPPED");
    return parseRemoteDesktopIceReply({
      attemptId: reply.attemptId,
      candidates: reply.candidates,
      next: reply.next,
      complete: reply.complete
    });
  }

  stop(): void {
    this.#generation += 1;
    this.#nativeCapture.stop();
    this.#grant = undefined;
    this.#attempt = undefined;
    this.#presentationLease = undefined;
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pending.reject(new Error("REMOTE_DESKTOP_VIDEO_STOPPED"));
    }
    const ready = this.#ready;
    this.#ready = undefined;
    if (ready !== undefined) {
      clearTimeout(ready.timer);
      ready.reject(new Error("REMOTE_DESKTOP_VIDEO_STOPPED"));
    }
    const owner = this.#window;
    this.#window = undefined;
    if (owner !== undefined && !owner.isDestroyed()) owner.destroy();
  }

  async retire(): Promise<void> {
    if (this.#retired) return;
    this.#retired = true;
    this.stop();
    this.#inputHandler = undefined;
    this.#presentationPongHandler = undefined;
    ipcMain.removeHandler(REMOTE_DESKTOP_CAPTURE_CHANNELS.ready);
    ipcMain.removeHandler(REMOTE_DESKTOP_CAPTURE_CHANNELS.reply);
    ipcMain.removeHandler(REMOTE_DESKTOP_CAPTURE_CHANNELS.input);
    ipcMain.removeHandler(REMOTE_DESKTOP_CAPTURE_CHANNELS.nativeFrame);
    ipcMain.removeHandler(REMOTE_DESKTOP_CAPTURE_CHANNELS.presentationPong);
    ipcMain.removeHandler(REMOTE_DESKTOP_CAPTURE_CHANNELS.stopped);
    const captureSession = this.#captureSession;
    this.#captureSession = undefined;
    if (captureSession !== undefined) {
      try { captureSession.protocol.unhandle("https"); }
      catch { /* The isolated session already retired its protocol handler. */ }
    }
  }

  async #startWindow(generation: number, signal: AbortSignal): Promise<void> {
    const captureSession = this.#session();
    const owner = new BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      width: 1,
      height: 1,
      webPreferences: {
        session: captureSession,
        preload: this.#preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        plugins: false,
        navigateOnDragDrop: false,
        webviewTag: false,
        backgroundThrottling: false,
        spellcheck: false
      }
    });
    this.#window = owner;
    const failed = (): void => {
      if (this.#window !== owner) return;
      this.stop();
    };
    owner.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    owner.webContents.on("will-attach-webview", (event) => { event.preventDefault(); });
    owner.webContents.on("will-navigate", (event) => { event.preventDefault(); failed(); });
    owner.webContents.on("will-redirect", (event) => { event.preventDefault(); failed(); });
    owner.webContents.on("render-process-gone", failed);
    owner.webContents.on("destroyed", failed);
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(failed, REMOTE_DESKTOP_OFFER_BUDGET.captureReadyMs);
      this.#ready = { resolve, reject, timer };
    });
    await owner.loadURL(CAPTURE_URL).catch(() => { failed(); });
    await Promise.race([ready, abortPromise(signal)]);
    if (generation !== this.#generation || this.#window !== owner || owner.isDestroyed()) {
      throw new Error("REMOTE_DESKTOP_VIDEO_STOPPED");
    }
  }

  #session(): Session {
    if (this.#captureSession !== undefined) return this.#captureSession;
    const captureSession = session.fromPartition(this.#partition, { cache: false });
    this.#captureSession = captureSession;
    void captureSession.protocol.handle("https", (request) => {
      if (request.method !== "GET" || request.url !== CAPTURE_URL) {
        return new Response(null, { status: 403 });
      }
      return new Response(CAPTURE_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; media-src 'self' blob:; connect-src 'none'; script-src 'none'; style-src 'none'; frame-src 'none'"
        }
      });
    });
    captureSession.setPermissionCheckHandler((owner, permission, origin, details) =>
      this.#trusted(owner, details.isMainFrame, details.requestingUrl)
      && origin === "https://remote-desktop.joko.invalid"
      && permission === "media");
    captureSession.setPermissionRequestHandler((owner, permission, callback, details) => {
      const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
      callback(this.#trusted(owner, details.isMainFrame, details.requestingUrl)
        && permission === "media" && Array.isArray(mediaTypes) && mediaTypes.length === 0);
    });
    captureSession.setDisplayMediaRequestHandler((request, callback) => {
      const grant = this.#grant;
      this.#grant = undefined;
      const owner = this.#window?.webContents;
      const pending = this.#pending;
      let grantCurrent = false;
      try { grantCurrent = grant?.current() === true; }
      catch { /* Current lease lookup failed closed. */ }
      if (grant === undefined || owner === undefined || owner.isDestroyed()
        || request.frame !== owner.mainFrame || !request.videoRequested
        || request.securityOrigin !== "https://remote-desktop.joko.invalid"
        || request.audioRequested !== grant.audio
        || this.#attempt?.leaseId !== grant.leaseId
        || this.#attempt.attemptId !== grant.attemptId
        || !grantCurrent
        || pending?.op !== "offer" || pending.id !== grant.requestId) {
        callback({});
        return;
      }
      callback({
        video: grant.source,
        ...(grant.audio ? { audio: "loopback" as const } : {})
      });
    });
    captureSession.on("will-download", (event) => { event.preventDefault(); });
    return captureSession;
  }

  #trusted(owner: WebContents | null, isMainFrame: boolean, requestingUrl?: string): boolean {
    const expected = this.#window?.webContents;
    return owner !== null && expected !== undefined && owner === expected && !owner.isDestroyed()
      && isMainFrame && requestingUrl === CAPTURE_URL && owner.mainFrame.url === CAPTURE_URL;
  }

  #registered(event: IpcMainInvokeEvent): void {
    this.#assertSender(event);
    const ready = this.#ready;
    this.#ready = undefined;
    if (ready !== undefined) {
      clearTimeout(ready.timer);
      ready.resolve();
    }
  }

  #receiveReply(event: IpcMainInvokeEvent, id: unknown, raw: unknown): void {
    this.#assertSender(event);
    const pending = this.#pending;
    if (pending === undefined || id !== pending.id) throw new Error("Remote Desktop capture reply is stale.");
    let reply: DesktopRemoteDesktopCaptureReply;
    try {
      reply = parseCaptureReply(raw, pending.op);
    } catch {
      reply = { kind: "error", code: "unavailable" };
    }
    this.#pending = undefined;
    clearTimeout(pending.timer);
    pending.resolve(reply);
  }

  #receiveInput(
    event: IpcMainInvokeEvent,
    leaseId: unknown,
    sequence: unknown,
    events: unknown
  ): void {
    this.#assertSender(event);
    if (typeof leaseId !== "string" || this.#attempt?.leaseId !== leaseId
      || !Number.isSafeInteger(sequence) || (sequence as number) < 1) {
      throw new Error("Remote Desktop capture input is invalid.");
    }
    const request = parseRemoteDesktopRequest({ op: "input", lease: leaseId, sequence, events });
    if (request.op !== "input") throw new Error("Remote Desktop capture input is invalid.");
    this.#inputHandler?.(leaseId, request.sequence, request.events);
  }

  async #nativeFrame(
    event: IpcMainInvokeEvent,
    leaseId: unknown,
    attemptId: unknown
  ): Promise<DesktopRemoteDesktopNativeFrame | null> {
    this.#assertSender(event);
    const attempt = this.#attempt;
    if (typeof leaseId !== "string" || typeof attemptId !== "string"
      || attempt?.leaseId !== leaseId || attempt.attemptId !== attemptId
      || !attempt.nativeCapture) {
      throw new Error("Remote Desktop native frame request is stale.");
    }
    let current = false;
    try { current = attempt.current(); } catch { /* Authority lookup failed closed. */ }
    if (!current) throw new Error("Remote Desktop native frame request is stale.");
    const generation = this.#generation;
    const frame = await this.#nativeCapture.frame(
      attempt.displayId,
      true,
      attempt.cursorOverlay,
      attempt.settings
    );
    let stillCurrent = false;
    try { stillCurrent = attempt.current(); } catch { /* Authority lookup failed closed. */ }
    if (generation !== this.#generation || this.#attempt !== attempt || !stillCurrent) return null;
    return frame;
  }

  #receivePresentationPong(
    event: IpcMainInvokeEvent,
    leaseId: unknown,
    attemptId: unknown
  ): void {
    this.#assertSender(event);
    const attempt = this.#attempt;
    if (typeof leaseId !== "string" || typeof attemptId !== "string"
      || this.#presentationLease !== leaseId
      || attempt?.leaseId !== leaseId || attempt.attemptId !== attemptId) {
      throw new Error("Remote Desktop presentation pong is stale.");
    }
    this.#presentationPongHandler?.(leaseId);
  }

  #assertSender(event: IpcMainInvokeEvent): void {
    const owner = this.#window?.webContents;
    if (owner === undefined || owner.isDestroyed() || event.sender !== owner
      || event.senderFrame !== owner.mainFrame || event.senderFrame.parent !== null
      || event.senderFrame.url !== CAPTURE_URL) {
      throw new Error("Remote Desktop capture sender is invalid.");
    }
  }

  #command(
    command: Extract<DesktopRemoteDesktopCaptureCommand, { readonly op: "offer" | "ice" }>,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<DesktopRemoteDesktopCaptureReply> {
    const owner = this.#window?.webContents;
    if (owner === undefined || owner.isDestroyed()) {
      return Promise.reject(new Error("REMOTE_DESKTOP_VIDEO_UNAVAILABLE"));
    }
    if (this.#pending !== undefined) return Promise.reject(new Error("REMOTE_DESKTOP_VIDEO_BUSY"));
    return Promise.race([
      new Promise<DesktopRemoteDesktopCaptureReply>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.#pending?.id !== command.id) return;
          this.#pending = undefined;
          reject(new Error("REMOTE_DESKTOP_VIDEO_TIMEOUT"));
        }, timeoutMs);
        this.#pending = { id: command.id, op: command.op, resolve, reject, timer };
        try {
          owner.send(REMOTE_DESKTOP_CAPTURE_CHANNELS.command, command);
        } catch {
          this.#pending = undefined;
          clearTimeout(timer);
          reject(new Error("REMOTE_DESKTOP_VIDEO_UNAVAILABLE"));
        }
      }),
      abortPromise(signal)
    ]).then((reply) => {
      if (reply.kind === "error") {
        throw new Error(
          reply.code === "audio-unavailable"
            ? "REMOTE_DESKTOP_AUDIO_UNAVAILABLE"
            : reply.code === "timeout"
              ? "REMOTE_DESKTOP_VIDEO_TIMEOUT"
              : reply.code === "stopped"
                ? "REMOTE_DESKTOP_VIDEO_STOPPED"
                : "REMOTE_DESKTOP_VIDEO_UNAVAILABLE"
        );
      }
      return reply;
    });
  }

  #assertAvailable(): void {
    if (this.#retired) throw new Error("REMOTE_DESKTOP_VIDEO_STOPPED");
  }
}

async function enumerateDesktopSources(
  thumbnail: boolean,
  signal: AbortSignal,
  timeoutMs: number = REMOTE_DESKTOP_OFFER_BUDGET.sourcesMs
): Promise<DesktopCapturerSource[]> {
  throwIfAborted(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: thumbnail
          ? { width: REMOTE_DESKTOP_MAX_FRAME_DIMENSION, height: REMOTE_DESKTOP_MAX_FRAME_DIMENSION }
          : { width: 0, height: 0 },
        fetchWindowIcons: false
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("REMOTE_DESKTOP_VIDEO_TIMEOUT")), timeoutMs);
      }),
      abortPromise(signal)
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function exactDesktopSource(
  sources: readonly DesktopCapturerSource[],
  displayId: string
): DesktopCapturerSource | null {
  if (!screen.getAllDisplays().some((display) => String(display.id) === displayId)) {
    throw new Error("REMOTE_DESKTOP_DISPLAY_MISSING");
  }
  return sources.find((source) => source.display_id === displayId) ?? null;
}

export function encodeDesktopFrame(thumbnail: NativeImage): RemoteDesktopJpegFrame | null {
  if (thumbnail.isEmpty()) return null;
  let image = thumbnail;
  const initial = image.getSize();
  if (Math.max(initial.width, initial.height) > REMOTE_DESKTOP_MAX_FRAME_DIMENSION) {
    image = initial.width >= initial.height
      ? image.resize({ width: REMOTE_DESKTOP_MAX_FRAME_DIMENSION })
      : image.resize({ height: REMOTE_DESKTOP_MAX_FRAME_DIMENSION });
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const jpeg = image.toJPEG(55);
    const size = image.getSize();
    if (jpeg.byteLength >= 1 && jpeg.byteLength <= REMOTE_DESKTOP_MAX_FRAME_BYTES
      && Math.max(size.width, size.height) <= REMOTE_DESKTOP_MAX_FRAME_DIMENSION) {
      return Object.freeze({ jpeg: jpeg.toString("base64"), width: size.width, height: size.height });
    }
    image = image.resize({ width: Math.max(1, Math.floor(size.width * 0.75)) });
  }
  return null;
}

/** Native WebRTC pixels may be 4096px/1MiB; relay frames stay 1280/180KiB. */
export function encodeNativeRelayFrame(
  frame: DesktopRemoteDesktopNativeFrame | null
): RemoteDesktopJpegFrame | null {
  if (frame === null) return null;
  let bytes: Buffer;
  try { bytes = Buffer.from(frame.jpeg, "base64"); }
  catch { return null; }
  const encoded = encodeDesktopFrame(nativeImage.createFromBuffer(bytes));
  bytes.fill(0);
  return encoded === null ? null : Object.freeze({
    ...encoded,
    ...(frame.cursor === null ? {} : { cursor: frame.cursor })
  });
}

function parseCaptureReply(
  value: unknown,
  expected: "offer" | "ice"
): DesktopRemoteDesktopCaptureReply {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid");
  const record = value as Record<string, unknown>;
  if (record["kind"] === "error"
    && ((expected === "offer" && record["code"] === "audio-unavailable")
      || record["code"] === "unavailable" || record["code"] === "stopped"
      || record["code"] === "timeout")
    && exactKeys(record, ["kind", "code"])) {
    return { kind: "error", code: record["code"] };
  }
  if (expected === "offer" && record["kind"] === "offer"
    && exactKeys(record, ["kind", "answerSdp"]) && typeof record["answerSdp"] === "string"
    && record["answerSdp"].length >= 1 && Buffer.byteLength(record["answerSdp"], "utf8") <= 64 * 1_024) {
    return { kind: "offer", answerSdp: record["answerSdp"] };
  }
  if (expected === "ice" && record["kind"] === "ice"
    && exactKeys(record, ["kind", "attemptId", "candidates", "next", "complete"])) {
    const candidates = parseRemoteDesktopIceCandidates(record["candidates"]);
    if (typeof record["attemptId"] === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(record["attemptId"])
      && Number.isSafeInteger(record["next"]) && (record["next"] as number) >= 0
      && (record["next"] as number) <= REMOTE_DESKTOP_NETWORK.maxCandidates
      && typeof record["complete"] === "boolean") {
      return {
        kind: "ice",
        attemptId: record["attemptId"],
        candidates,
        next: record["next"] as number,
        complete: record["complete"]
      };
    }
  }
  throw new Error("invalid");
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertCapturePermission(): void {
  if (!capturePermissionGranted()) {
    throw new Error("REMOTE_DESKTOP_SCREEN_PERMISSION_REQUIRED");
  }
}

function capturePermissionGranted(): boolean {
  if (process.platform !== "darwin") return true;
  try { return systemPreferences.getMediaAccessStatus("screen") === "granted"; }
  catch { return false; }
}

function abortPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Remote Desktop request was aborted.");
}
