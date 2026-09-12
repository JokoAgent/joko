// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type SessionView } from "../model.js";
import { translate } from "../i18n.js";
import { Inspector } from "./Inspector.js";
import { INSPECTOR_DEFAULT_RATIO, inspectorPointerWidth, inspectorRatioForWidth, inspectorResizeDeltaForKey, inspectorWidthForRatio, normalizeInspectorRatio } from "./inspector-resize.js";

describe("right-sidebar sizing", () => {
  it("retains the user's preferred proportion across a narrow viewport and restores it on widening", async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const originalWidth = window.innerWidth;
    window.localStorage.setItem("joko.session.inspectorRatio", "0.5");
    const resize = async (width: number) => act(async () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
      window.dispatchEvent(new Event("resize"));
    });
    try {
      await resize(1200);
      await act(async () => root.render(createElement(Inspector, {
        controller: { state: { preferences: DEFAULT_UI_PREFERENCES }, releaseArtifactUrl: vi.fn() } as unknown as AppController,
        snapshot: emptySnapshot(), session: { id: "task", backendId: "backend", targetId: "target", name: "Task", state: "idle", generation: 1n, pinned: false, archived: false, fastMode: false, planMode: false, permissionMode: "ask", updatedAt: 1 } satisfies SessionView,
        timeline: [], open: true, t: (key, values) => translate("en", key, values), runAction: () => undefined, onClose: vi.fn(), onSelectionQuote: vi.fn()
      })));
      const width = () => Number(host.querySelector('[role="separator"]')?.getAttribute("aria-valuenow"));
      expect(width()).toBe(600);
      await resize(390);
      expect(width()).toBe(0);
      await resize(1200);
      expect(width()).toBe(600);
      await act(async () => host.querySelector('[role="separator"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
      expect(width()).toBe(584);
      await resize(390);
      await resize(1200);
      expect(width()).toBe(584);
      expect(Number(window.localStorage.getItem("joko.session.inspectorRatio"))).toBeCloseTo(584 / 1200);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
      window.localStorage.clear();
      document.documentElement.style.removeProperty("--inspector-width");
    }
  });

  it("defaults to half of the available session workbench", () => {
    expect(inspectorWidthForRatio(1_200, INSPECTOR_DEFAULT_RATIO)).toBe(600);
  });

  it("keeps a 280px sidebar and a 400px main chat whenever space permits", () => {
    expect(inspectorWidthForRatio(1_000, 0.1)).toBe(280);
    expect(inspectorWidthForRatio(1_000, 0.9)).toBe(600);
    expect(inspectorWidthForRatio(600, 0.5)).toBe(200);
  });

  it("normalizes persisted and pointer-derived ratios to the 10–90 percent range", () => {
    expect(normalizeInspectorRatio(null)).toBe(0.5);
    expect(normalizeInspectorRatio("bad")).toBe(0.5);
    expect(normalizeInspectorRatio(0.01)).toBe(0.1);
    expect(normalizeInspectorRatio(2)).toBe(0.9);
    expect(inspectorRatioForWidth(1_000, 420)).toBe(0.42);
  });

  it("supports pointer and keyboard resizing when the panel moves left", () => {
    expect(inspectorPointerWidth(1_000, 620, "right")).toBe(380);
    expect(inspectorPointerWidth(100, 480, "left")).toBe(380);
    expect(inspectorResizeDeltaForKey("right", "ArrowLeft")).toBe(16);
    expect(inspectorResizeDeltaForKey("right", "ArrowRight", true)).toBe(-64);
    expect(inspectorResizeDeltaForKey("left", "ArrowLeft")).toBe(-16);
    expect(inspectorResizeDeltaForKey("left", "ArrowRight", true)).toBe(64);
  });
});
