import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import {
  AccessibilityInfo, ActivityIndicator, Alert, AppState, BackHandler, FlatList, Keyboard, Linking, Modal, PanResponder, Platform,
  Image, Pressable, ScrollView, SectionList, StyleSheet, Text, TextInput, findNodeHandle, useColorScheme,
  useWindowDimensions, View
} from "react-native";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { SvgXml } from "react-native-svg";
import { StatusBar } from "expo-status-bar";
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
import { mobileNetwork } from "./network";
import { mobileDiscovery } from "./native-lan-discovery";
import {
  mobileAttachmentCamera,
  mobileAttachmentFiles,
  mobilePhotoLibrary,
  mobileComposerDrafts,
  mobileInteractionDrafts,
  mobileNewTaskDrafts,
  mobileStorage
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
  mobileComposerAtomLabel,
  plainTextMobileComposerDraft,
  removeMobileComposerAtom,
  removeMobileComposerMention,
  updateMobilePastedTextAtom,
  type MobileComposerAtom,
  type MobileComposerDraft,
  type MobileComposerSelection,
  type MobileWorkspaceLineRange
} from "./mobile-composer-document";
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
import type { MobileTimelinePreviewArtifact } from "./mobile-timeline-artifacts";
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
  mobileModelPreviewFiles
);
const runtimeCommandCatalogCache = new MobileRuntimeCommandCatalogCache();
const mobileComposerImagePaste = new MobileComposerImagePaste(mobileAttachmentFiles);
type Page = "home" | "connection" | "new" | "task" | "files" | "connections" | "devices" | "device";

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

function useMobileImageGallery(onCommitted: (draft: MobileComposerDraft) => void) {
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
      const failed = { ...current, busy: false, error: errorText(error) };
      viewRef.current = failed;
      setView(failed);
    }).finally(() => {
      if (pageControllerRef.current === controller) pageControllerRef.current = undefined;
    });
  }, []);

  const decoded = useCallback((value: MobileImageGalleryNativeDecode): void => {
    const current = viewRef.current;
    if (!current) throw new Error("The image gallery was closed before decode completed.");
    client.confirmImageGalleryPageDecoded(
      current.descriptor.leaseId,
      current.session.leaseId,
      current.session.pageId,
      value
    );
  }, []);

  const addOriginal = useCallback(async (signal: AbortSignal): Promise<void> => {
    const current = viewRef.current;
    if (!current) throw new Error("The image gallery was closed before the item could be added.");
    const draft = await client.addImageGalleryPageToComposer(
      current.descriptor.leaseId,
      current.session.leaseId,
      signal
    );
    signal.throwIfAborted();
    viewRef.current = undefined;
    setView(undefined);
    onCommittedRef.current(draft);
  }, []);

  const save = useCallback(async (
    strokes: readonly MobileImageAnnotationStroke[],
    burned: MobileBurnedImage | undefined,
    signal: AbortSignal
  ): Promise<void> => {
    const current = viewRef.current;
    if (!current) throw new Error("The image gallery was closed before the annotation could be added.");
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
  }, []);

  return { view, open, close, navigate, decoded, addOriginal, save };
}

async function performMobileImageOutput(
  session: MobileComposerImageEditorSession,
  action: MobileImageOutputAction,
  decoded: MobileImageGalleryNativeDecode,
  rendered: MobileImageOutputRenderedImage | undefined,
  signal: AbortSignal
): Promise<string> {
  const source = await client.prepareImageOutput(session.leaseId, decoded, signal);
  await mobileImageOutput.perform(action, source, rendered, signal);
  return action === "copy" ? "Image copied to the system clipboard."
    : action === "save" ? "Image saved to the photo library."
      : "System image sharing completed.";
}

export function App() {
  const state = useSyncExternalStore((listener) => client.subscribe(listener), () => client.state);
  const incomingShare = useSyncExternalStore(
    (listener) => mobileIncomingShare.subscribe(listener),
    () => mobileIncomingShare.snapshot
  );
  const [page, setPage] = useState<Page>("home");
  const [menuOpen, setMenuOpen] = useState(false);
  const [homeDrawerMounted, setHomeDrawerMounted] = useState(false);
  const [homeSearchFocusRequest, setHomeSearchFocusRequest] = useState(0);
  const [focusTaskComposer, setFocusTaskComposer] = useState(false);
  const [deviceId, setDeviceId] = useState<string>();
  const homeMenuButtonRef = useRef<View>(null);
  const pendingHomeMenuActionRef = useRef<(() => void) | undefined>(undefined);
  const openedIncomingShareRef = useRef<string | undefined>(undefined);
  const retiredIncomingShareRef = useRef<string | undefined>(undefined);
  const scheme = useColorScheme();
  const dark = scheme === "dark";
  const colors = useMemo(() => ({
    background: dark ? "#15191d" : "#f7f6f3", surface: dark ? "#24292d" : "#ffffff",
    ink: dark ? "#f4f4f2" : "#242a2d", muted: dark ? "#adb6b7" : "#637073",
    border: dark ? "#394246" : "#e1e2df", accent: "#ff9800", negative: "#cc634e",
    brandBackground: dark ? "#302920" : "#fff1db"
  }), [dark]);

  useEffect(() => {
    void mobileImageOutput.maintain().catch(() => undefined);
    void mobileIncomingShare.refresh().catch(() => undefined);
    client.setForeground(AppState.currentState === "active");
    void client.start();
    const subscription = AppState.addEventListener("change", (status) => {
      const foreground = status === "active";
      client.setForeground(foreground);
      if (foreground) void mobileIncomingShare.refresh().catch(() => undefined);
      if (!foreground) {
        void mobileComposerDrafts.flush().catch(() => undefined);
        void mobileInteractionDrafts.flush().catch(() => undefined);
        void mobileNewTaskDrafts.flush().catch(() => undefined);
      }
    });
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
      subscription.remove();
      linking.remove();
      client.setForeground(false);
      void mobileComposerDrafts.flush().catch(() => undefined);
      void mobileInteractionDrafts.flush().catch(() => undefined);
      void mobileNewTaskDrafts.flush().catch(() => undefined);
    };
  }, []);

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

  const common = { colors, state };
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
          {state.status === "starting" ? <SafeAreaView style={styles.fill} edges={["top", "left", "right", "bottom"]}>
            <StartupLoading colors={colors} dark={dark} />
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
          onClose={() => setMenuOpen(false)}
          onMountedChange={setHomeDrawerMounted}
          onClosed={() => {
            const action = pendingHomeMenuActionRef.current;
            pendingHomeMenuActionRef.current = undefined;
            if (action) action(); else focusNative(homeMenuButtonRef);
          }}
          onSearch={() => queueHomeMenuAction(() => setHomeSearchFocusRequest((value) => value + 1))}
          onSwitch={() => queueHomeMenuAction(() => { client.setConnectionMode("saved"); setPage("connection"); })}
          onConnections={() => queueHomeMenuAction(() => setPage("connections"))}
          onDevices={() => queueHomeMenuAction(() => setPage("devices"))} />
      </View>
    </SafeAreaProvider>
  );
}

type Colors = { background: string; surface: string; ink: string; muted: string; border: string; accent: string; negative: string; brandBackground: string };
type ScreenProps = { colors: Colors; state: MobileClient["state"] };

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

function ConnectionScreen({ colors, state, dark, onBack, onConnected }: ScreenProps & {
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
    try { await client.inspect(origin); setInspected(true); } catch (error) { setLocalError(errorText(error)); setInspected(false); }
  };
  const pair = async () => {
    setLocalError("");
    try { await client.pair(origin, code, deviceName, newAutomatic); setCode(""); onConnected(); } catch (error) { setLocalError(errorText(error)); }
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
    void client.inspectNearby(node).then(() => setInspected(true)).catch((error) => setLocalError(errorText(error)));
  };
  const selectMode = (mode: MobileClient["state"]["connectionMode"]) => {
    setInspected(false);
    setCode("");
    setLocalError("");
    client.setConnectionMode(mode);
  };
  const forget = (profile: SavedMobileConnection) => Alert.alert(
    `Forget ${profile.displayName}?`,
    "This removes only this device's protected credential. It does not log out the server connection. Any unconfirmed operation warning for this connection will no longer be recoverable here.",
    [{ text: "Keep", style: "cancel" }, { text: "Forget", style: "destructive", onPress: () => {
      setLocalError("");
      void client.forgetConnection(profile.profileId).catch((error) => setLocalError(errorText(error)));
    } }]
  );
  return <MobileConnectionStage
    artworkId={artwork.id}
    artworkSource={artwork.source}
    iconSource={appIcon}
    colors={{ brandBackground: colors.brandBackground, ink: colors.ink, muted: colors.muted }}
    onArtworkPress={() => setArtworkVariant((current) => current === "base" ? "alt" : "base")}
    onIconPress={() => { setArtworkGroupIndex((current) => nextConnectionArtworkGroupIndex(current)); setArtworkVariant("base"); }}
  >
    {onBack && !state.busy && <Back label="Joko" onPress={onBack} colors={colors} />}
    <Text style={[styles.title, { color: colors.ink }]}>Connect to a Joko node</Text>
    <Text style={[styles.description, { color: colors.muted }]}>Choose a nearby node, use an exact saved connection, or add an address manually. Pairing grants this device revocable access.</Text>
    <View style={[styles.modeTabs, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <ModeTab label="Nearby" selected={state.connectionMode === "nearby"} onPress={() => selectMode("nearby")} colors={colors} />
      <ModeTab label={`Saved${state.saved.length ? ` (${state.saved.length})` : ""}`} selected={state.connectionMode === "saved"} onPress={() => selectMode("saved")} colors={colors} />
      <ModeTab label="Add" selected={state.connectionMode === "add"} onPress={() => selectMode("add")} colors={colors} />
    </View>
    {state.status === "revoked" && <Banner text={state.error || "This device needs to pair again."} colors={colors} />}
    {state.automaticProfileId && <View style={[styles.notice, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.fill}><Text style={[styles.caption, { color: colors.muted }]}>Automatic entry</Text>
        <Text style={[styles.label, { color: colors.ink }]}>{state.saved.find((item) => item.profileId === state.automaticProfileId)?.displayName || "Missing saved connection"}</Text></View>
      <Action label="Turn off" compact disabled={state.busy}
        onPress={() => void client.disableAutomaticEntry().catch((error) => setLocalError(errorText(error)))} colors={colors} />
    </View>}
    {state.connectionMode === "nearby" && <>
      <View style={styles.sectionHeader}><Text style={[styles.section, { color: colors.muted }]}>Nearby Joko nodes</Text>
        <Action label={state.discoveryState === "refreshing" ? "Refreshing…" : "Refresh"} compact
          disabled={state.busy || state.discoveryState === "refreshing"} onPress={() => void client.refreshNearby()} colors={colors} /></View>
      {state.discoveryState === "refreshing" && state.nearby.length === 0 && <ActivityIndicator color={colors.accent} />}
      {state.discoveryError && <Banner text={state.discoveryError} colors={colors} />}
      {state.discoveryState !== "refreshing" && state.nearby.length === 0 && <Text style={[styles.description, { color: colors.muted }]}>No nearby nodes answered. Check Wi-Fi and local-network permission, then refresh or use Add.</Text>}
      {state.nearby.map((nearby) => <Pressable key={`${nearby.serverId}:${nearby.origin}`} accessibilityRole="button"
        accessibilityLabel={`Pair with ${nearby.displayName}`} onPress={() => selectNearby(nearby)}
        style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.fill}><Text style={[styles.label, { color: colors.ink }]}>{nearby.displayName}</Text>
          <Text selectable style={[styles.caption, { color: colors.muted }]}>{nearby.origin}</Text>
          <Text style={[styles.caption, { color: colors.muted }]}>{nearby.pairingEnabled ? "Pairing available" : "Pairing closed"} · v{nearby.version || "unknown"}</Text></View>
        <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
      </Pressable>)}
    </>}
    {state.connectionMode === "saved" && <>
      <View style={styles.sectionHeader}><Text style={[styles.section, { color: colors.muted }]}>Saved connections</Text>
        <Action label="Recheck" compact disabled={state.busy || state.saved.some((profile) => profile.credentialState === "checking")}
          onPress={() => void client.refreshSaved()} colors={colors} /></View>
      {state.saved.length === 0 && <Text style={[styles.description, { color: colors.muted }]}>No saved connections. Use Nearby or Add to pair this device.</Text>}
      {state.saved.map((profile) => {
        const automatic = savedAutomaticChoices[profile.profileId] ?? profile.automatic;
        return <View key={profile.profileId} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.statusTitle}><Text style={[styles.label, { color: colors.ink }]}>{profile.displayName}</Text>
          {profile.automatic && <Text style={[styles.badge, { color: colors.ink, backgroundColor: colors.brandBackground }]}>Automatic</Text>}</View>
        <Text selectable style={[styles.caption, { color: colors.muted }]}>{profile.origin}</Text>
        <Text selectable style={[styles.caption, { color: colors.muted }]}>Identity: {profile.serverId}</Text>
        <Text style={[styles.caption, { color: profile.credentialState === "available" ? colors.muted : colors.negative }]}>{savedStatus(profile)}</Text>
        {profile.error && <Text accessibilityRole="alert" style={[styles.caption, { color: colors.negative }]}>{profile.error}</Text>}
        <SavedPendingOperations profile={profile} colors={colors} />
        <AutomaticEntryChoice checked={automatic} disabled={state.busy || state.status === "connecting"}
          onPress={() => setSavedAutomaticChoices((choices) => ({ ...choices, [profile.profileId]: !automatic }))} colors={colors} />
        <View style={styles.actionRow}>
          <Action label={state.status === "connecting" ? "Connecting…" : "Connect"} onPress={() => {
            setLocalError("");
            void client.connectSaved(profile.profileId, automatic).then(() => {
              if (client.state.activeProfileId === profile.profileId) onConnected();
            }).catch((error) => setLocalError(errorText(error)));
          }} colors={colors} disabled={state.busy || state.status === "connecting" || profile.credentialState === "checking"} />
          <Action label="Forget" onPress={() => forget(profile)} colors={colors} danger disabled={state.busy} />
        </View>
      </View>;
      })}
    </>}
    {state.connectionMode === "add" && <>
      <AutomaticEntryChoice checked={newAutomatic} disabled={state.busy || state.status === "connecting"} onPress={() => setNewAutomatic((value) => !value)} colors={colors} />
      <Field label="Joko node address" value={origin} onChange={(value) => { setOrigin(value); setInspected(false); client.cancel(); }} placeholder="http://192.168.1.20:4318" colors={colors} autoCapitalize="none" keyboardType="url" />
      {origin.trim().startsWith("http://") && <Text style={[styles.warning, { color: colors.negative }]}>Local HTTP is not encrypted. Pair only on a trusted private network; anyone on that network may observe traffic.</Text>}
      <Action label={state.busy ? "Checking…" : "Check node identity"} onPress={inspect} colors={colors} disabled={state.busy || !origin.trim()} />
      {inspected && state.candidate && <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.label, { color: colors.ink }]}>{state.candidate.node.displayName}</Text>
        <Text selectable style={[styles.caption, { color: colors.muted }]}>Identity: {state.candidate.node.serverId}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>v{state.candidate.node.version || "unknown"} · API {state.candidate.node.apiVersion} · {state.candidate.node.pairingEnabled ? "Pairing available" : "Pairing is closed"}</Text>
      </View>}
      {inspected && state.candidate?.node.pairingEnabled && <>
        <Field label="Device name" value={deviceName} onChange={setDeviceName} placeholder="My phone" colors={colors} />
        <Action label={state.busy ? "Requesting…" : "Request pairing"} onPress={() => {
          setLocalError(""); void client.requestPairing(origin, deviceName).catch((error) => setLocalError(errorText(error)));
        }} colors={colors} disabled={state.busy || !deviceName.trim()} />
        {state.challenge && <>
          <Text style={[styles.description, { color: colors.muted }]}>Ask the Joko node owner for the code issued for this exact request. Enter it before it expires.</Text>
          <Field label="Pairing code" value={code} onChange={setCode} placeholder="Code shown on the Joko node" colors={colors} keyboardType="number-pad" />
          <Action label={state.busy ? "Pairing…" : "Pair this device"} onPress={pair} colors={colors} disabled={state.busy || !code.trim()} />
        </>}
      </>}
    </>}
    {(localError || state.connectionAttemptError || (!state.activeProfileId && state.error)) &&
      <Banner text={localError || state.connectionAttemptError || state.error || ""} colors={colors} />}
  </MobileConnectionStage>;
}

