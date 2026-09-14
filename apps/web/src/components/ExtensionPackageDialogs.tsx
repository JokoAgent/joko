import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { AlertTriangle, CheckCircle2, PackageCheck, RefreshCcw, ShieldAlert, Trash2 } from "lucide-react";

import type { AppController } from "../controller.js";
import type {
  BackendView,
  ExtensionCatalogEntryView,
  ExtensionPackageExportJobView,
  ExtensionPackageExportPreviewView,
  ExtensionPackagePreviewView,
  ResourceCompatibilityView,
  ResourcePackageWarningView,
  ResourceView
} from "../model.js";
import { resourceKindsForBackend } from "../resource-capabilities.js";
import { ArtifactDownloadButton } from "./ArtifactDownloadButton.js";
import type { RunAction, Translator } from "./types.js";
import { Button, CheckboxControl, formatBytes, Modal, Pill, SelectControl } from "./ui.js";

export interface ExtensionPackageIntent {
  readonly extension: ExtensionCatalogEntryView;
  readonly backendId: string;
}

export function ExtensionPackageDialog({
  controller,
  backends,
  resources,
  intent,
  t,
  runAction,
  onClose,
  onChanged
}: {
  readonly controller: AppController;
  readonly backends: readonly BackendView[];
  readonly resources: readonly ResourceView[];
  readonly intent?: ExtensionPackageIntent;
  readonly t: Translator;
  readonly runAction: RunAction;
  readonly onClose: () => void;
  readonly onChanged: (extensionId: string) => Promise<void>;
}): JSX.Element {
  const [backendId, setBackendId] = useState("");
  const [preview, setPreview] = useState<ExtensionPackagePreviewView>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [replacementConfirmed, setReplacementConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"success" | "failed">();
  const requestGeneration = useRef(0);
  const mutationGeneration = useRef(0);
  const ownerResourceId = intent?.extension.owner.kind === "resource" ? intent.extension.owner.resourceId : undefined;
  const selectedFixedBackendId = ownerResourceId === undefined
    ? undefined
    : resources.find((resource) => resource.id === ownerResourceId)?.backendId;

  useEffect(() => {
    requestGeneration.current += 1;
    mutationGeneration.current += 1;
    setBackendId(selectedFixedBackendId ?? intent?.backendId ?? "");
    setPreview(undefined);
    setError(undefined);
    setReplacementConfirmed(false);
    setBusy(false);
    setResult(undefined);
  }, [intent, selectedFixedBackendId]);

  useEffect(() => {
    if (intent === undefined || backendId === "") return;
    const abort = new AbortController();
    const generation = ++requestGeneration.current;
    setLoading(true);
    setPreview(undefined);
    setError(undefined);
    setReplacementConfirmed(false);
    void controller.getExtensionPackagePreview(
      intent.extension.id,
      intent.extension.revision,
      backendId,
      abort.signal
    ).then((next) => {
      if (!abort.signal.aborted && generation === requestGeneration.current) setPreview(next);
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted && generation === requestGeneration.current) setError(packageError(cause, t));
    }).finally(() => {
      if (!abort.signal.aborted && generation === requestGeneration.current) setLoading(false);
    });
    return () => abort.abort();
  }, [backendId, controller, intent, t]);

  const close = (): void => {
    if (busy) return;
    requestGeneration.current += 1;
    mutationGeneration.current += 1;
    onClose();
  };
  const confirm = (): void => {
    if (preview === undefined || busy || result === "success" || (preview.sourceReplacement && !replacementConfirmed)) return;
    const generation = ++mutationGeneration.current;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    runAction(`extension-package:${preview.resourceId}`, async () => {
      try {
        await controller.adoptExtensionPackage(preview, replacementConfirmed);
      } catch (cause) {
        if (generation === mutationGeneration.current) {
          setError(packageError(cause, t));
          setResult("failed");
          setBusy(false);
        }
        throw cause;
      }
      if (generation === mutationGeneration.current) setResult("success");
      await onChanged(preview.extensionId).catch(() => undefined);
      if (generation === mutationGeneration.current) setBusy(false);
    });
  };
  const capableBackends = backends.filter((backend) => resourceKindsForBackend(backend).includes("package"));

  return <Modal
    open={intent !== undefined}
    title={t("extensions.package.previewTitle", { name: intent?.extension.name ?? t("extensions.title") })}
    description={t("extensions.package.previewBody")}
    size="large"
    onClose={close}
  >
    <div className="extension-package-dialog">
      <label className="field"><span>{t("extensions.package.backend")}</span><SelectControl
        value={backendId}
        disabled={busy || selectedFixedBackendId !== undefined || result === "success"}
        onChange={(event) => setBackendId(event.target.value)}
      >
        {capableBackends.length === 0 && <option value="">{t("extensions.package.noBackend")}</option>}
        {capableBackends.map((backend) => <option value={backend.id} key={backend.id}>{backend.name}</option>)}
      </SelectControl></label>
      {loading && <p className="extension-package-dialog__status" role="status"><RefreshCcw aria-hidden="true" />{t("extensions.package.loading")}</p>}
      {error !== undefined && <p className="extension-detail__error" role="alert"><AlertTriangle aria-hidden="true" />{error}</p>}
      {preview !== undefined && <ExtensionPackagePreview preview={preview} t={t} />}
      {preview?.sourceReplacement && <label className="extension-package-replacement">
        <CheckboxControl checked={replacementConfirmed} disabled={busy || result === "success"} onChange={(event) => setReplacementConfirmed(event.target.checked)} />
        <span><strong>{t("extensions.package.replacementTitle")}</strong><small>{t("extensions.package.replacementBody", {
          name: preview.currentResource?.name ?? preview.packageName,
          source: preview.currentResource?.sourceDisplay ?? t("common.unknown")
        })}</small><em>{t("extensions.package.replacementConfirm")}</em></span>
      </label>}
      {result === "success" && <p className="extension-package-result is-success" role="status"><CheckCircle2 aria-hidden="true" />{t("extensions.package.success")}</p>}
      {result === "failed" && <p className="extension-package-result is-failed" role="status"><AlertTriangle aria-hidden="true" />{t("extensions.package.failed")}</p>}
    </div>
    <div className="modal__actions">
      <Button disabled={busy} onClick={close}>{result === "success" ? t("common.close") : t("common.cancel")}</Button>
      {result !== "success" && <Button tone={preview?.action === "replace" ? "danger" : "primary"} disabled={
        preview === undefined || busy || (preview.sourceReplacement && !replacementConfirmed)
      } onClick={confirm}>{busy ? t("extensions.install.installing") : packageActionLabel(preview?.action, t)}</Button>}
    </div>
  </Modal>;
}

