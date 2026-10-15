// @vitest-environment jsdom
import type { JSONContent } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { BackendHealth, CapabilitySupport, ModelInputModality, ModelOutputModality, SessionState, SnapshotSchema } from "@joko/contracts";
import type { AppController } from "../controller.js";
import { mapSnapshot, type OrchestratorGateway } from "../gateway.js";
import { DEFAULT_UI_PREFERENCES, type LocalState } from "../local-state.js";
import { emptySnapshot, type ComposerDraft } from "../model.js";
import { composerDocumentPlainText, plainTextToComposerDocument } from "../composer-quote-document.js";
import { createTaskSharingController } from "../task-sharing-controller.js";
import { guestBackend, taskSourceKey, type TaskSource } from "../task-sharing.js";
import { SessionPane } from "./SessionPane.js";

vi.mock("./ComposerRichTextEditor.js", () => ({ ComposerRichTextEditor: ({ document, editable, disabled, onDocumentChange }: {
  document: JSONContent; editable: boolean; disabled: boolean; onDocumentChange(document: JSONContent, composing: boolean): void;
}) => <textarea aria-label="Draft" readOnly={!editable || disabled} value={composerDocumentPlainText(document)} onChange={event => onDocumentChange(plainTextToComposerDocument(event.target.value), false)} /> }));
let root: Root | undefined;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("requestAnimationFrame", () => 0); });
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); vi.unstubAllGlobals(); });
const source: Extract<TaskSource, { kind: "joined" }> = { kind: "joined", homeProfileId: "home", homeServerId: "home-server", homeOrigin: "https://home.example",
  joinId: "joined", remoteServerId: "host", shareId: "share", memberId: "member", sessionId: "task", generation: 1n, memberGeneration: 2n };
describe("shared task formal Composer composition", () => {
  it("accepts an explicit keyless-provider task without querying the Home Partner catalog", async () => {
    const snapshot = mapSnapshot(create(SnapshotSchema, { generation: 1n, sessions: [{ sessionId: "task", targetId: "target", backendId: "backend", state: SessionState.IDLE,
      nativeBinding: { runtimeGeneration: 1n }, model: { model: { providerId: "local-keyless", modelId: "model" } }, location: { kind: { case: "serviceNode", value: {} } } }],
      backends: [{ backendId: "backend", health: BackendHealth.HEALTHY, capabilities: { capabilities: [{ name: "input.text", support: CapabilitySupport.SUPPORTED }] } }],
      models: [{ backendId: "backend", key: { providerId: "local-keyless", modelId: "model" }, available: true, inputModalities: [ModelInputModality.TEXT], outputModalities: [ModelOutputModality.TEXT] }] }));
    const session = snapshot.sessions[0]!, backend = guestBackend(snapshot.backends[0]!);
    const home = { state: { ready: true, connectionState: "connected", activeProfile: { id: "home", serverId: "home-server", origin: "https://home.example" },
      snapshot: emptySnapshot(), preferences: DEFAULT_UI_PREFERENCES }, send: vi.fn(), listPartners: vi.fn(), getVoiceInputCapabilities: vi.fn().mockResolvedValue({}) } as unknown as AppController;
    let draft: ComposerDraft | undefined;
    const local = { readDraftSnapshot: vi.fn<LocalState["readDraftSnapshot"]>(async () => ({ revision: 1, draft })),
      saveDraft: vi.fn<LocalState["saveDraft"]>(async (_server, _profile, _session, value) => { draft = value; }) } as unknown as LocalState;
    const gateway = { send: vi.fn().mockResolvedValue(undefined), getArtifactUrl: vi.fn() } as unknown as OrchestratorGateway;
    let memberId = "member";
    const controller = createTaskSharingController({ home: () => home, gateway, source, snapshot: () => snapshot,
      access: () => ({ role: "guest", memberId, editableQueueItemIds: new Set() }), current: () => true, local });
    const host = document.body.appendChild(document.createElement("div")); root = createRoot(host); const actions: Promise<unknown>[] = [];
    const render = async (app = controller): Promise<void> => { await act(async () => root!.render(<SessionPane controller={app} session={session} backend={backend} models={snapshot.models}
      timeline={[]} timelineHasEarlier={false} timelineHistoryLoading={false} onLoadEarlierTimeline={async () => undefined}
      extensionWidgets={[]} extensionStatuses={[]} queue={[]} extraDirectories={[]} resources={[]} commandRefreshSignal={[]}
      remainingInteractions={0} navigationOpen={false} inspectorOpen={false} inspectorAvailable={false} composerAutoFocus={false}
      t={key => key} runAction={(_key, work) => { actions.push(work()); }} onOpenNavigation={() => undefined} onOpenInspector={() => undefined}
      onRename={() => undefined} onArchive={() => undefined} onDelete={() => undefined} />)); };
    await render(); expect(host.querySelector(".portable-cleanup-notice")).toBeNull(); expect(host.querySelector(".objective-indicator")).toBeNull();
    expect(local.readDraftSnapshot).toHaveBeenCalledExactlyOnceWith("host", `shared:${taskSourceKey(source)}`, "task");
    const editor = host.querySelector<HTMLTextAreaElement>("textarea")!; expect(editor.readOnly).toBe(false);
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "Guest input"); editor.dispatchEvent(new Event("input", { bubbles: true })); });
    const send = host.querySelector<HTMLButtonElement>(".composer__send .send-button")!;
    expect(send.disabled).toBe(false); expect(host.querySelector(".composer__source-notice")).toBeNull();
    await act(async () => { send.click(); await Promise.all(actions); });
    expect(gateway.send).toHaveBeenCalledExactlyOnceWith("task", expect.objectContaining({ text: "Guest input" }), { expectedGeneration: 1n });
    expect(local.saveDraft).toHaveBeenLastCalledWith("host", `shared:${taskSourceKey(source)}`, "task", expect.objectContaining({ text: "" }));
    expect(home.send).not.toHaveBeenCalled(); expect(home.listPartners).not.toHaveBeenCalled();
    memberId = "foreign";
    await render(); expect(host.querySelector<HTMLButtonElement>(".composer__send .send-button")?.disabled).toBe(true);
    expect(home.listPartners).not.toHaveBeenCalled();
  });
});
