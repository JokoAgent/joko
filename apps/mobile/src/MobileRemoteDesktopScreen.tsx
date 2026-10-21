import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, Appearance, BackHandler, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { WebView } from "react-native-webview";
import Svg, { Path } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { RemoteDesktopPermissionStatus } from "@joko/contracts";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import {
  MobileRemoteDesktopController,
  type MobileRemoteDesktopSnapshot,
  type MobileRemoteDesktopInputMode,
  type MobileRemoteDesktopTransport
} from "./remote-desktop-controller";
import {
  mobileRemoteDesktopClipboardNoticeLabel,
  mobileRemoteDesktopCopy,
  mobileRemoteDesktopCredentialCopy,
  mobileRemoteDesktopNoticeLabel,
  mobileRemoteDesktopStatusLabel
} from "./remote-desktop-presentation";
import { mobileRemoteClipboardSystem } from "./mobile-remote-desktop-clipboard-native";
import {
  createMobileRemoteDesktopVideoPreferenceStore,
  type MobileRemoteDesktopVideoSettings
} from "./mobile-remote-desktop-video-preference";
import { remoteDesktopViewerCommand, remoteDesktopViewerHtml } from "./remote-desktop-viewer";
import { remotePresentation } from "../modules/joko-remote-presentation/src/index";
import { createMobileRemoteDesktopHostMutePreferenceStore } from "./mobile-remote-desktop-host-mute-preference";
import { createMobileRemoteDesktopLockPreferenceStore } from "./mobile-remote-desktop-lock-preference";
import { createMobileRemoteDesktopClipboardSyncPreferenceStore } from "./mobile-remote-desktop-clipboard-sync-preference";
import { createMobileRemoteDesktopPrivacyPreferenceStore } from "./mobile-remote-desktop-privacy-preference";
import { createMobileRemoteDesktopCredentialsNative } from "./mobile-remote-desktop-credentials-native";
import { supportedCredentialHost } from "./mobile-remote-desktop-credentials";
import { MobileRemoteDesktopSystemActions } from "./MobileRemoteDesktopSystemActions";
import { MobileRemoteDesktopKeyboardPanel, MobileRemoteDesktopShortcutTools } from "./MobileRemoteDesktopKeyboardPanel";
import { mobileRemoteDesktopShortcuts } from "./remote-desktop-keyboard";
import { MobileKeyboardAvoidingView, useMobileKeyboardState } from "./MobileKeyboardAvoidingView";
import { MobileNativeRemoteDesktopView } from "./MobileNativeRemoteDesktopView";
import { dispatchMobileRemoteDesktopNativeCommand, parseMobileRemoteDesktopNativeCommand,
  sendMobileRemoteDesktopNativeInput, sendMobileRemoteDesktopNativeRequest, type MobileRemoteDesktopNativeHandle } from "./remote-desktop-native-bridge";
import { MobileRemoteDesktopPipPreferenceStore } from "./mobile-remote-desktop-pip-preference";
import { MobileRemoteDesktopNativeTools, MobileRemoteDesktopNetworkStatus } from "./MobileRemoteDesktopNativeTools";
import type { MobileAppLifecycleTransition } from "./mobile-app-lifecycle";
import { createInputModePreferenceStore, createMouseButtonsPreferenceStore } from "./mobile-remote-desktop-input-preference";
import { MobileRemoteDesktopMouseControls } from "./MobileRemoteDesktopMouseControls";
import { MobileRemoteDesktopFoldTouchpad } from "./MobileRemoteDesktopFoldTouchpad";
import { mobileRemoteDesktopFoldLayout, mobileRemoteDesktopLocalGeometry } from "./mobile-remote-desktop-fold-layout";
import { useMobileAdaptiveWindow } from "./MobileAdaptiveWindow";
import { avoidReservedRegions, keyboardControlRegion, safeWindowRect, windowDivision, type MobileLayoutRect } from "./mobile-window-geometry";
import { MobileRemoteDesktopDisplaySelector, MobileRemoteDesktopPanel, MobileRemoteDesktopToolbar,
  type MobileRemoteDesktopPanelProps, type MobileRemoteDesktopToolbarAction } from "./MobileRemoteDesktopChrome";
import { MobileRemoteDesktopPermissionGuide } from "./MobileRemoteDesktopPermissionGuide";

export type MobileRemoteDesktopLifecycleHandler = (transition: MobileAppLifecycleTransition) => void;
type RegisterLifecycle = (handler: MobileRemoteDesktopLifecycleHandler) => () => void;

export interface MobileRemoteDesktopColors {
  readonly dark?: boolean;
  readonly background: string;
  readonly surface: string;
  readonly ink: string;
  readonly muted: string;
  readonly border: string;
  readonly accent: string;
  readonly negative: string;
}

export function MobileRemoteDesktopScreen({ transport, preferredDeviceId, routeFocused, interactive, foreground, online, colors, locale, onClose, onRestore, onEnded, registerLifecycle }: {
  readonly transport?: MobileRemoteDesktopTransport;
  readonly preferredDeviceId?: string;
  readonly routeFocused: boolean;
  readonly interactive: boolean;
  readonly foreground: boolean;
  readonly online: boolean;
  readonly colors: MobileRemoteDesktopColors;
  readonly locale: MobileSupportedLocale;
  readonly onClose: (retained: boolean) => void;
  readonly onRestore: () => void;
  readonly onEnded: () => void;
  readonly registerLifecycle?: RegisterLifecycle;
}) {
  const copy = mobileRemoteDesktopCopy(locale);
  if (!transport) return <Unavailable colors={colors} title={copy.title} message={copy.revoked}
    back={copy.back} onClose={() => onClose(false)} />;
  return <RemoteDesktopSession key={`${transport.ownerKey}/${preferredDeviceId ?? "picker"}`}
    transport={transport} preferredDeviceId={preferredDeviceId} interactive={interactive}
    foreground={foreground} online={online} routeFocused={routeFocused}
    colors={colors} locale={locale} onClose={onClose} onRestore={onRestore} onEnded={onEnded} registerLifecycle={registerLifecycle} />;
}