function ExtensionPackagePreview({ preview, t }: { readonly preview: ExtensionPackagePreviewView; readonly t: Translator }): JSX.Element {
  return <div className="extension-package-preview">
    <dl className="extension-package-preview__identity">
      <div><dt>{t("extensions.package.packageName")}</dt><dd><code>{preview.packageName}</code></dd></div>
      <div><dt>{t("extensions.package.currentVersion")}</dt><dd>{preview.installedVersion ?? "—"}</dd></div>
      <div><dt>{t("extensions.package.availableVersion")}</dt><dd>{preview.availableVersion ?? "—"}</dd></div>
    </dl>
    <p className="extension-package-preview__mode"><PackageCheck aria-hidden="true" />{preview.preservesEnabled ? t("extensions.package.preserveEnabled") : t("extensions.package.installsDisabled")}</p>
    {preview.warnings.map((warning) => <p className="extension-package-warning" key={warning}><AlertTriangle aria-hidden="true" /><span><strong>{packageWarningLabel(warning, t)}</strong>{warning === "lifecycleScriptsDisabled" && preview.disabledLifecycleScripts.length > 0 && <small>{t("extensions.package.lifecycleList", { scripts: preview.disabledLifecycleScripts.join(", ") })}</small>}</span></p>)}
    <section className="extension-package-preview__section"><h3>{t("extensions.package.compatibility")}</h3>
      {preview.compatibilityDetails.length === 0
        ? <p className="muted">{t("extensions.package.noCompatibility")}</p>
        : <div className="extension-package-content">{preview.compatibilityDetails.map((detail, index) => <div key={`${detail.kind}:${detail.name}:${index}`}><span><strong>{detail.name}</strong><small>{resourceKindLabel(detail.kind, t)}</small></span><Pill tone={compatibilityTone(detail.compatibility)}>{compatibilityLabel(detail.compatibility, t)}</Pill></div>)}</div>}
    </section>
    {preview.runtimeRequirements.length > 0 && <section className="extension-package-preview__section"><h3>{t("extensions.package.runtime")}</h3><div className="extension-package-content">{preview.runtimeRequirements.map((requirement) => <div key={`${requirement.packageName}:${requirement.range}`}><span><code>{requirement.packageName}</code><small>{requirement.range}{requirement.currentVersion === undefined ? "" : ` · ${t("resource.currentRuntime", { version: requirement.currentVersion })}`}</small></span><Pill tone={requirement.status === "compatible" ? "success" : requirement.status === "incompatible" ? "danger" : "warning"}>{runtimeRequirementLabel(requirement.status, t)}</Pill></div>)}</div></section>}
    {preview.disabledLifecycleScripts.length > 0 && !preview.warnings.includes("lifecycleScriptsDisabled") && <p className="extension-package-warning"><ShieldAlert aria-hidden="true" /><span><strong>{t("extensions.package.lifecycleDisabled")}</strong><small>{t("extensions.package.lifecycleList", { scripts: preview.disabledLifecycleScripts.join(", ") })}</small></span></p>}
  </div>;
}

