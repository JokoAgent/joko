import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  WorkspaceFilesSidebar,
  clampWorkspaceFilesMenuPosition,
  splitWorkspaceSearchPreview,
  workspaceSearchErrorText
} from "./WorkspaceFilesSidebar.js";

async function* emptyWorkspaceSearch() {
  yield {
    kind: "end" as const,
    truncated: false,
    totalMatches: 0,
    totalFiles: 0,
    revision: "sha256:empty"
  };
}

describe("WorkspaceFilesSidebar static document-host surface", () => {
  it("renders the compact tree and keeps the alternate search surface mounted", () => {
    const markup = renderToStaticMarkup(<WorkspaceFilesSidebar
      workspaceId="workspace-a"
      activeTargetId="target-a"
      workspaceDisplayName="Joko"
      projectOptions={[
        { targetId: "target-a", workspaceId: "workspace-a", sessionId: "session-a", displayName: "Joko", activeSessionCount: 2 },
        { targetId: "target-b", workspaceId: "workspace-b", sessionId: "session-b", displayName: "Other", activeSessionCount: 1 }
      ]}
      selectedPath="README.md"
      initialDirectories={new Map([["", [
        { path: "src", name: "src", kind: "directory" as const },
        { path: "README.md", name: "README.md", kind: "file" as const }
      ]]])}
      initialFileIndex={{ paths: ["README.md"], truncated: false }}
      loadDirectory={vi.fn(async () => [])}
      searchWorkspace={vi.fn(emptyWorkspaceSearch)}
      onSelectFile={vi.fn()}
      onOpenSearchMatch={vi.fn()}
      onSelectProject={vi.fn()}
      onLeaveDocumentMode={vi.fn()}
    />);

    expect(markup).toContain("role=\"tree\"");
    expect(markup).toContain("role=\"treeitem\"");
    expect(markup).toContain("aria-level=\"1\"");
    expect(markup).toContain("aria-selected=\"true\"");
    expect(markup).toContain("Back to task");
    expect(markup).toContain("Switch project");
    expect(markup).toContain("2 active");
    expect(markup).toContain("aria-current=\"true\"");
    expect(markup).toContain("Filter files");
    expect(markup).toContain("Search in files");
    expect(markup).not.toContain("/server/");
  });

  it("does not render structural write affordances merely because callbacks exist elsewhere", () => {
    const markup = renderToStaticMarkup(<WorkspaceFilesSidebar
      workspaceId="workspace-a"
      workspaceDisplayName="Joko"
      initialDirectories={new Map([["", []]])}
      loadDirectory={vi.fn(async () => [])}
      searchWorkspace={vi.fn(emptyWorkspaceSearch)}
      onSelectFile={vi.fn()}
      onOpenSearchMatch={vi.fn()}
      onLeaveDocumentMode={vi.fn()}
    />);
    expect(markup).not.toContain("New file");
    expect(markup).not.toContain("New folder");
    expect(markup).not.toContain("Rename");
    expect(markup).not.toContain("Delete");
  });

  it("clamps a fixed menu within the owner viewport", () => {
    expect(clampWorkspaceFilesMenuPosition(990, 790, 1000, 800)).toEqual({ x: 768, y: 580 });
    expect(clampWorkspaceFilesMenuPosition(-50, -20, 1000, 800)).toEqual({ x: 8, y: 8 });
  });
});

describe("splitWorkspaceSearchPreview", () => {
  it("trims rg indentation and highlights every authoritative byte range", () => {
    expect(splitWorkspaceSearchPreview("   Foo foo FOO", [
      { startByte: 3, endByte: 6 },
      { startByte: 7, endByte: 10 },
      { startByte: 11, endByte: 14 }
    ]).map(({ text, match }) => [text, match])).toEqual([
      ["Foo", true],
      [" ", false],
      ["foo", true],
      [" ", false],
      ["FOO", true]
    ]);
  });

  it("does not invent visually plausible matches absent from rg", () => {
    expect(splitWorkspaceSearchPreview("Foo foo", [{ startByte: 4, endByte: 7 }]).filter((segment) => segment.match).map((segment) => segment.text)).toEqual(["foo"]);
    expect(splitWorkspaceSearchPreview("a+b then a+b", [{ startByte: 0, endByte: 3 }]).filter((segment) => segment.match).map((segment) => segment.text)).toEqual(["a+b"]);
  });

  it("maps UTF-8 offsets safely across CJK and astral Unicode without fake highlights", () => {
    expect(splitWorkspaceSearchPreview("  前🐾后🐾", [{ startByte: 12, endByte: 16 }]).map(({ text, match }) => [text, match])).toEqual([
      ["前🐾后", false],
      ["🐾", true]
    ]);
    expect(splitWorkspaceSearchPreview("前🐾后", [{ startByte: 4, endByte: 7 }]).every((segment) => !segment.match)).toBe(true);
  });

  it("shows a terminal provider reason and only falls back for an empty message", () => {
    expect(workspaceSearchErrorText(" ripgrep is unavailable. ", "Workspace search failed.")).toBe("ripgrep is unavailable.");
    expect(workspaceSearchErrorText("", "Workspace search failed.")).toBe("Workspace search failed.");
  });
});
