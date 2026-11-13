// @vitest-environment jsdom
import { act, createElement, forwardRef, useImperativeHandle, useRef, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { AuthenticationState, CapabilitySupport, EventCursorSchema, EventIdentitySchema, EventSchema, InteractionKind, InteractionSchema, InteractionState, McpAppNativeOperation, McpAppNativeServiceOperateResponseSchema, McpAppOperation, McpAppServiceOperateResponseSchema,
  MessageRole, ModelKeySchema, ModelSelectionSchema, ModelSourceKind, NativeMessageIdentitySchema, NativeSessionBindingSchema, PartnerSessionTaskStatus, PiMessageLifecycleKind, PlanReviewDecisionKind, ProviderAccountUsageSnapshotSchema, ProviderDescriptorSchema, QueueItemSchema, QueueItemState,
  RuntimeCommandInputMode, RuntimeCommandSource, ResourceKind, SessionSchema, SessionState, SnapshotSchema, capabilityNames } from "@joko/contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileComposerDraftStore } from "./composer-draft-store";
import { mobileComposerInput, plainTextMobileComposerDraft, replaceMobileComposerRange, type MobileComposerDraft } from "./mobile-composer-document";
import type { MobileComposerRichInput } from "./MobileComposerRichInput";
import type { MobileRuntimeCommandPalette } from "./MobileRuntimeCommandPalette";
import type { MobileState, MobileTaskSendObserver } from "./mobile-client";
import { mobileMessage } from "./mobile-messages";
import type { MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import type { MobileObjectiveApi } from "./mobile-objective";
import type { MobileCollaborationApi } from "./mobile-collaboration";
import { PermissionMode } from "@joko/contracts";
import type { MobileObjectiveSheetProps } from "./MobileObjectiveSheet";
import type { MobileTaskHeader } from "./MobileTaskHeader";
import type { MobileContextSheet } from "./MobileContextSheet";
import type { MobileConversationSearchSheet } from "./MobileConversationSearchSheet";
import type { MobileMcpAppApi } from "./mobile-mcp-app-api";
import type { MobileNativeIntentMessageFocus } from "./mobile-native-intent";
import type { MobileSheetActionItem } from "./MobileActionSheet";
import type { MobileMessageActionId } from "./task-actions";
import type { MobileProviderUsageTransport } from "./mobile-account-usage";
import { MobileInteractionDraftStore, mobileInteractionDraftIdentity } from "./interaction-draft-store";
import { pendingMobileInteractions } from "./mobile-interactions";
import type { MobileInteractionSheet } from "./MobileInteractionSheet";

type TimelineVisibility = (event: { viewableItems: { item: unknown; isViewable: boolean }[] }) => void;
type TimelineScrollFailure = (event: { index: number; averageItemLength: number }) => void;
type TimelineScrollSample = { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } };
type TimelineScrollHandlers = {
  maintainVisibleContentPosition?: { minIndexForVisible: number };
  onScroll?: (event: TimelineScrollSample) => void;
  onScrollBeginDrag?: (event?: TimelineScrollSample) => void;
  onScrollEndDrag?: (event: TimelineScrollSample) => void;
  onMomentumScrollBegin?: () => void;
  onMomentumScrollEnd?: (event: TimelineScrollSample) => void;
  onContentSizeChange?: (width: number, height: number) => void;
  onScrollToIndexFailed?: TimelineScrollFailure;
};
let timelineList: ({ data: readonly unknown[]; instance: object; onViewableItemsChanged: TimelineVisibility } & TimelineScrollHandlers) | undefined;
const scrollTimelineToIndex = vi.fn<(options: { index: number; animated: boolean; viewPosition?: number }) => void>();
const scrollTimelineToOffset = vi.fn();
const scrollTimelineToEnd = vi.fn();
type NativeAppStatus = "active" | "inactive" | "background";
const appStateListeners = new Set<(status: NativeAppStatus) => void>();
const nativeAppState = {
  currentState: "active" as NativeAppStatus,
  addEventListener: (_type: string, listener: (status: NativeAppStatus) => void) => {
    appStateListeners.add(listener);
    return { remove: () => { appStateListeners.delete(listener); } };
  }
};
let sendFollowSourceKey: string | undefined;
let sendFollowPresentationKey: string | undefined;
let ordinaryTimelineTransportKey: string | undefined;
let receiveAppMessage: ((event: { nativeEvent: { data: string } }) => void) | undefined;
let appBridgeKey = "";
let MobileMcpAppViewsProvider: typeof import("./MobileMcpAppViews").MobileMcpAppViewsProvider;
const openSystemLink = vi.fn(async (_url: string) => {});
const writeClipboard = vi.fn(async (_text: string) => true);

let input: ComponentProps<typeof MobileComposerRichInput>;
let palette: ComponentProps<typeof MobileRuntimeCommandPalette>;
let header: ComponentProps<typeof MobileTaskHeader>;
let contextSheet: ComponentProps<typeof MobileContextSheet>;
let conversationSearch: ComponentProps<typeof MobileConversationSearchSheet>;
let taskMessageActions: { items: readonly MobileSheetActionItem<MobileMessageActionId>[]; onAction: (action: MobileMessageActionId) => void } | undefined;
let interactionSheet: ComponentProps<typeof MobileInteractionSheet>;
let objectiveSheet: MobileObjectiveSheetProps;
let activeObjectiveApi: MobileObjectiveApi | undefined;
let activeCollaborationApi: MobileCollaborationApi | undefined;
let activeInputHandoffApi: import("./mobile-input-handoff").MobileInputHandoffApi | undefined;
let providerUsage: MobileProviderUsageTransport | undefined;
let taskRole: "ordinary" | "lead" | "worker" | undefined = "ordinary";
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
const interactionDrafts = new MobileInteractionDraftStore(drafts.driver);
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
const send = vi.fn(async (_draft: MobileComposerDraft, _observer?: MobileTaskSendObserver) => true);
const loadEarlier = vi.fn(async () => undefined);
const loadNewer = vi.fn(async (_signal: AbortSignal) => {});
const returnToLatest = vi.fn(() => {
  renderedState = { ...renderedState, window: undefined, windowHasNewer: false, before: undefined, historyEnd: false };
});
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
  taskHeaderSourceKey: () => sendFollowSourceKey,
  taskPresentationOwnerKey: () => sendFollowPresentationKey ?? sendFollowSourceKey,
  taskAppCommandControls: () => current ? appControls : undefined,
  taskRuntimeCommandControls: () => current ? runtime : undefined,
  listTaskRuntimeCommands: vi.fn(async () => catalog),
  resolveTaskRuntimeCommandResource: resolveResource,
  taskQueueItems: () => empty, taskQueueCapabilities: () => ({}),
  taskInteractions: () => pendingMobileInteractions(renderedState.detail, renderedState.selectedId), subscribe: () => () => {},
  taskPendingImagePasteCount: () => 0, taskForeground: () => true,
  taskNativeTreeControls: () => undefined, send, latest: returnToLatest, older: loadEarlier, newer: loadNewer, taskContextControls: () => undefined,
  taskProviderUsageTransport: () => providerUsage,
  taskObjectiveApi: () => current ? activeObjectiveApi : undefined,
  taskCollaborationApi: () => current ? activeCollaborationApi : undefined,
  taskInputHandoffApi: () => current ? activeInputHandoffApi : undefined,
  taskCatalogMentionControls: () => undefined, taskTimelineRows: () => empty,
  partnerConversationTransport: () => activePartner ? { ownerKey: "private-task", sessionId: "session" }
    : ordinaryTimelineTransportKey && renderedState.status === "connected" ? { ownerKey: ordinaryTimelineTransportKey, sessionId: "session" } : undefined,
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
  vi.doMock("react-native-webview", () => ({ WebView: ({ onMessage }: { onMessage?: typeof receiveAppMessage }) => {
    receiveAppMessage = onMessage;
    return null;
  } }));
  vi.stubGlobal("__DEV__", false);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.doMock("react-native", () => ({
    View: surface, Text: surface, ScrollView: surface, SectionList: surface, Image: surface, ActivityIndicator: surface,
    FlatList: forwardRef(({ data, renderItem, ListFooterComponent, onViewableItemsChanged, ...scrollHandlers }: { data?: readonly unknown[];
      ListFooterComponent?: ReactNode;
      renderItem?: (value: { item: unknown; index: number }) => ReactNode; onViewableItemsChanged?: TimelineVisibility } & TimelineScrollHandlers, ref) => {
      const instance = useRef({}).current;
      useImperativeHandle(ref, () => ({ scrollToIndex: scrollTimelineToIndex, scrollToOffset: scrollTimelineToOffset, scrollToEnd: scrollTimelineToEnd }), []);
      if (onViewableItemsChanged) timelineList = { data: data ?? [], instance, onViewableItemsChanged, ...scrollHandlers };
      return createElement("div", null, data?.map((item, index) => createElement("div", { key: index }, renderItem?.({ item, index }))), ListFooterComponent);
    }), TextInput: forwardRef(() => null),
    Modal: ({ visible, children }: { visible?: boolean; children?: ReactNode }) => visible ? createElement("div", null, children) : null,
    Pressable: ({ children, onPress, disabled, accessibilityLabel }: { children?: ReactNode | ((value: { pressed: boolean }) => ReactNode); onPress?: () => void; disabled?: boolean; accessibilityLabel?: string }) => createElement("button", { onClick: onPress, disabled, "aria-label": accessibilityLabel }, typeof children === "function" ? children({ pressed: false }) : children),
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }, Platform: { OS: "android", select: (value: Record<string, unknown>) => value.android ?? value.default },
    AppState: nativeAppState, BackHandler: { addEventListener: () => ({ remove() {} }) },
    Keyboard: { dismiss() {}, addListener: () => ({ remove() {} }) }, PanResponder: { create: () => ({ panHandlers: {} }) },
    AccessibilityInfo: { announceForAccessibility() {}, setAccessibilityFocus() {}, addEventListener: () => ({ remove() {} }) },
    Linking: { openURL: openSystemLink }, Alert: { alert() {} }, findNodeHandle: () => null, useColorScheme: () => "light", useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 })
  }));
  vi.doMock("react-native-safe-area-context", () => ({ SafeAreaProvider: surface, SafeAreaView: surface, useSafeAreaInsets: () => ({ top: 0, left: 0, bottom: 0, right: 0 }) }));
  vi.doMock("react-native-svg", () => ({ SvgXml: () => null }));
  vi.doMock("expo-status-bar", () => ({ StatusBar: () => null }));
  vi.doMock("expo-constants", () => ({ default: {} }));
  vi.doMock("expo-crypto", () => {
    let nextByte = 0;
    return { randomUUID: () => "selected-occurrence", getRandomBytes: (count: number) => new Uint8Array(count).fill(++nextByte) };
  });
  vi.doMock("expo-clipboard", () => ({ setStringAsync: writeClipboard }));
  vi.doMock("expo-camera", () => ({ CameraView: () => null, useCameraPermissions: () => [undefined, vi.fn()] }));
  for (const name of ["expo-image-picker", "expo-image-manipulator", "expo-image", "expo-sharing", "expo-file-system", "expo-media-library", "expo-audio", "expo-network", "expo-secure-store", "expo-notifications", "expo-application"]) vi.doMock(name, () => new Proxy({}, { get: (_object, key) => key === "then" ? undefined : () => undefined }));
  vi.doMock("expo-modules-core", () => ({ requireNativeModule: () => ({}), requireOptionalNativeModule: () => ({}),
    requireNativeViewManager: (_module: string, name: string) => ({ surfaceId, children }: { surfaceId: string; children?: ReactNode }) =>
      createElement("div", { [name === "AppHost" ? "data-app-host" : "data-app-slot"]: surfaceId }, children),
    NativeModule: class {}, EventEmitter: class {} }));
  vi.doMock("../modules/joko-mcp-app-surface/src/JokoMcpAppSurfaceModule", () => ({ default: { appHostAvailable: true } }));
  vi.doMock("./mobile-mcp-app-document", () => ({ prepareMcpAppNativeDocument: async (_document: unknown, bridgeKey: string) => {
    appBridgeKey = bridgeKey;
    const uri = "http://127.0.0.1:2/proxy.html";
    return { source: { uri }, documentUrls: [uri], resourceUrl: "http://127.0.0.1:1/resource.html", close: async () => {} };
  } }));
  vi.doMock("expo", () => ({ requireOptionalNativeModule: () => null }));
  vi.doMock("./mobile-client", () => ({ MobileClient: class { constructor() { return client; } } }));
  vi.doMock("./storage", () => new Proxy({ mobileComposerDrafts: drafts, mobileInteractionDrafts: interactionDrafts,
    mobileLocalePreferences: { snapshot: { effectiveLocale: "en" } },
    mobileReplyQuotePreferences: { snapshot: { ready: true, visible: true, saving: false, failed: false }, subscribe: () => () => {}, hydrate: async () => {} } }, {
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
  vi.doMock("./MobileInputHandoffPanel", () => ({ MobileInputHandoffPanel: (props: { api: import("./mobile-input-handoff").MobileInputHandoffApi }) => createElement("div", { "data-input-handoff-owner": props.api.ownerKey }, "Owner input handoff") }));
  const screens = ["MobileSharedConnectionScreen", "MobileFileTextPreview", "MobileFilesPreviewPager", "MobileTimelineImage", "MobileNativeIntentNotice", "MobilePhotoLibrarySheet", "MobileThinkingCard", "MobileWorkGroupCard", "MobilePlanCard", "MobileAudioMetadataCard", "MobileToolCallCard", "MobileDelegatedTaskCard", "MobileDrawer", "MobileTaskDerivationSheet", "MobileMessageRewindSheet", "MobileSessionDerivationMarker", "MobileComposerAtomSheet", "MobileCommandHelpSheet", "MobileQuoteSelectionSheet", "MobileRuntimeControlsSheet", "MobileNativeTreeSheet", "MobileSessionMentionSheet", "MobileWorkspaceMentionSheet", "MobileCatalogMentionSheet", "MobileMarkdownMessage", "MobileConversationShareBar", "MobileConversationShareRenderer", "MobileImageLightbox", "MobileMediaPlayer", "MobilePdfViewer", "MobileModelViewer", "MobileOfflineNotice", "MobileAutomationsScreen", "MobilePartnersScreen", "MobilePartnerDirectoryScreen", "MobilePartnerWorkingStatus", "MobilePartnerProfileSheet", "MobilePartnerResourcesScreen", "MobileExtensionsScreen", "MobileFilesToolbar", "MobileFilesBrowser", "MobileSettingsScreen", "MobileRemoteDesktopScreen", "MobileUpdateSurface"];
  for (const name of screens) vi.doMock(`./${name}`, () => new Proxy({}, {
    get: (_object, key) => key === "then" ? undefined : () => null,
    has: () => true,
    getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, value: () => null })
  }));
  vi.doMock("./MobileConversationSearchSheet", () => ({ MobileConversationSearchSheet: (props: ComponentProps<typeof MobileConversationSearchSheet>) => {
    conversationSearch = props;
    return null;
  } }));
  vi.doMock("./MobileActionSheet", () => ({ MobileActionSheet: (props: NonNullable<typeof taskMessageActions> & { visible: boolean }) => {
    if (props.visible && props.items.some(item => item.id === "copy-text")) taskMessageActions = props;
    return null;
  } }));
  vi.doMock("./MobileInteractionSheet", () => ({ MobileInteractionSheet: (props: ComponentProps<typeof MobileInteractionSheet>) => {
    interactionSheet = props;
    return null;
  } }));
  vi.doMock("./MobileTaskTags", () => ({ MobileTaskTagDots: () => null, MobileTaskTagsSheet: () => null, mobileTaskTagName: () => "" }));
  vi.doMock("./use-mobile-task-header-role", () => ({ useMobileTaskHeaderRole: () => ({ role: taskRole, failed: false, retry() {} }) }));
  vi.doMock("./MobileTaskHeader", () => ({ MobileTaskHeader: (props: ComponentProps<typeof MobileTaskHeader>) => {
    header = props;
    return providerUsage ? createElement("div", { "data-task-menu-header": true }, props.menuHeader) : null;
  } }));
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
  ({ MobileMcpAppViewsProvider } = await import("./MobileMcpAppViews"));
});
beforeEach(async () => {
  current = true; resolveResource.mockReset().mockResolvedValue(resource); send.mockReset().mockResolvedValue(true);
  returnToLatest.mockClear();
  loadEarlier.mockReset().mockResolvedValue(undefined);
  loadNewer.mockReset().mockResolvedValue(undefined);
  taskMessageActions = undefined;
  writeClipboard.mockClear();
  nativeAppState.currentState = "active";
  timelineList = undefined; scrollTimelineToIndex.mockReset(); scrollTimelineToOffset.mockClear(); scrollTimelineToEnd.mockClear();
  sendFollowSourceKey = undefined; sendFollowPresentationKey = undefined; ordinaryTimelineTransportKey = undefined;
  activePartner = undefined; renderedState = state; privateDirectory.mockClear(); openPrivateThread.mockClear();
  activeObjectiveApi = undefined;
  activeCollaborationApi = undefined; activeInputHandoffApi = undefined; providerUsage = undefined; taskRole = "ordinary";
  drafts.save(identity, plainTextMobileComposerDraft("/an arguments")); await drafts.flush(identity);
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
});
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); vi.useRealTimers(); });
function taskScreen(messageFocus?: ComponentProps<typeof TaskScreen>["messageFocus"],
  onMessageFocusConsumed?: ComponentProps<typeof TaskScreen>["onMessageFocusConsumed"]) {
  return createElement(TaskScreen, { colors, state: renderedState, locale: "en", onBack() {}, onHome() {}, onNew() {}, onFiles() {},
    onOpenPartnerThread: openPrivateThread, onRemoteDesktop() {}, focusComposer: false, onComposerFocused() {}, onOpenDerivationOrigin: async () => false,
    messageFocus, onMessageFocusConsumed });
}
async function render(assertPalette = true): Promise<void> {
  await act(async () => root.render(taskScreen()));
  await act(async () => {});
  await act(async () => input.onFocus?.());
  await act(async () => input.onSelectionChange({ start: 3, end: 3 }, input.draft));
  await act(async () => {});
  if (assertPalette) { expect(input.editable).toBe(true); expect(input.selection).toEqual({ start: 3, end: 3 }); expect(palette.visible).toBe(true); expect(palette.checkingDraft).toBe(false); }
}

