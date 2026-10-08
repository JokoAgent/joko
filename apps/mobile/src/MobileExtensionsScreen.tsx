import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  FlatList,
  Modal,
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
  mobileExtensionMainViewReady,
  type MobileExtension,
  type MobileExtensionCatalog,
  type MobileExtensionCommand,
  type MobileExtensionCredentialKind,
  type MobileExtensionTaskChoice,
  type MobileExtensionTransport,
  type MobileExtensionUseDestination
} from "./mobile-extensions";
import { mobileExtensionUseReady } from "./mobile-extension-use-handoff";
import { MobileExtensionMainView } from "./MobileExtensionMainView";
import type { MobilePartnersColors } from "./MobilePartnersScreen";

export interface MobileExtensionsScreenProps {
  readonly colors: MobilePartnersColors;
  readonly locale: MobileSupportedLocale;
  readonly transport?: MobileExtensionTransport;
  readonly onBack: () => void;
  readonly onOpenNewTask: () => void;
  readonly onOpenTask: () => void;
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
  readonly kind: "enabled" | "sidebar" | "setup" | "receipt";
};

type UseSelection = {
  readonly ownerKey: string;
  readonly extension: MobileExtension;
  readonly command: MobileExtensionCommand;
};

type MainViewSelection = {
  readonly ownerKey: string;
  readonly extension: MobileExtension;
};

function errorText(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return (value.trim() || "Unknown error").slice(0, 1_024);
}

function Action({ label, colors, onPress, disabled = false, selected, testID }: {
  readonly label: string;
  readonly colors: MobilePartnersColors;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly selected?: boolean;
  readonly testID?: string;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled, ...(selected === undefined ? {} : { selected }) }}
    disabled={disabled} onPress={onPress} testID={testID}
    style={[styles.action, {
      borderColor: selected ? colors.accent : colors.border,
      backgroundColor: selected ? colors.brandBackground : colors.surface
    }, disabled && styles.disabled]}>
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

