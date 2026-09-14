import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrowserContext, Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";

import { workspaceHtmlPreviewUrl } from "./html-preview.js";
import {
  BrowserProvider,
  BrowserTargetModeConflictError,
  type BrowserProviderOptions
} from "./provider.js";

class TargetPage extends EventEmitter {
  readonly contextOwner: TargetContext;
  focusCount = 0;
  routeCount = 0;
  readonly #focusError: Error | undefined;
  #url = "about:blank";
  #closed = false;

  constructor(contextOwner: TargetContext, focusError?: Error) {
    super();
    this.contextOwner = contextOwner;
    this.#focusError = focusError;
  }

  url(): string { return this.#url; }
  async title(): Promise<string> { return ""; }
  isClosed(): boolean { return this.#closed; }
  context(): BrowserContext { return this.contextOwner as unknown as BrowserContext; }
  mainFrame(): object { return this; }
  async bringToFront(): Promise<void> {
    this.focusCount += 1;
    if (this.#focusError !== undefined) throw this.#focusError;
  }
  async route(): Promise<void> { this.routeCount += 1; }
  async routeWebSocket(): Promise<void> { /* Network socket behavior is owned by html-preview tests. */ }

  async goto(url: string): Promise<null> {
    this.#url = url;
    this.emit("framenavigated", this);
    this.emit("domcontentloaded");
    return null;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("close");
  }
}

class TargetContext extends EventEmitter {
  readonly allPages: TargetPage[];
  newPageCount = 0;
  closed = false;
  readonly #browserOwner: TargetBrowser;
  readonly #newPageFocusError: Error | undefined;

  constructor(initialPageCount: number, browserOwner: TargetBrowser, newPageFocusError?: Error) {
    super();
    this.#browserOwner = browserOwner;
    this.#newPageFocusError = newPageFocusError;
    this.allPages = Array.from({ length: initialPageCount }, () => new TargetPage(this));
  }

  pages(): Page[] {
    return this.allPages.filter((page) => !page.isClosed()) as unknown as Page[];
  }

  async newPage(): Promise<Page> {
    this.newPageCount += 1;
    const page = new TargetPage(this, this.#newPageFocusError);
    this.allPages.push(page);
    this.emit("page", page as unknown as Page);
    return page as unknown as Page;
  }

  browser(): TargetBrowser { return this.#browserOwner; }

  async newCDPSession(): Promise<{
    send(): Promise<{ readonly currentIndex: number; readonly entries: readonly object[] }>;
    detach(): Promise<void>;
  }> {
    return {
      send: async () => ({ currentIndex: 0, entries: [{}] }),
      detach: async () => undefined
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(this.allPages.map((page) => page.close()));
    this.emit("close");
  }
}

class TargetBrowser {
  readonly temporaryContexts: TargetContext[] = [];
  readonly temporaryContextOptions: unknown[] = [];
  readonly #temporaryPageFocusError: Error | undefined;

  constructor(temporaryPageFocusError?: Error) {
    this.#temporaryPageFocusError = temporaryPageFocusError;
  }

  async newContext(options: unknown): Promise<BrowserContext> {
    this.temporaryContextOptions.push(options);
    const context = new TargetContext(0, this, this.#temporaryPageFocusError);
    this.temporaryContexts.push(context);
    return context as unknown as BrowserContext;
  }
}

interface TargetFixture {
  readonly provider: BrowserProvider;
  readonly root: string;
  readonly launches: Array<{ readonly profileDirectory: string; readonly headless: boolean }>;
  readonly contexts: TargetContext[];
  readonly browser: TargetBrowser;
  cleanup(): Promise<void>;
}

async function targetFixture(input: {
  readonly initialPageCount?: number;
  readonly targetMode: "sidebar" | "external";
  readonly profileDisplayName?: string;
  readonly temporaryPageFocusError?: Error;
  readonly onActivity?: NonNullable<BrowserProviderOptions["onActivity"]>;
}): Promise<TargetFixture> {
  const root = await mkdtemp(join(tmpdir(), "joko-browser-target-"));
  const launches: Array<{ readonly profileDirectory: string; readonly headless: boolean }> = [];
  const contexts: TargetContext[] = [];
  const browser = new TargetBrowser(input.temporaryPageFocusError);
  const provider = new BrowserProvider({
    providerId: "browser-target-test",
    executablePath: "unused-by-target-test",
    profileDirectories: {
      sidebar: join(root, "profiles", "sidebar"),
      external: join(root, "profiles", "external")
    },
    targetMode: input.targetMode,
    ...(input.profileDisplayName === undefined ? {} : { profileDisplayName: input.profileDisplayName }),
    ...(input.onActivity === undefined ? {} : { onActivity: input.onActivity }),
    downloadDirectory: join(root, "downloads"),
    uploadRoots: [root],
    launchPersistentContext: async (profileDirectory, options) => {
      launches.push({ profileDirectory, headless: options.headless ?? false });
      const context = new TargetContext(input.initialPageCount ?? 1, browser);
      contexts.push(context);
      return context as unknown as BrowserContext;
    }
  });
  return {
    provider,
    root,
    launches,
    contexts,
    browser,
    cleanup: async () => {
      await provider.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  };
}

describe("BrowserProvider target modes", () => {
  it("uses an explicit external headed target and focuses the first tab without duplication", async () => {
    const value = await targetFixture({ targetMode: "external" });
    try {
      expect(value.provider.targetMode).toBe("external");
      const firstResult = await value.provider.showExternalWindow();
      const secondResult = await value.provider.showExternalWindow();

      expect(value.launches).toEqual([{
        profileDirectory: join(value.root, "profiles", "external"),
        headless: false
      }]);
      expect(firstResult).toBeUndefined();
      expect(secondResult).toBeUndefined();
      expect(value.contexts[0]?.newPageCount).toBe(0);
      expect(value.contexts[0]?.allPages[0]?.focusCount).toBe(2);
    } finally {
      await value.cleanup();
    }
  });

  it("creates one blank tab only when the external context has no tabs", async () => {
    const value = await targetFixture({ initialPageCount: 0, targetMode: "external" });
    try {
      await value.provider.showExternalWindow();
      await value.provider.showExternalWindow();
      expect(value.contexts[0]?.newPageCount).toBe(1);
      expect(value.contexts[0]?.allPages).toHaveLength(1);
      expect(value.contexts[0]?.allPages[0]?.url()).toBe("about:blank");
      expect(value.contexts[0]?.allPages[0]?.focusCount).toBe(2);
    } finally {
      await value.cleanup();
    }
  });

  it("opens external HTML in a focused temporary isolated context owned by that page", async () => {
    const value = await targetFixture({ targetMode: "external" });
    const assertCurrent = vi.fn();
    const dispose = vi.fn();
    try {
      await value.provider.start();
      const originalPage = (await value.provider.listPages())[0]!;
      const originalTakeover = await value.provider.beginHumanTakeover({
        providerId: value.provider.id,
        pageId: originalPage.id,
        generation: value.provider.generation,
        owner: "workspace-html-owner"
      });
      const url = workspaceHtmlPreviewUrl("workspace-html-external", "reports/result.html");
      const takeover = await value.provider.openHumanPage({
        providerId: value.provider.id,
        generation: value.provider.generation,
        owner: "workspace-html-owner",
        url
      }, 60_000, { html: "<!doctype html><title>Result</title>", assertCurrent, dispose });

      expect(value.launches).toEqual([{
        profileDirectory: join(value.root, "profiles", "external"),
        headless: false
      }]);
      expect(value.browser.temporaryContextOptions).toEqual([{
        acceptDownloads: false,
        serviceWorkers: "block"
      }]);
      expect(value.contexts[0]?.allPages).toHaveLength(1);
      expect(value.browser.temporaryContexts).toHaveLength(1);
      const isolated = value.browser.temporaryContexts[0]!;
      const page = isolated.allPages[0]!;
      expect(takeover.pageId).toMatch(/^page-/u);
      expect(page.url()).toBe(url);
      expect(page.routeCount).toBe(1);
      expect(page.focusCount).toBe(1);
      expect(assertCurrent).toHaveBeenCalled();
      expect(dispose).not.toHaveBeenCalled();

      const restored = await value.provider.compensateHumanPageOpen(takeover, {
        pageId: originalTakeover.pageId,
        assertCurrent: () => undefined
      }, 60_000);
      expect(isolated.closed).toBe(true);
      expect(page.isClosed()).toBe(true);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(restored).toMatchObject({ pageId: originalTakeover.pageId, owner: originalTakeover.owner });
      expect(restored?.takeoverId).not.toBe(originalTakeover.takeoverId);
      expect(value.provider.currentHumanTakeover()).toEqual(restored);
      expect(value.contexts[0]?.allPages[0]?.focusCount).toBe(2);
    } finally {
      await value.cleanup();
    }
  });

  it("closes an uncommitted HTML page without restoring a retired previous-page authority", async () => {
    const value = await targetFixture({ targetMode: "external" });
    const dispose = vi.fn();
    const assertPreviousCurrent = vi.fn(() => { throw new Error("retired owner"); });
    try {
      await value.provider.start();
      const originalPage = (await value.provider.listPages())[0]!;
      const originalTakeover = await value.provider.beginHumanTakeover({
        providerId: value.provider.id,
        pageId: originalPage.id,
        generation: value.provider.generation,
        owner: "workspace-html-owner"
      });
      const takeover = await value.provider.openHumanPage({
        providerId: value.provider.id,
        generation: value.provider.generation,
        owner: "workspace-html-owner",
        url: workspaceHtmlPreviewUrl("workspace-html-retired", "result.html")
      }, 60_000, { html: "<!doctype html><title>Retired</title>", assertCurrent: () => undefined, dispose });
      const isolated = value.browser.temporaryContexts[0]!;
      const openedPage = isolated.allPages[0]!;

      await expect(value.provider.compensateHumanPageOpen(takeover, {
        pageId: originalTakeover.pageId,
        assertCurrent: assertPreviousCurrent
      }, 60_000)).resolves.toBeUndefined();

      expect(assertPreviousCurrent).toHaveBeenCalledOnce();
      expect(openedPage.isClosed()).toBe(true);
      expect(isolated.closed).toBe(true);
      expect(dispose).toHaveBeenCalledOnce();
      expect(value.contexts[0]?.allPages[0]?.isClosed()).toBe(false);
      expect(value.provider.currentHumanTakeover()).toBeUndefined();
    } finally {
      await value.cleanup();
    }
  });

  it("closes an uncommitted HTML page after its exact takeover was already released", async () => {
    const value = await targetFixture({ targetMode: "external" });
    const dispose = vi.fn();
    const assertPreviousCurrent = vi.fn();
    try {
      await value.provider.start();
      const originalPage = (await value.provider.listPages())[0]!;
      const originalTakeover = await value.provider.beginHumanTakeover({
        providerId: value.provider.id,
        pageId: originalPage.id,
        generation: value.provider.generation,
        owner: "workspace-html-owner"
      });
      const takeover = await value.provider.openHumanPage({
        providerId: value.provider.id,
        generation: value.provider.generation,
        owner: "workspace-html-owner",
        url: workspaceHtmlPreviewUrl("workspace-html-released", "result.html")
      }, 60_000, { html: "<!doctype html><title>Released</title>", assertCurrent: () => undefined, dispose });
      const isolated = value.browser.temporaryContexts[0]!;
      const openedPage = isolated.allPages[0]!;

      await value.provider.endHumanTakeover(takeover);
      await expect(value.provider.compensateHumanPageOpen(takeover, {
        pageId: originalTakeover.pageId,
        assertCurrent: assertPreviousCurrent
      }, 60_000)).resolves.toBeUndefined();

      expect(assertPreviousCurrent).not.toHaveBeenCalled();
      expect(openedPage.isClosed()).toBe(true);
      expect(isolated.closed).toBe(true);
      expect(dispose).toHaveBeenCalledOnce();
      expect(value.contexts[0]?.allPages[0]?.isClosed()).toBe(false);
      expect(value.provider.currentHumanTakeover()).toBeUndefined();
    } finally {
      await value.cleanup();
    }
  });

  it("closes every current and non-current HTML page owned by a released Connection", async () => {
    const value = await targetFixture({ targetMode: "external" });
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    try {
      await value.provider.start();
      const originalPage = (await value.provider.listPages())[0]!;
      await value.provider.beginHumanTakeover({
        providerId: value.provider.id,
        pageId: originalPage.id,
        generation: value.provider.generation,
        owner: "workspace-html-owner"
      });
      const first = await value.provider.openHumanPage({
        providerId: value.provider.id,
        generation: value.provider.generation,
        owner: "workspace-html-owner",
        url: workspaceHtmlPreviewUrl("workspace-html-first", "first.html")
      }, 60_000, { html: "<!doctype html><title>First</title>", assertCurrent: () => undefined, dispose: firstDispose });
      const second = await value.provider.openHumanPage({
        providerId: value.provider.id,
        generation: value.provider.generation,
        owner: "workspace-html-owner",
        url: workspaceHtmlPreviewUrl("workspace-html-second", "second.html")
      }, 60_000, { html: "<!doctype html><title>Second</title>", assertCurrent: () => undefined, dispose: secondDispose });

      await expect(value.provider.closeHtmlPagesOwnedBy("workspace-html-owner")).resolves.toEqual({
        retiredPages: [
          { pageId: first.pageId, generation: first.generation },
          { pageId: second.pageId, generation: second.generation }
        ],
        complete: true
      });

      expect(value.browser.temporaryContexts).toHaveLength(2);
      expect(value.browser.temporaryContexts.every((context) => context.closed)).toBe(true);
      expect(value.browser.temporaryContexts.flatMap((context) => context.allPages).every((page) => page.isClosed())).toBe(true);
      expect(firstDispose).toHaveBeenCalledOnce();
      expect(secondDispose).toHaveBeenCalledOnce();
      expect(value.contexts[0]?.allPages[0]?.isClosed()).toBe(false);
      expect(value.provider.currentHumanTakeover()).toBeUndefined();
    } finally {
      await value.cleanup();
    }
  });

  it("keeps the exact previous takeover when the new external HTML page cannot be focused", async () => {
    const value = await targetFixture({ targetMode: "external", temporaryPageFocusError: new Error("focus failed") });
    const dispose = vi.fn();
    try {
      await value.provider.start();
      const originalPage = (await value.provider.listPages())[0]!;
      const originalTakeover = await value.provider.beginHumanTakeover({
        providerId: value.provider.id,
        pageId: originalPage.id,
        generation: value.provider.generation,
        owner: "workspace-html-owner"
      });

      await expect(value.provider.openHumanPage({
        providerId: value.provider.id,
        generation: value.provider.generation,
        owner: "workspace-html-owner",
        url: workspaceHtmlPreviewUrl("workspace-html-focus-failure", "result.html")
      }, 60_000, { html: "<!doctype html><title>Focus</title>", assertCurrent: () => undefined, dispose }))
        .rejects.toThrow("focus failed");

      expect(value.provider.currentHumanTakeover()).toEqual(originalTakeover);
      expect(value.contexts[0]?.allPages[0]?.isClosed()).toBe(false);
      expect(value.browser.temporaryContexts[0]?.closed).toBe(true);
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      await value.cleanup();
    }
  });

  it("rolls back to the exact previous takeover when activity persistence fails after transfer", async () => {
    let failTransferActivity = false;
    const onActivity = vi.fn(async (activity: { readonly type: string; readonly detail: string }) => {
      if (failTransferActivity && activity.type === "takeover" && activity.detail.endsWith(" ended.")) {
        failTransferActivity = false;
        throw new Error("activity persistence failed");
      }
    });
    const value = await targetFixture({ targetMode: "external", onActivity });
    const dispose = vi.fn();
    try {
      await value.provider.start();
      const originalPage = (await value.provider.listPages())[0]!;
      const originalTakeover = await value.provider.beginHumanTakeover({
        providerId: value.provider.id,
        pageId: originalPage.id,
        generation: value.provider.generation,
        owner: "workspace-html-owner"
      });
      failTransferActivity = true;

      await expect(value.provider.openHumanPage({
        providerId: value.provider.id,
        generation: value.provider.generation,
        owner: "workspace-html-owner",
        url: workspaceHtmlPreviewUrl("workspace-html-activity-failure", "result.html")
      }, 60_000, { html: "<!doctype html><title>Activity</title>", assertCurrent: () => undefined, dispose }))
        .rejects.toThrow("activity persistence failed");

      expect(value.provider.currentHumanTakeover()).toEqual(originalTakeover);
      expect(value.contexts[0]?.allPages[0]?.isClosed()).toBe(false);
      expect(value.contexts[0]?.allPages[0]?.focusCount).toBe(2);
      expect(value.browser.temporaryContexts[0]?.closed).toBe(true);
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      await value.cleanup();
    }
  });

  it("writes the Joko name into the managed external profile before launch and never decorates the sidebar profile", async () => {
    const value = await targetFixture({ targetMode: "external", profileDisplayName: "Joko" });
    try {
      await value.provider.start();
      const externalRoot = join(value.root, "profiles", "external");
      const localState = JSON.parse(await readFile(join(externalRoot, "Local State"), "utf8")) as {
        readonly profile: { readonly info_cache: { readonly Default: Readonly<Record<string, unknown>> } };
      };
      const preferences = JSON.parse(await readFile(join(externalRoot, "Default", "Preferences"), "utf8")) as {
        readonly profile: { readonly name: string };
      };
      expect(localState.profile.info_cache.Default).toMatchObject({ name: "Joko", shortcut_name: "Joko", user_name: "Joko" });
      expect(preferences.profile.name).toBe("Joko");

      await value.provider.stop();
      await value.provider.setTargetMode("sidebar");
      await value.provider.start();
      await expect(readFile(join(value.root, "profiles", "sidebar", "Local State"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await value.cleanup();
    }
  });

  it("does not launch or overwrite a malformed managed profile", async () => {
    const value = await targetFixture({ targetMode: "external", profileDisplayName: "Joko" });
    const localStatePath = join(value.root, "profiles", "external", "Local State");
    try {
      await mkdir(join(value.root, "profiles", "external"), { recursive: true });
      await writeFile(localStatePath, "not-json", "utf8");
      await expect(value.provider.start()).rejects.toThrow();
      expect(value.launches).toEqual([]);
      expect(await readFile(localStatePath, "utf8")).toBe("not-json");
    } finally {
      await value.cleanup();
    }
  });

  it("requires callers to stop before switching to the isolated sidebar profile", async () => {
    const value = await targetFixture({ targetMode: "external" });
    try {
      await value.provider.start();
      const lease = value.provider.acquireAgentLease("agent-owner");
      await expect(value.provider.setTargetMode("sidebar")).rejects.toThrow(/agent lease/u);
      await value.provider.releaseAgentLease(lease);

      const page = (await value.provider.listPages())[0]!;
      const takeover = await value.provider.beginHumanTakeover({
        providerId: value.provider.id,
        pageId: page.id,
        generation: value.provider.generation,
        owner: "human-owner"
      });
      await expect(value.provider.setTargetMode("sidebar")).rejects.toThrow(/human takeover/u);
      await value.provider.endHumanTakeover(takeover);
      await expect(value.provider.setTargetMode("sidebar")).rejects.toThrow(/Stop/u);

      await value.provider.stop();
      await value.provider.setTargetMode("sidebar");
      expect(value.provider.targetMode).toBe("sidebar");
      await value.provider.start();
      expect(value.launches.at(-1)).toEqual({
        profileDirectory: join(value.root, "profiles", "sidebar"),
        headless: true
      });
    } finally {
      await value.cleanup();
    }
  });

  it("rejects showing a machine-local window from the sidebar target without launching", async () => {
    const value = await targetFixture({ targetMode: "sidebar" });
    try {
      await expect(value.provider.showExternalWindow()).rejects.toBeInstanceOf(BrowserTargetModeConflictError);
      expect(value.provider.running).toBe(false);
      expect(value.launches).toEqual([]);
    } finally {
      await value.cleanup();
    }
  });

  it("rejects overlapping profile configurations", () => {
    const common = {
      executablePath: "unused-by-target-test",
      targetMode: "external" as const,
      downloadDirectory: "downloads",
      uploadRoots: []
    } satisfies Omit<BrowserProviderOptions, "profileDirectories">;
    expect(() => new BrowserProvider({
      ...common,
      profileDirectories: { sidebar: "same-profile", external: "same-profile" }
    })).toThrow(/non-overlapping/u);
  });

  it("rejects a missing runtime target instead of defaulting to external", () => {
    expect(() => new BrowserProvider({
      executablePath: "unused-by-target-test",
      profileDirectories: { sidebar: "sidebar-profile", external: "external-profile" },
      targetMode: undefined as never,
      downloadDirectory: "downloads",
      uploadRoots: []
    })).toThrow(/target mode is invalid/u);
  });
});
