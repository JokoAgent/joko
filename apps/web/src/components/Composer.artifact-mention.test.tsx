// @vitest-environment jsdom
import type { JSONContent } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { composerDocumentPlainText, plainTextToComposerDocument } from "../composer-quote-document.js";
import { remapComposerInlineMentionReplacement } from "../composer-mention-ranges.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type BackendView, type ComposerDraft, type ComposerInlineMentionRange, type ComposerTokenMentionDraft, type SessionResourceView, type SessionView } from "../model.js";
import { Composer } from "./Composer.js";

let changeDocument: (document: JSONContent, composing: boolean, map: (ranges: readonly ComposerInlineMentionRange[]) => readonly ComposerInlineMentionRange[]) => void;
vi.mock("./ComposerRichTextEditor.js", () => ({
  ComposerRichTextEditor: ({ document, onDocumentChange }: { document: JSONContent; onDocumentChange: typeof changeDocument }) => {
    changeDocument = onDocumentChange;
    return <textarea aria-label="Draft" readOnly value={composerDocumentPlainText(document)} />;
  }
}));
const roots: Root[] = [];
const session: SessionView = { id: "task-one", backendId: "backend-one", targetId: "target-one", name: "Task one", state: "idle",
  pinned: false, archived: false, generation: 1n, fastMode: false, permissionMode: "ask", planMode: false, updatedAt: 0 };
const draft: ComposerDraft = { text: "Read @export", attachments: [], deliveryMode: "prompt", inlineMentionRanges: [{ mentionId: "mention-one", from: 5, to: 12 }], mentions: [
  { id: "mention-one", kind: "artifact", sourceSessionId: session.id, reference: "artifact-one", label: "Export", token: "@export" }
] };
const mentionCases: readonly { readonly kind: string; readonly mention: ComposerTokenMentionDraft; readonly options: string[] }[] = [
  { kind: "artifact", mention: { id: "mention-one", kind: "artifact", sourceSessionId: session.id, reference: "artifact-one", label: "Export", token: "@export" }, options: ["artifact"] },
  { kind: "file", mention: { id: "mention-one", kind: "workspace", reference: "artifact-one", label: "Export", token: "@export", workspaceId: "workspace" }, options: ["workspace_file"] },
  { kind: "directory", mention: { id: "mention-one", kind: "workspace", reference: "artifact-one", label: "Export", token: "@export", workspaceId: "workspace", directory: true }, options: ["workspace_directory"] },
  { kind: "line range", mention: { id: "mention-one", kind: "workspace", reference: "artifact-one", label: "Export", token: "@export", workspaceId: "workspace", lineRange: { startLine: 1, endLine: 2 } }, options: ["workspace_file", "workspace_line_range"] },
  { kind: "resource", mention: { id: "mention-one", kind: "resource", reference: "resource-one", label: "Export", token: "@export", discoveredRevision: "revision-one", resourceVersion: "5", runtimeGeneration: 1 }, options: ["resource"] }
];

beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("requestAnimationFrame", () => 0); });
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren(); vi.unstubAllGlobals();
});

it.each(mentionCases)("keeps a retained $kind mention editable until its exact capability is available", async ({ mention, options }) => {
  const retained = { ...draft, mentions: [mention] };
  const view = await mount(retained, { resources: resourceCatalog(mention) });
  for (const capability of [undefined, { supported: false, options }, { supported: true, options: [] }, { supported: true, options: ["workspace_line_range"] }]) {
    await view.render(capability);
    expect(view.send().disabled).toBe(true);
    expect(view.text()).toBe(draft.text);
  }
  expect(view.api.send).not.toHaveBeenCalled();
  await view.render({ supported: true, options });
  expect(view.send().disabled).toBe(false);
  await act(async () => { view.send().click(); await Promise.all(view.actions); });
  expect(view.api.send).toHaveBeenCalledExactlyOnceWith(session.id, expect.objectContaining({ text: retained.text, mentions: retained.mentions }), { expectedGeneration: session.generation });
});

it.each(mentionCases)("restores the exact $kind draft if support disappears while durable clearing is pending", async ({ mention, options }) => {
  const retained = { ...draft, mentions: [mention] };
  const view = await mount(retained, { resources: resourceCatalog(mention) });
  await view.render({ supported: true, options });
  let release!: () => void;
  vi.mocked(view.api.saveDraft).mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  await act(async () => view.send().click());
  expect(view.text()).toBe("");
  await view.render({ supported: true, options: [] });
  await act(async () => { release(); await Promise.all(view.actions); });
  expect(view.api.send).not.toHaveBeenCalled();
  expect(view.text()).toBe(draft.text);
  expect(view.api.saveDraft).toHaveBeenLastCalledWith(session.id, expect.objectContaining({ text: retained.text, mentions: retained.mentions }));
  expect(view.send().disabled).toBe(true);
  await view.render({ supported: true, options });
  expect(view.send().disabled).toBe(false);
  expect(view.api.send).not.toHaveBeenCalled();
});

