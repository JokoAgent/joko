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
import {
  MOBILE_SUPPORTED_LOCALES,
  type MobileLocalePreference,
  type MobileLocalePreferenceState,
  type MobileSupportedLocale
} from "./mobile-locale-preference";
import { mobileMessage, type MobileMessageKey } from "./mobile-messages";
import { MobileVoiceDictionaryScreen } from "./MobileVoiceDictionaryScreen";
import type {
  MobileVoiceDictionaryEditOutcome,
  MobileVoiceDictionaryStoreState
} from "./mobile-voice-dictionary-store";
import { MobileUpdateSettingsSection, type MobileUpdateActions } from "./MobileUpdateSurface";
import type { MobileUpdateControllerState } from "./mobile-update-controller";

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
  readonly locale: MobileLocalePreferenceState;
  readonly diagnostics: MobileDiagnosticsState;
  readonly voiceDictionary: MobileVoiceDictionaryStoreState;
  readonly updates: MobileUpdateControllerState;
  readonly updateActions: Pick<MobileUpdateActions, "onChannelChange" | "onCheck" | "onReset">;
  readonly client: MobileSettingsClient;
  readonly onThemeChange: (preference: MobileThemePreference) => Promise<void>;
  readonly onLocaleChange: (preference: MobileLocalePreference) => Promise<void>;
  readonly onDiagnosticsEnabledChange: (enabled: boolean) => Promise<void>;
  readonly onDiagnosticsClear: () => Promise<void>;
  readonly onDiagnosticsExport: () => Promise<void>;
  readonly onVoiceDictionaryRetry: () => Promise<void>;
  readonly onVoiceDictionaryReset: () => Promise<void>;
  readonly onVoiceInstructionsChange: (value: string) => Promise<void>;
  readonly onVoiceAutoLearningChange: (enabled: boolean) => Promise<void>;
  readonly onVoiceDictionaryAdd: (value: string) => Promise<void>;
  readonly onVoiceDictionaryEdit: (id: string, text: string, aliases: string) => Promise<MobileVoiceDictionaryEditOutcome>;
  readonly onVoiceDictionaryDelete: (id: string) => Promise<void>;
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

