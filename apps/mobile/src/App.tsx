import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import {
  AccessibilityInfo, ActivityIndicator, Alert, AppState, FlatList, Keyboard, Modal, PanResponder, Platform,
  Image, Pressable, ScrollView, SectionList, StyleSheet, Text, TextInput, findNodeHandle, useColorScheme,
  useWindowDimensions, View
} from "react-native";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { SvgXml } from "react-native-svg";
import { StatusBar } from "expo-status-bar";
import { randomUUID } from "expo-crypto";
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
import { mobileComposerDrafts, mobileInteractionDrafts, mobileStorage } from "./storage";
import {
  mobileComposerDraftIdentityKey,
  type MobileComposerDraftIdentity
} from "./composer-draft-store";
import { addToMobileComposer, changeMobileComposerText } from "./composer-draft-behavior";
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
import { MobileDrawer } from "./MobileDrawer";
import { MobileActionSheet } from "./MobileActionSheet";
import { MobileInteractionSheet } from "./MobileInteractionSheet";
import { MobileRuntimeControlsSheet } from "./MobileRuntimeControlsSheet";
import { MobileContextSheet } from "./MobileContextSheet";
import { MobileNativeTreeSheet } from "./MobileNativeTreeSheet";
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
  type MobileFileSearchResult,
  type MobileFilesSearchMode
} from "./workspace-files";
import { buildMobileMessageActions, queueItemText, type MobileMessageActionId } from "./task-actions";

const client = new MobileClient(
  mobileNetwork,
  mobileStorage,
  mobileDiscovery,
  randomUUID,
  Platform.OS,
  Date.now,
  (identity) => mobileInteractionDrafts.clear(identity)
);
type Page = "home" | "connection" | "new" | "task" | "files" | "connections" | "devices" | "device";

export function App() {
  const state = useSyncExternalStore((listener) => client.subscribe(listener), () => client.state);
  const [page, setPage] = useState<Page>("home");
  const [menuOpen, setMenuOpen] = useState(false);
  const [homeDrawerMounted, setHomeDrawerMounted] = useState(false);
  const [homeSearchFocusRequest, setHomeSearchFocusRequest] = useState(0);
  const [deviceId, setDeviceId] = useState<string>();
  const homeMenuButtonRef = useRef<View>(null);
  const pendingHomeMenuActionRef = useRef<(() => void) | undefined>(undefined);
  const scheme = useColorScheme();
  const dark = scheme === "dark";
  const colors = useMemo(() => ({
    background: dark ? "#15191d" : "#f7f6f3", surface: dark ? "#24292d" : "#ffffff",
    ink: dark ? "#f4f4f2" : "#242a2d", muted: dark ? "#adb6b7" : "#637073",
    border: dark ? "#394246" : "#e1e2df", accent: "#ff9800", negative: "#cc634e",
    brandBackground: dark ? "#302920" : "#fff1db"
  }), [dark]);

  useEffect(() => {
    client.setForeground(AppState.currentState === "active");
    void client.start();
    const subscription = AppState.addEventListener("change", (status) => {
      const foreground = status === "active";
      client.setForeground(foreground);
      if (!foreground) {
        void mobileComposerDrafts.flush().catch(() => undefined);
        void mobileInteractionDrafts.flush().catch(() => undefined);
      }
    });
    return () => {
      subscription.remove();
      client.setForeground(false);
      void mobileComposerDrafts.flush().catch(() => undefined);
      void mobileInteractionDrafts.flush().catch(() => undefined);
    };
  }, []);

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
                  onFiles={() => setPage("files")} /> :
                page === "files" ? <FilesScreen {...common} onBack={() => setPage("task")} /> :
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
  const [targetId, setTargetId] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const targets = state.owner?.targets.filter((target) => target.state === TargetState.ACTIVE &&
    state.owner?.backends.some((backend) => backend.backendId === target.backendId
      && backend.capabilities?.capabilities.some((capability) => capability.name === capabilityNames.inputText && capability.support === CapabilitySupport.SUPPORTED))) ?? [];
  return <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
    <Back onPress={onBack} colors={colors} />
    <Text style={[styles.title, { color: colors.ink }]}>New task</Text>
    <Text style={[styles.description, { color: colors.muted }]}>Choose an active project on this Joko node. The task uses its current workspace and Backend.</Text>
    <Text style={[styles.section, { color: colors.muted }]}>Project</Text>
    {targets.length === 0 && <Text style={[styles.description, { color: colors.muted }]}>No project currently supports text tasks. Create one on a connected Joko client, then refresh.</Text>}
    {targets.map((target) => <Pressable key={target.targetId} accessibilityRole="radio" accessibilityState={{ selected: targetId === target.targetId }}
      accessibilityLabel={`Project ${target.displayName}`} onPress={() => setTargetId(target.targetId)}
      style={[styles.row, { backgroundColor: colors.surface, borderColor: targetId === target.targetId ? colors.accent : colors.border }]}>
      <Text style={[styles.label, { color: colors.ink }]}>{target.displayName}</Text>
      <Text style={[styles.caption, { color: colors.muted }]}>{state.owner?.backends.find((backend) => backend.backendId === target.backendId)?.displayName}</Text>
    </Pressable>)}
    <Field label="Task name" value={name} onChange={setName} placeholder="New task" colors={colors} />
    <Action label={state.busy ? "Creating…" : "Create task"} disabled={!targetId || state.busy || state.status !== "connected"}
      colors={colors} onPress={() => { setError(""); void client.create(targetId, name).then(() => {
        if (client.state.selectedId) onCreated();
      }).catch((failure) => setError(errorText(failure))); }} />
    {(error || state.error) && <Banner text={error || state.error || ""} colors={colors} />}
    {state.pending.some((item) => item.kind === "create") && <Action label="Check creation status" onPress={() => void client.reconcile()} colors={colors} />}
  </ScrollView>;
}

