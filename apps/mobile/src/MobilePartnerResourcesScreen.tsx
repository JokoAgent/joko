import { useEffect, useMemo, useRef, useState } from "react";
import { MobilePartnerAvatar } from "./MobilePartnerAvatar";
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View
} from "react-native";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import type { MobilePartner } from "./mobile-partner-private";
import {
  filterMobilePartnerResources,
  type MobilePartnerResourcePreview,
  type MobilePartnerResourceTransport
} from "./mobile-partner-resources";
import type { MobilePartnersColors } from "./MobilePartnersScreen";

export interface MobilePartnerResourcesScreenProps {
  readonly colors: MobilePartnersColors;
  readonly locale: MobileSupportedLocale;
  readonly transport?: MobilePartnerResourceTransport;
  readonly onBack: () => void;
  readonly onOpenTask: () => void;
}

type DirectoryState = {
  readonly ownerKey?: string;
  readonly status: "offline" | "loading" | "ready" | "error";
  readonly refreshing: boolean;
  readonly partners: readonly MobilePartner[];
};

type DetailState = {
  readonly ownerKey?: string;
  readonly partnerId?: string;
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly preview?: MobilePartnerResourcePreview;
  readonly opening: boolean;
  readonly openFailed: boolean;
};

const emptyDirectory: DirectoryState = {
  status: "offline",
  refreshing: false,
  partners: []
};
const emptyDetail: DetailState = { status: "idle", opening: false, openFailed: false };

