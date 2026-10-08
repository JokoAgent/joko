import { base64Decode, base64Encode } from "@bufbuild/protobuf/wire";
import {
  allowMobileExtensionMainViewNavigation,
  type MobileExtension, type MobileExtensionMainViewSurface, type MobileExtensionTransport
} from "./mobile-extensions";
import {
  EXTENSION_LIBRARY_BRIDGE_RESPONSE, EXTENSION_LIBRARY_BRIDGE_VERSION,
  extensionLibraryBridgeCapabilities, parseMobileExtensionLibraryRequest,
  type MobileExtensionLibraryRequest, type MobileExtensionLibrarySession
} from "./mobile-extension-library-runtime";

export const MOBILE_LIBRARY_MESSAGE_CHARACTERS = 24 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAXIMUM_PENDING = 16;
const MAXIMUM_REQUESTS_PER_FRAME = 4096;
const INTEGER = /^-?(?:0|[1-9][0-9]{0,19})$/u;

export function encodeMobileLibraryMessage(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint"
    ? { $jokoLibraryInteger: item.toString(10) }
    : item instanceof Uint8Array ? { $jokoLibraryBytes: base64Encode(item) } : item);
  if (encoded === undefined || encoded.length > MOBILE_LIBRARY_MESSAGE_CHARACTERS) throw new Error("Library message is too large.");
  return encoded;
}

export function decodeMobileLibraryMessage(value: string): unknown {
  if (value.length > MOBILE_LIBRARY_MESSAGE_CHARACTERS) throw new Error("Library message is too large.");
  return JSON.parse(value, (_key, item: unknown) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    if ("$jokoLibraryInteger" in record) {
      if (Object.keys(record).length !== 1 || typeof record.$jokoLibraryInteger !== "string"
        || !INTEGER.test(record.$jokoLibraryInteger)) throw new Error("Invalid Library integer.");
      return BigInt(record.$jokoLibraryInteger);
    }
    if ("$jokoLibraryBytes" in record) {
      if (Object.keys(record).length !== 1 || typeof record.$jokoLibraryBytes !== "string"
        || record.$jokoLibraryBytes.length > 4 * Math.ceil(16 * 1024 * 1024 / 3)) throw new Error("Invalid Library bytes.");
      const bytes = base64Decode(record.$jokoLibraryBytes);
      if (bytes.byteLength > 16 * 1024 * 1024 || base64Encode(bytes) !== record.$jokoLibraryBytes) throw new Error("Invalid Library bytes.");
      return bytes;
    }
    return item;
  });
}

/** A lease belongs to one document occurrence; it is never stored in a draft or receipt. */
export class MobileExtensionLibraryBridge {
  readonly #seen = new Set<string>();
  readonly #requests = new Set<AbortController>();
  #queue: Promise<void> = Promise.resolve();
  #session: MobileExtensionLibrarySession | undefined;
  #disposed = false;
  #faulted = false;

  constructor(readonly context: {
    readonly extension: MobileExtension;
    readonly surface: MobileExtensionMainViewSurface;
    readonly frameId: string;
    readonly transport: MobileExtensionTransport;
    readonly current: () => boolean;
    readonly send: (message: string) => void;
    readonly timeoutMs?: number;
  }) {}

