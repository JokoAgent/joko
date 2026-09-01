import type { BrowserLease, BrowserProvider, BrowserRemoteNodeRouter } from "@joko/tool-browser";
import { OperationalStore } from "@joko/store";
import { describe, expect, it, vi } from "vitest";

import type { ArtifactStore } from "./artifact-store.js";
import { BUILTIN_BROWSER_RECIPES, BUILTIN_BROWSER_SITE_GUIDES } from "./browser-builtin-catalog.js";
import { BrowserToolBridgeProvider, type BrowserUserKnowledgeLayer } from "./browser-tool-bridge.js";
import type { BrowserTransferCoordinator } from "./browser-transfers.js";
import { OperationalBrowserState } from "./operational-browser-state.js";

function fixture(
  remoteNodes?: BrowserRemoteNodeRouter,
  userKnowledge?: BrowserUserKnowledgeLayer,
  options: {
    readonly running?: boolean;
    readonly generation?: number;
    readonly enabledForNewSessions?: (targetId: string) => boolean;
    readonly state?: OperationalBrowserState;
  } = {}
) {
  const lease: BrowserLease = {
    id: "lease-1",
    providerId: "browser",
    owner: "pi-browser:test",
    generation: 6,
    mode: "agent",
    acquiredAt: 1,
    expiresAt: 60_001
  };
  const actions: unknown[] = [];
  const start = vi.fn(async () => undefined);
  const acquireAgentLease = vi.fn(() => lease);
  const releaseAgentLease = vi.fn(async () => undefined);
  const captureScreenshot = vi.fn(async () => Uint8Array.from(Buffer.from("standalone-png")));
  const capturePdf = vi.fn(async () => Uint8Array.from(Buffer.from("pdf-bytes")));
  const readConsoleMessages = vi.fn(async () => [{
    sequence: 4,
    at: 9,
    level: "warning",
    text: "Authorization: Bearer super-secret-browser-token"
  }]);
  const readHttpRequestSummaries = vi.fn(async () => [{
    sequence: 5,
    at: 10,
    method: "GET",
    url: "https://example.test/data?access_token=super-secret-browser-token",
    resourceType: "fetch",
    navigation: false,
    headers: { authorization: "Bearer super-secret-browser-token" }
  }]);
  const browser = {
    id: "browser",
    generation: options.generation ?? 6,
    running: options.running ?? true,
    targetMode: "external",
    start,
    stop: vi.fn(async () => undefined),
    acquireAgentLease,
    releaseAgentLease,
    listPages: vi.fn(async () => [{ id: "page-1", url: "https://example.test/", title: "Example", state: "ready" as const }]),
    createPage: vi.fn(async () => ({ id: "page-2", url: "https://open.test/", title: "Open", state: "ready" as const })),
    snapshot: vi.fn(async () => ({
      page: { id: "page-1", url: "https://example.test/", title: "Example", state: "ready" as const },
      aria: "- button \"Continue\"",
      screenshot: Buffer.from("png")
    })),
    captureScreenshot,
    capturePdf,
    readConsoleMessages,
    readHttpRequestSummaries,
    resolvePageId: vi.fn((targetId?: string) => targetId ?? "page-1"),
    resolveElementSelector: vi.fn((_pageId: string, target: { selector?: string; ref?: string; query?: { role?: string } }) =>
      target.selector ?? (target.ref === undefined ? `role=${target.query?.role ?? "button"}` : `ref=${target.ref}`)),
    focusPage: vi.fn(async () => ({ id: "page-1", url: "https://example.test/", title: "Example", state: "ready" as const })),
    listDialogs: vi.fn(async () => [{ id: "dialog-1", pageId: "page-1", type: "confirm", message: "Continue?", defaultValue: "" }]),
    handleDialog: vi.fn(async () => undefined),
    evaluatePage: vi.fn(async () => ({ value: "safe" })),
    evaluateBundledRecipe: vi.fn(async () => ({ value: "bundled" })),
    extract: vi.fn(async () => ({ ok: true as const, count: 1, records: [{ title: "Example" }] })),
    readResponseBody: vi.fn(async () => ({
      url: "https://example.test/api/items", status: 200, mediaType: "application/json", body: "{\"ok\":true}", truncated: false
    })),
    captureResource: vi.fn(async () => ({
      url: "https://cdn.example.test/report.txt",
      fileName: "report.txt",
      mediaType: "text/plain",
      bytes: Uint8Array.from(Buffer.from("resource"))
    })),
    act: vi.fn(async (_pageId: string, _lease: BrowserLease, action: unknown) => {
      actions.push(action);
      return { id: "page-1", url: "https://example.test/next", title: "Next", state: "ready" as const };
    }),
    closePage: vi.fn(async () => undefined)
  } as unknown as BrowserProvider;
  const artifact = {
    id: "artifact-1",
    sha256: "a".repeat(64),
    byteLength: 3,
    mimeType: "text/plain",
    fileName: "note.txt",
    storagePath: "D:\\private\\artifact",
    createdAt: 1
  };
  const get = vi.fn(async () => artifact);
  const ingestBytes = vi.fn(async (_bytes: Uint8Array, options?: { fileName?: string; mimeType?: string }) => ({
    ...artifact,
    id: "generated-artifact",
    fileName: options?.fileName ?? artifact.fileName,
    mimeType: options?.mimeType ?? artifact.mimeType
  }));
  const upload = vi.fn(async () => ({
    browserTransferId: "transfer-1",
    browserProviderId: "browser",
    pageId: "page-1",
    toolCallId: "",
    direction: 1,
    state: 3,
    blob: {
      blobId: artifact.id,
      fileName: artifact.fileName,
      mediaType: artifact.mimeType,
      byteSize: BigInt(artifact.byteLength),
      sha256Hex: artifact.sha256
    }
  }));
  const transfers = {
    upload,
    list: vi.fn(() => [])
  } as unknown as BrowserTransferCoordinator;
  const bridge = new BrowserToolBridgeProvider({
    browser,
    transfers,
    artifacts: { get, ingestBytes } as unknown as ArtifactStore,
    ...(options.state === undefined ? {} : { state: options.state }),
    ...(options.enabledForNewSessions === undefined
      ? {}
      : { enabledForNewSessions: options.enabledForNewSessions }),
    ...(remoteNodes === undefined ? {} : { remoteNodes }),
    ...(userKnowledge === undefined ? {} : { userKnowledge })
  });
  return {
    bridge,
    browser,
    start,
    actions,
    acquireAgentLease,
    releaseAgentLease,
    captureScreenshot,
    capturePdf,
    readConsoleMessages,
    readHttpRequestSummaries,
    get,
    ingestBytes,
    upload
  };
}

