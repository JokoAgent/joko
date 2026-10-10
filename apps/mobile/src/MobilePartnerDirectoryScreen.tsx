import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import {
  filterMobilePartnerDirectory,
  firstIdentityLine,
  type MobilePartnerCatalog,
  type MobilePartnerDirectoryProfile,
  type MobilePartnerDirectoryTransport
} from "./mobile-partner-directory";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import { MobilePartnerAvatar } from "./MobilePartnerAvatar";
import { MobilePartnerInitializationScreen } from "./MobilePartnerInitializationScreen";
import type { MobilePartnerInitializationTransport } from "./mobile-partner-initialization";
import type { MobilePartnerCreationTransport } from "./mobile-partner-creation";
import { MobilePartnerCreateSheet } from "./MobilePartnerCreateSheet";
import { MobilePartnerPresenceRing } from "./MobilePartnerPresenceRing";
import { mobilePartnerActivityState, mobilePartnerDirectoryPreview, type MobilePartnerDirectoryObservation } from "./mobile-partner-activity";

export interface MobilePartnerDirectoryScreenProps {
  readonly colors: MobilePartnersColors;
  readonly locale: MobileSupportedLocale;
  readonly transport?: MobilePartnerDirectoryTransport;
  readonly observation?: MobilePartnerDirectoryObservation;
  readonly initializationTransport?: MobilePartnerInitializationTransport;
  readonly creationTransport?: MobilePartnerCreationTransport;
  readonly onBack: () => void;
  readonly onOpenTask: (sessionId: string) => void;
}

interface DirectoryState {
  readonly ownerKey?: string;
  readonly status: "loading" | "ready" | "offline" | "error";
  readonly catalog?: MobilePartnerCatalog;
  readonly refreshing: boolean;
  readonly error?: string;
}

