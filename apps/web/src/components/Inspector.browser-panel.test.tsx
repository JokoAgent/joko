// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController, BrowserInspectorFocusRequest } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import type { BrowserView, SessionView } from "../model.js";
import { BrowserPanel } from "./Inspector.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("Inspector Browser panel", () => {
  const session = { id: "session-one", name: "Current task" } as SessionView;

  it("reveals the exact Provider and page and lets the user switch Providers", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    roots.push(root);
    const second = browser("browser-b", "Second Provider", "page-b", "Second Page");
    const browsers = [browser("browser-a", "First Provider", "page-a", "First Page"), {
      ...second,
      pages: [...second.pages, { ...second.pages[0]!, id: "other-page", sessionId: "other-session", title: "Other task page" }]
    }];
    const request: BrowserInspectorFocusRequest = { sessionId: "session-one", browserId: "browser-b", pageId: "page-b", requestId: 1 };
    const controller = {
      state: { preferences: DEFAULT_UI_PREFERENCES },
      releaseArtifactUrl: vi.fn(),
      restartBrowser: vi.fn(async () => undefined),
      endBrowserTakeover: vi.fn(async () => undefined),
      captureBrowserScreenshot: vi.fn(async () => "capture"),
      updateBrowserCommentDesign: vi.fn(async () => []),
      uploadBrowserFile: vi.fn(async () => undefined),
      performBrowserTakeoverAction: vi.fn(async () => "capture-action")
    } as unknown as AppController;

    await act(async () => root.render(<BrowserPanel
      controller={controller}
      browsers={browsers}
      browserSettings={[]}
      session={session}
      commentSessions={[]}
      locale="en"
      focusRequest={request}
      t={(key) => key}
      runAction={(_key, action) => { void action(); }}
    />));
    await settle();

    expect(host.querySelector(".browser-provider-card strong")?.textContent).toBe("Second Provider");
    expect(host.querySelector(".browser-chrome__omnibox button")?.textContent).toBe("https://page-b.example.test/");
    expect(host.textContent).not.toContain("Other task page");

    const nativeSelect = host.querySelector<HTMLSelectElement>("select.select-control__native-bridge");
    expect(nativeSelect).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(nativeSelect, "browser-a");
      nativeSelect?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();

    expect(host.querySelector(".browser-provider-card strong")?.textContent).toBe("First Provider");
    expect(host.querySelector(".browser-chrome__omnibox button")?.textContent).toBe("https://page-a.example.test/");
  });

  it("uses the real Browser canvas for address, pointer, keyboard, and text input", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    roots.push(root);
    const source = browser("browser-a", "Provider", "page-a", "Page");
    const browsers: readonly BrowserView[] = [{
      ...source,
      takeover: {
        id: "takeover-one",
        pageId: "page-a",
        connectionId: "connection-one",
        state: "active",
        generation: 1n
      },
      pages: [{ ...source.pages[0]!, screenshotBlobId: "shot-one" }]
    }];
    const perform = vi.fn(async () => `capture-${perform.mock.calls.length}`);
    const controller = {
      state: { preferences: DEFAULT_UI_PREFERENCES, activeProfile: { id: "connection-one" } },
      getArtifactUrl: vi.fn(async () => "data:image/png;base64,iVBORw0KGgo="),
      releaseArtifactUrl: vi.fn(),
      restartBrowser: vi.fn(async () => undefined),
      endBrowserTakeover: vi.fn(async () => undefined),
      captureBrowserScreenshot: vi.fn(async () => "capture"),
      updateBrowserCommentDesign: vi.fn(async () => []),
      uploadBrowserFile: vi.fn(async () => undefined),
      performBrowserTakeoverAction: perform
    } as unknown as AppController;

    await act(async () => root.render(<BrowserPanel
      controller={controller}
      browsers={browsers}
      browserSettings={[]}
      session={session}
      commentSessions={[]}
      locale="en"
      t={(key) => key}
      runAction={(_key, action) => { void action(); }}
    />));
    await settle();

    const omniboxButton = host.querySelector<HTMLButtonElement>(".browser-chrome__omnibox button");
    expect(omniboxButton).not.toBeNull();
    expect(omniboxButton?.disabled, host.innerHTML).toBe(false);
    await act(async () => omniboxButton?.click());
    await settle();
    const omnibox = host.querySelector<HTMLInputElement>("input[aria-label='browser.address']");
    expect(omnibox).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(omnibox, "example.org");
      omnibox?.dispatchEvent(new Event("input", { bubbles: true }));
      omnibox?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();
    expect(perform).toHaveBeenCalledWith("browser-a", "page-a", { kind: "navigate", url: "https://example.org" });

    const canvas = host.querySelector<HTMLCanvasElement>(".remote-browser canvas");
    expect(canvas).not.toBeNull();
    Object.defineProperty(canvas, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }) });
    Object.defineProperty(canvas, "setPointerCapture", { value: vi.fn() });
    Object.defineProperty(canvas, "hasPointerCapture", { value: () => false });
    await act(async () => {
      canvas?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 50, clientY: 25, button: 0 }));
      canvas?.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 50, clientY: 25, button: 0 }));
    });
    await settle();
    expect(perform).toHaveBeenCalledWith("browser-a", "page-a", expect.objectContaining({ kind: "mouseClick", normalizedX: 0.5, normalizedY: 0.25 }));

    await act(async () => canvas?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await settle();
    expect(perform).toHaveBeenCalledWith("browser-a", "page-a", { kind: "keyPress", key: "enter" });

    const textInput = host.querySelector<HTMLInputElement>(".remote-browser__controls form input");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(textInput, "hello");
      textInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => textInput?.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(perform).toHaveBeenCalledWith("browser-a", "page-a", { kind: "textInput", text: "hello" });
  });
});

function browser(id: string, name: string, pageId: string, pageTitle: string): BrowserView {
  return {
    id,
    name,
    state: "ready",
    generation: 1n,
    activePageId: pageId,
    pages: [{
      id: pageId,
      sessionId: "session-one",
      title: pageTitle,
      url: `https://${pageId}.example.test/`,
      state: "ready",
      canGoBack: false,
      canGoForward: false,
      recoverable: false,
      lastKnownGeneration: 1n
    }]
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}
