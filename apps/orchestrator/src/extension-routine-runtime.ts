import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { redactSecrets, type RoutineSource } from "@joko/core";
import type { OperationalStore } from "@joko/store";
import type { ExtensionCatalogManager } from "./extension-catalog.js";
import type { PiResourceManager } from "./resource-manager.js";
import type { ExtensionMainViewAuthority, ExtensionMainViewManager, ExtensionMainViewSurface } from "./extension-main-view-manager.js";
import { parseRoutineEvent } from "./partner-routine-definition.js";
import type { RoutineEngine } from "./partner-routine-engine.js";
import type { ExtensionRoutineEventsDescriptor } from "./extension-surface-manifest.js";

interface PublisherAuthority {
  readonly key: string; readonly name: string; readonly surface: ExtensionMainViewAuthority; readonly events: ExtensionRoutineEventsDescriptor;
}
interface Publisher {
  readonly authority: PublisherAuthority; readonly connectionId: string;
  current: boolean; surface?: ExtensionMainViewSurface; context?: BrowserContext; page?: Page;
}

/** Resident browser publishers are independent of UI windows and cannot choose a source identity. */
export class ExtensionRoutineRuntime {
  #publishers = new Map<string, Publisher>();
  #retryAt = new Map<string, number>();
  #pending = new Map<string, number>();
  #totalPending = 0;
  #browser?: Browser;
  #browserOpening?: Promise<Browser>;
  #tail = Promise.resolve();
  #timer?: NodeJS.Timeout;
  #unsubscribe?: () => void;
  #stopped = true;
  constructor(private readonly options: {
    readonly catalog: Pick<ExtensionCatalogManager, "get" | "snapshot" | "onAuthorityChanged">;
    readonly resources: Pick<PiResourceManager, "get">; readonly store: Pick<OperationalStore, "getBackend">;
    readonly surfaces: ExtensionMainViewManager; readonly engine: RoutineEngine; readonly executablePath?: string;
    readonly launch?: () => Promise<Browser>; readonly now?: () => number;
  }) {}
  #now(): number { return (this.options.now ?? Date.now)(); }
  async start(): Promise<void> {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#unsubscribe = this.options.catalog.onAuthorityChanged(ids => {
      for (const id of ids) { const publisher = this.#publishers.get(id); if (publisher) this.#retire(publisher); this.#retryAt.delete(id); }
      void this.#reconcile();
    });
    this.#timer = setInterval(() => { void this.#reconcile(); }, 15000); this.#timer.unref();
    await this.#reconcile();
  }
  #retire(publisher: Publisher): void {
    publisher.current = false; this.options.engine.removeSource(`extension:${publisher.authority.surface.extensionId}`);
  }
  #capture(id: string): PublisherAuthority {
    const extension = this.options.catalog.get(id);
    if (!extension.installed || !extension.enabled || extension.owner.kind !== "resource" || !extension.routineEvents
      || !["ready", "not_required"].includes(extension.setup.state)) throw new Error("Routine publisher unavailable.");
    const resource = this.options.resources.get(extension.owner.resourceId);
    const declaration = resource.resourceDetails.filter(detail => detail.kind === "extension" && detail.entryPath === extension.routineEvents!.extensionEntry
      && JSON.stringify(detail.routineEvents) === JSON.stringify({ html: extension.routineEvents!.html, events: extension.routineEvents!.events }));
    if (resource.kind !== "package" || resource.scope !== "managed" || !resource.enabled || !resource.packageIdentity
      || !["installed", "loaded", "update_available"].includes(resource.state) || resource.versionNumber !== extension.owner.resourceVersion
      || resource.discoveredRevision !== extension.owner.discoveredRevision || declaration.length !== 1) throw new Error("Routine publisher installation changed.");
    const backend = this.options.store.getBackend(resource.backendId);
    const events = { html: extension.routineEvents.html, events: structuredClone(extension.routineEvents.events) };
    const surface: ExtensionMainViewAuthority = { extensionId: extension.id, resourceId: resource.id, backendId: resource.backendId,
      backendRevision: backend.revision, backendGeneration: backend.descriptor.instanceGeneration, resourceRevision: resource.versionNumber,
      discoveredRevision: resource.discoveredRevision, packageName: resource.packageIdentity,
      ...(resource.version === undefined ? {} : { packageVersion: resource.version }), extensionEntry: extension.routineEvents.extensionEntry,
      mainView: { html: events.html }, routineEvents: events };
    return { key: JSON.stringify({ ...surface, backendRevision: surface.backendRevision.toString(), resourceRevision: surface.resourceRevision.toString(), extensionRevision: extension.revision.toString() }), name: extension.name, surface, events };
  }
  #current(publisher: Publisher): boolean {
    if (this.#stopped || !publisher.current || this.#publishers.get(publisher.authority.surface.extensionId) !== publisher) return false;
    try { return this.#capture(publisher.authority.surface.extensionId).key === publisher.authority.key; } catch { return false; }
  }
  #source(publisher: Publisher, status: RoutineSource["status"]): void {
    this.options.engine.registerSource({ id: `extension:${publisher.authority.surface.extensionId}`, name: publisher.authority.name,
      events: publisher.authority.events.events.map(event => ({ ...event, fields: [...event.fields] })), status });
  }
  #reconcile(): Promise<void> {
    const next = this.#tail.then(async () => {
      if (this.#stopped) return;
      const desired = new Map<string, PublisherAuthority>();
      for (const extension of this.options.catalog.snapshot().entries) {
        try { if (extension.routineEvents) desired.set(extension.id, this.#capture(extension.id)); } catch { /* Uninstalled/disabled publishers have no executable authority. */ }
      }
      for (const [id, publisher] of this.#publishers) {
        if (!publisher.current || desired.get(id)?.key !== publisher.authority.key || publisher.page?.isClosed()) {
          this.#retire(publisher); await this.#close(publisher); this.#publishers.delete(id);
        } else if (publisher.surface) {
          try { await this.options.surfaces.getSurface(publisher.surface.id, publisher.connectionId, true); }
          catch { this.#retire(publisher); await this.#close(publisher); this.#publishers.delete(id); }
        }
      }
      for (const [id, authority] of desired) {
        if (this.#stopped || this.#publishers.has(id) || (this.#retryAt.get(id) ?? 0) > this.#now()) continue;
        const publisher: Publisher = { authority, connectionId: `routine_publisher_${randomUUID().replaceAll("-", "")}`, current: true };
        this.#publishers.set(id, publisher);
        try { this.#source(publisher, "disconnected");
          if (this.#publishers.size > 64) throw new Error("Routine publisher capacity reached.");
          await this.#open(publisher);
        } catch {
          this.#retire(publisher); await this.#close(publisher); this.#publishers.delete(id); this.#retryAt.set(id, this.#now() + 60000);
          try { this.#source(publisher, "error"); } catch { /* A source quota error does not grant execution. */ }
        }
      }
    });
    this.#tail = next.catch(() => undefined); return this.#tail;
  }
  async #getBrowser(): Promise<Browser> {
    if (this.#browser?.isConnected()) return this.#browser;
    if (!this.#browserOpening) {
      this.#browserOpening = (this.options.launch ? this.options.launch() : this.options.executablePath
        ? chromium.launch({ executablePath: this.options.executablePath, headless: true, timeout: 15000 })
        : Promise.reject(new Error("Routine publisher browser unavailable."))).then(browser => {
          if (this.#stopped) { void browser.close(); throw new Error("Routine runtime stopped."); }
          this.#browser = browser;
          browser.on("disconnected", () => { for (const publisher of this.#publishers.values()) this.#retire(publisher); });
          return browser;
        }).finally(() => { this.#browserOpening = undefined; });
    }
    return this.#browserOpening;
  }
  async #open(publisher: Publisher): Promise<void> {
    const assertAuthorityCurrent = () => { if (!this.#current(publisher)) throw new Error("Routine publisher changed."); };
    const browser = await this.#getBrowser(); assertAuthorityCurrent();
    publisher.surface = await this.options.surfaces.open({ authority: publisher.authority.surface, connectionId: publisher.connectionId, assertAuthorityCurrent });
    assertAuthorityCurrent();
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false }); publisher.context = context;
    const page = await context.newPage(); publisher.page = page;
    page.on("close", () => this.#retire(publisher)); page.on("crash", () => this.#retire(publisher));
    const url = new URL(publisher.surface.endpoint, "https://joko-extension.invalid");
    const parts = url.pathname.split("/"); const token = parts[5]!;
    await context.route("**/*", async route => {
      try {
        assertAuthorityCurrent(); const request = route.request(); const assetUrl = new URL(request.url());
        if (assetUrl.origin !== url.origin || !assetUrl.pathname.startsWith(url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1))
          || request.method() !== "GET" || request.isNavigationRequest() && request.frame() !== page.mainFrame()) throw new Error("Routine asset request unavailable.");
        const assetPath = assetUrl.pathname.slice(url.pathname.lastIndexOf("/") + 1).split("/").map(decodeURIComponent).join("/");
        const asset = await this.options.surfaces.serve({ surfaceId: publisher.surface!.id, token, assetPath, method: "GET" });
        assertAuthorityCurrent(); await route.fulfill({ status: asset.status, headers: { ...asset.headers, "content-type": asset.mimeType }, body: asset.body });
      } catch { await route.abort("blockedbyclient").catch(() => undefined); }
    });
    await page.exposeBinding("__jokoRoutineRequest", async ({ frame }, request: unknown) => {
      if (frame !== page.mainFrame()) return { ok: false, message: "Routine publisher unavailable." };
      return this.#request(publisher, request);
    });
    await page.addInitScript(() => {
      const host = (window as unknown as { __jokoRoutineRequest: (request: unknown) => Promise<unknown> }).__jokoRoutineRequest;
      Object.defineProperty(window, "joko", { value: Object.freeze({ routines: Object.freeze({ request: (request: unknown) => host(request) }) }), writable: false, configurable: false });
    });
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 15000 }); assertAuthorityCurrent();
  }
  async #request(publisher: Publisher, raw: unknown): Promise<{ ok: boolean; accepted?: number; duplicate?: boolean; message?: string }> {
    const id = publisher.authority.surface.extensionId;
    const pending = this.#pending.get(id) ?? 0;
    if (pending >= 8 || this.#totalPending >= 32) return { ok: false, message: "Routine request intake is busy; retry later." };
    this.#pending.set(id, pending + 1); this.#totalPending += 1;
    try {
      validateRoutineRequestSize(raw);
      if (!this.#current(publisher) || !publisher.surface) throw new Error("Publisher changed.");
      await this.options.surfaces.getSurface(publisher.surface.id, publisher.connectionId);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid request.");
      const request = raw as Record<string, unknown>;
      if (request.action === "status" && ["listening", "disconnected", "error"].includes(String(request.status))) {
        if (!this.#current(publisher)) throw new Error("Publisher changed."); this.#source(publisher, request.status as RoutineSource["status"]); return { ok: true };
      }
      if (request.action !== "publish") throw new Error("Unknown operation.");
      const event = parseRoutineEvent(request.event);
      if (redactSecrets(JSON.stringify(event)) !== JSON.stringify(event)) return { ok: false, message: "Routine event contains credential data." };
      return { ok: true, ...await this.options.engine.publish(`extension:${id}`, event, () => this.#current(publisher)) };
    } catch { return { ok: false, message: "Routine request could not be accepted. Check the source and retry explicitly." }; }
    finally { this.#totalPending -= 1; const remaining = this.#pending.get(id)! - 1; if (remaining) this.#pending.set(id, remaining); else this.#pending.delete(id); }
  }
  async #close(publisher: Publisher): Promise<void> {
    await publisher.context?.close().catch(() => undefined);
    if (publisher.surface) await this.options.surfaces.closeSurface(publisher.surface.id, publisher.connectionId).catch(() => undefined);
  }
  async stop(): Promise<void> {
    this.#stopped = true; clearInterval(this.#timer); this.#unsubscribe?.();
    for (const publisher of this.#publishers.values()) this.#retire(publisher);
    await this.#tail;
    await Promise.all([...this.#publishers.values()].map(publisher => this.#close(publisher))); this.#publishers.clear();
    await this.#browser?.close().catch(() => undefined); this.#browser = undefined;
  }
}

/** Includes ignored envelope properties, prototypes and cycles before any persistence wait. */
export function validateRoutineRequestSize(payload: unknown): void {
  let remaining = 128 * 1024; let nodes = 4096; const ancestors = new Set<object>();
  const invalid = () => { throw new Error("Routine request is too large or invalid."); };
  const spend = (bytes: number) => { remaining -= bytes; if (remaining < 0) invalid(); };
  const text = (value: string) => { if (value.length > remaining) invalid(); spend(Buffer.byteLength(JSON.stringify(value), "utf8")); };
  const visit = (value: unknown, depth: number): void => {
    if (--nodes < 0 || depth > 16) invalid();
    if (typeof value === "string") { text(value); return; }
    if (value == null) { spend(4); return; }
    if (typeof value === "boolean") { spend(5); return; }
    if (typeof value === "number" && Number.isFinite(value)) { spend(String(value).length); return; }
    if (typeof value !== "object" || value === null || ancestors.has(value)) return invalid();
    ancestors.add(value); spend(2);
    if (Array.isArray(value)) { if (value.length > nodes) invalid(); }
    else { const prototype = Object.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null) invalid(); }
    for (const key in value) { if (!Object.hasOwn(value, key)) continue; text(key); spend(2); visit((value as Record<string, unknown>)[key], depth + 1); }
    ancestors.delete(value);
  };
  visit(payload, 0);
}
