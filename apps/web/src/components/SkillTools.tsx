import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX, RefObject } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileDiff,
  FileText,
  Folder,
  FolderOpen,
  Pencil,
  RefreshCcw,
  Search,
  Sparkles,
  Trash2
} from "lucide-react";

import type { AppController } from "../controller.js";
import type {
  BackendView,
  SkillDescriptorView,
  SkillDiffChangeView,
  SkillDraftView,
  SkillFileContentView,
  SkillFileEntryView,
  SkillRecoveryView,
  SkillScopeView,
  SkillSessionView,
  TargetView
} from "../model.js";
import type { Translator } from "./types.js";
import { moveTablistSelection } from "./tablist-navigation.js";
import { SkillMarketCatalogTools, SkillMarketSourcesTools } from "./SkillMarketTools.js";
import { Button, EmptyState, IconButton, Modal, Pill, SelectControl, cx, formatRelativeTime } from "./ui.js";

type LoadState<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly value: T };

interface SkillGroup {
  readonly key: string;
  readonly label: string;
  readonly skills: readonly SkillDescriptorView[];
}

export function groupSkillCatalog(
  skills: readonly SkillDescriptorView[],
  targets: readonly TargetView[],
  globalLabel: string,
  projectLabel: string
): readonly SkillGroup[] {
  const targetNames = new Map(targets.map((target) => [target.id, target.name]));
  const global = skills.filter((skill) => skill.scope === "global");
  const projects = new Map<string, SkillDescriptorView[]>();
  for (const skill of skills) {
    if (skill.scope !== "project") continue;
    const key = skill.targetId ?? "project";
    const current = projects.get(key);
    if (current === undefined) projects.set(key, [skill]);
    else current.push(skill);
  }
  return [
    ...(global.length === 0 ? [] : [{ key: "global", label: globalLabel, skills: global }]),
    ...[...projects.entries()]
      .sort(([left], [right]) => (targetNames.get(left) ?? left).localeCompare(targetNames.get(right) ?? right))
      .map(([key, values]) => ({
        key: `project:${key}`,
        label: targetNames.get(key) ?? (key === "project" ? projectLabel : `${projectLabel} · ${key}`),
        skills: values
      }))
  ];
}

export function SkillTools({ controller, backends, targets, locale, t }: {
  readonly controller: AppController;
  readonly backends: readonly BackendView[];
  readonly targets: readonly TargetView[];
  readonly locale: string;
  readonly t: Translator;
}): JSX.Element {
  const [tab, setTab] = useState<"installed" | "market" | "sources">("installed");
  return <div className="skill-hub">
    <div className="skill-hub__tabs" role="tablist" aria-label={t("skills.sections.label")}>
      {(["installed", "market", "sources"] as const).map((value) => <button
        key={value}
        type="button"
        role="tab"
        aria-selected={tab === value}
        tabIndex={tab === value ? 0 : -1}
        className={cx(tab === value && "is-active")}
        onKeyDown={(event) => moveTablistSelection(event, "horizontal")}
        onClick={() => setTab(value)}
      >{t(`skills.sections.${value}`)}</button>)}
    </div>
    {tab === "installed" && <LocalSkillTools controller={controller} backends={backends} targets={targets} locale={locale} t={t} />}
    {tab === "market" && <SkillMarketCatalogTools controller={controller} backends={backends} targets={targets} locale={locale} t={t} onOpenSources={() => setTab("sources")} />}
    {tab === "sources" && <SkillMarketSourcesTools controller={controller} locale={locale} t={t} onOpenMarket={() => setTab("market")} />}
  </div>;
}

