import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { MobileKeyboardAvoidingView, useMobileKeyboardState } from "./MobileKeyboardAvoidingView";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage, type MobileMessageKey } from "./mobile-messages";
import {
  artifactKindLabel,
  filterMobileCatalogMentionCandidates,
  resourceKindLabel,
  type MobileCatalogMentionCandidate,
  type MobileCatalogMentionCatalog,
  type MobileCatalogMentionControls
} from "./mobile-catalog-mentions";

export function MobileCatalogMentionSheet({
  visible,
  controls,
  busy,
  colors,
  locale,
  onClose,
  onLoad,
  onSelect
}: {
  readonly visible: boolean;
  readonly controls?: MobileCatalogMentionControls;
  readonly busy: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly locale: MobileSupportedLocale;
  readonly onClose: () => void;
  readonly onLoad: (surfaceOwnerKey: string, signal: AbortSignal) => Promise<MobileCatalogMentionCatalog>;
  readonly onSelect: (surfaceOwnerKey: string, candidate: MobileCatalogMentionCandidate) => Promise<void>;
}) {
  const [catalog, setCatalog] = useState<MobileCatalogMentionCatalog>({});
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [selectingIdentity, setSelectingIdentity] = useState<string>();
  const mountedRef = useRef(true);
  const visibleRef = useRef(visible);
  const controlsRef = useRef(controls);
  const loadRef = useRef(onLoad);
  const selectRef = useRef(onSelect);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const requestRef = useRef(0);
  const searchRef = useRef<TextInput>(null);
  const keyboard = useMobileKeyboardState();
  const safeArea = useSafeAreaInsets();
  visibleRef.current = visible;
  controlsRef.current = controls;
  loadRef.current = onLoad;
  selectRef.current = onSelect;
  const disabled = busy || selectingIdentity !== undefined;
  const results = useMemo(() => filterMobileCatalogMentionCandidates(catalog, query), [catalog, query]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const load = (): void => {
    const current = controlsRef.current;
    if (!visibleRef.current || !current || disabled) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const request = requestRef.current + 1;
    requestRef.current = request;
    const ownerKey = current.surfaceOwnerKey;
    setLoading(true);
    setLoadError(undefined);
    setActionError(undefined);
    void loadRef.current(ownerKey, controller.signal).then((next) => {
      if (!mountedRef.current || controller.signal.aborted || !visibleRef.current
        || requestRef.current !== request || controlsRef.current?.surfaceOwnerKey !== ownerKey) return;
      setCatalog(next);
      setQuery("");
      setTimeout(() => searchRef.current?.focus(), 80);
    }).catch((error) => {
      if (!mountedRef.current || controller.signal.aborted || requestRef.current !== request
        || controlsRef.current?.surfaceOwnerKey !== ownerKey) return;
      setLoadError(errorText(error, locale));
    }).finally(() => {
      if (mountedRef.current && requestRef.current === request) setLoading(false);
    });
  };

  useEffect(() => {
    abortRef.current?.abort();
    requestRef.current += 1;
    setCatalog({});
    setQuery("");
    setLoading(false);
    setLoadError(undefined);
    setActionError(undefined);
    setSelectingIdentity(undefined);
    if (!visible || !controls) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const request = requestRef.current + 1;
    requestRef.current = request;
    const ownerKey = controls.surfaceOwnerKey;
    setLoading(true);
    void loadRef.current(ownerKey, controller.signal).then((next) => {
      if (!mountedRef.current || controller.signal.aborted || !visibleRef.current
        || requestRef.current !== request || controlsRef.current?.surfaceOwnerKey !== ownerKey) return;
      setCatalog(next);
      setTimeout(() => searchRef.current?.focus(), 120);
    }).catch((error) => {
      if (!mountedRef.current || controller.signal.aborted || requestRef.current !== request
        || controlsRef.current?.surfaceOwnerKey !== ownerKey) return;
      setLoadError(errorText(error, locale));
    }).finally(() => {
      if (mountedRef.current && requestRef.current === request) setLoading(false);
    });
    return () => controller.abort();
  }, [controls?.surfaceOwnerKey, visible]);

  if (!controls) return null;

  const select = async (candidate: MobileCatalogMentionCandidate): Promise<void> => {
    if (disabled || loading) return;
    const ownerKey = controls.surfaceOwnerKey;
    const identity = candidateIdentity(candidate);
    setSelectingIdentity(identity);
    setActionError(undefined);
    try {
      await selectRef.current(ownerKey, candidate);
    } catch (error) {
      if (mountedRef.current && visibleRef.current && controlsRef.current?.surfaceOwnerKey === ownerKey) {
        setActionError(errorText(error, locale));
      }
    } finally {
      if (mountedRef.current && controlsRef.current?.surfaceOwnerKey === ownerKey) setSelectingIdentity(undefined);
    }
  };

  const kindsKey = controls.policy.resources && controls.policy.artifacts
    ? "mention.catalog.both"
    : controls.policy.resources ? "mention.catalog.resources" : "mention.catalog.artifacts";
  const kinds = mobileMessage(locale, kindsKey);
  const close = (): void => { if (!disabled) onClose(); };
  return <Modal visible={visible} transparent animationType="slide" statusBarTranslucent onRequestClose={close}>
    <MobileKeyboardAvoidingView keyboard={keyboard} consumedBottomInset={safeArea.bottom}
      behavior={Platform.OS === "android" ? "height" : undefined} style={styles.modalRoot}>
      <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "mention.catalog.close")}
        disabled={disabled} onPress={close} style={styles.backdrop} />
      <SafeAreaView accessibilityViewIsModal edges={["bottom", "left", "right"]}
        style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={[styles.eyebrow, { color: colors.muted }]}>{mobileMessage(locale, "mention.catalog.eyebrow")}</Text>
            <Text style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, "mention.catalog.title", { kinds })}</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "mention.catalog.refresh")}
            accessibilityState={{ disabled: disabled || loading }} disabled={disabled || loading}
            onPress={load} style={styles.iconButton}>
            <Text style={[styles.refreshText, { color: colors.ink }]}>↻</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "mention.catalog.close")}
            accessibilityState={{ disabled }} disabled={disabled} onPress={close} style={styles.iconButton}>
            <Text style={[styles.closeText, { color: colors.ink }]}>×</Text>
          </Pressable>
        </View>
        <TextInput ref={searchRef} accessibilityLabel={mobileMessage(locale, "mention.catalog.searchLabel")} value={query}
          onChangeText={setQuery} editable={!disabled && !loading} autoCapitalize="none" autoCorrect={false}
          placeholder={mobileMessage(locale, "mention.catalog.search", { kinds })} placeholderTextColor={colors.muted}
          style={[styles.search, { color: colors.ink, backgroundColor: colors.background, borderColor: colors.border }]} />
        {(loadError || actionError) && <View accessibilityRole="alert" style={styles.errorRow}>
          <Text accessibilityLiveRegion="polite" style={[styles.error, { color: colors.negative }]}>
            {loadError ?? actionError}
          </Text>
          {loadError && <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "mention.catalog.retry")}
            disabled={disabled || loading} onPress={load} style={styles.retryButton}>
            <Text style={[styles.retry, { color: colors.accent }]}>{mobileMessage(locale, "common.retry")}</Text>
          </Pressable>}
        </View>}
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          {loading && <View accessibilityLabel={mobileMessage(locale, "mention.catalog.loading")} style={styles.loading}>
            <ActivityIndicator color={colors.muted} />
          </View>}
          {!loading && !loadError && results.items.length === 0 && <Text style={[styles.empty, { color: colors.muted }]}>
            {query.trim() ? mobileMessage(locale, "mention.catalog.noMatch")
              : mobileMessage(locale, "mention.catalog.empty", { kinds })}
          </Text>}
          {!loading && results.items.map((candidate) => <CatalogRow key={candidateIdentity(candidate)}
            candidate={candidate} disabled={disabled} selecting={selectingIdentity === candidateIdentity(candidate)}
            colors={colors} locale={locale} onPress={() => void select(candidate)} />)}
          {!loading && results.truncated && <Text accessibilityRole="alert" style={[styles.notice, { color: colors.muted }]}>
            {mobileMessage(locale, "mention.catalog.more")}
          </Text>}
        </ScrollView>
      </SafeAreaView>
    </MobileKeyboardAvoidingView>
  </Modal>;
}

