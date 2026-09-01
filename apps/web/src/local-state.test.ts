import { describe, expect, it } from "vitest";

import { DEFAULT_UI_PREFERENCES, normalizeComposerMentions, normalizeNewSessionLocalDraft, normalizeUiPreferences } from "./local-state.js";
import { plainTextToComposerDocument } from "./composer-quote-document.js";

describe("durable UI preferences", () => {
  it("accepts the complete current preferences shape", () => {
    const current = {
      ...DEFAULT_UI_PREFERENCES,
      uiFamily: '"HarmonyOS Sans SC"',
      codeFamily: '"JetBrains Mono Variable", "JetBrains Mono"',
      uiSize: 18,
      codeSize: 24,
      windowZoom: 0.7,
      navigationMode: "rail" as const,
      navigationOpen: true,
      navigationWidth: 480,
      messageSearchSort: "activityDesc" as const,
      messageNavRailEnabled: false,
      sessionNotificationsEnabled: false,
      appShortcutOverrides: {
        "find-in-page": { code: "KeyG", key: "g", meta: false, ctrl: true, alt: true, shift: false },
        "search-in-project": null
      },
      sidebarDisplayPreferences: {
        status: "all" as const,
        backendId: "backend-a" as const,
        lastActivity: "7d" as const,
        groupBy: "flat" as const,
        groupDialogue: false,
        groupDevice: false,
        sortBy: "priority" as const,
        projectOrder: "custom" as const,
        mainViewMode: "text" as const,
        pinnedViewMode: "card" as const,
        sessionInfoFields: ["tokens", "time"] as const
      },
      sidebarOwnerLayouts: {
        "orchestrator-a": {
          projectFilter: ["target-a"],
          manualProjectOrder: ["target-b", "target-a"],
          manualPinnedOrder: ["session-b", "session-a"],
          collapsedProjectIds: ["target-a"],
          collapsedDialogue: true
        }
      }
    };
    expect(normalizeUiPreferences(current)).toEqual(current);
  });

  it("rehydrates sparse non-default overrides without discarding them", () => {
    expect(normalizeUiPreferences({
      linkOpenPreference: "external",
      streamFadeEnabled: false,
      messageNavRailEnabled: false,
      personalizationPrompts: { "orchestrator-a": "Explain tradeoffs." }
    })).toEqual({
      ...DEFAULT_UI_PREFERENCES,
      linkOpenPreference: "external",
      streamFadeEnabled: false,
      messageNavRailEnabled: false,
      personalizationPrompts: { "orchestrator-a": "Explain tradeoffs." }
    });
  });

  it("falls back as a whole for incomplete, extra, or malformed preference records", () => {
    const { theme: _theme, ...incomplete } = DEFAULT_UI_PREFERENCES;
    expect(normalizeUiPreferences(undefined)).toEqual(DEFAULT_UI_PREFERENCES);
    expect(normalizeUiPreferences(incomplete)).toEqual(DEFAULT_UI_PREFERENCES);
    expect(normalizeUiPreferences({ ...DEFAULT_UI_PREFERENCES, theme: "sepia" })).toEqual(DEFAULT_UI_PREFERENCES);
    expect(normalizeUiPreferences({ ...DEFAULT_UI_PREFERENCES, obsoleteSetting: true })).toEqual(DEFAULT_UI_PREFERENCES);
    expect(normalizeUiPreferences({ ...DEFAULT_UI_PREFERENCES, uiFamily: " padded " })).toEqual(DEFAULT_UI_PREFERENCES);
    expect(normalizeUiPreferences({
      ...DEFAULT_UI_PREFERENCES,
      sidebarDisplayPreferences: { ...DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences, status: "unknown" }
    })).toEqual(DEFAULT_UI_PREFERENCES);
  });

  it("accepts only exact current automatic-connection targets", () => {
    const managed = { ...DEFAULT_UI_PREFERENCES, automaticConnectionTarget: { kind: "managedLocal" as const } };
    const remote = { ...DEFAULT_UI_PREFERENCES, automaticConnectionTarget: { kind: "profile" as const, profileId: "remote-profile" } };
    expect(normalizeUiPreferences(managed)).toEqual(managed);
    expect(normalizeUiPreferences(remote)).toEqual(remote);
    expect(normalizeUiPreferences({ ...managed, automaticConnectionTarget: { kind: "managedLocal", profileId: "ignored" } })).toEqual(DEFAULT_UI_PREFERENCES);
    expect(normalizeUiPreferences({ ...remote, automaticConnectionTarget: { kind: "profile", profileId: "bad\nprofile" } })).toEqual(DEFAULT_UI_PREFERENCES);
  });
});
describe("owner-scoped delayed-create drafts", () => {
  it("restores bounded attachment bytes and opaque approved-directory IDs without paths", () => {
    const image = new File([new Uint8Array([1, 2, 3])], "capture.png", { type: "image/png", lastModified: 42 });
    const draft = normalizeNewSessionLocalDraft({
      selection: { kind: "target", targetId: "target-1" },
      nativeStart: { kind: "attach", reference: "native-1" },
      providerId: "provider-1",
      modelId: "model-1",
      effort: "high",
      fastMode: true,
      permissionMode: "auto",
      planMode: true,
      text: "Review @src/main.ts",
      editorDocument: plainTextToComposerDocument("Review @src/main.ts"),
      mentions: [{ id: "file-1", kind: "workspace", reference: "src/main.ts", label: "main.ts", token: "@src/main.ts", workspaceId: "workspace-1" }],
      attachments: [
        { id: "attachment-1", kind: "image", file: image, previewUrl: "blob:must-not-survive" },
        { secret: "must not survive" }
      ],
      extraDirectoryIds: ["extra-approved-id", "extra-approved-id", "../server/path", "bad\u0000id"]
    });

    expect(draft).toEqual({
      selection: { kind: "target", targetId: "target-1" },
      nativeStart: { kind: "attach", reference: "native-1" },
      providerId: "provider-1",
      modelId: "model-1",
      effort: "high",
      fastMode: true,
      permissionMode: "auto",
      planMode: true,
      text: "Review @src/main.ts",
      editorDocument: plainTextToComposerDocument("Review @src/main.ts"),
      mentions: [{ id: "file-1", kind: "workspace", reference: "src/main.ts", label: "main.ts", token: "@src/main.ts", workspaceId: "workspace-1" }],
      attachments: [{ id: "attachment-1", kind: "image", file: image }],
      extraDirectoryIds: ["extra-approved-id"]
    });
  });

  it("fails closed on invalid target identity and strips malformed mentions", () => {
    expect(normalizeNewSessionLocalDraft({ selection: { kind: "target", targetId: "" }, text: "", nativeStart: { kind: "fresh" } })).toBeUndefined();
    expect(normalizeNewSessionLocalDraft({
      selection: { kind: "dialogue", backendId: "backend-1" },
      text: "hello",
      editorDocument: plainTextToComposerDocument("hello"),
      nativeStart: { kind: "fresh" },
      permissionMode: "backend-specific",
      mentions: [{ id: "bad", kind: "artifact", reference: "x", label: "x", token: "@x" }]
    })).toMatchObject({ permissionMode: "ask", mentions: [], attachments: [] });
  });

  it("requires and normalizes the structured first-message document", () => {
    const common = {
      selection: { kind: "target", targetId: "target-1" },
      nativeStart: { kind: "fresh" },
      text: "- inspect\n- verify"
    };
    const structured = {
      type: "doc",
      content: [{
        type: "bulletList",
        attrs: { marker: "-", separator: " " },
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "inspect" }] }] },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "verify" }] }] }
        ]
      }]
    };

    expect(normalizeNewSessionLocalDraft({ ...common, editorDocument: structured })?.editorDocument).toEqual(structured);
    expect(normalizeNewSessionLocalDraft({ ...common, editorDocument: { type: "untrusted", content: [] } })).toBeUndefined();
    expect(normalizeNewSessionLocalDraft(common)).toBeUndefined();
  });

  it("restores only bounded isolated-workspace intent without persisting service paths", () => {
    expect(normalizeNewSessionLocalDraft({
      selection: { kind: "target", targetId: "target-1" },
      text: "inspect",
      editorDocument: plainTextToComposerDocument("inspect"),
      nativeStart: { kind: "fresh" },
      worktree: { enabled: true, sourceRef: "refs/remotes/origin/main", refreshRemote: true, serverPath: "must-not-survive" }
    })?.worktree).toEqual({ enabled: true, sourceRef: "refs/remotes/origin/main", refreshRemote: true });

    expect(normalizeNewSessionLocalDraft({
      selection: { kind: "target", targetId: "target-1" },
      text: "inspect",
      editorDocument: plainTextToComposerDocument("inspect"),
      nativeStart: { kind: "fresh" },
      worktree: { enabled: true, sourceRef: "refs/heads/main\nmalformed", refreshRemote: true }
    })).toBeUndefined();
  });
});

describe("structured composer message references", () => {
  it("restores bounded message identities while preserving existing mention kinds", () => {
    expect(normalizeComposerMentions([
      { id: "resource:one", kind: "resource", reference: "one", label: "One", token: "@One" },
      { id: "message:s1:e1", kind: "message", reference: "m1", label: " Task ", sessionId: "s1", role: "assistant", sourceEventId: "e1" }
    ])).toEqual([
      { id: "resource:one", kind: "resource", reference: "one", label: "One", token: "@One" },
      { id: "message:s1:e1", kind: "message", reference: "m1", label: "Task", sessionId: "s1", role: "assistant", sourceEventId: "e1" }
    ]);
  });

  it("drops malformed message references from untrusted IndexedDB data", () => {
    expect(normalizeComposerMentions([
      { id: "bad-role", kind: "message", reference: "m1", label: "Task", sessionId: "s1", role: "tool" },
      { id: "bad-session", kind: "message", reference: "m1", label: "Task", sessionId: "s1\nother", role: "user" }
    ])).toEqual([]);
  });
});
