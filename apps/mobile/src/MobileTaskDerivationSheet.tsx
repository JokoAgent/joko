import { useEffect, useRef, useState } from "react";
import { AppState, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { MobileMessageForkResult, MobileTaskCloneControls, MobileTaskCloneResult } from "./mobile-client";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

export function MobileTaskDerivationSheet({ visible, kind, controls, busy, colors, locale, onClose, onSubmit, onOpen, onError }: {
  readonly visible: boolean; readonly kind: "clone" | "fork";
  readonly controls?: Omit<MobileTaskCloneControls, "canClone"> & { readonly canDerive: boolean; readonly restoreInput?: boolean };
  readonly busy: boolean;
  readonly colors: MobileInteractionSheetColors; readonly locale: MobileSupportedLocale;
  readonly onClose: () => void;
  readonly onSubmit: (authorityKey: string, name: string, signal: AbortSignal) => Promise<MobileTaskCloneResult | MobileMessageForkResult>;
  readonly onOpen: (sessionId: string) => void; readonly onError: (message: string) => void;
}) {
  const [owner, setOwner] = useState<string>();
  const [name, setName] = useState("");
  const [settling, setSettling] = useState(false);
  const [notice, setNotice] = useState<"unknown" | "failed" | "draftFailed">();
  const [created, setCreated] = useState<string>();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const request = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const active = visible && foreground && owner !== undefined && owner === controls?.surfaceOwnerKey;
  const activeRef = useRef(active);
  activeRef.current = active;
  const close = (): void => { request.current?.abort(); closeRef.current(); };

  useEffect(() => {
    if (visible && controls) {
      setOwner(controls.surfaceOwnerKey);
      setName(mobileMessage(locale, `${kind}.defaultName`, { name: controls.sourceName.slice(0, 105) }));
      setNotice(undefined); setCreated(undefined); setSettling(false);
    } else { request.current?.abort(); setOwner(undefined); }
  }, [visible]);
  useEffect(() => {
    if (visible && owner && owner !== controls?.surfaceOwnerKey) close();
  }, [visible, owner, controls?.surfaceOwnerKey]);
  useEffect(() => {
    mounted.current = true;
    const listener = AppState.addEventListener("change", (state) => {
      setForeground(state === "active");
      if (state !== "active") { request.current?.abort(); closeRef.current(); }
    });
    return () => { mounted.current = false; request.current?.abort(); listener.remove(); };
  }, []);

  const confirm = async (): Promise<void> => {
    if (!active || !controls?.canDerive || busy || request.current || !name.trim() || created || notice === "unknown") return;
    const controller = new AbortController();
    request.current = controller; setSettling(true); setNotice(undefined);
    try {
      const result = await onSubmit(controls.authorityKey, name, controller.signal);
      if (controller.signal.aborted || !mounted.current || !activeRef.current || request.current !== controller) return;
      if (result.kind === "cloned" || result.kind === "forked") {
        setCreated(result.sessionId);
        if (result.kind === "forked" && !result.draftRestored) setNotice("draftFailed");
      } else if (result.kind === "unknown") setNotice("unknown");
      else if (result.kind === "rejected") setNotice("failed");
    } catch (error) {
      if (!controller.signal.aborted && mounted.current && activeRef.current) onError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request.current === controller) request.current = undefined;
      if (mounted.current && activeRef.current) setSettling(false);
    }
  };
  const button = (label: string, action: () => void, disabled = false) => <Pressable accessibilityRole="button"
    accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={action}
    style={[styles.button, { backgroundColor: colors.accent }, disabled && styles.disabled]}>
    <Text style={[styles.buttonText, { color: colors.ink }]}>{label}</Text>
  </Pressable>;
  return <Modal visible={active} animationType="slide" onRequestClose={close}>
    <SafeAreaView style={[styles.fill, { backgroundColor: colors.background }]}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, `${kind}.title`)}</Text>
        <Text style={[styles.body, { color: colors.muted }]}>{mobileMessage(locale, `${kind}.body`, { name: controls?.sourceName ?? "" })}</Text>
        {kind === "fork" && controls?.restoreInput && <Text style={[styles.body, { color: colors.muted }]}>{mobileMessage(locale, "fork.restoreInput")}</Text>}
        <TextInput accessibilityLabel={mobileMessage(locale, `${kind}.name`)} value={name} maxLength={120}
          editable={!busy && !settling && !created} onChangeText={setName}
          style={[styles.input, { color: colors.ink, borderColor: colors.border, backgroundColor: colors.surface }]} />
        {notice && <Text accessibilityLiveRegion="polite" style={[styles.body, { color: colors.muted }]}>{mobileMessage(locale,
          notice === "draftFailed" ? "fork.draftFailed" : `${kind}.${notice}`)}</Text>}
        {created ? button(mobileMessage(locale, `${kind}.open`), () => { if (activeRef.current) onOpen(created); })
          : button(mobileMessage(locale, settling ? `${kind}.working` : `${kind}.confirm`), () => void confirm(),
            busy || settling || Boolean(request.current) || notice === "unknown" || !controls?.canDerive || !name.trim())}
        {button(mobileMessage(locale, "common.close"), close)}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 }, content: { padding: 20, gap: 18 }, title: { fontSize: 22, fontWeight: "700" },
  body: { fontSize: 15, lineHeight: 22 }, input: { minHeight: 48, borderWidth: 1, borderRadius: 12, padding: 12, fontSize: 16 },
  button: { minHeight: 48, borderRadius: 12, justifyContent: "center", alignItems: "center", padding: 12 },
  buttonText: { fontSize: 15, fontWeight: "700" }, disabled: { opacity: 0.5 }
});
