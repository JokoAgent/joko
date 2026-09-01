import { describe, expect, it } from "vitest";

import {
  mermaidZoomAt,
  normalizeWorkspaceMermaidWheelDelta,
  workspaceMermaidEditShortcutAction,
  workspaceMermaidWheelZoomFactor
} from "./WorkspaceMermaidHosts.js";

describe("Workspace Mermaid lightbox", () => {
  it("zooms around a focal point and enforces the 0.2x–8x range", () => {
    expect(mermaidZoomAt({ scale: 1, x: 0, y: 0 }, { x: 30, y: -20 }, 2)).toEqual({ scale: 2, x: -30, y: 20 });
    expect(mermaidZoomAt({ scale: 1, x: 0, y: 0 }, { x: 0, y: 0 }, 0.01).scale).toBe(0.2);
    expect(mermaidZoomAt({ scale: 1, x: 0, y: 0 }, { x: 0, y: 0 }, 20).scale).toBe(8);
  });

  it("normalizes line/page wheel deltas before applying the zoom curve", () => {
    expect(normalizeWorkspaceMermaidWheelDelta(2, 0)).toBe(2);
    expect(normalizeWorkspaceMermaidWheelDelta(2, 1)).toBe(32);
    expect(normalizeWorkspaceMermaidWheelDelta(2, 2)).toBe(1_600);
    expect(workspaceMermaidWheelZoomFactor(1, 1)).toBeCloseTo(workspaceMermaidWheelZoomFactor(16, 0), 12);
    expect(workspaceMermaidWheelZoomFactor(1, 2)).toBeCloseTo(workspaceMermaidWheelZoomFactor(40, 0), 12);
  });

  it("cancels unchanged source and applies only dirty source on Cmd/Ctrl+Enter", () => {
    expect(workspaceMermaidEditShortcutAction({ key: "Enter", ctrlKey: true, metaKey: false }, false)).toBe("cancel");
    expect(workspaceMermaidEditShortcutAction({ key: "Enter", ctrlKey: false, metaKey: true }, true)).toBe("apply");
    expect(workspaceMermaidEditShortcutAction({ key: "Enter", ctrlKey: false, metaKey: false }, true)).toBeUndefined();
  });
});
