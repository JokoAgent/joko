import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import { BrowserLeaseConflictError } from "./leases.js";
import { BrowserProvider } from "./provider.js";
import {
  BrowserTakeoverConflictError,
  BrowserTakeoverInputError,
  BrowserTakeoverRateLimitError,
  type BrowserTakeoverFence
} from "./takeovers.js";

type RecordedHumanInput =
  | { readonly type: "click"; readonly x: number; readonly y: number; readonly button: string; readonly clickCount: number }
  | { readonly type: "move"; readonly x: number; readonly y: number; readonly steps?: number }
  | { readonly type: "down" | "up"; readonly button: string }
  | { readonly type: "scroll"; readonly deltaX: number; readonly deltaY: number }
  | { readonly type: "key"; readonly key: string }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "navigation"; readonly command: "back" | "forward" | "reload" | "stop" };

class FakeLocator {
  async click(): Promise<void> {}
  async fill(_value: string): Promise<void> {}
  async press(_value: string): Promise<void> {}
  async selectOption(_value: string): Promise<void> {}
  async setInputFiles(_paths: readonly string[]): Promise<void> {}
  async ariaSnapshot(): Promise<string> { return "- document"; }
}

class FakePage extends EventEmitter {
  #url: string;
  #closed = false;
  readonly #mainFrame = {};
  readonly #simulateCommentDocument: boolean;
  #commentElementId: string | undefined;
  readonly #commentInlineStyles = new Map<string, { value: string; priority: string }>();
  #commentText = "Save";
  readonly #humanInputs: RecordedHumanInput[];
  readonly #screenshotFullPageValues: boolean[];

  readonly mouse = {
    click: async (x: number, y: number, options: { readonly button?: string; readonly clickCount?: number } = {}): Promise<void> => {
      this.#humanInputs.push({ type: "click", x, y, button: options.button ?? "left", clickCount: options.clickCount ?? 1 });
    },
    move: async (x: number, y: number, options: { readonly steps?: number } = {}): Promise<void> => {
      this.#humanInputs.push({ type: "move", x, y, ...(options.steps === undefined ? {} : { steps: options.steps }) });
    },
    down: async (options: { readonly button?: string } = {}): Promise<void> => {
      this.#humanInputs.push({ type: "down", button: options.button ?? "left" });
    },
    up: async (options: { readonly button?: string } = {}): Promise<void> => {
      this.#humanInputs.push({ type: "up", button: options.button ?? "left" });
    },
    wheel: async (deltaX: number, deltaY: number): Promise<void> => {
      this.#humanInputs.push({ type: "scroll", deltaX, deltaY });
    }
  };