it("reads the actual task menu's Claude family quota using the owning model route", async () => {
  const model = create(ModelKeySchema, { providerId: "provider", modelId: "claude-opus-4[1m]" });
  const selected = create(SessionSchema, { ...session, model: create(ModelSelectionSchema, { model }) });
  const owner = create(SnapshotSchema, { sessions: [selected], models: [
    { backendId: "other-backend", key: model, source: { kind: ModelSourceKind.LOCAL, nativeAdapterKind: "pi" } },
    { backendId: selected.backendId, key: model, source: { kind: ModelSourceKind.LOCAL, nativeAdapterKind: "claude-agent-sdk-stdio" } }
  ] });
  const provider = create(ProviderDescriptorSchema, { backendId: selected.backendId, providerId: model.providerId, displayName: "Owner subscription",
    authenticationState: AuthenticationState.AUTHENTICATED, version: { generation: 0n, revision: { value: 1n } },
    capabilities: { schemaVersion: "joko.provider.v1", capabilities: [{ name: capabilityNames.providerAccountUsage, support: CapabilitySupport.SUPPORTED }] } });
  const read = vi.fn<MobileProviderUsageTransport["read"]>(async () => create(ProviderAccountUsageSnapshotSchema, { providerId: model.providerId,
    observedAt: { seconds: BigInt(Math.floor(Date.now() / 1000)) }, primaryWindow: { usedPercent: 20, windowMinutes: 300 }, modelWindows: [
      { displayName: "Claude Sonnet", window: { usedPercent: 87, windowMinutes: 10_080 } },
      { displayName: "Claude Opus", window: { usedPercent: 100, windowMinutes: 10_080 } }
    ] }));
  providerUsage = { ownerKey: "owned-usage", providers: [provider], read };
  renderedState = { ...state, detail: owner, owner };
  await act(async () => root.render(taskScreen()));
  expect(read).not.toHaveBeenCalled();
  await act(async () => header.onMenuVisibilityChange(true));
  expect(read).toHaveBeenCalledExactlyOnceWith(selected.backendId, model.providerId, expect.any(AbortSignal));
  const menu = host.querySelector("[data-task-menu-header]");
  expect(menu?.textContent).toContain("80% remaining");
  expect(menu?.textContent).toContain("Claude Opus");
  expect(Array.from(menu?.querySelectorAll("div") ?? []).some(row => row.children[0]?.textContent?.startsWith("Claude Opus")
    && row.children[1]?.textContent === "0% remaining")).toBe(true);
  expect(menu?.textContent).not.toContain("Claude Sonnet");
  const other = create(SnapshotSchema, { ...owner, models: owner.models.map(row => row.backendId === selected.backendId && row.source
    ? { ...row, source: { ...row.source, nativeAdapterKind: "pi" } } : row) });
  renderedState = { ...state, detail: other, owner: other };
  await act(async () => root.render(taskScreen()));
  expect(host.querySelector("[data-task-menu-header]")?.textContent).not.toContain("Claude Opus");
});

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

