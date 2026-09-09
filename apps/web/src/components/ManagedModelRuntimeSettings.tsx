import { useEffect, useMemo, useState, type JSX } from "react";
import {
  Check,
  Cpu,
  Download,
  HardDrive,
  Image,
  LoaderCircle,
  Pause,
  Play,
  Search,
  Trash2,
  Wrench,
  X
} from "lucide-react";

import type { AppController } from "../controller.js";
import { translate, type MessageKey } from "../i18n.js";
import type {
  Locale,
  ManagedModelRuntimeCatalogModelView,
  ManagedModelRuntimeTransferView,
  ManagedModelRuntimeView
} from "../model.js";
import type { RunAction } from "./types.js";
import { Button, IconButton, Pill } from "./ui.js";
import "./managed-model-runtime-settings.css";

const ACTIVE_REFRESH_MS = 750;
const IDLE_REFRESH_MS = 2_000;

export function ManagedModelRuntimeSettings({
  controller,
  runtimes,
  runAction
}: {
  readonly controller: AppController;
  readonly runtimes: readonly ManagedModelRuntimeView[];
  readonly runAction: RunAction;
}): JSX.Element | null {
  const active = runtimes.some((runtime) =>
    runtime.state === "installing"
    || runtime.state === "starting"
    || runtime.transfers.some((transfer) => !transfer.done || transfer.phase === "paused")
  );
  useEffect(() => {
    const abort = new AbortController();
    let inFlight = false;
    const refresh = async (): Promise<void> => {
      if (inFlight || abort.signal.aborted) return;
      inFlight = true;
      try {
        await controller.refreshManagedModelRuntimes(abort.signal);
      } catch {
        // The authoritative connection banner owns transport failures. A later
        // probe can still observe an externally started local runtime.
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), active ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS);
    return () => {
      abort.abort();
      window.clearInterval(timer);
    };
  }, [active, controller]);

  if (runtimes.length === 0) return null;
  return <section className="managed-model-runtimes" aria-label={copy(controller.state.preferences.locale).sectionLabel}>
    {runtimes.map((runtime) => <ManagedModelRuntimePanel
      key={runtime.id}
      controller={controller}
      runtime={runtime}
      runAction={runAction}
      locale={controller.state.preferences.locale}
    />)}
  </section>;
}