  receive(data: string, url: string): void {
    if (!this.#current() || !allowMobileExtensionMainViewNavigation(this.context.surface, url)) return;
    let wrapper: unknown;
    try { wrapper = decodeMobileLibraryMessage(data); } catch { return; }
    if (typeof wrapper !== "object" || wrapper === null || Array.isArray(wrapper)) return;
    const value = wrapper as Record<string, unknown>;
    if (Object.keys(value).length !== 3 || value.surfaceId !== this.context.surface.surfaceId
      || value.frameId !== this.context.frameId || !("request" in value)) return;
    const request = parseMobileExtensionLibraryRequest(value.request);
    if (request === undefined || this.#seen.has(request.id)) return;
    if (this.#seen.size >= MAXIMUM_REQUESTS_PER_FRAME) {
      this.#respond(request.id, { ok: false, error: { code: "reopen-required", message: "Refresh the main view to continue." } });
      this.dispose();
      return;
    }
    this.#seen.add(request.id);
    if (request.command.kind === "capabilities") {
      this.#respond(request.id, { ok: true, result: extensionLibraryBridgeCapabilities() });
      return;
    }
    if (this.#faulted || this.#requests.size >= MAXIMUM_PENDING) {
      this.#respond(request.id, { ok: false, error: {
        code: this.#faulted ? "reopen-required" : "busy",
        message: this.#faulted ? "Refresh the main view before retrying." : "Too many Library requests."
      } });
      return;
    }
    const abort = new AbortController();
    this.#requests.add(abort);
    let dispatched = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = this.#queue.then(async () => {
      abort.signal.throwIfAborted();
      if (!this.#current() || this.#faulted) throw new Error("Library bridge retired.");
      dispatched = true;
      const result = await this.#execute(request, abort.signal);
      abort.signal.throwIfAborted();
      return result;
    });
    this.#queue = work.then(() => undefined, () => undefined);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error("Library request timed out."));
      }, this.context.timeoutMs ?? REQUEST_TIMEOUT_MS);
    });
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort.signal.addEventListener("abort", () => reject(new Error("Library request cancelled.")), { once: true });
    });
    void Promise.race([work, timeout, cancelled]).then((result) => {
      this.#respond(request.id, { ok: true, result });
    }, () => {
      if (dispatched) {
        this.#faulted = true;
        this.#retireSession();
      }
      this.#respond(request.id, { ok: false, error: {
        code: dispatched ? "result-unknown" : "cancelled",
        message: dispatched ? "The Library request could not be confirmed. It was not resent. Refresh the main view before retrying."
          : "The Library request was cancelled before dispatch."
      } });
    }).finally(() => {
      clearTimeout(timer);
      abort.abort();
      this.#requests.delete(abort);
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const request of this.#requests) request.abort();
    this.#requests.clear();
    this.#retireSession();
  }

  #current(): boolean {
    return !this.#disposed && this.context.current() && this.context.surface.expiresAt > Date.now();
  }

  #retireSession(): void {
    const session = this.#session;
    this.#session = undefined;
    if (session !== undefined) void this.context.transport.closeLibrary(session).catch(() => undefined);
  }

  async #execute(request: MobileExtensionLibraryRequest, signal: AbortSignal): Promise<unknown> {
    const { extension, surface, transport } = this.context;
    if (request.command.kind === "status") {
      const overview = await transport.libraryStatus(extension, surface, signal);
      return {
        state: overview.state, unavailableReason: overview.unavailableReason, location: overview.location?.kind,
        files: overview.files, bytes: overview.bytes, diskFreeBytes: overview.diskFreeBytes,
        softLimitBytes: overview.softLimitBytes, softLimitExceeded: overview.softLimitExceeded,
        orphaned: overview.orphaned, operation: overview.operation
      };
    }
    if (this.#session !== undefined && this.#session.expiresAt <= Date.now()) this.#retireSession();
    if (this.#session === undefined) {
      const session = await transport.openLibrary(extension, surface, signal);
      if (signal.aborted || !this.#current() || this.#faulted) {
        void transport.closeLibrary(session).catch(() => undefined);
        throw new Error("Library session retired.");
      }
      this.#session = session;
    }
    const session = this.#session;
    if (request.command.kind === "open") return {
      extensionId: session.extensionId, expiresAt: session.expiresAt, bindingGeneration: session.bindingGeneration,
      limits: session.limits
    };
    if (request.command.kind !== "call") throw new Error("Invalid Library request.");
    return transport.callLibrary(extension, surface, session, request.command.call, signal);
  }

  #respond(id: string, value: unknown): void {
    if (!this.#current()) return;
    const wrapper = {
      frameId: this.context.frameId, surfaceId: this.context.surface.surfaceId,
      response: { type: EXTENSION_LIBRARY_BRIDGE_RESPONSE, version: EXTENSION_LIBRARY_BRIDGE_VERSION, id, ...value as object }
    };
    try { this.context.send(encodeMobileLibraryMessage(wrapper)); } catch {
      this.#faulted = true;
      this.#retireSession();
      this.context.send(encodeMobileLibraryMessage({ ...wrapper, response: {
        type: EXTENSION_LIBRARY_BRIDGE_RESPONSE, version: EXTENSION_LIBRARY_BRIDGE_VERSION, id,
        ok: false, error: { code: "result-unknown", message: "The Library response could not be delivered. Refresh the main view." }
      } }));
    }
  }
}

