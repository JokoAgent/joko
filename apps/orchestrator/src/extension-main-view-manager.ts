import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ExtensionLibraryDescriptor, ExtensionMainViewDescriptor } from "./extension-surface-manifest.js";
import { inspectPiPackageCatalog } from "./pi-package-compatibility.js";
import type { PiInstalledPackageLease, PiResourceManager } from "./resource-manager.js";

export const EXTENSION_MAIN_VIEW_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors *",
  "form-action 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'"
].join("; ");

export interface ExtensionMainViewAuthority {
  readonly extensionId: string;
  readonly resourceId: string;
  readonly backendId: string;
  readonly backendRevision: bigint;
  readonly backendGeneration: number;
  readonly resourceRevision: bigint;
  readonly discoveredRevision: string;
  readonly packageName: string;
  readonly packageVersion?: string;
  readonly extensionEntry: string;
  readonly mainView: ExtensionMainViewDescriptor;
  readonly library?: ExtensionLibraryDescriptor;
}

export interface ExtensionMainViewSurface {
  readonly id: string;
  readonly extensionId: string;
  readonly authority: ExtensionMainViewAuthority;
  readonly endpoint: string;
  readonly title?: string;
  readonly icon?: ExtensionMainViewDescriptor["icon"];
  readonly expiresAt: number;
}

export interface ExtensionMainViewAsset {
  readonly status: 200;
  readonly mimeType: string;
  readonly contentLength: number;
  readonly body?: Buffer;
  readonly headers: Readonly<Record<string, string>>;
}

export class ExtensionMainViewError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 405 | 410 | 413 | 416 | 429,
    message: string
  ) {
    super(message);
    this.name = "ExtensionMainViewError";
  }
}

export interface ExtensionMainViewManagerOptions {
  readonly resources: Pick<PiResourceManager, "acquireInstalledPackage">;
  readonly rootDirectory: string;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly maximumSurfaces?: number;
  readonly maximumAssetBytes?: number;
}

interface ActiveSurface {
  readonly id: string;
  readonly tokenDigest: Buffer;
  readonly endpoint: string;
  readonly authority: ExtensionMainViewAuthority;
  readonly connectionId: string;
  readonly root: string;
  readonly viewRoot: string;
  readonly lease: PiInstalledPackageLease;
  readonly assertAuthorityCurrent: () => void | Promise<void>;
  readonly expiresAt: number;
}

const SURFACE_ID = /^extension_surface_[a-f0-9]{32}$/u;
const TOKEN = /^[a-f0-9]{64}$/u;
const EXTENSION_ID = /^extension_[a-f0-9]{32}$/u;
const SAFE_CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAXIMUM_SURFACES = 32;
const DEFAULT_MAXIMUM_ASSET_BYTES = 256 * 1024 * 1024;
const LIBRARY_BRIDGE_ASSET = "__joko_extension_library_bridge__.js";
const LIBRARY_BRIDGE_SCRIPT = Buffer.from(`(()=>{"use strict";const p=new Map();let n=0;addEventListener("message",e=>{if(e.source!==parent)return;const d=e.data;if(!d||d.type!=="joko:extension-library-response"||d.version!==1||typeof d.id!=="string")return;const f=p.get(d.id);if(!f)return;const v=d.ok===true&&d.result&&typeof d.result==="object"?Object.freeze({...d.result,ok:true}):d.ok===false&&d.error&&typeof d.error.code==="string"&&typeof d.error.message==="string"?Object.freeze({ok:false,errorCode:d.error.code,message:d.error.message}):null;if(!v)return;p.delete(d.id);clearTimeout(f.t);f.r(v)});const library=operation=>new Promise(r=>{const b=new Uint8Array(16);crypto.getRandomValues(b);const id="library_"+(++n).toString(36)+"_"+Array.from(b,x=>x.toString(16).padStart(2,"0")).join("");const t=setTimeout(()=>{p.delete(id);r(Object.freeze({ok:false,errorCode:"TIMEOUT",message:"Extension Library request timed out."}))},60000);p.set(id,{r,t});parent.postMessage({type:"joko:extension-library-request",version:1,id,operation},"*")});Object.defineProperty(window,"joko",{value:Object.freeze({library}),writable:false,configurable:false})})();`, "utf8");

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

