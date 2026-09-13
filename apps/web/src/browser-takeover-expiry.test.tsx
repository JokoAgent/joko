// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "./controller.js";
import { DEFAULT_UI_PREFERENCES } from "./local-state.js";
import { emptySnapshot, type BrowserTakeoverView, type BrowserView } from "./model.js";
import { useLiveBrowserTakeover } from "./browser-takeover-expiry.js";
import { ToolsPage } from "./components/ToolsPage.js";

const roots: Root[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("browser takeover expiry", () => {
  it("keeps an authoritative takeover live when the Provider omits a deadline", () => {
    const value = { ...takeover(11_000), expiresAt: undefined };
    const mounted = mount(value, "page-1");
    expect(mounted.host.textContent).toBe("active:owned");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("converges to inactive at the authoritative expiry without another snapshot", () => {
    const mounted = mount(takeover(11_000), "page-1");
    expect(mounted.host.textContent).toBe("active:owned");

    act(() => vi.advanceTimersByTime(999));
    expect(mounted.host.textContent).toBe("active:owned");
    act(() => vi.advanceTimersByTime(1));
    expect(mounted.host.textContent).toBe("inactive");
  });

  it("replaces the old deadline when the same takeover is renewed", () => {
    const mounted = mount(takeover(11_000), "page-1");
    act(() => vi.advanceTimersByTime(500));
    act(() => mounted.root.render(<Harness takeover={takeover(12_000)} pageId="page-1" />));

    act(() => vi.advanceTimersByTime(500));
    expect(mounted.host.textContent).toBe("active:owned");
    act(() => vi.advanceTimersByTime(999));
    expect(mounted.host.textContent).toBe("active:owned");
    act(() => vi.advanceTimersByTime(1));
    expect(mounted.host.textContent).toBe("inactive");
  });

  it("keeps the deadline while page selection changes and clears it on unmount", () => {
    const mounted = mount(takeover(15_000), "page-1");
    expect(vi.getTimerCount()).toBe(1);

    act(() => mounted.root.render(<Harness takeover={takeover(15_000)} pageId="page-2" />));
    expect(mounted.host.textContent).toBe("active:other");
    expect(vi.getTimerCount()).toBe(1);

    act(() => mounted.root.unmount());
    roots.splice(roots.indexOf(mounted.root), 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns the Browser tools surface to non-control actions at expiry", async () => {
    const base = emptySnapshot();
    const browser: BrowserView = {
      id: "browser",
      name: "Browser",
      state: "ready",
      generation: 7n,
      takeover: takeover(11_000),
      pages: [{
        id: "page-1",
        title: "Example",
        url: "https://example.test/",
        state: "ready",
        canGoBack: false,
        canGoForward: false,
        recoverable: false,
        lastKnownGeneration: 7n
      }]
    };
    const controller = {
      state: {
        activeProfile: { id: "connection-1" },
        preferences: DEFAULT_UI_PREFERENCES
      },
      listBrowserActivity: vi.fn(async () => []),
      listBrowserTransfers: vi.fn(async () => []),
      updateBrowserCommentDesign: vi.fn(async () => []),
      releaseArtifactUrl: vi.fn()
    } as unknown as AppController;
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(<ToolsPage
      controller={controller}
      snapshot={{ ...base, browsers: [browser] }}
      locale="en"
      t={(key) => key}
      runAction={(_key, action) => { void action(); }}
      onOpenNavigation={vi.fn()}
    />));

    expect(host.textContent).toContain("browser.remoteControlActive");
    expect(host.textContent).toContain("browser.release");
    act(() => vi.advanceTimersByTime(1_000));
    expect(host.textContent).toContain("browser.remoteControlInactive");
    expect(host.textContent).toContain("browser.takeover");
    expect(host.textContent).not.toContain("browser.release");
  });
});

function mount(value: BrowserTakeoverView, pageId: string): { readonly host: HTMLDivElement; readonly root: Root } {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<Harness takeover={value} pageId={pageId} />));
  return { host, root };
}

function Harness({ takeover: value, pageId }: { readonly takeover?: BrowserTakeoverView; readonly pageId: string }) {
  const live = useLiveBrowserTakeover(value);
  if (live === undefined) return <>inactive</>;
  return <>{live.state}:{live.pageId === pageId ? "owned" : "other"}</>;
}

function takeover(expiresAt: number): BrowserTakeoverView {
  return {
    id: "takeover-1",
    pageId: "page-1",
    connectionId: "connection-1",
    state: "active",
    generation: 7n,
    startedAt: 9_000,
    expiresAt
  };
}
