// @vitest-environment jsdom
import type { JSONContent } from "@tiptap/core";
import { act, forwardRef, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { plainTextToComposerDocument } from "../composer-quote-document.js";
import { emptySnapshot, type AppSnapshot, type ComposerInlineMentionRange, type ConnectionProfile, type ModelView,
  type NewSessionLocalDraft, type NewSessionModelRequest, type ProviderRuntimeView } from "../model.js";
import { NewSessionPage } from "./NewSessionPage.js";

let editor: { onDocumentChange(document: JSONContent, composing: boolean,
  mapper: (ranges: readonly ComposerInlineMentionRange[]) => readonly ComposerInlineMentionRange[]): void };
vi.mock("./ComposerRichTextEditor.js", () => ({ ComposerRichTextEditor: forwardRef(function Editor(props: typeof editor, ref) {
  editor = props;
  useImperativeHandle(ref, () => ({ focus: vi.fn(), focusFromBlankSurface: vi.fn(), insertRouteReference: vi.fn(),
    routeReferenceDrop: vi.fn(), insertText: vi.fn(), editPastedText: vi.fn() }));
  return <div />;
}) }));
vi.mock("./HomeUsageDashboard.js", () => ({ HomeUsageDashboard: () => null }));
vi.mock("./ModelPicker.js", () => ({ ModelPicker: ({ value }: { value?: { backendId: string; providerId: string; modelId: string } }) =>
  <output data-testid="model">{value ? JSON.stringify(value) : "default"}</output> }));
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined;
  document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("applies an exact one-time Provider intent after draft hydration and keeps unsaved input and attachments on a later intent", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  const profile: ConnectionProfile = { id: "connection", serverId: "node", deviceId: "device", origin: "http://127.0.0.1", name: "Local" };
  const model = (backendId: string): ModelView => ({ backendId, providerId: "same-provider", providerName: "Provider", modelId: "same-model", name: backendId,
    available: true, supportsImages: true, inputModalities: ["text", "image"], outputModalities: ["text"], supportsFast: false, efforts: [],
    contextWindow: 100, maximumOutputTokens: 10, inputCostMicrosPerMillion: 0, outputCostMicrosPerMillion: 0, currencyCode: "USD" });
  const runtime = (backendId: string): ProviderRuntimeView => ({ backendId, id: "same-provider", name: "Provider", kind: "subscription", compatibility: "native",
    authenticationState: "authenticated", endpoint: "", ownerManaged: true, supportsLogin: false, loginMethods: [], supportsLogout: true,
    supportsRefresh: true, credentialSurfaces: [], capabilities: new Set() });
  const snapshot: AppSnapshot = { ...emptySnapshot(), generation: 2n,
    backends: ["first", "second"].map(id => ({ id, name: id, version: "1", health: "healthy", capabilities: new Map(
      ["input.text", "model.switch"].map(name => [name, { name, supported: true, options: [] }])) })),
    providers: [runtime("first"), runtime("second")], models: [model("first"), model("second")] };
  const attachment = { id: "file", file: new File(["bytes"], "keep.txt", { type: "text/plain" }), kind: "file" as const };
  const draft: NewSessionLocalDraft = { selection: { kind: "dialogue", backendId: "first" }, nativeStart: { kind: "fresh" },
    providerId: "same-provider", modelId: "same-model", fastMode: false, permissionMode: "ask", planMode: false,
    text: "Saved text", editorDocument: plainTextToComposerDocument("Saved text"), mentions: [], inlineMentionRanges: [], attachments: [attachment] };
  const read = vi.fn(async () => draft), save = vi.fn(async (_draft: NewSessionLocalDraft) => undefined), submit = vi.fn();
  let controller = { state: { activeProfile: profile, snapshot, connectionGeneration: 4, connectionState: "connected", route: { kind: "newSession" },
    navigationRevision: 1, preferences: { locale: "en", newSessionWorktreeEnabled: false } }, readNewSessionDraft: read, saveNewSessionDraft: save,
    refreshProviderModels: vi.fn(async () => undefined), setNewSessionWorktreeEnabled: vi.fn(async () => undefined) } as unknown as AppController;
  const request = (backendId: string, requestId: string): NewSessionModelRequest => ({ backendId, requestId, profile, providerId: "same-provider",
    modelId: "same-model", connectionGeneration: 4, snapshotGeneration: "2" });
  const container = document.body.appendChild(document.createElement("div")); root = createRoot(container);
  const render = (initialModel: NewSessionModelRequest) => <NewSessionPage controller={controller} snapshot={snapshot} initialModel={initialModel}
    navigationOpen t={key => key} onOpenNavigation={() => undefined} onClose={() => undefined} onSubmit={submit} />;
  await act(async () => root!.render(render(request("second", "intent-one"))));
  await vi.waitFor(() => expect(container.querySelector("[data-testid=model]")?.textContent).toContain('"backendId":"second"'));
  await vi.waitFor(() => expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Saved text", attachments: [attachment],
    selection: { kind: "dialogue", backendId: "second" }, providerId: "same-provider", modelId: "same-model" })));
  await act(async () => editor.onDocumentChange(plainTextToComposerDocument("Unsaved current input"), false, ranges => ranges));
  await act(async () => root!.render(render(request("first", "intent-two"))));
  await vi.waitFor(() => expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Unsaved current input", attachments: [attachment],
    selection: { kind: "dialogue", backendId: "first" }, providerId: "same-provider", modelId: "same-model" })));
  expect(read).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled();
  controller = { ...controller, state: { ...controller.state, connectionGeneration: 5 } };
  await act(async () => root!.render(render(request("second", "stale-intent"))));
  expect(container.querySelector("[data-testid=model]")?.textContent).toContain('"backendId":"first"');
  expect(read).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled();
});
