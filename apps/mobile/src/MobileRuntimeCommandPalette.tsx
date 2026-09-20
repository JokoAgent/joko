import { useEffect, useRef } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { RuntimeCommandSource } from "@joko/contracts";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import {
  isMobileAppCommandCandidate,
  type MobileCommandPaletteCandidate
} from "./mobile-app-commands";

export type MobileRuntimeCommandPaletteStatus = "loading" | "refreshing" | "ready" | "error";

export function MobileRuntimeCommandPalette({
  visible,
  query,
  items,
  selectedIndex,
  status,
  error,
  runtimeAvailable,
  disabled,
  checkingDraft,
  colors,
  onClose,
  onRefresh,
  onRetry,
  onSelect
}: {
  readonly visible: boolean;
  readonly query: string;
  readonly items: readonly MobileCommandPaletteCandidate[];
  readonly selectedIndex: number;
  readonly status: MobileRuntimeCommandPaletteStatus;
  readonly error?: string;
  readonly runtimeAvailable: boolean;
  readonly disabled: boolean;
  readonly checkingDraft: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
  readonly onRetry: () => void;
  readonly onSelect: (candidate: MobileCommandPaletteCandidate) => void;
}) {
  const listRef = useRef<ScrollView>(null);
  const selectedPosition = items.length === 0 ? -1
    : Math.max(0, Math.min(Number.isSafeInteger(selectedIndex) ? selectedIndex : 0, items.length - 1));
  const selected = selectedPosition < 0 ? undefined : items[selectedPosition];
  useEffect(() => {
    if (!visible || !selected) return;
    listRef.current?.scrollTo?.({ animated: true, y: Math.max(0, selectedPosition * 64 - 6) });
  }, [selected?.commandId, selectedPosition, status, visible]);
  if (!visible) return null;
  const baseUnavailable = disabled || checkingDraft;
  return <View accessibilityLabel="Commands" accessibilityRole="list"
    style={[styles.palette, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    {selected && <Text accessibilityLiveRegion="polite" style={styles.screenReaderStatus}>
      Selected /{selected.name}
    </Text>}
    <View style={styles.header}>
      <View style={styles.headerText}>
        <Text style={[styles.title, { color: colors.ink }]}>Commands</Text>
        <Text style={[styles.query, { color: colors.muted }]} numberOfLines={1}>/{query}</Text>
      </View>
      {status === "refreshing" && <Text accessibilityLiveRegion="polite"
        style={[styles.status, { color: colors.muted }]}>Refreshing…</Text>}
      {checkingDraft && <Text accessibilityLiveRegion="polite"
        style={[styles.status, { color: colors.muted }]}>Checking draft…</Text>}
      <Pressable accessibilityRole="button" accessibilityLabel="Refresh runtime commands"
        accessibilityState={{ disabled: !runtimeAvailable || disabled || status === "loading" || status === "refreshing" }}
        disabled={!runtimeAvailable || disabled || status === "loading" || status === "refreshing"}
        onPress={onRefresh} style={styles.headerButton}>
        <Text style={[styles.headerAction, { color: colors.accent }]}>↻</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Close commands"
        onPress={onClose} style={styles.headerButton}>
        <Text style={[styles.headerAction, { color: colors.ink }]}>×</Text>
      </Pressable>
    </View>
    {status === "error" && <View accessibilityRole="alert" style={styles.errorRow}>
          <Text style={[styles.error, { color: colors.negative }]}>{error || "Runtime commands could not be loaded."}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Retry runtime commands" disabled={!runtimeAvailable || disabled}
            accessibilityState={{ disabled: !runtimeAvailable || disabled }} onPress={onRetry}
            style={[styles.retry, { borderColor: colors.border }, (!runtimeAvailable || disabled) && styles.disabled]}>
            <Text style={[styles.retryText, { color: colors.ink }]}>Retry</Text>
          </Pressable>
        </View>}
    {status === "loading" && items.length === 0 ? <Text accessibilityLiveRegion="polite"
      style={[styles.empty, { color: colors.muted }]}>Loading runtime commands…</Text>
      : items.length === 0 ? <Text accessibilityLiveRegion="polite"
            style={[styles.empty, { color: colors.muted }]}>
            {query ? "No matching commands. Enter and Tab will keep this text unsent."
              : "No commands are available."}
          </Text>
          : <ScrollView ref={listRef} keyboardShouldPersistTaps="always" nestedScrollEnabled style={styles.list}
              contentContainerStyle={styles.listContent}>
              {items.map((item, index) => {
                const selected = index === selectedIndex;
                const unavailable = baseUnavailable
                  || !isMobileAppCommandCandidate(item) && status !== "ready";
                return <Pressable key={item.commandId} accessibilityRole="button"
                  accessibilityLabel={`Insert ${isMobileAppCommandCandidate(item) ? "app" : "runtime"} command /${item.name}`}
                  accessibilityHint={item.description || commandSourceLabel(item)}
                  accessibilityState={{ selected, disabled: unavailable }} disabled={unavailable}
                  onPress={() => onSelect(item)}
                  style={[styles.item, {
                    backgroundColor: selected ? colors.brandBackground : colors.background,
                    borderColor: selected ? colors.accent : colors.border
                  }, unavailable && styles.disabled]}>
                  <View style={styles.itemText}>
                    <Text style={[styles.command, { color: colors.ink }]} numberOfLines={1}>/{item.name}</Text>
                    <Text style={[styles.description, { color: colors.muted }]} numberOfLines={2}>
                      {item.description || commandSourceLabel(item)}
                    </Text>
                  </View>
                  {selected && <Text accessibilityElementsHidden style={[styles.selected, { color: colors.accent }]}>↵</Text>}
                </Pressable>;
              })}
            </ScrollView>}
  </View>;
}

function commandSourceLabel(candidate: MobileCommandPaletteCandidate): string {
  return isMobileAppCommandCandidate(candidate) ? "Joko command" : `${runtimeCommandSourceLabel(candidate.source)} command`;
}

export function runtimeCommandSourceLabel(source: RuntimeCommandSource): string {
  if (source === RuntimeCommandSource.SKILL) return "Skill";
  if (source === RuntimeCommandSource.PROMPT) return "Prompt";
  if (source === RuntimeCommandSource.EXTENSION) return "Extension";
  return "Backend command";
}

const styles = StyleSheet.create({
  command: { fontSize: 14, fontWeight: "700" },
  description: { fontSize: 12, lineHeight: 16, marginTop: 2 },
  disabled: { opacity: 0.55 },
  empty: { fontSize: 13, lineHeight: 18, paddingHorizontal: 12, paddingVertical: 14 },
  error: { flex: 1, fontSize: 12, lineHeight: 17 },
  errorRow: { alignItems: "center", flexDirection: "row", gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  header: { alignItems: "center", flexDirection: "row", minHeight: 42, paddingLeft: 12, paddingRight: 4 },
  headerAction: { fontSize: 20, fontWeight: "700" },
  headerButton: { alignItems: "center", justifyContent: "center", minHeight: 40, minWidth: 40 },
  headerText: { flex: 1, minWidth: 0 },
  item: { alignItems: "center", borderRadius: 10, borderWidth: 1, flexDirection: "row", minHeight: 52, paddingHorizontal: 10, paddingVertical: 7 },
  itemText: { flex: 1, minWidth: 0 },
  list: { maxHeight: 224 },
  listContent: { gap: 6, paddingBottom: 10, paddingHorizontal: 8 },
  palette: { borderRadius: 12, borderWidth: 1, marginBottom: 8, overflow: "hidden" },
  query: { fontSize: 11, marginTop: 1 },
  retry: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 7 },
  retryText: { fontSize: 12, fontWeight: "700" },
  screenReaderStatus: { height: 1, left: -10_000, overflow: "hidden", position: "absolute", width: 1 },
  selected: { fontSize: 16, fontWeight: "700", marginLeft: 8 },
  status: { fontSize: 11 },
  title: { fontSize: 13, fontWeight: "700" }
});