export function ExtensionPackageRemovalDialog({ controller, extension, t, runAction, onClose, onChanged }: {
  readonly controller: AppController;
  readonly extension?: ExtensionCatalogEntryView;
  readonly t: Translator;
  readonly runAction: RunAction;
  readonly onClose: () => void;
  readonly onChanged: () => Promise<void>;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"success" | "failed">();
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setBusy(false);
    setResult(undefined);
    setError(undefined);
  }, [extension]);
  const close = (): void => {
    if (busy) return;
    generation.current += 1;
    onClose();
  };
  const remove = (): void => {
    if (extension === undefined || extension.owner.kind !== "resource" || busy) return;
    const current = ++generation.current;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    runAction(`extension-package-remove:${extension.owner.resourceId}`, async () => {
      try {
        await controller.removeExtensionPackage(extension.id, extension.revision);
      } catch (cause) {
        if (current === generation.current) {
          setResult("failed");
          setError(packageError(cause, t));
          setBusy(false);
        }
        throw cause;
      }
      if (current === generation.current) setResult("success");
      await onChanged().catch(() => undefined);
      if (current === generation.current) setBusy(false);
    });
  };
  return <Modal open={extension !== undefined} title={t("extensions.package.uninstallTitle", { name: extension?.name ?? t("extensions.title") })} description={t("extensions.package.uninstallBody")} size="small" onClose={close}>
    {error !== undefined && <p className="extension-detail__error" role="alert"><AlertTriangle aria-hidden="true" />{error}</p>}
    {result === "success" && <p className="extension-package-result is-success" role="status"><CheckCircle2 aria-hidden="true" />{t("extensions.package.uninstallSuccess")}</p>}
    {result === "failed" && <p className="extension-package-result is-failed" role="status"><AlertTriangle aria-hidden="true" />{t("extensions.package.failed")}</p>}
    <div className="modal__actions"><Button disabled={busy} onClick={close}>{result === "success" ? t("common.close") : t("common.cancel")}</Button>{result !== "success" && <Button tone="danger" disabled={busy} onClick={remove}><Trash2 aria-hidden="true" />{t("extensions.package.uninstall")}</Button>}</div>
  </Modal>;
}

const ACTIVE_EXPORT_STATES = new Set<ExtensionPackageExportJobView["state"]>([
  "pending", "snapshotting", "packaging", "verifying"
]);

