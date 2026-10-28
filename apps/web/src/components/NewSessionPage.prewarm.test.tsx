// @vitest-environment jsdom
import type { JSONContent } from "@tiptap/core";
import { act, forwardRef, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { plainTextToComposerDocument } from "../composer-quote-document.js";
import { emptySnapshot, type AppSnapshot, type ComposerInlineMentionRange, type NewSessionDraft, type NewSessionLocalDraft } from "../model.js";
import type { DelayedNewSessionDraft } from "../new-session-flow.js";
import { NewSessionPage } from "./NewSessionPage.js";

let editor: { onDocumentChange(document: JSONContent, composing: boolean, map: (ranges: readonly ComposerInlineMentionRange[]) => readonly ComposerInlineMentionRange[]): void };
vi.mock("./ComposerRichTextEditor.js", () => ({ ComposerRichTextEditor: forwardRef(function Editor(props: typeof editor, ref) {
  editor = props; useImperativeHandle(ref, () => ({ focus: vi.fn(), focusFromBlankSurface: vi.fn(), insertRouteReference: vi.fn(),
    routeReferenceDrop: vi.fn(), insertText: vi.fn(), editPastedText: vi.fn() })); return <div />;
}) }));
vi.mock("./HomeUsageDashboard.js", () => ({ HomeUsageDashboard: () => null }));
vi.mock("./ModelPicker.js", () => ({ ModelPicker: () => null }));
const roots: Root[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.replaceChildren(); localStorage.clear(); vi.unstubAllGlobals(); });

it("prepares on real input, discards a cleared draft, and sends by adopting the next exact task", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("requestAnimationFrame", () => 0);
  const snapshot: AppSnapshot = { ...emptySnapshot(), generation: 1n, backends: [{ id: "native", name: "Native", version: "1", health: "healthy", instanceGeneration: 1,
    capabilities: new Map([...["input.text", "model.switch", "session.prewarm"].map(name => [name, { name, supported: true, options: [] as string[] }] as const),
      ["permission.modes", { name: "permission.modes", supported: true, options: ["ask"] }]]) }],
    targets: [{ id: "project", revision: 2n, backendId: "native", name: "Project", workspaceId: "workspace", workspaceName: "Project", trusted: true, pinned: false, archived: false }],
    workspaces: [{ id: "workspace", targetId: "project", name: "Project", kind: "userProject", serverPath: "D:/project", trusted: true, dirty: false, entries: [] }],
    models: [{ backendId: "native", providerId: "account", providerName: "Account", modelId: "model", name: "Model", available: true,
      supportsImages: false, supportsFast: false, efforts: [], inputModalities: ["text"], outputModalities: ["text"], contextWindow: 1000, maximumOutputTokens: 100,
      inputCostMicrosPerMillion: 0, outputCostMicrosPerMillion: 0, currencyCode: "USD" }] };
  let saved: NewSessionLocalDraft | undefined;
  let creations = 0;
  const create = vi.fn(async (_draft: NewSessionDraft) => ({ sessionId: `prepared-${++creations}`, generation: 1n }));
  const discard = vi.fn(async (_sessionId: string, _draftId: string, _operationId: string) => undefined);
  const api = { state: { activeProfile: { id: "connection", serverId: "node", deviceId: "device", origin: "https://node.example" }, snapshot,
    connectionGeneration: 1, navigationRevision: 1, connectionState: "connected", route: { kind: "newSession" }, preferences: { locale: "en", newSessionWorktreeEnabled: false } },
    readNewSessionDraft: vi.fn(async () => undefined), saveNewSessionDraft: vi.fn(async (draft: NewSessionLocalDraft) => { saved = draft; }),
    prepareTargetWorkspace: vi.fn(async () => undefined), probeTargetWorktree: vi.fn(async () => ({ targetId: "project", eligibility: "notGitRepository", canRefreshRemote: false })),
    refreshProviderModels: vi.fn(async () => undefined), listTargetWorktreeSources: vi.fn(async () => []),
    createSession: create, readSessionPreparation: vi.fn(async () => ({ state: "pending" as const })),
    prewarmSession: vi.fn(async () => undefined), discardProvisionalSession: discard };
  const controller = api as unknown as AppController, submit = vi.fn(async (_draft: DelayedNewSessionDraft) => undefined);
  const container = document.body.appendChild(document.createElement("div")), root = createRoot(container); roots.push(root);
  await act(async () => root.render(<NewSessionPage controller={controller} snapshot={snapshot} initialTargetId="project" navigationOpen t={key => key}
    onOpenNavigation={() => undefined} onClose={() => undefined} onSubmit={submit} />));
  await vi.waitFor(() => expect(saved).toBeDefined()); expect(create).not.toHaveBeenCalled();
  await act(async () => editor.onDocumentChange(plainTextToComposerDocument("Unsent first draft"), false, ranges => ranges));
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(saved?.preparation?.sessionId).toBe("prepared-1"));
  expect(create.mock.calls[0]![0]).not.toHaveProperty("text");
  const originalDraft = saved!.preparation!;
  await act(async () => editor.onDocumentChange(plainTextToComposerDocument(""), false, ranges => ranges));
  await vi.waitFor(() => expect(discard).toHaveBeenCalledWith("prepared-1", originalDraft.draftId, expect.any(String)), { timeout: 2500 });
  await act(async () => editor.onDocumentChange(plainTextToComposerDocument("Keep this exact first input"), false, ranges => ranges));
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(saved?.preparation?.sessionId).toBe("prepared-2"));
  await act(async () => container.querySelector<HTMLButtonElement>("button.send-button")!.click());
  await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0]![0]).toMatchObject({ reuseProvisionalSessionId: "prepared-2", provisionalDraftId: saved!.preparation!.draftId });
  expect(create).toHaveBeenCalledTimes(2);
});
