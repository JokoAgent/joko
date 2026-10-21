// @vitest-environment jsdom
import { act, createElement, forwardRef, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { EventSchema, MessageRole, RuntimeCommandInputMode, RuntimeCommandSource, ResourceKind, SessionSchema, SessionState, SnapshotSchema } from "@joko/contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileComposerDraftStore } from "./composer-draft-store";
import { mobileComposerInput, plainTextMobileComposerDraft, replaceMobileComposerRange, type MobileComposerDraft } from "./mobile-composer-document";
import type { MobileComposerRichInput } from "./MobileComposerRichInput";
import type { MobileRuntimeCommandPalette } from "./MobileRuntimeCommandPalette";
import type { MobileState } from "./mobile-client";
import { mobileMessage } from "./mobile-messages";
import type { MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import type { MobileObjectiveApi } from "./mobile-objective";
import type { MobileCollaborationApi } from "./mobile-collaboration";
import { PermissionMode } from "@joko/contracts";
import type { MobileObjectiveSheetProps } from "./MobileObjectiveSheet";
import type { MobileTaskHeader } from "./MobileTaskHeader";
import type { MobileContextSheet } from "./MobileContextSheet";

let input: ComponentProps<typeof MobileComposerRichInput>;
let palette: ComponentProps<typeof MobileRuntimeCommandPalette>;
let header: ComponentProps<typeof MobileTaskHeader>;
let contextSheet: ComponentProps<typeof MobileContextSheet>;
let objectiveSheet: MobileObjectiveSheetProps;
let activeObjectiveApi: MobileObjectiveApi | undefined;
let activeCollaborationApi: MobileCollaborationApi | undefined;
let taskRole: "ordinary" | "lead" | "worker" = "ordinary";
let root: Root;
let host: HTMLDivElement;
let TaskScreen: typeof import("./App").TaskScreen;
const identity = { profileId: "profile", sessionId: "session" };
const values = new Map<string, string>();
const drafts = new MobileComposerDraftStore({
  getItem: async (key) => values.get(key) ?? null,
  setItem: async (key, value) => { values.set(key, value); },
  removeItem: async (key) => { values.delete(key); }
});
const runtime = { authorityKey: "authority", surfaceOwnerKey: "runtime-owner", sessionId: "session", backendId: "backend", targetId: "target", runtimeGeneration: "7", resourceMentions: true };
const command = { commandId: "skill-analysis", name: "analysis", description: "Analyze", source: RuntimeCommandSource.SKILL,
  resourceId: "opaque-skill", inputMode: RuntimeCommandInputMode.RESOURCE_MENTION };
const catalog = { surfaceOwnerKey: runtime.surfaceOwnerKey, sessionId: "session", runtimeGeneration: "7", items: [command] };
const resource = { kind: "resource" as const, resourceId: "opaque-skill", displayText: "Native catalog display", resourceKind: ResourceKind.SKILL,
  discoveredRevision: "content-sha", resourceVersion: "11", runtimeGeneration: "7" };
let current = true;
const appControls = { ...runtime, surfaceOwnerKey: "app-owner", session: create(SessionSchema, { sessionId: "session" }),
  policy: { help: true as const, jumpSession: true as const, userShell: false, sessionReset: false, review: false }, jumpSessionIds: ["session"] };
const resolveResource = vi.fn(async () => resource);
const send = vi.fn(async () => true);
const empty = Object.freeze([]);
let activePartner: MobilePartnerDirectoryProfile | undefined;
const peer: MobilePartnerDirectoryProfile = {
  partnerId: "bea", revision: 3n, profileVersion: 1n, displayName: "Current Bea", description: "", avatar: "leaf",
  identitySource: "Help", templateId: "general", lifecycle: "active", initializationState: "ready", invitationStage: "ready",
  homeTargetId: "target", canonicalSessionId: "peer-session", usesDirectoryDefaults: true,
  capabilities: { modelChain: [{ backendId: "backend", providerId: "provider", modelId: "model", fastMode: false }], permissionMode: "ask", planMode: false },
  createdAt: 1000, updatedAt: 2000, activity: { partnerId: "bea", unreadReplyCount: 0, artifactCount: 0,
    activeDelegationCount: 0, readThroughCursor: 0n, readUpdatedAt: 0 }
};
const privateDirectory = vi.fn(async () => ({ directory: { revision: 1n, activeCount: 2, archivedCount: 0,
  errorCount: 0, updatedAt: 2000 }, partners: [activePartner!, peer] }));
const openPrivateThread = vi.fn();
const client = new Proxy({
  get state() { return renderedState; },
  taskDraftProfileId: () => renderedState.activeProfileId,
  taskAppCommandControls: () => current ? appControls : undefined,
  taskRuntimeCommandControls: () => current ? runtime : undefined,
  listTaskRuntimeCommands: vi.fn(async () => catalog),
  resolveTaskRuntimeCommandResource: resolveResource,
  taskQueueItems: () => empty, taskQueueCapabilities: () => ({}), taskInteractions: () => empty, subscribe: () => () => {},
  taskPendingImagePasteCount: () => 0, taskForeground: () => true,
  taskNativeTreeControls: () => undefined, send, taskContextControls: () => undefined,
  taskObjectiveApi: () => current ? activeObjectiveApi : undefined,
  taskCollaborationApi: () => current ? activeCollaborationApi : undefined,
  taskCatalogMentionControls: () => undefined, taskTimelineRows: () => empty,
  partnerConversationTransport: () => activePartner ? { ownerKey: "private-task", sessionId: "session" } : undefined,
  partnerDirectoryTransport: () => activePartner ? { ownerKey: "private-node", list: privateDirectory } : undefined
}, { get: (object, key) => key in object ? object[key as keyof typeof object] : () => undefined });
const session = create(SessionSchema, { sessionId: "session", backendId: "backend", targetId: "target", state: SessionState.IDLE });
const snapshot = create(SnapshotSchema, { sessions: [session] });
const state = { status: "connected", activeProfileId: "profile", selectedId: "session", owner: snapshot, detail: snapshot,
  saved: [], pending: [], older: [], live: [], busy: false, historyBusy: false, historyEnd: true, readReceipts: {} } as unknown as MobileState;
let renderedState = state;
const colors = { background: "#fff", surface: "#fff", ink: "#111", muted: "#666", border: "#ccc", accent: "#f80", negative: "#c00", brandBackground: "#ffe", dark: false };
const surface = ({ children }: { children?: ReactNode }) => createElement("div", null, children);

beforeAll(async () => {
  vi.doMock("react-native-webview", () => ({ WebView: surface }));
  vi.stubGlobal("__DEV__", false);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.doMock("react-native", () => ({
    View: surface, Text: surface, ScrollView: surface, SectionList: surface, Image: surface, ActivityIndicator: surface,
    FlatList: forwardRef(({ data, renderItem }: { data?: readonly unknown[];
      renderItem?: (value: { item: unknown; index: number }) => ReactNode }) => createElement("div", null,
      data?.map((item, index) => createElement("div", { key: index }, renderItem?.({ item, index }))))), TextInput: forwardRef(() => null),
    Modal: ({ visible, children }: { visible?: boolean; children?: ReactNode }) => visible ? createElement("div", null, children) : null,
    Pressable: ({ children, onPress, disabled, accessibilityLabel }: { children?: ReactNode | ((value: { pressed: boolean }) => ReactNode); onPress?: () => void; disabled?: boolean; accessibilityLabel?: string }) => createElement("button", { onClick: onPress, disabled, "aria-label": accessibilityLabel }, typeof children === "function" ? children({ pressed: false }) : children),
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }, Platform: { OS: "android", select: (value: Record<string, unknown>) => value.android ?? value.default },
    AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) }, BackHandler: { addEventListener: () => ({ remove() {} }) },
    Keyboard: { dismiss() {}, addListener: () => ({ remove() {} }) }, PanResponder: { create: () => ({ panHandlers: {} }) },
    AccessibilityInfo: { announceForAccessibility() {}, setAccessibilityFocus() {}, addEventListener: () => ({ remove() {} }) },
    Linking: {}, Alert: { alert() {} }, findNodeHandle: () => null, useColorScheme: () => "light", useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 })
  }));
  vi.doMock("react-native-safe-area-context", () => ({ SafeAreaProvider: surface, SafeAreaView: surface, useSafeAreaInsets: () => ({ top: 0, left: 0, bottom: 0, right: 0 }) }));
  vi.doMock("react-native-svg", () => ({ SvgXml: () => null }));
  vi.doMock("expo-status-bar", () => ({ StatusBar: () => null }));
  vi.doMock("expo-constants", () => ({ default: {} }));
  vi.doMock("expo-crypto", () => ({ randomUUID: () => "selected-occurrence", getRandomBytes: (count: number) => new Uint8Array(count).fill(1) }));
  vi.doMock("expo-clipboard", () => ({}));
  for (const name of ["expo-image-picker", "expo-image-manipulator", "expo-image", "expo-sharing", "expo-file-system", "expo-media-library", "expo-audio", "expo-network", "expo-secure-store", "expo-notifications", "expo-application"]) vi.doMock(name, () => new Proxy({}, { get: (_object, key) => key === "then" ? undefined : () => undefined }));
  vi.doMock("expo-modules-core", () => ({ requireNativeModule: () => ({}), requireOptionalNativeModule: () => ({}), NativeModule: class {}, EventEmitter: class {} }));
  vi.doMock("expo", () => ({ requireOptionalNativeModule: () => null }));
  vi.doMock("./mobile-client", () => ({ MobileClient: class { constructor() { return client; } } }));
  vi.doMock("./storage", () => new Proxy({ mobileComposerDrafts: drafts, mobileLocalePreferences: { snapshot: { effectiveLocale: "en" } } }, {
    get: (object, key) => key in object ? object[key as keyof typeof object] : {},
    has: () => true,
    getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, value: {} })
  }));
  const nativeModules = ["network", "native-lan-discovery", "native-notifications", "mobile-media-preview", "mobile-pdf-preview", "mobile-model-preview", "mobile-file-share", "mobile-files-thumbnail-cache", "mobile-incoming-share"];
  for (const name of nativeModules) vi.doMock(`./${name}`, () => new Proxy({}, { get: () => ({}), has: () => true, getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, value: {} }) }));
  vi.doMock("./mobile-push-controller", () => ({ MobilePushController: class {} }));
  vi.doMock("./mobile-voice-dictionary-readonly-controller", () => ({ MobileVoiceDictionaryReadOnlyController: class {} }));
  vi.doMock("./MobileComposerRichInput", () => ({
    MobileComposerRichInput: forwardRef((_props: ComponentProps<typeof MobileComposerRichInput>, ref) => {
      input = _props;
      if (ref && typeof ref !== "function") ref.current = { focus() {}, blur() {} } as never;
      return createElement("div", { "data-input": "composer" }, _props.draft.text);
    }), MobileComposerAtomChips: () => null, MobileAttachmentTray: () => null
  }));
  vi.doMock("./MobileRuntimeCommandPalette", () => ({ MobileRuntimeCommandPalette: (_props: ComponentProps<typeof MobileRuntimeCommandPalette>) => { palette = _props; return null; } }));
  const screens = ["MobileSharedConnectionScreen", "MobileFileTextPreview", "MobileFilesPreviewPager", "MobileTimelineImage", "MobileNativeIntentNotice", "MobilePhotoLibrarySheet", "MobileThinkingCard", "MobileWorkGroupCard", "MobilePlanCard", "MobileAudioMetadataCard", "MobileToolCallCard", "MobileDelegatedTaskCard", "MobileDrawer", "MobileActionSheet", "MobileTaskDerivationSheet", "MobileMessageRewindSheet", "MobileSessionDerivationMarker", "MobileComposerAtomSheet", "MobileCommandHelpSheet", "MobileQuoteSelectionSheet", "MobileInteractionSheet", "MobileRuntimeControlsSheet", "MobileNativeTreeSheet", "MobileSessionMentionSheet", "MobileWorkspaceMentionSheet", "MobileCatalogMentionSheet", "MobileMarkdownMessage", "MobileConversationShareBar", "MobileConversationShareRenderer", "MobileImageLightbox", "MobileMediaPlayer", "MobilePdfViewer", "MobileModelViewer", "MobileOfflineNotice", "MobileAutomationsScreen", "MobilePartnersScreen", "MobilePartnerDirectoryScreen", "MobilePartnerWorkingStatus", "MobilePartnerProfileSheet", "MobileConversationSearchSheet", "MobilePartnerResourcesScreen", "MobileExtensionsScreen", "MobileFilesToolbar", "MobileFilesBrowser", "MobileSettingsScreen", "MobileRemoteDesktopScreen", "MobileUpdateSurface"];
  for (const name of screens) vi.doMock(`./${name}`, () => new Proxy({}, {
    get: (_object, key) => key === "then" ? undefined : () => null,
    has: () => true,
    getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, value: () => null })
  }));
  vi.doMock("./MobileTaskTags", () => ({ MobileTaskTagDots: () => null, MobileTaskTagsSheet: () => null, mobileTaskTagName: () => "" }));
  vi.doMock("./use-mobile-task-header-role", () => ({ useMobileTaskHeaderRole: () => ({ role: taskRole, failed: false, retry() {} }) }));
  vi.doMock("./MobileTaskHeader", () => ({ MobileTaskHeader: (props: ComponentProps<typeof MobileTaskHeader>) => { header = props; return null; } }));
  vi.doMock("./MobileContextSheet", () => ({ MobileContextSheet: (props: ComponentProps<typeof MobileContextSheet>) => { contextSheet = props; return null; } }));
  vi.doMock("./MobileObjectiveSheet", () => ({ MobileObjectiveSheet: (props: MobileObjectiveSheetProps) => { objectiveSheet = props; return null; } }));
  vi.doMock("./MobilePartnerAvatar", () => ({ MobilePartnerAvatar: () => null, MobilePartnerAvatarProvider: surface }));
  vi.doMock("./MobilePartnerConversationRow", () => ({ MobilePartnerConversationRow: surface }));
  vi.doMock("./MobileKeyboardAvoidingView", () => ({ MobileKeyboardAvoidingView: surface, useMobileKeyboardState: () => ({ shown: false, height: 0 }) }));
  vi.doMock("./use-mobile-voice-input", () => ({ useMobileVoiceInput: () => ({ busy: false, recording: false, preparing: false, error: undefined }) }));
  vi.doMock("./use-mobile-partner-read", () => ({ useMobilePartnerIdentity: () => ({ ready: true, partner: activePartner, retrySequence: 0 }),
    useMobilePartnerRead: () => ({ ready: true, partner: activePartner }) }));
  vi.doMock("./use-mobile-audio-artwork", () => ({ useMobileAudioArtwork: () => new Map() }));
  vi.doMock("./mobile-delegated-reader", () => ({ useMobileDelegatedTasks: () => ({ entries: empty, loading: false }) }));
  vi.doMock("./use-mobile-hidden-history", () => ({ useMobileHiddenHistory: () => false }));
  vi.doMock("./use-mobile-conversation-share", () => ({ useMobileConversationShare: () => ({ active: false, busy: false, selectedIds: [], enterVisible() {} }) }));
  vi.doMock("./use-mobile-screenshot-selection", () => ({ useMobileScreenshotSelection() {} }));
  ({ TaskScreen } = await import("./App"));
});
beforeEach(async () => {
  current = true; resolveResource.mockReset().mockResolvedValue(resource); send.mockClear();
  activePartner = undefined; renderedState = state; privateDirectory.mockClear(); openPrivateThread.mockClear();
  activeObjectiveApi = undefined;
  activeCollaborationApi = undefined; taskRole = "ordinary";
  drafts.save(identity, plainTextMobileComposerDraft("/an arguments")); await drafts.flush(identity);
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
});
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); });
async function render(assertPalette = true): Promise<void> {
  await act(async () => root.render(createElement(TaskScreen, { colors, state: renderedState, locale: "en", onBack() {}, onHome() {}, onNew() {}, onFiles() {}, onOpenPartnerThread: openPrivateThread, onRemoteDesktop() {}, focusComposer: false, onComposerFocused() {}, onOpenDerivationOrigin: async () => false })));
  await act(async () => {});
  await act(async () => input.onFocus?.());
  await act(async () => input.onSelectionChange({ start: 3, end: 3 }, input.draft));
  await act(async () => {});
  if (assertPalette) { expect(input.editable).toBe(true); expect(input.selection).toEqual({ start: 3, end: 3 }); expect(palette.visible).toBe(true); expect(palette.checkingDraft).toBe(false); }
}
describe("actual App slash Skill selection", () => {
  it("adopts fresh full identity into the retained draft, restores it and only sends after explicit action", async () => {
    await render();
    await act(async () => input.onCommandPaletteKey?.("Enter"));
    expect(resolveResource).toHaveBeenCalledWith(runtime.surfaceOwnerKey, catalog, command, expect.any(AbortSignal));
    expect(input.draft.text).toBe("/analysis arguments");
    expect(input.draft.mentions).toMatchObject([{ kind: "resource", resourceId: "opaque-skill", discoveredRevision: "content-sha", resourceVersion: "11", runtimeGeneration: "7", start: 0, end: 9 }]);
    expect(input.draft.slashCommands).toEqual([]); expect(send).not.toHaveBeenCalled();
    const retained = drafts.readSync(identity)!; expect(retained).toEqual(input.draft);
    expect(mobileComposerInput(retained).mentionRanges).toMatchObject([{ start: 0, end: 9 }]);
    await act(async () => root.unmount()); root = createRoot(host); await render(false);
    expect(input.draft).toEqual(retained);
    const button = Array.from(host.querySelectorAll("button")).find((element) => element.textContent === mobileMessage("en", "composer.send"));
    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(send).toHaveBeenCalledWith(retained, expect.objectContaining({ operationId: "selected-occurrence" }));
  });
  it("keeps a failed slash Skill draft editable and can retry the formal selection without sending", async () => {
    await render();
    resolveResource.mockRejectedValueOnce(new Error("Skill unavailable"));
    await act(async () => palette.onSelect(command));
    expect(input.draft.text).toBe("/an arguments"); expect(input.draft.mentions).toEqual([]);
    expect(host.textContent).toContain("Skill unavailable"); expect(input.editable).toBe(true);
    vi.mocked(client.listTaskRuntimeCommands).mockResolvedValueOnce({ ...catalog });
    await act(async () => palette.onRetry());
    await act(async () => palette.onSelect(command));
    expect(input.draft.mentions[0]).toMatchObject({ resourceId: "opaque-skill" }); expect(send).not.toHaveBeenCalled();
  });
  it.each(["edit", "owner", "cancel", "ime"] as const)("does not adopt a late formal Skill after %s retirement", async (retirement) => {
    await render();
    let finish!: (value: typeof resource) => void;
    resolveResource.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const original = input.draft;
    await act(async () => palette.onSelect(command));
    await act(async () => {
      if (retirement === "edit") input.onEdit(replaceMobileComposerRange(original, { start: original.text.length, end: original.text.length }, " changed"), original);
      if (retirement === "owner") current = false;
      if (retirement === "cancel") palette.onClose();
      if (retirement === "ime") input.onCompositionChange?.(true);
      finish(resource);
    });
    expect(input.draft.text).toBe(retirement === "edit" ? "/an arguments changed" : "/an arguments");
    expect(input.draft.mentions).toEqual([]); expect(send).not.toHaveBeenCalled();
  });
});

