import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ExtensionSourceError,
  ExtensionSourceManager,
  normalizeExtensionSourceInput,
  type ExtensionSourceGitExecutor
} from "./extension-source-manager.js";
import { inspectPiPackageCatalog } from "./pi-package-compatibility.js";
import { mkdtemp } from "./test-paths.js";

const roots: string[] = [];
const NOW = 1_800_000_000_000;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function makeRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `joko-extension-source-${label}-`));
  roots.push(root);
  return root;
}

async function writeMarket(
  root: string,
  marketName: string,
  packages: readonly { readonly path: string; readonly label: string; readonly version?: string; readonly entry?: string }[]
): Promise<void> {
  await mkdir(join(root, ".agents", "plugins"), { recursive: true });
  await writeFile(join(root, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: marketName,
    displayName: `${marketName} catalog`,
    plugins: packages.map((item) => ({ name: item.label, source: item.path }))
  }), "utf8");
  for (const item of packages) {
    const packageRoot = join(root, ...item.path.split("/"));
    const extension = item.entry ?? "extensions/index.ts";
    await mkdir(join(packageRoot, "extensions"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: `@sample/${item.label.toLocaleLowerCase("en-US")}`,
      version: item.version ?? "1.0.0",
      author: "Package Author",
      description: `${item.label} package`,
      pi: { extensions: [extension] }
    }), "utf8");
    await writeFile(join(packageRoot, ...extension.split("/")), "export default function setup() {}\n", "utf8");
  }
}

async function fixture(label: string, git?: ExtensionSourceGitExecutor, inspectPackageCatalog?: typeof inspectPiPackageCatalog) {
  const root = await makeRoot(label);
  const store = new OperationalStore(join(root, "orchestrator.db"), { now: () => NOW });
  const manager = new ExtensionSourceManager({
    store,
    cacheRoot: join(root, "source-cache"),
    homeDirectory: root,
    now: () => NOW,
    ...(git === undefined ? {} : { git }),
    ...(inspectPackageCatalog === undefined ? {} : { inspectPackageCatalog })
  });
  await manager.initialize();
  return { root, store, manager };
}

