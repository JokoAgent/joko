import type { App, BrowserWindow } from "electron";
import { loadHashedNativeHelper, nativeHelperRecord, type NativeHelperModuleOptions } from "./native-helper-module.js";

interface Point { readonly x: number; readonly y: number }
interface Rect extends Point { readonly width: number; readonly height: number }
interface Contact extends Point { readonly id: number }
type Phase = "begin" | "change" | "end" | "cancel";
interface Packet {
  readonly phase: Phase;
  readonly touches: readonly Contact[];
  readonly width?: number;
  readonly height?: number;
}
interface FrameBounds extends Rect { readonly scaleX: number; readonly scaleY: number }
interface TrackedSurface {
  readonly objectId: string;
  readonly frameObjectId: string;
  readonly session?: string;
  readonly bounds: Rect;
  readonly frame: FrameBounds;
  readonly bootstrapUrl: string;
  readonly mode: "touch" | "contacts";
}

interface NativeTrackpad {
  readonly start: (handle: Buffer, receive: (text: string) => void) => number | null;
  readonly stop: (token: number) => void;
  readonly position: (handle: Buffer) => Point | null;
}

interface TrackingOptions {
  readonly directory: string;
  readonly isCurrent: () => boolean;
  readonly bootstrapBaseUrl?: () => string;
  readonly platform?: NodeJS.Platform;
  readonly load?: () => NativeTrackpad | undefined;
}

interface Gesture {
  readonly centre: Point;
  readonly anchor: Point;
  readonly aspect: number;
  raw: readonly Contact[];
  projected: readonly Contact[];
}

const READY_FRAME = `function(x, y, bootstrapUrl) {
  const f = document.elementFromPoint(x, y);
  if (!(f instanceof HTMLIFrameElement) || !f.isConnected || !f.hasAttribute('data-joko-extension-surface') ||
      f.sandbox.value !== 'allow-scripts') return null;
  const source = new URL(f.src), expected = new URL(bootstrapUrl);
  if (source.protocol !== expected.protocol || source.host !== expected.host || source.pathname !== expected.pathname ||
      source.search || !/^#v1-[a-f0-9]{32}$/.test(source.hash)) return null;
  return f;
}`;
const READ_FRAME_BOUNDS = `function() {
  const rect = this.getBoundingClientRect();
  const scaleX = rect.width / this.offsetWidth, scaleY = rect.height / this.offsetHeight;
  return { x: rect.x + this.clientLeft * scaleX, y: rect.y + this.clientTop * scaleY,
    width: this.clientWidth * scaleX, height: this.clientHeight * scaleY, scaleX, scaleY };
}`;
const READ_SURFACE = `function(x, y) {
  if (document.querySelector('meta[name="joko-native-trackpad"]')?.content !== 'touch') return null;
  return document.elementFromPoint(x, y)?.closest('[data-joko-trackpad]') ?? null;
}`;
const READ_SURFACE_BOUNDS = `function() {
  const rect = this.getBoundingClientRect();
  const x = Math.max(0, rect.left), y = Math.max(0, rect.top);
  return { x, y, width: Math.min(innerWidth, rect.right) - x, height: Math.min(innerHeight, rect.bottom) - y,
    mode: this.getAttribute('data-joko-trackpad') };
}`;
const DELIVER_CONTACTS = `function(phase, touches, anchor, mode) {
  if (phase !== 'cancel') {
    if (!this.isConnected || this.getAttribute('data-joko-trackpad') !== mode ||
        document.querySelector('meta[name="joko-native-trackpad"]')?.content !== 'touch') return false;
    if (phase === 'begin' && document.elementFromPoint(anchor.x, anchor.y)?.closest('[data-joko-trackpad]') !== this)
      return false;
  }
  if (mode === 'contacts') this.dispatchEvent(new CustomEvent('joko-trackpad', { detail: { phase, touches } }));
  return true;
}`;

export function configureNativeTrackpadInput(commandLine: App["commandLine"], platform = process.platform): void {
  if (platform !== "darwin") return;
  const enabled = commandLine.getSwitchValue("enable-features").split(",").filter(Boolean);
  if (!enabled.includes("SyntheticPointerActions")) {
    commandLine.appendSwitch("enable-features", [...enabled, "SyntheticPointerActions"].join(","));
  }
}

