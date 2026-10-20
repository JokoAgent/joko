import { useEffect, useRef, useState } from "react";
import { AppState, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SessionTitleSuggestionStatus, type SuggestSessionTitleResponse } from "@joko/contracts";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

/** A suggestion edits only this occurrence's draft; saving remains an explicit action. */
export function MobileTaskRenameSheet({ visible, ownerKey, name, busy, colors, locale, isCurrent, onClose, onSuggest, onConfirm }: {
  readonly visible: boolean; readonly ownerKey?: string; readonly name: string; readonly busy: boolean;
  readonly colors: MobileInteractionSheetColors; readonly locale: MobileSupportedLocale;
  readonly isCurrent: (ownerKey: string) => boolean; readonly onClose: () => void;
  readonly onSuggest: (ownerKey: string, signal: AbortSignal) => Promise<SuggestSessionTitleResponse>;
  readonly onConfirm: (ownerKey: string, name: string) => void;
}) {
  const [draft, setDraft] = useState(name);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<"task.renameNoMaterial" | "task.renameProviderUnavailable" | "task.renameFailed">();
  const occurrence = useRef(0);
  const request = useRef<AbortController | undefined>(undefined);
  const current = useRef({ visible, ownerKey, name, isCurrent, onClose });
  current.current = { visible, ownerKey, name, isCurrent, onClose };
  const retire = (): void => { occurrence.current++; request.current?.abort(); request.current = undefined; setGenerating(false); };
  const close = (): void => { retire(); setDraft(current.current.name); setError(undefined); current.current.onClose(); };
  const active = (): boolean => !!ownerKey && current.current.visible && current.current.ownerKey === ownerKey
    && AppState.currentState === "active" && current.current.isCurrent(ownerKey);
  useEffect(() => {
    retire(); setDraft(name); setError(undefined);
    return () => { occurrence.current++; request.current?.abort(); request.current = undefined; };
  }, [visible, ownerKey, name]);
  useEffect(() => {
    const listener = AppState.addEventListener("change", state => { if (state !== "active") close(); });
    return () => listener.remove();
  }, []);
  const suggest = async (): Promise<void> => {
    if (!active() || busy || request.current || !ownerKey) return;
    const controller = new AbortController(), attempt = ++occurrence.current;
    request.current = controller; setGenerating(true); setError(undefined);
    try {
      const result = await onSuggest(ownerKey, controller.signal);
      if (controller.signal.aborted || occurrence.current !== attempt || !active()) return;
      const title = result.title.trim();
      if (result.status === SessionTitleSuggestionStatus.OK && title) setDraft(title.slice(0, 256));
      else setError(result.status === SessionTitleSuggestionStatus.NO_MATERIAL ? "task.renameNoMaterial"
        : result.status === SessionTitleSuggestionStatus.PROVIDER_UNAVAILABLE ? "task.renameProviderUnavailable" : "task.renameFailed");
    } catch {
      if (!controller.signal.aborted && occurrence.current === attempt && active()) setError("task.renameFailed");
    } finally {
      if (request.current === controller) { request.current = undefined; setGenerating(false); }
    }
  };
  const confirm = (): void => {
    if (!active() || busy || !ownerKey || !draft.trim()) return;
    const title = draft.trim(); retire();
    if (title !== name.trim()) onConfirm(ownerKey, title);
    current.current.onClose();
  };
  const button = (label: string, onPress: () => void, disabled = false) => <Pressable accessibilityRole="button"
    accessibilityLabel={label} disabled={disabled} accessibilityState={{ disabled }} onPress={onPress}
    style={[styles.button, { borderColor: colors.border }, disabled && styles.disabled]}>
    <Text style={{ color: colors.ink }}>{label}</Text>
  </Pressable>;
  return <Modal visible={visible && !!ownerKey} transparent animationType="fade" onRequestClose={close}>
    <View style={styles.backdrop}>
      <View accessibilityViewIsModal style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, "home.renameTitle")}</Text>
        <TextInput accessibilityLabel={mobileMessage(locale, "home.taskName")} autoFocus selectTextOnFocus maxLength={256}
          value={draft} editable={!busy} returnKeyType="done" onSubmitEditing={confirm}
          onChangeText={value => { retire(); setDraft(value); setError(undefined); }}
          style={[styles.input, { color: colors.ink, backgroundColor: colors.background, borderColor: colors.border }]} />
        {button(mobileMessage(locale, generating ? "task.renameSuggesting" : "task.renameSuggest"), () => void suggest(), busy || generating)}
        {error && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{mobileMessage(locale, error)}</Text>}
        <View style={styles.actions}>
          {button(mobileMessage(locale, "common.cancel"), close)}
          {button(mobileMessage(locale, "common.rename"), confirm, busy || !draft.trim())}
        </View>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: "center", justifyContent: "center", padding: 20, backgroundColor: "rgba(0,0,0,0.38)" },
  card: { width: "100%", maxWidth: 400, padding: 20, borderWidth: 1, borderRadius: 18, gap: 16 },
  title: { fontSize: 22, fontWeight: "700" }, input: { minHeight: 48, padding: 12, borderWidth: 1, borderRadius: 12, fontSize: 16 },
  actions: { flexDirection: "row", gap: 12, justifyContent: "flex-end" },
  button: { minHeight: 44, paddingHorizontal: 16, justifyContent: "center", borderRadius: 12, borderWidth: 1 }, disabled: { opacity: 0.45 }
});