/** Process-local owner for exact-generation, connection-scoped Extension UI. */
export class ExtensionMainViewManager {
  readonly #resources: ExtensionMainViewManagerOptions["resources"];
  readonly #rootDirectory: string;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maximumSurfaces: number;
  readonly #maximumAssetBytes: number;
  readonly #surfaces = new Map<string, ActiveSurface>();
  #tail: Promise<void> = Promise.resolve();
  #expirationTimer?: NodeJS.Timeout;
  #initialized = false;
  #closed = false;

  constructor(options: ExtensionMainViewManagerOptions) {
    if (!isAbsolute(options.rootDirectory) || resolve(options.rootDirectory) !== options.rootDirectory) {
      throw new Error("Extension main-view root must be a normalized absolute path.");
    }
    this.#resources = options.resources;
    this.#rootDirectory = options.rootDirectory;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = positiveInteger(options.ttlMs ?? DEFAULT_TTL_MS, "Extension main-view TTL");
    this.#maximumSurfaces = positiveInteger(options.maximumSurfaces ?? DEFAULT_MAXIMUM_SURFACES, "Extension main-view surface limit");
    this.#maximumAssetBytes = positiveInteger(options.maximumAssetBytes ?? DEFAULT_MAXIMUM_ASSET_BYTES, "Extension main-view asset limit");
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(this.#rootDirectory, { recursive: true, mode: 0o700 });
    await assertCanonicalDirectory(this.#rootDirectory, "Extension main-view root");
    for (const entry of await readdir(this.#rootDirectory, { withFileTypes: true })) {
      if (entry.name.includes("/") || entry.name.includes("\\") || entry.name === "." || entry.name === "..") {
        throw new Error("Extension main-view root contains an unsafe entry.");
      }
      await removeOwnedSurfacePath(this.#rootDirectory, join(this.#rootDirectory, entry.name));
    }
    this.#expirationTimer = setInterval(() => { void this.#expire(); }, Math.min(this.#ttlMs, 30_000));
    this.#expirationTimer.unref?.();
    this.#initialized = true;
  }

  async open(input: {
    readonly authority: ExtensionMainViewAuthority;
    readonly connectionId: string;
    readonly assertAuthorityCurrent: () => void | Promise<void>;
  }): Promise<ExtensionMainViewSurface> {
    this.#assertReady();
    validateAuthority(input.authority);
    if (!SAFE_CONNECTION_ID.test(input.connectionId)) throw new Error("Extension main-view connection ID is invalid.");
    return this.#mutate(async () => {
      await this.#destroyExpired(this.#now());
      if (this.#surfaces.size >= this.#maximumSurfaces) {
        throw new ExtensionMainViewError(429, "Extension main-view surface limit reached.");
      }
      await input.assertAuthorityCurrent();
      const lease = await this.#resources.acquireInstalledPackage({
        resourceId: input.authority.resourceId,
        backendId: input.authority.backendId,
        expectedResourceVersion: input.authority.resourceRevision,
        expectedDiscoveredRevision: input.authority.discoveredRevision,
        expectedPackageIdentity: input.authority.packageName,
        ...(input.authority.packageVersion === undefined ? {} : { expectedPackageVersion: input.authority.packageVersion })
      });
      const id = `extension_surface_${randomUUID().replaceAll("-", "")}`;
      const token = randomBytes(32).toString("hex");
      const root = join(this.#rootDirectory, id);
      try {
        await mkdir(root, { recursive: false, mode: 0o700 });
        const packageRoot = join(root, "package");
        await mkdir(packageRoot, { recursive: false, mode: 0o700 });
        const snapshot = await lease.snapshotTo(packageRoot);
        if (snapshot.discoveredRevision !== input.authority.discoveredRevision) {
          throw new Error("Extension main-view snapshot does not match its Resource generation.");
        }
        const catalog = await inspectPiPackageCatalog(packageRoot);
        const extension = catalog.extensions.find((entry) => entry.relativePath === input.authority.extensionEntry);
        if (extension === undefined || !sameMainView(extension.mainView, input.authority.mainView)
          || !sameLibrary(extension.library, input.authority.library)
          || catalog.name !== input.authority.packageName
          || catalog.version !== input.authority.packageVersion) {
          throw new Error("Extension main-view declaration changed while its surface was opening.");
        }
        await lease.assertCurrent();
        await input.assertAuthorityCurrent();
        const viewRoot = resolve(packageRoot, ...dirname(input.authority.mainView.html).split("/"));
        await assertContainedCanonicalDirectory(packageRoot, viewRoot, "Extension main-view directory");
        const expiresAt = this.#now() + this.#ttlMs;
        const endpoint = `/v1/extensions/main-views/${id}/${token}/${encodeURIComponent(basename(input.authority.mainView.html))}`;
        this.#surfaces.set(id, {
          id,
          tokenDigest: tokenDigest(token),
          endpoint,
          authority: copyAuthority(input.authority),
          connectionId: input.connectionId,
          root,
          viewRoot,
          lease,
          assertAuthorityCurrent: input.assertAuthorityCurrent,
          expiresAt
        });
        return {
          id,
          extensionId: input.authority.extensionId,
          authority: copyAuthority(input.authority),
          endpoint,
          ...(input.authority.mainView.title === undefined ? {} : { title: input.authority.mainView.title }),
          ...(input.authority.mainView.icon === undefined ? {} : { icon: input.authority.mainView.icon }),
          expiresAt
        };
      } catch (error) {
        await lease.release().catch(() => undefined);
        await removeOwnedSurfacePath(this.#rootDirectory, root).catch(() => undefined);
        throw error;
      }
    });
  }

