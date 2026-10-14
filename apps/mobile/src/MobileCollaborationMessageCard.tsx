import { memo, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from "react-native";
import type { CollaborationReportOrigin } from "@joko/contracts";
import type { MobileCollaborationMessage } from "./mobile-collaboration-timeline";
import { mobileCollaborationCopy } from "./mobile-collaboration-messages";
import { mobileMessage } from "./mobile-messages";
import { useMobileExpandedBlock } from "./mobile-expanded-block-memory";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";

export interface MobileCollaborationMessageCardProps {
  readonly message: MobileCollaborationMessage;
  readonly ownerKey: string;
  readonly blockKey: string;
  readonly enabled: boolean;
  readonly canOpen: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly locale: MobileSupportedLocale;
  readonly onOpen?: (origin: CollaborationReportOrigin, signal: AbortSignal) => Promise<void>;
}

/** One canonical Timeline row; expanding and opening never dispatch more work. */
export const MobileCollaborationMessageCard = memo(function MobileCollaborationMessageCard(props: MobileCollaborationMessageCardProps) {
  const { message, ownerKey, blockKey, colors, locale } = props, copy = mobileCollaborationCopy(locale);
  const [expanded, toggle] = useMobileExpandedBlock(ownerKey, `collaboration:${blockKey}:${message.variant}`);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [opening, setOpening] = useState(false), [failed, setFailed] = useState(false);
  const pending = useRef<AbortController | undefined>(undefined), current = useRef(props); current.current = props;
  useEffect(() => {
    setOpening(false); setFailed(false);
    const subscription = AppState.addEventListener("change", state => {
      setForeground(state === "active"); if (state !== "active") { pending.current?.abort(); pending.current = undefined; setOpening(false); }
    });
    return () => { subscription.remove(); pending.current?.abort(); pending.current = undefined; };
  }, [ownerKey, blockKey]);
  useEffect(() => { if (!props.canOpen) { pending.current?.abort(); pending.current = undefined; setOpening(false); } }, [props.canOpen]);
  const title = (message.action === "create" ? copy.dispatchTitle : message.action === "batch" ? copy.batchTitle
    : message.action === "send" ? copy.sendTitle : copy.reportTitle).replace("{name}", message.label).replace("{count}", String(message.count ?? 0));
  const interactive = props.enabled && foreground, body = message.body.trim() ? message.body : undefined;
  const state = message.state;
  const stateLabel = state === undefined ? undefined : mobileMessage(locale, `tool.state.${state}`);
  const heading = <>
    {state === "running" ? <ActivityIndicator size="small" color={colors.muted} /> : <Text accessibilityElementsHidden style={{ color: state === "failed" ? colors.negative : colors.muted }}>
      {state === "succeeded" ? "✓" : state === "failed" ? "!" : state === "aborted" ? "×" : "◇"}</Text>}
    <View style={styles.fill}><Text style={[styles.title, { color: colors.ink }]} numberOfLines={1}>{title}</Text>
      {stateLabel && <Text style={[styles.caption, { color: colors.muted }]}>{stateLabel}</Text>}</View>
    {body && <Text accessibilityElementsHidden style={{ color: colors.muted }}>{expanded ? "⌄" : "›"}</Text>}
  </>;
  const open = async (): Promise<void> => {
    if (!interactive || !props.canOpen || !props.onOpen || !message.origin || pending.current) return;
    const controller = new AbortController(); pending.current = controller; setOpening(true); setFailed(false);
    try { await props.onOpen(message.origin, controller.signal); }
    catch { if (!controller.signal.aborted && pending.current === controller && current.current.ownerKey === ownerKey) setFailed(true); }
    finally { if (pending.current === controller) { pending.current = undefined; setOpening(false); } }
  };
  return <View style={styles.card}>
    {message.origin && <Pressable accessibilityRole="button" accessibilityLabel={copy.reportSource.replace("{name}", message.label)}
      accessibilityState={{ disabled: !interactive || !props.canOpen || opening }} disabled={!interactive || !props.canOpen || opening}
      onPress={() => void open()} style={styles.source}>
      <Text style={[styles.caption, { color: props.canOpen ? colors.accent : colors.muted }]}>{copy.reportSource.replace("{name}", message.label)}</Text>
      {opening && <ActivityIndicator size="small" color={colors.muted} />}
    </Pressable>}
    {body ? <Pressable accessibilityRole="button" accessibilityLabel={(expanded ? copy.collapse : copy.expand).replace("{name}", title)}
      accessibilityState={{ expanded, disabled: !interactive }} disabled={!interactive} onPress={toggle} style={styles.heading}>{heading}</Pressable>
      : <View style={styles.heading}>{heading}</View>}
    {body && expanded && <Text selectable style={[styles.body, { color: colors.ink, borderColor: colors.border }]}>{body}</Text>}
    {message.error && <Text selectable accessibilityLiveRegion="polite" style={[styles.caption, { color: colors.negative }]}>{message.error}</Text>}
    {failed && <Text accessibilityLiveRegion="polite" style={[styles.caption, { color: colors.negative }]}>{copy.openFailed}</Text>}
  </View>;
});

const styles = StyleSheet.create({
  card: { minWidth: 0, gap: 6 }, fill: { flex: 1, minWidth: 0 },
  heading: { flexDirection: "row", alignItems: "center", gap: 9, minHeight: 44 },
  source: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 },
  title: { fontSize: 14, fontWeight: "600" }, caption: { fontSize: 12, lineHeight: 18 },
  body: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, fontSize: 13, lineHeight: 20 }
});
