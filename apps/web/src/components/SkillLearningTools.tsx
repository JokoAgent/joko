import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import { ArrowLeft, Check, FileDiff, FileText, RefreshCcw, Sparkles, X } from "lucide-react";

import type { AppController } from "../controller.js";
import type { BackendView, SkillLearningRunView, SkillMarketEntryIdentityView, TargetView } from "../model.js";
import { resourceKindsForBackend } from "../resource-capabilities.js";
import { randomUuid } from "../web-crypto.js";
import type { Translator } from "./types.js";
import { Button, Pill, SelectControl } from "./ui.js";

type LoadState<T> = { readonly kind: "loading" } | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly value: T };

export function SkillLearningTools({ controller, backends, targets, marketIdentity, t }: {
  readonly controller: AppController;
  readonly backends: readonly BackendView[];
  readonly targets: readonly TargetView[];
  readonly marketIdentity?: SkillMarketEntryIdentityView;
  readonly t: Translator;
}): JSX.Element {
  const eligible = useMemo(() => targets.filter((target) => !target.archived
    && backends.some((backend) => backend.id === target.backendId && resourceKindsForBackend(backend).includes("skill"))), [backends, targets]);
  const [targetId, setTargetId] = useState(eligible[0]?.id ?? "");
  const [instruction, setInstruction] = useState("");
  const [requestId, setRequestId] = useState(() => randomUuid());
  const [runs, setRuns] = useState<LoadState<readonly SkillLearningRunView[]>>({ kind: "loading" });
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<LoadState<SkillLearningRunView>>();
  const [selectedFile, setSelectedFile] = useState<string>();
  const [confirmedReplace, setConfirmedReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [reload, setReload] = useState(0);
  const sequence = useRef(0);
  const active = detail?.kind === "ready" ? detail.value : undefined;

  useEffect(() => {
    if (eligible.some((target) => target.id === targetId)) return;
    setTargetId(eligible[0]?.id ?? "");
  }, [eligible, targetId]);

  const refresh = useCallback(() => setReload((value) => value + 1), []);
  useEffect(() => {
    const generation = ++sequence.current;
    const abort = new AbortController();
    let running = false;
    const load = (): void => {
      if (running || abort.signal.aborted) return;
      running = true;
      void controller.listSkillLearningRuns(abort.signal).then(async (items) => {
        if (abort.signal.aborted || generation !== sequence.current) return;
        setRuns({ kind: "ready", value: items });
        const id = selectedId ?? items[0]?.id;
        if (id === undefined) { setDetail(undefined); return; }
        if (selectedId === undefined) setSelectedId(id);
        const run = await controller.getSkillLearningRun(id, abort.signal);
        if (abort.signal.aborted || generation !== sequence.current) return;
        setDetail({ kind: "ready", value: run });
        setSelectedFile((current) => current !== undefined && run.proposal?.files.some((file) => file.key === current)
          ? current : run.proposal?.files.find((file) => file.key === "SKILL.md")?.key ?? run.proposal?.files[0]?.key);
      }).catch((cause: unknown) => {
        if (abort.signal.aborted || generation !== sequence.current) return;
        const message = cause instanceof Error ? cause.message : t("skills.learning.error");
        setRuns((current) => current.kind === "ready" ? current : { kind: "error", message });
        setDetail((current) => current?.kind === "ready" ? current : { kind: "error", message });
      }).finally(() => { running = false; });
    };
    load();
    const timer = window.setInterval(load, 4_000);
    return () => { abort.abort(); window.clearInterval(timer); };
  }, [controller, reload, selectedId, t]);

  const start = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy || targetId === "" || (marketIdentity === undefined && instruction.trim() === "")) return;
    setBusy(true);
    setActionError(undefined);
    void controller.startSkillLearning({
      requestId, targetId, instruction,
      ...(marketIdentity === undefined ? {} : { marketIdentity })
    }).then((run) => {
      setRequestId(randomUuid());
      setInstruction("");
      setSelectedId(run.id);
      setDetail({ kind: "ready", value: run });
      refresh();
    }).catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : t("skills.learning.error")))
      .finally(() => setBusy(false));
  };

  const act = (action: (run: SkillLearningRunView) => Promise<SkillLearningRunView>): void => {
    if (busy || active === undefined) return;
    setBusy(true);
    setActionError(undefined);
    void action(active).then((next) => {
      setDetail({ kind: "ready", value: next });
      setConfirmedReplace(false);
      refresh();
    }).catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : t("skills.learning.error")))
      .finally(() => setBusy(false));
  };

  const proposal = active?.proposal;
  const file = proposal?.files.find((item) => item.key === selectedFile);
  return <div className="skill-learning">
    <section className="skill-learning__start">
      <div><p className="eyebrow">{t("skills.sections.learning")}</p><h2>{t("skills.learning.title")}</h2><p>{t("skills.learning.body")}</p></div>
      <form onSubmit={start}>
        <label>{t("skills.learning.target")}
          <SelectControl value={targetId} disabled={busy} onChange={(event) => { setTargetId(event.target.value); setRequestId(randomUuid()); }}>
            {eligible.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
          </SelectControl>
        </label>
        {marketIdentity !== undefined && <p className="skill-learning__source">{t("skills.learning.marketSource")}</p>}
        <label>{t("skills.learning.instruction")}
          <textarea value={instruction} maxLength={4_000} disabled={busy} placeholder={t("skills.learning.placeholder")}
            onChange={(event) => { setInstruction(event.target.value); setRequestId(randomUuid()); }} />
        </label>
        <Button tone="primary" type="submit" disabled={busy || targetId === "" || marketIdentity === undefined && instruction.trim() === ""}>
          <Sparkles aria-hidden="true" />{busy ? t("common.working") : t("skills.learning.start")}
        </Button>
      </form>
      {eligible.length === 0 && <p role="status">{t("skills.learning.noTarget")}</p>}
    </section>
    <section className="skill-learning__history" aria-label={t("skills.learning.history")}>
      <header><h3>{t("skills.learning.history")}</h3><Button onClick={refresh}><RefreshCcw aria-hidden="true" />{t("common.refresh")}</Button></header>
      {runs.kind === "loading" && <p role="status">{t("common.loading")}</p>}
      {runs.kind === "error" && <p role="alert">{runs.message}</p>}
      {runs.kind === "ready" && runs.value.length === 0 && <p>{t("skills.learning.empty")}</p>}
      {runs.kind === "ready" && <div className="skill-learning__run-list">{runs.value.map((run) => <button
        key={run.id} type="button" className={run.id === selectedId ? "is-active" : undefined}
        aria-pressed={run.id === selectedId} onClick={() => { setDetail({ kind: "loading" }); setSelectedId(run.id); setConfirmedReplace(false); }}
      ><span>{run.summary}</span><Pill tone={run.state === "applied" ? "success" : run.state === "failed" ? "danger" : run.state === "awaitingReview" ? "warning" : "neutral"}>{t(`skills.learning.state.${run.state}`)}</Pill></button>)}</div>}
    </section>
    {detail?.kind === "loading" && <p role="status">{t("common.loading")}</p>}
    {detail?.kind === "error" && <p role="alert">{detail.message}</p>}
    {active !== undefined && <section className="skill-learning__detail" aria-label={t("skills.learning.review")}>
      <header><div><h3>{active.summary}</h3><Pill tone={active.state === "awaitingReview" ? "warning" : active.state === "applied" ? "success" : "neutral"}>{t(`skills.learning.state.${active.state}`)}</Pill></div>
        {active.distillationSessionId !== undefined && <Button onClick={() => controller.navigate({ kind: "session", sessionId: active.distillationSessionId! })}><ArrowLeft aria-hidden="true" />{t("skills.learning.openTask")}</Button>}
      </header>
      {active.error !== undefined && <p role="alert" className="danger-text">{active.error}</p>}
      {(active.state === "collecting" || active.state === "distilling") && <div className="skill-learning__progress" role="status"><Sparkles aria-hidden="true" />{t(`skills.learning.state.${active.state}`)}</div>}
      {proposal !== undefined && <>
        <div className="skill-learning__explanation"><h4>{proposal.name}</h4><p>{proposal.description}</p><p>{proposal.explanation}</p></div>
        <div className="skill-learning__review-grid">
          <div className="skill-learning__file-list" role="group" aria-label={t("skills.learning.files")}>{proposal.files.map((item) => <button
            key={item.key} type="button" aria-pressed={item.key === selectedFile} className={item.key === selectedFile ? "is-active" : undefined}
            onClick={() => setSelectedFile(item.key)}><FileText aria-hidden="true" />{item.key}</button>)}</div>
          <div className="skill-learning__file"><h4>{file?.key ?? t("skills.learning.files")}</h4><pre>{file?.content ?? ""}</pre></div>
        </div>
        <section className="skill-learning__diff"><h4><FileDiff aria-hidden="true" />{t("skills.learning.diff")}</h4>
          {!proposal.diff.available && <p>{proposal.diff.reason ?? t("skills.learning.diffUnavailable")}</p>}
          {proposal.diff.available && proposal.diff.changes.length === 0 && <p>{t("skills.diffClean")}</p>}
          {proposal.diff.changes.map((change) => <details key={change.key}><summary>{change.key} · {t(`skills.diff.${change.kind}`)}</summary><pre>{change.unifiedDiff ?? t("skills.diffBinary")}</pre></details>)}
          {proposal.diff.truncated && <p>{t("skills.learning.diffTruncated")}</p>}
        </section>
        {active.state === "awaitingReview" && <div className="skill-learning__actions">
          {proposal.currentResourceId !== undefined && <label><input type="checkbox" checked={confirmedReplace} onChange={(event) => setConfirmedReplace(event.target.checked)} />{t("skills.learning.replaceConfirm")}</label>}
          <Button tone="primary" disabled={busy || proposal.currentResourceId !== undefined && !confirmedReplace} onClick={() => act((run) => controller.applySkillLearning(run, confirmedReplace))}><Check aria-hidden="true" />{t("skills.learning.apply")}</Button>
          <Button disabled={busy} onClick={() => act((run) => controller.discardSkillLearning(run))}><X aria-hidden="true" />{t("skills.learning.discard")}</Button>
        </div>}
      </>}
      {(active.state === "collecting" || active.state === "distilling") && <Button disabled={busy} onClick={() => act((run) => controller.cancelSkillLearning(run))}>{t("common.cancel")}</Button>}
      {actionError !== undefined && <p role="alert" className="danger-text">{actionError}</p>}
    </section>}
  </div>;
}
