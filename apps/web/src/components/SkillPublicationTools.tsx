import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { AlertTriangle, CheckCircle2, Circle, LoaderCircle, RefreshCcw, Upload } from "lucide-react";

import type { AppController } from "../controller.js";
import type {
  SkillMarketSourceView,
  SkillPublicationJobView,
  SkillPublicationMetadataView,
  SkillPublicationPreviewView,
  SkillPublicationResultView,
  SkillSessionView
} from "../model.js";
import type { Translator } from "./types.js";
import { Button, Modal, Pill, SelectControl, cx, formatRelativeTime } from "./ui.js";

type LoadState<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly value: T };

export function SkillPublicationDialog({ controller, session, locale, t, onClose, onPublished, onOpenPublished }: {
  readonly controller: AppController;
  readonly session: SkillSessionView;
  readonly locale: string;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onPublished: () => void;
  readonly onOpenPublished: (result: SkillPublicationResultView) => void;
}): JSX.Element {
  const [sources, setSources] = useState<LoadState<readonly SkillMarketSourceView[]>>({ kind: "loading" });
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [sourceRecovered, setSourceRecovered] = useState(false);
  const [slug, setSlug] = useState(() => suggestedSlug(session.skill.name));
  const [preview, setPreview] = useState<LoadState<SkillPublicationPreviewView>>();
  const [jobs, setJobs] = useState<readonly SkillPublicationJobView[]>([]);
  const [jobsRecovered, setJobsRecovered] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string>();
  const [name, setName] = useState(session.metadata.name ?? session.skill.name);
  const [author, setAuthor] = useState("");
  const [description, setDescription] = useState(session.metadata.description ?? "");
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState("");
  const [version, setVersion] = useState(session.metadata.version ?? "1.0.0");
  const [changelog, setChangelog] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pollSequence = useRef(0);
  const publishedNotices = useRef(new Set<string>());
  const initialJobsLoaded = useRef(false);

  const loadJobs = useCallback(async (signal?: AbortSignal): Promise<readonly SkillPublicationJobView[]> => {
    const catalog = await controller.listSkillPublicationJobs(session.skill.id, signal);
    if (!initialJobsLoaded.current) {
      for (const job of catalog.items) if (job.state === "published") publishedNotices.current.add(job.id);
      initialJobsLoaded.current = true;
    }
    setJobs(catalog.items);
    setJobsRecovered(catalog.recoveredFromCorruption);
    setSelectedJobId((current) => current !== undefined && catalog.items.some((job) => job.id === current)
      ? current
      : catalog.items[0]?.id);
    return catalog.items;
  }, [controller, session.skill.id]);

  useEffect(() => {
    const abort = new AbortController();
    void Promise.all([
      controller.listSkillMarketSources(abort.signal),
      loadJobs(abort.signal)
    ]).then(([catalog]) => {
      if (abort.signal.aborted) return;
      const available = catalog.sources.filter((source) => source.kind === "local" && source.state === "ready");
      setSources({ kind: "ready", value: available });
      setSourceRecovered(catalog.recoveredFromCorruption);
      setSelectedSourceId((current) => available.some((source) => source.id === current) ? current : available[0]?.id ?? "");
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted) setSources({ kind: "error", message: messageOf(cause, t) });
    });
    return () => abort.abort();
  }, [controller, loadJobs, t]);

  const selectedJob = jobs.find((job) => job.id === selectedJobId);
  const activeJob = jobs.find((job) => !isTerminalPublication(job));
  useEffect(() => {
    if (activeJob === undefined) return;
    const sequence = ++pollSequence.current;
    const abort = new AbortController();
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const next = await controller.getSkillPublicationJob(activeJob.id, abort.signal);
        if (abort.signal.aborted || sequence !== pollSequence.current) return;
        setJobs((current) => current.map((job) => job.id === next.id ? next : job));
        if (!isTerminalPublication(next)) timer = window.setTimeout(() => { void poll(); }, 500);
      } catch (cause) {
        if (!abort.signal.aborted && sequence === pollSequence.current) setError(messageOf(cause, t));
      }
    };
    timer = window.setTimeout(() => { void poll(); }, 250);
    return () => {
      pollSequence.current += 1;
      abort.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeJob?.id, activeJob?.revision, activeJob?.state, controller, t]);

  useEffect(() => {
    let changed = false;
    for (const job of jobs) {
      if (job.state !== "published" || publishedNotices.current.has(job.id)) continue;
      publishedNotices.current.add(job.id);
      changed = true;
    }
    if (changed) onPublished();
  }, [jobs, onPublished]);

  const availableSources = sources.kind === "ready" ? sources.value : [];
  const selectedSource = availableSources.find((source) => source.id === selectedSourceId);
  const reviewed = preview?.kind === "ready" ? preview.value : undefined;
  const parsedTags = useMemo(() => tags.split(",").map((tag) => tag.trim()).filter(Boolean), [tags]);
  const uniqueTags = new Set(parsedTags.map((tag) => tag.toLocaleLowerCase("en-US"))).size === parsedTags.length;
  const canonicalVersion = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(version.trim());
  const safeText = (value: string): boolean => !/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value);
  const formValid = reviewed !== undefined
    && name.trim() !== "" && name.trim().length <= 64
    && description.trim().length <= 2_000 && author.trim().length <= 128 && category.trim().length <= 64
    && parsedTags.length <= 20 && parsedTags.every((tag) => tag.length <= 48) && uniqueTags
    && [name, author, description, category, ...parsedTags, changelog].every(safeText)
    && canonicalVersion && (reviewed.mode === "first" || changelog.trim() !== "") && changelog.trim().length <= 280;

  const prepare = (): void => {
    if (selectedSource === undefined || busy || slug.trim() === "") return;
    const abort = new AbortController();
    setPreview({ kind: "loading" });
    setBusy(true);
    setError(undefined);
    void controller.getSkillPublicationPreview(
      session.skill.id,
      session.skill.revision,
      selectedSource.id,
      selectedSource.revision,
      slug.trim(),
      abort.signal
    ).then((value) => {
      setPreview({ kind: "ready", value });
      setSlug(value.suggestedSlug);
      setVersion(value.suggestedVersion);
      setName(value.existingEntry?.name ?? session.metadata.name ?? session.skill.name);
      setAuthor(value.existingEntry?.author ?? "");
      setDescription(value.existingEntry?.description ?? session.metadata.description ?? "");
      setCategory(value.existingEntry?.category ?? "");
      setTags(value.existingEntry?.tags.join(", ") ?? "");
      setChangelog("");
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted) setPreview({ kind: "error", message: messageOf(cause, t) });
    }).finally(() => {
      if (!abort.signal.aborted) setBusy(false);
    });
  };

  const metadata = (): SkillPublicationMetadataView => ({
    slug: reviewed!.suggestedSlug,
    name: name.trim(),
    ...(author.trim() === "" ? {} : { author: author.trim() }),
    description: description.trim(),
    ...(category.trim() === "" ? {} : { category: category.trim() }),
    tags: parsedTags,
    version: version.trim(),
    ...(changelog.trim() === "" ? {} : { changelog: changelog.trim() })
  });

  const publish = (): void => {
    if (!formValid || reviewed === undefined || busy) return;
    setBusy(true);
    setError(undefined);
    void controller.startSkillPublication(reviewed, metadata()).then(async () => {
      const next = await loadJobs();
      setSelectedJobId(next[0]?.id);
    }).catch((cause: unknown) => setError(messageOf(cause, t))).finally(() => setBusy(false));
  };

  const mutateJob = (action: (job: SkillPublicationJobView) => Promise<void>): void => {
    if (selectedJob === undefined || busy) return;
    setBusy(true);
    setError(undefined);
    void action(selectedJob).then(async () => {
      const next = await loadJobs();
      setSelectedJobId(next[0]?.id);
    }).catch((cause: unknown) => setError(messageOf(cause, t))).finally(() => setBusy(false));
  };

  return <Modal
    open
    title={t("skills.publish.title", { name: session.skill.name })}
    description={t("skills.publish.body")}
    size="large"
    className="skill-publication-modal"
    dismissOnBackdrop={!busy}
    onClose={() => { if (!busy) onClose(); }}
  >
    <div className="skill-publication">
      <section className="skill-publication__destination">
        <h3>{t("skills.publish.destination")}</h3>
        {sources.kind === "loading" && <PublicationNotice tone="neutral" message={t("skills.publish.loadingSources")} />}
        {sources.kind === "error" && <PublicationNotice tone="danger" message={sources.message} />}
        {sourceRecovered && <PublicationNotice tone="warning" message={t("skills.publish.sourceRecovered")} />}
        {sources.kind === "ready" && availableSources.length === 0 && <PublicationNotice tone="warning" message={t("skills.publish.noLocalSource")} />}
        {availableSources.length > 0 && <div className="skill-publication__destination-grid">
          <label><span>{t("skills.publish.source")}</span><SelectControl value={selectedSourceId} disabled={busy || reviewed !== undefined} onChange={(event) => { setSelectedSourceId(event.target.value); setPreview(undefined); }}>
            {availableSources.map((source) => <option value={source.id} key={source.id}>{source.displayName ?? source.name}</option>)}
          </SelectControl></label>
          <label><span>{t("skills.publish.slug")}</span><input value={slug} disabled={busy || reviewed !== undefined} onChange={(event) => setSlug(event.target.value)} /></label>
          {reviewed === undefined && <Button tone="primary" disabled={busy || selectedSource === undefined || slug.trim() === ""} onClick={prepare}>{busy ? t("common.working") : t("skills.publish.review")}</Button>}
          {reviewed !== undefined && <Button disabled={busy || activeJob !== undefined} onClick={() => setPreview(undefined)}>{t("skills.publish.changeDestination")}</Button>}
        </div>}
        {preview?.kind === "loading" && <PublicationNotice tone="neutral" message={t("skills.publish.preparing")} />}
        {preview?.kind === "error" && <PublicationNotice tone="danger" message={preview.message} />}
      </section>

      {reviewed !== undefined && <>
        <section className="skill-publication__authority">
          <div><span>{t("skills.publish.mode")}</span><strong>{t(`skills.publish.mode.${reviewed.mode}`)}</strong></div>
          <div><span>{t("skills.publish.source")}</span><strong>{reviewed.source.displayName ?? reviewed.source.name}</strong></div>
          <div><span>{t("skills.publish.content")}</span><code>{reviewed.authority.observedRevision.slice(0, 19)}…</code></div>
        </section>
        {reviewed.dirty && <PublicationNotice tone="warning" message={t("skills.publish.dirty")} />}
        <section className="skill-publication__form" aria-label={t("skills.publish.metadata")}>
          <h3>{t("skills.publish.metadata")}</h3>
          <label><span>{t("skills.publish.name")}</span><input value={name} maxLength={64} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
          <label><span>{t("skills.publish.author")}</span><input value={author} maxLength={128} disabled={busy} onChange={(event) => setAuthor(event.target.value)} /></label>
          <label className="is-wide"><span>{t("skills.publish.description")}</span><textarea value={description} maxLength={2_000} disabled={busy} onChange={(event) => setDescription(event.target.value)} /></label>
          <label><span>{t("skills.publish.category")}</span><input value={category} maxLength={64} disabled={busy} onChange={(event) => setCategory(event.target.value)} /></label>
          <label><span>{t("skills.publish.tags")}</span><input value={tags} disabled={busy} placeholder={t("skills.publish.tagsPlaceholder")} onChange={(event) => setTags(event.target.value)} /></label>
          <label><span>{t("skills.publish.version")}</span><input value={version} disabled={busy} inputMode="numeric" onChange={(event) => setVersion(event.target.value)} /></label>
          <label className="is-wide"><span>{t("skills.publish.changelog")}{reviewed.mode === "version" ? ` · ${t("skills.publish.required")}` : ""}</span><textarea value={changelog} maxLength={280} disabled={busy} onChange={(event) => setChangelog(event.target.value)} /></label>
        </section>
        <section className="skill-publication__access">
          <fieldset><legend>{t("skills.publish.publisher")}</legend><label><input type="radio" checked readOnly />{t("skills.publish.publisher.personal")}</label><label className="is-disabled" title={reviewed.collaborationUnavailableReason}><input type="radio" disabled />{t("skills.publish.publisher.team")}</label></fieldset>
          <fieldset><legend>{t("skills.publish.visibility")}</legend><label><input type="radio" checked readOnly />{t("skills.publish.visibility.public")}</label><label className="is-disabled" title={reviewed.collaborationUnavailableReason}><input type="radio" disabled />{t("skills.publish.visibility.department")}</label><label className="is-disabled" title={reviewed.collaborationUnavailableReason}><input type="radio" disabled />{t("skills.publish.visibility.private")}</label></fieldset>
          <p><AlertTriangle aria-hidden="true" />{reviewed.collaborationUnavailableReason}</p>
        </section>
        {error !== undefined && <PublicationNotice tone="danger" message={error} />}
        <div className="skill-publication__publish-action"><Button tone="primary" disabled={busy || !formValid || activeJob !== undefined} onClick={publish}><Upload aria-hidden="true" />{busy ? t("common.working") : t(reviewed.mode === "first" ? "skills.publish.action.first" : "skills.publish.action.version")}</Button></div>
      </>}

      <section className="skill-publication__jobs" aria-label={t("skills.publish.jobs")}>
        <header><div><h3>{t("skills.publish.jobs")}</h3><p>{t("skills.publish.jobsBody")}</p></div><Button disabled={busy} onClick={() => { void loadJobs().catch((cause: unknown) => setError(messageOf(cause, t))); }}><RefreshCcw aria-hidden="true" />{t("common.refresh")}</Button></header>
        {jobsRecovered && <PublicationNotice tone="warning" message={t("skills.publish.jobsRecovered")} />}
        {jobs.length === 0 ? <p className="skill-publication__empty">{t("skills.publish.noJobs")}</p> : <div className="skill-publication__job-layout">
          <div className="skill-publication__job-list">{jobs.map((job) => <button type="button" className={cx(job.id === selectedJobId && "is-active")} key={job.id} onClick={() => setSelectedJobId(job.id)}><span><strong>v{job.metadata.version}</strong><small>{formatRelativeTime(job.updatedAt, locale)}</small></span><Pill tone={publicationTone(job)}>{t(`skills.publish.state.${job.state}`)}</Pill></button>)}</div>
          {selectedJob !== undefined && <PublicationJobDetails job={selectedJob} locale={locale} t={t} busy={busy} onCancel={() => mutateJob((job) => controller.cancelSkillPublication(job))} onRetry={() => mutateJob((job) => controller.retrySkillPublication(job))} onOpenPublished={onOpenPublished} />}
        </div>}
      </section>
      <div className="modal__actions"><Button disabled={busy} onClick={onClose}>{t("common.close")}</Button></div>
    </div>
  </Modal>;
}

