import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import {
  mobileExtensionLibraryReady,
  type MobileExtensionLibraryGraceEntry,
  type MobileExtensionLibraryLocationValidation,
  type MobileExtensionLibraryMutation,
  type MobileExtensionLibraryOverview,
  type MobileExtensionLibrarySnapshot,
  type MobileExtensionLibraryTrashEntry
} from "./mobile-extension-library";
import { mobileExtensionKey, type MobileExtension, type MobileExtensionTransport } from "./mobile-extensions";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import type { MobilePartnersColors } from "./MobilePartnersScreen";

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "error" }
  | { readonly phase: "ready"; readonly snapshot: MobileExtensionLibrarySnapshot };

type LocationIntent = "relocate" | "rebind";
type ConfirmIntent =
  | { readonly kind: "default" }
  | { readonly kind: "unbind" }
  | { readonly kind: "trash" }
  | { readonly kind: "purge"; readonly entry: MobileExtensionLibraryTrashEntry }
  | { readonly kind: "rollback"; readonly entry: MobileExtensionLibraryGraceEntry };

interface ValidatedLocation {
  readonly candidate: string;
  readonly validation: MobileExtensionLibraryLocationValidation;
}

export function MobileExtensionLibrary({ colors, extension, locale, onBack, transport }: {
  readonly colors: MobilePartnersColors;
  readonly extension: MobileExtension;
  readonly locale: MobileSupportedLocale;
  readonly onBack: () => void;
  readonly transport: MobileExtensionTransport;
}) {
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const loadAbort = useRef<AbortController | undefined>(undefined);
  const actionAbort = useRef<AbortController | undefined>(undefined);
  const validationAbort = useRef<AbortController | undefined>(undefined);
  const loadOccurrence = useRef<symbol | undefined>(undefined);
  const actionOccurrence = useRef<symbol | undefined>(undefined);
  const validationOccurrence = useRef<symbol | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [busy, setBusy] = useState<MobileExtensionLibraryMutation["kind"]>();
  const [actionError, setActionError] = useState<string>();
  const [operationPhase, setOperationPhase] = useState<string>();
  const [locationIntent, setLocationIntent] = useState<LocationIntent>();
  const [candidate, setCandidate] = useState("");
  const [validatedLocation, setValidatedLocation] = useState<ValidatedLocation>();
  const [validationError, setValidationError] = useState<string>();
  const [validating, setValidating] = useState(false);
  const [confirmIntent, setConfirmIntent] = useState<ConfirmIntent>();
  const [confirmation, setConfirmation] = useState("");
  const [restoreEntry, setRestoreEntry] = useState<MobileExtensionLibraryTrashEntry>();
  const [restoreDestination, setRestoreDestination] = useState<"original" | "default">("original");
  const extensionKey = mobileExtensionKey(extension);

  useEffect(() => {
    const currentTransport = transportRef.current;
    const controller = new AbortController();
    const occurrence = Symbol("extension-library-load");
    loadAbort.current?.abort();
    loadAbort.current = controller;
    loadOccurrence.current = occurrence;
    setState({ phase: "loading" });
    setActionError(undefined);
    void currentTransport.loadLibrary(extension, controller.signal).then((snapshot) => {
      if (controller.signal.aborted || loadOccurrence.current !== occurrence
        || transportRef.current.ownerKey !== currentTransport.ownerKey) return;
      setState({ phase: "ready", snapshot });
    }, () => {
      if (controller.signal.aborted || loadOccurrence.current !== occurrence
        || transportRef.current.ownerKey !== currentTransport.ownerKey) return;
      setState({ phase: "error" });
    });
    return () => {
      controller.abort();
      if (loadOccurrence.current === occurrence) loadOccurrence.current = undefined;
    };
  }, [attempt, extensionKey, transport.ownerKey]);

  useEffect(() => () => {
    loadAbort.current?.abort();
    actionAbort.current?.abort();
    validationAbort.current?.abort();
    loadOccurrence.current = undefined;
    actionOccurrence.current = undefined;
    validationOccurrence.current = undefined;
  }, []);

  useEffect(() => {
    if (busy !== "relocate") return undefined;
    const controller = new AbortController();
    let reading = false;
    const read = (): void => {
      if (reading) return;
      reading = true;
      const currentTransport = transportRef.current;
      void currentTransport.loadLibrary(extension, controller.signal).then((snapshot) => {
        if (!controller.signal.aborted && transportRef.current.ownerKey === currentTransport.ownerKey) {
          setOperationPhase(snapshot.overview?.operation?.phase ?? "precheck");
        }
      }).catch(() => undefined).finally(() => { reading = false; });
    };
    read();
    const timer = setInterval(read, 500);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [busy, extensionKey, transport.ownerKey]);

  const snapshot = state.phase === "ready" ? state.snapshot : undefined;
  const overview = snapshot?.overview;
  const ready = mobileExtensionLibraryReady(extension);
  const unavailable = overview?.state === "unavailable";
  const canRebind = unavailable
    && (overview.unavailableReason === "diskMissing" || overview.unavailableReason === "bindingMoved");

  const closeDialogs = (): void => {
    validationAbort.current?.abort();
    validationOccurrence.current = undefined;
    setLocationIntent(undefined);
    setCandidate("");
    setValidatedLocation(undefined);
    setValidationError(undefined);
    setValidating(false);
    setConfirmIntent(undefined);
    setConfirmation("");
    setRestoreEntry(undefined);
    setRestoreDestination("original");
  };

  const perform = (mutation: MobileExtensionLibraryMutation): void => {
    const currentTransport = transportRef.current;
    if (snapshot === undefined || busy !== undefined) return;
    const controller = new AbortController();
    const occurrence = Symbol("extension-library-action");
    actionAbort.current?.abort();
    actionAbort.current = controller;
    actionOccurrence.current = occurrence;
    setBusy(mutation.kind);
    setActionError(undefined);
    if (mutation.kind === "relocate") setOperationPhase("precheck");
    void currentTransport.mutateLibrary(extension, snapshot, mutation, controller.signal).then((next) => {
      if (controller.signal.aborted || actionOccurrence.current !== occurrence
        || transportRef.current.ownerKey !== currentTransport.ownerKey) return;
      setState({ phase: "ready", snapshot: next });
      closeDialogs();
    }, (error: unknown) => {
      if (controller.signal.aborted || actionOccurrence.current !== occurrence
        || transportRef.current.ownerKey !== currentTransport.ownerKey) return;
      setActionError(errorText(error));
    }).finally(() => {
      if (actionOccurrence.current !== occurrence) return;
      actionOccurrence.current = undefined;
      actionAbort.current = undefined;
      setBusy(undefined);
      setOperationPhase(undefined);
    });
  };

  const updateCandidate = (value: string): void => {
    validationAbort.current?.abort();
    validationOccurrence.current = undefined;
    setCandidate(value);
    setValidatedLocation(undefined);
    setValidationError(undefined);
    setValidating(false);
  };

  const validateCandidate = (): void => {
    const exactCandidate = candidate.trim();
    const currentTransport = transportRef.current;
    if (exactCandidate.length === 0 || validating || busy !== undefined) return;
    const controller = new AbortController();
    const occurrence = Symbol("extension-library-location-validation");
    validationAbort.current?.abort();
    validationAbort.current = controller;
    validationOccurrence.current = occurrence;
    setValidating(true);
    setValidatedLocation(undefined);
    setValidationError(undefined);
    void currentTransport.validateLibraryLocation(extension, exactCandidate, controller.signal).then((validation) => {
      if (controller.signal.aborted || validationOccurrence.current !== occurrence
        || transportRef.current.ownerKey !== currentTransport.ownerKey) return;
      setValidatedLocation({ candidate: exactCandidate, validation });
    }, (error: unknown) => {
      if (controller.signal.aborted || validationOccurrence.current !== occurrence
        || transportRef.current.ownerKey !== currentTransport.ownerKey) return;
      setValidationError(errorText(error));
    }).finally(() => {
      if (validationOccurrence.current !== occurrence) return;
      validationAbort.current = undefined;
      setValidating(false);
    });
  };

  const openLocation = (intent: LocationIntent): void => {
    if (!ready || busy !== undefined) return;
    setLocationIntent(intent);
    setCandidate("");
    setValidatedLocation(undefined);
    setValidationError(undefined);
  };

  return <View style={[styles.root, { backgroundColor: colors.background }]} testID="extensions.library.surface">
    <View style={[styles.header, { borderColor: colors.border }]}>
      <Action label={mobileMessage(locale, "common.back")} colors={colors} onPress={onBack}
        testID="extensions.library.back" />
      <View style={styles.grow}>
        <Text style={[styles.title, { color: colors.ink }]} numberOfLines={1}>{extension.name}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "extension.libraryTitle")}</Text>
      </View>
      <Action label={mobileMessage(locale, "common.refresh")} colors={colors}
        disabled={busy !== undefined || state.phase === "loading"}
        onPress={() => setAttempt((value) => value + 1)} testID="extensions.library.refresh" />
    </View>

    {state.phase === "loading"
      ? <Status colors={colors} text={mobileMessage(locale, "extension.libraryLoading")} loading />
      : state.phase === "error"
        ? <View style={styles.centered} accessibilityRole="alert">
          <Text style={[styles.body, styles.centeredText, { color: colors.negative }]}>
            {mobileMessage(locale, "extension.libraryError")}
          </Text>
          <Action label={mobileMessage(locale, "common.retry")} colors={colors}
            onPress={() => setAttempt((value) => value + 1)} />
        </View>
        : snapshot && <ScrollView contentContainerStyle={styles.content}>
          <View style={[styles.hero, { backgroundColor: colors.brandBackground, borderColor: colors.border }]}>
            <View style={styles.grow}>
              <Text style={[styles.heading, { color: colors.ink }]}>{mobileMessage(locale, "extension.libraryTitle")}</Text>
              <Text style={[styles.body, { color: colors.muted }]}>{mobileMessage(locale, "extension.libraryBody")}</Text>
            </View>
            {overview && <StatePill colors={colors} locale={locale} overview={overview} />}
          </View>

          {actionError !== undefined && <Notice colors={colors} danger text={mobileMessage(locale,
            "extension.libraryActionFailed", { error: actionError })}>
            <Action label={mobileMessage(locale, "common.refresh")} colors={colors}
              onPress={() => setAttempt((value) => value + 1)} />
          </Notice>}
          {!ready && <Notice colors={colors} text={`${mobileMessage(locale, "extension.libraryNotReady")}. ${mobileMessage(locale,
            "extension.libraryNotReadyBody")}`} />}
          {overview?.orphaned === true && <Notice colors={colors} text={`${mobileMessage(locale,
            "extension.libraryOrphaned")}. ${mobileMessage(locale, "extension.libraryOrphanedBody")}`} />}
          {overview?.softLimitExceeded === true && <Notice colors={colors} text={`${mobileMessage(locale,
            "extension.librarySoftLimit")}. ${mobileMessage(locale, "extension.librarySoftLimitBody", {
              limit: formatBytes(overview.softLimitBytes)
            })}`} />}
          {(overview?.operation !== undefined || busy === "relocate") && <MigrationStatus colors={colors} locale={locale}
            phase={overview?.operation?.phase ?? operationPhase ?? "precheck"} />}

          {overview && <View style={styles.summary}>
            <Summary colors={colors} label={mobileMessage(locale, "extension.libraryLocation")}
              value={overview.location === undefined
                ? mobileMessage(locale, "extension.libraryUnbound")
                : mobileMessage(locale, overview.location.kind === "default"
                  ? "extension.libraryDefault" : "extension.libraryCustom")}
              detail={overview.location?.path ?? mobileMessage(locale, "extension.libraryUnboundBody")} />
            <Summary colors={colors} label={mobileMessage(locale, "extension.libraryUsage")}
              value={formatBytes(overview.bytes)}
              detail={mobileMessage(locale, "extension.libraryFiles", { count: overview.files })} />
            <Summary colors={colors} label={mobileMessage(locale, "extension.libraryFree")}
              value={overview.diskFreeBytes === undefined ? mobileMessage(locale, "common.unknown")
                : formatBytes(overview.diskFreeBytes)}
              detail={mobileMessage(locale, "extension.libraryReserve")} />
          </View>}

          {overview?.state === "unavailable" && <View style={[styles.card, {
            backgroundColor: colors.surface,
            borderColor: colors.negative
          }]} accessibilityRole="alert">
            <Text style={[styles.heading, { color: colors.negative }]}>{mobileMessage(locale, "extension.libraryUnavailable")}</Text>
            <Text style={[styles.body, { color: colors.ink }]}>{unavailableReason(locale, overview.unavailableReason)}</Text>
            <View style={styles.actions}>
              {canRebind && <Action label={mobileMessage(locale, "extension.libraryRebind")} colors={colors}
                disabled={busy !== undefined} onPress={() => openLocation("rebind")}
                testID="extensions.library.rebind" />}
              {overview.unavailableReason === "metadataCorrupt" && <Action
                label={mobileMessage(locale, "extension.libraryRepairMetadata")} colors={colors}
                disabled={busy !== undefined} onPress={() => perform({ kind: "repairMetadata" })}
                testID="extensions.library.repairMetadata" />}
              {overview.unavailableReason === "stateCorrupt" && <Action
                label={mobileMessage(locale, "extension.libraryRepairState")} colors={colors}
                disabled={busy !== undefined} onPress={() => perform({ kind: "repairState" })}
                testID="extensions.library.repairState" />}
              {overview.location !== undefined && <Action label={mobileMessage(locale, "extension.libraryUnbind")}
                colors={colors} disabled={busy !== undefined}
                onPress={() => setConfirmIntent({ kind: "unbind" })} testID="extensions.library.unbind" />}
            </View>
          </View>}

          {ready && overview?.state !== "unavailable" && <View style={styles.actions}>
            {overview?.location === undefined && <Action label={mobileMessage(locale, "extension.libraryUseDefault")}
              colors={colors} disabled={busy !== undefined} onPress={() => setConfirmIntent({ kind: "default" })}
              testID="extensions.library.default" />}
            <Action label={mobileMessage(locale, overview?.location === undefined
              ? "extension.libraryChooseLocation" : "extension.libraryMove")}
              colors={colors} disabled={busy !== undefined} onPress={() => openLocation("relocate")}
              testID="extensions.library.relocate" />
            {overview?.location?.kind === "custom" && <Action
              label={mobileMessage(locale, "extension.libraryMoveDefault")} colors={colors}
              disabled={busy !== undefined} onPress={() => setConfirmIntent({ kind: "default" })} />}
            {overview?.location !== undefined && <Action label={mobileMessage(locale, "extension.libraryDelete")}
              colors={colors} danger disabled={busy !== undefined}
              onPress={() => { setConfirmation(""); setConfirmIntent({ kind: "trash" }); }}
              testID="extensions.library.trash" />}
          </View>}

          <RecoveryList colors={colors} locale={locale} title={mobileMessage(locale, "extension.libraryTrash")}
            empty={mobileMessage(locale, "extension.libraryTrashEmpty")} entries={snapshot.trash}
            expiryLabel={mobileMessage(locale, "extension.libraryDeleteAfter")}
            actions={(entry) => <>
              <Action label={mobileMessage(locale, "extension.libraryRestore")} colors={colors}
                disabled={busy !== undefined} onPress={() => {
                  setConfirmation("");
                  setRestoreDestination("original");
                  setRestoreEntry(entry);
                }} testID={`extensions.library.restore.${entry.id}`} />
              <Action label={mobileMessage(locale, "extension.libraryPurge")} colors={colors} danger
                disabled={busy !== undefined} onPress={() => {
                  setConfirmation("");
                  setConfirmIntent({ kind: "purge", entry });
                }} testID={`extensions.library.purge.${entry.id}`} />
            </>} />
          <RecoveryList colors={colors} locale={locale} title={mobileMessage(locale, "extension.libraryGrace")}
            empty={mobileMessage(locale, "extension.libraryGraceEmpty")} entries={snapshot.grace}
            expiryLabel={mobileMessage(locale, "extension.libraryExpires")}
            actions={(entry) => <Action label={mobileMessage(locale, "extension.libraryRollback")}
              colors={colors} disabled={!ready || busy !== undefined}
              onPress={() => setConfirmIntent({ kind: "rollback", entry })}
              testID={`extensions.library.rollback.${entry.id}`} />} />

          {busy !== undefined && <View style={styles.progress} accessibilityLiveRegion="polite">
            <ActivityIndicator color={colors.accent} />
            <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "extension.libraryWorking")}</Text>
          </View>}
        </ScrollView>}

    <Modal visible={locationIntent !== undefined} transparent animationType="fade"
      onRequestClose={() => { if (!validating && busy === undefined) closeDialogs(); }}>
      <Dialog colors={colors} title={mobileMessage(locale, locationIntent === "rebind"
        ? "extension.libraryRebindTitle" : "extension.libraryMoveTitle")}
        body={mobileMessage(locale, locationIntent === "rebind"
          ? "extension.libraryRebindBody" : "extension.libraryMoveBody")}>
        <Text style={[styles.label, { color: colors.ink }]}>{mobileMessage(locale, "extension.libraryParentFolder")}</Text>
        <TextInput accessibilityLabel={mobileMessage(locale, "extension.libraryParentFolder")}
          autoCorrect={false} autoCapitalize="none" value={candidate} onChangeText={updateCandidate}
          editable={!validating && busy === undefined} placeholder={mobileMessage(locale, "extension.libraryPathPlaceholder")}
          placeholderTextColor={colors.muted} style={[styles.input, { color: colors.ink, borderColor: colors.border }]}
          testID="extensions.library.candidate" />
        <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "extension.libraryParentHint")}</Text>
        {validationError !== undefined && <Text accessibilityRole="alert" style={[styles.body, { color: colors.negative }]}>
          {validationError}
        </Text>}
        {validatedLocation !== undefined && <View style={[styles.card, {
          backgroundColor: colors.brandBackground,
          borderColor: colors.border
        }]} accessibilityRole="summary">
          <Text style={[styles.label, { color: colors.ink }]}>{mobileMessage(locale, "extension.libraryLocationReady")}</Text>
          <Text style={[styles.body, { color: colors.ink }]} selectable>{validatedLocation.validation.libraryRoot}</Text>
          <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "extension.libraryFreeValue", {
            value: validatedLocation.validation.diskFreeBytes === undefined
              ? mobileMessage(locale, "common.unknown")
              : formatBytes(validatedLocation.validation.diskFreeBytes)
          })}</Text>
        </View>}
        {validatedLocation?.validation.warnings.includes("cloud_sync_location") === true && <Notice colors={colors}
          text={`${mobileMessage(locale, "extension.libraryCloudWarning")}. ${mobileMessage(locale,
            "extension.libraryCloudWarningBody")}`} />}
        <View style={styles.actions}>
          <Action label={mobileMessage(locale, "common.cancel")} colors={colors}
            disabled={validating || busy !== undefined} onPress={closeDialogs} />
          <Action label={mobileMessage(locale, validating ? "extension.libraryValidating" : "extension.libraryValidate")}
            colors={colors} disabled={candidate.trim().length === 0 || validating || busy !== undefined}
            onPress={validateCandidate} testID="extensions.library.validate" />
          <Action label={mobileMessage(locale, locationIntent === "rebind"
            ? "extension.libraryRebind" : "extension.libraryConfirmMove")}
            colors={colors} disabled={validatedLocation === undefined || validating || busy !== undefined}
            onPress={() => {
              if (validatedLocation === undefined || locationIntent === undefined) return;
              if (locationIntent === "rebind") perform({
                kind: "rebind",
                candidate: validatedLocation.candidate,
                validation: validatedLocation.validation
              });
              else perform({ kind: "relocate", destination: {
                kind: "custom",
                candidate: validatedLocation.candidate,
                validation: validatedLocation.validation
              } });
            }} testID="extensions.library.confirmLocation" />
        </View>
      </Dialog>
    </Modal>

    <Modal visible={confirmIntent !== undefined} transparent animationType="fade"
      onRequestClose={() => { if (busy === undefined) closeDialogs(); }}>
      <Dialog colors={colors} title={mobileMessage(locale, "extension.libraryConfirmTitle")}
        body={confirmDescription(locale, confirmIntent, extension, overview)}>
        {(confirmIntent?.kind === "trash" || confirmIntent?.kind === "purge") && <>
          <Text style={[styles.label, { color: colors.ink }]}>{mobileMessage(locale, "extension.libraryTypeName", {
            name: confirmIntent.kind === "purge" ? confirmIntent.entry.name : extension.name
          })}</Text>
          <TextInput accessibilityLabel={mobileMessage(locale, "extension.libraryTypeName", {
            name: confirmIntent.kind === "purge" ? confirmIntent.entry.name : extension.name
          })} autoCorrect={false} autoCapitalize="none" value={confirmation} onChangeText={setConfirmation}
            editable={busy === undefined} style={[styles.input, { color: colors.ink, borderColor: colors.border }]}
            testID="extensions.library.confirmation" />
        </>}
        <View style={styles.actions}>
          <Action label={mobileMessage(locale, "common.cancel")} colors={colors}
            disabled={busy !== undefined} onPress={closeDialogs} />
          <Action label={confirmAction(locale, confirmIntent)} colors={colors}
            danger={confirmIntent?.kind === "trash" || confirmIntent?.kind === "purge"}
            disabled={busy !== undefined || !confirmationMatches(confirmIntent, extension, confirmation)}
            onPress={() => {
              const intent = confirmIntent;
              if (intent === undefined) return;
              if (intent.kind === "default") perform({ kind: "relocate", destination: { kind: "default" } });
              else if (intent.kind === "unbind") perform({ kind: "unbind" });
              else if (intent.kind === "trash") perform({ kind: "trash", confirmation });
              else if (intent.kind === "purge") perform({ kind: "purge", entry: intent.entry, confirmation });
              else perform({ kind: "rollback", entry: intent.entry });
            }} testID="extensions.library.confirmAction" />
        </View>
      </Dialog>
    </Modal>

    <Modal visible={restoreEntry !== undefined} transparent animationType="fade"
      onRequestClose={() => { if (busy === undefined) closeDialogs(); }}>
      <Dialog colors={colors} title={mobileMessage(locale, "extension.libraryRestoreTitle")}
        body={mobileMessage(locale, "extension.libraryRestoreBody", { name: restoreEntry?.name ?? "" })}>
        <Text style={[styles.label, { color: colors.ink }]}>{mobileMessage(locale, "extension.libraryTypeName", {
          name: restoreEntry?.name ?? ""
        })}</Text>
        <TextInput accessibilityLabel={mobileMessage(locale, "extension.libraryTypeName", {
          name: restoreEntry?.name ?? ""
        })} autoCorrect={false} autoCapitalize="none" value={confirmation} onChangeText={setConfirmation}
          editable={busy === undefined} style={[styles.input, { color: colors.ink, borderColor: colors.border }]}
          testID="extensions.library.restoreConfirmation" />
        <Text style={[styles.label, { color: colors.ink }]}>{mobileMessage(locale, "extension.libraryRestoreDestination")}</Text>
        <View style={styles.actions}>
          <Choice label={mobileMessage(locale, "extension.libraryRestoreOriginal")} colors={colors}
            selected={restoreDestination === "original"} disabled={busy !== undefined}
            onPress={() => setRestoreDestination("original")} />
          <Choice label={mobileMessage(locale, "extension.libraryRestoreDefault")} colors={colors}
            selected={restoreDestination === "default"} disabled={busy !== undefined}
            onPress={() => setRestoreDestination("default")} />
        </View>
        <View style={styles.actions}>
          <Action label={mobileMessage(locale, "common.cancel")} colors={colors}
            disabled={busy !== undefined} onPress={closeDialogs} />
          <Action label={mobileMessage(locale, "extension.libraryRestore")} colors={colors}
            disabled={restoreEntry === undefined || confirmation !== restoreEntry.name || busy !== undefined}
            onPress={() => {
              const entry = restoreEntry;
              if (entry !== undefined) perform({
                kind: "restore",
                entry,
                confirmation,
                destination: restoreDestination
              });
            }} testID="extensions.library.confirmRestore" />
        </View>
      </Dialog>
    </Modal>
  </View>;
}