const BOOTSTRAP = String.raw`function(frameId, surfaceId) {
  var marker = Symbol.for("joko.extension-library-mobile.transport");
  if (window !== window.top || !window.ReactNativeWebView || window[marker]) return;
  Object.defineProperty(window, marker, { value: true });
  var requestType = "joko:extension-library-request", responseType = "joko:extension-library-response";
  var delivered = new Set(), closed = false, maximum = 25165824;
  function encode(value) {
    var json = JSON.stringify(value, function(key, item) {
      if (typeof item === "bigint") return { $jokoLibraryInteger: item.toString(10) };
      if (item instanceof Uint8Array) {
        if (item.byteLength > 16777216) throw new Error("Library bytes are too large.");
        var blocks = [];
        for (var offset = 0; offset < item.length; offset += 8192)
          blocks.push(String.fromCharCode.apply(null, item.subarray(offset, offset + 8192)));
        return { $jokoLibraryBytes: btoa(blocks.join("")) };
      }
      return item;
    });
    if (!json || json.length > maximum) throw new Error("Library message is too large.");
    return json;
  }
  function decode(json) {
    return JSON.parse(json, function(key, item) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      if (Object.prototype.hasOwnProperty.call(item, "$jokoLibraryInteger")) {
        if (Object.keys(item).length !== 1 || typeof item.$jokoLibraryInteger !== "string"
          || !/^-?(?:0|[1-9][0-9]{0,19})$/.test(item.$jokoLibraryInteger)) throw new Error("Invalid Library integer.");
        return BigInt(item.$jokoLibraryInteger);
      }
      if (Object.prototype.hasOwnProperty.call(item, "$jokoLibraryBytes")) {
        if (Object.keys(item).length !== 1 || typeof item.$jokoLibraryBytes !== "string") throw new Error("Invalid Library bytes.");
        var binary = atob(item.$jokoLibraryBytes), bytes = new Uint8Array(binary.length);
        if (bytes.length > 16777216 || btoa(binary) !== item.$jokoLibraryBytes) throw new Error("Invalid Library bytes.");
        for (var index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
        return bytes;
      }
      return item;
    });
  }
  function send(request) {
    if (closed) throw new Error("Library page closed.");
    window.ReactNativeWebView.postMessage(encode({ frameId: frameId, surfaceId: surfaceId, request: request }));
  }
  function receive(event) {
    if (closed || typeof event.data !== "string" || event.data.length > maximum) return;
    var value;
    try { value = decode(event.data); } catch (error) { return; }
    if (!value || value.frameId !== frameId || value.surfaceId !== surfaceId || !value.response
      || value.response.type !== responseType || value.response.version !== 1 || typeof value.response.id !== "string"
      || delivered.has(value.response.id)) return;
    delivered.add(value.response.id);
    var response = value.response;
    window.dispatchEvent(new MessageEvent("message", { data: response, source: window, origin: window.location.origin }));
  }
  function forward(event) {
    var value = event.data;
    if (closed || event.source !== window || event.origin !== window.location.origin || !value
      || value.type !== requestType || value.version !== 1) return;
    try { send(value); } catch (error) { }
  }
  window.addEventListener("message", receive);
  document.addEventListener("message", receive);
  window.addEventListener("message", forward);
  window.addEventListener("pagehide", function() {
    closed = true;
  }, { once: true });
  window.dispatchEvent(new Event("joko:extension-library-transport-ready"));
}`;

export function mobileExtensionLibraryBootstrap(frameId: string, surfaceId: string): string {
  return `(${BOOTSTRAP})(${JSON.stringify(frameId)},${JSON.stringify(surfaceId)});true;`;
}