function TaskScreen({ colors, state, onBack, onHome, onNew, onFiles }: ScreenProps & {
  onBack: () => void; onHome: () => void; onNew: () => void; onFiles: () => void;
}) {
  const initialDraftIdentity = state.activeProfileId && state.selectedId
    ? { profileId: state.activeProfileId, sessionId: state.selectedId }
    : undefined;
  const [draft, setDraft] = useState(() => initialDraftIdentity
    ? mobileComposerDrafts.readSync(initialDraftIdentity) ?? ""
    : "");
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
  const [queueEdit, setQueueEdit] = useState<{
    readonly lease: MobileQueueEditLease;
    readonly profileId: string;
    readonly stashedDraft: string;
  }>();
  const [composerContentHeight, setComposerContentHeight] = useState(composerMinimumInputHeight);
  const [composerManualHeight, setComposerManualHeight] = useState<number | null>(null);
  const initialInteractions = client.taskInteractions();
  const [selectedInteractionId, setSelectedInteractionId] = useState<string | undefined>(initialInteractions[0]?.interactionId);
  const [interactionVisible, setInteractionVisible] = useState(initialInteractions.length > 0);
  const [runtimeControlsVisible, setRuntimeControlsVisible] = useState(false);
  const [contextVisible, setContextVisible] = useState(false);
  const [nativeTreeVisible, setNativeTreeVisible] = useState(false);
  const interactionSurfaceOwnerRef = useRef<string | undefined>(
    state.activeProfileId && state.selectedId ? `${state.activeProfileId}\u001f${state.selectedId}` : undefined
  );
  const interactionDraftsRef = useRef<{ readonly ownerKey?: string; readonly values: ReadonlyMap<string, MobileInteractionDraftIdentity> }>({
    values: new Map()
  });
  const queueEditRef = useRef(queueEdit);
  const draftIdentityRef = useRef<MobileComposerDraftIdentity | undefined>(initialDraftIdentity);
  const taskMountedRef = useRef(true);
  const keyboard = useMobileKeyboardState();
  const safeArea = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const draftIdentity = state.activeProfileId && state.selectedId
    ? { profileId: state.activeProfileId, sessionId: state.selectedId }
    : undefined;
  const draftIdentityKey = draftIdentity ? mobileComposerDraftIdentityKey(draftIdentity) : undefined;
  draftIdentityRef.current = draftIdentity;
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
    if (!identity) {
      if (!queueEditRef.current) setDraft("");
      setLoadedDraftKey(undefined);
      setDraftReady(true);
      return;
    }
    let current = true;
    const key = mobileComposerDraftIdentityKey(identity);
    const cached = mobileComposerDrafts.readSync(identity);
    if (!queueEditRef.current) setDraft(cached ?? "");
    setLoadedDraftKey(key);
    setDraftReady(cached !== null);
    void mobileComposerDrafts.read(identity).then((stored) => {
      if (!current || !taskMountedRef.current || queueEditRef.current
        || draftIdentityRef.current === undefined
        || mobileComposerDraftIdentityKey(draftIdentityRef.current) !== key) return;
      setDraft(stored ?? "");
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
    }
    void client.cancelQueueEdit(active.lease).catch((error) => {
      if (taskMountedRef.current) setLocalError(errorText(error));
    });
  }, [state.activeProfileId, state.detail?.queueItems, state.selectedId, state.status]);
  useEffect(() => {
    taskMountedRef.current = true;
    return () => {
      taskMountedRef.current = false;
      queueEditRef.current = undefined;
      client.leaveTask();
    };
  }, []);

  const openMessageActions = (row: TimelineRow): void => {
    if (!state.selectedId) return;
    setMessageAction({ sessionId: state.selectedId, row });
    setMessageActionsVisible(true);
  };
  const saveNormalDraft = (value: string, identity = draftIdentityRef.current): void => {
    setDraft(value);
    if (identity) mobileComposerDrafts.save(identity, value);
  };
  const appendToNormalDraft = (text: string): void => {
    const active = queueEditRef.current;
    const result = addToMobileComposer({
      visibleText: draft,
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
    const selected = messageAction;
    setMessageAction(undefined);
    if (!selected || client.state.selectedId !== selected.sessionId) return;
    const latest = timelineRows(client.state.window
      ?? [...client.state.older, ...(client.state.detail?.timeline ?? []), ...client.state.live])
      .find((row) => row.eventId === selected.row.eventId && row.completed);
    if (!latest) return;
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
    if (!profileId || !composerOwnerReady || interactions.length > 0) return;
    const stashedDraft = draft;
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
      setDraft(lease.text);
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
      }
    }).catch((error) => {
      if (taskMountedRef.current) setLocalError(errorText(error));
    });
  }, [interactionIdsKey, state.activeProfileId, state.selectedId]);
  const submitComposer = async (): Promise<void> => {
    setLocalError("");
    const active = queueEditRef.current;
    try {
      if (!active) {
        const identity = draftIdentityRef.current;
        if (!await client.send(draft)) return;
        if (!identity) {
          setDraft("");
          return;
        }
        const clearing = mobileComposerDrafts.clear(identity);
        if (draftIdentityRef.current
          && mobileComposerDraftIdentityKey(draftIdentityRef.current) === mobileComposerDraftIdentityKey(identity)
          && !queueEditRef.current) setDraft("");
        await clearing;
        return;
      }
      if (!await client.saveQueueEdit(active.lease, draft)) return;
      if (queueEditRef.current !== active) return;
      queueEditRef.current = undefined;
      setQueueEdit(undefined);
      setDraft(active.stashedDraft);
    } catch (error) {
      if (taskMountedRef.current) setLocalError(errorText(error));
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
          onPress={() => { setContextVisible(false); setRuntimeControlsVisible(false); setNativeTreeVisible(true); }} colors={colors} compact
          disabled={nativeTreeControls === undefined || state.busy || interactions.length > 0} />
        <Action label={contextControls?.usage ? `Context ${contextControls.usage.percent}%` : "Context"}
          onPress={() => { setNativeTreeVisible(false); setRuntimeControlsVisible(false); setContextVisible(true); }} colors={colors} compact
          disabled={contextControls === undefined || state.busy || interactions.length > 0} />
        <Action label="Controls" onPress={() => { setNativeTreeVisible(false); setContextVisible(false); setRuntimeControlsVisible(true); }} colors={colors} compact
          disabled={!runtimeControlsAvailable || state.busy || interactions.length > 0} />
        {client.canOpenFiles() && <Action label="Files" onPress={onFiles} colors={colors} compact />}
        <Action label="Refresh" onPress={() => void client.refresh()} colors={colors} compact />
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
        <View style={styles.messageActions}>
          <Pressable accessibilityRole="button" accessibilityLabel={`View context for ${item.label}`}
            disabled={state.historyBusy || state.status !== "connected"}
            onPress={() => { setLocalError(""); void client.around(item.eventId).catch((error) => setLocalError(errorText(error))); }}
            style={styles.inlineTouchAction}>
            <Text style={[styles.caption, { color: colors.accent }]}>View context</Text>
          </Pressable>
          {buildMobileMessageActions(item, { canDelete: client.canDeleteMessage(item.eventId) }).length > 0
            && <Pressable accessibilityRole="button" accessibilityLabel={`More actions for ${item.label}`}
              onPress={() => openMessageActions(item)} style={styles.inlineTouchAction}>
              <Text style={[styles.caption, { color: colors.accent }]}>More</Text>
            </Pressable>}
        </View>
      </View>} />
    {queueItems.length > 0 && <View style={styles.queueRegion}>
      <Text style={[styles.section, { color: colors.muted }]}>Queue</Text>
      <ScrollView nestedScrollEnabled style={styles.queueScroll} contentContainerStyle={styles.queueList}
        keyboardShouldPersistTaps="handled">
      {queueItems.map((item, index) => {
        const editing = queueEdit?.lease.queueItemId === item.queueItemId;
        const disabled = state.busy || state.status !== "connected" || queueMutationPending || interactions.length > 0 || (!!queueEdit && !editing);
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
    {queueEdit && <View style={[styles.queueEditBanner, { borderColor: colors.border, backgroundColor: colors.brandBackground }]}>
      <Text style={[styles.caption, styles.fill, { color: colors.ink }]} numberOfLines={1}>Editing queued input</Text>
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
      <View style={styles.composerRow}>
        <TextInput accessibilityLabel={queueEdit ? "Queued input" : "Task message"} multiline
          value={composerOwnerReady ? draft : ""}
          onChangeText={(value) => {
            const change = changeMobileComposerText(queueEditRef.current !== undefined, value);
            setDraft(change.visibleText);
            if (change.normalDraftToPersist !== null && draftIdentityRef.current) {
              mobileComposerDrafts.save(draftIdentityRef.current, change.normalDraftToPersist);
            }
          }}
          onContentSizeChange={(event) => setComposerContentHeight(Math.max(
            composerMinimumInputHeight,
            Math.ceil(event.nativeEvent.contentSize.height)
          ))}
          scrollEnabled={composerHeight.scrollEnabled}
          editable={!state.busy && composerOwnerReady} placeholder={!composerOwnerReady ? "Restoring saved draft…" : queueEdit ? "Edit queued input…" : "Message Joko…"}
          placeholderTextColor={colors.muted}
          style={[styles.composerInput, { color: colors.ink, height: composerHeight.visibleHeight }]} />
        <Action label={state.busy ? (queueEdit ? "Saving…" : "Sending…") : (queueEdit ? "Save edit" : "Send")} colors={colors} compact
          disabled={!composerOwnerReady || !draft.trim() || (!queueEdit && unknown) || state.busy || state.status !== "connected"}
          onPress={() => void submitComposer()} />
      </View>
    </View>}
    </MobileKeyboardAvoidingView>
    <MobileActionSheet visible={messageActionsVisible} items={messageActionItems} colors={colors}
      onClose={() => setMessageActionsVisible(false)} onAction={runMessageAction} />
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
      controls={runtimeControls} busy={state.busy || runtimeControlPending} colors={colors}
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

function FilesScreen({ colors, state, onBack }: ScreenProps & { onBack: () => void }) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<MobileFilesSearchMode>("name");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [localError, setLocalError] = useState("");
  const authorityKey = client.filesAuthorityKey();
  const connected = state.status === "connected" && authorityKey !== undefined;
  const files = state.files;
  const searching = query.trim().length > 0;

  useEffect(() => {
    if (!connected || !authorityKey) return;
    if (!files.open || files.authorityKey !== authorityKey || files.status === "offline" || files.status === "idle") {
      setLocalError("");
      void client.openFiles().catch((error) => setLocalError(errorText(error)));
    }
  }, [authorityKey, connected, files.authorityKey, files.open, files.status]);

  useEffect(() => () => client.closeFiles(), []);

  useEffect(() => {
    if (!files.open) return;
    const timer = setTimeout(() => {
      void client.searchFiles(query, mode, caseSensitive).catch((error) => setLocalError(errorText(error)));
    }, 250);
    return () => clearTimeout(timer);
  }, [caseSensitive, files.artifactsRevision, files.authorityKey, files.fileIndexRevision, files.open, mode, query]);

  const run = (action: () => Promise<void>): void => {
    setLocalError("");
    void action().catch((error) => setLocalError(errorText(error)));
  };
  const leave = (): void => { client.closeFiles(); onBack(); };
  const openResult = (result: MobileFileSearchResult): void => run(() => client.previewFileSearchResult(result));
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
        disabled={!connected || files.status === "loading"} onPress={() => run(() => client.refreshFiles())} />
    </View>

    {files.status === "offline" && <View style={[styles.connectionNotice, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={[styles.statusDot, { backgroundColor: colors.negative }]} />
      <Text style={[styles.caption, styles.fill, { color: colors.muted }]}>Offline · showing only the in-memory view already loaded for this task. New reads are paused.</Text>
    </View>}
    {(localError || files.error) && <Banner text={localError || files.error || ""} colors={colors} />}
    {files.watchStatus === "error" && files.watchError && <Banner text={`Live file refresh unavailable: ${files.watchError}`} colors={colors} />}

    <View accessibilityRole="tablist" style={styles.filesTabs}>
      <ModeTab label="Workspace" selected={files.location.kind === "workspace"}
        onPress={() => run(() => client.openFilesDirectory(""))} colors={colors} />
      <ModeTab label={`Generated${files.artifacts.length ? ` (${files.artifacts.length})` : ""}`}
        selected={files.location.kind === "generated"} onPress={() => {
          setLocalError("");
          try { client.openGeneratedFiles(); } catch (error) { setLocalError(errorText(error)); }
        }} colors={colors} />
    </View>

    <View style={styles.filesSearchControls}>
      <TextInput accessibilityLabel="Search files" placeholder={mode === "name" ? "Search file names" : "Search file contents"}
        placeholderTextColor={colors.muted} value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false}
        style={[styles.input, styles.searchInput, { color: colors.ink, backgroundColor: colors.surface, borderColor: colors.border }]} />
      {files.searchStatus === "searching" && <ActivityIndicator color={colors.accent} />}
    </View>
    <View style={styles.filesSearchOptions}>
      <View accessibilityRole="tablist" style={styles.filesSearchModes}>
        <ModeTab label="Name" selected={mode === "name"} onPress={() => setMode("name")} colors={colors} />
        <ModeTab label="Content" selected={mode === "content"} onPress={() => setMode("content")} colors={colors} />
      </View>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: caseSensitive }} accessibilityLabel="Case-sensitive file search"
        onPress={() => setCaseSensitive((value) => !value)} style={styles.caseChoice}>
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
            result={result} colors={colors} disabled={!connected} onPress={() => openResult(result)} />)}
          {files.searchStatus === "ready" && <Text style={[styles.caption, { color: colors.muted }]}>
            {files.searchResults.length} result{files.searchResults.length === 1 ? "" : "s"}
            {mode === "content" ? ` across ${files.searchTotalFiles} file${files.searchTotalFiles === 1 ? "" : "s"}` : ""}
          </Text>}
        </> : files.location.kind === "generated" ? <>
          <Text style={[styles.section, { color: colors.muted }]}>Generated by this task</Text>
          {files.artifacts.length === 0 && <Text style={[styles.description, { color: colors.muted }]}>No canonical Generated files are available for this task.</Text>}
          {files.artifacts.map((artifact) => <Pressable key={artifact.artifactId} accessibilityRole="button"
            accessibilityLabel={`Preview Generated file ${artifactTitle(artifact)}`} disabled={!connected}
            onPress={() => run(() => client.previewArtifact(artifact))}
            style={[styles.fileRow, { backgroundColor: colors.surface, borderColor: colors.border }, !connected && styles.disabled]}>
            <Text style={styles.fileGlyph}>◆</Text>
            <View style={styles.fill}><Text style={[styles.label, { color: colors.ink }]} numberOfLines={1}>{artifactTitle(artifact)}</Text>
              <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>
                {artifact.blob ? `${artifact.blob.mediaType || "application/octet-stream"} · ${formatByteSize(artifact.blob.byteSize)}` : "Blob unavailable"}
              </Text></View>
            <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
          </Pressable>)}
        </> : <>
          <View style={styles.sectionHeader}>
            <Text style={[styles.section, { color: colors.muted }]}>{files.location.path || "Workspace root"}</Text>
            {files.location.path && <Action label="Up" compact colors={colors} disabled={!connected}
              onPress={() => run(() => client.openFilesDirectory(workspaceParentPath(files.location.kind === "workspace" ? files.location.path : "")))} />}
          </View>
          {files.entries.length === 0 && <Text style={[styles.description, { color: colors.muted }]}>This directory is empty.</Text>}
          {files.entries.map((entry) => <Pressable key={entry.relativePath} accessibilityRole="button"
            accessibilityLabel={`${entry.kind === FileKind.DIRECTORY ? "Open directory" : "Preview file"} ${entry.displayName || workspaceBasename(entry.relativePath)}`}
            disabled={!connected} onPress={() => run(() => client.previewWorkspaceEntry(entry))}
            style={[styles.fileRow, { backgroundColor: colors.surface, borderColor: colors.border }, !connected && styles.disabled]}>
            <Text style={styles.fileGlyph}>{entry.kind === FileKind.DIRECTORY ? "▰" : "◇"}</Text>
            <View style={styles.fill}>
              <Text style={[styles.label, { color: colors.ink }]} numberOfLines={1}>{entry.displayName || workspaceBasename(entry.relativePath)}</Text>
              <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>
                {entry.kind === FileKind.DIRECTORY ? "Directory" : `${entry.mediaType || "application/octet-stream"} · ${formatByteSize(entry.revision?.byteSize ?? 0n)}`}
                {entry.hidden ? " · hidden" : ""}{entry.ignored ? " · ignored" : ""}
              </Text>
            </View>
            <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
          </Pressable>)}
        </>}
      </ScrollView>}
    <FilePreviewModal colors={colors} preview={files.preview} onClose={() => client.closeFilesPreview()} />
  </View>;
}

