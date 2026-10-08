import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import {
  filterMobileExtensions,
  type MobileExtension,
  type MobileExtensionCatalog,
  type MobileExtensionTransport
} from "./mobile-extensions";
import type { MobilePartnersColors } from "./MobilePartnersScreen";

export interface MobileExtensionsScreenProps {
  readonly colors: MobilePartnersColors;
  readonly locale: MobileSupportedLocale;
  readonly transport?: MobileExtensionTransport;
  readonly onBack: () => void;
}

type DirectoryState = {
  readonly ownerKey?: string;
  readonly status: "offline" | "loading" | "ready" | "error";
  readonly refreshing: boolean;
  readonly catalog?: MobileExtensionCatalog;
};

type DetailState = {
  readonly ownerKey?: string;
  readonly extensionId?: string;
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly extension?: MobileExtension;
};

const emptyDirectory: DirectoryState = { status: "offline", refreshing: false };
const emptyDetail: DetailState = { status: "idle" };

type MutationState = {
  readonly ownerKey: string;
  readonly extensionId: string;
  readonly kind: "enabled" | "sidebar" | "receipt";
};

function errorText(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return (value.trim() || "Unknown error").slice(0, 1_024);
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

function setupState(extension: MobileExtension, locale: MobileSupportedLocale): string {
  return mobileMessage(locale, `extension.setup.${extension.setup.state}`);
}

function source(extension: MobileExtension, locale: MobileSupportedLocale): string {
  return mobileMessage(locale, `extension.source.${extension.source}`);
}

function availability(value: boolean, locale: MobileSupportedLocale): string {
  return mobileMessage(locale, value ? "extension.available" : "extension.unavailable");
}

function Capability({ label, available, colors, locale }: {
  readonly label: string;
  readonly available: boolean;
  readonly colors: MobilePartnersColors;
  readonly locale: MobileSupportedLocale;
}) {
  return <View style={styles.capability}>
    <Text style={[styles.body, styles.grow, { color: colors.ink }]}>{label}</Text>
    <Text style={[styles.caption, { color: available ? colors.accent : colors.muted }]}>{availability(available, locale)}</Text>
  </View>;
}

export function MobileExtensionsScreen({ colors, locale, transport, onBack }: MobileExtensionsScreenProps) {
  const { width } = useWindowDimensions();
  const wide = width >= 780;
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const listAbort = useRef<AbortController | undefined>(undefined);
  const detailAbort = useRef<AbortController | undefined>(undefined);
  const detailOccurrence = useRef<symbol | undefined>(undefined);
  const mutationAbort = useRef<AbortController | undefined>(undefined);
  const mutationOccurrence = useRef<symbol | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [directory, setDirectory] = useState<DirectoryState>(emptyDirectory);
  const [detail, setDetail] = useState<DetailState>(emptyDetail);
  const [mutation, setMutation] = useState<MutationState | undefined>();
  const [mutationError, setMutationError] = useState<string | undefined>();
  const ownerKey = transport?.ownerKey;

  useEffect(() => {
    listAbort.current?.abort();
    detailAbort.current?.abort();
    mutationAbort.current?.abort();
    detailOccurrence.current = undefined;
    mutationOccurrence.current = undefined;
    setDetail(emptyDetail);
    setMutation(undefined);
    setMutationError(undefined);
    if (!transport || !ownerKey) {
      setDirectory(emptyDirectory);
      return;
    }
    const controller = new AbortController();
    listAbort.current = controller;
    setDirectory((current) => current.ownerKey === ownerKey && current.catalog
      ? { ...current, status: "ready", refreshing: true }
      : { ownerKey, status: "loading", refreshing: false });
    void transport.list(controller.signal).then((catalog) => {
      if (controller.signal.aborted || transportRef.current?.ownerKey !== ownerKey) return;
      setDirectory({ ownerKey, status: "ready", refreshing: false, catalog });
    }, () => {
      if (controller.signal.aborted || transportRef.current?.ownerKey !== ownerKey) return;
      setDirectory((current) => current.ownerKey === ownerKey && current.catalog
        ? { ...current, status: "ready", refreshing: false }
        : { ownerKey, status: "error", refreshing: false });
    });
    return () => controller.abort();
  }, [attempt, ownerKey]);

  useEffect(() => () => {
    listAbort.current?.abort();
    detailAbort.current?.abort();
    mutationAbort.current?.abort();
    detailOccurrence.current = undefined;
    mutationOccurrence.current = undefined;
  }, []);

  const closeDetail = () => {
    detailAbort.current?.abort();
    detailOccurrence.current = undefined;
    setDetail(emptyDetail);
    setMutationError(undefined);
  };

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (detail.extensionId && !wide) closeDetail();
      else onBack();
      return true;
    });
    return () => subscription.remove();
  }, [detail.extensionId, onBack, wide]);

  const openDetail = (expected: MobileExtension) => {
    const currentTransport = transportRef.current;
    if (!currentTransport) return;
    detailAbort.current?.abort();
    const controller = new AbortController();
    const occurrence = Symbol("extension-detail");
    detailAbort.current = controller;
    detailOccurrence.current = occurrence;
    setMutationError(undefined);
    setDetail({ ownerKey: currentTransport.ownerKey, extensionId: expected.extensionId, status: "loading" });
    void currentTransport.detail(expected, controller.signal).then((extension) => {
      if (controller.signal.aborted || detailOccurrence.current !== occurrence
        || transportRef.current?.ownerKey !== currentTransport.ownerKey) return;
      setDetail({ ownerKey: currentTransport.ownerKey, extensionId: expected.extensionId, status: "ready", extension });
    }, () => {
      if (controller.signal.aborted || detailOccurrence.current !== occurrence
        || transportRef.current?.ownerKey !== currentTransport.ownerKey) return;
      setDetail({ ownerKey: currentTransport.ownerKey, extensionId: expected.extensionId, status: "error" });
    });
  };

  const adoptCurrent = (
    currentOwnerKey: string,
    extensionId: string,
    catalog: MobileExtensionCatalog,
    extension?: MobileExtension
  ) => {
    setDirectory({ ownerKey: currentOwnerKey, status: "ready", refreshing: false, catalog });
    setDetail((current) => current.ownerKey === currentOwnerKey && current.extensionId === extensionId
      ? extension === undefined
        ? emptyDetail
        : { ownerKey: currentOwnerKey, extensionId, status: "ready", extension }
      : current);
  };

  const refreshCurrent = async (
    currentTransport: MobileExtensionTransport,
    extensionId: string,
    signal: AbortSignal
  ): Promise<{ readonly catalog: MobileExtensionCatalog; readonly extension?: MobileExtension }> => {
    const catalog = await currentTransport.list(signal);
    const matches = catalog.extensions.filter((candidate) => candidate.extensionId === extensionId);
    if (matches.length === 0) return { catalog };
    if (matches.length !== 1) throw new Error("The Extension catalog contains an ambiguous identity.");
    return { catalog, extension: await currentTransport.detail(matches[0]!, signal) };
  };

  const changeExtension = (expected: MobileExtension, kind: "enabled" | "sidebar", value: boolean) => {
    const currentTransport = transportRef.current;
    if (!currentTransport || mutation !== undefined
      || currentTransport.pending.some((pending) => pending.extensionId === expected.extensionId)) return;
    const controller = new AbortController();
    const occurrence = Symbol("extension-mutation");
    mutationAbort.current = controller;
    mutationOccurrence.current = occurrence;
    setMutation({ ownerKey: currentTransport.ownerKey, extensionId: expected.extensionId, kind });
    setMutationError(undefined);
    const request = kind === "enabled"
      ? currentTransport.setEnabled(expected, value, controller.signal)
      : currentTransport.setSidebarVisible(expected, value, controller.signal);
    void request.then((result) => {
      if (controller.signal.aborted || mutationOccurrence.current !== occurrence
        || transportRef.current?.ownerKey !== currentTransport.ownerKey) return;
      adoptCurrent(currentTransport.ownerKey, expected.extensionId, result.catalog, result.extension);
    }, (error) => {
      if (controller.signal.aborted || mutationOccurrence.current !== occurrence
        || transportRef.current?.ownerKey !== currentTransport.ownerKey) return;
      setMutationError(errorText(error));
    }).finally(() => {
      if (mutationOccurrence.current !== occurrence) return;
      mutationOccurrence.current = undefined;
      mutationAbort.current = undefined;
      setMutation(undefined);
    });
  };

  const checkReceipt = (extensionId: string, operationId: string, dismiss: boolean) => {
    const currentTransport = transportRef.current;
    if (!currentTransport || mutation !== undefined) return;
    const controller = new AbortController();
    const occurrence = Symbol("extension-receipt");
    mutationAbort.current = controller;
    mutationOccurrence.current = occurrence;
    setMutation({ ownerKey: currentTransport.ownerKey, extensionId, kind: "receipt" });
    setMutationError(undefined);
    const check = dismiss
      ? currentTransport.dismiss(operationId, controller.signal)
      : currentTransport.reconcile(operationId, controller.signal);
    void check.then(() => refreshCurrent(currentTransport, extensionId, controller.signal)).then((result) => {
      if (controller.signal.aborted || mutationOccurrence.current !== occurrence
        || transportRef.current?.ownerKey !== currentTransport.ownerKey) return;
      adoptCurrent(currentTransport.ownerKey, extensionId, result.catalog, result.extension);
    }, (error) => {
      if (controller.signal.aborted || mutationOccurrence.current !== occurrence
        || transportRef.current?.ownerKey !== currentTransport.ownerKey) return;
      setMutationError(errorText(error));
    }).finally(() => {
      if (mutationOccurrence.current !== occurrence) return;
      mutationOccurrence.current = undefined;
      mutationAbort.current = undefined;
      setMutation(undefined);
    });
  };

  const visibleDirectory = directory.ownerKey === ownerKey ? directory : emptyDirectory;
  const visibleDetail = detail.ownerKey === ownerKey ? detail : emptyDetail;
  const extensions = visibleDirectory.catalog?.extensions ?? [];
  const filtered = useMemo(() => filterMobileExtensions(extensions, query), [extensions, query]);
  const selected = visibleDetail.extensionId
    ? extensions.find((extension) => extension.extensionId === visibleDetail.extensionId)
    : undefined;
  const pending = selected !== undefined && transport !== undefined && transport.ownerKey === ownerKey
    ? transport.pending.filter((receipt) => receipt.extensionId === selected.extensionId)
    : [];
  const selectedBusy = selected !== undefined && mutation !== undefined && mutation.ownerKey === ownerKey
    && mutation.extensionId === selected.extensionId;

  const directoryPane = <View style={[styles.pane, wide && styles.directoryPane]} testID="extensions.directory">
    <View style={styles.header}>
      <Action label={mobileMessage(locale, "common.back")} colors={colors} onPress={onBack} />
      <View style={styles.grow}>
        <Text style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, "extension.title")}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "extension.menuDescription")}</Text>
      </View>
      <Action label={mobileMessage(locale, "extension.refresh")} colors={colors}
        onPress={() => setAttempt((value) => value + 1)} disabled={!transport || visibleDirectory.refreshing || mutation !== undefined}
        testID="extensions.refresh" />
    </View>
    {visibleDirectory.status === "offline"
      ? <Centered colors={colors} text={mobileMessage(locale, "extension.offline")} />
      : visibleDirectory.status === "loading"
        ? <Centered colors={colors} loading text={mobileMessage(locale, "extension.loading")} />
        : visibleDirectory.status === "error"
          ? <View style={styles.centered}>
            <Centered colors={colors} error text={mobileMessage(locale, "extension.error")} />
            <Action label={mobileMessage(locale, "common.retry")} colors={colors}
              onPress={() => setAttempt((value) => value + 1)} />
          </View>
          : <>
            {visibleDirectory.catalog?.recoveredFromCorruption && <View accessibilityRole="alert"
              style={[styles.notice, { backgroundColor: colors.surface, borderColor: colors.negative }]}>
              <Text style={[styles.caption, { color: colors.negative }]}>{mobileMessage(locale, "extension.recovered")}</Text>
            </View>}
            <View style={[styles.search, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <TextInput accessibilityLabel={mobileMessage(locale, "extension.search")}
                autoCorrect={false} value={query} onChangeText={setQuery}
                placeholder={mobileMessage(locale, "extension.search")}
                placeholderTextColor={colors.muted} style={[styles.searchInput, { color: colors.ink }]} />
              {query.length > 0 && <Action label={mobileMessage(locale, "common.clear")} colors={colors}
                onPress={() => setQuery("")} />}
            </View>
            <FlatList contentContainerStyle={filtered.length === 0 ? styles.emptyList : styles.rows}
              data={filtered} keyExtractor={(extension) => extension.extensionId}
              ListEmptyComponent={<Centered colors={colors} text={mobileMessage(locale,
                query.trim() ? "extension.noResults" : "extension.empty")} />}
              renderItem={({ item: extension }) => <Pressable accessibilityRole="button"
                accessibilityLabel={mobileMessage(locale, "extension.openAccessibility", { name: extension.name })}
                accessibilityState={{ selected: extension.extensionId === visibleDetail.extensionId }}
                onPress={() => openDetail(extension)} testID={`extensions.item.${extension.extensionId}`}
                style={[styles.row, { borderColor: extension.extensionId === visibleDetail.extensionId ? colors.accent : colors.border,
                  backgroundColor: extension.extensionId === visibleDetail.extensionId ? colors.brandBackground : colors.surface }]}>
                <View style={[styles.monogram, { backgroundColor: colors.brandBackground }]}>
                  <Text style={[styles.monogramText, { color: colors.ink }]}>{Array.from(extension.name).slice(0, 2).join("").toLocaleUpperCase()}</Text>
                </View>
                <View style={styles.grow}>
                  <Text style={[styles.label, { color: colors.ink }]} numberOfLines={2}>{extension.name}</Text>
                  <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>
                    {[source(extension, locale), extension.version, mobileMessage(locale,
                      extension.enabled ? "extension.enabled" : "extension.disabled")].filter(Boolean).join(" · ")}
                  </Text>
                  <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "extension.setup")}: {setupState(extension, locale)}</Text>
                </View>
                <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
              </Pressable>} />
          </>}
  </View>;

  const extension = visibleDetail.extension;
  const detailPane = <View style={[styles.pane, styles.detailPane, { borderColor: colors.border }]}
    testID="extensions.detail">
    <View style={styles.header}>
      {!wide && <Action label={mobileMessage(locale, "extension.backToDirectory")} colors={colors}
        onPress={closeDetail} />}
      <View style={styles.grow}>
        <Text style={[styles.heading, { color: colors.ink }]}>{selected?.name ?? mobileMessage(locale, "extension.title")}</Text>
        {selected && <Text style={[styles.caption, { color: colors.muted }]}>{source(selected, locale)}</Text>}
      </View>
      {selected && <Action label={mobileMessage(locale, "common.refresh")} colors={colors}
        disabled={visibleDetail.status === "loading" || mutation !== undefined} onPress={() => openDetail(selected)} />}
    </View>
    {!selected
      ? <Centered colors={colors} text={mobileMessage(locale, "extension.empty")} />
      : visibleDetail.status === "loading"
        ? <Centered colors={colors} loading text={mobileMessage(locale, "extension.detailLoading")} />
        : visibleDetail.status === "error" || !extension
          ? <View style={styles.centered}>
            <Centered colors={colors} error text={mobileMessage(locale, "extension.detailError")} />
            <Action label={mobileMessage(locale, "common.retry")} colors={colors} onPress={() => openDetail(selected)} />
          </View>
          : <ScrollView contentContainerStyle={styles.detailContent}>
            {extension.description.length > 0 && <Text style={[styles.body, { color: colors.ink }]}>{extension.description}</Text>}
            <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Text style={[styles.label, { color: colors.ink }]}>{mobileMessage(locale,
                extension.enabled ? "extension.enabled" : "extension.disabled")}</Text>
              {extension.version && <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale,
                "extension.version", { version: extension.version })}</Text>}
              {extension.author && <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale,
                "extension.author", { author: extension.author })}</Text>}
              <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "extension.setup")}: {setupState(extension, locale)}</Text>
              {extension.updateAvailable && <Text style={[styles.caption, { color: colors.accent }]}>{mobileMessage(locale,
                "extension.updateAvailable")}</Text>}
            </View>
            {extension.error && <Text accessibilityRole="alert" style={[styles.body, { color: colors.negative }]}>
              {mobileMessage(locale, "extension.extensionError", { error: extension.error })}
            </Text>}
            {extension.setup.error && <Text accessibilityRole="alert" style={[styles.body, { color: colors.negative }]}>
              {mobileMessage(locale, "extension.setupError", { error: extension.setup.error })}
            </Text>}

            <Text style={[styles.section, { color: colors.muted }]}>{mobileMessage(locale, "extension.controls")}</Text>
            <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={styles.controlRow}>
                <View style={styles.grow}>
                  <Text style={[styles.label, { color: colors.ink }]}>{mobileMessage(locale,
                    extension.enabled ? "extension.enabled" : "extension.disabled")}</Text>
                </View>
                <Action label={mobileMessage(locale, extension.enabled ? "extension.disable" : "extension.enable")}
                  colors={colors} disabled={mutation !== undefined || pending.length > 0}
                  onPress={() => changeExtension(extension, "enabled", !extension.enabled)}
                  testID="extensions.enabled" />
              </View>
              {extension.sidebarSupported && <View style={styles.controlRow}>
                <View style={styles.grow}>
                  <Text style={[styles.label, { color: colors.ink }]}>{mobileMessage(locale,
                    extension.sidebarVisible ? "extension.sidebarVisible" : "extension.sidebarHidden")}</Text>
                </View>
                <Action label={mobileMessage(locale, extension.sidebarVisible ? "extension.hideSidebar" : "extension.showSidebar")}
                  colors={colors} disabled={mutation !== undefined || pending.length > 0}
                  onPress={() => changeExtension(extension, "sidebar", !extension.sidebarVisible)}
                  testID="extensions.sidebar" />
              </View>}
              {selectedBusy && <View style={styles.progress} accessibilityLiveRegion="polite">
                <ActivityIndicator color={colors.accent} />
                <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "extension.changing")}</Text>
              </View>}
            </View>
            {pending.map((receipt) => <View key={receipt.operationId} accessibilityRole="alert"
              style={[styles.notice, styles.receipt, { backgroundColor: colors.surface, borderColor: colors.negative }]}>
              <Text style={[styles.body, { color: colors.negative }]}>{mobileMessage(locale,
                receipt.state === "unknown" ? "extension.receiptUnknown" : "extension.receiptAccepted")}</Text>
              <Text selectable style={[styles.caption, { color: colors.muted }]}>{receipt.operationId}</Text>
              <View style={styles.actionRow}>
                <Action label={mobileMessage(locale, "extension.checkReceipt")} colors={colors}
                  disabled={mutation !== undefined} onPress={() => checkReceipt(extension.extensionId, receipt.operationId, false)} />
                {receipt.state === "unknown" && <Action label={mobileMessage(locale, "common.verifyClear")} colors={colors}
                  disabled={mutation !== undefined} onPress={() => Alert.alert(
                    mobileMessage(locale, "extension.clearReceiptTitle"),
                    mobileMessage(locale, "extension.clearReceiptBody"),
                    [{ text: mobileMessage(locale, "common.cancel"), style: "cancel" },
                      { text: mobileMessage(locale, "common.verifyClear"), onPress: () => {
                        checkReceipt(extension.extensionId, receipt.operationId, true);
                      } }]
                  )} />}
              </View>
            </View>)}
            {mutationError && <View accessibilityRole="alert"
              style={[styles.notice, styles.receipt, { backgroundColor: colors.surface, borderColor: colors.negative }]}>
              <Text style={[styles.body, { color: colors.negative }]}>{mobileMessage(locale,
                "extension.changeFailed", { error: mutationError })}</Text>
            </View>}

            <Text style={[styles.section, { color: colors.muted }]}>{mobileMessage(locale, "extension.capabilities")}</Text>
            <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Capability label={mobileMessage(locale, "extension.mainView")} available={extension.mainView !== undefined}
                colors={colors} locale={locale} />
              <Capability label={mobileMessage(locale, "extension.library")} available={extension.library !== undefined}
                colors={colors} locale={locale} />
              <Capability label={mobileMessage(locale, "extension.taskUse")} available={extension.useSupported}
                colors={colors} locale={locale} />
            </View>

            <Text style={[styles.section, { color: colors.muted }]}>{mobileMessage(locale, "extension.tools", {
              count: extension.tools.length
            })}</Text>
            {extension.tools.length === 0
              ? <Text style={[styles.body, { color: colors.muted }]}>{mobileMessage(locale, "extension.noTools")}</Text>
              : extension.tools.map((tool) => <View key={tool.name}
                style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Text style={[styles.label, { color: colors.ink }]}>{tool.name}</Text>
                {tool.description.length > 0 && <Text style={[styles.caption, { color: colors.muted }]}>{tool.description}</Text>}
              </View>)}

            <Text style={[styles.section, { color: colors.muted }]}>{mobileMessage(locale, "extension.permissions", {
              count: extension.permissions.length
            })}</Text>
            {extension.permissions.length === 0
              ? <Text style={[styles.body, { color: colors.muted }]}>{mobileMessage(locale, "extension.noPermissions")}</Text>
              : extension.permissions.map((permission) => <View key={permission.permissionId}
                style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Text style={[styles.label, { color: colors.ink }]}>{permission.label}</Text>
                {permission.description.length > 0 && <Text style={[styles.caption, { color: colors.muted }]}>{permission.description}</Text>}
                <Text style={[styles.caption, { color: colors.muted }]}>{[
                  mobileMessage(locale, permission.required ? "extension.permission.required" : "extension.permission.optional"),
                  mobileMessage(locale, permission.granted ? "extension.permission.granted" : "extension.permission.notGranted")
                ].join(" · ")}</Text>
              </View>)}

            <Text style={[styles.section, { color: colors.muted }]}>{mobileMessage(locale, "extension.commands", {
              count: extension.commands.length
            })}</Text>
            {extension.commands.length === 0
              ? <Text style={[styles.body, { color: colors.muted }]}>{mobileMessage(locale, "extension.noCommands")}</Text>
              : extension.commands.map((command) => <View key={command.name}
                style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Text style={[styles.label, { color: colors.ink }]}>/{command.name}</Text>
                {command.description.length > 0 && <Text style={[styles.caption, { color: colors.muted }]}>{command.description}</Text>}
              </View>)}
          </ScrollView>}
  </View>;

  return <View style={[styles.screen, { backgroundColor: colors.background }]}>
    {wide ? <View style={styles.wide}>{directoryPane}{detailPane}</View>
      : visibleDetail.extensionId ? detailPane : directoryPane}
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
  section: { fontSize: 13, fontWeight: "700", letterSpacing: 0.4, marginTop: 8, textTransform: "uppercase" },
  centered: { alignItems: "center", flex: 1, gap: 12, justifyContent: "center", padding: 24 },
  centeredText: { maxWidth: 360, textAlign: "center" },
  action: { alignItems: "center", borderRadius: 12, borderWidth: StyleSheet.hairlineWidth,
    justifyContent: "center", minHeight: 44, minWidth: 44, paddingHorizontal: 12 },
  actionText: { fontSize: 14, fontWeight: "600" },
  disabled: { opacity: 0.45 },
  notice: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, marginHorizontal: 12, marginBottom: 8, padding: 12 },
  search: { alignItems: "center", borderRadius: 14, borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row", gap: 8, marginHorizontal: 12, marginBottom: 8, paddingLeft: 12 },
  searchInput: { flex: 1, fontSize: 15, minHeight: 44, minWidth: 0 },
  rows: { gap: 8, padding: 12 },
  emptyList: { flexGrow: 1 },
  row: { alignItems: "center", borderRadius: 14, borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row", gap: 12, minHeight: 82, padding: 12 },
  monogram: { alignItems: "center", borderRadius: 24, height: 48, justifyContent: "center", width: 48 },
  monogramText: { fontSize: 14, fontWeight: "700" },
  chevron: { fontSize: 28 },
  detailContent: { gap: 12, padding: 16 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, gap: 4, padding: 14 },
  capability: { alignItems: "center", flexDirection: "row", gap: 12, minHeight: 30 },
  controlRow: { alignItems: "center", flexDirection: "row", gap: 12, minHeight: 52 },
  progress: { alignItems: "center", flexDirection: "row", gap: 8, minHeight: 44 },
  receipt: { marginHorizontal: 0, marginBottom: 0, gap: 8 },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 }
});