it.each(["ordinary open", "manual drag", "explicit message focus"] as const)("uses the initial task tail only for an %s", async (opening) => {
  vi.useFakeTimers();
  sendFollowSourceKey = "task-source";
  renderedState = { ...state, live: Array.from({ length: 24 }, (_, index) =>
    taskUserInput(`input-${index}`, `operation-${index}`, BigInt(index + 1), `Existing input ${index}`)) };
  const focus = opening === "explicit message focus"
    ? { requestId: 1, sessionId: "session", messageId: "input-3", messageEventId: "input-3" } : undefined;
  await act(async () => root.render(taskScreen(focus)));
  expect(timelineList?.data).toHaveLength(24);
  if (opening === "manual drag") await act(async () => timelineList?.onScrollBeginDrag?.());
  await act(async () => {
    timelineList?.onContentSizeChange?.(400, 1_600);
    timelineList?.onContentSizeChange?.(400, 1_700);
    timelineList?.onContentSizeChange?.(400, 1_800);
  });
  expect(scrollTimelineToEnd.mock.calls).toEqual(opening === "ordinary open" ? [[{ animated: false }], [{ animated: false }]] : []);
});

it("retires the pending native scroll retry when the open conversation search clears its hit", async () => {
  vi.useFakeTimers();
  renderedState = { ...state, live: [taskUserInput("first", "first-operation", 1n, "First match"),
    taskUserInput("second", "second-operation", 2n, "Second match")] };
  await act(async () => root.render(taskScreen()));
  const action = header.actions.find(item => item.id === "search")!;
  expect(action.disabled).toBe(false);
  await act(async () => action.onPress());
  expect(conversationSearch.visible).toBe(true);
  await act(async () => conversationSearch.onFocus({ itemKey: "second", sourceKey: "second" }));
  await act(async () => vi.advanceTimersByTimeAsync(30));
  expect(scrollTimelineToIndex).toHaveBeenCalledExactlyOnceWith({ index: 1, animated: false, viewPosition: 0.2 });
  await act(async () => timelineList?.onScrollToIndexFailed?.({ index: 1, averageItemLength: 100 }));
  expect(scrollTimelineToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 100, animated: false });
  await act(async () => conversationSearch.onFocus(undefined));
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(conversationSearch.visible).toBe(true);
  expect(scrollTimelineToIndex).toHaveBeenCalledTimes(1);
});

