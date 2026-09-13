import { describe, expect, it } from "vitest";
import type { RuntimeCommandView, SessionView, WorkspaceEntryView } from "../model.js";
import {
  composerBuiltInCommand,
  composerCommandItems,
  composerMentionItems,
  detectComposerCommandActivation,
  filterComposerPaletteItems,
  insertComposerPaletteValue,
  mentionsStillPresent,
  replaceComposerCommandRun
} from "./composer-palette.js";

describe("shared composer palettes", () => {
  it("exposes and strictly parses the application help, task jump, and generic shell commands", () => {
    const options = { helpSupported: true, jumpSessionSupported: true, userShellSupported: true };
    expect(composerCommandItems([], options).map((item) => item.value)).toEqual([
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

  it("projects only workspace references before a task has a live runtime catalog", () => {
    const entries: readonly WorkspaceEntryView[] = [{
      path: "src",
      name: "src",
      kind: "directory",
      generated: false,
      children: [{ path: "src/main.ts", name: "main.ts", kind: "file", generated: false }]
    }];
    const items = composerMentionItems(entries, "workspace-1");

    expect(items[0]?.mention).toEqual({
      id: "workspace:workspace-1:src/main.ts",
      kind: "workspace",
      reference: "src/main.ts",
      label: "main.ts",
      token: "@src/main.ts",
      workspaceId: "workspace-1"
    });
    expect(items).toHaveLength(1);
  });

  it("adds exact historical task identities to a new task palette", () => {
    const base = {
      name: "Previous task", state: "idle" as const, backendId: "backend", targetId: "target",
      pinned: false, archived: false, generation: 1n, fastMode: false, permissionMode: "ask" as const,
      planMode: false, updatedAt: 1
    };
    const sessions: readonly SessionView[] = [{ ...base, id: "first" }, { ...base, id: "second" }];
    expect(composerMentionItems([], undefined, [], sessions).map((item) => item.mention)).toEqual([
      expect.objectContaining({ id: "session:first", kind: "session", reference: "first" }),
      expect.objectContaining({ id: "session:second", kind: "session", reference: "second" })
    ]);
  });

  it("uses only commands observed from the live runtime", () => {
    const commands: readonly RuntimeCommandView[] = [{
      id: "command-1",
      name: "review",
      description: "Review changes",
      source: "skill",
      resourceId: "skill-1",
      loaded: true
    }];
    const items = composerCommandItems(commands);

    expect(items.map((item) => item.value)).toEqual(["/review"]);
  });

  it("tracks a slash query at a token boundary and owns the complete run around the caret", () => {
    expect(detectComposerCommandActivation("inspect /rev", 12, { isComposing: false, bashMode: false }))
      .toEqual({ from: 8, to: 12, query: "rev" });
    expect(detectComposerCommandActivation("/review later", 4, { isComposing: false, bashMode: false }))
      .toEqual({ from: 0, to: 7, query: "rev" });
    expect(detectComposerCommandActivation("line\n/re", 8, { isComposing: false, bashMode: false }))
      .toEqual({ from: 5, to: 8, query: "re" });
    expect(detectComposerCommandActivation("path/to", 7, { isComposing: false, bashMode: false })).toBeUndefined();
    expect(detectComposerCommandActivation("//review", 8, { isComposing: false, bashMode: false })).toBeUndefined();
    expect(detectComposerCommandActivation("/rev", 4, { isComposing: true, bashMode: false })).toBeUndefined();
    expect(detectComposerCommandActivation("/rev", 4, { isComposing: false, bashMode: true })).toBeUndefined();
  });

  it("filters with the live query and replaces the whole slash run without duplicating whitespace", () => {
    const items = composerCommandItems([], { helpSupported: true, reviewSupported: true });
    expect(filterComposerPaletteItems(items, "rev").map((item) => item.value)).toEqual(["/review"]);
    expect(replaceComposerCommandRun("ask /review later", { from: 4, to: 11, query: "rev" }, "/help"))
      .toEqual({ text: "ask /help later", caret: 9, replacement: "/help" });
    expect(replaceComposerCommandRun("ask /review", { from: 4, to: 11, query: "rev" }, "/help"))
      .toEqual({ text: "ask /help ", caret: 10, replacement: "/help " });
    expect(replaceComposerCommandRun("ask /review later", { from: 4, to: 8, query: "rev" }, "/help"))
      .toBeUndefined();
    expect(replaceComposerCommandRun("ask /review later", { from: 4, to: 11, query: "other" }, "/help"))
      .toBeUndefined();
  });

  it("adds and intercepts /clear only when session.reset is supported", () => {
    expect(composerCommandItems([], { sessionResetSupported: false })).toEqual([]);
    expect(composerCommandItems([], { sessionResetSupported: true })).toEqual([
      expect.objectContaining({ id: "builtin:clear", value: "/clear" })
    ]);
    expect(composerBuiltInCommand(" /clear ", { sessionResetSupported: true })).toEqual({ kind: "sessionReset" });
    expect(composerBuiltInCommand("/clear", { sessionResetSupported: false })).toBeUndefined();
    expect(composerBuiltInCommand("/clear this", { sessionResetSupported: true })).toBeUndefined();
  });

  it("adds and strictly intercepts the capability-driven isolated /review command", () => {
    expect(composerCommandItems([], { reviewSupported: true })).toEqual([
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
      { id: "one", kind: "resource", reference: "one", label: "One", token: "@one", discoveredRevision: "revision-one", resourceVersion: "1", runtimeGeneration: 2 },
      { id: "two", kind: "resource", reference: "two", label: "Two", token: "@two", discoveredRevision: "revision-two", resourceVersion: "2", runtimeGeneration: 2 }
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
