import { describe, expect, it } from "vitest";
import {
  WORKSPACE_CHAT_RAIL_DEFAULT_WIDTH,
  clampWorkspaceChatRailWidth,
  readWorkspaceChatRailCollapsed,
  readWorkspaceChatRailWidth,
  workspaceChatRailDragWidth
} from "./workspace-chat-rail.js";

describe("workspace document chat rail", () => {
  it("uses the configured default and bounds", () => {
    expect(WORKSPACE_CHAT_RAIL_DEFAULT_WIDTH).toBe(400);
    expect(clampWorkspaceChatRailWidth(10)).toBe(400);
    expect(clampWorkspaceChatRailWidth(710.4)).toBe(710);
    expect(clampWorkspaceChatRailWidth(5_000)).toBe(1120);
  });

  it("inverts a drag from the rail's left edge", () => {
    expect(workspaceChatRailDragWidth(500, 100, 160)).toBe(440);
    expect(workspaceChatRailDragWidth(500, 100, 40)).toBe(560);
  });

  it("fails persisted values to safe defaults", () => {
    expect(readWorkspaceChatRailWidth(undefined)).toBe(400);
    expect(readWorkspaceChatRailWidth({ getItem: () => "700" })).toBe(700);
    expect(readWorkspaceChatRailWidth({ getItem: () => "oops" })).toBe(400);
    expect(readWorkspaceChatRailCollapsed({ getItem: () => "true" })).toBe(true);
  });
});
