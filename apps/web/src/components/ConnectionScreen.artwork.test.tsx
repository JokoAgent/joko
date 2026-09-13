// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CONNECTION_ARTWORK_GROUPS } from "../connection-artwork.js";
import type { AppController } from "../controller.js";
import type { Translator } from "./types.js";
import { ConnectionScreen } from "./ConnectionScreen.js";

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true)
    })
  });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.deleteProperty(window, "matchMedia");
});

describe("ConnectionScreen artwork interaction", () => {
  it("rotates groups on tab changes and toggles alt only from the artwork", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<ConnectionScreen controller={controllerFixture()} t={translator} />));

    const tabs = [...container.querySelectorAll<HTMLButtonElement>(".connection-tabs button")];
    const artwork = (): HTMLButtonElement => {
      const button = container.querySelector<HTMLButtonElement>(".connection-hero__artwork");
      if (button === null) throw new Error("Missing connection artwork button.");
      return button;
    };

    expect(artwork().dataset.artwork).toBe("jogging");
    await act(async () => artwork().click());
    expect(artwork().dataset.artwork).toBe("jogging-alt");
    await act(async () => artwork().click());
    expect(artwork().dataset.artwork).toBe("jogging");

    await act(async () => tabs[0]?.click());
    expect(artwork().dataset.artwork).toBe(CONNECTION_ARTWORK_GROUPS[1]?.base.id);
    await act(async () => tabs[0]?.click());
    expect(artwork().dataset.artwork).toBe(CONNECTION_ARTWORK_GROUPS[1]?.base.id);
    await act(async () => artwork().click());
    expect(artwork().dataset.artwork).toBe(CONNECTION_ARTWORK_GROUPS[1]?.alt.id);

    await act(async () => tabs[2]?.click());
    expect(artwork().dataset.artwork).toBe(CONNECTION_ARTWORK_GROUPS[2]?.base.id);

    const titleIcon = container.querySelector<HTMLButtonElement>(".connection-title-icon");
    if (titleIcon === null) throw new Error("Missing connection title icon button.");
    await act(async () => titleIcon.click());
    expect(artwork().dataset.artwork).toBe(CONNECTION_ARTWORK_GROUPS[0]?.base.id);
    expect(tabs[2]?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => root.unmount());
    container.remove();
  });
});

const translator: Translator = (key) => key;

function controllerFixture(): AppController {
  return {
    state: {
      connectionState: "disconnected",
      profiles: [{ id: "saved", name: "Saved", origin: "https://orchestrator.example" }],
      activeProfile: undefined,
      automaticConnectionAvailable: true,
      preferences: { theme: "light", locale: "en" },
      error: undefined,
      discoveryState: "idle",
      discoveryError: undefined,
      discoveredNodes: []
    },
    setTheme: vi.fn(async () => undefined),
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    pair: vi.fn(async () => undefined),
    forgetProfile: vi.fn(async () => undefined),
    refreshDiscoveredNodes: vi.fn(async () => undefined),
    cancelAutomaticConnectionAttempt: vi.fn()
  } as unknown as AppController;
}
