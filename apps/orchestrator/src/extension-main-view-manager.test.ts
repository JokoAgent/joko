import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webcrypto } from "node:crypto";
import { Script } from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ExtensionMainViewError,
  ExtensionMainViewManager,
  type ExtensionMainViewAuthority
} from "./extension-main-view-manager.js";
import type { PiInstalledPackageLease, PiResourceManager } from "./resource-manager.js";
import { mkdtemp } from "./test-paths.js";

const roots: string[] = [];
const REVISION = `sha256:${"a".repeat(64)}`;
const authority: ExtensionMainViewAuthority = {
  extensionId: "extension_0123456789abcdef0123456789abcdef",
  resourceId: "resource-package-review",
  backendId: "pi",
  backendRevision: 3n,
  backendGeneration: 2,
  resourceRevision: 7n,
  discoveredRevision: REVISION,
  packageName: "@sample/review",
  packageVersion: "2.1.0",
  extensionEntry: "extensions/review.ts",
  mainView: { html: "ui/review/index.html", title: "Review", icon: "layout" }
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: { readonly now?: () => number; readonly ttlMs?: number;
  readonly maximumAssetBytes?: number;
  readonly onSurfaceRevoked?: (surfaceId: string, connectionId: string) => void } = {}) {
  const root = await mkdtemp(join(tmpdir(), "joko-extension-main-view-"));
  roots.push(root);
  let current = true;
  let releases = 0;
  let surfaceManifest = authority.mainView;
  let surfaceLibrary: ExtensionMainViewAuthority["library"];
  let surfaceSettings: ExtensionMainViewAuthority["settings"];
  const acquireInstalledPackage = vi.fn(async (): Promise<PiInstalledPackageLease> => ({
    resource: {} as PiInstalledPackageLease["resource"],
    snapshotTo: async (destination) => {
      await mkdir(join(destination, "extensions"), { recursive: true });
      await mkdir(join(destination, "ui", "review"), { recursive: true });
      await writeFile(join(destination, "package.json"), JSON.stringify({
        name: authority.packageName,
        version: authority.packageVersion,
        pi: { extensions: [authority.extensionEntry] },
        joko: {
          extensionSurfaces: {
            schemaVersion: 1,
            extensions: [{
              entry: authority.extensionEntry,
              mainView: surfaceManifest,
              ...(surfaceSettings === undefined ? {} : { settings: surfaceSettings }),
              ...(surfaceLibrary === undefined ? {} : { library: surfaceLibrary })
            }]
          }
        }
      }), "utf8");
      await writeFile(join(destination, "extensions", "review.ts"), "export default function setup() {}\n", "utf8");
      await writeFile(join(destination, "ui", "review", "index.html"), "<!doctype html><script type=\"module\" src=\"./app.js\"></script>\n", "utf8");
      await writeFile(join(destination, "ui", "review", "secondary.html"), "<!doctype html><p>Secondary</p>\n", "utf8");
      await writeFile(join(destination, "ui", "review", "app.js"), "document.body.dataset.ready = 'true';\n", "utf8");
      return { discoveredRevision: REVISION, files: 4, bytes: 512, entries: [] };
    },
    assertCurrent: async () => { if (!current) throw new Error("Resource generation changed."); },
    release: async () => { releases += 1; }
  }));
  const manager = new ExtensionMainViewManager({
    resources: { acquireInstalledPackage } as Pick<PiResourceManager, "acquireInstalledPackage">,
    rootDirectory: join(root, "surfaces"),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.maximumAssetBytes === undefined ? {} : { maximumAssetBytes: options.maximumAssetBytes }),
    ...(options.onSurfaceRevoked === undefined ? {} : { onSurfaceRevoked: options.onSurfaceRevoked })
  });
  await manager.initialize();
  return {
    manager,
    acquireInstalledPackage,
    setCurrent(value: boolean) { current = value; },
    setSurfaceManifest(value: typeof surfaceManifest) { surfaceManifest = value; },
    setSurfaceLibrary(value: typeof surfaceLibrary) { surfaceLibrary = value; },
    setSurfaceSettings(value: typeof surfaceSettings) { surfaceSettings = value; },
    releases: () => releases
  };
}