export function loadNativeTrackpad(options: NativeHelperModuleOptions): NativeTrackpad | undefined {
  if (options.platform !== "darwin" || !["arm64", "x64"].includes(options.architecture)) return undefined;
  const native = loadHashedNativeHelper(options, "joko-macos-trackpad.node", 2 * 1024 * 1024);
  if (!nativeHelperRecord(native) || Object.keys(native).sort().join(",") !== "position,protocolVersion,start,stop"
    || native.protocolVersion !== 1 || typeof native.start !== "function" || typeof native.stop !== "function"
    || typeof native.position !== "function") return undefined;
  return native as unknown as NativeTrackpad;
}

/** Binds local AppKit touches to the actual opted-in element in a live extension iframe. */
export function installNativeTrackpad(window: BrowserWindow, options: TrackingOptions): void {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return;
  const contents = window.webContents, debuggerSession = contents.debugger;
  const loaded = (options.load ?? (() => loadNativeTrackpad({
    directory: options.directory, platform, architecture: process.arch
  })))();
  if (loaded === undefined) return;
  const native = loaded;

  const iframeSessions = new Map<string, string>();
  let captureToken: number | null = null;
  let owner: object | undefined;
  let retirement: { readonly owner: object; readonly done: Promise<void> } | undefined;
  let capture: TrackedSurface | undefined;
  let gesture: Gesture | undefined;
  let deliveredGesture: Gesture | undefined;
  let zoom = 1;
  let pointer: Point | undefined;
  let originUrl = "";
  let epoch = 0;
  let pendingRead: object | undefined;
  let pendingWrites = 0;
  let deliveryTail = Promise.resolve();
  let lastRead = -Infinity;

  const current = () => !window.isDestroyed() && !contents.isDestroyed() && window.isVisible()
    && window.isFocused() && contents.isFocused() && options.isCurrent();

  const releaseObject = (objectId: string, session?: string) =>
    debuggerSession.sendCommand("Runtime.releaseObject", { objectId }, session).catch(() => undefined);

  function detachDebugger(attachedOwner: object): void {
    if (owner !== attachedOwner) return;
    owner = undefined;
    iframeSessions.clear();
    if (!contents.isDestroyed() && debuggerSession.isAttached()) debuggerSession.detach();
  }

  function retire(): Promise<void> | undefined {
    if (retirement !== undefined && retirement.owner === owner) return retirement.done;
    epoch++;
    const previousToken = captureToken, previous = capture, previousGesture = deliveredGesture, previousOwner = owner;
    const outstanding = deliveryTail;
    captureToken = null;
    capture = undefined;
    gesture = undefined;
    deliveredGesture = undefined;
    pendingRead = undefined;
    pendingWrites = 0;
    deliveryTail = Promise.resolve();
    if (previousToken !== null) native.stop(previousToken);
    if (previousOwner === undefined) return;
    if (previous === undefined || contents.isDestroyed()) {
      detachDebugger(previousOwner);
      return;
    }
    const cancel = outstanding.then(() => {
      if (owner !== previousOwner || contents.isDestroyed() || previousGesture === undefined) return;
      return previous.mode === "touch" ? dispatchTouch("touchCancel", []) : deliver(previous, "cancel", [], previousGesture.anchor);
    });
    const timeout = setTimeout(() => detachDebugger(previousOwner), 500);
    const done = cancel.catch(() => undefined).then(() => owner === previousOwner ? Promise.all([
      releaseObject(previous.objectId, previous.session), releaseObject(previous.frameObjectId)
    ]) : undefined).then(() => {
      clearTimeout(timeout);
      detachDebugger(previousOwner);
    }).finally(() => {
      if (retirement?.owner === previousOwner) retirement = undefined;
    });
    retirement = { owner: previousOwner, done };
    return done;
  }

  function deliver(surface: TrackedSurface, phase: Phase, points: readonly Contact[], anchor: Point): Promise<boolean> {
    const relative = (point: Point) => ({
      x: (point.x - surface.frame.x) / surface.frame.scaleX,
      y: (point.y - surface.frame.y) / surface.frame.scaleY
    });
    const touches = points.map(point => ({ id: point.id, ...relative(point) }));
    return debuggerSession.sendCommand("Runtime.callFunctionOn", {
      objectId: surface.objectId, functionDeclaration: DELIVER_CONTACTS, returnByValue: true,
      arguments: [{ value: phase }, { value: touches }, { value: relative(anchor) }, { value: surface.mode }]
    }, surface.session).then(response => response.exceptionDetails === undefined && response.result?.value === true);
  }

  function dispatchTouch(type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", points: readonly Contact[]): Promise<unknown> {
    return debuggerSession.sendCommand("Input.dispatchTouchEvent", { type, touchPoints: points });
  }

  function send(text: string, stamp: number): void {
    const surface = capture;
    if (stamp !== epoch || surface === undefined) return;
    if (!current() || contents.getZoomFactor() !== zoom || contents.getURL() !== originUrl || pendingWrites >= 32) {
      retire();
      return;
    }
    const packet = parsePacket(text);
    if (packet === undefined || packet.phase === "cancel") { retire(); return; }
    if (packet.phase === "begin") {
      const position = native.position(window.getNativeWindowHandle());
      const anchor = position === null ? undefined : { x: position.x / zoom, y: position.y / zoom };
      if (gesture !== undefined || anchor === undefined || !validPoint(anchor) || !contains(surface.bounds, anchor)) { retire(); return; }
      const [first, second] = packet.touches as readonly [Contact, Contact];
      gesture = { centre: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
        anchor, aspect: packet.height! / packet.width!, raw: [], projected: [] };
    }
    const active = gesture;
    if (active === undefined) return;
    if (packet.phase === "change" && packet.touches.some(point => !active.raw.some(before => before.id === point.id))) {
      retire(); return;
    }
    const points = project(packet.touches, active, surface.bounds);
    active.raw = packet.touches;
    active.projected = points;
    if (packet.phase === "end") gesture = undefined;
    pendingWrites++;
    deliveryTail = deliveryTail.then(async () => {
      if (stamp !== epoch) return;
      if (!current()) { retire(); return; }
      if (packet.phase === "begin") {
        const { x, y } = active.anchor;
        const reply = await debuggerSession.sendCommand("Runtime.callFunctionOn", { objectId: surface.frameObjectId,
          functionDeclaration: `function(x,y,url) { return (${READY_FRAME})(x,y,url) === this; }`, returnByValue: true,
          arguments: [{ value: x }, { value: y }, { value: surface.bootstrapUrl }] });
        if (stamp !== epoch) return;
        if (reply.result?.value !== true || !current()) { retire(); return; }
        deliveredGesture = active;
      }
      const accepted = await deliver(surface, packet.phase, points, active.anchor);
      if (stamp !== epoch) return;
      if (!accepted || !current()) { retire(); return; }
      if (surface.mode === "touch") {
        // Chromium's synthetic input router hit-tests the root viewport. Each move
        // supplies the active contacts, allowing the router to release omitted IDs.
        const type = packet.phase === "begin" ? "touchStart" : packet.phase === "end" ? "touchEnd" : "touchMove";
        await dispatchTouch(type, points);
      }
      if (stamp === epoch && packet.phase === "end") deliveredGesture = undefined;
    }).catch(() => { if (stamp === epoch) retire(); }).finally(() => { if (stamp === epoch) pendingWrites--; });
  }

  async function locate(point: Point): Promise<void> {
    if (pendingRead || owner !== undefined || !current() || performance.now() - lastRead < 30) return;
    lastRead = performance.now();
    const stamp = epoch;
    const selectedZoom = contents.getZoomFactor(), selectedUrl = contents.getURL();
    let attachment: object | undefined;
    let parentObject: string | undefined, surfaceObject: string | undefined, frameSession: string | undefined;
    const lookup = {};
    pendingRead = lookup;
    const timer = setTimeout(() => { if (pendingRead === lookup && stamp === epoch) retire(); }, 750);
    try {
      const bootstrapUrl = new URL("./isolated-surface.html", options.bootstrapBaseUrl?.() ?? selectedUrl).href;
      const expression = `(${READY_FRAME})(${point.x},${point.y},${JSON.stringify(bootstrapUrl)})`;
      if (await contents.executeJavaScript(`Boolean(${expression})`) !== true || stamp !== epoch
        || !current() || contents.getURL() !== selectedUrl || debuggerSession.isAttached()) return;
      debuggerSession.attach("1.3");
      attachment = {};
      owner = attachment;
      await debuggerSession.sendCommand("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
        filter: [{ type: "iframe" }, { exclude: true }] });
      const parent = await debuggerSession.sendCommand("Runtime.evaluate", { expression });
      parentObject = parent.result?.objectId;
      if (parentObject === undefined || stamp !== epoch) return;
      const [description, frameReply] = await Promise.all([
        debuggerSession.sendCommand("DOM.describeNode", { objectId: parentObject }),
        debuggerSession.sendCommand("Runtime.callFunctionOn", { objectId: parentObject, functionDeclaration: READ_FRAME_BOUNDS, returnByValue: true })
      ]);
      const frameId: unknown = description.node?.frameId;
      const frame = frameReply.result?.value as FrameBounds | undefined;
      if (typeof frameId !== "string" || frame === undefined || !validRect(frame) || !contains(frame, point)
        || !Number.isFinite(frame.scaleX) || !Number.isFinite(frame.scaleY) || frame.scaleX <= 0 || frame.scaleY <= 0 || stamp !== epoch) return;
      frameSession = iframeSessions.get(frameId);
      const world = await debuggerSession.sendCommand("Page.createIsolatedWorld", { frameId, worldName: "joko-native-trackpad" }, frameSession);
      if (!Number.isSafeInteger(world.executionContextId) || stamp !== epoch) return;
      const frameX = (point.x - frame.x) / frame.scaleX, frameY = (point.y - frame.y) / frame.scaleY;
      const hit = await debuggerSession.sendCommand("Runtime.evaluate", {
        expression: `(${READ_SURFACE})(${frameX},${frameY})`, contextId: world.executionContextId
      }, frameSession);
      surfaceObject = hit.result?.objectId;
      if (surfaceObject === undefined || stamp !== epoch) return;
      const reply = await debuggerSession.sendCommand("Runtime.callFunctionOn", {
        objectId: surfaceObject, functionDeclaration: READ_SURFACE_BOUNDS, returnByValue: true
      }, frameSession);
      const rect = reply.result?.value as (Rect & { mode: unknown }) | undefined;
      if (rect === undefined || !validRect(rect) || (rect.mode !== "touch" && rect.mode !== "contacts")) return;
      const bounds = { x: frame.x + rect.x * frame.scaleX, y: frame.y + rect.y * frame.scaleY,
        width: rect.width * frame.scaleX, height: rect.height * frame.scaleY };
      if (stamp !== epoch || !current() || pointer === undefined || !contains(bounds, pointer)
        || contents.getURL() !== selectedUrl || contents.getZoomFactor() !== selectedZoom) return;
      const token = native.start(window.getNativeWindowHandle(), (text) => send(text, stamp));
      if (token === null) return;
      capture = { objectId: surfaceObject, frameObjectId: parentObject, bounds, frame, bootstrapUrl, mode: rect.mode,
        ...(frameSession === undefined ? {} : { session: frameSession }) };
      captureToken = token;
      originUrl = selectedUrl;
      zoom = selectedZoom;
    } catch { /* The input continues through the ordinary AppKit gesture path. */ }
    finally {
      clearTimeout(timer);
      if (pendingRead === lookup) pendingRead = undefined;
      if (owner === attachment && attachment !== undefined && capture === undefined) detachDebugger(attachment);
    }
  }

  function pointerMoved(): void {
    if (!current() || gesture !== undefined) return;
    const position = native.position(window.getNativeWindowHandle());
    const factor = contents.getZoomFactor();
    if (position === null || !validPoint(position) || !Number.isFinite(factor) || factor <= 0) { retire(); return; }
    pointer = { x: position.x / factor, y: position.y / factor };
    if (capture && (!contains(capture.bounds, pointer) || factor !== zoom)) {
      const previous = retire(), next = pointer;
      if (previous !== undefined) {
        void previous.then(() => { if (pointer === next) void locate(next); });
        return;
      }
    }
    if (capture === undefined) void locate(pointer);
  }

  contents.on("before-mouse-event", (_event, mouse) => {
    if (mouse.type === "mouseDown" || mouse.type === "mouseLeave") retire();
    if (mouse.type === "mouseMove" || mouse.type === "mouseUp" || mouse.type === "mouseEnter") pointerMoved();
  });
  contents.on("did-start-navigation", details => { if (details.isMainFrame || !details.isSameDocument) retire(); });
  contents.on("render-process-gone", retire);
  contents.on("zoom-changed", retire);
  contents.on("blur", retire);
  contents.on("focus", pointerMoved);
  debuggerSession.on("message", (_event, method, params) => {
    if (owner === undefined) return;
    if (method === "Target.attachedToTarget" && params.targetInfo?.type === "iframe"
      && typeof params.targetInfo.targetId === "string" && typeof params.sessionId === "string" && iframeSessions.size < 256) {
      iframeSessions.set(params.targetInfo.targetId, params.sessionId);
    }
    if (method === "Target.detachedFromTarget") {
      for (const [frameId, session] of iframeSessions) if (session === params.sessionId) iframeSessions.delete(frameId);
      if (capture?.session !== undefined && capture.session === params.sessionId) retire();
    }
  });
  debuggerSession.on("detach", () => { owner = undefined; iframeSessions.clear(); retire(); });
  window.on("blur", retire);
  window.on("focus", pointerMoved);
  window.on("resize", retire);
  window.on("hide", retire);
  contents.once("destroyed", () => {
    retire();
    window.removeListener("blur", retire);
    window.removeListener("focus", pointerMoved);
    window.removeListener("resize", retire);
    window.removeListener("hide", retire);
  });
}