it("opens the actual Context collaboration form, creates a waiting worker, and keeps the lead composer", async () => {
  activeCollaborationApi = { ownerKey: "team-source", sessionId: "session", generation: 7n, profileId: "profile", writable: true, initialTargetId: "target",
    targets: [{ id: "target", name: "Project", backendId: "backend", backendName: "Backend", models: [], permissionModes: [PermissionMode.ASK], canSetEffort: false, canSetFastMode: false }],
    load: vi.fn(async () => ({ role: "ordinary" })), restore: vi.fn(async () => undefined), enable: vi.fn(async () => ({ role: "lead" })) } as unknown as MobileCollaborationApi;
  await render(false); await act(async () => header.actions.find(action => action.id === "context")!.onPress());
  expect(contextSheet.visible).toBe(true); await act(async () => contextSheet.onCollaboration!());
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(value => value.getAttribute("aria-label") === "Enable collaboration");
  expect(button).toBeDefined(); await act(async () => button!.click());
  expect(activeCollaborationApi.enable).toHaveBeenCalledWith({ role: "developer", targetId: "target", initialTask: "", permissionMode: PermissionMode.ASK }, expect.any(AbortSignal));
  expect(drafts.readSync(identity)?.text).toBe("/an arguments"); expect(send).not.toHaveBeenCalled();
});

