import { describe, expect, it } from "vitest";

import {
  DEFAULT_UI_PREFERENCES,
  LocalState,
  normalizeComposerMentions,
  normalizeNewSessionLocalDraft,
  normalizePendingExtensionSuggestion,
  normalizePendingExtensionUse,
  normalizeRecentExtensionSuggestions,
  normalizeUiPreferences
} from "./local-state.js";
import { plainTextToComposerDocument } from "./composer-quote-document.js";
import type { PendingExtensionSuggestionView } from "./model.js";

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
      webLinkOpenPreference: "sidebar",
      localLinkOpenPreference: "external",
      streamFadeEnabled: false,
      messageNavRailEnabled: false,
      personalizationPrompts: { "orchestrator-a": "Explain tradeoffs." }
    })).toEqual({
      ...DEFAULT_UI_PREFERENCES,
      webLinkOpenPreference: "sidebar",
      localLinkOpenPreference: "external",
      streamFadeEnabled: false,
      messageNavRailEnabled: false,
      personalizationPrompts: { "orchestrator-a": "Explain tradeoffs." }
    });
  });

  it("accepts the current system locale preference and rejects non-v1 aliases", () => {
    expect(normalizeUiPreferences({ locale: "system" })).toEqual(DEFAULT_UI_PREFERENCES);
    expect(normalizeUiPreferences({ theme: "light", locale: "auto" })).toEqual(DEFAULT_UI_PREFERENCES);
    expect(normalizeUiPreferences({ theme: "light", locale: "default" })).toEqual(DEFAULT_UI_PREFERENCES);
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
  it("retains only the exact revision-fenced Extension use handoff", () => {
    const handoff = {
      extensionId: "extension_0123456789abcdef0123456789abcdef",
      extensionRevision: "7",
      commandName: "review",
      runtimeSessionId: "session-runtime-1",
      displayName: "Review tools",
      owner: {
        kind: "resource",
        resourceId: "resource-1",
        discoveredRevision: "sha256:owner",
        resourceRevision: "4"
      },
      secret: "must-not-survive"
    };

    expect(normalizePendingExtensionUse(handoff)).toEqual({
      extensionId: handoff.extensionId,
      extensionRevision: "7",
      commandName: "review",
      runtimeSessionId: "session-runtime-1",
      displayName: "Review tools",
      owner: handoff.owner
    });
    expect(normalizePendingExtensionUse({ ...handoff, extensionRevision: "0" })).toBeUndefined();
    expect(normalizePendingExtensionUse({ ...handoff, runtimeSessionId: " bad\nsession " })).toBeUndefined();
    expect(normalizePendingExtensionUse({ ...handoff, owner: { ...handoff.owner, discoveredRevision: "" } })).toBeUndefined();
  });

  it("retains the exact current Extension suggestion shape and bounded recent identities", () => {
    const handoff = pendingExtensionSuggestion();
    expect(normalizePendingExtensionSuggestion({ ...handoff, secret: "must-not-survive" })).toEqual(handoff);
    expect(normalizePendingExtensionSuggestion({ ...handoff, nonce: "not-a-nonce" })).toBeUndefined();
    expect(normalizePendingExtensionSuggestion({ ...handoff, selectedPrompt: "Changed after selection" })).toBeUndefined();
    expect(normalizePendingExtensionSuggestion({
      ...handoff,
      recommendation: { ...handoff.recommendation, command: "review" },
      runtimeSessionId: undefined
    })?.recommendation.command).toBe("review");
    expect(normalizeRecentExtensionSuggestions([
      handoff.extensionId,
      "extension_11111111111111111111111111111111",
      handoff.extensionId,
      "invalid",
      "extension_22222222222222222222222222222222",
      "extension_33333333333333333333333333333333",
      "extension_44444444444444444444444444444444",
      "extension_55555555555555555555555555555555"
    ])).toEqual([
      handoff.extensionId,
      "extension_11111111111111111111111111111111",
      "extension_22222222222222222222222222222222",
      "extension_33333333333333333333333333333333",
      "extension_44444444444444444444444444444444"
    ]);
  });

  it("persists the frozen draft and atomically CASes and consumes one exact nonce", async () => {
    const memory = memoryDatabase();
    const state = Reflect.construct(LocalState as unknown as Function, [memory.database]) as LocalState;
    const setup = { ...pendingExtensionSuggestion(), phase: "setup" as const };
    await state.savePendingExtensionSuggestion("owner", setup);

    const restored = await state.readPendingExtensionSuggestion("owner", setup.nonce);
    expect(restored).toMatchObject({
      nonce: setup.nonce,
      phase: "setup",
      draft: {
        text: "Review the draft",
        attachments: [{ id: "attachment-1", kind: "file" }],
        browserComments: [{ id: "comment-1", screenshot: { id: "comment-image-1", kind: "image" } }],
        extraDirectoryIds: ["extra-1"]
      }
    });
    expect(await restored!.draft.attachments[0]!.file.text()).toBe("attachment bytes");

    expect(await state.compareAndSetPendingExtensionSuggestion("owner", {
      ...setup,
      contextKey: JSON.stringify([1, "server", "another-profile", 3, "target", "target-1"])
    }, { ...setup, phase: "ready" })).toBe(false);
    expect(await state.compareAndSetPendingExtensionSuggestion("owner", setup, { ...setup, phase: "ready" })).toBe(true);

    const consumed = await state.consumePendingExtensionSuggestion("owner", setup.nonce, setup.contextKey);
    expect(consumed?.phase).toBe("ready");
    expect(await state.consumePendingExtensionSuggestion("owner", setup.nonce, setup.contextKey)).toBeUndefined();
    const consumeTransaction = memory.operations.filter((entry) => entry.transaction === memory.lastTransaction());
    expect(consumeTransaction.map((entry) => entry.kind)).toEqual(["get"]);
    const successfulConsume = memory.operations.filter((entry) => entry.transaction === memory.lastDeleteTransaction());
    expect(successfulConsume.map((entry) => entry.kind)).toEqual(["get", "delete"]);
    expect(successfulConsume.every((entry) => entry.mode === "readwrite")).toBe(true);
  });

  it("does not clear a newer nonce and clears only exact invalid durable data", async () => {
    const memory = memoryDatabase();
    const state = Reflect.construct(LocalState as unknown as Function, [memory.database]) as LocalState;
    const current = pendingExtensionSuggestion();
    await state.savePendingExtensionSuggestion("owner", current);
    expect(await state.consumePendingExtensionSuggestion(
      "owner",
      "11111111-1111-4111-8111-111111111111",
      current.contextKey
    )).toBeUndefined();
    expect((await state.readPendingExtensionSuggestion("owner"))?.nonce).toBe(current.nonce);

    memory.failNextRead();
    await expect(state.readPendingExtensionSuggestion("owner", current.nonce)).rejects.toThrow("transient IndexedDB read");
    expect((await state.readPendingExtensionSuggestion("owner"))?.nonce).toBe(current.nonce);

    const key = memory.records.keys().find((candidate) => String(candidate).includes("pending-extension-suggestion"));
    expect(key).toBeDefined();
    memory.records.set(key!, { ...(memory.records.get(key!) as Record<string, unknown>), phase: "old-shape" });
    expect(await state.readPendingExtensionSuggestion("owner", current.nonce)).toBeUndefined();
    expect(memory.records.has(key!)).toBe(false);
  });

  it("records at most five most-recent Extension uses without duplicate identities", async () => {
    const memory = memoryDatabase();
    const state = Reflect.construct(LocalState as unknown as Function, [memory.database]) as LocalState;
    const ids = Array.from({ length: 6 }, (_, index) => `extension_${index.toString(16).padStart(32, "0")}`);
    for (const id of ids) await state.recordExtensionSuggestionUse("owner", id);
    await state.recordExtensionSuggestionUse("owner", ids[2]!);
    expect(await state.readRecentExtensionSuggestions("owner")).toEqual([
      ids[2], ids[5], ids[4], ids[3], ids[1]
    ]);
  });

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
      inlineMentionRanges: [{ mentionId: "file-1", from: 7, to: 19 }],
      attachments: [
        { id: "attachment-1", kind: "image", file: image, previewUrl: "blob:must-not-survive" },
        { secret: "must not survive" }
      ],
      browserComments: [{
        id: "comment-1",
        markerNumber: 1,
        pageUrl: "https://example.com/design",
        target: { kind: "element", point: { x: 10, y: 20 }, viewport: { width: 800, height: 600 } },
        comment: "  Align this  ",
        screenshot: { id: "comment-image-1", kind: "image", file: image, previewUrl: "blob:must-not-survive" }
      }],
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
      inlineMentionRanges: [{ mentionId: "file-1", from: 7, to: 19 }],
      attachments: [{ id: "attachment-1", kind: "image", file: image }],
      browserComments: [{
        id: "comment-1",
        markerNumber: 1,
        pageUrl: "https://example.com/design",
        target: { kind: "element", point: { x: 10, y: 20 }, viewport: { width: 800, height: 600 } },
        comment: "Align this",
        screenshot: { id: "comment-image-1", kind: "image", file: image }
      }],
      extraDirectoryIds: ["extra-approved-id"]
    });
  });

  it("fails closed on invalid target identity and malformed durable mentions", () => {
    expect(normalizeNewSessionLocalDraft({ selection: { kind: "target", targetId: "" }, text: "", nativeStart: { kind: "fresh" } })).toBeUndefined();
    expect(normalizeNewSessionLocalDraft({
      selection: { kind: "dialogue", backendId: "backend-1" },
      text: "hello",
      editorDocument: plainTextToComposerDocument("hello"),
      nativeStart: { kind: "fresh" },
      permissionMode: "backend-specific",
      mentions: [{ id: "bad", kind: "artifact", reference: "x", label: "x", token: "@x", workspaceId: "invalid-artifact-scope" }]
    })).toBeUndefined();
  });

  it("retains an editable new-task draft before any Backend or Target is selected", () => {
    const draft = {
      selection: { kind: "unselected" },
      nativeStart: { kind: "fresh" },
      text: "Keep this while disconnected",
      editorDocument: plainTextToComposerDocument("Keep this while disconnected"),
      mentions: [],
      attachments: []
    };
    expect(normalizeNewSessionLocalDraft(draft)?.selection).toEqual({ kind: "unselected" });
    expect(normalizeNewSessionLocalDraft(draft)?.text).toBe(draft.text);
    expect(normalizeNewSessionLocalDraft({ ...draft, selection: { kind: "unselected", targetId: "other" } })).toBeUndefined();
  });

  it("requires and normalizes the structured first-message document", () => {
    const common = {
      selection: { kind: "target", targetId: "target-1" },
      nativeStart: { kind: "fresh" },
      text: "- inspect\n- verify",
      mentions: []
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
      mentions: [],
      worktree: { enabled: true, sourceRef: "refs/remotes/origin/main", refreshRemote: true, serverPath: "must-not-survive" }
    })?.worktree).toEqual({ enabled: true, sourceRef: "refs/remotes/origin/main", refreshRemote: true });

    expect(normalizeNewSessionLocalDraft({
      selection: { kind: "target", targetId: "target-1" },
      text: "inspect",
      editorDocument: plainTextToComposerDocument("inspect"),
      nativeStart: { kind: "fresh" },
      mentions: [],
      worktree: { enabled: true, sourceRef: "refs/heads/main\nmalformed", refreshRemote: true }
    })).toBeUndefined();
  });
});