function LocalSkillTools({ controller, backends, targets, locale, t }: {
  readonly controller: AppController;
  readonly backends: readonly BackendView[];
  readonly targets: readonly TargetView[];
  readonly locale: string;
  readonly t: Translator;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | SkillScopeView>("all");
  const [catalog, setCatalog] = useState<LoadState<readonly SkillDescriptorView[]>>({ kind: "loading" });
  const [catalogRevision, setCatalogRevision] = useState(0n);
  const [selectedId, setSelectedId] = useState<string>();
  const [sessionState, setSessionState] = useState<LoadState<SkillSessionView> | undefined>();
  const [selectedFileKey, setSelectedFileKey] = useState<string>();
  const [fileState, setFileState] = useState<LoadState<SkillFileContentView> | undefined>();
  const [editing, setEditing] = useState(false);
  const [editorText, setEditorText] = useState("");
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ readonly draft: SkillDraftView; readonly source: "edit" | "rename" }>();
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [recoveries, setRecoveries] = useState<readonly SkillRecoveryView[]>([]);
  const [recoveryError, setRecoveryError] = useState<string>();
  const [recoveryNotice, setRecoveryNotice] = useState<string>();
  const [mobileDetail, setMobileDetail] = useState(false);
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [fileRefreshSequence, setFileRefreshSequence] = useState(0);
  const catalogRequest = useRef(0);
  const detailRequest = useRef(0);
  const fileRequest = useRef(0);
  const selectedButton = useRef<HTMLButtonElement | null>(null);
  const detailHeading = useRef<HTMLHeadingElement | null>(null);
  const sessionRef = useRef<SkillSessionView | undefined>(undefined);
  const dirty = editing && fileState?.kind === "ready" && editorText !== fileState.value.content;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const loadCatalog = useCallback(() => setRefreshSequence((value) => value + 1), []);

  useEffect(() => {
    const request = ++catalogRequest.current;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setCatalog((current) => current.kind === "ready" ? current : { kind: "loading" });
      setRecoveryError(undefined);
      void controller.listSkills({ signal: abort.signal }).then((next) => {
        if (abort.signal.aborted || catalogRequest.current !== request) return;
        setCatalogRevision(next.revision);
        setCatalog({ kind: "ready", value: next.skills });
        setSelectedId((current) => current !== undefined && next.skills.some((skill) => skill.id === current)
          ? current
          : next.skills[0]?.id);
      }).catch((error: unknown) => {
        if (abort.signal.aborted || catalogRequest.current !== request) return;
        setCatalog((current) => current.kind === "ready"
          ? current
          : { kind: "error", message: errorMessage(error, t) });
      });
      void controller.listSkillRecoveries(abort.signal).then((nextRecoveries) => {
        if (abort.signal.aborted || catalogRequest.current !== request) return;
        setRecoveries(nextRecoveries);
      }).catch((error: unknown) => {
        if (abort.signal.aborted || catalogRequest.current !== request) return;
        setRecoveryError(errorMessage(error, t));
      });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [controller, refreshSequence, t]);

  const allSkills = catalog.kind === "ready" ? catalog.value : [];
  const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
  const skills = allSkills.filter((skill) => (scope === "all" || skill.scope === scope)
    && (normalizedQuery === "" || `${skill.name}\n${skill.sourceLabel}\n${skill.backendId}`.toLocaleLowerCase("en-US").includes(normalizedQuery)));
  const selected = allSkills.find((skill) => skill.id === selectedId);
  const groups = useMemo(() => groupSkillCatalog(
    skills,
    targets,
    t("skills.scopeGlobal"),
    t("skills.scopeProject")
  ), [skills, t, targets]);

  useEffect(() => {
    const request = ++detailRequest.current;
    const abort = new AbortController();
    const prior = sessionRef.current;
    sessionRef.current = undefined;
    if (prior !== undefined) void controller.closeSkill(prior.id).catch(() => undefined);
    setSelectedFileKey(undefined);
    setFileState(undefined);
    setEditing(false);
    setEditorText("");
    setActionError(undefined);
    setPreview(undefined);
    if (selected === undefined) {
      setSessionState(undefined);
      return () => abort.abort();
    }
    if (!selected.contentAvailable) {
      setSessionState({ kind: "error", message: t("skills.contentUnavailable") });
      return () => abort.abort();
    }
    setSessionState({ kind: "loading" });
    let opened: SkillSessionView | undefined;
    void controller.openSkill(selected.id, selected.revision, abort.signal).then((value) => {
      opened = value;
      if (abort.signal.aborted || detailRequest.current !== request) {
        void controller.closeSkill(value.id).catch(() => undefined);
        return;
      }
      sessionRef.current = value;
      setSessionState({ kind: "ready", value });
      const first = value.files.find((file) => file.kind === "file" && file.key.toLocaleLowerCase("en-US") === "skill.md")
        ?? value.files.find((file) => file.kind === "file");
      setSelectedFileKey(first?.key);
    }).catch((error: unknown) => {
      if (abort.signal.aborted || detailRequest.current !== request) return;
      setSessionState({ kind: "error", message: errorMessage(error, t) });
    });
    return () => {
      abort.abort();
      if (opened !== undefined) {
        if (sessionRef.current?.id === opened.id) sessionRef.current = undefined;
        void controller.closeSkill(opened.id).catch(() => undefined);
      }
    };
  }, [controller, selected?.id, selected?.revision, t]);

  const session = sessionState?.kind === "ready" ? sessionState.value : undefined;

  useEffect(() => {
    const request = ++fileRequest.current;
    const abort = new AbortController();
    setEditing(false);
    setEditorText("");
    setActionError(undefined);
    if (session === undefined || selectedFileKey === undefined) {
      setFileState(undefined);
      return () => abort.abort();
    }
    setFileState({ kind: "loading" });
    void controller.readSkillFile(session.id, selectedFileKey, abort.signal).then((file) => {
      if (abort.signal.aborted || fileRequest.current !== request || sessionRef.current?.id !== session.id) return;
      setFileState({ kind: "ready", value: file });
      setEditorText(file.content);
    }).catch((error: unknown) => {
      if (abort.signal.aborted || fileRequest.current !== request) return;
      setFileState({ kind: "error", message: errorMessage(error, t) });
    });
    return () => abort.abort();
  }, [controller, fileRefreshSequence, selectedFileKey, session?.id, t]);

  useEffect(() => {
    if (mobileDetail && session !== undefined && window.innerWidth <= 720) {
      detailHeading.current?.focus();
    }
  }, [mobileDetail, session?.id]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  const discardAllowed = (): boolean => !dirty || window.confirm(t("skills.unsavedLeave"));
  const selectSkill = (skill: SkillDescriptorView): void => {
    if (skill.id === selectedId) {
      setMobileDetail(true);
      return;
    }
    if (!discardAllowed()) return;
    setSelectedId(skill.id);
    setMobileDetail(true);
  };
  const selectFile = (key: string): void => {
    if (key === selectedFileKey || !discardAllowed()) return;
    setSelectedFileKey(key);
  };
  const leaveDetail = (): void => {
    if (!discardAllowed()) return;
    setMobileDetail(false);
    window.requestAnimationFrame(() => selectedButton.current?.focus());
  };

  const mutate = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setActionError(undefined);
    try {
      await action();
    } catch (error) {
      setActionError(errorMessage(error, t));
    } finally {
      setBusy(false);
    }
  };

  const prepareEdit = (): void => {
    if (session === undefined || fileState?.kind !== "ready") return;
    void mutate(async () => {
      const draft = await controller.prepareSkillFileEdit(
        session.id,
        fileState.value.key,
        fileState.value.revision,
        editorText
      );
      setPreview({ draft, source: "edit" });
    });
  };

  const prepareRename = (): void => {
    if (session === undefined) return;
    void mutate(async () => {
      const draft = await controller.prepareSkillRename(session.id, renameValue);
      setRenameOpen(false);
      setPreview({ draft, source: "rename" });
    });
  };

  const applyDraft = (): void => {
    if (preview === undefined) return;
    void mutate(async () => {
      const result = await controller.applySkillDraft(preview.draft);
      const nextId = result.skill?.id;
      setPreview(undefined);
      setEditing(false);
      setSelectedFileKey(undefined);
      if (nextId !== undefined) setSelectedId(nextId);
      loadCatalog();
    });
  };

  const toggleEnabled = (): void => {
    if (session === undefined) return;
    void mutate(async () => {
      const result = await controller.setSkillEnabled(session.skill, !session.skill.enabled);
      if (result.skill !== undefined) setSelectedId(result.skill.id);
      loadCatalog();
    });
  };

  const confirmDelete = (): void => {
    if (session === undefined) return;
    void mutate(async () => {
      const result = await controller.deleteSkill(session, deleteConfirmation);
      setDeleteOpen(false);
      setDeleteConfirmation("");
      setMobileDetail(false);
      setSelectedId(undefined);
      setRecoveryNotice(result.recoveryId);
      loadCatalog();
    });
  };

  return <>
    <section className={cx("skill-workbench", mobileDetail && "skill-workbench--mobile-detail")} aria-label={t("skills.title")} data-catalog-revision={catalogRevision.toString()}>
      <aside className="skill-catalog">
        <header className="skill-catalog__toolbar">
          <label className="skill-search"><Search aria-hidden="true" /><span className="sr-only">{t("skills.search")}</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("skills.search")} /></label>
          <SelectControl aria-label={t("skills.scopeFilter")} value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}>
            <option value="all">{t("skills.scopeAll")}</option>
            <option value="global">{t("skills.scopeGlobal")}</option>
            <option value="project">{t("skills.scopeProject")}</option>
          </SelectControl>
          <IconButton label={t("common.refresh")} onClick={() => { if (discardAllowed()) loadCatalog(); }}><RefreshCcw aria-hidden="true" /></IconButton>
        </header>
        {catalog.kind === "loading" && <CatalogStatus label={t("skills.loading")} />}
        {catalog.kind === "error" && <CatalogStatus error label={catalog.message} action={<Button onClick={loadCatalog}>{t("common.retry")}</Button>} />}
        {catalog.kind === "ready" && skills.length === 0 && <EmptyState icon={<Sparkles />} title={allSkills.length === 0 ? t("skills.empty") : t("skills.noResults")} body={allSkills.length === 0 ? t("skills.emptyBody") : t("skills.noResultsBody")} />}
        {catalog.kind === "ready" && skills.length > 0 && <div className="skill-catalog__groups">{groups.map((group) => <section key={group.key}>
          <h3>{group.label}<span>{group.skills.length}</span></h3>
          <div>{group.skills.map((skill) => <button
            ref={skill.id === selectedId ? selectedButton : undefined}
            type="button"
            className={cx("skill-card", skill.id === selectedId && "is-active")}
            key={skill.id}
            aria-current={skill.id === selectedId ? "true" : undefined}
            onClick={() => selectSkill(skill)}
          >
            <span className="skill-card__icon"><Sparkles aria-hidden="true" /></span>
            <span className="skill-card__copy"><strong>{skill.name}</strong><small>{skill.sourceLabel}</small><em>{backendName(skill.backendId, backends)} · {skillStateLabel(skill, t)}</em></span>
            <span className="skill-card__state"><span className={cx("skill-enabled-dot", skill.enabled && "is-enabled")} aria-hidden="true" /><ChevronRight aria-hidden="true" /></span>
          </button>)}</div>
        </section>)}</div>}
        {catalog.kind === "ready" && recoveryError !== undefined && <CatalogStatus error label={recoveryError} action={<Button onClick={loadCatalog}>{t("common.retry")}</Button>} />}
        {recoveries.length > 0 && <section className="skill-recoveries" aria-label={t("skills.recoveries")}><h3>{t("skills.recoveries")}</h3>{recoveries.map((recovery) => <article key={recovery.id}><span><strong>{recovery.name}</strong><small>{t("skills.recoveryMeta", { files: recovery.files, time: formatRelativeTime(recovery.createdAt, locale) })}</small></span><Pill tone={recovery.status === "ready" ? "success" : "warning"}>{recovery.status === "ready" ? t("skills.recoveryReady") : t("skills.recoveryMissing")}</Pill></article>)}</section>}
      </aside>
      <section className="skill-detail-pane">
        <button type="button" className="skill-detail__back" onClick={leaveDetail}><ArrowLeft aria-hidden="true" />{t("common.back")}</button>
        {selected === undefined && <EmptyState icon={<Sparkles />} title={t("skills.selectTitle")} body={t("skills.selectBody")} />}
        {selected !== undefined && sessionState?.kind === "loading" && <CatalogStatus label={t("skills.opening")} />}
        {selected !== undefined && sessionState?.kind === "error" && <CatalogStatus error label={sessionState.message} action={<Button onClick={loadCatalog}>{t("common.refresh")}</Button>} />}
        {session !== undefined && <SkillDetail
          controller={controller}
          session={session}
          headingRef={detailHeading}
          selectedFileKey={selectedFileKey}
          fileState={fileState}
          editing={editing}
          editorText={editorText}
          dirty={dirty}
          busy={busy}
          actionError={actionError}
          t={t}
          onSelectFile={selectFile}
          onEditorText={setEditorText}
          onEdit={() => { if (fileState?.kind === "ready") { setEditorText(fileState.value.content); setEditing(true); setActionError(undefined); } }}
          onCancelEdit={() => { if (discardAllowed() && fileState?.kind === "ready") { setEditorText(fileState.value.content); setEditing(false); setActionError(undefined); } }}
          onPrepareEdit={prepareEdit}
          onRetryFile={() => setFileRefreshSequence((value) => value + 1)}
          onToggle={toggleEnabled}
          onRename={() => { setRenameValue(session.skill.name); setRenameOpen(true); setActionError(undefined); }}
          onDelete={() => { setDeleteConfirmation(""); setDeleteOpen(true); setActionError(undefined); }}
        />}
      </section>
    </section>

    <Modal open={preview !== undefined} title={t("skills.reviewTitle")} description={preview?.source === "rename" ? t("skills.reviewRenameBody") : t("skills.reviewEditBody")} size="large" onClose={() => { if (!busy) setPreview(undefined); }} dismissOnBackdrop={!busy}>
      {preview !== undefined && <div className="skill-review"><SkillDiff changes={preview.draft.changes} t={t} />{actionError !== undefined && <InlineError message={actionError} />}<div className="modal__actions"><Button disabled={busy} onClick={() => setPreview(undefined)}>{t("common.cancel")}</Button><Button tone="primary" disabled={busy} onClick={applyDraft}>{busy ? t("common.working") : t("skills.apply")}</Button></div></div>}
    </Modal>

    <Modal open={renameOpen} title={t("skills.renameTitle")} description={t("skills.renameBody")} size="small" onClose={() => { if (!busy) setRenameOpen(false); }} dismissOnBackdrop={!busy}>
      <label className="skill-dialog-field"><span>{t("skills.name")}</span><input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} /></label>
      {actionError !== undefined && <InlineError message={actionError} />}
      <div className="modal__actions"><Button disabled={busy} onClick={() => setRenameOpen(false)}>{t("common.cancel")}</Button><Button tone="primary" disabled={busy || renameValue.trim() === "" || renameValue === session?.skill.name} onClick={prepareRename}>{t("skills.review")}</Button></div>
    </Modal>

    <Modal open={deleteOpen} title={t("skills.deleteTitle", { name: session?.skill.name ?? "" })} description={t("skills.deleteBody", { name: session?.skill.name ?? "" })} size="small" onClose={() => { if (!busy) setDeleteOpen(false); }} dismissOnBackdrop={!busy}>
      {session !== undefined && <dl className="skill-delete-summary">
        <div><dt>{t("skills.nameLabel")}</dt><dd>{session.skill.name}</dd></div>
        <div><dt>{t("skills.scope")}</dt><dd>{session.skill.scope === "global" ? t("skills.scopeGlobal") : t("skills.scopeProject")}</dd></div>
        <div><dt>{t("skills.backend")}</dt><dd>{backendName(session.skill.backendId, backends)}</dd></div>
        {session.skill.scope === "project" && <div><dt>{t("skills.project")}</dt><dd>{targetName(session.skill.targetId, targets, t("skills.scopeProject"))}</dd></div>}
        <div><dt>{t("skills.size")}</dt><dd>{t("skills.sizeValue", { files: session.fileCount, size: formatBytes(session.bytes) })}</dd></div>
      </dl>}
      <label className="skill-dialog-field"><span>{t("skills.deleteConfirmation")}</span><input autoFocus value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} /></label>
      {actionError !== undefined && <InlineError message={actionError} />}
      <div className="modal__actions"><Button disabled={busy} onClick={() => setDeleteOpen(false)}>{t("common.cancel")}</Button><Button tone="danger" disabled={busy || deleteConfirmation !== session?.skill.name} onClick={confirmDelete}><Trash2 aria-hidden="true" />{t("common.delete")}</Button></div>
    </Modal>

    <Modal open={recoveryNotice !== undefined} title={t("skills.deletedTitle")} description={t("skills.deletedBody")} size="small" onClose={() => setRecoveryNotice(undefined)}>
      <p className="skill-recovery-id"><span>{t("skills.recoveryId")}</span><code>{recoveryNotice}</code></p>
      <div className="modal__actions"><Button tone="primary" onClick={() => setRecoveryNotice(undefined)}>{t("common.close")}</Button></div>
    </Modal>
  </>;
}

