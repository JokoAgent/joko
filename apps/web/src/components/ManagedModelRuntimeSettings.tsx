import { useEffect, useMemo, useRef, useState, type JSX } from "react";
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
  ManagedModelRuntimeView,
  ManagedRepositoryModelView,
  ManagedModelContextTarget,
  ManagedModelContextView
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
  return <section className="managed-model-runtimes" aria-label={copy(controller.state.effectiveLocale).sectionLabel}>
    {runtimes.map((runtime) => <ManagedModelRuntimePanel
      key={runtime.id}
      controller={controller}
      runtime={runtime}
      runAction={runAction}
      locale={controller.state.effectiveLocale}
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
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [actionError, setActionError] = useState<string>();
  const lifetime = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    pendingRef.current = false;
    setPending(false);
    return () => { abort.abort(); };
  }, [controller, runtime.id]);
  const repositoryModels = runtime.capabilities.supportsRepositoryModels === true;
  const canConfigure = runtime.capabilities.canConfigure === true;
  const catalog = useMemo(() => runtime.catalog.flatMap((model): CatalogEntry[] => repositoryModels
    ? (model.variants ?? []).map((variant) => ({ ...model, id: `${model.id}:${repositoryKey(variant)}`, name: `${variant.repository}/${variant.file}`, sizeBytes: variant.sizeBytes, repositoryModel: { repository: variant.repository, file: variant.file }, quantization: variant.quantization }))
    : [model]), [repositoryModels, runtime.catalog]);
  const pulls = useMemo(() => new Map(runtime.transfers
    .filter((transfer) => transfer.kind === "modelPull" && (transfer.modelName !== undefined || transfer.repositoryModel !== undefined))
    .map((transfer) => [transfer.repositoryModel === undefined ? modelKey(transfer.modelName!) : repositoryKey(transfer.repositoryModel), transfer] as const)), [runtime.transfers]);
  const installedNames = useMemo(() => new Set(runtime.installedModels.map((model) => model.repositoryModel === undefined ? modelKey(model.name) : repositoryKey(model.repositoryModel))), [runtime.installedModels]);
  const searching = query.trim().length > 0;
  const visibleCatalog = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return catalog.filter((model) => {
      const transfer = pulls.get(catalogKey(model));
      const pinned = transfer !== undefined && (!transfer.done || transfer.phase === "paused" || transfer.phase === "error");
      const matches = searching ? `${model.displayName} ${model.name} ${(model.aliases ?? []).join(" ")}`.toLocaleLowerCase().includes(normalized) : model.recommended;
      return pinned || matches && (!installedNames.has(catalogKey(model)) || searching);
    });
  }, [installedNames, pulls, query, catalog, searching]);
  const visibleIds = new Set(visibleCatalog.map((model) => model.id));
  const moreModels = catalog.filter((model) => !visibleIds.has(model.id) && !installedNames.has(catalogKey(model)));
  const customTransfers = runtime.transfers.filter((transfer) =>
    transfer.kind === "modelPull"
    && (transfer.modelName !== undefined || transfer.repositoryModel !== undefined)
    && !catalog.some((model) => catalogKey(model) === (transfer.repositoryModel === undefined ? modelKey(transfer.modelName!) : repositoryKey(transfer.repositoryModel)))
    && transfer.phase !== "success"
    && transfer.phase !== "cancelled"
  );
  const installTransfer = runtime.transfers.find((transfer) => transfer.kind === "runtimeInstall");
  const canDownload = runtime.capabilities.canPullModels && canConfigure && !pending;
  const errorVisible = runtime.errorMessage !== undefined && dismissedErrorRevision !== runtime.revision;

  const action = (key: string, effect: () => Promise<unknown>): void => {
    if (pendingRef.current) return;
    const signal = lifetime.current?.signal;
    pendingRef.current = true;
    setPending(true);
    setActionError(undefined);
    runAction(`managed-model-runtime:${runtime.id}:${key}`, async () => {
      try { await effect(); }
      catch { if (!signal?.aborted) setActionError(text.actionFailed); }
      finally { if (!signal?.aborted) { pendingRef.current = false; setPending(false); } }
    });
  };
  const pull = (modelName: string): void => action(`pull:${modelName}`, () => controller.pullManagedModel(runtime.id, modelName));
  const cancelPull = (modelName: string): void => action(`cancel:${modelName}`, () => controller.cancelManagedModelPull(runtime.id, modelName));
  const download = (model: CatalogEntry): void => model.repositoryModel === undefined ? pull(model.name) : action(`download:${catalogKey(model)}`, () => controller.downloadManagedRepositoryModel(runtime.id, model.repositoryModel!));
  const control = (transfer: ManagedModelRuntimeTransferView | undefined, modelName: string, operation: "pause" | "resume" | "cancel"): void => {
    if (transfer?.repositoryModel !== undefined && transfer.transferId !== undefined) action(`${operation}:${transfer.transferId}`, () => controller.controlManagedRepositoryDownload(runtime.id, transfer.transferId!, transfer.repositoryModel!, operation));
    else if (!repositoryModels) action(`${operation}:${modelName}`, () => operation === "pause" ? controller.pauseManagedModelPull(runtime.id, modelName) : operation === "resume" ? controller.resumeManagedModelPull(runtime.id, modelName) : controller.cancelManagedModelPull(runtime.id, modelName));
  };
  const transferCapabilities = { ...runtime.capabilities, canPausePulls: runtime.capabilities.canPausePulls && canConfigure && !pending, canResumePulls: runtime.capabilities.canResumePulls && canConfigure && !pending, canCancelPulls: runtime.capabilities.canCancelPulls && canConfigure && !pending };
  const card = (model: CatalogEntry, best = false): JSX.Element => <CatalogModelCard key={model.id} model={model} transfer={pulls.get(catalogKey(model))} installed={installedNames.has(catalogKey(model))} best={best} canDownload={canDownload} capabilities={transferCapabilities} text={text} locale={locale} onPull={() => download(model)} onPause={() => control(pulls.get(catalogKey(model)), model.name, "pause")} onResume={() => control(pulls.get(catalogKey(model)), model.name, "resume")} onCancel={() => control(pulls.get(catalogKey(model)), model.name, "cancel")} />;

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
    {actionError !== undefined && <div className="managed-model-runtime-error" role="alert"><span>{actionError}</span><IconButton label={text.dismiss} onClick={() => setActionError(undefined)}><X aria-hidden="true" /></IconButton></div>}
    {runtime.configureBlockedReason !== undefined && <p className="managed-model-runtime-owner-notice" role="status">{text.blocked[runtime.configureBlockedReason]}</p>}
    {runtime.capabilities.startupPolicy === "onUse" && <p className="managed-model-runtime-owner-notice">{text.onUse}</p>}
    {(runtime.capabilities.canStop || runtime.capabilities.canRestart) && <div className="managed-model-runtime-actions managed-model-runtime-owner-actions">
      {runtime.capabilities.canRestart && <Button disabled={pending} onClick={() => action("restart", () => controller.restartManagedModelRuntime(runtime.id))}>{text.restart}</Button>}
      {runtime.capabilities.canStop && <Button disabled={pending} onClick={() => action("stop", () => controller.stopManagedModelRuntime(runtime.id))}>{text.stop}</Button>}
    </div>}

    {(runtime.state === "absent" || runtime.state === "installing") && <section className="managed-model-runtime-onboarding">
      <p>{runtime.capabilities.canInstall
        ? text.installConsent(formatBytes(runtime.installPreflight.requiredDiskBytes))
        : text.installOnHost}</p>
      {installTransfer !== undefined && <TransferMeter transfer={installTransfer} text={text} />}
      <div className="managed-model-runtime-actions">
        {runtime.capabilities.canInstall && <Button
          tone="primary"
          disabled={pending || !canConfigure || runtime.state === "installing" || !runtime.installPreflight.allowed}
          onClick={() => action("install", () => controller.installManagedModelRuntime(runtime.id))}
        >{runtime.state === "installing" && <LoaderCircle className="managed-model-runtime-spinner" aria-hidden="true" />}<Download aria-hidden="true" />{text.install}</Button>}
        {runtime.capabilities.canCancelInstall && <Button disabled={pending} onClick={() => action("cancel-install", () => controller.cancelManagedModelRuntimeInstall(runtime.id))}>{text.cancelInstall}</Button>}
      </div>
      {!runtime.installPreflight.allowed && <p className="managed-model-runtime-warning">{preflightWarning(runtime.installPreflight, text)}</p>}
    </section>}

    {(runtime.state === "stopped" || runtime.state === "starting") && <div className="managed-model-runtime-start">
      <p>{runtime.capabilities.startupPolicy === "onUse" ? text.onUse : text.stoppedBody}</p>
      {runtime.capabilities.canStart && runtime.capabilities.startupPolicy !== "onUse" && <Button tone="primary" disabled={pending || runtime.state === "starting"} onClick={() => action("start", () => controller.startManagedModelRuntime(runtime.id))}>
        {runtime.state === "starting" && <LoaderCircle className="managed-model-runtime-spinner" aria-hidden="true" />}{text.start}
      </Button>}
    </div>}

    {runtime.state === "portConflict" && <p className="managed-model-runtime-warning">{text.portConflict}</p>}

    {runtime.capabilities.supportsCuratedCatalog && <section className="managed-model-runtime-catalog">
      <div className="managed-model-runtime-section-heading">
        <strong>{searching ? text.searchResults : text.recommended}</strong>
        {!searching && <span>{text.recommendationBody}</span>}
        {!searching && runtime.hostProfile !== undefined && <span>{text.hostSummary(runtime.hostProfile.memoryGb, runtime.hostProfile.chip ?? `${runtime.hostProfile.platform} ${runtime.hostProfile.arch}`)}{runtime.hostProfile.appleSilicon ? ` · ${text.appleSilicon}` : ""}</span>}
      </div>
      <label className="managed-model-runtime-search">
        <Search aria-hidden="true" />
        <span className="sr-only">{text.searchPlaceholder}</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text.searchPlaceholder} />
      </label>
      <div className="managed-model-runtime-model-list">
        {visibleCatalog.map((model, index) => card(model, model.recommended && index === 0 && !searching))}
        {visibleCatalog.length === 0 && <p className="managed-model-runtime-empty">{text.noSearchResults}</p>}
      </div>
    </section>}

    {!searching && moreModels.length > 0 && runtime.capabilities.supportsCuratedCatalog && <details className="managed-model-runtime-more">
      <summary>{text.moreModels} <span>{moreModels.length}</span></summary>
      <div className="managed-model-runtime-model-list">{moreModels.map((model) => card(model))}</div>
    </details>}

    {repositoryModels && <RepositoryDownload controller={controller} runtime={runtime} disabled={!canConfigure || pending} canDownload={canDownload} text={text} action={action} />}
    {runtime.capabilities.supportsCustomModels && !repositoryModels && <section className="managed-model-runtime-manual">
      <label htmlFor={`managed-model-runtime-manual-${runtime.id}`}>{text.manualDownload}</label>
      <div><input
        id={`managed-model-runtime-manual-${runtime.id}`}
        value={manualName}
        onChange={(event) => setManualName(event.target.value)}
        placeholder={text.manualPlaceholder}
        spellCheck={false}
      /><Button disabled={!canDownload || manualName.trim() === ""} onClick={() => { pull(manualName.trim()); setManualName(""); }}>{text.downloadAdd}</Button></div>
    </section>}

    {customTransfers.map((transfer) => <article className="managed-model-runtime-custom-transfer" key={transfer.transferId ?? transfer.modelName}>
      <div><strong>{transfer.repositoryModel === undefined ? transfer.modelName : `${transfer.repositoryModel.repository}/${transfer.repositoryModel.file}`}</strong>{transfer.phase === "error" ? <Button disabled={!canDownload} onClick={() => transfer.repositoryModel === undefined ? pull(transfer.modelName!) : action(`retry:${transfer.transferId}`, () => controller.downloadManagedRepositoryModel(runtime.id, transfer.repositoryModel!))}>{text.retry}</Button> : <TransferActions
        transfer={transfer}
        capabilities={transferCapabilities}
        text={text}
        onPause={() => control(transfer, transfer.modelName ?? "", "pause")}
        onResume={() => control(transfer, transfer.modelName ?? "", "resume")}
        onCancel={() => transfer.repositoryModel === undefined ? cancelPull(transfer.modelName!) : control(transfer, transfer.modelName ?? "", "cancel")}
      />}</div>
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
          </span> : !repositoryModels && runtime.capabilities.canDeleteModels && <IconButton label={`${text.delete} ${model.displayName}`} onClick={() => setDeleteName(model.name)}><Trash2 aria-hidden="true" /></IconButton>}
        </div>
        {repositoryModels && model.repositoryModel !== undefined && (runtime.providerRoutes?.length ?? 0) > 0 && <ModelContextSettings controller={controller} runtime={runtime} modelId={model.name} repositoryModel={model.repositoryModel} disabled={!canConfigure || pending} locale={locale} text={text} />}
      </article>)}</div>
    </section>}
  </article>;
}