describe("ExtensionMainViewManager", () => {
  it("opens the inspected mobile settings page independently of the main view and its Library authority", async () => {
    const f = await fixture();
    try {
      const settings = { html: "ui/review/index.html", mobileHtml: "ui/review/secondary.html", title: "Configuration", height: 320 };
      f.setSurfaceSettings(settings);
      const view = await f.manager.open({ authority, connectionId: "connection-a", assertAuthorityCurrent: () => undefined });
      const configuration = { ...authority, mainView: { html: settings.mobileHtml, title: settings.title }, settings, mobileSettings: true as const };
      const page = await f.manager.open({ authority: configuration, connectionId: "connection-a", assertAuthorityCurrent: () => undefined });
      expect(page.endpoint).toMatch(/secondary\.html$/u);
      expect(f.manager.isSurfaceCurrent(view.id, "connection-a")).toBe(true);
      expect(f.manager.isSurfaceCurrent(page.id, "connection-b")).toBe(false);
      const [, , , , surfaceId, token, entry] = page.endpoint.split("/");
      const html = await f.manager.serve({ surfaceId: surfaceId!, token: token!, assetPath: entry!, method: "GET", isolatedDocument: true });
      const programs = [...html.body!.toString().matchAll(/data:text\/javascript;base64,([A-Za-z0-9+/=]+)/gu)]
        .map(match => Buffer.from(match[1]!, "base64").toString()).join("\n");
      expect(programs).toContain("joko:extension-settings-request");
      expect(programs).not.toContain("joko:extension-library-request");
      expect(html.headers["content-security-policy"]).toContain("connect-src 'none'");
      await expect(f.manager.open({ authority: { ...configuration, library: { schemaVersion: 1 } }, connectionId: "connection-a", assertAuthorityCurrent: () => undefined })).rejects.toThrow(/settings authority/u);
      await f.manager.closeSurface(page.id, "connection-a");
      expect(f.manager.isSurfaceCurrent(page.id, "connection-a")).toBe(false);
      await expect(f.manager.getSurface(view.id, "connection-a")).resolves.toMatchObject({ id: view.id });
    } finally { await f.manager.close(); }
  });
  it("retires an ordinary view only inside its owning connection when moving the single instance", async () => {
    const revoked = vi.fn(), f = await fixture({ onSurfaceRevoked: revoked });
    try {
      const first = await f.manager.open({ authority, connectionId: "connection-a", assertAuthorityCurrent: () => undefined });
      const other = await f.manager.open({ authority, connectionId: "connection-b", assertAuthorityCurrent: () => undefined });
      const second = await f.manager.open({ authority, connectionId: "connection-a", assertAuthorityCurrent: () => undefined });
      expect(second.id).not.toBe(first.id); expect(revoked).toHaveBeenCalledExactlyOnceWith(first.id, "connection-a");
      await expect(f.manager.getSurface(first.id, "connection-a")).rejects.toMatchObject({ statusCode: 404 });
      await expect(f.manager.getSurface(second.id, "connection-a")).resolves.toMatchObject({ id: second.id });
      await expect(f.manager.getSurface(other.id, "connection-b")).resolves.toMatchObject({ id: other.id });
    } finally { await f.manager.close(); }
  });
  it("allows independent surfaces only on the exact declared multiple-view generation", async () => {
    const f = await fixture(), multi = { ...authority, mainView: { ...authority.mainView, open: "sidebar" as const, side: "left" as const, multiple: true as const } };
    f.setSurfaceManifest(multi.mainView);
    try {
      const first = await f.manager.open({ authority: multi, connectionId: "connection-a", assertAuthorityCurrent: () => undefined });
      const second = await f.manager.open({ authority: multi, connectionId: "connection-b", assertAuthorityCurrent: () => undefined });
      await expect(f.manager.getSurface(first.id, "connection-a")).resolves.toMatchObject({ id: first.id });
      await expect(f.manager.getSurface(second.id, "connection-b")).resolves.toMatchObject({ id: second.id });
      f.setSurfaceManifest({ ...multi.mainView, side: "right" });
      await expect(f.manager.open({ authority: multi, connectionId: "connection-c", assertAuthorityCurrent: () => undefined })).rejects.toThrow("declaration changed");
      await expect(f.manager.getSurface(first.id, "connection-a")).resolves.toMatchObject({ id: first.id });
    } finally { await f.manager.close(); }
  });
  it("materializes only the current declared document and keeps the total response budget", async () => {
    const f = await fixture();
    try {
      const surface = await f.manager.open({ authority, connectionId: "connection-a", assertAuthorityCurrent: () => undefined });
      const [, surfaceId, token, entry] = /main-views\/([^/]+)\/([^/]+)\/(.+)$/u.exec(surface.endpoint)!;
      const request = { surfaceId: surfaceId!, token: token!, assetPath: entry!, method: "GET", isolatedDocument: true };
      const html = await f.manager.serve(request);
      expect(html.body!.toString()).toContain("data:text/javascript;base64,");
      expect(html.body!.toString()).not.toContain('src="./app.js"');
      expect((await f.manager.serve({ ...request, assetPath: "secondary.html" })).body!.toString()).toContain("Secondary");
      f.setCurrent(false);
      await expect(f.manager.serve(request)).rejects.toMatchObject({ statusCode: 410 });
    } finally { await f.manager.close(); }
    const small = await fixture({ maximumAssetBytes: 200 });
    try {
      const surface = await small.manager.open({ authority, connectionId: "connection-a", assertAuthorityCurrent: () => undefined });
      const [, surfaceId, token, entry] = /main-views\/([^/]+)\/([^/]+)\/(.+)$/u.exec(surface.endpoint)!;
      await expect(small.manager.serve({ surfaceId: surfaceId!, token: token!, assetPath: entry!, method: "GET", isolatedDocument: true }))
        .rejects.toMatchObject({ statusCode: 413 });
    } finally { await small.manager.close(); }
  });

  it("leases and re-verifies an exact package generation before serving its declared directory", async () => {
    const { manager, acquireInstalledPackage, releases } = await fixture();
    try {
      const assertAuthorityCurrent = vi.fn();
      const surface = await manager.open({ authority, connectionId: "connection-a", assertAuthorityCurrent });
      expect(surface).toMatchObject({
        extensionId: authority.extensionId,
        title: "Review",
        icon: "layout"
      });
      expect(surface.endpoint).toMatch(/^\/v1\/extensions\/main-views\/extension_surface_[a-f0-9]{32}\/[a-f0-9]{64}\/index\.html$/u);
      expect(acquireInstalledPackage).toHaveBeenCalledWith({
        resourceId: authority.resourceId,
        backendId: authority.backendId,
        expectedResourceVersion: 7n,
        expectedDiscoveredRevision: REVISION,
        expectedPackageIdentity: authority.packageName,
        expectedPackageVersion: authority.packageVersion
      });
      const [, surfaceId, token, entry] = /main-views\/([^/]+)\/([^/]+)\/(.+)$/u.exec(surface.endpoint)!;
      const html = await manager.serve({ surfaceId: surfaceId!, token: token!, assetPath: entry!, method: "GET" });
      expect(html.mimeType).toBe("text/html; charset=utf-8");
      expect(html.body?.toString("utf8")).toContain("./app.js");
      expect(html.headers).toMatchObject({
        "access-control-allow-origin": "null",
        "accept-ranges": "none",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff"
      });
      expect(html.headers["content-security-policy"]).toContain("connect-src 'none'");
      const script = await manager.serve({ surfaceId: surfaceId!, token: token!, assetPath: "app.js", method: "HEAD" });
      expect(script.mimeType).toBe("text/javascript; charset=utf-8");
      expect(script.body).toBeUndefined();
      expect(assertAuthorityCurrent).toHaveBeenCalledTimes(6);
      expect(releases()).toBe(0);
    } finally {
      await manager.close();
    }
    expect(releases()).toBe(1);
  });

  it("does not return an asset authorized before its resource or connection was revoked", async () => {
    const f = await fixture(); let current = true, retireAfterCheck = false;
    const assertAuthorityCurrent = async () => {
      if (!current) throw new Error("Connection was revoked.");
      if (retireAfterCheck) { retireAfterCheck = false; queueMicrotask(() => { current = false; }); }
    };
    try {
      const surface = await f.manager.open({ authority, connectionId: "connection-a", assertAuthorityCurrent });
      const [, surfaceId, token] = /main-views\/([^/]+)\/([^/]+)/u.exec(surface.endpoint)!;
      retireAfterCheck = true;
      await expect(f.manager.serve({ surfaceId: surfaceId!, token: token!, assetPath: "app.js", method: "GET" })).rejects.toMatchObject({ statusCode: 410 });
      expect(f.releases()).toBe(1);
    } finally { await f.manager.close(); }
  });

  it("limits runtime code and read-only stylesheet transforms to the original surface types", async () => {
    const f = await fixture();
    try {
      const surface = await f.manager.open({ authority, connectionId: "connection-a", assertAuthorityCurrent: () => undefined });
      const [, surfaceId, token] = /main-views\/([^/]+)\/([^/]+)/u.exec(surface.endpoint)!;
      const request = { surfaceId: surfaceId!, token: token!, assetPath: "app.js", method: "GET" };
      const script = await f.manager.serve({ ...request, materializeAsset: "script" });
      expect(script.mimeType).toBe("text/javascript; charset=utf-8"); expect(script.body!.toString()).toContain("document.body.dataset.ready");
      const style = await f.manager.serve({ ...request, assetPath: "index.html", method: "POST", materializeAsset: "style", inlineStyle: "body{color:rgb(1,2,3)}" });
      expect(style.mimeType).toBe("text/css; charset=utf-8"); expect(style.body!.toString()).toContain("color:");
      await expect(f.manager.serve({ ...request, materializeAsset: "style" })).rejects.toMatchObject({ statusCode: 404 });
      await expect(f.manager.serve({ ...request, assetPath: "index.html", materializeAsset: "style", inlineStyle: "body{}" })).rejects.toMatchObject({ statusCode: 405 });
      await expect(f.manager.serve({ ...request, assetPath: "../private.css", method: "POST", materializeAsset: "style", inlineStyle: "body{}" })).rejects.toMatchObject({ statusCode: 404 });
    } finally { await f.manager.close(); }
  });

  it("retires existing response lifetimes before queued connection cleanup can run", async () => {
    const f = await fixture();
    let hold = false, entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const assertAuthorityCurrent = async () => { if (hold) { hold = false; entered(); await gate; } };
    try {
      const surface = await f.manager.open({ authority, connectionId: "connection-a", assertAuthorityCurrent });
      const [, surfaceId, token] = /main-views\/([^/]+)\/([^/]+)/u.exec(surface.endpoint)!;
      const request = { surfaceId: surfaceId!, token: token!, assetPath: "app.js", method: "GET" };
      const first = await f.manager.serve(request); expect(first.lifetime!.aborted).toBe(false);
      hold = true;
      const pending = f.manager.serve(request); await started;
      const closing = f.manager.closeConnection("connection-a");
      expect(first.lifetime!.aborted).toBe(true);
      const rejected = expect(pending).rejects.toMatchObject({ statusCode: 410 });
      release(); await rejected; await closing; expect(f.releases()).toBe(1);
    } finally { release(); await f.manager.close(); }
  });

  it("fails closed for path escape, unknown media, ranges, methods, and another connection's close", async () => {
    const { manager, releases } = await fixture();
    try {
      const surface = await manager.open({ authority, connectionId: "connection-a", assertAuthorityCurrent: () => undefined });
      const [, surfaceId, token] = /main-views\/([^/]+)\/([^/]+)/u.exec(surface.endpoint)!;
      await expect(manager.serve({ surfaceId: surfaceId!, token: token!, assetPath: "../package.json", method: "GET" }))
        .rejects.toMatchObject({ statusCode: 404 });
      await expect(manager.serve({ surfaceId: surfaceId!, token: token!, assetPath: "notes.bin", method: "GET" }))
        .rejects.toMatchObject({ statusCode: 404 });
      await expect(manager.serve({ surfaceId: surfaceId!, token: token!, assetPath: "index.html", method: "GET", rangeRequested: true }))
        .rejects.toMatchObject({ statusCode: 416 });
      await expect(manager.serve({ surfaceId: surfaceId!, token: token!, assetPath: "index.html", method: "POST" }))
        .rejects.toMatchObject({ statusCode: 405 });
      await expect(manager.closeSurface(surfaceId!, "connection-b")).resolves.toBe(false);
      await expect(manager.closeSurface(surfaceId!, "connection-a")).resolves.toBe(true);
      expect(releases()).toBe(1);
    } finally {
      await manager.close();
    }
  });

  it("injects the bounded Library bootstrap only into a declared entry document", async () => {
    const libraryAuthority: ExtensionMainViewAuthority = { ...authority, library: { schemaVersion: 1 } };
    const { manager, setSurfaceLibrary } = await fixture();
    setSurfaceLibrary(libraryAuthority.library);
    try {
      const surface = await manager.open({
        authority: libraryAuthority,
        connectionId: "connection-a",
        assertAuthorityCurrent: () => undefined
      });
      const [, surfaceId, token, entry] = /main-views\/([^/]+)\/([^/]+)\/(.+)$/u.exec(surface.endpoint)!;
      const html = await manager.serve({ surfaceId: surfaceId!, token: token!, assetPath: entry!, method: "GET" });
      const text = html.body!.toString("utf8");
      expect(text).toContain('<script src="./__joko_extension_library_bridge__.js"></script>');
      expect(html.contentLength).toBe(html.body!.byteLength);

      const head = await manager.serve({ surfaceId: surfaceId!, token: token!, assetPath: entry!, method: "HEAD" });
      expect(head.body).toBeUndefined();
      expect(head.contentLength).toBe(html.contentLength);

      const bootstrap = await manager.serve({
        surfaceId: surfaceId!, token: token!, assetPath: "__joko_extension_library_bridge__.js", method: "GET"
      });
      const bootstrapText = bootstrap.body?.toString("utf8") ?? "";
      const page = libraryPage(bootstrapText);
      const response = page.window.joko!.library({ kind: "read", path: "mail" });
      expect(page.parent.postMessage).toHaveBeenCalledTimes(1);
      const request = page.parent.postMessage.mock.calls[0]![0] as { id: string };
      page.dispatch("message", { source: page.parent, data: { type: "joko:extension-library-response", version: 1,
        id: request.id, ok: true, result: { kind: "read", content: Uint8Array.of(128) } } });
      await expect(response).resolves.toMatchObject({ kind: "read", ok: true, content: Uint8Array.of(128) });

      const mobile = libraryPage(bootstrapText, true);
      const opening = mobile.window.joko!.library({ kind: "open" });
      expect(mobile.parent.postMessage).not.toHaveBeenCalled();
      mobile.window[Symbol.for("joko.extension-library-mobile.transport")] = true;
      mobile.dispatch("joko:extension-library-transport-ready", {});
      mobile.dispatch("joko:extension-library-transport-ready", {});
      expect(mobile.parent.postMessage).toHaveBeenCalledTimes(1);
      const mobileRequest = mobile.parent.postMessage.mock.calls[0]![0] as { id: string };
      mobile.dispatch("message", { source: mobile.parent, data: { type: "joko:extension-library-response", version: 1,
        id: mobileRequest.id, ok: false, error: { code: "result-unknown", message: "Refresh the main view." } } });
      await expect(opening).resolves.toEqual({ ok: false, errorCode: "result-unknown", message: "Refresh the main view." });
      expect(bootstrap.headers["content-security-policy"]).toContain("script-src 'self'");

      const secondary = await manager.serve({
        surfaceId: surfaceId!, token: token!, assetPath: "secondary.html", method: "GET"
      });
      expect(secondary.body?.toString("utf8")).not.toContain("__joko_extension_library_bridge__.js");
    } finally {
      await manager.close();
    }
  });

  it("revokes immediately when Resource authority changes and expires idle leases", async () => {
    let now = 1_800_000_000_000;
    const onSurfaceRevoked = vi.fn();
    const { manager, setCurrent, releases } = await fixture({ now: () => now, ttlMs: 1_000, onSurfaceRevoked });
    try {
      const first = await manager.open({ authority, connectionId: "connection-a", assertAuthorityCurrent: () => undefined });
      const [, firstId, firstToken] = /main-views\/([^/]+)\/([^/]+)/u.exec(first.endpoint)!;
      setCurrent(false);
      await expect(manager.serve({ surfaceId: firstId!, token: firstToken!, assetPath: "index.html", method: "GET" }))
        .rejects.toEqual(expect.objectContaining<Partial<ExtensionMainViewError>>({ statusCode: 410 }));
      expect(releases()).toBe(1);
      expect(onSurfaceRevoked).toHaveBeenCalledExactlyOnceWith(firstId, "connection-a");

      setCurrent(true);
      const second = await manager.open({ authority, connectionId: "connection-a", assertAuthorityCurrent: () => undefined });
      const [, secondId, secondToken] = /main-views\/([^/]+)\/([^/]+)/u.exec(second.endpoint)!;
      now += 1_001;
      await expect(manager.serve({ surfaceId: secondId!, token: secondToken!, assetPath: "index.html", method: "GET" }))
        .rejects.toMatchObject({ statusCode: 404 });
      expect(releases()).toBe(2);
      expect(onSurfaceRevoked).toHaveBeenLastCalledWith(secondId, "connection-a");
    } finally {
      await manager.close();
    }
  });

  it("releases its lease and snapshot when re-parsed manifest authority drifts", async () => {
    const { manager, setSurfaceManifest, releases } = await fixture();
    try {
      setSurfaceManifest({ ...authority.mainView, title: "Changed" });
      await expect(manager.open({ authority, connectionId: "connection-a", assertAuthorityCurrent: () => undefined }))
        .rejects.toThrow(/declaration changed/u);
      expect(releases()).toBe(1);
    } finally {
      await manager.close();
    }
  });

  it("rejects a Library declaration that is absent from the exact surface authority", async () => {
    const { manager, setSurfaceLibrary, releases } = await fixture();
    try {
      setSurfaceLibrary({ schemaVersion: 1 });
      await expect(manager.open({ authority, connectionId: "connection-a", assertAuthorityCurrent: () => undefined }))
        .rejects.toThrow(/declaration changed/u);
      expect(releases()).toBe(1);
    } finally {
      await manager.close();
    }
  });
});

function libraryPage(source: string, mobile = false) {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const page: { joko?: { library(operation: unknown): Promise<unknown> }; ReactNativeWebView?: object; [key: symbol]: unknown } = {};
  if (mobile) page.ReactNativeWebView = {};
  const frameParent = { postMessage: vi.fn((_data: unknown, _origin: string) => undefined) };
  new Script(source).runInNewContext({ window: page, parent: frameParent, crypto: webcrypto, Uint8Array, Symbol,
    setTimeout, clearTimeout,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      const current = listeners.get(type) ?? new Set();
      current.add(listener); listeners.set(type, current);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => listeners.get(type)?.delete(listener)
  });
  return { window: page, parent: frameParent, dispatch: (type: string, event: unknown) =>
    listeners.get(type)?.forEach((listener) => listener(event)) };
}