export function ExtensionPackageExportDialog({ controller, extension, t, runAction, onClose }: {
  readonly controller: AppController;
  readonly extension?: ExtensionCatalogEntryView;
  readonly t: Translator;
  readonly runAction: RunAction;
  readonly onClose: () => void;
}): JSX.Element {
  const [preview, setPreview] = useState<ExtensionPackageExportPreviewView>();
  const [job, setJob] = useState<ExtensionPackageExportJobView>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [recovered, setRecovered] = useState(false);
  const [reloadRevision, setReloadRevision] = useState(0);
  const generation = useRef(0);
  const selectedExtensionId = extension?.id;

  useEffect(() => {
    const request = ++generation.current;
    setPreview(undefined);
    setJob(undefined);
    setError(undefined);
    setRecovered(false);
    setBusy(false);
    if (extension === undefined || extension.owner.kind !== "resource") {
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    void Promise.all([
      controller.getExtensionPackageExportPreview(extension.id, extension.revision, abort.signal),
      controller.listExtensionPackageExports(extension.id, abort.signal)
    ]).then(([nextPreview, catalog]) => {
      if (abort.signal.aborted || request !== generation.current) return;
      setPreview(nextPreview);
      setJob(nextPreview.activeExport ?? catalog.exports[0]);
      setRecovered(nextPreview.recoveredFromCorruption || catalog.recoveredFromCorruption);
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted && request === generation.current) setError(packageError(cause, t));
    }).finally(() => {
      if (!abort.signal.aborted && request === generation.current) setLoading(false);
    });
    return () => abort.abort();
  }, [controller, extension, reloadRevision, t]);

  useEffect(() => {
    if (job === undefined || !ACTIVE_EXPORT_STATES.has(job.state) || selectedExtensionId === undefined) return;
    const abort = new AbortController();
    const request = generation.current;
    const timer = window.setTimeout(() => {
      void controller.getExtensionPackageExport(job.id, abort.signal).then((next) => {
        if (
          abort.signal.aborted
          || request !== generation.current
          || next.id !== job.id
          || next.authority.extensionId !== selectedExtensionId
        ) return;
        setJob(next);
        setError(undefined);
      }).catch((cause: unknown) => {
        if (!abort.signal.aborted && request === generation.current) setError(packageError(cause, t));
      });
    }, 350);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [controller, job, selectedExtensionId, t]);

  const close = (): void => {
    if (busy) return;
    generation.current += 1;
    onClose();
  };
  const start = (): void => {
    if (preview === undefined || busy || active) return;
    const request = generation.current;
    setBusy(true);
    setError(undefined);
    runAction(`extension-package-export:${preview.extensionId}`, async () => {
      try {
        const next = await controller.startExtensionPackageExport(preview);
        if (request === generation.current && next.authority.extensionId === preview.extensionId) setJob(next);
      } catch (cause) {
        if (request === generation.current) setError(packageError(cause, t));
        throw cause;
      } finally {
        if (request === generation.current) setBusy(false);
      }
    });
  };
  const cancel = (): void => {
    if (job === undefined || !ACTIVE_EXPORT_STATES.has(job.state) || busy) return;
    const request = generation.current;
    setBusy(true);
    setError(undefined);
    runAction(`extension-package-export-cancel:${job.id}`, async () => {
      try {
        const next = await controller.cancelExtensionPackageExport(job.id, job.revision);
        if (request === generation.current && next.id === job.id) setJob(next);
      } catch (cause) {
        if (request === generation.current) setError(packageError(cause, t));
        throw cause;
      } finally {
        if (request === generation.current) setBusy(false);
      }
    });
  };
  const refresh = (): void => {
    if (busy || loading) return;
    setError(undefined);
    setReloadRevision((value) => value + 1);
  };
  const active = job !== undefined && ACTIVE_EXPORT_STATES.has(job.state);
  const artifact = job?.state === "ready" ? job.artifact : undefined;

  return <Modal
    open={extension !== undefined}
    title={t("extensions.export.title", { name: extension?.name ?? t("extensions.title") })}
    description={t("extensions.export.body")}
    size="medium"
    onClose={close}
  >
    <div className="extension-package-export" aria-busy={loading || busy}>
      {loading && <p className="extension-package-dialog__status" role="status"><RefreshCcw aria-hidden="true" />{t("extensions.export.loading")}</p>}
      {error !== undefined && <p className="extension-detail__error" role="alert"><AlertTriangle aria-hidden="true" />{error}</p>}
      {recovered && <p className="extension-package-warning" role="status"><AlertTriangle aria-hidden="true" /><span>{t("extensions.export.recovered")}</span></p>}
      {preview !== undefined && <>
        <p className="extension-package-export__local"><ShieldAlert aria-hidden="true" /><span><strong>{t("extensions.export.localOnly")}</strong><small>{t("extensions.export.localOnlyBody")}</small></span></p>
        <dl className="extension-package-export__authority">
          <div><dt>{t("extensions.package.packageName")}</dt><dd><code>{preview.packageName}</code></dd></div>
          <div><dt>{t("extensions.version")}</dt><dd>{preview.packageVersion ?? t("common.unknown")}</dd></div>
          <div><dt>{t("extensions.export.backend")}</dt><dd><code>{preview.backendId}</code><small>{t("extensions.export.backendRevision", { revision: preview.backendRevision.toString(10), generation: preview.backendGeneration })}</small></dd></div>
          <div><dt>{t("extensions.export.resource")}</dt><dd><code>{preview.resourceId}</code><small>{t("extensions.export.resourceRevision", { revision: preview.resourceRevision.toString(10) })}</small></dd></div>
        </dl>
        <p className="extension-package-export__limits">{t("extensions.export.limits", {
          entries: preview.maximumEntries,
          bytes: formatBytes(preview.maximumUncompressedBytes)
        })}</p>
      </>}
      {job !== undefined && <section className={`extension-package-export__job is-${job.state}`}>
        <header><span><strong>{job.fileName}</strong><small>{t("extensions.export.progress", { files: job.files, bytes: formatBytes(job.uncompressedBytes) })}</small></span><Pill tone={exportStateTone(job.state)}>{t(`extensions.export.state.${job.state}`)}</Pill></header>
        {active && <p role="status"><RefreshCcw aria-hidden="true" />{t("extensions.export.activeBody")}</p>}
        {job.state === "ready" && <p className="extension-package-result is-success" role="status"><CheckCircle2 aria-hidden="true" />{t("extensions.export.readyBody")}</p>}
        {job.state === "failed" && <p className="extension-package-result is-failed" role="alert"><AlertTriangle aria-hidden="true" />{job.error ?? t("extensions.export.failedBody")}</p>}
        {job.state === "cancelled" && <p className="muted">{t("extensions.export.cancelledBody")}</p>}
      </section>}
    </div>
    <div className="modal__actions">
      <Button disabled={busy} onClick={close}>{t("common.close")}</Button>
      {error !== undefined && <Button disabled={busy || loading} onClick={refresh}><RefreshCcw aria-hidden="true" />{t("common.retry")}</Button>}
      {active && <Button tone="danger" disabled={busy} onClick={cancel}>{t("extensions.export.cancel")}</Button>}
      {!active && preview !== undefined && <Button tone="primary" disabled={busy || loading} onClick={start}>{job === undefined ? t("extensions.export.prepare") : t("extensions.export.prepareAgain")}</Button>}
      {artifact !== undefined && <ArtifactDownloadButton
        tone="primary"
        ownerKey={JSON.stringify([job!.id, job!.revision.toString(10), artifact.blobId])}
        connectionOwner={controller.downloadArtifact}
        label={t("extensions.export.download")}
        errorLabel={t("workspace.downloadUnavailable")}
        action={(context) => controller.downloadArtifact(artifact.blobId, artifact.fileName, context)}
      />}
    </div>
  </Modal>;
}

function exportStateTone(state: ExtensionPackageExportJobView["state"]): "success" | "danger" | "warning" | "neutral" {
  if (state === "ready") return "success";
  if (state === "failed") return "danger";
  if (ACTIVE_EXPORT_STATES.has(state)) return "warning";
  return "neutral";
}

type BatchState = "pending" | "updating" | "done" | "skipped" | "failed";

interface ExtensionPackageBatchRow {
  readonly resourceId: string;
  readonly extension: ExtensionCatalogEntryView;
  readonly backendId?: string;
  readonly state: BatchState;
  readonly error?: string;
}

export function ExtensionPackageBatchDialog({ controller, resources, open, t, runAction, onClose, onChanged }: {
  readonly controller: AppController;
  readonly resources: readonly ResourceView[];
  readonly open: boolean;
  readonly t: Translator;
  readonly runAction: RunAction;
  readonly onClose: () => void;
  readonly onChanged: () => Promise<void>;
}): JSX.Element {
  const [rows, setRows] = useState<readonly ExtensionPackageBatchRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [summary, setSummary] = useState<string>();
  const generation = useRef(0);
  const resourcesRef = useRef(resources);
  resourcesRef.current = resources;
  useEffect(() => {
    if (!open) {
      generation.current += 1;
      return;
    }
    const abort = new AbortController();
    const current = ++generation.current;
    setRows([]);
    setError(undefined);
    setSummary(undefined);
    setLoading(true);
    setRunning(false);
    void controller.listExtensions({ installed: true, signal: abort.signal }).then((catalog) => {
      if (abort.signal.aborted || current !== generation.current) return;
      setRows(batchRows(catalog.extensions, resourcesRef.current));
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted && current === generation.current) setError(packageError(cause, t));
    }).finally(() => {
      if (!abort.signal.aborted && current === generation.current) setLoading(false);
    });
    return () => abort.abort();
  }, [controller, open, t]);
  const close = (): void => {
    if (running) return;
    generation.current += 1;
    onClose();
  };
  const updateRow = (resourceId: string, state: BatchState, rowError?: string): void => {
    setRows((current) => current.map((row) => row.resourceId === resourceId
      ? { ...row, state, ...(rowError === undefined ? { error: undefined } : { error: rowError }) }
      : row));
  };
  const start = (): void => {
    if (loading || running || rows.length === 0) return;
    const current = ++generation.current;
    const pending = [...rows];
    setRunning(true);
    setSummary(undefined);
    runAction("extension-package-update-all", async () => {
      let done = 0;
      let failed = 0;
      let skipped = 0;
      for (const row of pending) {
        if (row.extension.update?.sourceReplacement === true) {
          skipped += 1;
          if (current === generation.current) updateRow(row.resourceId, "skipped", t("extensions.package.batchSwitchSkipped"));
          continue;
        }
        if (row.backendId === undefined) {
          failed += 1;
          if (current === generation.current) updateRow(row.resourceId, "failed", t("extensions.package.noBackend"));
          continue;
        }
        if (current === generation.current) updateRow(row.resourceId, "updating");
        try {
          const preview = await controller.getExtensionPackagePreview(row.extension.id, row.extension.revision, row.backendId);
          if (preview.action === "replace" || preview.sourceReplacement) {
            skipped += 1;
            if (current === generation.current) updateRow(row.resourceId, "skipped", t("extensions.package.batchSwitchSkipped"));
            continue;
          }
          if (preview.action !== "update" || preview.currentResource?.resourceId !== row.resourceId) {
            throw new Error(t("extensions.package.batchChanged"));
          }
          await controller.adoptExtensionPackage(preview, false);
          done += 1;
          if (current === generation.current) updateRow(row.resourceId, "done");
        } catch (cause) {
          failed += 1;
          if (current === generation.current) updateRow(row.resourceId, "failed", packageError(cause, t));
        }
      }
      await onChanged().catch(() => undefined);
      if (current === generation.current) {
        setSummary(t("extensions.package.batchComplete", { done, failed, skipped }));
        setRunning(false);
      }
    });
  };
  return <Modal open={open} title={t("extensions.package.batchTitle")} description={t("extensions.package.batchBody")} size="medium" onClose={close}>
    <div className="extension-package-batch">
      {loading && <p className="extension-package-dialog__status" role="status"><RefreshCcw aria-hidden="true" />{t("extensions.package.batchLoading")}</p>}
      {error !== undefined && <p className="extension-detail__error" role="alert"><AlertTriangle aria-hidden="true" />{error}</p>}
      {!loading && error === undefined && rows.length === 0 && <p className="muted">{t("extensions.package.batchEmpty")}</p>}
      {rows.map((row) => <div className={`extension-package-batch__row is-${row.state}`} key={row.resourceId}><span><strong>{row.extension.name}</strong><small>{row.extension.version ?? t("common.unknown")}{row.extension.update?.availableVersion === undefined ? "" : ` → ${row.extension.update.availableVersion}`}</small>{row.error !== undefined && <em>{row.error}</em>}</span><Pill tone={batchTone(row.state)}>{batchStateLabel(row.state, t)}</Pill></div>)}
      {summary !== undefined && <p className="extension-package-result is-success" role="status"><CheckCircle2 aria-hidden="true" />{summary}</p>}
    </div>
    <div className="modal__actions"><Button disabled={running} onClick={close}>{summary === undefined ? t("common.cancel") : t("common.close")}</Button>{summary === undefined && <Button tone="primary" disabled={loading || running || rows.length === 0} onClick={start}>{running ? t("extensions.install.installing") : t("extensions.package.batchStart")}</Button>}</div>
  </Modal>;
}

