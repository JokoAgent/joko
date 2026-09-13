// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import type { BrowserView, SessionView } from "../model.js";
import { BrowserPageRail } from "./BrowserPageRail.js";
import type { RunAction, Translator } from "./types.js";

const roots: Root[] = [];
const t: Translator = (key) => key;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("BrowserPageRail", () => {
  it("routes new, focus, close, and recovery through typed controller lifecycle methods", async () => {
    const controller = {
      state: { activeProfile: { id: "connection-1" } },
      openBrowserPage: vi.fn(async () => "page-new"),
      focusBrowserPage: vi.fn(async () => "page-2"),
      closeBrowserPage: vi.fn(async () => "page-1"),
      recoverBrowserPage: vi.fn(async () => "page-restored"),
      beginBrowserTakeover: vi.fn(async () => undefined)
    } as unknown as AppController;
    const onSelect = vi.fn();
    const runAction: RunAction = (_key, action) => { void action(); };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(<BrowserPageRail
      browser={browser()}
      selectedPageId="page-1"
      sessions={[{ id: "session-1", name: "Task" } as SessionView]}
      controller={controller}
      t={t}
      runAction={runAction}
      onSelect={onSelect}
    />));

    await act(async () => item(host, "Two").querySelector<HTMLButtonElement>("button")?.click());
    expect(controller.focusBrowserPage).toHaveBeenCalledWith("browser", "page-2");

    await act(async () => item(host, "Two").querySelector<HTMLButtonElement>('[aria-label="browser.closePage"]')?.click());
    expect(controller.closeBrowserPage).toHaveBeenCalledWith("browser", "page-2");

    await act(async () => item(host, "Lost").querySelector<HTMLButtonElement>('[aria-label="browser.restorePage"]')?.click());
    expect(controller.recoverBrowserPage).toHaveBeenCalledWith("browser", "session-1", "page-lost", "https://lost.test/");

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="browser.addPage"]')?.click());
    expect(controller.openBrowserPage).toHaveBeenCalledWith("browser", "session-1", "about:blank");
  });
});

function browser(): BrowserView {
  return {
    id: "browser",
    name: "Browser",
    state: "ready",
    generation: 7n,
    activePageId: "page-1",
    takeover: { id: "takeover-1", pageId: "page-1", connectionId: "connection-1", state: "active", generation: 7n },
    pages: [
      { id: "page-1", title: "One", url: "https://one.test/", state: "ready", canGoBack: false, canGoForward: false, recoverable: false, lastKnownGeneration: 7n },
      { id: "page-2", title: "Two", url: "https://two.test/", state: "ready", canGoBack: false, canGoForward: false, recoverable: false, lastKnownGeneration: 7n },
      { id: "page-lost", title: "Lost", url: "https://lost.test/", state: "closed", canGoBack: false, canGoForward: false, recoverable: true, lastKnownGeneration: 6n }
    ]
  };
}

function item(host: HTMLElement, title: string): HTMLElement {
  const result = [...host.querySelectorAll<HTMLElement>(".browser-page-rail__item")]
    .find((candidate) => candidate.textContent?.includes(title));
  if (result === undefined) throw new Error(`Missing Browser page item ${title}`);
  return result;
}