it("follows the measured ordinary tail through streaming growth until the reader scrolls up", async () => {
  vi.useFakeTimers();
  sendFollowSourceKey = "task-source";
  const streaming = create(SnapshotSchema, { sessions: [create(SessionSchema, { ...session, state: SessionState.RUNNING })] });
  const prompt = taskUserInput("prompt", "prompt-operation", 1n, "A task question");
  const first = taskAssistantDelta("first-delta", 2n, "Streaming");
  renderedState = { ...state, owner: streaming, detail: streaming, live: [prompt, first] };
  await mountMeasuredTimelineTail();

  const second = taskAssistantDelta("second-delta", 3n, " reply");
  renderedState = { ...renderedState, live: [prompt, first, second] };
  await act(async () => root.render(taskScreen()));
  expect(timelineList!.data).toContainEqual(expect.objectContaining({ id: "streaming-reply", text: "Streaming reply" }));
  await act(async () => {
    // Native layout can report the old offset with the new height first.
    timelineList!.onScroll!(timelineScrollSample(1_200, 1_800));
    timelineList!.onContentSizeChange!(400, 1_800);
    timelineList!.onContentSizeChange!(400, 1_800);
  });
  expect(scrollTimelineToEnd).toHaveBeenCalledExactlyOnceWith({ animated: false });
  expect(timelineLatestButton()).toBeUndefined();

  await act(async () => {
    const bottom = timelineScrollSample(1_400, 1_800), earlier = timelineScrollSample(600, 1_800);
    timelineList!.onScroll!(bottom);
    timelineList!.onScrollBeginDrag!(bottom);
    timelineList!.onScrollEndDrag!(bottom);
    timelineList!.onMomentumScrollBegin!();
    timelineList!.onScroll!(earlier);
    timelineList!.onMomentumScrollEnd!(earlier);
  });
  renderedState = { ...renderedState, live: [prompt, first, second, taskAssistantDelta("third-delta", 4n, " keeps growing")] };
  await act(async () => root.render(taskScreen()));
  await act(async () => timelineList!.onContentSizeChange!(400, 2_000));
  expect(scrollTimelineToEnd).toHaveBeenCalledTimes(1);
  expect(timelineLatestButton()).toBeUndefined();

  renderedState = { ...renderedState, live: [...renderedState.live, taskAssistantAnswer("stream-completed", 5n, "streaming-reply")] };
  await act(async () => root.render(taskScreen()));
  expect(timelineLatestButton()).toBeUndefined();
});

it.each(["jump button", "manual return"] as const)("preserves older reading until a stable new tail and clears its notice by %s", async (returnMode) => {
  vi.useFakeTimers();
  sendFollowSourceKey = "task-source";
  const prompt = taskUserInput("loaded-prompt", "prompt-operation", 2n, "Loaded question");
  const answer = taskAssistantAnswer("loaded-answer", 3n);
  renderedState = { ...state, live: [prompt, answer] };
  await mountMeasuredTimelineTail();
  await act(async () => {
    const bottom = timelineScrollSample(1_200, 1_600), earlier = timelineScrollSample(500, 1_600);
    timelineList!.onScrollBeginDrag!(bottom);
    timelineList!.onScroll!(earlier);
    timelineList!.onScrollEndDrag!(earlier);
  });

  const earlierPage = taskUserInput("earlier-prompt", "earlier-operation", 1n, "Loaded from earlier history");
  renderedState = { ...renderedState, older: [earlierPage] };
  await act(async () => root.render(taskScreen()));
  await act(async () => timelineList!.onContentSizeChange!(400, 1_800));
  expect(timelineLatestButton()).toBeUndefined();
  expect(scrollTimelineToEnd).not.toHaveBeenCalled();

  const newPrompt = taskUserInput("another-prompt", "other-device-operation", 4n, "A new question");
  renderedState = { ...renderedState, live: [prompt, answer, newPrompt] };
  await act(async () => root.render(taskScreen()));
  expect(timelineList!.data).toContainEqual(expect.objectContaining({ id: "another-prompt" }));
  await act(async () => timelineList!.onContentSizeChange!(400, 2_000));
  expect(scrollTimelineToEnd).not.toHaveBeenCalled();
  expect(timelineLatestButton()).toBeDefined();

  if (returnMode === "jump button") {
    await act(async () => timelineLatestButton()!.click());
    expect(scrollTimelineToEnd).toHaveBeenCalledExactlyOnceWith({ animated: false });
  } else {
    await act(async () => {
      const earlier = timelineScrollSample(500, 2_000), bottom = timelineScrollSample(1_600, 2_000);
      timelineList!.onScrollBeginDrag!(earlier);
      timelineList!.onScroll!(bottom);
      timelineList!.onScrollEndDrag!(bottom);
    });
    expect(scrollTimelineToEnd).not.toHaveBeenCalled();
  }
  expect(timelineLatestButton()).toBeUndefined();
  scrollTimelineToEnd.mockClear();
  renderedState = { ...renderedState, live: [prompt, answer, newPrompt, taskAssistantAnswer("new-answer", 5n)] };
  await act(async () => root.render(taskScreen()));
  await act(async () => timelineList!.onContentSizeChange!(400, 2_200));
  expect(scrollTimelineToEnd).toHaveBeenCalledExactlyOnceWith({ animated: false });
  expect(timelineLatestButton()).toBeUndefined();
});

it.each(["connection", "around window", "foreground cycle"] as const)("retires the measured tail on a %s change", async (retirement) => {
  vi.useFakeTimers();
  sendFollowSourceKey = "task-source";
  const prompt = taskUserInput("prompt", "prompt-operation", 1n, "Initial question");
  renderedState = { ...state, live: [prompt] };
  await mountMeasuredTimelineTail();
  const oldList = timelineList!;
  if (retirement === "connection") sendFollowSourceKey = "replacement-connection";
  if (retirement === "around window") renderedState = { ...renderedState, window: [prompt] };
  if (retirement === "foreground cycle") {
    await act(async () => changeNativeAppStatus("background"));
    await act(async () => changeNativeAppStatus("active"));
  }
  await act(async () => root.render(taskScreen()));
  await act(async () => oldList.onContentSizeChange!(400, 1_800));
  expect(scrollTimelineToEnd).not.toHaveBeenCalled();
  expect(timelineLatestButton()).toBeUndefined();
});

