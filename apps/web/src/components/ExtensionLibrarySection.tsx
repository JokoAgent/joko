import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { JSX } from "react";
import {
  AlertTriangle,
  ArchiveRestore,
  Cloud,
  Database,
  FolderCog,
  FolderOpen,
  HardDrive,
  RefreshCcw,
  RotateCcw,
  Trash2,
  Unlink
} from "lucide-react";

import type { AppController } from "../controller.js";
import type {
  ExtensionCatalogEntryView,
  ExtensionLibraryGraceEntryView,
  ExtensionLibraryLocationValidationView,
  ExtensionLibraryOverviewView,
  ExtensionLibraryTrashEntryView
} from "../model.js";
import type { Translator } from "./types.js";
import { Button, ErrorBanner, Modal, Pill, Spinner, cx } from "./ui.js";

interface LibraryData {
  readonly overview?: ExtensionLibraryOverviewView;
  readonly trash: readonly ExtensionLibraryTrashEntryView[];
  readonly grace: readonly ExtensionLibraryGraceEntryView[];
}

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "error"; readonly message: string }
  | { readonly phase: "ready"; readonly data: LibraryData };

type LocationIntent = "relocate" | "rebind";
type ConfirmIntent =
  | { readonly kind: "default" }
  | { readonly kind: "unbind" }
  | { readonly kind: "trash" }
  | { readonly kind: "purge"; readonly entry: ExtensionLibraryTrashEntryView }
  | { readonly kind: "rollback"; readonly entry: ExtensionLibraryGraceEntryView };