it("limits an Artifact-only palette to canonical Artifacts despite loaded workspace files and resources", async () => {
  const view = await mount({ ...draft, mentions: [], inlineMentionRanges: [] }, {
    workspace: { id: "workspace", targetId: session.targetId, name: "Workspace", kind: "userProject", serverPath: "/workspace", trusted: true, dirty: false, entries: [
      { path: "private.ts", name: "private.ts", kind: "file", generated: false }
    ] },
    resources: [{ sessionId: session.id, id: "resource", name: "Hidden resource", kind: "skill", discoveredRevision: "revision-one", resourceVersion: "1", runtimeGeneration: 1 }],
    artifacts: ["one", "two"].map((id) => ({ id, sourceSessionId: session.id, blobId: id, title: `Export ${id}`, fileName: `${id}.txt`, kind: "file", mediaType: "text/plain", byteSize: 1 }))
  });
  await view.render({ supported: true, options: ["artifact"] });
  await act(async () => view.host.querySelector<HTMLButtonElement>('button[aria-label="common.add"]')!.click());
  const action = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent?.includes("composer.mention"))!;
  await act(async () => action.click());
  const candidates = [...document.body.querySelectorAll('[role="option"]')].map((option) => option.textContent);
  expect(candidates).toHaveLength(2);
  expect(candidates.join(" ")).toContain("Export one");
  expect(candidates.join(" ")).toContain("Export two");
  expect(candidates.join(" ")).not.toMatch(/private|Hidden resource|indexed/u);
  expect(view.api.listWorkspaceFiles).not.toHaveBeenCalled();
  await view.render({ supported: true, options: [] });
  expect(document.body.querySelector('[role="option"]')).toBeNull();
});

it("keeps Joko message references sendable without Backend mention support", async () => {
  const retained: ComposerDraft = { ...draft, text: "Read this", inlineMentionRanges: [], mentions: [
    { id: "message", kind: "message", reference: "m", label: "Prior message", sessionId: session.id, role: "assistant" }
  ] };
  const view = await mount(retained);
  expect(view.send().disabled).toBe(false);
  await act(async () => { view.send().click(); await Promise.all(view.actions); });
  expect(view.api.send).toHaveBeenCalledWith(session.id, expect.objectContaining({ mentions: retained.mentions }), expect.anything());
});

it("sends only the retained exact Artifact after deleting the other same-named occurrences from a restored draft", async () => {
  const sameName: ComposerDraft = { ...draft, text: "@Export @Export @Export", mentions: [
    { id: "a", kind: "artifact", sourceSessionId: session.id, reference: "artifact-a", label: "Export", token: "@Export" },
    { id: "b", kind: "artifact", sourceSessionId: "task-source", reference: "artifact-b", label: "Export", token: "@Export" }
  ], inlineMentionRanges: [
    { mentionId: "b", from: 0, to: 7 }, { mentionId: "a", from: 8, to: 15 }, { mentionId: "b", from: 16, to: 23 }
  ] };
  const view = await mount(sameName);
  await view.render({ supported: true, options: ["artifact"] });
  await act(async () => changeDocument(plainTextToComposerDocument("@Export @Export"), false,
    (ranges) => remapComposerInlineMentionReplacement(ranges, 0, 8, 0)));
  await act(async () => changeDocument(plainTextToComposerDocument("@Export"), false,
    (ranges) => remapComposerInlineMentionReplacement(ranges, 7, 15, 0)));
  await act(async () => { view.send().click(); await Promise.all(view.actions); });
  expect(view.api.send).toHaveBeenCalledExactlyOnceWith(session.id, expect.objectContaining({
    text: "@Export", mentions: [sameName.mentions[0]], inlineMentionRanges: [{ mentionId: "a", from: 0, to: 7 }]
  }), { expectedGeneration: session.generation });
});

async function mount(initialDraft = draft, catalog: Partial<Pick<Parameters<typeof Composer>[0], "workspace" | "resources" | "artifacts">> = {}) {
  const api = { state: { connectionState: "connected", snapshot: emptySnapshot(), preferences: DEFAULT_UI_PREFERENCES },
    readDraft: vi.fn(async () => initialDraft), readDraftSnapshot: vi.fn(async () => ({ revision: 1, draft: initialDraft })), saveDraft: vi.fn(async () => undefined), send: vi.fn(async () => undefined),
    getVoiceInputCapabilities: vi.fn(async () => ({})), listWorkspaceFiles: vi.fn(async () => ({ paths: ["indexed.ts"], truncated: false, revision: "1" }))
  } as unknown as AppController;
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host); roots.push(root);
  const actions: Promise<unknown>[] = [];
  const render = async (mention?: { supported: boolean; options: string[] }) => {
    const backend: BackendView = { id: session.backendId, name: "Backend one", version: "1", health: "healthy", authenticationState: "notRequired", capabilities: new Map([
      ["input.text", { name: "input.text", supported: true, options: [] }],
      ...(mention === undefined ? [] : [["input.mention", { name: "input.mention", ...mention }] as const])
    ]) };
    await act(async () => root.render(<Composer controller={api} session={session} backend={backend}
      autoFocus={false} queue={[]} extraDirectories={[]} resources={[]} commands={[]} messageHistory={[]} {...catalog}
      t={(key) => key} runAction={(_key, action) => { actions.push(action().catch(() => undefined)); }} onLocalSend={() => undefined} />));
  };
  await render();
  return { api, host, render, actions, send: () => host.querySelector<HTMLButtonElement>(".send-button")!,
    text: () => host.querySelector<HTMLTextAreaElement>("textarea")!.value };
}

function resourceCatalog(mention: ComposerTokenMentionDraft): readonly SessionResourceView[] {
  return mention.kind !== "resource" ? [] : [{
    sessionId: session.id,
    id: mention.reference,
    name: mention.label,
    kind: "skill",
    discoveredRevision: mention.discoveredRevision,
    resourceVersion: mention.resourceVersion,
    runtimeGeneration: mention.runtimeGeneration
  }];
}