  readonly keyboard = {
    press: async (key: string): Promise<void> => { this.#humanInputs.push({ type: "key", key }); },
    insertText: async (text: string): Promise<void> => { this.#humanInputs.push({ type: "text", text }); }
  };

  constructor(
    url = "https://example.test/",
    humanInputs: RecordedHumanInput[] = [],
    screenshotFullPageValues: boolean[] = [],
    simulateCommentDocument = false
  ) {
    super();
    this.#url = url;
    this.#humanInputs = humanInputs;
    this.#screenshotFullPageValues = screenshotFullPageValues;
    this.#simulateCommentDocument = simulateCommentDocument;
  }

  url(): string { return this.#url; }
  async title(): Promise<string> { return "Test page"; }
  isClosed(): boolean { return this.#closed; }
  locator(_selector: string): FakeLocator { return new FakeLocator(); }
  async bringToFront(): Promise<void> {}
  async screenshot(options: { readonly fullPage?: boolean } = {}): Promise<Buffer> {
    this.#screenshotFullPageValues.push(options.fullPage ?? false);
    return Buffer.from("png");
  }
  viewportSize(): { width: number; height: number } { return { width: 1_001, height: 501 }; }
  mainFrame(): object { return this.#mainFrame; }
  navigateWithinDocument(): void { this.emit("framenavigated", this.#mainFrame); }
  commentInlineStyle(property: string): string { return this.#commentInlineStyles.get(property)?.value ?? ""; }
  async goBack(): Promise<null> {
    this.#humanInputs.push({ type: "navigation", command: "back" });
    return null;
  }
  async goForward(): Promise<null> {
    this.#humanInputs.push({ type: "navigation", command: "forward" });
    return null;
  }
  async reload(): Promise<null> {
    this.#humanInputs.push({ type: "navigation", command: "reload" });
    this.emit("domcontentloaded");
    return null;
  }

  async evaluate(expression: unknown, argument?: unknown): Promise<unknown> {
    if (typeof expression === "string") {
      this.#humanInputs.push({ type: "navigation", command: "stop" });
      return undefined;
    }
    if (!this.#simulateCommentDocument || argument === null || typeof argument !== "object") {
      if (this.#simulateCommentDocument && argument === undefined && String(expression).includes("scrollX")) {
        return { scrollX: 350, scrollY: 450, viewport: { width: 1_000, height: 500 } };
      }
      return undefined;
    }
    const value = argument as Record<string, unknown>;
    if ("ids" in value && Array.isArray(value.ids)) return value.ids;
    if ("elementId" in value && value.originals !== null && typeof value.originals === "object") {
      for (const [property, original] of Object.entries(value.originals as Record<string, { value: string; priority: string }>)) {
        this.#commentInlineStyles.set(property, { value: original.value, priority: original.priority });
      }
      if (value.hasText === true) this.#commentText = typeof value.originalText === "string" ? value.originalText : "";
      if (value.preview !== null && typeof value.preview === "object") {
        const preview = value.preview as { styles?: Record<string, string>; text?: string };
        for (const [property, style] of Object.entries(preview.styles ?? {})) {
          this.#commentInlineStyles.set(property, { value: style, priority: "important" });
        }
        if (Object.prototype.hasOwnProperty.call(preview, "text")) this.#commentText = preview.text ?? "";
      }
      return true;
    }
    if (!("request" in value) || value.request === null || typeof value.request !== "object") return undefined;
    const request = value.request as Record<string, unknown>;
    const viewport = { width: 1_000, height: 500 };
    const documentScroll = { x: 200, y: 300 };
    if (request.intent === "region") {
      const point = request.normalizedPoint as { x: number; y: number };
      const region = request.normalizedRegion as { x: number; y: number; width: number; height: number };
      return {
        documentScroll,
        target: {
          kind: "region",
          point: { x: point.x * viewport.width, y: point.y * viewport.height },
          viewport,
          region: {
            x: region.x * viewport.width,
            y: region.y * viewport.height,
            width: region.width * viewport.width,
            height: region.height * viewport.height
          },
          themeVariant: "light"
        }
      };
    }
    if (request.intent === "existingText") {
      return {
        documentScroll,
        target: {
          kind: "text",
          point: { x: 904, y: 250 },
          viewport,
          selectedText: "Selected page text",
          textRegions: [{ x: 700, y: 220, width: 200, height: 60 }],
          targetTag: "p",
          themeVariant: "dark"
        }
      };
    }
    const properties = ["color", "background-color", "font-size", "font-weight", "padding", "border-radius"];
    const knownIds = Array.isArray(value.knownIds) ? value.knownIds : [];
    this.#commentElementId = typeof knownIds[0] === "string"
      ? knownIds[0]
      : typeof value.elementId === "string" ? value.elementId : this.#commentElementId;
    return {
      documentScroll,
      target: {
        kind: "element",
        point: { x: 500, y: 250 },
        viewport,
        targetTag: "button",
        targetLabel: "Save",
        targetRole: "button",
        themeVariant: "light",
        designBaseline: {
          styles: Object.fromEntries(properties.map((property) => [property, this.#commentInlineStyles.get(property)?.value || "initial"])),
          editableText: this.#commentText,
          provenance: {}
        }
      },
      privateElement: {
        elementId: this.#commentElementId,
        originalStyles: Object.fromEntries(properties.map((property) => [property, this.#commentInlineStyles.get(property) ?? { value: "", priority: "" }])),
        originalText: this.#commentText
      }
    };
  }

  async goto(url: string): Promise<null> {
    this.#humanInputs.push({ type: "navigate", url });
    this.#url = url;
    this.emit("domcontentloaded");
    return null;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("close");
  }
}

class FakeContext extends EventEmitter {
  readonly #pages: FakePage[];
  readonly #humanInputs: RecordedHumanInput[];
  readonly #screenshotFullPageValues: boolean[];
  readonly #simulateCommentDocument: boolean;

  constructor(
    humanInputs: RecordedHumanInput[],
    screenshotFullPageValues: boolean[],
    urls: readonly string[] = ["https://example.test/"],
    simulateCommentDocument = false
  ) {
    super();
    this.#humanInputs = humanInputs;
    this.#screenshotFullPageValues = screenshotFullPageValues;
    this.#simulateCommentDocument = simulateCommentDocument;
    this.#pages = urls.map((url) => new FakePage(url, humanInputs, screenshotFullPageValues, simulateCommentDocument));
  }

  firstPage(): FakePage { return this.#pages[0]!; }

  pages(): Page[] {
    return this.#pages.filter((page) => !page.isClosed()) as unknown as Page[];
  }

  async newPage(): Promise<Page> {
    const page = new FakePage("about:blank", this.#humanInputs, this.#screenshotFullPageValues, this.#simulateCommentDocument);
    this.#pages.push(page);
    this.emit("page", page as unknown as Page);
    return page as unknown as Page;
  }

  async close(): Promise<void> {
    await Promise.all(this.#pages.map((page) => page.close()));
  }
}

interface ProviderFixture {
  readonly provider: BrowserProvider;
  readonly root: string;
  readonly launchHeadlessValues: boolean[];
  readonly humanInputs: RecordedHumanInput[];
  readonly screenshotFullPageValues: boolean[];
  readonly fakePage: FakePage;
  cleanup(): Promise<void>;
}

async function fixture(headless = false, now: () => number = Date.now, initialGeneration = 0, simulateCommentDocument = false): Promise<ProviderFixture> {
  const root = await mkdtemp(join(tmpdir(), "joko-browser-takeover-"));
  const launchHeadlessValues: boolean[] = [];
  const humanInputs: RecordedHumanInput[] = [];
  const screenshotFullPageValues: boolean[] = [];
  let context: FakeContext | undefined;
  const provider = new BrowserProvider({
    providerId: "provider-a",
    initialGeneration,
    executablePath: "unused-by-fake-launcher",
    profileDirectories: {
      sidebar: join(root, "profile-sidebar"),
      external: join(root, "profile-external")
    },
    targetMode: headless ? "sidebar" : "external",
    downloadDirectory: join(root, "downloads"),
    uploadRoots: [root],
    now,
    launchPersistentContext: async (_profile, options) => {
      launchHeadlessValues.push(options.headless ?? false);
      context = new FakeContext(humanInputs, screenshotFullPageValues, ["https://example.test/"], simulateCommentDocument);
      return context as unknown as BrowserContext;
    }
  });
  await provider.start();
  if (context === undefined) throw new Error("Fake Browser context was not created.");
  return {
    provider,
    root,
    launchHeadlessValues,
    humanInputs,
    screenshotFullPageValues,
    fakePage: context.firstPage(),
    cleanup: async () => {
      await provider.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  };
}

async function begin(provider: BrowserProvider, owner = "connection-a") {
  const page = (await provider.listPages())[0];
  if (page === undefined) throw new Error("Fake provider did not expose a page.");
  return provider.beginHumanTakeover({
    providerId: provider.id,
    pageId: page.id,
    generation: provider.generation,
    owner
  }, 5_000);
}

describe("BrowserProvider human takeover fences", () => {
  it("keeps generation and page identities monotonic after a durable host restart seed", async () => {
    const value = await fixture(false, Date.now, 9);
    try {
      expect(value.provider.generation).toBe(10);
      expect((await value.provider.listPages())[0]?.id).toMatch(/^page-10-/u);
      await value.provider.recover();
      expect(value.provider.generation).toBe(11);
      expect((await value.provider.listPages())[0]?.id).toMatch(/^page-11-/u);
    } finally {
      await value.cleanup();
    }
  });

  it("rejects stale provider, page, generation, and owner at begin", async () => {
    const value = await fixture();
    try {
      const page = (await value.provider.listPages())[0]!;
      const request = {
        providerId: value.provider.id,
        pageId: page.id,
        generation: value.provider.generation,
        owner: "connection-a"
      };
      await expect(value.provider.beginHumanTakeover({ ...request, providerId: "provider-b" })).rejects
        .toThrow(BrowserTakeoverConflictError);
      await expect(value.provider.beginHumanTakeover({ ...request, pageId: "page-unknown" })).rejects.toThrow(/does not exist/u);
      await expect(value.provider.beginHumanTakeover({ ...request, generation: request.generation + 1 })).rejects
        .toThrow(BrowserTakeoverConflictError);
      expect(() => value.provider.beginHumanTakeover({ ...request, owner: " " })).toThrow(/owner/u);
    } finally {
      await value.cleanup();
    }
  });

  it("checks all five takeover fence components for operations and end", async () => {
    const value = await fixture();
    try {
      const takeover = await begin(value.provider);
      const mutations: readonly BrowserTakeoverFence[] = [
        { ...takeover, providerId: "provider-b" },
        { ...takeover, pageId: "page-b" },
        { ...takeover, generation: takeover.generation + 1 },
        { ...takeover, owner: "connection-b" },
        { ...takeover, takeoverId: "takeover-b" }
      ];
      for (const fence of mutations) {
        let invoked = false;
        await expect(value.provider.runHumanTakeoverOperation(fence, async () => {
          invoked = true;
        })).rejects.toThrow(BrowserTakeoverConflictError);
        expect(invoked).toBe(false);
        await expect(value.provider.endHumanTakeover(fence)).rejects.toThrow(BrowserTakeoverConflictError);
      }
      expect(value.provider.assertHumanTakeover(takeover)).toEqual(takeover);
      await expect(value.provider.runHumanTakeoverOperation(takeover, async (page) => page.url()))
        .resolves.toBe("https://example.test/");
      await value.provider.endHumanTakeover(takeover);
      expect(value.provider.currentHumanTakeover()).toBeUndefined();
    } finally {
      await value.cleanup();
    }
  });

  it("prevents takeover and agent control from overlapping", async () => {
    const value = await fixture();
    try {
      const agent = value.provider.acquireAgentLease("agent-a", 5_000);
      await expect(begin(value.provider)).rejects.toThrow(BrowserTakeoverConflictError);
      await value.provider.releaseAgentLease(agent);

      const takeover = await begin(value.provider);
      expect(() => value.provider.acquireAgentLease("agent-b", 5_000)).toThrow(BrowserLeaseConflictError);
      await value.provider.endHumanTakeover(takeover);
      expect(value.provider.acquireAgentLease("agent-b", 5_000).owner).toBe("agent-b");
    } finally {
      await value.cleanup();
    }
  });

  it("allows only one concurrent begin request", async () => {
    const value = await fixture();
    try {
      const page = (await value.provider.listPages())[0]!;
      const request = {
        providerId: value.provider.id,
        pageId: page.id,
        generation: value.provider.generation,
        owner: "connection-a"
      };
      const first = value.provider.beginHumanTakeover(request, 5_000);
      const second = value.provider.beginHumanTakeover(request, 5_000);
      const takeover = await first;
      await expect(second).rejects.toThrow(BrowserTakeoverConflictError);
      expect(value.provider.currentHumanTakeover()).toEqual(takeover);
    } finally {
      await value.cleanup();
    }
  });

  it("fences ephemeral page-comment inspection and bounds design preview input", async () => {
    const value = await fixture();
    try {
      const takeover = await begin(value.provider);
      await expect(value.provider.inspectHumanCommentTarget({ ...takeover, owner: "connection-b" }, {
        intent: "element",
        markerNumber: 1,
        normalizedX: 0.5,
        normalizedY: 0.5
      })).rejects.toThrow(BrowserTakeoverConflictError);
      await expect(value.provider.inspectHumanCommentTarget(takeover, { intent: "existingText", markerNumber: 1 })).resolves.toEqual({});
      await expect(value.provider.inspectHumanCommentTarget(takeover, {
        intent: "element",
        markerNumber: 1,
        normalizedX: 1.1,
        normalizedY: 0.5
      })).rejects.toThrow(/normalized coordinate/u);
      await expect(value.provider.inspectHumanCommentTarget(takeover, {
        intent: "existingText",
        markerNumber: 0
      })).rejects.toThrow(/marker number/u);
      await expect(value.provider.inspectHumanCommentTarget(takeover, {
        intent: "existingText",
        markerNumber: 0xffff_ffff
      })).resolves.toEqual({});
      await expect(value.provider.updateHumanCommentDesign(takeover, {
        action: "apply",
        targetToken: "target-1",
        styles: { position: "fixed" } as never
      })).rejects.toThrow(/property/u);
      await expect(value.provider.updateHumanCommentDesign(takeover, {
        action: "reconcile",
        validMarkerNumbers: null as never
      })).rejects.toThrow(/whitelist/u);
    } finally {
      await value.cleanup();
    }
  });

  it("keeps every target kind in one ephemeral document ledger and returns authoritative scrolled placements", async () => {
    const value = await fixture(false, Date.now, 0, true);
    try {
      const takeover = await begin(value.provider);
      const region = await value.provider.inspectHumanCommentTarget(takeover, {
        intent: "region",
        markerNumber: 1,
        normalizedPoint: { x: 0.1, y: 0.2 },
        normalizedRegion: { x: 0.2, y: 0.4, width: 0.3, height: 0.2 }
      });
      expect(region.targetToken).toMatch(/^[\da-f-]{36}$/u);
      await expect(value.provider.updateHumanCommentDesign(takeover, {
        action: "apply",
        targetToken: region.targetToken!,
        styles: { color: "#fff" }
      })).rejects.toThrow(/design baseline/u);
      await expect(value.provider.inspectHumanCommentTarget(takeover, {
        intent: "existingText",
        markerNumber: 2
      })).rejects.toThrow(/pending/u);

      await expect(value.provider.updateHumanCommentDesign(takeover, {
        action: "reconcile",
        validMarkerNumbers: Array.from({ length: 17 }, (_item, index) => index + 1)
      })).resolves.toEqual({
        placements: [{
          markerNumber: 1,
          point: { x: -50, y: -50 },
          viewport: { width: 1_000, height: 500 },
          pending: true,
          region: { x: 50, y: 50, width: 300, height: 100 }
        }]
      });
      await value.provider.updateHumanCommentDesign(takeover, {
        action: "commit",
        targetToken: region.targetToken!,
        markerNumber: 1
      });
      const committed = await value.provider.updateHumanCommentDesign(takeover, {
        action: "reconcile",
        validMarkerNumbers: [1]
      });
      expect(committed.placements).toEqual([{
        markerNumber: 1,
        point: { x: -50, y: -50 },
        viewport: { width: 1_000, height: 500 },
        pending: false
      }]);

      const text = await value.provider.inspectHumanCommentTarget(takeover, {
        intent: "existingText",
        markerNumber: 2
      });
      expect(text.targetToken).toMatch(/^[\da-f-]{36}$/u);
      const withText = await value.provider.updateHumanCommentDesign(takeover, {
        action: "reconcile",
        validMarkerNumbers: [1]
      });
      expect(withText.placements[1]).toEqual({
        markerNumber: 2,
        point: { x: 754, y: 100 },
        viewport: { width: 1_000, height: 500 },
        pending: true,
        textRegions: [{ x: 550, y: 70, width: 200, height: 60 }]
      });
      await value.provider.updateHumanCommentDesign(takeover, { action: "reset", targetToken: text.targetToken! });

      const element = await value.provider.inspectHumanCommentTarget(takeover, {
        intent: "element",
        markerNumber: 3,
        normalizedX: 0.5,
        normalizedY: 0.5
      });
      await expect(value.provider.updateHumanCommentDesign(takeover, {
        action: "apply",
        targetToken: element.targetToken!,
        styles: { color: "#123456" },
        text: "Save now"
      })).resolves.toEqual({ placements: [] });
      await value.provider.updateHumanCommentDesign(takeover, {
        action: "commit",
        targetToken: element.targetToken!,
        markerNumber: 3
      });
      const pruned = await value.provider.updateHumanCommentDesign(takeover, {
        action: "reconcile",
        validMarkerNumbers: [3]
      });
      expect(pruned.placements.map((placement) => placement.markerNumber)).toEqual([3]);
    } finally {
      await value.cleanup();
    }
  });

  it("fences the entire annotation ledger on every main-frame navigation", async () => {
    const value = await fixture(false, Date.now, 0, true);
    try {
      const takeover = await begin(value.provider);
      const inspected = await value.provider.inspectHumanCommentTarget(takeover, {
        intent: "region",
        markerNumber: 1,
        normalizedPoint: { x: 0.5, y: 0.5 },
        normalizedRegion: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }
      });
      value.fakePage.navigateWithinDocument();
      await expect(value.provider.updateHumanCommentDesign(takeover, {
        action: "reset",
        targetToken: inspected.targetToken!
      })).rejects.toThrow(BrowserTakeoverConflictError);
    } finally {
      await value.cleanup();
    }
  });

  it("repairs original element-style chains through later records that do not override the removed property", async () => {
    const value = await fixture(false, Date.now, 0, true);
    try {
      const takeover = await begin(value.provider);
      const first = await value.provider.inspectHumanCommentTarget(takeover, {
        intent: "element",
        markerNumber: 1,
        normalizedX: 0.5,
        normalizedY: 0.5
      });
      await value.provider.updateHumanCommentDesign(takeover, {
        action: "apply",
        targetToken: first.targetToken!,
        styles: { color: "red" }
      });
      await value.provider.updateHumanCommentDesign(takeover, {
        action: "commit",
        targetToken: first.targetToken!,
        markerNumber: 1
      });
      const second = await value.provider.inspectHumanCommentTarget(takeover, {
        intent: "element",
        markerNumber: 2,
        normalizedX: 0.5,
        normalizedY: 0.5
      });
      await value.provider.updateHumanCommentDesign(takeover, {
        action: "apply",
        targetToken: second.targetToken!,
        styles: { padding: "20px" }
      });
      await value.provider.updateHumanCommentDesign(takeover, {
        action: "commit",
        targetToken: second.targetToken!,
        markerNumber: 2
      });

      await value.provider.updateHumanCommentDesign(takeover, {
        action: "reconcile",
        validMarkerNumbers: [2]
      });
      expect(value.fakePage.commentInlineStyle("color")).toBe("");
      expect(value.fakePage.commentInlineStyle("padding")).toBe("20px");
    } finally {
      await value.cleanup();
    }
  });

  it("opens a fresh page for every human link without navigating the previous page", async () => {
    const value = await fixture();
    try {
      const original = (await value.provider.listPages())[0]!;
      const first = await value.provider.openHumanPage({
        providerId: value.provider.id,
        generation: value.provider.generation,
        owner: "connection-a",
        url: "https://first.test/"
      }, 5_000);
      const second = await value.provider.openHumanPage({
        providerId: value.provider.id,
        generation: value.provider.generation,
        owner: "connection-a",
        url: "https://second.test/"
      }, 5_000);
      const pages = await value.provider.listPages();

      expect(first.pageId).not.toBe(original.id);
      expect(second.pageId).not.toBe(first.pageId);
      expect(pages.map((page) => page.url)).toEqual([
        "https://example.test/",
        "https://first.test/",
        "https://second.test/"
      ]);
      expect(value.provider.currentHumanTakeover()).toEqual(second);
    } finally {
      await value.cleanup();
    }
  });

  it("does not silently replace another Connection's takeover while opening a page", async () => {
    const value = await fixture();
    try {
      const takeover = await begin(value.provider, "connection-a");
      const pagesBefore = await value.provider.listPages();
      await expect(value.provider.openHumanPage({
        providerId: value.provider.id,
        generation: value.provider.generation,
        owner: "connection-b",
        url: "https://blocked.test/"
      }, 5_000)).rejects.toThrow(BrowserTakeoverConflictError);
      expect(await value.provider.listPages()).toEqual(pagesBefore);
      expect(value.provider.currentHumanTakeover()).toEqual(takeover);
    } finally {
      await value.cleanup();
    }
  });

  it("focuses and closes pages only through the exact human takeover fence", async () => {
    const value = await fixture();
    try {
      const first = await begin(value.provider);
      const second = await value.provider.openHumanPage({
        providerId: value.provider.id,
        generation: value.provider.generation,
        owner: "connection-a",
        url: "https://second.test/"
      }, 5_000);
      const third = await value.provider.openHumanPage({
        providerId: value.provider.id,
        generation: value.provider.generation,
        owner: "connection-a",
        url: "https://third.test/"
      }, 5_000);
      const pages = await value.provider.listPages();
      const original = pages.find((page) => page.id === first.pageId)!;

      await expect(value.provider.focusHumanPage({ ...third, generation: third.generation + 1 }, original.id, 5_000))
        .rejects.toThrow(BrowserTakeoverConflictError);
      const focused = await value.provider.focusHumanPage(third, original.id, 5_000);
      expect(focused.pageId).toBe(original.id);
      expect(focused.takeoverId).not.toBe(second.takeoverId);
      expect(value.provider.currentHumanTakeover()).toEqual(focused);

      const afterBackgroundClose = await value.provider.closeHumanPage(focused, second.pageId, 5_000);
      expect(afterBackgroundClose).toEqual(focused);
      expect((await value.provider.listPages()).some((page) => page.id === second.pageId)).toBe(false);

      const replacement = (await value.provider.listPages()).find((page) => page.id !== focused.pageId)!;
      const afterActiveClose = await value.provider.closeHumanPage(focused, focused.pageId, 5_000);
      expect(afterActiveClose?.pageId).toBe(replacement.id);
      expect(value.provider.currentHumanTakeover()).toEqual(afterActiveClose);
      expect((await value.provider.listPages()).some((page) => page.id === focused.pageId)).toBe(false);
    } finally {
      await value.cleanup();
    }
  });

  it("releases human control when the final page is closed", async () => {
    const value = await fixture();
    try {
      const takeover = await begin(value.provider);
      await expect(value.provider.closeHumanPage(takeover, takeover.pageId, 5_000)).resolves.toBeUndefined();
      expect(value.provider.currentHumanTakeover()).toBeUndefined();
      expect(await value.provider.listPages()).toEqual([]);
      expect(value.provider.acquireAgentLease("agent-after-close", 5_000).owner).toBe("agent-after-close");
    } finally {
      await value.cleanup();
    }
  });

  it("automatically fences a takeover on recovery and rejects the old capability", async () => {
    const value = await fixture();
    try {
      const takeover = await begin(value.provider);
      await value.provider.recover();
      expect(value.provider.generation).toBe(takeover.generation + 1);
      expect(value.provider.currentHumanTakeover()).toBeUndefined();
      expect(() => value.provider.assertHumanTakeover(takeover)).toThrow(BrowserTakeoverConflictError);
      await expect(value.provider.runHumanTakeoverOperation(takeover, async () => undefined)).rejects
        .toThrow(BrowserTakeoverConflictError);
    } finally {
      await value.cleanup();
    }
  });

  it("interrupts a stuck fenced operation and completes recovery without waiting for it", async () => {
    const value = await fixture();
    try {
      const takeover = await begin(value.provider);
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const gate = new Promise<void>(() => undefined);
      const operation = value.provider.runHumanTakeoverOperation(takeover, async () => {
        enter();
        await gate;
        return "complete";
      });
      await entered;
      await expect(Promise.race([
        value.provider.recover().then(() => "recovered"),
        new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error("Recovery remained blocked.")), 250))
      ])).resolves.toBe("recovered");
      await expect(operation).rejects.toThrow(BrowserLeaseConflictError);
      expect(value.provider.generation).toBe(takeover.generation + 1);
      expect(value.provider.currentHumanTakeover()).toBeUndefined();
    } finally {
      await value.cleanup();
    }
  });

  it("makes a begin queued after recovery fail its stale generation fence", async () => {
    const value = await fixture();
    try {
      const page = (await value.provider.listPages())[0]!;
      const request = {
        providerId: value.provider.id,
        pageId: page.id,
        generation: value.provider.generation,
        owner: "connection-a"
      };
      const recovery = value.provider.recover();
      const takeover = value.provider.beginHumanTakeover(request, 5_000);
      await recovery;
      await expect(takeover).rejects.toThrow(BrowserTakeoverConflictError);
      expect(value.provider.currentHumanTakeover()).toBeUndefined();
    } finally {
      await value.cleanup();
    }
  });

  it("keeps a headless generation isolated and exposes remote input instead of restarting headed", async () => {
    const value = await fixture(true);
    try {
      const oldGeneration = value.provider.generation;
      const oldPageId = (await value.provider.listPages())[0]!.id;
      const takeover = await begin(value.provider);
      expect(value.launchHeadlessValues).toEqual([true]);
      expect(takeover.providerId).toBe(value.provider.id);
      expect(takeover.generation).toBe(oldGeneration);
      expect(takeover.pageId).toBe(oldPageId);
      expect(value.provider.assertHumanTakeover(takeover)).toEqual(takeover);
    } finally {
      await value.cleanup();
    }
  });

  it("maps typed remote screenshot input to the current CSS viewport under the exact fence", async () => {
    const value = await fixture(true);
    try {
      const takeover = await begin(value.provider);
      await value.provider.performHumanTakeoverAction(takeover, {
        type: "mouseClick",
        normalizedX: 0.25,
        normalizedY: 0.5,
        button: "secondary",
        clickCount: 2
      });
      await value.provider.performHumanTakeoverAction(takeover, { type: "mouseMove", normalizedX: 0.4, normalizedY: 0.2 });
      await value.provider.performHumanTakeoverAction(takeover, {
        type: "mouseDrag",
        startNormalizedX: 0.1,
        startNormalizedY: 0.2,
        endNormalizedX: 0.8,
        endNormalizedY: 0.9,
        button: "primary"
      });
      await value.provider.performHumanTakeoverAction(takeover, { type: "scroll", deltaX: -20, deltaY: 160 });
      await value.provider.performHumanTakeoverAction(takeover, { type: "keyPress", key: "c", modifiers: ["Control", "Shift"] });
      await value.provider.performHumanTakeoverAction(takeover, { type: "textInput", text: "remote text" });
      await value.provider.performHumanTakeoverAction(takeover, { type: "navigate", url: "https://openai.com/" });
      await value.provider.performHumanTakeoverAction(takeover, { type: "navigationCommand", command: "back" });
      await value.provider.performHumanTakeoverAction(takeover, { type: "navigationCommand", command: "forward" });
      await value.provider.performHumanTakeoverAction(takeover, { type: "navigationCommand", command: "reload" });
      await value.provider.performHumanTakeoverAction(takeover, { type: "navigationCommand", command: "stop" });

      expect(value.humanInputs).toEqual([
        { type: "click", x: 250, y: 250, button: "right", clickCount: 2 },
        { type: "move", x: 400, y: 100 },
        { type: "move", x: 100, y: 100 },
        { type: "down", button: "left" },
        { type: "move", x: 800, y: 450, steps: 10 },
        { type: "up", button: "left" },
        { type: "scroll", deltaX: -20, deltaY: 160 },
        { type: "key", key: "Control+Shift+c" },
        { type: "text", text: "remote text" },
        { type: "navigate", url: "https://openai.com/" },
        { type: "navigation", command: "back" },
        { type: "navigation", command: "forward" },
        { type: "navigation", command: "reload" },
        { type: "navigation", command: "stop" }
      ]);
    } finally {
      await value.cleanup();
    }
  });

  it("forces takeover screenshots to the current viewport even if full-page capture is requested", async () => {
    const value = await fixture(true);
    try {
      const page = (await value.provider.listPages())[0]!;
      const lease = value.provider.acquireAgentLease("snapshot-owner", 5_000);
      await value.provider.snapshot(page.id, lease, { fullPage: true });
      await value.provider.releaseAgentLease(lease);
      const takeover = await begin(value.provider);
      await value.provider.snapshotHumanTakeover(takeover, { fullPage: true });
      expect(value.screenshotFullPageValues).toEqual([true, false]);
    } finally {
      await value.cleanup();
    }
  });

  it("rejects malformed or excessive human input before it reaches Playwright", async () => {
    let now = 1_000;
    const value = await fixture(true, () => now);
    try {
      const takeover = await begin(value.provider);
      await expect(value.provider.performHumanTakeoverAction(takeover, {
        type: "mouseClick", normalizedX: 1.01, normalizedY: 0.5, button: "primary"
      })).rejects.toThrow(BrowserTakeoverInputError);
      await expect(value.provider.performHumanTakeoverAction(takeover, {
        type: "scroll", deltaX: 0, deltaY: 10_001
      })).rejects.toThrow(BrowserTakeoverInputError);
      await expect(value.provider.performHumanTakeoverAction(takeover, {
        type: "keyPress", key: "Control+L" as "Enter"
      })).rejects.toThrow(BrowserTakeoverInputError);
      await expect(value.provider.performHumanTakeoverAction(takeover, {
        type: "textInput", text: "x".repeat(4_097)
      })).rejects.toThrow(BrowserTakeoverInputError);
      expect(value.humanInputs).toHaveLength(0);

      for (let index = 0; index < 30; index += 1) {
        await value.provider.performHumanTakeoverAction(takeover, { type: "keyPress", key: "Tab" });
      }
      await expect(value.provider.performHumanTakeoverAction(takeover, { type: "keyPress", key: "Tab" }))
        .rejects.toThrow(BrowserTakeoverRateLimitError);
      now += 1_000;
      await expect(value.provider.performHumanTakeoverAction(takeover, { type: "keyPress", key: "Tab" }))
        .resolves.toBeUndefined();
    } finally {
      await value.cleanup();
    }
  });

  it("expires the human capability without changing headless mode and re-enables Agent leases", async () => {
    let now = 1_000;
    const value = await fixture(true, () => now);
    try {
      const takeover = await begin(value.provider);
      now = takeover.expiresAt;
      expect(value.provider.currentHumanTakeover()).toBeUndefined();
      expect(value.provider.acquireAgentLease("agent-after-expiry", 5_000).owner).toBe("agent-after-expiry");
      expect(value.launchHeadlessValues).toEqual([true]);
      await expect(value.provider.performHumanTakeoverAction(takeover, { type: "keyPress", key: "Enter" }))
        .rejects.toThrow(BrowserTakeoverConflictError);
    } finally {
      await value.cleanup();
    }
  });

  it("rejects an invalid takeover TTL before a headless lifecycle side effect", async () => {
    const value = await fixture(true);
    try {
      const page = (await value.provider.listPages())[0]!;
      const generation = value.provider.generation;
      expect(() => value.provider.beginHumanTakeover({
        providerId: value.provider.id,
        pageId: page.id,
        generation,
        owner: "connection-a"
      }, 999)).toThrow(/TTL/u);
      expect(value.provider.generation).toBe(generation);
      expect(value.launchHeadlessValues).toEqual([true]);
      expect(value.provider.currentHumanTakeover()).toBeUndefined();
    } finally {
      await value.cleanup();
    }
  });

  it("fences the takeover if its bound page closes during an operation", async () => {
    const value = await fixture();
    try {
      const takeover = await begin(value.provider);
      await expect(value.provider.runHumanTakeoverOperation(takeover, async (page) => page.close())).rejects
        .toThrow(BrowserTakeoverConflictError);
      expect(value.provider.currentHumanTakeover()).toBeUndefined();
    } finally {
      await value.cleanup();
    }
  });
});
