import { useEffect, useRef, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MobileKeyboardAvoidingView, useMobileKeyboardState } from "./MobileKeyboardAvoidingView";
import { MobileObjectiveView, type MobileObjectiveViewProps } from "./MobileObjectiveView";
import { MobileObjectiveNativeSheet } from "./MobileObjectiveNativeSheet";
import { mobileMessage } from "./mobile-messages";
import type { MobileObjectiveApi, MobileObjectiveInput } from "./mobile-objective";
import { useMobileObjective } from "./use-mobile-objective";

export interface MobileObjectiveSheetProps extends Pick<MobileObjectiveViewProps, "colors" | "locale" | "dark"> {
  readonly visible: boolean;
  readonly api?: MobileObjectiveApi;
  readonly initialText?: string;
  readonly disabled: boolean;
  readonly onClose: () => void;
  readonly onCheck?: () => Promise<void>;
  readonly onSaved?: (input: MobileObjectiveInput) => Promise<void>;
  readonly create?: { readonly ownerKey: string; readonly submit: (input: MobileObjectiveInput) => Promise<void> };
}
export function MobileObjectiveSheet(props: MobileObjectiveSheetProps) {
  const keyboard = useMobileKeyboardState();
  const projection = useMobileObjective(props.api, props.visible);
  const [creating, setCreating] = useState(false), [error, setError] = useState<string>();
  const flight = useRef(false), owner = props.create?.ownerKey ?? props.api?.ownerKey;
  const context = useRef({ owner, visible: props.visible }); context.current = { owner, visible: props.visible };
  useEffect(() => { setCreating(false); setError(undefined); flight.current = false; }, [owner, props.visible]);
  const loading = props.create === undefined && !projection.loaded;
  const busy = creating || projection.busy;
  const close = (): void => { if (!busy) props.onClose(); };
  const set = async (input: MobileObjectiveInput): Promise<void> => {
    if (flight.current || props.disabled || loading) return;
    const original = owner; flight.current = true; setError(undefined);
    const current = (): boolean => context.current.owner === original && context.current.visible;
    try {
      if (props.create) { setCreating(true); await props.create.submit(input); }
      else if (!await projection.mutate("set", input)) return;
      if (!current()) return;
      await props.onSaved?.(input); if (current()) props.onClose();
    } catch (failure) {
      if (current()) setError(failure instanceof Error ? failure.message : mobileMessage(props.locale, "objective.error"));
    } finally { if (current()) { flight.current = false; setCreating(false); } }
  };
  const view: MobileObjectiveViewProps = { colors: props.colors, locale: props.locale, dark: props.dark,
    objective: projection.objective, initial: projection.initial ?? { text: props.initialText ?? "" },
    error: error ?? projection.error, disabled: props.disabled || loading || props.api?.writable === false, busy,
    onSet: input => void set(input), onPause: () => void projection.mutate("pause"),
    onResume: () => void projection.mutate("resume"), onClear: () => void projection.mutate("clear") };
  const retry = props.api === undefined ? undefined : () => {
    if (busy) return;
    void props.onCheck?.().then(() => projection.retry()).catch(failure => setError(failure instanceof Error ? failure.message : mobileMessage(props.locale, "objective.error")));
    if (!props.onCheck) projection.retry();
  };
  const contentKey = `${owner ?? "none"}\u001f${projection.initial === undefined ? "composer" : "restored"}\u001f${props.visible}`;
  if (Platform.OS === "ios") return <MobileObjectiveNativeSheet key={contentKey} {...view} visible={props.visible}
    loading={loading} onClose={close} onRetry={retry} />;
  return <Modal visible={props.visible} transparent animationType="slide" onRequestClose={close}>
    <MobileKeyboardAvoidingView style={styles.root} keyboard={keyboard}>
      <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(props.locale, "common.close")} onPress={close} style={styles.backdrop} />
      <SafeAreaView accessibilityViewIsModal edges={["bottom", "left", "right"]}
        style={[styles.sheet, { backgroundColor: props.colors.surface, borderColor: props.colors.border }]}>
        <View style={styles.header}><Text accessibilityRole="header" style={[styles.title, { color: props.colors.ink }]}>{mobileMessage(props.locale, "objective.title")}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(props.locale, "common.close")} disabled={busy} onPress={close} style={styles.close}>
            <Text style={[styles.title, { color: props.colors.ink }]}>×</Text></Pressable></View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          {loading ? <Text style={{ color: props.colors.muted }}>{mobileMessage(props.locale, "objective.loading")}</Text>
            : <MobileObjectiveView key={contentKey} {...view} />}
          {loading && view.error && <Text accessibilityRole="alert" style={{ color: props.colors.negative }}>{view.error}</Text>}
          {retry && <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(props.locale, "objective.check")} disabled={busy} onPress={retry} style={styles.close}>
            <Text style={{ color: props.colors.accent }}>{mobileMessage(props.locale, "objective.check")}</Text></Pressable>}
        </ScrollView>
      </SafeAreaView>
    </MobileKeyboardAvoidingView>
  </Modal>;
}
const styles = StyleSheet.create({ root: { flex: 1, justifyContent: "flex-end" }, backdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.3)" },
  sheet: { maxHeight: "92%", borderTopWidth: 1, borderTopLeftRadius: 22, borderTopRightRadius: 22 },
  header: { flexDirection: "row", alignItems: "center", paddingLeft: 18, paddingRight: 8, minHeight: 60 },
  title: { fontSize: 20, fontWeight: "600", flex: 1 }, close: { minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center" },
  content: { padding: 18, gap: 14 } });