function CatalogRow({ candidate, disabled, selecting, colors, locale, onPress }: {
  readonly candidate: MobileCatalogMentionCandidate;
  readonly disabled: boolean;
  readonly selecting: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly locale: MobileSupportedLocale;
  readonly onPress: () => void;
}) {
  const kind = localizedCatalogKind(candidate.kind === "resource"
    ? resourceKindLabel(candidate.resourceKind) : artifactKindLabel(candidate.artifactKind), locale);
  const context = candidate.kind === "resource"
    ? `${kind}${candidate.version ? ` · ${candidate.version}` : ""}`
    : `${kind} · ${candidate.sourceDisplayText}`;
  const identity = candidate.kind === "resource"
    ? candidate.resourceId
    : `${candidate.fileName} · ${candidate.sourceSessionId}`;
  return <Pressable accessibilityRole="button"
    accessibilityLabel={mobileMessage(locale, "mention.catalog.reference", {
      kind: mobileMessage(locale, candidate.kind === "resource" ? "mention.catalog.resource" : "mention.catalog.artifact"),
      name: candidate.displayText
    })}
    accessibilityHint={mobileMessage(locale, "mention.catalog.hint", {
      kind: mobileMessage(locale, candidate.kind === "resource" ? "mention.catalog.resource" : "mention.catalog.artifact")
    })}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={[styles.row, { borderColor: colors.border }, disabled && styles.disabled]}>
    <Text style={[styles.glyph, { color: colors.accent }]}>{candidate.kind === "resource" ? "✦" : "◇"}</Text>
    <View style={styles.rowText}>
      <Text style={[styles.rowLabel, { color: colors.ink }]} numberOfLines={2}>{candidate.displayText}</Text>
      <Text style={[styles.context, { color: colors.muted }]} numberOfLines={1}>{context}</Text>
      <Text selectable style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>{identity}</Text>
    </View>
    {selecting ? <ActivityIndicator size="small" color={colors.muted} />
      : <Text style={[styles.add, { color: colors.accent }]}>{mobileMessage(locale, "common.add")}</Text>}
  </Pressable>;
}

