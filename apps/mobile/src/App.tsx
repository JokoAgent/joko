import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator, Alert, AppState, FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView,
  StyleSheet, Text, TextInput, useColorScheme, View
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { SvgXml } from "react-native-svg";
import { StatusBar } from "expo-status-bar";
import { randomUUID } from "expo-crypto";
import { CapabilitySupport, QueueItemState, TargetState, capabilityNames } from "@joko/contracts";
import { MobileConnectionStage } from "./MobileConnectionStage";
import { MobileClient } from "./mobile-client";
import {
  mobileConnectionAppIcon,
  mobileConnectionArtworkFrame,
  mobileLoadingIllustration,
  nextConnectionArtworkGroupIndex,
  type ConnectionArtworkVariant
} from "./connection-artwork";
import { mobileNetwork } from "./network";
import { mobileStorage } from "./storage";
import { timelineRows } from "./timeline";

const client = new MobileClient(mobileNetwork, mobileStorage, randomUUID, Platform.OS);
type Page = "connection" | "sessions" | "new" | "task";

export function App() {
  const state = useSyncExternalStore((listener) => client.subscribe(listener), () => client.state);
  const [page, setPage] = useState<Page>("connection");
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
    const subscription = AppState.addEventListener("change", (status) => client.setForeground(status === "active"));
    return () => { subscription.remove(); client.setForeground(false); };
  }, []);

  useEffect(() => {
    if (state.status === "connected" && page === "connection") setPage("sessions");
    if ((state.status === "unpaired" || state.status === "revoked") && page !== "connection") setPage("connection");
    if (page === "task" && !state.selectedId) setPage("sessions");
  }, [state.status, state.selectedId, page]);

  const common = { colors, state };
  return (
    <SafeAreaProvider>
      <View style={[styles.root, { backgroundColor: colors.background }]}>
        <StatusBar style={dark ? "light" : "dark"} />
        {state.status === "starting" ? <SafeAreaView style={styles.fill} edges={["top", "left", "right", "bottom"]}>
          <StartupLoading colors={colors} dark={dark} />
        </SafeAreaView> :
          page === "connection" ? <ConnectionScreen {...common} dark={dark} onConnected={() => setPage("sessions")} /> :
          <SafeAreaView style={styles.fill} edges={["top", "left", "right", "bottom"]}>
            {page === "new" ? <NewTaskScreen {...common} onBack={() => setPage("sessions")} onCreated={() => setPage("task")} /> :
              page === "task" ? <TaskScreen {...common} onBack={() => setPage("sessions")} /> :
              <SessionsScreen {...common} onNew={() => setPage("new")} onSelect={() => setPage("task")} />}
          </SafeAreaView>}
      </View>
    </SafeAreaProvider>
  );
}

type Colors = { background: string; surface: string; ink: string; muted: string; border: string; accent: string; negative: string; brandBackground: string };
type ScreenProps = { colors: Colors; state: MobileClient["state"] };

