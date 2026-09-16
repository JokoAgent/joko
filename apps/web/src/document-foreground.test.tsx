// @vitest-environment jsdom

import { act, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useDocumentForeground } from "./document-foreground.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");

afterEach(() => {
  document.body.replaceChildren();
  if (originalVisibilityState === undefined) {
    Reflect.deleteProperty(document, "visibilityState");
  } else {
    Object.defineProperty(document, "visibilityState", originalVisibilityState);
  }
  vi.restoreAllMocks();
});

describe("renderer Document foreground", () => {
  it("requires visible focus and retires through blur and pagehide", async () => {
    let focused = false;
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    const mounted = await mountProbe(document);
    expect(mounted.value()).toBe("background");

    focused = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(mounted.value()).toBe("foreground");
    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(mounted.value()).toBe("background");

    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(mounted.value()).toBe("background");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(mounted.value()).toBe("background");
    await act(async () => window.dispatchEvent(new Event("pageshow")));
    expect(mounted.value()).toBe("foreground");

    visibility = "hidden";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(mounted.value()).toBe("background");
    await mounted.unmount();
  });

  it("listens only to the supplied owner Document realm", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const frame = document.body.appendChild(document.createElement("iframe"));
    const frameDocument = required(frame.contentDocument);
    const frameWindow = required(frame.contentWindow);
    let frameFocused = false;
    vi.spyOn(frameDocument, "hasFocus").mockImplementation(() => frameFocused);
    Object.defineProperty(frameDocument, "visibilityState", { configurable: true, value: "visible" });
    const mounted = await mountProbe(frameDocument);
    expect(mounted.value()).toBe("background");

    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(mounted.value()).toBe("background");
    frameFocused = true;
    const FrameEvent = (frameWindow as Window & typeof globalThis).Event;
    await act(async () => frameWindow.dispatchEvent(new FrameEvent("focus")));
    expect(mounted.value()).toBe("foreground");
    await mounted.unmount();
  });
});

function Probe({ ownerDocument }: { readonly ownerDocument: Document }): JSX.Element {
  return <output>{useDocumentForeground(ownerDocument) ? "foreground" : "background"}</output>;
}

async function mountProbe(ownerDocument: Document): Promise<{
  readonly value: () => string | null;
  readonly unmount: () => Promise<void>;
}> {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(<Probe ownerDocument={ownerDocument} />));
  return {
    value: () => host.querySelector("output")?.textContent ?? null,
    unmount: async () => act(async () => root.unmount())
  };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected test value");
  return value;
}
