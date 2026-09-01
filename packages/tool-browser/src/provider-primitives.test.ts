import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrowserContext, Page, Response } from "playwright-core";
import { describe, expect, it } from "vitest";

import { BrowserProvider, type BrowserAction, type BrowserProviderOptions } from "./provider.js";

interface RecordedOperation {
  readonly kind: string;
  readonly selector?: string;
  readonly targetSelector?: string;
  readonly text?: string;
  readonly key?: string;
  readonly button?: string;
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly width?: number;
  readonly height?: number;
  readonly milliseconds?: number;
  readonly url?: string;
  readonly paths?: readonly string[];
  readonly clickCount?: number;
}

class PrimitiveLocator {
  constructor(readonly page: PrimitivePage, readonly selector: string) {}

  async click(options?: { readonly button?: string }): Promise<void> {
    this.page.operations.push({ kind: "click", selector: this.selector, button: options?.button ?? "left" });
  }

  async dblclick(): Promise<void> {
    this.page.operations.push({ kind: "doubleClick", selector: this.selector });
  }

  async hover(): Promise<void> {
    this.page.operations.push({ kind: "hover", selector: this.selector });
  }

  async dragTo(target: PrimitiveLocator): Promise<void> {
    this.page.operations.push({ kind: "drag", selector: this.selector, targetSelector: target.selector });
  }

  async fill(text: string): Promise<void> {
    this.page.operations.push({ kind: "fill", selector: this.selector, text });
  }

  async press(key: string): Promise<void> {
    this.page.operations.push({ kind: "press", selector: this.selector, key });
  }

  async pressSequentially(text: string, options?: { readonly delay?: number }): Promise<void> {
    this.page.operations.push({ kind: "pressSequentially", selector: this.selector, text, milliseconds: options?.delay });
  }

  async selectOption(value: string): Promise<void> {
    this.page.operations.push({ kind: "select", selector: this.selector, text: value });
  }

  async setInputFiles(paths: readonly string[]): Promise<void> {
    this.page.operations.push({ kind: "upload", selector: this.selector, paths: [...paths] });
  }

  async waitFor(): Promise<void> {
    this.page.operations.push({ kind: "waitFor", selector: this.selector });
  }

  async screenshot(): Promise<Uint8Array> { return this.page.screenshotBytes; }
  async evaluate(): Promise<unknown> {
    this.page.operations.push({ kind: "extract", selector: this.selector });
    return this.page.extractResult;
  }

  async ariaSnapshot(): Promise<string> { return this.page.ariaSnapshotValue; }
}

class PrimitivePage extends EventEmitter {
  readonly operations: RecordedOperation[] = [];
  screenshotBytes = Uint8Array.from([1, 2, 3, 4]);
  pdfBytes = Uint8Array.from([5, 6, 7, 8]);
  evaluateResult: unknown = { safe: true };
  extractResult: unknown = { ok: true, count: 1, records: [{ title: "Example" }] };
  ariaSnapshotValue = "- button \"Continue\"";
  lastScreenshotOptions: unknown;
  screenshotGate: Promise<void> | undefined;
  screenshotStarted: (() => void) | undefined;
  #closed = false;
  #url = "about:blank";

  constructor(readonly contextOwner: PrimitiveContext) {
    super();
  }

  readonly keyboard = {
    press: async (key: string): Promise<void> => {
      this.operations.push({ kind: key.includes("+") ? "hotkey" : "press", key });
    }
  };

  readonly mouse = {
    click: async (x: number, y: number, options?: { readonly button?: string; readonly clickCount?: number }): Promise<void> => {
      this.operations.push({ kind: "clickCoords", width: x, height: y, button: options?.button, clickCount: options?.clickCount });
    },
    wheel: async (deltaX: number, deltaY: number): Promise<void> => {
      this.operations.push({ kind: "scroll", deltaX, deltaY });
    }
  };

