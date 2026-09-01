import { describe, expect, it } from "vitest";
import type { ResourceView, RuntimeCommandView, WorkspaceEntryView } from "../model.js";
import {
  composerBuiltInCommand,
  composerCommandItems,
  composerMentionItems,
  insertComposerPaletteValue,
  mentionsStillPresent
} from "./composer-palette.js";

describe("shared composer palettes", () => {
  it("exposes and strictly parses the application help, task jump, and generic shell commands", () => {
    const options = { helpSupported: true, jumpSessionSupported: true, userShellSupported: true };
    expect(composerCommandItems([], [], options).map((item) => item.value)).toEqual([
      "/help",
      "/jump-session",
      "/cmd"
    ]);
    expect(composerBuiltInCommand("/HELP", options)).toEqual({ kind: "help" });
    expect(composerBuiltInCommand("/jump-session task-123", options)).toEqual({
      kind: "jumpSession",
      sessionId: "task-123"
    });
    expect(composerBuiltInCommand("/jump-session", options)).toEqual({ kind: "jumpSession", sessionId: "" });
    expect(composerBuiltInCommand("/cmd git status --short", options)).toEqual({
      kind: "userShell",
      command: "git status --short"
    });
    expect(composerBuiltInCommand(" /help", options)).toBeUndefined();
    expect(composerBuiltInCommand("/cmdlet", options)).toBeUndefined();
    expect(composerBuiltInCommand("/help", {})).toBeUndefined();
  });

  it("projects workspace and resource mentions into the same structured wire shape", () => {
    const entries: readonly WorkspaceEntryView[] = [{
      path: "src",
      name: "src",
      kind: "directory",
      generated: false,
      children: [{ path: "src/main.ts", name: "main.ts", kind: "file", generated: false }]
    }];
    const items = composerMentionItems(entries, "workspace-1", [resource({ id: "skill-1", name: "review", kind: "skill" })]);

    expect(items[0]?.mention).toEqual({
      id: "workspace:workspace-1:src/main.ts",
      kind: "workspace",
      reference: "src/main.ts",
      label: "main.ts",
      token: "@src/main.ts",
      workspaceId: "workspace-1"
    });
    expect(items[1]?.mention).toMatchObject({ kind: "resource", reference: "skill-1", token: "@review" });
  });

  it("uses loaded runtime commands and supplements delayed-create with loaded skills/templates", () => {
    const commands: readonly RuntimeCommandView[] = [{
      id: "command-1",
      name: "review",
      description: "Review changes",
      source: "skill",
      resourceId: "skill-1",
      loaded: true
    }];
    const items = composerCommandItems(commands, [
      resource({ id: "skill-1", name: "review", kind: "skill" }),
      resource({ id: "prompt-1", name: "release notes", kind: "prompt" }),
      resource({ id: "disabled", name: "hidden", kind: "skill", enabled: false })
    ]);

    expect(items.map((item) => item.value)).toEqual(["/review", "/release-notes"]);
  });

  it("adds and intercepts /clear only when session.reset is supported", () => {
    expect(composerCommandItems([], [], { sessionResetSupported: false })).toEqual([]);
    expect(composerCommandItems([], [], { sessionResetSupported: true })).toEqual([
      expect.objectContaining({ id: "builtin:clear", value: "/clear" })
    ]);
    expect(composerBuiltInCommand(" /clear ", { sessionResetSupported: true })).toEqual({ kind: "sessionReset" });
    expect(composerBuiltInCommand("/clear", { sessionResetSupported: false })).toBeUndefined();
    expect(composerBuiltInCommand("/clear this", { sessionResetSupported: true })).toBeUndefined();
  });

  it("adds and strictly intercepts the capability-driven isolated /review command", () => {
    expect(composerCommandItems([], [], { reviewSupported: true })).toEqual([
      expect.objectContaining({ id: "builtin:review", value: "/review" })
    ]);
    expect(composerBuiltInCommand("/review", { reviewSupported: true })).toEqual({ kind: "review", focus: "" });
    expect(composerBuiltInCommand("/review focus on auth\nand data loss", { reviewSupported: true })).toEqual({
      kind: "review",
      focus: "focus on auth\nand data loss"
    });
    expect(composerBuiltInCommand("/REVIEW security", { reviewSupported: true })).toEqual({ kind: "review", focus: "security" });
    expect(composerBuiltInCommand(" /review", { reviewSupported: true })).toBeUndefined();
    expect(composerBuiltInCommand("/review-template", { reviewSupported: true })).toBeUndefined();
    expect(composerBuiltInCommand("/review", { reviewSupported: false })).toBeUndefined();
  });

  it("shares insertion and stale-mention pruning semantics", () => {
    const item = { id: "one", label: "File", value: "@src/a.ts", meta: "src/a.ts" };
    expect(insertComposerPaletteValue("@", "@", item)).toBe("@src/a.ts ");
    expect(insertComposerPaletteValue("Inspect", undefined, item)).toBe("Inspect @src/a.ts ");
    expect(mentionsStillPresent("keep @one", [
      { id: "one", kind: "resource", reference: "one", label: "One", token: "@one" },
      { id: "two", kind: "resource", reference: "two", label: "Two", token: "@two" }
    ]).map((mention) => mention.id)).toEqual(["one"]);
  });

  it("keeps detachable message chips structured instead of searching for a text token", () => {
    expect(mentionsStillPresent("ordinary draft text", [{
      id: "message:session-1:event-1",
      kind: "message",
      reference: "message-1",
      label: "Review task",
      sessionId: "session-1",
      role: "assistant",
      sourceEventId: "event-1"
    }])).toHaveLength(1);
  });
});

function resource(overrides: Partial<ResourceView> & Pick<ResourceView, "id" | "name" | "kind">): ResourceView {
  return {
    id: overrides.id,
    backendId: overrides.backendId ?? "backend-1",
    name: overrides.name,
    kind: overrides.kind,
    scope: overrides.scope ?? "managed",
    state: overrides.state ?? "loaded",
    enabled: overrides.enabled ?? true,
    source: overrides.source ?? "test",
    discoveredRevision: overrides.discoveredRevision ?? "1",
    compatibilityDetails: overrides.compatibilityDetails ?? [],
    runtimeRequirements: overrides.runtimeRequirements ?? [],
    warnings: overrides.warnings ?? [],
    disabledLifecycleScripts: overrides.disabledLifecycleScripts ?? [],
    canToggle: overrides.canToggle ?? true,
    requiresExtensionApproval: overrides.requiresExtensionApproval ?? false,
    postMutationNotice: overrides.postMutationNotice ?? false,
    ...(overrides.targetId === undefined ? {} : { targetId: overrides.targetId })
  };
}