function candidateIdentity(candidate: MobileCatalogMentionCandidate): string {
  return candidate.kind === "resource"
    ? JSON.stringify(["resource", candidate.resourceId])
    : JSON.stringify(["artifact", candidate.sourceSessionId, candidate.artifactId]);
}

function localizedCatalogKind(value: string, locale: MobileSupportedLocale): string {
  const keyByEnglishLabel: Readonly<Record<string, MobileMessageKey>> = {
    Extension: "mention.catalog.kind.extension",
    Skill: "mention.catalog.kind.skill",
    Prompt: "mention.catalog.kind.prompt",
    Package: "mention.catalog.kind.package",
    Resource: "mention.catalog.kind.resource",
    Image: "mention.catalog.kind.image",
    Export: "mention.catalog.kind.export",
    "Tool result": "mention.catalog.kind.toolResult",
    Diagnostics: "mention.catalog.kind.diagnostics",
    Diff: "mention.catalog.kind.diff",
    File: "mention.catalog.kind.file"
  };
  return mobileMessage(locale, keyByEnglishLabel[value] ?? "mention.catalog.kind.resource");
}

function errorText(error: unknown, locale: MobileSupportedLocale): string {
  return error instanceof Error ? error.message : mobileMessage(locale, "mention.catalog.loadError");
}

const styles = StyleSheet.create({
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  backdrop: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.42)" },
  sheet: { maxHeight: "92%", borderTopWidth: 1, borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: "hidden" },
  header: { minHeight: 78, paddingHorizontal: 14, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 6 },
  headerText: { flex: 1, gap: 2 },
  eyebrow: { fontSize: 12, lineHeight: 17, fontWeight: "700", textTransform: "uppercase" },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700" },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  refreshText: { fontSize: 26, lineHeight: 32, fontWeight: "500" },
  closeText: { fontSize: 30, lineHeight: 34, fontWeight: "500" },
  search: { minHeight: 48, marginHorizontal: 18, marginBottom: 8, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, fontSize: 16 },
  errorRow: { paddingHorizontal: 18, paddingBottom: 8, flexDirection: "row", alignItems: "center", gap: 10 },
  error: { flex: 1, fontSize: 13, lineHeight: 19, fontWeight: "600" },
  retryButton: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  retry: { fontSize: 14, lineHeight: 20, fontWeight: "800" },
  content: { paddingHorizontal: 18, paddingTop: 4, paddingBottom: 28 },
  loading: { minHeight: 130, alignItems: "center", justifyContent: "center" },
  empty: { minHeight: 100, paddingVertical: 32, textAlign: "center", fontSize: 14, lineHeight: 20 },
  row: { minHeight: 78, borderBottomWidth: 1, paddingVertical: 9, flexDirection: "row", alignItems: "center", gap: 10 },
  glyph: { width: 22, textAlign: "center", fontSize: 18, lineHeight: 24, fontWeight: "800" },
  rowText: { flex: 1, gap: 1 },
  rowLabel: { fontSize: 15, lineHeight: 21, fontWeight: "700" },
  context: { fontSize: 12, lineHeight: 17, fontWeight: "600" },
  caption: { fontSize: 11, lineHeight: 16 },
  add: { minHeight: 44, lineHeight: 44, fontSize: 14, fontWeight: "800" },
  notice: { paddingVertical: 12, fontSize: 12, lineHeight: 18, textAlign: "center" },
  disabled: { opacity: 0.5 }
});
