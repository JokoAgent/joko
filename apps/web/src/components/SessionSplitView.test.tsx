// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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

  it("accounts for nested descendants before deciding whether to degrade", () => {
    const two = addSessionSplit({}, "two", "one", "right");
    const three = addSessionSplit(two, "three", "two", "bottom");
    expect(sessionSplitMinimumSize(three.root)).toEqual({ width: 566, height: 446 });
    expect(ratioWithPixelMinimum(0.2, 900, "row", 280, 566)).toBeCloseTo(280 / 894);
  });
});
