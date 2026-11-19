import { describe, expect, it } from "vitest";
import { composerDirectoryReferencesAllowed, composerDocumentPlainText, normalizeComposerDocument, serializeComposerDocument } from "../composer-quote-document.js";
import {
  SESSION_LINK_DRAG_MIME,
  classifyComposerInternalDrop,
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

  it("retains only the exact same-workspace directory occurrence as a typed atom", () => {
    const transfer = dataTransfer({
      [WORKSPACE_ENTRY_DRAG_MIME]: encodeWorkspaceEntryDragPayload({
        version: 1, workspaceId: "workspace-1", kind: "directory", path: "design docs", name: "design docs"
      })
    });
    const insertion = resolveComposerInternalDrop(transfer, "workspace-1", true);
    expect(insertion?.attrs).toMatchObject({ directoryWorkspaceId: "workspace-1", serialized: '@"design docs/"' });
    expect(resolveComposerInternalDrop(transfer, "workspace-2", true)).toBeUndefined();
    expect(resolveComposerInternalDrop(transfer, "workspace-1", false)?.attrs).not.toHaveProperty("directoryWorkspaceId");
    const document = normalizeComposerDocument(JSON.parse(JSON.stringify({
      type: "doc", content: [{ type: "paragraph", content: [
        { type: "text", text: '  @"design docs/" ' },
        { type: "composerRouteReference", attrs: insertion?.attrs }
      ] }]
    })));
    const token = '@"design docs/"';
    expect(composerDocumentPlainText(document)).toBe(`${token} ${token}`);
    expect(serializeComposerDocument(document)).toMatchObject({
      text: `${token} ${token}`,
      directoryReferences: [{ path: "design docs", workspaceId: "workspace-1", start: token.length + 1, end: 2 * token.length + 1 }]
    });
    expect(composerDirectoryReferencesAllowed(document, true, "workspace-1")).toBe(true);
    expect(composerDirectoryReferencesAllowed(document, true, "workspace-2")).toBe(false);
    expect(composerDirectoryReferencesAllowed(document, false, "workspace-1")).toBe(false);
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
    expect(classifyComposerInternalDrop(malformed, "workspace-1")).toEqual({ kind: "invalid" });
    expect(resolveComposerInternalDrop(malformed, "workspace-1")).toBeUndefined();
    expect(resolveComposerInternalDrop(dataTransfer({ [SESSION_LINK_DRAG_MIME]: "https://example.test/ordinary" }), undefined)).toBeUndefined();
  });

  it("distinguishes protected dragover MIME claims from invalid and ordinary drops", () => {
    const protectedTransfer = dataTransfer({}, [WORKSPACE_ENTRY_DRAG_MIME]);
    expect(hasComposerInternalDrop(protectedTransfer)).toBe(true);
    expect(classifyComposerInternalDrop(protectedTransfer, "workspace-1")).toEqual({ kind: "pending" });

    const foreignWorkspace = dataTransfer({
      [WORKSPACE_ENTRY_DRAG_MIME]: encodeWorkspaceEntryDragPayload({
        version: 1,
        workspaceId: "workspace-2",
        kind: "file",
        path: "private.txt",
        name: "private.txt"
      })
    }, [WORKSPACE_ENTRY_DRAG_MIME, "Files"]);
    expect(classifyComposerInternalDrop(foreignWorkspace, "workspace-1")).toEqual({ kind: "invalid" });
    expect(classifyComposerInternalDrop(dataTransfer({}, ["Files"]), "workspace-1")).toEqual({ kind: "none" });
  });
});

function dataTransfer(values: Readonly<Record<string, string>>, types: readonly string[] = Object.keys(values)): { readonly types: readonly string[]; getData(type: string): string } {
  return { types, getData: (type) => values[type] ?? "" };
}