describe("ExtensionSourceManager", () => {
  it("normalizes only credential-free current-v1 local and Git source shapes", () => {
    expect(normalizeExtensionSourceInput({ kind: "local", path: "~/catalog" }, "D:\\owner"))
      .toEqual({ kind: "local", path: join("D:\\owner", "catalog") });
    expect(normalizeExtensionSourceInput({ kind: "git", repositoryUrl: "example/extensions", ref: "v1", sparsePaths: [".agents/plugins", "packages/review"] }))
      .toEqual({
        kind: "git",
        repositoryUrl: "https://github.com/example/extensions.git",
        ref: "v1",
        sparsePaths: [".agents/plugins", "packages/review"]
      });
    for (const repositoryUrl of [
      "https://token@example.test/extensions.git",
      "https://example.test/extensions.git?token=secret",
      "git://example.test/extensions.git",
      "https://example.test\\@attacker.test/extensions.git"
    ]) {
      expect(() => normalizeExtensionSourceInput({ kind: "git", repositoryUrl, sparsePaths: [] })).toThrow(ExtensionSourceError);
    }
    expect(() => normalizeExtensionSourceInput({ kind: "git", repositoryUrl: "https://example.test/extensions.git", ref: "--upload-pack", sparsePaths: [] })).toThrow(/ref/iu);
    expect(() => normalizeExtensionSourceInput({ kind: "git", repositoryUrl: "https://example.test/extensions.git", ref: "main..other", sparsePaths: [] })).toThrow(/ref/iu);
    expect(() => normalizeExtensionSourceInput({ kind: "git", repositoryUrl: "https://example.test/extensions.git", ref: "release.lock/main", sparsePaths: [] })).toThrow(/ref/iu);
    expect(() => normalizeExtensionSourceInput({ kind: "git", repositoryUrl: "https://example.test/extensions.git", sparsePaths: ["../outside"] })).toThrow(/sparse/iu);
    expect(() => normalizeExtensionSourceInput({ kind: "git", repositoryUrl: "https://example.test/extensions.git", sparsePaths: [".git/config"] })).toThrow(/sparse/iu);
  });

  it("requires Git 2.25 before network source acquisition", async () => {
    const git = vi.fn<ExtensionSourceGitExecutor>(async () => ({ stdout: "git version 2.24.4\n", stderr: "" }));
    const { store, manager } = await fixture("git-preflight", git);
    try {
      await expect(manager.gitPreflight()).resolves.toEqual({ available: false, version: "2.24.4", minimumVersion: "2.25" });
      await expect(manager.add({ kind: "git", repositoryUrl: "https://example.test/extensions.git", sparsePaths: [] }, 0n))
        .rejects.toMatchObject({ code: "SOURCE_GIT_UNAVAILABLE" });
      expect(git).toHaveBeenCalledTimes(2);
      expect(git).toHaveBeenNthCalledWith(1, ["--version"], { timeoutMs: 10_000 });
    } finally {
      store.close();
    }
  });

  it("discovers real local Pi packages before persistence and projects exact stable entry identities", async () => {
    const { root, store, manager } = await fixture("local");
    try {
      const market = join(root, "catalog");
      await writeMarket(market, "local-catalog", [{ path: "packages/review", label: "Review", version: "2.1.0" }]);
      const source = await manager.add({ kind: "local", path: market }, 0n);
      expect(source).toMatchObject({
        revision: 1n,
        name: "local-catalog",
        displayName: "local-catalog catalog",
        state: "ready",
        declaredEntryCount: 1,
        skippedEntryCount: 0,
        unreadableEntryCount: 0
      });
      expect(source.entries).toMatchObject([{
        name: "Review",
        packageName: "@sample/review",
        version: "2.1.0",
        bindingName: "index.ts",
        bindingOrdinal: 0,
        packageRelativePath: "packages/review",
        extensionRelativePath: "extensions/index.ts"
      }]);
      expect(source.entries[0]!.id).toMatch(/^extension_source_entry_[a-f0-9]{32}$/u);
      expect(source.entries[0]!.resourceId).toMatch(/^resource_market_[a-f0-9]{32}$/u);
      expect(source.entries[0]!.contentRevision).toMatch(/^sha256:[a-f0-9]{64}$/u);
      await expect(manager.add({ kind: "local", path: market }, 1n)).rejects.toMatchObject({ code: "SOURCE_DUPLICATE" });
      await expect(manager.add({ kind: "local", path: join(root, "missing") }, 1n)).rejects.toBeInstanceOf(Error);
      expect(manager.snapshot().sources).toHaveLength(1);
      await writeFile(join(market, "packages", "review", "extensions", "index.ts"), "export default function changed() {}\n", "utf8");
      await expect(manager.withEntry({
        sourceId: source.id,
        sourceRevision: source.revision,
        entryId: source.entries[0]!.id,
        contentRevision: source.entries[0]!.contentRevision
      }, async () => undefined)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
      const refreshed = await manager.refresh(source.id, source.revision);
      expect(refreshed).toMatchObject({ revision: 2n, state: "ready" });
      expect(refreshed.entries[0]!.packageContentRevision).not.toBe(source.entries[0]!.packageContentRevision);
      expect(refreshed.entries[0]!.contentRevision).not.toBe(source.entries[0]!.contentRevision);

      const restarted = new ExtensionSourceManager({ store, cacheRoot: join(root, "source-cache"), homeDirectory: root, now: () => NOW });
      await restarted.initialize();
      expect(restarted.snapshot()).toMatchObject({ revision: 2n, recoveredFromCorruption: false });
      expect(restarted.snapshot().sources[0]?.entries[0]).toMatchObject({ id: source.entries[0]!.id, resourceId: source.entries[0]!.resourceId });
    } finally {
      store.close();
    }
  });

  it("durably fails closed when a local source disappears during the running process", async () => {
    const { root, store, manager } = await fixture("live-availability");
    try {
      const market = join(root, "catalog");
      await writeMarket(market, "live-catalog", [{ path: "packages/review", label: "Review" }]);
      const source = await manager.add({ kind: "local", path: market }, 0n);
      await rm(market, { recursive: true, force: true });

      const unavailable = await manager.auditAvailability();
      expect(unavailable).toMatchObject({
        revision: 2n,
        sources: [{ id: source.id, revision: 2n, state: "error", error: expect.stringContaining("unavailable") }]
      });
      await expect(manager.auditAvailability()).resolves.toMatchObject({ revision: 2n, sources: [{ revision: 2n }] });

      const restarted = new ExtensionSourceManager({ store, cacheRoot: join(root, "source-cache"), homeDirectory: root, now: () => NOW });
      await restarted.initialize();
      expect(restarted.snapshot()).toMatchObject({ revision: 2n, sources: [{ revision: 2n, state: "error" }] });
    } finally {
      store.close();
    }
  });

  it("keeps the previous immutable Git generation when refresh discovery fails and isolates other sources", async () => {
    let clone = 0;
    const git: ExtensionSourceGitExecutor = async (args) => {
      if (args[0] === "--version") return { stdout: "git version 2.43.1\n", stderr: "" };
      if (args[0] === "clone") {
        clone += 1;
        const destination = String(args.at(-1));
        if (clone === 1) await writeMarket(destination, "git-catalog", [{ path: "packages/first", label: "First" }]);
        else {
          await mkdir(join(destination, ".agents", "plugins"), { recursive: true });
          await writeFile(join(destination, ".agents", "plugins", "marketplace.json"), "{broken", "utf8");
        }
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse") return { stdout: clone === 1 ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const { root, store, manager } = await fixture("refresh", git);
    try {
      const local = join(root, "local");
      await writeMarket(local, "local-catalog", [{ path: "packages/local", label: "Local" }]);
      await manager.add({ kind: "local", path: local }, 0n);
      const source = await manager.add({ kind: "git", repositoryUrl: "https://example.test/extensions.git", sparsePaths: [] }, 1n);
      const originalEntry = source.entries[0]!;

      await expect(manager.refresh(source.id, source.revision)).rejects.toMatchObject({ code: "SOURCE_MANIFEST_INVALID" });
      const snapshot = manager.snapshot();
      const failed = snapshot.sources.find((item) => item.id === source.id)!;
      expect(failed).toMatchObject({ state: "error", revision: 2n, entries: [{ id: originalEntry.id, contentRevision: originalEntry.contentRevision }] });
      expect(snapshot.sources.find((item) => item.name === "local-catalog")?.state).toBe("ready");
      await expect(manager.withEntry({
        sourceId: failed.id,
        sourceRevision: failed.revision,
        entryId: originalEntry.id,
        contentRevision: originalEntry.contentRevision
      }, async (_entry, packageRoot) => readFile(join(packageRoot, "extensions", "index.ts"), "utf8"))).resolves.toContain("setup");
    } finally {
      store.close();
    }
  });

  it("isolates permanently invalid and transiently unreadable package entries", async () => {
    const inspect = vi.fn(async (packageRoot: string) => {
      if (packageRoot.endsWith(`${join("packages", "busy")}`)) {
        throw Object.assign(new Error("temporarily unavailable"), { code: "EACCES" });
      }
      return inspectPiPackageCatalog(packageRoot);
    });
    const { root, store, manager } = await fixture("entry-isolation", undefined, inspect);
    try {
      const market = join(root, "catalog");
      await writeMarket(market, "mixed-catalog", [
        { path: "packages/ready", label: "Ready" },
        { path: "packages/busy", label: "Busy" }
      ]);
      await writeFile(join(market, ".agents", "plugins", "marketplace.json"), JSON.stringify({
        name: "mixed-catalog",
        plugins: [
          { name: "Ready", source: "packages/ready" },
          { name: "Busy", source: "packages/busy" },
          { name: "Missing", source: "packages/missing" }
        ]
      }), "utf8");

      const source = await manager.add({ kind: "local", path: market }, 0n);
      expect(source).toMatchObject({
        state: "ready",
        declaredEntryCount: 3,
        skippedEntryCount: 1,
        unreadableEntryCount: 1,
        entries: [{ name: "Ready" }]
      });
    } finally {
      store.close();
    }
  });

  it("rejects package projections that change while their catalog metadata is inspected", async () => {
    const inspect = vi.fn(async (packageRoot: string) => {
      const result = await inspectPiPackageCatalog(packageRoot);
      await rm(join(packageRoot, "extensions", "index.ts"));
      return result;
    });
    const { root, store, manager } = await fixture("inspection-race", undefined, inspect);
    try {
      const market = join(root, "catalog");
      await writeMarket(market, "changing-catalog", [{ path: "packages/changing", label: "Changing" }]);
      const source = await manager.add({ kind: "local", path: market }, 0n);
      expect(source).toMatchObject({ declaredEntryCount: 1, skippedEntryCount: 1, unreadableEntryCount: 0, entries: [] });
    } finally {
      store.close();
    }
  });

  it("never treats source-control metadata as an Extension package", async () => {
    const { root, store, manager } = await fixture("metadata-package");
    try {
      const market = join(root, "catalog");
      await writeMarket(market, "metadata-catalog", [{ path: ".git/catalog-package", label: "Metadata" }]);
      const source = await manager.add({ kind: "local", path: market }, 0n);
      expect(source).toMatchObject({ declaredEntryCount: 1, skippedEntryCount: 1, unreadableEntryCount: 0, entries: [] });
    } finally {
      store.close();
    }
  });

  it("rolls the current pointer back when durable refresh publication fails", async () => {
    let clone = 0;
    const git: ExtensionSourceGitExecutor = async (args) => {
      if (args[0] === "--version") return { stdout: "git version 2.43.0\n", stderr: "" };
      if (args[0] === "clone") {
        clone += 1;
        await writeMarket(String(args.at(-1)), "git-catalog", [{ path: "packages/review", label: clone === 1 ? "Before" : "After" }]);
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse") return { stdout: `${(clone === 1 ? "a" : "b").repeat(40)}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const { store, manager } = await fixture("rollback", git);
    try {
      const source = await manager.add({ kind: "git", repositoryUrl: "https://example.test/extensions.git", sparsePaths: [] }, 0n);
      const before = source.entries[0]!;
      vi.spyOn(store, "setSetting").mockImplementationOnce(() => { throw new Error("disk full"); });
      await expect(manager.refresh(source.id, source.revision)).rejects.toThrow("disk full");
      expect(manager.snapshot()).toMatchObject({ revision: 1n, sources: [{ revision: 1n, entries: [{ id: before.id }] }] });
      await expect(manager.withEntry({ sourceId: source.id, sourceRevision: 1n, entryId: before.id, contentRevision: before.contentRevision },
        async (_entry, packageRoot) => readFile(join(packageRoot, "package.json"), "utf8"))).resolves.toContain("Before");
    } finally {
      store.close();
    }
  });

  it("removes source visibility before lease-delayed Git cache cleanup, revokes exact leases, and never deletes local directories", async () => {
    const git: ExtensionSourceGitExecutor = async (args) => {
      if (args[0] === "--version") return { stdout: "git version 2.43.0\n", stderr: "" };
      if (args[0] === "clone") {
        await writeMarket(String(args.at(-1)), "git-catalog", [{ path: "packages/review", label: "Review" }]);
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse") return { stdout: `${"c".repeat(40)}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const { root, store, manager } = await fixture("remove", git);
    try {
      const localRoot = join(root, "local");
      await writeMarket(localRoot, "local-catalog", [{ path: "packages/local", label: "Local" }]);
      const local = await manager.add({ kind: "local", path: localRoot }, 0n);
      const source = await manager.add({ kind: "git", repositoryUrl: "https://example.test/extensions.git", sparsePaths: [] }, 1n);
      const lease = await manager.acquireEntry({
        sourceId: source.id,
        sourceRevision: source.revision,
        entryId: source.entries[0]!.id,
        contentRevision: source.entries[0]!.contentRevision
      });
      const leasedRoot = lease.packageRoot;
      await expect(readFile(join(leasedRoot, "package.json"), "utf8")).resolves.toContain("Review");
      await manager.remove(source.id, source.revision);
      expect(manager.snapshot().sources.map((item) => item.id)).toEqual([local.id]);
      expect(existsSync(leasedRoot)).toBe(true);
      expect(() => lease.assertCurrent()).toThrow(/not found|changed/iu);
      lease.release();
      lease.release();
      await waitFor(() => !existsSync(leasedRoot));
      await manager.remove(local.id, local.revision);
      expect(existsSync(localRoot)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("resets an unknown durable source shape instead of reading compatibility data", async () => {
    const root = await makeRoot("corruption");
    const store = new OperationalStore(join(root, "orchestrator.db"));
    store.setSetting("service", "orchestrator", "extension_sources", { format: 0, sources: [{ token: "must-not-survive" }] });
    const manager = new ExtensionSourceManager({ store, cacheRoot: join(root, "cache") });
    await manager.initialize();
    expect(manager.snapshot()).toEqual({ revision: 0n, sources: [], recoveredFromCorruption: true });
    const restarted = new ExtensionSourceManager({ store, cacheRoot: join(root, "cache") });
    await restarted.initialize();
    expect(restarted.snapshot().recoveredFromCorruption).toBe(false);
    store.close();
  });

  it("fails closed at restart when one saved current generation is unavailable", async () => {
    const git: ExtensionSourceGitExecutor = async (args) => {
      if (args[0] === "--version") return { stdout: "git version 2.43.0\n", stderr: "" };
      if (args[0] === "clone") {
        await writeMarket(String(args.at(-1)), "git-catalog", [{ path: "packages/review", label: "Review" }]);
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse") return { stdout: `${"d".repeat(40)}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const { root, store, manager } = await fixture("restart-pointer", git);
    try {
      const localRoot = join(root, "local");
      await writeMarket(localRoot, "local-catalog", [{ path: "packages/local", label: "Local" }]);
      await manager.add({ kind: "local", path: localRoot }, 0n);
      const source = await manager.add({ kind: "git", repositoryUrl: "https://example.test/extensions.git", sparsePaths: [] }, 1n);
      const slots = await readdir(join(root, "source-cache"));
      const slot = slots.find((name) => name.startsWith(`${source.id}-`));
      if (slot === undefined) throw new Error("Git source cache slot was not created.");
      await rm(join(root, "source-cache", slot, "current"));

      const restarted = new ExtensionSourceManager({ store, cacheRoot: join(root, "source-cache"), homeDirectory: root, now: () => NOW, git });
      await restarted.initialize();
      const snapshot = restarted.snapshot();
      expect(snapshot.revision).toBe(3n);
      expect(snapshot.sources.find((item) => item.name === "local-catalog")?.state).toBe("ready");
      const unavailable = snapshot.sources.find((item) => item.id === source.id);
      expect(unavailable).toMatchObject({ revision: 2n, state: "error", error: expect.stringContaining("cache is unavailable") });
      await expect(restarted.withEntry({
        sourceId: source.id,
        sourceRevision: unavailable!.revision,
        entryId: source.entries[0]!.id,
        contentRevision: source.entries[0]!.contentRevision
      }, async () => undefined)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    } finally {
      store.close();
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("Timed out waiting for filesystem state.");
}