  url(): string { return this.#url; }
  forceUrl(url: string): void { this.#url = url; }
  async title(): Promise<string> { return "Primitive page"; }
  isClosed(): boolean { return this.#closed; }
  context(): BrowserContext { return this.contextOwner as unknown as BrowserContext; }
  mainFrame(): object { return this; }
  locator(selector: string): PrimitiveLocator { return new PrimitiveLocator(this, selector); }
  frameLocator(selector: string): { locator: (inner: string) => PrimitiveLocator } {
    this.operations.push({ kind: "frame", selector });
    return { locator: (inner) => new PrimitiveLocator(this, inner) };
  }
  async bringToFront(): Promise<void> {}

  async goto(url: string): Promise<null> {
    this.#url = url;
    this.operations.push({ kind: "navigate", url });
    return null;
  }

  async goBack(): Promise<null> {
    this.operations.push({ kind: "back" });
    return null;
  }

  async goForward(): Promise<null> {
    this.operations.push({ kind: "forward" });
    return null;
  }

  async reload(): Promise<null> {
    this.operations.push({ kind: "reload" });
    return null;
  }

  async setViewportSize(viewport: { readonly width: number; readonly height: number }): Promise<void> {
    this.operations.push({ kind: "resize", ...viewport });
  }

  async waitForTimeout(milliseconds: number): Promise<void> {
    this.operations.push({ kind: "wait", milliseconds });
  }

  async waitForURL(url: string): Promise<void> { this.operations.push({ kind: "waitForURL", url }); }
  async waitForLoadState(key: string): Promise<void> { this.operations.push({ kind: "waitForLoadState", key }); }
  getByText(text: string): PrimitiveLocator { return new PrimitiveLocator(this, `text=${text}`); }

  async evaluate(source: unknown): Promise<unknown> {
    this.operations.push({ kind: typeof source === "string" ? "evaluate" : "extract" });
    return typeof source === "string" ? this.evaluateResult : this.extractResult;
  }

  async screenshot(options: unknown): Promise<Uint8Array> {
    this.lastScreenshotOptions = options;
    this.screenshotStarted?.();
    await this.screenshotGate;
    return this.screenshotBytes;
  }

  async pdf(): Promise<Uint8Array> { return this.pdfBytes; }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("close");
  }
}

class PrimitiveContext extends EventEmitter {
  readonly page = new PrimitivePage(this);
  keepPageOpenOnClose = false;

  pages(): Page[] { return this.page.isClosed() ? [] : [this.page as unknown as Page]; }

  readonly request = {
    get: async (url: string): Promise<unknown> => ({
      url: () => url,
      ok: () => true,
      status: () => 200,
      headers: () => ({ "content-type": "text/plain", "content-length": "8" }),
      body: async () => Buffer.from("resource")
    })
  };

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
    if (!this.keepPageOpenOnClose) await this.page.close();
  }
}

interface PrimitiveFixture {
  readonly provider: BrowserProvider;
  readonly context: PrimitiveContext;
  readonly root: string;
  readonly pageId: string;
  readonly lease: ReturnType<BrowserProvider["acquireAgentLease"]>;
  cleanup(): Promise<void>;
}

async function primitiveFixture(
  limits: Pick<BrowserProviderOptions,
    "maximumScreenshotBytes" | "maximumPdfBytes" | "maximumConsoleMessages" | "maximumHttpRequestSummaries"> = {}
): Promise<PrimitiveFixture> {
  const root = await mkdtemp(join(tmpdir(), "joko-browser-primitives-"));
  const context = new PrimitiveContext();
  const provider = new BrowserProvider({
    providerId: "browser-primitives-test",
    executablePath: "unused-by-primitives-test",
    profileDirectories: {
      sidebar: join(root, "profile-sidebar"),
      external: join(root, "profile-external")
    },
    targetMode: "sidebar",
    downloadDirectory: join(root, "downloads"),
    uploadRoots: [root],
    now: () => 1_700_000_000_000,
    ...limits,
    launchPersistentContext: async () => context as unknown as BrowserContext
  });
  await provider.start();
  const [page] = await provider.listPages();
  if (page === undefined) throw new Error("Primitive fixture failed to create a page.");
  const lease = provider.acquireAgentLease("primitives-owner");
  return {
    provider,
    context,
    root,
    pageId: page.id,
    lease,
    cleanup: async () => {
      await provider.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  };
}

describe("BrowserProvider action primitives", () => {
  it("dispatches every bounded BrowserAction through the fenced page surface", async () => {
    const value = await primitiveFixture();
    try {
      const uploadPath = join(value.root, "upload.txt");
      await writeFile(uploadPath, "safe upload");
      const canonicalUploadPath = await realpath(uploadPath);
      const actions: BrowserAction[] = [
        { type: "navigate", url: "https://example.com/path" },
        { type: "click", selector: "#click" },
        { type: "doubleClick", selector: "#double" },
        { type: "rightClick", selector: "#context" },
        { type: "hover", selector: "#hover" },
        { type: "drag", sourceSelector: "#source", targetSelector: "#target" },
        { type: "type", selector: "#combined-type", text: "combined", submit: true },
        { type: "fill", selector: "#fill", text: "replacement" },
        { type: "press", key: "Enter" },
        { type: "hotkey", key: "K", modifiers: ["ControlOrMeta", "Shift"] },
        { type: "scroll", deltaX: 12, deltaY: -34 },
        { type: "resize", width: 1_280, height: 720 },
        { type: "wait", milliseconds: 250 },
        { type: "select", selector: "#select", value: "choice" },
        { type: "upload", selector: "#upload", paths: [uploadPath] },
        { type: "back" },
        { type: "reload" }
      ];

      for (const action of actions) await value.provider.act(value.pageId, value.lease, action);

      expect(value.context.page.operations).toEqual([
        { kind: "navigate", url: "https://example.com/path" },
        { kind: "click", selector: "#click", button: "left" },
        { kind: "doubleClick", selector: "#double" },
        { kind: "click", selector: "#context", button: "right" },
        { kind: "hover", selector: "#hover" },
        { kind: "drag", selector: "#source", targetSelector: "#target" },
        { kind: "fill", selector: "#combined-type", text: "combined" },
        { kind: "press", selector: "#combined-type", key: "Enter" },
        { kind: "fill", selector: "#fill", text: "replacement" },
        { kind: "press", key: "Enter" },
        { kind: "hotkey", key: "ControlOrMeta+Shift+K" },
        { kind: "scroll", deltaX: 12, deltaY: -34 },
        { kind: "resize", width: 1_280, height: 720 },
        { kind: "wait", milliseconds: 250 },
        { kind: "select", selector: "#select", text: "choice" },
        { kind: "upload", selector: "#upload", paths: [canonicalUploadPath] },
        { kind: "back" },
        { kind: "reload" }
      ]);
    } finally {
      await value.cleanup();
    }
  });

  it("rejects unsafe URLs and out-of-bound action inputs before dispatch", async () => {
    const value = await primitiveFixture();
    try {
      const invalid: BrowserAction[] = [
        { type: "navigate", url: "file:///private/secret" },
        { type: "doubleClick", selector: "" },
        { type: "hotkey", key: "Control+L" },
        { type: "scroll", deltaX: Number.POSITIVE_INFINITY, deltaY: 0 },
        { type: "resize", width: 0, height: 720 },
        { type: "wait", milliseconds: 30_001 }
      ];
      for (const action of invalid) {
        await expect(value.provider.act(value.pageId, value.lease, action)).rejects.toThrow();
      }
      expect(value.context.page.operations).toEqual([]);
    } finally {
      await value.cleanup();
    }
  });

  it("covers coordinate, gradual input, conditional wait, multi-select, and forward actions", async () => {
    const value = await primitiveFixture();
    try {
      await value.provider.act(value.pageId, value.lease, {
        type: "clickCoords", x: 42, y: 84, button: "middle", doubleClick: true
      });
      await value.provider.act(value.pageId, value.lease, {
        type: "type", selector: "#query", text: "gradual", slowly: true, delayMs: 25
      });
      await value.provider.act(value.pageId, value.lease, {
        type: "wait", selector: ".ready", url: "**/done", textGone: "Loading", loadState: "networkidle", timeoutMs: 2_000
      });
      await value.provider.act(value.pageId, value.lease, {
        type: "select", selector: "#choices", values: ["one", "two"]
      });
      await value.provider.act(value.pageId, value.lease, { type: "forward" });

      expect(value.context.page.operations).toEqual([
        { kind: "clickCoords", width: 42, height: 84, button: "middle", clickCount: 2 },
        { kind: "fill", selector: "#query", text: "" },
        { kind: "pressSequentially", selector: "#query", text: "gradual", milliseconds: 25 },
        { kind: "waitFor", selector: ".ready" },
        { kind: "waitForURL", url: "**/done" },
        { kind: "waitFor", selector: "text=Loading" },
        { kind: "waitForLoadState", key: "networkidle" },
        { kind: "select", selector: "#choices", text: ["one", "two"] },
        { kind: "forward" }
      ]);
    } finally {
      await value.cleanup();
    }
  });

  it("resolves fresh snapshot refs and semantic element queries without exposing page internals", async () => {
    const value = await primitiveFixture();
    try {
      const snapshot = await value.provider.snapshot(value.pageId, value.lease, { maxChars: 10_000 });
      expect(snapshot.aria).toContain("[ref=r1]");
      expect(value.provider.resolveElementSelector(value.pageId, { ref: "r1" })).toBe("role=button[name=\"Continue\"]");
      expect(value.provider.resolveElementSelector(value.pageId, {
        query: { role: "button", name: "Continue", index: 1 }
      })).toBe("role=button[name=\"Continue\"] >> nth=1");
      expect(() => value.provider.resolveElementSelector(value.pageId, { ref: "stale" })).toThrow(/stale|unknown/u);
      await value.provider.snapshot(value.pageId, value.lease, { frame: "iframe[name=content]" });
      await value.provider.extract(value.pageId, value.lease, { fields: { title: "h2" } }, 1_000, "iframe[name=content]");
      expect(value.context.page.operations).toEqual(expect.arrayContaining([
        { kind: "frame", selector: "iframe[name=content]" }
      ]));
    } finally {
      await value.cleanup();
    }
  });

  it("double-fences snapshots across release, stale generations, and interrupt recovery", async () => {
    const released = await primitiveFixture();
    try {
      await released.provider.releaseAgentLease(released.lease);
      await expect(released.provider.snapshot(released.pageId, released.lease)).rejects.toThrow();
    } finally {
      await released.cleanup();
    }

    const interrupted = await primitiveFixture();
    try {
      let started!: () => void;
      const entered = new Promise<void>((resolve) => { started = resolve; });
      interrupted.context.page.screenshotStarted = started;
      interrupted.context.page.screenshotGate = new Promise<void>(() => undefined);
      const snapshot = interrupted.provider.snapshot(interrupted.pageId, interrupted.lease);
      await entered;
      await interrupted.provider.recover();
      await expect(snapshot).rejects.toThrow();
      await expect(interrupted.provider.snapshot(interrupted.pageId, interrupted.lease)).rejects.toThrow();
    } finally {
      await interrupted.cleanup();
    }
  });
});

describe("BrowserProvider safe read primitives", () => {
  it("waits only for the next matching response and removes listeners on timeout, abort, stop, and recovery", async () => {
    const value = await primitiveFixture();
    try {
      value.context.page.emit("response", fakeResponse("https://example.test/api/items", "historical"));
      const future = value.provider.readResponseBody(value.pageId, value.lease, "*/api/*", 100, 1_000);
      await Promise.resolve();
      await Promise.resolve();
      expect(value.context.page.listenerCount("response")).toBe(1);
      value.context.page.emit("response", fakeResponse("https://example.test/assets/logo.png", "ignored"));
      value.context.page.emit("response", fakeResponse("https://example.test/api/items", "future body"));
      await expect(future).resolves.toMatchObject({
        url: "https://example.test/api/items",
        status: 200,
        body: "future body",
        truncated: false
      });
      expect(value.context.page.listenerCount("response")).toBe(0);

      await expect(value.provider.readResponseBody(value.pageId, value.lease, "missing", 100, 5))
        .rejects.toThrow(/timed out/u);
      expect(value.context.page.listenerCount("response")).toBe(0);

      const abort = new AbortController();
      const aborted = value.provider.readResponseBody(value.pageId, value.lease, "later", 100, 1_000, abort.signal);
      await Promise.resolve();
      abort.abort(new Error("caller cancelled"));
      await expect(aborted).rejects.toThrow("caller cancelled");
      expect(value.context.page.listenerCount("response")).toBe(0);

      const stopped = value.provider.readResponseBody(value.pageId, value.lease, "later", 100, 1_000);
      await Promise.resolve();
      const stop = value.provider.stop();
      await expect(stopped).rejects.toThrow();
      await stop;
      expect(value.context.page.listenerCount("response")).toBe(0);
    } finally {
      await value.cleanup();
    }

    const recovered = await primitiveFixture();
    try {
      const pending = recovered.provider.readResponseBody(recovered.pageId, recovered.lease, "later", 100, 1_000);
      await Promise.resolve();
      expect(recovered.context.page.listenerCount("response")).toBe(1);
      recovered.context.keepPageOpenOnClose = true;
      await recovered.provider.recover();
      await expect(pending).rejects.toThrow(/interrupted/u);
      expect(recovered.context.page.listenerCount("response")).toBe(0);
    } finally {
      recovered.context.keepPageOpenOnClose = false;
      await recovered.cleanup();
    }
  });

  it("returns screenshot-only and PDF bytes under configured output bounds", async () => {
    const value = await primitiveFixture({ maximumScreenshotBytes: 4, maximumPdfBytes: 4 });
    try {
      const screenshot = await value.provider.captureScreenshot(value.pageId, value.lease, { fullPage: true });
      const pdf = await value.provider.capturePdf(value.pageId, value.lease);
      expect([...screenshot]).toEqual([1, 2, 3, 4]);
      expect([...pdf]).toEqual([5, 6, 7, 8]);
      expect(value.context.page.lastScreenshotOptions).toMatchObject({
        type: "png",
        animations: "disabled",
        caret: "hide",
        fullPage: true
      });

      value.context.page.screenshotBytes = Uint8Array.from([1, 2, 3, 4, 5]);
      value.context.page.pdfBytes = Uint8Array.from([1, 2, 3, 4, 5]);
      await expect(value.provider.captureScreenshot(value.pageId, value.lease)).rejects.toThrow(/byte limit/u);
      await expect(value.provider.capturePdf(value.pageId, value.lease)).rejects.toThrow(/byte limit/u);
    } finally {
      await value.cleanup();
    }
  });

  it("retains a bounded console snapshot with credential-shaped content redacted", async () => {
    const value = await primitiveFixture({ maximumConsoleMessages: 2 });
    try {
      value.context.page.emit("console", { type: () => "log", text: () => "discarded oldest" });
      value.context.page.emit("console", {
        type: () => "warning",
        text: () => "Authorization: Bearer top-secret-value\npassword=hunter2"
      });
      value.context.page.emit("console", {
        type: () => "info",
        text: () => "https://user:pass@example.com/callback?access_token=oauth-value"
      });

      const messages = await value.provider.readConsoleMessages(value.pageId, value.lease);
      expect(messages.map((message) => message.level)).toEqual(["warning", "info"]);
      const published = JSON.stringify(messages);
      expect(published).not.toContain("top-secret-value");
      expect(published).not.toContain("hunter2");
      expect(published).not.toContain("user:pass");
      expect(published).not.toContain("oauth-value");
      expect(published).toContain("redacted");
      await expect(value.provider.readConsoleMessages(value.pageId, value.lease, { limit: 3 })).rejects.toThrow();
    } finally {
      await value.cleanup();
    }
  });

  it("retains HTTP(S)-only request summaries without inspecting headers, cookies, or bodies", async () => {
    const value = await primitiveFixture({ maximumHttpRequestSummaries: 2 });
    try {
      let forbiddenReads = 0;
      const request = (url: string, method = "GET", resourceType = "fetch", navigation = false) => ({
        url: () => url,
        method: () => method,
        resourceType: () => resourceType,
        isNavigationRequest: () => navigation,
        allHeaders: () => { forbiddenReads += 1; throw new Error("must not read headers"); },
        postData: () => { forbiddenReads += 1; throw new Error("must not read bodies"); }
      });
      value.context.page.emit("request", request("https://example.com/discarded"));
      value.context.page.emit("request", request("https://user:pass@example.com/api?token=network-secret", "POST"));
      value.context.page.emit("request", request("https://example.com/document", "GET", "document", true));
      value.context.page.emit("request", request("data:text/plain,private"));

      const summaries = await value.provider.readHttpRequestSummaries(value.pageId, value.lease);
      expect(summaries).toHaveLength(2);
      expect(summaries[0]).toMatchObject({ method: "POST", resourceType: "fetch", navigation: false });
      expect(summaries[1]).toMatchObject({ method: "GET", resourceType: "document", navigation: true });
      expect(forbiddenReads).toBe(0);
      const published = JSON.stringify(summaries);
      expect(published).not.toContain("user:pass");
      expect(published).not.toContain("network-secret");
      expect(published).not.toMatch(/headers|cookie|body/iu);
    } finally {
      await value.cleanup();
    }
  });

  it("fences every safe read when its agent lease is released", async () => {
    const value = await primitiveFixture();
    try {
      await value.provider.releaseAgentLease(value.lease);
      await expect(value.provider.captureScreenshot(value.pageId, value.lease)).rejects.toThrow(/lease/iu);
      await expect(value.provider.capturePdf(value.pageId, value.lease)).rejects.toThrow(/lease/iu);
      await expect(value.provider.readConsoleMessages(value.pageId, value.lease)).rejects.toThrow(/lease/iu);
      await expect(value.provider.readHttpRequestSummaries(value.pageId, value.lease)).rejects.toThrow(/lease/iu);
    } finally {
      await value.cleanup();
    }
  });

  it("blocks restored local or internal pages while allowing an HTTP(S) recovery navigation", async () => {
    const value = await primitiveFixture();
    try {
      value.context.page.forceUrl("file:///private/credential.txt");
      expect(await value.provider.listPages()).toMatchObject([{ url: "about:blank", title: "" }]);
      await expect(value.provider.captureScreenshot(value.pageId, value.lease)).rejects.toThrow(/HTTP\(S\)/u);
      await expect(value.provider.capturePdf(value.pageId, value.lease)).rejects.toThrow(/HTTP\(S\)/u);
      await expect(value.provider.readConsoleMessages(value.pageId, value.lease)).rejects.toThrow(/HTTP\(S\)/u);
      await expect(value.provider.readHttpRequestSummaries(value.pageId, value.lease)).rejects.toThrow(/HTTP\(S\)/u);
      await expect(value.provider.act(value.pageId, value.lease, { type: "click", selector: "body" })).rejects.toThrow(/HTTP\(S\)/u);

      await value.provider.act(value.pageId, value.lease, { type: "navigate", url: "https://example.com/recovered" });
      await expect(value.provider.captureScreenshot(value.pageId, value.lease)).resolves.toBeInstanceOf(Uint8Array);
    } finally {
      await value.cleanup();
    }
  });

  it("bounds evaluation, extraction, response bodies, dialogs, and public resource capture", async () => {
    const value = await primitiveFixture();
    try {
      value.context.page.forceUrl("https://example.com/");
      value.context.page.evaluateResult = {
        title: "Safe",
        access_token: "must-not-publish",
        path: "D:\\private\\account\\note.txt"
      };
      const evaluated = await value.provider.evaluatePage(value.pageId, value.lease, "() => ({ title: document.title })");
      expect(JSON.stringify(evaluated)).not.toContain("must-not-publish");
      expect(JSON.stringify(evaluated)).not.toContain("D:\\private");
      value.context.page.evaluateResult = Array.from({ length: 1_001 }, (_, index) => index);
      await expect(value.provider.evaluatePage(value.pageId, value.lease, "() => []"))
        .resolves.toContain("[truncated 1 items]");
      value.context.page.evaluateResult = Object.fromEntries(
        Array.from({ length: 1_001 }, (_, index) => [`field_${String(index).padStart(4, "0")}`, index])
      );
      await expect(value.provider.evaluatePage(value.pageId, value.lease, "() => ({})"))
        .resolves.toMatchObject({ "[truncated fields]": 1 });
      value.context.page.evaluateResult = {
        title: "Safe",
        access_token: "must-not-publish",
        path: "D:\\private\\account\\note.txt"
      };
      expect(() => value.provider.evaluatePage(
        value.pageId,
        value.lease,
        "() => document.cookie"
      )).toThrow(/credential|storage/u);
      await expect(value.provider.evaluateBundledRecipe(
        value.pageId,
        value.lease,
        "() => { const value = document.cookie; return { used: Boolean(value) }; }"
      )).resolves.toMatchObject({ access_token: "[redacted]" });

      const extracted = await value.provider.extract(value.pageId, value.lease, {
        multiple: true,
        fields: { title: "h2", href: { selector: "a", type: "href" } },
        limit: 2
      });
      expect(extracted).toMatchObject({ ok: true, count: 1 });

      const bodyPromise = value.provider.readResponseBody(value.pageId, value.lease, "*/api/*", 1_000);
      await Promise.resolve();
      value.context.page.emit("response", {
        url: () => "https://example.com/api/items",
        status: () => 200,
        text: async () => '{"name":"visible","access_token":"must-not-publish"}',
        headerValue: async () => "application/json"
      });
      const body = await bodyPromise;
      expect(body.body).toContain("visible");
      expect(body.body).not.toContain("must-not-publish");

      let accepted = false;
      value.context.page.emit("dialog", {
        type: () => "confirm",
        message: () => "Continue?",
        defaultValue: () => "",
        accept: async () => { accepted = true; },
        dismiss: async () => undefined
      });
      const [dialog] = await value.provider.listDialogs(value.pageId, value.lease);
      expect(dialog).toMatchObject({ type: "confirm", message: "Continue?" });
      await value.provider.handleDialog(value.pageId, value.lease, { dialogId: dialog?.id, accept: true });
      expect(accepted).toBe(true);

      const resource = await value.provider.captureResource(
        value.pageId,
        value.lease,
        "https://cdn.example.com/files/report.txt"
      );
      expect(Buffer.from(resource.bytes).toString()).toBe("resource");
      expect(resource).toMatchObject({ fileName: "report.txt", mediaType: "text/plain" });
      expect(() => value.provider.captureResource(value.pageId, value.lease, "http://127.0.0.1/private"))
        .toThrow(/public/u);
    } finally {
      await value.cleanup();
    }
  });
});

function fakeResponse(url: string, body: string): Response {
  return {
    url: () => url,
    status: () => 200,
    headerValue: async (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null,
    text: async () => body
  } as unknown as Response;
}
