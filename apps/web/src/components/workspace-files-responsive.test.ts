import { describe, expect, it } from "vitest";

import {
  initialWorkspaceChatRailCollapsed,
  workspaceFilesUsesCompactLayout
} from "./WorkspaceFilesRoute.js";

describe("Files responsive application shell", () => {
  it.each([980, 800, 640])("uses a drawer and a collapsed overlay chat at %ipx", (viewportWidth) => {
    const compact = workspaceFilesUsesCompactLayout(viewportWidth);
    expect(compact).toBe(true);
    expect(initialWorkspaceChatRailCollapsed(false, compact)).toBe(true);
    expect(initialWorkspaceChatRailCollapsed(true, compact)).toBe(true);
  });
  it("keeps wide-layout chat persistence without overriding it", () => {
    expect(workspaceFilesUsesCompactLayout(981)).toBe(false);
    expect(initialWorkspaceChatRailCollapsed(false, false)).toBe(false);
    expect(initialWorkspaceChatRailCollapsed(true, false)).toBe(true);
  });
});