function RepositoryDownload({ controller, runtime, disabled, canDownload, text, action }: {
  readonly controller: AppController; readonly runtime: ManagedModelRuntimeView; readonly disabled: boolean; readonly canDownload: boolean; readonly text: Copy;
  readonly action: (key: string, effect: () => Promise<unknown>) => void;
}): JSX.Element {
  const [repository, setRepository] = useState("");
  const [files, setFiles] = useState<readonly { readonly file: string; readonly sizeBytes: number }[]>();
  const [selectedFile, setSelectedFile] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), [controller, runtime.id]);
  useEffect(() => { if (!runtime.capabilities.canConfigure) { request.current?.abort(); setStatus("idle"); } }, [runtime.capabilities.canConfigure]);
  const normalized = repository.trim();
  const valid = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(normalized);
  const query = async (): Promise<void> => {
    if (disabled || !valid || status === "loading") return;
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    setStatus("loading");
    setFiles(undefined);
    setSelectedFile("");
    try {
      const result = await controller.listManagedModelRepositoryFiles(runtime.id, normalized, abort.signal);
      if (abort.signal.aborted || result.repository !== normalized) return;
      setFiles(result.files);
      setSelectedFile(result.files[0]?.file ?? "");
      setStatus("ready");
    } catch { if (!abort.signal.aborted) setStatus("failed"); }
  };
  return <section className="managed-model-runtime-manual managed-model-runtime-repository" aria-label={text.repositoryDownload}>
    <label htmlFor={`repository-${runtime.id}`}>{text.repositoryDownload}</label>
    <p>{text.repositoryBody}</p>
    <div><input id={`repository-${runtime.id}`} value={repository} disabled={disabled} placeholder="owner/model-GGUF" spellCheck={false} onChange={(event) => { request.current?.abort(); setRepository(event.target.value); setFiles(undefined); setSelectedFile(""); setStatus("idle"); }} onKeyDown={(event) => { if (event.key === "Enter") void query(); }} /><Button disabled={disabled || !valid || status === "loading"} onClick={() => void query()}>{status === "loading" ? text.loadingFiles : status === "failed" ? text.retryAction : text.queryFiles}</Button></div>
    {status === "loading" && <span role="status">{text.loadingFiles}</span>}
    {status === "failed" && <p className="managed-model-runtime-warning" role="alert">{text.filesFailed}</p>}
    {status === "ready" && files?.length === 0 && <p role="status">{text.noFiles}</p>}
    {files !== undefined && files.length > 0 && <div className="managed-model-runtime-file-selection"><label htmlFor={`repository-file-${runtime.id}`} className="sr-only">{text.fileSelection}</label><select id={`repository-file-${runtime.id}`} value={selectedFile} disabled={disabled} onChange={(event) => setSelectedFile(event.target.value)}>{files.map((file) => <option key={file.file} value={file.file}>{file.file} · {formatBytes(file.sizeBytes)}</option>)}</select><Button disabled={!canDownload || selectedFile === ""} onClick={() => action(`repository:${normalized}:${selectedFile}`, () => controller.downloadManagedRepositoryModel(runtime.id, { repository: normalized, file: selectedFile }))}>{text.downloadAdd}</Button></div>}
  </section>;
}