export function ExtensionLibrarySection({ controller, extension, locale, disabled, t }: {
  readonly controller: AppController;
  readonly extension: ExtensionCatalogEntryView;
  readonly locale: string;
  readonly disabled: boolean;
  readonly t: Translator;
}): JSX.Element | null {
  const ready = extensionLibraryReady(extension);
  const [loadRevision, setLoadRevision] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ phase: "loading" });
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [operationPhase, setOperationPhase] = useState<string>();
  const [locationIntent, setLocationIntent] = useState<LocationIntent>();
  const [candidate, setCandidate] = useState("");
  const [validation, setValidation] = useState<ExtensionLibraryLocationValidationView>();
  const [validationError, setValidationError] = useState<string>();
  const [validating, setValidating] = useState(false);
  const [confirmIntent, setConfirmIntent] = useState<ConfirmIntent>();
  const [confirmation, setConfirmation] = useState("");
  const [restoreEntry, setRestoreEntry] = useState<ExtensionLibraryTrashEntryView>();
  const [restoreDestination, setRestoreDestination] = useState<"original" | "default">("original");
  const loadRequest = useRef(0);
  const actionRequest = useRef(0);
  const validationRequest = useRef(0);
  const actionAbort = useRef<AbortController | undefined>(undefined);
  const validationAbort = useRef<AbortController | undefined>(undefined);
  const candidateInput = useRef<HTMLInputElement>(null);
  const confirmationInput = useRef<HTMLInputElement>(null);
  const restoreInput = useRef<HTMLInputElement>(null);
  const titleId = useId();

  useEffect(() => {
    const request = ++loadRequest.current;
    const abort = new AbortController();
    setLoadState({ phase: "loading" });
    setActionError(undefined);
    const overview = ready
      ? controller.getExtensionLibraryOverview(extension.id, extension.revision, abort.signal)
      : Promise.resolve(undefined);
    void Promise.all([
      overview,
      controller.listExtensionLibraryTrash(extension.id, abort.signal),
      controller.listExtensionLibraryGrace(extension.id, abort.signal)
    ]).then(([nextOverview, trash, grace]) => {
      if (abort.signal.aborted || request !== loadRequest.current) return;
      setLoadState({ phase: "ready", data: { overview: nextOverview, trash, grace } });
    }).catch((cause: unknown) => {
      if (abort.signal.aborted || request !== loadRequest.current) return;
      setLoadState({ phase: "error", message: libraryError(cause, t) });
    });
    return () => abort.abort();
  }, [controller, extension.id, extension.revision, loadRevision, ready, t]);

  useEffect(() => {
    actionRequest.current += 1;
    actionAbort.current?.abort();
    validationRequest.current += 1;
    validationAbort.current?.abort();
    setBusy(undefined);
    setLocationIntent(undefined);
    setConfirmIntent(undefined);
    setRestoreEntry(undefined);
    setRestoreDestination("original");
    setConfirmation("");
    return () => {
      actionRequest.current += 1;
      actionAbort.current?.abort();
      validationRequest.current += 1;
      validationAbort.current?.abort();
    };
  }, [controller, extension.id, extension.revision]);

  useEffect(() => {
    if (busy !== "relocate" || !ready) return undefined;
    const abort = new AbortController();
    let pending = false;
    const poll = (): void => {
      if (pending) return;
      pending = true;
      void controller.getExtensionLibraryOverview(extension.id, extension.revision, abort.signal).then((overview) => {
        if (!abort.signal.aborted && overview.operation?.phase !== undefined) setOperationPhase(overview.operation.phase);
      }).catch(() => undefined).finally(() => { pending = false; });
    };
    poll();
    const timer = window.setInterval(poll, 400);
    return () => { abort.abort(); window.clearInterval(timer); };
  }, [busy, controller, extension.id, extension.revision, ready]);

  const reload = useCallback(() => setLoadRevision((value) => value + 1), []);
  const perform = useCallback((key: string, action: (signal: AbortSignal) => Promise<unknown>): void => {
    if (disabled || busy !== undefined) return;
    const request = ++actionRequest.current;
    actionAbort.current?.abort();
    const abort = new AbortController();
    actionAbort.current = abort;
    setBusy(key);
    setActionError(undefined);
    if (key === "relocate") setOperationPhase("precheck");
    void action(abort.signal).then(() => {
      if (abort.signal.aborted || request !== actionRequest.current) return;
      setLocationIntent(undefined);
      setConfirmIntent(undefined);
      setRestoreEntry(undefined);
      setRestoreDestination("original");
      setConfirmation("");
      setValidation(undefined);
      setCandidate("");
      setLoadRevision((value) => value + 1);
    }).catch((cause: unknown) => {
      if (abort.signal.aborted || request !== actionRequest.current) return;
      setActionError(libraryError(cause, t));
    }).finally(() => {
      if (request !== actionRequest.current) return;
      if (actionAbort.current === abort) actionAbort.current = undefined;
      setBusy(undefined);
      setOperationPhase(undefined);
    });
  }, [busy, disabled, t]);

  const openLocation = (intent: LocationIntent): void => {
    if (!ready || disabled || busy !== undefined) return;
    setLocationIntent(intent);
    setCandidate("");
    setValidation(undefined);
    setValidationError(undefined);
  };
  const closeLocation = (): void => {
    validationRequest.current += 1;
    validationAbort.current?.abort();
    setLocationIntent(undefined);
    setValidation(undefined);
    setValidationError(undefined);
  };
  const updateCandidate = (value: string): void => {
    validationRequest.current += 1;
    validationAbort.current?.abort();
    setValidating(false);
    setCandidate(value);
    setValidation(undefined);
    setValidationError(undefined);
  };
  const pickCandidate = (): void => {
    if (window.jokoDesktop?.capabilities.includes("extension.libraryLocationPicker") !== true) {
      candidateInput.current?.focus();
      return;
    }
    const request = ++validationRequest.current;
    const expectedIntent = locationIntent;
    void window.jokoDesktop.extensionLibraries.pickLocation().then((selection) => {
      if (request === validationRequest.current && expectedIntent !== undefined && locationIntent === expectedIntent && !selection.cancelled) {
        updateCandidate(selection.path);
      }
    }).catch((cause: unknown) => {
      if (request === validationRequest.current && locationIntent === expectedIntent) setValidationError(libraryError(cause, t));
    });
  };
  const validateCandidate = (): void => {
    const value = candidate.trim();
    if (!ready || value.length === 0 || validating) return;
    const request = ++validationRequest.current;
    validationAbort.current?.abort();
    const abort = new AbortController();
    validationAbort.current = abort;
    setValidating(true);
    setValidation(undefined);
    setValidationError(undefined);
    void controller.validateExtensionLibraryLocation(extension.id, extension.revision, value, abort.signal).then((result) => {
      if (!abort.signal.aborted && request === validationRequest.current) setValidation(result);
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted && request === validationRequest.current) setValidationError(libraryError(cause, t));
    }).finally(() => {
      if (request === validationRequest.current) setValidating(false);
    });
  };

  if (extension.library === undefined) return null;
  const data = loadState.phase === "ready" ? loadState.data : undefined;
  const overview = data?.overview;
  const unavailable = overview?.state === "unavailable";
  const canRebind = unavailable && (overview.unavailableReason === "diskMissing" || overview.unavailableReason === "bindingMoved");
  const destructiveMatch = confirmIntent?.kind === "trash" || confirmIntent?.kind === "purge"
    ? confirmation === (confirmIntent.kind === "purge" ? confirmIntent.entry.name : extension.name)
    : true;

  return <section className="extension-library" aria-labelledby={titleId}>
    <header className="extension-library__header">
      <span className="extension-library__icon"><Database aria-hidden="true" /></span>
      <div><h3 id={titleId}>{t("extensions.library.title")}</h3><p>{t("extensions.library.body")}</p></div>
      {overview !== undefined && <Pill tone={libraryTone(overview)}>{libraryStateLabel(overview, t)}</Pill>}
    </header>

    {loadState.phase === "loading" && <div className="extension-library__loading" role="status"><Spinner /><span>{t("extensions.library.loading")}</span></div>}
    {loadState.phase === "error" && <ErrorBanner message={loadState.message} onRetry={reload} retryLabel={t("common.retry")} />}
    {actionError !== undefined && <ErrorBanner message={actionError} onRetry={reload} onClose={() => setActionError(undefined)} retryLabel={t("common.retry")} dismissLabel={t("common.dismiss")} />}

    {data !== undefined && <>
      {!ready && <div className="extension-library__notice"><AlertTriangle aria-hidden="true" /><div><strong>{t("extensions.library.notReady")}</strong><p>{t("extensions.library.notReadyBody")}</p></div></div>}
      {overview?.orphaned === true && <div className="extension-library__notice extension-library__notice--warning" role="status"><ArchiveRestore aria-hidden="true" /><div><strong>{t("extensions.library.orphaned")}</strong><p>{t("extensions.library.orphanedBody")}</p></div></div>}
      {overview?.softLimitExceeded === true && <div className="extension-library__notice extension-library__notice--warning" role="status"><HardDrive aria-hidden="true" /><div><strong>{t("extensions.library.softLimit")}</strong><p>{t("extensions.library.softLimitBody", { limit: formatBytes(overview.softLimitBytes) })}</p></div></div>}
      {overview?.operation !== undefined || busy === "relocate" ? <LibraryMigrationStatus phase={overview?.operation?.phase ?? operationPhase ?? "precheck"} t={t} /> : null}

      {overview !== undefined && <div className="extension-library__summary">
        <div><span>{t("extensions.library.location")}</span><strong>{overview.location === undefined ? t("extensions.library.unbound") : overview.location.kind === "default" ? t("extensions.library.default") : t("extensions.library.custom")}</strong><small title={overview.location?.path}>{overview.location?.path ?? t("extensions.library.unboundBody")}</small></div>
        <div><span>{t("extensions.library.usage")}</span><strong>{formatBytes(overview.bytes)}</strong><small>{t("extensions.library.files", { count: overview.files })}</small></div>
        <div><span>{t("extensions.library.free")}</span><strong>{overview.diskFreeBytes === undefined ? t("common.unknown") : formatBytes(overview.diskFreeBytes)}</strong><small>{t("extensions.library.reserve")}</small></div>
      </div>}

      {unavailable && <div className="extension-library__unavailable" role="alert"><AlertTriangle aria-hidden="true" /><div><strong>{t("extensions.library.unavailable")}</strong><p>{unavailableReason(overview.unavailableReason, t)}</p></div><div>
        {canRebind && <Button disabled={disabled || busy !== undefined} onClick={() => openLocation("rebind")}><FolderOpen aria-hidden="true" />{t("extensions.library.rebind")}</Button>}
        {overview.unavailableReason === "metadataCorrupt" && <Button disabled={disabled || busy !== undefined} onClick={() => perform("repair", (signal) => controller.repairExtensionLibraryMetadata(extension.id, extension.revision, signal))}><RefreshCcw aria-hidden="true" />{t("extensions.library.repairMetadata")}</Button>}
        {overview.unavailableReason === "stateCorrupt" && <Button disabled={disabled || busy !== undefined} onClick={() => perform("repair", (signal) => controller.repairExtensionLibraryState(signal))}><RefreshCcw aria-hidden="true" />{t("extensions.library.repairState")}</Button>}
        {overview.location !== undefined && <Button tone="ghost" disabled={disabled || busy !== undefined} onClick={() => { setConfirmation(""); setConfirmIntent({ kind: "unbind" }); }}><Unlink aria-hidden="true" />{t("extensions.library.unbind")}</Button>}
      </div></div>}

      {ready && !unavailable && <div className="extension-library__actions">
        {overview?.location === undefined && <Button tone="primary" disabled={disabled || busy !== undefined} onClick={() => setConfirmIntent({ kind: "default" })}><HardDrive aria-hidden="true" />{t("extensions.library.useDefault")}</Button>}
        <Button disabled={disabled || busy !== undefined} onClick={() => openLocation("relocate")}><FolderCog aria-hidden="true" />{overview?.location === undefined ? t("extensions.library.chooseLocation") : t("extensions.library.move")}</Button>
        {overview?.location?.kind === "custom" && <Button tone="ghost" disabled={disabled || busy !== undefined} onClick={() => setConfirmIntent({ kind: "default" })}><RotateCcw aria-hidden="true" />{t("extensions.library.moveDefault")}</Button>}
        {overview?.location !== undefined && <Button tone="danger" disabled={disabled || busy !== undefined} onClick={() => { setConfirmation(""); setConfirmIntent({ kind: "trash" }); }}><Trash2 aria-hidden="true" />{t("extensions.library.delete")}</Button>}
      </div>}

      <LibraryRecoveryList
        title={t("extensions.library.trash")}
        empty={t("extensions.library.trashEmpty")}
        entries={data.trash}
        locale={locale}
        expiryLabel={t("extensions.library.deleteAfter")}
        renderActions={(entry) => <><Button disabled={disabled || busy !== undefined} onClick={() => { setConfirmation(""); setRestoreDestination("original"); setRestoreEntry(entry); }}><ArchiveRestore aria-hidden="true" />{t("extensions.library.restore")}</Button><Button tone="ghost" className="danger-text" disabled={disabled || busy !== undefined} onClick={() => { setConfirmation(""); setConfirmIntent({ kind: "purge", entry }); }}><Trash2 aria-hidden="true" />{t("extensions.library.purge")}</Button></>}
      />
      <LibraryRecoveryList
        title={t("extensions.library.grace")}
        empty={t("extensions.library.graceEmpty")}
        entries={data.grace}
        locale={locale}
        expiryLabel={t("extensions.library.expires")}
        renderActions={(entry) => <Button disabled={!ready || disabled || busy !== undefined} onClick={() => setConfirmIntent({ kind: "rollback", entry })}><RotateCcw aria-hidden="true" />{t("extensions.library.rollback")}</Button>}
      />
    </>}

    <Modal
      open={locationIntent !== undefined}
      title={locationIntent === "rebind" ? t("extensions.library.rebindTitle") : t("extensions.library.moveTitle")}
      description={locationIntent === "rebind" ? t("extensions.library.rebindBody") : t("extensions.library.moveBody")}
      size="medium"
      onClose={closeLocation}
      initialFocus={() => candidateInput.current}
    >
      <div className="extension-library-dialog">
        <label><span>{t("extensions.library.parentFolder")}</span><div><input ref={candidateInput} value={candidate} onChange={(event) => updateCandidate(event.target.value)} placeholder={t("extensions.library.pathPlaceholder")} disabled={validating || busy !== undefined} /><Button disabled={validating || busy !== undefined} onClick={pickCandidate}><FolderOpen aria-hidden="true" />{window.jokoDesktop?.capabilities.includes("extension.libraryLocationPicker") === true ? t("extensions.library.browse") : t("extensions.library.enterPath")}</Button></div></label>
        <p className="muted">{t("extensions.library.parentHint", { name: extension.id })}</p>
        {validationError !== undefined && <p className="extension-library-dialog__error" role="alert"><AlertTriangle aria-hidden="true" />{validationError}</p>}
        {validation !== undefined && <div className="extension-library-validation" role="status"><HardDrive aria-hidden="true" /><div><strong>{t("extensions.library.locationReady")}</strong><p title={validation.libraryRoot}>{validation.libraryRoot}</p><small>{t("extensions.library.freeValue", { value: validation.diskFreeBytes === undefined ? t("common.unknown") : formatBytes(validation.diskFreeBytes) })}</small></div></div>}
        {validation?.warnings.includes("cloud_sync_location") === true && <div className="extension-library-cloud-warning" role="alert"><Cloud aria-hidden="true" /><div><strong>{t("extensions.library.cloudWarning")}</strong><p>{t("extensions.library.cloudWarningBody")}</p></div></div>}
        <div className="modal__actions"><Button onClick={closeLocation}>{t("common.cancel")}</Button><Button disabled={candidate.trim().length === 0 || validating || busy !== undefined} onClick={validateCandidate}>{validating ? t("extensions.library.validating") : t("extensions.library.validate")}</Button><Button tone="primary" disabled={validation === undefined || validating || busy !== undefined} onClick={() => {
          if (validation === undefined || locationIntent === undefined) return;
          const value = candidate.trim();
          if (locationIntent === "rebind") perform("rebind", (signal) => controller.rebindExtensionLibrary(extension.id, extension.revision, value, signal));
          else perform("relocate", (signal) => controller.relocateExtensionLibrary(extension.id, extension.revision, { kind: "custom", candidate: value }, signal));
        }}>{locationIntent === "rebind" ? t("extensions.library.rebind") : t("extensions.library.confirmMove")}</Button></div>
      </div>
    </Modal>

    <Modal
      open={confirmIntent !== undefined}
      title={confirmTitle(confirmIntent, t)}
      description={confirmDescription(confirmIntent, extension, overview, t)}
      size="small"
      dialogRole={confirmIntent?.kind === "trash" || confirmIntent?.kind === "purge" ? "alertdialog" : "dialog"}
      onClose={() => { setConfirmIntent(undefined); setConfirmation(""); }}
      initialFocus={() => confirmIntent?.kind === "trash" || confirmIntent?.kind === "purge" ? confirmationInput.current : null}
    >
      <div className="extension-library-dialog">
        {(confirmIntent?.kind === "trash" || confirmIntent?.kind === "purge") && <label><span>{t("extensions.library.typeName", { name: confirmIntent.kind === "purge" ? confirmIntent.entry.name : extension.name })}</span><input ref={confirmationInput} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label>}
        <div className="modal__actions"><Button onClick={() => { setConfirmIntent(undefined); setConfirmation(""); }}>{t("common.cancel")}</Button><Button tone={confirmIntent?.kind === "trash" || confirmIntent?.kind === "purge" ? "danger" : "primary"} disabled={!destructiveMatch || busy !== undefined} onClick={() => {
          const intent = confirmIntent;
          if (intent === undefined) return;
          if (intent.kind === "default") perform("relocate", (signal) => controller.relocateExtensionLibrary(extension.id, extension.revision, { kind: "default" }, signal));
          else if (intent.kind === "unbind") perform("unbind", (signal) => controller.unbindExtensionLibrary(extension.id, extension.revision, signal));
          else if (intent.kind === "trash") perform("trash", (signal) => controller.trashExtensionLibrary(extension.id, extension.revision, confirmation, signal));
          else if (intent.kind === "purge") perform("purge", (signal) => controller.purgeExtensionLibraryTrash(intent.entry.id, confirmation, signal));
          else perform("rollback", (signal) => controller.rollbackExtensionLibrary(extension.id, extension.revision, intent.entry.id, signal));
        }}>{confirmAction(confirmIntent, t)}</Button></div>
      </div>
    </Modal>

    <Modal
      open={restoreEntry !== undefined}
      title={t("extensions.library.restoreTitle")}
      description={restoreEntry === undefined ? undefined : t("extensions.library.restoreBody", { name: restoreEntry.name })}
      size="small"
      onClose={() => { setRestoreEntry(undefined); setRestoreDestination("original"); setConfirmation(""); }}
      initialFocus={() => restoreInput.current}
    >
      <div className="extension-library-dialog">
        <label><span>{t("extensions.library.typeName", { name: restoreEntry?.name ?? "" })}</span><input ref={restoreInput} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label>
        <p className="muted">{t("extensions.library.restoreLocationBody")}</p>
        <fieldset className="extension-library-restore-destination">
          <legend>{t("extensions.library.restoreDestination")}</legend>
          <label><input type="radio" name={`${titleId}-restore-destination`} checked={restoreDestination === "original"} onChange={() => setRestoreDestination("original")} />{t("extensions.library.restoreOriginal")}</label>
          <label><input type="radio" name={`${titleId}-restore-destination`} checked={restoreDestination === "default"} onChange={() => setRestoreDestination("default")} />{t("extensions.library.restoreDefault")}</label>
        </fieldset>
        <div className="modal__actions"><Button onClick={() => { setRestoreEntry(undefined); setRestoreDestination("original"); setConfirmation(""); }}>{t("common.cancel")}</Button><Button tone="primary" disabled={restoreEntry === undefined || confirmation !== restoreEntry.name || busy !== undefined} onClick={() => {
          const entry = restoreEntry;
          if (entry !== undefined) perform("restore", (signal) => controller.restoreExtensionLibraryTrash(
            entry.id,
            confirmation,
            restoreDestination === "default" ? { kind: "default" } : undefined,
            signal
          ));
        }}>{t("extensions.library.restore")}</Button></div>
      </div>
    </Modal>
  </section>;
}