it.each(["unmeasured input", "fast answer", "manual drag", "newer input", "unconfirmed send"] as const)(
  "hands an accepted ordinary send to the actual task list once with %s", async (arrival) => {
    vi.useFakeTimers();
    sendFollowSourceKey = "task-source";
    const draft = plainTextMobileComposerDraft("Show the latest accepted input");
    const oldPrompt = taskUserInput("old-prompt", "previous-operation", 10n, "Older prompt");
    renderedState = { ...state, live: [oldPrompt] };
    let finish!: (accepted: boolean) => void;
    const receipt = new Promise<boolean>((resolve) => { finish = resolve; });
    send.mockImplementationOnce(async (value, observer) => {
      observer?.onProgress?.({ phase: "sending", input: value, sentAt: 2 });
      return receipt;
    });
    await render(false);
    await act(async () => {
      const bottom = timelineScrollSample(1_200, 1_600), earlier = timelineScrollSample(500, 1_600);
      timelineList!.onContentSizeChange!(400, 1_600);
      timelineList!.onScroll!(bottom);
      timelineList!.onScrollBeginDrag!(bottom);
      timelineList!.onScroll!(earlier);
      timelineList!.onScrollEndDrag!(earlier);
    });
    scrollTimelineToEnd.mockClear();
    await act(async () => input.onEdit(replaceMobileComposerRange(input.draft, { start: 0, end: input.draft.text.length }, draft.text), input.draft));
    const sendButton = Array.from(host.querySelectorAll("button")).find(button => button.textContent === mobileMessage("en", "composer.send"));
    expect(sendButton).toBeDefined();
    await act(async () => sendButton!.click());
    const operationId = send.mock.calls[0]?.[1]?.operationId;
    expect(operationId).toBe("selected-occurrence");
    const initialRows = timelineList!.data as readonly { operationId?: string; optimistic?: boolean }[];
    const provisional = initialRows.findIndex(row => row.operationId === operationId && row.optimistic);
    expect(provisional).toBeGreaterThanOrEqual(0);
    expect(provisional).toBeGreaterThan(initialRows.findIndex(row => row.operationId === "previous-operation"));
    expect(scrollTimelineToIndex).not.toHaveBeenCalled();

    if (arrival === "manual drag") await act(async () => timelineList?.onScrollBeginDrag?.());
    if (arrival === "unmeasured input") {
      const queued = create(QueueItemSchema, { queueItemId: "queued-input", sessionId: session.sessionId, backendId: session.backendId,
        targetId: session.targetId, sourceId: operationId, state: QueueItemState.ACCEPTED });
      renderedState = { ...renderedState, detail: create(SnapshotSchema, { ...renderedState.detail!, queueItems: [queued] }) };
      await act(async () => root.render(taskScreen()));
      scrollTimelineToIndex.mockImplementationOnce(({ index }) => timelineList?.onScrollToIndexFailed?.({ index, averageItemLength: 40 }));
      await act(async () => finish(true));
      expect(scrollTimelineToIndex).toHaveBeenCalledExactlyOnceWith({ index: provisional, animated: false, viewPosition: 0.2 });
      expect(scrollTimelineToOffset).toHaveBeenCalledExactlyOnceWith({ offset: provisional * 40, animated: false });
    } else if (arrival === "unconfirmed send") {
      await act(async () => finish(false));
      expect(scrollTimelineToIndex).not.toHaveBeenCalled();
    }
    const accepted = taskUserInput("accepted-prompt", operationId!, 11n, draft.text);
    const reply = create(EventSchema, { eventId: "quick-answer", identity: { sessionId: "session" }, cursor: { generation: 1n, sequence: 12n },
      payload: { kind: { case: "messageCompleted", value: { messageId: "quick-answer", role: MessageRole.ASSISTANT,
        blocks: [{ content: { case: "text", value: "Reply already arrived" } }] } } } });
    renderedState = { ...state, live: [oldPrompt, accepted, reply,
      ...(arrival === "newer input" ? [taskUserInput("other-prompt", "another-operation", 13n, "Newer independent prompt")] : [])] };
    await act(async () => root.render(taskScreen()));
    const rows = timelineList!.data as readonly { operationId?: string }[];
    const index = rows.findIndex(row => row.operationId === operationId);
    expect(index).toBeGreaterThan(rows.findIndex(row => row.operationId === "previous-operation"));
    expect(index).toBeLessThan(rows.length - 1);

    if (arrival !== "unmeasured input" && arrival !== "unconfirmed send") {
      expect(scrollTimelineToIndex).not.toHaveBeenCalled();
      await act(async () => finish(true));
    }
    if (arrival === "fast answer" || arrival === "unmeasured input") {
      expect(scrollTimelineToIndex).toHaveBeenCalledExactlyOnceWith({ index, animated: false, viewPosition: 0.2 });
    } else {
      expect(scrollTimelineToIndex).not.toHaveBeenCalled();
    }
    await act(async () => {
      timelineList?.onContentSizeChange?.(400, 800);
      timelineList?.onContentSizeChange?.(400, 900);
    });
    expect(scrollTimelineToIndex).toHaveBeenCalledTimes(arrival === "unmeasured input" ? 2 : arrival === "fast answer" ? 1 : 0);
    if (arrival === "unmeasured input") {
      expect(scrollTimelineToIndex).toHaveBeenLastCalledWith({ index, animated: false, viewPosition: 0.2 });
    }
    expect(scrollTimelineToEnd).not.toHaveBeenCalled();
  });

it.each(["own refresh", "reader drag", "other refresh", "replaced list"] as const)(
  "waits for fresh ordinary authority after an accepted send through %s", async (outcome) => {
    vi.useFakeTimers();
    sendFollowSourceKey = "header-before";
    sendFollowPresentationKey = "same-task";
    ordinaryTimelineTransportKey = "same-task-transport";
    const oldPrompt = taskUserInput("old-prompt", "previous-operation", 10n, "Older prompt");
    renderedState = { ...state, live: [oldPrompt] };
    let accept!: (value: boolean) => void;
    const sendResult = new Promise<boolean>(resolve => { accept = resolve; });
    send.mockImplementationOnce(async (draft, observer) => {
      observer?.onProgress?.({ phase: "sending", input: draft, sentAt: 2 });
      return sendResult;
    });
    await mountMeasuredTimelineTail();
    const originalList = timelineList!.instance;
    const bottom = timelineScrollSample(1_200, 1_600), earlier = timelineScrollSample(500, 1_600);
    await act(async () => {
      timelineList!.onScrollBeginDrag!(bottom);
      timelineList!.onScroll!(earlier);
      timelineList!.onScrollEndDrag!(earlier);
    });
    const text = "Follow my accepted input";
    await act(async () => input.onEdit(replaceMobileComposerRange(input.draft, { start: 0, end: input.draft.text.length }, text), input.draft));
    const sendButton = Array.from(host.querySelectorAll("button")).find(button => button.textContent === mobileMessage("en", "composer.send"));
    expect(sendButton).toBeDefined();
    await act(async () => sendButton!.click());
    const observer = send.mock.calls[0]?.[1];
    expect(observer?.operationId).toBe("selected-occurrence");
    expect(observer?.onAcceptedRefresh).toBeTypeOf("function");
    let connectionEpoch = 1;
    await act(async () => {
      observer!.onAcceptedRefresh!(() => connectionEpoch === 2);
      connectionEpoch = 2;
      sendFollowSourceKey = undefined;
      taskRole = undefined;
      renderedState = { ...renderedState, status: "connecting" };
      root.render(taskScreen());
    });
    expect(timelineList!.instance).toBe(originalList);
    expect(scrollTimelineToIndex).not.toHaveBeenCalled();
    if (outcome === "reader drag") await act(async () => {
      timelineList!.onScrollBeginDrag!(earlier);
      timelineList!.onScroll!(timelineScrollSample(250, 1_600));
      timelineList!.onScrollEndDrag!(timelineScrollSample(250, 1_600));
    });
    if (outcome === "other refresh") connectionEpoch++;
    if (outcome === "replaced list") ordinaryTimelineTransportKey = "other-task-transport";
    sendFollowSourceKey = "header-after";
    const queued = create(QueueItemSchema, { queueItemId: "accepted-queue", sessionId: session.sessionId, backendId: session.backendId,
      targetId: session.targetId, sourceId: observer!.operationId, state: QueueItemState.ACCEPTED });
    renderedState = { ...state, live: [oldPrompt], detail: create(SnapshotSchema, { ...state.detail!, queueItems: [queued] }) };
    await act(async () => root.render(taskScreen()));
    if (outcome === "replaced list") expect(timelineList!.instance).not.toBe(originalList);
    else expect(timelineList!.instance).toBe(originalList);
    await act(async () => accept(true));
    expect(scrollTimelineToIndex).not.toHaveBeenCalled();

    scrollTimelineToIndex.mockImplementationOnce(({ index }) => timelineList!.onScrollToIndexFailed!({ index, averageItemLength: 40 }));
    taskRole = "ordinary";
    await act(async () => root.render(taskScreen()));
    expect(scrollTimelineToIndex).toHaveBeenCalledTimes(outcome === "own refresh" ? 1 : 0);
    const echo = taskUserInput("accepted-prompt", observer!.operationId!, 11n, text);
    renderedState = { ...state, live: [oldPrompt, echo, taskAssistantAnswer("fast-answer", 12n)] };
    await act(async () => root.render(taskScreen()));
    expect(timelineList!.data).toContainEqual(expect.objectContaining({ id: echo.eventId, operationId: observer!.operationId }));
    await act(async () => {
      timelineList!.onContentSizeChange!(400, 1_800);
      timelineList!.onContentSizeChange!(400, 1_900);
    });
    if (outcome === "own refresh") {
      expect(scrollTimelineToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 40, animated: false });
      expect(scrollTimelineToIndex.mock.calls).toEqual([[{ index: 1, animated: false, viewPosition: 0.2 }],
        [{ index: 1, animated: false, viewPosition: 0.2 }]]);
    } else expect(scrollTimelineToIndex).not.toHaveBeenCalled();
  });

