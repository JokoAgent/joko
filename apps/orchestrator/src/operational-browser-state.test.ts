import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { describe, expect, it } from "vitest";

import { OperationalBrowserState } from "./operational-browser-state.js";

describe("OperationalBrowserState", () => {
  it("restores a bounded public activity log across process composition", () => {
    const store = new OperationalStore(":memory:");
    const first = new OperationalBrowserState(store, 2);
    first.recordActivity({ at: 1, type: "started", detail: "Browser generation 1 started." });
    first.recordActivity({ at: 2, type: "navigation", pageId: "page-1", detail: "https://example.test/" });
    first.recordActivity({ at: 3, type: "action", pageId: "page-1", detail: "click" });

    const restored = new OperationalBrowserState(store, 2);
    expect(restored.activities).toEqual([
      { at: 2, type: "navigation", pageId: "page-1", detail: "https://example.test/" },
      { at: 3, type: "action", pageId: "page-1", detail: "click" }
    ]);
    store.close();
  });

  it("persists path-free transfers and generation-fenced screenshot references", () => {
    const store = new OperationalStore(":memory:");
    const state = new OperationalBrowserState(store);
    state.put({
      id: "transfer-one",
      browserProviderId: "browser",
      pageId: "page-1",
      toolCallId: "call-1",
      direction: contract.TransferDirection.DOWNLOAD,
      initiatedAt: 10,
      generation: 3,
      state: contract.BrowserTransferState.COMPLETED,
      blob: { id: "artifact-one", sha256: "a".repeat(64), byteLength: 5, mimeType: "image/png", fileName: "capture.png" },
      artifact: { id: "artifact-one", sha256: "a".repeat(64), byteLength: 5, mimeType: "image/png", fileName: "capture.png", createdAt: 10 }
    });
    state.recordScreenshot({
      browserProviderId: "browser",
      pageId: "page-1",
      generation: 3,
      artifactId: "artifact-one",
      blob: { id: "artifact-one", sha256: "a".repeat(64), byteLength: 5, mimeType: "image/png", fileName: "capture.png" },
      capturedAt: 10
    });

    expect(new OperationalBrowserState(store).list("browser")).toHaveLength(1);
    expect(state.findScreenshot("browser", "page-1", 3)?.artifactId).toBe("artifact-one");
    expect(state.findScreenshot("browser", "page-1", 4)).toBeUndefined();
    expect(JSON.stringify(store.listSettings(), (_key, value) => typeof value === "bigint" ? value.toString(10) : value))
      .not.toContain("storagePath");
    store.close();
  });

  it("rejects incomplete or malformed persisted activity logs", () => {
    const store = new OperationalStore(":memory:");
    for (const value of [
      { entries: [] },
      { version: 2, entries: [] },
      { version: 1 },
      { version: 1, entries: [{ at: 1, type: "started", detail: "started", pageId: null }] }
    ]) {
      store.setSetting("service", "orchestrator", "browser_activity.v1", value);
      expect(() => new OperationalBrowserState(store)).toThrow(/activity log/u);
    }
    store.close();
  });

  it("persists recoverable human page descriptors and the active logical page", () => {
    const store = new OperationalStore(":memory:");
    const first = new OperationalBrowserState(store);
    first.recordHumanPage({
      browserProviderId: "browser",
      pageId: "page-7-1",
      generation: 7,
      sessionId: "session-1",
      targetId: "target-1",
      bindingGeneration: 1,
      url: "https://example.test/docs",
      title: "Docs",
      updatedAt: 10
    }, { active: true });
    first.recordHumanPage({
      browserProviderId: "browser",
      pageId: "page-7-2",
      generation: 7,
      sessionId: "session-1",
      targetId: "target-1",
      bindingGeneration: 1,
      url: "about:blank",
      title: "New page",
      updatedAt: 20
    }, { active: true });

    const restored = new OperationalBrowserState(store);
    expect(restored.lastBrowserGeneration("browser")).toBe(7);
    expect(restored.activePageId("browser")).toBe("page-7-2");
    expect(restored.recoverablePages("browser", new Set(["page-7-1"]))).toEqual([
      expect.objectContaining({ pageId: "page-7-2", url: "about:blank", state: "open" })
    ]);

    restored.closeHumanPage("browser", "page-7-2", 7, "page-7-1");
    expect(new OperationalBrowserState(store).recoverablePages("browser", new Set())).toEqual([
      expect.objectContaining({ pageId: "page-7-1", state: "open" })
    ]);
    store.close();
  });

  it("rejects incomplete or malformed persisted page catalogs", () => {
    const store = new OperationalStore(":memory:");
    for (const value of [
      { version: 1, openEntries: [], lastGenerations: [] },
      { version: 1, openEntries: [], activePages: [] },
      { version: 1, openEntries: [], activePages: {}, lastGenerations: [] },
      { version: 1, openEntries: [], activePages: [], lastGenerations: [{}] },
      { version: 2, openEntries: [], activePages: [], lastGenerations: [] }
    ]) {
      store.setSetting("service", "orchestrator", "browser_pages.v1", value);
      expect(() => new OperationalBrowserState(store)).toThrow(/page catalog/u);
    }
    store.close();
  });

  it("retains 101 open pages, the oldest active page, and the generation watermark across restart", () => {
    const store = new OperationalStore(":memory:");
    const state = new OperationalBrowserState(store);
    for (let index = 0; index < 101; index += 1) {
      state.recordHumanPage(humanPage(`page-${index}`, index + 1, index + 1), { active: index === 0 });
    }

    const restored = new OperationalBrowserState(store);
    expect(restored.recoverablePages("browser", new Set())).toHaveLength(101);
    expect(restored.findRecoverablePage("browser", "page-0")).toMatchObject({ state: "open", generation: 1 });
    expect(restored.activePageId("browser")).toBe("page-0");
    expect(restored.lastBrowserGeneration("browser")).toBe(101);

    restored.closeHumanPage("browser", "page-0", 1, "page-100");
    const restarted = new OperationalBrowserState(store);
    expect(restarted.recoverablePages("browser", new Set())).toHaveLength(100);
    expect(restarted.findRecoverablePage("browser", "page-0")).toBeUndefined();
    expect(restarted.activePageId("browser")).toBe("page-100");
    expect(restarted.lastBrowserGeneration("browser")).toBe(101);
    store.close();
  });

  it("collapses closed page history into a bounded per-provider generation watermark", () => {
    const store = new OperationalStore(":memory:");
    const state = new OperationalBrowserState(store);
    for (let generation = 1; generation <= 150; generation += 1) {
      const pageId = `closed-page-${generation}`;
      state.recordHumanPage(humanPage(pageId, generation, generation), { active: true });
      state.closeHumanPage("browser", pageId, generation);
    }

    const restored = new OperationalBrowserState(store);
    expect(restored.recoverablePages("browser", new Set())).toEqual([]);
    expect(restored.activePageId("browser")).toBeUndefined();
    expect(restored.lastBrowserGeneration("browser")).toBe(150);
    const persisted = store.findSetting<unknown>("service", "orchestrator", "browser_pages.v1")?.value;
    expect(persisted).toMatchObject({
      version: 1,
      openEntries: [],
      activePages: [],
      lastGenerations: [{ browserProviderId: "browser", generation: 150 }]
    });
    expect(JSON.stringify(persisted)).not.toContain("closed-page-");
    store.close();
  });

  it("rejects credential-shaped recovery URLs before persistence", () => {
    const store = new OperationalStore(":memory:");
    const state = new OperationalBrowserState(store);
    expect(() => state.recordHumanPage({
      browserProviderId: "browser",
      pageId: "page-1-1",
      generation: 1,
      sessionId: "session-1",
      targetId: "target-1",
      bindingGeneration: 1,
      url: "https://example.test/?access_token=secret",
      title: "Unsafe",
      updatedAt: 10
    }, { active: true })).toThrow(/invalid/u);
    expect(JSON.stringify(store.listSettings())).not.toContain("secret");
    store.close();
  });

  it("claims Browser page creation before the effect and atomically commits its full owner descriptor", () => {
    const store = browserAuthorityStore();
    const state = new OperationalBrowserState(store);
    const authority = bridgeAuthority("a");
    const claim = state.claimBrowserPageOpen<{ readonly pageId: string }>(authority);

    expect(claim).toMatchObject({ replayed: false });
    expect(() => state.claimBrowserPageOpen(authority)).toThrow(/in progress/u);

    const result = state.completeBrowserPageOpen(claim, authority, {
      browserProviderId: "browser",
      pageId: "page-1-1",
      generation: 1,
      sessionId: "session-1",
      targetId: "target-1",
      bindingGeneration: 1,
      url: "https://example.test/owned",
      title: "Owned",
      updatedAt: 20
    }, { pageId: "page-1-1" });

    expect(result).toEqual({ pageId: "page-1-1" });
    const restarted = new OperationalBrowserState(store);
    expect(restarted.findRecoverablePage("browser", "page-1-1")).toMatchObject({
      sessionId: "session-1",
      targetId: "target-1",
      bindingGeneration: 1,
      generation: 1
    });
    expect(restarted.claimBrowserPageOpen<{ readonly pageId: string }>(authority)).toMatchObject({
      replayed: true,
      value: { pageId: "page-1-1" }
    });
    expect(() => state.claimBrowserPageOpen({
      ...authority,
      effectIdentity: "b".repeat(64),
      requestBodyHash: `sha256:${"b".repeat(64)}`
    })).toThrow();

    const session = store.getSession("session-1");
    store.updateSession("session-1", { archived: true }, session.revision, 30);
    expect(() => state.assertPageAuthority({
      browserProviderId: "browser",
      pageId: "page-1-1",
      browserGeneration: 1,
      sessionId: "session-1",
      targetId: "target-1",
      bindingGeneration: 1
    })).toThrow(/authority/u);
    expect(() => state.claimBrowserPageOpen(authority)).toThrow(/authority/u);
    store.close();
  });

  it("tombstones an interrupted Browser page effect as outcome-unknown without adopting a page", () => {
    const store = browserAuthorityStore();
    const state = new OperationalBrowserState(store);
    const authority = bridgeAuthority("c");
    const claim = state.claimBrowserPageOpen(authority);

    expect(store.recoverStartup("browser-effect-recovery").recoveredEffectOperationIds).toEqual([claim.operationId]);
    const restarted = new OperationalBrowserState(store);
    expect(restarted.recoverablePages("browser", new Set())).toEqual([]);
    expect(() => restarted.claimBrowserPageOpen(authority)).toThrow(/previously failed/u);
    store.close();
  });
});