function formatTime(value: number, locale: MobileSupportedLocale): string {
  const date = new Date(value);
  if (!Number.isFinite(value) || Number.isNaN(date.valueOf())) return mobileMessage(locale, "common.unknown");
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

function statusLabel(partner: MobilePartnerDirectoryProfile, locale: MobileSupportedLocale): string {
  if (partner.lifecycle === "archived") return mobileMessage(locale, "partnerDirectory.state.archived");
  if (partner.initializationState === "pending") return mobileMessage(locale, "partnerDirectory.state.pending");
  if (partner.initializationState === "error") return mobileMessage(locale, "partnerDirectory.state.error");
  return mobileMessage(locale, "partnerDirectory.state.ready");
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
    <Text style={[styles.actionLabel, { color: colors.ink }]}>{label}</Text>
  </Pressable>;
}

function PartnerRow({ partner, colors, locale, opening, recoverable, online, observation, last, onOpen }: {
  readonly partner: MobilePartnerDirectoryProfile;
  readonly colors: MobilePartnersColors;
  readonly locale: MobileSupportedLocale;
  readonly opening: boolean;
  readonly recoverable: boolean;
  readonly online: boolean;
  readonly observation?: MobilePartnerDirectoryObservation;
  readonly last: boolean;
  readonly onOpen: () => void;
}) {
  const available = online && partner.lifecycle === "active" && partner.initializationState === "ready"
    && partner.canonicalSessionId !== undefined;
  const identity = firstIdentityLine(partner.identitySource);
  const activity = mobileMessage(locale, "partnerDirectory.activity", {
    artifacts: partner.activity.artifactCount, delegations: partner.activity.activeDelegationCount
  });
  const execution = observation ? mobilePartnerActivityState(partner, observation) : online ? "unknown" : "offline";
  const working = online && partner.lifecycle === "active" && partner.initializationState === "ready"
    && ["working", "recovering", "compacting"].includes(execution);
  const prefix = !online ? mobileMessage(locale, "partnerDirectory.execution.offline")
    : partner.lifecycle !== "active" || partner.initializationState !== "ready" ? statusLabel(partner, locale)
      : execution === "ready" || execution === "working" ? "" : mobileMessage(locale, `partnerDirectory.execution.${execution}`);
  const preview = working ? mobileMessage(locale, `partnerDirectory.execution.${execution}`)
    : mobilePartnerDirectoryPreview(partner) || mobileMessage(locale, "partnerDirectory.startChat");
  return <Pressable accessibilityRole="button"
    accessibilityLabel={mobileMessage(locale, recoverable ? "partnerInitialization.openAccessibility"
      : "partnerDirectory.openAccessibility", { name: partner.displayName })}
    accessibilityHint={[prefix, preview, identity, activity,
      recoverable ? mobileMessage(locale, "partnerInitialization.openAccessibility", { name: partner.displayName })
        : mobileMessage(locale, available ? "partnerDirectory.openTask" : "partnerDirectory.unavailable")].join(" · ")}
    accessibilityState={{ disabled: !available && !recoverable || opening }} disabled={!available && !recoverable || opening}
    onPress={onOpen} testID={`partnerDirectory.item.${partner.partnerId}`}
    style={[styles.row, { backgroundColor: colors.surface }, !available && !recoverable && styles.unavailable]}>
    <View style={styles.avatar}>
      <View style={!online ? styles.unavailable : undefined}><MobilePartnerAvatar preset={partner.avatar} partner={partner} colors={colors} /></View>
      <MobilePartnerPresenceRing active={working} color={colors.accent} />
      <View accessible={false} style={[styles.presence, { backgroundColor: colors.surface }]}>
        <View style={[styles.presenceDot, { backgroundColor: online ? colors.ink : colors.muted }]} />
      </View>
    </View>
    <View style={[styles.rowBody, !last && { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth }]}>
      <View style={styles.titleRow}>
        <Text style={[styles.name, { color: colors.ink }]} numberOfLines={1}>{partner.displayName}</Text>
        <View style={styles.grow} />
        {opening || working ? <View testID={`partnerDirectory.working.${partner.partnerId}`}><ActivityIndicator color={colors.muted} /></View>
          : <Text style={[styles.time, { color: colors.muted }]} numberOfLines={1}>
            {formatTime(partner.activity.latestReplyAt ?? partner.updatedAt, locale)}
          </Text>}
      </View>
      <View style={styles.previewRow}>
        <Text style={[styles.preview, { color: colors.muted }]} numberOfLines={1}>
          {!working && prefix !== "" && <Text style={{ color: colors.ink, fontWeight: "500" }}>{prefix} · </Text>}
          {preview}
        </Text>
        {partner.activity.unreadReplyCount > 0 && <View accessibilityLabel={mobileMessage(locale,
          "partnerDirectory.unreadReplies", { count: partner.activity.unreadReplyCount })}
          testID={`partnerDirectory.unread.${partner.partnerId}`} style={[styles.unread, { backgroundColor: colors.accent }]} />}
      </View>
    </View>
  </Pressable>;
}

export function MobilePartnerDirectoryScreen({ colors, locale, transport, observation, initializationTransport, creationTransport, onBack, onOpenTask }:
  MobilePartnerDirectoryScreenProps) {
  const [state, setState] = useState<DirectoryState>(() => transport
    ? { ownerKey: transport.ownerKey, status: "loading", refreshing: false }
    : { status: "offline", refreshing: false });
  const [lifecycle, setLifecycle] = useState<MobilePartnerDirectoryProfile["lifecycle"]>("active");
  const [query, setQuery] = useState("");
  const [openingId, setOpeningId] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [initialization, setInitialization] = useState<{ readonly ownerKey: string; readonly partnerId: string }>();
  const [creation, setCreation] = useState(false);
  const transportRef = useRef(transport);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const openRef = useRef<AbortController | undefined>(undefined);
  const generationRef = useRef(0);
  const ownerKey = observation?.ownerKey ?? transport?.ownerKey;
  const ownerRef = useRef(ownerKey); ownerRef.current = ownerKey;
  transportRef.current = transport;

  const load = (): void => {
    if (requestRef.current) return;
    const current = transportRef.current;
    const generation = ++generationRef.current;
    if (!current) {
      setState((previous) => previous.ownerKey === ownerRef.current && previous.catalog
        ? { ...previous, status: "offline", refreshing: false } : { status: "offline", refreshing: false });
      return;
    }
    const ownerKey = current.ownerKey;
    const controller = new AbortController();
    requestRef.current = controller;
    setState((previous) => previous.ownerKey === ownerKey && previous.catalog
      ? { ...previous, status: "ready", refreshing: true, error: undefined }
      : { ownerKey, status: "loading", refreshing: false });
    void current.list(controller.signal).then((catalog) => {
      if (controller.signal.aborted || generationRef.current !== generation
        || transportRef.current?.ownerKey !== ownerKey) return;
      setState({ ownerKey, status: "ready", catalog, refreshing: false });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || generationRef.current !== generation
        || transportRef.current?.ownerKey !== ownerKey) return;
      const message = error instanceof Error ? error.message : String(error);
      setState((previous) => previous.ownerKey === ownerKey && previous.catalog
        ? { ...previous, status: "ready", refreshing: false, error: message }
        : { ownerKey, status: "error", refreshing: false, error: message });
    }).finally(() => { if (requestRef.current === controller) requestRef.current = undefined; });
  };

  useEffect(() => {
    setOpeningId(undefined);
    setActionError(undefined);
    requestRef.current?.abort(); requestRef.current = undefined;
    openRef.current?.abort();
    load();
    return () => {
      generationRef.current += 1;
      requestRef.current?.abort();
      openRef.current?.abort();
    };
  }, [ownerKey, transport?.ownerKey]);

  useEffect(() => {
    if (!transport || state.ownerKey !== transport.ownerKey || !state.catalog || state.refreshing || state.error
      || initialization || creation || openingId) return;
    const timer = setTimeout(load, 2500);
    return () => clearTimeout(timer);
  }, [transport?.ownerKey, state.catalog, state.refreshing, state.error, initialization, creation, openingId]);

  const leaveInitialization = (): void => { setInitialization(undefined); load(); };
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (initialization) leaveInitialization(); else onBack();
      return true;
    });
    return () => subscription.remove();
  }, [onBack, initialization]);

  const currentOwner = ownerKey !== undefined && state.ownerKey === ownerKey;
  const catalog = currentOwner ? state.catalog : undefined;
  const status = currentOwner ? state.status : transport ? "loading" : "offline";
  const visible = useMemo(() => filterMobilePartnerDirectory(catalog?.partners ?? [], lifecycle, query, locale),
    [catalog?.partners, lifecycle, query, locale]);
  const open = (partner: MobilePartnerDirectoryProfile): void => {
    const current = transportRef.current;
    if (!current || openingId !== undefined || current.ownerKey !== state.ownerKey) return;
    openRef.current?.abort();
    const controller = new AbortController();
    openRef.current = controller;
    const ownerKey = current.ownerKey;
    setOpeningId(partner.partnerId);
    setActionError(undefined);
    void current.open(partner, controller.signal).then((result) => {
      if (controller.signal.aborted || transportRef.current?.ownerKey !== ownerKey) return;
      onOpenTask(result.sessionId);
    }).catch((error: unknown) => {
      if (controller.signal.aborted || transportRef.current?.ownerKey !== ownerKey) return;
      setActionError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (!controller.signal.aborted && transportRef.current?.ownerKey === ownerKey) setOpeningId(undefined);
    });
  };

  const emptyKey = query.trim() !== "" ? "partnerDirectory.noResults"
    : lifecycle === "active" ? "partnerDirectory.emptyActive" : "partnerDirectory.emptyArchived";
  if (initialization) return <MobilePartnerInitializationScreen partnerId={initialization.partnerId}
    transport={initializationTransport?.ownerKey === initialization.ownerKey ? initializationTransport : undefined}
    colors={colors} locale={locale} onBack={leaveInitialization} onOpenTask={onOpenTask} />;
  return <View style={[styles.screen, { backgroundColor: colors.background }]} testID="partnerDirectory.screen">
    <View style={styles.header}>
      <Action label={mobileMessage(locale, "common.back")} colors={colors} onPress={onBack} />
      <View style={styles.grow}>
        <Text style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, "partnerDirectory.title")}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "partnerDirectory.subtitle")}</Text>
      </View>
      <Action label={mobileMessage(locale, "common.refresh")} colors={colors}
        disabled={!transport || status === "loading" || state.refreshing} onPress={load}
        testID="partnerDirectory.refresh" />
      <Action label={mobileMessage(locale, "partnerCreation.create")} colors={colors} onPress={() => setCreation(true)}
        disabled={!creationTransport || creationTransport.ownerKey !== transport?.ownerKey} testID="partnerDirectory.create" />
    </View>
    {catalog && <View style={styles.summary} accessibilityLabel={mobileMessage(locale, "partnerDirectory.summary", {
      active: catalog.directory.activeCount, archived: catalog.directory.archivedCount,
      errors: catalog.directory.errorCount
    })}>
      <Text style={[styles.summaryText, { color: colors.ink }]}>{mobileMessage(locale, "partnerDirectory.activeCount", { count: catalog.directory.activeCount })}</Text>
      <Text style={[styles.summaryText, { color: colors.muted }]}>{mobileMessage(locale, "partnerDirectory.archivedCount", { count: catalog.directory.archivedCount })}</Text>
      <Text style={[styles.summaryText, { color: catalog.directory.errorCount > 0 ? colors.negative : colors.muted }]}>
        {mobileMessage(locale, "partnerDirectory.errorCount", { count: catalog.directory.errorCount })}
      </Text>
    </View>}
    {catalog && <View style={styles.controls}>
      <View accessibilityRole="radiogroup" style={[styles.segmented, { borderColor: colors.border }]}>
        {(["active", "archived"] as const).map((value) => <Pressable key={value} accessibilityRole="radio"
          accessibilityState={{ checked: lifecycle === value }} onPress={() => setLifecycle(value)}
          testID={`partnerDirectory.filter.${value}`}
          style={[styles.segment, lifecycle === value && { backgroundColor: colors.brandBackground }]}>
          <Text style={[styles.actionLabel, { color: colors.ink }]}>{mobileMessage(locale,
            value === "active" ? "partnerDirectory.active" : "partnerDirectory.archived")}</Text>
        </Pressable>)}
      </View>
      <View style={[styles.searchField, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <TextInput accessibilityLabel={mobileMessage(locale, "partnerDirectory.search")} value={query}
        onChangeText={setQuery} autoCorrect={false} clearButtonMode="while-editing"
        placeholder={mobileMessage(locale, "partnerDirectory.search")}
        placeholderTextColor={colors.muted} testID="partnerDirectory.search"
        style={[styles.search, { color: colors.ink }]} />
      {query.length > 0 && <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "common.clear")}
        onPress={() => setQuery("")} style={styles.clear} testID="partnerDirectory.clearSearch">
        <Text style={[styles.body, { color: colors.muted }]}>×</Text>
      </Pressable>}
      </View>
    </View>}
    {currentOwner && (state.error || actionError) && <View accessibilityRole="alert" style={[styles.notice, {
      borderColor: colors.negative, backgroundColor: colors.surface
    }]}>
      <Text style={[styles.body, { color: colors.negative }]}>{actionError ?? mobileMessage(locale,
        catalog ? "partnerDirectory.stale" : "partnerDirectory.error")}</Text>
    </View>}
    {status === "offline" && !catalog ? <View style={styles.center}>
      <Text style={[styles.body, { color: colors.muted }]}>{mobileMessage(locale, "partnerDirectory.offline")}</Text>
    </View> : status === "loading" ? <View style={styles.center}>
      <ActivityIndicator color={colors.accent} />
      <Text style={[styles.body, { color: colors.muted }]}>{mobileMessage(locale, "partnerDirectory.loading")}</Text>
    </View> : status === "error" ? <View style={styles.center}>
      <Text style={[styles.body, { color: colors.negative }]}>{mobileMessage(locale, "partnerDirectory.error")}</Text>
      <Action label={mobileMessage(locale, "common.retry")} colors={colors} onPress={load} />
    </View> : <FlatList data={visible} keyExtractor={(partner) => partner.partnerId}
      contentContainerStyle={[styles.list, visible.length === 0 && styles.emptyList]}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      refreshControl={<RefreshControl refreshing={state.refreshing} onRefresh={load} tintColor={colors.accent} />}
      ListEmptyComponent={<View style={styles.center}><Text style={[styles.body, styles.emptyText, { color: colors.muted }]}>
        {mobileMessage(locale, emptyKey)}
      </Text>{!query.trim() && lifecycle === "active" && <Action label={mobileMessage(locale, "partnerCreation.create")}
        colors={colors} onPress={() => setCreation(true)} disabled={!creationTransport || creationTransport.ownerKey !== transport?.ownerKey}
        testID="partnerDirectory.emptyCreate" />}</View>}
      renderItem={({ item, index }) => {
        const recoverable = item.lifecycle === "active" && item.initializationState !== "ready"
          && initializationTransport !== undefined && initializationTransport.ownerKey === transport?.ownerKey;
        return <PartnerRow partner={item} colors={colors} locale={locale} recoverable={recoverable}
          online={transport !== undefined} observation={observation?.ownerKey === ownerKey ? observation : undefined}
          last={index === visible.length - 1} opening={openingId === item.partnerId} onOpen={() => {
            if (recoverable && transport) setInitialization({ ownerKey: transport.ownerKey, partnerId: item.partnerId });
            else open(item);
          }} />;
      }} />}
    <MobilePartnerCreateSheet visible={creation} transport={creationTransport?.ownerKey === transport?.ownerKey ? creationTransport : undefined}
      colors={colors} locale={locale} onClose={() => { setCreation(false); load(); }} onCreated={(partner) => {
        if (creationTransport && creationTransport.ownerKey === transportRef.current?.ownerKey && initializationTransport?.ownerKey === creationTransport.ownerKey) {
          setInitialization({ ownerKey: creationTransport.ownerKey, partnerId: partner.partnerId });
        }
      }} />
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingTop: 12 },
  header: { minHeight: 54, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14 },
  grow: { flex: 1, minWidth: 0 },
  title: { fontSize: 23, lineHeight: 29, fontWeight: "700" },
  name: { flexShrink: 1, fontSize: 18, lineHeight: 28, fontWeight: "500" },
  body: { fontSize: 15, lineHeight: 21 },
  caption: { fontSize: 12, lineHeight: 17 },
  action: { minHeight: 42, minWidth: 42, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12,
    alignItems: "center", justifyContent: "center" },
  actionLabel: { fontSize: 14, lineHeight: 19, fontWeight: "600" },
  disabled: { opacity: 0.45 },
  summary: { flexDirection: "row", flexWrap: "wrap", gap: 12, paddingHorizontal: 14, paddingTop: 12 },
  summaryText: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
  controls: { gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
  segmented: { alignSelf: "flex-start", flexDirection: "row", borderWidth: 1, borderRadius: 12, overflow: "hidden" },
  segment: { minHeight: 40, justifyContent: "center", paddingHorizontal: 16 },
  searchField: { flexDirection: "row", alignItems: "center", minHeight: 44, borderWidth: 1, borderRadius: 22 },
  search: { flex: 1, minWidth: 0, minHeight: 44, paddingHorizontal: 13, fontSize: 15 },
  clear: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  notice: { marginHorizontal: 14, marginBottom: 10, borderWidth: 1, borderRadius: 12, padding: 10 },
  center: { flex: 1, minHeight: 180, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  list: { paddingBottom: 28 },
  emptyList: { flexGrow: 1, justifyContent: "center" },
  emptyText: { textAlign: "center" },
  row: { height: 78, paddingLeft: 16, gap: 12, flexDirection: "row", alignItems: "center" },
  avatar: { width: 44, height: 44 },
  presence: { position: "absolute", right: 0, bottom: 0, padding: 2, borderRadius: 7 },
  presenceDot: { width: 10, height: 10, borderRadius: 5 },
  rowBody: { flex: 1, minWidth: 0, alignSelf: "stretch", justifyContent: "center", paddingRight: 16 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 4, height: 28 },
  time: { fontSize: 13, lineHeight: 22, fontVariant: ["tabular-nums"] },
  previewRow: { flexDirection: "row", alignItems: "center", gap: 8, height: 26 },
  preview: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 26 },
  unavailable: { opacity: 0.68 },
  unread: { width: 10, height: 10, borderRadius: 5 }
});
