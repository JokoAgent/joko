import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewToken
} from "react-native";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { MobilePartnerAvatar } from "./MobilePartnerAvatar";
import type {
  MobilePartner,
  MobilePartnerPrivateState,
  MobilePrivateDetail,
  MobilePrivateMessage,
  MobilePrivateThread
} from "./mobile-partner-private";

export interface MobilePartnersColors {
  readonly background: string;
  readonly surface: string;
  readonly ink: string;
  readonly muted: string;
  readonly border: string;
  readonly accent: string;
  readonly negative: string;
  readonly brandBackground: string;
}

export interface MobilePartnersScreenProps {
  readonly colors: MobilePartnersColors;
  readonly locale: MobileSupportedLocale;
  readonly view: MobilePartnerPrivateState;
  readonly onBack: () => void;
  readonly onOpenPartner: (partnerId: string) => void;
  readonly onClosePartner: () => void;
  readonly onOpenThread: (partnerId: string, threadId: string) => void;
  readonly onCloseThread: () => void;
  readonly onRefresh: () => void | Promise<void>;
  readonly onDetailVisible: (partnerId: string, threadId: string, lastVisibleSequence: number) => void;
}

type NarrowRoute =
  | { readonly kind: "directory" }
  | { readonly kind: "threads"; readonly partnerId: string }
  | { readonly kind: "detail"; readonly partnerId: string; readonly threadId: string };

function initialRoute(view: MobilePartnerPrivateState): NarrowRoute {
  if (view.selectedPartnerId && view.selectedThreadId) {
    return { kind: "detail", partnerId: view.selectedPartnerId, threadId: view.selectedThreadId };
  }
  if (view.selectedPartnerId) return { kind: "threads", partnerId: view.selectedPartnerId };
  return { kind: "directory" };
}

