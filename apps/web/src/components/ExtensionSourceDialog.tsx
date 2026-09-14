import { useEffect, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import { AlertTriangle, FolderOpen, GitBranch, Plus, RefreshCcw, Trash2 } from "lucide-react";

import type { AppController } from "../controller.js";
import type { ExtensionSourceCatalogView, ExtensionSourceDraft, ExtensionSourceGitPreflightView, ExtensionSourceView } from "../model.js";
import type { RunAction, Translator } from "./types.js";
import { Button, EmptyState, Modal, Pill, SelectControl, formatRelativeTime } from "./ui.js";

export function ExtensionSourceDialog({ controller, locale, open, t, runAction, onClose, onCatalogChanged }: {
  readonly controller: AppController;
  readonly locale: string;
  readonly open: boolean;
  readonly t: Translator;
  readonly runAction: RunAction;
  readonly onClose: () => void;
  readonly onCatalogChanged: () => void;
}): JSX.Element {
  const [catalog, setCatalog] = useState<ExtensionSourceCatalogView>();
  const [preflight, setPreflight] = useState<ExtensionSourceGitPreflightView>();
  const [loading, setLoading] = useState(false);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [preflightError, setPreflightError] = useState<string>();
  const [reloadRevision, setReloadRevision] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false);
  const [kind, setKind] = useState<ExtensionSourceDraft["kind"]>("local");
  const [localPath, setLocalPath] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [sparsePaths, setSparsePaths] = useState("");
  const [mutationKey, setMutationKey] = useState<string>();
  const [mutationError, setMutationError] = useState<string>();
  const [removeCandidate, setRemoveCandidate] = useState<ExtensionSourceView>();
  const dialogGeneration = useRef(0);
  const loadRequest = useRef(0);

  useEffect(() => {
    dialogGeneration.current += 1;
    if (!open) {
      setEditorOpen(false);
      setMutationKey(undefined);
      setMutationError(undefined);
      setRemoveCandidate(undefined);
      return;
    }
    setMutationError(undefined);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    const request = ++loadRequest.current;
    setLoading(true);
    setLoadError(undefined);
    void controller.listExtensionSources(abort.signal).then((next) => {
      if (!abort.signal.aborted && request === loadRequest.current) {
        setCatalog(next);
        if (next.sources.length === 0) setEditorOpen(true);
      }
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted && request === loadRequest.current) setLoadError(sourceErrorMessage(cause, t));
    }).finally(() => {
      if (!abort.signal.aborted && request === loadRequest.current) setLoading(false);
    });
    return () => abort.abort();
  }, [controller, open, reloadRevision, t]);

  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setPreflightLoading(true);
    setPreflightError(undefined);
    void controller.getExtensionSourceGitPreflight(abort.signal).then((next) => {
      if (!abort.signal.aborted) setPreflight(next);
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted) {
        setPreflight(undefined);
        setPreflightError(sourceErrorMessage(cause, t));
      }
    }).finally(() => {
      if (!abort.signal.aborted) setPreflightLoading(false);
    });
    return () => abort.abort();
  }, [controller, open, t]);

  const mutate = (key: string, action: () => Promise<void>, onSucceeded?: () => void): void => {
    if (mutationKey !== undefined) return;
    const generation = dialogGeneration.current;
    setMutationKey(key);
    setMutationError(undefined);
    runAction(key, async () => {
      try {
        await action();
        if (generation === dialogGeneration.current) onSucceeded?.();
      } catch (cause) {
        if (generation === dialogGeneration.current) setMutationError(sourceErrorMessage(cause, t));
        throw cause;
      } finally {
        onCatalogChanged();
        // Completion is an external catalog change even when the initiating
        // dialog generation was closed. Reload through a fresh owner request;
        // never apply the old operation's local editor/error state.
        setReloadRevision((value) => value + 1);
        if (generation === dialogGeneration.current) {
          setMutationKey((current) => current === key ? undefined : current);
        }
      }
    });
  };

  const submitSource = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (catalog === undefined) return;
    const draft: ExtensionSourceDraft = kind === "local"
      ? { kind: "local", path: localPath.trim() }
      : {
          kind: "git",
          repositoryUrl: repositoryUrl.trim(),
          ...(gitRef.trim() === "" ? {} : { ref: gitRef.trim() }),
          sparsePaths: sparsePaths.split(/\r?\n/u).map((value) => value.trim()).filter((value) => value !== "")
        };
    mutate("add-extension-source", () => controller.addExtensionSource(draft, catalog.revision), () => {
      setLocalPath("");
      setRepositoryUrl("");
      setGitRef("");
      setSparsePaths("");
      setEditorOpen(false);
    });
  };

  const inputReady = kind === "local"
    ? localPath.trim() !== ""
    : repositoryUrl.trim() !== "" && preflight?.available === true;
  const busy = mutationKey !== undefined;
  const closeDialog = (): void => {
    dialogGeneration.current += 1;
    onClose();
  };
  return <>
    <Modal open={open} title={t("extensions.sources.title")} description={t("extensions.sources.body")} size="large" className="extension-source-modal" showClose closeLabel={t("common.close")} onClose={closeDialog}>
      <div className="extension-sources" aria-busy={busy}>
        <div className="extension-sources__toolbar">
          <div>
            <strong>{t("extensions.sources.saved")}</strong>
            <small>{catalog === undefined ? t("extensions.sources.revisionUnknown") : t("extensions.sources.revision", { revision: catalog.revision.toString(10) })}</small>
          </div>
          <Button disabled={busy} onClick={() => setEditorOpen((value) => !value)}><Plus aria-hidden="true" />{editorOpen ? t("common.cancel") : t("extensions.sources.add")}</Button>
        </div>
        {catalog?.recoveredFromCorruption === true && <p className="extension-sources__warning" role="alert"><AlertTriangle aria-hidden="true" />{t("extensions.sources.recovered")}</p>}
        {editorOpen && <form className="extension-source-editor" onSubmit={submitSource}>
          <label><span>{t("extensions.sources.kind")}</span><SelectControl value={kind} disabled={busy} onChange={(event) => setKind(event.target.value as ExtensionSourceDraft["kind"])}><option value="local">{t("extensions.sources.local")}</option><option value="git">{t("extensions.sources.git")}</option></SelectControl></label>
          {kind === "local" ? <label><span>{t("extensions.sources.localPath")}</span><input autoComplete="off" value={localPath} disabled={busy} placeholder={t("extensions.sources.localPathPlaceholder")} onChange={(event) => setLocalPath(event.target.value)} /></label> : <>
            <label><span>{t("extensions.sources.repositoryUrl")}</span><input autoComplete="off" value={repositoryUrl} disabled={busy} placeholder={t("extensions.sources.repositoryUrlPlaceholder")} onChange={(event) => setRepositoryUrl(event.target.value)} /></label>
            <label><span>{t("extensions.sources.gitRef")}</span><input autoComplete="off" value={gitRef} disabled={busy} placeholder={t("extensions.sources.gitRefPlaceholder")} onChange={(event) => setGitRef(event.target.value)} /></label>
            <label><span>{t("extensions.sources.sparsePaths")}</span><textarea value={sparsePaths} disabled={busy} placeholder={t("extensions.sources.sparsePathsPlaceholder")} onChange={(event) => setSparsePaths(event.target.value)} /></label>
            <p className={preflight?.available === false || preflightError !== undefined ? "extension-source-editor__preflight is-error" : "extension-source-editor__preflight"}>{preflightLoading
              ? t("extensions.sources.gitChecking")
              : preflightError ?? (preflight?.available === true
                ? t("extensions.sources.gitReady", { version: preflight.version ?? t("common.unknown") })
                : t("extensions.sources.gitUnavailable", { version: preflight?.minimumVersion ?? t("common.unknown") }))}</p>
          </>}
          <div className="extension-source-editor__actions"><Button type="button" disabled={busy} onClick={() => setEditorOpen(false)}>{t("common.cancel")}</Button><Button type="submit" tone="primary" disabled={busy || catalog === undefined || !inputReady}>{t("extensions.sources.addAction")}</Button></div>
        </form>}
        {mutationError !== undefined && <p className="extension-sources__warning is-error" role="alert"><AlertTriangle aria-hidden="true" />{mutationError}</p>}
        {loading && <p className="extension-sources__status" role="status">{t("extensions.sources.loading")}</p>}
        {loadError !== undefined && <div className="extension-sources__status is-error" role="alert"><span>{loadError}</span><Button disabled={busy} onClick={() => setReloadRevision((value) => value + 1)}><RefreshCcw aria-hidden="true" />{t("common.retry")}</Button></div>}
        {!loading && loadError === undefined && catalog?.sources.length === 0 && <EmptyState icon={<FolderOpen />} title={t("extensions.sources.empty")} body={t("extensions.sources.emptyBody")} />}
        {loadError === undefined && catalog !== undefined && catalog.sources.length > 0 && <div className="extension-source-list">{catalog.sources.map((source) => <article className="extension-source-card" key={source.id}>
          <span className="extension-source-card__icon">{source.kind === "git" ? <GitBranch aria-hidden="true" /> : <FolderOpen aria-hidden="true" />}</span>
          <div className="extension-source-card__copy"><span><strong>{source.displayName ?? source.name}</strong><Pill tone={source.state === "ready" ? "success" : "danger"}>{source.state === "ready" ? t("extensions.sources.ready") : t("extensions.sources.error")}</Pill></span><small title={sourceLocationLabel(source)}>{sourceLocationLabel(source)}</small><small>{t("extensions.sources.counts", { extensions: source.discoveredExtensionCount, declared: source.declaredEntryCount, skipped: source.skippedEntryCount, unreadable: source.unreadableEntryCount })}</small><small>{source.refreshedAt === undefined ? t("extensions.sources.added", { time: formatRelativeTime(source.addedAt, locale) }) : t("extensions.sources.refreshed", { time: formatRelativeTime(source.refreshedAt, locale) })}</small>{source.error !== undefined && <em role="alert">{source.error}</em>}</div>
          <div className="extension-source-card__actions"><Button disabled={busy} onClick={() => mutate(`refresh-extension-source:${source.id}`, () => controller.refreshExtensionSource(source.id, source.revision))}><RefreshCcw aria-hidden="true" />{t("common.refresh")}</Button><Button tone="ghost" className="danger-text" disabled={busy} onClick={() => setRemoveCandidate(source)}><Trash2 aria-hidden="true" />{t("common.remove")}</Button></div>
        </article>)}</div>}
        <div className="modal__actions"><Button disabled={busy} onClick={closeDialog}>{t("common.close")}</Button></div>
      </div>
    </Modal>
    <Modal open={open && removeCandidate !== undefined} title={t("extensions.sources.removeTitle")} description={removeCandidate === undefined ? undefined : t("extensions.sources.removeBody", { name: removeCandidate.displayName ?? removeCandidate.name })} size="small" dialogRole="alertdialog" dismissOnBackdrop={!busy} onClose={() => { if (!busy) setRemoveCandidate(undefined); }}>
      <div className="modal__actions"><Button disabled={busy} onClick={() => setRemoveCandidate(undefined)}>{t("common.cancel")}</Button><Button tone="danger" disabled={busy || removeCandidate === undefined} onClick={() => {
        const source = removeCandidate;
        if (source === undefined) return;
        mutate(`remove-extension-source:${source.id}`, () => controller.removeExtensionSource(source.id, source.revision), () => setRemoveCandidate(undefined));
      }}>{t("common.remove")}</Button></div>
    </Modal>
  </>;
}

function sourceLocationLabel(source: ExtensionSourceView): string {
  if (source.location.kind === "local") return source.location.path;
  const suffix = source.location.ref === undefined ? "" : ` · ${source.location.ref}`;
  return `${source.location.repositoryUrl}${suffix}`;
}

function sourceErrorMessage(cause: unknown, t: Translator): string {
  return cause instanceof Error && cause.message.trim() !== "" ? cause.message : t("extensions.sources.requestError");
}
