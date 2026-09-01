// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { translate } from "../i18n.js";
import { DesktopPageSearchBar } from "./DesktopPageSearchBar.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    queueMicrotask(() => callback(0));
    return 1;
  });
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "jokoDesktop");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  vi.restoreAllMocks();
});

describe("DesktopPageSearchBar", () => {
  it("searches, rejects late results, navigates in both directions, and restores focus", async () => {
    const host = desktopSearchHost();
    const returnFocus = document.createElement("button");
    document.body.append(returnFocus);
    returnFocus.focus();
    await render(host.api);

    await pressFindShortcut();
    const input = document.querySelector<HTMLInputElement>('[role="search"] input')!;
    expect(document.activeElement).toBe(input);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "needle");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.start).toHaveBeenLastCalledWith({ text: "needle", forward: true, findNext: false, requestToken: 1 });

    await act(async () => host.publish({ requestId: 8, requestToken: 99, matches: 41, activeMatchOrdinal: 40, finalUpdate: true }));
    expect(document.querySelector("[aria-live='polite']")?.textContent).toBe("0/0");
    await act(async () => host.publish({ requestId: 9, requestToken: 1, matches: 4, activeMatchOrdinal: 2, finalUpdate: true }));
    expect(document.querySelector("[aria-live='polite']")?.textContent).toBe("2/4");

    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(host.start).toHaveBeenLastCalledWith({ text: "needle", forward: true, findNext: true, requestToken: 2 });
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })));
    expect(host.start).toHaveBeenLastCalledWith({ text: "needle", forward: false, findNext: true, requestToken: 3 });

    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.stop).toHaveBeenCalledWith("clearSelection");
    expect(document.querySelector('[role="search"]')).toBeNull();
    expect(document.activeElement).toBe(returnFocus);
  });

  it("leaves the shortcut to an active document search but ignores an owner behind an inert overlay", async () => {
    const host = desktopSearchHost();
    await render(host.api);
    const owner = document.createElement("section");
    owner.dataset.localPageSearchOwner = "true";
    document.body.append(owner);

    const event = new KeyboardEvent("keydown", { key: "f", code: "KeyF", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => window.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector('[role="search"]')).toBeNull();
    expect(host.start).not.toHaveBeenCalled();

    const hiddenDocument = document.createElement("div");
    hiddenDocument.setAttribute("inert", "");
    hiddenDocument.append(owner);
    document.body.append(hiddenDocument);
    await pressFindShortcut();

    expect(document.querySelector('[role="search"] input')).not.toBeNull();
  });
});

async function render(api: JokoDesktopApi): Promise<void> {
  Object.defineProperty(window, "jokoDesktop", { configurable: true, value: api });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<DesktopPageSearchBar overrides={{}} t={(key, values) => translate("en", key, values)} />));
}

async function pressFindShortcut(): Promise<void> {
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", {
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    bubbles: true,
    cancelable: true
  })));
}

function desktopSearchHost(): {
  readonly api: JokoDesktopApi;
  readonly start: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
  readonly publish: (result: Parameters<Parameters<JokoDesktopApi["pageSearch"]["onResult"]>[0]>[0]) => void;
} {
  let listener: Parameters<JokoDesktopApi["pageSearch"]["onResult"]>[0] | undefined;
  const start = vi.fn(async () => 1);
  const stop = vi.fn(async () => undefined);
  return {
    api: {
      platform: "win32",
      capabilities: ["page.search"],
      pageSearch: {
        start,
        stop,
        onResult: (next: Parameters<JokoDesktopApi["pageSearch"]["onResult"]>[0]) => {
          listener = next;
          return () => { listener = undefined; };
        }
      }
    } as unknown as JokoDesktopApi,
    start,
    stop,
    publish: (result) => listener?.(result)
  };
}
