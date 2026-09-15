import { describe, expect, it, vi } from "vitest";

import {
  appendBrowserCommentDraftTarget,
  newSessionBrowserCommentDraftTarget,
  sessionBrowserCommentDraftTarget
} from "./browser-comment-draft-target.js";
import { emptySnapshot, type AppSnapshot, type BrowserCommentDraftItem, type NewSessionLocalDraft, type SessionView } from "./model.js";
import type { AppController } from "./controller.js";
import { plainTextToComposerDocument } from "./composer-quote-document.js";

describe("Browser annotation draft targets", () => {
  it("offers only an exact image-capable new-task route and appends without flattening its structured draft", async () => {
    const draft = newTaskDraft();
    const snapshot = imageSnapshot();
    const target = newSessionBrowserCommentDraftTarget(draft, snapshot, "New task draft");
    expect(target).toEqual({ key: JSON.stringify(["newSession"]), kind: "newSession", label: "New task draft" });
    expect(newSessionBrowserCommentDraftTarget({ ...draft, modelId: "missing" }, snapshot, "New task draft")).toBeUndefined();

    const saveNewSessionDraft = vi.fn(async () => undefined);
    const controller = {
      readNewSessionDraft: vi.fn(async () => draft),
      saveNewSessionDraft
    } as unknown as AppController;
    const item = browserComment();
    await appendBrowserCommentDraftTarget(controller, target!, item);

    expect(saveNewSessionDraft).toHaveBeenCalledExactlyOnceWith({ ...draft, browserComments: [item] });
  });

  it("uses the real task draft CAS and retries without replacing newer composer input", async () => {
    const session = sessionView();
    const target = sessionBrowserCommentDraftTarget(session, session.name);
    const latest = { text: "Typed while annotating", editorDocument: plainTextToComposerDocument("Typed while annotating"), attachments: [], mentions: [], deliveryMode: "prompt" as const };
    const readDraftSnapshot = vi.fn()
      .mockResolvedValueOnce({ revision: 2, draft: { ...latest, text: "Earlier", editorDocument: plainTextToComposerDocument("Earlier") } })
      .mockResolvedValueOnce({ revision: 3, draft: latest });
    const saveDraftIfRevision = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(4);
    const controller = { readDraftSnapshot, saveDraftIfRevision } as unknown as AppController;
    const item = browserComment();

    await appendBrowserCommentDraftTarget(controller, target, item);

    expect(saveDraftIfRevision.mock.calls.map((call) => call[2])).toEqual([2, 3]);
    expect(saveDraftIfRevision.mock.calls[1]?.[1]).toEqual({ ...latest, browserComments: [item] });
  });
});

function newTaskDraft(): NewSessionLocalDraft {
  return {
    selection: { kind: "target", targetId: "target" },
    nativeStart: { kind: "fresh" },
    providerId: "provider",
    modelId: "model",
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    text: "Review @source",
    editorDocument: plainTextToComposerDocument("Review @source"),
    mentions: [{ id: "source", kind: "workspace", reference: "source.ts", label: "source.ts", token: "@source", workspaceId: "workspace" }],
    inlineMentionRanges: [{ mentionId: "source", from: 7, to: 14 }],
    attachments: [],
    extraDirectoryIds: ["approved-directory"]
  };
}

function imageSnapshot(): AppSnapshot {
  const snapshot = emptySnapshot();
  return {
    ...snapshot,
    targets: [{ id: "target", backendId: "backend", name: "Project", workspaceId: "workspace", revision: 1n, workspaceName: "Project", trusted: true, pinned: false, archived: false }],
    backends: [{ id: "backend", name: "Backend", version: "1", health: "healthy", capabilities: new Map([
      ["input.image", { name: "input.image", supported: true, options: [] }]
    ]) }],
    models: [{
      backendId: "backend", providerId: "provider", providerName: "Provider", modelId: "model", name: "Model",
      available: true, supportsImages: true, supportsFast: false, inputModalities: ["text", "image"], outputModalities: ["text"],
      efforts: [], contextWindow: 8_192, maximumOutputTokens: 2_048,
      inputCostMicrosPerMillion: 0, outputCostMicrosPerMillion: 0, currencyCode: "USD"
    }]
  };
}

function sessionView(): SessionView {
  return { id: "session", backendId: "backend", targetId: "target", name: "Task", state: "idle", pinned: false, archived: false, generation: 1n, fastMode: false, permissionMode: "ask", planMode: false, updatedAt: 1 };
}

function browserComment(): BrowserCommentDraftItem {
  return {
    id: "comment",
    markerNumber: 1,
    pageUrl: "https://example.com/",
    target: { kind: "element", point: { x: 20, y: 30 }, viewport: { width: 800, height: 600 } },
    comment: "Align this",
    screenshot: { id: "screenshot", kind: "image", file: new File(["png"], "comment.png", { type: "image/png" }) }
  };
}