function SkillDetail({ controller, session, headingRef, selectedFileKey, fileState, editing, editorText, dirty, busy, actionError, t, onSelectFile, onEditorText, onEdit, onCancelEdit, onPrepareEdit, onRetryFile, onToggle, onRename, onDelete }: {
  readonly controller: AppController;
  readonly session: SkillSessionView;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly selectedFileKey?: string;
  readonly fileState?: LoadState<SkillFileContentView>;
  readonly editing: boolean;
  readonly editorText: string;
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly actionError?: string;
  readonly t: Translator;
  readonly onSelectFile: (key: string) => void;
  readonly onEditorText: (value: string) => void;
  readonly onEdit: () => void;
  readonly onCancelEdit: () => void;
  readonly onPrepareEdit: () => void;
  readonly onRetryFile: () => void;
  readonly onToggle: () => void;
  readonly onRename: () => void;
  readonly onDelete: () => void;
}): JSX.Element {
  const skill = session.skill;
  return <article className="skill-detail">
    <header className="skill-detail__header">
      <span className="skill-detail__icon"><Sparkles aria-hidden="true" /></span>
      <div><p className="eyebrow">{t("skills.detailEyebrow")}</p><h2 ref={headingRef} tabIndex={-1}>{skill.name}</h2><p>{session.metadata.description ?? t("skills.noDescription")}</p></div>
      <div className="skill-detail__actions">
        {skill.canToggle && <Button disabled={busy} onClick={onToggle}>{skill.enabled ? t("common.disable") : t("common.enable")}</Button>}
        {skill.canEdit && <Button disabled={busy || editing} onClick={onRename}>{t("skills.rename")}</Button>}
        {skill.canDelete && <IconButton disabled={busy || editing} label={t("skills.deleteTitle", { name: skill.name })} onClick={onDelete}><Trash2 aria-hidden="true" /></IconButton>}
      </div>
    </header>
    <dl className="skill-detail__metadata">
      <div><dt>{t("common.state")}</dt><dd><Pill tone={skill.enabled ? "success" : "neutral"}>{skillStateLabel(skill, t)}</Pill></dd></div>
      <div><dt>{t("skills.scope")}</dt><dd>{skill.scope === "global" ? t("skills.scopeGlobal") : t("skills.scopeProject")}</dd></div>
      <div><dt>{t("common.source")}</dt><dd>{skill.sourceLabel}</dd></div>
      <div><dt>{t("skills.size")}</dt><dd>{t("skills.sizeValue", { files: session.fileCount, size: formatBytes(session.bytes) })}</dd></div>
    </dl>
    {session.metadata.parseError !== undefined && <div className="skill-callout skill-callout--danger" role="alert"><AlertTriangle aria-hidden="true" /><span><strong>{t("skills.frontmatterError")}</strong><small>{session.metadata.parseError}</small></span></div>}
    {session.dirty && <div className="skill-callout skill-callout--warning" role="status"><FileDiff aria-hidden="true" /><span><strong>{t("skills.dirtyTitle")}</strong><small>{session.diff.available ? t("skills.dirtyBody") : session.diff.reason ?? t("skills.diffUnavailable")}</small></span></div>}
    {actionError !== undefined && <InlineError message={actionError} />}
    <div className="skill-content-workbench">
      <aside className="skill-file-tree" aria-label={t("skills.files")}><h3>{t("skills.files")}</h3><div>{session.files.map((entry) => <SkillTreeRow key={entry.key} controller={controller} sessionId={session.id} entry={entry} depth={0} selectedKey={selectedFileKey} onSelect={onSelectFile} t={t} />)}</div></aside>
      <section className="skill-file-preview">
        <header><div><span>{selectedFileKey ?? t("skills.noFile")}</span>{dirty && <Pill tone="warning">{t("skills.unsaved")}</Pill>}</div><div>{editing ? <><Button disabled={busy} onClick={onCancelEdit}>{t("common.cancel")}</Button><Button tone="primary" disabled={busy || !dirty} onClick={onPrepareEdit}>{t("skills.review")}</Button></> : fileState?.kind === "ready" && fileState.value.editable && skill.canEdit ? <Button onClick={onEdit}><Pencil aria-hidden="true" />{t("common.edit")}</Button> : null}</div></header>
        <div className="skill-file-preview__body">
          {fileState === undefined && <EmptyState icon={<FileText />} title={t("skills.noFile")} body={t("skills.noFileBody")} />}
          {fileState?.kind === "loading" && <CatalogStatus label={t("skills.loadingFile")} />}
          {fileState?.kind === "error" && <CatalogStatus error label={fileState.message} action={<Button onClick={onRetryFile}>{t("common.retry")}</Button>} />}
          {fileState?.kind === "ready" && (editing
            ? <textarea aria-label={t("skills.editor")} value={editorText} onChange={(event) => onEditorText(event.target.value)} spellCheck={false} />
            : <pre>{fileState.value.content}</pre>)}
        </div>
      </section>
    </div>
    <section className="skill-detail__section"><h3>{t("skills.frontmatter")}</h3><pre>{JSON.stringify(session.metadata.frontmatter, null, 2)}</pre></section>
    <section className="skill-detail__section"><header><h3>{t("skills.currentDiff")}</h3>{session.diff.truncated && <Pill tone="warning">{t("common.truncated")}</Pill>}</header>{session.diff.available ? <SkillDiff changes={session.diff.changes} t={t} /> : <p className="muted">{session.diff.reason ?? t("skills.diffUnavailable")}</p>}</section>
  </article>;
}

