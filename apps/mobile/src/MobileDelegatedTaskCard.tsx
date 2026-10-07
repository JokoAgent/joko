import { memo, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import {
  buildMobileDelegatedConversation, currentMobileDelegatedChildren, mobileDelegatedChildIdentities,
  mobileDelegatedResultIsInTranscript, mobileSubagentState, projectMobileDelegated,
  type MobileDelegatedEntry
} from "./mobile-delegated";
import {
  MobileDelegatedDetailReader, type MobileDelegatedControls, type MobileDelegatedDetailState, type MobileDelegatedReadClient
} from "./mobile-delegated-reader";
import { mobileDelegatedErrorText, mobileDelegatedSystemText, mobileDelegatedTaskMessage } from "./mobile-delegated-task-messages";
import { useMobileExpandedBlock } from "./mobile-expanded-block-memory";
import { MobileMarkdownMessage } from "./MobileMarkdownMessage";
import { MobileToolCallCard } from "./MobileToolCallCard";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";

const idle: MobileDelegatedDetailState = { phase: "idle", entries: [], childId: "", nextPageToken: "", tailPageToken: "", transcriptAvailable: false };
const noSubscription = (): (() => void) => () => {};

export interface MobileDelegatedTaskCardProps {
  readonly entry: MobileDelegatedEntry;
  readonly entries?: readonly MobileDelegatedEntry[];
  readonly readClient: MobileDelegatedReadClient;
  readonly controls: MobileDelegatedControls;
  readonly colors: MobileInteractionSheetColors;
  readonly locale: MobileSupportedLocale;
  readonly enabled: boolean;
  readonly ancestors?: readonly string[];
}

export const MobileDelegatedTaskCard = memo(function MobileDelegatedTaskCard({ entry, entries = [], readClient, controls,
  colors, locale, enabled, ancestors = [] }: MobileDelegatedTaskCardProps) {
  const [expanded, toggle] = useMobileExpandedBlock(controls.surfaceOwnerKey, entry.key);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const run = entry.run;
  const reader = useMemo(() => run ? new MobileDelegatedDetailReader(readClient, controls, run) : undefined,
    [readClient, controls.authorityKey, run?.subagentRunId, run?.version?.generation]);
  const detail = useSyncExternalStore(reader?.subscribe ?? noSubscription, reader?.snapshot ?? (() => idle), reader?.snapshot ?? (() => idle));
  const interactive = enabled && foreground && readClient.taskDelegatedControls()?.authorityKey === controls.authorityKey;
  const projection = projectMobileDelegated(entry, detail.detail);
  const t = (key: Parameters<typeof mobileDelegatedTaskMessage>[1], values?: Readonly<Record<string, string | number>>) => mobileDelegatedTaskMessage(locale, key, values);
  const title = projection.title || t(run ? "delegated" : "background");
  const children = currentMobileDelegatedChildren(detail.detail?.children ?? []);
  const selectedChild = children.find((child) => child.childId === detail.childId);
  const identities = selectedChild ? mobileDelegatedChildIdentities(selectedChild, detail.detail?.children ?? []) : undefined;
  const content = identities ? detail.entries.filter((item) => !item.childId || identities.has(item.childId)) : detail.entries;
  const conversation = useMemo(() => buildMobileDelegatedConversation(content), [content]);
  const nested = ancestors.length < 5 ? entries.filter((child) => child.run?.parentSubagentRunId === run?.subagentRunId
    && child.run?.subagentRunId !== run?.subagentRunId && !ancestors.includes(child.key)) : [];
  const summary = selectedChild?.result ?? projection.summary;
  const showResult = !mobileDelegatedResultIsInTranscript(summary, content, !detail.nextPageToken && detail.phase !== "loading");
  const metadata = [t(projection.state), projection.model, projection.thinkingLevel,
    projection.tokens === undefined ? "" : t("tokens", { count: projection.tokens }),
    projection.toolUses === undefined ? "" : t("tools", { count: projection.toolUses }),
    projection.durationMs === undefined ? "" : `${Math.round(projection.durationMs / 1_000)}s`,
    projection.costUsd === undefined ? "" : `$${projection.costUsd.toFixed(4)}`,
    projection.readOnly === undefined ? "" : t(projection.readOnly ? "readOnly" : "writeAccess")].filter(Boolean);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setForeground(state === "active"); if (state !== "active") reader?.retire();
    });
    return () => { subscription.remove(); reader?.retire(); };
  }, [reader]);
  useEffect(() => {
    if (run) reader?.updateRun(run);
    if (expanded && interactive && reader) void reader.refresh();
    else reader?.cancel();
    return () => reader?.cancel();
  }, [reader, expanded, interactive, run?.version?.revision?.value, entry.refreshKey]);

  const action = (label: string, onPress: () => void, selected = false, disabled = false) =>
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected, disabled: !interactive || disabled }}
      disabled={!interactive || disabled} onPress={onPress} style={[styles.action, { borderColor: selected ? colors.accent : colors.border }]}>
      <Text style={{ color: colors.accent }}>{label}</Text>
    </Pressable>;
  const markdown = (text: string, block: string) => <MobileMarkdownMessage text={text} colors={colors} locale={locale}
    ownerKey={JSON.stringify([controls.surfaceOwnerKey, entry.key, block])} />;

  return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={t(expanded ? "collapse" : "expand", { name: title })}
      accessibilityState={{ expanded, disabled: !interactive }} disabled={!interactive} onPress={toggle} style={styles.heading}>
      <Text style={{ color: projection.state === "failed" ? colors.negative : colors.muted }}>
        {projection.state === "completed" ? "✓" : projection.state === "failed" ? "!" : projection.state === "stopped" ? "×" : "○"}
      </Text>
      <View style={styles.fill}><Text style={[styles.title, { color: colors.ink }]}>{title}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{metadata.join(" · ")}</Text></View>
      <Text style={{ color: colors.muted }}>{expanded ? "⌄" : "›"}</Text>
    </Pressable>
    {!expanded && projection.summary !== "" && <Text selectable numberOfLines={3} style={[styles.summary, { color: colors.ink }]}>{projection.summary}</Text>}
    {projection.statusText !== "" && <Text selectable style={[styles.caption, { color: colors.muted }]}>{projection.statusText}</Text>}
    {projection.progress !== undefined && <Text style={[styles.caption, { color: colors.muted }]}>{Math.round(projection.progress * 100)}%</Text>}
    {projection.error !== "" && <Text selectable style={[styles.caption, { color: colors.negative }]}>{mobileDelegatedErrorText(projection.error, locale)}</Text>}
    {expanded && interactive && <View style={[styles.details, { borderColor: colors.border }]}>
      {(selectedChild?.assignment || projection.assignment) !== "" && <View><Text style={[styles.section, { color: colors.muted }]}>{t("assignment")}</Text>
        {markdown(selectedChild?.assignment || projection.assignment, "assignment")}</View>}
      {children.length > 0 && <View><Text style={[styles.section, { color: colors.muted }]}>{t("children", { count: children.length })}</Text>
        <View style={styles.actions}>{action(t("allChildren"), () => void reader?.selectChild(""), !detail.childId, detail.phase === "loading")}
          {children.map((child) => <View key={child.childId}>{action(child.title || child.childId, () => void reader?.selectChild(child.childId), child.childId === detail.childId, detail.phase === "loading")}
            <Text style={[styles.caption, { color: colors.muted }]}>{[child.role, t(child.awaitingApproval ? "awaitingApproval" : mobileSubagentState(child.state)),
              child.readOnly === undefined ? "" : t(child.readOnly ? "readOnly" : "writeAccess")].filter(Boolean).join(" · ")}</Text></View>)}</View>
      </View>}
      {showResult && summary !== "" && <View><Text style={[styles.section, { color: colors.muted }]}>{t("result")}</Text>{markdown(summary, "result")}</View>}
      {(projection.resultTruncated || selectedChild?.resultTruncated) && <Text style={[styles.caption, { color: colors.muted }]}>{t("truncated")}</Text>}
      {selectedChild?.error?.message && <Text selectable style={{ color: colors.negative }}>{mobileDelegatedErrorText(selectedChild.error.message, locale)}</Text>}
      {detail.detail?.run?.capabilities?.viewActivity && detail.detail.activity.length > 0 && <View>
        <Text style={[styles.section, { color: colors.muted }]}>{t("activity")}</Text>
        {detail.detail.activity.map((activity) => <Text selectable key={activity.sequence.toString()} style={[styles.caption, { color: colors.muted }]}>
          {[t(mobileSubagentState(activity.state)), activity.summary, activity.lastToolName].filter(Boolean).join(" · ")}</Text>)}
      </View>}
      {conversation.length > 0 && <Text style={[styles.section, { color: colors.muted }]}>{t("content")}</Text>}
      {conversation.map((item) => <View key={item.id} style={styles.message}>
        {item.kind === "tool" && item.tool ? <MobileToolCallCard ownerKey={controls.surfaceOwnerKey} enabled={interactive} colors={colors} locale={locale}
          call={{ scopeKey: JSON.stringify([entry.key, detail.childId, item.childId, item.id]), name: item.tool.name,
            state: item.tool.isError ? "failed" : item.tool.done ? "succeeded" : "running", input: item.tool.input,
            output: item.tool.output, error: item.tool.isError ? item.tool.output : "", inputTruncated: false,
            inputRedacted: false, outputTruncated: false }} /> : <>
          <Text style={[styles.caption, { color: colors.muted }]}>{item.childTitle || t(item.kind === "tool" ? "activity" : item.kind)}</Text>
          {item.kind === "system" ? <Text selectable style={{ color: colors.muted }}>{mobileDelegatedSystemText(item.entry, locale)}</Text>
            : markdown(item.text, item.id)}
        </>}
      </View>)}
      {run && !controls.canReadDetail && <Text style={{ color: colors.muted }}>{t("unavailable")}</Text>}
      {detail.detail && !detail.transcriptAvailable && <Text style={{ color: colors.muted }}>{t("unavailable")}</Text>}
      {detail.phase === "loading" && <View><Text accessibilityLiveRegion="polite" style={{ color: colors.muted }}>{t("loading")}</Text>
        {action(t("cancel"), () => reader?.cancel())}</View>}
      {detail.phase === "empty" && <Text style={{ color: colors.muted }}>{t("empty")}</Text>}
      {(detail.phase === "error" || detail.phase === "cancelled") && <View>
        <Text accessibilityLiveRegion="polite" style={{ color: colors.negative }}>{t(detail.phase === "cancelled" ? "cancelled" : detail.error ?? "readFailed")}</Text>
        {action(t("retry"), () => void reader?.refresh())}</View>}
      {detail.nextPageToken && action(t("loadMore"), () => void reader?.loadMore(), false, detail.phase === "loading")}
      {nested.map((child) => <MobileDelegatedTaskCard key={child.key} entry={child} entries={entries} readClient={readClient} controls={controls}
        colors={colors} locale={locale} enabled={interactive} ancestors={[...ancestors, entry.key]} />)}
    </View>}
  </View>;
});

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, gap: 8, minWidth: 0 },
  heading: { flexDirection: "row", alignItems: "center", gap: 9, minHeight: 44 }, fill: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, fontWeight: "600" }, caption: { fontSize: 12, lineHeight: 18 },
  summary: { fontSize: 13, lineHeight: 19 }, details: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, gap: 12 },
  section: { fontSize: 12, fontWeight: "600", marginBottom: 6 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, action: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, padding: 8, minHeight: 44, justifyContent: "center", alignItems: "center" },
  message: { gap: 5 }
});
