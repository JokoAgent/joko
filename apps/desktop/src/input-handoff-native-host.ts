import { randomUUID } from "node:crypto";
import { createClient, type Client, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { screen } from "electron";
import type { RemoteDesktopHandoffWindow } from "@joko/device-peer";
import type { RemoteDesktopInput } from "@joko/device-peer";
import type { DesktopRemoteDesktopInputOwnership } from "./remote-desktop-host.js";
import { ConnectionService, DesktopInputHandoffHostService, NativeInputHandoffMethod as Method, type HandoffDriver,
  type NativeActRequest, type NativeInputHandoffCommand, type NativeWindowRef, type PointerRequest } from "@joko/contracts";
import { DESKTOP_HOST_AUTHORIZATION_HEADER } from "@joko/contracts/desktop-bootstrap";
import type { DesktopManagedOrchestratorConnection } from "./channels.js";
import { createMacHandoffDriver } from "./input-handoff-macos-driver.js";

type HostClient = Client<typeof DesktopInputHandoffHostService>;
interface RegisteredHost { readonly client: HostClient; readonly scope: { hostInstanceId: string; hostGeneration: bigint }; readonly connection: DesktopManagedOrchestratorConnection; readonly signal: AbortSignal }
export interface DesktopInputHandoffHostOptions {
  readonly readAuthKey: (profileId: string) => Promise<string | undefined>;
  readonly readHostKey: (profileId: string) => Promise<string | undefined>;
  readonly isAuthorityCurrent: (connection: DesktopManagedOrchestratorConnection) => boolean | Promise<boolean>;
  readonly platform?: NodeJS.Platform;
  readonly createDriver?: (signal: AbortSignal) => HandoffDriver;
}
/** Main-only native execution. Server identity is verified before reading any
 * key; each command is admitted and monitored under its exact host generation. */
export class DesktopInputHandoffHost {
  readonly #instance = randomUUID(); #connection: DesktopManagedOrchestratorConnection | undefined; #lifetime: AbortController | undefined;
  #registered: RegisteredHost | undefined;
  constructor(readonly options: DesktopInputHandoffHostOptions) {}
  setConnection(connection: DesktopManagedOrchestratorConnection | undefined): void {
    if ((this.options.platform ?? process.platform) !== "darwin") connection = undefined;
    if (JSON.stringify(connection) === JSON.stringify(this.#connection)) return;
    this.#lifetime?.abort(); this.#registered = undefined; this.#connection = connection;
    if (!connection) { this.#lifetime = undefined; return; }
    const lifetime = new AbortController(); this.#lifetime = lifetime; void this.#run(connection, lifetime.signal).catch(() => undefined);
  }
  close(): void { this.setConnection(undefined); }
  async resolveLiveWindow(requestId: string, controllerDeviceId: string, signal: AbortSignal): Promise<RemoteDesktopHandoffWindow | null> {
    const owner = this.#registered; if (!owner) return null;
    const response = await owner.client.resolveNativeInputHandoffWindow({ ...owner.scope, requestId, controllerDeviceId }, { signal: AbortSignal.any([signal, owner.signal]) });
    const window = response.window;
    if (!window || window.requestId !== requestId || this.#registered !== owner || !await this.options.isAuthorityCurrent(owner.connection)) return null;
    if (!Number.isSafeInteger(window.windowId) || window.windowId < 1 || !Number.isSafeInteger(window.processId) || window.processId < 1
      || !window.app || window.app.length > 300 || window.frame.length !== 4 || !window.frame.every(Number.isFinite)) return null;
    const [x, y, width, height] = window.frame as [number, number, number, number];
    if (width < 1 || height < 1 || width > 32_768 || height > 32_768) return null;
    const display = screen.getDisplayMatching({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
    return { requestId, windowId: window.windowId, pid: window.processId, displayId: String(display.id), app: window.app,
      ...(window.title ? { title: window.title } : {}), width: Math.round(width), height: Math.round(height) };
  }
  async isLiveWindowCurrent(window: RemoteDesktopHandoffWindow, controllerDeviceId: string, signal: AbortSignal): Promise<boolean> {
    const owner = this.#registered; if (!owner) return false;
    try {
      const result = await owner.client.checkNativeInputHandoffWindow({ ...owner.scope, requestId: window.requestId, controllerDeviceId, windowId: window.windowId, processId: window.pid }, { signal: AbortSignal.any([signal, owner.signal]) });
      return result.current && this.#registered === owner && await this.options.isAuthorityCurrent(owner.connection);
    } catch { return false; }
  }
  liveViewEnded(window: RemoteDesktopHandoffWindow, controllerDeviceId: string): void {
    const owner = this.#registered; if (!owner) return;
    void owner.client.endNativeInputHandoffWindow({ ...owner.scope, requestId: window.requestId, controllerDeviceId, windowId: window.windowId, processId: window.pid }, { signal: owner.signal }).catch(() => undefined);
  }
  liveInputOwnership(window: RemoteDesktopHandoffWindow, controllerDeviceId: string): DesktopRemoteDesktopInputOwnership {
    const inputOwnerId = randomUUID();
    const request = (owner: RegisteredHost) => ({ ...owner.scope, requestId: window.requestId,
      controllerDeviceId, windowId: window.windowId, processId: window.pid });
    let captured = this.#registered;
    return {
      begin: async (events: readonly RemoteDesktopInput[], signal: AbortSignal) => {
        const owner = this.#registered; if (!owner || owner !== captured) throw invalid();
        const gestures = events.map(event => event.kind === "key" || event.kind === "release" ? event
          : event.kind === "button" ? { ...event, x: 0, y: 0 } : { kind: "text", text: "" });
        const gestureState = Buffer.from(JSON.stringify(gestures));
        try {
          const result = await owner.client.beginNativeInputHandoffInput({ window: request(owner), inputOwnerId, gestureState }, { signal: AbortSignal.any([signal, owner.signal]) });
          signal.throwIfAborted(); if (this.#registered !== owner || !result.inputBatchId) throw invalid();
          return async () => { const current = this.#registered; if (!current || current.connection.serverId !== owner.connection.serverId) return;
            await current.client.finishNativeInputHandoffInput({ window: request(current), inputOwnerId, inputBatchId: result.inputBatchId }, { signal: current.signal }); };
        } finally { gestureState.fill(0); }
      },
      close: async () => { const owner = this.#registered; if (!owner || !captured || owner.connection.serverId !== captured.connection.serverId) return;
        await owner.client.finishNativeInputHandoffInput({ window: request(owner), inputOwnerId, closed: true }, { signal: owner.signal }).catch(() => undefined); captured = undefined; }
    };
  }
  async #client(connection: DesktopManagedOrchestratorConnection, signal: AbortSignal): Promise<HostClient> {
    const current = async () => { signal.throwIfAborted(); if (!await this.options.isAuthorityCurrent(connection)) throw new Error("Native input host retired."); };
    const identity = await createClient(ConnectionService, createConnectTransport({ baseUrl: connection.origin, httpVersion: "1.1", defaultTimeoutMs: 5_000 })).getServerInfo({}, { signal });
    await current(); if (identity.server?.serverId !== connection.serverId) throw new Error("Native input service changed.");
    const auth = await this.options.readAuthKey(connection.profileId), host = await this.options.readHostKey(connection.profileId); await current();
    if (!auth || !host) throw new Error("Native input host authorization is unavailable.");
    const authorize: Interceptor = next => async request => { await current(); request.header.set("authorization", `Bearer ${auth}`); request.header.set(DESKTOP_HOST_AUTHORIZATION_HEADER, `Bearer ${host}`); return next(request); };
    return createClient(DesktopInputHandoffHostService, createConnectTransport({ baseUrl: connection.origin, httpVersion: "1.1", interceptors: [authorize], defaultTimeoutMs: 25_000 }));
  }
  async #run(connection: DesktopManagedOrchestratorConnection, signal: AbortSignal): Promise<void> {
    let retry = 500;
    while (!signal.aborted) {
      try {
        const client = await this.#client(connection, signal), registered = await client.registerNativeInputHandoffHost({ hostInstanceId: this.#instance, platform: "darwin", processId: process.pid }, { signal });
        const scope = { hostInstanceId: this.#instance, hostGeneration: registered.hostGeneration };
        this.#registered = { client, scope, connection, signal };
        while (!signal.aborted) {
          const response = await client.pollNativeInputHandoffCommand(scope, { signal }); signal.throwIfAborted();
          if (!await this.options.isAuthorityCurrent(connection)) return;
          const command = response.command; if (!command) continue;
          const request = { ...scope, commandId: command.commandId }, active = new AbortController();
          const abort = () => active.abort(), valid = async () => {
            const admitted = await client.admitNativeInputHandoffCommand(request, { signal }); if (!admitted.current) abort();
          };
          signal.addEventListener("abort", abort, { once: true });
          let monitoring = false;
          const monitor = setInterval(() => { if (monitoring || active.signal.aborted) return; monitoring = true; void valid().catch(abort).finally(() => { monitoring = false; }); }, 500); monitor.unref();
          let payload: Uint8Array = new Uint8Array(), success = false;
          try {
            await valid(); active.signal.throwIfAborted();
            const driver = (this.options.createDriver ?? createMacHandoffDriver)(active.signal);
            const value = await executeNativeInputHandoffCommand(command, driver); active.signal.throwIfAborted();
            payload = encodeNativeResult(value); success = true; wipePictures(value);
          } catch { payload = Buffer.from("null"); }
          finally { clearInterval(monitor); signal.removeEventListener("abort", abort); active.abort(); command.payload.fill(0); }
          // Completion retries only the receipt. A native effect never runs twice.
          try { for (let attempt = 0; ; attempt++) { try { await client.completeNativeInputHandoffCommand({ ...request, success, payload }, { signal }); break; }
            catch (error) { if (attempt >= 2 || signal.aborted) throw error; await delay(500 * (attempt + 1), signal); } } }
          finally { payload.fill(0); }
          retry = 500;
        }
      } catch { if (this.#registered?.signal === signal) this.#registered = undefined; if (!signal.aborted) await delay(retry, signal); retry = Math.min(30_000, retry * 2); }
    }
  }
}

export async function executeNativeInputHandoffCommand(command: Pick<NativeInputHandoffCommand, "method" | "payload">, driver: HandoffDriver): Promise<unknown> {
  if (command.payload.byteLength > 65_536) throw invalid();
  const raw: unknown = JSON.parse(Buffer.from(command.payload).toString("utf8")), body = record(raw);
  const target = (): { pid: number; window: NativeWindowRef } => ({ pid: pid(body.pid), window: windowRef(body.window) });
  switch (command.method) {
    case Method.PERMISSION: exact(body, []); return driver.permission();
    case Method.REQUEST_PERMISSION: exact(body, []); await driver.requestPermission(); return null;
    case Method.WINDOWS: exact(body, []); return driver.windows();
    case Method.SNAPSHOT: exact(body, ["pid"], ["window"]); return driver.snapshot(pid(body.pid), body.window === undefined ? undefined : windowRef(body.window));
    case Method.COMMAND_LINE: exact(body, ["pid"]); return driver.commandLine(pid(body.pid));
    case Method.CAPTURE: exact(body, ["pid", "window"]); if (!driver.capture) throw invalid(); return driver.capture(target());
    case Method.RAISE: exact(body, ["pid", "window"]); if (!driver.raise) throw invalid(); return driver.raise(target());
    case Method.FOCUSED_FIELD: exact(body, ["pid"]); if (!driver.focusedField) throw invalid(); return driver.focusedField(pid(body.pid));
    case Method.QR: exact(body, ["pid", "window", "frame"]); if (!driver.qr) throw invalid(); return driver.qr(target(), body.frame === null ? null : numbers(body.frame, 4));
    case Method.ACT: {
      exact(body, ["pid", "window", "ref", "fp", "kind"], ["value"]); target();
      if (!text(body.ref, 1024) || !text(body.fp, 4096) || !["press", "text", "key"].includes(String(body.kind)) || body.value !== undefined && !text(body.value, 4096, true)) throw invalid();
      return driver.act(body as unknown as NativeActRequest);
    }
    case Method.POINTER: {
      target(); numbers(body.windowFrame, 4);
      if (body.kind === "tap") {
        exact(body, ["kind", "pid", "window", "windowFrame", "area", "point"]);
        const [x, y, width, height] = numbers(body.area, 4) as [number, number, number, number], [px, py] = numbers(body.point, 2) as [number, number];
        if (width <= 0 || height <= 0 || px < x || px > x + width || py < y || py > y + height) throw invalid();
      }
      else if (body.kind === "type") { exact(body, ["kind", "pid", "window", "windowFrame", "value", "submit", "secure"]); if (!text(body.value, 4096, true) || typeof body.submit !== "boolean" || typeof body.secure !== "boolean") throw invalid(); }
      else throw invalid();
      if (!driver.pointer) throw invalid(); return driver.pointer(body as unknown as PointerRequest);
    }
    default: throw invalid();
  }
}
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): void { if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw invalid(); }
function pid(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) <= 0) throw invalid(); return value as number; }
function windowRef(value: unknown): NativeWindowRef { const item = record(value); exact(item, ["index", "title"]); if (!Number.isSafeInteger(item.index) || (item.index as number) < 0 || !text(item.title, 300, true)) throw invalid(); return item as unknown as NativeWindowRef; }
function text(value: unknown, maximum: number, empty = false): value is string { return typeof value === "string" && (empty || !!value) && value.length <= maximum && !value.includes("\0"); }
function numbers(value: unknown, length: number): number[] { if (!Array.isArray(value) || value.length !== length || value.some(item => typeof item !== "number" || !Number.isFinite(item))) throw invalid(); return value as number[]; }
function invalid(): Error { return new Error("Native input handoff command is invalid."); }
function encodeNativeResult(value: unknown): Uint8Array { const bytes = Buffer.from(JSON.stringify(value, (key, item: unknown) => key === "jpeg" ? Buffer.from(item as Uint8Array).toString("base64") : item)); if (bytes.length > 8_000_000) throw invalid(); return bytes; }
function wipePictures(value: unknown): void { if (!value || typeof value !== "object") return; for (const [key, item] of Object.entries(value)) { if (key === "jpeg" && item instanceof Uint8Array) item.fill(0); else wipePictures(item); } }
function delay(ms: number, signal: AbortSignal): Promise<void> { return new Promise(resolve => { const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }; const timer = setTimeout(done, ms); timer.unref(); signal.addEventListener("abort", done, { once: true }); if (signal.aborted) done(); }); }