describe("structured composer message references", () => {
  it("retains typed directory and line references and rejects invalid source ranges", () => {
    const base = { id: "workspace:source", kind: "workspace", reference: "src/main.ts", label: "main.ts", token: "@main.ts" };
    for (const metadata of [{ directory: true }, { lineRange: { startLine: 2, endLine: 7 } }]) {
      const mention = { ...base, ...metadata };
      expect(normalizeComposerMentions([mention])).toEqual([mention]);
    }
    for (const metadata of [
      { directory: true, lineRange: { startLine: 1, endLine: 2 } },
      { lineRange: { startLine: 0, endLine: 2 } },
      { lineRange: { startLine: 2, endLine: 1 } }
    ]) expect(normalizeComposerMentions([{ ...base, ...metadata }])).toEqual([]);
  });

  it("restores bounded message identities while preserving existing mention kinds", () => {
    const resource = { id: "resource:one", kind: "resource", reference: "one", label: "One", token: "@One", discoveredRevision: "revision-one", resourceVersion: "7", runtimeGeneration: 3 };
    expect(normalizeComposerMentions([
      resource,
      { id: "message:s1:e1", kind: "message", reference: "m1", label: " Task ", sessionId: "s1", role: "assistant", sourceEventId: "e1" }
    ])).toEqual([
      resource,
      { id: "message:s1:e1", kind: "message", reference: "m1", label: "Task", sessionId: "s1", role: "assistant", sourceEventId: "e1" }
    ]);
  });

  it("rejects an old resource mention shape at the durable new-task draft boundary", () => {
    const current = normalizeNewSessionLocalDraft({
      selection: { kind: "target", targetId: "target-1" },
      nativeStart: { kind: "fresh" },
      providerId: "",
      modelId: "",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      text: "@One",
      editorDocument: plainTextToComposerDocument("@One"),
      mentions: [{ id: "resource:one", kind: "resource", reference: "one", label: "One", token: "@One" }],
      inlineMentionRanges: [{ mentionId: "resource:one", from: 0, to: 4 }],
      attachments: []
    });
    expect(current).toBeUndefined();
  });

  it("round-trips exact Artifact source identities and rejects the old source-less shape", () => {
    const mentions = [
      { id: "artifact:source-one:shared", kind: "artifact", sourceSessionId: "source-one", reference: "shared", label: "Report", token: "@Report" },
      { id: "artifact:source-two:shared", kind: "artifact", sourceSessionId: "source-two", reference: "shared", label: "Report", token: "@Report" }
    ];
    expect(normalizeComposerMentions(mentions)).toEqual(mentions);
    expect(normalizeComposerMentions([
      { id: "artifact:legacy:shared", kind: "artifact", reference: "shared", label: "Report", token: "@Report" }
    ])).toEqual([]);
  });

  it("drops malformed message references from untrusted IndexedDB data", () => {
    expect(normalizeComposerMentions([
      { id: "bad-role", kind: "message", reference: "m1", label: "Task", sessionId: "s1", role: "tool" },
      { id: "bad-session", kind: "message", reference: "m1", label: "Task", sessionId: "s1\nother", role: "user" }
    ])).toEqual([]);
  });
});

