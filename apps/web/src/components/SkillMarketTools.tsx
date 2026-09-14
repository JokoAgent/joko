import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Download,
  File,
  FileDiff,
  Folder,
  FolderOpen,
  GitBranch,
  Globe2,
  LoaderCircle,
  Plus,
  RefreshCcw,
  Search,
  Sparkles,
  Trash2
} from "lucide-react";

import type { AppController } from "../controller.js";
import type {
  BackendView,
  SkillDescriptorView,
  SkillMarketArchivePageView,
  SkillMarketCatalogPageView,
  SkillMarketEntryIdentityView,
  SkillMarketEntryView,
  SkillMarketGitPreflightView,
  SkillMarketInstallPlanView,
  SkillMarketInstallTargetView,
  SkillMarketPreviewFileView,
  SkillMarketPreviewView,
  SkillMarketSortView,
  SkillMarketSourceCatalogView,
  SkillMarketSourceDraft,
  SkillMarketSourceView,
  SkillMarketSyncJobView,
  SkillMarketSyncPolicyView,
  TargetView
} from "../model.js";
import { resourceKindsForBackend } from "../resource-capabilities.js";
import type { Translator } from "./types.js";
import { Button, CheckboxControl, EmptyState, IconButton, Modal, Pill, SelectControl, cx, formatRelativeTime } from "./ui.js";

type LoadState<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly value: T };

export function SkillMarketSourcesTools({ controller, locale, t, onOpenMarket }: {
  readonly controller: AppController;
  readonly locale: string;
  readonly t: Translator;
  readonly onOpenMarket: () => void;
}): JSX.Element {
  const [catalog, setCatalog] = useState<LoadState<SkillMarketSourceCatalogView>>({ kind: "loading" });
  const [preflight, setPreflight] = useState<LoadState<SkillMarketGitPreflightView>>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false);
  const [kind, setKind] = useState<SkillMarketSourceDraft["kind"]>("local");
  const [serverPath, setServerPath] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [sparsePaths, setSparsePaths] = useState("");
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string>();
  const [removeCandidate, setRemoveCandidate] = useState<SkillMarketSourceView>();
  const loadRequest = useRef(0);
  const mutationGeneration = useRef(0);

  useEffect(() => () => { mutationGeneration.current += 1; }, []);

  useEffect(() => {
    const request = ++loadRequest.current;
    const abort = new AbortController();
    setCatalog({ kind: "loading" });
    setPreflight((current) => current.kind === "ready" ? current : { kind: "loading" });
    void controller.listSkillMarketSources(abort.signal).then((value) => {
      if (abort.signal.aborted || request !== loadRequest.current) return;
      setCatalog({ kind: "ready", value });
      if (value.sources.length === 0) setEditorOpen(true);
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted && request === loadRequest.current) setCatalog({ kind: "error", message: errorMessage(cause, t) });
    });
    void controller.getSkillMarketGitPreflight(abort.signal).then((value) => {
      if (!abort.signal.aborted && request === loadRequest.current) setPreflight({ kind: "ready", value });
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted && request === loadRequest.current) setPreflight({ kind: "error", message: errorMessage(cause, t) });
    });
    return () => abort.abort();
  }, [controller, reload, t]);

  const mutate = (action: (signal: AbortSignal) => Promise<void>, succeeded?: () => void): void => {
    if (busy) return;
    const generation = ++mutationGeneration.current;
    const abort = new AbortController();
    setBusy(true);
    setMutationError(undefined);
    void action(abort.signal).then(() => {
      if (generation !== mutationGeneration.current) return;
      succeeded?.();
      setReload((value) => value + 1);
    }).catch((cause: unknown) => {
      if (generation === mutationGeneration.current) setMutationError(errorMessage(cause, t));
    }).finally(() => {
      if (generation === mutationGeneration.current) setBusy(false);
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (catalog.kind !== "ready") return;
    const draft: SkillMarketSourceDraft = kind === "local"
      ? { kind: "local", serverPath: serverPath.trim() }
      : {
          kind: "git",
          repositoryUrl: repositoryUrl.trim(),
          ...(gitRef.trim() === "" ? {} : { ref: gitRef.trim() }),
          sparsePaths: sparsePaths.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)
        };
    mutate((signal) => controller.addSkillMarketSource(draft, catalog.value.revision, signal), () => {
      setServerPath("");
      setRepositoryUrl("");
      setGitRef("");
      setSparsePaths("");
      setEditorOpen(false);
    });
  };

  const gitReady = preflight.kind === "ready" && preflight.value.available;
  const inputReady = kind === "local" ? serverPath.trim() !== "" : repositoryUrl.trim() !== "" && gitReady;
  return <section className="skill-market-sources" aria-label={t("skills.market.sources.title")} aria-busy={busy}>
    <header className="skill-market-page-header">
      <div><p className="eyebrow">{t("skills.market.sources.eyebrow")}</p><h2>{t("skills.market.sources.title")}</h2><p>{t("skills.market.sources.body")}</p></div>
      <div><Button tone="ghost" onClick={onOpenMarket}>{t("skills.market.sources.browse")}</Button><Button disabled={busy} onClick={() => setEditorOpen((value) => !value)}><Plus aria-hidden="true" />{editorOpen ? t("common.cancel") : t("skills.market.sources.add")}</Button></div>
    </header>
    {catalog.kind === "ready" && <p className="skill-market-revision">{t("skills.market.sources.revision", { revision: catalog.value.revision.toString(10) })}</p>}
    {catalog.kind === "ready" && catalog.value.recoveredFromCorruption && <InlineNotice tone="warning" message={t("skills.market.sources.recovered")} />}
    {editorOpen && <form className="skill-market-source-editor" onSubmit={submit}>
      <label><span>{t("skills.market.sources.kind")}</span><SelectControl value={kind} disabled={busy} onChange={(event) => setKind(event.target.value as SkillMarketSourceDraft["kind"])}><option value="local">{t("skills.market.sources.local")}</option><option value="git">{t("skills.market.sources.git")}</option></SelectControl></label>
      {kind === "local" ? <label><span>{t("skills.market.sources.path")}</span><input autoComplete="off" value={serverPath} disabled={busy} placeholder={t("skills.market.sources.pathPlaceholder")} onChange={(event) => setServerPath(event.target.value)} /><small>{t("skills.market.sources.pathPrivate")}</small></label> : <>
        <label><span>{t("skills.market.sources.repository")}</span><input autoComplete="off" value={repositoryUrl} disabled={busy} placeholder={t("skills.market.sources.repositoryPlaceholder")} onChange={(event) => setRepositoryUrl(event.target.value)} /></label>
        <label><span>{t("skills.market.sources.ref")}</span><input autoComplete="off" value={gitRef} disabled={busy} placeholder={t("skills.market.sources.refPlaceholder")} onChange={(event) => setGitRef(event.target.value)} /></label>
        <label><span>{t("skills.market.sources.sparse")}</span><textarea value={sparsePaths} disabled={busy} placeholder={t("skills.market.sources.sparsePlaceholder")} onChange={(event) => setSparsePaths(event.target.value)} /></label>
        <GitPreflight state={preflight} t={t} />
      </>}
      <div className="skill-market-source-editor__actions"><Button type="button" disabled={busy} onClick={() => setEditorOpen(false)}>{t("common.cancel")}</Button><Button type="submit" tone="primary" disabled={busy || catalog.kind !== "ready" || !inputReady}>{t("skills.market.sources.addAction")}</Button></div>
    </form>}
    {mutationError !== undefined && <InlineNotice tone="error" message={mutationError} />}
    {catalog.kind === "loading" && <LoadingState message={t("skills.market.sources.loading")} />}
    {catalog.kind === "error" && <ErrorState message={catalog.message} retry={() => setReload((value) => value + 1)} t={t} />}
    {catalog.kind === "ready" && catalog.value.sources.length === 0 && <EmptyState icon={<FolderOpen />} title={t("skills.market.sources.empty")} body={t("skills.market.sources.emptyBody")} />}
    {catalog.kind === "ready" && catalog.value.sources.length > 0 && <div className="skill-market-source-list">{catalog.value.sources.map((source) => <article className="skill-market-source-card" key={source.id}>
      <span className="skill-market-source-card__icon">{source.kind === "git" ? <GitBranch aria-hidden="true" /> : <FolderOpen aria-hidden="true" />}</span>
      <div className="skill-market-source-card__copy"><span><strong>{source.displayName ?? source.name}</strong><Pill tone={source.state === "ready" ? "success" : "danger"}>{t(`skills.market.sources.state.${source.state}`)}</Pill></span><small>{source.display}</small><small>{t("skills.market.sources.entries", { count: source.entryCount })}</small><small>{source.refreshedAt === undefined ? t("skills.market.sources.added", { time: formatRelativeTime(source.addedAt, locale) }) : t("skills.market.sources.refreshed", { time: formatRelativeTime(source.refreshedAt, locale) })}</small>{source.error !== undefined && <em role="alert">{source.error}</em>}</div>
      <div className="skill-market-source-card__actions"><Button disabled={busy} onClick={() => mutate((signal) => controller.refreshSkillMarketSource(source.id, source.revision, signal))}><RefreshCcw aria-hidden="true" />{t("common.refresh")}</Button><Button tone="ghost" className="danger-text" disabled={busy} aria-label={t("skills.market.sources.removeLabel", { name: source.displayName ?? source.name })} onClick={() => setRemoveCandidate(source)}><Trash2 aria-hidden="true" />{t("common.remove")}</Button></div>
    </article>)}</div>}
    <Modal open={removeCandidate !== undefined} title={t("skills.market.sources.removeTitle")} description={removeCandidate === undefined ? undefined : t("skills.market.sources.removeBody", { name: removeCandidate.displayName ?? removeCandidate.name })} dialogRole="alertdialog" size="small" dismissOnBackdrop={!busy} onClose={() => { if (!busy) setRemoveCandidate(undefined); }}>
      <div className="modal__actions"><Button disabled={busy} onClick={() => setRemoveCandidate(undefined)}>{t("common.cancel")}</Button><Button tone="danger" disabled={busy || removeCandidate === undefined} onClick={() => {
        const source = removeCandidate;
        if (source !== undefined) mutate((signal) => controller.removeSkillMarketSource(source.id, source.revision, signal), () => setRemoveCandidate(undefined));
      }}>{t("common.remove")}</Button></div>
    </Modal>
  </section>;
}