it.each(["accepted", "reader drag", "new window", "new focus", "unknown"] as const)(
  "adopts the current accepted send from a historic window only while its presentation owns it (%s)", async outcome => {
    sendFollowSourceKey = "anchored-task";
    sendFollowPresentationKey = "same-task";
    ordinaryTimelineTransportKey = "same-task-transport";
    const anchor = taskUserInput("old-anchor", "old-operation", 4n, "Original linked message");
    const anchorWindow = [anchor];
    renderedState = { ...state, window: anchorWindow };
    const originalFocus = { requestId: 1, sessionId: session.sessionId, messageId: anchor.eventId, messageEventId: anchor.eventId };
    let focus: MobileNativeIntentMessageFocus | undefined = originalFocus;
    const consumeFocus = vi.fn((consumed: MobileNativeIntentMessageFocus) => { if (focus === consumed) focus = undefined; });
    let finish!: (accepted: boolean) => void;
    send.mockImplementationOnce(async (draft, observer) => {
      observer?.onProgress?.({ phase: "sending", input: draft, sentAt: 2 });
      return new Promise<boolean>(resolve => { finish = resolve; });
    });
    await act(async () => root.render(taskScreen(focus, consumeFocus)));
    const text = "Show the sent message";
    await act(async () => input.onEdit(replaceMobileComposerRange(input.draft, { start: 0, end: input.draft.text.length }, text), input.draft));
    const sendButton = Array.from(host.querySelectorAll("button")).find(button => button.textContent === mobileMessage("en", "composer.send"));
    expect(sendButton?.disabled).toBe(false);
    await act(async () => sendButton!.click());
    const observer = send.mock.calls[0]![1]!;
    expect(observer.operationId).toBe("selected-occurrence");
    expect(timelineList!.data).toEqual([expect.objectContaining({ id: anchor.eventId })]);
    expect(returnToLatest).not.toHaveBeenCalled();

    if (outcome === "reader drag") await act(async () => timelineList!.onScrollBeginDrag!());
    if (outcome === "new window") renderedState = { ...renderedState, window: [...anchorWindow] };
    if (outcome === "new focus") focus = { ...originalFocus, requestId: 2 };
    await act(async () => root.render(taskScreen(focus, consumeFocus)));
    const latestWindow = renderedState.window;
    const echo = taskUserInput("accepted-input", observer.operationId!, 11n, text);
    const originalList = timelineList!.instance;
    let refreshOwned = false;
    await act(async () => {
      if (outcome !== "unknown") observer.onAcceptedRefresh!(() => refreshOwned);
      if (outcome === "accepted") {
        refreshOwned = true;
        sendFollowSourceKey = undefined;
        taskRole = undefined;
        renderedState = { ...renderedState, status: "connecting" };
        root.render(taskScreen(focus, consumeFocus));
      }
    });
    expect(timelineList!.instance).toBe(originalList);
    await act(async () => {
      sendFollowSourceKey = "refreshed-task";
      taskRole = "ordinary";
      renderedState = { ...renderedState, status: "connected", detail: create(SnapshotSchema, { ...state.detail!,
        timeline: [taskUserInput("recent-input", "recent-operation", 10n, "Recent message"), echo,
          taskUserInput("independent-input", "independent-operation", 12n, "A message from another client")] }) };
      root.render(taskScreen(focus, consumeFocus));
    });
    await act(async () => {
      finish(outcome !== "unknown");
    });

    const acceptedSeeks = scrollTimelineToIndex.mock.calls.filter(([args]) => args.viewPosition === 0.2);
    if (outcome === "accepted") {
      expect(returnToLatest).toHaveBeenCalledOnce();
      expect(consumeFocus).toHaveBeenCalledExactlyOnceWith(originalFocus);
      expect(renderedState.window).toBeUndefined();
      expect(timelineList!.data).toContainEqual(expect.objectContaining({ id: echo.eventId, text, operationId: observer.operationId }));
      expect(acceptedSeeks).toEqual([[{ index: 1, animated: false, viewPosition: 0.2 }]]);
    } else {
      expect(returnToLatest).not.toHaveBeenCalled();
      expect(consumeFocus).not.toHaveBeenCalled();
      expect(renderedState.window).toBe(latestWindow);
      expect(timelineList!.data).toEqual([expect.objectContaining({ id: anchor.eventId })]);
      expect(acceptedSeeks).toEqual([]);
    }
  });

function timelineScrollSample(y: number, height: number): TimelineScrollSample {
  return { nativeEvent: { contentOffset: { y }, contentSize: { height }, layoutMeasurement: { height: 400 } } };
}

it("loads earlier history on an upward drag near the top and keeps native prepend anchoring on the ordinary list", async () => {
  vi.useFakeTimers();
  sendFollowSourceKey = "task-source";
  const prompt = taskUserInput("prompt", "prompt-operation", 10n, "Current window");
  const firstPage = taskUserInput("first-page", "first-page-operation", 2n, "Older history");
  renderedState = { ...state, live: [prompt], historyEnd: false };
  let completePage!: () => void;
  loadEarlier.mockImplementationOnce(async () => {
    renderedState = { ...renderedState, historyBusy: true };
    await new Promise<void>(resolve => { completePage = resolve; });
    renderedState = { ...renderedState, historyBusy: false, older: [firstPage],
      before: create(EventCursorSchema, { opaqueToken: "older-cursor", generation: 1n, sequence: 2n }) };
  });
  await mountMeasuredTimelineTail();
  expect(timelineList!.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 1 });
  const nearTop = timelineScrollSample(130, 1_600);
  await act(async () => timelineList!.onScroll!(nearTop));
  expect(loadEarlier).not.toHaveBeenCalled();
  await act(async () => {
    timelineList!.onScrollBeginDrag!(timelineScrollSample(700, 1_600));
    timelineList!.onScroll!(nearTop);
    timelineList!.onScroll!(timelineScrollSample(75, 1_600));
    timelineList!.onScrollEndDrag!(nearTop);
  });
  expect(loadEarlier).toHaveBeenCalledOnce();
  await act(async () => { completePage(); });
  await act(async () => root.render(taskScreen()));
  await act(async () => timelineList!.onContentSizeChange!(400, 1_900));
  expect(timelineList!.data).toContainEqual(expect.objectContaining({ id: "first-page" }));
  expect(scrollTimelineToEnd).not.toHaveBeenCalled();

  await act(async () => {
    timelineList!.onScrollBeginDrag!(timelineScrollSample(0, 1_900));
    timelineList!.onScrollEndDrag!(timelineScrollSample(0, 1_900));
  });
  expect(loadEarlier).toHaveBeenCalledTimes(2);

  renderedState = { ...renderedState, window: [firstPage] };
  await act(async () => root.render(taskScreen()));
  expect(timelineList!.maintainVisibleContentPosition).toBeUndefined();
  await act(async () => timelineList!.onScrollBeginDrag!(timelineScrollSample(0, 1_900)));
  expect(loadEarlier).toHaveBeenCalledTimes(2);
});

it("reads newer history at the end of a linked window without returning to latest", async () => {
  const anchor = taskUserInput("linked", "linked-operation", 4n, "Linked old message");
  const middle = taskUserInput("middle", "middle-operation", 10n, "Middle reply");
  const latest = taskUserInput("latest", "latest-operation", 30n, "Latest message");
  const detail = create(SnapshotSchema, { ...state.detail!, timeline: [latest] });
  renderedState = { ...state, detail, window: [anchor], windowHasNewer: true, historyEnd: false };
  loadNewer.mockImplementationOnce(async () => {
    renderedState = { ...renderedState, window: [anchor, middle], windowHasNewer: true };
  }).mockImplementationOnce(async () => {
    renderedState = { ...renderedState, window: [anchor, middle, latest], windowHasNewer: false };
  });
  const newerButton = () => Array.from(host.querySelectorAll("button"))
    .find(button => button.getAttribute("aria-label") === mobileMessage("en", "task.loadNewer"));
  const focus = { requestId: 1, sessionId: session.sessionId, messageId: anchor.eventId, messageEventId: anchor.eventId };
  vi.useFakeTimers();
  await act(async () => root.render(taskScreen(focus)));
  await act(async () => vi.advanceTimersByTimeAsync(30));
  const list = timelineList!.instance;
  expect(timelineList!.data).toEqual([expect.objectContaining({ id: anchor.eventId, text: "Linked old message" })]);
  expect(scrollTimelineToIndex).toHaveBeenCalledExactlyOnceWith({ index: 0, animated: false, viewPosition: 0.5 });
  expect(newerButton()?.disabled).toBe(false);

  await act(async () => { newerButton()!.click(); newerButton()!.click(); });
  await act(async () => root.render(taskScreen(focus)));
  expect(loadNewer).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
  expect(timelineList!.data).toEqual([
    expect.objectContaining({ id: anchor.eventId, text: "Linked old message" }),
    expect.objectContaining({ id: middle.eventId, text: "Middle reply" })
  ]);
  expect(timelineList!.instance).toBe(list);

  await act(async () => newerButton()!.click());
  await act(async () => root.render(taskScreen(focus)));
  expect(loadNewer).toHaveBeenCalledTimes(2);
  expect(timelineList!.data).toEqual([anchor, middle, latest].map(item => expect.objectContaining({ id: item.eventId })));
  expect(timelineList!.instance).toBe(list);
  expect(newerButton()).toBeUndefined();
  expect(returnToLatest).not.toHaveBeenCalled();
  expect(scrollTimelineToIndex).toHaveBeenCalledOnce();
  expect(scrollTimelineToEnd).not.toHaveBeenCalled();
});