export function ManagedModelContextSettings({ controller, runtime, modelId, repositoryModel, disabled, locale }: {
  readonly controller: AppController; readonly runtime: ManagedModelRuntimeView; readonly modelId: string; readonly repositoryModel: ManagedRepositoryModelView; readonly disabled: boolean; readonly locale: Locale;
}): JSX.Element {
  return <ModelContextSettings controller={controller} runtime={runtime} modelId={modelId} repositoryModel={repositoryModel} disabled={disabled} locale={locale} text={copy(locale)} />;
}

function ModelContextSettings({ controller, runtime, modelId, repositoryModel, disabled, locale, text }: {
  readonly controller: AppController; readonly runtime: ManagedModelRuntimeView; readonly modelId: string; readonly repositoryModel: ManagedRepositoryModelView; readonly disabled: boolean; readonly locale: Locale; readonly text: Copy;
}): JSX.Element {
  const targetKey = JSON.stringify({ modelId, repositoryModel, routes: runtime.providerRoutes });
  const target = useMemo((): ManagedModelContextTarget => {
    const targets = (runtime.providerRoutes ?? []).map((route) => ({ ...route, modelId, repositoryModel }));
    return { ...targets[0]!, relatedTargets: targets.slice(1) };
  }, [targetKey]);
  const [context, setContext] = useState<ManagedModelContextView>();
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [writing, setWriting] = useState(false);
  const writingRef = useRef(false);
  const [error, setError] = useState(false);
  const [readRevision, setReadRevision] = useState(0);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const advertisedContext = runtime.installedModels.find((model) => model.name === modelId)?.contextWindowTokens;
  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    writingRef.current = false;
    setWriting(false);
    setLoading(true);
    setError(false);
    void controller.getManagedModelContext(runtime.id, target, abort.signal).then((next) => {
      if (abort.signal.aborted) return;
      setContext(next); setValue(String(next.effectiveContextWindowTokens / 1_000)); setLoading(false);
    }, () => { if (!abort.signal.aborted) { setError(true); setLoading(false); } });
    return () => abort.abort();
  }, [controller, runtime.id, target, readRevision, runtime.capabilities.canConfigure, advertisedContext]);
  const tokens = Number(value) * 1_000;
  const valid = value.trim() !== "" && Number.isSafeInteger(tokens) && tokens >= 1_000 && tokens <= (context?.maximumContextWindowTokens ?? 0);
  const write = async (operation: "save" | "reset", preset?: number): Promise<void> => {
    if (disabled || loading || writingRef.current || !context?.canConfigure || operation === "save" && preset === undefined && !valid) return;
    const signal = lifetime.current?.signal;
    writingRef.current = true; setWriting(true); setError(false);
    try {
      const next = operation === "reset" ? await controller.resetManagedModelContext(runtime.id, target) : await controller.setManagedModelContext(runtime.id, target, preset ?? tokens);
      if (!signal?.aborted) { setContext(next); setValue(String(next.effectiveContextWindowTokens / 1_000)); }
    } catch { if (!signal?.aborted) setError(true); }
    finally { if (!signal?.aborted) { writingRef.current = false; setWriting(false); } }
  };
  return <section className="managed-model-runtime-context" aria-label={`${text.contextWindow} ${modelId}`} aria-busy={loading || writing}>
    <strong>{text.contextWindow}</strong>
    {loading ? <span role="status">{text.contextLoading}</span> : context !== undefined && <>
      <span>{text.contextSummary(context.defaultContextWindowTokens, context.effectiveContextWindowTokens, context.maximumContextWindowTokens)}</span>
      {context.mixed && <p>{text.contextMixed}</p>}
      <div className="managed-model-runtime-context__field"><label htmlFor={`context-${runtime.id}-${modelId}`}>{text.contextK}</label><input id={`context-${runtime.id}-${modelId}`} inputMode="decimal" value={value} aria-invalid={!valid} disabled={disabled || !context.canConfigure || writing} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void write("save"); }} /><Button disabled={disabled || !context.canConfigure || writing || !valid} onClick={() => void write("save")}>{text.save}</Button><Button disabled={disabled || !context.canConfigure || writing || !context.customized && !context.mixed} onClick={() => void write("reset")}>{text.contextReset}</Button></div>
      {!valid && <p className="managed-model-runtime-warning">{text.contextInvalid(context.maximumContextWindowTokens)}</p>}
      {context.presets.length > 0 && <div className="managed-model-runtime-actions">{context.presets.map((preset) => <Button key={preset} disabled={disabled || !context.canConfigure || writing} onClick={() => void write("save", preset)}>{new Intl.NumberFormat(locale === "zh-CN" ? "zh-CN" : "en").format(preset)} {text.tokens}</Button>)}</div>}
      {context.pendingApply && <p role="status">{text.contextPending}</p>}
    </>}
    {error && <p className="managed-model-runtime-warning" role="alert">{text.contextFailed} <Button disabled={writing || loading} onClick={() => setReadRevision((revision) => revision + 1)}>{text.retryAction}</Button></p>}
  </section>;
}

