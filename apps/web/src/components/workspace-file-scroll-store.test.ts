import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAllWorkspaceFileScrollForTests,
  loadWorkspaceFileScroll,
  saveWorkspaceFileScroll
} from "./workspace-file-scroll-store.js";

describe("workspace file scroll store", () => {
  beforeEach(clearAllWorkspaceFileScrollForTests);

  it("keeps independent session-only anchors by workspace and path key", () => {
    saveWorkspaceFileScroll("workspace-a\0README.md", { top: 220, line: 14, offset: 7 });
    saveWorkspaceFileScroll("workspace-b\0README.md", { top: 40, line: 3, offset: 1 });
    expect(loadWorkspaceFileScroll("workspace-a\0README.md")).toEqual({ top: 220, line: 14, offset: 7 });
    expect(loadWorkspaceFileScroll("workspace-b\0README.md")).toEqual({ top: 40, line: 3, offset: 1 });
  });
});