export function MobileSettingsScreen({ colors, state, foreground, theme, locale, diagnostics, voiceDictionary, client, onThemeChange,
  onLocaleChange, onDiagnosticsEnabledChange, onDiagnosticsClear, onDiagnosticsExport, onBack,
  onVoiceDictionaryRetry, onVoiceDictionaryReset, onVoiceInstructionsChange, onVoiceAutoLearningChange, onVoiceDictionaryAdd,
  onVoiceDictionaryEdit, onVoiceDictionaryDelete, onConnections, onDevices, updates, updateActions,
  appVersion }: MobileSettingsScreenProps) {
  const current = resolveMobileSettingsCurrentDevice(state);
  const t = (key: MobileMessageKey, variables?: Readonly<Record<string, string | number>>): string =>
    mobileMessage(locale.effectiveLocale, key, variables);
  const resolvedAppVersion = appVersion || Constants.expoConfig?.version || t("common.unknown");
  const [editor, setEditor] = useState<{ readonly ownerKey: string; readonly original: string; readonly draft: string }>();
  const [savingName, setSavingName] = useState(false);
  const [renameUnknown, setRenameUnknown] = useState(false);
  const [localError, setLocalError] = useState("");
  const [notice, setNotice] = useState("");
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
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
    setLocalError(t("settings.rename.ownerChanged"));
  }, [currentOwnerKey, editor, locale.effectiveLocale]);

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
      setNotice(t("settings.rename.saved"));
    }
  }, [current, editor, locale.effectiveLocale, pendingRename, renameUnknown]);

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
      t("settings.rename.discardTitle"),
      t("settings.rename.discardBody"),
      [
        { text: t("settings.rename.keepEditing"), style: "cancel" },
        { text: t("settings.rename.discard"), style: "destructive", onPress: discardEditor }
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
  }, [editor, savingName, locale.effectiveLocale]);

  const saveName = async (): Promise<void> => {
    if (!editor || !current || editor.ownerKey !== current.ownerKey || !canRename) return;
    const value = editor.draft.trim();
    if (!value || value.length > 128) {
      setLocalError(t("settings.rename.invalid"));
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
        setLocalError(t("settings.rename.unknown"));
        return;
      }
      setRenameUnknown(false);
      unknownReceiptSeen.current = false;
      setEditor(undefined);
      setNotice(t("settings.rename.saved"));
    } catch (error) {
      if (saveGeneration.current === generation) setLocalError(errorText(error, locale.effectiveLocale));
    } finally {
      if (saveGeneration.current === generation) setSavingName(false);
    }
  };

  const changeTheme = async (preference: MobileThemePreference): Promise<void> => {
    setLocalError("");
    try { await onThemeChange(preference); }
    catch { setLocalError(t("settings.theme.error")); }
  };

  const changeLocale = async (preference: MobileLocalePreference): Promise<void> => {
    setLocalError("");
    try { await onLocaleChange(preference); }
    catch { setLocalError(t("settings.language.error")); }
  };

  const runReceiptAction = async (action: () => Promise<void>): Promise<void> => {
    setLocalError("");
    try { await action(); }
    catch (error) { setLocalError(errorText(error, locale.effectiveLocale)); }
  };

  const runDiagnosticsAction = async (action: () => Promise<void>, success: string): Promise<void> => {
    setLocalError("");
    setNotice("");
    try {
      await action();
      setNotice(success);
    } catch {
      setLocalError(t("settings.diagnostics.error"));
    }
  };

  if (voiceOpen) return <MobileVoiceDictionaryScreen colors={colors} locale={locale.effectiveLocale}
    state={voiceDictionary} onBack={() => setVoiceOpen(false)} onRetry={onVoiceDictionaryRetry}
    onReset={onVoiceDictionaryReset}
    onSetInstructions={onVoiceInstructionsChange} onSetAutoLearning={onVoiceAutoLearningChange}
    onAddTerm={onVoiceDictionaryAdd} onEditEntry={onVoiceDictionaryEdit}
    onDeleteEntry={onVoiceDictionaryDelete} />;

  if (editor) {
    const editable = canRename && editor.ownerKey === currentOwnerKey;
    return <ScrollView contentContainerStyle={[styles.screen, { backgroundColor: colors.background }]}
      keyboardShouldPersistTaps="handled">
      <BackButton label={t("settings.title")} language={locale.effectiveLocale}
        disabled={savingName} onPress={requestCloseEditor} colors={colors} />
      <Text style={[styles.title, { color: colors.ink }]}>{t("settings.rename.title")}</Text>
      <Text style={[styles.description, { color: colors.muted }]}>
        {t("settings.rename.description")}
      </Text>
      {!online && <Notice colors={colors} text={foreground
        ? t("settings.rename.reconnect")
        : t("settings.rename.foreground")} />}
      <View style={styles.field}>
        <Text style={[styles.caption, { color: colors.muted }]}>{t("settings.rename.title")}</Text>
        <TextInput accessibilityLabel={t("settings.rename.title")} value={editor.draft} editable={editable}
          onChangeText={(draft) => setEditor((value) => value ? { ...value, draft } : value)}
          maxLength={128} autoCorrect={false} placeholder={t("settings.rename.title")} placeholderTextColor={colors.muted}
          style={[styles.input, !editable && styles.disabled,
            { color: colors.ink, backgroundColor: colors.surface, borderColor: colors.border }]} />
      </View>
      <Text style={[styles.caption, { color: colors.muted }]}>{editor.draft.trim().length}/128</Text>
      {(localError || state.error) && <ErrorNotice colors={colors} text={localError || state.error || ""} />}
      <View style={styles.actionRow}>
        <Button label={t("common.cancel")} colors={colors} disabled={savingName} onPress={requestCloseEditor} />
        <Button label={savingName ? t("settings.rename.saving") : t("settings.rename.save")} colors={colors}
          disabled={!editable || !editor.draft.trim() || editor.draft.trim().length > 128
            || editor.draft.trim() === editor.original}
          onPress={() => void saveName()} />
      </View>
    </ScrollView>;
  }

  return <ScrollView contentContainerStyle={[styles.screen, { backgroundColor: colors.background }]}>
    <BackButton label="Joko" language={locale.effectiveLocale} onPress={onBack} colors={colors} />
    <Text style={[styles.title, { color: colors.ink }]}>{t("settings.title")}</Text>

    <Text style={[styles.section, { color: colors.muted }]}>{t("settings.appearance")}</Text>
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      {(["system", "light", "dark"] as const).map((preference) => <ThemeChoice key={preference}
        preference={preference} selected={theme.preference === preference} colors={colors} language={locale.effectiveLocale}
        disabled={theme.status === "loading" || theme.saving}
        onPress={() => void changeTheme(preference)} />)}
    </View>
    {theme.error && <ErrorNotice colors={colors} text={t("settings.theme.error")} />}

    <Text style={[styles.section, { color: colors.muted }]}>{t("settings.language")}</Text>
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      {(["system", ...MOBILE_SUPPORTED_LOCALES] as const).map((preference) => <LanguageChoice key={preference}
        preference={preference} selected={locale.preference === preference} effective={locale.effectiveLocale}
        language={locale.effectiveLocale} colors={colors} disabled={locale.status === "loading" || locale.saving}
        onPress={() => void changeLocale(preference)} />)}
    </View>
    {locale.error && <ErrorNotice colors={colors} text={t("settings.language.error")} />}

    <Text style={[styles.section, { color: colors.muted }]}>{t("settings.voice.title")}</Text>
    <NavigationRow label={t("settings.voice.title")} description={t("settings.voice.navigation")}
      colors={colors} onPress={() => { setLocalError(""); setNotice(""); setVoiceOpen(true); }} />

    <Text style={[styles.section, { color: colors.muted }]}>{t("settings.currentNode")}</Text>
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <InformationRow label={t("common.name")} value={state.node?.displayName || t("common.unavailable")} colors={colors} />
      <InformationRow label={t("common.address")} value={state.origin || t("common.unavailable")} colors={colors} selectable />
      <InformationRow label={t("common.status")} value={connectionLabel(state.status, foreground, locale.effectiveLocale)} colors={colors} />
      <InformationRow label={t("settings.nodeVersion")} value={state.node?.version || t("common.unknown")} colors={colors} />
      <InformationRow label={t("common.apiVersion")} value={state.node?.apiVersion || t("common.unknown")} colors={colors} />
    </View>
    <NavigationRow label={t("settings.connectionSettings")} description={t("settings.connectionSettingsDescription")}
      colors={colors} onPress={onConnections} />

    <Text style={[styles.section, { color: colors.muted }]}>{t("settings.thisPhone")}</Text>
    {current ? <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <InformationRow label={t("common.name")} value={current.device.displayName} colors={colors} />
      <InformationRow label={t("common.platform")} value={current.device.platform || platformLabel()} colors={colors} />
      <InformationRow label={t("settings.appVersion")} value={current.device.appVersion || t("common.unknown")} colors={colors} />
      <InformationRow label={t("settings.deviceId")} value={current.device.deviceId} colors={colors} selectable />
      <View style={styles.actionRow}>
        <Button label={t("settings.copyDeviceId")} colors={colors} onPress={() => {
          void Clipboard.setStringAsync(current.device.deviceId).then(() => setNotice(t("settings.deviceIdCopied")))
            .catch((error) => setLocalError(errorText(error, locale.effectiveLocale)));
        }} />
        <Button label={t("settings.renamePhone")} colors={colors} disabled={!canRename} onPress={() => {
          setLocalError("");
          setNotice("");
          setRenameUnknown(false);
          unknownReceiptSeen.current = false;
          setEditor({ ownerKey: current.ownerKey, original: current.device.displayName, draft: current.device.displayName });
        }} />
      </View>
    </View> : <Notice colors={colors}
      text={t("settings.deviceMismatch")} />}
    {!online && current && <Notice colors={colors} text={foreground
      ? t("settings.identityReconnect")
      : t("settings.identityBackground")} />}
    <NavigationRow label={t("settings.allDevices")} description={t("settings.allDevicesDescription")}
      colors={colors} onPress={onDevices} />

    {pendingRename && <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.warning, { color: colors.negative }]}>
        {pendingRename.state === "unknown" ? t("settings.receipt.unknown") : t("settings.receipt.awaiting")}
        {` · ${pendingRename.operationId}`}
      </Text>
      <Text style={[styles.caption, { color: colors.muted }]}>{t("settings.receipt.noReplay")}</Text>
      <View style={styles.actionRow}>
        <Button label={t("settings.receipt.check")} colors={colors} disabled={!online || state.busy}
          onPress={() => void runReceiptAction(() => client.reconcile())} />
        {pendingRename.state === "unknown" && <Button label={t("settings.receipt.verify")} colors={colors}
          disabled={!online || state.busy} onPress={() => Alert.alert(
            t("settings.receipt.clearTitle"),
            t("settings.receipt.clearBody"),
            [
              { text: t("settings.receipt.keepChecking"), style: "cancel" },
              { text: t("settings.receipt.verify"), onPress: () => void runReceiptAction(
                () => client.dismissUnconfirmed(pendingRename.operationId)
              ) }
            ]
          )} />}
      </View>
    </View>}

    <MobileUpdateSettingsSection colors={colors} locale={locale.effectiveLocale}
      state={updates} actions={updateActions} />

    <Text style={[styles.section, { color: colors.muted }]}>{t("common.about")}</Text>
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <InformationRow label={t("settings.jokoApp")} value={resolvedAppVersion} colors={colors} />
      <InformationRow label={t("common.platform")} value={platformLabel()} colors={colors} />
      <InformationRow label={t("common.node")} value={state.node?.version || t("common.unknown")} colors={colors} />
      <InformationRow label={t("common.api")} value={state.node?.apiVersion || t("common.unknown")} colors={colors} />
    </View>

    <Text style={[styles.section, { color: colors.muted }]}>{t("settings.diagnostics")}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={t("settings.diagnostics.local")}
      accessibilityState={{ expanded: diagnosticsExpanded }}
      onPress={() => setDiagnosticsExpanded((value) => !value)}
      style={[styles.navigationRow, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.fill}>
        <Text style={[styles.label, { color: colors.ink }]}>{t("settings.diagnostics.local")}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>
          {diagnostics.enabled ? t("settings.diagnostics.on", { count: diagnostics.eventCount }) : t("settings.diagnostics.off")}
        </Text>
      </View>
      <Text style={[styles.chevron, { color: colors.muted }]}>{diagnosticsExpanded ? "⌃" : "⌄"}</Text>
    </Pressable>
    {diagnosticsExpanded && <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.description, { color: colors.ink }]}>{t("settings.diagnostics.recordingTitle")}</Text>
      <Text style={[styles.caption, { color: colors.muted }]}>
        {t("settings.diagnostics.privacy")}
      </Text>
      <View style={styles.toggleRow}>
        <View style={styles.fill}>
          <Text style={[styles.label, { color: colors.ink }]}>{t("settings.diagnostics.record")}</Text>
          <Text style={[styles.caption, { color: colors.muted }]}>
            {diagnostics.status === "loading" ? t("settings.diagnostics.loading")
              : diagnostics.enabled ? t("settings.diagnostics.recording") : t("settings.diagnostics.notRecording")}
          </Text>
        </View>
        <Switch accessibilityLabel={t("settings.diagnostics.record")} value={diagnostics.enabled}
          disabled={diagnostics.status === "loading" || diagnostics.saving || diagnostics.exporting}
          trackColor={{ false: colors.border, true: colors.accent }} thumbColor={colors.surface}
          onValueChange={(value) => void runDiagnosticsAction(
            () => onDiagnosticsEnabledChange(value),
            value ? t("settings.diagnostics.enabled") : t("settings.diagnostics.disabled")
          )} />
      </View>
      <InformationRow label={t("settings.diagnostics.retained")}
        value={t("settings.diagnostics.retainedValue", { count: diagnostics.eventCount })} colors={colors} />
      <InformationRow label={t("settings.diagnostics.retention")} value={t("settings.diagnostics.retentionValue")} colors={colors} />
      <View style={styles.actionRow}>
        <Button label={diagnostics.exporting ? t("settings.diagnostics.exporting") : t("settings.diagnostics.export")} colors={colors}
          disabled={diagnostics.status === "loading" || diagnostics.saving || diagnostics.exporting}
          onPress={() => void runDiagnosticsAction(onDiagnosticsExport, t("settings.diagnostics.exported"))} />
        <Button label={t("settings.diagnostics.clear")} colors={colors}
          disabled={diagnostics.status === "loading" || diagnostics.saving || diagnostics.exporting
            || diagnostics.eventCount === 0 && diagnostics.status === "ready"}
          onPress={() => Alert.alert(
            t("settings.diagnostics.clearTitle"),
            t("settings.diagnostics.clearBody"),
            [
              { text: t("common.cancel"), style: "cancel" },
              { text: t("common.clear"), style: "destructive", onPress: () => void runDiagnosticsAction(
                onDiagnosticsClear,
                t("settings.diagnostics.cleared")
              ) }
            ]
          )} />
      </View>
      {diagnostics.error && <ErrorNotice colors={colors} text={t("settings.diagnostics.error")} />}
    </View>}
    {notice && <Text accessibilityLiveRegion="polite" style={[styles.noticeText, { color: colors.ink,
      backgroundColor: colors.brandBackground, borderColor: colors.accent }]}>{notice}</Text>}
    {(localError || state.error) && <ErrorNotice colors={colors} text={localError || state.error || ""} />}
  </ScrollView>;
}