function ConnectionScreen({ colors, state, dark, onConnected }: ScreenProps & { dark: boolean; onConnected: () => void }) {
  const [origin, setOrigin] = useState(state.origin ?? "");
  const [deviceName, setDeviceName] = useState(`${Platform.OS === "ios" ? "iPhone/iPad" : "Android"} Joko`);
  const [code, setCode] = useState("");
  const [inspected, setInspected] = useState(false);
  const [localError, setLocalError] = useState("");
  const [automatic, setAutomatic] = useState(state.saved?.automatic ?? false);
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
    try { await client.pair(origin, code, deviceName, automatic); setCode(""); onConnected(); } catch (error) { setLocalError(errorText(error)); }
  };
  const toggleAutomatic = () => {
    const next = !automatic;
    setAutomatic(next);
    if (!next && state.saved?.automatic) {
      void client.disableAutomaticEntry().catch((error) => {
        setAutomatic(true);
        setLocalError(errorText(error));
      });
    }
  };
  return <MobileConnectionStage
    artworkId={artwork.id}
    artworkSource={artwork.source}
    iconSource={appIcon}
    colors={{ brandBackground: colors.brandBackground, ink: colors.ink, muted: colors.muted }}
    onArtworkPress={() => setArtworkVariant((current) => current === "base" ? "alt" : "base")}
    onIconPress={() => { setArtworkGroupIndex((current) => nextConnectionArtworkGroupIndex(current)); setArtworkVariant("base"); }}
  >
    <Text style={[styles.title, { color: colors.ink }]}>Connect to a Joko node</Text>
    <Text style={[styles.description, { color: colors.muted }]}>Choose a saved node or pair another one. Pairing grants this device access; the node owner can revoke it at any time.</Text>
    <AutomaticEntryChoice checked={automatic} disabled={state.busy || state.status === "connecting"} onPress={toggleAutomatic} colors={colors} />
    {state.status === "revoked" && <Banner text={state.error || "This device needs to pair again."} colors={colors} />}
    {state.saved && <>
      <Text style={[styles.section, { color: colors.muted }]}>Saved node</Text>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.label, { color: colors.ink }]}>{state.saved.displayName}</Text>
        <Text selectable style={[styles.caption, { color: colors.muted }]}>{state.saved.origin}</Text>
        <Text selectable style={[styles.caption, { color: colors.muted }]}>Identity: {state.saved.serverId}</Text>
        <Action label={state.status === "connecting" ? "Connecting…" : "Connect to saved node"} onPress={() => {
          setLocalError("");
          void client.connectSaved(automatic).then(onConnected).catch((error) => setLocalError(errorText(error)));
        }} colors={colors} disabled={state.busy || state.status === "connecting"} />
      </View>
      <Text style={[styles.section, { color: colors.muted }]}>Pair another node</Text>
    </>}
    <Field label="Joko node address" value={origin} onChange={(value) => { setOrigin(value); setInspected(false); client.cancel(); }} placeholder="http://192.168.1.20:4318" colors={colors} autoCapitalize="none" keyboardType="url" />
    {origin.trim().startsWith("http://") && <Text style={[styles.warning, { color: colors.negative }]}>Local HTTP is not encrypted. Pair only on a trusted private network; anyone on that network may observe traffic.</Text>}
    <Action label={state.busy ? "Checking…" : "Check node identity"} onPress={inspect} colors={colors} disabled={state.busy || !origin.trim()} />
    {inspected && state.node && <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.label, { color: colors.ink }]}>{state.node.displayName}</Text>
      <Text selectable style={[styles.caption, { color: colors.muted }]}>Identity: {state.node.serverId}</Text>
      <Text style={[styles.caption, { color: colors.muted }]}>{state.node.pairingEnabled ? "Pairing available" : "Pairing is closed"}</Text>
    </View>}
    {inspected && state.node?.pairingEnabled && <>
      <Field label="Device name" value={deviceName} onChange={setDeviceName} placeholder="My phone" colors={colors} />
      <Action label={state.busy ? "Requesting…" : "Request pairing"} onPress={() => {
        setLocalError(""); void client.requestPairing(origin, deviceName).catch((error) => setLocalError(errorText(error)));
      }} colors={colors} disabled={state.busy || !deviceName.trim()} />
      {state.challenge && <>
        <Text style={[styles.description, { color: colors.muted }]}>Ask the Joko node owner for the code issued for this pairing request. Enter it before it expires.</Text>
        <Field label="Pairing code" value={code} onChange={setCode} placeholder="Code shown on the Joko node" colors={colors} keyboardType="number-pad" />
        <Action label={state.busy ? "Pairing…" : "Pair this device"} onPress={pair} colors={colors} disabled={state.busy || !code.trim()} />
      </>}
    </>}
    {(localError || state.error) && <Banner text={localError || state.error || ""} colors={colors} />}
    {state.status === "offline" && <Action label="Retry saved connection" onPress={() => void client.refresh()} colors={colors} />}
  </MobileConnectionStage>;
}

