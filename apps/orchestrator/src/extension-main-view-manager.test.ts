import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

async function fixture(options: { readonly now?: () => number; readonly ttlMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "joko-extension-main-view-"));
  roots.push(root);
  let current = true;
  let releases = 0;
  let surfaceManifest = authority.mainView;
  let surfaceLibrary: ExtensionMainViewAuthority["library"];
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
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs })
  });
  await manager.initialize();
  return {
    manager,
    acquireInstalledPackage,
    setCurrent(value: boolean) { current = value; },
    setSurfaceManifest(value: typeof surfaceManifest) { surfaceManifest = value; },
    setSurfaceLibrary(value: typeof surfaceLibrary) { surfaceLibrary = value; },
    releases: () => releases
  };
}

describe("ExtensionMainViewManager", () => {
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
      expect(assertAuthorityCurrent).toHaveBeenCalledTimes(4);
      expect(releases()).toBe(0);
    } finally {
      await manager.close();
    }
    expect(releases()).toBe(1);
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
      expect(bootstrapText).toContain("joko:extension-library-request");
      expect(bootstrapText).toContain("Object.freeze({...d.result,ok:true})");
      expect(bootstrapText).toContain("errorCode:d.error.code");
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
    const { manager, setCurrent, releases } = await fixture({ now: () => now, ttlMs: 1_000 });
    try {
      const first = await manager.open({ authority, connectionId: "connection-a", assertAuthorityCurrent: () => undefined });
      const [, firstId, firstToken] = /main-views\/([^/]+)\/([^/]+)/u.exec(first.endpoint)!;
      setCurrent(false);
      await expect(manager.serve({ surfaceId: firstId!, token: firstToken!, assetPath: "index.html", method: "GET" }))
        .rejects.toEqual(expect.objectContaining<Partial<ExtensionMainViewError>>({ statusCode: 410 }));
      expect(releases()).toBe(1);

      setCurrent(true);
      const second = await manager.open({ authority, connectionId: "connection-a", assertAuthorityCurrent: () => undefined });
      const [, secondId, secondToken] = /main-views\/([^/]+)\/([^/]+)/u.exec(second.endpoint)!;
      now += 1_001;
      await expect(manager.serve({ surfaceId: secondId!, token: secondToken!, assetPath: "index.html", method: "GET" }))
        .rejects.toMatchObject({ statusCode: 404 });
      expect(releases()).toBe(2);
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