function SkillTreeRow({ controller, sessionId, entry, depth, selectedKey, onSelect, t }: {
  readonly controller: AppController;
  readonly sessionId: string;
  readonly entry: SkillFileEntryView;
  readonly depth: number;
  readonly selectedKey?: string;
  readonly onSelect: (key: string) => void;
  readonly t: Translator;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<LoadState<readonly SkillFileEntryView[]> | undefined>();
  const request = useRef(0);
  const abort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => {
    request.current += 1;
    abort.current?.abort();
  }, []);
  const loadChildren = (): void => {
    abort.current?.abort();
    const controllerAbort = new AbortController();
    abort.current = controllerAbort;
    const current = ++request.current;
    setChildren({ kind: "loading" });
    void controller.listSkillFiles(sessionId, entry.key, controllerAbort.signal).then((value) => {
      if (!controllerAbort.signal.aborted && request.current === current) setChildren({ kind: "ready", value });
    }).catch((error: unknown) => {
      if (!controllerAbort.signal.aborted && request.current === current) setChildren({ kind: "error", message: errorMessage(error, t) });
    });
  };
  const activate = (): void => {
    if (entry.kind === "file") {
      onSelect(entry.key);
      return;
    }
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (nextExpanded && (children === undefined || children.kind === "error")) loadChildren();
  };
  const FolderIcon = expanded ? FolderOpen : Folder;
  return <Fragment>
    <button type="button" className={cx("skill-tree-row", entry.kind === "file" && entry.key === selectedKey && "is-active")} style={{ paddingInlineStart: `${6 + depth * 15}px` }} onClick={activate} aria-expanded={entry.kind === "directory" ? expanded : undefined}>
      {entry.kind === "directory" ? expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" /> : <span className="skill-tree-row__spacer" />}
      {entry.kind === "directory" ? <FolderIcon aria-hidden="true" /> : <FileText aria-hidden="true" />}
      <span>{entry.name}{entry.kind === "directory" ? "/" : ""}</span>
      {entry.kind === "file" && !entry.editable && <em>{formatBytes(entry.size)}</em>}
    </button>
    {entry.kind === "directory" && expanded && children?.kind === "loading" && <p className="skill-tree-row__status" style={{ paddingInlineStart: `${34 + depth * 15}px` }}>{t("common.loading")}</p>}
    {entry.kind === "directory" && expanded && children?.kind === "error" && <p className="skill-tree-row__status is-error" style={{ paddingInlineStart: `${34 + depth * 15}px` }}>{children.message}<button type="button" onClick={loadChildren}>{t("common.retry")}</button></p>}
    {entry.kind === "directory" && expanded && children?.kind === "ready" && children.value.map((child) => <SkillTreeRow key={child.key} controller={controller} sessionId={sessionId} entry={child} depth={depth + 1} selectedKey={selectedKey} onSelect={onSelect} t={t} />)}
  </Fragment>;
}

function SkillDiff({ changes, t }: { readonly changes: readonly SkillDiffChangeView[]; readonly t: Translator }): JSX.Element {
  if (changes.length === 0) return <div className="skill-diff-empty"><CheckCircle2 aria-hidden="true" /><span>{t("skills.diffClean")}</span></div>;
  return <div className="skill-diff-list">{changes.map((change) => <article key={`${change.kind}:${change.key}`}>
    <header><FileDiff aria-hidden="true" /><strong>{change.key}</strong><Pill tone={change.kind === "added" ? "success" : change.kind === "deleted" ? "danger" : "warning"}>{t(`skills.diff.${change.kind}`)}</Pill></header>
    {change.binary ? <p>{t("skills.diffBinary")}</p> : <pre>{(change.unifiedDiff ?? "").split("\n").map((line, index) => <span className={diffLineClass(line)} key={index}>{line}{"\n"}</span>)}</pre>}
  </article>)}</div>;
}

export function diffLineClass(line: string): string | undefined {
  if (line.startsWith("+++") || line.startsWith("---")) return "skill-diff-line--header";
  if (line.startsWith("+")) return "skill-diff-line--added";
  if (line.startsWith("-")) return "skill-diff-line--deleted";
  if (line.startsWith("@@")) return "skill-diff-line--hunk";
  return undefined;
}

function CatalogStatus({ label, error = false, action }: { readonly label: string; readonly error?: boolean; readonly action?: JSX.Element }): JSX.Element {
  return <div className={cx("skill-load-state", error && "is-error")} role={error ? "alert" : "status"}>{error ? <AlertTriangle aria-hidden="true" /> : <RefreshCcw className="spin" aria-hidden="true" />}<p>{label}</p>{action}</div>;
}

function InlineError({ message }: { readonly message: string }): JSX.Element {
  return <p className="skill-inline-error" role="alert"><AlertTriangle aria-hidden="true" />{message}</p>;
}

function backendName(id: string, backends: readonly BackendView[]): string {
  return backends.find((backend) => backend.id === id)?.name ?? id;
}

function targetName(id: string | undefined, targets: readonly TargetView[], fallback: string): string {
  if (id === undefined) return fallback;
  return targets.find((target) => target.id === id)?.name ?? id;
}

function skillStateLabel(skill: SkillDescriptorView, t: Translator): string {
  if (!skill.enabled || skill.state === "disabled") return t("common.disabled");
  if (skill.state === "loaded") return t("skills.loaded");
  if (skill.state === "error") return t("skills.errorState");
  return t("common.enabled");
}

function errorMessage(error: unknown, t: Translator): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : t("skills.error");
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}
