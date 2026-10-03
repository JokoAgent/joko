import { clone, create } from "@bufbuild/protobuf";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { AppState, Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { VoiceInputServiceSettingsSchema, VoiceInputServiceSettingsPatchSchema, VoiceInputTranscriptionProtocol,
  defaultVoiceInputSaucSettings, projectVoiceInputSaucSettings, protoVoiceInputSaucSettings, voiceInputSaucEndpoint, ModelRouteRefSchema,
  type VoiceInputServiceSettings, type VoiceInputSaucSettingsView } from "@joko/contracts";
import type { MobileSettingsColors } from "./MobileSettingsScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobileVoiceSettingsTransport } from "./mobile-voice-service-settings";
import type { MobileVoicePreferencesStoreState } from "./mobile-voice-preferences-store";
import { mobileVoiceServiceMessage } from "./mobile-voice-service-messages";
import type { MobileVoiceCapability } from "./mobile-voice-input";

export interface MobileVoiceServiceDraft {
  readonly value: VoiceInputServiceSettings;
  readonly ownerKey: string;
  readonly dirty: boolean;
}

export function MobileVoiceServiceSettings(props: {
  readonly colors: MobileSettingsColors; readonly locale: MobileSupportedLocale;
  readonly transport?: MobileVoiceSettingsTransport;
  readonly cache?: MutableRefObject<MobileVoiceServiceDraft | undefined>;
  readonly preferences: MobileVoicePreferencesStoreState;
  readonly onSetContext?: (enabled: boolean, contextData: readonly { readonly text: string }[]) => Promise<void>;
}) {
  const { colors, transport } = props;
  const t = (index: number): string => mobileVoiceServiceMessage(props.locale, index);
  const [draft, setDraft] = useState<MobileVoiceServiceDraft | undefined>(props.cache?.current);
  const [baseline, setBaseline] = useState<VoiceInputServiceSettings>();
  const [capability, setCapability] = useState<MobileVoiceCapability>();
  const [secret, setSecret] = useState("");
  const [fallbackSecret, setFallbackSecret] = useState("");
  const [clear, setClear] = useState(false);
  const [clearFallback, setClearFallback] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [contextEnabled, setContextEnabled] = useState(props.preferences.document.recognitionContextEnabled);
  const [contextData, setContextData] = useState(props.preferences.document.recognitionContextData.map((item) => ({ ...item })));
  const [contextDirty, setContextDirty] = useState(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const ownerKey = transport?.ownerKey;
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const current = (): boolean => lifetime.current !== undefined && !lifetime.current.signal.aborted
    && transportRef.current !== undefined && transportRef.current.ownerKey === ownerKey && transportRef.current.isCurrent();
  const run = async (effect: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    if (busy || !current()) return;
    const request = lifetime.current!;
    setBusy(true); setNotice("");
    try { await effect(request.signal); }
    catch { if (!request.signal.aborted && current()) setNotice(t(32)); }
    finally { if (!request.signal.aborted && current()) setBusy(false); }
  };
  const load = async (signal: AbortSignal): Promise<void> => {
    if (!transport) return;
    const [settings, profile] = await Promise.all([transport.get(signal), transport.getCapabilities(signal)]);
    if (signal.aborted || !current()) return;
    setBaseline(settings); setCapability(profile);
    setDraft((previous) => previous?.dirty ? previous : { value: clone(VoiceInputServiceSettingsSchema, settings), ownerKey: transport.ownerKey, dirty: false });
  };
  useEffect(() => {
    const request = new AbortController(); lifetime.current = request;
    setBusy(false); setBaseline(undefined); setCapability(undefined); setNotice(""); setSecret(""); setFallbackSecret("");
    if (transport?.isCurrent()) {
      setBusy(true);
      void load(request.signal).catch(() => { if (!request.signal.aborted && current()) setNotice(t(32)); })
        .finally(() => { if (!request.signal.aborted && current()) setBusy(false); });
    }
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") { request.abort(); setSecret(""); setFallbackSecret(""); setBusy(false); setBaseline(undefined); }
    });
    return () => { request.abort(); subscription.remove(); if (lifetime.current === request) lifetime.current = undefined; };
  }, [ownerKey]);
  useEffect(() => { if (props.cache) props.cache.current = draft; }, [draft, props.cache]);
  useEffect(() => {
    if (!contextDirty) {
      setContextEnabled(props.preferences.document.recognitionContextEnabled);
      setContextData(props.preferences.document.recognitionContextData.map((item) => ({ ...item })));
    }
  }, [props.preferences.document, contextDirty]);
  const disabled = busy || !current() || !baseline;
  const update = (values: Partial<VoiceInputServiceSettings>): void => {
    if (disabled) return;
    setDraft((previous) => previous ? { ...previous, dirty: true, value: { ...previous.value, ...values } } : previous);
  };
  const input = (label: string, value: string, onChangeText: (value: string) => void, secure = false, editable = !disabled) => <View style={styles.field} key={label}>
    <Text style={{ color: colors.muted }}>{label}</Text>
    <TextInput accessibilityLabel={label} value={value} editable={editable} onChangeText={onChangeText}
      secureTextEntry={secure} autoCapitalize="none" autoCorrect={false} maxLength={secure ? 65_536 : 2_048}
      style={[styles.input, { color: colors.ink, borderColor: colors.border, backgroundColor: colors.surface }]} />
  </View>;
  const button = (label: string, onPress: () => void, isDisabled = disabled) => <Pressable key={label} accessibilityRole="button"
    accessibilityLabel={label} disabled={isDisabled} onPress={onPress} style={[styles.button, { borderColor: colors.border, opacity: isDisabled ? 0.45 : 1 }]}>
    <Text style={{ color: colors.ink }}>{label}</Text></Pressable>;
  const toggle = (label: string, value: boolean, onValueChange: (value: boolean) => void, isDisabled = disabled) => <View key={label} style={styles.row}>
    <Text style={[styles.fill, { color: colors.ink }]}>{label}</Text><Switch accessibilityLabel={label} value={value}
      disabled={isDisabled} onValueChange={onValueChange} trackColor={{ false: colors.border, true: colors.accent }} /></View>;
  const route = (fallback: boolean) => {
    if (!draft) return null;
    const value = draft.value;
    const prefix = `${t(fallback ? 2 : 1)} · `;
    const protocol = fallback ? value.fallbackProtocol : value.protocol;
    const endpoint = fallback ? value.fallbackEndpoint : value.endpoint;
    const model = fallback ? value.fallbackModel : value.model;
    const resourceId = fallback ? value.fallbackResourceId : value.resourceId;
    const keyless = fallback ? value.fallbackKeyless : value.keyless;
    const sauc = projectVoiceInputSaucSettings(fallback ? value.fallbackSauc : value.sauc) ?? defaultVoiceInputSaucSettings();
    const isSauc = protocol === VoiceInputTranscriptionProtocol.VOLCENGINE_SAUC;
    const chooseProtocol = (nextProtocol: VoiceInputTranscriptionProtocol): void => {
      const nextIsSauc = nextProtocol === VoiceInputTranscriptionProtocol.VOLCENGINE_SAUC;
      let nextEndpoint = endpoint;
      if (nextIsSauc) { try { nextEndpoint = voiceInputSaucEndpoint(endpoint, sauc.mode); } catch { /* Keep the invalid endpoint visible for explicit editing. */ } }
      update(fallback ? { fallbackProtocol: nextProtocol, fallbackSauc: nextIsSauc ? protoVoiceInputSaucSettings(sauc) : undefined,
        fallbackResourceId: nextIsSauc ? resourceId : "", fallbackModel: nextIsSauc ? "" : model,
        fallbackEndpoint: nextEndpoint, ...(nextIsSauc ? { fallbackKeyless: false } : {}) }
        : { protocol: nextProtocol, sauc: nextIsSauc ? protoVoiceInputSaucSettings(sauc) : undefined,
          resourceId: nextIsSauc ? resourceId : "", model: nextIsSauc ? "" : model,
          endpoint: nextEndpoint, ...(nextIsSauc ? { keyless: false } : {}) });
    };
    const changeSauc = (part: Partial<VoiceInputSaucSettingsView>) => {
      const next = { ...sauc, ...part };
      let nextEndpoint = endpoint;
      if (part.mode !== undefined) { try { nextEndpoint = voiceInputSaucEndpoint(endpoint, next.mode); } catch { /* The endpoint remains visibly invalid until edited. */ } }
      update(fallback ? { fallbackSauc: protoVoiceInputSaucSettings(next), fallbackEndpoint: nextEndpoint }
        : { sauc: protoVoiceInputSaucSettings(next), endpoint: nextEndpoint });
    };
    return <View key={prefix} style={[styles.group, { borderColor: colors.border }]}>
      <Text style={[styles.title, { color: colors.ink }]}>{t(fallback ? 2 : 1)}</Text>
      {fallback && toggle(prefix + t(3), value.fallbackEnabled, (fallbackEnabled) => update({ fallbackEnabled }))}
      <Text style={{ color: colors.muted }}>{t(4)}</Text><View style={styles.wrap}>{[
        [VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_BATCH, "OpenAI batch"], [VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_REALTIME, "OpenAI realtime"],
        [VoiceInputTranscriptionProtocol.QWEN_COMPATIBLE_REALTIME, "Qwen realtime"], [VoiceInputTranscriptionProtocol.ELEVENLABS_SCRIBE_REALTIME, "Scribe realtime"],
        [VoiceInputTranscriptionProtocol.VOLCENGINE_SAUC, "SAUC"]
      ].map(([choice, label]) => button(prefix + label + (protocol === choice ? " ✓" : ""), () => chooseProtocol(choice as VoiceInputTranscriptionProtocol)))}</View>
      {input(prefix + t(5), endpoint, (text) => update(fallback ? { fallbackEndpoint: text } : { endpoint: text }))}
      {!isSauc && input(prefix + t(6), model, (text) => update(fallback ? { fallbackModel: text } : { model: text }))}
      {isSauc && <>
        {input(prefix + t(7), resourceId, (text) => update(fallback ? { fallbackResourceId: text } : { resourceId: text }))}
        <Text style={{ color: colors.muted }}>{t(8)}</Text><View style={styles.wrap}>{(["asyncTwoPass", "bidirectional", "streamInput"] as const)
          .map((mode, index) => button(prefix + t(9 + index) + (sauc.mode === mode ? " ✓" : ""), () => changeSauc({ mode })))}</View>
        <Text style={{ color: colors.muted }}>{t(12)}</Text><View style={styles.wrap}>{(["apiKey", "accessToken"] as const)
          .map((authentication, index) => button(prefix + t(13 + index) + (sauc.authentication === authentication ? " ✓" : ""), () => changeSauc({ authentication, ...(authentication === "apiKey" ? { appId: "" } : {}) })))}</View>
        {sauc.authentication === "accessToken" && input(prefix + t(15), sauc.appId, (appId) => changeSauc({ appId }))}
        {toggle(prefix + t(16), sauc.useDictionaryHotwords, (useDictionaryHotwords) => changeSauc({ useDictionaryHotwords }))}
        {(["boostingTableName", "boostingTableId", "correctTableName", "correctTableId"] as const).map((key, index) => input(prefix + t(17 + index), sauc[key], (text) => changeSauc({ [key]: text })))}
        <Text style={{ color: colors.muted }}>{t(36)}</Text>
      </>}
      {!isSauc && toggle(prefix + t(25), keyless, (text) => update(fallback ? { fallbackKeyless: text } : { keyless: text }))}
      <Text style={{ color: colors.muted }}>{t((fallback ? value.fallbackCredentialConfigured : value.credentialConfigured) ? 23 : 24)}</Text>
      {input(prefix + (isSauc ? t(sauc.authentication === "apiKey" ? 13 : 14) : t(21)), fallback ? fallbackSecret : secret,
        (text) => { if (fallback) { setFallbackSecret(text); setClearFallback(false); } else { setSecret(text); setClear(false); } }, true)}
      {toggle(prefix + t(22), fallback ? clearFallback : clear, (enabled) => {
        if (fallback) { setClearFallback(enabled); if (enabled) setFallbackSecret(""); }
        else { setClear(enabled); if (enabled) setSecret(""); }
      })}
    </View>;
  };
  const save = async (signal: AbortSignal) => {
    if (!transport || !draft || !baseline || draft.ownerKey !== transport.ownerKey
      || draft.value.version?.revision?.value !== baseline.version?.revision?.value) return;
    const value = draft.value;
    const patch = create(VoiceInputServiceSettingsPatchSchema, {
      enabled: value.enabled, protocol: value.protocol, endpoint: value.endpoint.trim(), model: value.model.trim(), resourceId: value.resourceId.trim(), keyless: value.keyless,
      ...(value.protocol === VoiceInputTranscriptionProtocol.VOLCENGINE_SAUC ? { sauc: value.sauc } : {}),
      fallbackEnabled: value.fallbackEnabled, fallbackProtocol: value.fallbackProtocol, fallbackEndpoint: value.fallbackEndpoint.trim(), fallbackModel: value.fallbackModel.trim(),
      fallbackResourceId: value.fallbackResourceId.trim(), fallbackKeyless: value.fallbackKeyless,
      ...(value.fallbackProtocol === VoiceInputTranscriptionProtocol.VOLCENGINE_SAUC ? { fallbackSauc: value.fallbackSauc } : {}),
      refinementEnabled: value.refinementEnabled, clearCredential: clear, clearFallbackCredential: clearFallback,
      refinerModel: value.refinerModel ?? create(ModelRouteRefSchema),
      refinerFallbackModel: value.refinerFallbackModel ?? create(ModelRouteRefSchema),
      expectedRevision: { value: baseline.version!.revision!.value }
    });
    try {
      const settings = await transport.save(patch, { primary: secret, fallback: fallbackSecret }, signal);
      if (signal.aborted || !current()) return;
      setBaseline(settings); setDraft({ value: clone(VoiceInputServiceSettingsSchema, settings), dirty: false, ownerKey: transport.ownerKey });
      setClear(false); setClearFallback(false); setNotice(t(30));
    } finally { if (lifetime.current?.signal === signal) { setSecret(""); setFallbackSecret(""); } }
  };
  return <View style={styles.group}>
    <Text style={[styles.title, { color: colors.ink }]}>{t(0)}</Text>
    {disabled && <Text style={{ color: colors.muted }}>{t(33)}</Text>}
    {draft && <>
      {toggle(t(3), draft.value.enabled, (enabled) => update({ enabled }))}
      {route(false)}{route(true)}
      {toggle(t(46), draft.value.refinementEnabled, (refinementEnabled) => update({ refinementEnabled }))}
      {(["refinerModel", "refinerFallbackModel"] as const).map((key, index) => <View key={key} style={styles.field}>
        <Text style={{ color: colors.muted }}>{t(index + 1)} · {t(46)}</Text>
        {(["backendId", "providerId", "modelId"] as const).map((field) => input(`${t(index + 1)} · ${t(46)} · ${field}`,
          draft.value[key]?.[field] ?? "", (text) => update({ [key]: create(ModelRouteRefSchema, {
            backendId: draft.value[key]?.backendId ?? "", providerId: draft.value[key]?.providerId ?? "", modelId: draft.value[key]?.modelId ?? "", [field]: text
          }) })))}
      </View>)}
      {baseline && draft.dirty && (draft.ownerKey !== ownerKey || draft.value.version?.revision?.value !== baseline.version?.revision?.value) && <>
        <Text style={{ color: colors.muted }}>{t(35)}</Text>{button(t(34), () => setDraft({ ...draft, ownerKey: ownerKey!, value: { ...draft.value, version: baseline.version } }))}
      </>}
    </>}
    <View style={styles.wrap}>
      {button(t(27), () => void run(load), busy || !current())}
      {button(t(26), () => void run(save), disabled || !draft || draft.ownerKey !== ownerKey
        || draft.value.version?.revision?.value !== baseline?.version?.revision?.value || transport?.hasPending() === true)}
      {button(t(28), () => void run(async (signal) => { const result = await transport!.test(signal); if (current()) setNotice(t(result.ok ? 31 : 32)); }), disabled || draft?.dirty === true)}
      {transport?.hasPending() && button(t(29), () => void run(async (signal) => { await transport.reconcile(signal); await load(signal); }), busy || !current())}
    </View>
    {notice && <Text accessibilityLiveRegion="polite" style={{ color: colors.muted }}>{notice}</Text>}
    <Text style={[styles.title, { color: colors.ink }]}>{t(37)}</Text>
    <Text style={{ color: colors.muted }}>{t(39)}</Text>
    {toggle(t(38), contextEnabled, (enabled) => { setContextEnabled(enabled); setContextDirty(true); }, props.preferences.saving || !props.onSetContext)}
    {capability && !capability.supportsRecognitionContext && <Text style={{ color: colors.muted }}>{t(44)}</Text>}
    <Text style={{ color: colors.muted }}>{t(45)}</Text>
    {contextData.map((item, index) => <View key={index} style={styles.field}>
      <TextInput accessibilityLabel={`${t(37)} ${index + 1}`} value={item.text} multiline editable={!props.preferences.saving}
        autoCorrect={false} onChangeText={(text) => { setContextData((items) => items.map((entry, ordinal) => ordinal === index ? { text } : entry)); setContextDirty(true); }}
        style={[styles.input, { color: colors.ink, borderColor: colors.border, backgroundColor: colors.surface }]} />
      {button(`${t(41)} ${index + 1}`, () => { setContextData((items) => items.filter((_item, ordinal) => ordinal !== index)); setContextDirty(true); }, props.preferences.saving)}
    </View>)}
    <View style={styles.wrap}>
      {button(t(40), () => { setContextData((items) => [...items, { text: "" }]); setContextDirty(true); }, props.preferences.saving || contextData.length >= 20)}
      {button(t(42), () => {
        const occurrence = lifetime.current;
        void props.onSetContext?.(contextEnabled, contextData).then(() => {
          if (occurrence === lifetime.current && !occurrence?.signal.aborted) { setContextDirty(false); setNotice(t(43)); }
        }).catch(() => { if (occurrence === lifetime.current && !occurrence?.signal.aborted) setNotice(t(32)); });
      }, props.preferences.saving || !contextDirty || !props.onSetContext)}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  group: { gap: 12, marginVertical: 10, padding: 12, borderWidth: 1, borderRadius: 12 }, title: { fontSize: 17, fontWeight: "600" },
  field: { gap: 6 }, input: { borderWidth: 1, borderRadius: 10, padding: 12, minHeight: 44 },
  button: { padding: 10, borderWidth: 1, borderRadius: 10, minHeight: 44 }, row: { flexDirection: "row", alignItems: "center", gap: 12 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, fill: { flex: 1 }
});