it("copies the adopted Pi entry from the message menu after withholding the temporary link", async () => {
  sendFollowSourceKey = "task-source";
  const identity = { sessionId: session.sessionId, backendId: "pi", targetId: session.targetId, runId: "run", generation: 1n };
  const running = create(SnapshotSchema, { sessions: [create(SessionSchema, { ...session, backendId: "pi", state: SessionState.RUNNING })] });
  const answer = create(EventSchema, {
    eventId: "temporary-completion", identity, cursor: { generation: 1n, sequence: 3n },
    payload: { kind: { case: "messageCompleted", value: { messageId: "temporary-completion", role: MessageRole.ASSISTANT,
      blocks: [{ content: { case: "text", value: "A Pi reply" } }] } } },
    pi: { payload: { case: "messageLifecycle", value: { kind: PiMessageLifecycleKind.MESSAGE_END } } }
  });
  renderedState = { ...state, owner: running, detail: running, live: [answer] };
  const more = () => Array.from(host.querySelectorAll("button")).find(button => button.getAttribute("aria-label")
    === mobileMessage("en", "task.moreFor", { name: "Assistant" }));
  await act(async () => root.render(taskScreen()));
  await act(async () => more()!.click());
  expect(taskMessageActions?.items.map(item => item.id)).toContain("copy-text");
  expect(taskMessageActions?.items.map(item => item.id)).not.toContain("copy-link");
  await act(async () => taskMessageActions!.onAction("copy-link"));
  expect(writeClipboard).not.toHaveBeenCalled();

  const completed = answer.payload!.kind;
  if (completed.case !== "messageCompleted") throw new Error("Expected an assistant completion.");
  const adopted = create(EventSchema, { ...answer, eventId: "adopted-completion",
    cursor: create(EventCursorSchema, { generation: 1n, sequence: 8n }),
    payload: { kind: { case: "messageCompleted", value: { ...completed.value, messageId: "native-entry",
      nativeIdentity: create(NativeMessageIdentitySchema, { entryId: "native-entry" }) } } } });
  const settled = create(SnapshotSchema, { ...running,
    sessions: [create(SessionSchema, { ...running.sessions[0]!, state: SessionState.IDLE })], timeline: [adopted] });
  renderedState = { ...state, owner: settled, detail: settled };
  await act(async () => root.render(taskScreen()));
  await act(async () => more()!.click());
  expect(taskMessageActions?.items.map(item => item.id)).toContain("copy-link");
  await act(async () => taskMessageActions!.onAction("copy-link"));
  expect(writeClipboard).toHaveBeenCalledExactlyOnceWith("joko://task/session?message=native-entry&event=adopted-completion");
});

it.each(["same request", "resolved while reconnecting"] as const)("retains the original question draft across a transient empty task (%s)", async outcome => {
  const generation = 7n;
  const runtimeSession = create(SessionSchema, { ...session, nativeBinding: create(NativeSessionBindingSchema, { runtimeGeneration: generation }) });
  const question = create(InteractionSchema, {
    interactionId: `question-${outcome}`, sessionId: session.sessionId, backendId: session.backendId, targetId: session.targetId,
    kind: InteractionKind.QUESTION, state: InteractionState.PENDING, generation, version: { generation, revision: { value: 3n } },
    request: { case: "question", value: { fields: [{ fieldId: "summary", label: "Summary", required: true,
      input: { case: "text", value: {} } }] } }
  });
  const snapshot = create(SnapshotSchema, { sessions: [runtimeSession], interactions: [question] });
  const identity = mobileInteractionDraftIdentity(state.activeProfileId, question)!;
  const draft = { kind: "question", fieldIndex: 0, answers: { summary: { kind: "text", value: "Keep this unsent answer" } } } as const;
  renderedState = { ...state, owner: snapshot, detail: snapshot };
  await act(async () => root.render(taskScreen()));
  expect(interactionSheet.interactions).toEqual([question]);
  interactionDrafts.save(identity, draft);
  await interactionDrafts.flush(identity);

  for (const status of ["connecting", "offline", "connected"] as const) {
    renderedState = { ...renderedState, status, detail: undefined };
    await act(async () => root.render(taskScreen()));
    expect(interactionSheet.interactions).toEqual([]);
    expect(interactionSheet.visible).toBe(false);
    await expect(new MobileInteractionDraftStore(drafts.driver).read(identity)).resolves.toEqual(draft);
  }

  const returned = outcome === "same request" ? snapshot : create(SnapshotSchema, { ...snapshot,
    interactions: [create(InteractionSchema, { ...question, state: InteractionState.RESOLVED })] });
  renderedState = { ...renderedState, status: "connected", owner: returned, detail: returned };
  await act(async () => root.render(taskScreen()));
  await interactionDrafts.flush(identity);
  expect(interactionSheet.interactions).toEqual(outcome === "same request" ? [question] : []);
  expect(interactionSheet.visible).toBe(outcome === "same request");
  await expect(new MobileInteractionDraftStore(drafts.driver).read(identity)).resolves.toEqual(outcome === "same request" ? draft : null);
  await interactionDrafts.clear(identity);
});

it("renders a single resolved plan review with its decision, feedback and original summary", async () => {
  const identity = { sessionId: session.sessionId, backendId: "claude-code", targetId: session.targetId, generation: 1n,
    runId: "run", attemptId: "attempt" };
  const review = create(InteractionSchema, { ...identity, interactionId: "review", kind: InteractionKind.PLAN_REVIEW, state: InteractionState.RESOLVED,
    request: { case: "planReview", value: { title: "Review the proposed plan", markdown: "1. Prepare\n2. Test\n3. Verify\n4. Publish",
      allowedDecisions: [PlanReviewDecisionKind.EXECUTE, PlanReviewDecisionKind.REFINE] } },
    resolution: { decision: { case: "planReview", value: { decision: PlanReviewDecisionKind.REFINE, feedback: "Cover reconnect before publishing." } } }
  });
  const observed = (eventId: string, sequence: bigint, interaction = review) => create(EventSchema, {
    eventId, identity, cursor: { generation: 1n, sequence }, payload: { kind: { case: "interactionChanged", value: { interaction } } }
  });
  const detail = create(SnapshotSchema, { ...state.detail!, sessions: [create(SessionSchema, { ...session, backendId: identity.backendId })],
    timeline: [observed("request", 2n), observed("resolution", 3n)] });
  renderedState = { ...state, detail };
  await act(async () => root.render(taskScreen()));
  expect(timelineList!.data).toHaveLength(1);
  expect(host.textContent).toContain(mobileMessage("en", "interaction.plan.refine"));
  expect(host.textContent).toContain("Cover reconnect before publishing.");
  expect(host.textContent).toContain("1. Prepare\n2. Test\n3. Verify\n…");
  expect(interactionSheet.visible).toBe(false);

  const foreign = create(InteractionSchema, { ...review, sessionId: "other-session" });
  const otherBackend = create(InteractionSchema, { ...review, backendId: "codex" });
  const otherEvent = create(EventSchema, { ...observed("other-backend", 5n, otherBackend),
    identity: create(EventIdentitySchema, { ...identity, backendId: "codex" }) });
  renderedState = { ...state, detail: create(SnapshotSchema, { ...detail, timeline: [observed("foreign", 4n, foreign), otherEvent] }) };
  await act(async () => root.render(taskScreen()));
  expect(host.textContent).not.toContain("Cover reconnect before publishing.");
});

