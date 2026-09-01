// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { emptySnapshot, type AppSnapshot } from "../model.js";
import { SessionRuntimeFallbackCell } from "./SessionRuntimeFallbackCell.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("SessionRuntimeFallbackCell", () => {
  it("is capability-driven and wires the optimistic toggle plus default reset", async () => {
    const setEnabled = vi.fn(async () => undefined);
    const reset = vi.fn(async () => undefined);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<SessionRuntimeFallbackCell
      controller={{
        setSessionRuntimeFallbackEnabled: setEnabled,
        resetSessionRuntimeFallback: reset
      } as unknown as AppController}
      snapshot={snapshot(true)}
      runAction={(_key, work) => { void work(); }}
      t={(key, values) => translate("en", key, values)}
    />));

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle automatic task model fallback"]'
    )!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle.click());
    expect(setEnabled).toHaveBeenCalledWith(true);
    const resetButton = container.querySelector<HTMLButtonElement>('button[aria-label="Restore default"]')!;
    await act(async () => resetButton.click());
    expect(reset).toHaveBeenCalledOnce();
  });

  it("does not render without model switching", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<SessionRuntimeFallbackCell
      controller={{} as AppController}
      snapshot={snapshot(false)}
      runAction={() => undefined}
      t={(key, values) => translate("en", key, values)}
    />));
    expect(container.innerHTML).toBe("");
  });
});

function snapshot(supported: boolean): AppSnapshot {
  const base = emptySnapshot();
  return {
    ...base,
    backends: [{
      id: "runtime",
      name: "Runtime",
      version: "1.0.0",
      health: "healthy",
      capabilities: new Map([["model.switch", {
        name: "model.switch",
        supported,
        options: []
      }]])
    }],
    settings: {
      ...base.settings,
      personalization: {
        ...base.settings.personalization,
        sessionRuntimeFallbackEnabled: false,
        sessionRuntimeFallbackCustomized: true
      }
    }
  };
}