function ManagedModelRuntimePanel({
  controller,
  runtime,
  runAction,
  locale
}: {
  readonly controller: AppController;
  readonly runtime: ManagedModelRuntimeView;
  readonly runAction: RunAction;
  readonly locale: Locale;
}): JSX.Element {
  const text = copy(locale);
  const [query, setQuery] = useState("");
  const [manualName, setManualName] = useState("");
  const [deleteName, setDeleteName] = useState<string>();
  const [dismissedErrorRevision, setDismissedErrorRevision] = useState<bigint>();
  const pulls = useMemo(() => new Map(runtime.transfers
    .filter((transfer) => transfer.kind === "modelPull" && transfer.modelName !== undefined)
    .map((transfer) => [modelKey(transfer.modelName!), transfer] as const)), [runtime.transfers]);
  const installedNames = useMemo(() => new Set(runtime.installedModels.map((model) => modelKey(model.name))), [runtime.installedModels]);
  const searching = query.trim().length > 0;
  const visibleCatalog = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const values = searching
      ? runtime.catalog.filter((model) => `${model.displayName} ${model.name}`.toLocaleLowerCase().includes(normalized))
      : runtime.catalog.filter((model) => model.recommended);
    return values.filter((model) => !installedNames.has(modelKey(model.name)) || pulls.has(modelKey(model.name)) || searching);
  }, [installedNames, pulls, query, runtime.catalog, searching]);
  const moreModels = runtime.catalog.filter((model) => !model.recommended && !installedNames.has(modelKey(model.name)));
  const customTransfers = runtime.transfers.filter((transfer) =>
    transfer.kind === "modelPull"
    && transfer.modelName !== undefined
    && !runtime.catalog.some((model) => modelKey(model.name) === modelKey(transfer.modelName!))
    && transfer.phase !== "success"
    && transfer.phase !== "cancelled"
  );
  const installTransfer = runtime.transfers.find((transfer) => transfer.kind === "runtimeInstall");
  const canDownload = runtime.capabilities.canPullModels;
  const errorVisible = runtime.errorMessage !== undefined && dismissedErrorRevision !== runtime.revision;

  const action = (key: string, effect: () => Promise<unknown>): void => runAction(
    `managed-model-runtime:${runtime.id}:${key}`,
    async () => { await effect(); }
  );
  const pull = (modelName: string): void => action(`pull:${modelName}`, () => controller.pullManagedModel(runtime.id, modelName));
  const cancelPull = (modelName: string): void => action(`cancel:${modelName}`, () => controller.cancelManagedModelPull(runtime.id, modelName));

  return <article className="managed-model-runtime-card">
    <header className="managed-model-runtime-card__header">
      <div className="managed-model-runtime-card__identity">
        <span className="managed-model-runtime-card__icon"><HardDrive aria-hidden="true" /></span>
        <div><h3>{runtime.name}</h3><p>{text.localModels}{runtime.version === undefined ? "" : ` · v${runtime.version}`}</p></div>
      </div>
      <Pill tone={runtime.state === "ready" ? "success" : runtime.state === "error" || runtime.state === "portConflict" ? "danger" : runtime.state === "installing" || runtime.state === "starting" ? "warning" : "neutral"}>
        {runtimeStatusLabel(runtime.state, text)}
      </Pill>
    </header>

    {errorVisible && <div className="managed-model-runtime-error" role="alert">
      <span>{runtime.errorMessage}</span>
      <IconButton label={text.dismiss} onClick={() => setDismissedErrorRevision(runtime.revision)}><X aria-hidden="true" /></IconButton>
    </div>}

    {(runtime.state === "absent" || runtime.state === "installing") && <section className="managed-model-runtime-onboarding">
      <p>{runtime.capabilities.canInstall
        ? text.installConsent(formatBytes(runtime.installPreflight.requiredDiskBytes))
        : text.installOnHost}</p>
      {installTransfer !== undefined && <TransferMeter transfer={installTransfer} text={text} />}
      <div className="managed-model-runtime-actions">
        {runtime.capabilities.canInstall && <Button
          tone="primary"
          disabled={runtime.state === "installing" || !runtime.installPreflight.allowed}
          onClick={() => action("install", () => controller.installManagedModelRuntime(runtime.id))}
        >{runtime.state === "installing" && <LoaderCircle className="managed-model-runtime-spinner" aria-hidden="true" />}<Download aria-hidden="true" />{text.install}</Button>}
        {runtime.capabilities.canCancelInstall && <Button onClick={() => action("cancel-install", () => controller.cancelManagedModelRuntimeInstall(runtime.id))}>{text.cancelInstall}</Button>}
      </div>
      {!runtime.installPreflight.allowed && <p className="managed-model-runtime-warning">{preflightWarning(runtime.installPreflight, text)}</p>}
    </section>}

    {(runtime.state === "stopped" || runtime.state === "starting") && <div className="managed-model-runtime-start">
      <p>{text.stoppedBody}</p>
      {runtime.capabilities.canStart && <Button tone="primary" disabled={runtime.state === "starting"} onClick={() => action("start", () => controller.startManagedModelRuntime(runtime.id))}>
        {runtime.state === "starting" && <LoaderCircle className="managed-model-runtime-spinner" aria-hidden="true" />}{text.start}
      </Button>}
    </div>}

    {runtime.state === "portConflict" && <p className="managed-model-runtime-warning">{text.portConflict}</p>}

    {runtime.capabilities.supportsCuratedCatalog && <section className="managed-model-runtime-catalog">
      <div className="managed-model-runtime-section-heading">
        <strong>{searching ? text.searchResults : text.recommended}</strong>
        {!searching && <span>{text.recommendationBody}</span>}
      </div>
      <label className="managed-model-runtime-search">
        <Search aria-hidden="true" />
        <span className="sr-only">{text.searchPlaceholder}</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text.searchPlaceholder} />
      </label>
      <div className="managed-model-runtime-model-list">
        {visibleCatalog.map((model, index) => <CatalogModelCard
          key={model.id}
          model={model}
          transfer={pulls.get(modelKey(model.name))}
          installed={installedNames.has(modelKey(model.name))}
          best={model.recommended && index === 0 && !searching}
          canDownload={canDownload}
          capabilities={runtime.capabilities}
          text={text}
          onPull={() => pull(model.name)}
          onPause={() => action(`pause:${model.name}`, () => controller.pauseManagedModelPull(runtime.id, model.name))}
          onResume={() => action(`resume:${model.name}`, () => controller.resumeManagedModelPull(runtime.id, model.name))}
          onCancel={() => cancelPull(model.name)}
        />)}
        {visibleCatalog.length === 0 && <p className="managed-model-runtime-empty">{text.noSearchResults}</p>}
      </div>
    </section>}

    {!searching && moreModels.length > 0 && runtime.capabilities.supportsCuratedCatalog && <details className="managed-model-runtime-more">
      <summary>{text.moreModels} <span>{moreModels.length}</span></summary>
      <div className="managed-model-runtime-model-list">{moreModels.map((model) => <CatalogModelCard
        key={model.id}
        model={model}
        transfer={pulls.get(modelKey(model.name))}
        installed={false}
        best={false}
        canDownload={canDownload}
        capabilities={runtime.capabilities}
        text={text}
        onPull={() => pull(model.name)}
        onPause={() => action(`pause:${model.name}`, () => controller.pauseManagedModelPull(runtime.id, model.name))}
        onResume={() => action(`resume:${model.name}`, () => controller.resumeManagedModelPull(runtime.id, model.name))}
        onCancel={() => cancelPull(model.name)}
      />)}</div>
    </details>}

    {runtime.capabilities.supportsCustomModels && <section className="managed-model-runtime-manual">
      <label htmlFor={`managed-model-runtime-manual-${runtime.id}`}>{text.manualDownload}</label>
      <div><input
        id={`managed-model-runtime-manual-${runtime.id}`}
        value={manualName}
        onChange={(event) => setManualName(event.target.value)}
        placeholder={text.manualPlaceholder}
        spellCheck={false}
      /><Button disabled={!canDownload || manualName.trim() === ""} onClick={() => { pull(manualName.trim()); setManualName(""); }}>{text.downloadAdd}</Button></div>
    </section>}

    {customTransfers.map((transfer) => <article className="managed-model-runtime-custom-transfer" key={transfer.modelName}>
      <div><strong>{transfer.modelName}</strong><TransferActions
        transfer={transfer}
        capabilities={runtime.capabilities}
        text={text}
        onPause={() => action(`pause:${transfer.modelName}`, () => controller.pauseManagedModelPull(runtime.id, transfer.modelName!))}
        onResume={() => action(`resume:${transfer.modelName}`, () => controller.resumeManagedModelPull(runtime.id, transfer.modelName!))}
        onCancel={() => cancelPull(transfer.modelName!)}
      /></div>
      <TransferMeter transfer={transfer} text={text} />
    </article>)}

    {runtime.installedModels.length > 0 && <section className="managed-model-runtime-installed">
      <div className="managed-model-runtime-section-heading"><strong>{text.installedModels}</strong><span>{text.automaticProviderSync}</span></div>
      <div className="managed-model-runtime-installed-list">{runtime.installedModels.map((model) => <article key={model.name}>
        <div className="managed-model-runtime-installed-name"><Check aria-hidden="true" /><span><strong>{model.displayName}</strong><small>{model.name}</small></span></div>
        <div className="managed-model-runtime-model-meta">
          {model.sizeBytes !== undefined && <Pill>{formatBytes(model.sizeBytes)}</Pill>}
          {model.contextWindowTokens !== undefined && <Pill><Cpu aria-hidden="true" />{formatTokens(model.contextWindowTokens)}</Pill>}
          {model.supportsTools && <Pill><Wrench aria-hidden="true" />{text.tools}</Pill>}
          {model.supportsImages && <Pill><Image aria-hidden="true" />{text.images}</Pill>}
          {deleteName === model.name ? <span className="managed-model-runtime-delete-confirm">
            <Button tone="ghost" onClick={() => setDeleteName(undefined)}>{text.keep}</Button>
            <Button tone="danger" onClick={() => { setDeleteName(undefined); action(`delete:${model.name}`, () => controller.deleteManagedModel(runtime.id, model.name)); }}>{text.delete}</Button>
          </span> : runtime.capabilities.canDeleteModels && <IconButton label={`${text.delete} ${model.displayName}`} onClick={() => setDeleteName(model.name)}><Trash2 aria-hidden="true" /></IconButton>}
        </div>
      </article>)}</div>
    </section>}
  </article>;
}

