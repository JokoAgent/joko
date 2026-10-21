import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { OperationalStore } from "@joko/store";
import type { ExtensionCatalogManager } from "../extension-catalog.js";
import type { PiResourceManager } from "../resource-manager.js";
import type { ExtensionMainViewAuthority, ExtensionMainViewManager, ExtensionMainViewSurface } from "../extension-main-view-manager.js";
import type { BridgeToolProvider, BridgeToolCallContext, BridgeToolCallResult } from "../mcp-router.js";
import type { ExtensionRuntimeDescriptor } from "../extension-surface-manifest.js";
import type { ExtensionCardAuthority, ExtensionCardAction, ExtensionCardsManager } from "./manager.js";
import type { ExtensionCardScope } from "./service.js";
import { withExtensionCardToken } from "./service.js";
import { MAIL_COMPOSE_RUNTIME_SOURCE } from "./mail-runtime-source.js";
import type { CredentialVault, EncryptedCredential } from "../credential-vault.js";
import { ExtensionNetwork } from "./network.js";
import { createExtensionMailReader, type ExtensionMailPreview } from "./mail-reader.js";
import type { ExtensionCardMedia } from "./media.js";
import { EXTENSION_CARD_RUNTIME_BOOTSTRAP_SOURCE } from "./runtime-bootstrap.js";

interface Authority extends ExtensionCardAuthority { readonly surface: ExtensionMainViewAuthority }
interface Instance {
  readonly authority: Authority; readonly connectionId: string; readonly abort: AbortController;
  unregister: () => void; current: boolean; context?: BrowserContext; page?: Page; surface?: ExtensionMainViewSurface;
  opening?: Promise<Page>; readonly tickets: Map<string, { scope: ExtensionCardScope; assertCurrent: () => void }>;
  readonly calls: Set<string>; pending: number;
  readonly callGuards: Map<string, { signal: AbortSignal; assertCurrent: () => void }>;
}
interface Options {
  readonly catalog: Pick<ExtensionCatalogManager, "get" | "snapshot" | "onAuthorityChanged">;
  readonly resources: Pick<PiResourceManager, "get">;
  readonly store: OperationalStore; readonly vault: CredentialVault;
  readonly surfaces: ExtensionMainViewManager; readonly cards: ExtensionCardsManager;
  readonly registerProvider: (provider: BridgeToolProvider) => () => void;
  readonly redact: (text: string) => string;
  readonly locale?: () => string;
  readonly fetch?: typeof fetch;
  readonly resolveCredential?: (reference: string) => string;
  readonly media?: ExtensionCardMedia;
  readonly continueTask: (scope: ExtensionCardScope, text: string, guard: (() => Promise<void>) & { readonly signal: AbortSignal }) => Promise<void>;
  readonly executablePath?: string; readonly launch?: () => Promise<Browser>;
}

/** Approved logic has a private browser context and a source-bound host bridge.
 * No plugin page is given a Node global, ordinary Connection bearer or UI bridge. */