function Action({ label, colors, onPress, disabled = false, danger = false, testID }: {
  readonly label: string;
  readonly colors: MobilePartnersColors;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly testID?: string;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress} testID={testID}
    style={[styles.action, { borderColor: danger ? colors.negative : colors.border, backgroundColor: colors.surface },
      disabled && styles.disabled]}>
    <Text style={[styles.actionText, { color: danger ? colors.negative : colors.ink }]}>{label}</Text>
  </Pressable>;
}

function Choice({ label, colors, selected, disabled, onPress }: {
  readonly label: string;
  readonly colors: MobilePartnersColors;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return <Pressable accessibilityRole="radio" accessibilityLabel={label}
    accessibilityState={{ checked: selected, disabled }} disabled={disabled} onPress={onPress}
    style={[styles.action, { borderColor: selected ? colors.accent : colors.border,
      backgroundColor: selected ? colors.brandBackground : colors.surface }, disabled && styles.disabled]}>
    <Text style={[styles.actionText, { color: colors.ink }]}>{label}</Text>
  </Pressable>;
}

function Status({ colors, text, loading = false }: {
  readonly colors: MobilePartnersColors;
  readonly text: string;
  readonly loading?: boolean;
}) {
  return <View style={styles.centered} accessibilityRole={loading ? "progressbar" : undefined}>
    {loading && <ActivityIndicator color={colors.accent} />}
    <Text style={[styles.body, styles.centeredText, { color: colors.muted }]}>{text}</Text>
  </View>;
}

function Notice({ colors, text, danger = false, children }: {
  readonly colors: MobilePartnersColors;
  readonly text: string;
  readonly danger?: boolean;
  readonly children?: ReactNode;
}) {
  return <View style={[styles.notice, { backgroundColor: colors.surface,
    borderColor: danger ? colors.negative : colors.border }]} accessibilityRole={danger ? "alert" : undefined}>
    <Text style={[styles.body, { color: danger ? colors.negative : colors.ink }]}>{text}</Text>
    {children}
  </View>;
}

function StatePill({ colors, locale, overview }: {
  readonly colors: MobilePartnersColors;
  readonly locale: MobileSupportedLocale;
  readonly overview: MobileExtensionLibraryOverview;
}) {
  const key = overview.state === "unavailable" ? "extension.libraryState.unavailable"
    : overview.state === "readOnly" ? "extension.libraryState.readOnly"
      : overview.orphaned ? "extension.libraryState.orphaned" : "extension.libraryState.ready";
  const warning = overview.state !== "ready" || overview.orphaned || overview.softLimitExceeded;
  return <View style={[styles.pill, { borderColor: warning ? colors.negative : colors.accent }]}>
    <Text style={[styles.pillText, { color: warning ? colors.negative : colors.accent }]}>{mobileMessage(locale, key)}</Text>
  </View>;
}

function Summary({ colors, label, value, detail }: {
  readonly colors: MobilePartnersColors;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) {
  return <View style={[styles.summaryCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <Text style={[styles.caption, { color: colors.muted }]}>{label}</Text>
    <Text style={[styles.label, { color: colors.ink }]}>{value}</Text>
    <Text style={[styles.caption, { color: colors.muted }]} selectable>{detail}</Text>
  </View>;
}

function MigrationStatus({ colors, locale, phase }: {
  readonly colors: MobilePartnersColors;
  readonly locale: MobileSupportedLocale;
  readonly phase: string;
}) {
  const phases = ["precheck", "copying", "verifying", "switching"] as const;
  const index = phases.indexOf(phase as (typeof phases)[number]);
  return <View style={[styles.progressCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
    accessibilityRole="progressbar" accessibilityLiveRegion="polite">
    <ActivityIndicator color={colors.accent} />
    <View style={styles.grow}>
      <Text style={[styles.label, { color: colors.ink }]}>{mobileMessage(locale, "extension.libraryMigrating")}</Text>
      <Text style={[styles.caption, { color: colors.muted }]}>{index < 0 ? phase : mobileMessage(locale,
        phaseMessage(phases[index]!))}</Text>
    </View>
  </View>;
}

function RecoveryList<T extends MobileExtensionLibraryTrashEntry | MobileExtensionLibraryGraceEntry>({
  colors,
  locale,
  title,
  empty,
  entries,
  expiryLabel,
  actions
}: {
  readonly colors: MobilePartnersColors;
  readonly locale: MobileSupportedLocale;
  readonly title: string;
  readonly empty: string;
  readonly entries: readonly T[];
  readonly expiryLabel: string;
  readonly actions: (entry: T) => ReactNode;
}) {
  return <View style={styles.sectionBlock}>
    <Text style={[styles.section, { color: colors.muted }]}>{title}</Text>
    {entries.length === 0
      ? <Text style={[styles.body, { color: colors.muted }]}>{empty}</Text>
      : entries.map((entry) => <View key={entry.id} style={[styles.card, {
        backgroundColor: colors.surface,
        borderColor: colors.border
      }]}>
        <Text style={[styles.label, { color: colors.ink }]}>{entry.name}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{[
          formatBytes(entry.bytes),
          mobileMessage(locale, "extension.libraryFiles", { count: entry.files }),
          `${expiryLabel} ${new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(entry.expiresAt)}`
        ].join(" · ")}</Text>
        <View style={styles.actions}>{actions(entry)}</View>
      </View>)}
  </View>;
}

function Dialog({ colors, title, body, children }: {
  readonly colors: MobilePartnersColors;
  readonly title: string;
  readonly body: string;
  readonly children: ReactNode;
}) {
  return <View style={styles.modalBackdrop}>
    <ScrollView style={[styles.dialog, { backgroundColor: colors.background, borderColor: colors.border }]}
      contentContainerStyle={styles.dialogContent} keyboardShouldPersistTaps="handled">
      <Text style={[styles.heading, { color: colors.ink }]}>{title}</Text>
      <Text style={[styles.body, { color: colors.muted }]}>{body}</Text>
      {children}
    </ScrollView>
  </View>;
}

function unavailableReason(
  locale: MobileSupportedLocale,
  reason: MobileExtensionLibraryOverview["unavailableReason"]
): string {
  switch (reason) {
    case "metadataCorrupt": return mobileMessage(locale, "extension.libraryReason.metadataCorrupt");
    case "fileLimit": return mobileMessage(locale, "extension.libraryReason.fileLimit");
    case "io": return mobileMessage(locale, "extension.libraryReason.io");
    case "operationInProgress": return mobileMessage(locale, "extension.libraryReason.operationInProgress");
    case "diskMissing": return mobileMessage(locale, "extension.libraryReason.diskMissing");
    case "bindingMoved": return mobileMessage(locale, "extension.libraryReason.bindingMoved");
    case "stateCorrupt": return mobileMessage(locale, "extension.libraryReason.stateCorrupt");
    default: return mobileMessage(locale, "common.unknown");
  }
}

function phaseMessage(phase: "precheck" | "copying" | "verifying" | "switching") {
  switch (phase) {
    case "precheck": return "extension.libraryPhase.precheck" as const;
    case "copying": return "extension.libraryPhase.copying" as const;
    case "verifying": return "extension.libraryPhase.verifying" as const;
    case "switching": return "extension.libraryPhase.switching" as const;
  }
}

function confirmDescription(
  locale: MobileSupportedLocale,
  intent: ConfirmIntent | undefined,
  extension: MobileExtension,
  overview: MobileExtensionLibraryOverview | undefined
): string {
  if (intent?.kind === "default") return mobileMessage(locale, "extension.libraryMoveDefaultBody");
  if (intent?.kind === "unbind") return mobileMessage(locale, "extension.libraryUnbindBody");
  if (intent?.kind === "trash") return mobileMessage(locale, "extension.libraryDeleteBody", {
    count: overview?.files ?? 0
  });
  if (intent?.kind === "purge") return mobileMessage(locale, "extension.libraryPurgeBody", { name: intent.entry.name });
  if (intent?.kind === "rollback") return mobileMessage(locale, "extension.libraryRollbackBody");
  return extension.name;
}

function confirmAction(locale: MobileSupportedLocale, intent: ConfirmIntent | undefined): string {
  if (intent?.kind === "default") return mobileMessage(locale, "extension.libraryConfirmMove");
  if (intent?.kind === "unbind") return mobileMessage(locale, "extension.libraryUnbind");
  if (intent?.kind === "trash") return mobileMessage(locale, "extension.libraryDelete");
  if (intent?.kind === "purge") return mobileMessage(locale, "extension.libraryPurge");
  return mobileMessage(locale, "extension.libraryRollback");
}

function confirmationMatches(
  intent: ConfirmIntent | undefined,
  extension: MobileExtension,
  confirmation: string
): boolean {
  if (intent?.kind === "trash") return confirmation === extension.name;
  if (intent?.kind === "purge") return confirmation === intent.entry.name;
  return intent !== undefined;
}

function formatBytes(value: bigint): string {
  if (value < 1024n) return `${value.toString(10)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let divisor = 1024n;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= divisor * 1024n; index += 1) {
    divisor *= 1024n;
    unit = units[index]!;
  }
  const tenths = value * 10n / divisor;
  return `${(tenths / 10n).toString(10)}.${(tenths % 10n).toString(10)} ${unit}`;
}

function errorText(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return (value.trim() || "Unknown error").slice(0, 1_024);
}

const styles = StyleSheet.create({
  root: { flex: 1, minWidth: 0 },
  header: { alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", gap: 12,
    minHeight: 64, padding: 12 },
  grow: { flex: 1, minWidth: 0 },
  title: { fontSize: 18, fontWeight: "700" },
  heading: { fontSize: 18, fontWeight: "700" },
  label: { fontSize: 15, fontWeight: "600" },
  body: { fontSize: 15, lineHeight: 21 },
  caption: { fontSize: 13, lineHeight: 18 },
  content: { gap: 12, padding: 16 },
  hero: { alignItems: "center", borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, flexDirection: "row",
    gap: 12, padding: 16 },
  pill: { borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 5 },
  pillText: { fontSize: 12, fontWeight: "700" },
  centered: { alignItems: "center", flex: 1, gap: 12, justifyContent: "center", padding: 24 },
  centeredText: { maxWidth: 380, textAlign: "center" },
  action: { alignItems: "center", borderRadius: 12, borderWidth: StyleSheet.hairlineWidth,
    justifyContent: "center", minHeight: 44, minWidth: 44, paddingHorizontal: 12, paddingVertical: 8 },
  actionText: { fontSize: 14, fontWeight: "600", textAlign: "center" },
  disabled: { opacity: 0.45 },
  notice: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, gap: 8, padding: 14 },
  summary: { gap: 8 },
  summaryCard: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, gap: 3, padding: 14 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, gap: 8, padding: 14 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  sectionBlock: { gap: 8 },
  section: { fontSize: 13, fontWeight: "700", letterSpacing: 0.4, textTransform: "uppercase" },
  progress: { alignItems: "center", flexDirection: "row", gap: 8, minHeight: 44 },
  progressCard: { alignItems: "center", borderRadius: 14, borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row", gap: 12, padding: 14 },
  modalBackdrop: { alignItems: "center", backgroundColor: "rgba(16, 18, 24, 0.48)", flex: 1,
    justifyContent: "flex-end", padding: 12 },
  dialog: { borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, maxHeight: "88%", maxWidth: 680,
    width: "100%" },
  dialogContent: { gap: 12, padding: 18 },
  input: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, fontSize: 15, minHeight: 46,
    paddingHorizontal: 12, paddingVertical: 10 }
});