function formatTime(value: number, locale: MobileSupportedLocale): string {
  if (!Number.isFinite(value)) return mobileMessage(locale, "common.unknown");
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return mobileMessage(locale, "common.unknown");
  return date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

function formatMessageTime(timestamp: number, locale: MobileSupportedLocale): string {
  const value = new Date(timestamp), current = new Date();
  const sameDay = value.getFullYear() === current.getFullYear() && value.getMonth() === current.getMonth()
    && value.getDate() === current.getDate();
  return new Intl.DateTimeFormat(locale, {
    ...(sameDay ? {} : value.getFullYear() === current.getFullYear()
      ? { month: "short", day: "numeric" } as const : { year: "numeric", month: "short", day: "numeric" } as const),
    hour: "2-digit", minute: "2-digit"
  }).format(value);
}

function partnerName(partners: readonly MobilePartner[], partnerId: string, locale: MobileSupportedLocale): string {
  return partners.find((partner) => partner.partnerId === partnerId)?.displayName
    ?? mobileMessage(locale, "partner.unknownName");
}

function threadNames(thread: MobilePrivateThread, partners: readonly MobilePartner[], locale: MobileSupportedLocale): {
  readonly first: string;
  readonly second: string;
} {
  return {
    first: partnerName(partners, thread.firstPartnerId, locale),
    second: partnerName(partners, thread.secondPartnerId, locale)
  };
}

function threadStatus(thread: MobilePrivateThread, locale: MobileSupportedLocale): string {
  if (thread.status === "active") return mobileMessage(locale, "partner.thread.active");
  if (thread.closeReason === "messageLimit") return mobileMessage(locale, "partner.thread.closedLimit");
  if (thread.closeReason === "idleTimeout") return mobileMessage(locale, "partner.thread.closedIdle");
  return mobileMessage(locale, "partner.thread.closed");
}

function Notice({ text, colors, error = false }: {
  readonly text: string;
  readonly colors: MobilePartnersColors;
  readonly error?: boolean;
}) {
  return <View accessibilityRole="alert" style={[styles.notice, {
    backgroundColor: colors.surface,
    borderColor: error ? colors.negative : colors.border
  }]}>
    <Text style={[styles.caption, { color: error ? colors.negative : colors.muted }]}>{text}</Text>
  </View>;
}

function Action({ label, colors, onPress, disabled = false }: {
  readonly label: string;
  readonly colors: MobilePartnersColors;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress} style={[styles.action, {
      borderColor: colors.border, backgroundColor: colors.surface, opacity: disabled ? 0.45 : 1
    }]}>
    <Text style={[styles.actionText, { color: colors.ink }]}>{label}</Text>
  </Pressable>;
}

function Centered({ text, colors, loading = false }: {
  readonly text: string;
  readonly colors: MobilePartnersColors;
  readonly loading?: boolean;
}) {
  return <View style={styles.centered}>
    {loading && <ActivityIndicator color={colors.accent} />}
    <Text style={[styles.body, styles.centeredText, { color: colors.muted }]}>{text}</Text>
  </View>;
}

function PartnerRow({ partner, selected, colors, locale, onPress }: {
  readonly partner: MobilePartner;
  readonly selected: boolean;
  readonly colors: MobilePartnersColors;
  readonly locale: MobileSupportedLocale;
  readonly onPress: () => void;
}) {
  const state = partner.lifecycle === "archived"
    ? mobileMessage(locale, "partner.lifecycle.archived")
    : partner.initializationState === "pending"
      ? mobileMessage(locale, "partner.initialization.pending")
      : partner.initializationState === "error"
        ? mobileMessage(locale, "partner.initialization.error")
        : mobileMessage(locale, "partner.lifecycle.active");
  return <Pressable accessibilityRole="button"
    accessibilityLabel={mobileMessage(locale, "partner.openPartnerAccessibility", { name: partner.displayName })}
    accessibilityState={{ selected }} onPress={onPress}
    style={[styles.row, {
      borderColor: selected ? colors.accent : colors.border,
      backgroundColor: selected ? colors.brandBackground : colors.surface
    }]}>
    <Text style={[styles.label, { color: colors.ink }]} numberOfLines={2}>{partner.displayName}</Text>
    <Text style={[styles.caption, { color: colors.muted }]}>{state}</Text>
  </Pressable>;
}

function ThreadRow({ thread, partners, selected, colors, locale, onPress }: {
  readonly thread: MobilePrivateThread;
  readonly partners: readonly MobilePartner[];
  readonly selected: boolean;
  readonly colors: MobilePartnersColors;
  readonly locale: MobileSupportedLocale;
  readonly onPress: () => void;
}) {
  const names = threadNames(thread, partners, locale);
  return <Pressable accessibilityRole="button"
    accessibilityLabel={mobileMessage(locale, "partner.openThreadAccessibility", names)}
    accessibilityState={{ selected }} onPress={onPress}
    style={[styles.row, {
      borderColor: selected ? colors.accent : colors.border,
      backgroundColor: selected ? colors.brandBackground : colors.surface
    }]}>
    <Text style={[styles.label, { color: colors.ink }]} numberOfLines={2}>
      {mobileMessage(locale, "partner.pair", names)}
    </Text>
    <Text style={[styles.caption, { color: colors.muted }]}>{threadStatus(thread, locale)}</Text>
    <Text style={[styles.caption, { color: colors.muted }]}>
      {mobileMessage(locale, "partner.messageLimit", { count: thread.messageCount, limit: thread.maxMessages })}
      {" · "}{mobileMessage(locale, "partner.updatedAt", { time: formatTime(thread.updatedAt, locale) })}
    </Text>
    {thread.blockedUntil !== undefined && <Text style={[styles.caption, { color: colors.negative }]}>
      {mobileMessage(locale, "partner.blockedUntil", { time: formatTime(thread.blockedUntil, locale) })}
    </Text>}
  </Pressable>;
}

function MessageRow({ message, viewerPartnerId, partners, colors, locale }: {
  readonly message: MobilePrivateMessage;
  readonly viewerPartnerId: string;
  readonly partners: readonly MobilePartner[];
  readonly colors: MobilePartnersColors;
  readonly locale: MobileSupportedLocale;
}) {
  const ownSide = message.senderPartnerId === viewerPartnerId;
  const sender = partners.find(partner => partner.partnerId === message.senderPartnerId);
  const avatar = <MobilePartnerAvatar preset={sender?.avatar ?? "orbit"} partner={sender} colors={colors} size={28} />;
  return <View testID={`partner.privateMessage.${ownSide ? "own" : "peer"}`}
    style={[styles.messageRow, ownSide ? styles.messageRowOwn : styles.messageRowPeer]}>
    {!ownSide && avatar}
    <View style={[styles.messageColumn, ownSide ? styles.messageColumnOwn : styles.messageColumnPeer]}>
      <Text style={[styles.messageMeta, { color: colors.muted }]}>
        {partnerName(partners, message.senderPartnerId, locale)} · {formatMessageTime(message.createdAt, locale)}
      </Text>
      <Text selectable style={[styles.messageBubble, { color: colors.ink, borderColor: colors.border,
        backgroundColor: ownSide ? colors.surface : colors.background }]}>{message.content}</Text>
      {message.deliveryStatus === "pending" && <Text style={[styles.messageMeta, { color: colors.muted }]}>
        {mobileMessage(locale, "partner.delivery.pending")}
      </Text>}
    </View>
    {ownSide && avatar}
  </View>;
}

export function MobilePartnersScreen({ colors, locale, view, onBack, onOpenPartner, onClosePartner,
  onOpenThread, onCloseThread, onRefresh, onDetailVisible }: MobilePartnersScreenProps) {
  const { width } = useWindowDimensions();
  const wide = width >= 780;
  const [route, setRoute] = useState<NarrowRoute>(() => initialRoute(view));
  const [pulling, setPulling] = useState(false);
  const refreshBinding = JSON.stringify([view.open, route]);
  const refreshBindingRef = useRef(refreshBinding); refreshBindingRef.current = refreshBinding;
  const refreshFlight = useRef<object | undefined>(undefined);
  const pullFallback = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    refreshFlight.current = undefined; setPulling(false);
    return () => {
      refreshFlight.current = undefined;
      clearTimeout(pullFallback.current); pullFallback.current = undefined;
    };
  }, [refreshBinding]);
  const refresh = (pull = false): void => {
    if (!view.open || refreshBindingRef.current !== refreshBinding || refreshFlight.current
      || pull && (view.status === "offline" || view.detailStatus === "offline")) return;
    const flight = {}; refreshFlight.current = flight;
    if (pull) {
      setPulling(true);
      clearTimeout(pullFallback.current);
      pullFallback.current = setTimeout(() => {
        if (refreshFlight.current === flight && refreshBindingRef.current === refreshBinding) setPulling(false);
      }, 8000);
    }
    const finish = (): void => {
      if (refreshFlight.current !== flight || refreshBindingRef.current !== refreshBinding) return;
      refreshFlight.current = undefined; clearTimeout(pullFallback.current); pullFallback.current = undefined;
      setPulling(false);
    };
    try {
      const pending = onRefresh();
      if (pending === undefined) finish();
      else void pending.catch(() => undefined).finally(finish);
    }
    catch { finish(); }
  };
  const refreshAction = (): void => refresh();
  const previousThread = useRef(view.selectedThreadId);
  const previousPartner = useRef(view.selectedPartnerId);
  const visibleContext = useRef<{
    readonly partnerId: string;
    readonly threadId: string;
    readonly detail: MobilePrivateDetail;
    readonly onDetailVisible: MobilePartnersScreenProps["onDetailVisible"];
  } | undefined>(undefined);
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50, minimumViewTime: 150 }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }: { readonly viewableItems: readonly ViewToken[] }) => {
    const context = visibleContext.current;
    if (!context) return;
    let lastVisibleSequence = 0;
    for (const token of viewableItems) {
      if (!token.isViewable) continue;
      const item = token.item as MobilePrivateMessage | undefined;
      if (!item || item.threadId !== context.threadId) continue;
      if (!context.detail.messages.some((message) => message.messageId === item.messageId
        && message.sequence === item.sequence)) continue;
      lastVisibleSequence = Math.max(lastVisibleSequence, item.sequence);
    }
    if (lastVisibleSequence > 0) {
      context.onDetailVisible(context.partnerId, context.threadId, lastVisibleSequence);
    }
  }).current;

  useEffect(() => () => { visibleContext.current = undefined; }, []);

  useEffect(() => {
    const changedThread = view.selectedThreadId && view.selectedThreadId !== previousThread.current;
    const changedPartner = view.selectedPartnerId && view.selectedPartnerId !== previousPartner.current;
    previousThread.current = view.selectedThreadId;
    previousPartner.current = view.selectedPartnerId;
    if (changedThread && view.selectedPartnerId) {
      setRoute({ kind: "detail", partnerId: view.selectedPartnerId, threadId: view.selectedThreadId! });
    } else if (changedPartner && route.kind === "directory") {
      setRoute({ kind: "threads", partnerId: view.selectedPartnerId! });
    }
  }, [view.selectedPartnerId, view.selectedThreadId]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (wide) {
        if (view.selectedThreadId) onCloseThread();
        else if (view.selectedPartnerId) onClosePartner();
        else onBack();
      } else if (route.kind === "detail") {
        setRoute({ kind: "threads", partnerId: route.partnerId });
        onCloseThread();
      } else if (route.kind === "threads") {
        setRoute({ kind: "directory" });
        onClosePartner();
      } else {
        onBack();
      }
      return true;
    });
    return () => subscription.remove();
  }, [wide, route, view.selectedPartnerId, view.selectedThreadId, onBack, onClosePartner, onCloseThread]);

  const openPartner = (partnerId: string) => {
    setRoute({ kind: "threads", partnerId });
    onOpenPartner(partnerId);
  };
  const openThread = (partnerId: string, threadId: string) => {
    setRoute({ kind: "detail", partnerId, threadId });
    onOpenThread(partnerId, threadId);
  };
  const backToDirectory = () => {
    setRoute({ kind: "directory" });
    onClosePartner();
  };
  const backToThreads = (partnerId: string) => {
    setRoute({ kind: "threads", partnerId });
    onCloseThread();
  };
  const selectedPartner = view.partners.find((partner) => partner.partnerId === view.selectedPartnerId
    && (wide || route.kind === "directory" || route.partnerId === partner.partnerId));
  const selectedThread = view.threads.find((thread) => thread.threadId === view.selectedThreadId
    && (wide || route.kind !== "detail" || route.threadId === thread.threadId));
  const waitingForRoute = !wide && route.kind === "detail"
    && (view.selectedPartnerId !== route.partnerId || view.selectedThreadId !== route.threadId);
  const detail = view.detail;
  const detailReady = view.status === "ready" && view.detailStatus === "ready" && detail !== undefined
    && view.selectedPartnerId !== undefined && view.selectedThreadId !== undefined
    && detail.thread.threadId === view.selectedThreadId
    && (detail.thread.firstPartnerId === view.selectedPartnerId
      || detail.thread.secondPartnerId === view.selectedPartnerId);
  const detailVisible = detailReady && (wide || route.kind === "detail"
    && route.partnerId === view.selectedPartnerId && route.threadId === view.selectedThreadId);
  visibleContext.current = detailVisible && detail ? {
    partnerId: view.selectedPartnerId!, threadId: view.selectedThreadId!, detail, onDetailVisible
  } : undefined;

  const directory = <View style={[styles.pane, wide && styles.wideDirectory]}>
    <View style={styles.header}>
      <Action label={mobileMessage(locale, "common.back")} colors={colors} onPress={onBack} />
      <View style={styles.grow}>
        <Text style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, "partner.title")}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "partner.readOnly")}</Text>
      </View>
      <Action label={mobileMessage(locale, "partner.refresh")} colors={colors} onPress={refreshAction}
        disabled={view.status === "loading"} />
    </View>
    {view.status === "offline" && <Notice colors={colors} text={mobileMessage(locale, "partner.offline")} />}
    {view.status === "offline" && <Action label={mobileMessage(locale, "partner.retry")}
      colors={colors} onPress={refreshAction} />}
    {view.status === "error" && <Notice colors={colors} error text={mobileMessage(locale, "partner.error")} />}
    {view.status === "error" && <Action label={mobileMessage(locale, "partner.retry")}
      colors={colors} onPress={refreshAction} />}
    {view.status === "loading" || view.status === "idle"
      ? <Centered colors={colors} text={mobileMessage(locale, "partner.loadingDirectory")} loading />
      : view.status === "ready" && view.partners.length === 0
        ? <Centered colors={colors} text={mobileMessage(locale, "partner.emptyDirectory")} />
        : view.status === "ready" && <ScrollView contentContainerStyle={styles.rows}>
          <Text style={[styles.section, { color: colors.muted }]}>
            {mobileMessage(locale, "partner.directoryCount", { count: view.partners.length })}
          </Text>
          {view.partners.map((partner) => <PartnerRow key={partner.partnerId} partner={partner}
            selected={partner.partnerId === view.selectedPartnerId} colors={colors} locale={locale}
            onPress={() => openPartner(partner.partnerId)} />)}
        </ScrollView>}
  </View>;

  const partnerIdForThreads = wide ? view.selectedPartnerId : route.kind === "directory" ? undefined : route.partnerId;
  const threadsReady = view.status === "ready" && partnerIdForThreads !== undefined
    && view.selectedPartnerId === partnerIdForThreads;
  const threadList = <View style={[styles.pane, wide && styles.wideThreads, { borderColor: colors.border }]}>
    <View style={styles.header}>
      {!wide && <Action label={mobileMessage(locale, "partner.backToDirectory")}
        colors={colors} onPress={backToDirectory} />}
      <View style={styles.grow}>
        <Text style={[styles.heading, { color: colors.ink }]}>
          {selectedPartner?.displayName ?? mobileMessage(locale, "partner.threads")}
        </Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "partner.threads")}</Text>
      </View>
    </View>
    {view.status === "offline"
      ? <View style={styles.errorBody}>
        <Notice colors={colors} text={mobileMessage(locale, "partner.offline")} />
        <Action label={mobileMessage(locale, "partner.retry")} colors={colors} onPress={refreshAction} />
      </View>
      : view.status === "error"
        ? <View style={styles.errorBody}>
          <Notice colors={colors} error text={mobileMessage(locale, "partner.error")} />
          <Action label={mobileMessage(locale, "partner.retry")} colors={colors} onPress={refreshAction} />
        </View>
        : !partnerIdForThreads
          ? <Centered colors={colors} text={mobileMessage(locale, "partner.selectPartner")} />
          : !threadsReady
            ? <Centered colors={colors} text={mobileMessage(locale, "partner.loadingThreads")} loading />
            : view.threads.length === 0
              ? <Centered colors={colors} text={mobileMessage(locale, "partner.emptyThreads")} />
              : <ScrollView contentContainerStyle={styles.rows}>
                <Text style={[styles.section, { color: colors.muted }]}>
                  {mobileMessage(locale, "partner.threadCount", { count: view.threads.length })}
                </Text>
                {view.threads.map((thread) => <ThreadRow key={thread.threadId} thread={thread}
                  partners={view.partners} selected={thread.threadId === view.selectedThreadId}
                  colors={colors} locale={locale}
                  onPress={() => openThread(partnerIdForThreads, thread.threadId)} />)}
              </ScrollView>}
  </View>;

  const detailPane = <View style={[styles.pane, styles.detailPane, { borderColor: colors.border }]}>
    <View style={styles.header}>
      {!wide && route.kind === "detail" && <Action label={mobileMessage(locale, "partner.backToThreads")}
        colors={colors} onPress={() => backToThreads(route.partnerId)} />}
      <View style={styles.grow}>
        <Text style={[styles.heading, { color: colors.ink }]}>
          {selectedThread ? mobileMessage(locale, "partner.pair", threadNames(selectedThread, view.partners, locale))
            : mobileMessage(locale, "partner.threads")}
        </Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "partner.readOnly")}</Text>
      </View>
      {selectedThread && <Action label={mobileMessage(locale, "partner.refresh")}
        colors={colors} onPress={refreshAction} disabled={view.detailStatus === "loading"} />}
    </View>
    {view.status === "offline" || view.detailStatus === "offline"
      ? <View style={styles.errorBody}>
        <Notice colors={colors} text={mobileMessage(locale, "partner.offline")} />
        <Action label={mobileMessage(locale, "partner.retry")} colors={colors} onPress={refreshAction} />
      </View>
      : view.status === "error" || view.detailStatus === "error"
        ? <View style={styles.errorBody}>
          <Notice colors={colors} error text={mobileMessage(locale, "partner.error")} />
          <Action label={mobileMessage(locale, "partner.retry")} colors={colors} onPress={refreshAction} />
        </View>
        : waitingForRoute
          ? <Centered colors={colors} text={mobileMessage(locale, "partner.loadingDetail")} loading />
        : !view.selectedThreadId || !selectedThread
          ? <Centered colors={colors} text={mobileMessage(locale, "partner.selectThread")} />
          : !detailVisible || !detail
            ? <Centered colors={colors} text={mobileMessage(locale, "partner.loadingDetail")} loading />
            : <>
              {view.detailError && <View style={styles.errorBody}>
                <Notice colors={colors} error text={mobileMessage(locale, "partner.readError")} />
                <Action label={mobileMessage(locale, "partner.retry")} colors={colors} onPress={refreshAction} />
              </View>}
              <View style={[styles.threadMeta, { borderColor: colors.border, backgroundColor: colors.surface }]}>
                <Text style={[styles.label, { color: colors.ink }]}>{threadStatus(detail.thread, locale)}</Text>
                <Text style={[styles.caption, { color: colors.muted }]}>
                  {mobileMessage(locale, "partner.messageLimit", {
                    count: detail.thread.messageCount, limit: detail.thread.maxMessages
                  })}
                </Text>
                <Text style={[styles.caption, { color: colors.muted }]}>
                  {mobileMessage(locale, "partner.expiresAt", { time: formatTime(detail.thread.expiresAt, locale) })}
                </Text>
                {detail.thread.blockedUntil !== undefined && <Text style={[styles.caption, { color: colors.negative }]}>
                  {mobileMessage(locale, "partner.blockedUntil", {
                    time: formatTime(detail.thread.blockedUntil, locale)
                  })}
                </Text>}
                {detail.thread.closedAt !== undefined && <Text style={[styles.caption, { color: colors.muted }]}>
                  {mobileMessage(locale, "partner.closedAt", { time: formatTime(detail.thread.closedAt, locale) })}
                </Text>}
                <Text style={[styles.caption, { color: colors.muted }]}>
                  {detail.readState
                    ? mobileMessage(locale, "partner.readThrough", {
                      name: partnerName(view.partners, detail.readState.partnerId, locale),
                      sequence: detail.readState.throughSequence
                    })
                    : mobileMessage(locale, "partner.readUnknown")}
                </Text>
              </View>
              <FlatList<MobilePrivateMessage> data={detail.messages} keyExtractor={(message) => message.messageId}
                  renderItem={({ item }) => <MessageRow message={item} viewerPartnerId={view.selectedPartnerId!} partners={view.partners}
                    colors={colors} locale={locale} />}
                  contentContainerStyle={styles.messages} viewabilityConfig={viewabilityConfig}
                  onViewableItemsChanged={onViewableItemsChanged}
                  refreshControl={<RefreshControl refreshing={pulling} onRefresh={() => refresh(true)} tintColor={colors.muted} />}
                  ListEmptyComponent={<Centered colors={colors} text={mobileMessage(locale, "partner.emptyMessages")} />}
                  ListFooterComponent={detail.thread.closeReason === "messageLimit" ? <View style={styles.messageLimit}
                    testID="partner.privateMessage.limit">
                    <View style={[styles.messageLimitLine, { backgroundColor: colors.border }]} />
                    <Text style={[styles.messageLimitText, { color: colors.muted }]}>{mobileMessage(locale, "partner.thread.closedLimit")}</Text>
                    <View style={[styles.messageLimitLine, { backgroundColor: colors.border }]} />
                  </View> : undefined} />
            </>}
  </View>;

  if (wide) return <View style={[styles.root, styles.wide, { backgroundColor: colors.background }]}>
    {directory}{threadList}{detailPane}
  </View>;
  return <View style={[styles.root, { backgroundColor: colors.background }]}>
    {route.kind === "directory" ? directory : route.kind === "threads" ? threadList : detailPane}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  wide: { flexDirection: "row" },
  pane: { flex: 1, padding: 12, gap: 10 },
  wideDirectory: { flex: 0.8, minWidth: 215, maxWidth: 285 },
  wideThreads: { flex: 1, minWidth: 235, maxWidth: 330, borderLeftWidth: 1 },
  detailPane: { borderLeftWidth: 1 },
  header: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: 8 },
  grow: { flex: 1 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700" },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: "700" },
  section: { fontSize: 12, lineHeight: 17, fontWeight: "700", marginBottom: 2 },
  label: { fontSize: 15, lineHeight: 21, fontWeight: "600" },
  body: { fontSize: 14, lineHeight: 20 },
  caption: { fontSize: 12, lineHeight: 17 },
  rows: { gap: 8, paddingBottom: 24 },
  row: { minHeight: 64, borderWidth: 1, borderRadius: 13, padding: 12, gap: 4, justifyContent: "center" },
  action: { minHeight: 44, minWidth: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 11,
    paddingVertical: 8, alignItems: "center", justifyContent: "center" },
  actionText: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
  notice: { minHeight: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12,
    paddingVertical: 9, justifyContent: "center" },
  centered: { flex: 1, minHeight: 140, alignItems: "center", justifyContent: "center", gap: 10, padding: 20 },
  centeredText: { textAlign: "center" },
  errorBody: { gap: 10 },
  threadMeta: { borderWidth: 1, borderRadius: 13, padding: 12, gap: 4 },
  messages: { gap: 16, paddingTop: 16, paddingBottom: 24, flexGrow: 1 },
  messageRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  messageRowOwn: { justifyContent: "flex-end" },
  messageRowPeer: { justifyContent: "flex-start" },
  messageColumn: { maxWidth: "74%", minWidth: 0, gap: 4 },
  messageColumnOwn: { alignItems: "flex-end" },
  messageColumnPeer: { alignItems: "flex-start" },
  messageMeta: { fontSize: 12, lineHeight: 18, paddingHorizontal: 4 },
  messageBubble: { fontSize: 17, lineHeight: 26, fontWeight: "400", borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 8, overflow: "hidden" },
  messageLimit: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 16 },
  messageLimitLine: { flex: 1, height: StyleSheet.hairlineWidth },
  messageLimitText: { flexShrink: 1, fontSize: 13, lineHeight: 18, textAlign: "center" }
});