function PublicationJobDetails({ job, locale, t, busy, onCancel, onRetry, onOpenPublished }: {
  readonly job: SkillPublicationJobView;
  readonly locale: string;
  readonly t: Translator;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onOpenPublished: (result: SkillPublicationResultView) => void;
}): JSX.Element {
  return <article className="skill-publication__job-detail">
    <header><div><p className="eyebrow">{t("skills.publish.attempt", { count: job.attempt })}</p><h4>{job.metadata.name} · v{job.metadata.version}</h4><small>{formatRelativeTime(job.updatedAt, locale)}</small></div><Pill tone={publicationTone(job)}>{t(`skills.publish.state.${job.state}`)}</Pill></header>
    <div className="skill-publication__gates">{job.gates.map((gate) => <section className={cx(`is-${gate.status}`)} key={gate.id}>{gate.status === "passed" ? <CheckCircle2 aria-hidden="true" /> : gate.status === "blocked" ? <AlertTriangle aria-hidden="true" /> : job.state === "published" ? <CheckCircle2 aria-hidden="true" /> : <Circle aria-hidden="true" />}<div><strong>{t(`skills.publish.gate.${gate.id}`)}</strong><small>{t(`skills.publish.gateStatus.${gate.status}`)}</small>{gate.issues.map((issue) => <p key={`${issue.code}:${issue.path ?? ""}`}>{issue.path === undefined ? issue.message : `${issue.path} · ${issue.message}`}</p>)}</div></section>)}</div>
    {(job.files > 0 || job.archiveBytes > 0) && <p className="skill-publication__size">{t("skills.publish.size", { files: job.files, source: formatBytes(job.uncompressedBytes), archive: formatBytes(job.archiveBytes) })}</p>}
    {job.state === "reconciling" && <p className="skill-publication__reconciling"><LoaderCircle className="spin" aria-hidden="true" />{t("skills.publish.reconciling")}</p>}
    {job.error !== undefined && <PublicationNotice tone="danger" message={job.error} />}
    {job.result !== undefined && <><PublicationNotice tone="success" message={t("skills.publish.complete", { version: job.result.version })} /><Button tone="primary" onClick={() => onOpenPublished(job.result!)}>{t("skills.publish.openMarket")}</Button></>}
    <div className="skill-publication__job-actions">{job.cancellable && <Button disabled={busy} onClick={onCancel}>{t("common.cancel")}</Button>}{isRetryablePublication(job) && <Button disabled={busy} onClick={onRetry}>{t("common.retry")}</Button>}</div>
  </article>;
}

function PublicationNotice({ tone, message }: {
  readonly tone: "neutral" | "success" | "warning" | "danger";
  readonly message: string;
}): JSX.Element {
  return <p className={cx("skill-publication__notice", `is-${tone}`)} role={tone === "danger" ? "alert" : "status"}>{tone === "success" ? <CheckCircle2 aria-hidden="true" /> : tone === "neutral" ? <LoaderCircle className="spin" aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}{message}</p>;
}

function isTerminalPublication(job: SkillPublicationJobView): boolean {
  return job.state === "published" || job.state === "blocked" || job.state === "failed" || job.state === "cancelled";
}

function isRetryablePublication(job: SkillPublicationJobView): boolean {
  return job.state === "blocked" || job.state === "failed" || job.state === "cancelled";
}

function publicationTone(job: SkillPublicationJobView): "success" | "warning" | "danger" | "neutral" {
  if (job.state === "published") return "success";
  if (job.state === "failed") return "danger";
  if (job.state === "blocked" || job.state === "cancelled") return "warning";
  return "neutral";
}

function suggestedSlug(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "") || "skill";
}

function messageOf(cause: unknown, t: Translator): string {
  return cause instanceof Error && cause.message.trim() !== "" ? cause.message : t("skills.publish.error");
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}
