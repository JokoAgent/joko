import { useEffect, useRef, useState } from "react";
import { AppState, Image, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import { inputHandoffHeldElsewhere, inputHandoffQrLink, inputHandoffStepKey, isInputHandoffDeviceCode,
  type InputHandoffAction, type InputHandoffDecision, type InputHandoffPicture, type InputHandoffSnapshot, type InputHandoffValues } from "@joko/contracts";
import type { MobileInputHandoffApi } from "./mobile-input-handoff";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileInputHandoffText } from "./mobile-input-handoff-text";
import { MobileInputHandoffFields } from "./MobileInputHandoffFields";

interface Props { readonly api: MobileInputHandoffApi; readonly colors: MobileInteractionSheetColors & { readonly dark?: boolean }; readonly locale: MobileSupportedLocale }
/** Owner-only transient UI. Closing, backgrounding or changing owner destroys its native fields and pixels. */
export function MobileInputHandoffPanel(props: Props) {
  const [foreground, setForeground] = useState(AppState.currentState === "active"), [occurrence, setOccurrence] = useState(0);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", state => { setForeground(state === "active"); if (state !== "active") setOccurrence(value => value + 1); });
    return () => subscription.remove();
  }, []);
  return foreground && props.api.isCurrent() ? <PanelScope key={`${props.api.ownerKey}:${occurrence}`} {...props} /> : null;
}
function PanelScope(props: Props) {
  const [snapshots, setSnapshots] = useState<readonly InputHandoffSnapshot[]>([]), [failed, setFailed] = useState(false), api = useRef(props.api);
  api.current = props.api;
  useEffect(() => {
    const controller = new AbortController(); let pending = false, active = true;
    const read = async () => {
      if (!active || pending || AppState.currentState !== "active" || !api.current.isCurrent()) return;
      pending = true;
      try { const value = await api.current.list(controller.signal); if (active && !controller.signal.aborted && api.current.isCurrent()) { setSnapshots(value); setFailed(false); } }
      catch { if (active && !controller.signal.aborted) { setSnapshots([]); setFailed(true); } }
      finally { pending = false; }
    };
    void read(); const timer = setInterval(() => { void read(); }, 1000);
    const app = AppState.addEventListener("change", state => { if (state !== "active") { active = false; controller.abort(); setSnapshots([]); } });
    return () => { active = false; controller.abort(); clearInterval(timer); app.remove(); };
  }, [props.api.ownerKey]);
  return <View style={styles.stack}>{snapshots.map(snapshot => <MobileInputHandoffCard key={`${inputHandoffStepKey(snapshot)}:${snapshot.revision}`}
    {...props} snapshot={snapshot} />)}{failed && <Text accessibilityLiveRegion="polite" style={{ color: props.colors.muted }}>{mobileInputHandoffText(props.locale, "unavailable")}</Text>}</View>;
}

