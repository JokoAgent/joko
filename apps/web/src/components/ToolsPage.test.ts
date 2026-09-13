import { describe, expect, it } from "vitest";
import {
  browserTakeoverKey,
  browserTakeoverModifiers,
  clampBrowserScrollDelta,
  mcpServerTone,
  normalizedBrowserCanvasPoint
} from "./ToolsPage.js";

describe("remote Browser canvas coordinates", () => {
  const rect = { left: 100, top: 50, width: 400, height: 200 };

  it("maps rendered client coordinates to screenshot-independent normalized coordinates", () => {
    expect(normalizedBrowserCanvasPoint(rect, 300, 100)).toEqual({ x: 0.5, y: 0.25 });
  });

  it("clamps pointer coordinates to the canvas edges", () => {
    expect(normalizedBrowserCanvasPoint(rect, -50, 500)).toEqual({ x: 0, y: 1 });
    expect(normalizedBrowserCanvasPoint(rect, 500, 250)).toEqual({ x: 1, y: 1 });
  });

  it("rejects zero-sized or non-finite geometry and pointer coordinates", () => {
    expect(normalizedBrowserCanvasPoint({ ...rect, width: 0 }, 300, 100)).toBeUndefined();
    expect(normalizedBrowserCanvasPoint({ ...rect, height: 0 }, 300, 100)).toBeUndefined();
    expect(normalizedBrowserCanvasPoint({ ...rect, left: Number.NaN }, 300, 100)).toBeUndefined();
    expect(normalizedBrowserCanvasPoint(rect, Number.POSITIVE_INFINITY, 100)).toBeUndefined();
    expect(normalizedBrowserCanvasPoint(rect, 300, Number.NaN)).toBeUndefined();
  });
});

describe("remote Browser keyboard input", () => {
  it("maps only the explicitly supported navigation and editing keys", () => {
    expect(browserTakeoverKey("Enter")).toBe("Enter");
    expect(browserTakeoverKey("Tab")).toBe("Tab");
    expect(browserTakeoverKey("Escape")).toBe("Escape");
    expect(browserTakeoverKey("Backspace")).toBe("Backspace");
    expect(browserTakeoverKey("Delete")).toBe("Delete");
    expect(browserTakeoverKey("ArrowUp")).toBe("ArrowUp");
    expect(browserTakeoverKey("ArrowDown")).toBe("ArrowDown");
    expect(browserTakeoverKey("ArrowLeft")).toBe("ArrowLeft");
    expect(browserTakeoverKey("ArrowRight")).toBe("ArrowRight");
    expect(browserTakeoverKey("Home")).toBe("Home");
    expect(browserTakeoverKey("End")).toBe("End");
    expect(browserTakeoverKey("PageUp")).toBe("PageUp");
    expect(browserTakeoverKey("PageDown")).toBe("PageDown");
    expect(browserTakeoverKey(" ")).toBe("Space");
  });

  it("forwards bounded printable keys and modifier chords while rejecting unknown keys", () => {
    expect(browserTakeoverKey("a")).toBe("a");
    expect(browserTakeoverKey("C")).toBe("c");
    expect(browserTakeoverKey("7")).toBe("7");
    expect(browserTakeoverKey("F5")).toBeUndefined();
    expect(browserTakeoverKey("Enter", { ctrlKey: true })).toBe("Enter");
    expect(browserTakeoverModifiers({ ctrlKey: true, shiftKey: true })).toEqual(["control", "shift"]);
    expect(browserTakeoverModifiers({ altKey: true, metaKey: true })).toEqual(["alt", "meta"]);
  });
});

describe("remote Browser scrolling", () => {
  it("truncates fractional wheel input and clamps it to the Provider bound", () => {
    expect(clampBrowserScrollDelta(42.9)).toBe(42);
    expect(clampBrowserScrollDelta(-42.9)).toBe(-42);
    expect(clampBrowserScrollDelta(20_000)).toBe(10_000);
    expect(clampBrowserScrollDelta(-20_000)).toBe(-10_000);
    expect(clampBrowserScrollDelta(0)).toBe(0);
  });
});

describe("MCP runtime status", () => {
  it("uses distinct tones for connected, failed, disabled, and transitional servers", () => {
    expect(mcpServerTone("connected")).toBe("success");
    expect(mcpServerTone("error")).toBe("danger");
    expect(mcpServerTone("disabled")).toBe("neutral");
    expect(mcpServerTone("starting")).toBe("warning");
    expect(mcpServerTone("degraded")).toBe("warning");
    expect(mcpServerTone("disconnected")).toBe("warning");
  });
});