function extensionSetupStartable(extension: MobileExtension | undefined): boolean {
  return extension?.setup.state === "required" || extension?.setup.state === "cancelled"
    || extension?.setup.state === "failed";
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

export function MobileExtensionsScreen({
  colors,
  locale,
  transport,
  onBack,
  onOpenNewTask,
  onOpenTask
}: MobileExtensionsScreenProps) {
  const { width } = useWindowDimensions();
  const wide = width >= 780;
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const listAbort = useRef<AbortController | undefined>(undefined);
  const detailAbort = useRef<AbortController | undefined>(undefined);
  const detailOccurrence = useRef<symbol | undefined>(undefined);
  const mutationAbort = useRef<AbortController | undefined>(undefined);
  const mutationOccurrence = useRef<symbol | undefined>(undefined);
  const useAbort = useRef<AbortController | undefined>(undefined);
  const useOccurrence = useRef<symbol | undefined>(undefined);
  const useInFlight = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [directory, setDirectory] = useState<DirectoryState>(emptyDirectory);
  const [detail, setDetail] = useState<DetailState>(emptyDetail);
  const [mutation, setMutation] = useState<MutationState | undefined>();
  const [mutationError, setMutationError] = useState<string | undefined>();
  const [setupValues, setSetupValues] = useState<Readonly<Record<string, string>>>({});
  const [credentialKinds, setCredentialKinds] = useState<Readonly<Record<string, MobileExtensionCredentialKind>>>({});
  const [useSelection, setUseSelection] = useState<UseSelection | undefined>();
  const [taskQuery, setTaskQuery] = useState("");
  const [useBusy, setUseBusy] = useState(false);
  const [useError, setUseError] = useState<string | undefined>();
  const [mainView, setMainView] = useState<MainViewSelection | undefined>();
  const ownerKey = transport?.ownerKey;

  useEffect(() => { setMainView(undefined); }, [ownerKey]);

  useEffect(() => {
    setSetupValues({});
    setCredentialKinds({});
  }, [detail.ownerKey, detail.extension?.extensionId, detail.extension?.setup.attemptId]);

  useEffect(() => {
    listAbort.current?.abort();
    detailAbort.current?.abort();
    mutationAbort.current?.abort();
    detailOccurrence.current = undefined;
    mutationOccurrence.current = undefined;
    setDetail(emptyDetail);
    setMutation(undefined);
    setMutationError(undefined);
    if (!useInFlight.current) {
      useAbort.current?.abort();
      useOccurrence.current = undefined;
      setUseSelection(undefined);
      setTaskQuery("");
      setUseBusy(false);
      setUseError(undefined);
    }
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
    useAbort.current?.abort();
    useInFlight.current = false;
    detailOccurrence.current = undefined;
    mutationOccurrence.current = undefined;
    useOccurrence.current = undefined;
  }, []);

  const closeDetail = () => {
    setMainView(undefined);
    detailAbort.current?.abort();
    detailOccurrence.current = undefined;
    setDetail(emptyDetail);
    setMutationError(undefined);
  };

  const closeUseSelection = () => {
    useAbort.current?.abort();
    useInFlight.current = false;
    useAbort.current = undefined;
    useOccurrence.current = undefined;
    setUseSelection(undefined);
    setTaskQuery("");
    setUseBusy(false);
    setUseError(undefined);
  };

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (useSelection) {
        if (!useBusy) closeUseSelection();
      } else if (mainView?.ownerKey === ownerKey) {
        setMainView(undefined);
      } else if (detail.extensionId && !wide) closeDetail();
      else onBack();
      return true;
    });
    return () => subscription.remove();
  }, [detail.extensionId, mainView, onBack, ownerKey, useBusy, useSelection, wide]);

  const openDetail = (expected: MobileExtension) => {
    const currentTransport = transportRef.current;
    if (!currentTransport) return;
    setMainView(undefined);
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

  const runExtensionMutation = (
    expected: MobileExtension,
    kind: MutationState["kind"],
    request: (current: MobileExtensionTransport, signal: AbortSignal) => Promise<{
      readonly catalog: MobileExtensionCatalog;
      readonly extension: MobileExtension;
    }>
  ) => {
    const currentTransport = transportRef.current;
    if (!currentTransport || mutation !== undefined
      || currentTransport.pending.some((pending) => pending.extensionId === expected.extensionId)) return;
    const controller = new AbortController();
    const occurrence = Symbol("extension-mutation");
    mutationAbort.current = controller;
    mutationOccurrence.current = occurrence;
    setMutation({ ownerKey: currentTransport.ownerKey, extensionId: expected.extensionId, kind });
    setMutationError(undefined);
    void request(currentTransport, controller.signal).then((result) => {
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

  const changeExtension = (expected: MobileExtension, kind: "enabled" | "sidebar", value: boolean) => {
    runExtensionMutation(expected, kind, (current, signal) => kind === "enabled"
      ? current.setEnabled(expected, value, signal)
      : current.setSidebarVisible(expected, value, signal));
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

  const openUseSelection = (extension: MobileExtension, command: MobileExtensionCommand) => {
    const currentTransport = transportRef.current;
    if (!currentTransport || mutation !== undefined || useBusy
      || currentTransport.pending.some((receipt) => receipt.extensionId === extension.extensionId)) return;
    useAbort.current?.abort();
    useOccurrence.current = undefined;
    setUseSelection({ ownerKey: currentTransport.ownerKey, extension, command });
    setTaskQuery("");
    setUseError(undefined);
  };

  const runCommandHandoff = (destination: MobileExtensionUseDestination) => {
    const currentTransport = transportRef.current;
    const selection = useSelection;
    if (!currentTransport || !selection || selection.ownerKey !== currentTransport.ownerKey || useBusy) return;
    const controller = new AbortController();
    const occurrence = Symbol("extension-command-handoff");
    useAbort.current = controller;
    useOccurrence.current = occurrence;
    useInFlight.current = true;
    setUseBusy(true);
    setUseError(undefined);
    void currentTransport.useCommand(selection.extension, selection.command, destination, controller.signal).then((result) => {
      if (controller.signal.aborted || useOccurrence.current !== occurrence) return;
      useInFlight.current = false;
      useOccurrence.current = undefined;
      useAbort.current = undefined;
      setUseSelection(undefined);
      setTaskQuery("");
      setUseBusy(false);
      setUseError(undefined);
      if (result.kind === "newTask") onOpenNewTask();
      else onOpenTask();
    }, (error) => {
      if (controller.signal.aborted || useOccurrence.current !== occurrence) return;
      useInFlight.current = false;
      if (transportRef.current?.ownerKey !== selection.ownerKey) {
        setUseSelection(undefined);
        setTaskQuery("");
        setUseError(undefined);
        return;
      }
      setUseError(errorText(error));
    }).finally(() => {
      if (useOccurrence.current !== occurrence) return;
      useInFlight.current = false;
      useOccurrence.current = undefined;
      useAbort.current = undefined;
      setUseBusy(false);
    });
  };

  const visibleDirectory = directory.ownerKey === ownerKey ? directory : emptyDirectory;
  const visibleDetail = detail.ownerKey === ownerKey ? detail : emptyDetail;
  const visibleMainView = mainView?.ownerKey === ownerKey ? mainView : undefined;
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
  const setupStartable = extensionSetupStartable(visibleDetail.extension);
  const setupComplete = visibleDetail.extension?.setup.fields.every((field) => !field.required || field.configured) ?? false;
  const taskChoices: readonly MobileExtensionTaskChoice[] = useSelection !== undefined
    && transport !== undefined && transport.ownerKey === useSelection.ownerKey
    ? transport.tasks(useSelection.extension)
    : [];
  const filteredTaskChoices = useMemo(() => {
    const needle = taskQuery.trim().normalize("NFKC").toLocaleLowerCase();
    return needle.length === 0 ? taskChoices : taskChoices.filter((choice) => [choice.displayName, choice.targetName]
      .some((value) => value.normalize("NFKC").toLocaleLowerCase().includes(needle)));
  }, [taskChoices, taskQuery]);

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

            {extension.mainView !== undefined && <>
              <Text style={[styles.section, { color: colors.muted }]}>{mobileMessage(locale, "extension.mainView")}</Text>
              <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
                testID="extensions.mainView.entry">
                <View style={styles.controlRow}>
                  <View style={styles.grow}>
                    <Text style={[styles.label, { color: colors.ink }]}>{extension.mainView.title
                      ?? mobileMessage(locale, "extension.mainView")}</Text>
                    <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale,
                      mobileExtensionMainViewReady(extension)
                        ? "extension.mainViewReadyBody"
                        : "extension.mainViewNotReadyBody")}</Text>
                  </View>
                  <Action label={mobileMessage(locale, "extension.mainViewOpen")} colors={colors}
                    disabled={!mobileExtensionMainViewReady(extension) || selectedBusy
                      || mutation !== undefined || pending.length > 0}
                    onPress={() => {
                      const currentTransport = transportRef.current;
                      if (!currentTransport || !mobileExtensionMainViewReady(extension)) return;
                      setMainView({ ownerKey: currentTransport.ownerKey, extension });
                    }} testID="extensions.mainView.open" />
                </View>
              </View>
            </>}

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

            <Text style={[styles.section, { color: colors.muted }]}>{mobileMessage(locale, "extension.setupSection")}</Text>
            <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
              testID="extensions.setup">
              <View style={styles.controlRow}>
                <View style={styles.grow}>
                  <Text style={[styles.label, { color: colors.ink }]}>{setupState(extension, locale)}</Text>
                  <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale,
                    "extension.setupRevision", { revision: extension.setup.revision.toString(10) })}</Text>
                </View>
                {setupStartable && <Action label={mobileMessage(locale,
                  extension.setup.state === "required" ? "extension.beginSetup" : "common.retry")}
                  colors={colors} disabled={selectedBusy || pending.length > 0}
                  onPress={() => runExtensionMutation(extension, "setup", (current, signal) =>
                    current.beginSetup(extension, signal))} testID="extensions.setup.begin" />}
              </View>
              {extension.setup.state === "required" && <Text style={[styles.body, { color: colors.muted }]}>
                {mobileMessage(locale, "extension.setupRequiredBody")}
              </Text>}
              {extension.setup.state === "cancelled" && <Text style={[styles.body, { color: colors.muted }]}>
                {mobileMessage(locale, "extension.setupCancelledBody")}
              </Text>}
              {extension.setup.state === "failed" && <Text style={[styles.body, { color: colors.muted }]}>
                {mobileMessage(locale, "extension.setupFailedBody")}
              </Text>}
              {extension.setup.state === "notRequired" && <Text style={[styles.body, { color: colors.muted }]}>
                {mobileMessage(locale, "extension.setupNotRequiredBody")}
              </Text>}
              {extension.setup.state === "ready" && <>
                <Text style={[styles.body, { color: colors.muted }]}>{mobileMessage(locale, "extension.setupReadyBody")}</Text>
                <View style={styles.actionRow}>
                  <Action label={mobileMessage(locale, "extension.revokeSetup")} colors={colors}
                    disabled={selectedBusy || pending.length > 0} testID="extensions.setup.revoke"
                    onPress={() => Alert.alert(
                      mobileMessage(locale, "extension.revokeSetupTitle"),
                      mobileMessage(locale, "extension.revokeSetupBody"),
                      [
                        { text: mobileMessage(locale, "common.cancel"), style: "cancel" },
                        { text: mobileMessage(locale, "extension.revokeSetup"), style: "destructive", onPress: () => {
                          runExtensionMutation(extension, "setup", (current, signal) => current.revokeSetup(extension, signal));
                        } }
                      ]
                    )} />
                </View>
              </>}
              {extension.setup.state === "inProgress" && <>
                <View style={styles.setupFields}>{extension.setup.fields.map((field) => {
                  const value = setupValues[field.fieldId] ?? "";
                  const secret = field.kind === "secret" || field.kind === "oauth";
                  const credentialKind: MobileExtensionCredentialKind = field.kind === "oauth"
                    ? "oauth"
                    : credentialKinds[field.fieldId] ?? "apiKey";
                  return <View key={field.fieldId} style={[styles.setupField, { borderColor: colors.border }]}
                    testID={`extensions.setup.field.${field.fieldId}`}>
                    <View style={styles.controlRow}>
                      <View style={styles.grow}>
                        <Text style={[styles.label, { color: colors.ink }]}>{field.label}</Text>
                        <Text style={[styles.caption, { color: colors.muted }]}>{[
                          mobileMessage(locale, field.required ? "extension.setupRequired" : "extension.setupOptional"),
                          mobileMessage(locale, field.configured ? "extension.configured" : "extension.notConfigured")
                        ].join(" · ")}</Text>
                      </View>
                      {field.kind === "confirmation" && <Action label={mobileMessage(locale,
                        field.configured ? "extension.withdrawConfirmation" : "extension.confirmSetup")}
                        colors={colors} selected={field.configured} disabled={selectedBusy || pending.length > 0}
                        onPress={() => runExtensionMutation(extension, "setup", (current, signal) =>
                          current.submitSetupInteraction(extension, field.fieldId, !field.configured, signal))}
                        testID={`extensions.setup.confirm.${field.fieldId}`} />}
                    </View>
                    {field.description.length > 0 && <Text style={[styles.body, { color: colors.muted }]}>{field.description}</Text>}
                    {field.kind !== "confirmation" && <>
                      {field.kind === "secret" && <View style={styles.actionRow}>
                        {(["apiKey", "headerSecret", "oauth"] as const).map((candidate) => <Action
                          key={candidate} label={mobileMessage(locale, `extension.credential.${candidate}`)}
                          colors={colors} selected={credentialKind === candidate}
                          disabled={selectedBusy || pending.length > 0}
                          onPress={() => setCredentialKinds((current) => ({ ...current, [field.fieldId]: candidate }))}
                          testID={`extensions.setup.kind.${field.fieldId}.${candidate}`} />)}
                      </View>}
                      {field.options.length > 0
                        ? <View style={styles.actionRow}>{field.options.map((option) => <Action key={option}
                          label={option} colors={colors} selected={value === option}
                          disabled={selectedBusy || pending.length > 0}
                          onPress={() => setSetupValues((current) => ({ ...current, [field.fieldId]: option }))} />)}</View>
                        : <TextInput accessibilityLabel={field.label} autoCapitalize="none" autoCorrect={false}
                          secureTextEntry={secret} value={value}
                          maxLength={secret ? 64 * 1024 : 8_192}
                          onChangeText={(next) => setSetupValues((current) => ({ ...current, [field.fieldId]: next }))}
                          editable={!selectedBusy && pending.length === 0}
                          placeholder={mobileMessage(locale, secret ? "extension.credentialPlaceholder" : "extension.valuePlaceholder")}
                          placeholderTextColor={colors.muted}
                          style={[styles.setupInput, { color: colors.ink, borderColor: colors.border,
                            backgroundColor: colors.background }]}
                          testID={`extensions.setup.input.${field.fieldId}`} />}
                      <View style={styles.actionRow}>
                        <Action label={mobileMessage(locale, "common.save")} colors={colors}
                          disabled={selectedBusy || pending.length > 0 || value.trim().length === 0}
                          onPress={() => {
                            if (secret) {
                              setSetupValues((current) => ({ ...current, [field.fieldId]: "" }));
                              runExtensionMutation(extension, "setup", (current, signal) =>
                                current.saveSetupCredential(extension, field.fieldId, credentialKind, value, signal));
                            } else {
                              runExtensionMutation(extension, "setup", (current, signal) =>
                                current.submitSetupInteraction(extension, field.fieldId, value, signal));
                            }
                          }} testID={`extensions.setup.save.${field.fieldId}`} />
                      </View>
                    </>}
                  </View>;
                })}</View>
                <View style={styles.actionRow}>
                  <Action label={mobileMessage(locale, "extension.cancelSetup")} colors={colors}
                    disabled={selectedBusy || pending.length > 0}
                    onPress={() => runExtensionMutation(extension, "setup", (current, signal) =>
                      current.cancelSetup(extension, signal))} testID="extensions.setup.cancel" />
                  <Action label={mobileMessage(locale, "extension.completeSetup")} colors={colors}
                    disabled={selectedBusy || pending.length > 0 || !setupComplete}
                    onPress={() => runExtensionMutation(extension, "setup", (current, signal) =>
                      current.completeSetup(extension, signal))} testID="extensions.setup.complete" />
                </View>
              </>}
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
                <View style={styles.controlRow}>
                  <View style={styles.grow}>
                    <Text style={[styles.label, { color: colors.ink }]}>/{command.name}</Text>
                    {command.description.length > 0 && <Text style={[styles.caption, { color: colors.muted }]}>{command.description}</Text>}
                  </View>
                  <Action label={mobileMessage(locale, "extension.useCommand", { command: command.name })}
                    colors={colors} disabled={!mobileExtensionUseReady(extension) || selectedBusy
                      || mutation !== undefined || useBusy || pending.length > 0}
                    onPress={() => openUseSelection(extension, command)}
                    testID={`extensions.command.use.${command.name}`} />
                </View>
                {!mobileExtensionUseReady(extension) && <Text style={[styles.caption, { color: colors.muted }]}>
                  {mobileMessage(locale, "extension.useSetupRequired")}
                </Text>}
              </View>)}
          </ScrollView>}
  </View>;

  const visibleUseSelection = useSelection !== undefined && (useSelection.ownerKey === ownerKey || useBusy)
    ? useSelection
    : undefined;
  const newTaskRuntimeAvailable = visibleUseSelection !== undefined
    && taskChoices.some((choice) => choice.sessionId === visibleUseSelection.command.sessionId);

  return <>
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      {wide ? <View style={styles.wide}>{directoryPane}{visibleMainView && transport
        ? <MobileExtensionMainView colors={colors} extension={visibleMainView.extension} locale={locale}
          transport={transport} onBack={() => setMainView(undefined)} />
        : detailPane}</View>
        : visibleMainView && transport
          ? <MobileExtensionMainView colors={colors} extension={visibleMainView.extension} locale={locale}
            transport={transport} onBack={() => setMainView(undefined)} />
          : visibleDetail.extensionId ? detailPane : directoryPane}
    </View>
    <Modal visible={visibleUseSelection !== undefined} transparent animationType="fade"
      onRequestClose={() => { if (!useBusy) closeUseSelection(); }}>
      <View style={styles.modalBackdrop}>
        {visibleUseSelection && <View style={[styles.useSheet, {
          backgroundColor: colors.background,
          borderColor: colors.border
        }]} testID="extensions.command.destination">
          <View style={styles.header}>
            <View style={styles.grow}>
              <Text style={[styles.heading, { color: colors.ink }]}>{mobileMessage(locale,
                "extension.useTitle", { command: visibleUseSelection.command.name })}</Text>
              <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale,
                "extension.useDescription")}</Text>
            </View>
            <Action label={mobileMessage(locale, "common.cancel")} colors={colors}
              disabled={useBusy} onPress={closeUseSelection} />
          </View>
          <ScrollView contentContainerStyle={styles.useContent}>
            <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={styles.controlRow}>
                <View style={styles.grow}>
                  <Text style={[styles.label, { color: colors.ink }]}>{mobileMessage(locale, "common.newTask")}</Text>
                  <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale,
                    newTaskRuntimeAvailable
                      ? "extension.useNewTaskBody"
                      : "extension.useRuntimeRequired")}</Text>
                </View>
                <Action label={mobileMessage(locale, "extension.useNewTask")}
                  colors={colors} disabled={useBusy || !newTaskRuntimeAvailable}
                  onPress={() => runCommandHandoff({ kind: "newTask" })}
                  testID="extensions.command.newTask" />
              </View>
            </View>

            <Text style={[styles.section, { color: colors.muted }]}>{mobileMessage(locale,
              "extension.useExistingTasks", { count: taskChoices.length })}</Text>
            <View style={[styles.search, styles.useSearch, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <TextInput accessibilityLabel={mobileMessage(locale, "extension.useSearchTasks")}
                autoCorrect={false} value={taskQuery} onChangeText={setTaskQuery}
                editable={!useBusy} placeholder={mobileMessage(locale, "extension.useSearchTasks")}
                placeholderTextColor={colors.muted} style={[styles.searchInput, { color: colors.ink }]} />
              {taskQuery.length > 0 && <Action label={mobileMessage(locale, "common.clear")}
                colors={colors} disabled={useBusy} onPress={() => setTaskQuery("")} />}
            </View>
            {filteredTaskChoices.length === 0
              ? <Text style={[styles.body, { color: colors.muted }]}>{mobileMessage(locale,
                taskQuery.trim().length > 0 ? "extension.useNoTaskResults" : "extension.useNoTasks")}</Text>
              : filteredTaskChoices.map((choice) => <View key={choice.sessionId}
                style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <View style={styles.controlRow}>
                  <View style={styles.grow}>
                    <Text style={[styles.label, { color: colors.ink }]}>{choice.displayName}</Text>
                    <Text style={[styles.caption, { color: colors.muted }]}>{choice.targetName}</Text>
                  </View>
                  <Action label={mobileMessage(locale, "extension.useCommandIn", {
                    command: visibleUseSelection.command.name,
                    task: choice.displayName
                  })} colors={colors} disabled={useBusy}
                  onPress={() => runCommandHandoff({ kind: "task", sessionId: choice.sessionId })}
                  testID={`extensions.command.task.${choice.sessionId}`} />
                </View>
              </View>)}
            {useBusy && <View style={styles.progress} accessibilityLiveRegion="polite">
              <ActivityIndicator color={colors.accent} />
              <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "extension.useWorking")}</Text>
            </View>}
            {useError && <View accessibilityRole="alert"
              style={[styles.notice, styles.receipt, { backgroundColor: colors.surface, borderColor: colors.negative }]}>
              <Text style={[styles.body, { color: colors.negative }]}>{mobileMessage(locale,
                "extension.useFailed", { error: useError })}</Text>
            </View>}
          </ScrollView>
        </View>}
      </View>
    </Modal>
  </>;
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
  setupFields: { gap: 12 },
  setupField: { borderTopWidth: StyleSheet.hairlineWidth, gap: 10, paddingTop: 12 },
  setupInput: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, fontSize: 15, minHeight: 46,
    paddingHorizontal: 12, paddingVertical: 10 },
  capability: { alignItems: "center", flexDirection: "row", gap: 12, minHeight: 30 },
  controlRow: { alignItems: "center", flexDirection: "row", gap: 12, minHeight: 52 },
  progress: { alignItems: "center", flexDirection: "row", gap: 8, minHeight: 44 },
  receipt: { marginHorizontal: 0, marginBottom: 0, gap: 8 },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  modalBackdrop: { alignItems: "center", backgroundColor: "rgba(16, 18, 24, 0.48)", flex: 1,
    justifyContent: "flex-end", padding: 12 },
  useSheet: { borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, maxHeight: "88%", maxWidth: 680,
    overflow: "hidden", width: "100%" },
  useContent: { gap: 10, padding: 16 },
  useSearch: { marginHorizontal: 0, marginBottom: 0 }
});