function RemoteDesktopSession({ transport, preferredDeviceId, routeFocused, interactive, foreground, online, colors, locale, onClose, onRestore, onEnded, registerLifecycle }: {
  readonly transport: MobileRemoteDesktopTransport;
  readonly preferredDeviceId?: string;
  readonly routeFocused: boolean;
  readonly interactive: boolean;
  readonly foreground: boolean;
  readonly online: boolean;
  readonly colors: MobileRemoteDesktopColors;
  readonly locale: MobileSupportedLocale;
  readonly onClose: (retained: boolean) => void;
  readonly onRestore: () => void;
  readonly onEnded: () => void;
  readonly registerLifecycle?: RegisterLifecycle;
}) {
  const keyboard = useMobileKeyboardState(), safeArea = useSafeAreaInsets();
  const dimensions = useWindowDimensions(), landscape = dimensions.width > dimensions.height;
  const observedGeometry = useMobileAdaptiveWindow();
  const layoutContainer = useRef<View>(null);
  const measurement = useRef(0);
  const [containerRect, setContainerRect] = useState<MobileLayoutRect | null>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  const [toolbarHeight, setToolbarHeight] = useState(56);
  const [panelPage, setPanelPage] = useState<"controls" | "display" | "security" | "permissions" | null>(null);
  const operations = panelPage !== null;
  const nativeView = useRef<MobileRemoteDesktopNativeHandle | null>(null);
  const backgroundPreferences = useMemo(() => new MobileRemoteDesktopPipPreferenceStore(AsyncStorage), []);
  const backgroundPreference = useSyncExternalStore(backgroundPreferences.subscribe, () => backgroundPreferences.snapshot);
  const inputModePreferences = useMemo(() => createInputModePreferenceStore(AsyncStorage), []);
  const mouseButtonsPreferences = useMemo(() => createMouseButtonsPreferenceStore(AsyncStorage), []);
  const inputModePreference = useSyncExternalStore(inputModePreferences.subscribe, () => inputModePreferences.snapshot);
  const mouseButtonsPreference = useSyncExternalStore(mouseButtonsPreferences.subscribe, () => mouseButtonsPreferences.snapshot);
  const inputModeEdited = useRef(false);
  const [rotation, setRotation] = useState<"idle" | "pending" | "failed">("idle");
  const copy = mobileRemoteDesktopCopy(locale);
  const videoPreferences = useMemo(() => createMobileRemoteDesktopVideoPreferenceStore(), []);
  const hostMutePreferences = useMemo(() => createMobileRemoteDesktopHostMutePreferenceStore(AsyncStorage), []);
  const lockPreferences = useMemo(() => createMobileRemoteDesktopLockPreferenceStore(AsyncStorage), []);
  const clipboardSyncPreferences = useMemo(() => createMobileRemoteDesktopClipboardSyncPreferenceStore(AsyncStorage), []);
  const privacyPreferences = useMemo(() => createMobileRemoteDesktopPrivacyPreferenceStore(AsyncStorage), []);
  const nativeCredentials = useMemo(() => createMobileRemoteDesktopCredentialsNative(), []);
  const credentialLocale = useRef(locale); credentialLocale.current = locale;
  const credentialEnvironment = useMemo(() => ({ native: nativeCredentials, locale: () => credentialLocale.current,
    theme: (): "light" | "dark" => Appearance.getColorScheme() === "dark" ? "dark" : "light" }), [nativeCredentials]);
  const videoPreference = useSyncExternalStore(videoPreferences.subscribe, () => videoPreferences.snapshot);
  const videoPreferenceLoaded = videoPreference.status !== "loading";
  const nativePresentation = useMemo(() => ({
    nativeVideo: MobileNativeRemoteDesktopView !== null,
    nativePictureInPicture: MobileNativeRemoteDesktopView !== null,
    sendInput: async (batch: Parameters<MobileRemoteDesktopNativeHandle["sendInput"]>[0]) => {
      const handle = nativeView.current;
      return handle ? sendMobileRemoteDesktopNativeInput(handle, batch) : false;
    },
    sendRequest: async (request: Parameters<NonNullable<MobileRemoteDesktopNativeHandle["sendRequest"]>>[0]) => {
      const handle = nativeView.current;
      return handle ? sendMobileRemoteDesktopNativeRequest(handle, request) : false;
    },
    requiresPlaybackSession: Platform.OS === "ios",
    playback: async (enabled: boolean) => {
      if (Platform.OS !== "ios") return;
      if (!remotePresentation?.playback) throw new Error("Native Remote Desktop playback is unavailable.");
      await remotePresentation.playback(enabled);
    }
  }), []);
  const controller = useMemo(() => new MobileRemoteDesktopController(
    transport, preferredDeviceId, mobileRemoteClipboardSystem, nativePresentation, hostMutePreferences, lockPreferences, clipboardSyncPreferences, privacyPreferences, credentialEnvironment
  ),
    [transport.ownerKey, preferredDeviceId, nativePresentation, hostMutePreferences, lockPreferences, clipboardSyncPreferences, privacyPreferences, credentialEnvironment]);
  const snapshot = useSyncExternalStore(controller.subscribe, () => controller.snapshot);
  const permissionGuideVisible = snapshot.status === "permission" || panelPage === "permissions";
  useEffect(() => {
    controller.setPermissionGuideVisible(permissionGuideVisible);
    return () => controller.setPermissionGuideVisible(false);
  }, [controller, permissionGuideVisible]);
  const securityCopy = mobileRemoteDesktopCredentialCopy(locale);
  useEffect(() => {
    if (snapshot.credentials.explicitFailure && snapshot.credentials.notice && !snapshot.credentials.busy) {
      Alert.alert(securityCopy.autoUnlock, securityCopy[snapshot.credentials.notice]);
    }
  }, [snapshot.credentials, securityCopy]);
  const webView = useRef<WebView>(null);
  const viewerViewport = useRef({ width: 0, height: 0 });
  const html = useMemo(() => remoteDesktopViewerHtml(colors.background, colors.ink, nativePresentation.nativeVideo),
    [colors.background, colors.ink, nativePresentation]);
  useEffect(() => {
    controller.setViewerSink((message) => {
      if (nativePresentation.nativeVideo) {
        const nativeMessage = message.type === "init" ? Object.fromEntries(Object.entries(message).filter(([key]) => key !== "nativeVideo")) : message;
        const command = parseMobileRemoteDesktopNativeCommand(nativeMessage);
        const handle = nativeView.current;
        void dispatchMobileRemoteDesktopNativeCommand(handle, message).catch(() => {
          if (command) controller.nativeCommandFailed(command);
        });
      }
      webView.current?.injectJavaScript(remoteDesktopViewerCommand(message));
    });
    return () => controller.setViewerSink(() => undefined);
  }, [controller, nativePresentation]);
  useEffect(() => { void backgroundPreferences.hydrate(); }, [backgroundPreferences]);
  useEffect(() => { controller.setBackgroundViewing(backgroundPreference.enabled); }, [controller, backgroundPreference.enabled]);
  useEffect(() => { void inputModePreferences.hydrate(); void mouseButtonsPreferences.hydrate(); }, [inputModePreferences, mouseButtonsPreferences]);
  useEffect(() => {
    if (!inputModeEdited.current && inputModePreference.status === "ready") controller.setInputMode(inputModePreference.value);
  }, [controller, inputModePreference.status, inputModePreference.value]);
  useEffect(() => {
    controller.configureMouseControls(mouseButtonsPreference.value && !operations, MobileRemoteDesktopMouseControls !== null,
      { left: copy.leftMouseButton, right: copy.rightMouseButton, wheel: copy.mouseWheel });
  }, [controller, mouseButtonsPreference.value, copy, operations]);
  useEffect(() => registerLifecycle?.(transition => {
    if (transition.interactive && transition.transportForeground !== undefined) controller.setForeground(transition.transportForeground);
    controller.setInteractive(transition.interactive && routeFocused);
    if (!transition.interactive && transition.transportForeground !== undefined) controller.setForeground(transition.transportForeground);
  }), [controller, registerLifecycle, routeFocused]);
  useEffect(() => {
    void videoPreferences.hydrate();
  }, [videoPreferences]);
  useEffect(() => {
    controller.updateVideoSettings(videoPreference.settings);
  }, [controller, videoPreference.settings]);
  useEffect(() => {
    if (!videoPreferenceLoaded) return;
    void controller.open();
    return () => { void controller.close(); };
  }, [controller, videoPreferenceLoaded]);
  useEffect(() => controller.setRouteFocused(routeFocused), [controller, routeFocused]);
  useEffect(() => controller.setForeground(foreground), [controller, foreground]);
  useEffect(() => controller.setInteractive(interactive), [controller, interactive]);
  useEffect(() => controller.setOnline(online), [controller, online]);
  useEffect(() => {
    if (snapshot.restoreRequest && !routeFocused) onRestore();
  }, [snapshot.restoreRequest, routeFocused, onRestore]);
  const rotationScope = useRef<object | undefined>(undefined);
  useEffect(() => {
    const scope = {}; rotationScope.current = scope; setRotation("idle");
    return () => { if (rotationScope.current === scope) rotationScope.current = undefined; };
  }, [controller, routeFocused, foreground, interactive, online, snapshot.host, snapshot.selectedDisplayId, snapshot.status, snapshot.media]);
  const rotate = (): void => {
    const scope = rotationScope.current;
    if (!scope || rotation === "pending" || !routeFocused || !foreground || !interactive || !online || snapshot.status !== "live") return;
    setRotation("pending");
    const pending = remotePresentation?.rotate?.(!landscape);
    void (pending ?? Promise.reject(new Error("Native rotation unavailable."))).then(
      () => { if (rotationScope.current === scope) setRotation("idle"); },
      () => { if (rotationScope.current === scope) setRotation("failed"); }
    );
  };
  useEffect(() => {
    if (routeFocused) return;
    if (snapshot.exitStatus === "failed") onRestore();
    else if (snapshot.exitStatus === "closed" || (!snapshot.navigationRetained
      && !snapshot.presenting && snapshot.exitStatus === "idle")) onEnded();
  }, [routeFocused, snapshot.exitStatus, snapshot.navigationRetained, snapshot.presenting, onEnded, onRestore]);
  const leave = async (disconnect = false): Promise<void> => {
    const result = await controller.leave(disconnect);
    if (result !== "failed") onClose(result === "retained");
  };
  const back = (): void => {
    if (panelPage && panelPage !== "controls") { setPanelPage("controls"); return; }
    if (panelPage) { setPanelPage(null); return; }
    if (snapshot.keyboardOpen) { controller.closeKeyboard(); return; }
    void leave();
  };
  useEffect(() => {
    if (!routeFocused || !interactive || !foreground) setPanelPage(null);
  }, [routeFocused, interactive, foreground]);
  useEffect(() => {
    if (!routeFocused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      back();
      return true;
    });
    return () => subscription.remove();
  }, [routeFocused, controller, onClose, panelPage, snapshot.keyboardOpen]);
  const exitNotice = snapshot.exitNotice === "lock-expired" ? copy.lockExpired
    : snapshot.exitNotice === "lock-unavailable" ? copy.lockUnavailable
    : snapshot.exitNotice === "lock-failed" ? copy.lockFailed
    : snapshot.exitNotice === "authority-changed" ? copy.revoked : copy.exitFailed;
  const status = snapshot.displaySwitchBusy ? copy.displaySwitching : mobileRemoteDesktopStatusLabel(snapshot, copy);
  const notice = snapshot.displaySwitchNotice === "stop-failed" ? copy.displaySwitchFailed
    : snapshot.displaySwitchNotice === "display-missing" ? copy.displayUnavailable
    : mobileRemoteDesktopNoticeLabel(snapshot.notice, copy);
  const clipboardNotice = snapshot.clipboardBusy
    ? copy.clipboardTransferring
    : mobileRemoteDesktopClipboardNoticeLabel(snapshot.clipboardNotice, copy);
  const syncNotice = snapshot.clipboardSyncNotice === "load-failed" ? copy.clipboardSyncLoadFailed
    : snapshot.clipboardSyncNotice === "save-failed" ? copy.clipboardSyncSaveFailed
    : snapshot.clipboardSyncNotice === "skipped" ? copy.clipboardSyncSkipped
    : snapshot.clipboardSyncNotice === "conflict" ? copy.clipboardSyncConflict
    : snapshot.clipboardSyncNotice === "permission" ? copy.clipboardSyncPermission
    : snapshot.clipboardSyncNotice === "unknown" ? copy.clipboardSyncUnknown
    : snapshot.clipboardSyncNotice === "failed" ? copy.clipboardSyncFailed : undefined;
  const selection = snapshot.status === "select-host" || snapshot.status === "select-display";
  const terminal = ["unsupported", "permission", "revoked", "busy", "stopped", "error"].includes(snapshot.status);
  const localGeometry = useMemo(() => containerRect ? mobileRemoteDesktopLocalGeometry(observedGeometry, containerRect) : null,
    [observedGeometry, containerRect]);
  const keyboardBottom = Platform.OS === "ios" && snapshot.keyboardOpen && snapshot.keyboardMode === "inputMethod" ? keyboard.height : 0;
  const fold = localGeometry ? mobileRemoteDesktopFoldLayout(localGeometry, keyboardBottom, panelHeight, snapshot.keyboardOpen) : null;
  const division = localGeometry && windowDivision(localGeometry);
  const fullScreenFoldBackground = Boolean(fold && division?.axis === "horizontal");
  const systemSideRail = Platform.OS === "ios" && localGeometry !== null && !fold
    && (localGeometry.barEdge !== "none" || (localGeometry.reservedRegionsSupported && localGeometry.regularWidth
      && observedGeometry.width > observedGeometry.height));
  const adaptive = fold !== null || systemSideRail;
  const mediaRect = fold && !fullScreenFoldBackground ? fold.media : localGeometry
    ? { x: 0, y: 0, width: localGeometry.width, height: localGeometry.height } : null;
  const controlsRect = fold?.controls ?? (localGeometry ? keyboardControlRegion(localGeometry, keyboardBottom) : null);
  const railRect = useMemo(() => {
    if (!systemSideRail || !localGeometry) return null;
    const safe = safeWindowRect(localGeometry), width = Math.min(safe.width, Math.max(60, localGeometry.insets.right + 8));
    const statusReservations = localGeometry.regions.filter(region => region.kind === "occlusion" && region.y === 0
      && region.x + region.width >= localGeometry.width);
    const top = Math.max(safe.y, statusReservations.length ? Math.max(...statusReservations.map(region => region.y + region.height))
      : Math.max(0, 120 - (containerRect?.y ?? 0))) + 44 + 16;
    return avoidReservedRegions({ x: safe.x + safe.width - width, y: top, width,
      height: Math.max(0, safe.y + safe.height - top) }, localGeometry.regions.filter(region => region.kind === "occlusion"));
  }, [systemSideRail, localGeometry, containerRect?.y]);
  const viewportTop = fullScreenFoldBackground ? fold!.media.y : 0;
  const viewportBottom = fullScreenFoldBackground ? Math.max(0, localGeometry!.height - fold!.media.y - fold!.media.height) : 0;
  useEffect(() => {
    controller.configureViewport({ fitToInsets: fullScreenFoldBackground, topInset: viewportTop, bottomInset: viewportBottom });
    if (fold) viewerViewport.current = { width: fold.media.width, height: fold.media.height };
  }, [controller, fullScreenFoldBackground, viewportTop, viewportBottom, fold?.media.width, fold?.media.height]);
  const measureContainer = (): void => {
    const sequence = ++measurement.current;
    layoutContainer.current?.measureInWindow((x, y, width, height) => {
      if (measurement.current !== sequence) return;
      const rect = { x, y, width, height };
      if (!mobileRemoteDesktopLocalGeometry(observedGeometry, rect)) { setContainerRect(null); return; }
      setContainerRect(previous => previous && previous.x === x && previous.y === y && previous.width === width && previous.height === height ? previous : rect);
    });
  };
  useEffect(() => { measureContainer(); return () => { measurement.current += 1; }; },
    [observedGeometry.width, observedGeometry.height, observedGeometry.insets.top, observedGeometry.insets.right,
      observedGeometry.insets.bottom, observedGeometry.insets.left]);
  const interactionReady = snapshot.status === "live" && snapshot.hasFrame && snapshot.controlling
    && routeFocused && interactive && foreground && online && snapshot.exitStatus === "idle";
  const toolbarInputDisabled = !interactionReady || !snapshot.wantedControl || snapshot.displayModeBusy || snapshot.displaySwitchBusy;
  const mouseControlsVisible = snapshot.mouseButtons && snapshot.status === "live" && snapshot.hasFrame && snapshot.controlling
    && routeFocused && interactive && foreground && online && !snapshot.keyboardOpen && !operations && snapshot.exitStatus === "idle";
  const touchpadVisible = fold !== null && snapshot.hasFrame && routeFocused && !snapshot.keyboardOpen && !operations;
  const layoutKey = `${mediaRect?.x}/${mediaRect?.y}/${mediaRect?.width}/${mediaRect?.height}/${controlsRect?.x}/${controlsRect?.y}/${controlsRect?.width}/${controlsRect?.height}`;
  const selectInputMode = (mode: MobileRemoteDesktopInputMode): void => {
    inputModeEdited.current = true;
    controller.setInputMode(mode);
    if (mode !== "pan") void inputModePreferences.update(mode);
  };
  const showOperations = (): void => {
    controller.closeKeyboard(); controller.releaseInput();
    setPanelPage(value => value ? null : "controls");
  };
  const toolbarActions: MobileRemoteDesktopToolbarAction[] = [
    ...(snapshot.capabilities?.workspaceNavigation ? (["workspaceLeft", "workspaceRight"] as const).map(action => ({
      id: action, label: copy[action], icon: <CompactIcon icon={action === "workspaceLeft" ? "left" : "right"} colors={colors} disabled={toolbarInputDisabled} />,
      disabled: toolbarInputDisabled || snapshot.systemActionPending, onPress: () => { void controller.performSystemAction(action); }
    })) : mobileRemoteDesktopShortcuts(snapshot.capabilities).map(shortcut => ({ id: shortcut.id, label: copy[shortcut.labelKey],
      icon: <CompactIcon icon={shortcut.id} colors={colors} disabled={toolbarInputDisabled} />, disabled: toolbarInputDisabled,
      onPress: () => { controller.performKeyboardShortcut(shortcut.id); } }))),
    ...(snapshot.capabilities?.systemMenu ? [{ id: "systemMenu", label: copy.systemMenu,
      icon: <CompactIcon icon="menu" colors={colors} disabled={toolbarInputDisabled} />, disabled: toolbarInputDisabled || snapshot.systemActionPending,
      onPress: () => { void controller.performSystemAction("systemMenu"); } }] : []),
    { id: "keyboard", label: copy.keyboard, icon: <CompactIcon icon="keyboard" colors={colors} disabled={toolbarInputDisabled} />,
      disabled: toolbarInputDisabled, onPress: () => { setPanelPage(null); controller.showKeyboard(); } },
    { id: "settings", label: operations ? copy.closeSettings : copy.settings, icon: <CompactIcon icon="settings" colors={colors} />,
      selected: operations, onPress: showOperations }
  ];
  const ordinaryWidth = localGeometry?.width ?? dimensions.width, ordinaryHeight = localGeometry?.height ?? Math.max(0, dimensions.height - 62);
  const ordinarySafe = localGeometry ? safeWindowRect(localGeometry) : { x: safeArea.left, y: 0,
    width: ordinaryWidth - safeArea.left - safeArea.right, height: ordinaryHeight - safeArea.bottom };
  const panelHeader = <View style={[styles.panelHeader, { borderColor: colors.border, backgroundColor: colors.surface }]}>
    <View style={styles.panelHeaderAction}>{panelPage !== "controls" && <Pressable accessibilityRole="button" accessibilityLabel={copy.panelBack}
      onPress={() => setPanelPage("controls")} style={styles.back}><Text style={[styles.backText, { color: colors.ink }]}>‹</Text></Pressable>}</View>
    <View style={styles.heading}><Text accessibilityRole="header" style={[styles.panelTitle, { color: colors.ink }]}>
      {panelPage === "display" ? copy.displaySettings : panelPage === "security" ? copy.security
        : panelPage === "permissions" ? copy.permissionsTitle : copy.controls}
    </Text><Text numberOfLines={1} style={[styles.panelCaption, { color: colors.muted }]}>{snapshot.host?.displayName} · {status}</Text></View>
    <Pressable accessibilityRole="button" accessibilityLabel={copy.panelClose} onPress={() => setPanelPage(null)} style={styles.back}>
      <Text style={[styles.panelCloseText, { color: colors.ink }]}>×</Text>
    </Pressable>
  </View>;
  const securityAvailable = snapshot.capabilities?.lockOnExit || snapshot.capabilities?.privacyScreen || snapshot.privacyScreen
    || snapshot.privacyScreenNotice === "load-failed" || snapshot.capabilities?.hostMute || snapshot.hostMute || snapshot.hostMuteNotice
    || snapshot.clipboardSync || snapshot.clipboardSyncNotice || snapshot.capabilities?.clipboardSync && mobileRemoteClipboardSystem.syncAvailable
    || Platform.OS === "ios" && supportedCredentialHost(snapshot.capabilities?.platform);
  const selectedDisplay = snapshot.capabilities?.displays.find(display => display.displayId === snapshot.selectedDisplayId);
  const permissionGuidance = <RemoteDesktopPermissionGuidance snapshot={snapshot} controller={controller} colors={colors} locale={locale}
    disabled={!routeFocused || !interactive || !foreground || !online || snapshot.exitStatus !== "idle" || snapshot.displaySwitchBusy} />;
  const accessibilityGuidanceAvailable = snapshot.notice === "accessibility-permission" || snapshot.permissions !== undefined
    && !permissionReady(snapshot.permissions.accessibility);
  return <MobileKeyboardAvoidingView style={[styles.root, { backgroundColor: colors.background }]}
    keyboard={keyboard} consumedBottomInset={safeArea.bottom} enabled={!adaptive}>
    <View style={[styles.header, { borderColor: colors.border, backgroundColor: colors.background }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={copy.back}
        disabled={snapshot.exitStatus === "pending"} onPress={back}
        style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
        <Text style={[styles.backText, { color: colors.ink }]}>‹</Text>
      </Pressable>
      <View style={styles.heading}>
        <Text accessibilityRole="header" numberOfLines={1} style={[styles.title, { color: colors.ink }]}>
          {snapshot.host?.displayName || copy.title}
        </Text>
        <Text accessibilityLiveRegion="polite" numberOfLines={2} style={[styles.caption,
          { color: snapshot.status === "error" || snapshot.status === "revoked" ? colors.negative : colors.muted }]}>
          {notice && notice !== status ? `${status} · ${notice}` : status}
        </Text>
      </View>
      {snapshot.status === "live" && <Text style={[styles.badge, { color: colors.ink, borderColor: colors.border }]}>
        {snapshot.controlling ? copy.control : copy.view}
      </Text>}
    </View>
    <View ref={layoutContainer} testID="remoteDesktop.layout" style={styles.body} onLayout={measureContainer}>
    <View testID="remoteDesktop.media" style={[styles.viewer, { backgroundColor: colors.background },
      adaptive && mediaRect && { position: "absolute", flex: 0, left: mediaRect.x, top: mediaRect.y, width: mediaRect.width, height: mediaRect.height }]}
      onLayout={(event) => { viewerViewport.current = fold ? { width: fold.media.width, height: fold.media.height } : event.nativeEvent.layout; }}>
      {MobileNativeRemoteDesktopView && <MobileNativeRemoteDesktopView ref={nativeView}
        inlineVisible={routeFocused} onMessage={event => controller.nativeMessage(event.nativeEvent.data)}
        style={StyleSheet.absoluteFill} />}
      <WebView ref={webView} source={{ html, baseUrl: "about:blank" }} originWhitelist={["about:blank"]}
        javaScriptEnabled domStorageEnabled={false} sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false}
        allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never" mediaPlaybackRequiresUserAction={false} allowsInlineMediaPlayback
        allowsPictureInPictureMediaPlayback
        setSupportMultipleWindows={false} onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
        onMessage={(event) => controller.viewerMessage(event.nativeEvent.data)}
        onError={() => { controller.viewerProcessLost(); webView.current?.reload(); }}
        onContentProcessDidTerminate={() => { controller.viewerProcessLost(); webView.current?.reload(); }}
        onRenderProcessGone={() => { controller.viewerProcessLost(); webView.current?.reload(); return true; }}
        style={[styles.webView, adaptive && StyleSheet.absoluteFill]} />
      {MobileRemoteDesktopMouseControls && !fold && mouseControlsVisible && <MobileRemoteDesktopMouseControls
        key={`mouse/${snapshot.mouseOccurrence}/${layoutKey}`} controller={controller} colors={colors} locale={locale}
        bottom={16} right={systemSideRail ? (railRect?.width ?? 60) + 12 : 12} compact={landscape} />}
      {snapshot.status === "live" && snapshot.network && !snapshot.keyboardOpen && !landscape
        && <MobileRemoteDesktopNetworkStatus network={snapshot.network} colors={colors} locale={locale} />}
      {(selection || terminal || snapshot.status === "loading" || snapshot.exitStatus === "pending") && <View style={[styles.overlay,
        { backgroundColor: `${colors.background}ee` }]}>
        {snapshot.exitStatus === "pending" ? <><ActivityIndicator color={colors.accent} />
          <Text style={[styles.message, { color: colors.muted }]}>{snapshot.exitLockRequested ? copy.lockingOnExit : copy.disconnecting}</Text></> :
          snapshot.exitStatus === "failed" ? <>
            <Text accessibilityRole="alert" style={[styles.message, { color: colors.negative }]}>{exitNotice}</Text>
            <View style={styles.overlayActions}>
              <Button label={copy.reconnect} colors={colors} disabled={!interactive || !online}
                onPress={() => void controller.reconnectAfterExitFailure()} />
              <Button label={copy.closeViewer} colors={colors}
                onPress={() => { void controller.close().then(() => onClose(false)); }} />
            </View>
          </> : snapshot.status === "loading" ? <><ActivityIndicator color={colors.accent} />
          <Text style={[styles.message, { color: colors.muted }]}>{snapshot.displaySwitchBusy ? copy.displaySwitching : copy.connecting}</Text></> :
          snapshot.status === "select-host" ? <SelectionList title={copy.chooseDesktop}
            items={snapshot.hosts.map((host) => ({ id: host.route?.targetDeviceId ?? host.displayName,
              label: host.displayName, detail: host.platform }))} colors={colors}
            onSelect={(id) => { const host = snapshot.hosts.find((candidate) => candidate.route?.targetDeviceId === id); if (host) void controller.selectHost(host); }} /> :
          snapshot.status === "select-display" ? <SelectionList title={copy.chooseDisplay}
            items={(snapshot.capabilities?.displays ?? []).map((display) => ({ id: display.displayId,
              label: display.name, detail: `${display.width} × ${display.height}` }))} colors={colors}
            disabled={snapshot.displaySwitchBusy} onSelect={(id) => void controller.selectDisplay(id)} /> :
          snapshot.status === "permission" ? permissionGuidance : <>
            <Text accessibilityRole="alert" style={[styles.message, { color: colors.ink }]}>{notice ?? status}</Text>
            <View style={styles.overlayActions}>
              {snapshot.status === "busy" && snapshot.takeoverAvailable && <Button label={copy.takeover} colors={colors}
                onPress={() => void controller.takeover()} />}
              {snapshot.status !== "revoked" && <Button label={copy.retry} colors={colors}
                onPress={() => void controller.retry()} />}
            </View>
          </>}
      </View>}
      {(snapshot.status === "connecting" || snapshot.status === "capture-pending" || snapshot.status === "reconnecting" || snapshot.status === "offline")
        && <View pointerEvents="none" style={[styles.floatingStatus, { backgroundColor: `${colors.surface}e8`, borderColor: colors.border }]}>
          {snapshot.status !== "offline" && <ActivityIndicator size="small" color={colors.accent} />}
          <Text style={[styles.caption, styles.flex, { color: colors.muted }]}>{status}</Text>
        </View>}
    </View>
    {touchpadVisible && controlsRect && <View testID="remoteDesktop.foldControls" style={{ position: "absolute", left: controlsRect.x,
      top: controlsRect.y, width: controlsRect.width, height: controlsRect.height,
      paddingBottom: toolbarHeight + (mouseControlsVisible ? 80 : 0) }}>
      <MobileRemoteDesktopFoldTouchpad key={`pad/${snapshot.touchpadOccurrence}/${layoutKey}`} controller={controller}
        enabled={interactionReady} colors={colors} locale={locale} />
      {MobileRemoteDesktopMouseControls && mouseControlsVisible && <MobileRemoteDesktopMouseControls
        key={`mouse/${snapshot.mouseOccurrence}/${layoutKey}`} controller={controller} colors={colors} locale={locale} bottom={toolbarHeight} right={0} compact />}
    </View>}
    {adaptive && !snapshot.keyboardOpen && <ScrollView testID="remoteDesktop.toolbarPosition"
      onLayout={event => { if (!systemSideRail) setToolbarHeight(event.nativeEvent.layout.height); }}
      horizontal={!systemSideRail} contentContainerStyle={[styles.compactToolbar, systemSideRail && styles.compactRail]}
      style={systemSideRail && railRect ? { position: "absolute", left: railRect.x, top: railRect.y, width: railRect.width, height: railRect.height }
        : controlsRect ? { position: "absolute", left: controlsRect.x, width: controlsRect.width,
          top: controlsRect.y + controlsRect.height - toolbarHeight, maxHeight: controlsRect.height } : undefined}>
      <CompactButton icon="control" label={snapshot.controlling ? copy.view : copy.control} colors={colors}
        disabled={snapshot.status !== "live" || !snapshot.capabilities?.canControl} onPress={() => void controller.setControl(!snapshot.controlling)} />
      {snapshot.capabilities?.workspaceNavigation && (["workspaceLeft", "workspaceRight"] as const).map(action => <CompactButton key={action}
        icon={action === "workspaceLeft" ? "left" : "right"} label={copy[action]} colors={colors}
        disabled={toolbarInputDisabled || snapshot.systemActionPending} onPress={() => { void controller.performSystemAction(action); }} />)}
      {snapshot.capabilities?.systemMenu && <CompactButton icon="menu" label={copy.systemMenu} colors={colors}
        disabled={toolbarInputDisabled || snapshot.systemActionPending} onPress={() => { void controller.performSystemAction("systemMenu"); }} />}
      {mobileRemoteDesktopShortcuts(snapshot.capabilities).map(shortcut => <CompactButton key={shortcut.id} icon={shortcut.id}
        label={copy[shortcut.labelKey]} colors={colors} disabled={toolbarInputDisabled}
        onPress={() => controller.performKeyboardShortcut(shortcut.id)} />)}
      <CompactButton icon="keyboard" label={copy.keyboard} colors={colors} disabled={toolbarInputDisabled} onPress={() => { setPanelPage(null); controller.showKeyboard(); }} />
      <CompactButton icon="settings" label={operations ? copy.closeSettings : copy.settings} colors={colors} onPress={showOperations} />
    </ScrollView>}
    {!adaptive && !snapshot.keyboardOpen && <View testID="remoteDesktop.toolbarPosition" pointerEvents="box-none"
      style={landscape ? { position: "absolute", right: ordinaryWidth - ordinarySafe.x - ordinarySafe.width + 12,
        top: ordinarySafe.y, bottom: ordinaryHeight - ordinarySafe.y - ordinarySafe.height, justifyContent: "center" }
        : { position: "absolute", left: ordinarySafe.x + 8, right: ordinaryWidth - ordinarySafe.x - ordinarySafe.width + 8,
          bottom: ordinaryHeight - ordinarySafe.y - ordinarySafe.height + 8, alignItems: "center" }}>
      <MobileRemoteDesktopToolbar actions={toolbarActions} landscape={landscape} colors={colors} />
    </View>}
    {(operations || snapshot.keyboardOpen) && <RemoteDesktopPanelFrame adaptive={adaptive} keyboardOpen={snapshot.keyboardOpen}
      controlsRect={controlsRect} bodyHeight={localGeometry?.height ?? ordinaryHeight}
      foldToolbarHeight={fold ? toolbarHeight : 0} header={panelHeader} page={panelPage ?? "controls"}
      landscape={landscape} colors={colors} closeLabel={copy.panelClose} onClose={() => setPanelPage(null)}
      width={ordinaryWidth} height={ordinaryHeight} toolbarLength={toolbarActions.length * 44}
      top={ordinarySafe.y} left={ordinarySafe.x} right={ordinaryWidth - ordinarySafe.x - ordinarySafe.width}
      bottom={ordinaryHeight - ordinarySafe.y - ordinarySafe.height}>
    <View testID="remoteDesktop.controlsPanel" onLayout={event => { if (snapshot.keyboardOpen) setPanelHeight(event.nativeEvent.layout.height); }}
      style={[styles.controls, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      {snapshot.keyboardOpen ? <>
        <MobileRemoteDesktopSystemActions snapshot={snapshot} colors={colors} locale={locale}
          interactive={interactive} foreground={foreground} routeFocused={routeFocused} online={online}
          onAction={action => { void controller.performSystemAction(action); }} onRetry={() => { void controller.retrySystemAction(); }} />
        <MobileRemoteDesktopKeyboardPanel snapshot={snapshot} controller={controller} colors={colors} locale={locale}
          interactive={interactive} foreground={foreground} routeFocused={routeFocused} online={online} />
      </> : <>
      {panelPage === "controls" && <>
      <View style={styles.controlRow}>
        <Button label={snapshot.controlling ? copy.view : copy.control} colors={colors}
          selected={snapshot.controlling} disabled={snapshot.status !== "live" || !snapshot.capabilities?.canControl}
          onPress={() => void controller.setControl(!snapshot.controlling)} />
        {(["touch", "trackpad", "pan"] as const).map((mode) => <Button key={mode}
          label={mode === "touch" ? copy.touch : mode === "trackpad" ? copy.trackpad : copy.pan}
          colors={colors} selected={snapshot.inputMode === mode} disabled={snapshot.status !== "live"}
          onPress={() => selectInputMode(mode)} />)}
      </View>
      <View style={styles.controlRow}>
        <Pressable accessibilityRole="switch" accessibilityLabel={copy.mouseButtons}
          accessibilityState={{ checked: mouseButtonsPreference.value, disabled: mouseButtonsPreference.saving }}
          disabled={mouseButtonsPreference.saving} onPress={() => { void mouseButtonsPreferences.update(!mouseButtonsPreference.value); }}
          style={[styles.button, { borderColor: mouseButtonsPreference.value ? colors.accent : colors.border,
            backgroundColor: mouseButtonsPreference.value ? `${colors.accent}22` : colors.background }]}>
          <Text style={[styles.buttonText, { color: mouseButtonsPreference.value ? colors.accent : colors.ink }]}>{copy.mouseButtons}</Text>
        </Pressable>
        {(inputModePreference.saving || mouseButtonsPreference.saving) && <ActivityIndicator size="small" color={colors.accent} />}
      </View>
      {inputModePreference.notice && <View style={styles.controlRow}>
        <Text accessibilityRole="alert" style={[styles.caption, { color: colors.negative }]}>
          {`${copy.touch} / ${copy.trackpad} · ${inputModePreference.notice === "load-failed" ? copy.inputSettingsLoadFailed : copy.inputSettingsSaveFailed}`}
        </Text>
        <Button label={copy.retry} colors={colors} disabled={inputModePreference.saving}
          onPress={() => { void (inputModePreference.notice === "load-failed" ? inputModePreferences.retryLoad() : inputModePreferences.update(inputModePreference.value)); }} />
      </View>}
      {mouseButtonsPreference.notice && <View style={styles.controlRow}>
        <Text accessibilityRole="alert" style={[styles.caption, { color: colors.negative }]}>
          {`${copy.mouseButtons} · ${mouseButtonsPreference.notice === "load-failed" ? copy.inputSettingsLoadFailed : copy.inputSettingsSaveFailed}`}
        </Text>
        <Button label={copy.retry} colors={colors} disabled={mouseButtonsPreference.saving}
          onPress={() => { void (mouseButtonsPreference.notice === "load-failed" ? mouseButtonsPreferences.retryLoad() : mouseButtonsPreferences.update(mouseButtonsPreference.value)); }} />
      </View>}
      <PanelNavigation label={copy.displaySettings} detail={selectedDisplay ? `${selectedDisplay.width} × ${selectedDisplay.height}` : undefined}
        colors={colors} onPress={() => setPanelPage("display")} />
      {securityAvailable && <PanelNavigation label={copy.security} colors={colors} onPress={() => setPanelPage("security")} />}
      {accessibilityGuidanceAvailable && <PanelNavigation label={copy.permissionsTitle} colors={colors} onPress={() => setPanelPage("permissions")} />}
      </>}
      {panelPage === "permissions" && permissionGuidance}
      {panelPage === "display" && <>
      <MobileRemoteDesktopDisplaySelector displays={snapshot.capabilities?.displays ?? []} selectedDisplayId={snapshot.selectedDisplayId}
        disabled={snapshot.status !== "live" || !routeFocused || !interactive || !foreground || !online || snapshot.displaySwitchBusy
          || snapshot.displayModeBusy || snapshot.videoSettingsBusy || snapshot.exitStatus !== "idle"}
        label={copy.chooseDisplay} colors={colors} onSelect={id => { setPanelPage(null); void controller.selectDisplay(id); }} />
      {snapshot.displaySwitchBusy && <Text accessibilityLiveRegion="polite" style={[styles.caption, { color: colors.muted }]}>{copy.displaySwitching}</Text>}
      {snapshot.capabilities?.videoSettings && <>
        <View style={styles.controlRow}>
          <Text style={[styles.controlLabel, { color: colors.muted }]}>{copy.frameRate}</Text>
          {([30, 60] as const).map((fps) => <Button key={fps} label={`${fps} FPS`} colors={colors}
            selected={videoPreference.settings.fps === fps}
            disabled={snapshot.status !== "live" || snapshot.videoSettingsBusy}
            onPress={() => updateVideoPreference(videoPreferences, videoPreference.settings, { fps })} />)}
        </View>
        <View style={styles.controlRow}>
          <Text style={[styles.controlLabel, { color: colors.muted }]}>{copy.quality}</Text>
          {(["auto", "saver", "hd"] as const).map((quality) => <Button key={quality}
            label={quality === "auto" ? copy.auto : quality === "saver" ? copy.saver : copy.hd}
            colors={colors} selected={videoPreference.settings.quality === quality}
            disabled={snapshot.status !== "live" || snapshot.videoSettingsBusy}
            onPress={() => updateVideoPreference(videoPreferences, videoPreference.settings, { quality })} />)}
        </View>
        <Text style={[styles.controlLabel, { color: colors.muted }]}>{copy.qualityHint}</Text>
      </>}
      {snapshot.capabilities?.viewerDisplay && <View style={styles.controlRow}>
        <Text style={[styles.controlLabel, { color: colors.muted }]}>{copy.resolution}</Text>
        <Button label={copy.fitDisplay} colors={colors} selected={snapshot.viewerDisplayFitted}
          disabled={!snapshot.controlling || snapshot.status !== "live" || snapshot.displayModeBusy || snapshot.clipboardBusy || snapshot.videoSettingsBusy}
          onPress={() => void controller.fitViewerDisplay(viewerViewport.current.width, viewerViewport.current.height)} />
        {snapshot.capabilities.viewerDisplayRestore && <Button label={copy.restoreDisplay} colors={colors}
          disabled={!snapshot.controlling || !snapshot.viewerDisplayFitted || snapshot.status !== "live"
            || snapshot.displayModeBusy || snapshot.clipboardBusy || snapshot.videoSettingsBusy}
          onPress={() => void controller.restoreViewerDisplay()} />}
        {snapshot.displayModeBusy && <ActivityIndicator size="small" color={colors.accent} />}
      </View>}
      {snapshot.capabilities?.displayModes && (snapshot.controlling || snapshot.displayModeBusy) && <View style={styles.displayModeSection}>
        <Text style={[styles.controlLabel, { color: colors.muted }]}>{copy.resolution}</Text>
        {snapshot.capabilities.resolutionRestore && <Text style={[styles.controlLabel, { color: colors.muted }]}>{copy.temporaryResolution}</Text>}
        {snapshot.displayModesStatus === "loading" && <View style={styles.displayModeLoading}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={[styles.controlLabel, { color: colors.muted }]}>{copy.displayModesLoading}</Text>
        </View>}
        {snapshot.displayModesStatus === "error" && <View style={styles.displayModeLoading}>
          <Text accessibilityRole="alert" style={[styles.controlLabel, { color: colors.negative }]}>
            {copy.displayModesFailed}
          </Text>
          <Button label={copy.retry} colors={colors} disabled={snapshot.displayModeBusy}
            onPress={() => void controller.loadDisplayModes()} />
        </View>}
        {snapshot.displayModesStatus === "ready" && <ScrollView horizontal
          showsHorizontalScrollIndicator={false} contentContainerStyle={styles.displayModeList}>
          {snapshot.displayModes.map((mode) => <Button key={mode.modeId}
            label={`${mode.width} × ${mode.height}${mode.native ? ` · ${copy.nativeResolution}` : ""}`}
            colors={colors} selected={mode.current}
            disabled={snapshot.displayModeBusy || snapshot.clipboardBusy || snapshot.videoSettingsBusy
              || snapshot.status !== "live" || mode.current && !snapshot.viewerDisplayFitted}
            onPress={() => void controller.setDisplayMode(mode.modeId)} />)}
        </ScrollView>}
      </View>}
      {(snapshot.displayModeNotice === "change-failed" || snapshot.displayModeNotice === "restore-unavailable") && <Text accessibilityLiveRegion="polite" numberOfLines={3}
        style={[styles.clipboardNotice, { color: colors.negative }]}>
        {snapshot.displayModeNotice === "restore-unavailable" ? copy.displayRestoreFailed : copy.displayModeFailed}
      </Text>}
      </>}
      {panelPage === "controls" && <>
      {snapshot.capabilities?.videoSettings && snapshot.capabilities.systemAudio && <View style={styles.controlRow}>
        <Button label={videoPreference.settings.audio ? copy.audioOn : copy.audioOff} colors={colors}
          selected={videoPreference.settings.audio} disabled={snapshot.status !== "live" || snapshot.videoSettingsBusy}
          onPress={() => updateVideoPreference(videoPreferences, videoPreference.settings, { audio: !videoPreference.settings.audio })} />
      </View>}
      {nativePresentation.nativeVideo && <MobileRemoteDesktopNativeTools colors={colors} locale={locale}
        preference={backgroundPreference} backgroundAvailable={snapshot.capabilities?.backgroundViewing === true}
        disabled={!routeFocused || !foreground || !interactive || !online || snapshot.status !== "live" || snapshot.exitStatus === "pending"}
        rotation={rotation} onBackgroundChange={enabled => { void backgroundPreferences.update(enabled); }}
        onPreferenceRetry={() => { void backgroundPreferences.retryLoad(); }} onRotate={rotate} />}
      </>}
      {panelPage === "security" && <>
      {(snapshot.hostMute || snapshot.capabilities?.hostMute || snapshot.hostMuteNotice) && <>
        <View style={styles.controlRow}>
          <Button label={copy.hostMute} colors={colors} selected={snapshot.hostMute}
            disabled={!snapshot.hostMuteLoaded || snapshot.hostMutePending || !interactive || !snapshot.capabilities?.hostMute}
            onPress={() => void controller.setHostMute(!snapshot.hostMute)} />
          {snapshot.hostMutePending && <ActivityIndicator size="small" color={colors.accent} />}
          <Text accessibilityLiveRegion="polite" style={[styles.controlLabel, { color: colors.muted }]}>
            {snapshot.hostMutePending ? copy.hostMuteUpdating : snapshot.hostMuteActive ? copy.hostMuteActive : copy.hostMuteUnconfirmed}
          </Text>
          {snapshot.hostMuteNotice && <Button label={copy.retry} colors={colors}
            disabled={snapshot.hostMutePending || !interactive} onPress={() => void controller.retryHostMute()} />}
        </View>
        <Text style={[styles.clipboardNotice, { color: colors.muted }]}>{copy.hostMuteHint}</Text>
        {snapshot.hostMuteNotice && <Text accessibilityRole="alert" style={[styles.clipboardNotice, { color: colors.negative }]}>
          {snapshot.hostMuteNotice === "load-failed" ? copy.hostMuteLoadFailed : snapshot.hostMuteNotice === "save-failed" ? copy.hostMuteSaveFailed : copy.hostMuteApplyFailed}
        </Text>}
      </>}
      {(snapshot.clipboardSync || snapshot.clipboardSyncNotice || (snapshot.capabilities?.clipboardSync && mobileRemoteClipboardSystem.syncAvailable)) && <>
        <View style={styles.controlRow}>
          <Button label={copy.clipboardSync} colors={colors} selected={snapshot.clipboardSync}
            disabled={snapshot.clipboardSyncSaving || !interactive || snapshot.exitStatus !== "idle"
              || (!snapshot.clipboardSyncLoaded && snapshot.clipboardSyncNotice !== "load-failed")}
            onPress={() => void controller.setClipboardSync(!snapshot.clipboardSync)} />
          {snapshot.clipboardSyncSaving && <ActivityIndicator size="small" color={colors.accent} />}
          {snapshot.clipboardSync && <Text accessibilityLiveRegion="polite" style={[styles.controlLabel, { color: colors.muted }]}>
            {snapshot.clipboardSyncActive ? copy.clipboardSyncActive : copy.clipboardSyncPaused}
          </Text>}
          {snapshot.clipboardSyncNotice && <Button label={copy.retry} colors={colors}
            disabled={snapshot.clipboardSyncSaving || !interactive || snapshot.exitStatus !== "idle"}
            onPress={() => void controller.retryClipboardSync()} />}
        </View>
        <Text style={[styles.clipboardNotice, { color: colors.muted }]}>{copy.clipboardSyncHint}</Text>
        {syncNotice && <Text accessibilityRole="alert" style={[styles.clipboardNotice, { color: colors.negative }]}>{syncNotice}</Text>}
      </>}
      {Platform.OS === "ios" && supportedCredentialHost(snapshot.capabilities?.platform) && <>
        <View style={styles.controlRow}>
          <Button label={securityCopy.autoUnlock} colors={colors} selected={snapshot.credentials.autoUnlock}
            disabled={snapshot.credentials.busy || !interactive || snapshot.exitStatus !== "idle" ||
              (!snapshot.credentials.available && !snapshot.credentials.autoUnlock)}
            onPress={() => void controller.credential(snapshot.credentials.autoUnlock ? "disable" : "enable")} />
          {snapshot.credentials.busy && <ActivityIndicator size="small" color={colors.accent} />}
          {snapshot.credentials.busy && <Text accessibilityLiveRegion="polite" style={[styles.controlLabel, { color: colors.muted }]}>{securityCopy.pending}</Text>}
        </View>
        <Text style={[styles.clipboardNotice, { color: colors.muted }]}>{securityCopy.autoUnlockHint}</Text>
        {snapshot.credentials.autoUnlock && <View style={styles.controlRow}>
          <Button label={securityCopy.biometric} colors={colors} selected={snapshot.credentials.biometricVerification}
            disabled={snapshot.credentials.busy || !interactive || snapshot.exitStatus !== "idle" ||
              (!snapshot.credentials.biometricAvailable && !snapshot.credentials.biometricVerification)}
            onPress={() => void controller.credential("biometric", !snapshot.credentials.biometricVerification)} />
        </View>}
        <Text style={[styles.clipboardNotice, { color: colors.muted }]}>{securityCopy.storage}</Text>
        {(snapshot.credentials.notice || (!snapshot.credentials.available && !snapshot.credentials.busy)) &&
          <Text accessibilityRole="alert" style={[styles.clipboardNotice, { color: colors.negative }]}>
            {snapshot.credentials.notice ? securityCopy[snapshot.credentials.notice] : securityCopy.unavailable}
          </Text>}
        {snapshot.credentials.notice && <Button label={copy.retry} colors={colors}
          disabled={snapshot.credentials.busy || !interactive || snapshot.exitStatus !== "idle"}
          onPress={() => void controller.retryCredential()} />}
      </>}
      {(snapshot.privacyScreen || snapshot.capabilities?.privacyScreen || snapshot.privacyScreenNotice === "load-failed") && <>
        <View style={styles.controlRow}>
          <Button label={copy.privacyScreen} colors={colors} selected={snapshot.privacyScreen}
            disabled={snapshot.privacyScreenPending || !interactive || snapshot.exitStatus !== "idle" ||
              (!snapshot.privacyScreenLoaded && snapshot.privacyScreenNotice !== "load-failed") ||
              (!snapshot.capabilities?.privacyScreen && !snapshot.privacyScreen)}
            onPress={() => void controller.setPrivacyScreen(!snapshot.privacyScreen)} />
          {snapshot.privacyScreenPending && <ActivityIndicator size="small" color={colors.accent} />}
          <Text accessibilityLiveRegion="polite" style={[styles.controlLabel, { color: colors.muted }]}>
            {snapshot.privacyScreenNotice === "privacy-failed" ? copy.privacyScreenApplyFailed : snapshot.privacyScreenPending ? copy.privacyScreenUpdating :
              snapshot.privacyScreenActive ? copy.privacyScreenActive : copy.privacyScreenUnconfirmed}
          </Text>
          {(snapshot.privacyScreenNotice === "load-failed" || snapshot.privacyScreenNotice === "save-failed") &&
            <Button label={copy.retry} colors={colors} disabled={snapshot.privacyScreenPending || !interactive || snapshot.exitStatus !== "idle"}
              onPress={() => void controller.retryPrivacyScreenPreference()} />}
        </View>
        <Text style={[styles.clipboardNotice, { color: colors.muted }]}>{copy.privacyScreenHint}</Text>
        {snapshot.privacyScreenNotice && <Text accessibilityRole="alert" style={[styles.clipboardNotice, { color: colors.negative }]}>
          {snapshot.privacyScreenNotice === "load-failed" ? copy.privacyScreenLoadFailed :
            snapshot.privacyScreenNotice === "save-failed" ? copy.privacyScreenSaveFailed : copy.privacyScreenApplyFailed}
        </Text>}
      </>}
      {snapshot.capabilities?.lockOnExit && <>
        <View style={styles.controlRow}>
          <Button label={copy.lockOnExit} colors={colors} selected={snapshot.lockOnExit}
            disabled={!snapshot.lockOnExitLoaded || snapshot.lockOnExitPending || !interactive || snapshot.exitStatus !== "idle"}
            onPress={() => void controller.setLockOnExit(!snapshot.lockOnExit)} />
          {snapshot.lockOnExitPending && <ActivityIndicator size="small" color={colors.accent} />}
          {snapshot.lockOnExitNotice && <Button label={copy.retry} colors={colors}
            disabled={snapshot.lockOnExitPending || !interactive || snapshot.exitStatus !== "idle"}
            onPress={() => void controller.retryLockOnExitPreference()} />}
        </View>
        <Text style={[styles.clipboardNotice, { color: colors.muted }]}>{copy.lockOnExitHint}</Text>
        {snapshot.lockOnExitNotice && <Text accessibilityRole="alert" style={[styles.clipboardNotice, { color: colors.negative }]}>
          {snapshot.lockOnExitNotice === "load-failed" ? copy.lockPreferenceLoadFailed : copy.lockPreferenceSaveFailed}
        </Text>}
      </>}
      </>}
      {panelPage === "controls" && <>
      <View style={styles.controlRow}>
        <Button label={copy.left} colors={colors} disabled={!snapshot.controlling} onPress={() => controller.click(0)} />
        <Button label={copy.right} colors={colors} disabled={!snapshot.controlling} onPress={() => controller.click(2)} />
        <Button label={copy.keyboard} colors={colors} disabled={!snapshot.controlling} onPress={() => { setPanelPage(null); controller.showKeyboard(); }} />
        <Button label={copy.release} colors={colors} disabled={!snapshot.controlling} onPress={() => controller.releaseInput()} />
        <Button label={copy.fit} colors={colors} disabled={!snapshot.hasFrame} onPress={() => controller.fit()} />
      </View>
      <MobileRemoteDesktopSystemActions snapshot={snapshot} colors={colors} locale={locale}
        interactive={interactive} foreground={foreground} routeFocused={routeFocused} online={online}
        onAction={action => { void controller.performSystemAction(action); }} onRetry={() => { void controller.retrySystemAction(); }} />
      <MobileRemoteDesktopShortcutTools snapshot={snapshot} controller={controller} colors={colors} locale={locale}
        interactive={interactive} foreground={foreground} routeFocused={routeFocused} online={online} />
      <View style={styles.controlRow}>
        <Button label={copy.copyToPhone} colors={colors}
          disabled={snapshot.status !== "live" || !snapshot.controlling
            || !snapshot.clipboardAvailable || snapshot.clipboardBusy}
          onPress={() => void controller.copyToPhone()} />
        <Button label={copy.pasteFromPhone} colors={colors}
          disabled={snapshot.status !== "live" || !snapshot.controlling
            || !snapshot.clipboardAvailable || snapshot.clipboardBusy}
          onPress={() => void controller.pasteFromPhone()} />
      </View>
      {clipboardNotice && <Text accessibilityLiveRegion="polite" numberOfLines={2}
        style={[styles.clipboardNotice, { color: snapshot.clipboardNotice === "copied"
          || snapshot.clipboardNotice === "pasted" ? colors.muted : colors.negative }]}>
        {clipboardNotice}
      </Text>}
      </>}
      <View style={styles.controlRow}>
        <Button label={copy.disconnect} colors={colors} disabled={snapshot.exitStatus !== "idle" || !interactive || snapshot.displaySwitchBusy}
          onPress={() => void leave(true)} />
      </View>
      </>}
    </View>
    </RemoteDesktopPanelFrame>}
    </View>
  </MobileKeyboardAvoidingView>;
}

function permissionReady(status: RemoteDesktopPermissionStatus): boolean {
  return status === RemoteDesktopPermissionStatus.GRANTED || status === RemoteDesktopPermissionStatus.NOT_REQUIRED;
}

function RemoteDesktopPermissionGuidance({ snapshot, controller, colors, locale, disabled }: {
  readonly snapshot: MobileRemoteDesktopSnapshot; readonly controller: MobileRemoteDesktopController;
  readonly colors: MobileRemoteDesktopColors; readonly locale: MobileSupportedLocale; readonly disabled: boolean;
}) {
  const copy = mobileRemoteDesktopCopy(locale), permissions = snapshot.permissions;
  const ready = permissions !== undefined && permissionReady(permissions.screenRecording) && permissionReady(permissions.accessibility);
  const permissionValue = (status: RemoteDesktopPermissionStatus | undefined): string => status === RemoteDesktopPermissionStatus.GRANTED
    ? copy.permissionGranted : status === RemoteDesktopPermissionStatus.NOT_REQUIRED ? copy.permissionNotRequired
      : status === RemoteDesktopPermissionStatus.MISSING ? copy.permissionMissing : copy.permissionUnknown;
  const pending = snapshot.permissionGuideStatus === "pending";
  const notice = snapshot.permissionNotice === "check-failed" ? copy.permissionCheckFailed
    : snapshot.permissionNotice === "guide-opened" ? copy.permissionGuideOpened
    : snapshot.permissionNotice === "guide-failed" ? copy.permissionActionFailed
    : snapshot.permissionNotice === "guide-unknown" ? copy.permissionGuideUnknown : undefined;
  return <MobileRemoteDesktopPermissionGuide title={copy.permissionsTitle} intro={ready ? copy.permissionsReady : copy.permissionsIntro}
    rows={[{ label: copy.screenRecording, value: permissionValue(permissions?.screenRecording) },
      { label: copy.accessibility, value: permissionValue(permissions?.accessibility) }]}
    guideLabel={!ready ? pending ? copy.permissionChecking : copy.openGuideOnComputer : undefined}
    colors={colors} pending={pending} disabled={disabled} notice={notice} onGuide={() => void controller.refreshPermissions(true)}
    reconnectLabel={copy.reconnectAfterPermissions} onReconnect={() => void controller.retry()} />;
}

function RemoteDesktopPanelFrame({ adaptive, keyboardOpen, controlsRect, bodyHeight, foldToolbarHeight, children, ...panel }: MobileRemoteDesktopPanelProps & {
  readonly adaptive: boolean;
  readonly keyboardOpen: boolean;
  readonly controlsRect: MobileLayoutRect | null;
  readonly bodyHeight: number;
  readonly foldToolbarHeight: number;
}) {
  if (!adaptive && !keyboardOpen) return <MobileRemoteDesktopPanel {...panel}>{children}</MobileRemoteDesktopPanel>;
  return <ScrollView testID={keyboardOpen ? "remoteDesktop.keyboard" : "remoteDesktop.operations"}
    keyboardShouldPersistTaps="always" style={adaptive && controlsRect ? { position: "absolute", left: controlsRect.x,
      ...(keyboardOpen ? { bottom: bodyHeight - controlsRect.y - controlsRect.height } : { top: controlsRect.y }),
      width: controlsRect.width, maxHeight: Math.max(0, controlsRect.height - (!keyboardOpen ? foldToolbarHeight : 0)) }
      : { flexGrow: 0, maxHeight: Math.max(144, panel.height * .5) }}>
    {!keyboardOpen && panel.header}{children}
  </ScrollView>;
}

function PanelNavigation({ label, detail, colors, onPress }: {
  readonly label: string; readonly detail?: string; readonly colors: MobileRemoteDesktopColors; readonly onPress: () => void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
    style={({ pressed }) => [styles.panelNavigation, { borderColor: colors.border }, pressed && styles.pressed]}>
    <View style={styles.flex}><Text style={[styles.label, { color: colors.ink }]}>{label}</Text>
      {detail && <Text style={[styles.caption, { color: colors.muted }]}>{detail}</Text>}</View>
    <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
  </Pressable>;
}

function updateVideoPreference(
  store: ReturnType<typeof createMobileRemoteDesktopVideoPreferenceStore>,
  settings: MobileRemoteDesktopVideoSettings,
  patch: Partial<MobileRemoteDesktopVideoSettings>
): void {
  store.update({
    fps: patch.fps ?? settings.fps,
    quality: patch.quality ?? settings.quality,
    audio: patch.audio ?? settings.audio
  });
}

function SelectionList({ title, items, colors, disabled = false, onSelect }: {
  readonly title: string;
  readonly items: readonly { readonly id: string; readonly label: string; readonly detail: string }[];
  readonly colors: MobileRemoteDesktopColors;
  readonly disabled?: boolean;
  readonly onSelect: (id: string) => void;
}) {
  return <View style={styles.selection}>
    <Text accessibilityRole="header" style={[styles.selectionTitle, { color: colors.ink }]}>{title}</Text>
    <ScrollView contentContainerStyle={styles.selectionList}>
      {items.map((item) => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={item.label}
        accessibilityState={{ disabled }} disabled={disabled} onPress={() => onSelect(item.id)} style={({ pressed }) => [styles.selectionItem,
          { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.pressed]}>
        <View style={styles.flex}><Text style={[styles.label, { color: colors.ink }]}>{item.label}</Text>
          <Text style={[styles.caption, { color: colors.muted }]}>{item.detail}</Text></View>
        <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
      </Pressable>)}
    </ScrollView>
  </View>;
}

function Button({ label, colors, disabled = false, selected = false, onPress }: {
  readonly label: string;
  readonly colors: MobileRemoteDesktopColors;
  readonly disabled?: boolean;
  readonly selected?: boolean;
  readonly onPress: () => void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled, selected }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, { borderColor: selected ? colors.accent : colors.border,
      backgroundColor: selected ? `${colors.accent}22` : colors.background }, disabled && styles.disabled, pressed && styles.pressed]}>
    <Text numberOfLines={1} style={[styles.buttonText, { color: disabled ? colors.muted : selected ? colors.accent : colors.ink }]}>{label}</Text>
  </Pressable>;
}

const compactIcons = {
  control: "M6 3v11l3-3 3 6 3-1-3-6h5L6 3Z", keyboard: "M3 5h18v14H3V5Zm3 4h1m3 0h1m3 0h1m3 0h1M6 12h1m3 0h1m3 0h1m3 0h1M7 16h10",
  settings: "M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-7 0v6", allWindows: "M3 4h13v11H3V4Zm5 5h13v11H8",
  showDesktop: "M3 4h18v13H3V4Zm9 13v4m-4 0h8", left: "M15 5 8 12l7 7", right: "m9 5 7 7-7 7", menu: "M4 6h16M4 12h16M4 18h16"
} as const;
function CompactButton({ icon, label, colors, disabled = false, onPress }: {
  readonly icon: keyof typeof compactIcons; readonly label: string; readonly colors: MobileRemoteDesktopColors;
  readonly disabled?: boolean; readonly onPress: () => void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled}
    onPress={onPress} style={({ pressed }) => [styles.compactButton, { borderColor: colors.border, backgroundColor: colors.surface },
      disabled && styles.disabled, pressed && styles.pressed]}>
    <CompactIcon icon={icon} colors={colors} disabled={disabled} />
  </Pressable>;
}

function CompactIcon({ icon, colors, disabled = false }: { readonly icon: keyof typeof compactIcons;
  readonly colors: MobileRemoteDesktopColors; readonly disabled?: boolean }) {
  return <Svg width={24} height={24} viewBox="0 0 24 24"><Path d={compactIcons[icon]} fill="none" stroke={disabled ? colors.muted : colors.ink}
    strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" /></Svg>;
}

function Unavailable({ colors, title, message, back, onClose }: {
  readonly colors: MobileRemoteDesktopColors; readonly title: string; readonly message: string;
  readonly back: string; readonly onClose: () => void;
}) {
  return <View style={[styles.root, styles.center, { backgroundColor: colors.background }]}>
    <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{title}</Text>
    <Text accessibilityRole="alert" style={[styles.message, { color: colors.muted }]}>{message}</Text>
    <Button label={back} colors={colors} onPress={onClose} />
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 }, body: { flex: 1, minHeight: 0, position: "relative" }, flex: { flex: 1 }, center: { alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  header: { minHeight: 62, paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row", alignItems: "center", gap: 8 },
  back: { width: 44, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: 22 },
  backText: { fontSize: 32, lineHeight: 36 }, heading: { flex: 1, minWidth: 0 },
  title: { fontSize: 18, lineHeight: 24, fontWeight: "700" }, caption: { fontSize: 12, lineHeight: 17 },
  badge: { fontSize: 12, fontWeight: "700", borderWidth: StyleSheet.hairlineWidth, borderRadius: 999,
    paddingHorizontal: 10, paddingVertical: 5 },
  viewer: { flex: 1, minHeight: 0, overflow: "hidden" }, webView: { flex: 1, backgroundColor: "transparent" },
  overlay: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0,
    alignItems: "center", justifyContent: "center", gap: 14, padding: 22 },
  overlayActions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8 },
  message: { fontSize: 15, lineHeight: 22, textAlign: "center" },
  floatingStatus: { position: "absolute", top: 12, left: 12, right: 12, borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, flexDirection: "row", alignItems: "center", gap: 9 },
  controls: { borderTopWidth: StyleSheet.hairlineWidth, padding: 8, gap: 7 },
  panelHeader: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: 4, padding: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  panelHeaderAction: { width: 44, minHeight: 44 }, panelTitle: { fontSize: 16, lineHeight: 22, fontWeight: "600", textAlign: "center" },
  panelCaption: { fontSize: 12, lineHeight: 17, textAlign: "center" }, panelCloseText: { fontSize: 28, lineHeight: 32 },
  panelNavigation: { minHeight: 58, flexDirection: "row", alignItems: "center", padding: 8, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  compactToolbar: { padding: 8, gap: 8, alignItems: "center" }, compactRail: { flexDirection: "column", flexGrow: 1, justifyContent: "center", paddingHorizontal: 2 },
  compactButton: { width: 44, height: 44, flexShrink: 0, alignItems: "center", justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 10 },
  controlRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, justifyContent: "center" },
  controlLabel: { fontSize: 12, lineHeight: 17, alignSelf: "center", paddingHorizontal: 3 },
  displayModeSection: { gap: 6 },
  displayModeLoading: { minHeight: 36, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 },
  displayModeList: { flexGrow: 1, gap: 6, justifyContent: "center", paddingHorizontal: 2 },
  clipboardNotice: { fontSize: 12, lineHeight: 17, minHeight: 17, textAlign: "center" },
  button: { minHeight: 44, minWidth: 52, maxWidth: 160, paddingHorizontal: 11, paddingVertical: 7,
    alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderRadius: 10 },
  buttonText: { fontSize: 12, lineHeight: 17, fontWeight: "600" },
  selection: { width: "100%", maxWidth: 520, maxHeight: "85%", gap: 12 },
  selectionTitle: { fontSize: 20, lineHeight: 27, fontWeight: "700", textAlign: "center" },
  selectionList: { gap: 8, paddingBottom: 8 },
  selectionItem: { minHeight: 58, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 12,
    flexDirection: "row", alignItems: "center", gap: 8 },
  label: { fontSize: 15, lineHeight: 21, fontWeight: "600" }, chevron: { fontSize: 25 },
  disabled: { opacity: 0.42 }, pressed: { opacity: 0.65 }
});
