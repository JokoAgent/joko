import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { MobileKeyboardAvoidingView, useMobileKeyboardState } from "./MobileKeyboardAvoidingView";
import { findMobileConversationSearchHits, nextConversationSearchIndex, normalizeConversationSearchIndex,
  type MobileConversationSearchHit, type MobileConversationSearchText } from "./mobile-conversation-search";
import type { TimelineRow } from "./timeline";
import type { MobileWorkItem } from "./mobile-work-projection";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { MobileConversationSearchNative } from "./MobileConversationSearchNative";

export function MobileConversationSearchSheet({ visible, rows, additional, colors, locale, hasEarlier, loadingEarlier, canLoadEarlier,
  onClose, onFocus, onLoadEarlier }: {
  readonly visible: boolean; readonly rows: readonly MobileWorkItem<TimelineRow>[];
  readonly additional?: readonly MobileConversationSearchText[];
  readonly colors: { readonly surface: string; readonly ink: string; readonly muted: string; readonly border: string; readonly negative: string; readonly dark?: boolean };
  readonly locale: MobileSupportedLocale; readonly hasEarlier: boolean; readonly loadingEarlier: boolean; readonly canLoadEarlier: boolean;
  readonly onClose: () => void; readonly onFocus: (hit: MobileConversationSearchHit) => void;
  readonly onLoadEarlier: () => Promise<void>;
}) {
  const [query, setQuery] = useState(""); const [index, setIndex] = useState(0); const [failed, setFailed] = useState(false);
  const hits = useMemo(() => findMobileConversationSearchHits(rows, query, additional), [rows, query, additional]);
  const activeIndex = normalizeConversationSearchIndex(hits.length, index), active = hits[activeIndex];
  const owner = useRef<object>({}); const busy = useRef(false);
  const callbacks = useRef({ onFocus, onClose }); callbacks.current = { onFocus, onClose };
  const insets = useSafeAreaInsets(), keyboard = useMobileKeyboardState();
  useEffect(() => {
    const current = {}; owner.current = current;
    if (!visible) return;
    const subscription = AppState.addEventListener("change", (state) => { if (state !== "active") callbacks.current.onClose(); });
    return () => { owner.current = {}; busy.current = false; subscription.remove(); };
  }, [visible]);
  useEffect(() => { if (visible && active) callbacks.current.onFocus(active); }, [visible, active?.itemKey, active?.sourceKey, query]);
  const changeQuery = (text: string): void => { setQuery(text); setIndex(0); setFailed(false); };
  const earlier = async (): Promise<void> => {
    if (!visible || busy.current || loadingEarlier || !canLoadEarlier || !hasEarlier) return;
    const current = owner.current; busy.current = true; setFailed(false);
    try { await onLoadEarlier(); }
    catch { if (owner.current === current) setFailed(true); }
    finally { if (owner.current === current) busy.current = false; }
  };
  const action = (label: string, onPress: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.action, { borderColor: colors.border }, disabled && styles.disabled]}>
    <Text style={{ color: colors.ink }}>{label}</Text>
  </Pressable>;
  const counter = query.trim() ? `${Math.max(0, activeIndex + 1)} / ${hits.length}` : mobileMessage(locale, "conversationSearch.keyword");
  if (Platform.OS === "ios") return <MobileConversationSearchNative visible={visible} query={query} counter={counter} hasHits={hits.length > 0}
    title={mobileMessage(locale, "conversationSearch.title")} placeholder={mobileMessage(locale, "conversationSearch.placeholder")}
    clearLabel={mobileMessage(locale, "conversationSearch.clear")} previousLabel={mobileMessage(locale, "conversationSearch.previous")} nextLabel={mobileMessage(locale, "conversationSearch.next")}
    earlier={{ visible: query.trim() !== "" && hasEarlier, disabled: loadingEarlier || !canLoadEarlier,
      label: mobileMessage(locale, loadingEarlier ? "task.loadingHistory" : "conversationSearch.earlier") }}
    failed={failed ? mobileMessage(locale, "conversationSearch.failed") : undefined} colors={colors}
    onChangeQuery={changeQuery} onClose={onClose} onMove={(direction) => setIndex(nextConversationSearchIndex(hits.length, activeIndex, direction))}
    onLoadEarlier={() => { void earlier(); }} />;
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
    <MobileKeyboardAvoidingView style={styles.overlay} keyboard={keyboard} consumedBottomInset={insets.bottom}>
      <Pressable style={styles.backdrop} accessibilityLabel={mobileMessage(locale, "common.close")} onPress={onClose} />
      <SafeAreaView edges={["bottom"]} style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.header}><Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, "conversationSearch.title")}</Text>
          {action(mobileMessage(locale, "common.close"), onClose)}</View>
        <View style={[styles.inputRow, { borderColor: colors.border }]}>
          <TextInput value={query} onChangeText={changeQuery} autoFocus={visible} autoCapitalize="none" autoCorrect={false} returnKeyType="search"
            accessibilityLabel={mobileMessage(locale, "conversationSearch.placeholder")} placeholder={mobileMessage(locale, "conversationSearch.placeholder")}
            placeholderTextColor={colors.muted} style={[styles.input, { color: colors.ink }]} />
          {query !== "" && action(mobileMessage(locale, "conversationSearch.clear"), () => changeQuery(""))}
        </View>
        <View style={styles.toolbar}><Text accessibilityLiveRegion="polite" style={[styles.counter, { color: colors.muted }]}>{counter}</Text>
          {action(mobileMessage(locale, "conversationSearch.previous"), () => setIndex(nextConversationSearchIndex(hits.length, activeIndex, "previous")), hits.length === 0)}
          {action(mobileMessage(locale, "conversationSearch.next"), () => setIndex(nextConversationSearchIndex(hits.length, activeIndex, "next")), hits.length === 0)}</View>
        {query.trim() !== "" && hasEarlier && <View style={styles.toolbar}>{loadingEarlier && <ActivityIndicator color={colors.muted} />}
          {action(mobileMessage(locale, loadingEarlier ? "task.loadingHistory" : "conversationSearch.earlier"), () => { void earlier(); }, loadingEarlier || !canLoadEarlier)}</View>}
        {failed && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{mobileMessage(locale, "conversationSearch.failed")}</Text>}
      </SafeAreaView>
    </MobileKeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end" }, backdrop: { flex: 1 },
  sheet: { borderTopWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, gap: 16 },
  header: { flexDirection: "row", alignItems: "center", gap: 12 }, title: { flex: 1, fontSize: 17, fontWeight: "600" },
  inputRow: { flexDirection: "row", alignItems: "center", borderWidth: StyleSheet.hairlineWidth, borderRadius: 24, paddingHorizontal: 14, minHeight: 48 },
  input: { flex: 1, minWidth: 0, fontSize: 16, paddingVertical: 10 },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }, counter: { flex: 1, fontSize: 14 },
  action: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9, minHeight: 40 }, disabled: { opacity: 0.45 }
});