function SessionsScreen({ colors, state, onNew, onSelect, onMenu, menuButtonRef, searchFocusRequest }: ScreenProps & {
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
    messageSessionIds: currentMessageIds
  }), [currentMessageIds, search, state.owner, statusFilter]);
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
    setLocalError("");
    void action().catch((error) => setLocalError(errorText(error)));
  };
  const togglePin = (session: Session): void => runMutation(() => client.setSessionPinned(session.sessionId, !session.pinned));
  const toggleArchive = (session: Session): void => runMutation(() => client.setSessionArchived(session.sessionId, !session.archived));
  const openOptions = (session: Session): void => {
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
      `Delete ${session.displayName || "this task"}?`,
      "This removes the Joko task. Its native Backend session and artifacts are kept.",
      [{ text: "Cancel", style: "cancel" }, { text: "Delete task", style: "destructive", onPress: () => runMutation(() => client.deleteSession(session.sessionId)) }]
    );
  };
  const scheduleOption = (action: SessionOption): void => {
    const session = optionsSessionRef.current;
    if (!session) return;
    const generation = ++optionsGenerationRef.current;
    optionsSessionRef.current = undefined;
    setOptionsSession(undefined);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (optionsGenerationRef.current === generation && optionsSessionRef.current === undefined) applyOption(session, action);
    }));
  };

  return <View style={styles.fill}>
    <View style={styles.homeHeader}>
      <Pressable ref={menuButtonRef} accessibilityRole="button" accessibilityLabel="Open menu" onPress={onMenu}
        style={[styles.headerIconButton, { borderColor: colors.border, backgroundColor: colors.surface }]}>
        <Text style={[styles.headerIcon, { color: colors.ink }]}>☰</Text>
      </Pressable>
      <View style={styles.homeTitle}>
        <Text style={[styles.homeTitleText, { color: colors.ink }]} numberOfLines={1}>{state.node?.displayName || "Joko"}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>Tasks</Text>
      </View>
      <Action label="New" onPress={onNew} colors={colors} compact disabled={state.status !== "connected"} />
    </View>
    {(state.status === "connecting" || state.status === "offline") && <View
      accessibilityRole="alert"
      style={[styles.connectionNotice, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <View style={[styles.statusDot, { backgroundColor: state.status === "connecting" ? colors.accent : colors.negative }]} />
      <View style={styles.fill}>
        <Text style={[styles.label, { color: colors.ink }]}>{state.status === "connecting" ? "Reconnecting to this Joko node" : "This Joko node is offline"}</Text>
        {state.error && <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={2}>{state.error}</Text>}
      </View>
      {state.status === "offline" && <Action label="Retry" onPress={() => void client.refresh()} colors={colors} compact />}
    </View>}
    {state.status === "connected" && state.error && <Banner text={state.error} colors={colors} />}
    <View style={styles.searchRow}>
      <TextInput ref={searchRef} accessibilityLabel="Search tasks and messages" placeholder="Search tasks and messages"
        placeholderTextColor={colors.muted} value={search} onChangeText={setSearch}
        style={[styles.input, styles.searchInput, { color: colors.ink, backgroundColor: colors.surface, borderColor: colors.border }]} />
      {state.homeSearchStatus === "searching" && normalizedSearch && <ActivityIndicator color={colors.accent} />}
    </View>
    <View accessibilityRole="tablist" style={styles.filterRow}>
      {(["active", "archived", "all"] as const).map((filter) => <Pressable key={filter} accessibilityRole="tab"
        accessibilityState={{ selected: filter === statusFilter }} onPress={() => setStatusFilter(filter)}
        style={[styles.filterChip, { borderColor: filter === statusFilter ? colors.accent : colors.border,
          backgroundColor: filter === statusFilter ? colors.brandBackground : colors.surface }]}>
        <Text style={[styles.caption, { color: colors.ink }]}>{filter[0]!.toUpperCase() + filter.slice(1)}</Text>
      </Pressable>)}
    </View>
    {state.homeSearchError && normalizedSearch && <Banner text={state.homeSearchError} colors={colors} />}
    {localError && <Banner text={localError} colors={colors} />}
    <PendingReceipts items={state.pending.filter((item) => ["rename", "pin", "archive", "delete"].includes(item.kind))}
      colors={colors} onError={setLocalError} />
    <SectionList sections={listSections} keyExtractor={(item) => item.session.sessionId}
      renderSectionHeader={({ section }) => <Text style={[styles.listSectionTitle, { color: colors.muted }]}>{section.title}</Text>}
      ListEmptyComponent={<Centered label={state.status !== "connected" ? "Reconnect to load tasks" : normalizedSearch ? "No matching tasks or messages" : statusFilter === "archived" ? "No archived tasks" : "No tasks yet"} colors={colors} />}
      renderItem={({ item }) => <SwipeableSessionRow session={item.session} registry={swipeRegistry} colors={colors}
        onTogglePin={togglePin} onArchive={toggleArchive} onShowOptions={openOptions}>
        <View style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Pressable disabled={state.busy} accessibilityRole="button" accessibilityLabel={`Open task ${item.session.displayName || "Untitled"}`}
            onPress={() => {
              if (swipeRegistry.closeOpenRow()) return;
              setLocalError("");
              void client.select(item.session.sessionId).then(onSelect).catch((error) => setLocalError(errorText(error)));
            }} style={styles.sessionRowBody}>
            <View style={styles.fill}><View style={styles.statusTitle}>
              <Text style={[styles.label, { color: colors.ink }]} numberOfLines={1}>{item.session.displayName || "Untitled task"}</Text>
              {item.session.pinned && <Text style={[styles.badge, { color: colors.ink, backgroundColor: colors.brandBackground }]}>Pinned</Text>}
            </View>
              <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>{item.targetName} · {sessionState(item.session.state)}</Text></View>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`Options for ${item.session.displayName || "task"}`}
            onPress={() => { swipeRegistry.closeOpenRow(); openOptions(item.session); }} style={styles.rowOptions}>
            <Text style={[styles.rowOptionsText, { color: colors.muted }]}>•••</Text>
          </Pressable>
        </View>
      </SwipeableSessionRow>}
      refreshing={state.status === "connecting"} onRefresh={() => void client.refresh()}
      onScrollBeginDrag={() => { swipeRegistry.closeOpenRow(); }}
      contentContainerStyle={styles.list} />
    <Modal visible={optionsSession !== undefined} transparent animationType="none" onRequestClose={closeOptions} statusBarTranslucent>
      <View style={styles.sheetRoot}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close task options" onPress={closeOptions} style={styles.modalBackdrop} />
        <SafeAreaView accessibilityViewIsModal style={[styles.optionSheet, { backgroundColor: colors.surface, borderColor: colors.border }]} edges={["bottom", "left", "right"]}>
          <Text style={[styles.label, { color: colors.ink }]} numberOfLines={1}>{optionsSession?.displayName || "Task options"}</Text>
          <MenuRow label="Rename" onPress={() => scheduleOption("rename")} colors={colors} />
          <MenuRow label={optionsSession?.pinned ? "Unpin" : "Pin"} onPress={() => scheduleOption("pin")} colors={colors} />
          <MenuRow label={optionsSession?.archived ? "Restore" : "Archive"} onPress={() => scheduleOption("archive")} colors={colors} />
          <MenuRow label="Delete task" onPress={() => scheduleOption("delete")} colors={colors} />
          <Action label="Cancel" onPress={closeOptions} colors={colors} />
        </SafeAreaView>
      </View>
    </Modal>
    <Modal visible={renameSession !== undefined} transparent animationType="fade" onRequestClose={() => setRenameSession(undefined)} statusBarTranslucent>
      <View style={styles.dialogRoot}>
        <View accessibilityViewIsModal style={[styles.renameDialog, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.title, { color: colors.ink }]}>Rename task</Text>
          <Field label="Task name" value={renameDraft} onChange={setRenameDraft} placeholder="Task name" colors={colors} />
          <View style={styles.actionRow}>
            <Action label="Cancel" onPress={() => setRenameSession(undefined)} colors={colors} />
            <Action label="Rename" disabled={!renameDraft.trim() || state.busy} onPress={() => {
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

function HomeMenu({ visible, colors, state, onClose, onClosed, onMountedChange, onSearch, onSwitch, onConnections, onDevices }: ScreenProps & {
  visible: boolean; onClose: () => void; onClosed: () => void; onMountedChange: (mounted: boolean) => void;
  onSearch: () => void; onSwitch: () => void; onConnections: () => void; onDevices: () => void;
}) {
  const { width } = useWindowDimensions();
  const closeRef = useRef<View>(null);
  return <MobileDrawer visible={visible} width={Math.min(380, width * 0.84)} backgroundColor={colors.surface}
    borderColor={colors.border} onClose={onClose} onClosed={onClosed} onMountedChange={onMountedChange}
    initialFocusRef={closeRef} testID="home.drawer">
      <SafeAreaView style={styles.homeDrawer} edges={["top", "bottom", "left"]}>
        <View style={styles.drawerHeading}>
          <View style={styles.drawerTitleRow}><View style={styles.fill}><Text style={[styles.title, { color: colors.ink }]}>Joko</Text>
            <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={2}>
              {state.node?.displayName || "Joko node"}{state.origin ? `\n${state.origin}` : ""}
            </Text></View>
            <Pressable ref={closeRef} accessibilityRole="button" accessibilityLabel="Close menu" onPress={onClose} style={styles.drawerClose}>
              <Text style={[styles.headerIcon, { color: colors.ink }]}>×</Text>
            </Pressable>
          </View>
        </View>
        <MenuRow label="Search" description="Find tasks and message text" onPress={onSearch} colors={colors} />
        <MenuRow label="Switch or add Joko node" description="Nearby, saved, and manual connections" onPress={onSwitch} colors={colors} />
        <MenuRow label="Devices" description="Devices authorized by this Joko node" onPress={onDevices} colors={colors} />
        <MenuRow label="Connection settings" description="Automatic entry and exact server connections" onPress={onConnections} colors={colors} />
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

function ConnectionsScreen({ colors, state, onBack, onSwitch }: ScreenProps & { onBack: () => void; onSwitch: () => void }) {
  const [localError, setLocalError] = useState("");
  const currentConnectionId = state.saved.find((profile) => profile.profileId === state.activeProfileId)?.connectionId;
  const logout = (connectionId: string, name: string) => Alert.alert(
    `Log out ${name}?`,
    "Joko will first log out this exact server connection. Its local protected credential is removed only after the server confirms success.",
    [{ text: "Cancel", style: "cancel" }, { text: "Log out", style: "destructive", onPress: () => {
      setLocalError("");
      void client.logoutConnection(connectionId).catch((error) => setLocalError(errorText(error)));
    } }]
  );
  const forget = (profile: SavedMobileConnection) => Alert.alert(
    `Forget ${profile.displayName}?`,
    "This is local-only and does not log out the server connection.",
    [{ text: "Cancel", style: "cancel" }, { text: "Forget", style: "destructive", onPress: () => {
      setLocalError("");
      void client.forgetConnection(profile.profileId).catch((error) => setLocalError(errorText(error)));
    } }]
  );
  return <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
    <Back label="Joko" onPress={onBack} colors={colors} />
    <Text style={[styles.title, { color: colors.ink }]}>Connection settings</Text>
    <Text style={[styles.description, { color: colors.muted }]}>Local saved nodes and server-issued connections are separate. Forget changes only this phone; Log out is confirmed by the current Joko node first.</Text>
    <Text style={[styles.section, { color: colors.muted }]}>Current Joko node</Text>
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.label, { color: colors.ink }]}>{state.node?.displayName || "Joko node"}</Text>
      <Text selectable style={[styles.caption, { color: colors.muted }]}>{state.origin || "Address unavailable"}</Text>
      <Text style={[styles.caption, { color: colors.muted }]}>{state.status === "connected" ? "Connected" : state.status === "connecting" ? "Reconnecting" : "Offline"}</Text>
      <Action label="Switch or add Joko node" colors={colors} onPress={onSwitch} />
    </View>
    {state.automaticProfileId && <View style={[styles.notice, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.fill}><Text style={[styles.caption, { color: colors.muted }]}>Automatic entry</Text>
        <Text style={[styles.label, { color: colors.ink }]}>{state.saved.find((profile) => profile.profileId === state.automaticProfileId)?.displayName || "Missing saved connection"}</Text></View>
      <Action label="Turn off" compact colors={colors} disabled={state.busy}
        onPress={() => void client.disableAutomaticEntry().catch((error) => setLocalError(errorText(error)))} />
    </View>}
    {!state.automaticProfileId && state.status === "connected" && <Action label="Use current connection automatically" colors={colors}
      onPress={() => void client.setAutomaticEntryForActive(true).catch((error) => setLocalError(errorText(error)))} />}
    <Text style={[styles.section, { color: colors.muted }]}>Saved on this phone</Text>
    {state.saved.map((profile) => <View key={profile.profileId} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.statusTitle}><Text style={[styles.label, { color: colors.ink }]}>{profile.displayName}</Text>
        {profile.profileId === state.activeProfileId && <Text style={[styles.badge, { color: colors.ink, backgroundColor: colors.brandBackground }]}>Current</Text>}</View>
      <Text selectable style={[styles.caption, { color: colors.muted }]}>{profile.origin}</Text>
      <Text selectable style={[styles.caption, { color: colors.muted }]}>Profile: {profile.profileId}</Text>
      <SavedPendingOperations profile={profile} colors={colors} />
      <Action label="Forget locally" colors={colors} danger disabled={state.busy} onPress={() => forget(profile)} />
    </View>)}
    <Text style={[styles.section, { color: colors.muted }]}>Connections issued by this node</Text>
    {(state.owner?.connections ?? []).map((connection) => {
      const device = state.owner?.devices.find((candidate) => candidate.deviceId === connection.deviceId);
      const name = connection.displayName || device?.displayName || "Joko connection";
      return <View key={connection.connectionId} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.statusTitle}><Text style={[styles.label, { color: colors.ink }]}>{name}</Text>
          {connection.connectionId === currentConnectionId && <Text style={[styles.badge, { color: colors.ink, backgroundColor: colors.brandBackground }]}>Current</Text>}</View>
        <Text style={[styles.caption, { color: colors.muted }]}>{connectionStateLabel(connection.state)} · {device?.platform || "unknown platform"}</Text>
        <Text selectable style={[styles.caption, { color: colors.muted }]}>Connection: {connection.connectionId}</Text>
        {connection.state === ConnectionState.CONNECTED && <Action label="Log out" colors={colors} danger disabled={state.busy || state.status !== "connected"}
          onPress={() => logout(connection.connectionId, name)} />}
      </View>;
    })}
    <PendingReceipts items={state.pending.filter((item) => item.kind === "logout")} colors={colors} onError={setLocalError} />
    {(localError || state.error) && <Banner text={localError || state.error || ""} colors={colors} />}
  </ScrollView>;
}

function DevicesScreen({ colors, state, onBack, onDevice }: ScreenProps & {
  onBack: () => void; onDevice: (deviceId: string) => void;
}) {
  const devices = state.owner?.devices ?? [];
  const currentDeviceId = state.saved.find((profile) => profile.profileId === state.activeProfileId)?.deviceId;
  return <View style={styles.fill}>
    <View style={styles.stackHeader}>
      <Back label="Joko" onPress={onBack} colors={colors} />
      <Text style={[styles.title, { color: colors.ink }]}>Devices</Text>
    </View>
    {state.status !== "connected" && <View style={[styles.connectionNotice, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={[styles.statusDot, { backgroundColor: state.status === "connecting" ? colors.accent : colors.negative }]} />
      <Text style={[styles.caption, styles.fill, { color: colors.muted }]}>Showing the last authoritative device list from this Joko node while it reconnects.</Text>
    </View>}
    <FlatList data={devices} keyExtractor={(device) => device.deviceId} contentContainerStyle={styles.list}
      ListEmptyComponent={<Centered label="No authorized devices are available on this Joko node" colors={colors} />}
      renderItem={({ item: device }) => {
        return <Pressable accessibilityRole="button" accessibilityLabel={`Open device ${device.displayName}`}
          onPress={() => onDevice(device.deviceId)} style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.fill}>
            <View style={styles.statusTitle}>
              <Text style={[styles.label, { color: colors.ink }]}>{device.displayName}</Text>
              {device.deviceId === currentDeviceId && <Text style={[styles.badge, { color: colors.ink, backgroundColor: colors.brandBackground }]}>This phone</Text>}
            </View>
            <Text style={[styles.caption, { color: colors.muted }]}>{deviceStatusLabel(device.revoked, device.presence)} · {device.platform || "unknown platform"}</Text>
          </View>
          <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
        </Pressable>;
      }} />
  </View>;
}

function DeviceScreen({ colors, state, deviceId, onBack }: ScreenProps & { deviceId: string; onBack: () => void }) {
  const [localError, setLocalError] = useState("");
  const device = state.owner?.devices.find((candidate) => candidate.deviceId === deviceId);
  const activeDeviceId = state.saved.find((profile) => profile.profileId === state.activeProfileId)?.deviceId;
  if (!device) return <View style={styles.screen}><Back label="Devices" onPress={onBack} colors={colors} />
    <Text style={[styles.description, { color: colors.muted }]}>This device is no longer present in the current node snapshot.</Text></View>;
  const revoke = () => Alert.alert(
    `Revoke ${device.displayName}?`,
    "Every connection owned by this exact device will lose access. Joko removes matching local profiles only after the server confirms the revoke.",
    [{ text: "Cancel", style: "cancel" }, { text: "Revoke device", style: "destructive", onPress: () => {
      setLocalError("");
      void client.revokeDevice(device.deviceId).catch((error) => setLocalError(errorText(error)));
    } }]
  );
  return <ScrollView contentContainerStyle={styles.screen}>
    <Back label="Devices" onPress={onBack} colors={colors} />
    <Text style={[styles.title, { color: colors.ink }]}>{device.displayName}</Text>
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <InformationRow label="Status" value={deviceStatusLabel(device.revoked, device.presence)} colors={colors} />
      <InformationRow label="Kind" value={deviceKindLabel(device.kind)} colors={colors} />
      <InformationRow label="Platform" value={device.platform || "Unknown"} colors={colors} />
      <InformationRow label="App version" value={device.appVersion || "Unknown"} colors={colors} />
      <InformationRow label="Last seen" value={timestampLabel(device.lastSeenAt)} colors={colors} />
      <InformationRow label="Device ID" value={device.deviceId} colors={colors} selectable />
    </View>
    {device.deviceId === activeDeviceId
      ? <Text style={[styles.description, { color: colors.muted }]}>This is the device authorizing the current connection. Log out its exact connection instead of revoking it from itself.</Text>
      : !device.revoked && <Action label="Revoke device" colors={colors} danger disabled={state.busy || state.status !== "connected"} onPress={revoke} />}
    <PendingReceipts items={state.pending.filter((item) => item.kind === "revoke" && item.targetDeviceId === device.deviceId)} colors={colors} onError={setLocalError} />
    {(localError || state.error) && <Banner text={localError || state.error || ""} colors={colors} />}
  </ScrollView>;
}

function PendingReceipts({ items, colors, onError }: {
  items: MobileClient["state"]["pending"]; colors: Colors; onError: (message: string) => void;
}) {
  return <>{items.map((item) => <View key={item.operationId} style={styles.pendingReceipt}>
    <Text style={[styles.warning, { color: colors.negative }]}>
      {item.state === "unknown" ? "Server result unknown" : "Awaiting durable server result"} · {item.operationId}
    </Text>
    <View style={styles.actionRow}>
      <Action label="Check status" compact colors={colors} onPress={() => void client.reconcile().catch((error) => onError(errorText(error)))} />
      {item.state === "unknown" && <Action label="Verify and clear" compact colors={colors} onPress={() => Alert.alert(
        "Clear this receipt?",
        "Joko will first verify that the current node has no operation with this ID. It will never repeat the destructive action automatically.",
        [{ text: "Keep checking", style: "cancel" }, { text: "Verify and clear", onPress: () => {
          void client.dismissUnconfirmed(item.operationId).catch((error) => onError(errorText(error)));
        } }]
      )} />}
    </View>
  </View>)}</>;
}

function SavedPendingOperations({ profile, colors }: { profile: SavedMobileConnection; colors: Colors }) {
  if (profile.pendingOperations.length === 0) return null;
  return <Text accessibilityRole="alert" selectable style={[styles.warning, { color: colors.negative, paddingHorizontal: 0 }]}>
    Retained operation {profile.pendingOperations.length === 1 ? "receipt" : "receipts"}: {profile.pendingOperations.map((item) => item.operationId).join(", ")}. Connect this exact saved profile to check the server result; forgetting it clears these local receipts.
  </Text>;
}

function NewTaskScreen({ colors, state, onBack, onCreated }: ScreenProps & { onBack: () => void; onCreated: () => void }) {
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
    requestId: randomUUID
  });
  useMobileVoicePermissionSettings(voice.error);
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
      setError("Task reference authority changed. Reopen the reference list and try again.");
      return;
    }
    const ownerKey = controls.surfaceOwnerKey;
    setMentionBusy(true);
    setSessionMentionError("");
    void client.validateNewTaskSessionMentionCandidate(targetId, ownerKey, candidate).then((current) => {
      if (!mountedRef.current || profileIdRef.current !== ownerProfileId || draftRef.current.targetId !== targetId
        || sessionMentionOwnerRef.current !== ownerKey) {
        throw new Error("Task reference authority changed while the candidate was being checked.");
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
      throw new Error("Workspace reference authority changed. Reopen the reference list and try again.");
    }
    if (lineRange !== undefined && !controls.policy.lineRanges) {
      throw new Error("This Backend no longer supports Workspace line references.");
    }
    const current = await client.validateNewTaskWorkspaceMentionCandidate(
      targetId,
      surfaceOwnerKey,
      candidate
    );
    if (!mountedRef.current || profileIdRef.current !== ownerProfileId || draftRef.current.targetId !== targetId
      || workspaceMentionOwnerRef.current !== surfaceOwnerKey) {
      setWorkspaceMentionsVisible(false);
      throw new Error("Workspace reference authority changed while the path was being checked.");
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
      setError("Return to the active new-task composer before pasting text.");
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
        throw new Error("The new-task draft changed while clipboard text was being read. Paste it again.");
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
          throw new Error("The new-task Workspace changed while clipboard paths were being checked. Paste them again.");
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
      setError("The clipboard image batch no longer belongs to this new-task draft. Paste it again.");
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
            throw new Error("Attachment authority changed while the clipboard images were being prepared.");
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
      const sourceName = source === "camera" ? "camera" : source === "photos" ? "photo library" : "picker";
      setError(`Attachment authority changed. Reopen the ${sourceName} from the current project.`);
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
        throw new Error("Attachment authority changed while the selected media was being staged.");
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
      setError("Connect and return to the foreground before choosing where to keep these shared files.");
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
      if (mountedRef.current) setIncomingShareNotice("Shared files were discarded from the Joko inbox.");
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
      setError("Shared-file authority changed. Reopen this inbox from the current project and try again.");
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
      if (!claimId) throw new Error("The incoming share target claim is unavailable.");
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
            throw new Error("Shared-file authority changed while the files were being added.");
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
          ? `${result.replayed ? "Confirmed" : "Added"} ${result.plan.accepted.length} shared ${result.plan.accepted.length === 1 ? "file" : "files"}.`
          : "No shared files were added.",
        result.plan.rejected.length > 0
          ? `${result.plan.rejected.length} ${result.plan.rejected.length === 1 ? "item was" : "items were"} skipped as shown.`
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
      setError("Photo-library authority changed. Reopen Photos from the current project.");
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
      throw new Error("Photo-library authority changed. Reopen Photos from the current project.");
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
        throw new Error("Attachment authority changed while the selected photos were being staged.");
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
        throw new Error("The attachment removal could not be confirmed in the retained new-task draft.");
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
    if (!lease) throw new Error("The image editor is no longer open.");
    const result = await client.commitComposerImageEditor(lease.session.leaseId, strokes, burned, signal);
    if (!mountedRef.current || imageEditorLeaseRef.current !== lease || result.surface !== "new-task"
      || lease.scopeKey !== `${profileIdRef.current ?? ""}\u001f${draftRef.current.targetId}`) {
      throw new Error("The new-task image editor owner changed before its result could be displayed.");
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
    <Back onPress={() => { if (identity) void mobileNewTaskDrafts.flush(identity).catch(() => undefined); onBack(); }} colors={colors} />
    <Text style={[styles.title, { color: colors.ink }]}>New task</Text>
    <Text style={[styles.description, { color: colors.muted }]}>Choose an active project and enter the first message. Joko retains this draft on this device until the first message is durably accepted.</Text>
    {incomingShareNotice && <Banner text={incomingShareNotice} colors={colors} />}
    {incomingShareState.error && !incomingShareBatch && <Banner text={incomingShareState.error} colors={colors} />}
    {incomingShareBatch && <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
      accessibilityRole="summary" accessibilityLabel="Files shared with Joko">
      <Text style={[styles.label, { color: colors.ink }]}>Shared with Joko</Text>
      {incomingShareBatch.status === "invalid" ? <>
        <Text accessibilityRole="alert" style={[styles.warning, { color: colors.negative, paddingHorizontal: 0 }]}>
          {incomingShareBatch.invalidReason} This batch was kept so you can retry cleanup or discard it explicitly.
        </Text>
        <Action label={incomingShareState.busy ? "Discarding…" : "Discard invalid share"} colors={colors} compact
          disabled={incomingShareState.busy} onPress={() => void discardIncomingShare(incomingShareBatch.batchId)} />
      </> : <>
        <Text style={[styles.description, { color: colors.muted }]}>
          {incomingShareBatch.items.length + incomingShareBatch.overflowCount} external {incomingShareBatch.items.length + incomingShareBatch.overflowCount === 1 ? "item is" : "items are"} waiting in the protected device inbox. Nothing is sent automatically.
        </Text>
        {incomingShareBatch.boundProfileId === undefined ? <>
          <Text style={[styles.caption, { color: colors.muted }]}>Choose this active connection explicitly before Joko copies any file into its new-task draft.</Text>
          <View style={styles.actionRow}>
            <Action label={incomingShareState.busy ? "Binding…" : "Use with this connection"} colors={colors} compact
              disabled={incomingShareState.busy || !ownerReady || state.status !== "connected"}
              onPress={() => void bindIncomingShare(incomingShareBatch)} />
            <Action label="Discard" colors={colors} compact disabled={incomingShareState.busy}
              onPress={() => void discardIncomingShare(incomingShareBatch.batchId)} />
          </View>
        </> : incomingShareBatch.boundProfileId !== profileId ? <>
          <Text accessibilityRole="alert" style={[styles.warning, { color: colors.negative, paddingHorizontal: 0 }]}>
            This share belongs to a different connection profile and cannot enter the current draft.
          </Text>
          <Action label={incomingShareState.busy ? "Discarding…" : "Discard bound share"} colors={colors} compact
            disabled={incomingShareState.busy} onPress={() => void discardIncomingShare(incomingShareBatch.batchId)} />
        </> : incomingShareClaimCurrent === false ? <>
          <Text accessibilityRole="alert" style={[styles.warning, { color: colors.negative, paddingHorizontal: 0 }]}>
            This share was already claimed by a different project, model, or attachment policy. Return to that exact project state to retry, or discard it explicitly.
          </Text>
          <Action label="Discard claimed share" colors={colors} compact
            disabled={incomingShareState.busy || attachmentBusy}
            onPress={() => void discardIncomingShare(incomingShareBatch.batchId)} />
        </> : !attachmentControls || !targetAvailable || !incomingSharePlan ? <>
          <Text style={[styles.caption, { color: colors.muted }]}>Choose a current project whose model accepts these image or file attachments, or discard the share.</Text>
          {incomingShareBatch.items.filter((item) => item.state === "rejected").map((rejection) => <Text
            key={rejection.itemId} accessibilityRole="alert" style={[styles.caption, { color: colors.negative }]}>
            {rejection.fileName ? `${rejection.fileName}: ` : ""}{rejection.reason}
          </Text>)}
          {incomingShareBatch.overflowCount > 0 && <Text accessibilityRole="alert"
            style={[styles.caption, { color: colors.negative }]}>{incomingShareBatch.overflowCount} additional shared {incomingShareBatch.overflowCount === 1 ? "item was" : "items were"} rejected because one share can contain at most 20 items.</Text>}
          <Action label="Discard" colors={colors} compact disabled={incomingShareState.busy || attachmentBusy}
            onPress={() => void discardIncomingShare(incomingShareBatch.batchId)} />
        </> : <>
          <Text style={[styles.caption, { color: colors.muted }]}>Before you continue: {incomingSharePlan.accepted.length} {incomingSharePlan.accepted.length === 1 ? "file matches" : "files match"} this project; {incomingSharePlan.rejected.length} will be skipped.</Text>
          {incomingSharePlan.rejected.map((rejection, index) => <Text key={`${rejection.itemId ?? "overflow"}-${index}`}
            accessibilityRole="alert" style={[styles.caption, { color: colors.negative }]}>
            {rejection.fileName ? `${rejection.fileName}: ` : ""}{rejection.reason}
          </Text>)}
          <View style={styles.actionRow}>
            <Action label={attachmentBusy || incomingShareState.busy ? "Adding…"
              : incomingSharePlan.accepted.length > 0 ? "Add shared files" : "Confirm and clear"}
              colors={colors} compact disabled={!referencesEditable || incomingShareState.busy}
              onPress={() => void importIncomingShare(incomingShareBatch)} />
            <Action label="Discard" colors={colors} compact disabled={incomingShareState.busy || attachmentBusy}
              onPress={() => void discardIncomingShare(incomingShareBatch.batchId)} />
          </View>
        </>}
        {incomingShareState.error && <Text accessibilityRole="alert"
          style={[styles.warning, { color: colors.negative, paddingHorizontal: 0 }]}>{incomingShareState.error}</Text>}
      </>}
    </View>}
    <Text style={[styles.section, { color: colors.muted }]}>Project</Text>
    {targets.length === 0 && <Text style={[styles.description, { color: colors.muted }]}>No project currently supports text tasks. Create one on a connected Joko client, then refresh.</Text>}
    {targets.map((target) => <Pressable key={target.targetId} accessibilityRole="radio" accessibilityState={{ selected: draft.targetId === target.targetId }}
      accessibilityLabel={`Project ${target.displayName}`} disabled={!ownerReady || state.busy || attachmentBusy || voice.busy || retained !== undefined}
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
    {draft.targetId && !targetAvailable && <Banner text="The retained project is no longer an active text target. Choose a current project; your name and first message were kept." colors={colors} />}
    <Field label="Task name" value={draft.name} onChange={(name) => patchDraft({ name })} placeholder="New task" colors={colors}
      editable={ownerReady && !state.busy && !attachmentBusy && !voice.busy && retained === undefined} maxLength={256} />
    <View style={styles.field}>
      <Text style={[styles.caption, { color: colors.muted }]}>First message</Text>
      {(voice.available || voice.checking || voice.busy || sessionMentionControls || workspaceMentionControls || attachmentControls
        || ownerReady || draft.input.mentions.length > 0 || draft.input.atoms.length > 0
        || draft.input.attachments.length > 0) && <View style={styles.composerTools}>
        {(voice.available || voice.checking || voice.busy) && <MobileVoiceAction voice={voice} colors={colors}
          disabled={!ownerReady || !targetAvailable || state.busy || mentionBusy || attachmentBusy
            || state.status !== "connected" || retained !== undefined} />}
        {sessionMentionControls && <Action label="Reference task" colors={colors} compact
          disabled={!referencesEditable || draft.input.mentions.filter((mention) => mention.kind === "session").length >= 8}
          onPress={() => {
            setWorkspaceMentionsVisible(false);
            setSessionMentionError("");
            setSessionMentionsVisible(true);
          }} />}
        {workspaceMentionControls && <Action label="Reference Workspace" colors={colors} compact
          disabled={!referencesEditable}
          onPress={() => {
            setSessionMentionsVisible(false);
            setSessionMentionError("");
            setWorkspaceMentionsVisible(true);
          }} />}
        <Action label="Paste text" colors={colors} compact disabled={!referencesEditable}
          onPress={() => void pasteClipboardText()} />
        {attachmentControls && <Action label={attachmentBusy ? "Selecting…" : "Attach"} colors={colors} compact
          disabled={!referencesEditable || draft.input.attachments.length >= attachmentControls.policy.maximumItems}
          onPress={() => void addAttachments("picker")} />}
        {attachmentControls && mobilePhotoLibrarySupported(attachmentControls.policy) && <Action label="Photos"
          colors={colors} compact
          disabled={!referencesEditable || draft.input.attachments.length >= attachmentControls.policy.maximumItems}
          onPress={openPhotoLibrary} />}
        {attachmentControls && mobileCameraCaptureSupported(attachmentControls.policy) && <Action label="Take photo"
          colors={colors} compact
          disabled={!referencesEditable || draft.input.attachments.length >= attachmentControls.policy.maximumItems}
          onPress={() => void addAttachments("camera")} />}
        {draft.input.mentions.length > 0 && <ScrollView horizontal keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.mentionChips} showsHorizontalScrollIndicator={false}>
          {draft.input.mentions.map((mention) => <Pressable key={mention.mentionId}
            accessibilityRole="button" accessibilityLabel={`Remove ${mention.kind === "session" ? "task"
              : mention.kind === "workspace" && mention.directory ? "directory" : "file"} reference ${mention.displayText}`}
            accessibilityHint="Removes this exact reference occurrence from the first message"
            disabled={!referencesEditable} onPress={() => removeMention(mention.mentionId)}
            style={[styles.mentionChip, { borderColor: colors.border, backgroundColor: colors.brandBackground },
              !referencesEditable && styles.disabled]}>
            <Text style={[styles.mentionChipText, { color: colors.ink }]} numberOfLines={1}>
              {draft.input.text.slice(mention.start, mention.end)} ×
            </Text>
          </Pressable>)}
        </ScrollView>}
        <MobileComposerAtomChips atoms={draft.input.atoms} colors={colors}
          disabled={!referencesEditable} onOpen={setComposerAtomId} />
      </View>}
      <MobileAttachmentTray attachments={draft.input.attachments} colors={colors}
        disabled={!referencesEditable} busy={attachmentBusy || state.busy} pendingCount={pastedImageCount}
        onPreview={(attachmentId) => void openImageEditor(attachmentId)} onRemove={removeAttachment} />
      <MobileComposerRichInput key={`new-task-rich-${profileId ?? "none"}-${draft.targetId}`}
        ref={composerInputRef} accessibilityLabel="First message"
        accessibilityHint="This structured message is sent after the task is created"
        bordered draft={ownerReady ? draft.input : emptyMobileComposerDraft()} editable={referencesEditable}
        height={composerHeight} maxHeight={260} ownerKey={`new-task\u001f${profileId ?? "none"}\u001f${draft.targetId}`}
        placeholder={ownerReady ? "What should Joko do?" : "Restoring saved draft…"}
        selection={ownerReady ? composerSelection : { start: 0, end: 0 }} theme={composerTheme}
        onEdit={(result, sourceDraft) => {
          if (!referencesEditableRef.current || draftRef.current.input !== sourceDraft) {
            setError("Return to the active new-task composer before editing the first message.");
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
      <Text style={[styles.label, { color: colors.ink }]}>{retained.phase === "creating" ? "Task creation retained" : "First message retained"}</Text>
      <Text style={[styles.caption, { color: colors.muted }]}>{retained.phase === "creating"
        ? "Joko will only reconcile this exact creation operation; it will not create a second task automatically."
        : "The task exists. If delivery failed or is unknown, the exact structured input is retained in its composer without automatic replay."}</Text>
    </View>}
    <Action label={state.busy ? "Creating and sending…" : "Create and send"}
      disabled={!ownerReady || !draft.targetId || !targetAvailable
        || (!draft.input.text.trim() && draft.input.attachments.length === 0)
        || state.busy || mentionBusy || attachmentBusy || voice.busy
        || state.status !== "connected" || retained !== undefined || pendingCreate}
      colors={colors} onPress={submit} />
    {retained?.phase === "sending" && state.selectedId === retained.sessionId
      && <Action label="Open created task" onPress={onCreated} colors={colors} />}
    {(error || state.error) && <Banner text={error || state.error || ""} colors={colors} />}
    {imageOutputNotice && <Notice text={imageOutputNotice} colors={colors}
      onDismiss={() => setImageOutputNotice("")} />}
    <PendingReceipts items={state.pending.filter((item) => item.kind === "create")} colors={colors} onError={setError} />
    {(pendingCreate || retained !== undefined) && <Action label="Check retained status" onPress={() => {
      setError("");
      void client.reconcile().then(() => {
        const current = identity ? mobileNewTaskDrafts.readSync(identity)?.submission : undefined;
        if (current?.phase === "sending" && client.state.selectedId === current.sessionId) onCreated();
      }).catch((failure) => setError(errorText(failure)));
    }} colors={colors} disabled={state.busy || state.status !== "connected"} />}
    <MobileSessionMentionSheet visible={sessionMentionsVisible && sessionMentionControls !== undefined}
      controls={sessionMentionControls} busy={state.busy || mentionBusy} error={sessionMentionError} colors={colors}
      onClose={() => { if (!mentionBusy) { setSessionMentionsVisible(false); setSessionMentionError(""); } }}
      onSelect={insertSessionMention} />
    <MobileWorkspaceMentionSheet visible={workspaceMentionsVisible && workspaceMentionControls !== undefined}
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
    <MobilePhotoLibrarySheet visible={photoLibraryLease !== undefined}
      ownerKey={photoLibraryLease?.controls.surfaceOwnerKey}
      maximumSelection={Math.max(0, (photoLibraryLease?.controls.policy.maximumItems ?? 0)
        - draft.input.attachments.length)}
      colors={colors} library={mobilePhotoLibrary}
      onAdd={addPhotoLibraryAssets} onClose={closePhotoLibrary} />
    <MobileComposerAtomSheet atom={draft.input.atoms.find((atom) => atom.atomId === composerAtomId)}
      colors={colors} busy={!referencesEditable} onClose={() => setComposerAtomId(undefined)}
      onSavePaste={savePastedTextAtom} onRemove={removeComposerAtom} />
    {imageEditorLease && <MobileImageLightbox session={imageEditorLease.session}
      onOutputAction={async (action, decoded, rendered, signal) => {
        setImageOutputNotice("");
        setError("");
        try {
          const message = await performMobileImageOutput(imageEditorLease.session, action, decoded, rendered, signal);
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

function TaskScreen({ colors, state, onBack, onHome, onNew, onFiles, focusComposer, onComposerFocused }: ScreenProps & {
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
  const initialInteractions = client.taskInteractions();
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
  const imageGallery = useMobileImageGallery((nextDraft) => {
    const identity = draftIdentityRef.current;
    if (!identity || mobileComposerDraftIdentityKey(identity) !== draftIdentityKey) return;
    composerDraftRef.current = nextDraft;
    setDraft(nextDraft);
    setComposerNotice("Image added to the composer. Review it before sending.");
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
  const interactions = client.taskInteractions();
  const runtimeControls = client.taskRuntimeControls();
  const runtimeControlsOwnerRef = useRef(runtimeControls?.surfaceOwnerKey);
  const contextControls = client.taskContextControls();
  const contextOwnerRef = useRef(contextControls?.surfaceOwnerKey);
  const nativeTreeControls = client.taskNativeTreeControls();
  const nativeTreeOwnerRef = useRef(nativeTreeControls?.surfaceOwnerKey);
  const sessionMentionControls = client.taskSessionMentionControls();
  const sessionMentionOwnerRef = useRef(sessionMentionControls?.surfaceOwnerKey);
  const workspaceMentionControls = client.taskWorkspaceMentionControls();
  const workspaceMentionOwnerRef = useRef(workspaceMentionControls?.surfaceOwnerKey);
  const catalogMentionControls = client.taskCatalogMentionControls();
  const catalogMentionOwnerRef = useRef(catalogMentionControls?.surfaceOwnerKey);
  const appCommandControls = client.taskAppCommandControls();
  const runtimeCommandControls = client.taskRuntimeCommandControls();
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
  const voiceTransport = client.taskVoiceTransport();
  const attachmentControls = client.taskAttachmentControls();
  const attachmentOwnerRef = useRef(attachmentControls?.surfaceOwnerKey);
  const attachmentGenerationRef = useRef(0);
  const attachmentNativeActivityRef = useRef(false);
  const attachmentAbortRef = useRef<AbortController | undefined>(undefined);
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
    const active = queueEditRef.current;
    if (!active) return;
    const itemStillAccepted = state.detail?.queueItems.some((item) => item.queueItemId === active.lease.queueItemId
      && item.sessionId === active.lease.sessionId && item.state === QueueItemState.ACCEPTED) === true;
    const authorityRetired = state.selectedId !== active.lease.sessionId
      || state.status === "offline" || state.status === "unpaired" || state.status === "revoked";
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
    if (!state.selectedId || voice.busy) return;
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
    requestId: randomUUID
  });
  useMobileVoicePermissionSettings(voice.error);
  const composerPasteEditable = composerOwnerReady && queueEdit === undefined && !state.busy
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
        throw new Error("The task draft or command owner changed. Type the slash command again.");
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
        throw new Error("The task draft changed before the runtime command could be inserted.");
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
  const openTimelineArtifact = (artifact: MobileTimelinePreviewArtifact): void => {
    if (state.timelinePreview || galleryOpening || imageGallery.view || state.status !== "connected"
      || state.busy || attachmentBusy || voice.busy) return;
    setComposerNotice("");
    setLocalError("");
    void client.previewTimelineArtifact(artifact).catch((error) => {
      if (taskMountedRef.current) setLocalError(errorText(error));
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
      const sourceName = source === "camera" ? "camera" : source === "photos" ? "photo library" : "picker";
      setLocalError(`Attachment authority changed. Reopen the ${sourceName} from the current task.`);
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
        throw new Error("Attachment authority changed while the selected media was being staged.");
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
      setLocalError("Photo-library authority changed. Reopen Photos from the current task.");
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
      throw new Error("Photo-library authority changed. Reopen Photos from the current task.");
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
        throw new Error("Attachment authority changed while the selected photos were being staged.");
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
        throw new Error("The attachment removal could not be confirmed in the retained task draft.");
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
    if (!lease) throw new Error("The image editor is no longer open.");
    const result = await client.commitComposerImageEditor(lease.session.leaseId, strokes, burned, signal);
    const identity = draftIdentityRef.current;
    if (!taskMountedRef.current || imageEditorLeaseRef.current !== lease || result.surface !== "task"
      || !identity || lease.scopeKey !== mobileComposerDraftIdentityKey(identity)) {
      throw new Error("The task image editor owner changed before its result could be displayed.");
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
      setLocalError("Task reference authority changed. Reopen the reference list and try again.");
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
      throw new Error("Workspace reference authority changed. Reopen the reference list and try again.");
    }
    if (lineRange !== undefined && !controls.policy.lineRanges) {
      throw new Error("This Backend no longer supports Workspace line references.");
    }
    const current = await client.validateTaskWorkspaceMentionCandidate(surfaceOwnerKey, candidate);
    const latestControls = client.taskWorkspaceMentionControls();
    if (!latestControls || latestControls.surfaceOwnerKey !== surfaceOwnerKey
      || workspaceMentionOwnerRef.current !== surfaceOwnerKey || queueEditRef.current
      || !draftIdentityRef.current
      || mobileComposerDraftIdentityKey(draftIdentityRef.current) !== mobileComposerDraftIdentityKey(identity)) {
      setWorkspaceMentionsVisible(false);
      throw new Error("Workspace reference authority changed while the path was being checked.");
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
      throw new Error("Catalog reference authority changed. Reopen the reference list and try again.");
    }
    const current = await client.validateTaskCatalogMentionCandidate(surfaceOwnerKey, candidate);
    const latestControls = client.taskCatalogMentionControls();
    if (!latestControls || latestControls.surfaceOwnerKey !== surfaceOwnerKey
      || catalogMentionOwnerRef.current !== surfaceOwnerKey || queueEditRef.current
      || !draftIdentityRef.current
      || mobileComposerDraftIdentityKey(draftIdentityRef.current) !== mobileComposerDraftIdentityKey(identity)) {
      setCatalogMentionsVisible(false);
      throw new Error("Catalog reference authority changed while the candidate was being checked.");
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
      setLocalError("Return to the active task composer before pasting text.");
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
        throw new Error("The task draft changed while clipboard text was being read. Paste it again.");
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
          throw new Error("The task Workspace changed while clipboard paths were being checked. Paste them again.");
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
      setLocalError("The clipboard image batch no longer belongs to this task draft. Paste it again.");
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
            throw new Error("Attachment authority changed while the clipboard images were being prepared.");
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
        throw new Error("The task composer changed while the quote was being selected. Select it again.");
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
    if (voice.busy) return;
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
        setLocalError("Only a current completed assistant text message can be quoted.");
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
      setLocalError("This message is no longer deletable in the current idle task.");
      return;
    }
    Alert.alert(
      "Delete this message?",
      "This removes the selected durable message from the current task.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => {
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
    if (!profileId || !composerOwnerReady || interactions.length > 0 || voice.busy) return;
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
            throw new Error("This app command is unavailable here or its syntax is invalid. The draft was retained.");
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
            setComposerNotice("The command result is unknown. Check its durable operation; Joko will not run it again automatically.");
          } else if (outcome.status === "rejected") {
            setLocalError("The command was rejected. Its draft was retained.");
          } else if (outcome.kind === "userShell") {
            setComposerNotice("Shell command completed with a typed acknowledgement.");
          } else if (outcome.kind === "sessionReset") {
            setComposerNotice("Task context cleared.");
          } else if (outcome.kind === "review") {
            setComposerNotice("Independent Review started.");
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
      {wideNavigation.enabled ? <Pressable ref={drawerMenuRef} accessibilityRole="button" accessibilityLabel="Open task list"
        onPress={() => { pendingDrawerActionRef.current = undefined; setDrawerOpen(true); }}
        style={[styles.headerIconButton, { borderColor: colors.border, backgroundColor: colors.surface }]}>
        <Text style={[styles.headerIcon, { color: colors.ink }]}>☰</Text>
      </Pressable> : <Back onPress={onBack} colors={colors} />}
      <View style={styles.fill}>
        <Text style={[styles.title, { color: colors.ink }]} numberOfLines={1}>{session?.displayName || "Task"}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{session ? sessionState(session.state) : "Loading…"}</Text>
      </View>
      <View style={styles.headerActions}>
        <Action label="Branches"
          onPress={() => { setSessionMentionsVisible(false); setWorkspaceMentionsVisible(false); setCatalogMentionsVisible(false); setContextVisible(false); setRuntimeControlsVisible(false); setNativeTreeVisible(true); }} colors={colors} compact
          disabled={nativeTreeControls === undefined || state.busy || attachmentBusy || voice.busy || interactions.length > 0} />
        <Action label={contextControls?.usage ? `Context ${contextControls.usage.percent}%` : "Context"}
          onPress={() => { setSessionMentionsVisible(false); setWorkspaceMentionsVisible(false); setCatalogMentionsVisible(false); setNativeTreeVisible(false); setRuntimeControlsVisible(false); setContextVisible(true); }} colors={colors} compact
          disabled={contextControls === undefined || state.busy || attachmentBusy || voice.busy || interactions.length > 0} />
        <Action label="Controls" onPress={() => { setSessionMentionsVisible(false); setWorkspaceMentionsVisible(false); setCatalogMentionsVisible(false); setNativeTreeVisible(false); setContextVisible(false); setRuntimeControlsVisible(true); }} colors={colors} compact
          disabled={!runtimeControlsAvailable || state.busy || attachmentBusy || voice.busy || interactions.length > 0} />
        {client.canOpenFiles() && <Action label="Files" onPress={onFiles} colors={colors} compact disabled={attachmentBusy} />}
        <Action label="Refresh" onPress={() => void client.refresh()} colors={colors} compact disabled={attachmentBusy} />
      </View>
    </View>
    <Text accessibilityLiveRegion="polite" style={[styles.caption, styles.queue, { color: colors.muted }]}>
      {state.liveStatus === "streaming" ? "Live events" : state.liveStatus === "verifying" ? "Checking live updates…"
        : state.liveStatus === "polling" ? "Snapshot updates · live stream unavailable" : "Updates paused"}
    </Text>
    {state.error && <Banner text={state.error} colors={colors} />}
    <FlatList data={rows} keyExtractor={(row) => row.id} style={styles.fill} contentContainerStyle={styles.list}
      ListHeaderComponent={<View style={styles.historyActions}>
        {state.window && <Action label="Return to latest" colors={colors} onPress={() => client.latest()} />}
        {!state.historyEnd && <Action label={state.historyBusy ? "Loading history…" : "Load earlier history"} colors={colors}
          disabled={state.historyBusy || state.status !== "connected"}
          onPress={() => void client.older().catch((error) => setLocalError(errorText(error)))} />}
      </View>}
      ListEmptyComponent={<Centered label={state.status === "offline" ? "Offline. Reconnect to restore this task." : "No messages yet"} colors={colors} />}
      renderItem={({ item }) => <View style={[styles.message, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.caption, { color: colors.muted }]}>{item.label}</Text>
        <Text selectable style={[styles.body, { color: colors.ink }]}>{item.text}</Text>
        {item.images && item.images.length > 0 && <View accessibilityLabel={`${item.label} images`} style={styles.messageImages}>
          {item.images.map((image, index) => <Pressable key={image.pageId} accessibilityRole="imagebutton"
            accessibilityLabel={`Open image ${index + 1} of ${item.images!.length}, ${image.title}`}
            accessibilityHint="Opens this completed message image in the full-screen gallery"
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
            <Text style={[styles.caption, { color: colors.accent }]}>Open</Text>
          </Pressable>)}
        </View>}
        {item.artifacts && item.artifacts.length > 0 && <View accessibilityLabel={`${item.label} files`} style={styles.messageImages}>
          {item.artifacts.map((artifact) => {
            const disabled = state.timelinePreview !== undefined || galleryOpening || imageGallery.view !== undefined
              || state.status !== "connected" || state.busy || attachmentBusy || voice.busy;
            return <Pressable key={artifact.artifactId} accessibilityRole="button"
              accessibilityLabel={`Open ${artifact.title}, ${artifact.mediaType}`}
              accessibilityHint="Opens this verified completed-message file in the full-screen preview"
              disabled={disabled} onPress={() => openTimelineArtifact(artifact)}
              style={[styles.messageImageTile, { borderColor: colors.border, backgroundColor: colors.background },
                disabled && styles.disabled]}>
              <Text style={styles.messageImageGlyph}>{artifact.previewKind === "pdf" ? "▤"
                : artifact.previewKind === "model" ? "⬡" : "▶"}</Text>
              <View style={styles.fill}>
                <Text style={[styles.label, { color: colors.ink }]} numberOfLines={1}>{artifact.title}</Text>
                <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>
                  {artifact.mediaType} · {formatByteSize(artifact.byteSize)}
                </Text>
              </View>
              <Text style={[styles.caption, { color: colors.accent }]}>Open</Text>
            </Pressable>;
          })}
        </View>}
        <View style={styles.messageActions}>
          <Pressable accessibilityRole="button" accessibilityLabel={`View context for ${item.label}`}
            disabled={state.historyBusy || state.status !== "connected"}
            onPress={() => { setLocalError(""); void client.around(item.eventId).catch((error) => setLocalError(errorText(error))); }}
            style={styles.inlineTouchAction}>
            <Text style={[styles.caption, { color: colors.accent }]}>View context</Text>
          </Pressable>
           {buildMobileMessageActions(item, { canDelete: client.canDeleteMessage(item.eventId) }).length > 0
            && <Pressable accessibilityRole="button" accessibilityLabel={`More actions for ${item.label}`}
              disabled={voice.busy} onPress={() => openMessageActions(item)}
              style={[styles.inlineTouchAction, voice.busy && styles.disabled]}>
              <Text style={[styles.caption, { color: voice.busy ? colors.muted : colors.accent }]}>More</Text>
            </Pressable>}
        </View>
      </View>} />
    {queueItems.length > 0 && <View style={styles.queueRegion}>
      <Text style={[styles.section, { color: colors.muted }]}>Queue</Text>
      <ScrollView nestedScrollEnabled style={styles.queueScroll} contentContainerStyle={styles.queueList}
        keyboardShouldPersistTaps="handled">
      {queueItems.map((item, index) => {
        const editing = queueEdit?.lease.queueItemId === item.queueItemId;
        const disabled = state.busy || voice.busy || state.status !== "connected" || queueMutationPending || interactions.length > 0 || (!!queueEdit && !editing);
        const editableText = queueItemText(item.input);
        return <View key={item.queueItemId} style={[styles.queueCard, { backgroundColor: colors.surface, borderColor: editing ? colors.accent : colors.border }]}>
          <Text style={[styles.caption, { color: colors.muted }]}>Queued {index + 1} · {queueState(item.state)}{item.editLocked && !editing ? " · Editing elsewhere" : ""}</Text>
          <Text selectable style={[styles.body, { color: colors.ink }]}>{queueItemSummary(item)}</Text>
          <View style={styles.queueActions}>
            {queueCapabilities.edit && <Action label={editing ? "Editing" : "Edit"} colors={colors} compact
              disabled={disabled || editing || item.editLocked || editableText === undefined}
              onPress={() => void beginQueueEdit(item)} />}
            {queueCapabilities.cancel && <Action label="Remove" colors={colors} compact
              disabled={disabled || editing}
              onPress={() => mutateQueue(() => client.cancelQueueItem(item.queueItemId))} />}
            {queueCapabilities.reorder && <Action label="Move up" colors={colors} compact
              disabled={disabled || editing || index === 0}
              onPress={() => mutateQueue(() => client.moveQueueItem(item.queueItemId, "up"))} />}
            {queueCapabilities.reorder && <Action label="Move down" colors={colors} compact
              disabled={disabled || editing || index === queueItems.length - 1}
              onPress={() => mutateQueue(() => client.moveQueueItem(item.queueItemId, "down"))} />}
          </View>
        </View>;
      })}
      </ScrollView>
    </View>}
    {state.pending.filter((item) => item.sessionId === state.selectedId).map((item) => <View key={item.operationId} style={styles.pending}>
      <Text style={[styles.warning, { color: colors.negative }]}>{item.state === "unknown" ? "Operation result unknown" : "Awaiting durable result"} · {item.operationId}</Text>
      <Action label="Check status" onPress={() => void client.reconcile()} colors={colors} compact />
      {item.state === "unknown" && <Action label="Clear unconfirmed receipt" onPress={() => Alert.alert(
        "Clear this receipt?", "Only continue if you have checked the task. Joko will verify the operation is absent before clearing this local warning; it will not repeat the operation.",
        [{ text: "Keep checking", style: "cancel" }, { text: "Verify and clear", onPress: () => {
          void client.dismissUnconfirmed(item.operationId).catch((error) => setLocalError(errorText(error)));
        } }]
      )} colors={colors} compact />}
    </View>)}
    {localError && <Banner text={localError} colors={colors} />}
    {composerNotice && <View accessibilityLiveRegion="polite"
      style={[styles.connectionNotice, { backgroundColor: colors.brandBackground, borderColor: colors.accent }]}>
      <Text style={[styles.caption, styles.fill, { color: colors.ink }]}>{composerNotice}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Dismiss composer notice" onPress={() => setComposerNotice("")}
        style={styles.inlineTouchAction}><Text style={[styles.caption, { color: colors.accent }]}>Dismiss</Text></Pressable>
    </View>}
    {queueEdit && <View style={[styles.queueEditBanner, { borderColor: colors.border, backgroundColor: colors.brandBackground }]}>
      <Text style={[styles.caption, styles.fill, { color: colors.ink }]}>
        {queueEdit.lease.replacesStructuredInput
          ? "Editing queued input · changing its text removes structured reference and quote authority"
          : "Editing queued input"}
      </Text>
      <Action label="Cancel edit" colors={colors} compact disabled={state.busy} onPress={cancelQueueEdit} />
    </View>}
    {interactions.length > 0 ? <View style={[styles.interactionAwaiting, { borderColor: colors.border, backgroundColor: colors.brandBackground }]}>
      <View style={styles.fill}>
        <Text style={[styles.caption, { color: colors.muted }]}>{interactions.length === 1 ? "Task needs a response" : `${interactions.length} task requests need responses`}</Text>
        <Text style={[styles.label, { color: colors.ink }]} numberOfLines={1}>{activeInteraction ? mobileInteractionTitle(activeInteraction) : "Open request"}</Text>
      </View>
      <Action label="Open request" colors={colors} compact disabled={interactionMutationPending}
        onPress={() => setInteractionVisible(true)} />
    </View> : <View style={[styles.composer, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <View accessible accessibilityRole="adjustable" accessibilityLabel="Message input height"
        accessibilityHint="Swipe up or down to resize. Accessibility actions resize or return to automatic height."
        accessibilityActions={[{ name: "increment", label: "Increase height" }, { name: "decrement", label: "Decrease height" }, { name: "activate", label: "Use automatic height" }]}
        accessibilityValue={{ min: composerBounds.minimumHeight, max: composerBounds.maximumHeight,
          now: Math.round(composerHeight.visibleHeight), text: composerHeight.mode === "automatic" ? "Automatic height" : `Manual height ${Math.round(composerHeight.visibleHeight)}` }}
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
        {(voice.available || voice.checking || voice.busy) && <MobileVoiceAction voice={voice} colors={colors}
          disabled={!composerOwnerReady || state.busy || composerOperationPending || attachmentBusy
            || state.status !== "connected"} />}
        {sessionMentionControls && <Action label="Reference task" colors={colors} compact
          disabled={state.busy || composerOperationPending || voice.busy || !composerOwnerReady
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
        {workspaceMentionControls && <Action label="Reference Workspace" colors={colors} compact
          disabled={state.busy || composerOperationPending || voice.busy || !composerOwnerReady}
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
          label={catalogMentionControls.policy.resources && catalogMentionControls.policy.artifacts
            ? "Reference Resource / Artifact"
            : catalogMentionControls.policy.resources ? "Reference Resource" : "Reference Artifact"}
          colors={colors} compact disabled={state.busy || composerOperationPending || voice.busy || !composerOwnerReady}
          onPress={() => {
            setNativeTreeVisible(false);
            setContextVisible(false);
            setRuntimeControlsVisible(false);
            setSessionMentionsVisible(false);
            setSessionMentionError("");
            setWorkspaceMentionsVisible(false);
            setCatalogMentionsVisible(true);
          }} />}
        <Action label="Paste text" colors={colors} compact
          disabled={!composerPasteEditable}
          onPress={() => void pasteClipboardText()} />
        {attachmentControls && <Action label={attachmentBusy ? "Selecting…" : "Attach"}
          colors={colors} compact
          disabled={state.busy || composerOperationPending || voice.busy || attachmentBusy || !composerOwnerReady
            || draft.attachments.length >= attachmentControls.policy.maximumItems}
          onPress={() => void addAttachments("picker")} />}
        {attachmentControls && mobilePhotoLibrarySupported(attachmentControls.policy) && <Action label="Photos"
          colors={colors} compact
          disabled={state.busy || composerOperationPending || voice.busy || attachmentBusy || !composerOwnerReady
            || draft.attachments.length >= attachmentControls.policy.maximumItems}
          onPress={openPhotoLibrary} />}
        {attachmentControls && mobileCameraCaptureSupported(attachmentControls.policy) && <Action label="Take photo"
          colors={colors} compact
          disabled={state.busy || composerOperationPending || voice.busy || attachmentBusy || !composerOwnerReady
            || draft.attachments.length >= attachmentControls.policy.maximumItems}
          onPress={() => void addAttachments("camera")} />}
        {draft.mentions.length > 0 && <ScrollView horizontal keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.mentionChips} showsHorizontalScrollIndicator={false}>
          {draft.mentions.map((mention) => <Pressable key={mention.mentionId}
            accessibilityRole="button" accessibilityLabel={`Remove ${mention.kind === "session" ? "task"
              : mention.kind === "workspace" ? mention.directory ? "directory" : "file"
                : mention.kind === "resource" ? "resource" : "Artifact"} reference ${mention.displayText}`}
            accessibilityHint="Removes this exact reference occurrence from the message"
            disabled={state.busy || composerOperationPending || voice.busy} onPress={() => removeComposerMention(mention.mentionId)}
            style={[styles.mentionChip, { borderColor: colors.border, backgroundColor: colors.brandBackground },
              (state.busy || composerOperationPending || voice.busy) && styles.disabled]}>
            <Text style={[styles.mentionChipText, { color: colors.ink }]} numberOfLines={1}>{draft.text.slice(mention.start, mention.end)} ×</Text>
          </Pressable>)}
        </ScrollView>}
        <MobileComposerAtomChips atoms={draft.atoms} colors={colors}
          disabled={state.busy || composerOperationPending || voice.busy || attachmentBusy || !composerOwnerReady}
          onOpen={setComposerAtomId} />
      </View>}
      {!queueEdit && <MobileAttachmentTray attachments={draft.attachments} colors={colors}
        disabled={state.busy || composerOperationPending || voice.busy || attachmentBusy || !composerOwnerReady}
        busy={state.busy || composerOperationPending || voice.busy || attachmentBusy}
        pendingCount={pastedImageCount}
        onPreview={(attachmentId) => void openImageEditor(attachmentId)} onRemove={removeAttachment} />}
      <MobileRuntimeCommandPalette visible={runtimeCommandPaletteVisible}
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
        {queueEdit ? <TextInput ref={queueInputRef} accessibilityLabel="Queued input" multiline
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
          editable={!state.busy && !composerOperationPending && composerOwnerReady} placeholder="Edit queued input…"
          placeholderTextColor={colors.muted}
          style={[styles.composerInput, { color: colors.ink, height: composerHeight.visibleHeight }]} />
          : <MobileComposerRichInput key={`task-rich-${draftIdentityKey ?? "none"}`}
            ref={composerInputRef} accessibilityLabel="Task message"
            commandPaletteOpen={runtimeCommandPaletteVisible}
            draft={composerOwnerReady ? draft : emptyMobileComposerDraft()}
            editable={composerPasteEditable} height={composerHeight.visibleHeight}
            maxHeight={composerBounds.maximumHeight} ownerKey={`task\u001f${draftIdentityKey ?? "none"}`}
            placeholder={composerOwnerReady ? "Message Joko…" : "Restoring saved draft…"}
            selection={composerOwnerReady ? composerSelection : { start: 0, end: 0 }} theme={composerTheme}
            onEdit={(result, sourceDraft) => {
              const identity = draftIdentityRef.current;
              if (!identity || queueEditRef.current || !composerPasteEditableRef.current
                || composerDraftRef.current !== sourceDraft) {
                setLocalError("Return to the active task composer before editing this message.");
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
        <Action label={state.busy || appCommandRunning ? (queueEdit ? "Saving…" : "Sending…") : (queueEdit ? "Save edit" : "Send")} colors={colors} compact
          disabled={!composerOwnerReady || (!draft.text.trim() && (queueEdit !== undefined || draft.attachments.length === 0))
            || (!queueEdit && unknown) || attachmentBusy || voice.busy || state.busy || composerOperationPending
            || state.status !== "connected"}
          onPress={() => void submitComposer()} />
      </View>
    </View>}
    </MobileKeyboardAvoidingView>
    <MobilePhotoLibrarySheet visible={photoLibraryLease !== undefined}
      ownerKey={photoLibraryLease?.controls.surfaceOwnerKey}
      maximumSelection={Math.max(0, (photoLibraryLease?.controls.policy.maximumItems ?? 0)
        - draft.attachments.length)}
      colors={colors} library={mobilePhotoLibrary}
      onAdd={addPhotoLibraryAssets} onClose={closePhotoLibrary} />
    {imageEditorLease && <MobileImageLightbox session={imageEditorLease.session}
      onOutputAction={async (action, decoded, rendered, signal) => {
        setComposerNotice("");
        setLocalError("");
        try {
          const message = await performMobileImageOutput(imageEditorLease.session, action, decoded, rendered, signal);
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
      session={imageGallery.view.session}
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
          if (!view) throw new Error("The image gallery closed before output started.");
          const message = await performMobileImageOutput(view.session, action, decoded, rendered, signal);
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
      backLabel="Task" loadingLabel="Verifying the exact Timeline file…"
      onClose={() => client.closeTimelinePreview()} />
    <MobileActionSheet visible={messageActionsVisible} items={messageActionItems} colors={colors}
      onClose={() => setMessageActionsVisible(false)} onAction={runMessageAction} />
    <MobileCommandHelpSheet visible={commandHelpItems !== undefined} items={commandHelpItems ?? []}
      colors={colors} onClose={() => setCommandHelpItems(undefined)} />
    <MobileQuoteSelectionSheet lease={quoteSelection?.lease} colors={colors} busy={state.busy || voice.busy}
      onClose={() => setQuoteSelection(undefined)} onAdd={addSelectedQuote} />
    <MobileComposerAtomSheet atom={draft.atoms.find((atom) => atom.atomId === composerAtomId)}
      colors={colors} busy={state.busy || voice.busy || attachmentBusy || !composerOwnerReady || queueEdit !== undefined}
      onClose={() => setComposerAtomId(undefined)} onSavePaste={savePastedTextAtom} onRemove={removeComposerAtom} />
    <MobileInteractionSheet visible={interactionVisible && interactions.length > 0}
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
    <MobileRuntimeControlsSheet visible={runtimeControlsVisible && runtimeControls !== undefined}
      controls={runtimeControls} busy={state.busy || runtimeControlPending || attachmentBusy} colors={colors}
      onClose={() => setRuntimeControlsVisible(false)}
      onSetModel={(authorityKey, selection) => client.setTaskModel(authorityKey, selection)}
      onSetPermission={(authorityKey, mode) => client.setTaskPermission(authorityKey, mode)}
      onSetPlanMode={(authorityKey, enabled) => client.setTaskPlanMode(authorityKey, enabled)}
      onError={setLocalError} />
    <MobileContextSheet visible={contextVisible && contextControls !== undefined}
      controls={contextControls} busy={state.busy || contextPending} colors={colors}
      onClose={() => setContextVisible(false)}
      onCompact={(authorityKey) => client.compactTaskContext(authorityKey)}
      onError={setLocalError} />
    <MobileNativeTreeSheet visible={nativeTreeVisible && nativeTreeControls !== undefined}
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
    <MobileSessionMentionSheet visible={sessionMentionsVisible && sessionMentionControls !== undefined}
      controls={sessionMentionControls} busy={state.busy} error={sessionMentionError} colors={colors}
      onClose={() => { setSessionMentionsVisible(false); setSessionMentionError(""); }} onSelect={insertSessionMention} />
    <MobileWorkspaceMentionSheet visible={workspaceMentionsVisible && workspaceMentionControls !== undefined}
      controls={workspaceMentionControls} busy={state.busy} colors={colors}
      onClose={() => setWorkspaceMentionsVisible(false)}
      onLoadDirectory={(surfaceOwnerKey, parentPath, signal) => client.listTaskWorkspaceMentionDirectory(surfaceOwnerKey, parentPath, signal)}
      onLoadFileIndex={(surfaceOwnerKey, signal) => client.listTaskWorkspaceMentionFileIndex(surfaceOwnerKey, signal)}
      onSelect={insertWorkspaceMention} />
    <MobileCatalogMentionSheet visible={catalogMentionsVisible && catalogMentionControls !== undefined}
      controls={catalogMentionControls} busy={state.busy} colors={colors}
      onClose={() => setCatalogMentionsVisible(false)}
      onLoad={(surfaceOwnerKey, signal) => client.listTaskCatalogMentionCatalog(surfaceOwnerKey, signal)}
      onSelect={insertCatalogMention} />
    <MobileDrawer visible={drawerOpen} width={drawerWidthRef.current} backgroundColor={colors.surface} borderColor={colors.border}
      onClose={() => setDrawerOpen(false)} onMountedChange={setDrawerMounted} initialFocusRef={drawerCloseRef}
      onClosed={() => {
        const action = pendingDrawerActionRef.current;
        pendingDrawerActionRef.current = undefined;
        if (action) action(); else focusNative(drawerMenuRef);
      }} testID="task.drawer">
      <TaskListDrawer colors={colors} state={state} closeButtonRef={drawerCloseRef} onClose={() => setDrawerOpen(false)}
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

function FilesScreen({ colors, state, onBack, onAdded }: ScreenProps & { onBack: () => void; onAdded: () => void }) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<MobileFilesSearchMode>("name");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [localError, setLocalError] = useState("");
  const [imageOutputNotice, setImageOutputNotice] = useState("");
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [galleryOpening, setGalleryOpening] = useState(false);
  const [previewSource, setPreviewSource] = useState<MobileFilesComposerSource>();
  const handoffRef = useRef<AbortController | undefined>(undefined);
  const authorityKey = client.filesAuthorityKey();
  const connected = state.status === "connected" && authorityKey !== undefined;
  const files = state.files;
  const searching = query.trim().length > 0;
  const imageGallery = useMobileImageGallery(() => {
    client.closeFiles();
    onAdded();
  });
  const filesBusy = handoffBusy || galleryOpening || imageGallery.view !== undefined;

  useEffect(() => {
    if (!connected || !authorityKey) return;
    if (!files.open || files.authorityKey !== authorityKey || files.status === "offline" || files.status === "idle") {
      setLocalError("");
      void client.openFiles().catch((error) => setLocalError(errorText(error)));
    }
  }, [authorityKey, connected, files.authorityKey, files.open, files.status]);

  useEffect(() => () => {
    handoffRef.current?.abort();
    handoffRef.current = undefined;
    client.closeFiles();
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
  const locationTitle = files.location.kind === "generated"
    ? "Generated"
    : files.location.path || files.workspace?.displayName || "Workspace";

  return <View style={styles.fill}>
    <View style={[styles.header, { borderBottomColor: colors.border }]}>
      <Back onPress={leave} colors={colors} label="Task" />
      <View style={styles.fill}>
        <Text style={[styles.title, { color: colors.ink }]} numberOfLines={1}>Files</Text>
        <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>{locationTitle}</Text>
      </View>
      <Action label={files.status === "loading" ? "Refreshing…" : "Refresh"} compact colors={colors}
        disabled={!connected || files.status === "loading" || filesBusy} onPress={() => run(() => client.refreshFiles())} />
    </View>

    {files.status === "offline" && <View style={[styles.connectionNotice, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={[styles.statusDot, { backgroundColor: colors.negative }]} />
      <Text style={[styles.caption, styles.fill, { color: colors.muted }]}>Offline · showing only the in-memory view already loaded for this task. New reads are paused.</Text>
    </View>}
    {(localError || files.error) && <Banner text={localError || files.error || ""} colors={colors} />}
    {imageOutputNotice && <Notice text={imageOutputNotice} colors={colors}
      onDismiss={() => setImageOutputNotice("")} />}
    {handoffBusy && <View accessibilityLiveRegion="polite" style={[styles.connectionNotice, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <ActivityIndicator color={colors.accent} />
      <Text style={[styles.caption, styles.fill, { color: colors.muted }]}>Adding the verified item to this task’s composer…</Text>
    </View>}
    {galleryOpening && <View accessibilityLiveRegion="polite" style={[styles.connectionNotice, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <ActivityIndicator color={colors.accent} />
      <Text style={[styles.caption, styles.fill, { color: colors.muted }]}>Verifying the current image gallery…</Text>
    </View>}
    {files.watchStatus === "error" && files.watchError && <Banner text={`Live file refresh unavailable: ${files.watchError}`} colors={colors} />}

    <View accessibilityRole="tablist" style={styles.filesTabs}>
      <ModeTab label="Workspace" selected={files.location.kind === "workspace"}
        disabled={!connected || filesBusy} onPress={() => run(() => client.openFilesDirectory(""))} colors={colors} />
      <ModeTab label={`Generated${files.artifacts.length ? ` (${files.artifacts.length})` : ""}`}
        selected={files.location.kind === "generated"} disabled={!connected || filesBusy} onPress={() => {
          setLocalError("");
          try { client.openGeneratedFiles(); } catch (error) { setLocalError(errorText(error)); }
        }} colors={colors} />
    </View>

    <View style={styles.filesSearchControls}>
      <TextInput accessibilityLabel="Search files" placeholder={mode === "name" ? "Search file names" : "Search file contents"}
        placeholderTextColor={colors.muted} value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false}
        editable={!filesBusy}
        style={[styles.input, styles.searchInput, { color: colors.ink, backgroundColor: colors.surface, borderColor: colors.border }]} />
      {files.searchStatus === "searching" && <ActivityIndicator color={colors.accent} />}
    </View>
    <View style={styles.filesSearchOptions}>
      <View accessibilityRole="tablist" style={styles.filesSearchModes}>
        <ModeTab label="Name" selected={mode === "name"} disabled={filesBusy} onPress={() => setMode("name")} colors={colors} />
        <ModeTab label="Content" selected={mode === "content"} disabled={filesBusy} onPress={() => setMode("content")} colors={colors} />
      </View>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: caseSensitive, disabled: filesBusy }}
        accessibilityLabel="Case-sensitive file search" disabled={filesBusy}
        onPress={() => setCaseSensitive((value) => !value)} style={[styles.caseChoice, filesBusy && styles.disabled]}>
        <View style={[styles.choiceBox, { borderColor: caseSensitive ? colors.accent : colors.border,
          backgroundColor: caseSensitive ? colors.accent : colors.surface }]}>
          {caseSensitive && <Text style={styles.choiceCheck}>✓</Text>}
        </View>
        <Text style={[styles.caption, { color: colors.ink }]}>Match case</Text>
      </Pressable>
    </View>
    {files.searchError && searching && <Banner text={files.searchError} colors={colors} />}
    {files.searchTruncated && searching && <Text accessibilityRole="alert" style={[styles.warning, { color: colors.negative }]}>
      Results are truncated by the node. Refine the literal query to inspect the complete result set.
    </Text>}

    {files.status === "loading" && files.entries.length === 0 && files.artifacts.length === 0
      ? <Centered label="Loading the current Workspace and Generated files…" colors={colors} />
      : <ScrollView style={styles.fill} contentContainerStyle={styles.filesList} keyboardShouldPersistTaps="handled">
        {searching ? <>
          <Text style={[styles.section, { color: colors.muted }]}>Search results</Text>
          {files.searchStatus === "ready" && files.searchResults.length === 0
            && <Text style={[styles.description, { color: colors.muted }]}>No matching files</Text>}
          {files.searchResults.map((result, index) => <FileSearchResultRow key={fileSearchResultKey(result, index)}
            result={result} colors={colors} disabled={!connected || filesBusy} onPress={() => openResult(result)}
            onAdd={() => addToComposer({ kind: "search-result", result })} />)}
          {files.searchStatus === "ready" && <Text style={[styles.caption, { color: colors.muted }]}>
            {files.searchResults.length} result{files.searchResults.length === 1 ? "" : "s"}
            {mode === "content" ? ` across ${files.searchTotalFiles} file${files.searchTotalFiles === 1 ? "" : "s"}` : ""}
          </Text>}
        </> : files.location.kind === "generated" ? <>
          <Text style={[styles.section, { color: colors.muted }]}>Generated by this task</Text>
          {files.artifacts.length === 0 && <Text style={[styles.description, { color: colors.muted }]}>No canonical Generated files are available for this task.</Text>}
          {files.artifacts.map((artifact) => {
            const galleryImage = mobileImageGalleryMediaType(artifact.blob?.mediaType ?? "") !== undefined;
            const model = artifact.blob
              ? mobileModelPreviewKind(artifact.blob.mediaType, artifact.blob.fileName) !== undefined : false;
            const source = { kind: "artifact" as const, artifact };
            return <View key={artifact.artifactId} style={styles.fileActionRow}>
            <Pressable accessibilityRole="button"
              accessibilityLabel={`${galleryImage ? "Open image gallery for" : "Preview Generated file"} ${artifactTitle(artifact)}`}
              disabled={!connected || filesBusy}
              onPress={() => galleryImage
                ? openGallery(source)
                : openPreview(source, () => client.previewArtifact(artifact))}
              style={[styles.fileRow, styles.fileRowMain, { backgroundColor: colors.surface, borderColor: colors.border },
                (!connected || filesBusy) && styles.disabled]}>
              <Text style={styles.fileGlyph}>{galleryImage ? "▧" : model ? "⬡" : "◆"}</Text>
              <View style={styles.fill}><Text style={[styles.label, { color: colors.ink }]} numberOfLines={1}>{artifactTitle(artifact)}</Text>
                <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>
                  {artifact.blob ? `${artifact.blob.mediaType || "application/octet-stream"} · ${formatByteSize(artifact.blob.byteSize)}` : "Blob unavailable"}
                </Text></View>
              <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
            </Pressable>
            <Action label="Add" accessibilityLabel={`Add Generated file ${artifactTitle(artifact)} to composer`}
              compact colors={colors} disabled={!connected || filesBusy}
              onPress={() => addToComposer(source)} />
          </View>})}
        </> : <>
          <View style={styles.sectionHeader}>
            <Text style={[styles.section, { color: colors.muted }]}>{files.location.path || "Workspace root"}</Text>
            {files.location.path && <Action label="Up" compact colors={colors} disabled={!connected || filesBusy}
              onPress={() => run(() => client.openFilesDirectory(workspaceParentPath(files.location.kind === "workspace" ? files.location.path : "")))} />}
          </View>
          {files.entries.length === 0 && <Text style={[styles.description, { color: colors.muted }]}>This directory is empty.</Text>}
          {files.entries.map((entry) => {
            const label = entry.displayName || workspaceBasename(entry.relativePath);
            const galleryImage = entry.kind === FileKind.REGULAR
              && mobileImageGalleryMediaType(entry.mediaType) !== undefined;
            const model = entry.kind === FileKind.REGULAR
              && mobileModelPreviewKind(entry.mediaType, entry.relativePath) !== undefined;
            const source = { kind: "workspace-entry" as const, entry };
            return <View key={entry.relativePath} style={styles.fileActionRow}>
              <Pressable accessibilityRole="button"
                accessibilityLabel={`${entry.kind === FileKind.DIRECTORY ? "Open directory" : galleryImage ? "Open image gallery for" : "Preview file"} ${label}`}
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
                    {entry.kind === FileKind.DIRECTORY ? "Directory" : `${entry.mediaType || "application/octet-stream"} · ${formatByteSize(entry.revision?.byteSize ?? 0n)}`}
                    {entry.hidden ? " · hidden" : ""}{entry.ignored ? " · ignored" : ""}
                  </Text>
                </View>
                <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
              </Pressable>
              <Action label="Add" accessibilityLabel={`Add ${entry.kind === FileKind.DIRECTORY ? "directory" : "file"} ${label} to composer`}
                compact colors={colors} disabled={!connected || filesBusy}
                onPress={() => addToComposer(source)} />
            </View>;
          })}
        </>}
      </ScrollView>}
    <FilePreviewModal colors={colors} preview={files.preview} source={previewSource} busy={handoffBusy}
      onAdd={addToComposer} onOpenImage={openGallery} onClose={() => {
        setPreviewSource(undefined);
        client.closeFilesPreview();
      }} />
    {imageGallery.view && <MobileImageLightbox key={imageGallery.view.session.leaseId}
      session={imageGallery.view.session}
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
          if (!view) throw new Error("The image gallery closed before output started.");
          const message = await performMobileImageOutput(view.session, action, decoded, rendered, signal);
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

function FileSearchResultRow({ result, colors, disabled, onPress, onAdd }: {
  result: MobileFileSearchResult; colors: Colors; disabled: boolean; onPress: () => void; onAdd: () => void;
}) {
  const path = result.kind === "artifact" ? artifactTitle(result.artifact)
    : result.kind === "workspace-content" ? result.match.relativePath : result.relativePath;
  const detail = result.kind === "artifact"
    ? `Generated · ${result.artifact.blob?.mediaType || "application/octet-stream"}`
    : result.kind === "workspace-content"
      ? result.match.linePreview || "Content match"
      : "Workspace file";
  return <View style={styles.fileActionRow}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Preview ${path}`} disabled={disabled} onPress={onPress}
      style={[styles.fileRow, styles.fileRowMain, { backgroundColor: colors.surface, borderColor: colors.border }, disabled && styles.disabled]}>
      <Text style={styles.fileGlyph}>{result.kind === "artifact" ? "◆" : "◇"}</Text>
      <View style={styles.fill}><Text style={[styles.label, { color: colors.ink }]} numberOfLines={1}>{path}</Text>
        <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={2}>{detail}</Text></View>
      <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
    </Pressable>
    <Action label="Add" accessibilityLabel={`Add ${path} to composer`} compact colors={colors}
      disabled={disabled} onPress={onAdd} />
  </View>;
}

function FilePreviewModal({ colors, preview, source, busy, backLabel = "Files",
  loadingLabel = "Loading the exact observed file revision…", onAdd, onOpenImage, onClose }: {
  colors: Colors;
  preview: MobileFilePreview | undefined;
  source?: MobileFilesComposerSource;
  busy: boolean;
  backLabel?: string;
  loadingLabel?: string;
  onAdd?: (source: MobileFilesComposerSource) => void;
  onOpenImage?: (source: MobileFilesComposerSource) => void;
  onClose: () => void;
}) {
  const [mediaStatus, setMediaStatus] = useState<MobileMediaPlayerStatus>();
  const [pdfStatus, setPdfStatus] = useState<MobilePdfViewerStatus>();
  const [modelStatus, setModelStatus] = useState<MobileModelViewerStatus>();
  const mediaLeaseId = preview?.kind === "media" ? preview.leaseId : undefined;
  const pdfLeaseId = preview?.kind === "pdf" ? preview.leaseId : undefined;
  const modelLeaseId = preview?.kind === "model" ? preview.leaseId : undefined;
  useEffect(() => setMediaStatus(undefined), [mediaLeaseId]);
  useEffect(() => setPdfStatus(undefined), [pdfLeaseId]);
  useEffect(() => setModelStatus(undefined), [modelLeaseId]);
  return <Modal visible={preview !== undefined} animationType="slide" onRequestClose={busy ? () => undefined : onClose}>
    <SafeAreaView style={[styles.fill, { backgroundColor: colors.background }]} edges={["top", "bottom", "left", "right"]}>
      {preview && <>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Back onPress={onClose} colors={colors} label={backLabel} disabled={busy} />
          <View style={styles.fill}><Text style={[styles.title, { color: colors.ink }]} numberOfLines={1}>{preview.title}</Text>
            <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>{preview.sourceLabel}</Text></View>
          {source && onOpenImage && preview.kind === "image" && <Action label="Gallery"
            accessibilityLabel={`Open image gallery for ${preview.title}`} compact colors={colors}
            disabled={busy} onPress={() => onOpenImage(source)} />}
          {source && onAdd && <Action label={busy ? "Adding…" : "Add"}
            accessibilityLabel={`Add ${preview.title} to composer`} compact colors={colors}
            disabled={busy || preview.kind === "loading"} onPress={() => onAdd(source)} />}
        </View>
        {busy && <View accessibilityLiveRegion="polite" style={[styles.connectionNotice, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <ActivityIndicator color={colors.accent} />
          <Text style={[styles.caption, styles.fill, { color: colors.muted }]}>Adding the verified item to this task’s composer…</Text>
        </View>}
        <View style={[styles.previewMetadata, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <Text selectable style={[styles.caption, { color: colors.muted }]}>{preview.mediaType} · {formatByteSize(preview.byteSize)}</Text>
          {preview.kind === "text" && <Text style={[styles.caption, { color: colors.muted }]}>
            {preview.languageId || "plain text"} · lines {preview.totalLines} · bytes {preview.startByte.toString(10)}–{preview.endByte.toString(10)}
          </Text>}
          {preview.kind === "media" && <Text accessibilityLiveRegion="polite" style={[styles.caption, { color: mediaStatus?.state === "error" ? colors.negative : colors.muted }]}>
            {formatMobileMediaPlayerStatus(mediaStatus, preview.mediaKind)}
          </Text>}
          {preview.kind === "pdf" && <Text accessibilityLiveRegion="polite" style={[styles.caption, { color: pdfStatus?.state === "error" ? colors.negative : colors.muted }]}>
            {formatMobilePdfViewerStatus(pdfStatus)}
          </Text>}
          {preview.kind === "model" && <Text accessibilityLiveRegion="polite" style={[styles.caption, { color: modelStatus?.state === "error" ? colors.negative : colors.muted }]}>
            {formatMobileModelViewerStatus(modelStatus)}
          </Text>}
        </View>
        {preview.kind === "loading" ? <Centered label={loadingLabel} colors={colors} />
          : preview.kind === "image" ? <ScrollView style={styles.fill} contentContainerStyle={styles.imagePreviewContainer}>
            <Image source={{ uri: preview.dataUri }} accessibilityLabel={preview.altText} resizeMode="contain" style={styles.imagePreview} />
            {(preview.widthPixels > 0 || preview.heightPixels > 0) && <Text style={[styles.caption, { color: colors.muted }]}>
              {preview.widthPixels} × {preview.heightPixels} pixels
            </Text>}
          </ScrollView>
          : preview.kind === "media" ? <View style={styles.mediaPreviewContainer}>
            <MobileMediaPlayer
              key={preview.leaseId}
              background={colors.background}
              ink={colors.ink}
              instanceId={preview.leaseId}
              kind={preview.mediaKind}
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
              muted={colors.muted}
              onStatusChange={setModelStatus}
              style={styles.modelPreview}
              surface={colors.surface}
              title={preview.title}
            />
          </View>
          : preview.kind === "text" ? <ScrollView style={styles.fill} contentContainerStyle={styles.textPreviewContainer}>
            {preview.truncated && <Text accessibilityRole="alert" style={[styles.warning, { color: colors.negative }]}>Preview is truncated to the authenticated byte window shown above.</Text>}
            <Text selectable style={[styles.textPreview, { color: colors.ink }]}>{preview.text || "(empty file)"}</Text>
          </ScrollView>
          : <View style={styles.previewMessage}>
            <Text accessibilityRole="alert" style={[styles.label, { color: preview.kind === "error" ? colors.negative : colors.ink }]}>
              {preview.kind === "error" ? "Preview unavailable" : "No in-app preview"}
            </Text>
            <Text selectable style={[styles.description, { color: colors.muted }]}>{preview.reason}</Text>
          </View>}
      </>}
    </SafeAreaView>
  </Modal>;
}

function formatMobilePdfViewerStatus(status: MobilePdfViewerStatus | undefined): string {
  if (!status) return "Verified PDF · preparing offline renderer";
  if (status.state === "error") return status.error || "PDF preview failed";
  if (status.state === "ready") return "Offline renderer ready";
  if (status.state === "receiving") return "Transferring verified PDF";
  if (status.state === "document") return `${status.pageCount} ${status.pageCount === 1 ? "page" : "pages"} · ${status.zoomPercent}%`;
  if (status.state === "complete") return `All ${status.pageCount} pages rendered · ${status.zoomPercent}%`;
  return `${status.renderedPages} of ${status.pageCount} pages rendered · ${status.zoomPercent}%`;
}

function formatMobileModelViewerStatus(status: MobileModelViewerStatus | undefined): string {
  if (!status) return "Verified 3D model · preparing offline renderer";
  if (status.state === "error") return status.error || "3D model preview failed";
  if (status.state === "ready") return "Offline 3D renderer ready";
  if (status.state === "receiving") return "Transferring verified model package";
  if (status.state === "loading") return `Loading ${status.fileCount} verified model file${status.fileCount === 1 ? "" : "s"}`;
  return `Interactive 3D model ready · ${status.fileCount} verified file${status.fileCount === 1 ? "" : "s"}`;
}

function formatMobileMediaPlayerStatus(
  status: MobileMediaPlayerStatus | undefined,
  kind: "audio" | "video"
): string {
  if (!status) return `Verified ${kind} · ready to load`;
  if (status.state === "error") return status.error || `${kind === "video" ? "Video" : "Audio"} playback failed`;
  const current = status.currentTime === null ? undefined : formatMediaTime(status.currentTime);
  const duration = status.duration === null ? undefined : formatMediaTime(status.duration);
  const progress = current && duration ? ` · ${current} / ${duration}` : current ? ` · ${current}` : "";
  const label = status.state === "ready" ? "Ready" : status.state === "playing" ? "Playing"
    : status.state === "paused" ? "Paused" : status.state === "waiting" ? "Buffering"
      : status.state === "ended" ? "Finished" : "Unavailable";
  return `${label}${progress}`;
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

function TaskListDrawer({ colors, state, closeButtonRef, onClose, onSelect, onNew, onHome }: ScreenProps & {
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
    messageSessionIds: currentMessageIds
  }).map((section) => ({ ...section, data: section.items })), [currentMessageIds, search, state.owner, statusFilter]);
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
      <View style={styles.fill}><Text style={[styles.title, { color: colors.ink }]}>Tasks</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>Switch without leaving this task screen</Text></View>
      <Pressable ref={closeButtonRef} accessibilityRole="button" accessibilityLabel="Close task list" onPress={onClose} style={styles.drawerClose}>
        <Text style={[styles.headerIcon, { color: colors.ink }]}>×</Text>
      </Pressable>
    </View>
    <Action label="New task" onPress={onNew} colors={colors} disabled={state.status !== "connected"} />
    <View style={styles.searchRow}>
      <TextInput accessibilityLabel="Search tasks and messages" placeholder="Search tasks and messages" placeholderTextColor={colors.muted}
        value={search} onChangeText={setSearch} style={[styles.input, styles.searchInput,
          { color: colors.ink, backgroundColor: colors.background, borderColor: colors.border }]} />
      {state.homeSearchStatus === "searching" && normalizedSearch && <ActivityIndicator color={colors.accent} />}
    </View>
    <View accessibilityRole="tablist" style={styles.filterRow}>
      {(["active", "archived", "all"] as const).map((filter) => <Pressable key={filter} accessibilityRole="tab"
        accessibilityState={{ selected: filter === statusFilter }} onPress={() => setStatusFilter(filter)}
        style={[styles.filterChip, { borderColor: filter === statusFilter ? colors.accent : colors.border,
          backgroundColor: filter === statusFilter ? colors.brandBackground : colors.background }]}>
        <Text style={[styles.caption, { color: colors.ink }]}>{filter[0]!.toUpperCase() + filter.slice(1)}</Text>
      </Pressable>)}
    </View>
    {state.homeSearchError && normalizedSearch && <Banner text={state.homeSearchError} colors={colors} />}
    <SectionList sections={sections} keyExtractor={(item) => item.session.sessionId} style={styles.fill}
      renderSectionHeader={({ section }) => <Text style={[styles.listSectionTitle, { color: colors.muted }]}>{section.title}</Text>}
      ListEmptyComponent={<Text style={[styles.description, styles.drawerEmpty, { color: colors.muted }]}>No matching tasks</Text>}
      renderItem={({ item }) => <Pressable accessibilityRole="button"
        accessibilityState={{ selected: item.session.sessionId === state.selectedId }}
        accessibilityLabel={`Open task ${item.session.displayName || "Untitled"}`} onPress={() => onSelect(item.session.sessionId)}
        style={[styles.drawerTaskRow, { borderColor: item.session.sessionId === state.selectedId ? colors.accent : colors.border,
          backgroundColor: colors.background }]}>
        <Text style={[styles.label, { color: colors.ink }]} numberOfLines={1}>{item.session.displayName || "Untitled task"}</Text>
        <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>{item.targetName} · {sessionState(item.session.state)}</Text>
      </Pressable>}
      contentContainerStyle={styles.drawerList} />
    <Pressable accessibilityRole="button" accessibilityLabel="Go to Home" onPress={onHome}
      style={[styles.drawerHome, { borderColor: colors.border }]}>
      <Text style={[styles.label, { color: colors.accent }]}>Home</Text>
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

function MobileComposerAtomChips({ atoms, colors, disabled, onOpen }: {
  readonly atoms: readonly MobileComposerAtom[];
  readonly colors: Colors;
  readonly disabled: boolean;
  readonly onOpen: (atomId: string) => void;
}) {
  if (atoms.length === 0) return null;
  return <ScrollView horizontal keyboardShouldPersistTaps="handled"
    accessibilityLabel="Structured message items" contentContainerStyle={styles.mentionChips}
    showsHorizontalScrollIndicator={false}>
    {atoms.map((atom) => <Pressable key={atom.atomId} accessibilityRole="button"
      accessibilityLabel={`${atom.kind === "quote" ? "View quote" : atom.kind === "route-reference" ? `View ${atom.routeKind === "project" ? "project link" : atom.routeKind === "path" ? "Workspace path" : "task link"}` : "Edit pasted text"}: ${mobileComposerAtomLabel(atom)}`}
      accessibilityHint="Opens this exact structured message item; it is removed as one unit if edited in the text field"
      accessibilityState={{ disabled }} disabled={disabled} onPress={() => onOpen(atom.atomId)}
      style={[styles.mentionChip, { borderColor: colors.border, backgroundColor: colors.brandBackground },
        disabled && styles.disabled]}>
      <Text style={[styles.mentionChipText, { color: colors.ink }]} numberOfLines={1}>
        {mobileComposerAtomLabel(atom)} · {atom.kind === "pasted-text" ? "Edit" : "View"}
      </Text>
    </Pressable>)}
  </ScrollView>;
}

function MobileAttachmentTray({ attachments, colors, disabled, busy, pendingCount = 0, onPreview, onRemove }: {
  attachments: readonly MobileComposerAttachment[];
  colors: Colors;
  disabled: boolean;
  busy: boolean;
  pendingCount?: number;
  onPreview: (attachmentId: string) => void;
  onRemove: (attachmentId: string) => void;
}) {
  if (attachments.length === 0 && pendingCount === 0) return null;
  return <View accessibilityLabel="Attachments" style={styles.attachmentTray}>
    {pendingCount > 0 && <View accessible accessibilityLiveRegion="polite"
      accessibilityLabel={`Adding ${pendingCount} pasted ${pendingCount === 1 ? "image" : "images"}`}
      style={[styles.attachmentChip, { borderColor: colors.border, backgroundColor: colors.brandBackground }]}>
      <ActivityIndicator color={colors.accent} size="small" />
      <View style={styles.fill}>
        <Text style={[styles.attachmentName, { color: colors.ink }]} numberOfLines={1}>
          Adding {pendingCount} pasted {pendingCount === 1 ? "image" : "images"}…
        </Text>
        <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>
          Verifying and saving the complete clipboard batch
        </Text>
      </View>
    </View>}
    {attachments.map((attachment) => <View key={attachment.attachmentId}
      style={[styles.attachmentChip, { borderColor: colors.border, backgroundColor: colors.brandBackground }]}>
      <View style={styles.fill}>
        <Text style={[styles.attachmentName, { color: colors.ink }]} numberOfLines={1}>{attachment.fileName}</Text>
        <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>
          {attachment.kind === "image" ? "Image" : "File"} · {formatMobileAttachmentBytes(attachment.byteSize)}
          {attachment.state === "uploaded" ? " · Uploaded" : " · Ready"}
        </Text>
      </View>
      {busy && attachment.state === "local" && <ActivityIndicator color={colors.accent} size="small" />}
      {attachment.kind === "image" && <Pressable accessibilityRole="button"
        accessibilityLabel={`Preview image ${attachment.fileName}`}
        accessibilityHint="Opens the full-screen image viewer and annotation tools" disabled={disabled}
        onPress={() => onPreview(attachment.attachmentId)}
        style={[styles.attachmentPreview, disabled && styles.disabled]}>
        <Text style={[styles.attachmentPreviewText, { color: colors.accent }]}>Preview</Text>
      </Pressable>}
      <Pressable accessibilityRole="button" accessibilityLabel={`Remove attachment ${attachment.fileName}`}
        accessibilityHint="Removes this exact attachment from the draft" disabled={disabled}
        onPress={() => onRemove(attachment.attachmentId)} style={[styles.attachmentRemove, disabled && styles.disabled]}>
        <Text style={[styles.attachmentRemoveText, { color: colors.muted }]}>×</Text>
      </Pressable>
    </View>)}
  </View>;
}

function useMobileVoicePermissionSettings(error?: MobileVoiceRunError): void {
  useEffect(() => {
    if (error?.code !== "permissionBlocked") return;
    Alert.alert(
      "Allow microphone access",
      "Voice input needs microphone access. Open system settings and allow microphone access for Joko.",
      [
        { text: "Not now", style: "cancel" },
        { text: "Open Settings", onPress: () => {
          void Linking.openSettings().catch(() => {
            Alert.alert("Settings unavailable", "Open your device settings and allow microphone access for Joko.");
          });
        } }
      ]
    );
  }, [error]);
}

function MobileVoiceAction({ voice, colors, disabled }: {
  voice: MobileVoiceInputBinding;
  colors: Colors;
  disabled?: boolean;
}) {
  const longPressRef = useRef(false);
  const recording = voice.state === "starting" || voice.state === "listening";
  const submitting = voice.state === "submitting";
  const controlDisabled = voice.checking || submitting || !voice.busy && disabled === true;
  const label = submitting ? "Transcribing…" : recording ? voice.elapsedLabel ?? "0:00" : voice.checking ? "Checking voice…" : "Voice";
  return <View style={styles.voiceControls}>
    <Pressable accessibilityRole="button" accessibilityLabel={recording ? `Stop voice input, recording ${label}` : label}
      accessibilityHint="Tap to start or stop. Touch and hold to record until release."
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
    {voice.busy && <Action label="Cancel voice input" colors={colors} compact danger onPress={() => void voice.cancel()} />}
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

function Back({ onPress, colors, label = "Tasks", disabled }: {
  onPress: () => void; colors: Colors; label?: string; disabled?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`Back to ${label.toLocaleLowerCase()}`}
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
function AutomaticEntryChoice({ checked, disabled, onPress, colors }: {
  checked: boolean; disabled: boolean; onPress: () => void; colors: Colors;
}) {
  return <Pressable accessibilityRole="checkbox" accessibilityState={{ checked, disabled }}
    accessibilityLabel="Remember this node and enter it automatically next time"
    disabled={disabled} onPress={onPress} style={[styles.choice, disabled && styles.disabled]}>
    <View style={[styles.choiceBox, { borderColor: checked ? colors.accent : colors.border, backgroundColor: checked ? colors.accent : colors.surface }]}>
      {checked && <Text style={styles.choiceCheck}>✓</Text>}
    </View>
    <View style={styles.fill}>
      <Text style={[styles.label, { color: colors.ink }]}>Enter this node automatically next time</Text>
      <Text style={[styles.caption, { color: colors.muted }]}>Off by default on mobile. The saved credential remains available when this is off.</Text>
    </View>
  </Pressable>;
}

function Banner({ text, colors }: { text: string; colors: Colors }) {
  return <Text accessibilityRole="alert" style={[styles.warning, { color: colors.negative }]}>{text}</Text>;
}
function Notice({ text, colors, onDismiss }: { text: string; colors: Colors; onDismiss: () => void }) {
  return <View accessibilityLiveRegion="polite"
    style={[styles.connectionNotice, { backgroundColor: colors.brandBackground, borderColor: colors.accent }]}>
    <Text style={[styles.caption, styles.fill, { color: colors.ink }]}>{text}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Dismiss image output notice" onPress={onDismiss}
      style={styles.inlineTouchAction}><Text style={[styles.caption, { color: colors.accent }]}>Dismiss</Text></Pressable>
  </View>;
}
function Centered({ label, colors }: { label: string; colors: Colors }) {
  return <View style={styles.center}><ActivityIndicator color={colors.accent} /><Text style={[styles.description, { color: colors.muted }]}>{label}</Text></View>;
}
function StartupLoading({ colors, dark }: { colors: Colors; dark: boolean }) {
  return <View accessibilityRole="progressbar" accessibilityLabel="Loading Joko" style={styles.startupLoading}>
    <View style={styles.loadingArtwork} accessible={false}>
      <SvgXml xml={mobileLoadingIllustration(dark ? "dark" : "light")} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" />
    </View>
    <Text style={[styles.description, { color: colors.muted }]}>Loading Joko…</Text>
  </View>;
}
function focusNative(ref: RefObject<View | null>): void {
  const node = ref.current ? findNodeHandle(ref.current) : null;
  if (node !== null) setTimeout(() => AccessibilityInfo.setAccessibilityFocus(node), 0);
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : "The Joko node is unavailable."; }

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
function savedStatus(profile: SavedMobileConnection): string {
  switch (profile.credentialState) {
    case "checking": return "Checking identity and protected credential…";
    case "available": return "Ready on this device";
    case "missing": return "Protected credential is missing";
    case "unreadable": return "Protected credential is damaged";
    case "unavailable": return "Protected storage is unavailable";
    case "identity-conflict": return "Address now identifies a different node";
    case "offline": return "Node could not be reached";
    default: return "Not checked yet";
  }
}
function connectionStateLabel(value: ConnectionState): string {
  switch (value) {
    case ConnectionState.PAIRING: return "Pairing";
    case ConnectionState.CONNECTED: return "Connected";
    case ConnectionState.DISCONNECTED: return "Disconnected";
    case ConnectionState.REVOKED: return "Revoked";
    case ConnectionState.LOGGED_OUT: return "Logged out";
    default: return "Unknown";
  }
}
function deviceKindLabel(value: DeviceKind): string {
  switch (value) {
    case DeviceKind.WEB: return "Web";
    case DeviceKind.DESKTOP: return "Desktop";
    case DeviceKind.SERVICE: return "Service";
    case DeviceKind.MOBILE: return "Mobile";
    default: return "Unknown";
  }
}
function deviceStatusLabel(revoked: boolean, presence: DevicePresenceState): string {
  if (revoked) return "Revoked";
  if (presence === DevicePresenceState.ONLINE) return "Online";
  if (presence === DevicePresenceState.OFFLINE) return "Offline";
  return "Unknown";
}
function timestampLabel(value: { readonly seconds: bigint; readonly nanos: number } | undefined): string {
  if (value === undefined) return "Never";
  const milliseconds = Number(value.seconds) * 1_000 + value.nanos / 1_000_000;
  if (!Number.isFinite(milliseconds)) return "Unknown";
  return new Date(milliseconds).toLocaleString();
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
function sessionState(value: number): string { return ["Unknown", "Creating", "Idle", "Running", "Waiting", "Detached", "Recovering", "Archived", "Closing", "Closed", "Error"][value] || "Unknown"; }
function queueState(value: QueueItemState): string {
  switch (value) {
    case QueueItemState.ACCEPTED: return "Queued";
    case QueueItemState.DISPATCHING: return "Dispatching";
    case QueueItemState.BACKEND_ACCEPTED: return "Backend accepted";
    case QueueItemState.DISPATCH_UNKNOWN: return "Delivery unknown";
    case QueueItemState.COMPLETED: return "Completed";
    case QueueItemState.CANCELLED: return "Cancelled";
    case QueueItemState.FAILED: return "Failed";
    default: return "Unknown";
  }
}

function queueItemSummary(item: QueueItem): string {
  return mobileInputSummary(item.input).trim() || "[Queued input]";
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
  filesTabs: { paddingHorizontal: 16, paddingVertical: 8, flexDirection: "row", gap: 8 },
  filesSearchControls: { minHeight: 52, paddingHorizontal: 16, paddingTop: 4, flexDirection: "row", alignItems: "center", gap: 10 },
  filesSearchOptions: { paddingHorizontal: 16, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 12 },
  filesSearchModes: { flex: 1, flexDirection: "row", gap: 6 },
  caseChoice: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 7 },
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