interface CatalogEntry extends ManagedModelRuntimeCatalogModelView { readonly repositoryModel?: ManagedRepositoryModelView; readonly quantization?: string }
function repositoryKey(model: ManagedRepositoryModelView): string { return `${model.repository}\u0000${model.file}`; }
function catalogKey(model: CatalogEntry): string { return model.repositoryModel === undefined ? modelKey(model.name) : repositoryKey(model.repositoryModel); }

function CatalogModelCard({
  model,
  transfer,
  installed,
  best,
  canDownload,
  capabilities,
  text,
  locale,
  onPull,
  onPause,
  onResume,
  onCancel
}: {
  readonly model: CatalogEntry;
  readonly transfer?: ManagedModelRuntimeTransferView;
  readonly installed: boolean;
  readonly best: boolean;
  readonly canDownload: boolean;
  readonly capabilities: ManagedModelRuntimeView["capabilities"];
  readonly text: Copy;
  readonly locale: Locale;
  readonly onPull: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const active = transfer !== undefined && (!transfer.done || transfer.phase === "paused");
  return <article className="managed-model-runtime-model-card">
    <div className="managed-model-runtime-model-card__top">
      <div><div className="managed-model-runtime-model-title"><strong>{model.displayName}</strong>{model.repositoryModel === undefined ? <PackagingTag name={model.name} /> : <Pill>GGUF · {model.quantization}</Pill>}{best && <Pill tone="accent">{text.bestForYou}</Pill>}</div>
        <span>{model.name}</span>
        {model.descriptions?.[locale === "zh-CN" ? "zh-CN" : "en"] !== undefined && <small>{model.descriptions[locale === "zh-CN" ? "zh-CN" : "en"]}</small>}
        <small>{formatBytes(model.sizeBytes)} · {text.memoryHint(model.minimumMemoryGb)}</small>
        {model.preflight.memory === "constrained" && <small className="managed-model-runtime-warning">{text.memoryWarning(model.minimumMemoryGb)}</small>}
        {model.preflight.disk === "insufficient" && <small className="managed-model-runtime-warning">{text.diskWarning}</small>}
      </div>
      {installed && !active ? <span className="managed-model-runtime-installed-label"><Check aria-hidden="true" />{text.installed}</span>
        : active && transfer !== undefined ? <TransferActions transfer={transfer} capabilities={capabilities} text={text} onPause={onPause} onResume={onResume} onCancel={onCancel} />
          : <Button disabled={!canDownload || !model.preflight.allowed || model.platformLimited} onClick={onPull}>{transfer?.phase === "error" ? text.retry : text.downloadAdd}</Button>}
    </div>
    {(active || transfer?.phase === "error") && transfer !== undefined && <TransferMeter transfer={transfer} text={text} />}
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
  readonly retryAction: string;
  readonly actionFailed: string;
  readonly onUse: string;
  readonly restart: string;
  readonly stop: string;
  readonly appleSilicon: string;
  readonly hostSummary: (memory: number, chip: string) => string;
  readonly blocked: Record<NonNullable<ManagedModelRuntimeView["configureBlockedReason"]>, string>;
  readonly repositoryDownload: string;
  readonly repositoryBody: string;
  readonly loadingFiles: string;
  readonly queryFiles: string;
  readonly filesFailed: string;
  readonly noFiles: string;
  readonly fileSelection: string;
  readonly contextWindow: string;
  readonly contextLoading: string;
  readonly contextSummary: (defaultTokens: number, effective: number, maximum: number) => string;
  readonly contextMixed: string;
  readonly contextK: string;
  readonly contextReset: string;
  readonly contextInvalid: (max: number) => string;
  readonly contextPending: string;
  readonly contextFailed: string;
  readonly save: string;
  readonly tokens: string;
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
    retryAction: t("common.retry"),
    actionFailed: t("settings.localRuntime.actionFailed"),
    onUse: t("settings.localRuntime.onUse"),
    restart: t("common.restart"), stop: t("common.stop"),
    appleSilicon: t("settings.localRuntime.appleSilicon"),
    hostSummary: (memory, chip) => t("settings.localRuntime.hostSummary", { memory, chip }),
    blocked: { ownedElsewhere: t("settings.localRuntime.ownedElsewhere"), ownerUnknown: t("settings.localRuntime.ownerUnknown"), busy: t("settings.localRuntime.busy"), stopUnconfirmed: t("settings.localRuntime.stopUnconfirmed") },
    repositoryDownload: t("settings.localRuntime.repositoryDownload"), repositoryBody: t("settings.localRuntime.repositoryBody"), loadingFiles: t("settings.localRuntime.loadingFiles"), queryFiles: t("settings.localRuntime.queryFiles"), filesFailed: t("settings.localRuntime.filesFailed"), noFiles: t("settings.localRuntime.noFiles"), fileSelection: t("settings.localRuntime.fileSelection"),
    contextWindow: t("settings.localRuntime.contextWindow"), contextLoading: t("settings.localRuntime.contextLoading"), contextSummary: (defaultTokens, effective, maximum) => t("settings.localRuntime.contextSummary", { defaultTokens, effective, maximum }), contextMixed: t("settings.localRuntime.contextMixed"), contextK: t("settings.localRuntime.contextK"), contextReset: t("settings.localRuntime.contextReset"), contextInvalid: (max) => t("settings.localRuntime.contextInvalid", { max }), contextPending: t("settings.localRuntime.contextPending"), contextFailed: t("settings.localRuntime.contextFailed"), save: t("common.save"), tokens: t("settings.localRuntime.tokens"),
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
