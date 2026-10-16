// @vitest-environment jsdom
import { act, createElement, forwardRef, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { SessionSchema, SessionState, SnapshotSchema, EventSchema, MessageRole, PartnerLearningKind, PartnerLearningAction,
  SessionTitleSuggestionStatus, SuggestSessionTitleResponseSchema } from "@joko/contracts";
import { profilePartner } from "./test/mobile-partner-profile";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileState } from "./mobile-client";
import type { MobileHomeViewState } from "./mobile-task-home-navigation";
import { mobileMessage } from "./mobile-messages";
import { MobileComposerDraftStore } from "./composer-draft-store";
import { plainTextMobileComposerDraft } from "./mobile-composer-document";
import type { MobileComposerRichInput } from "./MobileComposerRichInput";
import type { MobileDrawerProps } from "./MobileDrawer";
import type { MobileTaskHeader } from "./MobileTaskHeader";
import type { MobileWindowGeometry } from "./mobile-window-geometry";

type NativeProps = {
  children?: ReactNode;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  testID?: string;
  style?: unknown;
  pointerEvents?: string;
  accessibilityElementsHidden?: boolean;
  consumedBottomInset?: number;
};
const surface = ({ children, accessibilityLabel, testID, style, pointerEvents, accessibilityElementsHidden, consumedBottomInset }: NativeProps) => createElement("div", {
  "aria-label": accessibilityLabel, "data-testid": testID, "data-native-style": JSON.stringify(style),
  "data-pointer-events": pointerEvents, "aria-hidden": accessibilityElementsHidden, "data-consumed-bottom-inset": consumedBottomInset
}, children);
const empty = Object.freeze([]);
const homeConnectionId = "home-connection";
const select = vi.fn(async (_sessionId?: string) => {});
const searchHome = vi.fn(async () => {});
const setSessionPinned = vi.fn(async () => true);
const setSessionArchived = vi.fn(async () => true);
const renameSession = vi.fn(async () => true);
const deleteSession = vi.fn(async () => true);
const suggestTaskTitle = vi.fn(async (_key: string, _signal: AbortSignal) => create(SuggestSessionTitleResponseSchema, {
  title: "Suggested title", status: SessionTitleSuggestionStatus.OK
}));
const alert = vi.fn();
const reconcile = vi.fn(async () => {});
const refresh = vi.fn(async () => {});
const writeClipboard = vi.fn(async () => true);
const draftValues = new Map<string, string>();
const drafts = new MobileComposerDraftStore({ getItem: async key => draftValues.get(key) ?? null,
  setItem: async (key, value) => { draftValues.set(key, value); }, removeItem: async key => { draftValues.delete(key); } });
const originalDraftFlush = drafts.flush.bind(drafts);
const draftFlush = vi.spyOn(drafts, "flush");
const newTaskFlush = vi.fn(async () => {});
const onBack = vi.fn(), onSearchFocus = vi.fn(), onNavigated = vi.fn();
let dimensions = { width: 390, height: 844, scale: 1, fontScale: 1 };
let platformOS = "android";
let taskWindowGeometry: MobileWindowGeometry | undefined;
let observedHeaderRole: "ordinary" | "worker" = "ordinary";
let headerSourceEpoch = 0;
let shareSelectionActive = false;
let composerProps: ComponentProps<typeof MobileComposerRichInput>;
let headerProps: ComponentProps<typeof MobileTaskHeader>;
let drawerProps: MobileDrawerProps;
let finishDrawerClose: (() => void) | undefined;
let taskNavigationPort: import("./App").TaskHomeNavigationPort | undefined;
let TaskScreen: typeof import("./App").TaskScreen;
type TaskProps = ComponentProps<typeof import("./App").TaskScreen>;
let taskProps: TaskProps;

function DrawerFixture(props: MobileDrawerProps): ReactNode {
  drawerProps = props;
  const [mounted, setMounted] = useState(false);
  const wasMounted = useRef(false);
  const latest = useRef(props); latest.current = props;
  finishDrawerClose = () => setMounted(false);
  useEffect(() => {
    if (props.visible && !mounted) { setMounted(true); latest.current.onMountedChange?.(true); }
  }, [props.visible, mounted]);
  useEffect(() => {
    const previous = wasMounted.current; wasMounted.current = mounted;
    if (previous && !mounted) { latest.current.onMountedChange?.(false); latest.current.onClosed?.(); }
  }, [mounted]);
  return mounted ? createElement("div", { "data-testid": "drawer-fixture" }, props.children) : null;
}
let state: MobileState;
let learningPartner: typeof profilePartner | undefined;
let collaborationApi: import("./mobile-collaboration").MobileCollaborationApi | undefined;
let learningProfileProps: ComponentProps<typeof import("./MobilePartnerProfileSheet").MobilePartnerProfileSheet> | undefined;
const client = new Proxy({
  get state() { return state; }, select, searchHome, setSessionPinned, setSessionArchived, renameSession, deleteSession, suggestTaskTitle, reconcile, refresh,
  taskQueueItems: () => empty, taskInteractions: () => empty, taskTimelineRows: () => empty,
  subscribe: () => () => {}, taskForeground: () => true, taskQueueCapabilities: () => ({}), taskPendingImagePasteCount: () => 0,
  partnerConversationTransport: () => learningPartner ? { ownerKey: "original-partner-owner" } : undefined,
  partnerProfileTransport: () => learningPartner ? { ownerKey: "original-partner-owner" } : undefined,
  taskDraftProfileId: () => state.activeProfileId,
  taskHeaderSourceKey: () => state.selectedId ? `${state.activeProfileId}/${state.selectedId}/${headerSourceEpoch}` : undefined,
  readTaskHeaderRole: async () => observedHeaderRole,
  taskCollaborationApi: () => collaborationApi
}, { get: (object, key) => key in object ? object[key as keyof typeof object] : () => undefined });
let SessionsScreen: typeof import("./App").SessionsScreen;
type ScreenProps = ComponentProps<typeof import("./App").SessionsScreen>;
let host: HTMLDivElement;
let root: Root;
let viewState: MobileHomeViewState;
let props: ScreenProps;
const colors = { background: "#fff", surface: "#fff", ink: "#111", muted: "#666", border: "#ccc",
  accent: "#f80", negative: "#c00", brandBackground: "#ffe", dark: false };