function LibraryMigrationStatus({ phase, t }: { readonly phase: string; readonly t: Translator }): JSX.Element {
  const stages = ["precheck", "copying", "verifying", "switching"] as const;
  const current = Math.max(0, stages.indexOf(phase as (typeof stages)[number]));
  return <div className="extension-library-migration" role="status" aria-live="polite"><Spinner /><div><strong>{t("extensions.library.migrating")}</strong><ol>{stages.map((stage, index) => <li className={cx(index < current && "is-complete", index === current && "is-active")} key={stage}>{t(`extensions.library.phase.${stage}`)}</li>)}</ol></div></div>;
}

function LibraryRecoveryList<T extends ExtensionLibraryTrashEntryView | ExtensionLibraryGraceEntryView>({ title, empty, entries, locale, expiryLabel, renderActions }: {
  readonly title: string;
  readonly empty: string;
  readonly entries: readonly T[];
  readonly locale: string;
  readonly expiryLabel: string;
  readonly renderActions: (entry: T) => JSX.Element;
}): JSX.Element {
  return <section className="extension-library__recovery"><h4>{title}</h4>{entries.length === 0 ? <p className="muted">{empty}</p> : <div>{entries.map((entry) => <article key={entry.id}><span><strong>{entry.name}</strong><small>{formatBytes(entry.bytes)} · {entry.files} · {expiryLabel} {new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(entry.expiresAt)}</small></span><div>{renderActions(entry)}</div></article>)}</div>}</section>;
}