describe("BrowserToolBridgeProvider", () => {
  it("publishes lifecycle tools while cold without launching the Browser", async () => {
    const { bridge, browser } = fixture(undefined, undefined, {
      running: false,
      generation: 0,
      enabledForNewSessions: (targetId) => targetId === "enabled-target"
    });

    expect(bridge.available).toBe(true);
    expect(bridge.generation).toBe(1);
    expect(bridge.includeInSnapshot).toBe(true);
    expect(bridge.includeForTarget("enabled-target")).toBe(true);
    expect(bridge.includeForTarget("disabled-target")).toBe(false);
    expect(browser.start).not.toHaveBeenCalled();

    const result = await bridge.callTool("call_tool", {
      name: "browser",
      args: { action: "start" }
    });

    expect(result.isError).toBe(false);
    expect(browser.start).toHaveBeenCalledOnce();
  });

  it("starts lazily before opening a page from either explicit cold-open entry point", async () => {
    for (const call of [
      (bridge: BrowserToolBridgeProvider) => bridge.callTool("call_tool", {
        name: "browser",
        args: { action: "open", url: "https://open.test/" }
      }),
      (bridge: BrowserToolBridgeProvider) => bridge.callTool("open_page", {
        url: "https://open.test/"
      })
    ]) {
      const { bridge, start, acquireAgentLease, browser } = fixture(undefined, undefined, {
        running: false,
        generation: 0
      });

      const result = await call(bridge);

      expect(result.isError).toBe(false);
      expect(start).toHaveBeenCalledOnce();
      expect(browser.createPage).toHaveBeenCalledOnce();
      expect(start.mock.invocationCallOrder[0]).toBeLessThan(acquireAgentLease.mock.invocationCallOrder[0]!);
    }
  });

  it("scopes page discovery and actions to one active Session and replays a claimed open without duplicating it", async () => {
    const store = browserBridgeAuthorityStore();
    const state = new OperationalBrowserState(store);
    state.recordHumanPage({
      browserProviderId: "browser",
      pageId: "page-1",
      generation: 6,
      sessionId: "session-a",
      targetId: "target-a",
      bindingGeneration: 1,
      url: "https://a.example.test/owned",
      title: "Owned A",
      updatedAt: 1
    }, { active: false });
    state.recordHumanPage({
      browserProviderId: "browser",
      pageId: "page-b",
      generation: 6,
      sessionId: "session-b",
      targetId: "target-b",
      bindingGeneration: 1,
      url: "https://b.example.test/private",
      title: "Private B",
      updatedAt: 2
    }, { active: false });
    const value = fixture(undefined, undefined, { generation: 6, state });
    vi.mocked(value.browser.listPages).mockResolvedValue([
      { id: "page-1", url: "https://a.example.test/owned", title: "Owned A", state: "ready" },
      { id: "page-b", url: "https://b.example.test/private", title: "Private B", state: "ready" }
    ]);
    const context = browserBridgeContext("a", "session-a", "target-a", 1, 6);

    const listed = await value.bridge.callTool("list_pages", {}, undefined, context);
    const listedText = JSON.stringify(listed);
    expect(listedText).toContain("Owned A");
    expect(listedText).not.toContain("Private B");
    expect(listedText).not.toContain("b.example.test");
    await expect(value.bridge.callTool("snapshot", { page_id: "page-b" }, undefined, context))
      .rejects.toThrow(/authority/u);

    const openContext = browserBridgeContext("c", "session-a", "target-a", 1, 6);
    const first = await value.bridge.callTool("open_page", { url: "https://open.test/" }, undefined, openContext);
    const replay = await value.bridge.callTool("open_page", { url: "https://open.test/" }, undefined, openContext);
    expect(replay).toEqual(first);
    expect(value.browser.createPage).toHaveBeenCalledOnce();
    expect(state.findRecoverablePage("browser", "page-2")).toMatchObject({
      sessionId: "session-a",
      targetId: "target-a",
      bindingGeneration: 1,
      generation: 6
    });

    await expect(value.bridge.callTool(
      "open_page",
      { url: "https://different.test/" },
      undefined,
      browserBridgeContext("c", "session-a", "target-a", 1, 6, "d")
    )).rejects.toThrow();
    expect(value.browser.createPage).toHaveBeenCalledOnce();

    const session = store.getSession("session-a");
    store.updateSession("session-a", { archived: true }, session.revision, 10);
    await expect(value.bridge.callTool("list_pages", {}, undefined, context)).rejects.toThrow(/authority/u);
    store.close();
  });

  it("withholds a late Browser action result after the product binding generation advances", async () => {
    const store = browserBridgeAuthorityStore();
    const state = new OperationalBrowserState(store);
    state.recordHumanPage({
      browserProviderId: "browser",
      pageId: "page-1",
      generation: 6,
      sessionId: "session-a",
      targetId: "target-a",
      bindingGeneration: 1,
      url: "https://a.example.test/before",
      title: "Before",
      updatedAt: 1
    }, { active: false });
    const value = fixture(undefined, undefined, { generation: 6, state });
    vi.mocked(value.browser.act).mockImplementation(async () => {
      const session = store.getSession("session-a");
      store.updateSession("session-a", {
        binding: { ...session.descriptor.binding, generation: 2 }
      }, session.revision, 5);
      return { id: "page-1", url: "https://a.example.test/after", title: "After", state: "ready" };
    });

    await expect(value.bridge.callTool("navigate", {
      page_id: "page-1",
      url: "https://a.example.test/after"
    }, undefined, browserBridgeContext("e", "session-a", "target-a", 1, 6))).rejects.toThrow(/authority/u);
    expect(state.findRecoverablePage("browser", "page-1")).toMatchObject({
      bindingGeneration: 1,
      url: "https://a.example.test/before",
      updatedAt: 1
    });
    store.close();
  });

  it("publishes only progressive discovery and exposes one nested Browser tool with the exact schemas and rules", async () => {
    const { bridge } = fixture();
    expect(bridge.tools.map((tool) => tool.name)).toEqual(["list_tools", "call_tool"]);
    expect(bridge.tools.map((tool) => ({ name: tool.name, requiresPermission: tool.requiresPermission }))).toEqual([
      { name: "list_tools", requiresPermission: true },
      { name: "call_tool", requiresPermission: true }
    ]);

    const overview = await bridge.callTool("list_tools", {});
    expect(overview.structuredContent).toBeUndefined();
    expect(JSON.parse((overview.content[0] as { text: string }).text)).toMatchObject({
      ok: true,
      categories: [{ name: "browser", tool_count: 1 }]
    });

    const catalog = await bridge.callTool("list_tools", { category: "browser" });
    expect(catalog.structuredContent).toBeUndefined();
    const catalogText = (catalog.content[0] as { text: string }).text;
    expect(Buffer.byteLength(catalogText, "utf8")).toBeLessThanOrEqual(200_000);
    const discovered = JSON.parse(catalogText) as {
      readonly tools: readonly { readonly name: string; readonly rules: readonly string[] }[];
      readonly rules: Readonly<Record<string, string>>;
    };
    expect(discovered.tools).toEqual([expect.objectContaining({
      name: "browser",
      rules: ["browser-workflow", "recipe-author"]
    })]);
    expect(Object.keys(discovered.rules)).toEqual(["browser-workflow", "recipe-author"]);
    expect(discovered.rules["browser-workflow"]).toContain("responseBody");
    expect(discovered.rules["browser-workflow"]).toContain("next");
    expect(discovered.rules["recipe-author"]).toContain("saveRecipe");
    expect(catalogText.match(/### Browser workflow/gu)).toHaveLength(1);
    expect(catalogText.match(/### Browser recipe authoring/gu)).toHaveLength(1);

    const schemaError = await bridge.callTool("call_tool", { name: "browser", args: {} });
    expect(schemaError.isError).toBe(true);
    expect(schemaError.structuredContent).toBeUndefined();
    const schema = (JSON.parse((schemaError.content[0] as { text: string }).text) as {
      readonly data: { readonly schema: { readonly properties: Readonly<Record<string, {
        readonly enum?: readonly string[];
        readonly properties?: Readonly<Record<string, { readonly enum?: readonly string[] }>>;
      }>> } };
    }).data.schema;
    expect(Object.keys(schema.properties)).toEqual([
      "action", "profile", "target", "node", "url", "targetId", "label", "limit", "maxChars",
      "mode", "snapshotFormat", "refs", "interactive", "compact", "depth", "selector", "frame", "labels", "urls",
      "fullPage", "ref", "type", "level", "paths", "inputRef", "query", "timeoutMs", "dialogId",
      "accept", "promptText", "filter", "clear", "extract", "recipeId", "inputs", "site", "recipeDraft",
      "siteGuideDraft", "request"
    ]);
    expect(schema.properties["action"]?.enum).toEqual([
      "doctor", "status", "start", "stop", "profiles", "tabs", "open", "focus", "close",
      "snapshot", "screenshot", "navigate", "console", "pdf", "upload", "dialog", "act",
      "requests", "responseBody", "extract", "recipe", "siteguide", "saveRecipe"
    ]);
    expect(schema.properties["request"]?.properties?.["kind"]?.enum).toEqual([
      "click", "clickCoords", "type", "press", "hover", "drag", "select", "fill", "resize",
      "wait", "evaluate", "saveResource", "close"
    ]);
    expect(Object.keys(schema.properties["request"]?.properties ?? {})).toEqual([
      "kind", "targetId", "ref", "query", "doubleClick", "button", "modifiers", "x", "y", "text", "submit",
      "slowly", "key", "delayMs", "startRef", "endRef", "values", "fields", "width", "height", "timeMs",
      "selector", "url", "loadState", "textGone", "timeoutMs", "fn"
    ]);

    const status = await bridge.callTool("call_tool", { name: "browser", args: { action: "status" } });
    expect(status).toMatchObject({ isError: false, content: [{ type: "text" }] });
    expect(status.structuredContent).toBeUndefined();
    expect(JSON.parse((status.content[0] as { text: string }).text)).toMatchObject({ ok: true, action: "status" });

    const screenshot = await bridge.callTool("call_tool", {
      name: "browser",
      args: { action: "screenshot", targetId: "page-1" }
    });
    expect(screenshot.content.map((block) => (block as { readonly type: string }).type)).toEqual(["text", "image"]);
    expect(screenshot.structuredContent).toBeUndefined();
    expect(JSON.parse((screenshot.content[0] as { text: string }).text)).toMatchObject({
      ok: true,
      action: "screenshot",
      data: { targetId: "page-1", mediaType: "image/png" }
    });
  });

  it("dispatches the unified lifecycle, tab, read, interaction, network, and resource action surface", async () => {
    const { bridge, browser, actions, get, upload, ingestBytes } = fixture();

    for (const action of ["doctor", "status", "profiles", "tabs"] as const) {
      const result = await bridge.callTool("browser", { action, profile: "external" });
      expect(result.isError, action).toBe(false);
      expect(result.structuredContent).toMatchObject({ ok: true, action });
    }
    await bridge.callTool("browser", { action: "start" });
    await bridge.callTool("browser", { action: "open", url: "https://open.test/", label: "work" });
    await bridge.callTool("browser", { action: "focus", targetId: "page-1" });
    await bridge.callTool("browser", { action: "snapshot", targetId: "page-1", maxChars: 10_000 });
    await bridge.callTool("browser", { action: "screenshot", targetId: "page-1", type: "jpeg" });
    await bridge.callTool("browser", { action: "navigate", targetId: "page-1", url: "https://example.test/next" });
    await bridge.callTool("browser", { action: "console", targetId: "page-1", limit: 10 });
    await bridge.callTool("browser", { action: "pdf", targetId: "page-1" });
    await bridge.callTool("browser", {
      action: "upload", targetId: "page-1", selector: "input[type=file]", paths: ["artifact-1"]
    });
    const dialogs = await bridge.callTool("browser", { action: "dialog", targetId: "page-1" });
    expect(JSON.stringify(dialogs)).toContain("dialog-1");
    await bridge.callTool("browser", {
      action: "dialog", targetId: "page-1", dialogId: "dialog-1", accept: true
    });
    await bridge.callTool("browser", { action: "requests", targetId: "page-1", filter: "/api/" });
    const body = await bridge.callTool("browser", {
      action: "responseBody", targetId: "page-1", url: "*/api/*", maxChars: 1_000
    });
    expect(JSON.stringify(body)).toContain("application/json");
    const extracted = await bridge.callTool("browser", {
      action: "extract",
      targetId: "page-1",
      extract: { multiple: true, fields: { title: "h2" }, limit: 5 }
    });
    expect(JSON.stringify(extracted)).toContain("Example");

    const requests = [
      { kind: "click", ref: "r1", button: "middle" },
      { kind: "clickCoords", x: 10, y: 20, doubleClick: true },
      { kind: "type", selector: "#query", text: "hello", slowly: true, delayMs: 20 },
      { kind: "press", selector: "#query", key: "Enter" },
      { kind: "hover", query: { role: "button" } },
      { kind: "drag", startRef: "from", endRef: "to" },
      { kind: "select", selector: "#choices", values: ["one", "two"] },
      { kind: "fill", fields: [{ selector: "#one", text: "first" }, { selector: "#two", text: "second" }] },
      { kind: "resize", width: 1_200, height: 800 },
      { kind: "wait", timeMs: 1 },
      { kind: "evaluate", fn: "() => ({ value: 'safe' })" },
      { kind: "saveResource", url: "https://cdn.example.test/report.txt" },
      { kind: "close" }
    ];
    for (const request of requests) {
      const result = await bridge.callTool("browser", { action: "act", targetId: "page-1", request });
      expect(result.isError, request.kind).toBe(false);
    }

    expect(actions).toEqual(expect.arrayContaining([
      { type: "click", selector: "ref=r1", button: "middle" },
      { type: "clickCoords", x: 10, y: 20, button: undefined, doubleClick: true },
      { type: "type", selector: "#query", text: "hello", slowly: true, delayMs: 20 },
      { type: "press", key: "Enter", selector: "#query" },
      { type: "drag", sourceSelector: "ref=from", targetSelector: "ref=to" },
      { type: "select", selector: "#choices", values: ["one", "two"] }
    ]));
    expect(get).toHaveBeenCalledWith("artifact-1");
    expect(upload).toHaveBeenCalled();
    expect(ingestBytes).toHaveBeenCalled();
    expect(browser.handleDialog).toHaveBeenCalledWith("page-1", expect.anything(), {
      dialogId: "dialog-1", accept: true, promptText: undefined
    });

    await bridge.callTool("browser", { action: "stop" });
    expect(browser.start).toHaveBeenCalled();
    expect(browser.stop).toHaveBeenCalled();
  });

  it("saves, discovers, and executes validated reusable browser recipes", async () => {
    const { bridge, actions } = fixture();
    const saved = await bridge.callTool("browser", {
      action: "saveRecipe",
      site: "example.test",
      recipeDraft: {
        id: "example-search",
        inputs: { query: { required: true } },
        steps: [
          { action: "navigate", url: "https://example.test/search?q={{query|url}}" },
          { action: "click", selector: "#result", as: "selected" }
        ],
        output: "{{selected}}"
      },
      siteGuideDraft: {
        site: "example.test",
        auth: "none",
        recipes: ["example-search"]
      }
    });
    expect(saved.isError).toBe(false);
    const guide = await bridge.callTool("browser", { action: "siteguide", site: "example.test" });
    expect(JSON.stringify(guide)).toContain("example-search");
    const run = await bridge.callTool("browser", {
      action: "recipe",
      recipeId: "example-search",
      targetId: "page-1",
      inputs: { query: "safe phrase" }
    });
    expect(run.isError).toBe(false);
    expect(actions).toEqual(expect.arrayContaining([
      { type: "navigate", url: "https://example.test/search?q=safe%20phrase" },
      { type: "click", selector: "#result" }
    ]));
    await expect(bridge.callTool("browser", {
      action: "saveRecipe",
      site: "example.test",
      recipeDraft: {
        id: "unsafe",
        steps: [{ action: "evaluate", fn: "() => '{{query}}'" }]
      }
    })).rejects.toThrow(/unsafe/u);
  });

  it("ships the complete built-in recipe and site-guide catalog without runtime reference dependencies", async () => {
    expect(BUILTIN_BROWSER_RECIPES).toHaveLength(56);
    expect(BUILTIN_BROWSER_SITE_GUIDES).toHaveLength(56);
    const { bridge, actions, browser } = fixture();
    const discovery = await bridge.callTool("browser", { action: "siteguide" });
    const discoveryData = discovery.structuredContent?.["data"] as { sites?: readonly unknown[] } | undefined;
    expect(discoveryData?.sites).toHaveLength(56);
    expect(JSON.stringify(discovery)).toContain("arxiv-search");
    const guide = await bridge.callTool("browser", { action: "siteguide", site: "arxiv.org" });
    expect(guide.structuredContent).toMatchObject({
      ok: true,
      action: "siteguide",
      data: {
        provenance: "builtin"
      }
    });
    const run = await bridge.callTool("browser", {
      action: "recipe",
      recipeId: "arxiv-search",
      targetId: "page-1",
      inputs: { query: "agent safety" }
    });
    expect(run.isError).toBe(false);
    expect(actions).toEqual(expect.arrayContaining([
      { type: "navigate", url: "https://export.arxiv.org/api/query?search_query=all:agent%20safety&max_results=20&sortBy=relevance" },
      { type: "wait", loadState: "load" }
    ]));
    expect(browser.extract).toHaveBeenCalled();
    const authenticated = await bridge.callTool("browser", {
      action: "recipe",
      recipeId: "linkedin-jobs-search",
      targetId: "page-1",
      inputs: { query: "engineer" }
    });
    expect(authenticated.isError).toBe(false);
    expect(browser.evaluateBundledRecipe).toHaveBeenCalledWith(
      "page-1",
      expect.anything(),
      expect.stringContaining("document.cookie"),
      undefined
    );
  });

  it("hydrates and durably saves the user recipe layer before publishing overrides", async () => {
    const save = vi.fn(async () => undefined);
    const userKnowledge: BrowserUserKnowledgeLayer = {
      recipes: [{
        id: "personal-search",
        description: "Personal flow",
        steps: [{ action: "navigate", url: "https://example.test/" }]
      }],
      siteGuides: [{ site: "personal.example", recipes: ["personal-search"] }],
      save
    };
    const { bridge } = fixture(undefined, userKnowledge);
    const initial = await bridge.callTool("browser", { action: "siteguide", site: "personal.example" });
    expect(initial.structuredContent).toMatchObject({ data: { provenance: "user" } });

    await bridge.callTool("browser", {
      action: "saveRecipe",
      site: "arxiv.org",
      recipeDraft: {
        id: "arxiv-search",
        description: "Local override",
        steps: [{ action: "navigate", url: "https://arxiv.org/" }]
      },
      siteGuideDraft: { site: "arxiv.org", recipes: ["arxiv-search"] }
    });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      site: "arxiv.org",
      recipe: expect.objectContaining({ id: "arxiv-search" }),
      siteGuide: expect.objectContaining({ site: "arxiv.org" })
    }));
    const overridden = await bridge.callTool("browser", { action: "siteguide", site: "arxiv.org" });
    expect(overridden.structuredContent).toMatchObject({ data: { provenance: "overridden" } });
  });

  it("routes target=node only through explicit action and act-kind capabilities", async () => {
    const capabilities = new Set([
      "action:navigate",
      "action:act",
      "act:click",
      "action:screenshot",
      "binary-result"
    ] as const);
    const call = vi.fn(async (request: { action: string; arguments: Readonly<Record<string, unknown>> }) =>
      request.action === "screenshot"
        ? {
            ok: true,
            data: { targetId: "remote-page" },
            binary: { bytes: Uint8Array.from([1, 2, 3]), mediaType: "image/png" as const }
          }
        : { ok: true, data: { accepted: true, arguments: request.arguments } });
    const route = {
      id: "node-a",
      generation: 3,
      available: true,
      capabilities,
      call
    };
    const router = {
      resolve: (id: string) => id === route.id ? route : undefined,
      list: () => [route]
    } as unknown as BrowserRemoteNodeRouter;
    const { bridge } = fixture(router);

    const navigated = await bridge.callTool("browser", {
      action: "navigate",
      target: "node",
      node: "node-a",
      targetId: "remote-page",
      url: "https://example.test/path"
    });
    expect(navigated).toMatchObject({ isError: false, structuredContent: { ok: true, action: "navigate" } });
    expect(call).toHaveBeenCalledWith({
      action: "navigate",
      arguments: { action: "navigate", targetId: "remote-page", url: "https://example.test/path" }
    }, undefined);

    await bridge.callTool("browser", {
      action: "act",
      target: "node",
      node: "node-a",
      targetId: "remote-page",
      request: { kind: "click", selector: "#continue" }
    });
    const screenshot = await bridge.callTool("browser", {
      action: "screenshot", target: "node", node: "node-a", targetId: "remote-page"
    });
    expect(screenshot.content).toContainEqual({
      type: "image", data: Buffer.from([1, 2, 3]).toString("base64"), mimeType: "image/png"
    });

    await expect(bridge.callTool("browser", {
      action: "act",
      target: "node",
      node: "node-a",
      targetId: "remote-page",
      request: { kind: "click", query: { role: "button" } }
    })).rejects.toThrow(/semantic-query/u);
    await expect(bridge.callTool("browser", {
      action: "act",
      target: "node",
      node: "node-a",
      targetId: "remote-page",
      request: { kind: "evaluate", fn: "() => true" }
    })).rejects.toThrow(/act:evaluate/u);
    await expect(bridge.callTool("browser", {
      action: "navigate",
      target: "node",
      node: "node-a",
      url: "file:///private/data"
    })).rejects.toThrow(/HTTP\(S\)|Only HTTP/u);
  });

  it("durably owns remote Browser pages and filters exact IDs across product Sessions", async () => {
    const store = browserBridgeAuthorityStore();
    const state = new OperationalBrowserState(store);
    const call = vi.fn(async (request: { action: string }) => {
      if (request.action === "open") {
        return {
          ok: true,
          data: {
            tab: {
              id: "remote-page-a",
              url: "https://remote-a.example.test/private",
              title: "Remote A",
              state: "ready"
            }
          }
        };
      }
      if (request.action === "tabs") {
        return {
          ok: true,
          data: {
            tabs: [
              { id: "remote-page-a", url: "https://remote-a.example.test/private", title: "Remote A", state: "ready" },
              { id: "remote-page-foreign", url: "https://foreign.example.test/private", title: "Foreign", state: "ready" }
            ]
          }
        };
      }
      return { ok: true, data: { accepted: true } };
    });
    const route = {
      id: "node-owned",
      generation: 3,
      available: true,
      capabilities: new Set(["action:open", "action:tabs", "action:navigate", "action:stop"] as const),
      call
    };
    const remoteNodes = {
      resolve: (id: string) => id === route.id ? route : undefined,
      list: () => [route]
    } as unknown as BrowserRemoteNodeRouter;
    const { bridge } = fixture(remoteNodes, undefined, { state });
    const openContext = browserBridgeContext("1", "session-a", "target-a", 1, 6);

    const [opened, replayed] = await Promise.all([
      bridge.callTool("browser", {
        action: "open",
        target: "node",
        node: "node-owned",
        url: "https://remote-a.example.test/private"
      }, undefined, openContext),
      bridge.callTool("browser", {
        action: "open",
        target: "node",
        node: "node-owned",
        url: "https://remote-a.example.test/private"
      }, undefined, openContext)
    ]);
    expect(replayed).toEqual(opened);
    expect(call).toHaveBeenCalledTimes(1);

    const listedA = await bridge.callTool("browser", {
      action: "tabs", target: "node", node: "node-owned"
    }, undefined, browserBridgeContext("2", "session-a", "target-a", 1, 6));
    expect(JSON.stringify(listedA)).toContain("remote-page-a");
    expect(JSON.stringify(listedA)).not.toContain("remote-page-foreign");
    expect(JSON.stringify(listedA)).not.toContain("foreign.example.test");

    const listedB = await bridge.callTool("browser", {
      action: "tabs", target: "node", node: "node-owned"
    }, undefined, browserBridgeContext("3", "session-b", "target-b", 1, 6));
    expect(JSON.stringify(listedB)).not.toContain("remote-page-a");
    await expect(bridge.callTool("browser", {
      action: "navigate",
      target: "node",
      node: "node-owned",
      targetId: "remote-page-a",
      url: "https://remote-a.example.test/changed"
    }, undefined, browserBridgeContext("4", "session-b", "target-b", 1, 6))).rejects.toThrow(/authority/u);
    await expect(bridge.callTool("browser", {
      action: "stop", target: "node", node: "node-owned"
    }, undefined, browserBridgeContext("5", "session-a", "target-a", 1, 6))).rejects.toThrow(/cannot stop/u);
    expect(call).toHaveBeenCalledTimes(3);
    store.close();
  });

  it("exposes page state and a bounded accessibility/image snapshot through the fenced bridge", async () => {
    const { bridge, acquireAgentLease, releaseAgentLease } = fixture();
    expect(bridge.available).toBe(true);
    expect(bridge.generation).toBe(6);
    expect(bridge.tools.map((tool) => tool.name)).toEqual(["list_tools", "call_tool"]);

    const pages = await bridge.callTool("list_pages", {});
    expect(JSON.stringify(pages.content)).toContain("page-1");
    const snapshot = await bridge.callTool("snapshot", { page_id: "page-1" });
    expect(snapshot.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" })
    ]));
    expect(JSON.stringify(snapshot.content)).toContain("Continue");
    expect(acquireAgentLease).toHaveBeenCalledTimes(2);
    expect(releaseAgentLease).toHaveBeenCalledTimes(2);
  });

  it("executes browser actions and artifact uploads without returning service-local paths", async () => {
    const { bridge, actions, get, upload } = fixture();
    const clicked = await bridge.callTool("click", { page_id: "page-1", selector: "role=button[name=Continue]" });
    expect(clicked.isError).toBe(false);
    expect(actions).toEqual([{ type: "click", selector: "role=button[name=Continue]" }]);

    const uploaded = await bridge.callTool("upload_artifact", {
      page_id: "page-1",
      selector: "input[type=file]",
      artifact_id: "artifact-1"
    });
    expect(get).toHaveBeenCalledWith("artifact-1");
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ id: "artifact-1" }), "page-1", "input[type=file]", {
      id: "pi-browser:6"
    });
    expect(JSON.stringify(uploaded)).not.toContain("D:\\private");
    expect(JSON.stringify(uploaded)).toContain("transfer-1");
  });

  it("dispatches the extended interaction catalog to the provider without weakening its fence", async () => {
    const { bridge, actions, acquireAgentLease, releaseAgentLease } = fixture();

    await bridge.callTool("double_click", { page_id: "page-1", selector: "#double" });
    await bridge.callTool("right_click", { page_id: "page-1", selector: "#context" });
    await bridge.callTool("hover", { page_id: "page-1", selector: "#hover" });
    await bridge.callTool("drag", {
      page_id: "page-1",
      source_selector: "#source",
      target_selector: "#target"
    });
    await bridge.callTool("fill", { page_id: "page-1", selector: "#query", text: "safe text" });
    await bridge.callTool("press", { page_id: "page-1", key: "Enter" });
    await bridge.callTool("hotkey", {
      page_id: "page-1",
      key: "A",
      modifiers: ["Control", "Shift"]
    });
    await bridge.callTool("scroll", { page_id: "page-1", delta_x: -120.5, delta_y: 240 });
    await bridge.callTool("resize", { page_id: "page-1", width: 1_280, height: 720 });
    await bridge.callTool("wait", { page_id: "page-1", milliseconds: 250 });

    expect(actions).toEqual([
      { type: "doubleClick", selector: "#double" },
      { type: "rightClick", selector: "#context" },
      { type: "hover", selector: "#hover" },
      { type: "drag", sourceSelector: "#source", targetSelector: "#target" },
      { type: "fill", selector: "#query", text: "safe text" },
      { type: "press", key: "Enter" },
      { type: "hotkey", key: "A", modifiers: ["Control", "Shift"] },
      { type: "scroll", deltaX: -120.5, deltaY: 240 },
      { type: "resize", width: 1_280, height: 720 },
      { type: "wait", milliseconds: 250 }
    ]);
    expect(acquireAgentLease).toHaveBeenCalledTimes(10);
    expect(releaseAgentLease).toHaveBeenCalledTimes(10);
  });

  it("returns bounded in-memory captures and defensively redacted diagnostics", async () => {
    const {
      bridge,
      captureScreenshot,
      capturePdf,
      readConsoleMessages,
      readHttpRequestSummaries
    } = fixture();

    const screenshot = await bridge.callTool("screenshot", { page_id: "page-1", full_page: true });
    expect(captureScreenshot).toHaveBeenCalledWith("page-1", expect.objectContaining({ id: "lease-1" }), {
      fullPage: true
    });
    expect(screenshot.content).toContainEqual({
      type: "image",
      data: Buffer.from("standalone-png").toString("base64"),
      mimeType: "image/png"
    });

    const pdf = await bridge.callTool("pdf", { page_id: "page-1" });
    expect(capturePdf).toHaveBeenCalledWith("page-1", expect.objectContaining({ id: "lease-1" }));
    expect(JSON.stringify(pdf.content)).toContain(Buffer.from("pdf-bytes").toString("base64"));
    expect(JSON.stringify(pdf.content)).toContain("application/pdf");

    const consoleMessages = await bridge.callTool("console_messages", { page_id: "page-1", limit: 20 });
    const requests = await bridge.callTool("http_requests", { page_id: "page-1", limit: 30 });
    expect(readConsoleMessages).toHaveBeenCalledWith("page-1", expect.objectContaining({ id: "lease-1" }), {
      limit: 20
    });
    expect(readHttpRequestSummaries).toHaveBeenCalledWith("page-1", expect.objectContaining({ id: "lease-1" }), {
      limit: 30
    });
    expect(JSON.stringify(consoleMessages)).not.toContain("super-secret-browser-token");
    expect(JSON.stringify(consoleMessages)).toContain("redacted");
    expect(JSON.stringify(requests)).not.toContain("super-secret-browser-token");
    expect(JSON.stringify(requests)).not.toContain("authorization");
    expect(JSON.stringify(requests)).toContain("%5Bredacted%5D");
  });

  it("rejects malformed and unknown calls before reaching Playwright", async () => {
    const { bridge, actions } = fixture();
    await expect(bridge.callTool("navigate", { page_id: "", url: "https://example.test" })).rejects.toThrow(/page_id/u);
    await expect(bridge.callTool("navigate", {
      page_id: "page-1",
      url: "https://example.test/callback?access_token=secret"
    })).rejects.toThrow(/human takeover/u);
    await expect(bridge.callTool("type_text", {
      page_id: "page-1",
      selector: "input[type=password]",
      text: "do-not-persist"
    })).rejects.toThrow(/Credential fields/u);
    await expect(bridge.callTool("missing", {})).rejects.toThrow(/not available/u);
    expect(actions).toEqual([]);
  });

  it("rejects credential fields and values outside every extended action/read boundary", async () => {
    const { bridge, actions, captureScreenshot, capturePdf, readConsoleMessages } = fixture();

    await expect(bridge.callTool("fill", {
      page_id: "page-1",
      selector: "input[name=api_key]",
      text: "must-not-be-filled"
    })).rejects.toThrow(/Credential fields/u);
    await expect(bridge.callTool("press", { page_id: "page-1", key: "Control+A" })).rejects.toThrow(/separately/u);
    await expect(bridge.callTool("hotkey", {
      page_id: "page-1",
      key: "A",
      modifiers: ["Control", "Control"]
    })).rejects.toThrow(/modifiers/u);
    await expect(bridge.callTool("scroll", {
      page_id: "page-1",
      delta_x: 100_001,
      delta_y: 0
    })).rejects.toThrow(/delta_x/u);
    await expect(bridge.callTool("resize", {
      page_id: "page-1",
      width: 8_193,
      height: 720
    })).rejects.toThrow(/width/u);
    await expect(bridge.callTool("wait", {
      page_id: "page-1",
      milliseconds: 30_001
    })).rejects.toThrow(/milliseconds/u);
    await expect(bridge.callTool("screenshot", {
      page_id: "page-1",
      full_page: "yes"
    })).rejects.toThrow(/full_page/u);
    await expect(bridge.callTool("console_messages", {
      page_id: "page-1",
      limit: 101
    })).rejects.toThrow(/limit/u);
    await expect(bridge.callTool("hover", {
      page_id: "page-1",
      selector: "#safe",
      unexpected: true
    })).rejects.toThrow(/not allowed/u);

    captureScreenshot.mockResolvedValueOnce(new Uint8Array(10 * 1024 * 1024 + 1));
    await expect(bridge.callTool("screenshot", { page_id: "page-1" })).rejects.toThrow(/inline result limit/u);
    capturePdf.mockResolvedValueOnce(new Uint8Array(10 * 1024 * 1024 + 1));
    await expect(bridge.callTool("pdf", { page_id: "page-1" })).rejects.toThrow(/inline result limit/u);
    expect(actions).toEqual([]);
    expect(readConsoleMessages).not.toHaveBeenCalled();
  });
});

function browserBridgeAuthorityStore(): OperationalStore {
  const store = new OperationalStore(":memory:");
  store.upsertBackend({
    id: "pi",
    displayName: "Pi",
    version: "test",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  });
  for (const suffix of ["a", "b"] as const) {
    store.upsertTarget({
      id: `target-${suffix}`,
      backendId: "pi",
      displayName: `Workspace ${suffix}`,
      workspaceRoot: `D:/workspace-${suffix}`,
      managed: false,
      trusted: true
    });
    store.createSession({
      id: `session-${suffix}`,
      backendId: "pi",
      targetId: `target-${suffix}`,
      title: `Session ${suffix}`,
      binding: { opaqueRef: `session-${suffix}.jsonl`, generation: 1 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 1,
      updatedAt: 1
    });
  }
  return store;
}

function browserBridgeContext(
  requestSeed: string,
  sessionId: string,
  targetId: string,
  generation: number,
  providerGeneration: number,
  bodySeed = requestSeed
) {
  return {
    sessionId,
    targetId,
    generation,
    providerGeneration,
    requestIdentity: requestSeed.repeat(64),
    effectIdentity: bodySeed.repeat(64),
    requestBodyHash: `sha256:${bodySeed.repeat(64)}`
  };
}