function humanPage(pageId: string, generation: number, updatedAt: number) {
  return {
    browserProviderId: "browser",
    pageId,
    generation,
    sessionId: "session-1",
    targetId: "target-1",
    bindingGeneration: 1,
    url: `https://example.test/${pageId}`,
    title: pageId,
    updatedAt
  };
}

function browserAuthorityStore(): OperationalStore {
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
  store.upsertTarget({
    id: "target-1",
    backendId: "pi",
    displayName: "Workspace",
    workspaceRoot: "D:/workspace",
    managed: false,
    trusted: true
  });
  store.createSession({
    id: "session-1",
    backendId: "pi",
    targetId: "target-1",
    title: "Session",
    binding: { opaqueRef: "session.jsonl", generation: 1 },
    pinned: false,
    archived: false,
    permissionMode: "ask",
    planMode: false,
    fastMode: false,
    createdAt: 1,
    updatedAt: 1
  });
  return store;
}

function bridgeAuthority(seed: string) {
  return {
    sessionId: "session-1",
    targetId: "target-1",
    bindingGeneration: 1,
    requestIdentity: seed.repeat(64),
    effectIdentity: seed.repeat(64),
    requestBodyHash: `sha256:${seed.repeat(64)}`,
    browserProviderId: "browser",
    providerGeneration: 1
  };
}