const onNew = vi.fn(), onSelect = vi.fn(), onMenu = vi.fn(), onOpenShare = vi.fn(), runNavigation = vi.fn();
const message = (key: Parameters<typeof mobileMessage>[1]) => mobileMessage("en", key);

beforeAll(async () => {
  vi.stubGlobal("__DEV__", false);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.doMock("react-native", () => ({
    View: surface, Text: surface, ScrollView: surface, Image: surface, ActivityIndicator: surface,
    SectionList: ({ sections, renderItem, renderSectionHeader, ListEmptyComponent }: {
      sections: readonly { key: string; data: readonly unknown[] }[];
      renderItem: (value: { item: unknown; index: number }) => ReactNode;
      renderSectionHeader: (value: { section: unknown }) => ReactNode;
      ListEmptyComponent?: ReactNode;
    }) => createElement("div", { "data-testid": "home-list" }, sections.length === 0 ? ListEmptyComponent
      : sections.map(section => createElement("section", { key: section.key }, renderSectionHeader({ section }),
        section.data.map((item, index) => createElement("div", { key: index }, renderItem({ item, index })))))),
    FlatList: ({ data, renderItem, ListEmptyComponent }: { data?: readonly { id: string }[];
      renderItem?: (value: { item: unknown }) => ReactNode; ListEmptyComponent?: ReactNode }) => createElement("div", {},
      data?.length && renderItem ? data.map(item => createElement("div", { key: item.id }, renderItem({ item }))) : ListEmptyComponent),
    TextInput: forwardRef<HTMLInputElement, { value?: string; accessibilityLabel?: string; placeholder?: string;
      onChangeText?: (value: string) => void }>((input, ref) => createElement("input", { ref, value: input.value ?? "",
      "aria-label": input.accessibilityLabel, placeholder: input.placeholder, readOnly: !input.onChangeText,
      onInput: event => input.onChangeText?.(event.currentTarget.value), onChange() {} })),
    Modal: ({ visible, children }: { visible?: boolean; children?: ReactNode }) => visible
      ? createElement("div", { "data-testid": "native-modal" }, children) : null,
    Pressable: ({ children, onPress, disabled, accessibilityLabel, accessibilityState, accessibilityRole }: {
      children?: ReactNode | ((value: { pressed: boolean }) => ReactNode); onPress?: () => void; disabled?: boolean;
      accessibilityLabel?: string; accessibilityState?: { selected?: boolean; disabled?: boolean }; accessibilityRole?: string;
    }) => createElement("button", { onClick: onPress, disabled, "aria-label": accessibilityLabel,
      role: accessibilityRole === "tab" ? "tab" : undefined, "aria-selected": accessibilityState?.selected },
      typeof children === "function" ? children({ pressed: false }) : children),
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
    Platform: { get OS() { return platformOS; }, select: (value: Record<string, unknown>) => value[platformOS] ?? value.default },
    AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
    BackHandler: { addEventListener: () => ({ remove() {} }) }, Keyboard: { dismiss() {}, addListener: () => ({ remove() {} }) },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    AccessibilityInfo: { announceForAccessibility() {}, setAccessibilityFocus() {}, addEventListener: () => ({ remove() {} }) },
    Linking: {}, Alert: { alert }, findNodeHandle: () => null, useColorScheme: () => "light",
    useWindowDimensions: () => dimensions
  }));
  vi.doMock("react-native-safe-area-context", () => ({ SafeAreaProvider: surface, SafeAreaView: surface,
    useSafeAreaInsets: () => ({ top: 0, left: 0, bottom: 0, right: 0 }) }));
  vi.doMock("./MobileAdaptiveWindow", () => ({ MobileAdaptiveWindowProvider: surface,
    useMobileAdaptiveWindow: () => taskWindowGeometry ?? { ...dimensions, insets: { top: 0, left: 0, bottom: 0, right: 0 },
      regularWidth: dimensions.width >= 600, regularHeight: dimensions.height >= 600,
      barEdge: "none", regions: [], reservedRegionsSupported: false } }));
  vi.doMock("react-native-svg", () => ({
    default: ({ children }: NativeProps) => createElement("svg", null, children),
    Path: ({ d }: { d: string }) => createElement("path", { d }),
    Rect: () => createElement("rect"), Circle: () => createElement("circle"),
    SvgXml: () => null
  }));
  vi.doMock("expo-status-bar", () => ({ StatusBar: () => null }));
  vi.doMock("expo-constants", () => ({ default: {} }));
  vi.doMock("expo-crypto", () => ({ randomUUID: () => "ui-occurrence" }));
  vi.doMock("expo-clipboard", () => ({ setStringAsync: writeClipboard }));
  for (const name of ["expo-image-picker", "expo-image-manipulator", "expo-image", "expo-sharing", "expo-file-system",
    "expo-media-library", "expo-audio", "expo-network", "expo-secure-store", "expo-notifications", "expo-application"])
    vi.doMock(name, () => new Proxy({}, { get: (_object, key) => key === "then" ? undefined : () => undefined }));
  vi.doMock("expo-modules-core", () => ({ requireNativeModule: () => ({}), requireOptionalNativeModule: () => ({}),
    NativeModule: class {}, EventEmitter: class {} }));
  vi.doMock("expo", () => ({ requireOptionalNativeModule: () => null }));
  vi.doMock("./mobile-client", () => ({ MobileClient: class { constructor() { return client; } } }));
  vi.doMock("./storage", () => new Proxy({ mobileLocalePreferences: { snapshot: { effectiveLocale: "en" } },
    mobileComposerDrafts: drafts, mobileNewTaskDrafts: { flush: newTaskFlush } }, {
    get: (object, key) => key in object ? object[key as keyof typeof object] : {}, has: () => true,
    getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, value: {} })
  }));
  for (const name of ["network", "native-lan-discovery", "native-notifications", "mobile-media-preview", "mobile-pdf-preview",
    "mobile-model-preview", "mobile-file-share", "mobile-files-thumbnail-cache", "mobile-incoming-share"])
    vi.doMock(`./${name}`, () => new Proxy({}, { get: () => ({}), has: () => true,
      getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, value: {} }) }));
  vi.doMock("./mobile-push-controller", () => ({ MobilePushController: class {} }));
  vi.doMock("./mobile-voice-dictionary-readonly-controller", () => ({ MobileVoiceDictionaryReadOnlyController: class {} }));
  for (const name of ["MobileSharedConnectionScreen", "MobileFileTextPreview", "MobileFilesPreviewPager", "MobileTimelineImage",
    "MobileNativeIntentNotice", "MobilePhotoLibrarySheet", "MobileThinkingCard", "MobileWorkGroupCard", "MobilePlanCard",
    "MobileAudioMetadataCard", "MobileToolCallCard", "MobileDelegatedTaskCard", "MobileActionSheet",
    "MobileTaskDerivationSheet", "MobileMessageRewindSheet", "MobileSessionDerivationMarker",
    "MobileComposerAtomSheet", "MobileCommandHelpSheet", "MobileQuoteSelectionSheet", "MobileInteractionSheet",
    "MobileRuntimeControlsSheet", "MobileContextSheet", "MobileNativeTreeSheet", "MobileSessionMentionSheet",
    "MobileWorkspaceMentionSheet", "MobileCatalogMentionSheet", "MobileMarkdownMessage", "MobileConversationShareBar",
    "MobileConversationShareRenderer", "MobileImageLightbox", "MobileMediaPlayer", "MobilePdfViewer", "MobileModelViewer",
    "MobileOfflineNotice", "MobileAutomationsScreen", "MobilePartnersScreen", "MobilePartnerDirectoryScreen",
    "MobilePartnerWorkingStatus", "MobileConversationSearchSheet", "MobilePartnerResourcesScreen",
    "MobileExtensionsScreen", "MobileFilesToolbar", "MobileFilesBrowser", "MobileSettingsScreen", "MobileRemoteDesktopScreen",
    "MobileUpdateSurface", "MobileRuntimeCommandPalette"])
    vi.doMock(`./${name}`, () => new Proxy({}, { get: (_object, key) => key === "then" ? undefined : () => null,
      has: () => true, getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, value: () => null }) }));
  vi.doMock("./SwipeableSessionRow", () => ({ SwipeableSessionRow: surface }));
  vi.doMock("./MobilePartnerProfileSheet", () => ({ MobilePartnerProfileSheet: (props: NonNullable<typeof learningProfileProps>) => {
    learningProfileProps = props;
    return props.visible ? createElement("output", { "data-testid": "learning-settings" }, props.initialLearningDestination ?? "profile") : null;
  } }));
  vi.doMock("./MobileTaskTags", () => ({ MobileTaskTagDots: () => null, MobileTaskTagsSheet: () => null, mobileTaskTagName: () => "" }));
  vi.doMock("./MobilePartnerAvatar", () => ({ MobilePartnerAvatar: () => null, MobilePartnerAvatarProvider: surface }));
  vi.doMock("./MobilePartnerConversationRow", () => ({ MobilePartnerConversationRow: surface }));
  vi.doMock("./MobileKeyboardAvoidingView", () => ({ MobileKeyboardAvoidingView: surface,
    useMobileKeyboardState: () => ({ shown: false, height: 0 }) }));
  vi.doMock("./MobileTaskHeader", () => ({ MobileTaskHeader: (props: ComponentProps<typeof MobileTaskHeader>) => {
    headerProps = props;
    return createElement("div", { "data-testid": "task-header" }, createElement("button", { onClick: props.onNavigate }, "Task back"),
      props.quickSwitch ? createElement("button", { onClick: props.quickSwitch.onOpen }, "Quick switch") : null);
  } }));
  vi.doMock("./MobileDrawer", () => ({ MobileDrawer: DrawerFixture, useReducedMotion: () => true }));
  vi.doMock("./MobileComposerRichInput", () => ({ MobileComposerRichInput: forwardRef((props: ComponentProps<typeof MobileComposerRichInput>, ref) => {
    composerProps = props;
    if (ref && typeof ref !== "function") ref.current = { focus() {}, blur() {} } as never;
    return createElement("div", { "data-testid": "task-composer" }, props.draft.text);
  }), MobileComposerAtomChips: () => null, MobileAttachmentTray: () => null }));
  vi.doMock("./use-mobile-voice-input", () => ({ useMobileVoiceInput: () => ({ busy: false, recording: false, preparing: false }) }));
  vi.doMock("./use-mobile-partner-read", () => ({ useMobilePartnerIdentity: () => ({ ready: true, retrySequence: 0, partner: learningPartner }),
    useMobilePartnerRead: () => ({ ready: true, partner: learningPartner, retry() {} }) }));
  vi.doMock("./use-mobile-audio-artwork", () => ({ useMobileAudioArtwork: () => new Map() }));
  vi.doMock("./mobile-delegated-reader", () => ({ useMobileDelegatedTasks: () => ({ entries: empty, loading: false }) }));
  vi.doMock("./use-mobile-hidden-history", () => ({ useMobileHiddenHistory: () => false }));
  vi.doMock("./use-mobile-conversation-share", () => ({ useMobileConversationShare: () => ({ active: shareSelectionActive, busy: false, allSelected: false, toggleAll() {},
    selectedIds: [], enterVisible() {} }) }));
  vi.doMock("./use-mobile-screenshot-selection", () => ({ useMobileScreenshotSelection() {} }));
  ({ SessionsScreen, TaskScreen } = await import("./App"));
});