function GitPreflight({ state, t }: { readonly state: LoadState<SkillMarketGitPreflightView>; readonly t: Translator }): JSX.Element {
  if (state.kind === "loading") return <p className="skill-market-preflight" role="status">{t("skills.market.sources.gitChecking")}</p>;
  if (state.kind === "error") return <p className="skill-market-preflight is-error" role="alert">{state.message}</p>;
  return <p className={cx("skill-market-preflight", !state.value.available && "is-error")}>{state.value.available
    ? t("skills.market.sources.gitReady", { version: state.value.version ?? t("common.unknown") })
    : t("skills.market.sources.gitUnavailable", { version: state.value.minimumVersion })}</p>;
}

interface CatalogCursor {
  readonly token: string;
  readonly revision?: bigint;
}

export function SkillMarketCatalogTools({ controller, backends, targets, locale, t, initialSelection, onOpenSources }: {
  readonly controller: AppController;
  readonly backends: readonly BackendView[];
  readonly targets: readonly TargetView[];
  readonly locale: string;
  readonly t: Translator;
  readonly initialSelection?: SkillMarketEntryIdentityView;
  readonly onOpenSources: () => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState<SkillMarketSortView>("trending");
  const [cursors, setCursors] = useState<readonly CatalogCursor[]>([{ token: "" }]);
  const [catalog, setCatalog] = useState<LoadState<SkillMarketCatalogPageView>>({ kind: "loading" });
  const [selected, setSelected] = useState<SkillMarketEntryIdentityView | undefined>(initialSelection);
  const [detail, setDetail] = useState<LoadState<{ readonly entry: SkillMarketEntryView; readonly preview: SkillMarketPreviewView; readonly files: SkillMarketArchivePageView }> | undefined>();
  const [selectedFile, setSelectedFile] = useState<string>();
  const [file, setFile] = useState<LoadState<SkillMarketPreviewFileView> | undefined>();
  const [installEntry, setInstallEntry] = useState<SkillMarketEntryView>();
  const [mobileDetail, setMobileDetail] = useState(initialSelection !== undefined);
  const [reload, setReload] = useState(0);
  const [detailReload, setDetailReload] = useState(0);
  const catalogRequest = useRef(0);
  const detailRequest = useRef(0);
  const fileRequest = useRef(0);
  const previewRef = useRef<SkillMarketPreviewView | undefined>(undefined);
  const selectedButton = useRef<HTMLButtonElement | null>(null);
  const detailHeading = useRef<HTMLHeadingElement | null>(null);
  const restoreCatalogFocus = useRef(false);
  const cursor = cursors[cursors.length - 1] ?? { token: "" };

  const resetPagination = useCallback(() => {
    setCursors([{ token: "" }]);
    setSelected(undefined);
    setMobileDetail(false);
  }, []);
  useEffect(() => {
    const request = ++catalogRequest.current;
    const abort = new AbortController();
    setCatalog({ kind: "loading" });
    const timer = window.setTimeout(() => {
      void controller.listSkillMarketCatalog({
        ...(cursor.revision === undefined ? {} : { expectedRevision: cursor.revision }),
        query,
        category,
        sort,
        pageToken: cursor.token,
        pageSize: 24,
        signal: abort.signal
      }).then((value) => {
        if (!abort.signal.aborted && request === catalogRequest.current) setCatalog({ kind: "ready", value });
      }).catch((cause: unknown) => {
        if (!abort.signal.aborted && request === catalogRequest.current) setCatalog({ kind: "error", message: errorMessage(cause, t) });
      });
    }, 80);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [category, controller, cursor.revision, cursor.token, query, reload, sort, t]);

  useEffect(() => {
    const request = ++detailRequest.current;
    const abort = new AbortController();
    const prior = previewRef.current;
    previewRef.current = undefined;
    if (prior !== undefined) void controller.closeSkillMarketPreview(prior.id).catch(() => undefined);
    setSelectedFile(undefined);
    setFile(undefined);
    if (selected === undefined) {
      setDetail(undefined);
      return () => abort.abort();
    }
    setDetail({ kind: "loading" });
    let opened: SkillMarketPreviewView | undefined;
    void controller.getSkillMarketEntry(selected, abort.signal).then(async (entry) => {
      const preview = await controller.openSkillMarketPreview(entry.identity, abort.signal);
      opened = preview;
      const files = await controller.listSkillMarketPreviewFiles(preview, "", 100, abort.signal);
      if (abort.signal.aborted || request !== detailRequest.current) {
        void controller.closeSkillMarketPreview(preview.id).catch(() => undefined);
        return;
      }
      previewRef.current = preview;
      setDetail({ kind: "ready", value: { entry, preview, files } });
      setSelectedFile(files.files.find((entry) => entry.kind === "file" && entry.key.toLocaleLowerCase("en-US") === "skill.md")?.key
        ?? files.files.find((entry) => entry.kind === "file")?.key);
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted && request === detailRequest.current) setDetail({ kind: "error", message: errorMessage(cause, t) });
    });
    return () => {
      abort.abort();
      if (opened !== undefined) {
        if (previewRef.current?.id === opened.id) previewRef.current = undefined;
        void controller.closeSkillMarketPreview(opened.id).catch(() => undefined);
      }
    };
  }, [controller, detailReload, selected?.contentRevision, selected?.entryRevision, selected?.sourceRevision, t]);

  const readyDetail = detail?.kind === "ready" ? detail.value : undefined;
  useEffect(() => {
    const request = ++fileRequest.current;
    const abort = new AbortController();
    if (readyDetail === undefined || selectedFile === undefined) {
      setFile(undefined);
      return () => abort.abort();
    }
    setFile({ kind: "loading" });
    void controller.readSkillMarketPreviewFile(readyDetail.preview, selectedFile, abort.signal).then((value) => {
      if (!abort.signal.aborted && request === fileRequest.current && previewRef.current?.id === readyDetail.preview.id) setFile({ kind: "ready", value });
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted && request === fileRequest.current) setFile({ kind: "error", message: errorMessage(cause, t) });
    });
    return () => abort.abort();
  }, [controller, readyDetail?.preview.id, selectedFile, t]);

  useEffect(() => {
    if (mobileDetail && detail?.kind === "ready" && window.innerWidth <= 720) detailHeading.current?.focus();
  }, [detail?.kind, mobileDetail]);

  useEffect(() => {
    if (mobileDetail || !restoreCatalogFocus.current) return;
    const frame = window.requestAnimationFrame(() => {
      const target = selectedButton.current;
      if (target === null || !target.isConnected) return;
      target.focus({ preventScroll: true });
      if (target.ownerDocument.activeElement === target) restoreCatalogFocus.current = false;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [catalog.kind, mobileDetail, selected?.entryId, selected?.sourceId]);

  const loadMoreFiles = (): void => {
    if (readyDetail?.files.nextPageToken === undefined) return;
    const expectedPreview = readyDetail.preview;
    const token = readyDetail.files.nextPageToken;
    void controller.listSkillMarketPreviewFiles(expectedPreview, token, 100).then((next) => {
      if (previewRef.current?.id !== expectedPreview.id || detail?.kind !== "ready") return;
      const keys = new Set(detail.value.files.files.map((entry) => entry.key));
      if (next.files.some((entry) => keys.has(entry.key))) return;
      setDetail({ kind: "ready", value: { ...detail.value, files: { ...next, files: [...detail.value.files.files, ...next.files] } } });
    }).catch((cause: unknown) => {
      if (previewRef.current?.id === expectedPreview.id) setDetail({ kind: "error", message: errorMessage(cause, t) });
    });
  };

  const page = catalog.kind === "ready" ? catalog.value : undefined;
  const selectEntry = (entry: SkillMarketEntryView): void => {
    setSelected(entry.identity);
    setMobileDetail(true);
  };
  return <>
    <section className={cx("skill-market-browser", mobileDetail && "skill-market-browser--mobile-detail")} aria-label={t("skills.market.title")}>
      <section className="skill-market-catalog">
        <header className="skill-market-controls">
          <label className="skill-market-search"><Search aria-hidden="true" /><span className="sr-only">{t("skills.market.search")}</span><input type="search" value={query} placeholder={t("skills.market.searchPlaceholder")} onChange={(event) => { setQuery(event.target.value); resetPagination(); }} /></label>
          <SelectControl aria-label={t("skills.market.category")} value={category} onChange={(event) => { setCategory(event.target.value); resetPagination(); }}><option value="">{t("skills.market.allCategories")}</option>{(page?.categories ?? []).map((value) => <option value={value} key={value}>{value}</option>)}</SelectControl>
          <SelectControl aria-label={t("skills.market.sort.label")} value={sort} onChange={(event) => { setSort(event.target.value as SkillMarketSortView); resetPagination(); }}>{(["trending", "downloads", "updated", "created"] as const).map((value) => <option value={value} key={value}>{t(`skills.market.sort.${value}`)}</option>)}</SelectControl>
          <IconButton label={t("common.refresh")} onClick={() => setReload((value) => value + 1)}><RefreshCcw aria-hidden="true" /></IconButton>
        </header>
        {catalog.kind === "loading" && <LoadingState message={t("skills.market.loading")} />}
        {catalog.kind === "error" && <ErrorState message={catalog.message} retry={() => setReload((value) => value + 1)} t={t} />}
        {page !== undefined && page.sourceCount === 0 && <EmptyState icon={<FolderOpen />} title={t("skills.market.noSources")} body={t("skills.market.noSourcesBody")} action={<Button tone="primary" onClick={onOpenSources}>{t("skills.market.manageSources")}</Button>} />}
        {page !== undefined && page.sourceCount > 0 && page.entries.length === 0 && <EmptyState icon={<Sparkles />} title={t("skills.market.empty")} body={t("skills.market.emptyBody")} />}
        {page !== undefined && page.entries.length > 0 && <div className="skill-market-card-list">{page.entries.map((entry) => <button
          ref={selected?.entryId === entry.identity.entryId && selected.sourceId === entry.identity.sourceId ? selectedButton : undefined}
          type="button"
          className={cx("skill-market-card", selected?.entryId === entry.identity.entryId && selected.sourceId === entry.identity.sourceId && "is-active")}
          key={`${entry.identity.sourceId}:${entry.identity.entryId}`}
          onClick={() => selectEntry(entry)}
        ><span className="skill-market-card__icon"><Sparkles aria-hidden="true" /></span><span className="skill-market-card__copy"><strong>{entry.name}</strong><small>{entry.description || t("skills.market.noDescription")}</small><span><MarketStatusPill entry={entry} t={t} />{entry.category !== undefined && <Pill tone={entry.sourceState === "ready" ? "neutral" : "danger"}>{entry.category}</Pill>}<em>v{entry.version}</em><em>{t("skills.market.downloads", { count: entry.downloads })}</em></span></span><ChevronRight aria-hidden="true" /></button>)}</div>}
        {page !== undefined && <footer className="skill-market-pagination"><span>{t("skills.market.results", { count: page.totalSize })}</span><div><Button disabled={cursors.length === 1} onClick={() => setCursors((value) => value.slice(0, -1))}>{t("common.previous")}</Button><Button disabled={page.nextPageToken === undefined} onClick={() => {
          if (page.nextPageToken !== undefined) setCursors((value) => [...value, { token: page.nextPageToken!, revision: page.revision }]);
        }}>{t("common.next")}</Button></div></footer>}
      </section>
      <section className="skill-market-detail-pane">
        <button type="button" className="skill-market-detail__back" onClick={() => { restoreCatalogFocus.current = true; setMobileDetail(false); }}><ArrowLeft aria-hidden="true" />{t("common.back")}</button>
        {selected === undefined && <EmptyState icon={<Sparkles />} title={t("skills.market.selectTitle")} body={t("skills.market.selectBody")} />}
        {selected !== undefined && detail?.kind === "loading" && <LoadingState message={t("skills.market.opening")} />}
        {selected !== undefined && detail?.kind === "error" && <ErrorState message={detail.message} retry={() => setDetailReload((value) => value + 1)} t={t} />}
        {readyDetail !== undefined && <article className="skill-market-detail">
          <header><div><p className="eyebrow">{readyDetail.entry.sourceDisplayName ?? readyDetail.entry.sourceName}</p><h2 ref={detailHeading} tabIndex={-1}>{readyDetail.entry.name}</h2><p>{readyDetail.entry.description || t("skills.market.noDescription")}</p></div><Pill tone={readyDetail.entry.sourceState === "ready" ? "success" : "danger"}>v{readyDetail.entry.version}</Pill></header>
          {readyDetail.entry.sourceError !== undefined && <InlineNotice tone="error" message={readyDetail.entry.sourceError} />}
          <dl className="skill-market-metadata"><div><dt>{t("skills.market.author")}</dt><dd>{readyDetail.entry.author ?? t("common.unknown")}</dd></div><div><dt>{t("skills.market.category")}</dt><dd>{readyDetail.entry.category ?? t("common.unknown")}</dd></div><div><dt>{t("skills.market.updated")}</dt><dd>{formatRelativeTime(readyDetail.entry.updatedAt, locale)}</dd></div><div><dt>{t("skills.market.size")}</dt><dd>{formatBytes(readyDetail.entry.archiveBytes)}</dd></div></dl>
          <div className="skill-market-tags">{readyDetail.entry.tags.map((tag) => <Pill key={tag}>{tag}</Pill>)}</div>
          <MarketInstallStatusDetails entry={readyDetail.entry} backends={backends} targets={targets} t={t} />
          <div className="skill-market-detail__actions"><Button tone="primary" disabled={readyDetail.entry.sourceState !== "ready"} onClick={() => setInstallEntry(readyDetail.entry)}><Download aria-hidden="true" />{t("skills.market.install.open")}</Button><span>{t("skills.market.preview.summary", { files: readyDetail.preview.files, size: formatBytes(readyDetail.preview.bytes) })}</span></div>
          <section className="skill-market-files" aria-label={t("skills.market.preview.files") }><div className="skill-market-file-list">{readyDetail.files.files.map((entry) => <button type="button" disabled={entry.kind === "directory"} className={cx(selectedFile === entry.key && "is-active")} key={entry.key} onClick={() => setSelectedFile(entry.key)}>{entry.kind === "directory" ? <Folder aria-hidden="true" /> : <File aria-hidden="true" />}<span>{entry.key}</span><small>{entry.kind === "file" ? formatBytes(entry.size) : t("skills.market.preview.folder")}</small></button>)}{readyDetail.files.nextPageToken !== undefined && <Button tone="ghost" onClick={loadMoreFiles}>{t("skills.market.preview.more")}</Button>}</div><div className="skill-market-file-preview">{selectedFile === undefined && <EmptyState icon={<File />} title={t("skills.market.preview.selectFile")} body={t("skills.market.preview.selectFileBody")} />}{file?.kind === "loading" && <LoadingState message={t("skills.market.preview.loadingFile")} />}{file?.kind === "error" && <ErrorState message={file.message} retry={() => { const key = selectedFile; setSelectedFile(undefined); window.setTimeout(() => setSelectedFile(key), 0); }} t={t} />}{file?.kind === "ready" && (file.value.previewable ? <pre>{file.value.content}</pre> : <EmptyState icon={<File />} title={t("skills.market.preview.unavailable")} body={t(`skills.market.preview.reason.${file.value.unavailableReason ?? "binary"}`)} />)}</div></section>
        </article>}
      </section>
    </section>
    {installEntry !== undefined && <SkillMarketInstallDialog controller={controller} entry={installEntry} backends={backends} targets={targets} locale={locale} t={t} onClose={() => setInstallEntry(undefined)} onChanged={() => { setDetailReload((value) => value + 1); setReload((value) => value + 1); }} />}
  </>;
}

type MarketAggregateStatus = "notInstalled" | "installed" | "updateAvailable" | "conflict";

function marketAggregateStatus(entry: SkillMarketEntryView): MarketAggregateStatus {
  if (entry.installStatuses.some((status) => status.state === "conflict")) return "conflict";
  if (entry.installStatuses.some((status) => status.state === "updateAvailable")) return "updateAvailable";
  if (entry.installStatuses.length > 0) return "installed";
  return "notInstalled";
}

function MarketStatusPill({ entry, t }: { readonly entry: SkillMarketEntryView; readonly t: Translator }): JSX.Element {
  const state = marketAggregateStatus(entry);
  return <Pill tone={state === "installed" ? "success" : state === "updateAvailable" ? "warning" : state === "conflict" ? "danger" : "neutral"}>{t(`skills.market.status.${state}`)}</Pill>;
}

function MarketInstallStatusDetails({ entry, backends, targets, t }: {
  readonly entry: SkillMarketEntryView;
  readonly backends: readonly BackendView[];
  readonly targets: readonly TargetView[];
  readonly t: Translator;
}): JSX.Element {
  const state = marketAggregateStatus(entry);
  return <section className="skill-market-placement-status" aria-label={t("skills.market.status.title")}>
    <header><div><h3>{t("skills.market.status.title")}</h3><p>{t(`skills.market.status.body.${state}`)}</p></div><MarketStatusPill entry={entry} t={t} /></header>
    {entry.installStatuses.length > 0 && <ul>{entry.installStatuses.map((status) => {
      const backend = backends.find((candidate) => candidate.id === status.backendId)?.name ?? status.backendId;
      const target = status.targetId === undefined ? undefined : targets.find((candidate) => candidate.id === status.targetId)?.name ?? status.targetId;
      return <li key={status.resourceId}><span><strong>{status.scope === "global"
        ? t("skills.market.status.placement.global", { backend })
        : t("skills.market.status.placement.project", { backend, target: target ?? t("common.unknown"), parent: status.relativeParent ?? t("common.unknown") })}</strong><small>{status.installedVersion === undefined ? t("skills.market.status.versionUnknown") : t("skills.market.status.version", { version: status.installedVersion })}</small></span><Pill tone={status.state === "installed" ? "success" : status.state === "updateAvailable" ? "warning" : "danger"}>{t(`skills.market.status.${status.state}`)}</Pill></li>;
    })}</ul>}
  </section>;
}

function SkillMarketInstallDialog({ controller, entry, backends, targets, locale, t, onClose, onChanged }: {
  readonly controller: AppController;
  readonly entry: SkillMarketEntryView;
  readonly backends: readonly BackendView[];
  readonly targets: readonly TargetView[];
  readonly locale: string;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}): JSX.Element {
  const capableBackends = useMemo(() => backends.filter((backend) => resourceKindsForBackend(backend).includes("skill")), [backends]);
  const [backendId, setBackendId] = useState(capableBackends[0]?.id ?? "");
  const [scope, setScope] = useState<"global" | "project">("global");
  const projectTargets = useMemo(() => targets.filter((target) => target.backendId === backendId && target.trusted && !target.archived), [backendId, targets]);
  const [targetId, setTargetId] = useState("");
  const [customParent, setCustomParent] = useState(false);
  const [relativeParent, setRelativeParent] = useState("");
  const [plan, setPlan] = useState<LoadState<SkillMarketInstallPlanView>>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [installed, setInstalled] = useState<SkillDescriptorView>();
  const [removeConfirmation, setRemoveConfirmation] = useState("");
  const [policy, setPolicy] = useState<SkillMarketSyncPolicyView>();
  const [jobs, setJobs] = useState<readonly SkillMarketSyncJobView[]>([]);
  const [syncError, setSyncError] = useState<string>();
  const [syncLoading, setSyncLoading] = useState(false);
  const planRef = useRef<SkillMarketInstallPlanView | undefined>(undefined);
  const planAbort = useRef<AbortController | undefined>(undefined);
  const planRequest = useRef(0);
  const generation = useRef(0);
  const controllerRef = useRef(controller);
  controllerRef.current = controller;

  useEffect(() => {
    if (capableBackends.some((backend) => backend.id === backendId)) return;
    const nextBackendId = capableBackends[0]?.id ?? "";
    planAbort.current?.abort();
    planAbort.current = undefined;
    planRequest.current += 1;
    const current = planRef.current;
    planRef.current = undefined;
    if (current !== undefined) void controller.closeSkillMarketInstallPlan(current.id).catch(() => undefined);
    setPlan(undefined);
    setInstalled(undefined);
    setPolicy(undefined);
    setJobs([]);
    setConfirmed(false);
    setRemoveConfirmation("");
    setBackendId(nextBackendId);
  }, [backendId, capableBackends, controller]);

  useEffect(() => {
    if (scope === "project" && !projectTargets.some((target) => target.id === targetId)) setTargetId(projectTargets[0]?.id ?? "");
  }, [projectTargets, scope, targetId]);

  useEffect(() => () => {
    generation.current += 1;
    planAbort.current?.abort();
    const current = planRef.current;
    if (current !== undefined) void controllerRef.current.closeSkillMarketInstallPlan(current.id).catch(() => undefined);
  }, []);

  const target: SkillMarketInstallTargetView | undefined = backendId === "" || (scope === "project" && targetId === "")
    ? undefined
    : {
        backendId,
        scope,
        ...(scope === "project" ? { targetId } : {}),
        ...(scope === "project" && customParent && relativeParent.trim() !== "" ? { relativeParent: relativeParent.trim() } : {})
      };

  const resetPlan = (): void => {
    planAbort.current?.abort();
    planAbort.current = undefined;
    planRequest.current += 1;
    const current = planRef.current;
    planRef.current = undefined;
    if (current !== undefined) void controller.closeSkillMarketInstallPlan(current.id).catch(() => undefined);
    setPlan(undefined);
    setInstalled(undefined);
    setPolicy(undefined);
    setJobs([]);
    setConfirmed(false);
    setRemoveConfirmation("");
  };

  const createPlan = (): void => {
    if (target === undefined || busy) return;
    const abort = new AbortController();
    resetPlan();
    const effectiveRequest = ++planRequest.current;
    planAbort.current = abort;
    setPlan({ kind: "loading" });
    setError(undefined);
    void controller.createSkillMarketInstallPlan(entry.identity, target, abort.signal).then((value) => {
      if (effectiveRequest !== planRequest.current) {
        void controller.closeSkillMarketInstallPlan(value.id).catch(() => undefined);
        return;
      }
      planAbort.current = undefined;
      planRef.current = value;
      setPlan({ kind: "ready", value });
      void loadSync(value.preview.currentResource?.resourceId);
    }).catch((cause: unknown) => {
      if (effectiveRequest === planRequest.current && !abort.signal.aborted) {
        planAbort.current = undefined;
        setPlan({ kind: "error", message: errorMessage(cause, t) });
      }
    });
  };

  const loadSync = async (resourceId?: string): Promise<void> => {
    if (resourceId === undefined) {
      setPolicy(undefined);
      setJobs([]);
      return;
    }
    setSyncLoading(true);
    setSyncError(undefined);
    try {
      const [policies, jobCatalog] = await Promise.all([
        controller.listSkillMarketSyncPolicies(),
        controller.listSkillMarketSyncJobs(resourceId)
      ]);
      setPolicy(policies.items.find((value) => value.resourceId === resourceId));
      setJobs(jobCatalog.items);
      if (policies.recoveredFromCorruption || jobCatalog.recoveredFromCorruption) setSyncError(t("skills.market.sync.recovered"));
    } catch (cause) {
      setSyncError(errorMessage(cause, t));
    } finally {
      setSyncLoading(false);
    }
  };

  const mutate = (action: () => Promise<void>, succeeded?: () => void): void => {
    if (busy) return;
    const owner = generation.current;
    setBusy(true);
    setError(undefined);
    void action().then(() => {
      if (owner !== generation.current) return;
      succeeded?.();
      onChanged();
    }).catch((cause: unknown) => {
      if (owner === generation.current) setError(errorMessage(cause, t));
    }).finally(() => {
      if (owner === generation.current) setBusy(false);
    });
  };

  const readyPlan = plan?.kind === "ready" ? plan.value : undefined;
  const syncResource = installed === undefined
    ? readyPlan?.preview.currentResource
    : { resourceId: installed.id, resourceRevision: installed.revision };
  const install = (): void => {
    if (readyPlan === undefined) return;
    mutate(async () => {
      const result = await controller.installSkillMarketPlan(readyPlan, confirmed);
      if (result.skill === undefined) throw new Error(t("skills.market.install.missingResult"));
      setInstalled(result.skill);
      await loadSync(result.skill.id);
    });
  };
  const uninstall = (): void => {
    const currentPlan = readyPlan;
    const current = currentPlan?.preview.currentResource;
    if (currentPlan === undefined || current === undefined || removeConfirmation !== current.name) return;
    mutate(async () => {
      const catalog = await controller.listSkills({
        backendId: currentPlan.target.backendId,
        ...(currentPlan.target.targetId === undefined ? {} : { targetId: currentPlan.target.targetId }),
        scope: currentPlan.target.scope
      });
      const skill = catalog.skills.find((value) => value.id === current.resourceId);
      if (skill === undefined) throw new Error(t("skills.market.install.ownerChanged"));
      const session = await controller.openSkill(skill.id, skill.revision);
      try {
        await controller.deleteSkill(session, removeConfirmation);
      } finally {
        await controller.closeSkill(session.id).catch(() => undefined);
      }
      onClose();
    });
  };

  const syncMutate = (action: () => Promise<void>): void => mutate(async () => {
    await action();
    await loadSync(syncResource?.resourceId);
  });

  return <Modal open title={t("skills.market.install.title", { name: entry.name })} description={t("skills.market.install.body")} size="large" className="skill-market-install-modal" dismissOnBackdrop={!busy} onClose={() => { if (!busy) { generation.current += 1; onClose(); } }}>
    <div className="skill-market-install">
      <section className="skill-market-target-picker" aria-label={t("skills.market.install.targetTitle")}>
        <h3>{t("skills.market.install.targetTitle")}</h3>
        {capableBackends.length === 0 ? <InlineNotice tone="error" message={t("skills.market.install.noBackend")} /> : <>
          <label><span>{t("skills.market.install.backend")}</span><SelectControl value={backendId} disabled={busy || readyPlan !== undefined} onChange={(event) => { setBackendId(event.target.value); resetPlan(); }}>{capableBackends.map((backend) => <option key={backend.id} value={backend.id}>{backend.name}</option>)}</SelectControl></label>
          <fieldset disabled={busy || readyPlan !== undefined}><legend>{t("skills.market.install.scope")}</legend><label><input type="radio" name="skill-market-scope" checked={scope === "global"} onChange={() => { setScope("global"); resetPlan(); }} /><Globe2 aria-hidden="true" /><span>{t("skills.scopeGlobal")}</span></label><label><input type="radio" name="skill-market-scope" checked={scope === "project"} onChange={() => { setScope("project"); resetPlan(); }} /><FolderOpen aria-hidden="true" /><span>{t("skills.scopeProject")}</span></label></fieldset>
          {scope === "project" && <><label><span>{t("skills.market.install.project")}</span><SelectControl value={targetId} disabled={busy || readyPlan !== undefined} onChange={(event) => { setTargetId(event.target.value); resetPlan(); }}><option value="">{t("skills.market.install.chooseProject")}</option>{projectTargets.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</SelectControl></label>{projectTargets.length === 0 && <InlineNotice tone="warning" message={t("skills.market.install.noTrustedProject")} />}<label className="skill-market-custom-parent"><CheckboxControl checked={customParent} disabled={busy || readyPlan !== undefined} onChange={(event) => { setCustomParent(event.target.checked); resetPlan(); }} /><span>{t("skills.market.install.customParent")}</span></label>{customParent && <label><span>{t("skills.market.install.parent")}</span><input value={relativeParent} disabled={busy || readyPlan !== undefined} placeholder=".agents/skills" onChange={(event) => { setRelativeParent(event.target.value); resetPlan(); }} /></label>}</>}
        </>}
        {readyPlan === undefined && <Button tone="primary" disabled={busy || target === undefined} onClick={createPlan}>{t("skills.market.install.review")}</Button>}
      </section>
      {plan?.kind === "loading" && <LoadingState message={t("skills.market.install.planning")} />}
      {plan?.kind === "error" && <ErrorState message={plan.message} retry={createPlan} t={t} />}
      {readyPlan !== undefined && <section className="skill-market-plan">
        <header><div><p className="eyebrow">{t(`skills.market.install.action.${readyPlan.preview.action}`)}</p><h3>{readyPlan.preview.name} · v{readyPlan.preview.availableVersion}</h3><p>{t("skills.market.install.summary", { files: readyPlan.preview.files, size: formatBytes(readyPlan.preview.bytes) })}</p></div><Pill tone={readyPlan.preview.action === "replace" ? "warning" : "success"}>{t(`skills.market.install.action.${readyPlan.preview.action}`)}</Pill></header>
        {readyPlan.preview.currentResource !== undefined && <dl className="skill-market-current"><div><dt>{t("skills.market.install.currentVersion")}</dt><dd>{readyPlan.preview.currentResource.version ?? t("common.unknown")}</dd></div><div><dt>{t("skills.market.install.currentSource")}</dt><dd>{readyPlan.preview.currentResource.sourceDisplay}</dd></div><div><dt>{t("skills.market.install.localChanges")}</dt><dd>{readyPlan.preview.currentResource.dirty ? t("common.yes") : t("common.no")}</dd></div><div><dt>{t("skills.market.install.enabledPreserved")}</dt><dd>{readyPlan.preview.preservesEnabled ? t("common.yes") : t("common.no")}</dd></div></dl>}
        {readyPlan.confirmationReasons.length > 0 && <div className="skill-market-confirmation-reasons" role="alert"><AlertTriangle aria-hidden="true" /><div><strong>{t("skills.market.install.confirmTitle")}</strong><ul>{readyPlan.confirmationReasons.map((reason) => <li key={reason}>{t(`skills.market.install.reason.${reason}`)}</li>)}</ul></div></div>}
        <section className="skill-market-plan-diff"><h4>{t("skills.market.install.changes")}</h4>{!readyPlan.preview.diffAvailable ? <p>{readyPlan.preview.diffReason ?? t("skills.market.install.diffUnavailable")}</p> : readyPlan.preview.changes.length === 0 ? <p className="skill-market-diff-clean"><CheckCircle2 aria-hidden="true" />{t("skills.market.install.noChanges")}</p> : readyPlan.preview.changes.map((change) => <article key={`${change.kind}:${change.key}`}><header><FileDiff aria-hidden="true" /><strong>{change.key}</strong><Pill tone={change.kind === "added" ? "success" : change.kind === "deleted" ? "danger" : "warning"}>{t(`skills.diff.${change.kind}`)}</Pill></header>{change.binary ? <p>{t("skills.diffBinary")}</p> : <pre>{change.unifiedDiff}</pre>}</article>)}</section>
        {readyPlan.requiresConfirmation && <label className="skill-market-confirm"><CheckboxControl checked={confirmed} disabled={busy || installed !== undefined} onChange={(event) => setConfirmed(event.target.checked)} /><span>{t("skills.market.install.confirm")}</span></label>}
        {installed !== undefined && <InlineNotice tone="success" message={t("skills.market.install.complete", { name: installed.name })} />}
        {error !== undefined && <InlineNotice tone="error" message={error} />}
        <div className="skill-market-plan__actions"><Button disabled={busy} onClick={resetPlan}>{t("skills.market.install.changeTarget")}</Button><Button tone="primary" disabled={busy || installed !== undefined || (readyPlan.requiresConfirmation && !confirmed)} onClick={install}>{busy ? t("common.working") : t(`skills.market.install.action.${readyPlan.preview.action}`)}</Button></div>
        {readyPlan.preview.currentResource !== undefined && installed === undefined && <section className="skill-market-uninstall"><h4>{t("skills.market.install.uninstallTitle")}</h4><p>{t("skills.market.install.uninstallBody", { name: readyPlan.preview.currentResource.name })}</p><label><span>{t("skills.deleteConfirmation")}</span><input value={removeConfirmation} disabled={busy} onChange={(event) => setRemoveConfirmation(event.target.value)} /></label><Button tone="danger" disabled={busy || removeConfirmation !== readyPlan.preview.currentResource.name} onClick={uninstall}><Trash2 aria-hidden="true" />{t("skills.market.install.uninstall")}</Button></section>}
        {syncResource !== undefined && <section className="skill-market-sync"><header><div><h4>{t("skills.market.sync.title")}</h4><p>{t("skills.market.sync.body")}</p></div>{syncLoading && <LoaderCircle className="spin" aria-label={t("common.loading")} />}</header>{syncError !== undefined && <InlineNotice tone={syncError === t("skills.market.sync.recovered") ? "warning" : "error"} message={syncError} />}{policy === undefined ? <Button disabled={busy || syncLoading} onClick={() => syncMutate(() => controller.enableSkillMarketSync(syncResource.resourceId, syncResource.resourceRevision, readyPlan.target))}>{t("skills.market.sync.enable")}</Button> : <><div className="skill-market-sync__policy"><span><strong>{policy.enabled ? t("skills.market.sync.enabled") : t("skills.market.sync.disabled")}</strong><small>{t("skills.market.sync.updated", { time: formatRelativeTime(policy.updatedAt, locale) })}</small></span><div>{policy.enabled ? <><Button disabled={busy || syncLoading} onClick={() => syncMutate(() => controller.enqueueSkillMarketSync(policy))}><RefreshCcw aria-hidden="true" />{t("skills.market.sync.now")}</Button><Button disabled={busy || syncLoading} onClick={() => syncMutate(() => controller.disableSkillMarketSync(policy))}>{t("skills.market.sync.disable")}</Button></> : <Button disabled={busy || syncLoading} onClick={() => syncMutate(() => controller.enableSkillMarketSync(syncResource.resourceId, syncResource.resourceRevision, readyPlan.target))}>{t("skills.market.sync.enable")}</Button>}</div></div><div className="skill-market-sync__jobs">{jobs.length === 0 ? <p>{t("skills.market.sync.noJobs")}</p> : jobs.map((job) => <article key={job.id}><span><Pill tone={syncJobTone(job)}>{t(`skills.market.sync.state.${job.state}`)}</Pill><small>{formatRelativeTime(job.updatedAt, locale)} · {t("skills.market.sync.attempt", { count: job.attempt })}</small>{job.outcome !== undefined && <em>{t(`skills.market.sync.outcome.${job.outcome}`)}</em>}{job.error !== undefined && <em role="alert">{job.error}</em>}</span>{isActiveSyncJob(job) ? <Button disabled={busy} onClick={() => syncMutate(() => controller.cancelSkillMarketSync(job))}>{t("common.cancel")}</Button> : isRetryableSyncJob(job) ? <Button disabled={busy || !policy.enabled} onClick={() => syncMutate(() => controller.retrySkillMarketSync(job))}>{t("common.retry")}</Button> : null}</article>)}</div></>}</section>}
      </section>}
      <div className="modal__actions"><Button disabled={busy} onClick={() => { generation.current += 1; onClose(); }}>{t("common.close")}</Button></div>
    </div>
  </Modal>;
}

function isActiveSyncJob(job: SkillMarketSyncJobView): boolean {
  return job.state === "pendingRevalidation" || job.state === "running" || job.state === "cancelling";
}

function isRetryableSyncJob(job: SkillMarketSyncJobView): boolean {
  return job.state === "failed" || job.state === "blocked" || job.state === "cancelled";
}

function syncJobTone(job: SkillMarketSyncJobView): "success" | "warning" | "danger" | "neutral" {
  if (job.state === "succeeded" || job.state === "upToDate") return "success";
  if (job.state === "failed") return "danger";
  if (job.state === "blocked" || job.state === "cancelled") return "warning";
  return "neutral";
}

function LoadingState({ message }: { readonly message: string }): JSX.Element {
  return <div className="skill-market-load" role="status"><RefreshCcw className="spin" aria-hidden="true" /><span>{message}</span></div>;
}

function ErrorState({ message, retry, t }: { readonly message: string; readonly retry: () => void; readonly t: Translator }): JSX.Element {
  return <div className="skill-market-load is-error" role="alert"><AlertTriangle aria-hidden="true" /><span>{message}</span><Button onClick={retry}><RefreshCcw aria-hidden="true" />{t("common.retry")}</Button></div>;
}

function InlineNotice({ tone, message }: { readonly tone: "success" | "warning" | "error"; readonly message: string }): JSX.Element {
  return <p className={cx("skill-market-notice", `is-${tone}`)} role={tone === "error" ? "alert" : "status"}>{tone === "success" ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}{message}</p>;
}

function errorMessage(cause: unknown, t: Translator): string {
  return cause instanceof Error && cause.message.trim() !== "" ? cause.message : t("skills.market.requestError");
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}