async function mountMeasuredTimelineTail(): Promise<void> {
  await act(async () => root.render(taskScreen()));
  await act(async () => {
    timelineList!.onContentSizeChange!(400, 1_600);
    timelineList!.onScroll!(timelineScrollSample(1_200, 1_600));
  });
  expect(scrollTimelineToEnd).toHaveBeenCalledWith({ animated: false });
  scrollTimelineToEnd.mockClear();
}

function timelineLatestButton(): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll("button")).find(button => button.getAttribute("aria-label") === mobileMessage("en", "task.returnLatest"));
}

function changeNativeAppStatus(status: NativeAppStatus): void {
  nativeAppState.currentState = status;
  for (const listener of appStateListeners) listener(status);
}

function taskAssistantDelta(eventId: string, sequence: bigint, delta: string) {
  return create(EventSchema, { eventId, identity: { sessionId: "session" }, cursor: { generation: 1n, sequence },
    payload: { kind: { case: "textDelta", value: { messageId: "streaming-reply", delta } } } });
}

function taskAssistantAnswer(eventId: string, sequence: bigint, messageId = eventId) {
  return create(EventSchema, { eventId, identity: { sessionId: "session" }, cursor: { generation: 1n, sequence },
    payload: { kind: { case: "messageCompleted", value: { messageId, role: MessageRole.ASSISTANT,
      blocks: [{ content: { case: "text", value: "A complete answer" } }] } } } });
}

function taskUserInput(eventId: string, operationId: string, sequence: bigint, text: string) {
  return create(EventSchema, { eventId, identity: { sessionId: "session", operationId }, cursor: { generation: 1n, sequence },
    payload: { kind: { case: "messageStarted", value: { messageId: eventId, role: MessageRole.USER, userInputAccepted: true,
      userInput: { parts: [{ content: { case: "text", value: text } }] } } } } });
}

it("mounts owner input handoff above the actual composer and removes it when its task connection retires", async () => {
  activeInputHandoffApi = { ownerKey: "current-native-owner", sessionId: "session", deviceId: "phone", isCurrent: () => current,
    list: async () => [], decide: async () => true, submit: async () => true, picture: async () => ({ mime: "image/jpeg", width: 1, height: 1, data: "/9j/" }) };
  await render(false);
  const panel = host.querySelector('[data-input-handoff-owner="current-native-owner"]'), composer = host.querySelector('[data-input="composer"]');
  expect(panel).not.toBeNull(); expect(composer).not.toBeNull(); expect(panel!.compareDocumentPosition(composer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  renderedState = { ...state, status: "offline" }; await render(false); expect(host.querySelector("[data-input-handoff-owner]")).toBeNull();
  expect(send).not.toHaveBeenCalled();
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

it("renders separate independent task outcomes from the original Partner's older timeline page", async () => {
  activePartner = { ...peer, partnerId: "ada", displayName: "Ada", canonicalSessionId: "session" };
  renderedState = { ...state, older: ["First retained result", "Second retained result"].map((result, index) => create(EventSchema, {
    eventId: `receipt-${index}`, identity: { sessionId: "session", generation: 1n }, cursor: { sequence: BigInt(index + 1) },
    payload: { kind: { case: "partnerSessionTaskReceipt", value: { taskId: "independent", title: "Independent inspection",
      execution: index + 1, status: PartnerSessionTaskStatus.COMPLETED, taskSessionId: "child", result } } }
  })) };
  await render(false);
  expect(host.textContent?.match(/Independent inspection/gu)).toHaveLength(2);
  expect(host.textContent).toContain("First retained result");
  expect(host.textContent).toContain("Second retained result");
  expect(host.textContent).toContain("Completed · #1");
  expect(host.textContent).toContain("Completed · #2");
  expect(host.querySelector('[aria-label="Open task"]')).toBeNull();
});

it("closes the native App view when a retained timeline card scrolls out and discards its late link grant", async () => {
  renderedState = { ...state, live: [create(EventSchema, { eventId: "mcp-app", identity: { sessionId: "session" }, cursor: { sequence: 1n },
    payload: { kind: { case: "mcpAppChanged", value: { card: { sessionId: "session", cardId: "app-card", title: "Retained App" } } } } })] };
  type Response = Awaited<ReturnType<MobileMcpAppApi["native"]>>;
  let returnLinks!: (result: Response) => void;
  let approveLateLink!: (result: Response) => void;
  let finishTeardown!: () => void;
  const links = new Promise<Response>(resolve => { returnLinks = resolve; });
  const lateGrant = new Promise<Response>(resolve => { approveLateLink = resolve; });
  const teardown = new Promise<void>(resolve => { finishTeardown = resolve; });
  const pendingPoll = new Promise<Response>(() => {});
  let nextPoll = links;
  const grant = create(McpAppNativeServiceOperateResponseSchema, { linkValidForMs: 15_000 });
  const native = vi.fn<MobileMcpAppApi["native"]>(async request => {
    if (request.operation === McpAppNativeOperation.OPEN) {
      return create(McpAppNativeServiceOperateResponseSchema, { document: { viewId: `view-${request.view?.openId}` } });
    }
    if (request.operation === McpAppNativeOperation.POLL) {
      const result = nextPoll;
      nextPoll = pendingPoll;
      return result;
    }
    if (request.operation === McpAppNativeOperation.AUTHORIZE_LINK) return request.linkId === "late" ? lateGrant : grant;
    return create(McpAppNativeServiceOperateResponseSchema);
  });
  const metadata = vi.fn<MobileMcpAppApi["metadata"]>(async request => {
    if (request.operation === McpAppOperation.TEARDOWN) await teardown;
    return create(McpAppServiceOperateResponseSchema);
  });
  openSystemLink.mockClear();
  await act(async () => root.render(createElement(MobileMcpAppViewsProvider, { ownerKey: "profile", bind: () => ({ ownerKey: "profile", native, metadata }), children: taskScreen() })));
  expect(host.textContent).toContain("Retained App");
  expect(native).not.toHaveBeenCalled();
  const item = timelineList!.data[0];
  const markVisible = (visible: boolean) => act(async () => timelineList!.onViewableItemsChanged({ viewableItems: visible ? [{ item, isViewable: true }] : [] }));
  await markVisible(true);
  const firstSlot = host.querySelector("[data-app-slot]")?.getAttribute("data-app-slot");
  expect(firstSlot).toBeTruthy();
  const url = "https://example.test/approved";
  await act(async () => {
    receiveAppMessage!({ nativeEvent: { data: JSON.stringify({ key: appBridgeKey, message: { jsonrpc: "2.0", method: "ui/notifications/initialized" } }) } });
    returnLinks(create(McpAppNativeServiceOperateResponseSchema, { eventsJson: JSON.stringify([
      { seq: 1, openLink: { id: "visible", url } }, { seq: 2, openLink: { id: "late", url } }
    ]) }));
  });
  expect(openSystemLink).toHaveBeenCalledExactlyOnceWith(url);
  expect(native).toHaveBeenCalledWith(expect.objectContaining({ operation: McpAppNativeOperation.AUTHORIZE_LINK, linkId: "late", url }));
  await markVisible(false);
  expect(host.textContent).toContain("Retained App");
  expect(host.querySelector("[data-app-slot]")).toBeNull();
  expect(host.querySelector("[data-app-host]")).not.toBeNull();
  expect(metadata).toHaveBeenCalledWith(expect.objectContaining({ operation: McpAppOperation.TEARDOWN }));
  await act(async () => approveLateLink(grant));
  expect(openSystemLink).toHaveBeenCalledOnce();
  expect(native).toHaveBeenCalledWith(expect.objectContaining({ operation: McpAppNativeOperation.LINK_RESULT, linkId: "late", success: false }));
  await act(async () => finishTeardown());
  await markVisible(true);
  const nextSlot = host.querySelector("[data-app-slot]")?.getAttribute("data-app-slot");
  expect(nextSlot).toBeTruthy();
  expect(nextSlot).not.toBe(firstSlot);
});