beforeEach(async () => {
  collaborationApi = undefined;
  learningPartner = undefined; learningProfileProps = undefined;
  taskWindowGeometry = undefined;
  platformOS = "android";
  observedHeaderRole = "ordinary"; shareSelectionActive = false;
  headerSourceEpoch = 0;
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 1));
  for (const spy of [select, searchHome, setSessionPinned, setSessionArchived, renameSession, deleteSession, suggestTaskTitle, alert, reconcile, refresh,
    writeClipboard, onNew, onSelect, onMenu, onOpenShare, runNavigation, onBack, onSearchFocus, onNavigated, newTaskFlush]) spy.mockClear();
  dimensions = { width: 390, height: 844, scale: 1, fontScale: 1 }; taskNavigationPort = undefined; finishDrawerClose = undefined;
  draftFlush.mockReset().mockImplementation(originalDraftFlush);
  drafts.save({ profileId: "profile", sessionId: "current" }, plainTextMobileComposerDraft("Retained composer"));
  await drafts.flush({ profileId: "profile", sessionId: "current" }); draftFlush.mockClear();
  select.mockImplementation(async sessionId => { state = { ...state, selectedId: sessionId }; });
  const sessions = [
    create(SessionSchema, { sessionId: "current", targetId: "dialogue", backendId: "backend", displayName: "Alpha", pinned: true, state: SessionState.IDLE }),
    create(SessionSchema, { sessionId: "other", targetId: "project", backendId: "backend", displayName: "Beta", state: SessionState.IDLE }),
    create(SessionSchema, { sessionId: "archived", targetId: "project", backendId: "backend", displayName: "Past", archived: true, state: SessionState.IDLE })
  ];
  const owner = create(SnapshotSchema, { snapshotId: "owner", generation: 1n, revision: { value: 1n }, sessions,
    connections: [{ connectionId: homeConnectionId }],
    targets: [{ targetId: "dialogue", backendId: "backend", displayName: "Dialogue" },
      { targetId: "project", backendId: "backend", displayName: "Project" }] });
  state = { status: "connected", activeProfileId: "profile", selectedId: "current", owner, detail: owner, saved: [], pending: [],
    older: [], live: [], busy: false, historyBusy: false, historyEnd: true, readReceipts: {},
    homeSearchQuery: "", homeSearchFilter: "active", homeSearchSessionIds: [], homeSearchStatus: "idle" } as unknown as MobileState;
  viewState = { search: "", statusFilter: "active" };
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  props = { colors, state, locale: "en", onNew, onSelect, onMenu, onOpenShare, currentSessionId: "current",
    incomingShare: { supported: true, busy: false }, menuButtonRef: { current: null }, searchFocusRequest: 0,
    viewState, onViewStateChange: next => { viewState = next; props = { ...props, viewState }; root.render(createElement(SessionsScreen, props)); },
    runNavigation, host: "drawer", foreground: true };
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.useRealTimers();
});
async function render(patch: Partial<ScreenProps> = {}): Promise<void> {
  props = { ...props, ...patch }; state = props.state;
  await act(async () => root.render(createElement(SessionsScreen, props)));
}
function button(label: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
    .find(item => item.getAttribute("aria-label") === label || item.textContent === label);
  expect(found, `visible action: ${label}`).toBeDefined(); return found!;
}
async function press(label: string): Promise<void> { await act(async () => button(label).click()); }
async function type(label: string, value: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`) ?? Array.from(host.querySelectorAll<HTMLInputElement>("input"))
    .find(item => item.placeholder === label);
  expect(input).toBeDefined();
  await act(async () => { input!.value = value; input!.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function option(label: string): Promise<void> {
  await press(mobileMessage("en", "home.optionsFor", { name: "Alpha" }));
  await press(label); await act(async () => vi.advanceTimersByTimeAsync(2));
}

async function renderTask(patch: Partial<TaskProps> = {}): Promise<void> {
  taskProps = { colors, state, locale: "en", onBack, onHome: onMenu, onNew, onFiles() {}, onOpenPartnerThread() {},
    onRemoteDesktop() {}, focusComposer: false, onComposerFocused() {}, onOpenDerivationOrigin: async () => false,
    homeNavigation: { viewState, onViewStateChange: next => { viewState = next; void renderTask(); },
      incomingShare: { supported: false, busy: false }, menuButtonRef: { current: null }, searchFocusRequest: 0,
      onSearchFocus, onMenu, onOpenShare, onNavigated,
      registerNavigation: port => { taskNavigationPort = port; return () => { if (taskNavigationPort === port) taskNavigationPort = undefined; }; } },
    ...patch };
  await act(async () => root.render(createElement(TaskScreen, taskProps)));
}
async function closeTaskDrawer(): Promise<void> { await act(async () => finishDrawerClose?.()); }

describe("actual Home navigation hosts", () => {
  it("offers current-task rename, pin and archive/restore with the exact task and read-only exclusions", async () => {
    await renderTask();
    expect(headerProps.actions.filter(action => ["rename", "pin", "archive", "delete"].includes(action.id)).map(action => action.id))
      .toEqual(["rename", "pin", "archive", "delete"]);
    await act(async () => headerProps.actions.find(action => action.id === "pin")!.onPress());
    await act(async () => headerProps.actions.find(action => action.id === "archive")!.onPress());
    expect(setSessionPinned).toHaveBeenCalledExactlyOnceWith("current", false);
    expect(setSessionArchived).toHaveBeenCalledExactlyOnceWith("current", true);
    state = { ...state, detail: create(SnapshotSchema, { ...state.detail!, sessions: state.detail!.sessions.map(session =>
      create(SessionSchema, { ...session, archived: session.sessionId === "current" })) }) };
    await renderTask();
    expect(headerProps.actions.find(action => action.id === "archive")?.label).toBe(message("common.restore"));
    await act(async () => headerProps.actions.find(action => action.id === "archive")!.onPress());
    expect(setSessionArchived).toHaveBeenLastCalledWith("current", false);
    state = { ...state, status: "offline" }; await renderTask();
    for (const action of headerProps.actions.filter(action => ["rename", "pin", "archive", "delete"].includes(action.id))) expect(action.disabled).toBe(true);
    state = { ...state, status: "connected", taskSource: { kind: "joined" } as MobileState["taskSource"] }; await renderTask();
    expect(headerProps.actions.some(action => ["rename", "pin", "archive", "delete"].includes(action.id))).toBe(false);
    state = { ...state, taskSource: undefined }; observedHeaderRole = "worker"; headerSourceEpoch++; await renderTask();
    expect(headerProps.actions.some(action => ["rename", "pin", "archive", "delete"].includes(action.id))).toBe(false);
  });

  it("keeps AI titles as drafts, restores cancel and retires late suggestions after manual typing or task change", async () => {
    await renderTask();
    const openRename = async () => act(async () => headerProps.actions.find(action => action.id === "rename")!.onPress());
    await openRename();
    expect(host.querySelector<HTMLInputElement>(`input[aria-label="${message("home.taskName")}"]`)?.value).toBe("Alpha");
    await press(message("task.renameSuggest"));
    expect(renameSession).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>(`input[aria-label="${message("home.taskName")}"]`)?.value).toBe("Suggested title");
    await press(message("common.cancel")); await openRename();
    expect(host.querySelector<HTMLInputElement>(`input[aria-label="${message("home.taskName")}"]`)?.value).toBe("Alpha");
    let resolve!: (value: ReturnType<typeof create<typeof SuggestSessionTitleResponseSchema>>) => void;
    suggestTaskTitle.mockImplementationOnce(() => new Promise(accept => { resolve = accept; }));
    await press(message("task.renameSuggest")); const firstSignal = suggestTaskTitle.mock.calls.at(-1)![1];
    await type(message("home.taskName"), "Manual title");
    expect(firstSignal.aborted).toBe(true);
    await act(async () => resolve(create(SuggestSessionTitleResponseSchema, { title: "Stale AI", status: SessionTitleSuggestionStatus.OK })));
    expect(host.querySelector<HTMLInputElement>(`input[aria-label="${message("home.taskName")}"]`)?.value).toBe("Manual title");
    await press(message("common.rename"));
    expect(renameSession).toHaveBeenCalledExactlyOnceWith("current", "Manual title");
    await openRename();
    suggestTaskTitle.mockImplementationOnce(() => new Promise(accept => { resolve = accept; }));
    await press(message("task.renameSuggest")); const retired = suggestTaskTitle.mock.calls.at(-1)![1];
    state = { ...state, selectedId: "other" }; await renderTask();
    expect(retired.aborted).toBe(true);
    await act(async () => resolve(create(SuggestSessionTitleResponseSchema, { title: "Retired title", status: SessionTitleSuggestionStatus.OK })));
    expect(host.querySelector<HTMLInputElement>(`input[aria-label="${message("home.taskName")}"]`)).toBeNull();
    expect(renameSession).toHaveBeenCalledTimes(1);
    await openRename(); await press(message("common.rename"));
    expect(renameSession).toHaveBeenCalledTimes(1);
  });

  it("requires exact delete confirmation, preserves cancel, and rejects an old connection's or older occurrence's alert", async () => {
    await renderTask();
    const chooseDelete = async () => act(async () => headerProps.actions.find(action => action.id === "delete")!.onPress());
    await chooseDelete();
    const first = alert.mock.calls.at(-1)![2] as { style?: string; onPress?: () => void }[];
    expect(deleteSession).not.toHaveBeenCalled();
    await act(async () => first.find(action => action.style === "cancel")!.onPress!());
    await act(async () => first.find(action => action.style === "destructive")!.onPress!());
    expect(deleteSession).not.toHaveBeenCalled();
    await chooseDelete(); const retired = alert.mock.calls.at(-1)![2] as typeof first;
    state = { ...state, activeProfileId: "replacement-profile" }; await renderTask();
    await act(async () => retired.find(action => action.style === "destructive")!.onPress!());
    expect(deleteSession).not.toHaveBeenCalled();
    await chooseDelete(); const oldOccurrence = alert.mock.calls.at(-1)![2] as typeof first;
    await chooseDelete(); const current = alert.mock.calls.at(-1)![2] as typeof first;
    await act(async () => oldOccurrence.find(action => action.style === "destructive")!.onPress!());
    expect(deleteSession).not.toHaveBeenCalled();
    await act(async () => current.find(action => action.style === "destructive")!.onPress!());
    expect(deleteSession).toHaveBeenCalledExactlyOnceWith("current");
  });

  it.each([SessionTitleSuggestionStatus.NO_MATERIAL, SessionTitleSuggestionStatus.PROVIDER_UNAVAILABLE,
    SessionTitleSuggestionStatus.GENERATION_FAILED])("retains a manual title after suggestion status %s and retries only on a new press", async status => {
    await renderTask();
    await act(async () => headerProps.actions.find(action => action.id === "rename")!.onPress());
    await type(message("home.taskName"), "Keep this draft");
    suggestTaskTitle.mockResolvedValueOnce(create(SuggestSessionTitleResponseSchema, { status }));
    await press(message("task.renameSuggest"));
    expect(host.querySelector<HTMLInputElement>(`input[aria-label="${message("home.taskName")}"]`)?.value).toBe("Keep this draft");
    expect(host.textContent).toContain(message(status === SessionTitleSuggestionStatus.NO_MATERIAL ? "task.renameNoMaterial"
      : status === SessionTitleSuggestionStatus.PROVIDER_UNAVAILABLE ? "task.renameProviderUnavailable" : "task.renameFailed"));
    expect(renameSession).not.toHaveBeenCalled(); expect(suggestTaskTitle).toHaveBeenCalledOnce();
    await press(message("task.renameSuggest"));
    expect(suggestTaskTitle).toHaveBeenCalledTimes(2); expect(renameSession).not.toHaveBeenCalled();
    await press(message("common.rename"));
    expect(renameSession).toHaveBeenCalledExactlyOnceWith("current", "Suggested title");
  });
  it.each(["memory", "skills"] as const)("opens original %s settings through an actual assistant learning footer without navigating the task", async destination => {
    learningPartner = { ...profilePartner, canonicalSessionId: "current", homeTargetId: "dialogue" };
    const completion = create(EventSchema, { eventId: "original-completion", identity: { sessionId: "current", runId: "run", backendId: "backend" },
      cursor: { generation: 1n, sequence: 5n }, occurredAt: { seconds: 1n, nanos: 0 },
      payload: { kind: { case: "messageCompleted", value: { messageId: "original-reply", role: MessageRole.ASSISTANT,
        blocks: [{ content: { case: "text", value: "Useful original reply." } }], learning: { revision: { value: 2n }, receipts: [{
          kind: destination === "memory" ? PartnerLearningKind.MEMORY : PartnerLearningKind.SKILL,
          entryId: "saved", title: "Release", action: PartnerLearningAction.CREATED }] } } } } });
    const originalDetail = state.detail;
    if (!originalDetail) throw new Error("Task fixture requires its original detail Snapshot.");
    state = { ...state, detail: create(SnapshotSchema, { ...originalDetail, timeline: [completion] }) };
    await renderTask();
    expect(host.querySelector('[data-testid="message.learningFooter"]')).not.toBeNull();
    await press(destination === "memory" ? "Memory saved: Release" : "Skill created: Release");
    expect(host.querySelector('[data-testid="learning-settings"]')?.textContent).toBe(destination);
    expect(learningProfileProps?.transport?.ownerKey).toBe("original-partner-owner");
    expect(learningProfileProps?.partner?.partnerId).toBe(profilePartner.partnerId);
    expect(select).not.toHaveBeenCalled();
    expect(state.selectedId).toBe("current");
  });
  it("keeps saved nontext assistant feedback out of the learning footer without discarding its receipt", async () => {
    learningPartner = { ...profilePartner, canonicalSessionId: "current", homeTargetId: "dialogue" };
    const completion = create(EventSchema, { eventId: "nontext-completion", identity: { sessionId: "current", runId: "run", backendId: "backend" },
      cursor: { generation: 1n, sequence: 5n }, occurredAt: { seconds: 1n, nanos: 0 }, payload: { kind: { case: "messageCompleted", value: {
        messageId: "nontext", role: MessageRole.ASSISTANT, blocks: [{ content: { case: "toolCall", value: { callId: "call", name: "Saved", input: "{}" } } }],
        learning: { revision: { value: 2n }, receipts: [{ kind: PartnerLearningKind.MEMORY, entryId: "memory", title: "Release", action: PartnerLearningAction.CREATED }] }
      } } } });
    const originalDetail = state.detail;
    if (!originalDetail) throw new Error("Task fixture requires its original detail Snapshot.");
    state = { ...state, detail: create(SnapshotSchema, { ...originalDetail, timeline: [completion] }) };
    await renderTask();
    expect(host.querySelector('[data-testid="message.learningFooter"]')).toBeNull();
    expect(learningProfileProps?.visible).toBe(false);
    expect(select).not.toHaveBeenCalled();
    const { timelineRows } = await import("./timeline");
    expect(timelineRows([completion])[0]).toMatchObject({ completed: true, assistantBodyPresent: false, learning: { revision: 2n } });
  });
  it("keeps the current row and the host's query/filter across drawer and persistent mounts", async () => {
    await render();
    expect(button(mobileMessage("en", "home.openTask", { name: "Alpha" })).getAttribute("aria-selected")).toBe("true");
    await type(message("home.search"), "Beta");
    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(searchHome).toHaveBeenLastCalledWith("Beta", "active");
    expect(host.textContent).toContain("Beta"); expect(host.textContent).not.toContain("Alpha");
    await press(message("home.filter.archived"));
    expect(viewState).toEqual({ search: "Beta", statusFilter: "archived" });
    await act(async () => root.unmount()); root = createRoot(host);
    await render({ host: "persistent" });
    expect(host.querySelector<HTMLInputElement>(`input[aria-label="${message("home.search")}"]`)?.value).toBe("Beta");
    expect(button(message("home.filter.archived")).getAttribute("aria-selected")).toBe("true");
    expect(host.textContent).not.toContain("Alpha");
  });

  it("hands row, new task, share and menu intents to the host before any navigation effect", async () => {
    await render({ incomingShare: { supported: true, busy: false, batch: { batchId: "share", orderKey: "1",
      createdAtUnixMs: 1, status: "ready", overflowCount: 0, items: [] } } });
    await press(mobileMessage("en", "home.openTask", { name: "Beta" }));
    await press(message("common.new")); await press(message("incoming.open")); await press(message("home.openMenu"));
    expect(runNavigation.mock.calls.map(call => call[0])).toEqual([{ kind: "session", sessionId: "other" },
      { kind: "new-task" }, { kind: "incoming-share" }, { kind: "menu" }]);
    for (const effect of [select, onSelect, onNew, onOpenShare, onMenu]) expect(effect).not.toHaveBeenCalled();
  });

  it("retains original Home options, copy feedback and unknown receipt controls in the embedded host", async () => {
    await render({ state: { ...state, pending: [{ operationId: "pin-receipt", kind: "pin", state: "unknown",
      connectionId: homeConnectionId, sessionId: "current" }] } });
    expect(host.textContent).toContain("pin-receipt"); await press(message("receipt.check"));
    expect(reconcile).toHaveBeenCalledOnce();
    await option(message("common.unpin"));
    expect(setSessionPinned).toHaveBeenCalledExactlyOnceWith("current", false);
    await option(message("common.archive"));
    expect(setSessionArchived).toHaveBeenCalledExactlyOnceWith("current", true);
    await option(message("common.rename"));
    await type(message("home.taskName"), "Renamed"); await press(message("common.rename"));
    expect(renameSession).toHaveBeenCalledExactlyOnceWith("current", "Renamed");
    await option(message("actions.copyTaskLink"));
    expect(writeClipboard).toHaveBeenCalledExactlyOnceWith("joko://task/current");
    expect(host.textContent).toContain(message("actions.taskLinkCopied"));
    expect(runNavigation).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
  });

  it("keeps offline Home read-only and restores its original controls on reconnect", async () => {
    await render({ state: { ...state, status: "offline", offlineSnapshotAt: 1 } });
    await press(mobileMessage("en", "home.optionsFor", { name: "Alpha" }));
    expect(button(message("common.rename")).disabled).toBe(true);
    expect(button(message("common.unpin")).disabled).toBe(true);
    expect(button(message("common.archive")).disabled).toBe(true);
    expect(button(message("actions.copyTaskLink")).disabled).toBe(false);
    expect(button(message("common.new")).disabled).toBe(true);
    await press(message("common.cancel")); await press(message("common.retry"));
    expect(refresh).toHaveBeenCalledOnce();
    await render({ state: { ...state, status: "connected" } });
    await option(message("common.archive"));
    expect(setSessionArchived).toHaveBeenCalledExactlyOnceWith("current", true);
  });

  it("retires debounced reads on unmount and does not read or navigate while hidden", async () => {
    await render({ viewState: { search: "Beta", statusFilter: "active" } });
    await act(async () => root.unmount()); root = createRoot(host);
    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(searchHome).not.toHaveBeenCalled();
    await render({ foreground: false, viewState: { search: "", statusFilter: "active" } });
    await press(mobileMessage("en", "home.openTask", { name: "Beta" }));
    await press(message("common.new")); await press(message("home.openMenu"));
    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(searchHome).not.toHaveBeenCalled(); expect(runNavigation).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
    await render({ foreground: true }); expect(searchHome).toHaveBeenCalledExactlyOnceWith("", "active");
  });
});

describe("actual Task Home navigation composition", () => {
  it.each([
    [{ senderSessionId: "other", senderSessionTitle: "Original title" }, "From task Original title"],
    [{ senderSessionId: "other", senderPartnerId: "partner", senderPartnerName: "Partner name" }, "From Partner Partner name"],
    [{ senderSessionId: "other" }, "From another task"]
  ] as const)("opens the typed task source %s after saving the original composer", async (taskMessageOrigin, label) => {
    const event = create(EventSchema, { eventId: "handoff", identity: { sessionId: "current" }, cursor: { generation: 1n, sequence: 9n },
      payload: { kind: { case: "messageStarted", value: { messageId: "input", role: MessageRole.USER, userInputAccepted: true, taskMessageOrigin,
        userInput: { parts: [{ content: { case: "text", value: "Unchanged body" } }] } } } } });
    if (!state.detail) throw new Error("Task requires its original detail Snapshot.");
    state = { ...state, detail: create(SnapshotSchema, { ...state.detail, timeline: [event] }) };
    await renderTask(); expect(host.textContent).toContain("Unchanged body");
    await press(label); expect(select).toHaveBeenCalledExactlyOnceWith("other");
    expect(draftFlush.mock.invocationCallOrder[0]).toBeLessThan(select.mock.invocationCallOrder[0]!);
  });
  it("renders a canonical worker report and flushes the original draft before opening its verified source", async () => {
    const origin = { goalId: "goal", workerId: "worker", leadSessionId: "current", workerSessionId: "reporting-task", workerLabel: "Reviewer", body: "Verified the release." };
    const event = create(EventSchema, { eventId: "report-event", identity: { sessionId: "current", runId: "report-run" }, cursor: { generation: 1n, sequence: 9n },
      payload: { kind: { case: "messageStarted", value: { messageId: "report", role: MessageRole.USER, userInputAccepted: true,
        userInput: { parts: [{ content: { case: "text", value: "[From Reviewer]\nVerified the release." } }] }, collaborationReportOrigin: origin } } } });
    if (!state.detail) throw new Error("Task requires its original detail Snapshot.");
    state = { ...state, detail: create(SnapshotSchema, { ...state.detail, timeline: [event] }) };
    const resolveReport = vi.fn(async () => "reporting-task");
    collaborationApi = { ownerKey: "report-owner", restore: async () => undefined, resolveReport } as unknown as import("./mobile-collaboration").MobileCollaborationApi;
    await renderTask();
    expect(host.textContent).toContain("Worker report"); expect(host.textContent).not.toContain(origin.body);
    await press("Expand Worker report"); expect(host.textContent).toContain(origin.body); expect(host.textContent).not.toContain("[From Reviewer]");
    await press("From worker Reviewer");
    expect(resolveReport).toHaveBeenCalledWith(expect.objectContaining(origin), expect.any(AbortSignal));
    expect(draftFlush).toHaveBeenCalled(); expect(select).toHaveBeenCalledExactlyOnceWith("reporting-task");
    expect(draftFlush.mock.invocationCallOrder[0]).toBeLessThan(select.mock.invocationCallOrder[0]!);
  });
  it("wires worker and sharing header state and moves the persistent new-task action to the current system bar", async () => {
    platformOS = "ios";
    dimensions = { ...dimensions, width: 800 };
    taskWindowGeometry = { width: 800, height: 844, insets: { top: 24, left: 0, right: 0, bottom: 16 },
      regularWidth: true, regularHeight: true, barEdge: "right", reservedRegionsSupported: true, regions: [] };
    observedHeaderRole = "worker";
    await renderTask();
    expect(headerProps.detailsOnly).toBe(true); expect(headerProps.primaryActionsReady).toBe(true);
    expect(headerProps.notice).toBe("Collaboration worker");
    const floating = host.querySelector('[data-testid="task.system-bar.new"]'); expect(floating).not.toBeNull();
    expect(host.querySelectorAll('button[aria-label="New"]')).toHaveLength(1);
    const composer = host.querySelector('[data-testid="task-composer"]');
    const header = host.querySelector('[data-testid="task-header"]');
    headerSourceEpoch++; await renderTask();
    expect(host.querySelector('[data-testid="task-header"]')).not.toBe(header);
    expect(host.querySelector('[data-testid="task-composer"]')).toBe(composer);
    shareSelectionActive = true; await renderTask();
    expect(headerProps.selection).toMatchObject({ allSelected: false, busy: false });
    expect(host.querySelector('[data-testid="task.system-bar.new"]')).toBeNull();
    shareSelectionActive = false; taskWindowGeometry = undefined; await renderTask();
    expect(headerProps.selection).toBeUndefined(); expect(host.querySelector('[data-testid="task.system-bar.new"]')).toBeNull();
    expect(host.querySelectorAll('button[aria-label="New"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="task-composer"]')).toBeNull();
    expect(composer).toBeNull();
    expect(host.textContent).toContain("Worker conversations are read-only");
    taskWindowGeometry = { width: 800, height: 844, insets: { top: 24, left: 0, right: 0, bottom: 16 },
      regularWidth: true, regularHeight: true, barEdge: "right", reservedRegionsSupported: true, regions: [] };
    await renderTask(); await press("New");
    expect(draftFlush).toHaveBeenCalled(); expect(onNew).toHaveBeenCalledOnce();
  });
  it("clips the whole bottom controls tree in the current pane and keeps the original Composer mounted when reservations retire", async () => {
    dimensions = { ...dimensions, width: 700 };
    await renderTask();
    const composer = host.querySelector('[data-testid="task-composer"]');
    const viewport = host.querySelector('[data-testid="task.controls-viewport"]');
    expect(viewport?.contains(composer)).toBe(true);
    expect(viewport?.hasAttribute("data-native-style")).toBe(false);
    taskWindowGeometry = { width: 700, height: 844, insets: { top: 24, left: 10, right: 10, bottom: 20 },
      regularWidth: false, regularHeight: true, barEdge: "left", reservedRegionsSupported: true,
      regions: [{ kind: "division", x: 250, y: 24, width: 20, height: 800 },
        { kind: "occlusion", x: 660, y: 24, width: 30, height: 800 }] };
    await renderTask();
    expect(host.querySelector('[data-testid="task.controls-viewport"]')).toBe(viewport);
    expect(viewport?.getAttribute("data-pointer-events")).toBe("box-none");
    expect(JSON.parse(viewport?.getAttribute("data-native-style") ?? "null"))
      .toEqual({ marginLeft: 0, marginRight: 30, marginBottom: 0, maxHeight: 800, overflow: "hidden" });
    expect(host.querySelector('[data-testid="task-composer"]')).toBe(composer);
    taskWindowGeometry = undefined; await renderTask();
    expect(viewport?.hasAttribute("data-native-style")).toBe(false);
    expect(host.querySelector('[data-testid="task-composer"]')).toBe(composer);
    expect(select).not.toHaveBeenCalled(); expect(draftFlush).not.toHaveBeenCalled();
  });
  it("keeps the detail and draft mounted across the system division while its gap has no input or accessibility tree", async () => {
    dimensions = { ...dimensions, width: 700 };
    await renderTask();
    const detail = host.querySelector('[data-testid="task.detail"]');
    const composer = host.querySelector('[data-testid="task-composer"]');
    taskWindowGeometry = { width: 700, height: 844, insets: { top: 24, left: 10, right: 10, bottom: 20 },
      regularWidth: false, regularHeight: true, barEdge: "left", reservedRegionsSupported: true,
      regions: [{ kind: "division", x: 250, y: 24, width: 20, height: 800 }] };
    await renderTask();
    expect(host.querySelector('[data-testid="task.navigation.persistent"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="task.home-column"]')?.getAttribute("data-native-style")).toContain('"width":240');
    const gap = host.querySelector('[data-testid="task.system-division"]');
    expect(gap?.getAttribute("data-native-style")).toBe('{"width":20}');
    expect(gap?.getAttribute("data-pointer-events")).toBe("none"); expect(gap?.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector('[data-testid="task.navigation.persistent"]')?.getAttribute("data-native-style"))
      .toContain('"paddingLeft":10');
    expect(host.querySelector('[data-consumed-bottom-inset="20"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="task.detail"]')).toBe(detail); expect(host.querySelector('[data-testid="task-composer"]')).toBe(composer);
    taskWindowGeometry = undefined; await renderTask();
    expect(host.querySelector('[data-testid="task.navigation.drawer"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="task.system-division"]')).toBeNull();
    expect(host.querySelector('[data-testid="task.detail"]')).toBe(detail); expect(host.querySelector('[data-testid="task-composer"]')).toBe(composer);
    expect(select).not.toHaveBeenCalled(); expect(draftFlush).not.toHaveBeenCalled();
  });
  it("keeps one Home and the same detail and Composer while resizing through all navigation modes", async () => {
    viewState = { search: "Alpha", statusFilter: "active" };
    await renderTask();
    const detail = host.querySelector('[data-testid="task.detail"]');
    const composer = host.querySelector('[data-testid="task-composer"]');
    expect(host.querySelector('[data-testid="task.navigation.narrow"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="home-list"]')).toHaveLength(0);
    expect(composerProps.draft.text).toBe("Retained composer"); expect(headerProps.quickSwitch).toBeUndefined();
    dimensions = { ...dimensions, width: 650 };
    await renderTask(); await press("Quick switch");
    expect(host.querySelector('[data-testid="task.navigation.drawer"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="home-list"]')).toHaveLength(1);
    expect(button(mobileMessage("en", "home.openTask", { name: "Alpha" })).getAttribute("aria-selected")).toBe("true");
    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(searchHome).toHaveBeenCalledExactlyOnceWith("Alpha", "active");
    dimensions = { ...dimensions, width: 900, height: 700 };
    await renderTask();
    expect(host.querySelector('[data-testid="task.navigation.persistent"]')).not.toBeNull();
    expect(drawerProps.visible).toBe(false);
    expect(host.querySelector('[data-testid="task.home-column"]')?.textContent).toBe("");
    expect(host.querySelectorAll('[data-testid="home-list"]')).toHaveLength(1);
    await closeTaskDrawer();
    expect(host.querySelector('[data-testid="drawer-fixture"]')).toBeNull();
    expect(host.querySelector('[data-testid="task.home-column"]')?.textContent).toContain("Alpha");
    expect(host.querySelectorAll('[data-testid="home-list"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="task.detail"]')).toBe(detail);
    expect(host.querySelector('[data-testid="task-composer"]')).toBe(composer);
    expect(composerProps.draft.text).toBe("Retained composer");
    expect(headerProps.quickSwitch).toBeUndefined(); expect(headerProps.persistentNavigation).toBeDefined();
    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(searchHome.mock.calls).toEqual([["Alpha", "active"], ["Alpha", "active"]]);
    dimensions = { ...dimensions, width: 390, height: 844 };
    await renderTask();
    expect(host.querySelectorAll('[data-testid="home-list"]')).toHaveLength(0);
    expect(host.querySelector('[data-testid="task.detail"]')).toBe(detail);
    expect(host.querySelector('[data-testid="task-composer"]')).toBe(composer);
  });

  it("waits for modal unmount and both draft flushes before selection, and reopens shared search through the captured port", async () => {
    dimensions = { ...dimensions, width: 650 };
    await renderTask(); await press("Quick switch");
    let releaseFlush!: () => void;
    draftFlush.mockImplementationOnce(() => new Promise<void>(resolve => { releaseFlush = resolve; }));
    await press(mobileMessage("en", "home.openTask", { name: "Beta" }));
    expect(drawerProps.visible).toBe(false); expect(host.querySelector('[data-testid="drawer-fixture"]')).not.toBeNull();
    expect(select).not.toHaveBeenCalled(); expect(draftFlush).not.toHaveBeenCalled();
    await closeTaskDrawer();
    expect(draftFlush).toHaveBeenCalledExactlyOnceWith({ profileId: "profile", sessionId: "current" });
    expect(select).not.toHaveBeenCalled(); expect(newTaskFlush).not.toHaveBeenCalled();
    await act(async () => releaseFlush());
    expect(newTaskFlush).toHaveBeenCalledOnce(); expect(select).toHaveBeenCalledExactlyOnceWith("other");
    expect(draftFlush.mock.invocationCallOrder[0]).toBeLessThan(newTaskFlush.mock.invocationCallOrder[0]);
    expect(newTaskFlush.mock.invocationCallOrder[0]).toBeLessThan(select.mock.invocationCallOrder[0]);
    expect(onNavigated).toHaveBeenCalledOnce();

    await renderTask();
    const searchDelivery = taskNavigationPort!({ kind: "search" }, true);
    expect(searchDelivery).toBeTypeOf("function"); expect(drawerProps.visible).toBe(false);
    expect(onSearchFocus).not.toHaveBeenCalled();
    await act(async () => searchDelivery!());
    expect(onSearchFocus).toHaveBeenCalledOnce(); expect(drawerProps.visible).toBe(true);
    expect(host.querySelectorAll('[data-testid="home-list"]')).toHaveLength(1);
    draftFlush.mockRejectedValueOnce(new Error("Draft storage failed"));
    await press(message("common.new")); await closeTaskDrawer();
    expect(onNew).not.toHaveBeenCalled(); expect(select).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Draft storage failed");
  });
});