export function extensionLibraryReady(extension: ExtensionCatalogEntryView): boolean {
  return extension.library !== undefined && extension.owner.kind === "resource" && extension.installed && extension.enabled
    && (extension.setup.state === "ready" || extension.setup.state === "notRequired")
    && (extension.installState === "installed" || extension.installState === "updateAvailable");
}

function libraryTone(overview: ExtensionLibraryOverviewView): "success" | "warning" | "danger" | "neutral" {
  if (overview.state === "unavailable") return "danger";
  if (overview.state === "readOnly" || overview.softLimitExceeded || overview.orphaned) return "warning";
  return "success";
}

function libraryStateLabel(overview: ExtensionLibraryOverviewView, t: Translator): string {
  if (overview.state === "unavailable") return t("extensions.library.state.unavailable");
  if (overview.state === "readOnly") return t("extensions.library.state.readOnly");
  if (overview.orphaned) return t("extensions.library.state.orphaned");
  return t("extensions.library.state.ready");
}

function unavailableReason(reason: ExtensionLibraryOverviewView["unavailableReason"], t: Translator): string {
  switch (reason) {
    case "metadataCorrupt": return t("extensions.library.reason.metadataCorrupt");
    case "fileLimit": return t("extensions.library.reason.fileLimit");
    case "operationInProgress": return t("extensions.library.reason.operationInProgress");
    case "diskMissing": return t("extensions.library.reason.diskMissing");
    case "bindingMoved": return t("extensions.library.reason.bindingMoved");
    case "stateCorrupt": return t("extensions.library.reason.stateCorrupt");
    case "io": return t("extensions.library.reason.io");
    default: return t("extensions.library.reason.unknown");
  }
}