function pendingExtensionSuggestion(): PendingExtensionSuggestionView {
  const attachment = new File(["attachment bytes"], "notes.txt", { type: "text/plain", lastModified: 7 });
  const screenshot = new File([new Uint8Array([1, 2, 3])], "comment.png", { type: "image/png", lastModified: 8 });
  return {
    nonce: "01234567-89ab-4cde-8fab-0123456789ab",
    phase: "ready",
    extensionId: "extension_0123456789abcdef0123456789abcdef",
    extensionRevision: "7",
    owner: {
      kind: "resource",
      resourceId: "resource-1",
      discoveredRevision: "sha256:resource",
      resourceRevision: "4"
    },
    recommendation: {
      id: "review-mail",
      label: "Review mail",
      prompt: "Review the messages needing attention.",
      locales: { "zh-CN": { label: "检查邮件", prompt: "检查需要处理的邮件。" } }
    },
    selectedLabel: "Review mail",
    selectedPrompt: "Review the messages needing attention.",
    contextKey: JSON.stringify([1, "server", "profile", 3, "target", "target-1", "7", "backend-1", 2, "1.0", "", ""]),
    draft: {
      selection: { kind: "target", targetId: "target-1" },
      nativeStart: { kind: "fresh" },
      providerId: "provider-1",
      modelId: "model-1",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      text: "Review the draft",
      editorDocument: plainTextToComposerDocument("Review the draft"),
      mentions: [],
      attachments: [{ id: "attachment-1", kind: "file", file: attachment }],
      browserComments: [{
        id: "comment-1",
        markerNumber: 1,
        pageUrl: "https://example.com/design",
        target: { kind: "element", point: { x: 10, y: 20 }, viewport: { width: 800, height: 600 } },
        comment: "Check this",
        screenshot: { id: "comment-image-1", kind: "image", file: screenshot }
      }],
      extraDirectoryIds: ["extra-1"]
    },
    backendId: "backend-1",
    targetId: "target-1"
  };
}

