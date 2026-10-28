import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ModelSourceKind, decodeModelSpeed, type Snapshot } from "@joko/contracts";
import { resolveMobileModelSpeed } from "./mobile-runtime-controls";
import { MobileModelSpeedControl } from "./MobileModelSpeedControl";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import type { MobileModelRoute } from "./mobile-runtime-controls";
import type { MobileNewTaskSourceSelection } from "./mobile-new-task-model-memory";

/** The new-task entry consumes the same authoritative source routes as the
 * task picker, while its selected configuration stays a draft until send. */
export function MobileNewTaskModelSelector({ models, value, favorites, colors, locale, disabled, onSelect, onFavorite }: {
  readonly models: readonly MobileModelRoute[];
  readonly value?: MobileNewTaskSourceSelection;
  readonly favorites: NonNullable<Snapshot["settings"]>["modelFavorites"];
  readonly colors: MobileInteractionSheetColors;
  readonly locale: MobileSupportedLocale;
  readonly disabled: boolean;
  readonly onSelect: (selection: MobileNewTaskSourceSelection) => Promise<void>;
  readonly onFavorite: (selection: MobileNewTaskSourceSelection) => Promise<void>;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const [choice, setChoice] = useState<MobileNewTaskSourceSelection>(), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const route = models.find(model => model.backendId === choice?.backendId && model.providerId === choice.providerId && model.modelId === choice.modelId);
  const selected = models.find(model => model.backendId === value?.backendId && model.providerId === value.providerId && model.modelId === value.modelId);
  useEffect(() => { setChoice(undefined); setQuery(""); setError(""); setBusy(false); }, [value?.backendId]);
  const label = (model: MobileModelRoute) => model.source
    ? [model.source.displayName, model.source.nodeName, model.source.nativeAdapterKind,
      model.source.groupMemberCount ? `×${model.source.groupMemberCount}` : undefined].filter(Boolean).join(" · ") : model.providerName;
  const choose = (model: MobileModelRoute, saved?: MobileNewTaskSourceSelection): void => {
    setError("");
    const configuration = saved ?? (value?.backendId === model.backendId && value.providerId === model.providerId && value.modelId === model.modelId ? value : undefined);
    const configuredEffort = model.efforts.some(effort => effort.id === configuration?.effortId) ? configuration?.effortId : undefined;
    const effort = model.canSetEffort ? configuredEffort ?? model.efforts.find(item => item.default)?.id ?? model.efforts[0]?.id : undefined;
    setChoice({ backendId: model.backendId, providerId: model.providerId, modelId: model.modelId,
      ...(effort ? { effortId: effort } : {}), fastMode: resolveMobileModelSpeed(model, configuration?.fastMode, model.canSetFastMode === true) });
  };
  const run = async (action: (value: MobileNewTaskSourceSelection) => Promise<void>, close: boolean): Promise<void> => {
    if (!choice || busy || disabled) return; setBusy(true); setError("");
    try { await action(choice); if (close) setOpen(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : mobileMessage(locale, "controls.changeError")); }
    finally { setBusy(false); }
  };
  const needle = query.trim().toLocaleLowerCase();
  const matching = models.filter(model => !needle || [model.displayName, model.modelId, label(model)].some(part => part.toLocaleLowerCase().includes(needle)));
  const saved = favorites?.favorites.flatMap(favorite => {
    const model = favorite.selection?.model;
    const entry = matching.find(route => route.backendId === favorite.backendId && route.providerId === model?.providerId && route.modelId === model?.modelId);
    return entry && model && entry.source?.kind !== ModelSourceKind.SHARE ? [{ entry, favorite, selection: { backendId: favorite.backendId, providerId: model.providerId, modelId: model.modelId,
      ...(favorite.selection?.effortId ? { effortId: favorite.selection.effortId } : {}), fastMode: decodeModelSpeed(favorite.selection ?? {}) } }] : [];
  }) ?? [];
  return <View style={styles.stack}>
    <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "common.model")} accessibilityState={{ expanded: open, disabled }}
      disabled={disabled || busy} onPress={() => setOpen(current => !current)} style={[styles.row, { borderColor: colors.border }]}>
      <View><Text style={{ color: colors.ink }}>{selected?.displayName ?? mobileMessage(locale, "common.model")}</Text>
        {selected && <Text style={{ color: colors.muted }}>{label(selected)}</Text>}</View><Text style={{ color: colors.accent }}>{open ? "⌃" : "⌄"}</Text>
    </Pressable>
    {open && <View style={[styles.stack, styles.panel, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <TextInput accessibilityLabel={mobileMessage(locale, "controls.searchModelsLabel")} placeholder={mobileMessage(locale, "controls.searchModels")}
        value={query} onChangeText={setQuery} editable={!busy && !disabled} placeholderTextColor={colors.muted}
        style={[styles.input, { color: colors.ink, borderColor: colors.border }]} />
      <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
        {!!saved.length && <Text style={{ color: colors.muted }}>{mobileMessage(locale, "controls.favorites")}</Text>}
        {saved.map(({ entry, favorite, selection }) => <Pressable key={favorite.favoriteId} disabled={busy || disabled}
          accessibilityRole="button" accessibilityLabel={`${entry.displayName}, ${mobileMessage(locale, "controls.savedFavorite")}`}
          onPress={() => choose(entry, selection)} style={styles.model}><Text style={{ color: colors.ink }}>★ {entry.displayName}</Text>
          <Text style={{ color: colors.muted }}>{label(entry)}</Text></Pressable>)}
        {matching.map(model => <Pressable key={model.key} disabled={busy || disabled} accessibilityRole="radio"
          accessibilityState={{ selected: route?.key === model.key }} accessibilityLabel={`${model.displayName}, ${label(model)}`}
          onPress={() => choose(model)} style={styles.model}><Text style={{ color: colors.ink }}>{model.displayName}</Text>
          <Text style={{ color: colors.muted }}>{label(model)}</Text></Pressable>)}
        {!matching.length && <Text style={{ color: colors.muted }}>{mobileMessage(locale, "controls.noModelMatch")}</Text>}
      </ScrollView>
      {route && choice && <>
        <Text style={{ color: colors.ink }}>{route.displayName}</Text>
        {route.canSetEffort && <View style={styles.options}>{route.efforts.map(effort => <Pressable key={effort.id} disabled={busy || disabled}
          accessibilityRole="radio" accessibilityState={{ selected: choice.effortId === effort.id }} onPress={() => setChoice({ ...choice, effortId: effort.id })}
          style={[styles.option, { borderColor: choice.effortId === effort.id ? colors.accent : colors.border }]}><Text style={{ color: colors.ink }}>{effort.label}</Text></Pressable>)}</View>}
        {route.canSetFastMode && <MobileModelSpeedControl value={choice.fastMode} supportsFast={route.supportsFastMode} supportsUltrafast={route.supportsUltrafastMode}
          colors={colors} locale={locale} disabled={busy || disabled} onChange={fastMode => setChoice({ ...choice, fastMode })} />}
        <View style={styles.options}><Pressable disabled={busy || disabled} accessibilityRole="button" onPress={() => { void run(onSelect, true); }} style={[styles.option, { borderColor: colors.accent }]}>
          <Text style={{ color: colors.accent }}>{mobileMessage(locale, "controls.applyModel")}</Text></Pressable>
          {route.source?.kind !== ModelSourceKind.SHARE && <Pressable disabled={busy || disabled} accessibilityRole="button" onPress={() => { void run(onFavorite, false); }} style={[styles.option, { borderColor: colors.border }]}>
            <Text style={{ color: colors.ink }}>{mobileMessage(locale, "controls.addFavorite")}</Text></Pressable>}</View>
      </>}
      {!!error && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{error}</Text>}
    </View>}
  </View>;
}
const styles = StyleSheet.create({ stack: { gap: 12 }, row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, padding: 12, borderWidth: 1, borderRadius: 10 },
  panel: { padding: 12, borderWidth: 1, borderRadius: 10 }, input: { padding: 10, borderWidth: 1, borderRadius: 8 }, list: { maxHeight: 280 },
  model: { paddingVertical: 10, gap: 4 }, options: { flexDirection: "row", gap: 8, flexWrap: "wrap" }, option: { padding: 10, borderWidth: 1, borderRadius: 8 } });