function SessionsScreen({ colors, state, onNew, onSelect }: ScreenProps & { onNew: () => void; onSelect: () => void }) {
  const [search, setSearch] = useState("");
  const sessions = state.owner?.sessions.filter((session) =>
    !session.archived && (session.displayName.toLocaleLowerCase().includes(search.toLocaleLowerCase())
      || state.owner?.targets.find((target) => target.targetId === session.targetId)?.displayName.toLocaleLowerCase().includes(search.toLocaleLowerCase()))) ?? [];
  return <View style={styles.fill}>
    <View style={styles.header}>
      <View><Text style={[styles.title, { color: colors.ink }]}>Tasks</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{state.node?.displayName || "Joko node"} · {state.status}</Text></View>
      <Action label="New task" onPress={onNew} colors={colors} compact disabled={state.status !== "connected"} />
    </View>
    {state.error && <Banner text={state.error} colors={colors} />}
    {state.status === "offline" && <Action label="Reconnect" onPress={() => void client.refresh()} colors={colors} />}
    <TextInput accessibilityLabel="Search tasks" placeholder="Search tasks" placeholderTextColor={colors.muted} value={search} onChangeText={setSearch}
      style={[styles.input, styles.search, { color: colors.ink, backgroundColor: colors.surface, borderColor: colors.border }]} />
    <FlatList data={sessions} keyExtractor={(item) => item.sessionId}
      ListEmptyComponent={<Centered label={state.status !== "connected" ? "Reconnect to load tasks" : search ? "No matching tasks" : "No tasks yet"} colors={colors} />}
      renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={`Open task ${item.displayName || "Untitled"}`}
        onPress={() => { void client.select(item.sessionId).then(onSelect).catch(() => undefined); }}
        style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.fill}><Text style={[styles.label, { color: colors.ink }]} numberOfLines={1}>{item.displayName || "Untitled task"}</Text>
          <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>{state.owner?.targets.find((target) => target.targetId === item.targetId)?.displayName || "Dialogue"} · {sessionState(item.state)}</Text></View>
        <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
      </Pressable>}
      refreshing={state.status === "connecting"} onRefresh={() => void client.refresh()}
      contentContainerStyle={styles.list} />
    <Text style={[styles.section, { color: colors.muted }]}>Paired devices</Text>
    <ScrollView horizontal style={styles.devices} contentContainerStyle={styles.deviceList}>
      {state.owner?.devices.map((device) => <Text key={device.deviceId} style={[styles.deviceChip, { color: colors.ink, borderColor: colors.border }]}>
        {device.displayName} · {device.revoked ? "revoked" : "paired"}
      </Text>)}
    </ScrollView>
  </View>;
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

