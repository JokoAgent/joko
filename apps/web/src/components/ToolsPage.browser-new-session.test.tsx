// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type AppSnapshot, type BrowserActivityView, type BrowserTransferView, type BrowserView, type NewSessionLocalDraft } from "../model.js";
import { ToolsPage } from "./ToolsPage.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  vi.restoreAllMocks();
});

describe("Tools Browser new-task annotations", () => {
  it("offers the exact image-capable new-task draft and opens that draft from comment mode", async () => {
    const draft: NewSessionLocalDraft = {
      selection: { kind: "target", targetId: "target-1" },
      nativeStart: { kind: "fresh" },
      providerId: "provider-1",
      modelId: "model-1",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      text: "Keep this prompt",
      editorDocument: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Keep this prompt" }] }] },
      mentions: [],
      attachments: []
    };
    const navigate = vi.fn();
    const controller = {
      state: {
        preferences: DEFAULT_UI_PREFERENCES,
        activeProfile: { id: "profile-1", serverId: "server-1" }
      },
      readNewSessionDraft: vi.fn(async () => draft),
      getArtifactUrl: vi.fn(async () => "data:image/png;base64,iVBORw0KGgo="),
      releaseArtifactUrl: vi.fn(),
      listBrowserActivity: vi.fn(async () => []),
      listBrowserTransfers: vi.fn(async () => []),
      inspectBrowserCommentTarget: vi.fn(async () => ({})),
      updateBrowserCommentDesign: vi.fn(async () => []),
      captureBrowserScreenshot: vi.fn(async () => "capture-1"),
      performBrowserTakeoverAction: vi.fn(async () => "capture-2"),
      restartBrowser: vi.fn(async () => undefined),
      endBrowserTakeover: vi.fn(async () => undefined),
      navigate
    } as unknown as AppController;
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    roots.push(root);

    await act(async () => root.render(<ToolsPage
      controller={controller}
      snapshot={snapshot()}
      locale="en"
      t={(key) => key}
      runAction={(_key, action) => { void action(); }}
      onOpenNavigation={() => undefined}
    />));
    await settle();

    await act(async () => required(host.querySelector<HTMLButtonElement>('[aria-label="browser.comment"]')).click());
    await settle();
    const target = required(host.querySelector<HTMLSelectElement>(".browser-comment-panel select"));
    expect([...target.options].map((option) => [option.value, option.textContent])).toEqual([
      ["", "browser.commentChooseTask"],
      [JSON.stringify(["newSession"]), "browser.commentNewTaskDraft"]
    ]);
    expect(target.value).toBe(JSON.stringify(["newSession"]));

    await act(async () => buttonWithText(host, "browser.commentOpenTask").click());
    expect(navigate).toHaveBeenCalledExactlyOnceWith({ kind: "newSession" });
  });
});