function batchRows(extensions: readonly ExtensionCatalogEntryView[], resources: readonly ResourceView[]): readonly ExtensionPackageBatchRow[] {
  const rows = new Map<string, ExtensionPackageBatchRow>();
  for (const extension of [...extensions].sort((left, right) => left.id.localeCompare(right.id, "en"))) {
    if (extension.owner.kind !== "resource" || extension.update === undefined || rows.has(extension.owner.resourceId)) continue;
    const resourceId = extension.owner.resourceId;
    const resource = resources.find((candidate) => candidate.id === resourceId);
    rows.set(resourceId, {
      resourceId,
      extension,
      ...(resource === undefined ? {} : { backendId: resource.backendId }),
      state: "pending"
    });
  }
  return [...rows.values()];
}

function packageActionLabel(action: ExtensionPackagePreviewView["action"] | undefined, t: Translator): string {
  if (action === "update") return t("extensions.package.update");
  if (action === "replace") return t("extensions.package.replace");
  return t("extensions.package.install");
}

function packageWarningLabel(value: ResourcePackageWarningView, t: Translator): string {
  if (value === "noResources") return t("resource.warningNoResources");
  if (value === "inspectionFailed") return t("resource.warningInspectionFailed");
  if (value === "inspectionLimit") return t("resource.warningInspectionLimit");
  if (value === "lifecycleScriptsDisabled") return t("resource.warningLifecycleScriptsDisabled");
  return t("resource.warningUnknown");
}