function validPoint(point: Point): boolean { return Number.isFinite(point.x) && Number.isFinite(point.y); }
function validRect(rect: Rect): boolean {
  return validPoint(rect) && Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width >= 2 && rect.height >= 2;
}
function contains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
}

function parsePacket(source: string): Packet | undefined {
  if (source.length > 1_024) return undefined;
  let packet: Packet;
  try { packet = JSON.parse(source) as Packet; } catch { return undefined; }
  if (!packet || !["begin", "change", "end", "cancel"].includes(packet.phase) || !Array.isArray(packet.touches)) return undefined;
  const count = packet.touches.length;
  if (packet.phase === "begin" ? count !== 2 : packet.phase === "change" ? count < 1 || count > 2 : count !== 0) return undefined;
  if (count && (typeof packet.width !== "number" || !Number.isFinite(packet.width) || packet.width <= 0
    || typeof packet.height !== "number" || !Number.isFinite(packet.height) || packet.height <= 0)) return undefined;
  if (packet.touches.some(point => !point || ![0, 1].includes(point.id) || !validPoint(point)
    || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)
    || new Set(packet.touches.map(point => point.id)).size !== count) return undefined;
  return packet;
}

function project(touches: readonly Contact[], gesture: Gesture, bounds: Rect): readonly Contact[] {
  const distance = Math.max(bounds.width, bounds.height);
  const clip = (point: number, start: number, length: number) => Math.max(start + 0.5, Math.min(start + length - 0.5, point));
  return touches.map(touch => {
    const start = gesture.projected.find(before => before.id === touch.id) ?? gesture.anchor;
    const previous = gesture.raw.find(before => before.id === touch.id) ?? gesture.centre;
    return { id: touch.id,
      x: clip(start.x + (touch.x - previous.x) * distance, bounds.x, bounds.width),
      y: clip(start.y + (touch.y - previous.y) * distance * gesture.aspect, bounds.y, bounds.height) };
  });
}