interface MemoryOperation {
  readonly transaction: number;
  readonly mode: IDBTransactionMode;
  readonly kind: "get" | "put" | "delete";
  readonly key: IDBValidKey;
}

function memoryDatabase(): {
  readonly database: IDBDatabase;
  readonly records: Map<IDBValidKey, unknown>;
  readonly operations: MemoryOperation[];
  readonly lastTransaction: () => number;
  readonly lastDeleteTransaction: () => number;
  readonly failNextRead: () => void;
} {
  const records = new Map<IDBValidKey, unknown>();
  const operations: MemoryOperation[] = [];
  let sequence = 0;
  let nextReadFails = false;
  const database = {
    transaction: (_store: string, mode: IDBTransactionMode) => {
      const transactionId = ++sequence;
      const transaction = {
        error: null,
        oncomplete: null as ((event: Event) => void) | null,
        onabort: null as ((event: Event) => void) | null,
        onerror: null as ((event: Event) => void) | null,
        abort: () => setTimeout(() => transaction.onabort?.(new Event("abort")), 0),
        objectStore: () => ({
          get: (key: IDBValidKey) => {
            operations.push({ transaction: transactionId, mode, kind: "get", key });
            const request = {
              result: undefined as unknown,
              error: null as DOMException | null,
              onsuccess: null as ((event: Event) => void) | null,
              onerror: null as ((event: Event) => void) | null
            };
            queueMicrotask(() => {
              if (nextReadFails) {
                nextReadFails = false;
                request.error = new DOMException("transient IndexedDB read", "UnknownError");
                request.onerror?.(new Event("error"));
                return;
              }
              request.result = records.get(key);
              request.onsuccess?.(new Event("success"));
            });
            return request as unknown as IDBRequest<unknown>;
          },
          put: (value: unknown, key: IDBValidKey) => {
            operations.push({ transaction: transactionId, mode, kind: "put", key });
            records.set(key, value);
            return {} as IDBRequest<IDBValidKey>;
          },
          delete: (key: IDBValidKey) => {
            operations.push({ transaction: transactionId, mode, kind: "delete", key });
            records.delete(key);
            return {} as IDBRequest<undefined>;
          }
        })
      };
      setTimeout(() => transaction.oncomplete?.(new Event("complete")), 0);
      return transaction as unknown as IDBTransaction;
    }
  } as unknown as IDBDatabase;
  return {
    database,
    records,
    operations,
    lastTransaction: () => sequence,
    lastDeleteTransaction: () => operations.findLast((entry) => entry.kind === "delete")?.transaction ?? -1,
    failNextRead: () => { nextReadFails = true; }
  };
}
