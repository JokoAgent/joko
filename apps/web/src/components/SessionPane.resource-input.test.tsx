// @vitest-environment jsdom
import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import { GetSnapshotResponseSchema, ListRuntimeCommandsResponseSchema, ListSessionResourcesResponseSchema, OperationState, ResourceKind, RuntimeCommandInputMode, RuntimeCommandSource, SnapshotSchema, SubmitOperationResponseSchema, type SubmitOperationRequest } from "@joko/contracts";
import type { JSONContent } from "@tiptap/core";
import { act, forwardRef, useImperativeHandle, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { composerDocumentPlainText, plainTextToComposerDocument } from "../composer-quote-document.js";
import { remapComposerInlineMentionReplacement } from "../composer-mention-ranges.js";
import type { ComposerInlineMentionRange } from "../model.js";
import { replaceComposerDocumentTextRange } from "./composer-inline-mention.js";
import { createOrchestratorGateway } from "../gateway.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { GAMEPAD_SKILL_EVENT } from "../gamepad-client.js";
import { emptySnapshot, type BackendView, type ComposerDraft, type SessionView } from "../model.js";
import { SessionPane } from "./SessionPane.js";

vi.mock("./Timeline.js", () => ({ Timeline: () => null }));
const editorState = vi.hoisted(() => ({ caret: 0 }));
vi.mock("./composer-inline-mention.js", async importOriginal => ({
  ...await importOriginal<typeof import("./composer-inline-mention.js")>(),
  composerCaretTextOffset: () => editorState.caret,
  setComposerCaretTextOffset: () => true
}));
vi.mock("./ComposerRichTextEditor.js", () => ({ ComposerRichTextEditor: forwardRef(function MockEditor(props: {
  document: JSONContent;
  onDocumentChange: (document: JSONContent, composing: boolean, map: (ranges: readonly ComposerInlineMentionRange[]) => readonly ComposerInlineMentionRange[]) => void;
}, ref) {
  const input = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus(), routeReferenceDrop: () => false }));
  return <textarea ref={input} aria-label="Draft" className="composer-rich-editor__content" value={composerDocumentPlainText(props.document)} onInput={event => {
    const before = composerDocumentPlainText(props.document); const after = event.currentTarget.value;
    let from = 0; while (from < Math.min(before.length, after.length) && before[from] === after[from]) from++;
    let suffix = 0; while (suffix < Math.min(before.length, after.length) - from && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
    const to = before.length - suffix; const replacement = after.slice(from, after.length - suffix);
    props.onDocumentChange(replaceComposerDocumentTextRange(props.document, from, to, replacement) ?? plainTextToComposerDocument(after), false,
      ranges => remapComposerInlineMentionReplacement(ranges, from, to, replacement.length));
  }} />;
}) }));
const roots: Root[] = [];
const disconnects: (() => void)[] = [];
beforeEach(() => { editorState.caret = 0; vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("requestAnimationFrame", () => 0); });
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); for (const disconnect of disconnects.splice(0)) disconnect(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("SessionPane loaded Skill input composition", () => {
  it("selects the loaded Skill from the actual mention catalog and sends its exact draft through the generated Gateway", async () => {
    const view = await mount();
    await selectSkill(view);
    expect(view.text()).toBe("@Release");
    expect(view.api.send).not.toHaveBeenCalled();
    await act(async () => { view.send().click(); await Promise.all(view.actions); });
    expect(view.api.send).toHaveBeenCalledExactlyOnceWith("task", expect.objectContaining({
      mentions: [expect.objectContaining({ kind: "resource", reference: "skill-opaque", discoveredRevision: "sha256:approved", resourceVersion: "7", runtimeGeneration: 1 })],
      inlineMentionRanges: [expect.objectContaining({ from: 0, to: 8 })]
    }), { expectedGeneration: 1n });
    expect(view.submissions).toHaveLength(1);
    expect(view.submissions[0]).toMatchObject({ mutation: { payload: { case: "sendInput", value: { sessionId: "task", input: { mentionRanges: [{ start: 0, end: 8, mentionIndex: 0 }], parts: [expect.anything(), { content: { case: "resourceMention", value: { resourceId: "skill-opaque", displayText: "Release", discoveredRevision: "sha256:approved", resourceVersion: 7n, runtimeGeneration: 1n } } }] } } } } });
    expect(view.text()).toBe("");
    expect(view.host.textContent).not.toContain("SKILL.md");
  });

  it("restores the complete selected Skill draft when capability is withdrawn during durable clearing without resending", async () => {
    const view = await mount(); await selectSkill(view);
    let finishClear!: () => void;
    view.api.saveDraft.mockImplementationOnce((_sessionId: string, _draft: ComposerDraft) => new Promise<void>(resolve => { finishClear = resolve; }));
    await act(async () => view.send().click());
    expect(view.text()).toBe("");
    await view.render(session(1n), backend(false));
    await act(async () => { finishClear(); await Promise.all(view.actions); });
    expect(view.api.send).not.toHaveBeenCalled(); expect(view.submissions).toHaveLength(0);
    expect(view.text()).toBe("@Release"); expect(view.send().disabled).toBe(true);
    expect(view.api.saveDraft).toHaveBeenLastCalledWith("task", expect.objectContaining({ mentions: [expect.objectContaining({ reference: "skill-opaque", discoveredRevision: "sha256:approved", resourceVersion: "7", runtimeGeneration: 1 })], inlineMentionRanges: [expect.objectContaining({ from: 0, to: 8 })] }));
    await view.render(session(1n), backend(true));
    await vi.waitFor(() => expect(view.send().disabled).toBe(false));
    expect(view.api.send).not.toHaveBeenCalled(); expect(view.submissions).toHaveLength(0);
  });

  it("retires a pending catalog when the task generation changes and ignores its late Skill before selecting the current catalog", async () => {
    const view = await mount(true);
    await vi.waitFor(() => expect(view.catalogRequests).toHaveLength(1));
    await view.render(session(2n), backend(true));
    await vi.waitFor(() => expect(view.catalogRequests).toHaveLength(2));
    expect(view.catalogRequests[0]?.signal?.aborted).toBe(true);
    await act(async () => view.catalogRequests[0]?.finish(1n));
    await openMention(view);
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
    await act(async () => view.catalogRequests[1]?.finish(2n));
    const choice = await vi.waitFor(() => required([...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent?.includes("Release"))));
    await act(async () => choice.click());
    await act(async () => { view.send().click(); await Promise.all(view.actions); });
    expect(view.submissions).toHaveLength(1);
    expect(view.submissions[0]).toMatchObject({ mutation: { payload: { case: "sendInput", value: { input: { parts: [expect.anything(), { content: { case: "resourceMention", value: { runtimeGeneration: 2n, resourceId: "skill-opaque" } } }] } } } } });
    expect(view.api.send).toHaveBeenCalledWith("task", expect.objectContaining({ mentions: [expect.objectContaining({ runtimeGeneration: 2 })] }), { expectedGeneration: 2n });
  });
});

describe("SessionPane Skill command input", () => {
  it("inserts a bound Resource-mode Skill through the existing task input entry after fresh identity validation without autosending", async () => {
    const view = await mount(false, { commands: "resource" });
    await vi.waitFor(() => expect(view.api.listCommands).toHaveBeenCalled());
    const input = required(view.host.querySelector<HTMLElement>("[data-gamepad-skill]"));
    await act(async () => input.dispatchEvent(new CustomEvent(GAMEPAD_SKILL_EVENT, {
      detail: { kind: "skill", serverId: "node", resourceId: "skill-opaque", name: "Release" }
    })));
    await vi.waitFor(() => expect(view.text()).toBe("/Release"));
    expect(view.api.listSessionResources).toHaveBeenCalledTimes(2);
    expect(view.api.saveDraftIfRevision).toHaveBeenCalledTimes(1);
    expect(view.stored()).toMatchObject({ mentions: [expect.objectContaining({ kind: "resource", token: "/Release", reference: "skill-opaque", discoveredRevision: "sha256:approved", resourceVersion: "7", runtimeGeneration: 1 })], inlineMentionRanges: [{ mentionId: expect.any(String), from: 0, to: 8 }] });
    expect(view.api.send).not.toHaveBeenCalled();
    await act(async () => { view.send().click(); await Promise.all(view.actions); });
    expect(view.submissions[0]).toMatchObject({ mutation: { payload: { case: "sendInput", value: { input: { mentionRanges: [{ start: 0, end: 8, mentionIndex: 0 }], parts: [expect.anything(), { content: { case: "resourceMention", value: { displayText: "/Release", resourceId: "skill-opaque", discoveredRevision: "sha256:approved", resourceVersion: 7n, runtimeGeneration: 1n } } }] } } } } });
  });

  it("freshly selects a Skill slash occurrence, keeps args and other identities, and explicitly sends through the generated Gateway", async () => {
    const initial: ComposerDraft = { text: "/dep keep @Release", deliveryMode: "prompt", attachments: [],
      mentions: [{ id: "earlier", kind: "resource", reference: "skill-opaque", label: "Release", token: "@Release", discoveredRevision: "sha256:approved", resourceVersion: "7", runtimeGeneration: 1 }],
      inlineMentionRanges: [{ mentionId: "earlier", from: 10, to: 18 }] };
    const view = await mount(false, { initial, commands: "resource" });
    await selectCommand(view);
    await vi.waitFor(() => expect(view.text()).toBe("/Release keep @Release"));
    expect(view.api.listSessionResources).toHaveBeenCalledTimes(2);
    expect(view.api.saveDraftIfRevision).toHaveBeenCalledTimes(1);
    expect(view.api.send).not.toHaveBeenCalled();
    expect(view.stored().mentions).toEqual([initial.mentions[0], expect.objectContaining({ kind: "resource", token: "/Release", label: "/Release", reference: "skill-opaque", discoveredRevision: "sha256:approved", resourceVersion: "7", runtimeGeneration: 1 })]);
    await edit(view, "/Release keep-edited @Release", 20);
    await act(async () => { view.send().click(); await Promise.all(view.actions); });
    expect(view.submissions).toHaveLength(1);
    expect(view.submissions[0]).toMatchObject({ mutation: { payload: { case: "sendInput", value: { input: {
      parts: [{ content: { case: "text", value: "/Release keep-edited @Release" } },
        { content: { case: "resourceMention", value: { displayText: "Release", resourceId: "skill-opaque", resourceVersion: 7n } } },
        { content: { case: "resourceMention", value: { displayText: "/Release", resourceId: "skill-opaque", discoveredRevision: "sha256:approved", resourceVersion: 7n, runtimeGeneration: 1n } } }],
      mentionRanges: [{ start: 0, end: 8, mentionIndex: 1 }, { start: 21, end: 29, mentionIndex: 0 }]
    } } } } });
  });

  it("keeps Skill source commands in TEXT mode as raw native slash input despite their Resource usage association", async () => {
    const view = await mount(false, { initial: { text: "/skill:Rel args", deliveryMode: "prompt", attachments: [], mentions: [] }, commands: "text" });
    await selectCommand(view);
    expect(view.text()).toBe("/skill:Release args");
    expect(view.api.saveDraftIfRevision).not.toHaveBeenCalled();
    expect(view.api.listSessionResources).toHaveBeenCalledTimes(1);
    await act(async () => { view.send().click(); await Promise.all(view.actions); });
    expect(view.submissions[0]).toMatchObject({ mutation: { payload: { case: "sendInput", value: { input: { parts: [{ content: { case: "text", value: "/skill:Release args" } }], mentionRanges: [] } } } } });
  });

  it("rejects a missing fresh Skill and allows an explicit retry without changing the args or sending", async () => {
    const view = await mount(false, { initial: { text: "/dep args", deliveryMode: "prompt", attachments: [], mentions: [] }, commands: "resource", missingSelection: true });
    await selectCommand(view);
    await vi.waitFor(() => expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("composer.inputUnavailable"));
    expect(view.text()).toBe("/dep args"); expect(view.api.saveDraftIfRevision).not.toHaveBeenCalled();
    await selectCommand(view);
    await vi.waitFor(() => expect(view.text()).toBe("/Release args"));
    expect(view.api.send).not.toHaveBeenCalled();
  });

  it.each(["same-text edit", "capability", "generation"] as const)("retires a late Skill selection after %s changes without adopting into the current draft", async drift => {
    const view = await mount(false, { initial: { text: "/dep args", deliveryMode: "prompt", attachments: [], mentions: [] }, commands: "resource", deferSelection: true });
    await selectCommand(view);
    await vi.waitFor(() => expect(view.catalogRequests).toHaveLength(1));
    if (drift === "same-text edit") { await edit(view, "/dep changed", 1); await edit(view, "/dep args", 1); }
    else if (drift === "capability") await view.render(session(1n), backend(false));
    else await view.render(session(2n), backend(true));
    await act(async () => { view.catalogRequests[0]!.finish(1n); await Promise.resolve(); });
    expect(view.api.saveDraftIfRevision).not.toHaveBeenCalled(); expect(view.api.send).not.toHaveBeenCalled();
    expect(view.text()).toBe("/dep args");
  });
});

async function mount(deferCatalog = false, options: { initial?: ComposerDraft; commands?: "resource" | "text"; deferSelection?: boolean; missingSelection?: boolean } = {}) {
  const submissions: SubmitOperationRequest[] = [];
  const catalogRequests: { signal?: AbortSignal; finish: (generation: bigint) => void }[] = [];
  let currentSession = session(1n);
  let catalogReads = 0;
  const transport = { unary: vi.fn(async (method: any, signal: AbortSignal | undefined, _timeout: unknown, _headers: unknown, input: any) => {
    let message: unknown;
    if (method.localName === "getSnapshot") message = create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } }) });
    else if (method.localName === "listSessionResources") {
      catalogReads++;
      const generation = deferCatalog || options.deferSelection && catalogReads === 2 ? await new Promise<bigint>(resolve => catalogRequests.push({ signal, finish: resolve })) : currentSession.generation;
      message = create(ListSessionResourcesResponseSchema, { resources: options.missingSelection && catalogReads === 2 ? [] : [{ sessionId: input.sessionId, resourceId: "skill-opaque", name: "Release", kind: ResourceKind.SKILL, discoveredRevision: "sha256:approved", resourceVersion: 7n, runtimeGeneration: generation }] });
    } else if (method.localName === "listRuntimeCommands") {
      message = create(ListRuntimeCommandsResponseSchema, { commands: options.commands ? [{ sessionId: input.sessionId, commandId: "command-opaque", name: options.commands === "text" ? "skill:Release" : "Release", description: "Release changes", source: RuntimeCommandSource.SKILL, loaded: true, resourceId: "skill-opaque", inputMode: options.commands === "text" ? RuntimeCommandInputMode.TEXT : RuntimeCommandInputMode.RESOURCE_MENTION }] : [] });
    } else if (method.localName === "submitOperation") { submissions.push(input as SubmitOperationRequest); message = create(SubmitOperationResponseSchema, { operation: { operationId: input.operationId, connectionId: input.connectionId, state: OperationState.SUCCEEDED } }); }
    else throw new Error("Optional service is unavailable in this UI fixture");
    return { stream: false, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
  }), stream: vi.fn(async (method: any) => ({ stream: true, service: method.parent, method, header: new Headers(), trailer: new Headers(), message: idleStream() })) } as unknown as Transport;
  const gateway = createOrchestratorGateway({ id: "connection", deviceId: "device", serverId: "node", name: "Node", origin: "https://node.invalid" }, "fixture-key", {}, () => transport);
  disconnects.push(() => gateway.disconnect()); await gateway.connect();
  let storedDraft: ComposerDraft = options.initial ?? { text: "", mentions: [], inlineMentionRanges: [], attachments: [], deliveryMode: "prompt" };
  let draftRevision = 1;
  const api = {
    state: { ready: true, activeProfile: { id: "connection", deviceId: "device", serverId: "node", name: "Node", origin: "https://node.invalid" }, connectionState: "connected", connectionGeneration: 1, snapshot: emptySnapshot(), route: { kind: "session", sessionId: "task" }, preferences: DEFAULT_UI_PREFERENCES, effectiveLocale: "en", systemLocale: "en" },
    listSessionResources: vi.fn((...args: Parameters<AppController["listSessionResources"]>) => gateway.listSessionResources(...args)),
    listCommands: vi.fn((...args: Parameters<AppController["listCommands"]>) => gateway.listCommands(...args)),
    readDraft: vi.fn(async () => storedDraft), readDraftSnapshot: vi.fn(async () => ({ revision: draftRevision, draft: storedDraft })), saveDraft: vi.fn(async (_sessionId: string, draft: ComposerDraft) => { storedDraft = draft; draftRevision++; }),
    saveDraftIfRevision: vi.fn(async (_sessionId: string, draft: ComposerDraft, expected: number) => { if (expected !== draftRevision) return undefined; storedDraft = draft; return ++draftRevision; }),
    send: vi.fn((...args: Parameters<AppController["send"]>) => gateway.send(...args)), getVoiceInputCapabilities: vi.fn(async () => ({})), getObjective: vi.fn(async () => undefined), watchObjective: vi.fn(() => idleStream()),
    getPortableReplacementCleanup: vi.fn(async () => undefined), listPartners: vi.fn(async () => ({ partners: [], directory: { revision: 1n, activeCount: 0, archivedCount: 0, errorCount: 0, updatedAt: 0, templates: [], avatarPresets: [] } }))
  };
  const controller = api as unknown as AppController;
  const host = document.body.appendChild(document.createElement("div")); const root = createRoot(host); roots.push(root);
  const actions: Promise<unknown>[] = [];
  const render = async (nextSession = currentSession, nextBackend = backend(true)) => {
    currentSession = nextSession; api.state.snapshot = { ...emptySnapshot(), sessions: [nextSession], backends: [nextBackend] };
    await act(async () => root.render(<SessionPane controller={controller} session={nextSession} backend={nextBackend} models={[]} timeline={[]} timelineHasEarlier={false} timelineHistoryLoading={false} onLoadEarlierTimeline={async () => undefined} extensionWidgets={[]} extensionStatuses={[]} queue={[]} extraDirectories={[]} resources={[]} commandRefreshSignal={[]} remainingInteractions={0} navigationOpen inspectorOpen t={key => key} runAction={(_key, action) => { actions.push(action().catch(() => undefined)); }} onOpenNavigation={() => undefined} onOpenInspector={() => undefined} onRename={() => undefined} onArchive={() => undefined} onDelete={() => undefined} />));
  };
  await render();
  return { api, host, render, actions, submissions, catalogRequests, stored: () => storedDraft, send: () => required(host.querySelector<HTMLButtonElement>(".send-button")), text: () => required(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Draft"]')).value };
}

function session(generation: bigint): SessionView { return { id: "task", backendId: "runtime", targetId: "target", name: "Task", state: "idle", generation, pinned: false, archived: false, fastMode: false, permissionMode: "ask", planMode: false, updatedAt: 1 }; }
// Public contract data is the UI input; actual capability advertising is proven by the Adapter owner.
function backend(resources: boolean): BackendView { return { id: "runtime", name: "Runtime", version: "1", instanceGeneration: 1, health: "healthy", authenticationState: "notRequired", capabilities: new Map([ ["input.text", { name: "input.text", supported: true, options: [] }], ["runtime.commands", { name: "runtime.commands", supported: true, options: [] }], ["runtime.resources", { name: "runtime.resources", supported: true, options: ["skill"] }], ["input.mention", { name: "input.mention", supported: true, options: resources ? ["workspace_file", "resource"] : ["workspace_file"] }] ]) }; }
async function selectCommand(view: Awaited<ReturnType<typeof mount>>): Promise<void> { const editor = required(view.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Draft"]')); editorState.caret = 1; await act(async () => { editor.focus(); document.dispatchEvent(new Event("selectionchange")); }); const choice = await vi.waitFor(() => required([...view.host.querySelectorAll<HTMLButtonElement>('[data-composer-typed-command-palette] [role="option"]')].find(item => item.textContent?.includes("Release")))); await act(async () => choice.click()); }
async function edit(view: Awaited<ReturnType<typeof mount>>, value: string, caret: number): Promise<void> { const editor = required(view.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Draft"]')); await act(async () => { editor.focus(); editorState.caret = caret; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, value); editor.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText" })); }); }
async function openMention(view: Awaited<ReturnType<typeof mount>>): Promise<void> { await act(async () => required(view.host.querySelector<HTMLButtonElement>('button[aria-label="common.add"]')).click()); const action = required([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent?.includes("composer.mention"))); await act(async () => action.click()); }
async function selectSkill(view: Awaited<ReturnType<typeof mount>>): Promise<void> { await openMention(view); const choice = await vi.waitFor(() => required([...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent?.includes("Release")))); await act(async () => choice.click()); }
function required<T>(value: T | null | undefined): T { if (value === null || value === undefined) throw new Error("Required mounted element is absent"); return value; }
async function* idleStream(): AsyncIterable<never> { await new Promise<never>(() => undefined); }
