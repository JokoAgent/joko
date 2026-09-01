import { create } from "@bufbuild/protobuf";
import {
  BrowserPermissionAction,
  CompositeArgumentKind,
  FilePermissionAction,
  InteractionSchema,
  PermissionDecisionKind,
  ResourcePermissionAction
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { formatCommand } from "./permission-format.js";
import { mapInteraction } from "./gateway.js";

function permissionWith(value: object): never {
  return value as never;
}

function mapSubject(subject: object) {
  return mapInteraction(create(InteractionSchema, {
    interactionId: "interaction-1",
    sessionId: "session-1",
    generation: 2n,
    request: {
      case: "permission",
      value: permissionWith({
        title: "Review exact operation",
        explanation: "The agent needs permission.",
        subject,
        allowedDecisions: [PermissionDecisionKind.ALLOW_ONCE, PermissionDecisionKind.DENY_ONCE]
      })
    }
  })).permissionSubject;
}

describe("permission subject projection", () => {
  it("retains precise command details and risk flags", () => {
    expect(mapSubject({ kind: { case: "command", value: {
      executable: "git",
      arguments: ["push", "origin", "main branch"],
      workingDirectoryDisplay: "D:\\work\\project",
      networkAccess: true,
      writesOutsideWorkspace: true,
      usesShell: false
    } } })).toEqual({
      kind: "command",
      executable: "git",
      arguments: ["push", "origin", "main branch"],
      workingDirectory: "D:\\work\\project",
      networkAccess: true,
      writesOutsideWorkspace: true,
      usesShell: false
    });
    expect(formatCommand("git", ["push", "origin", "main branch"])).toBe('"git" "push" "origin" "main branch"');
  });

  it("retains file, browser, and resource boundaries", () => {
    expect(mapSubject({ kind: { case: "file", value: {
      workspaceId: "workspace-1",
      relativePaths: ["src/a.ts", "../outside.txt"],
      action: FilePermissionAction.DELETE,
      outsidePrimaryWorkspace: true
    } } })).toMatchObject({ kind: "file", action: "delete", outsidePrimaryWorkspace: true, paths: ["src/a.ts", "../outside.txt"] });

    expect(mapSubject({ kind: { case: "browser", value: {
      browserProviderId: "browser-1",
      pageId: "page-1",
      action: BrowserPermissionAction.TAKE_OVER,
      origin: "https://example.test"
    } } })).toEqual({ kind: "browser", providerId: "browser-1", pageId: "page-1", action: "takeOver", origin: "https://example.test" });

    expect(mapSubject({ kind: { case: "resource", value: {
      resourceId: "skill-1",
      sourcePathDisplay: "D:\\skills\\review",
      action: ResourcePermissionAction.INSTALL
    } } })).toEqual({ kind: "resource", resourceId: "skill-1", sourcePath: "D:\\skills\\review", action: "install" });
  });

  it("keeps display-safe MCP and custom-tool arguments while honoring redaction", () => {
    const arguments_ = [
      { fieldPath: "query", value: { case: "text", value: "status" } },
      { fieldPath: "token", redacted: true, redactedPlaceholder: "[secret]", value: { case: undefined } },
      { fieldPath: "filters", value: { case: "composite", value: { kind: CompositeArgumentKind.OBJECT, childCount: 2 } } }
    ];
    expect(mapSubject({ kind: { case: "mcp", value: { serverId: "server-1", toolName: "lookup", arguments: arguments_ } } })).toEqual({
      kind: "mcp",
      serverId: "server-1",
      toolName: "lookup",
      arguments: [
        { fieldPath: "query", value: "status", redacted: false },
        { fieldPath: "token", value: "[secret]", redacted: true },
        { fieldPath: "filters", value: "object (2)", redacted: false }
      ]
    });
    expect(mapSubject({ kind: { case: "customTool", value: { toolId: "custom-1", displayName: "Deploy", arguments: arguments_ } } })).toMatchObject({ kind: "customTool", toolId: "custom-1", displayName: "Deploy" });
  });
});
