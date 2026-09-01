import { describe, expect, it } from "vitest";

import {
  readExtensionStatuses,
  readExtensionWidgets,
  updateExtensionStatuses,
  updateExtensionWidgets
} from "./extension-ui-state.js";

describe("extension UI durable state", () => {
  it("upserts, moves, and clears a widget by stable key", () => {
    const first = updateExtensionWidgets([], {
      type: "extension_widget",
      key: "checks",
      lines: ["Unit: running"],
      placement: "above_editor",
      removed: false
    }, 10);
    const moved = updateExtensionWidgets(first, {
      type: "extension_widget",
      key: "checks",
      lines: ["Unit: passed", "E2E: running"],
      placement: "below_editor",
      removed: false
    }, 20);
    const cleared = updateExtensionWidgets(moved, {
      type: "extension_widget",
      key: "checks",
      lines: [],
      placement: "above_editor",
      removed: true
    }, 30);

    expect(moved).toEqual([{
      key: "checks",
      lines: ["Unit: passed", "E2E: running"],
      placement: "below_editor",
      updatedAt: 20
    }]);
    expect(cleared).toEqual([]);
  });

  it("distinguishes a zero-line widget from an explicit clear", () => {
    const empty = updateExtensionWidgets([], {
      type: "extension_widget",
      key: "empty",
      lines: [],
      placement: "above_editor",
      removed: false
    }, 35);
    expect(empty).toEqual([{
      key: "empty",
      lines: [],
      placement: "above_editor",
      updatedAt: 35
    }]);
    expect(updateExtensionWidgets(empty, {
      type: "extension_widget",
      key: "empty",
      lines: [],
      placement: "above_editor",
      removed: true
    }, 36)).toEqual([]);
  });

  it("fails closed on malformed persisted values without clipping valid Backend text", () => {
    const value = readExtensionWidgets([
      null,
      { lines: ["ignored"] },
      { key: "valid", lines: ["x".repeat(4_000)], placement: "unknown", updatedAt: -1 }
    ]);
    expect(value).toHaveLength(1);
    expect(value[0]).toMatchObject({ key: "valid", placement: "above_editor" });
    expect(value[0]?.lines[0]).toHaveLength(4_000);
  });

  it("persists and explicitly clears footer status text", () => {
    const active = updateExtensionStatuses([], {
      type: "extension_status",
      key: "lint",
      text: "Checking"
    }, 40);
    expect(readExtensionStatuses(active)).toEqual([{ key: "lint", text: "Checking", updatedAt: 40 }]);
    expect(updateExtensionStatuses(active, { type: "extension_status", key: "lint" }, 50)).toEqual([]);
  });

  it("keeps every widget, line, key character, and status character across reconnect state", () => {
    const lines = Array.from({ length: 65 }, (_, index) => `${index}:${"x".repeat(2_049)}`);
    const widgets = Array.from({ length: 129 }, (_, index) => ({
      key: ` ${index}:${"k".repeat(129)} `,
      lines,
      placement: index % 2 === 0 ? "above_editor" : "below_editor",
      updatedAt: index
    }));
    const statusText = `  ${"s".repeat(2_049)}  `;
    const statuses = widgets.map((widget) => ({ key: widget.key, text: statusText, updatedAt: widget.updatedAt }));

    expect(readExtensionWidgets(widgets)).toHaveLength(129);
    expect(readExtensionWidgets(widgets)[0]?.lines).toEqual(lines);
    expect(readExtensionStatuses(statuses)).toHaveLength(129);
    expect(readExtensionStatuses(statuses)[0]?.text).toBe(statusText);
  });

  it("distinguishes an empty status value from the undefined clear operation", () => {
    const active = updateExtensionStatuses([], {
      type: "extension_status",
      key: "empty",
      text: ""
    }, 60);
    expect(active).toEqual([{ key: "empty", text: "", updatedAt: 60 }]);
    expect(updateExtensionStatuses(active, { type: "extension_status", key: "empty" }, 61)).toEqual([]);
  });

  it("preserves the empty key accepted by the native extension maps", () => {
    expect(updateExtensionWidgets([], {
      type: "extension_widget",
      key: "",
      lines: ["visible"],
      placement: "above_editor",
      removed: false
    }, 70)).toEqual([{ key: "", lines: ["visible"], placement: "above_editor", updatedAt: 70 }]);
    expect(updateExtensionStatuses([], {
      type: "extension_status",
      key: "",
      text: "visible"
    }, 71)).toEqual([{ key: "", text: "visible", updatedAt: 71 }]);
  });
});