it("renders the actual worker conversation read-only with a return to its original lead", async () => {
  taskRole = "worker"; activeCollaborationApi = { ownerKey: "worker-source", sessionId: "session", restore: vi.fn(async () => undefined),
    load: vi.fn(async () => ({ role: "worker" })), openLead: vi.fn() } as unknown as MobileCollaborationApi;
  await act(async () => root.render(createElement(TaskScreen, { colors, state, locale: "en", onBack() {}, onHome() {}, onNew() {}, onFiles() {}, onOpenPartnerThread: openPrivateThread, onRemoteDesktop() {}, focusComposer: false, onComposerFocused() {}, onOpenDerivationOrigin: async () => false })));
  expect(host.textContent).toContain("Worker conversations are read-only"); expect(host.textContent).not.toContain("Send input");
  const back = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(value => value.getAttribute("aria-label") === "Return to lead");
  expect(back).toBeDefined(); await act(async () => back!.click()); expect(activeCollaborationApi.openLead).toHaveBeenCalledOnce();
  expect(header.detailsOnly).toBe(true); expect(send).not.toHaveBeenCalled();
});

it.each([false, true])("opens the actual Context objective and consumes its exact source draft only before retirement=%s", async retired => {
  activeObjectiveApi = { ownerKey: "objective-source", sessionId: "session", generation: 7n, writable: true,
    restore: vi.fn(async () => undefined) } as unknown as MobileObjectiveApi;
  await render(false);
  await act(async () => header.actions.find(action => action.id === "context")!.onPress());
  expect(contextSheet.visible).toBe(true); expect(contextSheet.objectiveApi).toBe(activeObjectiveApi);
  await act(async () => contextSheet.onObjective!());
  expect(objectiveSheet.visible).toBe(true); expect(objectiveSheet.initialText).toBe("/an arguments");
  const accept = objectiveSheet.onSaved!;
  if (retired) activeObjectiveApi = { ...activeObjectiveApi, ownerKey: "replacement-generation" };
  await act(async () => accept({ text: "Reach the result" }));
  expect(drafts.readSync(identity)?.text ?? "").toBe(retired ? "/an arguments" : "");
  expect(input.draft.text).toBe(retired ? "/an arguments" : ""); expect(send).not.toHaveBeenCalled();
});

