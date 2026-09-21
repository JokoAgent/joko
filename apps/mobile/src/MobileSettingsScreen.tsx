import { useEffect, useRef, useState } from "react";
import {
  Alert,
  BackHandler,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";
import { ConnectionState, DeviceKind, type Device } from "@joko/contracts";
import type { MobileClient, MobileState, SavedMobileConnection } from "./mobile-client";
import type { MobileThemePreference, MobileThemePreferenceState } from "./mobile-theme-preference";
import type { MobileDiagnosticsState } from "./mobile-diagnostics";

export interface MobileSettingsColors {
  readonly background: string;
  readonly surface: string;
  readonly ink: string;
  readonly muted: string;
  readonly border: string;
  readonly accent: string;
  readonly negative: string;
  readonly brandBackground: string;
}

export type MobileSettingsClient = Pick<MobileClient,
  "renameCurrentDevice" | "reconcile" | "dismissUnconfirmed">;

export interface MobileSettingsScreenProps {
  readonly colors: MobileSettingsColors;
  readonly state: MobileState;
  readonly foreground: boolean;
  readonly theme: MobileThemePreferenceState;
  readonly diagnostics: MobileDiagnosticsState;
  readonly client: MobileSettingsClient;
  readonly onThemeChange: (preference: MobileThemePreference) => Promise<void>;
  readonly onDiagnosticsEnabledChange: (enabled: boolean) => Promise<void>;
  readonly onDiagnosticsClear: () => Promise<void>;
  readonly onDiagnosticsExport: () => Promise<void>;
  readonly onBack: () => void;
  readonly onConnections: () => void;
  readonly onDevices: () => void;
  readonly appVersion?: string;
}

export interface MobileSettingsCurrentDevice {
  readonly profile: SavedMobileConnection;
  readonly device: Device;
  readonly ownerKey: string;
}

export function resolveMobileSettingsCurrentDevice(state: MobileState): MobileSettingsCurrentDevice | undefined {
  const profiles = state.saved.filter((profile) => profile.profileId === state.activeProfileId);
  if (profiles.length !== 1) return undefined;
  const profile = profiles[0]!;
  if (state.node?.serverId !== profile.serverId || state.owner?.server?.serverId !== profile.serverId
    || state.owner.server.apiVersion !== state.node.apiVersion || state.origin !== profile.origin) return undefined;
  const connections = state.owner.connections.filter((connection) => connection.connectionId === profile.connectionId);
  if (connections.length !== 1 || connections[0]!.connectionProfileId !== profile.profileId
    || connections[0]!.deviceId !== profile.deviceId || connections[0]!.state !== ConnectionState.CONNECTED) {
    return undefined;
  }
  const devices = state.owner.devices.filter((device) => device.deviceId === profile.deviceId);
  if (devices.length !== 1) return undefined;
  const device = devices[0]!;
  if (device.revoked || device.kind !== DeviceKind.MOBILE || !device.connectionIds.includes(profile.connectionId)) {
    return undefined;
  }
  return {
    profile,
    device,
    ownerKey: `${profile.profileId}\u001f${profile.serverId}\u001f${profile.connectionId}\u001f${profile.deviceId}`
  };
}

export function MobileSettingsScreen({ colors, state, foreground, theme, diagnostics, client, onThemeChange,
  onDiagnosticsEnabledChange, onDiagnosticsClear, onDiagnosticsExport, onBack,
  onConnections, onDevices, appVersion = Constants.expoConfig?.version || "Unknown" }: MobileSettingsScreenProps) {
  const current = resolveMobileSettingsCurrentDevice(state);
  const [editor, setEditor] = useState<{ readonly ownerKey: string; readonly original: string; readonly draft: string }>();
  const [savingName, setSavingName] = useState(false);
  const [renameUnknown, setRenameUnknown] = useState(false);
  const [localError, setLocalError] = useState("");
  const [notice, setNotice] = useState("");
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);
  const saveGeneration = useRef(0);
  const unknownReceiptSeen = useRef(false);
  const currentOwnerKey = current?.ownerKey;
  const currentOwnerKeyRef = useRef(currentOwnerKey);
  currentOwnerKeyRef.current = currentOwnerKey;
  const pendingRename = current === undefined ? undefined : state.pending.find(
    (item) => item.kind === "device-rename" && item.targetDeviceId === current.device.deviceId
  );
  const online = foreground && state.status === "connected";
  const canRename = current !== undefined && (current.device.version?.revision?.value ?? 0n) > 0n
    && online && !state.busy && !savingName
    && !renameUnknown && pendingRename === undefined;

  useEffect(() => () => { saveGeneration.current += 1; }, []);

  useEffect(() => {
    if (!editor || editor.ownerKey === currentOwnerKey) return;
    saveGeneration.current += 1;
    setSavingName(false);
    setRenameUnknown(false);
    unknownReceiptSeen.current = false;
    setEditor(undefined);
    setLocalError("The active Joko node or current device changed. The unfinished device-name draft was retired.");
  }, [currentOwnerKey, editor]);

  useEffect(() => {
    if (!renameUnknown || !editor) return;
    if (pendingRename) {
      unknownReceiptSeen.current = true;
      return;
    }
    if (!unknownReceiptSeen.current || !current || current.ownerKey !== editor.ownerKey) return;
    setRenameUnknown(false);
    unknownReceiptSeen.current = false;
    if (current.device.displayName === editor.draft.trim()) {
      setEditor(undefined);
      setNotice("Device name saved.");
    }
  }, [current, editor, pendingRename, renameUnknown]);

  const discardEditor = (): void => {
    if (savingName) return;
    setEditor(undefined);
    setLocalError("");
  };

  const requestCloseEditor = (): void => {
    if (!editor || savingName) return;
    if (editor.draft === editor.original) {
      discardEditor();
      return;
    }
    Alert.alert(
      "Discard device name changes?",
      "The edited device name has not been saved.",
      [
        { text: "Keep editing", style: "cancel" },
        { text: "Discard", style: "destructive", onPress: discardEditor }
      ]
    );
  };

  useEffect(() => {
    if (!editor) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      requestCloseEditor();
      return true;
    });
    return () => subscription.remove();
  }, [editor, savingName]);

  const saveName = async (): Promise<void> => {
    if (!editor || !current || editor.ownerKey !== current.ownerKey || !canRename) return;
    const value = editor.draft.trim();
    if (!value || value.length > 128) {
      setLocalError("Use a device name between 1 and 128 characters.");
      return;
    }
    const generation = ++saveGeneration.current;
    const ownerKey = editor.ownerKey;
    setSavingName(true);
    setLocalError("");
    try {
      const confirmed = await client.renameCurrentDevice(current.device.deviceId, value);
      if (saveGeneration.current !== generation || currentOwnerKeyRef.current !== ownerKey) return;
      if (!confirmed) {
        setRenameUnknown(true);
        unknownReceiptSeen.current = pendingRename !== undefined;
        setLocalError("The server result is unknown. The operation receipt was retained and the name was not sent again.");
        return;
      }
      setRenameUnknown(false);
      unknownReceiptSeen.current = false;
      setEditor(undefined);
      setNotice("Device name saved.");
    } catch (error) {
      if (saveGeneration.current === generation) setLocalError(errorText(error));
    } finally {
      if (saveGeneration.current === generation) setSavingName(false);
    }
  };

  const changeTheme = async (preference: MobileThemePreference): Promise<void> => {
    setLocalError("");
    try { await onThemeChange(preference); }
    catch (error) { setLocalError(errorText(error)); }
  };

  const runReceiptAction = async (action: () => Promise<void>): Promise<void> => {
    setLocalError("");
    try { await action(); }
    catch (error) { setLocalError(errorText(error)); }
  };

  const runDiagnosticsAction = async (action: () => Promise<void>, success: string): Promise<void> => {
    setLocalError("");
    setNotice("");
    try {
      await action();
      setNotice(success);
    } catch (error) {
      setLocalError(errorText(error));
    }
  };

  if (editor) {
    const editable = canRename && editor.ownerKey === currentOwnerKey;
    return <ScrollView contentContainerStyle={[styles.screen, { backgroundColor: colors.background }]}
      keyboardShouldPersistTaps="handled">
      <BackButton label="Settings" disabled={savingName} onPress={requestCloseEditor} colors={colors} />
      <Text style={[styles.title, { color: colors.ink }]}>Device name</Text>
      <Text style={[styles.description, { color: colors.muted }]}>
        This name identifies the current phone on this Joko node. It is sent only when you save.
      </Text>
      {!online && <Notice colors={colors} text={foreground
        ? "Reconnect to this exact Joko node to rename the current device."
        : "Return Joko to the foreground to rename the current device."} />}
      <View style={styles.field}>
        <Text style={[styles.caption, { color: colors.muted }]}>Device name</Text>
        <TextInput accessibilityLabel="Device name" value={editor.draft} editable={editable}
          onChangeText={(draft) => setEditor((value) => value ? { ...value, draft } : value)}
          maxLength={128} autoCorrect={false} placeholder="Device name" placeholderTextColor={colors.muted}
          style={[styles.input, !editable && styles.disabled,
            { color: colors.ink, backgroundColor: colors.surface, borderColor: colors.border }]} />
      </View>
      <Text style={[styles.caption, { color: colors.muted }]}>{editor.draft.trim().length}/128</Text>
      {(localError || state.error) && <ErrorNotice colors={colors} text={localError || state.error || ""} />}
      <View style={styles.actionRow}>
        <Button label="Cancel" colors={colors} disabled={savingName} onPress={requestCloseEditor} />
        <Button label={savingName ? "Saving…" : "Save name"} colors={colors}
          disabled={!editable || !editor.draft.trim() || editor.draft.trim().length > 128
            || editor.draft.trim() === editor.original}
          onPress={() => void saveName()} />
      </View>
    </ScrollView>;
  }

  return <ScrollView contentContainerStyle={[styles.screen, { backgroundColor: colors.background }]}>
    <BackButton label="Joko" onPress={onBack} colors={colors} />
    <Text style={[styles.title, { color: colors.ink }]}>Settings</Text>

    <Text style={[styles.section, { color: colors.muted }]}>Appearance</Text>
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      {(["system", "light", "dark"] as const).map((preference) => <ThemeChoice key={preference}
        preference={preference} selected={theme.preference === preference} colors={colors}
        disabled={theme.status === "loading" || theme.saving}
        onPress={() => void changeTheme(preference)} />)}
    </View>
    {theme.error && <ErrorNotice colors={colors} text={theme.error} />}

    <Text style={[styles.section, { color: colors.muted }]}>Current Joko node</Text>
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <InformationRow label="Name" value={state.node?.displayName || "Unavailable"} colors={colors} />
      <InformationRow label="Address" value={state.origin || "Unavailable"} colors={colors} selectable />
      <InformationRow label="Status" value={connectionLabel(state.status, foreground)} colors={colors} />
      <InformationRow label="Node version" value={state.node?.version || "Unknown"} colors={colors} />
      <InformationRow label="API version" value={state.node?.apiVersion || "Unknown"} colors={colors} />
    </View>
    <NavigationRow label="Connection settings" description="Automatic entry and exact saved connections"
      colors={colors} onPress={onConnections} />

    <Text style={[styles.section, { color: colors.muted }]}>This phone</Text>
    {current ? <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <InformationRow label="Name" value={current.device.displayName} colors={colors} />
      <InformationRow label="Platform" value={current.device.platform || platformLabel()} colors={colors} />
      <InformationRow label="App version" value={current.device.appVersion || "Unknown"} colors={colors} />
      <InformationRow label="Device ID" value={current.device.deviceId} colors={colors} selectable />
      <View style={styles.actionRow}>
        <Button label="Copy device ID" colors={colors} onPress={() => {
          void Clipboard.setStringAsync(current.device.deviceId).then(() => setNotice("Device ID copied."))
            .catch((error) => setLocalError(errorText(error)));
        }} />
        <Button label="Rename this phone" colors={colors} disabled={!canRename} onPress={() => {
          setLocalError("");
          setNotice("");
          setRenameUnknown(false);
          unknownReceiptSeen.current = false;
          setEditor({ ownerKey: current.ownerKey, original: current.device.displayName, draft: current.device.displayName });
        }} />
      </View>
    </View> : <Notice colors={colors}
      text="The current phone cannot be matched exactly to the active saved profile and authenticated node snapshot." />}
    {!online && current && <Notice colors={colors} text={foreground
      ? "Showing the last verified device identity. Reconnect to rename it."
      : "Showing the last verified device identity. Device changes are read-only in the background."} />}
    <NavigationRow label="All devices" description="Inspect devices authorized by this Joko node"
      colors={colors} onPress={onDevices} />

    {pendingRename && <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.warning, { color: colors.negative }]}>
        {pendingRename.state === "unknown" ? "Device-name result unknown" : "Awaiting durable device-name result"}
        {` · ${pendingRename.operationId}`}
      </Text>
      <Text style={[styles.caption, { color: colors.muted }]}>The name is never sent again automatically.</Text>
      <View style={styles.actionRow}>
        <Button label="Check status" colors={colors} disabled={!online || state.busy}
          onPress={() => void runReceiptAction(() => client.reconcile())} />
        {pendingRename.state === "unknown" && <Button label="Verify and clear" colors={colors}
          disabled={!online || state.busy} onPress={() => Alert.alert(
            "Clear this receipt?",
            "Joko will first verify that the current node has no operation with this ID. It will not repeat the rename.",
            [
              { text: "Keep checking", style: "cancel" },
              { text: "Verify and clear", onPress: () => void runReceiptAction(
                () => client.dismissUnconfirmed(pendingRename.operationId)
              ) }
            ]
          )} />}
      </View>
    </View>}

    <Text style={[styles.section, { color: colors.muted }]}>About</Text>
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <InformationRow label="Joko app" value={appVersion} colors={colors} />
      <InformationRow label="Platform" value={platformLabel()} colors={colors} />
      <InformationRow label="Node" value={state.node?.version || "Unknown"} colors={colors} />
      <InformationRow label="API" value={state.node?.apiVersion || "Unknown"} colors={colors} />
    </View>

    <Text style={[styles.section, { color: colors.muted }]}>Diagnostics</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Local diagnostics"
      accessibilityState={{ expanded: diagnosticsExpanded }}
      onPress={() => setDiagnosticsExpanded((value) => !value)}
      style={[styles.navigationRow, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.fill}>
        <Text style={[styles.label, { color: colors.ink }]}>Local diagnostics</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>
          {diagnostics.enabled ? `On · ${diagnostics.eventCount} retained events` : "Off · no new events are recorded"}
        </Text>
      </View>
      <Text style={[styles.chevron, { color: colors.muted }]}>{diagnosticsExpanded ? "⌃" : "⌄"}</Text>
    </Pressable>
    {diagnosticsExpanded && <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.description, { color: colors.ink }]}>Device-private diagnostic recording</Text>
      <Text style={[styles.caption, { color: colors.muted }]}>
        Off by default. Joko keeps at most 500 allowlisted lifecycle, connection-state, and timing events for 7 days.
        Message text, files, paths, IDs, credentials, raw errors, audio, and transcripts are never included.
      </Text>
      <View style={styles.toggleRow}>
        <View style={styles.fill}>
          <Text style={[styles.label, { color: colors.ink }]}>Record local diagnostics</Text>
          <Text style={[styles.caption, { color: colors.muted }]}>
            {diagnostics.status === "loading" ? "Loading device preference…"
              : diagnostics.enabled ? "Recording allowlisted events on this phone" : "Recording is off"}
          </Text>
        </View>
        <Switch accessibilityLabel="Record local diagnostics" value={diagnostics.enabled}
          disabled={diagnostics.status === "loading" || diagnostics.saving || diagnostics.exporting}
          trackColor={{ false: colors.border, true: colors.accent }} thumbColor={colors.surface}
          onValueChange={(value) => void runDiagnosticsAction(
            () => onDiagnosticsEnabledChange(value),
            value ? "Local diagnostic recording enabled." : "Local diagnostic recording disabled."
          )} />
      </View>
      <InformationRow label="Retained" value={`${diagnostics.eventCount} / 500 events`} colors={colors} />
      <InformationRow label="Retention" value="7 days on this phone" colors={colors} />
      <View style={styles.actionRow}>
        <Button label={diagnostics.exporting ? "Exporting…" : "Export diagnostics"} colors={colors}
          disabled={diagnostics.status === "loading" || diagnostics.saving || diagnostics.exporting}
          onPress={() => void runDiagnosticsAction(onDiagnosticsExport, "Local diagnostics sent to the system share sheet.")} />
        <Button label="Clear diagnostics" colors={colors}
          disabled={diagnostics.status === "loading" || diagnostics.saving || diagnostics.exporting
            || diagnostics.eventCount === 0 && diagnostics.status === "ready"}
          onPress={() => Alert.alert(
            "Clear local diagnostics?",
            "This permanently removes the diagnostic events retained on this phone. Recording stays in its current state.",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Clear", style: "destructive", onPress: () => void runDiagnosticsAction(
                onDiagnosticsClear,
                "Local diagnostics cleared."
              ) }
            ]
          )} />
      </View>
      {diagnostics.error && <ErrorNotice colors={colors} text={diagnostics.error} />}
    </View>}
    {notice && <Text accessibilityLiveRegion="polite" style={[styles.noticeText, { color: colors.ink,
      backgroundColor: colors.brandBackground, borderColor: colors.accent }]}>{notice}</Text>}
    {(localError || state.error) && <ErrorNotice colors={colors} text={localError || state.error || ""} />}
  </ScrollView>;
}