export function MobileInputHandoffCard(props: Props & { readonly snapshot: InputHandoffSnapshot }) {
  const { snapshot, api, colors, locale } = props, t = (key: Parameters<typeof mobileInputHandoffText>[1]) => mobileInputHandoffText(locale, key);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [draft, setDraft] = useState<InputHandoffValues>({});
  const [picture, setPicture] = useState<InputHandoffPicture>(), [error, setError] = useState(""), [notice, setNotice] = useState(""), [now, setNow] = useState(Date.now());
  const live = useRef({ active: true, pending: false, serial: 0, abort: new AbortController(), api, snapshot }); live.current.api = api; live.current.snapshot = snapshot;
  const pictureBounds = useRef({ width: 0, height: 0 });
  const held = inputHandoffHeldElsewhere(snapshot, { deviceId: api.deviceId }), actionable = !snapshot.terminal && snapshot.phase === "ready";
  const current = () => live.current.active && !live.current.abort.signal.aborted && AppState.currentState === "active" && live.current.api.isCurrent();
  const clear = () => { setDraft({}); setPicture(undefined); setNotice(""); };
  const close = () => { live.current.serial++; live.current.abort.abort(); live.current.abort = new AbortController(); live.current.pending = false; setBusy(false); setOpen(false); clear(); };
  useEffect(() => {
    const owner = live.current; owner.active = true; if (owner.abort.signal.aborted) owner.abort = new AbortController();
    const timer = setInterval(() => setNow(Date.now()), 500);
    const app = AppState.addEventListener("change", state => { if (state !== "active") close(); });
    return () => { owner.active = false; owner.serial++; owner.abort.abort(); app.remove(); clearInterval(timer); };
  }, []);
  useEffect(() => { if (!actionable || held) close(); }, [actionable, held]);
  useEffect(() => {
    if (!open || !snapshot.picture || held || !actionable || !current()) return;
    const owner = live.current, serial = ++owner.serial; setPicture(undefined); setError("");
    void api.picture(snapshot, owner.abort.signal).then(value => { if (current() && owner.serial === serial) setPicture(value); })
      .catch(() => { if (current() && owner.serial === serial) setError(t("pictureFailed")); });
    return () => { if (owner.serial === serial) owner.serial++; };
  }, [open, snapshot.picture, snapshot.revision, held, actionable]);
  const run = async (work: (latest: InputHandoffSnapshot, signal: AbortSignal) => Promise<boolean | void>, erase = true) => {
    const owner = live.current; if (!current() || owner.pending) return;
    owner.pending = true; setBusy(true); setError(""); setNotice(""); const serial = ++owner.serial, signal = owner.abort.signal;
    try { const accepted = await work(owner.snapshot, signal); if (current() && owner.serial === serial && accepted === false) setError(t("changed")); }
    catch { if (current() && owner.serial === serial) setError(t("unknown")); }
    finally { if (owner.serial === serial) { owner.pending = false; if (owner.active) { setBusy(false); if (erase) setDraft({}); } } }
  };
  const decide = (action: InputHandoffDecision["action"]) => { void run((latest, signal) => api.decide(latest, action, signal)); };
  const submit = (action: InputHandoffAction) => {
    if (!actionable || held || !current() || snapshot.remoteInput !== true) return;
    const values: InputHandoffValues = {};
    if (action.kind !== "tap") for (const control of snapshot.controls) if (control.kind === "text" && Object.hasOwn(draft, control.id)
      && !(control.filled && draft[control.id] === "")) values[control.id] = draft[control.id]!;
    void run(async (latest, signal) => { try { return await api.submit(latest, { expectedRevision: latest.revision, values, action }, signal); }
      finally { for (const id of Object.keys(values)) delete values[id]; } });
  };
  const copy = (effect: () => Promise<unknown>) => { if (!current() || busy) return; void effect().then(value => { if (current()) setNotice(t(value === false ? "copyFailed" : "copied")); }, () => { if (current()) setNotice(t("copyFailed")); }); };
  const qr = picture?.qr, link = qr ? inputHandoffQrLink(qr) : null, code = isInputHandoffDeviceCode(snapshot.deviceCode) ? snapshot.deviceCode : undefined;
  const hasContent = Boolean(snapshot.picture || code || snapshot.controls.some(control => control.kind === "text")) && snapshot.qr !== "scanned";
  const button = (label: string, onPress: () => void, disabled = busy) => <Pressable key={label} accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled }} disabled={disabled} onPress={() => { if (current()) onPress(); }}
    style={[styles.button, { borderColor: colors.border, opacity: disabled ? 0.45 : 1 }]}><Text style={{ color: colors.ink }}>{label}</Text></Pressable>;
  const phase = snapshot.phase === "finishing" ? t("finishing").replace("{seconds}", String(Math.max(0, Math.ceil(((snapshot.finishingUntil ?? now) - now) / 1000)))) : t(snapshot.phase);
  return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]} accessibilityLabel={t("title")}>
    <View style={styles.heading}><Text style={[styles.title, { color: colors.ink }]}>{t("title")}</Text><Text style={{ color: colors.muted }}>{phase}</Text></View>
    <Text style={{ color: colors.ink }}>{snapshot.purpose}</Text>
    <Text style={{ color: colors.muted }}>{snapshot.source.app}{snapshot.source.window ? ` · ${snapshot.source.window}` : ""}</Text>
    {snapshot.source.origin && <Text selectable style={{ color: colors.ink }}>{snapshot.source.origin}</Text>}
    {snapshot.requester && <Text style={{ color: colors.muted }}>{t("requester")}: {snapshot.requester}</Text>}
    {snapshot.command && <Text selectable style={{ color: colors.ink, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" }}>{snapshot.command}</Text>}
    {snapshot.note && <Text style={{ color: colors.muted }}>{t("agent")}: {snapshot.note}</Text>}
    <Text style={{ color: colors.muted }}>{t("privacy")}</Text>
    {snapshot.source.warning && <Text style={{ color: colors.negative }}>{t(snapshot.source.warning)}</Text>}
    {snapshot.failure && <Text accessibilityLiveRegion="polite" style={{ color: colors.negative }}>{t(snapshot.failure)}</Text>}
    {held && <Text style={{ color: colors.muted }}>{t("held")}</Text>}
    {snapshot.qr === "scanned" && <Text style={{ color: colors.muted }}>{t("scanned")}</Text>}
    <View style={styles.actions}>
      {actionable && !held && hasContent && button(t(snapshot.qr === "scan" ? "qrOpen" : "open"), () => setOpen(true))}
      {actionable && held && button(t("claim"), () => decide("claim"))}
      {snapshot.phase === "finishing" && button(t("stay"), () => decide("stay"))}
      {!snapshot.terminal && button(t("refresh"), () => decide("refresh"))}
      {!snapshot.terminal && button(t("done"), () => decide("done"))}
      {!snapshot.terminal && button(t("cancel"), () => decide("cancel"))}
    </View>
    {error && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{error}</Text>}
    {open && actionable && !held && <Modal visible transparent={false} animationType="slide" onRequestClose={close}>
      <SafeAreaView style={[styles.fill, { backgroundColor: colors.background }]}>
        <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : "height"}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheet}>
            <View style={styles.heading}><Text style={[styles.title, { color: colors.ink }]}>{t(snapshot.qr === "scan" ? "qrOpen" : "open")}</Text>{button(t("close"), close, false)}</View>
            <Text style={{ color: colors.ink }}>{snapshot.source.origin ?? snapshot.source.app}</Text>
            {snapshot.picture && (picture ? <Pressable accessibilityRole="imagebutton" accessibilityLabel={t(qr ? "qrLabel" : "pictureLabel")}
              disabled={busy || Boolean(qr) || snapshot.remoteInput !== true} onPress={event => { const target = event.nativeEvent; const { width, height } = pictureBounds.current;
                if (width > 0 && height > 0) submit({ kind: "tap", x: Math.max(0, Math.min(1, target.locationX / width)), y: Math.max(0, Math.min(1, target.locationY / height)) }); }}
              onLayout={event => { pictureBounds.current = event.nativeEvent.layout; }} style={{ width: "100%", aspectRatio: picture.width / picture.height }}>
                <Image accessibilityLabel={t(qr ? "qrLabel" : "pictureLabel")} source={{ uri: `data:image/jpeg;base64,${picture.data}` }} resizeMode="contain" style={styles.fill} />
              </Pressable> : <Text accessibilityLiveRegion="polite" style={{ color: colors.muted }}>{t("pictureLoading")}</Text>)}
            {qr && <View style={styles.actions}>
              {link && button(`${t("openLink")} · ${link.site}`, () => { void Linking.openURL(link.url).catch(() => { if (current()) setError(t("unknown")); }); })}
              {button(t("copyText"), () => copy(() => Clipboard.setStringAsync(qr.text)))}
              {picture && button(t("copyImage"), () => copy(() => Clipboard.setImageAsync(picture.data)))}
            </View>}
            {code && <View style={styles.stack}><Text selectable style={[styles.code, { color: colors.ink }]}>{code.code}</Text><Text style={{ color: colors.muted }}>{code.origin}</Text>
              {button(t("openLink"), () => { void Linking.openURL(code.url).catch(() => { if (current()) setError(t("unknown")); }); })}
              {button(t("copyCode"), () => copy(() => Clipboard.setStringAsync(code.code)))}</View>}
            {!qr && !code && <>
              <MobileInputHandoffFields snapshot={snapshot} draft={draft} disabled={busy || snapshot.remoteInput !== true} colors={colors} locale={locale}
                onChange={(id, value) => { if (current() && !busy) setDraft(previous => ({ ...previous, [id]: value })); }} onSubmit={() => submit({ kind: "submit" })} />
              <View style={styles.actions}>{snapshot.picture && button(t("fill"), () => submit({ kind: "fill" }), busy || !picture || snapshot.remoteInput !== true)}
                {button(t(snapshot.picture ? "enter" : "submit"), () => submit({ kind: "submit" }), busy || Boolean(snapshot.picture && !picture) || snapshot.remoteInput !== true)}</View>
            </>}
            {snapshot.picture && !qr && button(t("form"), () => decide("refresh"))}
            {!snapshot.picture && !code && button(t("picture"), () => decide("picture"))}
            {notice && <Text accessibilityLiveRegion="polite" style={{ color: colors.muted }}>{notice}</Text>}
            {error && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{error}</Text>}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>}
  </View>;
}

const styles = StyleSheet.create({ fill: { flex: 1 }, stack: { gap: 10 }, card: { borderWidth: 1, borderRadius: 16, padding: 14, gap: 10 },
  heading: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 }, title: { fontSize: 17, fontWeight: "600" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, button: { minHeight: 44, justifyContent: "center", borderWidth: 1, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12 },
  sheet: { padding: 18, gap: 18, paddingBottom: 40 }, code: { fontSize: 28, fontWeight: "600", letterSpacing: 3 } });
