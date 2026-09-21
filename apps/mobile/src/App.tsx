import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import {
  AccessibilityInfo, ActivityIndicator, Alert, AppState, BackHandler, FlatList, Keyboard, Linking, Modal, PanResponder, Platform,
  Image, Pressable, ScrollView, SectionList, StyleSheet, Text, TextInput, findNodeHandle, useColorScheme,
  useWindowDimensions, View
} from "react-native";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { SvgXml } from "react-native-svg";
import { StatusBar } from "expo-status-bar";
import Constants from "expo-constants";
import { randomUUID } from "expo-crypto";
import * as Clipboard from "expo-clipboard";
import {
  CapabilitySupport, ConnectionState, DeviceKind, DevicePresenceState, FileKind, QueueItemState, TargetState, capabilityNames,
  type QueueItem, type Session
} from "@joko/contracts";
import { MobileConnectionStage } from "./MobileConnectionStage";
import {
  MobileClient,
  type MobileQueueEditLease,
  type NearbyMobileNode,
  type SavedMobileConnection
} from "./mobile-client";
import {
  mobileConnectionAppIcon,
  mobileConnectionArtworkFrame,
  mobileLoadingIllustration,
  nextConnectionArtworkGroupIndex,
  type ConnectionArtworkVariant
} from "./connection-artwork";
import { MOBILE_FILE_SHARE_MAXIMUM_BYTES, mobileNetwork } from "./network";
import { mobileDiscovery } from "./native-lan-discovery";
import {
  mobileAttachmentCamera,
  mobileAttachmentFiles,
  mobilePhotoLibrary,
  mobileComposerDrafts,
  mobileInteractionDrafts,
  mobileNewTaskDrafts,
  mobileOfflineCache,
  mobileDiagnostics,
  mobileLocalePreferences,
  mobileStorage,
  mobileThemePreferences
} from "./storage";
import {
  mobileComposerDraftIdentityKey,
  type MobileComposerDraftIdentity,
  type MobileComposerDraftSnapshot
} from "./composer-draft-store";
import type {
  MobileNewTaskDraftSnapshot,
  MobileNewTaskEditableDraft
} from "./new-task-draft-store";
import { addToMobileComposer } from "./composer-draft-behavior";
import {
  emptyMobileComposerDraft,
  isLongMobileComposerPaste,
  insertMobileArtifactMention,
  insertMobileStructuredClipboardText,
  insertMobileResourceMention,
  insertMobileSessionMention,
  insertMobileWorkspaceMention,
  mobileComposerNativeInputMaximumCharacters,
  mobileComposerDraftsEqual,
  mobileInputSummary,
  plainTextMobileComposerDraft,
  removeMobileComposerAtom,
  removeMobileComposerMention,
  updateMobilePastedTextAtom,
  type MobileComposerAtom,
  type MobileComposerDraft,
  type MobileComposerSelection,
  type MobileWorkspaceLineRange
} from "./mobile-composer-document";
import { mobileComposerRichAtomLabel } from "./mobile-composer-rich-document";
import { enrichMobileComposerRouteReferences } from "./mobile-composer-route-enrichment";
import { findMobileComposerWorkspacePathCandidates } from "./mobile-composer-route-links";
import {
  appendMobileComposerAttachments,
  formatMobileAttachmentBytes,
  removeMobileComposerAttachment,
  type MobileAttachmentControls,
  type MobileAttachmentPolicy,
  type MobileComposerAttachment
} from "./mobile-attachments";
import { mobileCameraCaptureSupported } from "./mobile-attachment-camera";
import { observeMobileAttachmentAuthority, waitForMobileAttachmentAuthority } from "./mobile-attachment-authority";
import {
  canBrowseMobilePhotoLibraryDirectly,
  mobilePhotoLibrarySupported,
  type MobilePhotoLibraryAsset
} from "./mobile-photo-library";
import { MobilePhotoLibrarySheet } from "./MobilePhotoLibrarySheet";
import {
  accessibleComposerHeight,
  buildComposerResizeGestureConfig,
  composerAutomaticMaximumHeight,
  composerMinimumInputHeight,
  computeComposerResizeBounds,
  resizeComposerHeight,
  resolveComposerHeight,
  settleComposerHeight,
  shouldDismissComposerKeyboard
} from "./composer-layout";
import { MobileKeyboardAvoidingView, useMobileKeyboardState } from "./MobileKeyboardAvoidingView";
import { timelineRows, type TimelineRow } from "./timeline";
import type { MobileTimelineArtifact } from "./mobile-timeline-artifacts";
import { MobileDrawer } from "./MobileDrawer";
import { MobileActionSheet } from "./MobileActionSheet";
import { MobileComposerAtomSheet } from "./MobileComposerAtomSheet";
import {
  MobileComposerRichInput,
  type MobileComposerRichImagePasteRequest,
  type MobileComposerRichImagePasteStartRequest,
  type MobileComposerRichInputHandle,
  type MobileComposerRichPasteRequest
} from "./MobileComposerRichInput";
import {
  MobileComposerImagePaste,
  commitMobileComposerImagePaste
} from "./mobile-composer-image-paste";
import { MobileRuntimeCommandPalette, type MobileRuntimeCommandPaletteStatus } from "./MobileRuntimeCommandPalette";
import { MobileCommandHelpSheet } from "./MobileCommandHelpSheet";
import {
  assertMobileAppCommandCandidate,
  filterMobileCommandPaletteCandidates,
  isMobileAppCommandCandidate,
  mergeMobileCommandPaletteCandidates,
  mobileAppCommandCandidates,
  mobileAppCommandIntent,
  parseMobileAppCommand,
  type MobileCommandPaletteCandidate
} from "./mobile-app-commands";
import {
  MobileRuntimeCommandCatalogCache,
  assertMobileRuntimeCommandCandidate,
  detectMobileRuntimeCommandActivation,
  replaceMobileRuntimeCommandRun,
  resolveMobileRuntimeCommandPaletteKey,
  type MobileRuntimeCommandActivation,
  type MobileRuntimeCommandCatalog
} from "./mobile-runtime-commands";
import type { MobileComposerCommandPaletteKey } from "./mobile-composer-rich-input-protocol";
import { MobileQuoteSelectionSheet } from "./MobileQuoteSelectionSheet";
import {
  captureMobileQuoteSelection,
  commitMobileQuoteSelection,
  type MobileQuoteSelectionLease
} from "./mobile-composer-quote";
import { MobileInteractionSheet } from "./MobileInteractionSheet";
import { MobileRuntimeControlsSheet } from "./MobileRuntimeControlsSheet";
import { MobileContextSheet } from "./MobileContextSheet";
import { MobileNativeTreeSheet } from "./MobileNativeTreeSheet";
import { MobileSessionMentionSheet } from "./MobileSessionMentionSheet";
import type { MobileSessionMentionCandidate } from "./mobile-session-mentions";
import { MobileWorkspaceMentionSheet } from "./MobileWorkspaceMentionSheet";
import type { MobileWorkspaceMentionCandidate } from "./mobile-workspace-mentions";
import { MobileCatalogMentionSheet } from "./MobileCatalogMentionSheet";
import type { MobileCatalogMentionCandidate } from "./mobile-catalog-mentions";
import {
  mobileInteractionDraftIdentity,
  mobileInteractionDraftIdentityKey,
  type MobileInteractionDraftIdentity
} from "./interaction-draft-store";
import { mobileInteractionTitle } from "./mobile-interactions";
import { SwipeableSessionRow } from "./SwipeableSessionRow";
import {
  buildMobileHomeSections, buildWideSessionNavLayout, createSwipeRowRegistry,
  type MobileHomeStatusFilter
} from "./home-navigation";
import {
  artifactTitle,
  workspaceBasename,
  workspaceParentPath,
  type MobileFilePreview,
  type MobileFileSearchResult,
  type MobileFilesComposerSource,
  type MobileFilesSearchMode
} from "./workspace-files";
import { buildMobileMessageActions, queueItemText, type MobileMessageActionId } from "./task-actions";
import { useMobileVoiceInput, type MobileVoiceInputBinding } from "./use-mobile-voice-input";
import type { MobileVoiceRunError } from "./mobile-voice-input";
import { MobileImageLightbox } from "./MobileImageLightbox";
import { MobileMediaPlayer } from "./MobileMediaPlayer";
import type { MobileMediaPlayerStatus } from "./mobile-media-player";
import { mobileMediaPreviewFiles } from "./mobile-media-preview";
import { MobilePdfViewer } from "./MobilePdfViewer";
import type { MobilePdfViewerStatus } from "./mobile-pdf-viewer";
import { mobilePdfPreviewFiles } from "./mobile-pdf-preview";
import { MobileModelViewer } from "./MobileModelViewer";
import type { MobileModelViewerStatus } from "./mobile-model-viewer";
import { mobileModelPreviewFiles, mobileModelPreviewKind } from "./mobile-model-preview";
import type { MobileBurnedImage, MobileComposerImageEditorSession } from "./mobile-composer-image-editor";
import type { MobileImageAnnotationStroke } from "./mobile-image-annotation";
import {
  mobileImageGalleryMediaType,
  type MobileImageGalleryDescriptor,
  type MobileImageGalleryNativeDecode,
  type MobileImageGalleryPageSession,
  type MobileImageGalleryPageSummary
} from "./mobile-image-gallery";
import {
  mobileImageOutput,
  type MobileImageOutputAction,
  type MobileImageOutputRenderedImage
} from "./mobile-image-output";
import { mobileFileShare, type MobileFileShareProgress } from "./mobile-file-share";
import { mobileOfflineAgeLabel } from "./mobile-offline-cache";
import { MobileOfflineNotice } from "./MobileOfflineNotice";
import { MobileAutomationsScreen } from "./MobileAutomationsScreen";
import { MobileFilesToolbar } from "./MobileFilesToolbar";
import { MobileSettingsScreen } from "./MobileSettingsScreen";
import { resolveMobileDarkTheme } from "./mobile-theme-preference";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import {
  commitMobileIncomingShare,
  mobileIncomingShare,
  mobileIncomingShareClaimMatches,
  mobileIncomingShareProfileRetired,
  planMobileIncomingShare,
  type MobileIncomingShareReadyBatch
} from "./mobile-incoming-share";

const client = new MobileClient(
  mobileNetwork,
  mobileStorage,
  mobileDiscovery,
  randomUUID,
  Platform.OS,
  Date.now,
  (identity) => mobileInteractionDrafts.clear(identity),
  mobileNewTaskDrafts,
  mobileComposerDrafts,
  mobileAttachmentFiles,
  mobileMediaPreviewFiles,
  mobilePdfPreviewFiles,
  mobileModelPreviewFiles,
  mobileFileShare,
  mobileOfflineCache
);
const runtimeCommandCatalogCache = new MobileRuntimeCommandCatalogCache();
const mobileComposerImagePaste = new MobileComposerImagePaste(mobileAttachmentFiles);
type Page = "home" | "connection" | "new" | "task" | "files" | "automations" | "settings" | "connections" | "devices" | "device";

interface MobilePhotoLibraryLease {
  readonly controls: MobileAttachmentControls;
  readonly scopeKey: string;
  readonly generation: number;
  readonly controller: AbortController;
}

interface MobileComposerImageEditorLease {
  readonly session: MobileComposerImageEditorSession;
  readonly scopeKey: string;
}

interface MobileNewTaskImagePasteLease {
  readonly count: number;
  readonly controller: AbortController;
  readonly controls: MobileAttachmentControls;
  readonly draft: MobileNewTaskEditableDraft;
  readonly generation: number;
  readonly profileId: string;
  readonly snapshot: Promise<MobileNewTaskDraftSnapshot>;
  readonly targetId: string;
}

interface MobileTaskImagePasteLease {
  readonly count: number;
  readonly controller: AbortController;
  readonly controls: MobileAttachmentControls;
  readonly draft: MobileComposerDraft;
  readonly generation: number;
  readonly identity: MobileComposerDraftIdentity;
  readonly snapshot: Promise<MobileComposerDraftSnapshot>;
}

interface MobileRuntimeCommandLoadState {
  readonly ownerKey?: string;
  readonly catalog?: MobileRuntimeCommandCatalog;
  readonly status: MobileRuntimeCommandPaletteStatus;
  readonly error?: string;
}

interface MobileRuntimeCommandDismissal {
  readonly ownerKey: string;
  readonly sourceDraft: MobileComposerDraft;
  readonly selection: MobileComposerSelection;
  readonly activation: MobileRuntimeCommandActivation;
}

interface MobileRuntimeCommandDraftLease {
  readonly ownerKey: string;
  readonly draftIdentityKey: string;
  readonly revision: number;
  readonly sourceDraft: MobileComposerDraft;
  readonly selection: MobileComposerSelection;
  readonly activation: MobileRuntimeCommandActivation;
  readonly runtimeCatalog?: MobileRuntimeCommandCatalog;
}

interface MobileRuntimeCommandPaletteSnapshot {
  readonly visible: boolean;
  readonly ownerKey?: string;
  readonly activation?: MobileRuntimeCommandActivation;
  readonly runtimeCatalog?: MobileRuntimeCommandCatalog;
  readonly items: readonly MobileCommandPaletteCandidate[];
  readonly selectedIndex: number;
  readonly status: MobileRuntimeCommandPaletteStatus;
  readonly draftLease?: MobileRuntimeCommandDraftLease;
}

interface MobileImageGalleryView {
  readonly descriptor: MobileImageGalleryDescriptor;
  readonly session: MobileImageGalleryPageSession;
  readonly busy: boolean;
  readonly error?: string;
}

function useMobileImageGallery(
  locale: MobileSupportedLocale,
  onCommitted: (draft: MobileComposerDraft) => void
) {
  const [view, setView] = useState<MobileImageGalleryView>();
  const viewRef = useRef<MobileImageGalleryView | undefined>(undefined);
  const pageControllerRef = useRef<AbortController | undefined>(undefined);
  const onCommittedRef = useRef(onCommitted);
  viewRef.current = view;
  onCommittedRef.current = onCommitted;

  const close = useCallback(() => {
    pageControllerRef.current?.abort();
    pageControllerRef.current = undefined;
    const current = viewRef.current;
    viewRef.current = undefined;
    setView(undefined);
    if (current) client.cancelImageGallery(current.descriptor.leaseId);
  }, []);

  useEffect(() => close, [close]);

  const open = useCallback(async (
    begin: (signal: AbortSignal) => Promise<MobileImageGalleryDescriptor>
  ): Promise<void> => {
    close();
    const controller = new AbortController();
    pageControllerRef.current = controller;
    let descriptor: MobileImageGalleryDescriptor | undefined;
    try {
      descriptor = await begin(controller.signal);
      const session = await client.loadImageGalleryPage(
        descriptor.leaseId,
        descriptor.initialIndex,
        controller.signal
      );
      controller.signal.throwIfAborted();
      const next = { descriptor, session, busy: false };
      viewRef.current = next;
      setView(next);
    } catch (error) {
      if (descriptor) client.cancelImageGallery(descriptor.leaseId);
      if (!controller.signal.aborted) throw error;
    } finally {
      if (pageControllerRef.current === controller) pageControllerRef.current = undefined;
    }
  }, [close]);

  const navigate = useCallback((pageIndex: number): void => {
    const current = viewRef.current;
    if (!current || current.busy || pageIndex === current.session.pageIndex) return;
    pageControllerRef.current?.abort();
    const controller = new AbortController();
    pageControllerRef.current = controller;
    const pending = { ...current, busy: true, error: undefined };
    viewRef.current = pending;
    setView(pending);
    void client.loadImageGalleryPage(current.descriptor.leaseId, pageIndex, controller.signal).then((session) => {
      if (controller.signal.aborted || viewRef.current?.descriptor.leaseId !== current.descriptor.leaseId) return;
      const next = { descriptor: current.descriptor, session, busy: false };
      viewRef.current = next;
      setView(next);
    }).catch((error) => {
      if (controller.signal.aborted || viewRef.current?.descriptor.leaseId !== current.descriptor.leaseId) return;
      const failed = { ...current, busy: false, error: errorText(error, locale) };
      viewRef.current = failed;
      setView(failed);
    }).finally(() => {
      if (pageControllerRef.current === controller) pageControllerRef.current = undefined;
    });
  }, [locale]);

  const decoded = useCallback((value: MobileImageGalleryNativeDecode): void => {
    const current = viewRef.current;
    if (!current) throw new Error(mobileMessage(locale, "task.error.galleryClosed"));
    client.confirmImageGalleryPageDecoded(
      current.descriptor.leaseId,
      current.session.leaseId,
      current.session.pageId,
      value
    );
  }, [locale]);

  const addOriginal = useCallback(async (signal: AbortSignal): Promise<void> => {
    const current = viewRef.current;
    if (!current) throw new Error(mobileMessage(locale, "task.error.galleryClosed"));
    const draft = await client.addImageGalleryPageToComposer(
      current.descriptor.leaseId,
      current.session.leaseId,
      signal
    );
    signal.throwIfAborted();
    viewRef.current = undefined;
    setView(undefined);
    onCommittedRef.current(draft);
  }, [locale]);

  const save = useCallback(async (
    strokes: readonly MobileImageAnnotationStroke[],
    burned: MobileBurnedImage | undefined,
    signal: AbortSignal
  ): Promise<void> => {
    const current = viewRef.current;
    if (!current) throw new Error(mobileMessage(locale, "task.error.galleryClosed"));
    const draft = await client.commitImageGalleryPageToComposer(
      current.descriptor.leaseId,
      current.session.leaseId,
      strokes,
      burned,
      signal
    );
    signal.throwIfAborted();
    viewRef.current = undefined;
    setView(undefined);
    onCommittedRef.current(draft);
  }, [locale]);

  return { view, open, close, navigate, decoded, addOriginal, save };
}

async function performMobileImageOutput(
  session: MobileComposerImageEditorSession,
  action: MobileImageOutputAction,
  decoded: MobileImageGalleryNativeDecode,
  rendered: MobileImageOutputRenderedImage | undefined,
  signal: AbortSignal,
  locale: MobileSupportedLocale
): Promise<string> {
  const source = await client.prepareImageOutput(session.leaseId, decoded, signal);
  await mobileImageOutput.perform(action, source, rendered, signal);
  return mobileMessage(locale, action === "copy" ? "image.copied"
    : action === "save" ? "image.saved" : "image.shared");
}

export function App() {
  const state = useSyncExternalStore((listener) => client.subscribe(listener), () => client.state);
  const theme = useSyncExternalStore(
    (listener) => mobileThemePreferences.subscribe(listener),
    () => mobileThemePreferences.snapshot
  );
  const incomingShare = useSyncExternalStore(
    (listener) => mobileIncomingShare.subscribe(listener),
    () => mobileIncomingShare.snapshot
  );
  const diagnostics = useSyncExternalStore(
    (listener) => mobileDiagnostics.subscribe(listener),
    () => mobileDiagnostics.snapshot
  );
  const locale = useSyncExternalStore(
    (listener) => mobileLocalePreferences.subscribe(listener),
    () => mobileLocalePreferences.snapshot
  );
  const [page, setPage] = useState<Page>("home");
  const [menuOpen, setMenuOpen] = useState(false);
  const [homeDrawerMounted, setHomeDrawerMounted] = useState(false);
  const [homeSearchFocusRequest, setHomeSearchFocusRequest] = useState(0);
  const [focusTaskComposer, setFocusTaskComposer] = useState(false);
  const [deviceId, setDeviceId] = useState<string>();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const homeMenuButtonRef = useRef<View>(null);
  const pendingHomeMenuActionRef = useRef<(() => void) | undefined>(undefined);
  const openedIncomingShareRef = useRef<string | undefined>(undefined);
  const retiredIncomingShareRef = useRef<string | undefined>(undefined);
  const diagnosticConnectionKeyRef = useRef<string | undefined>(undefined);
  const scheme = useColorScheme();
  const dark = resolveMobileDarkTheme(theme.preference, scheme);
  const colors = useMemo(() => ({
    background: dark ? "#15191d" : "#f7f6f3", surface: dark ? "#24292d" : "#ffffff",
    ink: dark ? "#f4f4f2" : "#242a2d", muted: dark ? "#adb6b7" : "#637073",
    border: dark ? "#394246" : "#e1e2df", accent: "#ff9800", negative: "#cc634e",
    brandBackground: dark ? "#302920" : "#fff1db"
  }), [dark]);

  useEffect(() => {
    void mobileThemePreferences.hydrate();
    void mobileLocalePreferences.hydrate();
    let diagnosticsStopped = false;
    let diagnosticsState = AppState.currentState;
    let diagnosticsTick = performance.now();
    void mobileDiagnostics.hydrate().then(async () => {
      if (diagnosticsStopped) return;
      mobileDiagnostics.record("app.started", { state: mobileDiagnosticAppState(diagnosticsState) });
      await mobileDiagnostics.flush().catch(() => undefined);
      await mobileDiagnostics.maintainExportCache().catch(() => undefined);
    });
    void mobileImageOutput.maintain().catch(() => undefined);
    void mobileFileShare.maintain().catch(() => undefined);
    void mobileIncomingShare.refresh().catch(() => undefined);
    client.setForeground(AppState.currentState === "active");
    void client.start();
    const subscription = AppState.addEventListener("change", (status) => {
      const foreground = status === "active";
      diagnosticsState = status;
      diagnosticsTick = performance.now();
      setForeground(foreground);
      client.setForeground(foreground);
      mobileDiagnostics.record("app.lifecycle", { state: mobileDiagnosticAppState(status) });
      if (foreground) void mobileIncomingShare.refresh().catch(() => undefined);
      if (foreground) mobileLocalePreferences.refreshSystemLocale();
      if (!foreground) {
        void mobileComposerDrafts.flush().catch(() => undefined);
        void mobileInteractionDrafts.flush().catch(() => undefined);
        void mobileNewTaskDrafts.flush().catch(() => undefined);
        void mobileDiagnostics.flush().catch(() => undefined);
      }
    });
    const diagnosticTimer = setInterval(() => {
      const nextTick = performance.now();
      if (diagnosticsState === "active" && nextTick - diagnosticsTick > 3_000) {
        mobileDiagnostics.record("js.stall", { elapsedMs: Math.min(86_400_000, Math.round(nextTick - diagnosticsTick - 2_000)) });
      }
      diagnosticsTick = nextTick;
      if (mobileDiagnostics.snapshot.enabled) void mobileDiagnostics.flush().catch(() => undefined);
    }, 2_000);
    const linking = Linking.addEventListener("url", ({ url }) => {
      if (/^joko:\/\/expo-sharing(?:[/?#]|$)/iu.test(url)) {
        void mobileIncomingShare.refresh().catch(() => undefined);
      }
    });
    void Linking.getInitialURL().then((url) => {
      if (url && /^joko:\/\/expo-sharing(?:[/?#]|$)/iu.test(url)) {
        void mobileIncomingShare.refresh().catch(() => undefined);
      }
    }).catch(() => undefined);
    return () => {
      diagnosticsStopped = true;
      clearInterval(diagnosticTimer);
      subscription.remove();
      linking.remove();
      client.setForeground(false);
      void mobileComposerDrafts.flush().catch(() => undefined);
      void mobileInteractionDrafts.flush().catch(() => undefined);
      void mobileNewTaskDrafts.flush().catch(() => undefined);
      void mobileDiagnostics.flush().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!diagnostics.enabled) {
      diagnosticConnectionKeyRef.current = undefined;
      return;
    }
    const key = `${state.status}\u001f${foreground}`;
    if (diagnosticConnectionKeyRef.current === key) return;
    diagnosticConnectionKeyRef.current = key;
    mobileDiagnostics.record("connection.state", { state: state.status, foreground });
  }, [diagnostics.enabled, foreground, state.status]);

  useEffect(() => {
    const batch = incomingShare.batch;
    if (!batch || openedIncomingShareRef.current === batch.batchId || !state.activeProfileId) return;
    openedIncomingShareRef.current = batch.batchId;
    setPage("new");
  }, [incomingShare.batch, state.activeProfileId]);

  useEffect(() => {
    const batch = incomingShare.batch;
    if (!batch || !mobileIncomingShareProfileRetired(
      batch,
      state.activeProfileId,
      state.status === "starting",
      state.saved.map((profile) => profile.profileId)
    )
      || incomingShare.busy) return;
    const retirement = `${batch.batchId}\u001f${state.activeProfileId ?? "forgotten"}`;
    if (retiredIncomingShareRef.current === retirement) return;
    retiredIncomingShareRef.current = retirement;
    void mobileIncomingShare.discard(batch.batchId).catch(() => {
      openedIncomingShareRef.current = undefined;
      if (client.state.activeProfileId) setPage("new");
    });
  }, [incomingShare.batch, incomingShare.busy, state.activeProfileId, state.saved, state.status]);

  useEffect(() => {
    if (!state.activeProfileId && state.status !== "starting") {
      setMenuOpen(false);
      if (page !== "connection") setPage("home");
    }
    if ((page === "task" || page === "files") && !state.selectedId) setPage("home");
    if (page === "files" && state.status === "connected" && !client.canOpenFiles()) {
      client.closeFiles();
      setPage(state.selectedId ? "task" : "home");
    }
    if (page === "device" && !state.owner?.devices.some((device) => device.deviceId === deviceId)) setPage("devices");
  }, [state.status, state.activeProfileId, state.selectedId, state.owner?.devices, deviceId, page]);

  const common = { colors, state, locale: locale.effectiveLocale };
  const connectionRequired = !state.activeProfileId;
  const queueHomeMenuAction = (action: () => void): void => {
    if (pendingHomeMenuActionRef.current) return;
    pendingHomeMenuActionRef.current = action;
    setMenuOpen(false);
  };
  const handleComposerFocused = useCallback(() => setFocusTaskComposer(false), []);
  return (
    <SafeAreaProvider>
      <View style={[styles.root, { backgroundColor: colors.background }]}>
        <StatusBar style={dark ? "light" : "dark"} />
        <View style={styles.fill} accessibilityElementsHidden={homeDrawerMounted}
          importantForAccessibility={homeDrawerMounted ? "no-hide-descendants" : "auto"}>
          {state.status === "starting" || theme.status === "loading" || locale.status === "loading" ? <SafeAreaView style={styles.fill} edges={["top", "left", "right", "bottom"]}>
            <StartupLoading colors={colors} dark={dark} locale={locale.effectiveLocale} />
          </SafeAreaView> :
            connectionRequired || page === "connection" ? <ConnectionScreen {...common} dark={dark}
              onBack={connectionRequired ? undefined : () => { client.cancel(); setPage("home"); }}
              onConnected={() => setPage("home")} /> :
            <SafeAreaView style={styles.fill} edges={["top", "left", "right", "bottom"]}>
              {page === "new" ? <NewTaskScreen {...common} onBack={() => setPage("home")} onCreated={() => setPage("task")} /> :
                page === "task" ? <TaskScreen {...common} onBack={() => setPage("home")} onHome={() => setPage("home")} onNew={() => setPage("new")}
                  onFiles={() => { setFocusTaskComposer(false); setPage("files"); }} focusComposer={focusTaskComposer}
                  onComposerFocused={handleComposerFocused} /> :
                page === "files" ? <FilesScreen {...common} onBack={() => setPage("task")}
                  onAdded={() => {
                    setFocusTaskComposer(true);
                    setPage("task");
                  }} /> :
                page === "automations" ? <MobileAutomationsScreen colors={colors} state={state} client={client}
                  onBack={() => setPage("home")} onOpenTask={() => setPage("task")} /> :
                page === "settings" ? <MobileSettingsScreen colors={colors} state={state} foreground={foreground}
                  theme={theme} locale={locale} diagnostics={diagnostics} client={client}
                  onThemeChange={(preference) => mobileThemePreferences.setPreference(preference)}
                  onLocaleChange={(preference) => mobileLocalePreferences.setPreference(preference)}
                  onDiagnosticsEnabledChange={(enabled) => mobileDiagnostics.setEnabled(enabled)}
                  onDiagnosticsClear={() => mobileDiagnostics.clear()}
                  onDiagnosticsExport={() => mobileDiagnostics.export({
                    appVersion: Constants.expoConfig?.version || "unknown",
                    platform: Platform.OS === "android" || Platform.OS === "ios" ? Platform.OS : "unknown"
                  })}
                  onBack={() => setPage("home")} onConnections={() => setPage("connections")}
                  onDevices={() => setPage("devices")} /> :
                page === "connections" ? <ConnectionsScreen {...common} onBack={() => setPage("home")}
                  onSwitch={() => setPage("connection")} /> :
                page === "devices" ? <DevicesScreen {...common} onBack={() => setPage("home")}
                  onDevice={(id) => { setDeviceId(id); setPage("device"); }} /> :
                page === "device" && deviceId ? <DeviceScreen {...common} deviceId={deviceId} onBack={() => setPage("devices")} /> :
                <SessionsScreen {...common} onNew={() => setPage("new")} onSelect={() => setPage("task")}
                  menuButtonRef={homeMenuButtonRef} searchFocusRequest={homeSearchFocusRequest}
                  onMenu={() => { pendingHomeMenuActionRef.current = undefined; setMenuOpen(true); }} />}
            </SafeAreaView>}
        </View>
        <HomeMenu visible={!connectionRequired && menuOpen} colors={colors} state={state}
          locale={locale.effectiveLocale}
          onClose={() => setMenuOpen(false)}
          onMountedChange={setHomeDrawerMounted}
          onClosed={() => {
            const action = pendingHomeMenuActionRef.current;
            pendingHomeMenuActionRef.current = undefined;
            if (action) action(); else focusNative(homeMenuButtonRef);
          }}
          onSearch={() => queueHomeMenuAction(() => setHomeSearchFocusRequest((value) => value + 1))}
          onAutomations={() => queueHomeMenuAction(() => setPage("automations"))}
          onSwitch={() => queueHomeMenuAction(() => { client.setConnectionMode("saved"); setPage("connection"); })}
          onSettings={() => queueHomeMenuAction(() => setPage("settings"))}
          onDevices={() => queueHomeMenuAction(() => setPage("devices"))} />
      </View>
    </SafeAreaProvider>
  );
}

type Colors = { background: string; surface: string; ink: string; muted: string; border: string; accent: string; negative: string; brandBackground: string };
type ScreenProps = { colors: Colors; state: MobileClient["state"]; locale: MobileSupportedLocale };

function mobileHomeSectionLabels(locale: MobileSupportedLocale) {
  return {
    dialogue: mobileMessage(locale, "home.section.dialogue"),
    project: mobileMessage(locale, "home.section.project"),
    pinned: mobileMessage(locale, "home.section.pinned")
  };
}

function mobileDiagnosticAppState(value: string): "active" | "inactive" | "background" | "unknown" {
  return value === "active" || value === "inactive" || value === "background" ? value : "unknown";
}

function mobileComposerRichTheme(colors: Colors) {
  return {
    background: colors.surface,
    border: colors.border,
    chip: colors.brandBackground,
    focus: colors.accent,
    placeholder: colors.muted,
    text: colors.ink,
    textSecondary: colors.muted
  };
}

function ConnectionScreen({ colors, state, locale, dark, onBack, onConnected }: ScreenProps & {
  dark: boolean; onBack?: () => void; onConnected: () => void;
}) {
  const [origin, setOrigin] = useState(state.candidate?.origin ?? "");
  const [deviceName, setDeviceName] = useState(`${Platform.OS === "ios" ? "iPhone/iPad" : "Android"} Joko`);
  const [code, setCode] = useState("");
  const [inspected, setInspected] = useState(false);
  const [localError, setLocalError] = useState("");
  const [newAutomatic, setNewAutomatic] = useState(false);
  const [savedAutomaticChoices, setSavedAutomaticChoices] = useState<Record<string, boolean>>({});
  const [artworkGroupIndex, setArtworkGroupIndex] = useState(0);
  const [artworkVariant, setArtworkVariant] = useState<ConnectionArtworkVariant>("base");
  const theme = dark ? "dark" : "light";
  const artwork = mobileConnectionArtworkFrame(artworkGroupIndex, artworkVariant, theme);
  const appIcon = mobileConnectionAppIcon(theme);
  const inspect = async () => {
    setLocalError("");
    try { await client.inspect(origin); setInspected(true); } catch (error) { setLocalError(errorText(error, locale)); setInspected(false); }
  };
  const pair = async () => {
    setLocalError("");
    try { await client.pair(origin, code, deviceName, newAutomatic); setCode(""); onConnected(); } catch (error) { setLocalError(errorText(error, locale)); }
  };
  useEffect(() => {
    if (state.busy || state.connectionAttemptError) return;
    if (state.connectionMode === "nearby") void client.refreshNearby();
    if (state.connectionMode === "saved") void client.refreshSaved();
  }, [state.connectionMode, state.busy, state.connectionAttemptError]);
  const selectNearby = (node: NearbyMobileNode) => {
    setOrigin(node.origin);
    setCode("");
    setInspected(false);
    setLocalError("");
    void client.inspectNearby(node).then(() => setInspected(true)).catch((error) => setLocalError(errorText(error, locale)));
  };
  const selectMode = (mode: MobileClient["state"]["connectionMode"]) => {
    setInspected(false);
    setCode("");
    setLocalError("");
    client.setConnectionMode(mode);
  };
  const forget = (profile: SavedMobileConnection) => Alert.alert(
    mobileMessage(locale, "connection.forgetTitle", { name: profile.displayName }),
    mobileMessage(locale, "connection.forgetBody"),
    [{ text: mobileMessage(locale, "common.keep"), style: "cancel" },
      { text: mobileMessage(locale, "common.forget"), style: "destructive", onPress: () => {
      setLocalError("");
      void client.forgetConnection(profile.profileId).catch((error) => setLocalError(errorText(error, locale)));
    } }]
  );
  return <MobileConnectionStage
    artworkId={artwork.id}
    artworkSource={artwork.source}
    iconSource={appIcon}
    locale={locale}
    colors={{ brandBackground: colors.brandBackground, ink: colors.ink, muted: colors.muted }}
    onArtworkPress={() => setArtworkVariant((current) => current === "base" ? "alt" : "base")}
    onIconPress={() => { setArtworkGroupIndex((current) => nextConnectionArtworkGroupIndex(current)); setArtworkVariant("base"); }}
  >
    {onBack && !state.busy && <Back label="Joko" accessibilityLabel={mobileMessage(locale, "common.backTo", { label: "Joko" })}
      onPress={onBack} colors={colors} />}
    <Text style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, "connection.title")}</Text>
    <Text style={[styles.description, { color: colors.muted }]}>{mobileMessage(locale, "connection.description")}</Text>
    <View style={[styles.modeTabs, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <ModeTab label={mobileMessage(locale, "connection.mode.nearby")} selected={state.connectionMode === "nearby"}
        onPress={() => selectMode("nearby")} colors={colors} />
      <ModeTab label={state.saved.length
        ? mobileMessage(locale, "connection.mode.savedCount", { count: state.saved.length })
        : mobileMessage(locale, "connection.mode.saved")} selected={state.connectionMode === "saved"}
        onPress={() => selectMode("saved")} colors={colors} />
      <ModeTab label={mobileMessage(locale, "connection.mode.add")} selected={state.connectionMode === "add"}
        onPress={() => selectMode("add")} colors={colors} />
    </View>
    {state.status === "revoked" && <Banner text={state.error || mobileMessage(locale, "connection.repair")} colors={colors} />}
    {state.automaticProfileId && <View style={[styles.notice, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.fill}><Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "connection.automaticEntry")}</Text>
        <Text style={[styles.label, { color: colors.ink }]}>{state.saved.find((item) => item.profileId === state.automaticProfileId)?.displayName
          || mobileMessage(locale, "connection.missingSaved")}</Text></View>
      <Action label={mobileMessage(locale, "common.turnOff")} compact disabled={state.busy}
        onPress={() => void client.disableAutomaticEntry().catch((error) => setLocalError(errorText(error, locale)))} colors={colors} />
    </View>}
    {state.connectionMode === "nearby" && <>
      <View style={styles.sectionHeader}><Text style={[styles.section, { color: colors.muted }]}>{mobileMessage(locale, "connection.nearbyTitle")}</Text>
        <Action label={mobileMessage(locale, state.discoveryState === "refreshing" ? "common.refreshing" : "common.refresh")} compact
          disabled={state.busy || state.discoveryState === "refreshing"} onPress={() => void client.refreshNearby()} colors={colors} /></View>
      {state.discoveryState === "refreshing" && state.nearby.length === 0 && <ActivityIndicator color={colors.accent} />}
      {state.discoveryError && <Banner text={state.discoveryError} colors={colors} />}
      {state.discoveryState !== "refreshing" && state.nearby.length === 0 && <Text style={[styles.description, { color: colors.muted }]}>{mobileMessage(locale, "connection.nearbyEmpty")}</Text>}
      {state.nearby.map((nearby) => <Pressable key={`${nearby.serverId}:${nearby.origin}`} accessibilityRole="button"
        accessibilityLabel={mobileMessage(locale, "connection.pairWith", { name: nearby.displayName })} onPress={() => selectNearby(nearby)}
        style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.fill}><Text style={[styles.label, { color: colors.ink }]}>{nearby.displayName}</Text>
          <Text selectable style={[styles.caption, { color: colors.muted }]}>{nearby.origin}</Text>
          <Text style={[styles.caption, { color: colors.muted }]}>{nearby.pairingEnabled
            ? mobileMessage(locale, "connection.pairingAvailable") : mobileMessage(locale, "connection.pairingClosed")} · v{nearby.version
              || mobileMessage(locale, "common.unknown")}</Text></View>
        <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
      </Pressable>)}
    </>}
    {state.connectionMode === "saved" && <>
      <View style={styles.sectionHeader}><Text style={[styles.section, { color: colors.muted }]}>{mobileMessage(locale, "connection.savedTitle")}</Text>
        <Action label={mobileMessage(locale, "connection.recheck")} compact disabled={state.busy || state.saved.some((profile) => profile.credentialState === "checking")}
          onPress={() => void client.refreshSaved()} colors={colors} /></View>
      {state.saved.length === 0 && <Text style={[styles.description, { color: colors.muted }]}>{mobileMessage(locale, "connection.savedEmpty")}</Text>}
      {state.saved.map((profile) => {
        const automatic = savedAutomaticChoices[profile.profileId] ?? profile.automatic;
        return <View key={profile.profileId} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.statusTitle}><Text style={[styles.label, { color: colors.ink }]}>{profile.displayName}</Text>
          {profile.automatic && <Text style={[styles.badge, { color: colors.ink, backgroundColor: colors.brandBackground }]}>{mobileMessage(locale, "connection.automaticEntry")}</Text>}</View>
        <Text selectable style={[styles.caption, { color: colors.muted }]}>{profile.origin}</Text>
        <Text selectable style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "connection.identity", { id: profile.serverId })}</Text>
        <Text style={[styles.caption, { color: profile.credentialState === "available" ? colors.muted : colors.negative }]}>{savedStatus(profile, locale)}</Text>
        {profile.error && <Text accessibilityRole="alert" style={[styles.caption, { color: colors.negative }]}>{profile.error}</Text>}
        <SavedPendingOperations profile={profile} colors={colors} locale={locale} />
        <AutomaticEntryChoice checked={automatic} disabled={state.busy || state.status === "connecting"}
          onPress={() => setSavedAutomaticChoices((choices) => ({ ...choices, [profile.profileId]: !automatic }))}
          colors={colors} locale={locale} />
        <View style={styles.actionRow}>
          <Action label={mobileMessage(locale, state.status === "connecting" ? "common.connecting" : "common.connect")} onPress={() => {
            setLocalError("");
            void client.connectSaved(profile.profileId, automatic).then(() => {
              if (client.state.activeProfileId === profile.profileId) onConnected();
            }).catch((error) => setLocalError(errorText(error, locale)));
          }} colors={colors} disabled={state.busy || state.status === "connecting" || profile.credentialState === "checking"} />
          <Action label={mobileMessage(locale, "common.forget")} onPress={() => forget(profile)} colors={colors} danger disabled={state.busy} />
        </View>
      </View>;
      })}
    </>}
    {state.connectionMode === "add" && <>
      <AutomaticEntryChoice checked={newAutomatic} disabled={state.busy || state.status === "connecting"}
        onPress={() => setNewAutomatic((value) => !value)} colors={colors} locale={locale} />
      <Field label={mobileMessage(locale, "connection.address")} value={origin}
        onChange={(value) => { setOrigin(value); setInspected(false); client.cancel(); }}
        placeholder="http://192.168.1.20:4318" colors={colors} autoCapitalize="none" keyboardType="url" />
      {origin.trim().startsWith("http://") && <Text style={[styles.warning, { color: colors.negative }]}>{mobileMessage(locale, "connection.httpWarning")}</Text>}
      <Action label={mobileMessage(locale, state.busy ? "connection.checking" : "connection.checkIdentity")}
        onPress={inspect} colors={colors} disabled={state.busy || !origin.trim()} />
      {inspected && state.candidate && <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.label, { color: colors.ink }]}>{state.candidate.node.displayName}</Text>
        <Text selectable style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "connection.identity", { id: state.candidate.node.serverId })}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "connection.candidateSummary", {
          version: state.candidate.node.version || mobileMessage(locale, "common.unknown"),
          api: state.candidate.node.apiVersion,
          pairing: mobileMessage(locale, state.candidate.node.pairingEnabled ? "connection.pairingAvailable" : "connection.pairingClosed")
        })}</Text>
      </View>}
      {inspected && state.candidate?.node.pairingEnabled && <>
        <Field label={mobileMessage(locale, "connection.deviceName")} value={deviceName} onChange={setDeviceName}
          placeholder={mobileMessage(locale, "connection.devicePlaceholder")} colors={colors} />
        <Action label={mobileMessage(locale, state.busy ? "connection.requesting" : "connection.requestPairing")} onPress={() => {
          setLocalError(""); void client.requestPairing(origin, deviceName).catch((error) => setLocalError(errorText(error, locale)));
        }} colors={colors} disabled={state.busy || !deviceName.trim()} />
        {state.challenge && <>
          <Text style={[styles.description, { color: colors.muted }]}>{mobileMessage(locale, "connection.challenge")}</Text>
          <Field label={mobileMessage(locale, "connection.pairingCode")} value={code} onChange={setCode}
            placeholder={mobileMessage(locale, "connection.pairingCodePlaceholder")} colors={colors} keyboardType="number-pad" />
          <Action label={mobileMessage(locale, state.busy ? "connection.pairing" : "connection.pairDevice")}
            onPress={pair} colors={colors} disabled={state.busy || !code.trim()} />
        </>}
      </>}
    </>}
    {(localError || state.connectionAttemptError || (!state.activeProfileId && state.error)) &&
      <Banner text={localError || state.connectionAttemptError || state.error || ""} colors={colors} />}
  </MobileConnectionStage>;
}

function SessionsScreen({ colors, state, locale, onNew, onSelect, onMenu, menuButtonRef, searchFocusRequest }: ScreenProps & {
  onNew: () => void; onSelect: () => void; onMenu: () => void;
  menuButtonRef: RefObject<View | null>; searchFocusRequest: number;
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<MobileHomeStatusFilter>("active");
  const [localError, setLocalError] = useState("");
  const [optionsSession, setOptionsSession] = useState<Session>();
  const optionsSessionRef = useRef<Session | undefined>(undefined);
  const optionsGenerationRef = useRef(0);
  const [renameSession, setRenameSession] = useState<Session>();
  const [renameDraft, setRenameDraft] = useState("");
  const searchRef = useRef<TextInput>(null);
  const swipeRegistry = useMemo(() => createSwipeRowRegistry(), []);
  const normalizedSearch = search.trim();
  const currentMessageIds = useMemo(() => (
    state.homeSearchQuery === normalizedSearch && state.homeSearchFilter === statusFilter
      ? new Set(state.homeSearchSessionIds) : new Set<string>()
  ), [normalizedSearch, state.homeSearchFilter, state.homeSearchQuery, state.homeSearchSessionIds, statusFilter]);
  const sections = useMemo(() => buildMobileHomeSections({
    snapshot: state.owner,
    statusFilter,
    query: search,
    messageSessionIds: currentMessageIds,
    labels: mobileHomeSectionLabels(locale)
  }), [currentMessageIds, locale, search, state.owner, statusFilter]);
  const listSections = useMemo(() => sections.map((section) => ({ ...section, data: section.items })), [sections]);

  useEffect(() => {
    if (searchFocusRequest > 0) searchRef.current?.focus();
  }, [searchFocusRequest]);
  useEffect(() => {
    if (!normalizedSearch) {
      void client.searchHome("", statusFilter);
      return;
    }
    const timer = setTimeout(() => { void client.searchHome(normalizedSearch, statusFilter); }, 180);
    return () => clearTimeout(timer);
  }, [normalizedSearch, state.activeProfileId, state.owner?.snapshotId, state.owner?.revision?.value, statusFilter]);

  const runMutation = (action: () => Promise<boolean>): void => {
    if (state.status !== "connected") return;
    setLocalError("");
    void action().catch((error) => setLocalError(errorText(error, locale)));
  };
  const togglePin = (session: Session): void => runMutation(() => client.setSessionPinned(session.sessionId, !session.pinned));
  const toggleArchive = (session: Session): void => runMutation(() => client.setSessionArchived(session.sessionId, !session.archived));
  const openOptions = (session: Session): void => {
    if (state.status !== "connected") return;
    optionsGenerationRef.current += 1;
    optionsSessionRef.current = session;
    setOptionsSession(session);
  };
  const closeOptions = (): void => {
    optionsGenerationRef.current += 1;
    optionsSessionRef.current = undefined;
    setOptionsSession(undefined);
  };
  const applyOption = (session: Session, action: SessionOption): void => {
    if (action === "rename") {
      setRenameDraft(session.displayName);
      setRenameSession(session);
    } else if (action === "pin") togglePin(session);
    else if (action === "archive") toggleArchive(session);
    else Alert.alert(
      mobileMessage(locale, "home.deleteTitle", { name: session.displayName || mobileMessage(locale, "home.untitledTask") }),
      mobileMessage(locale, "home.deleteBody"),
      [{ text: mobileMessage(locale, "common.cancel"), style: "cancel" },
        { text: mobileMessage(locale, "common.deleteTask"), style: "destructive", onPress: () => runMutation(() => client.deleteSession(session.sessionId)) }]
    );
  };
  const scheduleOption = (action: SessionOption): void => {
    if (state.status !== "connected") {
      closeOptions();
      return;
    }
    const session = optionsSessionRef.current;
    if (!session) return;
    const generation = ++optionsGenerationRef.current;
    optionsSessionRef.current = undefined;
    setOptionsSession(undefined);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (optionsGenerationRef.current === generation && optionsSessionRef.current === undefined) applyOption(session, action);
    }));
  };
  useEffect(() => {
    if (state.status === "connected") return;
    swipeRegistry.closeOpenRow();
    optionsGenerationRef.current += 1;
    optionsSessionRef.current = undefined;
    setOptionsSession(undefined);
    setRenameSession(undefined);
  }, [state.status, swipeRegistry]);

  return <View style={styles.fill}>
    <View style={styles.homeHeader}>
      <Pressable ref={menuButtonRef} accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "home.openMenu")} onPress={onMenu}
        style={[styles.headerIconButton, { borderColor: colors.border, backgroundColor: colors.surface }]}>
        <Text style={[styles.headerIcon, { color: colors.ink }]}>☰</Text>
      </Pressable>
      <View style={styles.homeTitle}>
        <Text style={[styles.homeTitleText, { color: colors.ink }]} numberOfLines={1}>{state.node?.displayName || "Joko"}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "common.tasks")}</Text>
      </View>
      <Action label={mobileMessage(locale, "common.new")} onPress={onNew} colors={colors} compact disabled={state.status !== "connected"} />
    </View>
    {(state.status === "connecting" || state.status === "offline") && <View
      accessibilityRole="alert"
      style={[styles.connectionNotice, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <View style={[styles.statusDot, { backgroundColor: state.status === "connecting" ? colors.accent : colors.negative }]} />
      <View style={styles.fill}>
        <Text style={[styles.label, { color: colors.ink }]}>{mobileMessage(locale,
          state.status === "connecting" ? "home.reconnecting" : "home.offline")}</Text>
        {state.offlineSnapshotAt !== undefined && <Text style={[styles.caption, { color: colors.muted }]}>
          {mobileMessage(locale, "home.offlineSummary", {
            age: mobileOfflineAgeLabel(state.offlineSnapshotAt, Date.now(), locale)
          })}
        </Text>}
        {state.error && <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={2}>{state.error}</Text>}
      </View>
      {state.status === "offline" && <Action label={mobileMessage(locale, "common.retry")}
        onPress={() => void client.refresh()} colors={colors} compact />}
    </View>}
    {state.status === "connected" && state.error && <Banner text={state.error} colors={colors} />}
    <View style={styles.searchRow}>
      <TextInput ref={searchRef} accessibilityLabel={mobileMessage(locale, "home.search")}
        placeholder={mobileMessage(locale, "home.search")}
        placeholderTextColor={colors.muted} value={search} onChangeText={setSearch}
        style={[styles.input, styles.searchInput, { color: colors.ink, backgroundColor: colors.surface, borderColor: colors.border }]} />
      {state.homeSearchStatus === "searching" && normalizedSearch && <ActivityIndicator color={colors.accent} />}
    </View>
    <View accessibilityRole="tablist" style={styles.filterRow}>
      {(["active", "archived", "all"] as const).map((filter) => <Pressable key={filter} accessibilityRole="tab"
        accessibilityState={{ selected: filter === statusFilter }} onPress={() => setStatusFilter(filter)}
        style={[styles.filterChip, { borderColor: filter === statusFilter ? colors.accent : colors.border,
          backgroundColor: filter === statusFilter ? colors.brandBackground : colors.surface }]}>
        <Text style={[styles.caption, { color: colors.ink }]}>{mobileMessage(locale, `home.filter.${filter}`)}</Text>
      </Pressable>)}
    </View>
    {state.homeSearchError && normalizedSearch && <Banner text={state.homeSearchError} colors={colors} />}
    {localError && <Banner text={localError} colors={colors} />}
    <PendingReceipts items={state.pending.filter((item) => ["rename", "pin", "archive", "delete"].includes(item.kind))}
      colors={colors} locale={locale} disabled={state.status !== "connected"} onError={setLocalError} />
    <SectionList sections={listSections} keyExtractor={(item) => item.session.sessionId}
      renderSectionHeader={({ section }) => <Text style={[styles.listSectionTitle, { color: colors.muted }]}>{section.title}</Text>}
      ListEmptyComponent={<Centered label={mobileMessage(locale, state.offlineSnapshotAt !== undefined
        ? "home.empty.offline" : state.status !== "connected" ? "home.empty.reconnect" : normalizedSearch
          ? "home.empty.search" : statusFilter === "archived" ? "home.empty.archived" : "home.empty.default")} colors={colors} />}
      renderItem={({ item }) => <SwipeableSessionRow session={item.session} registry={swipeRegistry} colors={colors} locale={locale}
        onTogglePin={togglePin} onArchive={toggleArchive} onShowOptions={openOptions}
        disabled={state.status !== "connected"}>
        <View style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Pressable disabled={state.busy} accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "home.openTask", {
            name: item.session.displayName || mobileMessage(locale, "home.untitled")
          })}
            onPress={() => {
              if (swipeRegistry.closeOpenRow()) return;
              setLocalError("");
              void client.select(item.session.sessionId).then(onSelect).catch((error) => setLocalError(errorText(error, locale)));
            }} style={styles.sessionRowBody}>
            <View style={styles.fill}><View style={styles.statusTitle}>
              <Text style={[styles.label, { color: colors.ink }]} numberOfLines={1}>{item.session.displayName
                || mobileMessage(locale, "home.untitledTask")}</Text>
              {item.session.pinned && <Text style={[styles.badge, { color: colors.ink, backgroundColor: colors.brandBackground }]}>{mobileMessage(locale, "common.pinned")}</Text>}
            </View>
              <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>{item.targetName} · {sessionState(item.session.state, locale)}</Text></View>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "home.optionsFor", {
            name: item.session.displayName || mobileMessage(locale, "home.untitledTask")
          })}
            accessibilityState={{ disabled: state.status !== "connected" }} disabled={state.status !== "connected"}
            onPress={() => { swipeRegistry.closeOpenRow(); openOptions(item.session); }} style={styles.rowOptions}>
            <Text style={[styles.rowOptionsText, { color: colors.muted }]}>•••</Text>
          </Pressable>
        </View>
      </SwipeableSessionRow>}
      refreshing={state.status === "connecting"} onRefresh={() => void client.refresh()}
      onScrollBeginDrag={() => { swipeRegistry.closeOpenRow(); }}
      contentContainerStyle={styles.list} />
    <Modal visible={state.status === "connected" && optionsSession !== undefined} transparent animationType="none"
      onRequestClose={closeOptions} statusBarTranslucent>
      <View style={styles.sheetRoot}>
        <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "home.closeOptions")}
          onPress={closeOptions} style={styles.modalBackdrop} />
        <SafeAreaView accessibilityViewIsModal style={[styles.optionSheet, { backgroundColor: colors.surface, borderColor: colors.border }]} edges={["bottom", "left", "right"]}>
          <Text style={[styles.label, { color: colors.ink }]} numberOfLines={1}>{optionsSession?.displayName
            || mobileMessage(locale, "home.taskOptions")}</Text>
          <MenuRow label={mobileMessage(locale, "common.rename")} onPress={() => scheduleOption("rename")} colors={colors} />
          <MenuRow label={mobileMessage(locale, optionsSession?.pinned ? "common.unpin" : "common.pin")}
            onPress={() => scheduleOption("pin")} colors={colors} />
          <MenuRow label={mobileMessage(locale, optionsSession?.archived ? "common.restore" : "common.archive")}
            onPress={() => scheduleOption("archive")} colors={colors} />
          <MenuRow label={mobileMessage(locale, "common.deleteTask")} onPress={() => scheduleOption("delete")} colors={colors} />
          <Action label={mobileMessage(locale, "common.cancel")} onPress={closeOptions} colors={colors} />
        </SafeAreaView>
      </View>
    </Modal>
    <Modal visible={state.status === "connected" && renameSession !== undefined} transparent animationType="fade"
      onRequestClose={() => setRenameSession(undefined)} statusBarTranslucent>
      <View style={styles.dialogRoot}>
        <View accessibilityViewIsModal style={[styles.renameDialog, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, "home.renameTitle")}</Text>
          <Field label={mobileMessage(locale, "home.taskName")} value={renameDraft} onChange={setRenameDraft}
            placeholder={mobileMessage(locale, "home.taskName")} colors={colors} />
          <View style={styles.actionRow}>
            <Action label={mobileMessage(locale, "common.cancel")} onPress={() => setRenameSession(undefined)} colors={colors} />
            <Action label={mobileMessage(locale, "common.rename")} disabled={state.status !== "connected" || !renameDraft.trim() || state.busy} onPress={() => {
              const target = renameSession;
              if (!target) return;
              setRenameSession(undefined);
              runMutation(() => client.renameSession(target.sessionId, renameDraft));
            }} colors={colors} />
          </View>
        </View>
      </View>
    </Modal>
  </View>;
}

type SessionOption = "rename" | "pin" | "archive" | "delete";

function HomeMenu({ visible, colors, state, locale, onClose, onClosed, onMountedChange, onSearch, onAutomations, onSwitch, onSettings, onDevices }: ScreenProps & {
  visible: boolean; onClose: () => void; onClosed: () => void; onMountedChange: (mounted: boolean) => void;
  onSearch: () => void; onAutomations: () => void; onSwitch: () => void; onSettings: () => void; onDevices: () => void;
}) {
  const { width } = useWindowDimensions();
  const closeRef = useRef<View>(null);
  return <MobileDrawer visible={visible} width={Math.min(380, width * 0.84)} backgroundColor={colors.surface}
    borderColor={colors.border} onClose={onClose} onClosed={onClosed} onMountedChange={onMountedChange}
    initialFocusRef={closeRef} locale={locale} testID="home.drawer">
      <SafeAreaView style={styles.homeDrawer} edges={["top", "bottom", "left"]}>
        <View style={styles.drawerHeading}>
          <View style={styles.drawerTitleRow}><View style={styles.fill}><Text style={[styles.title, { color: colors.ink }]}>Joko</Text>
            <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={2}>
              {state.node?.displayName || mobileMessage(locale, "home.menu.nodeFallback")}{state.origin ? `\n${state.origin}` : ""}
            </Text></View>
            <Pressable ref={closeRef} accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "home.menu.close")}
              onPress={onClose} style={styles.drawerClose}>
              <Text style={[styles.headerIcon, { color: colors.ink }]}>×</Text>
            </Pressable>
          </View>
        </View>
        <MenuRow label={mobileMessage(locale, "common.search")} description={mobileMessage(locale, "home.menu.searchDescription")}
          onPress={onSearch} colors={colors} />
        <MenuRow label={mobileMessage(locale, "home.menu.automations")}
          description={mobileMessage(locale, "home.menu.automationsDescription")} onPress={onAutomations} colors={colors} />
        <MenuRow label={mobileMessage(locale, "home.menu.switch")} description={mobileMessage(locale, "home.menu.switchDescription")}
          onPress={onSwitch} colors={colors} />
        <MenuRow label={mobileMessage(locale, "common.devices")} description={mobileMessage(locale, "home.menu.devicesDescription")}
          onPress={onDevices} colors={colors} />
        <MenuRow label={mobileMessage(locale, "settings.title")} description={mobileMessage(locale, "home.menu.settingsDescription")}
          onPress={onSettings} colors={colors} />
        <View style={styles.drawerSpacer} />
      </SafeAreaView>
  </MobileDrawer>;
}

function MenuRow({ label, description, onPress, colors }: {
  label: string; description?: string; onPress: () => void; colors: Colors;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
    style={[styles.menuRow, { borderColor: colors.border }]}>
    <View style={styles.fill}>
      <Text style={[styles.label, { color: colors.ink }]}>{label}</Text>
      {description && <Text style={[styles.caption, { color: colors.muted }]}>{description}</Text>}
    </View>
    <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
  </Pressable>;
}

function ConnectionsScreen({ colors, state, locale, onBack, onSwitch }: ScreenProps & { onBack: () => void; onSwitch: () => void }) {
  const [localError, setLocalError] = useState("");
  const currentConnectionId = state.saved.find((profile) => profile.profileId === state.activeProfileId)?.connectionId;
  const logout = (connectionId: string, name: string) => Alert.alert(
    mobileMessage(locale, "connections.logoutTitle", { name }),
    mobileMessage(locale, "connections.logoutBody"),
    [{ text: mobileMessage(locale, "common.cancel"), style: "cancel" },
      { text: mobileMessage(locale, "common.logOut"), style: "destructive", onPress: () => {
      setLocalError("");
      void client.logoutConnection(connectionId).catch((error) => setLocalError(errorText(error, locale)));
    } }]
  );
  const forget = (profile: SavedMobileConnection) => Alert.alert(
    mobileMessage(locale, "connections.forgetTitle", { name: profile.displayName }),
    mobileMessage(locale, "connections.forgetBody"),
    [{ text: mobileMessage(locale, "common.cancel"), style: "cancel" },
      { text: mobileMessage(locale, "common.forget"), style: "destructive", onPress: () => {
      setLocalError("");
      void client.forgetConnection(profile.profileId).catch((error) => setLocalError(errorText(error, locale)));
    } }]
  );
  return <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
    <Back label="Joko" accessibilityLabel={mobileMessage(locale, "common.backTo", { label: "Joko" })}
      onPress={onBack} colors={colors} />
    <Text style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, "connections.title")}</Text>
    <Text style={[styles.description, { color: colors.muted }]}>{mobileMessage(locale, "connections.description")}</Text>
    <Text style={[styles.section, { color: colors.muted }]}>{mobileMessage(locale, "connections.currentNode")}</Text>
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.label, { color: colors.ink }]}>{state.node?.displayName || mobileMessage(locale, "connections.nodeFallback")}</Text>
      <Text selectable style={[styles.caption, { color: colors.muted }]}>{state.origin || mobileMessage(locale, "connections.addressUnavailable")}</Text>
      <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, state.status === "connected"
        ? "connections.state.connected" : state.status === "connecting" ? "settings.connection.reconnecting" : "settings.connection.offline")}</Text>
      <Action label={mobileMessage(locale, "connections.switch")} colors={colors} onPress={onSwitch} />
    </View>
    {state.automaticProfileId && <View style={[styles.notice, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.fill}><Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "connection.automaticEntry")}</Text>
        <Text style={[styles.label, { color: colors.ink }]}>{state.saved.find((profile) => profile.profileId === state.automaticProfileId)?.displayName
          || mobileMessage(locale, "connection.missingSaved")}</Text></View>
      <Action label={mobileMessage(locale, "common.turnOff")} compact colors={colors} disabled={state.busy}
        onPress={() => void client.disableAutomaticEntry().catch((error) => setLocalError(errorText(error, locale)))} />
    </View>}
    {!state.automaticProfileId && state.status === "connected" && <Action label={mobileMessage(locale, "connections.useCurrentAutomatically")} colors={colors}
      onPress={() => void client.setAutomaticEntryForActive(true).catch((error) => setLocalError(errorText(error, locale)))} />}
    <Text style={[styles.section, { color: colors.muted }]}>{mobileMessage(locale, "connections.savedOnPhone")}</Text>
    {state.saved.map((profile) => <View key={profile.profileId} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.statusTitle}><Text style={[styles.label, { color: colors.ink }]}>{profile.displayName}</Text>
        {profile.profileId === state.activeProfileId && <Text style={[styles.badge, { color: colors.ink, backgroundColor: colors.brandBackground }]}>{mobileMessage(locale, "common.current")}</Text>}</View>
      <Text selectable style={[styles.caption, { color: colors.muted }]}>{profile.origin}</Text>
      <Text selectable style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "connections.profile", { id: profile.profileId })}</Text>
      <SavedPendingOperations profile={profile} colors={colors} locale={locale} />
      <Action label={mobileMessage(locale, "connections.forgetLocally")} colors={colors} danger disabled={state.busy} onPress={() => forget(profile)} />
    </View>)}
    <Text style={[styles.section, { color: colors.muted }]}>{mobileMessage(locale, "connections.issuedByNode")}</Text>
    {(state.owner?.connections ?? []).map((connection) => {
      const device = state.owner?.devices.find((candidate) => candidate.deviceId === connection.deviceId);
      const name = connection.displayName || device?.displayName || mobileMessage(locale, "connections.fallbackName");
      return <View key={connection.connectionId} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.statusTitle}><Text style={[styles.label, { color: colors.ink }]}>{name}</Text>
          {connection.connectionId === currentConnectionId && <Text style={[styles.badge, { color: colors.ink, backgroundColor: colors.brandBackground }]}>{mobileMessage(locale, "common.current")}</Text>}</View>
        <Text style={[styles.caption, { color: colors.muted }]}>{connectionStateLabel(connection.state, locale)} · {device?.platform
          || mobileMessage(locale, "common.unknownPlatform")}</Text>
        <Text selectable style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "connections.connection", { id: connection.connectionId })}</Text>
        {connection.state === ConnectionState.CONNECTED && <Action label={mobileMessage(locale, "common.logOut")} colors={colors} danger disabled={state.busy || state.status !== "connected"}
          onPress={() => logout(connection.connectionId, name)} />}
      </View>;
    })}
    <PendingReceipts items={state.pending.filter((item) => item.kind === "logout")} colors={colors}
      locale={locale} disabled={state.status !== "connected"} onError={setLocalError} />
    {(localError || state.error) && <Banner text={localError || state.error || ""} colors={colors} />}
  </ScrollView>;
}

function DevicesScreen({ colors, state, locale, onBack, onDevice }: ScreenProps & {
  onBack: () => void; onDevice: (deviceId: string) => void;
}) {
  const devices = state.owner?.devices ?? [];
  const currentDeviceId = state.saved.find((profile) => profile.profileId === state.activeProfileId)?.deviceId;
  return <View style={styles.fill}>
    <View style={styles.stackHeader}>
      <Back label="Joko" accessibilityLabel={mobileMessage(locale, "common.backTo", { label: "Joko" })}
        onPress={onBack} colors={colors} />
      <Text style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, "common.devices")}</Text>
    </View>
    {state.status !== "connected" && <View style={[styles.connectionNotice, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={[styles.statusDot, { backgroundColor: state.status === "connecting" ? colors.accent : colors.negative }]} />
      <Text style={[styles.caption, styles.fill, { color: colors.muted }]}>{mobileMessage(locale, "devices.reconnecting")}</Text>
    </View>}
    <FlatList data={devices} keyExtractor={(device) => device.deviceId} contentContainerStyle={styles.list}
      ListEmptyComponent={<Centered label={mobileMessage(locale, "devices.empty")} colors={colors} />}
      renderItem={({ item: device }) => {
        return <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "devices.open", { name: device.displayName })}
          onPress={() => onDevice(device.deviceId)} style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.fill}>
            <View style={styles.statusTitle}>
              <Text style={[styles.label, { color: colors.ink }]}>{device.displayName}</Text>
              {device.deviceId === currentDeviceId && <Text style={[styles.badge, { color: colors.ink, backgroundColor: colors.brandBackground }]}>{mobileMessage(locale, "devices.thisPhone")}</Text>}
            </View>
            <Text style={[styles.caption, { color: colors.muted }]}>{deviceStatusLabel(device.revoked, device.presence, locale)} · {device.platform
              || mobileMessage(locale, "common.unknownPlatform")}</Text>
          </View>
          <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
        </Pressable>;
      }} />
  </View>;
}

function DeviceScreen({ colors, state, locale, deviceId, onBack }: ScreenProps & { deviceId: string; onBack: () => void }) {
  const [localError, setLocalError] = useState("");
  const device = state.owner?.devices.find((candidate) => candidate.deviceId === deviceId);
  const activeDeviceId = state.saved.find((profile) => profile.profileId === state.activeProfileId)?.deviceId;
  if (!device) return <View style={styles.screen}><Back label={mobileMessage(locale, "common.devices")} onPress={onBack} colors={colors}
    accessibilityLabel={mobileMessage(locale, "common.backTo", { label: mobileMessage(locale, "common.devices") })} />
    <Text style={[styles.description, { color: colors.muted }]}>{mobileMessage(locale, "devices.missing")}</Text></View>;
  const revoke = () => Alert.alert(
    mobileMessage(locale, "devices.revokeTitle", { name: device.displayName }),
    mobileMessage(locale, "devices.revokeBody"),
    [{ text: mobileMessage(locale, "common.cancel"), style: "cancel" },
      { text: mobileMessage(locale, "common.revokeDevice"), style: "destructive", onPress: () => {
      setLocalError("");
      void client.revokeDevice(device.deviceId).catch((error) => setLocalError(errorText(error, locale)));
    } }]
  );
  return <ScrollView contentContainerStyle={styles.screen}>
    <Back label={mobileMessage(locale, "common.devices")} onPress={onBack} colors={colors}
      accessibilityLabel={mobileMessage(locale, "common.backTo", { label: mobileMessage(locale, "common.devices") })} />
    <Text style={[styles.title, { color: colors.ink }]}>{device.displayName}</Text>
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <InformationRow label={mobileMessage(locale, "common.status")} value={deviceStatusLabel(device.revoked, device.presence, locale)} colors={colors} />
      <InformationRow label={mobileMessage(locale, "devices.kind")} value={deviceKindLabel(device.kind, locale)} colors={colors} />
      <InformationRow label={mobileMessage(locale, "common.platform")} value={device.platform || mobileMessage(locale, "common.unknown")} colors={colors} />
      <InformationRow label={mobileMessage(locale, "settings.appVersion")} value={device.appVersion || mobileMessage(locale, "common.unknown")} colors={colors} />
      <InformationRow label={mobileMessage(locale, "devices.lastSeen")} value={timestampLabel(device.lastSeenAt, locale)} colors={colors} />
      <InformationRow label={mobileMessage(locale, "settings.deviceId")} value={device.deviceId} colors={colors} selectable />
    </View>
    {device.deviceId === activeDeviceId
      ? <Text style={[styles.description, { color: colors.muted }]}>{mobileMessage(locale, "devices.currentConnection")}</Text>
      : !device.revoked && <Action label={mobileMessage(locale, "common.revokeDevice")} colors={colors} danger
        disabled={state.busy || state.status !== "connected"} onPress={revoke} />}
    <PendingReceipts items={state.pending.filter((item) => item.kind === "revoke" && item.targetDeviceId === device.deviceId)}
      colors={colors} locale={locale} disabled={state.status !== "connected"} onError={setLocalError} />
    {(localError || state.error) && <Banner text={localError || state.error || ""} colors={colors} />}
  </ScrollView>;
}

function PendingReceipts({ items, colors, locale, disabled = false, onError }: {
  items: MobileClient["state"]["pending"]; colors: Colors; locale: MobileSupportedLocale;
  disabled?: boolean; onError: (message: string) => void;
}) {
  return <>{items.map((item) => <View key={item.operationId} style={styles.pendingReceipt}>
    <Text style={[styles.warning, { color: colors.negative }]}>
      {mobileMessage(locale, item.state === "unknown" ? "receipt.resultUnknown" : "receipt.awaiting")} · {item.operationId}
    </Text>
    <View style={styles.actionRow}>
      <Action label={mobileMessage(locale, "receipt.check")} compact colors={colors} disabled={disabled}
        onPress={() => void client.reconcile().catch((error) => onError(errorText(error, locale)))} />
      {item.state === "unknown" && <Action label={mobileMessage(locale, "receipt.verify")} compact colors={colors}
        disabled={disabled} onPress={() => Alert.alert(
        mobileMessage(locale, "receipt.clearTitle"),
        mobileMessage(locale, "receipt.clearBody"),
        [{ text: mobileMessage(locale, "receipt.keepChecking"), style: "cancel" },
          { text: mobileMessage(locale, "receipt.verify"), onPress: () => {
          void client.dismissUnconfirmed(item.operationId).catch((error) => onError(errorText(error, locale)));
        } }]
      )} />}
    </View>
  </View>)}</>;
}

function SavedPendingOperations({ profile, colors, locale }: {
  profile: SavedMobileConnection; colors: Colors; locale: MobileSupportedLocale;
}) {
  if (profile.pendingOperations.length === 0) return null;
  return <Text accessibilityRole="alert" selectable style={[styles.warning, { color: colors.negative, paddingHorizontal: 0 }]}>
    {mobileMessage(locale, "connection.retainedOperations", {
      count: profile.pendingOperations.length,
      ids: profile.pendingOperations.map((item) => item.operationId).join(", ")
    })}
  </Text>;
}

function NewTaskScreen({ colors, state, locale, onBack, onCreated }: ScreenProps & { onBack: () => void; onCreated: () => void }) {
  const incomingShareState = useSyncExternalStore(
    (listener) => mobileIncomingShare.subscribe(listener),
    () => mobileIncomingShare.snapshot
  );
  const initialIdentity = state.activeProfileId ? { profileId: state.activeProfileId } : undefined;
  const initialDraft = initialIdentity ? mobileNewTaskDrafts.readSync(initialIdentity) : null;
  const [draft, setDraft] = useState(() => ({
    targetId: initialDraft?.targetId ?? "",
    name: initialDraft?.name ?? "",
    input: initialDraft?.input ?? emptyMobileComposerDraft()
  }));
  const [composerSelection, setComposerSelection] = useState<MobileComposerSelection>(() => ({
    start: initialDraft?.input.text.length ?? 0,
    end: initialDraft?.input.text.length ?? 0
  }));
  const [loadedProfileId, setLoadedProfileId] = useState<string | undefined>();
  const [draftReady, setDraftReady] = useState(false);
  const [error, setError] = useState("");
  const [incomingShareNotice, setIncomingShareNotice] = useState("");
  const [imageOutputNotice, setImageOutputNotice] = useState("");
  const [sessionMentionsVisible, setSessionMentionsVisible] = useState(false);
  const [sessionMentionError, setSessionMentionError] = useState("");
  const [workspaceMentionsVisible, setWorkspaceMentionsVisible] = useState(false);
  const [mentionBusy, setMentionBusy] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [pastedImageCount, setPastedImageCount] = useState(0);
  const [photoLibraryLease, setPhotoLibraryLease] = useState<MobilePhotoLibraryLease>();
  const [imageEditorLease, setImageEditorLease] = useState<MobileComposerImageEditorLease>();
  const [composerAtomId, setComposerAtomId] = useState<string>();
  const [composerHeight, setComposerHeight] = useState(132);
  const mountedRef = useRef(true);
  const composerInputRef = useRef<MobileComposerRichInputHandle>(null);
  const profileId = state.activeProfileId;
  const profileIdRef = useRef(profileId);
  profileIdRef.current = profileId;
  const identity = profileId ? { profileId } : undefined;
  const retained = identity ? mobileNewTaskDrafts.readSync(identity)?.submission : undefined;
  const pendingCreate = state.pending.some((item) => item.kind === "create");
  const targets = state.owner?.targets.filter((target) => target.state === TargetState.ACTIVE &&
    state.owner?.backends.some((backend) => backend.backendId === target.backendId
      && backend.capabilities?.capabilities.some((capability) => capability.name === capabilityNames.inputText && capability.support === CapabilitySupport.SUPPORTED))) ?? [];
  const targetAvailable = targets.some((target) => target.targetId === draft.targetId);
  const voiceTransport = client.newTaskVoiceTransport(draft.targetId);
  const sessionMentionControls = client.newTaskSessionMentionControls(draft.targetId);
  const workspaceMentionControls = client.newTaskWorkspaceMentionControls(draft.targetId);
  const attachmentControls = client.newTaskAttachmentControls(draft.targetId);
  const sessionMentionOwnerRef = useRef(sessionMentionControls?.surfaceOwnerKey);
  const workspaceMentionOwnerRef = useRef(workspaceMentionControls?.surfaceOwnerKey);
  const attachmentOwnerRef = useRef(attachmentControls?.surfaceOwnerKey);
  const attachmentGenerationRef = useRef(0);
  const attachmentNativeActivityRef = useRef(false);
  const attachmentAbortRef = useRef<AbortController | undefined>(undefined);
  const imagePasteLeaseRef = useRef<MobileNewTaskImagePasteLease | undefined>(undefined);
  const photoLibraryLeaseRef = useRef<MobilePhotoLibraryLease | undefined>(undefined);
  const imageEditorLeaseRef = useRef<MobileComposerImageEditorLease | undefined>(undefined);
  const draftRef = useRef(draft);
  const selectionRef = useRef(composerSelection);
  const referencesEditableRef = useRef(false);
  const composerTheme = useMemo(() => mobileComposerRichTheme(colors), [colors]);
  draftRef.current = draft;
  selectionRef.current = composerSelection;
  const closeImageEditor = useCallback(() => {
    const lease = imageEditorLeaseRef.current;
    if (!lease) return;
    client.cancelComposerImageEditor(lease.session.leaseId);
    imageEditorLeaseRef.current = undefined;
    setImageEditorLease(undefined);
    attachmentNativeActivityRef.current = false;
    attachmentGenerationRef.current += 1;
    attachmentOwnerRef.current = client.newTaskAttachmentControls(draftRef.current.targetId)?.surfaceOwnerKey;
    setAttachmentBusy(false);
  }, []);
  const patchDraft = (patch: Partial<typeof draft>): void => {
    setDraft((current) => {
      const next = { ...current, ...patch };
      draftRef.current = next;
      if (identity) mobileNewTaskDrafts.save(identity, next);
      return next;
    });
  };
  const replaceInput = (input: MobileComposerDraft, selection: MobileComposerSelection): void => {
    const next = { ...draftRef.current, input };
    draftRef.current = next;
    selectionRef.current = selection;
    setDraft(next);
    setComposerSelection(selection);
    if (identity) mobileNewTaskDrafts.save(identity, next);
  };
  useEffect(() => mobileNewTaskDrafts.subscribeErrors((failedIdentity, failure) => {
    if (mountedRef.current && failedIdentity.profileId === profileId) setError(failure.message);
  }), [profileId]);
  useEffect(() => {
    mountedRef.current = true;
    if (!identity) {
      const input = emptyMobileComposerDraft();
      imagePasteLeaseRef.current = undefined;
      setPastedImageCount(0);
      setDraft({ targetId: "", name: "", input });
      setComposerSelection({ start: 0, end: 0 });
      setLoadedProfileId(undefined);
      setComposerAtomId(undefined);
      setDraftReady(true);
      return () => { mountedRef.current = false; };
    }
    let current = true;
    const cached = mobileNewTaskDrafts.readSync(identity);
    const cachedInput = cached?.input ?? emptyMobileComposerDraft();
    setDraft({ targetId: cached?.targetId ?? "", name: cached?.name ?? "", input: cachedInput });
    setComposerSelection({ start: cachedInput.text.length, end: cachedInput.text.length });
    setLoadedProfileId(profileId);
    setComposerAtomId(undefined);
    setDraftReady(false);
    void mobileNewTaskDrafts.read(identity).then((stored) => {
      if (!current || !mountedRef.current || state.activeProfileId !== identity.profileId) return;
      const input = stored?.input ?? emptyMobileComposerDraft();
      const next = { targetId: stored?.targetId ?? "", name: stored?.name ?? "", input };
      draftRef.current = next;
      setDraft(next);
      setComposerSelection({ start: input.text.length, end: input.text.length });
      setLoadedProfileId(identity.profileId);
      setDraftReady(true);
    }).catch((failure) => {
      if (!current || !mountedRef.current) return;
      setDraftReady(true);
      setError(errorText(failure));
    });
    return () => {
      current = false;
      mountedRef.current = false;
      attachmentAbortRef.current?.abort();
      attachmentNativeActivityRef.current = false;
      imagePasteLeaseRef.current = undefined;
      photoLibraryLeaseRef.current = undefined;
      if (imageEditorLeaseRef.current) {
        client.cancelComposerImageEditor(imageEditorLeaseRef.current.session.leaseId);
        imageEditorLeaseRef.current = undefined;
      }
      void mobileNewTaskDrafts.flush(identity).catch(() => undefined);
    };
  }, [profileId]);
  useEffect(() => {
    const next = sessionMentionControls?.surfaceOwnerKey;
    const changed = sessionMentionOwnerRef.current !== next;
    sessionMentionOwnerRef.current = next;
    if (changed || next === undefined) {
      setSessionMentionsVisible(false);
      setSessionMentionError("");
      setMentionBusy(false);
    }
  }, [sessionMentionControls?.surfaceOwnerKey]);
  useEffect(() => {
    const next = workspaceMentionControls?.surfaceOwnerKey;
    const changed = workspaceMentionOwnerRef.current !== next;
    workspaceMentionOwnerRef.current = next;
    if (changed || next === undefined) {
      setWorkspaceMentionsVisible(false);
      setMentionBusy(false);
    }
  }, [workspaceMentionControls?.surfaceOwnerKey]);
  useEffect(() => {
    const next = attachmentControls?.surfaceOwnerKey;
    const observed = observeMobileAttachmentAuthority(
      attachmentOwnerRef.current,
      next,
      attachmentNativeActivityRef.current
    );
    attachmentOwnerRef.current = observed.surfaceOwnerKey;
    if (observed.retired) {
      attachmentAbortRef.current?.abort();
      attachmentAbortRef.current = undefined;
      attachmentNativeActivityRef.current = false;
      imagePasteLeaseRef.current = undefined;
      setPastedImageCount(0);
      photoLibraryLeaseRef.current = undefined;
      setPhotoLibraryLease(undefined);
      if (imageEditorLeaseRef.current) {
        client.cancelComposerImageEditor(imageEditorLeaseRef.current.session.leaseId);
        imageEditorLeaseRef.current = undefined;
        setImageEditorLease(undefined);
      }
      attachmentGenerationRef.current += 1;
      setAttachmentBusy(false);
    }
  }, [attachmentControls?.surfaceOwnerKey]);
  useEffect(() => {
    const lease = imagePasteLeaseRef.current;
    if (!lease) return;
    const scopeMatches = profileId === lease.profileId && draft.targetId === lease.targetId;
    if (scopeMatches && state.status === "connected" && AppState.currentState === "active") return;
    lease.controller.abort();
    if (attachmentAbortRef.current === lease.controller) attachmentAbortRef.current = undefined;
    imagePasteLeaseRef.current = undefined;
    attachmentNativeActivityRef.current = false;
    attachmentGenerationRef.current += 1;
    setPastedImageCount(0);
    setAttachmentBusy(false);
  }, [draft.targetId, profileId, state.status]);
  useEffect(() => {
    const lease = photoLibraryLeaseRef.current;
    if (!lease) return;
    const scopeKey = profileId && draft.targetId ? `${profileId}\u001f${draft.targetId}` : "";
    if (scopeKey === lease.scopeKey && state.status !== "revoked" && state.status !== "unpaired") return;
    lease.controller.abort();
    attachmentAbortRef.current = undefined;
    attachmentNativeActivityRef.current = false;
    photoLibraryLeaseRef.current = undefined;
    setPhotoLibraryLease(undefined);
    attachmentGenerationRef.current += 1;
    setAttachmentBusy(false);
  }, [draft.targetId, profileId, state.status]);
  useEffect(() => {
    const lease = imageEditorLeaseRef.current;
    if (!lease) return;
    const scopeKey = profileId && draft.targetId ? `${profileId}\u001f${draft.targetId}` : "";
    if (lease.scopeKey === scopeKey && state.status === "connected") return;
    closeImageEditor();
  }, [closeImageEditor, draft.targetId, profileId, state.status]);
  const ownerReady = identity !== undefined && loadedProfileId === profileId && draftReady;
  const voice = useMobileVoiceInput({
    transport: voiceTransport,
    draftOwnerKey: profileId === undefined ? undefined : `new-task\u001f${profileId}`,
    enabled: ownerReady && targetAvailable && state.status === "connected" && !state.busy
      && !mentionBusy && !attachmentBusy && retained === undefined,
    readDraft: () => draftRef.current.input,
    readSelection: () => selectionRef.current,
    writeDraft: (input, selection, persist) => {
      const next = { ...draftRef.current, input };
      draftRef.current = next;
      selectionRef.current = selection;
      setDraft(next);
      setComposerSelection(selection);
      const currentProfileId = profileIdRef.current;
      if (!persist || !currentProfileId) return;
      const currentIdentity = { profileId: currentProfileId };
      mobileNewTaskDrafts.save(currentIdentity, next);
      void mobileNewTaskDrafts.flush(currentIdentity).catch((failure) => {
        if (mountedRef.current && profileIdRef.current === currentProfileId) setError(errorText(failure));
      });
    },
    onError: setError,
    locale,
    requestId: randomUUID
  });
  useMobileVoicePermissionSettings(voice.error, locale);
  useEffect(() => {
    if (!voice.busy) return;
    setSessionMentionsVisible(false);
    setWorkspaceMentionsVisible(false);
    setSessionMentionError("");
  }, [voice.busy]);
  const referencesEditable = ownerReady && !state.busy && !mentionBusy && !attachmentBusy && !voice.busy
    && retained === undefined;
  referencesEditableRef.current = referencesEditable;
  const incomingShareBatch = incomingShareState.batch;
  const incomingSharePlan = useMemo(() => incomingShareBatch?.status === "ready"
    && incomingShareBatch.boundProfileId === profileId && attachmentControls
    ? planMobileIncomingShare(incomingShareBatch, draft.input.attachments, attachmentControls.policy)
    : undefined, [attachmentControls, draft.input.attachments, incomingShareBatch, profileId]);
  const incomingShareClaimCurrent = incomingShareBatch?.status === "ready" && incomingShareBatch.claim
    && incomingSharePlan && attachmentControls
    ? mobileIncomingShareClaimMatches(incomingShareBatch, draft.targetId, attachmentControls, incomingSharePlan)
    : undefined;
  const insertSessionMention = (candidate: MobileSessionMentionCandidate): void => {
    const controls = sessionMentionControls;
    const targetId = draft.targetId;
    const ownerProfileId = profileId;
    if (!controls || sessionMentionOwnerRef.current !== controls.surfaceOwnerKey || !referencesEditable) {
      setSessionMentionsVisible(false);
      setSessionMentionError("");
      setError(mobileMessage(locale, "task.error.taskReferenceChanged"));
      return;
    }
    const ownerKey = controls.surfaceOwnerKey;
    setMentionBusy(true);
    setSessionMentionError("");
    void client.validateNewTaskSessionMentionCandidate(targetId, ownerKey, candidate).then((current) => {
      if (!mountedRef.current || profileIdRef.current !== ownerProfileId || draftRef.current.targetId !== targetId
        || sessionMentionOwnerRef.current !== ownerKey) {
        throw new Error(mobileMessage(locale, "task.error.taskReferenceChecking"));
      }
      const result = insertMobileSessionMention(draftRef.current.input, selectionRef.current, current, randomUUID());
      replaceInput(result.draft, result.selection);
      setSessionMentionsVisible(false);
      setTimeout(() => composerInputRef.current?.focus(), 0);
    }).catch((failure) => {
      if (mountedRef.current && sessionMentionOwnerRef.current === ownerKey) {
        setSessionMentionError(errorText(failure));
      }
    }).finally(() => {
      if (mountedRef.current && sessionMentionOwnerRef.current === ownerKey) setMentionBusy(false);
    });
  };
  const insertWorkspaceMention = async (
    surfaceOwnerKey: string,
    candidate: MobileWorkspaceMentionCandidate,
    lineRange?: MobileWorkspaceLineRange
  ): Promise<void> => {
    const targetId = draftRef.current.targetId;
    const ownerProfileId = profileIdRef.current;
    const controls = workspaceMentionControls;
    if (!controls || controls.surfaceOwnerKey !== surfaceOwnerKey
      || workspaceMentionOwnerRef.current !== surfaceOwnerKey || !referencesEditable) {
      setWorkspaceMentionsVisible(false);
      throw new Error(mobileMessage(locale, "task.error.workspaceReferenceChanged"));
    }
    if (lineRange !== undefined && !controls.policy.lineRanges) {
      throw new Error(mobileMessage(locale, "task.error.workspaceLineUnsupported"));
    }
    const current = await client.validateNewTaskWorkspaceMentionCandidate(
      targetId,
      surfaceOwnerKey,
      candidate
    );
    if (!mountedRef.current || profileIdRef.current !== ownerProfileId || draftRef.current.targetId !== targetId
      || workspaceMentionOwnerRef.current !== surfaceOwnerKey) {
      setWorkspaceMentionsVisible(false);
      throw new Error(mobileMessage(locale, "task.error.workspaceChecking"));
    }
    const result = insertMobileWorkspaceMention(draftRef.current.input, selectionRef.current, {
      ...current,
      ...(lineRange === undefined ? {} : { lineRange })
    }, randomUUID());
    replaceInput(result.draft, result.selection);
    setWorkspaceMentionsVisible(false);
    setTimeout(() => composerInputRef.current?.focus(), 0);
  };
  const removeMention = (mentionId: string): void => {
    try {
      const result = removeMobileComposerMention(draftRef.current.input, mentionId);
      replaceInput(result.draft, result.selection);
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  const pasteClipboardText = async (request?: MobileComposerRichPasteRequest): Promise<void> => {
    const ownerProfileId = profileIdRef.current;
    const captured = request?.draft ?? draftRef.current.input;
    const selection = request?.selection ?? selectionRef.current;
    const targetId = draftRef.current.targetId;
    const ownerSnapshot = client.state.owner;
    const workspacePathControls = client.newTaskWorkspacePathPasteControls(targetId);
    if (!ownerProfileId || !referencesEditableRef.current || AppState.currentState !== "active") {
      setError(mobileMessage(locale, "task.error.returnActiveNewTaskPaste"));
      return;
    }
    setError("");
    try {
      const text = request?.text ?? await Clipboard.getStringAsync();
      if (!mountedRef.current || profileIdRef.current !== ownerProfileId
        || draftRef.current.targetId !== targetId || draftRef.current.input !== captured
        || selectionRef.current.start !== selection.start || selectionRef.current.end !== selection.end
        || !referencesEditableRef.current || client.state.activeProfileId !== ownerProfileId
        || client.state.owner !== ownerSnapshot
        || client.state.status === "unpaired" || client.state.status === "revoked"
        || AppState.currentState !== "active") {
        throw new Error(mobileMessage(locale, "task.error.newTaskClipboardChanged"));
      }
      const pathCandidates = workspacePathControls !== undefined && !isLongMobileComposerPaste(text)
        ? findMobileComposerWorkspacePathCandidates(text, workspacePathControls.serverPathDisplay)
        : [];
      let pathResolutions = [] as Awaited<ReturnType<typeof client.validateNewTaskWorkspacePathPasteCandidates>>;
      if (workspacePathControls !== undefined && pathCandidates.length > 0) {
        try {
          pathResolutions = await client.validateNewTaskWorkspacePathPasteCandidates(
            targetId,
            workspacePathControls.surfaceOwnerKey,
            pathCandidates.map((candidate) => candidate.relativePath)
          );
        } catch (failure) {
          if (client.newTaskWorkspacePathPasteControls(targetId)?.surfaceOwnerKey
            !== workspacePathControls.surfaceOwnerKey) throw failure;
          pathResolutions = [];
        }
        if (!mountedRef.current || profileIdRef.current !== ownerProfileId
          || draftRef.current.targetId !== targetId || draftRef.current.input !== captured
          || selectionRef.current.start !== selection.start || selectionRef.current.end !== selection.end
          || !referencesEditableRef.current || client.state.activeProfileId !== ownerProfileId
          || client.state.owner !== ownerSnapshot
          || client.newTaskWorkspacePathPasteControls(targetId)?.surfaceOwnerKey
            !== workspacePathControls.surfaceOwnerKey
          || client.state.status !== "connected" || AppState.currentState !== "active") {
          throw new Error(mobileMessage(locale, "task.error.newTaskWorkspaceChanged"));
        }
      }
      const result = insertMobileStructuredClipboardText(
        captured,
        selection,
        text,
        () => randomUUID(),
        workspacePathControls === undefined ? {} : {
          workspacePath: {
            workspaceId: workspacePathControls.workspaceId,
            serverPathDisplay: workspacePathControls.serverPathDisplay,
            resolutions: pathResolutions
          }
        }
      );
      replaceInput(result.draft, result.selection);
      setTimeout(() => composerInputRef.current?.focus(), 0);
      if (result.insertedAtomIds.length > 0) {
        void enrichMobileComposerRouteReferences(
          result.draft,
          result.selection,
          result.insertedAtomIds,
          (target) => client.resolveComposerRouteReference(target)
        ).then((resolved) => {
          if (mobileComposerDraftsEqual(resolved.draft, result.draft)) return;
          if (!mountedRef.current || profileIdRef.current !== ownerProfileId
            || draftRef.current.targetId !== targetId || draftRef.current.input !== result.draft
            || selectionRef.current.start !== result.selection.start
            || selectionRef.current.end !== result.selection.end
            || !referencesEditableRef.current || client.state.activeProfileId !== ownerProfileId
            || client.state.owner !== ownerSnapshot
            || client.state.status !== "connected" || AppState.currentState !== "active") return;
          replaceInput(resolved.draft, resolved.selection);
        }).catch(() => undefined);
      }
    } catch (failure) {
      if (mountedRef.current && profileIdRef.current === ownerProfileId) setError(errorText(failure));
    }
  };
  const startClipboardImagePaste = (request: MobileComposerRichImagePasteStartRequest): boolean => {
    const controls = attachmentControls;
    const ownerProfileId = profileIdRef.current;
    const current = draftRef.current;
    if (!controls || !ownerProfileId || controls.profileId !== ownerProfileId || !controls.policy.images
      || request.draft !== current.input || request.count > controls.policy.maximumItems - current.input.attachments.length
      || attachmentOwnerRef.current !== controls.surfaceOwnerKey || !referencesEditableRef.current
      || imagePasteLeaseRef.current !== undefined || attachmentNativeActivityRef.current
      || client.state.activeProfileId !== ownerProfileId || client.state.status !== "connected"
      || client.state.busy || AppState.currentState !== "active") return false;
    const generation = ++attachmentGenerationRef.current;
    const controller = new AbortController();
    const snapshot = mobileNewTaskDrafts.readSnapshot({ profileId: ownerProfileId });
    void snapshot.catch(() => undefined);
    const lease: MobileNewTaskImagePasteLease = {
      count: request.count,
      controller,
      controls,
      draft: current,
      generation,
      profileId: ownerProfileId,
      snapshot,
      targetId: current.targetId
    };
    imagePasteLeaseRef.current = lease;
    attachmentAbortRef.current = controller;
    attachmentNativeActivityRef.current = true;
    setSessionMentionsVisible(false);
    setWorkspaceMentionsVisible(false);
    setAttachmentBusy(true);
    setPastedImageCount(request.count);
    setError("");
    return true;
  };
  const cancelClipboardImagePaste = (sourceDraft: MobileComposerDraft): void => {
    const lease = imagePasteLeaseRef.current;
    if (!lease || lease.draft.input !== sourceDraft) return;
    lease.controller.abort();
    imagePasteLeaseRef.current = undefined;
    if (attachmentAbortRef.current === lease.controller) attachmentAbortRef.current = undefined;
    attachmentNativeActivityRef.current = false;
    attachmentGenerationRef.current += 1;
    setPastedImageCount(0);
    setAttachmentBusy(false);
  };
  const pasteClipboardImages = async (request: MobileComposerRichImagePasteRequest): Promise<void> => {
    const lease = imagePasteLeaseRef.current;
    if (!lease || request.draft !== lease.draft.input || request.count !== request.images.length
      || request.count !== lease.count) {
      if (lease) cancelClipboardImagePaste(lease.draft.input);
      setError(mobileMessage(locale, "task.error.clipboardBatchNewTask"));
      return;
    }
    try {
      const result = await commitMobileComposerImagePaste({
        buildDraft: (input) => ({ targetId: lease.draft.targetId, name: lease.draft.name, input }),
        files: mobileAttachmentFiles,
        flush: () => mobileNewTaskDrafts.flush({ profileId: lease.profileId }),
        imagePaste: mobileComposerImagePaste,
        input: lease.draft.input,
        newId: randomUUID,
        payloads: request.images,
        policy: lease.controls.policy,
        profileId: lease.profileId,
        readBackMatches: (committed) => {
          const retainedDraft = mobileNewTaskDrafts.readSync({ profileId: lease.profileId });
          return retainedDraft !== null && retainedDraft.submission === undefined
            && sameMobileNewTaskEditableDraft(retainedDraft, committed);
        },
        saveIfRevision: (next, revision) => mobileNewTaskDrafts.saveIfRevision(
          { profileId: lease.profileId },
          next,
          revision
        ),
        signal: lease.controller.signal,
        snapshot: lease.snapshot,
        snapshotMatches: (stored) => stored !== undefined && stored.submission === undefined
          && sameMobileNewTaskEditableDraft(stored, lease.draft),
        validateAuthority: () => {
          const latest = client.newTaskAttachmentControls(lease.targetId);
          if (!mountedRef.current || imagePasteLeaseRef.current !== lease
            || attachmentGenerationRef.current !== lease.generation
            || attachmentAbortRef.current !== lease.controller || lease.controller.signal.aborted
            || profileIdRef.current !== lease.profileId || draftRef.current !== lease.draft
            || client.state.activeProfileId !== lease.profileId || client.state.status !== "connected"
            || client.state.busy || AppState.currentState !== "active"
            || attachmentOwnerRef.current !== lease.controls.surfaceOwnerKey
            || !sameMobileAttachmentControls(latest, lease.controls)) {
            throw new Error(mobileMessage(locale, "task.error.clipboardAttachmentChanged"));
          }
        }
      });
      if (!mountedRef.current || imagePasteLeaseRef.current !== lease
        || attachmentGenerationRef.current !== lease.generation || profileIdRef.current !== lease.profileId) return;
      draftRef.current = result.draft;
      setDraft(result.draft);
      setComposerSelection(selectionRef.current);
    } catch (failure) {
      if (mountedRef.current && profileIdRef.current === lease.profileId) {
        const retainedDraft = mobileNewTaskDrafts.readSync({ profileId: lease.profileId });
        if (retainedDraft !== null && retainedDraft.submission === undefined) {
          const recovered = {
            targetId: retainedDraft.targetId,
            name: retainedDraft.name,
            input: retainedDraft.input
          };
          const selection = boundedComposerSelection(selectionRef.current, recovered.input.text.length);
          draftRef.current = recovered;
          selectionRef.current = selection;
          setDraft(recovered);
          setComposerSelection(selection);
        }
        if (attachmentGenerationRef.current === lease.generation) setError(errorText(failure));
      }
    } finally {
      if (imagePasteLeaseRef.current === lease) imagePasteLeaseRef.current = undefined;
      if (attachmentAbortRef.current === lease.controller) attachmentAbortRef.current = undefined;
      if (mountedRef.current && attachmentGenerationRef.current === lease.generation) {
        attachmentNativeActivityRef.current = false;
        setPastedImageCount(0);
        setAttachmentBusy(false);
      }
    }
  };
  const removeComposerAtom = (atomId: string): void => {
    try {
      const result = removeMobileComposerAtom(draftRef.current.input, atomId);
      replaceInput(result.draft, result.selection);
      setComposerAtomId(undefined);
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  const savePastedTextAtom = (atomId: string, text: string): void => {
    try {
      const result = updateMobilePastedTextAtom(draftRef.current.input, atomId, text);
      replaceInput(result.draft, result.selection);
      setComposerAtomId(undefined);
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  const addAttachments = async (source: "picker" | "camera" | "photos"): Promise<void> => {
    const controls = attachmentControls;
    const ownerProfileId = profileIdRef.current;
    const targetId = draftRef.current.targetId;
    if (!controls || !ownerProfileId || controls.profileId !== ownerProfileId
      || attachmentOwnerRef.current !== controls.surfaceOwnerKey || !referencesEditable
      || attachmentNativeActivityRef.current) {
      const sourceName = mobileMessage(locale, source === "camera" ? "attachments.source.camera"
        : source === "photos" ? "attachments.source.photos" : "attachments.source.filePicker");
      setError(mobileMessage(locale, "task.error.attachmentReopenNewTask", { source: sourceName }));
      return;
    }
    const generation = ++attachmentGenerationRef.current;
    const controller = new AbortController();
    attachmentAbortRef.current = controller;
    attachmentNativeActivityRef.current = true;
    setSessionMentionsVisible(false);
    setWorkspaceMentionsVisible(false);
    setAttachmentBusy(true);
    setError("");
    let staged: readonly MobileComposerAttachment[] = [];
    try {
      staged = source === "camera"
        ? await mobileAttachmentCamera.captureAndStage(
            ownerProfileId,
            draftRef.current.input.attachments,
            controls.policy,
            randomUUID,
            controller.signal
          )
        : source === "photos"
          ? await mobilePhotoLibrary.pickSystemAndStage(
              ownerProfileId,
              draftRef.current.input.attachments,
              controls.policy,
              randomUUID,
              controller.signal
            )
          : await mobileAttachmentFiles.pickAndStage(
            ownerProfileId,
            draftRef.current.input.attachments,
            controls.policy,
            randomUUID,
            controller.signal
          );
      if (staged.length === 0) return;
      const latest = await waitForMobileAttachmentAuthority(
        { profileId: ownerProfileId, surfaceOwnerKey: controls.surfaceOwnerKey },
        () => client.newTaskAttachmentControls(targetId),
        (listener) => client.subscribe(() => listener()),
        {
          signal: controller.signal,
          retired: () => {
            const current = client.state;
            return profileIdRef.current !== ownerProfileId || draftRef.current.targetId !== targetId
              || current.activeProfileId !== ownerProfileId
              || current.status === "revoked" || current.status === "unpaired"
              || AppState.currentState === "active" && current.status === "connected"
                && client.newTaskAttachmentControls(targetId) === undefined;
          }
        }
      );
      if (!mountedRef.current || attachmentGenerationRef.current !== generation
        || profileIdRef.current !== ownerProfileId || draftRef.current.targetId !== targetId
        || latest.profileId !== ownerProfileId || latest.surfaceOwnerKey !== controls.surfaceOwnerKey
        || attachmentOwnerRef.current !== controls.surfaceOwnerKey) {
        throw new Error(mobileMessage(locale, "task.error.selectedMediaChanged"));
      }
      const input = {
        ...draftRef.current.input,
        attachments: appendMobileComposerAttachments(
          draftRef.current.input.attachments,
          staged,
          latest.policy
        )
      };
      replaceInput(input, selectionRef.current);
      staged = [];
      await mobileNewTaskDrafts.flush(identity);
    } catch (failure) {
      await Promise.all(staged.map((attachment) => mobileAttachmentFiles.remove(ownerProfileId, attachment)
        .catch(() => undefined)));
      if (mountedRef.current && attachmentGenerationRef.current === generation) setError(errorText(failure));
    } finally {
      if (attachmentAbortRef.current === controller) {
        attachmentAbortRef.current = undefined;
        attachmentNativeActivityRef.current = false;
        if (mountedRef.current && attachmentGenerationRef.current === generation) setAttachmentBusy(false);
      }
    }
  };
  const bindIncomingShare = async (batch: MobileIncomingShareReadyBatch): Promise<void> => {
    const ownerProfileId = profileIdRef.current;
    if (!ownerProfileId || !ownerReady || state.status !== "connected" || AppState.currentState !== "active") {
      setError(mobileMessage(locale, "incoming.connectForeground"));
      return;
    }
    setError("");
    setIncomingShareNotice("");
    try {
      await mobileIncomingShare.bind(batch.batchId, ownerProfileId);
    } catch (failure) {
      if (mountedRef.current) setError(errorText(failure));
    }
  };
  const discardIncomingShare = async (batchId: string): Promise<void> => {
    setError("");
    setIncomingShareNotice("");
    try {
      await mobileIncomingShare.discard(batchId);
      if (mountedRef.current) setIncomingShareNotice(mobileMessage(locale, "incoming.discarded"));
    } catch (failure) {
      if (mountedRef.current) setError(errorText(failure));
    }
  };
  const importIncomingShare = async (batch: MobileIncomingShareReadyBatch): Promise<void> => {
    const controls = attachmentControls;
    const ownerProfileId = profileIdRef.current;
    const targetId = draftRef.current.targetId;
    if (!controls || !ownerProfileId || controls.profileId !== ownerProfileId
      || batch.boundProfileId !== ownerProfileId || attachmentOwnerRef.current !== controls.surfaceOwnerKey
      || !referencesEditable || attachmentNativeActivityRef.current || AppState.currentState !== "active") {
      setError(mobileMessage(locale, "incoming.authorityChanged"));
      return;
    }
    const generation = ++attachmentGenerationRef.current;
    const controller = new AbortController();
    attachmentAbortRef.current = controller;
    attachmentNativeActivityRef.current = true;
    setSessionMentionsVisible(false);
    setWorkspaceMentionsVisible(false);
    setAttachmentBusy(true);
    setError("");
    setIncomingShareNotice("");
    try {
      const preview = planMobileIncomingShare(batch, draftRef.current.input.attachments, controls.policy);
      const claimedBatch = await mobileIncomingShare.claim(
        batch.batchId,
        ownerProfileId,
        targetId,
        controls,
        preview
      );
      const claimId = claimedBatch.claim?.claimId;
      if (!claimId) throw new Error(mobileMessage(locale, "incoming.claimUnavailable"));
      const result = await commitMobileIncomingShare({
        batch: claimedBatch,
        profileId: ownerProfileId,
        targetId,
        controls,
        draftStore: mobileNewTaskDrafts,
        attachmentFiles: mobileAttachmentFiles,
        signal: controller.signal,
        validateAuthority: async () => {
          const latest = await waitForMobileAttachmentAuthority(
            { profileId: ownerProfileId, surfaceOwnerKey: controls.surfaceOwnerKey },
            () => client.newTaskAttachmentControls(targetId),
            (listener) => client.subscribe(() => listener()),
            {
              signal: controller.signal,
              retired: () => {
                const current = client.state;
                return profileIdRef.current !== ownerProfileId || draftRef.current.targetId !== targetId
                  || current.activeProfileId !== ownerProfileId
                  || current.status === "revoked" || current.status === "unpaired"
                  || AppState.currentState !== "active"
                  || current.status === "connected" && client.newTaskAttachmentControls(targetId) === undefined;
              }
            }
          );
          if (!mountedRef.current || attachmentGenerationRef.current !== generation
            || profileIdRef.current !== ownerProfileId || draftRef.current.targetId !== targetId
            || attachmentOwnerRef.current !== controls.surfaceOwnerKey) {
            throw new Error(mobileMessage(locale, "incoming.authorityAdding"));
          }
          return latest;
        },
        acknowledge: () => mobileIncomingShare.acknowledge(batch.batchId, ownerProfileId, claimId)
      });
      if (!mountedRef.current || profileIdRef.current !== ownerProfileId
        || attachmentGenerationRef.current !== generation) return;
      const next = { targetId: result.draft.targetId, name: result.draft.name, input: result.draft.input };
      draftRef.current = next;
      setDraft(next);
      setIncomingShareNotice([
        result.plan.accepted.length > 0
          ? mobileMessage(locale, "incoming.result", {
            verb: mobileMessage(locale, result.replayed ? "incoming.confirmed" : "incoming.added"),
            count: result.plan.accepted.length,
            files: mobileMessage(locale, result.plan.accepted.length === 1 ? "incoming.file" : "incoming.files")
          })
          : mobileMessage(locale, "incoming.noneAdded"),
        result.plan.rejected.length > 0
          ? mobileMessage(locale, "incoming.skipped", {
            count: result.plan.rejected.length,
            items: mobileMessage(locale, result.plan.rejected.length === 1 ? "incoming.itemWas" : "incoming.itemsWere")
          })
          : ""
      ].filter(Boolean).join(" "));
    } catch (failure) {
      const retainedDraft = mobileNewTaskDrafts.readSync({ profileId: ownerProfileId });
      if (mountedRef.current && profileIdRef.current === ownerProfileId && retainedDraft
        && retainedDraft.submission === undefined) {
        const next = { targetId: retainedDraft.targetId, name: retainedDraft.name, input: retainedDraft.input };
        draftRef.current = next;
        setDraft(next);
      }
      if (mountedRef.current && attachmentGenerationRef.current === generation) setError(errorText(failure));
    } finally {
      if (attachmentAbortRef.current === controller) {
        attachmentAbortRef.current = undefined;
        attachmentNativeActivityRef.current = false;
        if (mountedRef.current && attachmentGenerationRef.current === generation) setAttachmentBusy(false);
      }
    }
  };
  const openPhotoLibrary = (): void => {
    if (!canBrowseMobilePhotoLibraryDirectly(Platform.OS)) {
      void addAttachments("photos");
      return;
    }
    const controls = attachmentControls;
    const ownerProfileId = profileIdRef.current;
    const targetId = draftRef.current.targetId;
    if (!controls || !ownerProfileId || controls.profileId !== ownerProfileId
      || attachmentOwnerRef.current !== controls.surfaceOwnerKey || !referencesEditable
      || attachmentNativeActivityRef.current || !mobilePhotoLibrarySupported(controls.policy)) {
      setError(mobileMessage(locale, "task.error.photoLibraryNewTask"));
      return;
    }
    const generation = ++attachmentGenerationRef.current;
    const controller = new AbortController();
    const lease: MobilePhotoLibraryLease = {
      controls,
      scopeKey: `${ownerProfileId}\u001f${targetId}`,
      generation,
      controller
    };
    attachmentAbortRef.current = controller;
    attachmentNativeActivityRef.current = true;
    photoLibraryLeaseRef.current = lease;
    setSessionMentionsVisible(false);
    setWorkspaceMentionsVisible(false);
    setAttachmentBusy(true);
    setError("");
    setPhotoLibraryLease(lease);
  };
  const closePhotoLibrary = (): void => {
    const lease = photoLibraryLeaseRef.current;
    if (!lease) return;
    lease.controller.abort();
    if (attachmentAbortRef.current === lease.controller) attachmentAbortRef.current = undefined;
    attachmentNativeActivityRef.current = false;
    photoLibraryLeaseRef.current = undefined;
    setPhotoLibraryLease(undefined);
    attachmentGenerationRef.current += 1;
    attachmentOwnerRef.current = client.newTaskAttachmentControls(draftRef.current.targetId)?.surfaceOwnerKey;
    setAttachmentBusy(false);
  };
  const addPhotoLibraryAssets = async (assets: readonly MobilePhotoLibraryAsset[]): Promise<void> => {
    const lease = photoLibraryLeaseRef.current;
    const ownerProfileId = profileIdRef.current;
    const targetId = draftRef.current.targetId;
    if (!lease || !ownerProfileId || lease.controls.profileId !== ownerProfileId
      || lease.scopeKey !== `${ownerProfileId}\u001f${targetId}`
      || attachmentGenerationRef.current !== lease.generation) {
      throw new Error(mobileMessage(locale, "task.error.photoLibraryNewTask"));
    }
    let staged: readonly MobileComposerAttachment[] = [];
    try {
      staged = await mobilePhotoLibrary.stageSelectedAssets(
        ownerProfileId,
        draftRef.current.input.attachments,
        lease.controls.policy,
        assets,
        randomUUID,
        lease.controller.signal
      );
      const latest = await waitForMobileAttachmentAuthority(
        { profileId: ownerProfileId, surfaceOwnerKey: lease.controls.surfaceOwnerKey },
        () => client.newTaskAttachmentControls(targetId),
        (listener) => client.subscribe(() => listener()),
        {
          signal: lease.controller.signal,
          retired: () => {
            const current = client.state;
            return profileIdRef.current !== ownerProfileId || draftRef.current.targetId !== targetId
              || current.activeProfileId !== ownerProfileId
              || current.status === "revoked" || current.status === "unpaired"
              || AppState.currentState === "active" && current.status === "connected"
                && client.newTaskAttachmentControls(targetId) === undefined;
          }
        }
      );
      if (!mountedRef.current || photoLibraryLeaseRef.current !== lease
        || attachmentGenerationRef.current !== lease.generation
        || profileIdRef.current !== ownerProfileId || draftRef.current.targetId !== targetId
        || latest.profileId !== ownerProfileId
        || latest.surfaceOwnerKey !== lease.controls.surfaceOwnerKey
        || attachmentOwnerRef.current !== lease.controls.surfaceOwnerKey) {
        throw new Error(mobileMessage(locale, "task.error.selectedPhotosChanged"));
      }
      const input = {
        ...draftRef.current.input,
        attachments: appendMobileComposerAttachments(
          draftRef.current.input.attachments,
          staged,
          latest.policy
        )
      };
      replaceInput(input, selectionRef.current);
      staged = [];
      await mobileNewTaskDrafts.flush({ profileId: ownerProfileId });
    } catch (failure) {
      await Promise.all(staged.map((attachment) => mobileAttachmentFiles.remove(ownerProfileId, attachment)
        .catch(() => undefined)));
      throw failure instanceof Error ? failure : new Error(errorText(failure));
    }
  };
  const removeAttachment = async (attachmentId: string): Promise<void> => {
    const ownerProfileId = profileIdRef.current;
    if (!identity || !ownerProfileId || !referencesEditable) return;
    const generation = ++attachmentGenerationRef.current;
    setAttachmentBusy(true);
    try {
      const result = removeMobileComposerAttachment(draftRef.current.input.attachments, attachmentId);
      replaceInput({ ...draftRef.current.input, attachments: result.attachments }, selectionRef.current);
      await mobileNewTaskDrafts.flush(identity);
      const retainedDraft = mobileNewTaskDrafts.readSync(identity);
      if (retainedDraft?.input.attachments.some((attachment) => attachment.attachmentId === attachmentId)) {
        throw new Error(mobileMessage(locale, "task.error.attachmentRemovalNewTask"));
      }
      await mobileAttachmentFiles.remove(ownerProfileId, result.removed);
    } catch (failure) {
      if (mountedRef.current && attachmentGenerationRef.current === generation) setError(errorText(failure));
    } finally {
      if (mountedRef.current && attachmentGenerationRef.current === generation) setAttachmentBusy(false);
    }
  };
  const openImageEditor = async (attachmentId: string): Promise<void> => {
    const ownerProfileId = profileIdRef.current;
    const targetId = draftRef.current.targetId;
    const attachment = draftRef.current.input.attachments.find((candidate) => candidate.attachmentId === attachmentId);
    if (!ownerProfileId || !targetId || attachment?.kind !== "image" || !referencesEditable
      || attachmentNativeActivityRef.current || imageEditorLeaseRef.current) return;
    const generation = ++attachmentGenerationRef.current;
    const controller = new AbortController();
    attachmentAbortRef.current = controller;
    attachmentNativeActivityRef.current = true;
    setSessionMentionsVisible(false);
    setWorkspaceMentionsVisible(false);
    setAttachmentBusy(true);
    setError("");
    let opened = false;
    try {
      const session = await client.openComposerImageEditor({
        surface: "new-task",
        targetId,
        attachmentId
      }, controller.signal);
      const scopeKey = `${ownerProfileId}\u001f${targetId}`;
      if (!mountedRef.current || attachmentGenerationRef.current !== generation
        || profileIdRef.current !== ownerProfileId || draftRef.current.targetId !== targetId) {
        client.cancelComposerImageEditor(session.leaseId);
        return;
      }
      const lease = { session, scopeKey };
      attachmentNativeActivityRef.current = false;
      imageEditorLeaseRef.current = lease;
      setImageEditorLease(lease);
      opened = true;
    } catch (failure) {
      if (!controller.signal.aborted && mountedRef.current && attachmentGenerationRef.current === generation) {
        setError(errorText(failure));
      }
    } finally {
      if (attachmentAbortRef.current === controller) attachmentAbortRef.current = undefined;
      if (!opened && mountedRef.current && attachmentGenerationRef.current === generation) {
        attachmentNativeActivityRef.current = false;
        setAttachmentBusy(false);
      }
    }
  };
  const saveImageEditor = async (
    strokes: readonly MobileImageAnnotationStroke[],
    burned: MobileBurnedImage | undefined,
    signal: AbortSignal
  ): Promise<void> => {
    const lease = imageEditorLeaseRef.current;
    if (!lease) throw new Error(mobileMessage(locale, "task.error.imageEditorClosed"));
    const result = await client.commitComposerImageEditor(lease.session.leaseId, strokes, burned, signal);
    if (!mountedRef.current || imageEditorLeaseRef.current !== lease || result.surface !== "new-task"
      || lease.scopeKey !== `${profileIdRef.current ?? ""}\u001f${draftRef.current.targetId}`) {
      throw new Error(mobileMessage(locale, "task.error.imageEditorNewTask"));
    }
    const next = { ...draftRef.current, input: result.draft };
    draftRef.current = next;
    setDraft(next);
  };
  const submit = (): void => {
    if (!identity || voice.busy) return;
    setError("");
    mobileNewTaskDrafts.save(identity, draft);
    void mobileNewTaskDrafts.flush(identity).then(() => client.create(draft.targetId, draft.name, draft.input)).then((result) => {
      if (result.sessionId) onCreated();
    }).catch((failure) => setError(errorText(failure)));
  };
  return <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
    <Back label={mobileMessage(locale, "common.tasks")}
      accessibilityLabel={mobileMessage(locale, "common.backTo", { label: mobileMessage(locale, "common.tasks") })}
      onPress={() => { if (identity) void mobileNewTaskDrafts.flush(identity).catch(() => undefined); onBack(); }} colors={colors} />
    <Text style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, "newTask.title")}</Text>
    <Text style={[styles.description, { color: colors.muted }]}>{mobileMessage(locale, "newTask.description")}</Text>
    {incomingShareNotice && <Banner text={incomingShareNotice} colors={colors} />}
    {incomingShareState.error && !incomingShareBatch && <Banner text={incomingShareState.error} colors={colors} />}
    {incomingShareBatch && <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
      accessibilityRole="summary" accessibilityLabel={mobileMessage(locale, "incoming.summary")}>
      <Text style={[styles.label, { color: colors.ink }]}>{mobileMessage(locale, "incoming.title")}</Text>
      {incomingShareBatch.status === "invalid" ? <>
        <Text accessibilityRole="alert" style={[styles.warning, { color: colors.negative, paddingHorizontal: 0 }]}>
          {incomingShareBatch.invalidReason} {mobileMessage(locale, "incoming.invalidKept")}
        </Text>
        <Action label={mobileMessage(locale, incomingShareState.busy ? "incoming.discarding" : "incoming.discardInvalid")} colors={colors} compact
          disabled={incomingShareState.busy} onPress={() => void discardIncomingShare(incomingShareBatch.batchId)} />
      </> : <>
        <Text style={[styles.description, { color: colors.muted }]}>
          {mobileMessage(locale, "incoming.waiting", {
            count: incomingShareBatch.items.length + incomingShareBatch.overflowCount,
            items: mobileMessage(locale, incomingShareBatch.items.length + incomingShareBatch.overflowCount === 1
              ? "incoming.item" : "incoming.items")
          })}
        </Text>
        {incomingShareBatch.boundProfileId === undefined ? <>
          <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "incoming.chooseConnection")}</Text>
          <View style={styles.actionRow}>
            <Action label={mobileMessage(locale, incomingShareState.busy ? "incoming.binding" : "incoming.useConnection")} colors={colors} compact
              disabled={incomingShareState.busy || !ownerReady || state.status !== "connected"}
              onPress={() => void bindIncomingShare(incomingShareBatch)} />
            <Action label={mobileMessage(locale, "common.discard")} colors={colors} compact disabled={incomingShareState.busy}
              onPress={() => void discardIncomingShare(incomingShareBatch.batchId)} />
          </View>
        </> : incomingShareBatch.boundProfileId !== profileId ? <>
          <Text accessibilityRole="alert" style={[styles.warning, { color: colors.negative, paddingHorizontal: 0 }]}>
            {mobileMessage(locale, "incoming.boundMismatch")}
          </Text>
          <Action label={mobileMessage(locale, incomingShareState.busy ? "incoming.discarding" : "incoming.discardBound")} colors={colors} compact
            disabled={incomingShareState.busy} onPress={() => void discardIncomingShare(incomingShareBatch.batchId)} />
        </> : incomingShareClaimCurrent === false ? <>
          <Text accessibilityRole="alert" style={[styles.warning, { color: colors.negative, paddingHorizontal: 0 }]}>
            {mobileMessage(locale, "incoming.claimedMismatch")}
          </Text>
          <Action label={mobileMessage(locale, "incoming.discardClaimed")} colors={colors} compact
            disabled={incomingShareState.busy || attachmentBusy}
            onPress={() => void discardIncomingShare(incomingShareBatch.batchId)} />
        </> : !attachmentControls || !targetAvailable || !incomingSharePlan ? <>
          <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "incoming.chooseCompatible")}</Text>
          {incomingShareBatch.items.filter((item) => item.state === "rejected").map((rejection) => <Text
            key={rejection.itemId} accessibilityRole="alert" style={[styles.caption, { color: colors.negative }]}>
            {rejection.fileName ? `${rejection.fileName}: ` : ""}{rejection.reason}
          </Text>)}
          {incomingShareBatch.overflowCount > 0 && <Text accessibilityRole="alert"
            style={[styles.caption, { color: colors.negative }]}>{mobileMessage(locale, "incoming.overflow", {
              count: incomingShareBatch.overflowCount,
              items: mobileMessage(locale, incomingShareBatch.overflowCount === 1 ? "incoming.itemWas" : "incoming.itemsWere")
            })}</Text>}
          <Action label={mobileMessage(locale, "common.discard")} colors={colors} compact disabled={incomingShareState.busy || attachmentBusy}
            onPress={() => void discardIncomingShare(incomingShareBatch.batchId)} />
        </> : <>
          <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "incoming.preview", {
            accepted: incomingSharePlan.accepted.length,
            files: mobileMessage(locale, incomingSharePlan.accepted.length === 1 ? "incoming.fileMatches" : "incoming.filesMatch"),
            skipped: incomingSharePlan.rejected.length
          })}</Text>
          {incomingSharePlan.rejected.map((rejection, index) => <Text key={`${rejection.itemId ?? "overflow"}-${index}`}
            accessibilityRole="alert" style={[styles.caption, { color: colors.negative }]}>
            {rejection.fileName ? `${rejection.fileName}: ` : ""}{rejection.reason}
          </Text>)}
          <View style={styles.actionRow}>
            <Action label={mobileMessage(locale, attachmentBusy || incomingShareState.busy ? "incoming.adding"
              : incomingSharePlan.accepted.length > 0 ? "incoming.add" : "incoming.confirmClear")}
              colors={colors} compact disabled={!referencesEditable || incomingShareState.busy}
              onPress={() => void importIncomingShare(incomingShareBatch)} />
            <Action label={mobileMessage(locale, "common.discard")} colors={colors} compact disabled={incomingShareState.busy || attachmentBusy}
              onPress={() => void discardIncomingShare(incomingShareBatch.batchId)} />
          </View>
        </>}
        {incomingShareState.error && <Text accessibilityRole="alert"
          style={[styles.warning, { color: colors.negative, paddingHorizontal: 0 }]}>{incomingShareState.error}</Text>}
      </>}
    </View>}
    <Text style={[styles.section, { color: colors.muted }]}>{mobileMessage(locale, "newTask.project")}</Text>
    {targets.length === 0 && <Text style={[styles.description, { color: colors.muted }]}>{mobileMessage(locale, "newTask.noProject")}</Text>}
    {targets.map((target) => <Pressable key={target.targetId} accessibilityRole="radio" accessibilityState={{ selected: draft.targetId === target.targetId }}
      accessibilityLabel={mobileMessage(locale, "newTask.projectAccessibility", { name: target.displayName })} disabled={!ownerReady || state.busy || attachmentBusy || voice.busy || retained !== undefined}
      onPress={() => {
        setSessionMentionsVisible(false);
        setWorkspaceMentionsVisible(false);
        setSessionMentionError("");
        patchDraft({ targetId: target.targetId });
      }}
      style={[styles.row, !ownerReady || state.busy || attachmentBusy || voice.busy || retained !== undefined ? styles.disabled : undefined,
        { backgroundColor: colors.surface, borderColor: draft.targetId === target.targetId ? colors.accent : colors.border }]}>
      <Text style={[styles.label, { color: colors.ink }]}>{target.displayName}</Text>
      <Text style={[styles.caption, { color: colors.muted }]}>{state.owner?.backends.find((backend) => backend.backendId === target.backendId)?.displayName}</Text>
    </Pressable>)}
    {draft.targetId && !targetAvailable && <Banner text={mobileMessage(locale, "newTask.retainedProject")} colors={colors} />}
    <Field label={mobileMessage(locale, "newTask.name")} value={draft.name} onChange={(name) => patchDraft({ name })}
      placeholder={mobileMessage(locale, "newTask.title")} colors={colors}
      editable={ownerReady && !state.busy && !attachmentBusy && !voice.busy && retained === undefined} maxLength={256} />
    <View style={styles.field}>
      <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "newTask.firstMessage")}</Text>
      {(voice.available || voice.checking || voice.busy || sessionMentionControls || workspaceMentionControls || attachmentControls
        || ownerReady || draft.input.mentions.length > 0 || draft.input.atoms.length > 0
        || draft.input.attachments.length > 0) && <View style={styles.composerTools}>
        {(voice.available || voice.checking || voice.busy) && <MobileVoiceAction voice={voice} colors={colors} locale={locale}
          disabled={!ownerReady || !targetAvailable || state.busy || mentionBusy || attachmentBusy
            || state.status !== "connected" || retained !== undefined} />}
        {sessionMentionControls && <Action label={mobileMessage(locale, "composer.referenceTask")} colors={colors} compact
          disabled={!referencesEditable || draft.input.mentions.filter((mention) => mention.kind === "session").length >= 8}
          onPress={() => {
            setWorkspaceMentionsVisible(false);
            setSessionMentionError("");
            setSessionMentionsVisible(true);
          }} />}
        {workspaceMentionControls && <Action label={mobileMessage(locale, "composer.referenceWorkspace")} colors={colors} compact
          disabled={!referencesEditable}
          onPress={() => {
            setSessionMentionsVisible(false);
            setSessionMentionError("");
            setWorkspaceMentionsVisible(true);
          }} />}
        <Action label={mobileMessage(locale, "composer.pasteText")} colors={colors} compact disabled={!referencesEditable}
          onPress={() => void pasteClipboardText()} />
        {attachmentControls && <Action label={mobileMessage(locale, attachmentBusy ? "common.selecting" : "composer.attach")} colors={colors} compact
          disabled={!referencesEditable || draft.input.attachments.length >= attachmentControls.policy.maximumItems}
          onPress={() => void addAttachments("picker")} />}
        {attachmentControls && mobilePhotoLibrarySupported(attachmentControls.policy) && <Action label={mobileMessage(locale, "composer.photos")}
          colors={colors} compact
          disabled={!referencesEditable || draft.input.attachments.length >= attachmentControls.policy.maximumItems}
          onPress={openPhotoLibrary} />}
        {attachmentControls && mobileCameraCaptureSupported(attachmentControls.policy) && <Action label={mobileMessage(locale, "composer.takePhoto")}
          colors={colors} compact
          disabled={!referencesEditable || draft.input.attachments.length >= attachmentControls.policy.maximumItems}
          onPress={() => void addAttachments("camera")} />}
        {draft.input.mentions.length > 0 && <ScrollView horizontal keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.mentionChips} showsHorizontalScrollIndicator={false}>
          {draft.input.mentions.map((mention) => <Pressable key={mention.mentionId}
            accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "composer.removeReference", {
              kind: mobileMessage(locale, mention.kind === "session" ? "composer.kind.task"
                : mention.kind === "workspace" && mention.directory ? "composer.kind.directory" : "composer.kind.file"),
              label: mention.displayText
            })}
            accessibilityHint={mobileMessage(locale, "composer.removeReferenceHint.newTask")}
            disabled={!referencesEditable} onPress={() => removeMention(mention.mentionId)}
            style={[styles.mentionChip, { borderColor: colors.border, backgroundColor: colors.brandBackground },
              !referencesEditable && styles.disabled]}>
            <Text style={[styles.mentionChipText, { color: colors.ink }]} numberOfLines={1}>
              {draft.input.text.slice(mention.start, mention.end)} ×
            </Text>
          </Pressable>)}
        </ScrollView>}
        <MobileComposerAtomChips atoms={draft.input.atoms} colors={colors} locale={locale}
          disabled={!referencesEditable} onOpen={setComposerAtomId} />
      </View>}
      <MobileAttachmentTray attachments={draft.input.attachments} colors={colors} locale={locale}
        disabled={!referencesEditable} busy={attachmentBusy || state.busy} pendingCount={pastedImageCount}
        onPreview={(attachmentId) => void openImageEditor(attachmentId)} onRemove={removeAttachment} />
      <MobileComposerRichInput key={`new-task-rich-${profileId ?? "none"}-${draft.targetId}`}
        ref={composerInputRef} accessibilityLabel={mobileMessage(locale, "newTask.inputLabel")}
        accessibilityHint={mobileMessage(locale, "newTask.inputHint")}
        bordered draft={ownerReady ? draft.input : emptyMobileComposerDraft()} editable={referencesEditable}
        height={composerHeight} locale={locale} maxHeight={260}
        ownerKey={`new-task\u001f${profileId ?? "none"}\u001f${draft.targetId}`}
        placeholder={mobileMessage(locale, ownerReady ? "newTask.placeholder" : "newTask.restoring")}
        selection={ownerReady ? composerSelection : { start: 0, end: 0 }} theme={composerTheme}
        onEdit={(result, sourceDraft) => {
          if (!referencesEditableRef.current || draftRef.current.input !== sourceDraft) {
            setError(mobileMessage(locale, "newTask.returnActive"));
            return;
          }
          replaceInput(result.draft, result.selection);
        }}
        onError={setError}
        onHeightChange={(nextHeight) => setComposerHeight(Math.max(132, Math.min(260, nextHeight)))}
        onOpenAtom={setComposerAtomId}
        onPasteImages={(request) => { void pasteClipboardImages(request); }}
        onPasteImagesCancel={cancelClipboardImagePaste}
        onPasteImagesStart={startClipboardImagePaste}
        onPasteText={(request) => { void pasteClipboardText(request); }}
        onSelectionChange={(nextSelection, sourceDraft) => {
          if (draftRef.current.input !== sourceDraft) return;
          selectionRef.current = nextSelection;
          setComposerSelection(nextSelection);
        }} />
    </View>
    {retained && <View accessibilityLiveRegion="polite" style={[styles.card, { backgroundColor: colors.brandBackground, borderColor: colors.border }]}>
      <Text style={[styles.label, { color: colors.ink }]}>{mobileMessage(locale,
        retained.phase === "creating" ? "newTask.creationRetained" : "newTask.messageRetained")}</Text>
      <Text style={[styles.caption, { color: colors.muted }]}>{retained.phase === "creating"
        ? mobileMessage(locale, "newTask.creationRecovery")
        : mobileMessage(locale, "newTask.deliveryRecovery")}</Text>
    </View>}
    <Action label={mobileMessage(locale, state.busy ? "newTask.creatingAndSending" : "newTask.createAndSend")}
      disabled={!ownerReady || !draft.targetId || !targetAvailable
        || (!draft.input.text.trim() && draft.input.attachments.length === 0)
        || state.busy || mentionBusy || attachmentBusy || voice.busy
        || state.status !== "connected" || retained !== undefined || pendingCreate}
      colors={colors} onPress={submit} />
    {retained?.phase === "sending" && state.selectedId === retained.sessionId
      && <Action label={mobileMessage(locale, "newTask.openCreated")} onPress={onCreated} colors={colors} />}
    {(error || state.error) && <Banner text={error || state.error || ""} colors={colors} />}
    {imageOutputNotice && <Notice text={imageOutputNotice} colors={colors} locale={locale}
      onDismiss={() => setImageOutputNotice("")} />}
    <PendingReceipts items={state.pending.filter((item) => item.kind === "create")} colors={colors} locale={locale}
      disabled={state.status !== "connected"} onError={setError} />
    {(pendingCreate || retained !== undefined) && <Action label={mobileMessage(locale, "newTask.checkRetained")} onPress={() => {
      setError("");
      void client.reconcile().then(() => {
        const current = identity ? mobileNewTaskDrafts.readSync(identity)?.submission : undefined;
        if (current?.phase === "sending" && client.state.selectedId === current.sessionId) onCreated();
      }).catch((failure) => setError(errorText(failure)));
    }} colors={colors} disabled={state.busy || state.status !== "connected"} />}
    <MobileSessionMentionSheet visible={sessionMentionsVisible && sessionMentionControls !== undefined} locale={locale}
      controls={sessionMentionControls} busy={state.busy || mentionBusy} error={sessionMentionError} colors={colors}
      onClose={() => { if (!mentionBusy) { setSessionMentionsVisible(false); setSessionMentionError(""); } }}
      onSelect={insertSessionMention} />
    <MobileWorkspaceMentionSheet visible={workspaceMentionsVisible && workspaceMentionControls !== undefined} locale={locale}
      controls={workspaceMentionControls} busy={state.busy || mentionBusy} colors={colors}
      onClose={() => setWorkspaceMentionsVisible(false)}
      onLoadDirectory={(surfaceOwnerKey, parentPath, signal) => client.listNewTaskWorkspaceMentionDirectory(
        draftRef.current.targetId,
        surfaceOwnerKey,
        parentPath,
        signal
      )}
      onLoadFileIndex={(surfaceOwnerKey, signal) => client.listNewTaskWorkspaceMentionFileIndex(
        draftRef.current.targetId,
        surfaceOwnerKey,
        signal
      )}
      onSelect={insertWorkspaceMention} />
    <MobilePhotoLibrarySheet visible={photoLibraryLease !== undefined} locale={locale}
      ownerKey={photoLibraryLease?.controls.surfaceOwnerKey}
      maximumSelection={Math.max(0, (photoLibraryLease?.controls.policy.maximumItems ?? 0)
        - draft.input.attachments.length)}
      colors={colors} library={mobilePhotoLibrary}
      onAdd={addPhotoLibraryAssets} onClose={closePhotoLibrary} />
    <MobileComposerAtomSheet atom={draft.input.atoms.find((atom) => atom.atomId === composerAtomId)} locale={locale}
      colors={colors} busy={!referencesEditable} onClose={() => setComposerAtomId(undefined)}
      onSavePaste={savePastedTextAtom} onRemove={removeComposerAtom} />
    {imageEditorLease && <MobileImageLightbox session={imageEditorLease.session} locale={locale}
      onOutputAction={async (action, decoded, rendered, signal) => {
        setImageOutputNotice("");
        setError("");
        try {
          const message = await performMobileImageOutput(imageEditorLease.session, action, decoded, rendered, signal, locale);
          if (!signal.aborted && mountedRef.current && imageEditorLeaseRef.current === imageEditorLease) {
            setImageOutputNotice(message);
          }
          return message;
        } catch (failure) {
          if (!signal.aborted && mountedRef.current) setError(errorText(failure));
          throw failure;
        }
      }}
      onNativeActivityChange={(active) => { attachmentNativeActivityRef.current = active; }}
      onClose={closeImageEditor} onSave={saveImageEditor} />}
  </ScrollView>;
}

function TaskScreen({ colors, state, locale, onBack, onHome, onNew, onFiles, focusComposer, onComposerFocused }: ScreenProps & {
  onBack: () => void; onHome: () => void; onNew: () => void; onFiles: () => void;
  focusComposer: boolean; onComposerFocused: () => void;
}) {
  const initialDraftIdentity = state.activeProfileId && state.selectedId
    ? { profileId: state.activeProfileId, sessionId: state.selectedId }
    : undefined;
  const initialComposerDraft = initialDraftIdentity ? mobileComposerDrafts.readSync(initialDraftIdentity) : null;
  const [draft, setDraft] = useState<MobileComposerDraft>(() => initialComposerDraft ?? emptyMobileComposerDraft());
  const [composerSelection, setComposerSelection] = useState<MobileComposerSelection>(() => ({
    start: initialComposerDraft?.text.length ?? 0,
    end: initialComposerDraft?.text.length ?? 0
  }));
  const [loadedDraftKey, setLoadedDraftKey] = useState(() => initialDraftIdentity
    ? mobileComposerDraftIdentityKey(initialDraftIdentity)
    : undefined);
  const [draftReady, setDraftReady] = useState(() => initialDraftIdentity === undefined
    || mobileComposerDrafts.readSync(initialDraftIdentity) !== null);
  const [localError, setLocalError] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMounted, setDrawerMounted] = useState(false);
  const [messageAction, setMessageAction] = useState<{ readonly sessionId: string; readonly row: TimelineRow }>();
  const [messageActionsVisible, setMessageActionsVisible] = useState(false);
  const [quoteSelection, setQuoteSelection] = useState<{
    readonly lease: MobileQuoteSelectionLease;
    readonly draft: MobileComposerDraft;
    readonly draftIdentityKey: string;
    readonly queueLease?: MobileQueueEditLease;
  }>();
  const [composerAtomId, setComposerAtomId] = useState<string>();
  const [queueEdit, setQueueEdit] = useState<{
    readonly lease: MobileQueueEditLease;
    readonly profileId: string;
    readonly stashedDraft: MobileComposerDraft;
  }>();
  const [composerContentHeight, setComposerContentHeight] = useState(composerMinimumInputHeight);
  const [composerManualHeight, setComposerManualHeight] = useState<number | null>(null);
  const initialInteractions = state.status === "connected" ? client.taskInteractions() : [];
  const [selectedInteractionId, setSelectedInteractionId] = useState<string | undefined>(initialInteractions[0]?.interactionId);
  const [interactionVisible, setInteractionVisible] = useState(initialInteractions.length > 0);
  const [runtimeControlsVisible, setRuntimeControlsVisible] = useState(false);
  const [contextVisible, setContextVisible] = useState(false);
  const [nativeTreeVisible, setNativeTreeVisible] = useState(false);
  const [sessionMentionsVisible, setSessionMentionsVisible] = useState(false);
  const [sessionMentionError, setSessionMentionError] = useState("");
  const [workspaceMentionsVisible, setWorkspaceMentionsVisible] = useState(false);
  const [catalogMentionsVisible, setCatalogMentionsVisible] = useState(false);
  const [composerComposing, setComposerComposing] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [runtimeCommandLoad, setRuntimeCommandLoad] = useState<MobileRuntimeCommandLoadState>({ status: "loading" });
  const [runtimeCommandSelectedIndex, setRuntimeCommandSelectedIndex] = useState(0);
  const [runtimeCommandDismissal, setRuntimeCommandDismissal] = useState<MobileRuntimeCommandDismissal>();
  const [runtimeCommandDraftLease, setRuntimeCommandDraftLease] = useState<MobileRuntimeCommandDraftLease>();
  const [runtimeCommandCommitting, setRuntimeCommandCommitting] = useState(false);
  const [appCommandRunning, setAppCommandRunning] = useState(false);
  const [commandHelpItems, setCommandHelpItems] = useState<readonly MobileCommandPaletteCandidate[]>();
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [pastedImageCount, setPastedImageCount] = useState(0);
  const [galleryOpening, setGalleryOpening] = useState(false);
  const [composerNotice, setComposerNotice] = useState("");
  const [fileShareBusy, setFileShareBusy] = useState(false);
  const [fileShareProgress, setFileShareProgress] = useState<MobileFileShareProgress>();
  const [timelinePreviewSource, setTimelinePreviewSource] = useState<MobileTimelineArtifact>();
  const [photoLibraryLease, setPhotoLibraryLease] = useState<MobilePhotoLibraryLease>();
  const [imageEditorLease, setImageEditorLease] = useState<MobileComposerImageEditorLease>();
  const interactionSurfaceOwnerRef = useRef<string | undefined>(
    state.activeProfileId && state.selectedId ? `${state.activeProfileId}\u001f${state.selectedId}` : undefined
  );
  const interactionDraftsRef = useRef<{ readonly ownerKey?: string; readonly values: ReadonlyMap<string, MobileInteractionDraftIdentity> }>({
    values: new Map()
  });
  const queueEditRef = useRef(queueEdit);
  const composerInputRef = useRef<MobileComposerRichInputHandle>(null);
  const queueInputRef = useRef<TextInput>(null);
  const composerDraftRef = useRef(draft);
  const composerSelectionRef = useRef(composerSelection);
  const draftIdentityRef = useRef<MobileComposerDraftIdentity | undefined>(initialDraftIdentity);
  const taskMountedRef = useRef(true);
  const composerPasteEditableRef = useRef(false);
  const composerComposingRef = useRef(false);
  const composerFocusedRef = useRef(false);
  const runtimeCommandControlsRef = useRef(client.taskRuntimeCommandControls());
  const runtimeCommandAbortRef = useRef<AbortController | undefined>(undefined);
  const runtimeCommandRequestRef = useRef(0);
  const runtimeCommandPaletteRef = useRef<MobileRuntimeCommandPaletteSnapshot>({
    visible: false,
    items: [],
    selectedIndex: 0,
    status: "loading"
  });
  const runtimeCommandCommittingRef = useRef(false);
  const composerTheme = useMemo(() => mobileComposerRichTheme(colors), [colors]);
  const keyboard = useMobileKeyboardState();
  const safeArea = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const draftIdentity = state.activeProfileId && state.selectedId
    ? { profileId: state.activeProfileId, sessionId: state.selectedId }
    : undefined;
  const draftIdentityKey = draftIdentity ? mobileComposerDraftIdentityKey(draftIdentity) : undefined;
  draftIdentityRef.current = draftIdentity;
  const imageGallery = useMobileImageGallery(locale, (nextDraft) => {
    const identity = draftIdentityRef.current;
    if (!identity || mobileComposerDraftIdentityKey(identity) !== draftIdentityKey) return;
    composerDraftRef.current = nextDraft;
    setDraft(nextDraft);
    setComposerNotice(mobileMessage(locale, "task.imageAdded"));
    setTimeout(() => composerInputRef.current?.focus(), 0);
  });
  const galleryOwnerRef = useRef(draftIdentityKey);
  const composerBounds = computeComposerResizeBounds({
    windowHeight: height,
    keyboardHeight: keyboard.height,
    composerChromeHeight: 76 + safeArea.top + (keyboard.visible ? 0 : safeArea.bottom)
  });
  const composerHeight = resolveComposerHeight({
    contentHeight: composerContentHeight,
    manualHeight: composerManualHeight,
    automaticMaximumHeight: composerAutomaticMaximumHeight,
    bounds: composerBounds
  });
  const composerBoundsRef = useRef(composerBounds);
  const composerHeightRef = useRef(composerHeight.visibleHeight);
  const composerContentHeightRef = useRef(composerContentHeight);
  const composerDragStartRef = useRef(composerHeight.visibleHeight);
  const composerDraggedHeightRef = useRef(composerHeight.visibleHeight);
  composerBoundsRef.current = composerBounds;
  composerHeightRef.current = composerHeight.visibleHeight;
  composerContentHeightRef.current = composerContentHeight;
  const composerResizeResponder = useMemo(() => PanResponder.create(buildComposerResizeGestureConfig({
    onGrant: () => {
      composerDragStartRef.current = composerHeightRef.current;
      composerDraggedHeightRef.current = composerHeightRef.current;
    },
    onMove: (translationY) => {
      const next = resizeComposerHeight({
        startHeight: composerDragStartRef.current,
        translationY,
        bounds: composerBoundsRef.current
      });
      composerDraggedHeightRef.current = next;
      setComposerManualHeight(next);
    },
    onEnd: (translationY) => {
      const draggedHeight = resizeComposerHeight({
        startHeight: composerDragStartRef.current,
        translationY,
        bounds: composerBoundsRef.current
      });
      composerDraggedHeightRef.current = draggedHeight;
      setComposerManualHeight(settleComposerHeight({
        draggedHeight,
        contentHeight: composerContentHeightRef.current,
        bounds: composerBoundsRef.current
      }));
      if (shouldDismissComposerKeyboard({
        draggedHeight,
        translationY,
        bounds: composerBoundsRef.current
      })) Keyboard.dismiss();
    }
  })), []);
  const wideNavigation = buildWideSessionNavLayout({ platform: Platform.OS, iosPad: Platform.OS === "ios" && Platform.isPad, windowWidth: width });
  const drawerWidthRef = useRef(wideNavigation.drawerWidth || 300);
  if (wideNavigation.enabled) drawerWidthRef.current = wideNavigation.drawerWidth;
  const drawerMenuRef = useRef<View>(null);
  const drawerCloseRef = useRef<View>(null);
  const pendingDrawerActionRef = useRef<(() => void) | undefined>(undefined);
  const session = state.detail?.sessions.find((item) => item.sessionId === state.selectedId)
    || state.owner?.sessions.find((item) => item.sessionId === state.selectedId);
  const rows = timelineRows(state.window ?? [...state.older, ...(state.detail?.timeline ?? []), ...state.live]);
  const unknown = state.pending.some((item) => item.kind === "send" && item.sessionId === state.selectedId && item.state === "unknown");
  const queueItems = client.taskQueueItems();
  const queueCapabilities = client.taskQueueCapabilities();
  const interactions = state.status === "connected" ? client.taskInteractions() : [];
  const runtimeControls = state.status === "connected" ? client.taskRuntimeControls() : undefined;
  const runtimeControlsOwnerRef = useRef(runtimeControls?.surfaceOwnerKey);
  const contextControls = state.status === "connected" ? client.taskContextControls() : undefined;
  const contextOwnerRef = useRef(contextControls?.surfaceOwnerKey);
  const nativeTreeControls = state.status === "connected" ? client.taskNativeTreeControls() : undefined;
  const nativeTreeOwnerRef = useRef(nativeTreeControls?.surfaceOwnerKey);
  const sessionMentionControls = state.status === "connected" ? client.taskSessionMentionControls() : undefined;
  const sessionMentionOwnerRef = useRef(sessionMentionControls?.surfaceOwnerKey);
  const workspaceMentionControls = state.status === "connected" ? client.taskWorkspaceMentionControls() : undefined;
  const workspaceMentionOwnerRef = useRef(workspaceMentionControls?.surfaceOwnerKey);
  const catalogMentionControls = state.status === "connected" ? client.taskCatalogMentionControls() : undefined;
  const catalogMentionOwnerRef = useRef(catalogMentionControls?.surfaceOwnerKey);
  const appCommandControls = state.status === "connected" ? client.taskAppCommandControls() : undefined;
  const runtimeCommandControls = state.status === "connected" ? client.taskRuntimeCommandControls() : undefined;
  runtimeCommandControlsRef.current = runtimeCommandControls;
  const runtimeCommandObservationKey = JSON.stringify([
    ...(state.owner?.runtimeCommands ?? []),
    ...(state.detail?.runtimeCommands ?? [])
  ].filter((command) => command.sessionId === state.selectedId).map((command) => [
    command.commandId,
    command.name,
    command.description,
    command.source,
    command.resourceId,
    command.loaded
  ]));
  const voiceTransport = state.status === "connected" ? client.taskVoiceTransport() : undefined;
  const attachmentControls = state.status === "connected" ? client.taskAttachmentControls() : undefined;
  const attachmentOwnerRef = useRef(attachmentControls?.surfaceOwnerKey);
  const attachmentGenerationRef = useRef(0);
  const attachmentNativeActivityRef = useRef(false);
  const attachmentAbortRef = useRef<AbortController | undefined>(undefined);
  const fileShareAbortRef = useRef<AbortController | undefined>(undefined);
  const imagePasteLeaseRef = useRef<MobileTaskImagePasteLease | undefined>(undefined);
  const photoLibraryLeaseRef = useRef<MobilePhotoLibraryLease | undefined>(undefined);
  const imageEditorLeaseRef = useRef<MobileComposerImageEditorLease | undefined>(undefined);
  composerDraftRef.current = draft;
  composerSelectionRef.current = composerSelection;
  composerComposingRef.current = composerComposing;
  composerFocusedRef.current = composerFocused;
  const closeImageEditor = useCallback(() => {
    const lease = imageEditorLeaseRef.current;
    if (!lease) return;
    client.cancelComposerImageEditor(lease.session.leaseId);
    imageEditorLeaseRef.current = undefined;
    setImageEditorLease(undefined);
    attachmentNativeActivityRef.current = false;
    attachmentGenerationRef.current += 1;
    attachmentOwnerRef.current = client.taskAttachmentControls()?.surfaceOwnerKey;
    setAttachmentBusy(false);
  }, []);
  const interactionOwnerKey = state.activeProfileId && state.selectedId
    ? `${state.activeProfileId}\u001f${state.selectedId}`
    : undefined;
  const interactionIdsKey = JSON.stringify(interactions.map((interaction) => [
    interaction.interactionId,
    interaction.backendId,
    interaction.targetId,
    interaction.kind.toString(10),
    interaction.request.case,
    interaction.generation.toString(10),
    interaction.version?.revision?.value.toString(10) ?? "0"
  ]));
  const activeInteractionId = interactions.some((interaction) => interaction.interactionId === selectedInteractionId)
    ? selectedInteractionId
    : interactions[0]?.interactionId;
  const activeInteraction = interactions.find((interaction) => interaction.interactionId === activeInteractionId);
  const interactionMutationPending = state.pending.some((item) => item.sessionId === state.selectedId
    && item.interactionId === activeInteractionId
    && (item.kind === "interaction-resolve" || item.kind === "interaction-dismiss"));
  const appCommandReceiptPending = state.pending.some((item) => item.sessionId === state.selectedId
    && ["session-shell", "session-reset", "session-review"].includes(item.kind));
  const composerOperationPending = appCommandRunning || appCommandReceiptPending;
  const runtimeControlPending = state.pending.some((item) => item.sessionId === state.selectedId
    && ["session-model", "session-permission", "session-plan", "session-compact", "session-branch"].includes(item.kind));
  const contextPending = runtimeControlPending;
  const nativeTreePending = runtimeControlPending;
  const runtimeControlsAvailable = runtimeControls !== undefined && (runtimeControls.canSwitchModel
    || runtimeControls.canSetEffort || runtimeControls.canSetFastMode
    || runtimeControls.canSetPermission || runtimeControls.canSetPlanMode);
  const queueMutationPending = state.pending.some((item) => item.sessionId === state.selectedId
    && ["queue-cancel", "queue-edit-lock", "queue-edit", "queue-interaction-lock", "queue-reorder"].includes(item.kind));
  const messageActionItems = messageAction
    ? buildMobileMessageActions(messageAction.row, { canDelete: client.canDeleteMessage(messageAction.row.eventId) })
    : [];
  useEffect(() => mobileComposerDrafts.subscribeErrors((identity, error) => {
    if (!taskMountedRef.current || mobileComposerDraftIdentityKey(identity) !== draftIdentityKey) return;
    setLocalError(error.message);
  }), [draftIdentityKey]);
  useEffect(() => {
    const ownerChanged = interactionSurfaceOwnerRef.current !== interactionOwnerKey;
    interactionSurfaceOwnerRef.current = interactionOwnerKey;
    if (interactions.length === 0) {
      setSelectedInteractionId(undefined);
      setInteractionVisible(false);
      return;
    }
    setRuntimeControlsVisible(false);
    setContextVisible(false);
    setNativeTreeVisible(false);
    setSessionMentionsVisible(false);
    setWorkspaceMentionsVisible(false);
    setCatalogMentionsVisible(false);
    composerComposingRef.current = false;
    setComposerComposing(false);
    composerFocusedRef.current = false;
    setComposerFocused(false);
    setRuntimeCommandDismissal(undefined);
    setRuntimeCommandDraftLease(undefined);
    setCommandHelpItems(undefined);
    setQuoteSelection(undefined);
    setComposerAtomId(undefined);
    if (ownerChanged) {
      setSelectedInteractionId(interactions[0]!.interactionId);
      setInteractionVisible(true);
      return;
    }
    if (selectedInteractionId !== undefined
      && interactions.some((interaction) => interaction.interactionId === selectedInteractionId)) return;
    setSelectedInteractionId(interactions[0]!.interactionId);
    setInteractionVisible(true);
  }, [interactionIdsKey, interactionOwnerKey, selectedInteractionId]);
  useEffect(() => {
    setCommandHelpItems(undefined);
  }, [appCommandControls?.surfaceOwnerKey]);
  useEffect(() => {
    const next = runtimeControls?.surfaceOwnerKey;
    const changed = runtimeControlsOwnerRef.current !== next;
    runtimeControlsOwnerRef.current = next;
    if (changed || next === undefined) setRuntimeControlsVisible(false);
  }, [runtimeControls?.surfaceOwnerKey]);
  useEffect(() => {
    const next = contextControls?.surfaceOwnerKey;
    const changed = contextOwnerRef.current !== next;
    contextOwnerRef.current = next;
    if (changed || next === undefined) setContextVisible(false);
  }, [contextControls?.surfaceOwnerKey]);
  useEffect(() => {
    const next = nativeTreeControls?.surfaceOwnerKey;
    const changed = nativeTreeOwnerRef.current !== next;
    nativeTreeOwnerRef.current = next;
    if (changed || next === undefined) setNativeTreeVisible(false);
  }, [nativeTreeControls?.surfaceOwnerKey]);
  useEffect(() => {
    const next = sessionMentionControls?.surfaceOwnerKey;
    const changed = sessionMentionOwnerRef.current !== next;
    sessionMentionOwnerRef.current = next;
    if (changed || next === undefined) {
      setSessionMentionsVisible(false);
      setSessionMentionError("");
    }
  }, [sessionMentionControls?.surfaceOwnerKey]);
  useEffect(() => {
    const next = workspaceMentionControls?.surfaceOwnerKey;
    const changed = workspaceMentionOwnerRef.current !== next;
    workspaceMentionOwnerRef.current = next;
    if (changed || next === undefined) setWorkspaceMentionsVisible(false);
  }, [workspaceMentionControls?.surfaceOwnerKey]);
  useEffect(() => {
    const next = catalogMentionControls?.surfaceOwnerKey;
    const changed = catalogMentionOwnerRef.current !== next;
    catalogMentionOwnerRef.current = next;
    if (changed || next === undefined) setCatalogMentionsVisible(false);
  }, [catalogMentionControls?.surfaceOwnerKey]);
  const loadRuntimeCommandCatalog = useCallback(() => {
    const controls = runtimeCommandControlsRef.current;
    runtimeCommandAbortRef.current?.abort();
    runtimeCommandAbortRef.current = undefined;
    const request = runtimeCommandRequestRef.current + 1;
    runtimeCommandRequestRef.current = request;
    if (!controls) {
      setRuntimeCommandLoad({ status: "loading" });
      return;
    }
    const ownerKey = controls.surfaceOwnerKey;
    const cached = runtimeCommandCatalogCache.read(ownerKey);
    const controller = new AbortController();
    runtimeCommandAbortRef.current = controller;
    setRuntimeCommandLoad({
      ownerKey,
      ...(cached === undefined ? {} : { catalog: cached }),
      status: cached === undefined ? "loading" : "refreshing"
    });
    void client.listTaskRuntimeCommands(ownerKey, controller.signal).then((catalog) => {
      if (!taskMountedRef.current || controller.signal.aborted || runtimeCommandRequestRef.current !== request
        || runtimeCommandControlsRef.current?.surfaceOwnerKey !== ownerKey
        || catalog.surfaceOwnerKey !== ownerKey) return;
      runtimeCommandCatalogCache.write(catalog);
      setRuntimeCommandLoad({ ownerKey, catalog, status: "ready" });
    }).catch((failure) => {
      if (!taskMountedRef.current || controller.signal.aborted || runtimeCommandRequestRef.current !== request
        || runtimeCommandControlsRef.current?.surfaceOwnerKey !== ownerKey) return;
      setRuntimeCommandLoad({
        ownerKey,
        ...(cached === undefined ? {} : { catalog: cached }),
        status: "error",
        error: errorText(failure)
      });
    }).finally(() => {
      if (runtimeCommandAbortRef.current === controller) runtimeCommandAbortRef.current = undefined;
    });
  }, []);
  useEffect(() => {
    setRuntimeCommandDismissal(undefined);
    setRuntimeCommandDraftLease(undefined);
    setRuntimeCommandSelectedIndex(0);
    loadRuntimeCommandCatalog();
  }, [loadRuntimeCommandCatalog, runtimeCommandControls?.surfaceOwnerKey, runtimeCommandObservationKey]);
  useEffect(() => {
    const next = attachmentControls?.surfaceOwnerKey;
    const observed = observeMobileAttachmentAuthority(
      attachmentOwnerRef.current,
      next,
      attachmentNativeActivityRef.current
    );
    attachmentOwnerRef.current = observed.surfaceOwnerKey;
    if (observed.retired) {
      attachmentAbortRef.current?.abort();
      attachmentAbortRef.current = undefined;
      attachmentNativeActivityRef.current = false;
      imagePasteLeaseRef.current = undefined;
      setPastedImageCount(0);
      photoLibraryLeaseRef.current = undefined;
      setPhotoLibraryLease(undefined);
      if (imageEditorLeaseRef.current) {
        client.cancelComposerImageEditor(imageEditorLeaseRef.current.session.leaseId);
        imageEditorLeaseRef.current = undefined;
        setImageEditorLease(undefined);
      }
      attachmentGenerationRef.current += 1;
      setAttachmentBusy(false);
    }
  }, [attachmentControls?.surfaceOwnerKey]);
  useEffect(() => {
    const lease = imagePasteLeaseRef.current;
    if (!lease) return;
    const identity = draftIdentityRef.current;
    const scopeMatches = identity !== undefined
      && mobileComposerDraftIdentityKey(identity) === mobileComposerDraftIdentityKey(lease.identity);
    if (scopeMatches && state.status === "connected" && AppState.currentState === "active") return;
    lease.controller.abort();
    if (attachmentAbortRef.current === lease.controller) attachmentAbortRef.current = undefined;
    imagePasteLeaseRef.current = undefined;
    attachmentNativeActivityRef.current = false;
    attachmentGenerationRef.current += 1;
    setPastedImageCount(0);
    setAttachmentBusy(false);
  }, [draftIdentityKey, state.status]);
  useEffect(() => {
    const lease = photoLibraryLeaseRef.current;
    if (!lease) return;
    const scopeKey = draftIdentityKey ?? "";
    if (scopeKey === lease.scopeKey && state.status !== "revoked" && state.status !== "unpaired") return;
    lease.controller.abort();
    attachmentAbortRef.current = undefined;
    attachmentNativeActivityRef.current = false;
    photoLibraryLeaseRef.current = undefined;
    setPhotoLibraryLease(undefined);
    attachmentGenerationRef.current += 1;
    setAttachmentBusy(false);
  }, [draftIdentityKey, state.status]);
  useEffect(() => {
    const lease = imageEditorLeaseRef.current;
    if (!lease) return;
    if (lease.scopeKey === (draftIdentityKey ?? "") && state.status === "connected") return;
    closeImageEditor();
  }, [closeImageEditor, draftIdentityKey, state.status]);
  useEffect(() => {
    const changed = galleryOwnerRef.current !== draftIdentityKey;
    galleryOwnerRef.current = draftIdentityKey;
    if (changed || state.status !== "connected") {
      imageGallery.close();
      setGalleryOpening(false);
    }
  }, [draftIdentityKey, imageGallery.close, state.status]);
  useEffect(() => {
    const next = new Map<string, MobileInteractionDraftIdentity>();
    if (state.activeProfileId) {
      for (const interaction of interactions) {
        const identity = mobileInteractionDraftIdentity(state.activeProfileId, interaction);
        if (identity) next.set(mobileInteractionDraftIdentityKey(identity), identity);
      }
    }
    const previous = interactionDraftsRef.current;
    interactionDraftsRef.current = { ownerKey: interactionOwnerKey, values: next };
    if (interactionOwnerKey === undefined || previous.ownerKey !== interactionOwnerKey) return;
    for (const [key, identity] of previous.values) {
      if (!next.has(key)) void mobileInteractionDrafts.clear(identity).catch((error) => {
        if (taskMountedRef.current) setLocalError(errorText(error));
      });
    }
  }, [interactionIdsKey, interactionOwnerKey, state.activeProfileId]);
  useEffect(() => {
    const identity = draftIdentity;
    draftIdentityRef.current = identity;
    setComposerManualHeight(null);
    setComposerContentHeight(composerMinimumInputHeight);
    composerComposingRef.current = false;
    setComposerComposing(false);
    composerFocusedRef.current = false;
    setComposerFocused(false);
    setRuntimeCommandDismissal(undefined);
    setRuntimeCommandDraftLease(undefined);
    setSessionMentionsVisible(false);
    setWorkspaceMentionsVisible(false);
    setCatalogMentionsVisible(false);
    if (!identity) {
      imagePasteLeaseRef.current = undefined;
      setPastedImageCount(0);
      setDraft(emptyMobileComposerDraft());
      setComposerSelection({ start: 0, end: 0 });
      setLoadedDraftKey(undefined);
      setDraftReady(true);
      return;
    }
    let current = true;
    const key = mobileComposerDraftIdentityKey(identity);
    const cached = mobileComposerDrafts.readSync(identity);
    const activeQueueEdit = queueEditRef.current;
    const editingCurrentIdentity = activeQueueEdit?.profileId === identity.profileId
      && activeQueueEdit.lease.sessionId === identity.sessionId;
    if (!editingCurrentIdentity) {
      const next = cached ?? emptyMobileComposerDraft();
      setDraft(next);
      setComposerSelection({ start: next.text.length, end: next.text.length });
    }
    setLoadedDraftKey(key);
    setDraftReady(cached !== null);
    void mobileComposerDrafts.read(identity).then((stored) => {
      const latestQueueEdit = queueEditRef.current;
      const stillEditingCurrentIdentity = latestQueueEdit?.profileId === identity.profileId
        && latestQueueEdit.lease.sessionId === identity.sessionId;
      if (!current || !taskMountedRef.current || stillEditingCurrentIdentity
        || draftIdentityRef.current === undefined
        || mobileComposerDraftIdentityKey(draftIdentityRef.current) !== key) return;
      const next = stored ?? emptyMobileComposerDraft();
      setDraft(next);
      setComposerSelection({ start: next.text.length, end: next.text.length });
      setLoadedDraftKey(key);
      setDraftReady(true);
    }).catch((error) => {
      if (!current || !taskMountedRef.current || draftIdentityRef.current === undefined
        || mobileComposerDraftIdentityKey(draftIdentityRef.current) !== key) return;
      setDraftReady(true);
      setLoadedDraftKey(key);
      setLocalError(errorText(error));
    });
    return () => {
      current = false;
      void mobileComposerDrafts.flush(identity).catch(() => undefined);
    };
  }, [draftIdentityKey]);
  const composerOwnerReady = loadedDraftKey === draftIdentityKey && draftReady;
  useEffect(() => {
    if (!composerOwnerReady || !focusComposer) return;
    const timer = setTimeout(() => {
      composerInputRef.current?.focus();
      onComposerFocused();
    }, 0);
    return () => clearTimeout(timer);
  }, [composerOwnerReady, draftIdentityKey, focusComposer, onComposerFocused]);
  useEffect(() => {
    if (!wideNavigation.enabled && drawerOpen) setDrawerOpen(false);
  }, [drawerOpen, wideNavigation.enabled]);
  useEffect(() => {
    if (!messageAction) return;
    const stillCurrent = state.selectedId === messageAction.sessionId
      && rows.some((row) => row.eventId === messageAction.row.eventId && row.completed);
    if (!stillCurrent) {
      setMessageActionsVisible(false);
      setMessageAction(undefined);
    }
  }, [messageAction, rows, state.selectedId]);
  useEffect(() => {
    if (state.status === "connected") return;
    setInteractionVisible(false);
    setRuntimeControlsVisible(false);
    setContextVisible(false);
    setNativeTreeVisible(false);
    setSessionMentionsVisible(false);
    setSessionMentionError("");
    setWorkspaceMentionsVisible(false);
    setCatalogMentionsVisible(false);
    setMessageActionsVisible(false);
    setMessageAction(undefined);
    setQuoteSelection(undefined);
    setComposerAtomId(undefined);
    setCommandHelpItems(undefined);
    setRuntimeCommandDismissal(undefined);
    setRuntimeCommandDraftLease(undefined);
  }, [state.status]);
  useEffect(() => {
    const active = queueEditRef.current;
    if (!active) return;
    const itemStillAccepted = state.detail?.queueItems.some((item) => item.queueItemId === active.lease.queueItemId
      && item.sessionId === active.lease.sessionId && item.state === QueueItemState.ACCEPTED) === true;
    const authorityRetired = state.selectedId !== active.lease.sessionId || state.status !== "connected";
    if (!authorityRetired && itemStillAccepted) return;
    queueEditRef.current = undefined;
    setQueueEdit(undefined);
    if (state.activeProfileId === active.profileId && state.selectedId === active.lease.sessionId) {
      setDraft(active.stashedDraft);
      setComposerSelection({ start: active.stashedDraft.text.length, end: active.stashedDraft.text.length });
    }
    void client.cancelQueueEdit(active.lease).catch((error) => {
      if (taskMountedRef.current) setLocalError(errorText(error));
    });
  }, [state.activeProfileId, state.detail?.queueItems, state.selectedId, state.status]);
  useEffect(() => {
    taskMountedRef.current = true;
    return () => {
      taskMountedRef.current = false;
      runtimeCommandAbortRef.current?.abort();
      runtimeCommandAbortRef.current = undefined;
      runtimeCommandRequestRef.current += 1;
      attachmentAbortRef.current?.abort();
      fileShareAbortRef.current?.abort();
      fileShareAbortRef.current = undefined;
      attachmentNativeActivityRef.current = false;
      imagePasteLeaseRef.current = undefined;
      photoLibraryLeaseRef.current = undefined;
      if (imageEditorLeaseRef.current) {
        client.cancelComposerImageEditor(imageEditorLeaseRef.current.session.leaseId);
        imageEditorLeaseRef.current = undefined;
      }
      queueEditRef.current = undefined;
      client.leaveTask();
    };
  }, []);

  const openMessageActions = (row: TimelineRow): void => {
    if (!state.selectedId || state.status !== "connected" || voice.busy) return;
    setMessageAction({ sessionId: state.selectedId, row });
    setMessageActionsVisible(true);
  };
  const saveNormalDraft = (value: MobileComposerDraft, identity = draftIdentityRef.current): void => {
    setDraft(value);
    composerDraftRef.current = value;
    const selection = { start: value.text.length, end: value.text.length };
    composerSelectionRef.current = selection;
    setComposerSelection(selection);
    if (identity) mobileComposerDrafts.save(identity, value);
  };
  const voice = useMobileVoiceInput({
    transport: voiceTransport,
    draftOwnerKey: draftIdentityKey,
    enabled: composerOwnerReady && queueEdit === undefined && interactions.length === 0
      && state.status === "connected" && !state.busy && !composerOperationPending && !attachmentBusy,
    readDraft: () => composerDraftRef.current,
    readSelection: () => composerSelectionRef.current,
    writeDraft: (value, selection, persist) => {
      if (queueEditRef.current) return;
      setDraft(value);
      composerDraftRef.current = value;
      composerSelectionRef.current = selection;
      setComposerSelection(selection);
      const identity = draftIdentityRef.current;
      if (!persist || !identity) return;
      mobileComposerDrafts.save(identity, value);
      const identityKey = mobileComposerDraftIdentityKey(identity);
      void mobileComposerDrafts.flush(identity).catch((failure) => {
        if (taskMountedRef.current && draftIdentityRef.current
          && mobileComposerDraftIdentityKey(draftIdentityRef.current) === identityKey) setLocalError(errorText(failure));
      });
    },
    onError: setLocalError,
    locale,
    requestId: randomUUID
  });
  useMobileVoicePermissionSettings(voice.error, locale);
  const composerPasteEditable = state.status === "connected" && composerOwnerReady && queueEdit === undefined && !state.busy
    && !composerOperationPending
    && !voice.busy && !attachmentBusy;
  composerPasteEditableRef.current = composerPasteEditable;
  const runtimeCommandEnabled = composerPasteEditable && composerFocused && interactions.length === 0
    && state.status === "connected" && appCommandControls !== undefined;
  const runtimeCommandActivation = runtimeCommandEnabled
    ? detectMobileRuntimeCommandActivation(draft, composerSelection, composerComposing)
    : undefined;
  const runtimeCommandDismissed = runtimeCommandActivation !== undefined && appCommandControls !== undefined
    && runtimeCommandDismissal?.ownerKey === appCommandControls.surfaceOwnerKey
    && runtimeCommandDismissal.sourceDraft === draft
    && sameComposerSelection(runtimeCommandDismissal.selection, composerSelection)
    && sameRuntimeCommandActivation(runtimeCommandDismissal.activation, runtimeCommandActivation);
  const runtimeCommandPaletteVisible = runtimeCommandActivation !== undefined && appCommandControls !== undefined
    && !runtimeCommandDismissed;
  const runtimeCommandLoadMatches = runtimeCommandControls !== undefined
    && runtimeCommandLoad.ownerKey === runtimeCommandControls.surfaceOwnerKey;
  const runtimeCommandCatalog = runtimeCommandLoadMatches ? runtimeCommandLoad.catalog : undefined;
  const runtimeCommandPaletteStatus: MobileRuntimeCommandPaletteStatus = runtimeCommandControls === undefined
    ? "ready"
    : runtimeCommandLoadMatches ? runtimeCommandLoad.status : "loading";
  const runtimeCommandCandidates = appCommandControls === undefined
    ? []
    : mergeMobileCommandPaletteCandidates(appCommandControls, runtimeCommandCatalog?.items);
  const runtimeCommandResults = runtimeCommandActivation === undefined
    ? { items: [] as readonly MobileCommandPaletteCandidate[], truncated: false }
    : filterMobileCommandPaletteCandidates(runtimeCommandCandidates, runtimeCommandActivation.query);
  const runtimeCommandResultKey = runtimeCommandResults.items.map((item) => item.commandId).join("\u001f");
  useEffect(() => {
    setRuntimeCommandSelectedIndex(0);
  }, [
    runtimeCommandActivation?.caret,
    runtimeCommandActivation?.from,
    runtimeCommandActivation?.query,
    runtimeCommandActivation?.to,
    appCommandControls?.surfaceOwnerKey,
    runtimeCommandResultKey
  ]);
  useEffect(() => {
    let active = true;
    setRuntimeCommandDraftLease(undefined);
    const activation = runtimeCommandActivation;
    const controls = appCommandControls;
    const catalog = runtimeCommandCatalog;
    const identity = draftIdentity;
    if (!runtimeCommandPaletteVisible || !activation || !controls || !identity
      || runtimeCommandCommittingRef.current) return;
    const sourceDraft = draft;
    const selection = { ...composerSelection };
    const identityKey = mobileComposerDraftIdentityKey(identity);
    void mobileComposerDrafts.readSnapshot(identity).then((snapshot) => {
      const currentActivation = detectMobileRuntimeCommandActivation(
        composerDraftRef.current,
        composerSelectionRef.current,
        composerComposingRef.current
      );
      if (!active || !taskMountedRef.current || snapshot.draft === undefined
        || !mobileComposerDraftsEqual(snapshot.draft, sourceDraft)
        || composerDraftRef.current !== sourceDraft
        || !sameComposerSelection(composerSelectionRef.current, selection)
        || !sameRuntimeCommandActivation(currentActivation, activation)
        || draftIdentityRef.current === undefined
        || mobileComposerDraftIdentityKey(draftIdentityRef.current) !== identityKey
        || client.taskAppCommandControls()?.surfaceOwnerKey !== controls.surfaceOwnerKey
        || runtimeCommandPaletteRef.current.runtimeCatalog !== catalog) return;
      setRuntimeCommandDraftLease({
        ownerKey: controls.surfaceOwnerKey,
        draftIdentityKey: identityKey,
        revision: snapshot.revision,
        sourceDraft,
        selection,
        activation,
        ...(catalog === undefined ? {} : { runtimeCatalog: catalog })
      });
    }).catch((failure) => {
      if (active && taskMountedRef.current) setLocalError(errorText(failure));
    });
    return () => { active = false; };
  }, [
    composerSelection.end,
    composerSelection.start,
    draft,
    draftIdentityKey,
    runtimeCommandActivation?.caret,
    runtimeCommandActivation?.from,
    runtimeCommandActivation?.query,
    runtimeCommandActivation?.to,
    runtimeCommandCatalog,
    appCommandControls?.surfaceOwnerKey,
    runtimeCommandPaletteVisible
  ]);
  const selectedRuntimeCommandIndex = runtimeCommandResults.items.length === 0 ? 0
    : Math.min(runtimeCommandSelectedIndex, runtimeCommandResults.items.length - 1);
  const currentRuntimeCommandDraftLease = runtimeCommandDraftLease
    && appCommandControls && runtimeCommandActivation
    && runtimeCommandDraftLease.ownerKey === appCommandControls.surfaceOwnerKey
    && runtimeCommandDraftLease.sourceDraft === draft
    && runtimeCommandDraftLease.runtimeCatalog === runtimeCommandCatalog
    && sameComposerSelection(runtimeCommandDraftLease.selection, composerSelection)
    && sameRuntimeCommandActivation(runtimeCommandDraftLease.activation, runtimeCommandActivation)
    ? runtimeCommandDraftLease : undefined;
  runtimeCommandPaletteRef.current = {
    visible: runtimeCommandPaletteVisible,
    ...(appCommandControls === undefined ? {} : { ownerKey: appCommandControls.surfaceOwnerKey }),
    ...(runtimeCommandActivation === undefined ? {} : { activation: runtimeCommandActivation }),
    ...(runtimeCommandCatalog === undefined ? {} : { runtimeCatalog: runtimeCommandCatalog }),
    items: runtimeCommandResults.items,
    selectedIndex: selectedRuntimeCommandIndex,
    status: runtimeCommandPaletteStatus,
    ...(currentRuntimeCommandDraftLease === undefined ? {} : { draftLease: currentRuntimeCommandDraftLease })
  };
  const dismissRuntimeCommandPalette = useCallback(() => {
    const palette = runtimeCommandPaletteRef.current;
    if (!palette.visible || !palette.ownerKey || !palette.activation) return;
    setRuntimeCommandDismissal({
      ownerKey: palette.ownerKey,
      sourceDraft: composerDraftRef.current,
      selection: { ...composerSelectionRef.current },
      activation: palette.activation
    });
    setRuntimeCommandDraftLease(undefined);
  }, []);
  const commitRuntimeCommand = useCallback(async (candidate: MobileCommandPaletteCandidate): Promise<void> => {
    const palette = runtimeCommandPaletteRef.current;
    const lease = palette.draftLease;
    const identity = draftIdentityRef.current;
    if (runtimeCommandCommittingRef.current || !palette.visible
      || !lease || !identity || palette.runtimeCatalog !== lease.runtimeCatalog
      || palette.ownerKey !== lease.ownerKey || mobileComposerDraftIdentityKey(identity) !== lease.draftIdentityKey) return;
    runtimeCommandCommittingRef.current = true;
    setRuntimeCommandCommitting(true);
    setLocalError("");
    try {
      const controls = client.taskAppCommandControls();
      const currentActivation = detectMobileRuntimeCommandActivation(
        composerDraftRef.current,
        composerSelectionRef.current,
        composerComposingRef.current
      );
      if (!controls || controls.surfaceOwnerKey !== lease.ownerKey
        || composerDraftRef.current !== lease.sourceDraft
        || !sameComposerSelection(composerSelectionRef.current, lease.selection)
        || !sameRuntimeCommandActivation(currentActivation, lease.activation)) {
        throw new Error(mobileMessage(locale, "task.error.commandOwnerChanged"));
      }
      const exact = isMobileAppCommandCandidate(candidate)
        ? assertMobileAppCommandCandidate(controls, candidate)
        : assertMobileRuntimeCommandCandidate(
            palette.status === "ready" ? client.taskRuntimeCommandControls() : undefined,
            palette.status === "ready" ? lease.runtimeCatalog : undefined,
            candidate
          );
      const result = replaceMobileRuntimeCommandRun(lease.sourceDraft, lease.activation, exact);
      if (!mobileComposerDrafts.saveIfRevision(identity, result.draft, lease.revision)) {
        throw new Error(mobileMessage(locale, "task.error.commandInsertChanged"));
      }
      composerDraftRef.current = result.draft;
      composerSelectionRef.current = result.selection;
      setDraft(result.draft);
      setComposerSelection(result.selection);
      setRuntimeCommandDraftLease(undefined);
      setRuntimeCommandDismissal(undefined);
      setRuntimeCommandSelectedIndex(0);
      try {
        await mobileComposerDrafts.flush(identity);
      } catch (failure) {
        if (taskMountedRef.current && draftIdentityRef.current
          && mobileComposerDraftIdentityKey(draftIdentityRef.current) === lease.draftIdentityKey) {
          setLocalError(errorText(failure));
        }
      }
      if (taskMountedRef.current && draftIdentityRef.current
        && mobileComposerDraftIdentityKey(draftIdentityRef.current) === lease.draftIdentityKey
        && mobileComposerDraftsEqual(composerDraftRef.current, result.draft)) {
        setTimeout(() => {
          if (!taskMountedRef.current || AppState.currentState !== "active" || draftIdentityRef.current === undefined
            || mobileComposerDraftIdentityKey(draftIdentityRef.current) !== lease.draftIdentityKey
            || !mobileComposerDraftsEqual(composerDraftRef.current, result.draft)) return;
          composerInputRef.current?.focus();
        }, 0);
      }
    } catch (failure) {
      if (taskMountedRef.current) {
        const retained = mobileComposerDrafts.readSync(identity);
        if (retained && !mobileComposerDraftsEqual(retained, composerDraftRef.current)) {
          composerDraftRef.current = retained;
          setDraft(retained);
          const selection = boundedComposerSelection(composerSelectionRef.current, retained.text.length);
          composerSelectionRef.current = selection;
          setComposerSelection(selection);
        }
        setRuntimeCommandDraftLease(undefined);
        setLocalError(errorText(failure));
      }
    } finally {
      runtimeCommandCommittingRef.current = false;
      if (taskMountedRef.current) setRuntimeCommandCommitting(false);
    }
  }, []);
  const handleRuntimeCommandPaletteKey = useCallback((key: MobileComposerCommandPaletteKey) => {
    const palette = runtimeCommandPaletteRef.current;
    if (!palette.visible) return;
    const selected = palette.items[Math.max(0, Math.min(palette.selectedIndex, palette.items.length - 1))];
    const decision = resolveMobileRuntimeCommandPaletteKey(
      key,
      palette.items,
      palette.selectedIndex,
      palette.draftLease !== undefined && selected !== undefined
        && (isMobileAppCommandCandidate(selected) || palette.status === "ready")
    );
    if (decision.kind === "dismiss") {
      dismissRuntimeCommandPalette();
      return;
    }
    if (decision.kind === "move") {
      setRuntimeCommandSelectedIndex(decision.selectedIndex);
      return;
    }
    if (decision.kind === "commit") void commitRuntimeCommand(decision.candidate);
  }, [commitRuntimeCommand, dismissRuntimeCommandPalette]);
  useEffect(() => {
    if (!runtimeCommandPaletteVisible) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      dismissRuntimeCommandPalette();
      return true;
    });
    return () => subscription.remove();
  }, [dismissRuntimeCommandPalette, runtimeCommandPaletteVisible]);
  const openTimelineImage = (row: TimelineRow, image: MobileImageGalleryPageSummary): void => {
    if (galleryOpening || imageGallery.view || state.status !== "connected" || state.busy
      || attachmentBusy || voice.busy || !row.completed) return;
    setGalleryOpening(true);
    setComposerNotice("");
    setLocalError("");
    void imageGallery.open((signal) => client.openTimelineImageGallery(image.sourceEventId ?? row.eventId, image.pageId, signal))
      .catch((error) => {
        if (taskMountedRef.current) setLocalError(errorText(error));
      }).finally(() => {
        if (taskMountedRef.current) setGalleryOpening(false);
      });
  };
  const openTimelineArtifact = (artifact: MobileTimelineArtifact): void => {
    if (!artifact.previewKind) return;
    if (state.timelinePreview || galleryOpening || imageGallery.view || state.status !== "connected"
      || state.busy || attachmentBusy || voice.busy || fileShareBusy) return;
    setComposerNotice("");
    setLocalError("");
    setTimelinePreviewSource(artifact);
    void client.previewTimelineArtifact(artifact).catch((error) => {
      if (taskMountedRef.current) {
        setTimelinePreviewSource(undefined);
        setLocalError(errorText(error));
      }
    });
  };
  const shareTimelineArtifact = (artifact: MobileTimelineArtifact): void => {
    if (fileShareAbortRef.current || state.status !== "connected" || state.busy
      || attachmentBusy || voice.busy || galleryOpening || imageGallery.view) return;
    const controller = new AbortController();
    fileShareAbortRef.current = controller;
    setFileShareBusy(true);
    setFileShareProgress(undefined);
    setComposerNotice("");
    setLocalError("");
    void client.shareTimelineArtifact(artifact, (progress) => {
      if (taskMountedRef.current && fileShareAbortRef.current === controller) setFileShareProgress(progress);
    }, controller.signal).then(() => {
      if (taskMountedRef.current && fileShareAbortRef.current === controller) {
        setComposerNotice(mobileMessage(locale, "task.shareCompleted"));
      }
    }).catch((error) => {
      if (!controller.signal.aborted && taskMountedRef.current && fileShareAbortRef.current === controller) {
        setLocalError(errorText(error));
      }
    }).finally(() => {
      if (fileShareAbortRef.current === controller) fileShareAbortRef.current = undefined;
      if (taskMountedRef.current) {
        setFileShareBusy(false);
        setFileShareProgress(undefined);
      }
    });
  };
  useEffect(() => {
    if (!voice.busy) return;
    setRuntimeControlsVisible(false);
    setContextVisible(false);
    setNativeTreeVisible(false);
    setSessionMentionsVisible(false);
    setWorkspaceMentionsVisible(false);
    setCatalogMentionsVisible(false);
    setSessionMentionError("");
  }, [voice.busy]);
  const addAttachments = async (source: "picker" | "camera" | "photos"): Promise<void> => {
    const controls = attachmentControls;
    const identity = draftIdentityRef.current;
    if (!controls || !identity || controls.profileId !== identity.profileId
      || attachmentOwnerRef.current !== controls.surfaceOwnerKey || !composerOwnerReady
      || queueEditRef.current || state.busy || attachmentNativeActivityRef.current) {
      const sourceName = mobileMessage(locale, source === "camera" ? "attachments.source.camera"
        : source === "photos" ? "attachments.source.photos" : "attachments.source.filePicker");
      setLocalError(mobileMessage(locale, "task.error.attachmentReopenTask", { source: sourceName }));
      return;
    }
    const identityKey = mobileComposerDraftIdentityKey(identity);
    const generation = ++attachmentGenerationRef.current;
    const controller = new AbortController();
    attachmentAbortRef.current = controller;
    attachmentNativeActivityRef.current = true;
    setRuntimeControlsVisible(false);
    setAttachmentBusy(true);
    setLocalError("");
    let staged: readonly MobileComposerAttachment[] = [];
    try {
      staged = source === "camera"
        ? await mobileAttachmentCamera.captureAndStage(
            identity.profileId,
            composerDraftRef.current.attachments,
            controls.policy,
            randomUUID,
            controller.signal
          )
        : source === "photos"
          ? await mobilePhotoLibrary.pickSystemAndStage(
              identity.profileId,
              composerDraftRef.current.attachments,
              controls.policy,
              randomUUID,
              controller.signal
            )
          : await mobileAttachmentFiles.pickAndStage(
            identity.profileId,
            composerDraftRef.current.attachments,
            controls.policy,
            randomUUID,
            controller.signal
          );
      if (staged.length === 0) return;
      const latest = await waitForMobileAttachmentAuthority(
        { profileId: identity.profileId, surfaceOwnerKey: controls.surfaceOwnerKey },
        () => client.taskAttachmentControls(),
        (listener) => client.subscribe(() => listener()),
        {
          signal: controller.signal,
          retired: () => {
            const currentIdentity = draftIdentityRef.current;
            const current = client.state;
            return !currentIdentity || mobileComposerDraftIdentityKey(currentIdentity) !== identityKey
              || current.activeProfileId !== identity.profileId || current.selectedId !== identity.sessionId
              || current.status === "revoked" || current.status === "unpaired"
              || AppState.currentState === "active" && current.status === "connected"
                && client.taskAttachmentControls() === undefined;
          }
        }
      );
      const latestIdentity = draftIdentityRef.current;
      if (!taskMountedRef.current || attachmentGenerationRef.current !== generation
        || !latestIdentity || mobileComposerDraftIdentityKey(latestIdentity) !== identityKey
        || latest.profileId !== identity.profileId || latest.surfaceOwnerKey !== controls.surfaceOwnerKey
        || attachmentOwnerRef.current !== controls.surfaceOwnerKey || queueEditRef.current) {
        throw new Error(mobileMessage(locale, "task.error.selectedMediaChanged"));
      }
      const next = {
        ...composerDraftRef.current,
        attachments: appendMobileComposerAttachments(
          composerDraftRef.current.attachments,
          staged,
          latest.policy
        )
      };
      saveNormalDraft(next, identity);
      staged = [];
      await mobileComposerDrafts.flush(identity);
    } catch (error) {
      await Promise.all(staged.map((attachment) => mobileAttachmentFiles.remove(identity.profileId, attachment)
        .catch(() => undefined)));
      if (taskMountedRef.current && attachmentGenerationRef.current === generation) setLocalError(errorText(error));
    } finally {
      if (attachmentAbortRef.current === controller) {
        attachmentAbortRef.current = undefined;
        attachmentNativeActivityRef.current = false;
        if (taskMountedRef.current && attachmentGenerationRef.current === generation) setAttachmentBusy(false);
      }
    }
  };
  const openPhotoLibrary = (): void => {
    if (!canBrowseMobilePhotoLibraryDirectly(Platform.OS)) {
      void addAttachments("photos");
      return;
    }
    const controls = attachmentControls;
    const identity = draftIdentityRef.current;
    if (!controls || !identity || controls.profileId !== identity.profileId
      || attachmentOwnerRef.current !== controls.surfaceOwnerKey || !composerOwnerReady
      || queueEditRef.current || state.busy || attachmentNativeActivityRef.current
      || !mobilePhotoLibrarySupported(controls.policy)) {
      setLocalError(mobileMessage(locale, "task.error.photoLibraryTask"));
      return;
    }
    const generation = ++attachmentGenerationRef.current;
    const controller = new AbortController();
    const lease: MobilePhotoLibraryLease = {
      controls,
      scopeKey: mobileComposerDraftIdentityKey(identity),
      generation,
      controller
    };
    attachmentAbortRef.current = controller;
    attachmentNativeActivityRef.current = true;
    photoLibraryLeaseRef.current = lease;
    setRuntimeControlsVisible(false);
    setContextVisible(false);
    setNativeTreeVisible(false);
    setSessionMentionsVisible(false);
    setWorkspaceMentionsVisible(false);
    setCatalogMentionsVisible(false);
    setAttachmentBusy(true);
    setLocalError("");
    setPhotoLibraryLease(lease);
  };
  const closePhotoLibrary = (): void => {
    const lease = photoLibraryLeaseRef.current;
    if (!lease) return;
    lease.controller.abort();
    if (attachmentAbortRef.current === lease.controller) attachmentAbortRef.current = undefined;
    attachmentNativeActivityRef.current = false;
    photoLibraryLeaseRef.current = undefined;
    setPhotoLibraryLease(undefined);
    attachmentGenerationRef.current += 1;
    attachmentOwnerRef.current = client.taskAttachmentControls()?.surfaceOwnerKey;
    setAttachmentBusy(false);
  };
  const addPhotoLibraryAssets = async (assets: readonly MobilePhotoLibraryAsset[]): Promise<void> => {
    const lease = photoLibraryLeaseRef.current;
    const identity = draftIdentityRef.current;
    if (!lease || !identity || lease.controls.profileId !== identity.profileId
      || lease.scopeKey !== mobileComposerDraftIdentityKey(identity)
      || attachmentGenerationRef.current !== lease.generation || queueEditRef.current) {
      throw new Error(mobileMessage(locale, "task.error.photoLibraryTask"));
    }
    let staged: readonly MobileComposerAttachment[] = [];
    try {
      staged = await mobilePhotoLibrary.stageSelectedAssets(
        identity.profileId,
        composerDraftRef.current.attachments,
        lease.controls.policy,
        assets,
        randomUUID,
        lease.controller.signal
      );
      const latest = await waitForMobileAttachmentAuthority(
        { profileId: identity.profileId, surfaceOwnerKey: lease.controls.surfaceOwnerKey },
        () => client.taskAttachmentControls(),
        (listener) => client.subscribe(() => listener()),
        {
          signal: lease.controller.signal,
          retired: () => {
            const currentIdentity = draftIdentityRef.current;
            const current = client.state;
            return !currentIdentity || mobileComposerDraftIdentityKey(currentIdentity) !== lease.scopeKey
              || current.activeProfileId !== identity.profileId || current.selectedId !== identity.sessionId
              || current.status === "revoked" || current.status === "unpaired"
              || AppState.currentState === "active" && current.status === "connected"
                && client.taskAttachmentControls() === undefined;
          }
        }
      );
      const latestIdentity = draftIdentityRef.current;
      if (!taskMountedRef.current || photoLibraryLeaseRef.current !== lease
        || attachmentGenerationRef.current !== lease.generation
        || !latestIdentity || mobileComposerDraftIdentityKey(latestIdentity) !== lease.scopeKey
        || latest.profileId !== identity.profileId
        || latest.surfaceOwnerKey !== lease.controls.surfaceOwnerKey
        || attachmentOwnerRef.current !== lease.controls.surfaceOwnerKey || queueEditRef.current) {
        throw new Error(mobileMessage(locale, "task.error.selectedPhotosChanged"));
      }
      const next = {
        ...composerDraftRef.current,
        attachments: appendMobileComposerAttachments(
          composerDraftRef.current.attachments,
          staged,
          latest.policy
        )
      };
      saveNormalDraft(next, identity);
      staged = [];
      await mobileComposerDrafts.flush(identity);
    } catch (failure) {
      await Promise.all(staged.map((attachment) => mobileAttachmentFiles.remove(identity.profileId, attachment)
        .catch(() => undefined)));
      throw failure instanceof Error ? failure : new Error(errorText(failure));
    }
  };
  const removeAttachment = async (attachmentId: string): Promise<void> => {
    const identity = draftIdentityRef.current;
    if (!identity || !composerOwnerReady || queueEditRef.current || state.busy || attachmentBusy) return;
    const generation = ++attachmentGenerationRef.current;
    setAttachmentBusy(true);
    try {
      const result = removeMobileComposerAttachment(composerDraftRef.current.attachments, attachmentId);
      saveNormalDraft({ ...composerDraftRef.current, attachments: result.attachments }, identity);
      await mobileComposerDrafts.flush(identity);
      if (mobileComposerDrafts.readSync(identity)?.attachments.some(
        (attachment) => attachment.attachmentId === attachmentId
      )) {
        throw new Error(mobileMessage(locale, "task.error.attachmentRemovalTask"));
      }
      await mobileAttachmentFiles.remove(identity.profileId, result.removed);
    } catch (error) {
      if (taskMountedRef.current && attachmentGenerationRef.current === generation) setLocalError(errorText(error));
    } finally {
      if (taskMountedRef.current && attachmentGenerationRef.current === generation) setAttachmentBusy(false);
    }
  };
  const openImageEditor = async (attachmentId: string): Promise<void> => {
    const identity = draftIdentityRef.current;
    const attachment = composerDraftRef.current.attachments.find((candidate) => candidate.attachmentId === attachmentId);
    if (!identity || attachment?.kind !== "image" || !composerOwnerReady || queueEditRef.current
      || state.busy || voice.busy || attachmentNativeActivityRef.current || imageEditorLeaseRef.current) return;
    const scopeKey = mobileComposerDraftIdentityKey(identity);
    const generation = ++attachmentGenerationRef.current;
    const controller = new AbortController();
    attachmentAbortRef.current = controller;
    attachmentNativeActivityRef.current = true;
    setRuntimeControlsVisible(false);
    setContextVisible(false);
    setNativeTreeVisible(false);
    setSessionMentionsVisible(false);
    setWorkspaceMentionsVisible(false);
    setCatalogMentionsVisible(false);
    setAttachmentBusy(true);
    setLocalError("");
    let opened = false;
    try {
      const editor = await client.openComposerImageEditor({ surface: "task", attachmentId }, controller.signal);
      const currentIdentity = draftIdentityRef.current;
      if (!taskMountedRef.current || attachmentGenerationRef.current !== generation || !currentIdentity
        || mobileComposerDraftIdentityKey(currentIdentity) !== scopeKey) {
        client.cancelComposerImageEditor(editor.leaseId);
        return;
      }
      const lease = { session: editor, scopeKey };
      attachmentNativeActivityRef.current = false;
      imageEditorLeaseRef.current = lease;
      setImageEditorLease(lease);
      opened = true;
    } catch (failure) {
      if (!controller.signal.aborted && taskMountedRef.current && attachmentGenerationRef.current === generation) {
        setLocalError(errorText(failure));
      }
    } finally {
      if (attachmentAbortRef.current === controller) attachmentAbortRef.current = undefined;
      if (!opened && taskMountedRef.current && attachmentGenerationRef.current === generation) {
        attachmentNativeActivityRef.current = false;
        setAttachmentBusy(false);
      }
    }
  };
  const saveImageEditor = async (
    strokes: readonly MobileImageAnnotationStroke[],
    burned: MobileBurnedImage | undefined,
    signal: AbortSignal
  ): Promise<void> => {
    const lease = imageEditorLeaseRef.current;
    if (!lease) throw new Error(mobileMessage(locale, "task.error.imageEditorClosed"));
    const result = await client.commitComposerImageEditor(lease.session.leaseId, strokes, burned, signal);
    const identity = draftIdentityRef.current;
    if (!taskMountedRef.current || imageEditorLeaseRef.current !== lease || result.surface !== "task"
      || !identity || lease.scopeKey !== mobileComposerDraftIdentityKey(identity)) {
      throw new Error(mobileMessage(locale, "task.error.imageEditorTask"));
    }
    composerDraftRef.current = result.draft;
    setDraft(result.draft);
    const selection = composerSelectionRef.current;
    const bounded = {
      start: Math.min(selection.start, result.draft.text.length),
      end: Math.min(selection.end, result.draft.text.length)
    };
    composerSelectionRef.current = bounded;
    setComposerSelection(bounded);
  };
  const insertSessionMention = (candidate: MobileSessionMentionCandidate): void => {
    const controls = sessionMentionControls;
    if (!controls || sessionMentionOwnerRef.current !== controls.surfaceOwnerKey || queueEditRef.current) {
      setSessionMentionsVisible(false);
      setSessionMentionError("");
      setLocalError(mobileMessage(locale, "task.error.taskReferenceChanged"));
      return;
    }
    try {
      const result = insertMobileSessionMention(draft, composerSelection, candidate, randomUUID());
      setDraft(result.draft);
      setComposerSelection(result.selection);
      if (draftIdentityRef.current) mobileComposerDrafts.save(draftIdentityRef.current, result.draft);
      setSessionMentionsVisible(false);
      setSessionMentionError("");
      setTimeout(() => composerInputRef.current?.focus(), 0);
    } catch (error) {
      setSessionMentionError(errorText(error));
    }
  };
  const insertWorkspaceMention = async (
    surfaceOwnerKey: string,
    candidate: MobileWorkspaceMentionCandidate,
    lineRange?: MobileWorkspaceLineRange
  ): Promise<void> => {
    const controls = workspaceMentionControls;
    const identity = draftIdentityRef.current;
    if (!controls || controls.surfaceOwnerKey !== surfaceOwnerKey
      || workspaceMentionOwnerRef.current !== surfaceOwnerKey || queueEditRef.current || !identity) {
      setWorkspaceMentionsVisible(false);
      throw new Error(mobileMessage(locale, "task.error.workspaceReferenceChanged"));
    }
    if (lineRange !== undefined && !controls.policy.lineRanges) {
      throw new Error(mobileMessage(locale, "task.error.workspaceLineUnsupported"));
    }
    const current = await client.validateTaskWorkspaceMentionCandidate(surfaceOwnerKey, candidate);
    const latestControls = client.taskWorkspaceMentionControls();
    if (!latestControls || latestControls.surfaceOwnerKey !== surfaceOwnerKey
      || workspaceMentionOwnerRef.current !== surfaceOwnerKey || queueEditRef.current
      || !draftIdentityRef.current
      || mobileComposerDraftIdentityKey(draftIdentityRef.current) !== mobileComposerDraftIdentityKey(identity)) {
      setWorkspaceMentionsVisible(false);
      throw new Error(mobileMessage(locale, "task.error.workspaceChecking"));
    }
    const result = insertMobileWorkspaceMention(draft, composerSelection, {
      ...current,
      ...(lineRange === undefined ? {} : { lineRange })
    }, randomUUID());
    setDraft(result.draft);
    setComposerSelection(result.selection);
    mobileComposerDrafts.save(identity, result.draft);
    setWorkspaceMentionsVisible(false);
    setTimeout(() => composerInputRef.current?.focus(), 0);
  };
  const insertCatalogMention = async (
    surfaceOwnerKey: string,
    candidate: MobileCatalogMentionCandidate
  ): Promise<void> => {
    const controls = catalogMentionControls;
    const identity = draftIdentityRef.current;
    if (!controls || controls.surfaceOwnerKey !== surfaceOwnerKey
      || catalogMentionOwnerRef.current !== surfaceOwnerKey || queueEditRef.current || !identity) {
      setCatalogMentionsVisible(false);
      throw new Error(mobileMessage(locale, "task.error.catalogReferenceChanged"));
    }
    const current = await client.validateTaskCatalogMentionCandidate(surfaceOwnerKey, candidate);
    const latestControls = client.taskCatalogMentionControls();
    if (!latestControls || latestControls.surfaceOwnerKey !== surfaceOwnerKey
      || catalogMentionOwnerRef.current !== surfaceOwnerKey || queueEditRef.current
      || !draftIdentityRef.current
      || mobileComposerDraftIdentityKey(draftIdentityRef.current) !== mobileComposerDraftIdentityKey(identity)) {
      setCatalogMentionsVisible(false);
      throw new Error(mobileMessage(locale, "task.error.catalogChecking"));
    }
    const result = current.kind === "resource"
      ? insertMobileResourceMention(draft, composerSelection, current, randomUUID())
      : insertMobileArtifactMention(draft, composerSelection, current, randomUUID());
    setDraft(result.draft);
    setComposerSelection(result.selection);
    mobileComposerDrafts.save(identity, result.draft);
    setCatalogMentionsVisible(false);
    setTimeout(() => composerInputRef.current?.focus(), 0);
  };
  const removeComposerMention = (mentionId: string): void => {
    try {
      const result = removeMobileComposerMention(draft, mentionId);
      setDraft(result.draft);
      setComposerSelection(result.selection);
      if (draftIdentityRef.current) mobileComposerDrafts.save(draftIdentityRef.current, result.draft);
    } catch (error) {
      setLocalError(errorText(error));
    }
  };
  const pasteClipboardText = async (request?: MobileComposerRichPasteRequest): Promise<void> => {
    const identity = draftIdentityRef.current;
    const captured = request?.draft ?? composerDraftRef.current;
    const selection = request?.selection ?? composerSelectionRef.current;
    const ownerSnapshot = client.state.owner;
    const workspacePathControls = client.taskWorkspacePathPasteControls();
    if (!identity || !composerPasteEditableRef.current || AppState.currentState !== "active") {
      setLocalError(mobileMessage(locale, "task.error.returnActiveTaskPaste"));
      return;
    }
    const identityKey = mobileComposerDraftIdentityKey(identity);
    setLocalError("");
    try {
      const text = request?.text ?? await Clipboard.getStringAsync();
      if (!taskMountedRef.current || draftIdentityRef.current === undefined
        || mobileComposerDraftIdentityKey(draftIdentityRef.current) !== identityKey
        || composerDraftRef.current !== captured
        || composerSelectionRef.current.start !== selection.start
        || composerSelectionRef.current.end !== selection.end
        || !composerPasteEditableRef.current || queueEditRef.current
        || client.state.activeProfileId !== identity.profileId || client.state.selectedId !== identity.sessionId
        || client.state.owner !== ownerSnapshot
        || client.state.status === "unpaired" || client.state.status === "revoked"
        || AppState.currentState !== "active") {
        throw new Error(mobileMessage(locale, "task.error.taskClipboardChanged"));
      }
      const pathCandidates = workspacePathControls !== undefined && !isLongMobileComposerPaste(text)
        ? findMobileComposerWorkspacePathCandidates(text, workspacePathControls.serverPathDisplay)
        : [];
      let pathResolutions = [] as Awaited<ReturnType<typeof client.validateTaskWorkspacePathPasteCandidates>>;
      if (workspacePathControls !== undefined && pathCandidates.length > 0) {
        try {
          pathResolutions = await client.validateTaskWorkspacePathPasteCandidates(
            workspacePathControls.surfaceOwnerKey,
            pathCandidates.map((candidate) => candidate.relativePath)
          );
        } catch (failure) {
          if (client.taskWorkspacePathPasteControls()?.surfaceOwnerKey
            !== workspacePathControls.surfaceOwnerKey) throw failure;
          pathResolutions = [];
        }
        if (!taskMountedRef.current || draftIdentityRef.current === undefined
          || mobileComposerDraftIdentityKey(draftIdentityRef.current) !== identityKey
          || composerDraftRef.current !== captured
          || composerSelectionRef.current.start !== selection.start
          || composerSelectionRef.current.end !== selection.end
          || !composerPasteEditableRef.current || queueEditRef.current
          || client.state.activeProfileId !== identity.profileId || client.state.selectedId !== identity.sessionId
          || client.state.owner !== ownerSnapshot
          || client.taskWorkspacePathPasteControls()?.surfaceOwnerKey
            !== workspacePathControls.surfaceOwnerKey
          || client.state.status !== "connected" || AppState.currentState !== "active") {
          throw new Error(mobileMessage(locale, "task.error.taskWorkspaceChanged"));
        }
      }
      const result = insertMobileStructuredClipboardText(
        captured,
        selection,
        text,
        () => randomUUID(),
        workspacePathControls === undefined ? {} : {
          workspacePath: {
            workspaceId: workspacePathControls.workspaceId,
            serverPathDisplay: workspacePathControls.serverPathDisplay,
            resolutions: pathResolutions
          }
        }
      );
      composerDraftRef.current = result.draft;
      composerSelectionRef.current = result.selection;
      setDraft(result.draft);
      setComposerSelection(result.selection);
      mobileComposerDrafts.save(identity, result.draft);
      setTimeout(() => composerInputRef.current?.focus(), 0);
      if (result.insertedAtomIds.length > 0) {
        void enrichMobileComposerRouteReferences(
          result.draft,
          result.selection,
          result.insertedAtomIds,
          (target) => client.resolveComposerRouteReference(target)
        ).then((resolved) => {
          if (mobileComposerDraftsEqual(resolved.draft, result.draft)) return;
          if (!taskMountedRef.current || draftIdentityRef.current === undefined
            || mobileComposerDraftIdentityKey(draftIdentityRef.current) !== identityKey
            || composerDraftRef.current !== result.draft
            || composerSelectionRef.current.start !== result.selection.start
            || composerSelectionRef.current.end !== result.selection.end
            || !composerPasteEditableRef.current || queueEditRef.current
            || client.state.activeProfileId !== identity.profileId
            || client.state.selectedId !== identity.sessionId
            || client.state.owner !== ownerSnapshot
            || client.state.status !== "connected" || AppState.currentState !== "active") return;
          composerDraftRef.current = resolved.draft;
          composerSelectionRef.current = resolved.selection;
          setDraft(resolved.draft);
          setComposerSelection(resolved.selection);
          mobileComposerDrafts.save(identity, resolved.draft);
        }).catch(() => undefined);
      }
    } catch (failure) {
      if (taskMountedRef.current && draftIdentityRef.current
        && mobileComposerDraftIdentityKey(draftIdentityRef.current) === identityKey) {
        setLocalError(errorText(failure));
      }
    }
  };
  const startClipboardImagePaste = (request: MobileComposerRichImagePasteStartRequest): boolean => {
    const controls = attachmentControls;
    const identity = draftIdentityRef.current;
    const current = composerDraftRef.current;
    if (!controls || !identity || controls.profileId !== identity.profileId || !controls.policy.images
      || request.draft !== current || request.count > controls.policy.maximumItems - current.attachments.length
      || attachmentOwnerRef.current !== controls.surfaceOwnerKey || !composerPasteEditableRef.current
      || imagePasteLeaseRef.current !== undefined || attachmentNativeActivityRef.current || queueEditRef.current
      || client.state.activeProfileId !== identity.profileId || client.state.selectedId !== identity.sessionId
      || client.state.status !== "connected" || client.state.busy || AppState.currentState !== "active") return false;
    const generation = ++attachmentGenerationRef.current;
    const controller = new AbortController();
    const snapshot = mobileComposerDrafts.readSnapshot(identity);
    void snapshot.catch(() => undefined);
    const lease: MobileTaskImagePasteLease = {
      controller,
      controls,
      count: request.count,
      draft: current,
      generation,
      identity,
      snapshot
    };
    imagePasteLeaseRef.current = lease;
    attachmentAbortRef.current = controller;
    attachmentNativeActivityRef.current = true;
    setRuntimeControlsVisible(false);
    setContextVisible(false);
    setNativeTreeVisible(false);
    setSessionMentionsVisible(false);
    setWorkspaceMentionsVisible(false);
    setCatalogMentionsVisible(false);
    setAttachmentBusy(true);
    setPastedImageCount(request.count);
    setLocalError("");
    return true;
  };
  const cancelClipboardImagePaste = (sourceDraft: MobileComposerDraft): void => {
    const lease = imagePasteLeaseRef.current;
    if (!lease || lease.draft !== sourceDraft) return;
    lease.controller.abort();
    imagePasteLeaseRef.current = undefined;
    if (attachmentAbortRef.current === lease.controller) attachmentAbortRef.current = undefined;
    attachmentNativeActivityRef.current = false;
    attachmentGenerationRef.current += 1;
    setPastedImageCount(0);
    setAttachmentBusy(false);
  };
  const pasteClipboardImages = async (request: MobileComposerRichImagePasteRequest): Promise<void> => {
    const lease = imagePasteLeaseRef.current;
    if (!lease || request.draft !== lease.draft || request.count !== request.images.length
      || request.count !== lease.count) {
      if (lease) cancelClipboardImagePaste(lease.draft);
      setLocalError(mobileMessage(locale, "task.error.clipboardBatchTask"));
      return;
    }
    const identityKey = mobileComposerDraftIdentityKey(lease.identity);
    try {
      const result = await commitMobileComposerImagePaste({
        buildDraft: (input) => input,
        files: mobileAttachmentFiles,
        flush: () => mobileComposerDrafts.flush(lease.identity),
        imagePaste: mobileComposerImagePaste,
        input: lease.draft,
        newId: randomUUID,
        payloads: request.images,
        policy: lease.controls.policy,
        profileId: lease.identity.profileId,
        readBackMatches: (committed) => {
          const retainedDraft = mobileComposerDrafts.readSync(lease.identity);
          return retainedDraft !== null && mobileComposerDraftsEqual(retainedDraft, committed);
        },
        saveIfRevision: (next, revision) => mobileComposerDrafts.saveIfRevision(lease.identity, next, revision),
        signal: lease.controller.signal,
        snapshot: lease.snapshot,
        snapshotMatches: (stored) => mobileComposerDraftsEqual(stored ?? emptyMobileComposerDraft(), lease.draft),
        validateAuthority: () => {
          const currentIdentity = draftIdentityRef.current;
          const latest = client.taskAttachmentControls();
          if (!taskMountedRef.current || imagePasteLeaseRef.current !== lease
            || attachmentGenerationRef.current !== lease.generation
            || attachmentAbortRef.current !== lease.controller || lease.controller.signal.aborted
            || !currentIdentity || mobileComposerDraftIdentityKey(currentIdentity) !== identityKey
            || composerDraftRef.current !== lease.draft || queueEditRef.current
            || client.state.activeProfileId !== lease.identity.profileId
            || client.state.selectedId !== lease.identity.sessionId || client.state.status !== "connected"
            || client.state.busy || AppState.currentState !== "active"
            || attachmentOwnerRef.current !== lease.controls.surfaceOwnerKey
            || !sameMobileAttachmentControls(latest, lease.controls)) {
            throw new Error(mobileMessage(locale, "task.error.clipboardAttachmentChanged"));
          }
        }
      });
      const currentIdentity = draftIdentityRef.current;
      if (!taskMountedRef.current || imagePasteLeaseRef.current !== lease
        || attachmentGenerationRef.current !== lease.generation || !currentIdentity
        || mobileComposerDraftIdentityKey(currentIdentity) !== identityKey) return;
      composerDraftRef.current = result.draft;
      setDraft(result.draft);
      setComposerSelection(composerSelectionRef.current);
    } catch (failure) {
      const currentIdentity = draftIdentityRef.current;
      if (taskMountedRef.current && currentIdentity
        && mobileComposerDraftIdentityKey(currentIdentity) === identityKey && !queueEditRef.current) {
        const recovered = mobileComposerDrafts.readSync(lease.identity) ?? emptyMobileComposerDraft();
        const selection = boundedComposerSelection(composerSelectionRef.current, recovered.text.length);
        composerDraftRef.current = recovered;
        composerSelectionRef.current = selection;
        setDraft(recovered);
        setComposerSelection(selection);
        if (attachmentGenerationRef.current === lease.generation) setLocalError(errorText(failure));
      }
    } finally {
      if (imagePasteLeaseRef.current === lease) imagePasteLeaseRef.current = undefined;
      if (attachmentAbortRef.current === lease.controller) attachmentAbortRef.current = undefined;
      if (taskMountedRef.current && attachmentGenerationRef.current === lease.generation) {
        attachmentNativeActivityRef.current = false;
        setPastedImageCount(0);
        setAttachmentBusy(false);
      }
    }
  };
  const removeComposerAtom = (atomId: string): void => {
    const identity = draftIdentityRef.current;
    if (!identity || queueEditRef.current) return;
    try {
      const result = removeMobileComposerAtom(composerDraftRef.current, atomId);
      composerDraftRef.current = result.draft;
      composerSelectionRef.current = result.selection;
      setDraft(result.draft);
      setComposerSelection(result.selection);
      mobileComposerDrafts.save(identity, result.draft);
      setComposerAtomId(undefined);
    } catch (failure) {
      setLocalError(errorText(failure));
    }
  };
  const savePastedTextAtom = (atomId: string, text: string): void => {
    const identity = draftIdentityRef.current;
    if (!identity || queueEditRef.current) return;
    try {
      const result = updateMobilePastedTextAtom(composerDraftRef.current, atomId, text);
      composerDraftRef.current = result.draft;
      composerSelectionRef.current = result.selection;
      setDraft(result.draft);
      setComposerSelection(result.selection);
      mobileComposerDrafts.save(identity, result.draft);
      setComposerAtomId(undefined);
    } catch (failure) {
      setLocalError(errorText(failure));
    }
  };
  const addSelectedQuote = (selection: MobileComposerSelection): void => {
    const captured = quoteSelection;
    const identity = draftIdentityRef.current;
    if (!captured || !identity) return;
    const identityKey = mobileComposerDraftIdentityKey(identity);
    const activeQueueEdit = queueEditRef.current;
    const currentNormalDraft = activeQueueEdit?.stashedDraft ?? composerDraftRef.current;
    const latest = timelineRows(client.state.window
      ?? [...client.state.older, ...(client.state.detail?.timeline ?? []), ...client.state.live])
      .find((row) => row.eventId === captured.lease.sourceEventId && row.id === captured.lease.sourceMessageId);
    try {
      if (captured.draftIdentityKey !== identityKey || currentNormalDraft !== captured.draft
        || captured.queueLease !== activeQueueEdit?.lease || AppState.currentState !== "active") {
        throw new Error(mobileMessage(locale, "task.error.quoteComposerChanged"));
      }
      const result = commitMobileQuoteSelection({
        lease: captured.lease,
        currentSessionId: client.state.selectedId,
        latestRow: latest,
        selection,
        draft: currentNormalDraft,
        atomId: randomUUID()
      });
      if (activeQueueEdit === undefined) {
        composerDraftRef.current = result.draft;
        composerSelectionRef.current = result.selection;
        setDraft(result.draft);
        setComposerSelection(result.selection);
      } else {
        const updated = { ...activeQueueEdit, stashedDraft: result.draft };
        queueEditRef.current = updated;
        setQueueEdit(updated);
      }
      mobileComposerDrafts.save(identity, result.draft);
      setQuoteSelection(undefined);
    } catch (failure) {
      setQuoteSelection(undefined);
      setLocalError(errorText(failure));
    }
  };
  const appendToNormalDraft = (text: string): void => {
    const active = queueEditRef.current;
    const result = addToMobileComposer({
      visibleDraft: draft,
      ...(active ? { queueStashedDraft: active.stashedDraft } : {}),
      addition: text
    });
    if (!active) {
      saveNormalDraft(result.normalDraft);
      return;
    }
    const updated = { ...active, stashedDraft: result.normalDraft };
    queueEditRef.current = updated;
    setQueueEdit(updated);
    mobileComposerDrafts.save({ profileId: active.profileId, sessionId: active.lease.sessionId }, result.normalDraft);
  };
  const runMessageAction = (action: MobileMessageActionId): void => {
    if (state.status !== "connected" || voice.busy) return;
    const selected = messageAction;
    setMessageAction(undefined);
    if (!selected || client.state.selectedId !== selected.sessionId) return;
    const latest = timelineRows(client.state.window
      ?? [...client.state.older, ...(client.state.detail?.timeline ?? []), ...client.state.live])
      .find((row) => row.eventId === selected.row.eventId && row.completed);
    if (!latest) return;
    if (action === "quote-selection") {
      const identity = draftIdentityRef.current;
      const lease = captureMobileQuoteSelection(selected.sessionId, latest);
      if (!identity || !lease || queueEditRef.current?.lease.sessionId !== undefined
        && queueEditRef.current.lease.sessionId !== selected.sessionId) {
        setLocalError(mobileMessage(locale, "task.error.quoteUnavailable"));
        return;
      }
      const activeQueueEdit = queueEditRef.current;
      const normalDraft = activeQueueEdit?.stashedDraft ?? composerDraftRef.current;
      setQuoteSelection({
        lease,
        draft: normalDraft,
        draftIdentityKey: mobileComposerDraftIdentityKey(identity),
        ...(activeQueueEdit === undefined ? {} : { queueLease: activeQueueEdit.lease })
      });
      return;
    }
    if (action === "add-to-composer") {
      appendToNormalDraft(latest.text);
      return;
    }
    if (!client.canDeleteMessage(latest.eventId)) {
      setLocalError(mobileMessage(locale, "task.error.messageNotDeletable"));
      return;
    }
    Alert.alert(
      mobileMessage(locale, "actions.deleteMessageTitle"),
      mobileMessage(locale, "actions.deleteMessageBody"),
      [
        { text: mobileMessage(locale, "common.cancel"), style: "cancel" },
        { text: mobileMessage(locale, "common.delete"), style: "destructive", onPress: () => {
          setLocalError("");
          void client.deleteMessage(latest.eventId).catch((error) => {
            if (taskMountedRef.current) setLocalError(errorText(error));
          });
        } }
      ]
    );
  };
  const beginQueueEdit = async (item: QueueItem): Promise<void> => {
    const profileId = state.activeProfileId;
    if (!profileId || state.status !== "connected" || !composerOwnerReady || interactions.length > 0 || voice.busy) return;
    const stashedDraft = draft;
    setSessionMentionsVisible(false);
    setWorkspaceMentionsVisible(false);
    setCatalogMentionsVisible(false);
    setLocalError("");
    try {
      const lease = await client.beginQueueEdit(item.queueItemId);
      if (!taskMountedRef.current || client.state.activeProfileId !== profileId
        || client.state.selectedId !== lease.sessionId) {
        await client.cancelQueueEdit(lease).catch(() => undefined);
        return;
      }
      const active = { lease, profileId, stashedDraft };
      queueEditRef.current = active;
      setQueueEdit(active);
      const queuedDraft = plainTextMobileComposerDraft(lease.text);
      setDraft(queuedDraft);
      setComposerSelection({ start: queuedDraft.text.length, end: queuedDraft.text.length });
    } catch (error) {
      if (taskMountedRef.current) setLocalError(errorText(error));
    }
  };
  const cancelQueueEdit = (): void => {
    const active = queueEditRef.current;
    if (!active) return;
    setLocalError("");
    void client.cancelQueueEdit(active.lease).then(() => {
      if (!taskMountedRef.current || queueEditRef.current !== active) return;
      queueEditRef.current = undefined;
      setQueueEdit(undefined);
      setDraft(active.stashedDraft);
      setComposerSelection({ start: active.stashedDraft.text.length, end: active.stashedDraft.text.length });
    }).catch((error) => {
      if (taskMountedRef.current) setLocalError(errorText(error));
    });
  };
  useEffect(() => {
    const active = queueEditRef.current;
    if (!active || interactions.length === 0) return;
    void client.cancelQueueEdit(active.lease).then(() => {
      if (!taskMountedRef.current || queueEditRef.current !== active) return;
      queueEditRef.current = undefined;
      setQueueEdit(undefined);
      if (client.state.activeProfileId === active.profileId && client.state.selectedId === active.lease.sessionId) {
        setDraft(active.stashedDraft);
        setComposerSelection({ start: active.stashedDraft.text.length, end: active.stashedDraft.text.length });
      }
    }).catch((error) => {
      if (taskMountedRef.current) setLocalError(errorText(error));
    });
  }, [interactionIdsKey, state.activeProfileId, state.selectedId]);
  const submitComposer = async (): Promise<void> => {
    if (voice.busy) return;
    setLocalError("");
    const active = queueEditRef.current;
    let appCommandStarted = false;
    try {
      if (!active) {
        const identity = draftIdentityRef.current;
        const sourceDraft = composerDraftRef.current;
        const intent = mobileAppCommandIntent(sourceDraft);
        if (intent !== undefined) {
          const controls = client.taskAppCommandControls();
          const invocation = parseMobileAppCommand(sourceDraft, controls);
          if (!identity || !controls || !invocation) {
            throw new Error(mobileMessage(locale, "task.error.commandInvalid"));
          }
          if (composerOperationPending) return;
          const helpItems = controls.surfaceOwnerKey === appCommandControls?.surfaceOwnerKey
            ? [...mergeMobileCommandPaletteCandidates(
                controls,
                runtimeCommandPaletteStatus === "ready" ? runtimeCommandCatalog?.items : undefined
              )]
            : [...mobileAppCommandCandidates(controls)];
          appCommandStarted = true;
          setAppCommandRunning(true);
          setRuntimeCommandDraftLease(undefined);
          const outcome = await client.executeTaskAppCommand(controls.surfaceOwnerKey, invocation, sourceDraft);
          const currentIdentity = draftIdentityRef.current;
          if (taskMountedRef.current && currentIdentity
            && mobileComposerDraftIdentityKey(currentIdentity) === mobileComposerDraftIdentityKey(identity)) {
            const retained = mobileComposerDrafts.readSync(identity);
            const next = retained ?? emptyMobileComposerDraft();
            composerDraftRef.current = next;
            setDraft(next);
            const selection = { start: next.text.length, end: next.text.length };
            composerSelectionRef.current = selection;
            setComposerSelection(selection);
          }
          if (!taskMountedRef.current) return;
          if (outcome.kind === "help") {
            setCommandHelpItems(helpItems);
          } else if (outcome.status === "unknown") {
            setComposerNotice(mobileMessage(locale, "task.command.unknown"));
          } else if (outcome.status === "rejected") {
            setLocalError(mobileMessage(locale, "task.command.rejected"));
          } else if (outcome.kind === "userShell") {
            setComposerNotice(mobileMessage(locale, "task.command.shellComplete"));
          } else if (outcome.kind === "sessionReset") {
            setComposerNotice(mobileMessage(locale, "task.command.contextCleared"));
          } else if (outcome.kind === "review") {
            setComposerNotice(mobileMessage(locale, "task.command.reviewStarted"));
          }
          return;
        }
        if (!await client.send(composerDraftRef.current)) {
          if (identity && draftIdentityRef.current
            && mobileComposerDraftIdentityKey(draftIdentityRef.current) === mobileComposerDraftIdentityKey(identity)) {
            const retainedDraft = mobileComposerDrafts.readSync(identity);
            if (retainedDraft) saveNormalDraft(retainedDraft, identity);
          }
          return;
        }
        if (!identity) {
          setDraft(emptyMobileComposerDraft());
          setComposerSelection({ start: 0, end: 0 });
          return;
        }
        if (draftIdentityRef.current
          && mobileComposerDraftIdentityKey(draftIdentityRef.current) === mobileComposerDraftIdentityKey(identity)
          && !queueEditRef.current && mobileComposerDrafts.readSync(identity) === null) {
          setDraft(emptyMobileComposerDraft());
          setComposerSelection({ start: 0, end: 0 });
        }
        return;
      }
      if (!await client.saveQueueEdit(active.lease, draft.text)) return;
      if (queueEditRef.current !== active) return;
      queueEditRef.current = undefined;
      setQueueEdit(undefined);
      setDraft(active.stashedDraft);
      setComposerSelection({ start: active.stashedDraft.text.length, end: active.stashedDraft.text.length });
    } catch (error) {
      if (taskMountedRef.current) {
        const identity = draftIdentityRef.current;
        if (identity && !queueEditRef.current) {
          const retainedDraft = mobileComposerDrafts.readSync(identity);
          if (retainedDraft) saveNormalDraft(retainedDraft, identity);
        }
        setLocalError(errorText(error));
      }
    } finally {
      if (appCommandStarted && taskMountedRef.current) setAppCommandRunning(false);
    }
  };
  const mutateQueue = (action: () => Promise<unknown>): void => {
    setLocalError("");
    void action().catch((error) => {
      if (taskMountedRef.current) setLocalError(errorText(error));
    });
  };
  const queueDrawerAction = (action: () => void): void => {
    if (pendingDrawerActionRef.current) return;
    pendingDrawerActionRef.current = action;
    setDrawerOpen(false);
  };
  return <View style={styles.fill}>
    <MobileKeyboardAvoidingView style={styles.fill} keyboard={keyboard} consumedBottomInset={safeArea.bottom}
      behavior={Platform.OS === "android" ? "height" : undefined}
      accessibilityElementsHidden={drawerMounted} importantForAccessibility={drawerMounted ? "no-hide-descendants" : "auto"}>
    <View style={styles.header}>
      {wideNavigation.enabled ? <Pressable ref={drawerMenuRef} accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "task.openList")}
        onPress={() => { pendingDrawerActionRef.current = undefined; setDrawerOpen(true); }}
        style={[styles.headerIconButton, { borderColor: colors.border, backgroundColor: colors.surface }]}>
        <Text style={[styles.headerIcon, { color: colors.ink }]}>☰</Text>
      </Pressable> : <Back label={mobileMessage(locale, "common.tasks")}
        accessibilityLabel={mobileMessage(locale, "common.backTo", { label: mobileMessage(locale, "common.tasks") })}
        onPress={onBack} colors={colors} />}
      <View style={styles.fill}>
        <Text style={[styles.title, { color: colors.ink }]} numberOfLines={1}>{session?.displayName || mobileMessage(locale, "task.titleFallback")}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{session ? sessionState(session.state, locale) : mobileMessage(locale, "task.loading")}</Text>
      </View>
      <View style={styles.headerActions}>
        <Action label={mobileMessage(locale, "task.branches")}
          onPress={() => { setSessionMentionsVisible(false); setWorkspaceMentionsVisible(false); setCatalogMentionsVisible(false); setContextVisible(false); setRuntimeControlsVisible(false); setNativeTreeVisible(true); }} colors={colors} compact
          disabled={state.status !== "connected" || nativeTreeControls === undefined || state.busy || attachmentBusy || voice.busy || interactions.length > 0} />
        <Action label={contextControls?.usage ? mobileMessage(locale, "task.contextPercent", { percent: contextControls.usage.percent }) : mobileMessage(locale, "task.context")}
          onPress={() => { setSessionMentionsVisible(false); setWorkspaceMentionsVisible(false); setCatalogMentionsVisible(false); setNativeTreeVisible(false); setRuntimeControlsVisible(false); setContextVisible(true); }} colors={colors} compact
          disabled={state.status !== "connected" || contextControls === undefined || state.busy || attachmentBusy || voice.busy || interactions.length > 0} />
        <Action label={mobileMessage(locale, "task.controls")} onPress={() => { setSessionMentionsVisible(false); setWorkspaceMentionsVisible(false); setCatalogMentionsVisible(false); setNativeTreeVisible(false); setContextVisible(false); setRuntimeControlsVisible(true); }} colors={colors} compact
          disabled={state.status !== "connected" || !runtimeControlsAvailable || state.busy || attachmentBusy || voice.busy || interactions.length > 0} />
        {client.canOpenFiles() && <Action label={mobileMessage(locale, "task.files")} onPress={onFiles} colors={colors} compact
          disabled={state.status !== "connected" || attachmentBusy} />}
        <Action label={mobileMessage(locale, "common.refresh")} onPress={() => void client.refresh()} colors={colors} compact disabled={attachmentBusy} />
      </View>
    </View>
    <Text accessibilityLiveRegion="polite" style={[styles.caption, styles.queue, { color: colors.muted }]}>
      {mobileMessage(locale, state.liveStatus === "streaming" ? "task.live"
        : state.liveStatus === "verifying" ? "task.checkingLive"
          : state.liveStatus === "polling" ? "task.polling" : "task.updatesPaused")}
    </Text>
    {state.status === "offline" && state.offlineSnapshotAt !== undefined
      && <MobileOfflineNotice cachedAt={state.offlineSnapshotAt} locale={locale} colors={colors} />}
    {state.error && <Banner text={state.error} colors={colors} />}
    {fileShareBusy && <View accessibilityLiveRegion="polite" style={[styles.connectionNotice, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <ActivityIndicator color={colors.accent} />
      <Text style={[styles.caption, styles.fill, { color: colors.muted }]}>{formatMobileFileShareProgress(fileShareProgress, locale)}</Text>
    </View>}
    <FlatList data={rows} keyExtractor={(row) => row.id} style={styles.fill} contentContainerStyle={styles.list}
      ListHeaderComponent={<View style={styles.historyActions}>
        {state.window && <Action label={mobileMessage(locale, "task.returnLatest")} colors={colors} onPress={() => client.latest()} />}
        {!state.historyEnd && <Action label={mobileMessage(locale, state.historyBusy ? "task.loadingHistory" : "task.loadEarlier")} colors={colors}
          disabled={state.historyBusy || state.status !== "connected"}
          onPress={() => void client.older().catch((error) => setLocalError(errorText(error)))} />}
      </View>}
      ListEmptyComponent={<Centered label={mobileMessage(locale, state.status === "offline"
        ? state.detail ? "task.offlineEmpty" : "task.offlineMissing" : "task.empty")} colors={colors} />}
      renderItem={({ item }) => <View style={[styles.message, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.caption, { color: colors.muted }]}>{item.label}</Text>
        <Text selectable style={[styles.body, { color: colors.ink }]}>{item.text}</Text>
        {item.images && item.images.length > 0 && <View accessibilityLabel={`${item.label} · ${mobileMessage(locale, "task.images", { count: item.images.length })}`} style={styles.messageImages}>
          {item.images.map((image, index) => <Pressable key={image.pageId} accessibilityRole="imagebutton"
            accessibilityLabel={mobileMessage(locale, "task.openImage", { index: index + 1, count: item.images!.length, name: image.title })}
            accessibilityHint={mobileMessage(locale, "task.openImageHint")}
            disabled={galleryOpening || imageGallery.view !== undefined || state.status !== "connected" || attachmentBusy || voice.busy}
            onPress={() => openTimelineImage(item, image)}
            style={[styles.messageImageTile, { borderColor: colors.border, backgroundColor: colors.background },
              (galleryOpening || imageGallery.view !== undefined || state.status !== "connected" || attachmentBusy || voice.busy)
                && styles.disabled]}>
            <Text style={styles.messageImageGlyph}>▧</Text>
            <View style={styles.fill}>
              <Text style={[styles.label, { color: colors.ink }]} numberOfLines={1}>{image.title}</Text>
              <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>
                {image.mediaType}{image.widthPixels && image.heightPixels
                  ? ` · ${image.widthPixels} × ${image.heightPixels}` : ""} · {formatByteSize(BigInt(image.byteSize))}
              </Text>
            </View>
            <Text style={[styles.caption, { color: colors.accent }]}>{mobileMessage(locale, "common.open")}</Text>
          </Pressable>)}
        </View>}
        {item.artifacts && item.artifacts.length > 0 && <View accessibilityLabel={`${item.label} · ${mobileMessage(locale, "task.filesCount", { count: item.artifacts.length })}`} style={styles.messageImages}>
          {item.artifacts.map((artifact) => {
            const disabled = state.timelinePreview !== undefined || galleryOpening || imageGallery.view !== undefined
              || state.status !== "connected" || state.busy || attachmentBusy || voice.busy || fileShareBusy;
            const detail = <>
              <Text style={styles.messageImageGlyph}>{artifact.previewKind === "pdf" ? "▤"
                : artifact.previewKind === "model" ? "⬡" : artifact.previewKind === "media" ? "▶" : "◆"}</Text>
              <View style={styles.fill}>
                <Text style={[styles.label, { color: colors.ink }]} numberOfLines={1}>{artifact.title}</Text>
                <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>
                  {artifact.mediaType} · {formatByteSize(artifact.byteSize)}
                </Text>
              </View>
              <Text style={[styles.caption, { color: artifact.previewKind ? colors.accent : colors.muted }]}>
                {mobileMessage(locale, artifact.previewKind ? "common.open" : "task.fileFallback")}
              </Text>
            </>;
            return <View key={artifact.artifactId} style={styles.fileActionRow}>
              {artifact.previewKind ? <Pressable accessibilityRole="button"
                accessibilityLabel={mobileMessage(locale, "task.openFile", { name: artifact.title, type: artifact.mediaType })}
                accessibilityHint={mobileMessage(locale, "task.openFileHint")}
                disabled={disabled} onPress={() => openTimelineArtifact(artifact)}
                style={[styles.messageImageTile, styles.fileRowMain,
                  { borderColor: colors.border, backgroundColor: colors.background }, disabled && styles.disabled]}>
                {detail}
              </Pressable> : <View accessible accessibilityLabel={`${artifact.title}, ${artifact.mediaType}`}
                style={[styles.messageImageTile, styles.fileRowMain,
                  { borderColor: colors.border, backgroundColor: colors.background }, disabled && styles.disabled]}>
                {detail}
              </View>}
              <Action label={mobileMessage(locale, fileShareBusy ? "image.sharing" : "common.share")}
                accessibilityLabel={mobileMessage(locale, "task.shareFile", { name: artifact.title })} compact colors={colors} disabled={disabled}
                onPress={() => shareTimelineArtifact(artifact)} />
            </View>;
          })}
        </View>}
        <View style={styles.messageActions}>
          <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "task.viewContextFor", { name: item.label })}
            disabled={state.historyBusy || state.status !== "connected"}
            onPress={() => { setLocalError(""); void client.around(item.eventId).catch((error) => setLocalError(errorText(error))); }}
            style={styles.inlineTouchAction}>
            <Text style={[styles.caption, { color: colors.accent }]}>{mobileMessage(locale, "task.viewContext")}</Text>
          </Pressable>
           {buildMobileMessageActions(item, { canDelete: client.canDeleteMessage(item.eventId) }).length > 0
            && <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "task.moreFor", { name: item.label })}
              disabled={state.status !== "connected" || voice.busy} onPress={() => openMessageActions(item)}
              style={[styles.inlineTouchAction, (state.status !== "connected" || voice.busy) && styles.disabled]}>
              <Text style={[styles.caption, { color: state.status !== "connected" || voice.busy ? colors.muted : colors.accent }]}>{mobileMessage(locale, "common.more")}</Text>
            </Pressable>}
        </View>
      </View>} />
    {queueItems.length > 0 && <View style={styles.queueRegion}>
      <Text style={[styles.section, { color: colors.muted }]}>{mobileMessage(locale, "task.queue")}</Text>
      <ScrollView nestedScrollEnabled style={styles.queueScroll} contentContainerStyle={styles.queueList}
        keyboardShouldPersistTaps="handled">
      {queueItems.map((item, index) => {
        const editing = queueEdit?.lease.queueItemId === item.queueItemId;
        const disabled = state.busy || voice.busy || state.status !== "connected" || queueMutationPending || interactions.length > 0 || (!!queueEdit && !editing);
        const editableText = queueItemText(item.input);
        return <View key={item.queueItemId} style={[styles.queueCard, { backgroundColor: colors.surface, borderColor: editing ? colors.accent : colors.border }]}>
          <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "task.queued")} {index + 1} · {queueState(item.state, locale)}{item.editLocked && !editing ? mobileMessage(locale, "task.editingElsewhere") : ""}</Text>
          <Text selectable style={[styles.body, { color: colors.ink }]}>{queueItemSummary(item, locale)}</Text>
          <View style={styles.queueActions}>
            {queueCapabilities.edit && <Action label={editing ? mobileMessage(locale, "composer.editing") : mobileMessage(locale, "common.edit")} colors={colors} compact
              disabled={disabled || editing || item.editLocked || editableText === undefined}
              onPress={() => void beginQueueEdit(item)} />}
            {queueCapabilities.cancel && <Action label={mobileMessage(locale, "common.remove")} colors={colors} compact
              disabled={disabled || editing}
              onPress={() => mutateQueue(() => client.cancelQueueItem(item.queueItemId))} />}
            {queueCapabilities.reorder && <Action label={mobileMessage(locale, "task.moveUp")} colors={colors} compact
              disabled={disabled || editing || index === 0}
              onPress={() => mutateQueue(() => client.moveQueueItem(item.queueItemId, "up"))} />}
            {queueCapabilities.reorder && <Action label={mobileMessage(locale, "task.moveDown")} colors={colors} compact
              disabled={disabled || editing || index === queueItems.length - 1}
              onPress={() => mutateQueue(() => client.moveQueueItem(item.queueItemId, "down"))} />}
          </View>
        </View>;
      })}
      </ScrollView>
    </View>}
    {state.pending.filter((item) => item.sessionId === state.selectedId).map((item) => <View key={item.operationId} style={styles.pending}>
      <Text style={[styles.warning, { color: colors.negative }]}>{mobileMessage(locale,
        item.state === "unknown" ? "task.operationUnknown" : "task.awaitingResult")} · {item.operationId}</Text>
      <Action label={mobileMessage(locale, "receipt.check")} onPress={() => void client.reconcile()} colors={colors} compact
        disabled={state.status !== "connected"} />
      {item.state === "unknown" && <Action label={mobileMessage(locale, "task.clearReceipt")} onPress={() => Alert.alert(
        mobileMessage(locale, "task.clearReceiptTitle"), mobileMessage(locale, "task.clearReceiptBody"),
        [{ text: mobileMessage(locale, "task.keepChecking"), style: "cancel" }, { text: mobileMessage(locale, "common.verifyClear"), onPress: () => {
          void client.dismissUnconfirmed(item.operationId).catch((error) => setLocalError(errorText(error)));
        } }]
      )} colors={colors} compact disabled={state.status !== "connected"} />}
    </View>)}
    {localError && <Banner text={localError} colors={colors} />}
    {composerNotice && <View accessibilityLiveRegion="polite"
      style={[styles.connectionNotice, { backgroundColor: colors.brandBackground, borderColor: colors.accent }]}>
      <Text style={[styles.caption, styles.fill, { color: colors.ink }]}>{composerNotice}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "composer.dismissNotice")} onPress={() => setComposerNotice("")}
        style={styles.inlineTouchAction}><Text style={[styles.caption, { color: colors.accent }]}>{mobileMessage(locale, "common.dismiss")}</Text></Pressable>
    </View>}
    {queueEdit && <View style={[styles.queueEditBanner, { borderColor: colors.border, backgroundColor: colors.brandBackground }]}>
      <Text style={[styles.caption, styles.fill, { color: colors.ink }]}>
        {queueEdit.lease.replacesStructuredInput
          ? mobileMessage(locale, "composer.editingStructured")
          : mobileMessage(locale, "composer.editing")}
      </Text>
      <Action label={mobileMessage(locale, "composer.cancelEdit")} colors={colors} compact disabled={state.status !== "connected" || state.busy}
        onPress={cancelQueueEdit} />
    </View>}
    {interactions.length > 0 ? <View style={[styles.interactionAwaiting, { borderColor: colors.border, backgroundColor: colors.brandBackground }]}>
      <View style={styles.fill}>
        <Text style={[styles.caption, { color: colors.muted }]}>{interactions.length === 1
          ? mobileMessage(locale, "task.taskNeedsResponse")
          : mobileMessage(locale, "task.requestsNeedResponse", { count: interactions.length })}</Text>
        <Text style={[styles.label, { color: colors.ink }]} numberOfLines={1}>{activeInteraction
          ? mobileInteractionTitle(activeInteraction, locale) : mobileMessage(locale, "task.openRequest")}</Text>
      </View>
      <Action label={mobileMessage(locale, "task.openRequest")} colors={colors} compact disabled={interactionMutationPending}
        onPress={() => setInteractionVisible(true)} />
    </View> : <View style={[styles.composer, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <View accessible accessibilityRole="adjustable" accessibilityLabel={mobileMessage(locale, "composer.heightLabel")}
        accessibilityHint={mobileMessage(locale, "composer.heightHint")}
        accessibilityActions={[{ name: "increment", label: mobileMessage(locale, "composer.heightIncrease") },
          { name: "decrement", label: mobileMessage(locale, "composer.heightDecrease") },
          { name: "activate", label: mobileMessage(locale, "composer.heightAutomaticAction") }]}
        accessibilityValue={{ min: composerBounds.minimumHeight, max: composerBounds.maximumHeight,
          now: Math.round(composerHeight.visibleHeight), text: composerHeight.mode === "automatic"
            ? mobileMessage(locale, "composer.heightAutomatic")
            : mobileMessage(locale, "composer.heightManual", { height: Math.round(composerHeight.visibleHeight) }) }}
        onAccessibilityAction={(event) => {
          const direction = event.nativeEvent.actionName === "increment" ? "increase"
            : event.nativeEvent.actionName === "decrement" ? "decrease" : "automatic";
          setComposerManualHeight(accessibleComposerHeight({
            currentHeight: composerHeight.visibleHeight,
            direction,
            bounds: composerBounds
          }));
        }}
        style={styles.composerResizeHandle} {...composerResizeResponder.panHandlers}>
        <View style={[styles.composerGrabber, { backgroundColor: colors.border }]} />
      </View>
      {!queueEdit && (voice.available || voice.checking || voice.busy || sessionMentionControls || workspaceMentionControls || catalogMentionControls
        || attachmentControls || composerOwnerReady || draft.mentions.length > 0 || draft.atoms.length > 0
        || draft.attachments.length > 0) && <View style={styles.composerTools}>
        {(voice.available || voice.checking || voice.busy) && <MobileVoiceAction voice={voice} colors={colors} locale={locale}
          disabled={!composerOwnerReady || state.busy || composerOperationPending || attachmentBusy
            || state.status !== "connected"} />}
        {sessionMentionControls && <Action label={mobileMessage(locale, "composer.referenceTask")} colors={colors} compact
          disabled={state.status !== "connected" || state.busy || composerOperationPending || voice.busy || !composerOwnerReady
            || draft.mentions.filter((mention) => mention.kind === "session").length >= 8}
          onPress={() => {
            setNativeTreeVisible(false);
            setContextVisible(false);
            setRuntimeControlsVisible(false);
            setWorkspaceMentionsVisible(false);
            setCatalogMentionsVisible(false);
            setSessionMentionError("");
            setSessionMentionsVisible(true);
          }} />}
        {workspaceMentionControls && <Action label={mobileMessage(locale, "composer.referenceWorkspace")} colors={colors} compact
          disabled={state.status !== "connected" || state.busy || composerOperationPending || voice.busy || !composerOwnerReady}
          onPress={() => {
            setNativeTreeVisible(false);
            setContextVisible(false);
            setRuntimeControlsVisible(false);
            setSessionMentionsVisible(false);
            setCatalogMentionsVisible(false);
            setSessionMentionError("");
            setWorkspaceMentionsVisible(true);
          }} />}
        {catalogMentionControls && <Action
          label={mobileMessage(locale, catalogMentionControls.policy.resources && catalogMentionControls.policy.artifacts
            ? "composer.referenceResourceArtifact"
            : catalogMentionControls.policy.resources ? "composer.referenceResource" : "composer.referenceArtifact")}
          colors={colors} compact disabled={state.status !== "connected" || state.busy || composerOperationPending || voice.busy || !composerOwnerReady}
          onPress={() => {
            setNativeTreeVisible(false);
            setContextVisible(false);
            setRuntimeControlsVisible(false);
            setSessionMentionsVisible(false);
            setSessionMentionError("");
            setWorkspaceMentionsVisible(false);
            setCatalogMentionsVisible(true);
          }} />}
        <Action label={mobileMessage(locale, "composer.pasteText")} colors={colors} compact
          disabled={!composerPasteEditable}
          onPress={() => void pasteClipboardText()} />
        {attachmentControls && <Action label={mobileMessage(locale, attachmentBusy ? "common.selecting" : "composer.attach")}
          colors={colors} compact
          disabled={state.status !== "connected" || state.busy || composerOperationPending || voice.busy || attachmentBusy || !composerOwnerReady
            || draft.attachments.length >= attachmentControls.policy.maximumItems}
          onPress={() => void addAttachments("picker")} />}
        {attachmentControls && mobilePhotoLibrarySupported(attachmentControls.policy) && <Action label={mobileMessage(locale, "composer.photos")}
          colors={colors} compact
          disabled={state.status !== "connected" || state.busy || composerOperationPending || voice.busy || attachmentBusy || !composerOwnerReady
            || draft.attachments.length >= attachmentControls.policy.maximumItems}
          onPress={openPhotoLibrary} />}
        {attachmentControls && mobileCameraCaptureSupported(attachmentControls.policy) && <Action label={mobileMessage(locale, "composer.takePhoto")}
          colors={colors} compact
          disabled={state.status !== "connected" || state.busy || composerOperationPending || voice.busy || attachmentBusy || !composerOwnerReady
            || draft.attachments.length >= attachmentControls.policy.maximumItems}
          onPress={() => void addAttachments("camera")} />}
        {draft.mentions.length > 0 && <ScrollView horizontal keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.mentionChips} showsHorizontalScrollIndicator={false}>
          {draft.mentions.map((mention) => <Pressable key={mention.mentionId}
            accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "composer.removeReference", {
              kind: mobileMessage(locale, mention.kind === "session" ? "composer.kind.task"
                : mention.kind === "workspace" ? mention.directory ? "composer.kind.directory" : "composer.kind.file"
                  : mention.kind === "resource" ? "composer.kind.resource" : "composer.kind.artifact"),
              label: mention.displayText
            })}
            accessibilityHint={mobileMessage(locale, "composer.removeReferenceHint.task")}
            disabled={state.status !== "connected" || state.busy || composerOperationPending || voice.busy}
            onPress={() => removeComposerMention(mention.mentionId)}
            style={[styles.mentionChip, { borderColor: colors.border, backgroundColor: colors.brandBackground },
              (state.status !== "connected" || state.busy || composerOperationPending || voice.busy) && styles.disabled]}>
            <Text style={[styles.mentionChipText, { color: colors.ink }]} numberOfLines={1}>{draft.text.slice(mention.start, mention.end)} ×</Text>
          </Pressable>)}
        </ScrollView>}
        <MobileComposerAtomChips atoms={draft.atoms} colors={colors} locale={locale}
          disabled={state.status !== "connected" || state.busy || composerOperationPending || voice.busy || attachmentBusy || !composerOwnerReady}
          onOpen={setComposerAtomId} />
      </View>}
      {!queueEdit && <MobileAttachmentTray attachments={draft.attachments} colors={colors} locale={locale}
        disabled={state.status !== "connected" || state.busy || composerOperationPending || voice.busy || attachmentBusy || !composerOwnerReady}
        busy={state.busy || composerOperationPending || voice.busy || attachmentBusy}
        pendingCount={pastedImageCount}
        onPreview={(attachmentId) => void openImageEditor(attachmentId)} onRemove={removeAttachment} />}
      <MobileRuntimeCommandPalette visible={runtimeCommandPaletteVisible} locale={locale}
        query={runtimeCommandActivation?.query ?? ""} items={runtimeCommandResults.items}
        selectedIndex={selectedRuntimeCommandIndex} status={runtimeCommandPaletteStatus}
        error={runtimeCommandLoadMatches ? runtimeCommandLoad.error : undefined}
        runtimeAvailable={runtimeCommandControls !== undefined}
        disabled={runtimeCommandCommitting}
        checkingDraft={currentRuntimeCommandDraftLease === undefined}
        colors={colors} onClose={dismissRuntimeCommandPalette}
        onRefresh={loadRuntimeCommandCatalog} onRetry={loadRuntimeCommandCatalog}
        onSelect={(candidate) => { void commitRuntimeCommand(candidate); }} />
      <View style={styles.composerRow}>
        {queueEdit ? <TextInput ref={queueInputRef} accessibilityLabel={mobileMessage(locale, "composer.queuedInput")} multiline
          value={composerOwnerReady ? draft.text : ""} selection={composerSelection}
          maxLength={mobileComposerNativeInputMaximumCharacters}
          onSelectionChange={(event) => {
            const nextSelection = boundedComposerSelection(event.nativeEvent.selection, draft.text.length);
            composerSelectionRef.current = nextSelection;
            setComposerSelection(nextSelection);
          }}
          onChangeText={(value) => setDraft(plainTextMobileComposerDraft(value))}
          onContentSizeChange={(event) => setComposerContentHeight(Math.max(
            composerMinimumInputHeight,
            Math.ceil(event.nativeEvent.contentSize.height)
          ))}
          scrollEnabled={composerHeight.scrollEnabled}
          editable={state.status === "connected" && !state.busy && !composerOperationPending && composerOwnerReady}
          placeholder={mobileMessage(locale, "composer.editQueued")}
          placeholderTextColor={colors.muted}
          style={[styles.composerInput, { color: colors.ink, height: composerHeight.visibleHeight }]} />
          : <MobileComposerRichInput key={`task-rich-${draftIdentityKey ?? "none"}`}
            ref={composerInputRef} accessibilityLabel={mobileMessage(locale, "composer.taskMessage")}
            commandPaletteOpen={runtimeCommandPaletteVisible}
            draft={composerOwnerReady ? draft : emptyMobileComposerDraft()}
            editable={composerPasteEditable} height={composerHeight.visibleHeight} locale={locale}
            maxHeight={composerBounds.maximumHeight} ownerKey={`task\u001f${draftIdentityKey ?? "none"}`}
            placeholder={mobileMessage(locale, composerOwnerReady ? "composer.placeholder" : "composer.restoring")}
            selection={composerOwnerReady ? composerSelection : { start: 0, end: 0 }} theme={composerTheme}
            onEdit={(result, sourceDraft) => {
              const identity = draftIdentityRef.current;
              if (!identity || queueEditRef.current || !composerPasteEditableRef.current
                || composerDraftRef.current !== sourceDraft) {
                setLocalError(mobileMessage(locale, "composer.returnActive"));
                return;
              }
              composerDraftRef.current = result.draft;
              composerSelectionRef.current = result.selection;
              setDraft(result.draft);
              setComposerSelection(result.selection);
              mobileComposerDrafts.save(identity, result.draft);
            }}
            onError={setLocalError}
            onBlur={() => {
              composerFocusedRef.current = false;
              composerComposingRef.current = false;
              setComposerFocused(false);
              setComposerComposing(false);
              setRuntimeCommandDraftLease(undefined);
            }}
            onCommandPaletteKey={handleRuntimeCommandPaletteKey}
            onCompositionChange={(composing) => {
              composerComposingRef.current = composing;
              setComposerComposing(composing);
              if (composing) setRuntimeCommandDraftLease(undefined);
            }}
            onFocus={() => {
              composerFocusedRef.current = true;
              setComposerFocused(true);
            }}
            onHeightChange={(nextHeight) => setComposerContentHeight(Math.max(composerMinimumInputHeight, nextHeight))}
            onOpenAtom={setComposerAtomId}
            onPasteImages={(request) => { void pasteClipboardImages(request); }}
            onPasteImagesCancel={cancelClipboardImagePaste}
            onPasteImagesStart={startClipboardImagePaste}
            onPasteText={(request) => { void pasteClipboardText(request); }}
            onSelectionChange={(nextSelection, sourceDraft) => {
              if (composerDraftRef.current !== sourceDraft) return;
              composerSelectionRef.current = nextSelection;
              setComposerSelection(nextSelection);
            }} />}
        <Action label={mobileMessage(locale, state.busy || appCommandRunning
          ? queueEdit ? "common.saving" : "common.sending"
          : queueEdit ? "composer.saveEdit" : "composer.send")} colors={colors} compact
          disabled={!composerOwnerReady || (!draft.text.trim() && (queueEdit !== undefined || draft.attachments.length === 0))
            || (!queueEdit && unknown) || attachmentBusy || voice.busy || state.busy || composerOperationPending
            || state.status !== "connected"}
          onPress={() => void submitComposer()} />
      </View>
    </View>}
    </MobileKeyboardAvoidingView>
    <MobilePhotoLibrarySheet visible={photoLibraryLease !== undefined} locale={locale}
      ownerKey={photoLibraryLease?.controls.surfaceOwnerKey}
      maximumSelection={Math.max(0, (photoLibraryLease?.controls.policy.maximumItems ?? 0)
        - draft.attachments.length)}
      colors={colors} library={mobilePhotoLibrary}
      onAdd={addPhotoLibraryAssets} onClose={closePhotoLibrary} />
    {imageEditorLease && <MobileImageLightbox session={imageEditorLease.session} locale={locale}
      onOutputAction={async (action, decoded, rendered, signal) => {
        setComposerNotice("");
        setLocalError("");
        try {
          const message = await performMobileImageOutput(imageEditorLease.session, action, decoded, rendered, signal, locale);
          if (!signal.aborted && taskMountedRef.current && imageEditorLeaseRef.current === imageEditorLease) {
            setComposerNotice(message);
          }
          return message;
        } catch (failure) {
          if (!signal.aborted && taskMountedRef.current) setLocalError(errorText(failure));
          throw failure;
        }
      }}
      onNativeActivityChange={(active) => { attachmentNativeActivityRef.current = active; }}
      onClose={closeImageEditor} onSave={saveImageEditor} />}
    {imageGallery.view && <MobileImageLightbox key={imageGallery.view.session.leaseId}
      session={imageGallery.view.session} locale={locale}
      gallery={{
        session: imageGallery.view.session,
        busy: imageGallery.view.busy,
        ...(imageGallery.view.error ? { error: imageGallery.view.error } : {}),
        onNavigate: imageGallery.navigate,
        onAddOriginal: imageGallery.addOriginal,
        onDecoded: imageGallery.decoded
      }}
      onOutputAction={async (action, decoded, rendered, signal) => {
        setComposerNotice("");
        setLocalError("");
        try {
          const view = imageGallery.view;
          if (!view) throw new Error(mobileMessage(locale, "task.error.galleryClosed"));
          const message = await performMobileImageOutput(view.session, action, decoded, rendered, signal, locale);
          if (!signal.aborted && taskMountedRef.current) setComposerNotice(message);
          return message;
        } catch (failure) {
          if (!signal.aborted && taskMountedRef.current) setLocalError(errorText(failure));
          throw failure;
        }
      }}
      onNativeActivityChange={(active) => { attachmentNativeActivityRef.current = active; }}
      onClose={imageGallery.close} onSave={imageGallery.save} />}
    <FilePreviewModal colors={colors} preview={state.timelinePreview} busy={false}
      sharing={fileShareBusy} shareProgress={fileShareProgress}
      onShare={timelinePreviewSource ? () => shareTimelineArtifact(timelinePreviewSource) : undefined}
      backLabel={mobileMessage(locale, "preview.taskTitle")}
      backAccessibilityLabel={mobileMessage(locale, "common.backTo", { label: mobileMessage(locale, "preview.taskTitle") })}
      loadingLabel={mobileMessage(locale, "preview.verifyingTimeline")} locale={locale}
      onClose={() => {
        setTimelinePreviewSource(undefined);
        client.closeTimelinePreview();
      }} />
    <MobileActionSheet visible={state.status === "connected" && messageActionsVisible} items={messageActionItems} colors={colors} locale={locale}
      onClose={() => setMessageActionsVisible(false)} onAction={runMessageAction} />
    <MobileCommandHelpSheet visible={state.status === "connected" && commandHelpItems !== undefined} items={commandHelpItems ?? []} locale={locale}
      colors={colors} onClose={() => setCommandHelpItems(undefined)} />
    <MobileQuoteSelectionSheet lease={state.status === "connected" ? quoteSelection?.lease : undefined} locale={locale}
      colors={colors} busy={state.busy || voice.busy}
      onClose={() => setQuoteSelection(undefined)} onAdd={addSelectedQuote} />
    <MobileComposerAtomSheet atom={state.status === "connected"
      ? draft.atoms.find((atom) => atom.atomId === composerAtomId) : undefined}
      colors={colors} locale={locale} busy={state.busy || voice.busy || attachmentBusy || !composerOwnerReady || queueEdit !== undefined}
      onClose={() => setComposerAtomId(undefined)} onSavePaste={savePastedTextAtom} onRemove={removeComposerAtom} />
    <MobileInteractionSheet visible={interactionVisible && interactions.length > 0} locale={locale}
      profileId={state.activeProfileId} interactions={interactions} selectedId={activeInteractionId}
      busy={state.busy || interactionMutationPending} colors={colors}
      onSelect={setSelectedInteractionId} onMinimize={() => setInteractionVisible(false)}
      onResolve={async (interaction, submission) => {
        const completed = await client.resolveInteraction(interaction.interactionId, submission);
        if (completed) setInteractionVisible(true);
        return completed;
      }}
      onDismiss={async (interaction) => {
        const completed = await client.dismissInteraction(interaction.interactionId);
        if (completed) setInteractionVisible(true);
        return completed;
      }}
      onError={setLocalError} />
    <MobileRuntimeControlsSheet visible={runtimeControlsVisible && runtimeControls !== undefined} locale={locale}
      controls={runtimeControls} busy={state.busy || runtimeControlPending || attachmentBusy} colors={colors}
      onClose={() => setRuntimeControlsVisible(false)}
      onSetModel={(authorityKey, selection) => client.setTaskModel(authorityKey, selection)}
      onSetPermission={(authorityKey, mode) => client.setTaskPermission(authorityKey, mode)}
      onSetPlanMode={(authorityKey, enabled) => client.setTaskPlanMode(authorityKey, enabled)}
      onError={setLocalError} />
    <MobileContextSheet visible={contextVisible && contextControls !== undefined} locale={locale}
      controls={contextControls} busy={state.busy || contextPending} colors={colors}
      onClose={() => setContextVisible(false)}
      onCompact={(authorityKey) => client.compactTaskContext(authorityKey)}
      onError={setLocalError} />
    <MobileNativeTreeSheet visible={nativeTreeVisible && nativeTreeControls !== undefined} locale={locale}
      controls={nativeTreeControls} busy={state.busy || nativeTreePending} colors={colors}
      onClose={() => setNativeTreeVisible(false)}
      onLoad={(authorityKey) => client.loadTaskNativeTree(authorityKey)}
      onNavigate={(authorityKey, tree, entryId, summarize, customInstructions) => client.navigateTaskNativeTree(
        authorityKey,
        tree,
        entryId,
        summarize,
        customInstructions
      )}
      onError={setLocalError} />
    <MobileSessionMentionSheet visible={sessionMentionsVisible && sessionMentionControls !== undefined} locale={locale}
      controls={sessionMentionControls} busy={state.busy} error={sessionMentionError} colors={colors}
      onClose={() => { setSessionMentionsVisible(false); setSessionMentionError(""); }} onSelect={insertSessionMention} />
    <MobileWorkspaceMentionSheet visible={workspaceMentionsVisible && workspaceMentionControls !== undefined} locale={locale}
      controls={workspaceMentionControls} busy={state.busy} colors={colors}
      onClose={() => setWorkspaceMentionsVisible(false)}
      onLoadDirectory={(surfaceOwnerKey, parentPath, signal) => client.listTaskWorkspaceMentionDirectory(surfaceOwnerKey, parentPath, signal)}
      onLoadFileIndex={(surfaceOwnerKey, signal) => client.listTaskWorkspaceMentionFileIndex(surfaceOwnerKey, signal)}
      onSelect={insertWorkspaceMention} />
    <MobileCatalogMentionSheet visible={catalogMentionsVisible && catalogMentionControls !== undefined} locale={locale}
      controls={catalogMentionControls} busy={state.busy} colors={colors}
      onClose={() => setCatalogMentionsVisible(false)}
      onLoad={(surfaceOwnerKey, signal) => client.listTaskCatalogMentionCatalog(surfaceOwnerKey, signal)}
      onSelect={insertCatalogMention} />
    <MobileDrawer visible={drawerOpen} width={drawerWidthRef.current} backgroundColor={colors.surface}
      borderColor={colors.border} locale={locale}
      onClose={() => setDrawerOpen(false)} onMountedChange={setDrawerMounted} initialFocusRef={drawerCloseRef}
      onClosed={() => {
        const action = pendingDrawerActionRef.current;
        pendingDrawerActionRef.current = undefined;
        if (action) action(); else focusNative(drawerMenuRef);
      }} testID="task.drawer">
      <TaskListDrawer colors={colors} state={state} locale={locale} closeButtonRef={drawerCloseRef} onClose={() => setDrawerOpen(false)}
        onSelect={(sessionId) => {
          if (sessionId === state.selectedId) { setDrawerOpen(false); return; }
          queueDrawerAction(() => {
            setLocalError("");
            void client.select(sessionId).catch((error) => setLocalError(errorText(error)));
          });
        }}
        onNew={() => queueDrawerAction(onNew)} onHome={() => queueDrawerAction(onHome)} />
    </MobileDrawer>
  </View>;
}

function FilesScreen({ colors, state, locale, onBack, onAdded }: ScreenProps & { onBack: () => void; onAdded: () => void }) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<MobileFilesSearchMode>("name");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [localError, setLocalError] = useState("");
  const [imageOutputNotice, setImageOutputNotice] = useState("");
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [fileShareBusy, setFileShareBusy] = useState(false);
  const [fileShareProgress, setFileShareProgress] = useState<MobileFileShareProgress>();
  const [galleryOpening, setGalleryOpening] = useState(false);
  const [previewSource, setPreviewSource] = useState<MobileFilesComposerSource>();
  const handoffRef = useRef<AbortController | undefined>(undefined);
  const fileShareRef = useRef<AbortController | undefined>(undefined);
  const filesMountedRef = useRef(true);
  const authorityKey = client.filesAuthorityKey();
  const connected = state.status === "connected" && authorityKey !== undefined;
  const files = state.files;
  const searching = query.trim().length > 0;
  const imageGallery = useMobileImageGallery(locale, () => {
    client.closeFiles();
    onAdded();
  });
  const filesBusy = handoffBusy || fileShareBusy || galleryOpening || imageGallery.view !== undefined;

  useEffect(() => {
    if (!connected || !authorityKey) return;
    if (!files.open || files.authorityKey !== authorityKey || files.status === "offline" || files.status === "idle") {
      setLocalError("");
      void client.openFiles().catch((error) => setLocalError(errorText(error)));
    }
  }, [authorityKey, connected, files.authorityKey, files.open, files.status]);

  useEffect(() => {
    filesMountedRef.current = true;
    return () => {
      filesMountedRef.current = false;
      handoffRef.current?.abort();
      handoffRef.current = undefined;
      fileShareRef.current?.abort();
      fileShareRef.current = undefined;
      client.closeFiles();
    };
  }, []);

  useEffect(() => {
    if (!files.open || filesBusy) return;
    const timer = setTimeout(() => {
      void client.searchFiles(query, mode, caseSensitive).catch((error) => setLocalError(errorText(error)));
    }, 250);
    return () => clearTimeout(timer);
  }, [caseSensitive, files.artifactsRevision, files.authorityKey, files.fileIndexRevision, files.open, filesBusy, mode, query]);

  const run = (action: () => Promise<void>): void => {
    if (handoffRef.current || filesBusy) return;
    setLocalError("");
    void action().catch((error) => setLocalError(errorText(error)));
  };
  const leave = (): void => {
    handoffRef.current?.abort();
    handoffRef.current = undefined;
    fileShareRef.current?.abort();
    fileShareRef.current = undefined;
    imageGallery.close();
    client.closeFiles();
    onBack();
  };
  const openPreview = (source: MobileFilesComposerSource, action: () => Promise<void>): void => {
    if (handoffRef.current || filesBusy) return;
    setPreviewSource(source);
    run(action);
  };
  const openResult = (result: MobileFileSearchResult): void => openPreview(
    { kind: "search-result", result },
    () => client.previewFileSearchResult(result)
  );
  const openGallery = (source: MobileFilesComposerSource): void => {
    if (handoffRef.current || galleryOpening || imageGallery.view) return;
    setGalleryOpening(true);
    setLocalError("");
    client.closeFilesPreview();
    setPreviewSource(undefined);
    void imageGallery.open((signal) => client.openFilesImageGallery(source, signal))
      .catch((error) => setLocalError(errorText(error)))
      .finally(() => setGalleryOpening(false));
  };
  const addToComposer = (source: MobileFilesComposerSource): void => {
    if (handoffRef.current || galleryOpening || imageGallery.view) return;
    const controller = new AbortController();
    handoffRef.current = controller;
    setHandoffBusy(true);
    setLocalError("");
    void client.addFilesItemToComposer(source, controller.signal).then(() => {
      if (handoffRef.current !== controller) return;
      handoffRef.current = undefined;
      setHandoffBusy(false);
      setPreviewSource(undefined);
      client.closeFiles();
      onAdded();
    }).catch((error) => {
      if (handoffRef.current !== controller) return;
      handoffRef.current = undefined;
      setHandoffBusy(false);
      setPreviewSource(undefined);
      client.closeFilesPreview();
      setLocalError(errorText(error));
    });
  };
  const shareFile = (source: MobileFilesComposerSource): void => {
    if (handoffRef.current || fileShareRef.current || galleryOpening || imageGallery.view) return;
    const controller = new AbortController();
    fileShareRef.current = controller;
    setFileShareBusy(true);
    setFileShareProgress(undefined);
    setImageOutputNotice("");
    setLocalError("");
    void client.shareFilesItem(source, (progress) => {
      if (filesMountedRef.current && fileShareRef.current === controller) setFileShareProgress(progress);
    }, controller.signal).then(() => {
      if (filesMountedRef.current && fileShareRef.current === controller) {
        setImageOutputNotice(mobileMessage(locale, "files.shareCompleted"));
      }
    }).catch((error) => {
      if (!controller.signal.aborted && filesMountedRef.current && fileShareRef.current === controller) {
        setLocalError(errorText(error));
      }
    }).finally(() => {
      if (fileShareRef.current === controller) fileShareRef.current = undefined;
      if (filesMountedRef.current) {
        setFileShareBusy(false);
        setFileShareProgress(undefined);
      }
    });
  };
  const locationTitle = files.location.kind === "generated"
    ? mobileMessage(locale, "files.generated")
    : files.location.path || files.workspace?.displayName || mobileMessage(locale, "files.workspace");

  return <View style={styles.fill}>
    <View style={[styles.header, { borderBottomColor: colors.border }]}>
      <Back onPress={leave} colors={colors} label={mobileMessage(locale, "files.task")}
        accessibilityLabel={mobileMessage(locale, "common.backTo", { label: mobileMessage(locale, "files.task") })} />
      <View style={styles.fill}>
        <Text style={[styles.title, { color: colors.ink }]} numberOfLines={1}>{mobileMessage(locale, "files.title")}</Text>
        <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>{locationTitle}</Text>
      </View>
      <Action label={mobileMessage(locale, files.status === "loading" ? "common.refreshing" : "common.refresh")} compact colors={colors}
        disabled={!connected || files.status === "loading" || filesBusy} onPress={() => run(() => client.refreshFiles())} />
    </View>

    {files.status === "offline" && <View style={[styles.connectionNotice, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={[styles.statusDot, { backgroundColor: colors.negative }]} />
      <Text style={[styles.caption, styles.fill, { color: colors.muted }]}>{mobileMessage(locale, "files.offline")}</Text>
    </View>}
    {(localError || files.error) && <Banner text={localError || files.error || ""} colors={colors} />}
    {imageOutputNotice && <Notice text={imageOutputNotice} colors={colors} locale={locale}
      onDismiss={() => setImageOutputNotice("")} />}
    {handoffBusy && <View accessibilityLiveRegion="polite" style={[styles.connectionNotice, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <ActivityIndicator color={colors.accent} />
      <Text style={[styles.caption, styles.fill, { color: colors.muted }]}>{mobileMessage(locale, "preview.addingVerified")}</Text>
    </View>}
    {fileShareBusy && <View accessibilityLiveRegion="polite" style={[styles.connectionNotice, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <ActivityIndicator color={colors.accent} />
      <Text style={[styles.caption, styles.fill, { color: colors.muted }]}>{formatMobileFileShareProgress(fileShareProgress, locale)}</Text>
    </View>}
    {galleryOpening && <View accessibilityLiveRegion="polite" style={[styles.connectionNotice, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <ActivityIndicator color={colors.accent} />
      <Text style={[styles.caption, styles.fill, { color: colors.muted }]}>{mobileMessage(locale, "files.verifyingGallery")}</Text>
    </View>}
    {files.watchStatus === "error" && files.watchError
      && <Banner text={mobileMessage(locale, "files.watchUnavailable", { error: files.watchError })} colors={colors} />}

    <MobileFilesToolbar colors={colors} locale={locale} location={files.location.kind}
      generatedCount={files.artifacts.length} navigationDisabled={!connected || filesBusy}
      searchDisabled={filesBusy} searching={files.searchStatus === "searching"}
      query={query} mode={mode} caseSensitive={caseSensitive}
      onOpenWorkspace={() => run(() => client.openFilesDirectory(""))}
      onOpenGenerated={() => {
        setLocalError("");
        try { client.openGeneratedFiles(); } catch (error) { setLocalError(errorText(error)); }
      }}
      onQueryChange={setQuery} onModeChange={setMode}
      onToggleCaseSensitive={() => setCaseSensitive((value) => !value)} />
    {files.searchError && searching && <Banner text={files.searchError} colors={colors} />}
    {files.searchTruncated && searching && <Text accessibilityRole="alert" style={[styles.warning, { color: colors.negative }]}>
      {mobileMessage(locale, "files.resultsTruncated")}
    </Text>}

    {files.status === "loading" && files.entries.length === 0 && files.artifacts.length === 0
      ? <Centered label={mobileMessage(locale, "files.loading")} colors={colors} />
      : <ScrollView style={styles.fill} contentContainerStyle={styles.filesList} keyboardShouldPersistTaps="handled">
        {searching ? <>
          <Text style={[styles.section, { color: colors.muted }]}>{mobileMessage(locale, "files.searchResults")}</Text>
          {files.searchStatus === "ready" && files.searchResults.length === 0
            && <Text style={[styles.description, { color: colors.muted }]}>{mobileMessage(locale, "files.noMatches")}</Text>}
          {files.searchResults.map((result, index) => <FileSearchResultRow key={fileSearchResultKey(result, index)}
            result={result} colors={colors} locale={locale} disabled={!connected || filesBusy} onPress={() => openResult(result)}
            shareDisabled={!shareableFileSearchResult(result)}
            onShare={() => shareFile({ kind: "search-result", result })}
            onAdd={() => addToComposer({ kind: "search-result", result })} />)}
          {files.searchStatus === "ready" && <Text style={[styles.caption, { color: colors.muted }]}>
            {mode === "content"
              ? mobileMessage(locale, files.searchTotalFiles === 1 ? "files.resultAcrossOne" : "files.resultAcrossMany", {
                results: files.searchResults.length,
                files: files.searchTotalFiles
              })
              : mobileMessage(locale, files.searchResults.length === 1 ? "files.resultOne" : "files.resultMany", {
                count: files.searchResults.length
              })}
          </Text>}
        </> : files.location.kind === "generated" ? <>
          <Text style={[styles.section, { color: colors.muted }]}>{mobileMessage(locale, "files.generatedByTask")}</Text>
          {files.artifacts.length === 0
            && <Text style={[styles.description, { color: colors.muted }]}>{mobileMessage(locale, "files.generatedEmpty")}</Text>}
          {files.artifacts.map((artifact) => {
            const galleryImage = mobileImageGalleryMediaType(artifact.blob?.mediaType ?? "") !== undefined;
            const model = artifact.blob
              ? mobileModelPreviewKind(artifact.blob.mediaType, artifact.blob.fileName) !== undefined : false;
            const source = { kind: "artifact" as const, artifact };
            return <View key={artifact.artifactId} style={styles.fileActionRow}>
            <Pressable accessibilityRole="button"
              accessibilityLabel={mobileMessage(locale, galleryImage ? "files.openGalleryFor" : "files.previewGenerated", {
                name: artifactTitle(artifact)
              })}
              disabled={!connected || filesBusy}
              onPress={() => galleryImage
                ? openGallery(source)
                : openPreview(source, () => client.previewArtifact(artifact))}
              style={[styles.fileRow, styles.fileRowMain, { backgroundColor: colors.surface, borderColor: colors.border },
                (!connected || filesBusy) && styles.disabled]}>
              <Text style={styles.fileGlyph}>{galleryImage ? "▧" : model ? "⬡" : "◆"}</Text>
              <View style={styles.fill}><Text style={[styles.label, { color: colors.ink }]} numberOfLines={1}>{artifactTitle(artifact)}</Text>
                <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>
                  {artifact.blob ? `${artifact.blob.mediaType || "application/octet-stream"} · ${formatByteSize(artifact.blob.byteSize)}`
                    : mobileMessage(locale, "files.blobUnavailable")}
                </Text></View>
              <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
            </Pressable>
            <Action label={mobileMessage(locale, "common.add")}
              accessibilityLabel={mobileMessage(locale, "files.addGenerated", { name: artifactTitle(artifact) })}
              compact colors={colors} disabled={!connected || filesBusy}
              onPress={() => addToComposer(source)} />
            <Action label={mobileMessage(locale, "common.share")}
              accessibilityLabel={mobileMessage(locale, "files.shareGenerated", { name: artifactTitle(artifact) })}
              compact colors={colors} disabled={!connected || filesBusy || !shareableBlobSize(artifact.blob?.byteSize)}
              onPress={() => shareFile(source)} />
          </View>})}
        </> : <>
          <View style={styles.sectionHeader}>
            <Text style={[styles.section, { color: colors.muted }]}>{files.location.path || mobileMessage(locale, "files.workspaceRoot")}</Text>
            {files.location.path && <Action label={mobileMessage(locale, "files.up")} compact colors={colors} disabled={!connected || filesBusy}
              onPress={() => run(() => client.openFilesDirectory(workspaceParentPath(files.location.kind === "workspace" ? files.location.path : "")))} />}
          </View>
          {files.entries.length === 0
            && <Text style={[styles.description, { color: colors.muted }]}>{mobileMessage(locale, "files.directoryEmpty")}</Text>}
          {files.entries.map((entry) => {
            const label = entry.displayName || workspaceBasename(entry.relativePath);
            const galleryImage = entry.kind === FileKind.REGULAR
              && mobileImageGalleryMediaType(entry.mediaType) !== undefined;
            const model = entry.kind === FileKind.REGULAR
              && mobileModelPreviewKind(entry.mediaType, entry.relativePath) !== undefined;
            const source = { kind: "workspace-entry" as const, entry };
            return <View key={entry.relativePath} style={styles.fileActionRow}>
              <Pressable accessibilityRole="button"
                accessibilityLabel={mobileMessage(locale, entry.kind === FileKind.DIRECTORY
                  ? "files.openDirectory" : galleryImage ? "files.openGalleryFor" : "files.previewFile", { name: label })}
                disabled={!connected || filesBusy}
                onPress={() => entry.kind === FileKind.DIRECTORY
                  ? run(() => client.previewWorkspaceEntry(entry))
                  : galleryImage
                    ? openGallery(source)
                    : openPreview(source, () => client.previewWorkspaceEntry(entry))}
                style={[styles.fileRow, styles.fileRowMain, { backgroundColor: colors.surface, borderColor: colors.border },
                  (!connected || filesBusy) && styles.disabled]}>
                <Text style={styles.fileGlyph}>{entry.kind === FileKind.DIRECTORY ? "▰" : galleryImage ? "▧" : model ? "⬡" : "◇"}</Text>
                <View style={styles.fill}>
                  <Text style={[styles.label, { color: colors.ink }]} numberOfLines={1}>{label}</Text>
                  <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>
                    {entry.kind === FileKind.DIRECTORY ? mobileMessage(locale, "files.directory")
                      : `${entry.mediaType || "application/octet-stream"} · ${formatByteSize(entry.revision?.byteSize ?? 0n)}`}
                    {entry.hidden ? ` · ${mobileMessage(locale, "files.hidden")}` : ""}
                    {entry.ignored ? ` · ${mobileMessage(locale, "files.ignored")}` : ""}
                  </Text>
                </View>
                <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
              </Pressable>
              <Action label={mobileMessage(locale, "common.add")}
                accessibilityLabel={mobileMessage(locale, entry.kind === FileKind.DIRECTORY
                  ? "files.addDirectory" : "files.addFile", { name: label })}
                compact colors={colors} disabled={!connected || filesBusy}
                onPress={() => addToComposer(source)} />
              <Action label={mobileMessage(locale, "common.share")}
                accessibilityLabel={mobileMessage(locale, "files.shareFile", { name: label })}
                compact colors={colors} disabled={!connected || filesBusy || entry.kind !== FileKind.REGULAR
                  || !shareableBlobSize(entry.revision?.byteSize)}
                onPress={() => shareFile(source)} />
            </View>;
          })}
        </>}
      </ScrollView>}
    <FilePreviewModal colors={colors} preview={files.preview} source={previewSource} busy={handoffBusy} locale={locale}
      sharing={fileShareBusy} shareProgress={fileShareProgress}
      onShare={previewSource && shareableMobileFilesSource(previewSource)
        ? () => shareFile(previewSource) : undefined}
      onAdd={addToComposer} onOpenImage={openGallery} onClose={() => {
        setPreviewSource(undefined);
        client.closeFilesPreview();
      }} />
    {imageGallery.view && <MobileImageLightbox key={imageGallery.view.session.leaseId}
      session={imageGallery.view.session}
      locale={locale}
      gallery={{
        session: imageGallery.view.session,
        busy: imageGallery.view.busy,
        ...(imageGallery.view.error ? { error: imageGallery.view.error } : {}),
        onNavigate: imageGallery.navigate,
        onAddOriginal: imageGallery.addOriginal,
        onDecoded: imageGallery.decoded
      }}
      onOutputAction={async (action, decoded, rendered, signal) => {
        setImageOutputNotice("");
        setLocalError("");
        try {
          const view = imageGallery.view;
          if (!view) throw new Error(mobileMessage(locale, "task.error.galleryClosed"));
          const message = await performMobileImageOutput(view.session, action, decoded, rendered, signal, locale);
          if (!signal.aborted) setImageOutputNotice(message);
          return message;
        } catch (failure) {
          if (!signal.aborted) setLocalError(errorText(failure));
          throw failure;
        }
      }}
      onClose={imageGallery.close} onSave={imageGallery.save} />}
  </View>;
}

function FileSearchResultRow({ result, colors, locale, disabled, shareDisabled, onPress, onAdd, onShare }: {
  result: MobileFileSearchResult; colors: Colors; locale: MobileSupportedLocale; disabled: boolean; shareDisabled: boolean;
  onPress: () => void; onAdd: () => void; onShare: () => void;
}) {
  const path = result.kind === "artifact" ? artifactTitle(result.artifact)
    : result.kind === "workspace-content" ? result.match.relativePath : result.relativePath;
  const detail = result.kind === "artifact"
    ? `${mobileMessage(locale, "files.generated")} · ${result.artifact.blob?.mediaType || "application/octet-stream"}`
    : result.kind === "workspace-content"
      ? result.match.linePreview || mobileMessage(locale, "files.contentMatch")
      : mobileMessage(locale, "files.workspaceFile");
  return <View style={styles.fileActionRow}>
    <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "files.previewResult", { name: path })}
      disabled={disabled} onPress={onPress}
      style={[styles.fileRow, styles.fileRowMain, { backgroundColor: colors.surface, borderColor: colors.border }, disabled && styles.disabled]}>
      <Text style={styles.fileGlyph}>{result.kind === "artifact" ? "◆" : "◇"}</Text>
      <View style={styles.fill}><Text style={[styles.label, { color: colors.ink }]} numberOfLines={1}>{path}</Text>
        <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={2}>{detail}</Text></View>
      <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
    </Pressable>
    <Action label={mobileMessage(locale, "common.add")}
      accessibilityLabel={mobileMessage(locale, "files.addResult", { name: path })} compact colors={colors}
      disabled={disabled} onPress={onAdd} />
    <Action label={mobileMessage(locale, "common.share")}
      accessibilityLabel={mobileMessage(locale, "files.shareResult", { name: path })} compact colors={colors}
      disabled={disabled || shareDisabled} onPress={onShare} />
  </View>;
}

function FilePreviewModal({ colors, preview, source, busy, sharing = false, shareProgress, backLabel,
  backAccessibilityLabel, loadingLabel, locale,
  onAdd, onOpenImage, onShare, onClose }: {
  colors: Colors;
  preview: MobileFilePreview | undefined;
  source?: MobileFilesComposerSource;
  busy: boolean;
  sharing?: boolean;
  shareProgress?: MobileFileShareProgress;
  backLabel?: string;
  backAccessibilityLabel?: string;
  loadingLabel?: string;
  locale: MobileSupportedLocale;
  onAdd?: (source: MobileFilesComposerSource) => void;
  onOpenImage?: (source: MobileFilesComposerSource) => void;
  onShare?: () => void;
  onClose: () => void;
}) {
  const [mediaStatus, setMediaStatus] = useState<MobileMediaPlayerStatus>();
  const [pdfStatus, setPdfStatus] = useState<MobilePdfViewerStatus>();
  const [modelStatus, setModelStatus] = useState<MobileModelViewerStatus>();
  const exactBackLabel = backLabel ?? mobileMessage(locale, "preview.filesTitle");
  const exactLoadingLabel = loadingLabel ?? mobileMessage(locale, "preview.loadingExact");
  const mediaLeaseId = preview?.kind === "media" ? preview.leaseId : undefined;
  const pdfLeaseId = preview?.kind === "pdf" ? preview.leaseId : undefined;
  const modelLeaseId = preview?.kind === "model" ? preview.leaseId : undefined;
  useEffect(() => setMediaStatus(undefined), [mediaLeaseId]);
  useEffect(() => setPdfStatus(undefined), [pdfLeaseId]);
  useEffect(() => setModelStatus(undefined), [modelLeaseId]);
  const blocked = busy || sharing;
  return <Modal visible={preview !== undefined} animationType="slide" onRequestClose={blocked ? () => undefined : onClose}>
    <SafeAreaView style={[styles.fill, { backgroundColor: colors.background }]} edges={["top", "bottom", "left", "right"]}>
      {preview && <>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Back onPress={onClose} colors={colors} label={exactBackLabel}
            accessibilityLabel={backAccessibilityLabel ?? mobileMessage(locale, "common.backTo", { label: exactBackLabel })}
            disabled={blocked} />
          <View style={styles.fill}><Text style={[styles.title, { color: colors.ink }]} numberOfLines={1}>{preview.title}</Text>
            <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>{preview.sourceLabel}</Text></View>
          {source && onOpenImage && preview.kind === "image" && <Action label={mobileMessage(locale, "preview.gallery")}
            accessibilityLabel={mobileMessage(locale, "preview.openGalleryFor", { title: preview.title })} compact colors={colors}
            disabled={blocked} onPress={() => onOpenImage(source)} />}
          {source && onAdd && <Action label={busy ? mobileMessage(locale, "preview.adding") : mobileMessage(locale, "common.add")}
            accessibilityLabel={mobileMessage(locale, "preview.addToComposer", { title: preview.title })} compact colors={colors}
            disabled={blocked || preview.kind === "loading"} onPress={() => onAdd(source)} />}
          {onShare && <Action label={sharing ? mobileMessage(locale, "preview.sharing") : mobileMessage(locale, "common.share")}
            accessibilityLabel={mobileMessage(locale, "preview.shareTitle", { title: preview.title })} compact colors={colors}
            disabled={blocked || preview.kind === "loading"} onPress={onShare} />}
        </View>
        {busy && <View accessibilityLiveRegion="polite" style={[styles.connectionNotice, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <ActivityIndicator color={colors.accent} />
          <Text style={[styles.caption, styles.fill, { color: colors.muted }]}>{mobileMessage(locale, "preview.addingVerified")}</Text>
        </View>}
        {sharing && <View accessibilityLiveRegion="polite" style={[styles.connectionNotice, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <ActivityIndicator color={colors.accent} />
          <Text style={[styles.caption, styles.fill, { color: colors.muted }]}>{formatMobileFileShareProgress(shareProgress, locale)}</Text>
        </View>}
        <View style={[styles.previewMetadata, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <Text selectable style={[styles.caption, { color: colors.muted }]}>{preview.mediaType} · {formatByteSize(preview.byteSize)}</Text>
          {preview.kind === "text" && <Text style={[styles.caption, { color: colors.muted }]}>
            {mobileMessage(locale, "preview.textMetadata", {
              language: preview.languageId || mobileMessage(locale, "preview.plainText"),
              lines: preview.totalLines,
              start: preview.startByte.toString(10),
              end: preview.endByte.toString(10)
            })}
          </Text>}
          {preview.kind === "media" && <Text accessibilityLiveRegion="polite" style={[styles.caption, { color: mediaStatus?.state === "error" ? colors.negative : colors.muted }]}>
            {formatMobileMediaPlayerStatus(mediaStatus, preview.mediaKind, locale)}
          </Text>}
          {preview.kind === "pdf" && <Text accessibilityLiveRegion="polite" style={[styles.caption, { color: pdfStatus?.state === "error" ? colors.negative : colors.muted }]}>
            {formatMobilePdfViewerStatus(pdfStatus, locale)}
          </Text>}
          {preview.kind === "model" && <Text accessibilityLiveRegion="polite" style={[styles.caption, { color: modelStatus?.state === "error" ? colors.negative : colors.muted }]}>
            {formatMobileModelViewerStatus(modelStatus, locale)}
          </Text>}
        </View>
        {preview.kind === "loading" ? <Centered label={exactLoadingLabel} colors={colors} />
          : preview.kind === "image" ? <ScrollView style={styles.fill} contentContainerStyle={styles.imagePreviewContainer}>
            <Image source={{ uri: preview.dataUri }} accessibilityLabel={preview.altText} resizeMode="contain" style={styles.imagePreview} />
            {(preview.widthPixels > 0 || preview.heightPixels > 0) && <Text style={[styles.caption, { color: colors.muted }]}>
              {mobileMessage(locale, "preview.imageDimensions", {
                width: preview.widthPixels,
                height: preview.heightPixels
              })}
            </Text>}
          </ScrollView>
          : preview.kind === "media" ? <View style={styles.mediaPreviewContainer}>
            <MobileMediaPlayer
              key={preview.leaseId}
              background={colors.background}
              ink={colors.ink}
              instanceId={preview.leaseId}
              kind={preview.mediaKind}
              locale={locale}
              mediaType={preview.mediaType}
              onStatusChange={setMediaStatus}
              style={styles.mediaPreview}
              surface={colors.surface}
              title={preview.title}
              uri={preview.uri}
            />
          </View>
          : preview.kind === "pdf" ? <View style={styles.pdfPreviewContainer}>
            <MobilePdfViewer
              key={preview.leaseId}
              accent={colors.accent}
              background={colors.background}
              border={colors.border}
              byteSize={preview.localByteSize}
              fileName={preview.fileName}
              ink={colors.ink}
              instanceId={preview.leaseId}
              locale={locale}
              muted={colors.muted}
              onStatusChange={setPdfStatus}
              sha256Hex={preview.sha256Hex}
              style={styles.pdfPreview}
              surface={colors.surface}
              title={preview.title}
              uri={preview.uri}
            />
          </View>
          : preview.kind === "model" ? <View style={styles.modelPreviewContainer}>
            <MobileModelViewer
              key={preview.leaseId}
              accent={colors.accent}
              background={colors.background}
              border={colors.border}
              ink={colors.ink}
              lease={preview}
              locale={locale}
              muted={colors.muted}
              onStatusChange={setModelStatus}
              style={styles.modelPreview}
              surface={colors.surface}
              title={preview.title}
            />
          </View>
          : preview.kind === "text" ? <ScrollView style={styles.fill} contentContainerStyle={styles.textPreviewContainer}>
            {preview.truncated && <Text accessibilityRole="alert" style={[styles.warning, { color: colors.negative }]}>{mobileMessage(locale, "preview.truncated")}</Text>}
            <Text selectable style={[styles.textPreview, { color: colors.ink }]}>{preview.text || mobileMessage(locale, "preview.emptyFile")}</Text>
          </ScrollView>
          : <View style={styles.previewMessage}>
            <Text accessibilityRole="alert" style={[styles.label, { color: preview.kind === "error" ? colors.negative : colors.ink }]}>
              {mobileMessage(locale, preview.kind === "error" ? "preview.unavailable" : "preview.noInApp")}
            </Text>
            <Text selectable style={[styles.description, { color: colors.muted }]}>{preview.reason}</Text>
          </View>}
      </>}
    </SafeAreaView>
  </Modal>;
}

function formatMobilePdfViewerStatus(
  status: MobilePdfViewerStatus | undefined,
  locale: MobileSupportedLocale
): string {
  if (!status) return mobileMessage(locale, "preview.status.preparingPdf");
  if (status.state === "error") return status.error || mobileMessage(locale, "preview.pdfError");
  if (status.state === "ready") return mobileMessage(locale, "preview.status.pdfReady");
  if (status.state === "receiving") return mobileMessage(locale, "preview.status.receivingPdf");
  if (status.state === "document" || status.state === "complete") {
    return mobileMessage(locale, status.state === "document"
      ? "preview.status.pdfDocument" : "preview.status.pdfComplete", {
      pages: status.pageCount,
      zoom: status.zoomPercent
    });
  }
  return mobileMessage(locale, "preview.status.renderingPdf", {
    rendered: status.renderedPages,
    pages: status.pageCount
  });
}

function formatMobileModelViewerStatus(
  status: MobileModelViewerStatus | undefined,
  locale: MobileSupportedLocale
): string {
  if (!status) return mobileMessage(locale, "preview.status.preparingModel");
  if (status.state === "error") return status.error || mobileMessage(locale, "preview.modelError");
  if (status.state === "ready") return mobileMessage(locale, "preview.status.modelReady");
  if (status.state === "receiving") return mobileMessage(locale, "preview.status.receivingModel");
  if (status.state === "loading") return mobileMessage(locale, "preview.status.loadingModelFiles", {
    files: status.fileCount,
    kind: mobileMessage(locale, status.fileCount === 1 ? "preview.status.file" : "preview.status.files")
  });
  return mobileMessage(locale, "preview.status.modelComplete", {
    files: status.fileCount,
    kind: mobileMessage(locale, status.fileCount === 1 ? "preview.status.file" : "preview.status.files")
  });
}

function formatMobileMediaPlayerStatus(
  status: MobileMediaPlayerStatus | undefined,
  kind: "audio" | "video",
  locale: MobileSupportedLocale
): string {
  if (!status) return mobileMessage(locale, "preview.status.preparingMedia", {
    kind: mobileMessage(locale, kind === "video" ? "preview.video" : "preview.audio")
  });
  if (status.state === "error") return status.error || mobileMessage(locale, "preview.mediaError");
  const current = status.currentTime === null ? undefined : formatMediaTime(status.currentTime);
  const duration = status.duration === null ? undefined : formatMediaTime(status.duration);
  const progress = current && duration ? `· ${current} / ${duration}` : current ? `· ${current}` : "";
  if (status.state === "ready") return mobileMessage(locale, "preview.status.ready", { time: progress }).trim();
  if (status.state === "playing") return mobileMessage(locale, "preview.status.playing", { time: progress }).trim();
  if (status.state === "paused") return mobileMessage(locale, "preview.status.paused", { time: progress }).trim();
  if (status.state === "waiting") return mobileMessage(locale, "preview.status.waiting", { time: progress }).trim();
  if (status.state === "ended") return mobileMessage(locale, "preview.status.ended", { time: progress }).trim();
  return mobileMessage(locale, "preview.status.unavailable");
}

function formatMediaTime(value: number): string {
  const seconds = Math.max(0, Math.floor(value));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function fileSearchResultKey(result: MobileFileSearchResult, index: number): string {
  if (result.kind === "artifact") return `artifact:${result.artifact.artifactId}`;
  if (result.kind === "workspace-name") return `name:${result.relativePath}`;
  return `content:${result.match.relativePath}:${result.match.range?.startByte.toString(10) ?? index}:${index}`;
}

function shareableBlobSize(byteSize: bigint | undefined): boolean {
  return byteSize !== undefined && byteSize >= 0n
    && byteSize <= BigInt(MOBILE_FILE_SHARE_MAXIMUM_BYTES);
}

function shareableFileSearchResult(result: MobileFileSearchResult): boolean {
  if (result.kind === "artifact") return shareableBlobSize(result.artifact.blob?.byteSize);
  if (result.kind === "workspace-content") return shareableBlobSize(result.match.revision?.byteSize);
  return true;
}

function shareableMobileFilesSource(source: MobileFilesComposerSource): boolean {
  if (source.kind === "artifact") return shareableBlobSize(source.artifact.blob?.byteSize);
  if (source.kind === "workspace-entry") {
    return source.entry.kind === FileKind.REGULAR && shareableBlobSize(source.entry.revision?.byteSize);
  }
  return shareableFileSearchResult(source.result);
}

function formatMobileFileShareProgress(
  progress: MobileFileShareProgress | undefined,
  locale: MobileSupportedLocale
): string {
  if (!progress) return mobileMessage(locale, "task.share.preparing");
  if (progress.phase === "dispatching") return mobileMessage(locale, "task.share.opening");
  return mobileMessage(locale, progress.phase === "verifying" ? "task.share.verifying" : "task.share.downloading", {
    completed: formatByteSize(BigInt(progress.bytesCompleted)),
    total: formatByteSize(BigInt(progress.totalBytes))
  });
}

function TaskListDrawer({ colors, state, locale, closeButtonRef, onClose, onSelect, onNew, onHome }: ScreenProps & {
  closeButtonRef: RefObject<View | null>; onClose: () => void; onSelect: (sessionId: string) => void;
  onNew: () => void; onHome: () => void;
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<MobileHomeStatusFilter>("active");
  const normalizedSearch = search.trim();
  const currentMessageIds = useMemo(() => (
    state.homeSearchQuery === normalizedSearch && state.homeSearchFilter === statusFilter
      ? new Set(state.homeSearchSessionIds) : new Set<string>()
  ), [normalizedSearch, state.homeSearchFilter, state.homeSearchQuery, state.homeSearchSessionIds, statusFilter]);
  const sections = useMemo(() => buildMobileHomeSections({
    snapshot: state.owner,
    statusFilter,
    query: search,
    messageSessionIds: currentMessageIds,
    labels: mobileHomeSectionLabels(locale)
  }).map((section) => ({ ...section, data: section.items })), [currentMessageIds, locale, search, state.owner, statusFilter]);
  useEffect(() => {
    if (!normalizedSearch) {
      void client.searchHome("", statusFilter);
      return;
    }
    const timer = setTimeout(() => { void client.searchHome(normalizedSearch, statusFilter); }, 180);
    return () => clearTimeout(timer);
  }, [normalizedSearch, state.activeProfileId, state.owner?.snapshotId, state.owner?.revision?.value, statusFilter]);
  return <SafeAreaView style={styles.taskDrawer} edges={["top", "bottom", "left"]}>
    <View style={styles.drawerTitleRow}>
      <View style={styles.fill}><Text style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, "common.tasks")}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "home.drawerSubtitle")}</Text></View>
      <Pressable ref={closeButtonRef} accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "home.closeTaskList")}
        onPress={onClose} style={styles.drawerClose}>
        <Text style={[styles.headerIcon, { color: colors.ink }]}>×</Text>
      </Pressable>
    </View>
    <Action label={mobileMessage(locale, "common.newTask")} onPress={onNew} colors={colors} disabled={state.status !== "connected"} />
    <View style={styles.searchRow}>
      <TextInput accessibilityLabel={mobileMessage(locale, "home.search")} placeholder={mobileMessage(locale, "home.search")}
        placeholderTextColor={colors.muted}
        value={search} onChangeText={setSearch} style={[styles.input, styles.searchInput,
          { color: colors.ink, backgroundColor: colors.background, borderColor: colors.border }]} />
      {state.homeSearchStatus === "searching" && normalizedSearch && <ActivityIndicator color={colors.accent} />}
    </View>
    <View accessibilityRole="tablist" style={styles.filterRow}>
      {(["active", "archived", "all"] as const).map((filter) => <Pressable key={filter} accessibilityRole="tab"
        accessibilityState={{ selected: filter === statusFilter }} onPress={() => setStatusFilter(filter)}
        style={[styles.filterChip, { borderColor: filter === statusFilter ? colors.accent : colors.border,
          backgroundColor: filter === statusFilter ? colors.brandBackground : colors.background }]}>
        <Text style={[styles.caption, { color: colors.ink }]}>{mobileMessage(locale, `home.filter.${filter}`)}</Text>
      </Pressable>)}
    </View>
    {state.homeSearchError && normalizedSearch && <Banner text={state.homeSearchError} colors={colors} />}
    <SectionList sections={sections} keyExtractor={(item) => item.session.sessionId} style={styles.fill}
      renderSectionHeader={({ section }) => <Text style={[styles.listSectionTitle, { color: colors.muted }]}>{section.title}</Text>}
      ListEmptyComponent={<Text style={[styles.description, styles.drawerEmpty, { color: colors.muted }]}>{mobileMessage(locale, "home.noMatching")}</Text>}
      renderItem={({ item }) => <Pressable accessibilityRole="button"
        accessibilityState={{ selected: item.session.sessionId === state.selectedId }}
        accessibilityLabel={mobileMessage(locale, "home.openTask", {
          name: item.session.displayName || mobileMessage(locale, "home.untitled")
        })} onPress={() => onSelect(item.session.sessionId)}
        style={[styles.drawerTaskRow, { borderColor: item.session.sessionId === state.selectedId ? colors.accent : colors.border,
          backgroundColor: colors.background }]}>
        <Text style={[styles.label, { color: colors.ink }]} numberOfLines={1}>{item.session.displayName
          || mobileMessage(locale, "home.untitledTask")}</Text>
        <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>{item.targetName} · {sessionState(item.session.state, locale)}</Text>
      </Pressable>}
      contentContainerStyle={styles.drawerList} />
    <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "home.goHome")} onPress={onHome}
      style={[styles.drawerHome, { borderColor: colors.border }]}>
      <Text style={[styles.label, { color: colors.accent }]}>{mobileMessage(locale, "common.home")}</Text>
    </Pressable>
  </SafeAreaView>;
}

function ModeTab({ label, selected, onPress, colors, disabled }: {
  label: string; selected: boolean; onPress: () => void; colors: Colors; disabled?: boolean;
}) {
  return <Pressable accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected, disabled }}
    disabled={disabled} onPress={onPress}
    style={[styles.modeTab, selected && styles.modeTabSelected, disabled && styles.disabled,
      { backgroundColor: selected ? colors.brandBackground : colors.surface }]}>
    <Text style={[styles.modeTabText, { color: colors.ink }]}>{label}</Text>
  </Pressable>;
}

function MobileComposerAtomChips({ atoms, colors, locale, disabled, onOpen }: {
  readonly atoms: readonly MobileComposerAtom[];
  readonly colors: Colors;
  readonly locale: MobileSupportedLocale;
  readonly disabled: boolean;
  readonly onOpen: (atomId: string) => void;
}) {
  if (atoms.length === 0) return null;
  return <ScrollView horizontal keyboardShouldPersistTaps="handled"
    accessibilityLabel={mobileMessage(locale, "composer.atoms.title")} contentContainerStyle={styles.mentionChips}
    showsHorizontalScrollIndicator={false}>
    {atoms.map((atom) => {
      const action = atom.kind === "quote" ? mobileMessage(locale, "composer.atoms.viewQuote")
        : atom.kind === "route-reference" ? mobileMessage(locale, "composer.atoms.viewKind", {
          kind: mobileMessage(locale, atom.routeKind === "project" ? "composer.atoms.projectLink"
            : atom.routeKind === "path" ? "composer.atoms.workspacePath" : "composer.atoms.taskLink")
        }) : mobileMessage(locale, "composer.atoms.editPaste");
      return <Pressable key={atom.atomId} accessibilityRole="button"
      accessibilityLabel={`${action}: ${mobileComposerRichAtomLabel(atom, locale)}`}
      accessibilityHint={mobileMessage(locale, "composer.atoms.openHint")}
      accessibilityState={{ disabled }} disabled={disabled} onPress={() => onOpen(atom.atomId)}
      style={[styles.mentionChip, { borderColor: colors.border, backgroundColor: colors.brandBackground },
        disabled && styles.disabled]}>
      <Text style={[styles.mentionChipText, { color: colors.ink }]} numberOfLines={1}>
        {mobileComposerRichAtomLabel(atom, locale)} · {mobileMessage(locale, atom.kind === "pasted-text" ? "common.edit" : "common.open")}
      </Text>
    </Pressable>;
    })}
  </ScrollView>;
}

function MobileAttachmentTray({ attachments, colors, locale, disabled, busy, pendingCount = 0, onPreview, onRemove }: {
  attachments: readonly MobileComposerAttachment[];
  colors: Colors;
  locale: MobileSupportedLocale;
  disabled: boolean;
  busy: boolean;
  pendingCount?: number;
  onPreview: (attachmentId: string) => void;
  onRemove: (attachmentId: string) => void;
}) {
  if (attachments.length === 0 && pendingCount === 0) return null;
  return <View accessibilityLabel={mobileMessage(locale, "attachments.title")} style={styles.attachmentTray}>
    {pendingCount > 0 && <View accessible accessibilityLiveRegion="polite"
      accessibilityLabel={mobileMessage(locale, "attachments.addingPasted", {
        count: pendingCount,
        kind: mobileMessage(locale, pendingCount === 1 ? "attachments.image" : "attachments.images")
      })}
      style={[styles.attachmentChip, { borderColor: colors.border, backgroundColor: colors.brandBackground }]}>
      <ActivityIndicator color={colors.accent} size="small" />
      <View style={styles.fill}>
        <Text style={[styles.attachmentName, { color: colors.ink }]} numberOfLines={1}>
          {mobileMessage(locale, "attachments.addingPasted", {
            count: pendingCount,
            kind: mobileMessage(locale, pendingCount === 1 ? "attachments.image" : "attachments.images")
          })}…
        </Text>
        <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>
          {mobileMessage(locale, "attachments.verifyingBatch")}
        </Text>
      </View>
    </View>}
    {attachments.map((attachment) => <View key={attachment.attachmentId}
      style={[styles.attachmentChip, { borderColor: colors.border, backgroundColor: colors.brandBackground }]}>
      <View style={styles.fill}>
        <Text style={[styles.attachmentName, { color: colors.ink }]} numberOfLines={1}>{attachment.fileName}</Text>
        <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>
          {mobileMessage(locale, attachment.kind === "image" ? "attachments.kindImage" : "attachments.kindFile")} · {formatMobileAttachmentBytes(attachment.byteSize)}
          {` · ${mobileMessage(locale, attachment.state === "uploaded" ? "attachments.uploaded" : "attachments.ready")}`}
        </Text>
      </View>
      {busy && attachment.state === "local" && <ActivityIndicator color={colors.accent} size="small" />}
      {attachment.kind === "image" && <Pressable accessibilityRole="button"
        accessibilityLabel={mobileMessage(locale, "attachments.previewImage", { name: attachment.fileName })}
        accessibilityHint={mobileMessage(locale, "attachments.previewHint")} disabled={disabled}
        onPress={() => onPreview(attachment.attachmentId)}
        style={[styles.attachmentPreview, disabled && styles.disabled]}>
        <Text style={[styles.attachmentPreviewText, { color: colors.accent }]}>{mobileMessage(locale, "common.open")}</Text>
      </Pressable>}
      <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "attachments.remove", { name: attachment.fileName })}
        accessibilityHint={mobileMessage(locale, "attachments.removeHint")} disabled={disabled}
        onPress={() => onRemove(attachment.attachmentId)} style={[styles.attachmentRemove, disabled && styles.disabled]}>
        <Text style={[styles.attachmentRemoveText, { color: colors.muted }]}>×</Text>
      </Pressable>
    </View>)}
  </View>;
}

function useMobileVoicePermissionSettings(error: MobileVoiceRunError | undefined, locale: MobileSupportedLocale): void {
  useEffect(() => {
    if (error?.code !== "permissionBlocked") return;
    Alert.alert(
      mobileMessage(locale, "voice.permissionTitle"),
      mobileMessage(locale, "voice.permissionBody"),
      [
        { text: mobileMessage(locale, "voice.notNow"), style: "cancel" },
        { text: mobileMessage(locale, "voice.openSettings"), onPress: () => {
          void Linking.openSettings().catch(() => {
            Alert.alert(mobileMessage(locale, "voice.settingsUnavailableTitle"), mobileMessage(locale, "voice.settingsUnavailableBody"));
          });
        } }
      ]
    );
  }, [error, locale]);
}

function MobileVoiceAction({ voice, colors, locale, disabled }: {
  voice: MobileVoiceInputBinding;
  colors: Colors;
  locale: MobileSupportedLocale;
  disabled?: boolean;
}) {
  const longPressRef = useRef(false);
  const recording = voice.state === "starting" || voice.state === "listening";
  const submitting = voice.state === "submitting";
  const controlDisabled = voice.checking || submitting || !voice.busy && disabled === true;
  const label = submitting ? mobileMessage(locale, "voice.transcribing") : recording ? voice.elapsedLabel ?? "0:00"
    : voice.checking ? mobileMessage(locale, "voice.checking") : mobileMessage(locale, "voice.label");
  return <View style={styles.voiceControls}>
    <Pressable accessibilityRole="button" accessibilityLabel={recording
      ? mobileMessage(locale, "voice.stopLabel", { duration: label }) : label}
      accessibilityHint={mobileMessage(locale, "voice.hint")}
      accessibilityState={{ disabled: controlDisabled, busy: voice.busy }} disabled={controlDisabled}
      onPressIn={() => {
        longPressRef.current = false;
        if (!voice.busy) voice.prewarm();
      }}
      onLongPress={() => {
        if (voice.busy) return;
        longPressRef.current = true;
        void voice.start();
      }}
      onPressOut={() => {
        if (longPressRef.current) void voice.stop();
      }}
      onPress={() => {
        if (longPressRef.current) {
          longPressRef.current = false;
          return;
        }
        void voice.toggle();
      }}
      style={[styles.voiceButton, {
        borderColor: recording ? colors.negative : colors.border,
        backgroundColor: recording ? colors.brandBackground : controlDisabled ? colors.border : colors.accent
      }, controlDisabled && styles.disabled]}>
      {voice.checking ? <ActivityIndicator color={colors.muted} size="small" /> : <>
        {recording && <View style={[styles.voiceDot, { backgroundColor: colors.negative }]} />}
        <Text style={[styles.voiceLabel, { color: recording ? colors.ink : controlDisabled ? colors.muted : "#2b2316" }]}>{label}</Text>
      </>}
    </Pressable>
    {voice.busy && <Action label={mobileMessage(locale, "voice.cancel")} colors={colors} compact danger onPress={() => void voice.cancel()} />}
  </View>;
}

function Action({ label, accessibilityLabel = label, onPress, colors, disabled, compact, danger }: {
  label: string; accessibilityLabel?: string; onPress: () => void; colors: Colors;
  disabled?: boolean; compact?: boolean; danger?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={[styles.button, compact && styles.compact, { backgroundColor: disabled ? colors.border : danger ? colors.negative : colors.accent }]}>
    <Text style={[styles.buttonText, { color: disabled ? colors.muted : danger ? "#fff" : "#2b2316" }]}>{label}</Text>
  </Pressable>;
}

function Back({ onPress, colors, label = "Tasks", accessibilityLabel, disabled }: {
  onPress: () => void; colors: Colors; label?: string; accessibilityLabel?: string; disabled?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? `Back to ${label.toLocaleLowerCase()}`}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.back, disabled && styles.disabled]}>
    <Text style={[styles.backText, { color: colors.accent }]}>‹  {label}</Text>
  </Pressable>;
}

function InformationRow({ label, value, colors, selectable }: {
  label: string; value: string; colors: Colors; selectable?: boolean;
}) {
  return <View style={styles.infoRow}>
    <Text style={[styles.infoLabel, { color: colors.muted }]}>{label}</Text>
    <Text selectable={selectable} style={[styles.infoValue, { color: colors.ink }]}>{value}</Text>
  </View>;
}

function Field({ label, value, onChange, placeholder, colors, autoCapitalize, keyboardType, editable, maxLength }: {
  label: string; value: string; onChange: (text: string) => void; placeholder: string; colors: Colors;
  autoCapitalize?: "none"; keyboardType?: "url" | "number-pad"; editable?: boolean; maxLength?: number;
}) {
  return <View style={styles.field}><Text style={[styles.caption, { color: colors.muted }]}>{label}</Text>
    <TextInput accessibilityLabel={label} value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={colors.muted}
      autoCapitalize={autoCapitalize} keyboardType={keyboardType} editable={editable} maxLength={maxLength}
      style={[styles.input, editable === false && styles.disabled,
        { color: colors.ink, backgroundColor: colors.surface, borderColor: colors.border }]} />
  </View>;
}
function AutomaticEntryChoice({ checked, disabled, onPress, colors, locale }: {
  checked: boolean; disabled: boolean; onPress: () => void; colors: Colors; locale: MobileSupportedLocale;
}) {
  return <Pressable accessibilityRole="checkbox" accessibilityState={{ checked, disabled }}
    accessibilityLabel={mobileMessage(locale, "connection.remember.accessibility")}
    disabled={disabled} onPress={onPress} style={[styles.choice, disabled && styles.disabled]}>
    <View style={[styles.choiceBox, { borderColor: checked ? colors.accent : colors.border, backgroundColor: checked ? colors.accent : colors.surface }]}>
      {checked && <Text style={styles.choiceCheck}>✓</Text>}
    </View>
    <View style={styles.fill}>
      <Text style={[styles.label, { color: colors.ink }]}>{mobileMessage(locale, "connection.remember.title")}</Text>
      <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "connection.remember.description")}</Text>
    </View>
  </Pressable>;
}

function Banner({ text, colors }: { text: string; colors: Colors }) {
  return <Text accessibilityRole="alert" style={[styles.warning, { color: colors.negative }]}>{text}</Text>;
}
function Notice({ text, colors, locale, onDismiss }: {
  text: string; colors: Colors; locale: MobileSupportedLocale; onDismiss: () => void;
}) {
  return <View accessibilityLiveRegion="polite"
    style={[styles.connectionNotice, { backgroundColor: colors.brandBackground, borderColor: colors.accent }]}>
    <Text style={[styles.caption, styles.fill, { color: colors.ink }]}>{text}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "composer.dismissNotice")} onPress={onDismiss}
      style={styles.inlineTouchAction}><Text style={[styles.caption, { color: colors.accent }]}>{mobileMessage(locale, "common.dismiss")}</Text></Pressable>
  </View>;
}
function Centered({ label, colors }: { label: string; colors: Colors }) {
  return <View style={styles.center}><ActivityIndicator color={colors.accent} /><Text style={[styles.description, { color: colors.muted }]}>{label}</Text></View>;
}
function StartupLoading({ colors, dark, locale }: { colors: Colors; dark: boolean; locale: MobileSupportedLocale }) {
  const label = mobileMessage(locale, "shell.loading");
  return <View accessibilityRole="progressbar" accessibilityLabel={label} style={styles.startupLoading}>
    <View style={styles.loadingArtwork} accessible={false}>
      <SvgXml xml={mobileLoadingIllustration(dark ? "dark" : "light")} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" />
    </View>
    <Text style={[styles.description, { color: colors.muted }]}>{label}</Text>
  </View>;
}
function focusNative(ref: RefObject<View | null>): void {
  const node = ref.current ? findNodeHandle(ref.current) : null;
  if (node !== null) setTimeout(() => AccessibilityInfo.setAccessibilityFocus(node), 0);
}
function errorText(error: unknown, locale?: MobileSupportedLocale): string {
  return error instanceof Error ? error.message : locale ? mobileMessage(locale, "common.error") : "The Joko node is unavailable.";
}

function sameMobileAttachmentControls(
  left: MobileAttachmentControls | undefined,
  right: MobileAttachmentControls
): boolean {
  return left !== undefined && left.profileId === right.profileId
    && left.surfaceOwnerKey === right.surfaceOwnerKey
    && sameMobileAttachmentPolicy(left.policy, right.policy);
}

function sameMobileAttachmentPolicy(left: MobileAttachmentPolicy, right: MobileAttachmentPolicy): boolean {
  return left.images === right.images && left.files === right.files
    && left.maximumItems === right.maximumItems && left.maximumBytes === right.maximumBytes
    && sameStrings(left.imageMediaTypes, right.imageMediaTypes)
    && sameStrings(left.fileMediaTypes, right.fileMediaTypes);
}

function sameMobileNewTaskEditableDraft(
  left: MobileNewTaskEditableDraft,
  right: MobileNewTaskEditableDraft
): boolean {
  return left.targetId === right.targetId && left.name === right.name
    && mobileComposerDraftsEqual(left.input, right.input);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameComposerSelection(
  left: MobileComposerSelection | undefined,
  right: MobileComposerSelection | undefined
): boolean {
  return left !== undefined && right !== undefined && left.start === right.start && left.end === right.end;
}

function sameRuntimeCommandActivation(
  left: MobileRuntimeCommandActivation | undefined,
  right: MobileRuntimeCommandActivation | undefined
): boolean {
  return left !== undefined && right !== undefined && left.from === right.from && left.to === right.to
    && left.caret === right.caret && left.query === right.query;
}

function boundedComposerSelection(
  selection: MobileComposerSelection,
  textLength: number
): MobileComposerSelection {
  const start = Math.max(0, Math.min(selection.start, selection.end, textLength));
  const end = Math.max(start, Math.min(Math.max(selection.start, selection.end), textLength));
  return { start, end };
}
function savedStatus(profile: SavedMobileConnection, locale: MobileSupportedLocale): string {
  switch (profile.credentialState) {
    case "checking": return mobileMessage(locale, "connection.status.checking");
    case "available": return mobileMessage(locale, "connection.status.available");
    case "missing": return mobileMessage(locale, "connection.status.missing");
    case "unreadable": return mobileMessage(locale, "connection.status.unreadable");
    case "unavailable": return mobileMessage(locale, "connection.status.unavailable");
    case "identity-conflict": return mobileMessage(locale, "connection.status.identityConflict");
    case "offline": return mobileMessage(locale, "connection.status.offline");
    default: return mobileMessage(locale, "connection.status.unchecked");
  }
}
function connectionStateLabel(value: ConnectionState, locale: MobileSupportedLocale): string {
  switch (value) {
    case ConnectionState.PAIRING: return mobileMessage(locale, "connections.state.pairing");
    case ConnectionState.CONNECTED: return mobileMessage(locale, "connections.state.connected");
    case ConnectionState.DISCONNECTED: return mobileMessage(locale, "connections.state.disconnected");
    case ConnectionState.REVOKED: return mobileMessage(locale, "connections.state.revoked");
    case ConnectionState.LOGGED_OUT: return mobileMessage(locale, "connections.state.loggedOut");
    default: return mobileMessage(locale, "connections.state.unknown");
  }
}
function deviceKindLabel(value: DeviceKind, locale: MobileSupportedLocale): string {
  switch (value) {
    case DeviceKind.WEB: return mobileMessage(locale, "devices.kind.web");
    case DeviceKind.DESKTOP: return mobileMessage(locale, "devices.kind.desktop");
    case DeviceKind.SERVICE: return mobileMessage(locale, "devices.kind.service");
    case DeviceKind.MOBILE: return mobileMessage(locale, "devices.kind.mobile");
    default: return mobileMessage(locale, "devices.kind.unknown");
  }
}
function deviceStatusLabel(revoked: boolean, presence: DevicePresenceState, locale: MobileSupportedLocale): string {
  if (revoked) return mobileMessage(locale, "devices.status.revoked");
  if (presence === DevicePresenceState.ONLINE) return mobileMessage(locale, "devices.status.online");
  if (presence === DevicePresenceState.OFFLINE) return mobileMessage(locale, "devices.status.offline");
  return mobileMessage(locale, "devices.status.unknown");
}
function timestampLabel(value: { readonly seconds: bigint; readonly nanos: number } | undefined, locale: MobileSupportedLocale): string {
  if (value === undefined) return mobileMessage(locale, "common.never");
  const milliseconds = Number(value.seconds) * 1_000 + value.nanos / 1_000_000;
  if (!Number.isFinite(milliseconds)) return mobileMessage(locale, "common.unknown");
  return new Date(milliseconds).toLocaleString(locale);
}
function formatByteSize(value: bigint): string {
  if (value < 0n) return "unknown size";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Number(value);
  if (!Number.isFinite(size)) return `${value.toString(10)} B`;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${unit === 0 ? Math.trunc(size) : size.toFixed(size >= 10 ? 1 : 2)} ${units[unit]}`;
}
function sessionState(value: number, locale: MobileSupportedLocale): string {
  const key = [
    "home.state.unknown",
    "home.state.creating",
    "home.state.idle",
    "home.state.running",
    "home.state.waiting",
    "home.state.detached",
    "home.state.recovering",
    "home.state.archived",
    "home.state.closing",
    "home.state.closed",
    "home.state.error"
  ] as const;
  return mobileMessage(locale, key[value] ?? "home.state.unknown");
}
function queueState(value: QueueItemState, locale: MobileSupportedLocale): string {
  switch (value) {
    case QueueItemState.ACCEPTED: return mobileMessage(locale, "task.queueState.accepted");
    case QueueItemState.DISPATCHING: return mobileMessage(locale, "task.queueState.dispatching");
    case QueueItemState.BACKEND_ACCEPTED: return mobileMessage(locale, "task.queueState.backendAccepted");
    case QueueItemState.DISPATCH_UNKNOWN: return mobileMessage(locale, "task.queueState.dispatchUnknown");
    case QueueItemState.COMPLETED: return mobileMessage(locale, "task.queueState.completed");
    case QueueItemState.CANCELLED: return mobileMessage(locale, "task.queueState.cancelled");
    case QueueItemState.FAILED: return mobileMessage(locale, "task.queueState.failed");
    default: return mobileMessage(locale, "task.queueState.unknown");
  }
}

function queueItemSummary(item: QueueItem, locale: MobileSupportedLocale): string {
  return mobileInputSummary(item.input).trim() || mobileMessage(locale, "task.queueFallback");
}

const styles = StyleSheet.create({
  root: { flex: 1 }, fill: { flex: 1 }, screen: { padding: 20, gap: 14, paddingBottom: 36 },
  title: { fontSize: 26, fontWeight: "700" },
  description: { fontSize: 15, lineHeight: 22 }, caption: { fontSize: 13, lineHeight: 18 },
  label: { fontSize: 16, fontWeight: "600" }, body: { fontSize: 15, lineHeight: 22 },
  section: { fontSize: 13, fontWeight: "700", marginTop: 12, textTransform: "uppercase" },
  field: { gap: 7 }, input: { borderWidth: 1, borderRadius: 12, minHeight: 48, paddingHorizontal: 14, fontSize: 16 },
  choice: { minHeight: 48, flexDirection: "row", alignItems: "flex-start", gap: 12 },
  choiceBox: { width: 24, height: 24, borderWidth: 1, borderRadius: 7, alignItems: "center", justifyContent: "center", marginTop: 1 },
  choiceCheck: { color: "#2b2316", fontSize: 16, fontWeight: "800", lineHeight: 18 }, disabled: { opacity: 0.55 },
  search: { marginHorizontal: 16, marginVertical: 10 },
  searchRow: { minHeight: 50, marginHorizontal: 16, marginTop: 6, flexDirection: "row", alignItems: "center", gap: 10 },
  searchInput: { flex: 1 },
  filterRow: { minHeight: 44, paddingHorizontal: 16, paddingVertical: 4, flexDirection: "row", alignItems: "center", gap: 8 },
  filterChip: { minHeight: 36, minWidth: 72, borderWidth: 1, borderRadius: 18, paddingHorizontal: 14, alignItems: "center", justifyContent: "center" },
  warning: { paddingHorizontal: 16, paddingVertical: 8, fontSize: 14, lineHeight: 20 },
  card: { borderWidth: 1, borderRadius: 14, padding: 16, gap: 6 },
  notice: { borderWidth: 1, borderRadius: 14, padding: 14, flexDirection: "row", alignItems: "center", gap: 12 },
  modeTabs: { borderWidth: 1, borderRadius: 14, padding: 4, flexDirection: "row", gap: 4 },
  modeTab: { flex: 1, minHeight: 42, borderRadius: 10, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  modeTabSelected: { shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } },
  modeTabText: { fontSize: 14, fontWeight: "700" },
  sectionHeader: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  statusTitle: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  badge: { borderRadius: 999, overflow: "hidden", paddingHorizontal: 9, paddingVertical: 4, fontSize: 11, fontWeight: "700" },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 6 },
  button: { minHeight: 48, borderRadius: 12, alignItems: "center", justifyContent: "center", paddingHorizontal: 18, paddingVertical: 10 },
  buttonText: { fontSize: 15, fontWeight: "700" }, compact: { minHeight: 44 },
  header: { padding: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  headerActions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 },
  homeHeader: { minHeight: 72, paddingHorizontal: 16, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 12 },
  homeTitle: { flex: 1, minWidth: 0, alignItems: "center" },
  homeTitleText: { maxWidth: "100%", fontSize: 20, lineHeight: 25, fontWeight: "700" },
  headerIconButton: { width: 44, height: 44, borderWidth: 1, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  headerIcon: { fontSize: 21, lineHeight: 24, fontWeight: "700" },
  connectionNotice: { marginHorizontal: 16, marginBottom: 8, borderWidth: 1, borderRadius: 14, padding: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  statusDot: { width: 9, height: 9, borderRadius: 5 },
  stackHeader: { paddingHorizontal: 16, paddingTop: 8, gap: 6 },
  modalBackdrop: { position: "absolute", inset: 0, backgroundColor: "rgba(0,0,0,0.38)" },
  homeDrawer: { flex: 1, paddingHorizontal: 16, paddingBottom: 12, gap: 4 },
  drawerHeading: { paddingHorizontal: 8, paddingTop: 18, paddingBottom: 20, gap: 5 },
  drawerTitleRow: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 8, paddingTop: 12 },
  drawerClose: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  drawerSpacer: { flex: 1 },
  menuRow: { minHeight: 58, borderBottomWidth: 1, paddingHorizontal: 8, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 10 },
  back: { minHeight: 44, justifyContent: "center" },
  backText: { fontSize: 16, fontWeight: "600" }, list: { padding: 16, gap: 8, flexGrow: 1 },
  row: { borderWidth: 1, borderRadius: 14, minHeight: 68, paddingLeft: 14, flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  sessionRowBody: { flex: 1, minHeight: 66, flexDirection: "row", alignItems: "center", paddingVertical: 12 },
  rowOptions: { width: 52, minHeight: 66, alignItems: "center", justifyContent: "center" },
  rowOptionsText: { fontSize: 16, letterSpacing: -1 },
  listSectionTitle: { paddingHorizontal: 4, paddingTop: 10, paddingBottom: 8, fontSize: 13, fontWeight: "700", textTransform: "uppercase" },
  chevron: { fontSize: 28 }, center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 },
  startupLoading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  loadingArtwork: { width: "82%", maxWidth: 420, height: 360 },
  infoRow: { minHeight: 42, flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 6 },
  infoLabel: { width: 92, fontSize: 13, lineHeight: 20, fontWeight: "600" },
  infoValue: { flex: 1, fontSize: 14, lineHeight: 20 },
  devices: { flexGrow: 0, maxHeight: 50 }, deviceList: { paddingHorizontal: 16, gap: 8 },
  deviceChip: { borderWidth: 1, borderRadius: 18, overflow: "hidden", paddingHorizontal: 12, paddingVertical: 8 },
  message: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 6, marginBottom: 8 },
  messageImages: { gap: 8, paddingTop: 4 },
  messageImageTile: { minHeight: 58, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8,
    flexDirection: "row", alignItems: "center", gap: 10 },
  messageImageGlyph: { fontSize: 24, color: "#ff9800" },
  messageActions: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 18 },
  inlineTouchAction: { minHeight: 44, justifyContent: "center" },
  historyActions: { gap: 8 },
  queue: { paddingHorizontal: 18, paddingVertical: 6 }, pending: { paddingHorizontal: 12, flexWrap: "wrap", flexDirection: "row", alignItems: "center" },
  queueRegion: { maxHeight: 272, paddingHorizontal: 12, paddingBottom: 8, gap: 6 },
  queueScroll: { flexGrow: 0 },
  queueList: { gap: 8 },
  queueCard: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, gap: 4 },
  queueActions: { flexDirection: "row", flexWrap: "wrap", gap: 7, paddingTop: 3 },
  queueEditBanner: { minHeight: 52, borderTopWidth: 1, paddingHorizontal: 12, paddingVertical: 4, flexDirection: "row", alignItems: "center", gap: 10 },
  interactionAwaiting: { minHeight: 68, borderTopWidth: 1, paddingHorizontal: 14, paddingVertical: 9, flexDirection: "row", alignItems: "center", gap: 12 },
  pendingReceipt: { gap: 4, paddingVertical: 4 },
  composer: { borderTopWidth: 1, paddingHorizontal: 12, paddingBottom: 8 },
  composerResizeHandle: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  composerGrabber: { width: 88, height: 4, borderRadius: 2 },
  composerTools: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8, paddingBottom: 6 },
  voiceControls: { flexDirection: "row", alignItems: "center", gap: 8 },
  voiceButton: { minWidth: 72, minHeight: 44, borderWidth: 1, borderRadius: 22, paddingHorizontal: 13,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 },
  voiceDot: { width: 8, height: 8, borderRadius: 4 },
  voiceLabel: { fontSize: 14, lineHeight: 18, fontWeight: "700", fontVariant: ["tabular-nums"] },
  mentionChips: { alignItems: "center", gap: 6, paddingRight: 8 },
  mentionChip: { minHeight: 44, maxWidth: 220, borderWidth: 1, borderRadius: 18, paddingHorizontal: 12, justifyContent: "center" },
  mentionChipText: { fontSize: 13, lineHeight: 18, fontWeight: "700" },
  attachmentTray: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingBottom: 8 },
  attachmentChip: { minHeight: 54, minWidth: 190, maxWidth: "100%", flexGrow: 1, flexBasis: 220,
    borderWidth: 1, borderRadius: 12, paddingLeft: 12, paddingRight: 6, paddingVertical: 7,
    flexDirection: "row", alignItems: "center", gap: 8 },
  attachmentName: { fontSize: 13, lineHeight: 18, fontWeight: "700" },
  attachmentPreview: { minWidth: 68, minHeight: 40, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  attachmentPreviewText: { fontSize: 13, lineHeight: 18, fontWeight: "700" },
  attachmentRemove: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  attachmentRemoveText: { fontSize: 24, lineHeight: 26, fontWeight: "500" },
  composerRow: { flexDirection: "row", alignItems: "flex-end", gap: 10 },
  composerInput: { flex: 1, minHeight: 44, fontSize: 16, lineHeight: 22, paddingVertical: 8 },
  sheetRoot: { flex: 1, justifyContent: "flex-end" },
  optionSheet: { borderTopWidth: 1, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 18, gap: 4 },
  dialogRoot: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.38)" },
  renameDialog: { borderWidth: 1, borderRadius: 18, padding: 20, gap: 16 },
  taskDrawer: { flex: 1, paddingHorizontal: 14, paddingBottom: 12, gap: 10 },
  drawerList: { paddingHorizontal: 2, paddingBottom: 12, flexGrow: 1 },
  drawerTaskRow: { minHeight: 62, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, gap: 2, marginBottom: 7 },
  drawerEmpty: { padding: 20, textAlign: "center" },
  drawerHome: { minHeight: 50, borderTopWidth: 1, alignItems: "center", justifyContent: "center" },
  filesList: { paddingHorizontal: 16, paddingBottom: 36, gap: 8, flexGrow: 1 },
  fileActionRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  fileRowMain: { flex: 1, minWidth: 0 },
  fileRow: { borderWidth: 1, borderRadius: 14, minHeight: 68, paddingHorizontal: 14, paddingVertical: 10,
    flexDirection: "row", alignItems: "center", gap: 10 },
  fileGlyph: { width: 22, textAlign: "center", fontSize: 18 },
  previewMetadata: { marginHorizontal: 16, marginBottom: 8, borderWidth: 1, borderRadius: 12, padding: 12, gap: 3 },
  previewMessage: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 28 },
  imagePreviewContainer: { flexGrow: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 16 },
  imagePreview: { width: "100%", minHeight: 320, flex: 1 },
  mediaPreviewContainer: { flex: 1, minHeight: 280, paddingHorizontal: 12, paddingBottom: 12 },
  mediaPreview: { flex: 1, minHeight: 240, overflow: "hidden", borderRadius: 16 },
  pdfPreviewContainer: { flex: 1, minHeight: 320, paddingHorizontal: 12, paddingBottom: 12 },
  pdfPreview: { flex: 1, minHeight: 280, overflow: "hidden", borderRadius: 16 },
  modelPreviewContainer: { flex: 1, minHeight: 320, paddingHorizontal: 12, paddingBottom: 12 },
  modelPreview: { flex: 1, minHeight: 280, overflow: "hidden", borderRadius: 16 },
  textPreviewContainer: { paddingHorizontal: 16, paddingBottom: 36 },
  textPreview: { fontSize: 13, lineHeight: 20, fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }) }
});