export class ExtensionCardRuntime {
  readonly #instances = new Map<string, Instance>();
  #browser?: Browser; #browserOpening?: Promise<Browser>; #stopped = true; #generation = 0;
  #tail = Promise.resolve(); #unsubscribe?: () => void; #timer?: NodeJS.Timeout;
  readonly #network: ExtensionNetwork | undefined;
  constructor(private readonly options: Options) {
    if (options.fetch && options.resolveCredential) this.#network = new ExtensionNetwork({ fetch: options.fetch, resolveCredential: options.resolveCredential, redact: options.redact, ...(options.media ? { media: options.media } : {}) });
  }
  authority(id: string): ExtensionCardAuthority | undefined {
    try { return this.#capture(id); } catch { return; }
  }
  async previewMail(sessionId: string, url: string, read: boolean, opened: boolean, signal: AbortSignal, assertCaller: () => void): Promise<ExtensionMailPreview> {
    const task = this.options.store.getSession(sessionId).descriptor;
    const current = () => {
      assertCaller(); signal.throwIfAborted();
      const selected = this.options.store.getSession(sessionId).descriptor;
      if (this.#stopped || selected.createdAt !== task.createdAt || selected.targetId !== task.targetId || selected.binding.generation !== task.binding.generation
        || selected.archived || selected.deletedAt !== undefined || this.options.store.findPendingSessionLifecycleCleanup(sessionId)) throw new Error("Mail task changed.");
    };
    const reader = createExtensionMailReader({ authorize: current, captureScope: () => current,
      plugins: () => [...this.#instances.values()].flatMap(instance => {
        try { this.#assert(instance); return instance.authority.runtime.mailReader ? [{ id: instance.authority.surface.extensionId, reader: instance.authority.runtime.mailReader }] : []; } catch { return []; }
      }),
      call: async (plugin, url, markRead) => {
        current(); const instance = this.#instances.get(plugin.id); if (!instance) throw new Error("Mail source changed.");
        const result = await this.#call(instance, plugin.reader.tool, { url, ...(markRead ? { markRead: true } : {}) }, signal,
          { sessionId, targetId: task.targetId, generation: task.binding.generation });
        current(); return { ok: !result.isError, result: result.structuredContent };
      } });
    return reader(url, read, opened && this.options.store.findSessionRuntimePolicy(sessionId)?.policy !== "review_read_only");
  }
  #capture(id: string): Authority {
    if (this.#stopped) throw new Error("Extension runtime stopped.");
    const extension = this.options.catalog.get(id);
    if (!extension.installed || !extension.enabled || extension.owner.kind !== "resource" || !extension.runtime
      || !["ready", "not_required"].includes(extension.setup.state)) throw new Error("Extension runtime unavailable.");
    const resource = this.options.resources.get(extension.owner.resourceId), descriptor = extension.runtime;
    const { extensionEntry, ...runtime } = descriptor;
    const declarations = resource.resourceDetails.filter(detail => detail.kind === "extension" && detail.entryPath === extensionEntry
      && JSON.stringify(detail.runtime) === JSON.stringify(runtime));
    if (resource.kind !== "package" || resource.scope !== "managed" || !resource.enabled || !resource.packageIdentity
      || !["installed", "loaded", "update_available"].includes(resource.state) || resource.versionNumber !== extension.owner.resourceVersion
      || resource.discoveredRevision !== extension.owner.discoveredRevision || declarations.length !== 1) throw new Error("Extension installation changed.");
    const backend = this.options.store.getBackend(resource.backendId);
    const surface: ExtensionMainViewAuthority = { extensionId: extension.id, resourceId: resource.id, backendId: resource.backendId,
      backendRevision: backend.revision, backendGeneration: backend.descriptor.instanceGeneration, resourceRevision: resource.versionNumber,
      discoveredRevision: resource.discoveredRevision, packageName: resource.packageIdentity,
      ...(resource.version === undefined ? {} : { packageVersion: resource.version }), extensionEntry,
      mainView: { html: runtime.html }, runtime: structuredClone(runtime) };
    const key = JSON.stringify({ ...surface, backendRevision: surface.backendRevision.toString(), resourceRevision: surface.resourceRevision.toString(),
      extensionRevision: extension.revision.toString() });
    return { key, name: extension.name, runtime, surface };
  }
  #assert(instance: Instance): void {
    if (this.#stopped || !instance.current || this.#instances.get(instance.authority.surface.extensionId) !== instance
      || this.#capture(instance.authority.surface.extensionId).key !== instance.authority.key) throw new Error("Extension runtime changed.");
    instance.abort.signal.throwIfAborted();
  }
  async start(): Promise<void> {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#unsubscribe = this.options.catalog.onAuthorityChanged(ids => {
      for (const id of ids) { const instance = this.#instances.get(id); if (instance) this.#retire(instance); }
      void this.#reconcile();
    });
    this.#timer = setInterval(() => { void this.#reconcile(); }, 15_000); this.#timer.unref();
    await this.#reconcile();
  }
  #retire(instance: Instance): void {
    if (!instance.current) return;
    instance.current = false; instance.abort.abort(); instance.unregister(); instance.tickets.clear();
    this.options.cards.revoke(instance.authority.surface.extensionId);
  }
  #reconcile(): Promise<void> {
    const next = this.#tail.then(async () => {
      if (this.#stopped) return;
      const desired = new Map<string, Authority>();
      for (const extension of this.options.catalog.snapshot().entries) {
        try { if (extension.runtime) desired.set(extension.id, this.#capture(extension.id)); } catch { /* No executable authority. */ }
      }
      for (const [id, instance] of this.#instances) {
        if (!instance.current || desired.get(id)?.key !== instance.authority.key || instance.page?.isClosed()) {
          this.#retire(instance); await this.#close(instance); this.#instances.delete(id);
        }
      }
      for (const [id, authority] of desired) {
        if (this.#stopped || this.#instances.has(id) || this.#instances.size >= 64) continue;
        const instance: Instance = { authority, connectionId: `extension_runtime_${randomUUID().replaceAll("-", "")}`, current: true,
          abort: new AbortController(), unregister: () => {}, tickets: new Map(), calls: new Set(), callGuards: new Map(), pending: 0 };
        this.#instances.set(id, instance);
        const providerId = `${id}-runtime`, generation = ++this.#generation;
        const provider: BridgeToolProvider = { id: providerId, generation,
          get available() { return instance.current; },
          tools: authority.runtime.tools.map(tool => ({ serverId: providerId, name: tool.name, description: tool.description,
            inputSchema: tool.inputSchema, requiresPermission: !tool.readOnly })),
          callTool: (name, args, signal, context) => this.#call(instance, name, args, signal, context) };
        try { instance.unregister = this.options.registerProvider(provider); }
        catch { this.#retire(instance); this.#instances.delete(id); }
      }
    });
    this.#tail = next.catch(() => undefined); return this.#tail;
  }
  async #getBrowser(): Promise<Browser> {
    if (this.#browser?.isConnected()) return this.#browser;
    if (!this.#browserOpening) this.#browserOpening = (this.options.launch ? this.options.launch() : this.options.executablePath
      ? chromium.launch({ executablePath: this.options.executablePath, headless: true, chromiumSandbox: true,
        args: ["--site-per-process"], ignoreDefaultArgs: ["--disable-site-isolation-trials"], timeout: 15_000 })
      : Promise.reject(new Error("Extension runtime browser unavailable."))).then(browser => {
      if (this.#stopped) { void browser.close(); throw new Error("Extension runtime stopped."); }
      this.#browser = browser;
      browser.on("disconnected", () => { for (const instance of this.#instances.values()) this.#retire(instance); });
      return browser;
    }).finally(() => { this.#browserOpening = undefined; });
    return this.#browserOpening;
  }
  async #ensure(instance: Instance): Promise<Page> {
    this.#assert(instance);
    if (instance.page && !instance.page.isClosed()) {
      if (instance.surface) await this.options.surfaces.getSurface(instance.surface.id, instance.connectionId, true);
      this.#assert(instance); return instance.page;
    }
    if (!instance.opening) instance.opening = this.#open(instance).catch(async error => {
      await this.#close(instance); throw error;
    }).finally(() => { instance.opening = undefined; });
    return instance.opening;
  }
  async #open(instance: Instance): Promise<Page> {
    const browser = await this.#getBrowser(); this.#assert(instance);
    const surface = await this.options.surfaces.open({ authority: instance.authority.surface, connectionId: instance.connectionId,
      assertAuthorityCurrent: () => this.#assert(instance) });
    instance.surface = surface; this.#assert(instance);
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, permissions: [] });
    instance.context = context;
    const page = await context.newPage(); instance.page = page;
    page.on("close", () => { if (instance.current) this.#retire(instance); });
    page.on("crash", () => this.#retire(instance));
    const url = new URL(surface.endpoint, `https://${instance.authority.surface.extensionId}.joko-extension.invalid`);
    const token = url.pathname.split("/")[5]!, prefix = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1);
    await context.route("**/*", async route => {
      try {
        this.#assert(instance);
        const request = route.request(), assetUrl = new URL(request.url());
        if (assetUrl.origin !== url.origin || request.frame() !== page.mainFrame()) throw new Error("Extension asset denied.");
        if (assetUrl.pathname === "/kv" || assetUrl.pathname === "/app-context") {
          const result = this.#localRequest(instance, assetUrl.pathname, request.method(), request.postData() ?? "");
          await route.fulfill({ status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(result) }); return;
        }
        if (!assetUrl.pathname.startsWith(prefix) || request.method() !== "GET" || request.isNavigationRequest() && assetUrl.href !== url.href) throw new Error("Extension asset denied.");
        const assetPath = assetUrl.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
        const asset = await this.options.surfaces.serve({ surfaceId: surface.id, token, assetPath, method: "GET" });
        this.#assert(instance);
        await route.fulfill({ status: asset.status, headers: { ...asset.headers, "content-type": asset.mimeType,
          "content-security-policy": asset.headers["content-security-policy"]?.replace("connect-src 'none'", "connect-src 'self'") ?? "default-src 'none'" }, body: asset.body });
      } catch { await route.abort("blockedbyclient").catch(() => undefined); }
    });
    await page.exposeBinding("__jokoExtensionRequest", async ({ frame }, payload: unknown) => {
      if (frame !== page.mainFrame() || instance.pending >= 16) return { ok: false };
      instance.pending += 1;
      try { this.#assert(instance); validateExtensionEnvelope(payload); return await this.#request(instance, payload); }
      catch { return { ok: false }; }
      finally { instance.pending -= 1; }
    });
    await page.addInitScript({ content: `(${EXTENSION_CARD_RUNTIME_BOOTSTRAP_SOURCE})(${JSON.stringify({ agent: instance.authority.runtime.agent === true, network: instance.authority.runtime.network !== undefined })})` });
    if (instance.authority.runtime.mail) await page.addInitScript({ content: `${MAIL_COMPOSE_RUNTIME_SOURCE}\nObject.defineProperty(window, "jokoMail", { value: jokoMail, writable: false, configurable: false });` });
    await page.goto(url.href, { waitUntil: "load", timeout: 15_000 }); this.#assert(instance);
    return page;
  }
  #localRequest(instance: Instance, path: string, method: string, body: string): unknown {
    this.#assert(instance);
    if (path === "/app-context" && method === "GET") return { context: { locale: this.options.locale?.() ?? "en" } };
    if (path !== "/kv" || !["GET", "PUT"].includes(method)) throw new Error("Extension local request denied.");
    const id = instance.authority.surface.extensionId;
    if (method === "PUT") {
      if (Buffer.byteLength(body) > 64 * 1024 || this.options.redact(body) !== body) throw new Error("Extension routing data invalid.");
      const value = JSON.parse(body) as unknown; validateExtensionEnvelope(value, 64 * 1024);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Extension routing data invalid.");
      this.options.store.setSetting("service", "extension-runtime-kv", id, this.options.vault.seal(JSON.stringify({ version: 1, data: value }), id));
      return { ok: true };
    }
    const sealed = this.options.store.findSetting<EncryptedCredential>("service", "extension-runtime-kv", id)?.value;
    if (!sealed) return {};
    const value = JSON.parse(this.options.vault.open(sealed, id)) as { version: number; data: unknown };
    if (value.version !== 1) throw new Error("Extension routing data unavailable.");
    return value.data;
  }
  async #request(instance: Instance, payload: unknown): Promise<unknown> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false };
    const request = payload as Record<string, unknown>, id = instance.authority.surface.extensionId;
    const current = () => { this.#assert(instance); };
    switch (request.type) {
      case "fetch-request": {
        const declaration = instance.authority.runtime.network;
        if (!declaration || !this.#network || typeof request.callId !== "string") return { ok: false };
        const scope = this.options.cards.cards.callInfoOf(request.callId), guard = instance.callGuards.get(request.callId);
        if (!scope || scope.extensionId !== id || scope.authorityKey !== instance.authority.key || !guard) return { ok: false };
        return this.#network.request({ extensionId: id, authorityKey: instance.authority.key, declaration,
          readOnly: this.options.store.findSessionRuntimePolicy(scope.sessionId)?.policy === "review_read_only",
          task: scope, signal: guard.signal, assertCurrent: () => { current(); guard.assertCurrent(); this.options.cards.assertAuthority(scope); } }, request);
      }
      case "card-update": {
        const result = await this.options.cards.cards.handleCardUpdate(id, instance.authority.key, request, current);
        return { ok: result.accepted };
      }
      case "mail-draft-update":
        if (!instance.authority.runtime.mail) return { ok: false };
        return this.options.cards.mail.handle(id, instance.authority.key, request, () => { try { current(); return true; } catch { return false; } });
      case "mail-draft-read":
        if (!instance.authority.runtime.mail) return { ok: false };
        return this.options.cards.mail.restore(id, instance.authority.key, request, () => { try { current(); return true; } catch { return false; } });
      case "agent-run": {
        if (!instance.authority.runtime.agent) return { ok: false };
        if (typeof request.userActionToken !== "string") return { ok: false };
        const ticket = instance.tickets.get(request.userActionToken); instance.tickets.delete(request.userActionToken);
        if (!ticket || request.mode !== "continue" || typeof request.userMessage !== "string" || request.userMessage.length > 16_000) return { ok: false };
        ticket.assertCurrent(); this.options.cards.assertAuthority(ticket.scope);
        const text = this.options.redact(`${request.userMessage}\n${JSON.stringify(request.event ?? {})}`);
        const guard = Object.assign(async () => { current(); ticket.assertCurrent(); this.options.cards.assertAuthority(ticket.scope); }, { signal: instance.abort.signal });
        await this.options.continueTask(ticket.scope, text, guard); return { ok: true };
      }
      default: return { ok: false };
    }
  }
  async #call(instance: Instance, name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined, context: BridgeToolCallContext): Promise<BridgeToolCallResult> {
    this.#assert(instance); signal?.throwIfAborted(); validateExtensionEnvelope(args);
    if (!instance.authority.runtime.tools.some(tool => tool.name === name) || instance.calls.size >= 16) throw new Error("Extension tool unavailable.");
    const assertCurrent = () => {
      this.#assert(instance); signal?.throwIfAborted();
      const session = this.options.store.getSession(context.sessionId).descriptor;
      if (session.targetId !== context.targetId || session.binding.generation !== context.generation || session.archived || session.deletedAt !== undefined) throw new Error("Extension task changed.");
    };
    assertCurrent();
    const page = await this.#ensure(instance); assertCurrent();
    const callId = this.options.cards.registerCall(instance.authority.surface.extensionId, instance.authority.key, context.sessionId, null);
    const callAbort = new AbortController();
    for (const id of instance.callGuards.keys()) if (!this.options.cards.cards.callInfoOf(id)) instance.callGuards.delete(id);
    instance.callGuards.set(callId, { signal: AbortSignal.any([callAbort.signal, instance.abort.signal, ...(signal ? [signal] : [])]), assertCurrent });
    instance.calls.add(callId);
    let rejectAbort: (reason?: unknown) => void = () => {};
    const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const cancel = () => {
      callAbort.abort();
      rejectAbort(new Error("Extension tool cancelled."));
      void page.evaluate(id => { (window as unknown as { __jokoRuntime: { cancel(id: string): void } }).__jokoRuntime.cancel(id); }, callId).catch(() => undefined);
    };
    signal?.addEventListener("abort", cancel, { once: true }); instance.abort.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, 30 * 60_000); timer.unref();
    let finalized = false;
    try {
      const value: unknown = await Promise.race([page.evaluate(async input => {
        return (window as unknown as { __jokoRuntime: { tool(value: unknown): Promise<unknown> } }).__jokoRuntime.tool(input);
      }, { name, arguments: args, callId, sessionId: context.sessionId,
        readOnly: this.options.store.findSessionRuntimePolicy(context.sessionId)?.policy === "review_read_only" }), cancelled]);
      assertCurrent(); validateExtensionEnvelope(value);
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { ok?: unknown }).ok !== "boolean") throw new Error("Extension tool returned an invalid result.");
      const hasCard = await this.options.cards.finalizeCall(callId); finalized = true;
      const result = withExtensionCardToken(value as { ok: boolean; result?: unknown }, hasCard, callId);
      return { content: [{ type: "text", text: this.options.redact(JSON.stringify(result)) }], isError: !result.ok,
        ...(result.result && typeof result.result === "object" && !Array.isArray(result.result) ? { structuredContent: JSON.parse(this.options.redact(JSON.stringify(result.result))) as Record<string, unknown> } : {}) };
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", cancel); instance.abort.signal.removeEventListener("abort", cancel);
      instance.calls.delete(callId); if (!finalized) await this.options.cards.finalizeCall(callId);
    }
  }
  async dispatch(scope: ExtensionCardScope, event: ExtensionCardAction, assertCurrent: () => void): Promise<void> {
    const instance = this.#instances.get(scope.extensionId);
    if (!instance || instance.authority.key !== scope.authorityKey) throw new Error("Extension source changed.");
    this.#assert(instance); assertCurrent();
    const page = await this.#ensure(instance); this.#assert(instance); assertCurrent();
    for (const id of instance.callGuards.keys()) if (!this.options.cards.cards.callInfoOf(id)) instance.callGuards.delete(id);
    instance.callGuards.set(event.spawnCallId, { signal: instance.abort.signal, assertCurrent: () => { assertCurrent(); this.options.cards.assertAuthority(scope); } });
    const token = event.change || !instance.authority.runtime.agent ? undefined : randomUUID();
    if (token) {
      if (instance.tickets.size >= 64) throw new Error("Extension action capacity reached.");
      instance.tickets.set(token, { scope, assertCurrent });
      const timer = setTimeout(() => instance.tickets.delete(token), 10 * 60_000); timer.unref();
    }
    let timer: NodeJS.Timeout | undefined, timedOut = false;
    try {
      await Promise.race([page.evaluate(async payload => (window as unknown as { __jokoRuntime: { event(payload: unknown): Promise<void> } }).__jokoRuntime.event(payload),
        { ...event, sessionId: scope.sessionId, ...(token ? { userActionToken: token } : {}) }), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { timedOut = true; this.#retire(instance); void this.#reconcile(); reject(new Error("Extension action timed out. Check the current card before retrying.")); }, 8000); timer.unref();
        })]);
      this.#assert(instance); assertCurrent();
    } catch (error) { if (token && !timedOut) instance.tickets.delete(token); throw error; }
    finally { clearTimeout(timer); }
  }
  async #close(instance: Instance): Promise<void> {
    this.#network?.retire(instance.authority.key); instance.callGuards.clear();
    const context = instance.context, surface = instance.surface;
    instance.context = undefined; instance.page = undefined; instance.surface = undefined;
    await context?.close().catch(() => undefined);
    if (surface) await this.options.surfaces.closeSurface(surface.id, instance.connectionId).catch(() => undefined);
  }
  async stop(): Promise<void> {
    this.#stopped = true; clearInterval(this.#timer); this.#unsubscribe?.();
    for (const instance of this.#instances.values()) this.#retire(instance);
    await this.#tail;
    await Promise.all([...this.#instances.values()].map(instance => this.#close(instance))); this.#instances.clear();
    await this.#browser?.close().catch(() => undefined); this.#browser = undefined;
  }
}

export function validateExtensionEnvelope(value: unknown, maximumBytes = 4 * 1024 * 1024): void {
  let nodes = 65_536, bytes = maximumBytes; const ancestors = new Set<object>();
  const spend = (amount: number) => { bytes -= amount; if (bytes < 0) throw new Error("Extension message exceeds its limit."); };
  const walk = (item: unknown, depth: number): void => {
    if (--nodes < 0 || depth > 32) throw new Error("Extension message is invalid.");
    if (item === null || typeof item === "boolean") { spend(5); return; }
    if (typeof item === "string") { if (item.length > bytes) throw new Error("Extension message exceeds its limit."); spend(Buffer.byteLength(JSON.stringify(item))); return; }
    if (typeof item === "number" && Number.isFinite(item)) { spend(String(item).length); return; }
    if (!item || typeof item !== "object" || ancestors.has(item)) throw new Error("Extension message is invalid.");
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error("Extension message is invalid.");
    ancestors.add(item); spend(2);
    for (const [key, child] of Object.entries(item)) { spend(Buffer.byteLength(JSON.stringify(key)) + 2); walk(child, depth + 1); }
    ancestors.delete(item);
  };
  walk(value, 0);
}
