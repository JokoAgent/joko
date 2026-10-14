import type { BrowserContext, CDPSession } from "playwright-core";
import { isBrowserProxyRequestUrlAllowed, type BrowserProxyLookup, type BrowserProxyRoute } from "./proxy.js";

const NETWORK_TARGETS = new Set(["page", "iframe", "service_worker", "shared_worker", "worker", "shared_storage_worklet", "worklet"]);
const COMMAND_TIMEOUT_MS = 10_000;
interface CdpMessage {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}
interface Pending { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> }
export interface BrowserProxyRequestGateHandle {
  readonly active: boolean;
  start(): Promise<void>;
  /** Keep paused requests blocked while the exact owned writer retires. */
  beginRetirement(): void;
  dispose(): Promise<void>;
}

/** Lifetime network-target gate using the Provider's owned Browser pipe. */
export class BrowserProxyRequestGate implements BrowserProxyRequestGateHandle {
  readonly #context: BrowserContext;
  readonly #route: BrowserProxyRoute;
  readonly #onFailure: () => void;
  readonly #lookup: BrowserProxyLookup | undefined;
  #session: CDPSession | undefined;
  #nextId = 1;
  #closing = false;
  #failed = false;
  readonly #retired = new AbortController();
  readonly #pending = new Map<number, Pending>();
  readonly #parents = new Map<string, string | undefined>();
  readonly #targets = new Map<string, string>();
  readonly #setups = new Map<string, Promise<void>>();
  readonly #tasks = new Set<Promise<void>>();
  readonly #onEvent = (message: { readonly method: string; readonly params?: object }) => {
    this.#enqueue({ method: message.method, ...(message.params === undefined ? {} : { params: message.params as Record<string, unknown> }) });
  };
  readonly #onClose = () => { if (!this.#closing) this.#fail(); };

  constructor(context: BrowserContext, route: BrowserProxyRoute, onFailure: () => void, lookup?: BrowserProxyLookup) {
    this.#context = context;
    this.#route = route;
    this.#onFailure = onFailure;
    this.#lookup = lookup;
  }
  get active(): boolean { return this.#session !== undefined && !this.#closing && !this.#failed; }

  async start(): Promise<void> {
    if (this.#route.mode !== "proxied") return;
    const browser = this.#context.browser();
    if (browser === null) throw new Error("The owned Browser CDP channel is unavailable.");
    this.#session = await browser.newBrowserCDPSession();
    this.#session.on("event", this.#onEvent);
    this.#session.on("close", this.#onClose);
    await this.#command("Target.setDiscoverTargets", { discover: true });
    // Playwright owns the root CDP session. Non-flat child sessions let us
    // transport their commands through that exact pipe, without a public port.
    await this.#command("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
    const targets = await this.#command("Target.getTargets") as { readonly targetInfos?: readonly { readonly targetId?: string; readonly type?: string }[] };
    for (const target of targets.targetInfos ?? []) {
      if (target.targetId !== undefined && target.type !== undefined && NETWORK_TARGETS.has(target.type)) await this.#attach(target.targetId);
    }
    await this.#command("Target.getTargets");
    while (this.#tasks.size > 0) await this.#awaitAlive(Promise.allSettled([...this.#tasks]));
    if (!this.active) throw new Error("The Browser proxy request gate could not be established.");
  }

  beginRetirement(): void {
    this.#closing = true;
    this.#retired.abort(new Error("The Browser proxy gate is retiring."));
    this.#rejectPending();
  }
  async dispose(): Promise<void> {
    this.beginRetirement();
    this.#rejectPending();
    const session = this.#session;
    this.#session = undefined;
    if (session !== undefined) {
      session.off("event", this.#onEvent);
      session.off("close", this.#onClose);
      await session.detach().catch(() => undefined);
    }
    this.#parents.clear();
    this.#targets.clear();
    this.#setups.clear();
  }

  #enqueue(message: CdpMessage, parent?: string): void {
    if (this.#closing) return;
    const task = this.#event(message, parent).catch(() => { this.#fail(); });
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task));
  }
  async #event(message: CdpMessage, parent?: string): Promise<void> {
    const params = message.params ?? {};
    if (message.method === "Target.receivedMessageFromTarget") {
      if (typeof params["message"] !== "string" || typeof params["sessionId"] !== "string") throw new Error("The proxy gate received an invalid CDP envelope.");
      const child = params["sessionId"];
      const nested = JSON.parse(params["message"]) as CdpMessage;
      if (typeof nested.id === "number") {
        const pending = this.#pending.get(nested.id);
        if (pending !== undefined) {
          this.#pending.delete(nested.id);
          clearTimeout(pending.timer);
          if (nested.error !== undefined) pending.reject(new Error("The Browser proxy gate command failed."));
          else pending.resolve(nested.result);
        }
      } else this.#enqueue(nested, child);
      return;
    }
    if (message.method === "Target.attachedToTarget") {
      const sessionId = params["sessionId"];
      const info = params["targetInfo"] as { readonly targetId?: string; readonly type?: string } | undefined;
      if (typeof sessionId !== "string" || typeof info?.targetId !== "string") throw new Error("The proxy target has no exact identity.");
      this.#parents.set(sessionId, parent);
      this.#targets.set(sessionId, info.targetId);
      if (info.type !== undefined && NETWORK_TARGETS.has(info.type)) await this.#setup(info.targetId, sessionId);
      else await this.#command("Runtime.runIfWaitingForDebugger", {}, sessionId);
      return;
    }
    if (message.method === "Target.detachedFromTarget") {
      const sessionId = params["sessionId"];
      if (typeof sessionId === "string") {
        const target = this.#targets.get(sessionId);
        if (target !== undefined) this.#setups.delete(target);
        this.#parents.delete(sessionId);
        this.#targets.delete(sessionId);
      }
      return;
    }
    if (message.method === "Fetch.requestPaused") {
      const requestId = params["requestId"];
      const request = params["request"] as { readonly url?: string } | undefined;
      if (parent === undefined || typeof requestId !== "string" || typeof request?.url !== "string") throw new Error("The proxy request has no exact target.");
      const allowed = await isBrowserProxyRequestUrlAllowed(request.url, this.#route, this.#lookup);
      if (!this.active || !this.#parents.has(parent)) return;
      try {
        await this.#command(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", {
          requestId, ...(allowed ? {} : { errorReason: "BlockedByClient" })
        }, parent);
      } catch {
        // A destroyed request is harmless; a live target with a dead gate is not.
        if (this.active && this.#parents.has(parent)) this.#fail();
      }
    }
  }
  async #attach(targetId: string): Promise<void> {
    const existing = this.#setups.get(targetId);
    if (existing !== undefined) return existing;
    try {
      const attached = await this.#command("Target.attachToTarget", { targetId, flatten: false }) as { readonly sessionId?: string };
      if (attached.sessionId === undefined) throw new Error("The Browser proxy target could not be attached.");
      this.#parents.set(attached.sessionId, undefined);
      this.#targets.set(attached.sessionId, targetId);
      await this.#setup(targetId, attached.sessionId);
    } catch (error) {
      const autoAttached = this.#setups.get(targetId);
      if (autoAttached !== undefined) { await autoAttached; return; }
      const targets = await this.#command("Target.getTargets") as { readonly targetInfos?: readonly { readonly targetId?: string }[] };
      if ((targets.targetInfos ?? []).some(target => target.targetId === targetId)) throw error;
    }
  }
  #setup(targetId: string, sessionId: string): Promise<void> {
    const existing = this.#setups.get(targetId);
    if (existing !== undefined) return existing;
    const setup = (async () => {
      await this.#command("Fetch.enable", { handleAuthRequests: false }, sessionId);
      await this.#command("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: false }, sessionId);
      await this.#command("Runtime.runIfWaitingForDebugger", {}, sessionId);
    })();
    this.#setups.set(targetId, setup);
    return setup;
  }
  async #command(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    if (!this.active) throw new Error("The Browser proxy gate channel is unavailable.");
    if (sessionId === undefined) {
      const session = this.#session!;
      return new Promise((resolveCommand, reject) => {
        const timer = setTimeout(() => reject(new Error("The Browser proxy gate command timed out.")), COMMAND_TIMEOUT_MS);
        void session.send(method as Parameters<CDPSession["send"]>[0], params as never).then(
          result => { clearTimeout(timer); resolveCommand(result); },
          () => { clearTimeout(timer); reject(new Error("The Browser proxy gate command failed.")); }
        );
      });
    }
    if (!this.#parents.has(sessionId)) throw new Error("The Browser proxy target is no longer attached.");
    const id = this.#nextId++;
    return new Promise((resolveCommand, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("The Browser proxy gate command timed out."));
      }, COMMAND_TIMEOUT_MS);
      this.#pending.set(id, { resolve: resolveCommand, reject, timer });
      void this.#command("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) }, this.#parents.get(sessionId))
        .catch(() => {
          const pending = this.#pending.get(id);
          if (pending !== undefined) { clearTimeout(timer); this.#pending.delete(id); pending.reject(new Error("The Browser proxy gate command failed.")); }
        });
    });
  }
  #fail(): void {
    if (this.#closing || this.#failed) return;
    this.#failed = true;
    this.#rejectPending();
    this.#onFailure();
  }
  #rejectPending(): void {
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("The Browser proxy gate channel retired.")); }
    this.#pending.clear();
  }
  #awaitAlive<T>(promise: Promise<T>): Promise<T> {
    const signal = this.#retired.signal;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolveAlive, reject) => {
      const abort = () => { reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      void promise.then(resolveAlive, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
}