function ThemeChoice({ preference, selected, disabled, colors, language, onPress }: {
  readonly preference: MobileThemePreference;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly colors: MobileSettingsColors;
  readonly language: MobileSupportedLocale;
  readonly onPress: () => void;
}) {
  const t = (key: MobileMessageKey, variables?: Readonly<Record<string, string | number>>): string =>
    mobileMessage(language, key, variables);
  const label = t(preference === "system" ? "settings.theme.system"
    : preference === "light" ? "settings.theme.light" : "settings.theme.dark");
  const description = t(preference === "system" ? "settings.theme.systemDescription"
    : preference === "light" ? "settings.theme.lightDescription" : "settings.theme.darkDescription");
  return <Pressable accessibilityRole="radio" accessibilityLabel={t("settings.theme.accessibility", { label })}
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

function LanguageChoice({ preference, selected, effective, disabled, colors, language, onPress }: {
  readonly preference: MobileLocalePreference;
  readonly selected: boolean;
  readonly effective: MobileSupportedLocale;
  readonly disabled: boolean;
  readonly colors: MobileSettingsColors;
  readonly language: MobileSupportedLocale;
  readonly onPress: () => void;
}) {
  const t = (key: MobileMessageKey, variables?: Readonly<Record<string, string | number>>): string =>
    mobileMessage(language, key, variables);
  const label = mobileLocaleLabel(language, preference);
  const description = preference === "system"
    ? t("settings.language.systemDescription", { language: mobileLocaleLabel(language, effective) })
    : t("settings.language.explicitDescription", { language: label });
  return <Pressable accessibilityRole="radio" accessibilityLabel={label}
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

function mobileLocaleLabel(language: MobileSupportedLocale, locale: MobileLocalePreference): string {
  const key: MobileMessageKey = locale === "system" ? "settings.language.system"
    : locale === "en" ? "settings.language.en"
      : locale === "zh-CN" ? "settings.language.zh-CN"
        : locale === "zh-TW" ? "settings.language.zh-TW"
          : locale === "ja" ? "settings.language.ja" : "settings.language.ko";
  return mobileMessage(language, key);
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

function BackButton({ label, language, disabled, onPress, colors }: {
  readonly label: string;
  readonly language: MobileSupportedLocale;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  readonly colors: MobileSettingsColors;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(language, "common.backTo", { label })}
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

function connectionLabel(
  status: MobileState["status"],
  foreground: boolean,
  language: MobileSupportedLocale
): string {
  if (!foreground) return mobileMessage(language, "settings.connection.background");
  if (status === "connected") return mobileMessage(language, "settings.connection.connected");
  if (status === "connecting") return mobileMessage(language, "settings.connection.reconnecting");
  if (status === "revoked") return mobileMessage(language, "settings.connection.revoked");
  if (status === "offline") return mobileMessage(language, "settings.connection.offline");
  return mobileMessage(language, status === "starting" ? "settings.connection.starting" : "settings.connection.none");
}

function platformLabel(): string {
  return Platform.OS === "ios" ? "iOS" : Platform.OS === "android" ? "Android" : Platform.OS;
}

function errorText(error: unknown, language: MobileSupportedLocale): string {
  return error instanceof Error && error.message ? error.message : mobileMessage(language, "settings.error");
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