function CatalogModelCard({
  model,
  transfer,
  installed,
  best,
  canDownload,
  capabilities,
  text,
  onPull,
  onPause,
  onResume,
  onCancel
}: {
  readonly model: ManagedModelRuntimeCatalogModelView;
  readonly transfer?: ManagedModelRuntimeTransferView;
  readonly installed: boolean;
  readonly best: boolean;
  readonly canDownload: boolean;
  readonly capabilities: ManagedModelRuntimeView["capabilities"];
  readonly text: Copy;
  readonly onPull: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const active = transfer !== undefined && (!transfer.done || transfer.phase === "paused");
  return <article className="managed-model-runtime-model-card">
    <div className="managed-model-runtime-model-card__top">
      <div><div className="managed-model-runtime-model-title"><strong>{model.displayName}</strong><PackagingTag name={model.name} />{best && <Pill tone="accent">{text.bestForYou}</Pill>}</div>
        <span>{model.name}</span>
        <small>{formatBytes(model.sizeBytes)} · {text.memoryHint(model.minimumMemoryGb)}</small>
        {model.preflight.memory === "constrained" && <small className="managed-model-runtime-warning">{text.memoryWarning(model.minimumMemoryGb)}</small>}
        {model.preflight.disk === "insufficient" && <small className="managed-model-runtime-warning">{text.diskWarning}</small>}
      </div>
      {installed && !active ? <span className="managed-model-runtime-installed-label"><Check aria-hidden="true" />{text.installed}</span>
        : active && transfer !== undefined ? <TransferActions transfer={transfer} capabilities={capabilities} text={text} onPause={onPause} onResume={onResume} onCancel={onCancel} />
          : <Button disabled={!canDownload || !model.preflight.allowed || model.platformLimited} onClick={onPull}>{transfer?.phase === "error" ? text.retry : text.downloadAdd}</Button>}
    </div>
    {active && transfer !== undefined && <TransferMeter transfer={transfer} text={text} />}
  </article>;
}

function TransferActions({ transfer, capabilities, text, onPause, onResume, onCancel }: {
  readonly transfer: ManagedModelRuntimeTransferView;
  readonly capabilities: ManagedModelRuntimeView["capabilities"];
  readonly text: Copy;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onCancel: () => void;
}): JSX.Element | null {
  if (transfer.done && transfer.phase !== "paused") return null;
  return <div className="managed-model-runtime-transfer-actions">
    {transfer.phase === "paused"
      ? capabilities.canResumePulls && <IconButton label={text.resume} onClick={onResume}><Play aria-hidden="true" /></IconButton>
      : capabilities.canPausePulls && <IconButton label={text.pause} onClick={onPause}><Pause aria-hidden="true" /></IconButton>}
    {capabilities.canCancelPulls && <IconButton label={text.cancelDownload} onClick={onCancel}><X aria-hidden="true" /></IconButton>}
  </div>;
}

function TransferMeter({ transfer, text }: { readonly transfer: ManagedModelRuntimeTransferView; readonly text: Copy }): JSX.Element {
  const percent = transfer.percent ?? (transfer.totalBytes !== undefined && transfer.totalBytes > 0 && transfer.completedBytes !== undefined
    ? Math.round(transfer.completedBytes / transfer.totalBytes * 100)
    : undefined);
  return <div className={`managed-model-runtime-meter ${transfer.phase === "error" ? "is-error" : ""} ${transfer.phase === "paused" ? "is-paused" : ""}`} aria-live="polite">
    <div><span>{text.phase[transfer.phase]}</span><span>{transferText(transfer, percent)}</span></div>
    <div className="managed-model-runtime-meter__track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span style={{ width: `${percent ?? (transfer.done ? 100 : 8)}%` }} />
    </div>
  </div>;
}

function PackagingTag({ name }: { readonly name: string }): JSX.Element {
  const lower = name.toLowerCase();
  return <Pill>{lower.includes("mlx") || lower.includes("mxfp") ? "MLX" : lower.includes("gguf") || lower.startsWith("hf.co/") ? "GGUF" : "Local"}</Pill>;
}

function transferText(transfer: ManagedModelRuntimeTransferView, percent?: number): string {
  const size = transfer.completedBytes === undefined ? "" : transfer.totalBytes === undefined
    ? formatBytes(transfer.completedBytes)
    : `${formatBytes(transfer.completedBytes)} / ${formatBytes(transfer.totalBytes)}`;
  const speed = transfer.bytesPerSecond === undefined ? "" : `${formatBytes(transfer.bytesPerSecond)}/s`;
  return [percent === undefined ? "" : `${percent}%`, size, speed].filter(Boolean).join(" · ");
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${index < 2 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function formatTokens(tokens: number): string {
  return tokens >= 1_000 ? `${new Intl.NumberFormat().format(Math.round(tokens / 1_000))}k ctx` : `${tokens} ctx`;
}

function modelKey(name: string): string {
  const normalized = name.trim().toLocaleLowerCase();
  const tail = normalized.slice(normalized.lastIndexOf("/") + 1);
  return tail.includes(":") ? normalized : `${normalized}:latest`;
}

function runtimeStatusLabel(state: ManagedModelRuntimeView["state"], text: Copy): string {
  return text.status[state];
}

function preflightWarning(preflight: ManagedModelRuntimeView["installPreflight"], text: Copy): string {
  if (preflight.disk === "insufficient") return text.diskWarning;
  if (preflight.errorCode === "unsupportedPlatform") return text.unsupportedPlatform;
  return text.preflightBlocked;
}

interface Copy {
  readonly sectionLabel: string;
  readonly localModels: string;
  readonly dismiss: string;
  readonly install: string;
  readonly installConsent: (size: string) => string;
  readonly installOnHost: string;
  readonly cancelInstall: string;
  readonly stoppedBody: string;
  readonly start: string;
  readonly portConflict: string;
  readonly recommended: string;
  readonly recommendationBody: string;
  readonly searchResults: string;
  readonly searchPlaceholder: string;
  readonly noSearchResults: string;
  readonly moreModels: string;
  readonly manualDownload: string;
  readonly manualPlaceholder: string;
  readonly downloadAdd: string;
  readonly retry: string;
  readonly bestForYou: string;
  readonly memoryHint: (memory: number) => string;
  readonly memoryWarning: (memory: number) => string;
  readonly diskWarning: string;
  readonly unsupportedPlatform: string;
  readonly preflightBlocked: string;
  readonly installed: string;
  readonly installedModels: string;
  readonly automaticProviderSync: string;
  readonly tools: string;
  readonly images: string;
  readonly keep: string;
  readonly delete: string;
  readonly pause: string;
  readonly resume: string;
  readonly cancelDownload: string;
  readonly status: Record<ManagedModelRuntimeView["state"], string>;
  readonly phase: Record<ManagedModelRuntimeTransferView["phase"], string>;
}

function copy(locale: Locale): Copy {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>): string => translate(locale, key, values);
  return {
    sectionLabel: t("settings.localRuntime.sectionLabel"),
    localModels: t("settings.localRuntime.localModels"),
    dismiss: t("settings.localRuntime.dismiss"),
    install: t("settings.localRuntime.install"),
    installConsent: (size) => t("settings.localRuntime.installConsent", { size }),
    installOnHost: t("settings.localRuntime.installOnHost"),
    cancelInstall: t("settings.localRuntime.cancelInstall"),
    stoppedBody: t("settings.localRuntime.stoppedBody"),
    start: t("settings.localRuntime.start"),
    portConflict: t("settings.localRuntime.portConflict"),
    recommended: t("settings.localRuntime.recommended"),
    recommendationBody: t("settings.localRuntime.recommendationBody"),
    searchResults: t("settings.localRuntime.searchResults"),
    searchPlaceholder: t("settings.localRuntime.searchPlaceholder"),
    noSearchResults: t("settings.localRuntime.noSearchResults"),
    moreModels: t("settings.localRuntime.moreModels"),
    manualDownload: t("settings.localRuntime.manualDownload"),
    manualPlaceholder: t("settings.localRuntime.manualPlaceholder"),
    downloadAdd: t("settings.localRuntime.downloadAdd"),
    retry: t("settings.localRuntime.retry"),
    bestForYou: t("settings.localRuntime.bestForYou"),
    memoryHint: (memory) => t("settings.localRuntime.memoryHint", { memory }),
    memoryWarning: (memory) => t("settings.localRuntime.memoryWarning", { memory }),
    diskWarning: t("settings.localRuntime.diskWarning"),
    unsupportedPlatform: t("settings.localRuntime.unsupportedPlatform"),
    preflightBlocked: t("settings.localRuntime.preflightBlocked"),
    installed: t("settings.localRuntime.installed"),
    installedModels: t("settings.localRuntime.installedModels"),
    automaticProviderSync: t("settings.localRuntime.automaticProviderSync"),
    tools: t("settings.localRuntime.tools"),
    images: t("settings.localRuntime.images"),
    keep: t("settings.localRuntime.keep"),
    delete: t("settings.localRuntime.delete"),
    pause: t("settings.localRuntime.pause"),
    resume: t("settings.localRuntime.resume"),
    cancelDownload: t("settings.localRuntime.cancelDownload"),
    status: {
      absent: t("settings.localRuntime.status.absent"),
      stopped: t("settings.localRuntime.status.stopped"),
      starting: t("settings.localRuntime.status.starting"),
      ready: t("settings.localRuntime.status.ready"),
      portConflict: t("settings.localRuntime.status.portConflict"),
      installing: t("settings.localRuntime.status.installing"),
      error: t("settings.localRuntime.status.error"),
      unknown: t("settings.localRuntime.status.unknown")
    },
    phase: {
      starting: t("settings.localRuntime.phase.starting"),
      resolving: t("settings.localRuntime.phase.resolving"),
      manifest: t("settings.localRuntime.phase.manifest"),
      downloading: t("settings.localRuntime.phase.downloading"),
      verifying: t("settings.localRuntime.phase.verifying"),
      extracting: t("settings.localRuntime.phase.extracting"),
      writing: t("settings.localRuntime.phase.writing"),
      promoting: t("settings.localRuntime.phase.promoting"),
      success: t("settings.localRuntime.phase.success"),
      paused: t("settings.localRuntime.phase.paused"),
      cancelled: t("settings.localRuntime.phase.cancelled"),
      error: t("settings.localRuntime.phase.error"),
      unknown: t("settings.localRuntime.phase.unknown")
    }
  };
}