function confirmTitle(intent: ConfirmIntent | undefined, t: Translator): string {
  if (intent?.kind === "default") return t("extensions.library.moveDefaultTitle");
  if (intent?.kind === "unbind") return t("extensions.library.unbindTitle");
  if (intent?.kind === "trash") return t("extensions.library.deleteTitle");
  if (intent?.kind === "purge") return t("extensions.library.purgeTitle");
  return t("extensions.library.rollbackTitle");
}

function confirmDescription(intent: ConfirmIntent | undefined, extension: ExtensionCatalogEntryView, overview: ExtensionLibraryOverviewView | undefined, t: Translator): string {
  if (intent?.kind === "default") return t("extensions.library.moveDefaultBody");
  if (intent?.kind === "unbind") return t("extensions.library.unbindBody", { path: overview?.location?.path ?? t("common.unknown") });
  if (intent?.kind === "trash") return t("extensions.library.deleteBody", { name: extension.name, path: overview?.location?.path ?? t("common.unknown"), files: overview?.files ?? 0, bytes: formatBytes(overview?.bytes ?? 0n) });
  if (intent?.kind === "purge") return t("extensions.library.purgeBody", { name: intent.entry.name });
  return t("extensions.library.rollbackBody");
}

function confirmAction(intent: ConfirmIntent | undefined, t: Translator): string {
  if (intent?.kind === "default") return t("extensions.library.confirmMove");
  if (intent?.kind === "unbind") return t("extensions.library.unbind");
  if (intent?.kind === "trash") return t("extensions.library.delete");
  if (intent?.kind === "purge") return t("extensions.library.purge");
  return t("extensions.library.rollback");
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

function libraryError(cause: unknown, t: Translator): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : t("extensions.library.error");
}