function ThemeChoice({ preference, selected, disabled, colors, onPress }: {
  readonly preference: MobileThemePreference;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly colors: MobileSettingsColors;
  readonly onPress: () => void;
}) {
  const label = preference === "system" ? "System" : preference === "light" ? "Light" : "Dark";
  const description = preference === "system" ? "Follow this phone's appearance" : `Always use ${label.toLocaleLowerCase()} appearance`;
  return <Pressable accessibilityRole="radio" accessibilityLabel={`${label} appearance`}
    accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress}
    style={[styles.choice, disabled && styles.disabled]}>
    <View style={[styles.radio, { borderColor: selected ? colors.accent : colors.border }]}>
      {selected && <View style={[styles.radioDot, { backgroundColor: colors.accent }]} />}
    </View>
    <View style={styles.fill}>
      <Text style={[styles.label, { color: colors.ink }]}>{label}</Text>
      <Text style={[styles.caption, { color: colors.muted }]}>{description}</Text>
    </View>
  </Pressable>;
}

function NavigationRow({ label, description, colors, onPress }: {
  readonly label: string;
  readonly description: string;
  readonly colors: MobileSettingsColors;
  readonly onPress: () => void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
    style={[styles.navigationRow, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <View style={styles.fill}>
      <Text style={[styles.label, { color: colors.ink }]}>{label}</Text>
      <Text style={[styles.caption, { color: colors.muted }]}>{description}</Text>
    </View>
    <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
  </Pressable>;
}

function BackButton({ label, disabled, onPress, colors }: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  readonly colors: MobileSettingsColors;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`Back to ${label.toLocaleLowerCase()}`}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={[styles.back, disabled && styles.disabled]}>
    <Text style={[styles.backText, { color: colors.accent }]}>‹  {label}</Text>
  </Pressable>;
}

function Button({ label, disabled, onPress, colors }: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  readonly colors: MobileSettingsColors;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress}
    style={[styles.button, { backgroundColor: disabled ? colors.border : colors.accent }]}>
    <Text style={[styles.buttonText, { color: disabled ? colors.muted : "#2b2316" }]}>{label}</Text>
  </Pressable>;
}

function InformationRow({ label, value, colors, selectable }: {
  readonly label: string;
  readonly value: string;
  readonly colors: MobileSettingsColors;
  readonly selectable?: boolean;
}) {
  return <View style={styles.infoRow}>
    <Text style={[styles.infoLabel, { color: colors.muted }]}>{label}</Text>
    <Text selectable={selectable} style={[styles.infoValue, { color: colors.ink }]}>{value}</Text>
  </View>;
}

function Notice({ text, colors }: { readonly text: string; readonly colors: MobileSettingsColors }) {
  return <Text style={[styles.noticeText, { color: colors.ink, backgroundColor: colors.brandBackground,
    borderColor: colors.accent }]}>{text}</Text>;
}

function ErrorNotice({ text, colors }: { readonly text: string; readonly colors: MobileSettingsColors }) {
  return <Text accessibilityRole="alert" style={[styles.error, { color: colors.negative }]}>{text}</Text>;
}

function connectionLabel(status: MobileState["status"], foreground: boolean): string {
  if (!foreground) return "Background · read-only";
  if (status === "connected") return "Connected";
  if (status === "connecting") return "Reconnecting";
  if (status === "revoked") return "Revoked";
  if (status === "offline") return "Offline";
  return status === "starting" ? "Starting" : "Not connected";
}

function platformLabel(): string {
  return Platform.OS === "ios" ? "iOS" : Platform.OS === "android" ? "Android" : Platform.OS;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "The Settings action failed.";
}

const styles = StyleSheet.create({
  screen: { flexGrow: 1, padding: 20, gap: 14, paddingBottom: 36 },
  fill: { flex: 1 },
  title: { fontSize: 26, fontWeight: "700" },
  description: { fontSize: 15, lineHeight: 22 },
  caption: { fontSize: 13, lineHeight: 18 },
  label: { fontSize: 16, fontWeight: "600" },
  section: { fontSize: 13, fontWeight: "700", marginTop: 12, textTransform: "uppercase" },
  card: { borderWidth: 1, borderRadius: 14, padding: 16, gap: 8 },
  choice: { minHeight: 54, flexDirection: "row", alignItems: "center", gap: 12 },
  radio: { width: 24, height: 24, borderWidth: 2, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  radioDot: { width: 12, height: 12, borderRadius: 6 },
  navigationRow: { minHeight: 68, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14,
    paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 10 },
  chevron: { fontSize: 28 },
  infoRow: { minHeight: 38, flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 4 },
  infoLabel: { width: 96, fontSize: 13, lineHeight: 20, fontWeight: "600" },
  infoValue: { flex: 1, fontSize: 14, lineHeight: 20 },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 6 },
  toggleRow: { minHeight: 54, flexDirection: "row", alignItems: "center", gap: 12 },
  button: { minHeight: 46, borderRadius: 12, alignItems: "center", justifyContent: "center",
    paddingHorizontal: 16, paddingVertical: 9 },
  buttonText: { fontSize: 15, fontWeight: "700" },
  back: { minHeight: 44, justifyContent: "center" },
  backText: { fontSize: 16, fontWeight: "600" },
  field: { gap: 7 },
  input: { borderWidth: 1, borderRadius: 12, minHeight: 48, paddingHorizontal: 14, fontSize: 16 },
  disabled: { opacity: 0.55 },
  warning: { fontSize: 14, lineHeight: 20 },
  error: { paddingHorizontal: 4, paddingVertical: 8, fontSize: 14, lineHeight: 20 },
  noticeText: { borderWidth: 1, borderRadius: 14, padding: 12, fontSize: 14, lineHeight: 20 }
});