function TaskScreen({ colors, state, onBack }: ScreenProps & { onBack: () => void }) {
  const [draft, setDraft] = useState("");
  const [localError, setLocalError] = useState("");
  const session = state.detail?.sessions.find((item) => item.sessionId === state.selectedId)
    || state.owner?.sessions.find((item) => item.sessionId === state.selectedId);
  const rows = timelineRows(state.window ?? [...state.older, ...(state.detail?.timeline ?? []), ...state.live]);
  const unknown = state.pending.some((item) => item.kind === "send" && item.sessionId === state.selectedId && item.state === "unknown");
  return <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <View style={styles.header}><View style={styles.fill}><Back onPress={onBack} colors={colors} />
      <Text style={[styles.title, { color: colors.ink }]} numberOfLines={1}>{session?.displayName || "Task"}</Text>
      <Text style={[styles.caption, { color: colors.muted }]}>{session ? sessionState(session.state) : "Loading…"}</Text></View>
      <Action label="Refresh" onPress={() => void client.refresh()} colors={colors} compact />
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
        <Pressable accessibilityRole="button" accessibilityLabel={`View context for ${item.label}`}
          disabled={state.historyBusy || state.status !== "connected"}
          onPress={() => { setLocalError(""); void client.around(item.eventId).catch((error) => setLocalError(errorText(error))); }}>
          <Text style={[styles.caption, { color: colors.accent }]}>View context</Text>
        </Pressable>
      </View>} />
    {state.detail?.queueItems.filter((item) => item.sessionId === state.selectedId).map((item) => <Text key={item.queueItemId}
      style={[styles.caption, styles.queue, { color: colors.muted }]}>Queue · {queueState(item.state)} · {item.input?.parts.flatMap((part) => part.content.case === "text" ? [part.content.value] : []).join(" ")}</Text>)}
    {state.pending.filter((item) => item.sessionId === state.selectedId).map((item) => <View key={item.operationId} style={styles.pending}>
      <Text style={[styles.warning, { color: colors.negative }]}>{item.state === "unknown" ? "Delivery unknown" : "Awaiting durable result"} · {item.operationId}</Text>
      <Action label="Check status" onPress={() => void client.reconcile()} colors={colors} compact />
      {item.state === "unknown" && <Action label="Clear unconfirmed receipt" onPress={() => Alert.alert(
        "Clear this receipt?", "Only continue if you have checked the task. Joko will verify the operation is absent before clearing this local warning; it will not send the message again.",
        [{ text: "Keep checking", style: "cancel" }, { text: "Verify and clear", onPress: () => {
          void client.dismissUnconfirmed(item.operationId).catch((error) => setLocalError(errorText(error)));
        } }]
      )} colors={colors} compact />}
    </View>)}
    {localError && <Banner text={localError} colors={colors} />}
    <View style={[styles.composer, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <TextInput accessibilityLabel="Task message" multiline value={draft} onChangeText={setDraft} placeholder="Message Joko…" placeholderTextColor={colors.muted}
        style={[styles.composerInput, { color: colors.ink }]} />
      <Action label={state.busy ? "Sending…" : "Send"} colors={colors} compact disabled={!draft.trim() || unknown || state.busy || state.status !== "connected"}
        onPress={() => { setLocalError(""); void client.send(draft).then((accepted) => { if (accepted) setDraft(""); }).catch((error) => setLocalError(errorText(error))); }} />
    </View>
  </KeyboardAvoidingView>;
}

function Action({ label, onPress, colors, disabled, compact }: { label: string; onPress: () => void; colors: Colors; disabled?: boolean; compact?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={[styles.button, compact && styles.compact, { backgroundColor: disabled ? colors.border : colors.accent }]}>
    <Text style={styles.buttonText}>{label}</Text>
  </Pressable>;
}

function Back({ onPress, colors }: { onPress: () => void; colors: Colors }) {
  return <Pressable accessibilityRole="button" accessibilityLabel="Back to tasks" onPress={onPress} style={styles.back}>
    <Text style={[styles.backText, { color: colors.accent }]}>‹  Tasks</Text>
  </Pressable>;
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
function errorText(error: unknown): string { return error instanceof Error ? error.message : "The Joko node is unavailable."; }
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
  search: { marginHorizontal: 16, marginVertical: 10 }, warning: { paddingHorizontal: 16, paddingVertical: 8, fontSize: 14, lineHeight: 20 },
  card: { borderWidth: 1, borderRadius: 14, padding: 16, gap: 6 },
  button: { minHeight: 48, borderRadius: 12, alignItems: "center", justifyContent: "center", paddingHorizontal: 18, paddingVertical: 10 },
  buttonText: { color: "#2b2316", fontSize: 15, fontWeight: "700" }, compact: { minHeight: 44 },
  header: { padding: 16, flexDirection: "row", alignItems: "center", gap: 10 }, back: { minHeight: 44, justifyContent: "center" },
  backText: { fontSize: 16, fontWeight: "600" }, list: { padding: 16, gap: 8, flexGrow: 1 },
  row: { borderWidth: 1, borderRadius: 14, minHeight: 68, padding: 14, flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 8 },
  chevron: { fontSize: 28 }, center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 },
  startupLoading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  loadingArtwork: { width: "82%", maxWidth: 420, height: 360 },
  devices: { flexGrow: 0, maxHeight: 50 }, deviceList: { paddingHorizontal: 16, gap: 8 },
  deviceChip: { borderWidth: 1, borderRadius: 18, overflow: "hidden", paddingHorizontal: 12, paddingVertical: 8 },
  message: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 6, marginBottom: 8 },
  historyActions: { gap: 8 },
  queue: { paddingHorizontal: 18, paddingVertical: 6 }, pending: { paddingHorizontal: 12, flexWrap: "wrap", flexDirection: "row", alignItems: "center" },
  composer: { flexDirection: "row", borderTopWidth: 1, paddingHorizontal: 12, paddingVertical: 8, alignItems: "flex-end", gap: 10 },
  composerInput: { flex: 1, minHeight: 44, maxHeight: 144, fontSize: 16, paddingVertical: 8 }
});