function FileSearchResultRow({ result, colors, disabled, onPress }: {
  result: MobileFileSearchResult; colors: Colors; disabled: boolean; onPress: () => void;
}) {
  const path = result.kind === "artifact" ? artifactTitle(result.artifact)
    : result.kind === "workspace-content" ? result.match.relativePath : result.relativePath;
  const detail = result.kind === "artifact"
    ? `Generated · ${result.artifact.blob?.mediaType || "application/octet-stream"}`
    : result.kind === "workspace-content"
      ? result.match.linePreview || "Content match"
      : "Workspace file";
  return <Pressable accessibilityRole="button" accessibilityLabel={`Preview ${path}`} disabled={disabled} onPress={onPress}
    style={[styles.fileRow, { backgroundColor: colors.surface, borderColor: colors.border }, disabled && styles.disabled]}>
    <Text style={styles.fileGlyph}>{result.kind === "artifact" ? "◆" : "◇"}</Text>
    <View style={styles.fill}><Text style={[styles.label, { color: colors.ink }]} numberOfLines={1}>{path}</Text>
      <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={2}>{detail}</Text></View>
    <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
  </Pressable>;
}

function FilePreviewModal({ colors, preview, onClose }: {
  colors: Colors; preview: MobileClient["state"]["files"]["preview"]; onClose: () => void;
}) {
  return <Modal visible={preview !== undefined} animationType="slide" onRequestClose={onClose}>
    <SafeAreaView style={[styles.fill, { backgroundColor: colors.background }]} edges={["top", "bottom", "left", "right"]}>
      {preview && <>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Back onPress={onClose} colors={colors} label="Files" />
          <View style={styles.fill}><Text style={[styles.title, { color: colors.ink }]} numberOfLines={1}>{preview.title}</Text>
            <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>{preview.sourceLabel}</Text></View>
        </View>
        <View style={[styles.previewMetadata, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <Text selectable style={[styles.caption, { color: colors.muted }]}>{preview.mediaType} · {formatByteSize(preview.byteSize)}</Text>
          {preview.kind === "text" && <Text style={[styles.caption, { color: colors.muted }]}>
            {preview.languageId || "plain text"} · lines {preview.totalLines} · bytes {preview.startByte.toString(10)}–{preview.endByte.toString(10)}
          </Text>}
        </View>
        {preview.kind === "loading" ? <Centered label="Loading the exact observed file revision…" colors={colors} />
          : preview.kind === "image" ? <ScrollView style={styles.fill} contentContainerStyle={styles.imagePreviewContainer}>
            <Image source={{ uri: preview.dataUri }} accessibilityLabel={preview.altText} resizeMode="contain" style={styles.imagePreview} />
            {(preview.widthPixels > 0 || preview.heightPixels > 0) && <Text style={[styles.caption, { color: colors.muted }]}>
              {preview.widthPixels} × {preview.heightPixels} pixels
            </Text>}
          </ScrollView>
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

function ModeTab({ label, selected, onPress, colors }: {
  label: string; selected: boolean; onPress: () => void; colors: Colors;
}) {
  return <Pressable accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected }} onPress={onPress}
    style={[styles.modeTab, selected && styles.modeTabSelected, { backgroundColor: selected ? colors.brandBackground : colors.surface }]}>
    <Text style={[styles.modeTabText, { color: colors.ink }]}>{label}</Text>
  </Pressable>;
}

function Action({ label, onPress, colors, disabled, compact, danger }: {
  label: string; onPress: () => void; colors: Colors; disabled?: boolean; compact?: boolean; danger?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={[styles.button, compact && styles.compact, { backgroundColor: disabled ? colors.border : danger ? colors.negative : colors.accent }]}>
    <Text style={[styles.buttonText, { color: disabled ? colors.muted : danger ? "#fff" : "#2b2316" }]}>{label}</Text>
  </Pressable>;
}

function Back({ onPress, colors, label = "Tasks" }: { onPress: () => void; colors: Colors; label?: string }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`Back to ${label.toLocaleLowerCase()}`} onPress={onPress} style={styles.back}>
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

function Field({ label, value, onChange, placeholder, colors, autoCapitalize, keyboardType }: {
  label: string; value: string; onChange: (text: string) => void; placeholder: string; colors: Colors;
  autoCapitalize?: "none"; keyboardType?: "url" | "number-pad";
}) {
  return <View style={styles.field}><Text style={[styles.caption, { color: colors.muted }]}>{label}</Text>
    <TextInput accessibilityLabel={label} value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={colors.muted}
      autoCapitalize={autoCapitalize} keyboardType={keyboardType} style={[styles.input, { color: colors.ink, backgroundColor: colors.surface, borderColor: colors.border }]} />
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
  const parts = item.input?.parts.map((part) => {
    if (part.content.case === "text") return part.content.value;
    if (part.content.case === "sessionMention") return `@${part.content.value.displayText || part.content.value.sessionId}`;
    return "[Attachment or reference]";
  }) ?? [];
  return parts.join(" ").trim() || "[Queued input]";
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
  fileRow: { borderWidth: 1, borderRadius: 14, minHeight: 68, paddingHorizontal: 14, paddingVertical: 10,
    flexDirection: "row", alignItems: "center", gap: 10 },
  fileGlyph: { width: 22, textAlign: "center", fontSize: 18 },
  previewMetadata: { marginHorizontal: 16, marginBottom: 8, borderWidth: 1, borderRadius: 12, padding: 12, gap: 3 },
  previewMessage: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 28 },
  imagePreviewContainer: { flexGrow: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 16 },
  imagePreview: { width: "100%", minHeight: 320, flex: 1 },
  textPreviewContainer: { paddingHorizontal: 16, paddingBottom: 36 },
  textPreview: { fontSize: 13, lineHeight: 20, fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }) }
});
