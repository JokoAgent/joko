import { useEffect, useRef, useState, type JSX } from "react";
import { Code, ConnectError } from "@connectrpc/connect";
import type { AppController } from "../controller.js";
import type { ScheduleDraft, SchedulePreRunResultView, ScheduleView } from "../model.js";
import type { Translator } from "./types.js";
import { Button, CheckboxControl, SelectControl } from "./ui.js";

type Hook = ScheduleView["preRunHook"];
export function ScheduleHookEditor({ controller, scheduleId, draft, open, saving, t, onChange, onBusyChange, onValidityChange }: {
  readonly controller: AppController; readonly scheduleId?: string; readonly draft: ScheduleDraft; readonly open: boolean;
  readonly saving: boolean; readonly t: Translator; readonly onChange: (hook: Hook) => void; readonly onBusyChange: (busy: boolean) => void;
  readonly onValidityChange: (valid: boolean) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [test, setTest] = useState<SchedulePreRunResultView>();
  const [content, setContent] = useState(""), [contentDirty, setContentDirty] = useState(false), [description, setDescription] = useState("");
  const [files, setFiles] = useState<readonly string[]>(), [file, setFile] = useState("");
  const [pending, setPending] = useState<{ id: string; kind: "prepare" | "test" }>();
  const [receiptReady, setReceiptReady] = useState(false);
  const request = useRef<AbortController | undefined>(undefined), retained = useRef<Hook>(draft.preRunHook);
  const owner = JSON.stringify([controller.state.activeProfile?.id, controller.state.activeProfile?.serverId, controller.state.connectionGeneration,
    draft.targetId, draft.backendId, draft.sessionMode === "bound" ? draft.sessionId : "", scheduleId, open]);
  const current = useRef({ owner, controller, onChange, onBusyChange }); current.current = { owner, controller, onChange, onBusyChange };
  const receiptKey = `joko.scheduleHook.operation:${JSON.stringify([controller.state.activeProfile?.id, controller.state.activeProfile?.serverId,
    draft.targetId, draft.backendId, scheduleId, draft.sessionMode === "bound" ? draft.sessionId : ""])}`;
  useEffect(() => {
    request.current?.abort(); request.current = undefined; setBusy(false); onBusyChange(false);
    setError(undefined); setTest(undefined); setContent(""); setContentDirty(false); setDescription(""); setFiles(undefined); setFile(""); retained.current = draft.preRunHook;
    setReceiptReady(false);
    try { const stored = window.localStorage.getItem(receiptKey); const value = stored ? JSON.parse(stored) as { id?: unknown; kind?: unknown } : undefined;
      if (value && typeof value.id === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(value.id) && (value.kind === "prepare" || value.kind === "test")) setPending({ id: value.id, kind: value.kind });
      else if (stored !== null) throw new Error("Invalid check receipt");
      else setPending(undefined);
      setReceiptReady(true);
    } catch { setPending(undefined); setError(t("scheduler.hook.receiptUnavailable")); }
    return () => { request.current?.abort(); onBusyChange(false); };
  }, [owner]);
  const enabled = draft.preRunHook !== undefined, online = open && controller.state.connectionState === "connected";
  useEffect(() => { const hook = draft.preRunHook; onValidityChange(!pending && (!enabled || !contentDirty && !!hook?.command.trim()
    && (hook.timeoutMs === undefined || Number.isSafeInteger(hook.timeoutMs) && hook.timeoutMs > 0))); }, [enabled, pending, contentDirty, draft.preRunHook, onValidityChange]);
  const locked = saving || busy || !online || !!pending;
  const change = (hook: Hook): void => { retained.current = hook; onChange(hook); setTest(undefined); setError(undefined); };
  const run = (action: (signal: AbortSignal, operationId?: string) => Promise<void>, kind?: "prepare" | "test", recovering = false): void => {
    if (saving || busy || !online || pending && !recovering || request.current || kind && !receiptReady) return;
    const abort = new AbortController(); request.current = abort; setBusy(true); onBusyChange(true); setError(undefined);
    void Promise.resolve().then(async () => {
      const id = kind ? crypto.randomUUID() : undefined;
      if (kind && id) { window.localStorage.setItem(receiptKey, JSON.stringify({ id, kind })); setPending({ id, kind }); }
      await action(abort.signal, id);
      if (kind) { window.localStorage.removeItem(receiptKey); if (!abort.signal.aborted && current.current.owner === owner) setPending(undefined); }
    }).catch(cause => {
      if (!abort.signal.aborted && current.current.owner === owner) setError(cause instanceof Error ? cause.message : t("error.unexpected"));
    }).finally(() => { if (request.current === abort) request.current = undefined;
      if (!abort.signal.aborted && current.current.owner === owner) { setBusy(false); current.current.onBusyChange(false); } });
  };
  const adopt = async (source: Parameters<AppController["prepareScheduleHook"]>[2], signal: AbortSignal, operationId?: string): Promise<void> => {
    const prepared = await controller.prepareScheduleHook(scheduleId, draft, source, signal, operationId);
    signal.throwIfAborted(); if (current.current.owner !== owner) return;
    retained.current = prepared.hook; current.current.onChange(prepared.hook); setTest(prepared.test);
    setContent(prepared.content); setContentDirty(false);
  };
  return <section className="schedule-editor__managed-hook" aria-label={t("scheduler.hook.title")}>
    <label><CheckboxControl checked={enabled} disabled={locked} onChange={event => {
      if (event.target.checked) onChange(retained.current ?? { command: "", filePath: "" });
      else { retained.current = draft.preRunHook; onChange(undefined); } setTest(undefined); setError(undefined);
    }} />{t("scheduler.hook.enable")}</label>
    {enabled && <>
      <p className="muted">{t("scheduler.hook.help")}</p>
      <label className="field"><span>{t("scheduler.hook.command")}</span><input value={draft.preRunHook!.command} disabled={locked} maxLength={32768}
        spellCheck={false} onChange={event => change({ ...draft.preRunHook!, command: event.target.value,
          filePath: event.target.value === draft.preRunHook!.command ? draft.preRunHook!.filePath : "" })} /></label>
      <label className="field"><span>{t("scheduler.hook.timeout")}</span><input type="number" min={1} step={1} disabled={locked}
        value={draft.preRunHook!.timeoutMs === undefined ? "" : draft.preRunHook!.timeoutMs / 1000}
        placeholder={t("scheduler.hook.unlimited")} onChange={event => change({ ...draft.preRunHook!, timeoutMs: event.target.value === "" ? undefined : Number(event.target.value) * 1000 })} /></label>
      <div className="toolbar-actions"><Button disabled={locked || !receiptReady || !draft.preRunHook!.command.trim()} onClick={() => run(async (signal, id) => {
        const result = await controller.testScheduleHook(scheduleId, draft, signal, id); signal.throwIfAborted(); if (current.current.owner === owner) setTest(result);
      }, "test")}>{t("scheduler.hook.test")}</Button><Button disabled={locked} onClick={() => run(async signal => {
        const target = controller.state.snapshot.targets.find(item => item.id === draft.targetId);
        if (!target) throw new Error(t("workspace.noWorkspace"));
        const listing = await controller.listWorkspaceFiles(target.workspaceId, signal); signal.throwIfAborted(); if (current.current.owner !== owner) return;
        setFiles(listing.paths.filter(path => /\.(?:mjs|cjs|js|py|sh|ps1|bat|cmd|exe)$/iu.test(path))); setFile("");
        if (listing.truncated) setError(t("scheduler.hook.filesTruncated"));
      })}>{t("scheduler.hook.browse")}</Button>
      {draft.preRunHook!.filePath && <Button disabled={locked || contentDirty} onClick={() => run(signal => adopt({ kind: "readCurrent", value: true }, signal))}>{t("scheduler.hook.editScript")}</Button>}</div>
      {files && <div className="toolbar-actions"><SelectControl value={file} disabled={locked} onChange={event => setFile(event.target.value)} aria-label={t("scheduler.hook.file")}>
        <option value="">{t("scheduler.hook.file")}</option>{files.map(path => <option key={path} value={path}>{path}</option>)}
      </SelectControl><Button disabled={locked || !file} onClick={() => run(signal => adopt({ kind: "workspaceFile", value: file }, signal))}>{t("common.confirm")}</Button></div>}
      <label className="field"><span>{t("scheduler.hook.script")}</span><textarea rows={5} disabled={locked} spellCheck={false} value={content} maxLength={262144}
        onChange={event => { setContent(event.target.value); setContentDirty(true); setTest(undefined); }} /></label>
      <Button disabled={locked || !receiptReady || !content.trim() || !contentDirty} onClick={() => run((signal, id) => adopt({ kind: "script", value: content }, signal, id), "prepare")}>{t("scheduler.hook.useScript")}</Button>
      {contentDirty && <p role="status">{t("scheduler.hook.scriptDraft")}</p>}
      <label className="field"><span>{t("scheduler.hook.description")}</span><textarea rows={2} value={description} maxLength={16384} disabled={locked}
        onChange={event => setDescription(event.target.value)} /></label>
      <Button disabled={locked || !receiptReady || !description.trim() || contentDirty} onClick={() => run((signal, id) => adopt({ kind: "description", value: description }, signal, id), "prepare")}>{t(draft.preRunHook!.filePath ? "scheduler.hook.modify" : "scheduler.hook.generate")}</Button>
      {test && <div role="status"><strong>{t(`scheduler.hook.result.${test.status}`)}</strong><p>{t("scheduler.hook.resultDetails", { code: test.exitCode ?? "—", ms: test.durationMs })}</p>
        {(test.error || test.stdout || test.stderr) && <pre>{[test.error, test.stdout, test.stderr].filter(Boolean).join("\n")}</pre>}
        {(test.stdoutTruncated || test.stderrTruncated) && <small>{t("scheduler.hook.outputTruncated")}</small>}</div>}
    </>}
    {pending && <div role="status"><p>{t("scheduler.hook.unknown")}</p><Button disabled={saving || busy || !online} onClick={() => run(async signal => {
      try { const result = await controller.getScheduleHookOperation(pending.id, signal); signal.throwIfAborted(); if (current.current.owner !== owner) return;
        if (result.state === "running") { setError(t("scheduler.hook.unknown")); return; }
        if (result.preparation) { retained.current = result.preparation.hook; current.current.onChange(result.preparation.hook); setContent(result.preparation.content); setContentDirty(false); setTest(result.preparation.test); }
        if (result.test) setTest(result.test);
        if (result.state === "failed") setError(result.error ?? t("scheduler.hook.failedRetry"));
        window.localStorage.removeItem(receiptKey); setPending(undefined);
      } catch (cause) { signal.throwIfAborted(); if (current.current.owner !== owner) return; if (cause instanceof ConnectError && cause.code === Code.NotFound) { window.localStorage.removeItem(receiptKey); setPending(undefined); setError(t("scheduler.hook.failedRetry")); } else throw cause; }
    }, undefined, true)}>{t("scheduler.hook.checkOperation")}</Button></div>}
    {busy && <p role="status">{t("common.working")}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
