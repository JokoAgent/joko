import { describe, expect, it } from "vitest";
import {
  SESSION_LINK_DRAG_MIME,
  hasComposerInternalDrop,
  resolveComposerInternalDrop
} from "./composer-internal-drop.js";
import {
  WORKSPACE_ENTRY_DRAG_MIME,
  encodeWorkspaceEntryDragPayload
} from "./workspace-tree-state.js";

describe("composer private drag payloads", () => {
  it("turns a same-workspace file or directory into the existing path atom", () => {
    for (const kind of ["file", "directory"] as const) {
      const transfer = dataTransfer({
        [WORKSPACE_ENTRY_DRAG_MIME]: encodeWorkspaceEntryDragPayload({
          version: 1,
          workspaceId: "workspace-1",
          kind,
          path: kind === "file" ? "src/main.ts" : "src/components",
          name: kind === "file" ? "main.ts" : "components"
        })
      });
      expect(resolveComposerInternalDrop(transfer, "workspace-1")).toEqual({
        source: "workspace",
        attrs: {
          kind: "path",
          display: kind === "file" ? "src/main.ts" : "src/components",
          serialized: kind === "file" ? "@src/main.ts" : "@src/components",
          reference: kind === "file" ? "src/main.ts" : "src/components"
        }
      });
      expect(resolveComposerInternalDrop(transfer, "workspace-2")).toBeUndefined();
    }
  });

  it("turns the sidebar task link into a resolvable session atom", () => {
    const href = "https://joko.test/app#/tasks/task%2Fone";
    const transfer = dataTransfer({ [SESSION_LINK_DRAG_MIME]: href });
    expect(hasComposerInternalDrop(transfer)).toBe(true);
    expect(resolveComposerInternalDrop(transfer, undefined)).toEqual({
      source: "session",
      attrs: {
        kind: "session",
        display: "task/one",
        serialized: href,
        reference: "task/one",
        href
      },
      pending: {
        target: { kind: "session", href, sessionId: "task/one" },
        expectedDisplay: "task/one"
      }
    });
  });

  it("consumes malformed private payloads without classifying them as OS files", () => {
    const malformed = dataTransfer({ [WORKSPACE_ENTRY_DRAG_MIME]: "{bad" });
    expect(hasComposerInternalDrop(malformed)).toBe(true);
    expect(resolveComposerInternalDrop(malformed, "workspace-1")).toBeUndefined();
    expect(resolveComposerInternalDrop(dataTransfer({ [SESSION_LINK_DRAG_MIME]: "https://example.test/ordinary" }), undefined)).toBeUndefined();
  });
});

function dataTransfer(values: Readonly<Record<string, string>>): { getData(type: string): string } {
  return { getData: (type) => values[type] ?? "" };
}