it("opens the actual Task private source pill with a fresh current peer and keeps incoming private bodies hidden", async () => {
  activePartner = { ...peer, partnerId: "ada", displayName: "Ada", canonicalSessionId: "session" };
  const origin = { messageId: "private-message", threadId: "private-thread", senderPartnerId: "bea",
    recipientPartnerId: "ada", senderDisplayName: "Historical Bea" };
  renderedState = { ...state, live: [create(EventSchema, { eventId: "private-input",
    identity: { sessionId: "session" }, cursor: { generation: 1n, sequence: 1n, opaqueToken: "cursor" },
    payload: { kind: { case: "messageStarted", value: { messageId: "private-message", role: MessageRole.USER,
      userInputAccepted: true, partnerPrivateOrigin: origin,
      userInput: { parts: [{ content: { case: "text", value: "Original private prompt must stay hidden" } }] } } } } })] };
  await render(false);
  const button = host.querySelector<HTMLButtonElement>('[aria-label="Received from Current Bea"]');
  expect(button).not.toBeNull(); expect(privateDirectory).toHaveBeenCalledOnce();
  expect(host.textContent).not.toContain("Original private prompt must stay hidden");
  await act(async () => button!.click());
  expect(openPrivateThread).toHaveBeenCalledExactlyOnceWith({ threadId: "private-thread", targetPartnerId: "bea",
    targetName: "Historical Bea" });
  renderedState = { ...renderedState, status: "offline" };
  await render(false);
  const offline = host.querySelector<HTMLButtonElement>('[aria-label="Received from Historical Bea"]');
  expect(offline?.disabled).toBe(true);
  await act(async () => offline!.click());
  expect(openPrivateThread).toHaveBeenCalledOnce(); expect(privateDirectory).toHaveBeenCalledOnce();
});