function compatibilityTone(value: ResourceCompatibilityView): "success" | "danger" | "warning" | "neutral" {
  return value === "supported" ? "success" : value === "unsupported" ? "danger" : value === "partial" ? "warning" : "neutral";
}

function compatibilityLabel(value: ResourceCompatibilityView, t: Translator): string {
  if (value === "supported") return t("resource.compatibilitySupported");
  if (value === "partial") return t("resource.compatibilityPartial");
  if (value === "unsupported") return t("resource.compatibilityUnsupported");
  return t("resource.compatibilityUnknown");
}

function resourceKindLabel(kind: ResourceView["kind"], t: Translator): string {
  if (kind === "extension") return t("resource.kindExtension");
  if (kind === "skill") return t("resource.kindSkill");
  if (kind === "prompt") return t("resource.kindPrompt");
  if (kind === "theme") return t("resource.kindTheme");
  return t("resource.kindPackage");
}

function runtimeRequirementLabel(value: ResourceView["runtimeRequirements"][number]["status"], t: Translator): string {
  return value === "compatible" ? t("resource.runtimeCompatible") : value === "incompatible" ? t("resource.runtimeIncompatible") : t("resource.runtimeUnknown");
}

function batchTone(value: BatchState): "success" | "danger" | "warning" | "neutral" {
  return value === "done" ? "success" : value === "failed" ? "danger" : value === "updating" ? "warning" : "neutral";
}

function batchStateLabel(value: BatchState, t: Translator): string {
  if (value === "updating") return t("extensions.package.batchUpdating");
  if (value === "done") return t("extensions.package.batchDone");
  if (value === "skipped") return t("extensions.package.batchSkipped");
  if (value === "failed") return t("extensions.package.batchFailed");
  return t("extensions.package.batchPending");
}

function packageError(cause: unknown, t: Translator): string {
  return cause instanceof Error && cause.message.trim() !== "" ? cause.message : t("extensions.error");
}