it("keeps the selected Browser page's ledger when a previous page finishes refreshing", async () => {
  const initial = snapshot();
  const browser = initial.browsers[0]!;
  const firstPage = browser.pages[0]!;
  const secondPage = { ...firstPage, id: "page-2", title: "Second page", url: "https://example.test/second" };
  const transfer: BrowserTransferView = {
    id: "transfer-1", browserId: browser.id, pageId: firstPage.id, direction: "download", state: "completed",
    blobId: "blob-first", fileName: "first-page.txt", mediaType: "text/plain", byteSize: 12, startedAt: 0
  };
  const activity: BrowserActivityView = {
    id: "activity-1", pageId: firstPage.id, kind: "download", description: "First page download", occurredAt: 0
  };
  const lateTransfers = deferred<readonly BrowserTransferView[]>();
  const lateActivity = deferred<readonly BrowserActivityView[]>();
  const listBrowserTransfers = vi.fn(async (_browserId: string, pageId: string) => pageId === firstPage.id ? lateTransfers.promise : [])
    .mockResolvedValueOnce([transfer]);
  const listBrowserActivity = vi.fn(async (_browserId: string, pageId: string) => pageId === firstPage.id ? lateActivity.promise : [])
    .mockResolvedValueOnce([activity]);
  const focusBrowserPage = vi.fn(async (_browserId: string, pageId: string) => pageId);
  const downloadArtifact = vi.fn();
  const controller = {
    state: { preferences: DEFAULT_UI_PREFERENCES, activeProfile: { id: "profile-1", serverId: "server-1" } },
    readNewSessionDraft: vi.fn(async () => undefined), getArtifactUrl: vi.fn(async () => "data:image/png;base64,iVBORw0KGgo="),
    releaseArtifactUrl: vi.fn(), listBrowserTransfers, listBrowserActivity, focusBrowserPage, downloadArtifact
  } as unknown as AppController;
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);

  await act(async () => root.render(<ToolsPage controller={controller}
    snapshot={{ ...initial, browsers: [{ ...browser, pages: [firstPage, secondPage] }] }} locale="en" t={(key) => key}
    runAction={(_key, action) => { void action(); }} onOpenNavigation={() => undefined} />));
  const ledger = () => required(host.querySelector(".browser-ledger"));
  expect(ledger().textContent).toContain(transfer.fileName);
  await act(async () => buttonWithText(ledger(), "common.refresh").click());
  expect(listBrowserTransfers).toHaveBeenCalledTimes(2);
  await act(async () => required(host.querySelector<HTMLButtonElement>(`button[title="${secondPage.url}"]`)).click());
  expect(focusBrowserPage).toHaveBeenCalledWith(browser.id, secondPage.id);
  expect(listBrowserTransfers).toHaveBeenLastCalledWith(browser.id, secondPage.id);
  expect(ledger().textContent).toContain("browser.noTransfers");
  await act(async () => {
    lateTransfers.resolve([transfer]);
    lateActivity.resolve([activity]);
  });
  expect(ledger().textContent).not.toContain(transfer.fileName);
  expect(ledger().textContent).not.toContain(activity.description);
  expect(ledger().querySelector('button[title="common.download"]')).toBeNull();
  expect(downloadArtifact).not.toHaveBeenCalled();
});

function snapshot(): AppSnapshot {
  const initial = emptySnapshot();
  const browser: BrowserView = {
    id: "browser-1",
    name: "Browser",
    state: "ready",
    generation: 1n,
    activePageId: "page-1",
    takeover: {
      id: "takeover-1",
      pageId: "page-1",
      connectionId: "profile-1",
      state: "active",
      generation: 1n
    },
    pages: [{
      id: "page-1",
      title: "Page",
      url: "https://example.test/page",
      state: "ready",
      screenshotBlobId: "screenshot-1",
      canGoBack: false,
      canGoForward: false,
      recoverable: false,
      lastKnownGeneration: 1n
    }]
  };
  return {
    ...initial,
    backends: [{
      id: "backend-1",
      name: "Backend",
      version: "1",
      health: "healthy",
      capabilities: new Map([
        ["input.text", { name: "input.text", supported: true, options: [] }],
        ["input.image", { name: "input.image", supported: true, options: [], maximumItems: 4 }]
      ])
    }],
    targets: [{
      id: "target-1",
      revision: 1n,
      backendId: "backend-1",
      name: "Project",
      workspaceId: "workspace-1",
      workspaceName: "Project",
      trusted: true,
      pinned: false,
      archived: false
    }],
    models: [{
      backendId: "backend-1",
      providerId: "provider-1",
      providerName: "Provider",
      modelId: "model-1",
      name: "Image model",
      available: true,
      supportsImages: true,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      supportsFast: false,
      efforts: [],
      contextWindow: 8_192,
      maximumOutputTokens: 2_048,
      inputCostMicrosPerMillion: 0,
      outputCostMicrosPerMillion: 0,
      currencyCode: "USD"
    }],
    browsers: [browser]
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

function buttonWithText(container: ParentNode, text: string): HTMLButtonElement {
  return required([...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === text));
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected value.");
  return value;
}
