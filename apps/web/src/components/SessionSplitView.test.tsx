// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { addSessionSplit } from "../session-split-layout.js";
import type { SessionView } from "../model.js";
import { ratioWithPixelMinimum, sessionSplitMinimumSize, SessionSplitView } from "./SessionSplitView.js";

const sessions = [
  { id: "one", name: "One" },
  { id: "two", name: "Two" }
] as unknown as readonly SessionView[];

describe("SessionSplitView", () => {
  it("renders a recursive layout with real pane slots and an accessible gutter", () => {
    const layout = addSessionSplit({}, "two", "one", "right");
    const markup = renderToStaticMarkup(<SessionSplitView
      layout={layout}
      currentSessionId="one"
      focusedSessionId="two"
      sessions={sessions}
      t={(key) => key}
      renderPane={(sessionId) => <main>Pane {sessionId}</main>}
      onLayoutChange={() => undefined}
      onFocus={() => undefined}
      onClose={() => undefined}
      onDropSession={() => undefined}
    />);
    expect(markup).toContain('role="separator"');
    expect(markup).toContain("Pane one");
    expect(markup).toContain("Pane two");
  });

  it("keeps both descendants above their pixel minimum when space permits", () => {
    expect(ratioWithPixelMinimum(0.01, 1_000, "row")).toBeCloseTo(280 / 994);
    expect(ratioWithPixelMinimum(0.99, 1_000, "row")).toBeCloseTo(1 - (280 / 994));
    expect(ratioWithPixelMinimum(0.1, 800, "column")).toBeCloseTo(220 / 794);
    expect(ratioWithPixelMinimum(0.1, 300, "column")).toBe(0.5);
  });

  it("reports only the mounted task when a split contracts to tabs", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", undefined);
    const width = vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(1_200);
    const height = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(700);
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    const layout = addSessionSplit({}, "two", "one", "right");
    const publish = vi.fn();
    function Split() {
      const [focused, setFocused] = useState("one");
      return <SessionSplitView layout={layout} currentSessionId="one" focusedSessionId={focused} sessions={sessions}
        t={(key) => key} renderPane={sessionId => <main data-pane-id={sessionId}>Pane {sessionId}</main>}
        onVisibleSessionIdsChange={publish} onFocus={setFocused} onLayoutChange={() => undefined}
        onClose={() => undefined} onDropSession={() => undefined} />;
    }
    const mountedIds = () => [...container.querySelectorAll<HTMLElement>("main[data-pane-id]")].map(pane => pane.dataset.paneId);
    try {
      await act(async () => root.render(<Split />));
      expect(new Set(mountedIds())).toEqual(new Set(["one", "two"]));
      expect(publish).toHaveBeenLastCalledWith(mountedIds());
      width.mockReturnValue(360);
      await act(async () => window.dispatchEvent(new Event("resize")));
      expect(mountedIds()).toEqual(["one"]);
      expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
      expect(publish).toHaveBeenLastCalledWith(["one"]);
      const second = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent === "Two")!;
      await act(async () => second.click());
      expect(mountedIds()).toEqual(["two"]);
      expect(publish).toHaveBeenLastCalledWith(["two"]);
      width.mockReturnValue(1_200);
      await act(async () => window.dispatchEvent(new Event("resize")));
      expect(publish).toHaveBeenLastCalledWith(mountedIds());
    } finally {
      await act(async () => root.unmount());
      container.remove();
      width.mockRestore(); height.mockRestore(); vi.unstubAllGlobals();
    }
    expect(publish).toHaveBeenLastCalledWith(undefined);
  });

  it("accounts for nested descendants before deciding whether to degrade", () => {
    const two = addSessionSplit({}, "two", "one", "right");
    const three = addSessionSplit(two, "three", "two", "bottom");
    expect(sessionSplitMinimumSize(three.root)).toEqual({ width: 566, height: 446 });
    expect(ratioWithPixelMinimum(0.2, 900, "row", 280, 566)).toBeCloseTo(280 / 894);
  });
});
