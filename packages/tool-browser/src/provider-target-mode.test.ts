import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrowserContext, Page } from "playwright-core";
import { describe, expect, it } from "vitest";

import {
  BrowserProvider,
  BrowserTargetModeConflictError,
  type BrowserProviderOptions
} from "./provider.js";

class TargetPage extends EventEmitter {
  readonly contextOwner: TargetContext;
  focusCount = 0;
  #closed = false;

  constructor(contextOwner: TargetContext) {
    super();
    this.contextOwner = contextOwner;
  }

  url(): string { return "about:blank"; }
  async title(): Promise<string> { return ""; }
  isClosed(): boolean { return this.#closed; }
  context(): BrowserContext { return this.contextOwner as unknown as BrowserContext; }
  mainFrame(): object { return this; }
  async bringToFront(): Promise<void> { this.focusCount += 1; }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("close");
  }
}

class TargetContext extends EventEmitter {
  readonly allPages: TargetPage[];
  newPageCount = 0;

  constructor(initialPageCount: number) {
    super();
    this.allPages = Array.from({ length: initialPageCount }, () => new TargetPage(this));
  }

  pages(): Page[] {
    return this.allPages.filter((page) => !page.isClosed()) as unknown as Page[];
  }

  async newPage(): Promise<Page> {
    this.newPageCount += 1;
    const page = new TargetPage(this);
    this.allPages.push(page);
    this.emit("page", page as unknown as Page);
    return page as unknown as Page;
  }

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
    await Promise.all(this.allPages.map((page) => page.close()));
  }
}

interface TargetFixture {
  readonly provider: BrowserProvider;
  readonly root: string;
  readonly launches: Array<{ readonly profileDirectory: string; readonly headless: boolean }>;
  readonly contexts: TargetContext[];
  cleanup(): Promise<void>;
}

async function targetFixture(input: {
  readonly initialPageCount?: number;
  readonly targetMode?: "sidebar" | "external";
  readonly profileDisplayName?: string;
} = {}): Promise<TargetFixture> {
  const root = await mkdtemp(join(tmpdir(), "joko-browser-target-"));
  const launches: Array<{ readonly profileDirectory: string; readonly headless: boolean }> = [];
  const contexts: TargetContext[] = [];
  const provider = new BrowserProvider({
    providerId: "browser-target-test",
    executablePath: "unused-by-target-test",
    profileDirectories: {
      sidebar: join(root, "profiles", "sidebar"),
      external: join(root, "profiles", "external")
    },
    ...(input.targetMode === undefined ? {} : { targetMode: input.targetMode }),
    ...(input.profileDisplayName === undefined ? {} : { profileDisplayName: input.profileDisplayName }),
    downloadDirectory: join(root, "downloads"),
    uploadRoots: [root],
    launchPersistentContext: async (profileDirectory, options) => {
      launches.push({ profileDirectory, headless: options.headless ?? false });
      const context = new TargetContext(input.initialPageCount ?? 1);
      contexts.push(context);
      return context as unknown as BrowserContext;
    }
  });
  return {
    provider,
    root,
    launches,
    contexts,
    cleanup: async () => {
      await provider.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  };
}

describe("BrowserProvider target modes", () => {
  it("defaults dual-profile Providers to an external headed target and focuses the first tab without duplication", async () => {
    const value = await targetFixture();
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
    const value = await targetFixture({ initialPageCount: 0 });
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

  it("writes the Joko name into the managed external profile before launch and never decorates the sidebar profile", async () => {
    const value = await targetFixture({ profileDisplayName: "Joko" });
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
    const value = await targetFixture({ profileDisplayName: "Joko" });
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
    const value = await targetFixture();
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
      downloadDirectory: "downloads",
      uploadRoots: []
    } satisfies Omit<BrowserProviderOptions, "profileDirectories">;
    expect(() => new BrowserProvider({
      ...common,
      profileDirectories: { sidebar: "same-profile", external: "same-profile" }
    })).toThrow(/non-overlapping/u);
  });
});