function formatTime(value: number, locale: MobileSupportedLocale): string {
  const date = new Date(value);
  if (!Number.isFinite(value) || Number.isNaN(date.valueOf())) return mobileMessage(locale, "common.unknown");
  return date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

function formatBytes(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return "—";
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(value < 10_240 ? 1 : 0)} KB`;
  if (value < 1_073_741_824) return `${(value / 1_048_576).toFixed(value < 10_485_760 ? 1 : 0)} MB`;
  return `${(value / 1_073_741_824).toFixed(1)} GB`;
}

function partnerStatus(partner: MobilePartner, locale: MobileSupportedLocale): string {
  if (partner.lifecycle === "archived") return mobileMessage(locale, "partner.lifecycle.archived");
  if (partner.initializationState === "pending") return mobileMessage(locale, "partner.initialization.pending");
  if (partner.initializationState === "error") return mobileMessage(locale, "partner.initialization.error");
  if (!partner.canonicalSessionId) return mobileMessage(locale, "partnerResource.unavailable");
  return mobileMessage(locale, "partner.lifecycle.active");
}

function available(partner: MobilePartner): boolean {
  return partner.lifecycle === "active" && partner.initializationState === "ready"
    && partner.canonicalSessionId !== undefined;
}

function Action({ label, colors, onPress, disabled = false, testID }: {
  readonly label: string;
  readonly colors: MobilePartnersColors;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly testID?: string;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress} testID={testID}
    style={[styles.action, { borderColor: colors.border, backgroundColor: colors.surface }, disabled && styles.disabled]}>
    <Text style={[styles.actionText, { color: colors.ink }]}>{label}</Text>
  </Pressable>;
}

function Centered({ text, colors, loading = false, error = false }: {
  readonly text: string;
  readonly colors: MobilePartnersColors;
  readonly loading?: boolean;
  readonly error?: boolean;
}) {
  return <View style={styles.centered} accessibilityRole={error ? "alert" : undefined}>
    {loading && <ActivityIndicator color={colors.accent} />}
    <Text style={[styles.body, styles.centeredText, { color: error ? colors.negative : colors.muted }]}>{text}</Text>
  </View>;
}

export function MobilePartnerResourcesScreen({ colors, locale, transport, onBack, onOpenTask }:
  MobilePartnerResourcesScreenProps) {
  const { width } = useWindowDimensions();
  const wide = width >= 780;
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const listAbort = useRef<AbortController | undefined>(undefined);
  const detailAbort = useRef<AbortController | undefined>(undefined);
  const detailOccurrence = useRef<symbol | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [directory, setDirectory] = useState<DirectoryState>(emptyDirectory);
  const [detail, setDetail] = useState<DetailState>(emptyDetail);
  const ownerKey = transport?.ownerKey;

  useEffect(() => {
    listAbort.current?.abort();
    detailAbort.current?.abort();
    detailOccurrence.current = undefined;
    setDetail(emptyDetail);
    if (!transport || !ownerKey) {
      setDirectory(emptyDirectory);
      return;
    }
    const controller = new AbortController();
    listAbort.current = controller;
    setDirectory((current) => current.ownerKey === ownerKey && current.partners.length > 0
      ? { ...current, status: "ready", refreshing: true }
      : { ownerKey, status: "loading", refreshing: false, partners: [] });
    void transport.list(controller.signal).then((partners) => {
      if (controller.signal.aborted || transportRef.current?.ownerKey !== ownerKey) return;
      setDirectory({ ownerKey, status: "ready", refreshing: false, partners });
    }, () => {
      if (controller.signal.aborted || transportRef.current?.ownerKey !== ownerKey) return;
      setDirectory((current) => current.ownerKey === ownerKey && current.partners.length > 0
        ? { ...current, status: "ready", refreshing: false }
        : { ownerKey, status: "error", refreshing: false, partners: [] });
    });
    return () => controller.abort();
  }, [attempt, ownerKey]);

  useEffect(() => () => {
    listAbort.current?.abort();
    detailAbort.current?.abort();
    detailOccurrence.current = undefined;
  }, []);

  const closeDetail = () => {
    detailAbort.current?.abort();
    detailOccurrence.current = undefined;
    setDetail(emptyDetail);
  };

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (detail.partnerId && !wide) closeDetail();
      else onBack();
      return true;
    });
    return () => subscription.remove();
  }, [detail.partnerId, onBack, wide]);

  const openPreview = (partner: MobilePartner) => {
    const currentTransport = transportRef.current;
    if (!currentTransport || !available(partner)) return;
    detailAbort.current?.abort();
    const controller = new AbortController();
    const occurrence = Symbol("partner-resource-preview");
    detailAbort.current = controller;
    detailOccurrence.current = occurrence;
    setDetail({ ownerKey: currentTransport.ownerKey, partnerId: partner.partnerId,
      status: "loading", opening: false, openFailed: false });
    void currentTransport.preview(partner.partnerId, controller.signal).then((preview) => {
      if (controller.signal.aborted || detailOccurrence.current !== occurrence
        || transportRef.current?.ownerKey !== currentTransport.ownerKey) return;
      setDetail({ ownerKey: currentTransport.ownerKey, partnerId: partner.partnerId,
        status: "ready", preview, opening: false, openFailed: false });
    }, () => {
      if (controller.signal.aborted || detailOccurrence.current !== occurrence
        || transportRef.current?.ownerKey !== currentTransport.ownerKey) return;
      setDetail({ ownerKey: currentTransport.ownerKey, partnerId: partner.partnerId,
        status: "error", opening: false, openFailed: false });
    });
  };

  const openTask = () => {
    const currentTransport = transportRef.current;
    const preview = detail.preview;
    if (!currentTransport || !preview || detail.opening) return;
    detailAbort.current?.abort();
    const controller = new AbortController();
    const occurrence = Symbol("partner-resource-open");
    detailAbort.current = controller;
    detailOccurrence.current = occurrence;
    setDetail((current) => ({ ...current, opening: true, openFailed: false }));
    void currentTransport.open(preview, controller.signal).then(() => {
      if (controller.signal.aborted || detailOccurrence.current !== occurrence) return;
      onOpenTask();
    }, () => {
      if (controller.signal.aborted || detailOccurrence.current !== occurrence
        || transportRef.current?.ownerKey !== currentTransport.ownerKey) return;
      setDetail((current) => ({ ...current, opening: false, openFailed: true }));
    });
  };

  const visibleDirectory = directory.ownerKey === ownerKey ? directory : emptyDirectory;
  const visibleDetail = detail.ownerKey === ownerKey ? detail : emptyDetail;
  const filtered = useMemo(() => filterMobilePartnerResources(visibleDirectory.partners, query),
    [query, visibleDirectory.partners]);
  const selected = visibleDetail.partnerId
    ? visibleDirectory.partners.find((partner) => partner.partnerId === visibleDetail.partnerId)
    : undefined;

  const directoryPane = <View style={[styles.pane, wide && styles.directoryPane]} testID="partnerResources.directory">
    <View style={styles.header}>
      <Action label={mobileMessage(locale, "common.back")} colors={colors} onPress={onBack} />
      <View style={styles.grow}>
        <Text style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, "partnerResource.title")}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "partnerResource.menuDescription")}</Text>
      </View>
      <Action label={mobileMessage(locale, "partnerResource.refresh")} colors={colors}
        onPress={() => setAttempt((value) => value + 1)} disabled={!transport || visibleDirectory.refreshing}
        testID="partnerResources.refresh" />
    </View>
    {visibleDirectory.status === "offline"
      ? <Centered colors={colors} text={mobileMessage(locale, "partnerResource.offline")} />
      : visibleDirectory.status === "loading"
        ? <Centered colors={colors} loading text={mobileMessage(locale, "partnerResource.loading")} />
        : visibleDirectory.status === "error"
          ? <View style={styles.centered}>
            <Centered colors={colors} error text={mobileMessage(locale, "partnerResource.error")} />
            <Action label={mobileMessage(locale, "common.retry")} colors={colors}
              onPress={() => setAttempt((value) => value + 1)} />
          </View>
          : <>
            <View style={[styles.search, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <TextInput accessibilityLabel={mobileMessage(locale, "partnerResource.search")}
                autoCorrect={false} value={query} onChangeText={setQuery}
                placeholder={mobileMessage(locale, "partnerResource.search")}
                placeholderTextColor={colors.muted} style={[styles.searchInput, { color: colors.ink }]} />
              {query.length > 0 && <Action label={mobileMessage(locale, "common.clear")} colors={colors}
                onPress={() => setQuery("")} />}
            </View>
            <FlatList contentContainerStyle={filtered.length === 0 ? styles.emptyList : styles.rows}
              data={filtered} keyExtractor={(partner) => partner.partnerId}
              ListEmptyComponent={<Centered colors={colors} text={mobileMessage(locale,
                query.trim() ? "partnerResource.noResults" : "partnerResource.empty")} />}
              renderItem={({ item: partner }) => {
                const enabled = available(partner);
                return <Pressable accessibilityRole="button"
                  accessibilityLabel={mobileMessage(locale, "partnerResource.openAccessibility", { name: partner.displayName })}
                  accessibilityState={{ disabled: !enabled, selected: partner.partnerId === visibleDetail.partnerId }}
                  disabled={!enabled} onPress={() => openPreview(partner)}
                  testID={`partnerResources.item.${partner.partnerId}`}
                  style={[styles.row, { borderColor: partner.partnerId === visibleDetail.partnerId ? colors.accent : colors.border,
                    backgroundColor: partner.partnerId === visibleDetail.partnerId ? colors.brandBackground : colors.surface },
                  !enabled && styles.disabled]}>
                  <MobilePartnerAvatar preset={partner.avatar} partner={partner} colors={colors} />
                  <View style={styles.grow}>
                    <Text style={[styles.label, { color: colors.ink }]} numberOfLines={2}>{partner.displayName}</Text>
                    <Text style={[styles.caption, { color: colors.muted }]}>{partnerStatus(partner, locale)}</Text>
                  </View>
                  <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
                </Pressable>;
              }} />
          </>}
  </View>;

  const detailPane = <View style={[styles.pane, styles.detailPane, { borderColor: colors.border }]}
    testID="partnerResources.detail">
    <View style={styles.header}>
      {!wide && <Action label={mobileMessage(locale, "partnerResource.backToDirectory")} colors={colors}
        onPress={closeDetail} />}
      <View style={styles.grow}>
        <Text style={[styles.heading, { color: colors.ink }]}>{selected?.displayName
          ?? mobileMessage(locale, "partnerResource.title")}</Text>
        {selected && <Text style={[styles.caption, { color: colors.muted }]}>{partnerStatus(selected, locale)}</Text>}
      </View>
      {selected && <Action label={mobileMessage(locale, "common.refresh")} colors={colors}
        disabled={visibleDetail.status === "loading" || visibleDetail.opening}
        onPress={() => openPreview(selected)} />}
    </View>
    {!selected
      ? <Centered colors={colors} text={mobileMessage(locale, "partnerResource.empty")} />
      : visibleDetail.status === "loading"
        ? <Centered colors={colors} loading text={mobileMessage(locale, "partnerResource.previewLoading")} />
        : visibleDetail.status === "error" || !visibleDetail.preview
          ? <View style={styles.centered}>
            <Centered colors={colors} error text={mobileMessage(locale, "partnerResource.previewError")} />
            <Action label={mobileMessage(locale, "common.retry")} colors={colors}
              onPress={() => openPreview(selected)} />
          </View>
          : <ScrollView contentContainerStyle={styles.detailContent}>
            <Text style={[styles.section, { color: colors.muted }]}>{mobileMessage(locale, "partnerResource.canonicalTask")}</Text>
            <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Text style={[styles.label, { color: colors.ink }]}>{visibleDetail.preview.session.displayName}</Text>
              <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "partnerResource.created", {
                time: formatTime(visibleDetail.preview.session.createdAt, locale)
              })}</Text>
              {visibleDetail.preview.session.lastActivityAt !== undefined && <Text style={[styles.caption, { color: colors.muted }]}>
                {mobileMessage(locale, "partnerResource.lastActivity", {
                  time: formatTime(visibleDetail.preview.session.lastActivityAt, locale)
                })}
              </Text>}
            </View>
            {visibleDetail.openFailed && <Text accessibilityRole="alert" style={[styles.body, { color: colors.negative }]}>
              {mobileMessage(locale, "partnerResource.openFailed")}
            </Text>}
            <Action label={mobileMessage(locale, visibleDetail.opening
              ? "partnerResource.openingTask" : "partnerResource.openTask")} colors={colors}
              disabled={visibleDetail.opening} onPress={openTask} testID="partnerResources.openTask" />
            <View style={styles.sectionRow}>
              <Text style={[styles.section, styles.grow, { color: colors.muted }]}>{mobileMessage(locale, "partnerResource.artifacts")}</Text>
              <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "partnerResource.artifactCount", {
                count: visibleDetail.preview.artifacts.length
              })}</Text>
            </View>
            {visibleDetail.preview.artifacts.length === 0
              ? <Text style={[styles.body, { color: colors.muted }]}>{mobileMessage(locale, "partnerResource.noArtifacts")}</Text>
              : visibleDetail.preview.artifacts.map((artifact) => <View key={artifact.artifactId}
                style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
                testID={`partnerResources.artifact.${artifact.artifactId}`}>
                <Text style={[styles.label, { color: colors.ink }]}>{artifact.title}</Text>
                <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>{artifact.fileName}</Text>
                <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "partnerResource.artifactMeta", {
                  mediaType: artifact.mediaType,
                  size: formatBytes(artifact.byteSize),
                  time: formatTime(artifact.createdAt, locale)
                })}</Text>
              </View>)}
          </ScrollView>}
  </View>;

  return <View style={[styles.screen, { backgroundColor: colors.background }]}>
    {wide ? <View style={styles.wide}>{directoryPane}{detailPane}</View>
      : visibleDetail.partnerId ? detailPane : directoryPane}
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  wide: { flex: 1, flexDirection: "row" },
  pane: { flex: 1, minWidth: 0 },
  directoryPane: { maxWidth: 420 },
  detailPane: { borderLeftWidth: StyleSheet.hairlineWidth },
  header: { alignItems: "center", flexDirection: "row", gap: 12, minHeight: 64, padding: 12 },
  grow: { flex: 1, minWidth: 0 },
  title: { fontSize: 22, fontWeight: "700" },
  heading: { fontSize: 18, fontWeight: "700" },
  label: { fontSize: 16, fontWeight: "600" },
  body: { fontSize: 15, lineHeight: 21 },
  caption: { fontSize: 13, lineHeight: 18 },
  section: { fontSize: 13, fontWeight: "700", letterSpacing: 0.4, textTransform: "uppercase" },
  centered: { alignItems: "center", flex: 1, gap: 12, justifyContent: "center", padding: 24 },
  centeredText: { maxWidth: 360, textAlign: "center" },
  action: { alignItems: "center", borderRadius: 12, borderWidth: StyleSheet.hairlineWidth,
    justifyContent: "center", minHeight: 44, minWidth: 44, paddingHorizontal: 12 },
  actionText: { fontSize: 14, fontWeight: "600" },
  disabled: { opacity: 0.45 },
  search: { alignItems: "center", borderRadius: 14, borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row", gap: 8, marginHorizontal: 12, marginBottom: 8, paddingLeft: 12 },
  searchInput: { flex: 1, fontSize: 15, minHeight: 44, minWidth: 0 },
  rows: { gap: 8, padding: 12 },
  emptyList: { flexGrow: 1 },
  row: { alignItems: "center", borderRadius: 14, borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row", gap: 12, minHeight: 72, padding: 12 },
  avatar: { alignItems: "center", borderRadius: 24, height: 48, justifyContent: "center", width: 48 },
  avatarText: { fontSize: 15, fontWeight: "700" },
  chevron: { fontSize: 28 },
  detailContent: { gap: 12, padding: 16 },
  sectionRow: { alignItems: "center", flexDirection: "row", gap: 12, marginTop: 8 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, gap: 4, padding: 14 }
});