  async getSurface(surfaceId: string, connectionId: string): Promise<ExtensionMainViewSurface> {
    this.#assertReady();
    if (!SURFACE_ID.test(surfaceId) || !SAFE_CONNECTION_ID.test(connectionId)) {
      throw new ExtensionMainViewError(404, "Extension main view not found.");
    }
    return this.#mutate(async () => {
      await this.#destroyExpired(this.#now());
      const surface = this.#surfaces.get(surfaceId);
      if (surface === undefined || surface.connectionId !== connectionId) {
        throw new ExtensionMainViewError(404, "Extension main view not found.");
      }
      try {
        await surface.lease.assertCurrent();
        await surface.assertAuthorityCurrent();
      } catch {
        await this.#destroy(surface);
        throw new ExtensionMainViewError(410, "Extension main view was revoked.");
      }
      return {
        id: surface.id,
        extensionId: surface.authority.extensionId,
        authority: copyAuthority(surface.authority),
        endpoint: surface.endpoint,
        ...(surface.authority.mainView.title === undefined ? {} : { title: surface.authority.mainView.title }),
        ...(surface.authority.mainView.icon === undefined ? {} : { icon: surface.authority.mainView.icon }),
        expiresAt: surface.expiresAt
      };
    });
  }

  async serve(input: {
    readonly surfaceId: string;
    readonly token: string;
    readonly assetPath: string;
    readonly method: string;
    readonly rangeRequested?: boolean;
  }): Promise<ExtensionMainViewAsset> {
    this.#assertReady();
    return this.#mutate(async () => {
      const now = this.#now();
      await this.#destroyExpired(now);
      if (!SURFACE_ID.test(input.surfaceId) || !TOKEN.test(input.token)) throw new ExtensionMainViewError(404, "Extension main view not found.");
      const surface = this.#surfaces.get(input.surfaceId);
      if (surface === undefined || !timingSafeEqual(surface.tokenDigest, tokenDigest(input.token))) {
        throw new ExtensionMainViewError(404, "Extension main view not found.");
      }
      if (input.method !== "GET" && input.method !== "HEAD") throw new ExtensionMainViewError(405, "Extension main views allow only GET and HEAD.");
      if (input.rangeRequested === true) throw new ExtensionMainViewError(416, "Extension main views do not support byte ranges.");
      try {
        await surface.lease.assertCurrent();
        await surface.assertAuthorityCurrent();
      } catch {
        await this.#destroy(surface);
        throw new ExtensionMainViewError(410, "Extension main view was revoked.");
      }
      if (input.assetPath === LIBRARY_BRIDGE_ASSET && surface.authority.library !== undefined) {
        return {
          status: 200,
          mimeType: MIME_TYPES[".js"]!,
          contentLength: LIBRARY_BRIDGE_SCRIPT.byteLength,
          ...(input.method === "HEAD" ? {} : { body: Buffer.from(LIBRARY_BRIDGE_SCRIPT) }),
          headers: surfaceHeaders()
        };
      }
      const candidate = safeAssetPath(surface.viewRoot, input.assetPath);
      const mimeType = MIME_TYPES[extname(candidate).toLowerCase()];
      if (mimeType === undefined) throw new ExtensionMainViewError(404, "Extension main-view asset type is not allowed.");
      const entrypoint = resolve(surface.viewRoot, basename(surface.authority.mainView.html));
      const injectLibrary = samePath(candidate, entrypoint) && mimeType.startsWith("text/html")
        && surface.authority.library !== undefined;
      const file = await readStableAsset(surface.viewRoot, candidate, this.#maximumAssetBytes, input.method === "HEAD" && !injectLibrary);
      const transformed = injectLibrary && file.body !== undefined ? injectLibraryBridge(file.body) : file.body;
      return {
        status: 200,
        mimeType,
        contentLength: transformed?.byteLength ?? file.size,
        ...(input.method === "HEAD" || transformed === undefined ? {} : { body: transformed }),
        headers: surfaceHeaders()
      };
    });
  }

  async closeSurface(surfaceId: string, connectionId: string): Promise<boolean> {
    this.#assertReady();
    if (!SURFACE_ID.test(surfaceId) || !SAFE_CONNECTION_ID.test(connectionId)) return false;
    return this.#mutate(async () => {
      const surface = this.#surfaces.get(surfaceId);
      if (surface === undefined || surface.connectionId !== connectionId) return false;
      await this.#destroy(surface);
      return true;
    });
  }

  async closeConnection(connectionId: string): Promise<void> {
    if (!this.#initialized || this.#closed || !SAFE_CONNECTION_ID.test(connectionId)) return;
    await this.#mutate(async () => {
      for (const surface of [...this.#surfaces.values()]) {
        if (surface.connectionId === connectionId) await this.#destroy(surface);
      }
    });
  }

  async close(): Promise<void> {
    if (!this.#initialized || this.#closed) return;
    this.#closed = true;
    if (this.#expirationTimer !== undefined) clearInterval(this.#expirationTimer);
    await this.#mutate(async () => {
      for (const surface of [...this.#surfaces.values()]) await this.#destroy(surface);
    });
  }

  async #expire(): Promise<void> {
    if (!this.#initialized || this.#closed) return;
    await this.#mutate(async () => this.#destroyExpired(this.#now()));
  }

  async #destroyExpired(now: number): Promise<void> {
    for (const surface of [...this.#surfaces.values()]) if (surface.expiresAt <= now) await this.#destroy(surface);
  }

  async #destroy(surface: ActiveSurface): Promise<void> {
    if (this.#surfaces.get(surface.id) === surface) this.#surfaces.delete(surface.id);
    await surface.lease.release().catch(() => undefined);
    await removeOwnedSurfacePath(this.#rootDirectory, surface.root).catch(() => undefined);
  }

  async #mutate<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  #assertReady(): void {
    if (!this.#initialized || this.#closed) throw new Error("Extension main-view manager is unavailable.");
  }
}

export function surfaceHeaders(): Readonly<Record<string, string>> {
  return {
    "access-control-allow-origin": "null",
    "accept-ranges": "none",
    "cache-control": "no-store",
    "content-disposition": "inline",
    "content-security-policy": EXTENSION_MAIN_VIEW_CONTENT_SECURITY_POLICY,
    "cross-origin-resource-policy": "cross-origin",
    "permissions-policy": "accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff"
  };
}

function validateAuthority(authority: ExtensionMainViewAuthority): void {
  if (!EXTENSION_ID.test(authority.extensionId) || authority.resourceId.trim() === "" || authority.backendId.trim() === ""
    || authority.backendRevision < 1n || !Number.isSafeInteger(authority.backendGeneration) || authority.backendGeneration < 0
    || authority.resourceRevision < 1n || !/^sha256:[a-f0-9]{64}$/u.test(authority.discoveredRevision)
    || authority.packageName.trim() === "" || authority.extensionEntry.trim() === "") {
    throw new Error("Extension main-view authority is invalid.");
  }
  if (authority.library !== undefined && authority.library.schemaVersion !== 1) {
    throw new Error("Extension main-view Library authority is invalid.");
  }
}

function copyAuthority(authority: ExtensionMainViewAuthority): ExtensionMainViewAuthority {
  return { ...authority, mainView: { ...authority.mainView }, ...(authority.library === undefined ? {} : { library: { ...authority.library } }) };
}

function sameMainView(left: ExtensionMainViewDescriptor | undefined, right: ExtensionMainViewDescriptor): boolean {
  return left?.html === right.html && left.title === right.title && left.icon === right.icon;
}

function sameLibrary(left: ExtensionLibraryDescriptor | undefined, right: ExtensionLibraryDescriptor | undefined): boolean {
  return left?.schemaVersion === right?.schemaVersion && (left === undefined) === (right === undefined);
}

function injectLibraryBridge(html: Buffer): Buffer {
  const source = html.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(html)) {
    throw new ExtensionMainViewError(410, "Extension main-view entry HTML is not valid UTF-8.");
  }
  const tag = `<script src="./${LIBRARY_BRIDGE_ASSET}"></script>`;
  const head = /<head(?:\s[^>]*)?>/iu.exec(source);
  if (head !== null && head.index !== undefined) {
    const offset = head.index + head[0].length;
    return Buffer.from(`${source.slice(0, offset)}${tag}${source.slice(offset)}`, "utf8");
  }
  const htmlTag = /<html(?:\s[^>]*)?>/iu.exec(source);
  if (htmlTag !== null && htmlTag.index !== undefined) {
    const offset = htmlTag.index + htmlTag[0].length;
    return Buffer.from(`${source.slice(0, offset)}<head>${tag}</head>${source.slice(offset)}`, "utf8");
  }
  return Buffer.from(`${tag}${source}`, "utf8");
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function safeAssetPath(root: string, value: string): string {
  if (value.length === 0 || value.length > 2_048 || value.includes("\\") || value.includes("\0") || value.startsWith("/")) {
    throw new ExtensionMainViewError(404, "Extension main-view asset not found.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ExtensionMainViewError(404, "Extension main-view asset not found.");
  }
  const candidate = resolve(root, ...segments);
  if (!within(root, candidate)) throw new ExtensionMainViewError(404, "Extension main-view asset not found.");
  return candidate;
}

async function readStableAsset(root: string, path: string, maximumBytes: number, head: boolean): Promise<{ readonly size: number; readonly body?: Buffer }> {
  let before;
  try {
    before = await lstat(path);
  } catch {
    throw new ExtensionMainViewError(404, "Extension main-view asset not found.");
  }
  if (!before.isFile() || before.isSymbolicLink()) throw new ExtensionMainViewError(404, "Extension main-view asset not found.");
  if (before.size > maximumBytes) throw new ExtensionMainViewError(413, "Extension main-view asset is too large.");
  const canonical = await realpath(path);
  if (!within(root, canonical) || !samePath(path, canonical)) throw new ExtensionMainViewError(404, "Extension main-view asset not found.");
  const handle = await open(canonical, constants.O_RDONLY);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || !sameIdentity(before, opened)) {
      throw new ExtensionMainViewError(410, "Extension main-view asset changed.");
    }
    const body = head ? undefined : await handle.readFile();
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || !sameIdentity(opened, after)
      || body !== undefined && body.length !== opened.size) throw new ExtensionMainViewError(410, "Extension main-view asset changed.");
    return { size: opened.size, ...(body === undefined ? {} : { body }) };
  } finally {
    await handle.close();
  }
}

async function assertCanonicalDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(path, await realpath(path))) throw new Error(`${label} is unsafe.`);
}

async function assertContainedCanonicalDirectory(root: string, path: string, label: string): Promise<void> {
  if (!within(root, path)) throw new Error(`${label} escapes its package boundary.`);
  await assertCanonicalDirectory(path, label);
}

async function removeOwnedSurfacePath(root: string, path: string): Promise<void> {
  if (!within(root, path) || samePath(root, path)) throw new Error("Extension main-view cleanup escaped its owner.");
  await rm(path, { recursive: true, force: true, maxRetries: 3 });
}

function within(root: string, candidate: string): boolean {
  const suffix = relative(resolve(root), resolve(candidate));
  return suffix === "" || suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sameIdentity(left: { readonly dev: number | bigint; readonly ino: number | bigint }, right: { readonly dev: number | bigint; readonly ino: number | bigint }): boolean {
  return left.dev === right.dev && (left.ino === 0 || right.ino === 0 || left.ino === right.ino);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} is invalid.`);
  return value;
}
