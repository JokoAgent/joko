import { useEffect, useRef, useState } from "react";
import { contextBudgetOptions, type SessionContextBudgetView } from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { SessionView } from "../model.js";
import type { Translator } from "./types.js";
import { formatTokenCount } from "./ContextCapacityRing.js";
import { Button, Modal, Spinner } from "./ui.js";

export function SessionContextBudget({ controller, session, supported, t }: { readonly controller: AppController; readonly session: SessionView; readonly supported: boolean; readonly t: Translator }) {
  const [open, setOpen] = useState(false);
  if (!supported || !controller.getSessionContextBudget || !controller.setSessionContextBudget) return null;
  return <><Button onClick={() => setOpen(true)}>{t("contextBudget.title")}</Button>
    <Modal open={open} onClose={() => setOpen(false)} title={t("contextBudget.title")} closeLabel={t("common.close")} showClose size="small">
      {open && <BudgetEditor key={`${session.id}:${session.generation}:${session.backendId}:${session.model?.providerId}:${session.model?.modelId}`} controller={controller} session={session} t={t} />}
    </Modal></>;
}
function BudgetEditor({ controller, session, t }: { readonly controller: AppController; readonly session: SessionView; readonly t: Translator }) {
  const [view, setView] = useState<SessionContextBudgetView>(), [error, setError] = useState(false), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const abortRef = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const abort = new AbortController(); abortRef.current = abort; let live = true;
    setView(undefined); setError(false);
    void controller.getSessionContextBudget!(session.id, session.generation, abort.signal)
      .then(value => { if (live && !abort.signal.aborted) setView(value); }).catch(() => { if (live && !abort.signal.aborted) setError(true); });
    return () => { live = false; abort.abort(); if (abortRef.current === abort) abortRef.current = undefined; };
  }, [controller, session.id, session.generation, reload]);
  const options = view ? contextBudgetOptions({ defaultWindow: numeric(view.defaultWindowTokens), maximumWindow: numeric(view.maximumWindowTokens), modelLimit: numeric(view.modelLimitTokens) }) : [];
  const current = numeric(view?.budgetTokens), defaultWindow = numeric(view?.defaultWindowTokens);
  const effective = numeric(view?.effectiveWindowTokens);
  const save = async (tokens: number | undefined) => {
    const original = view, abort = abortRef.current; if (!original || !abort || busy || abort.signal.aborted) return;
    setBusy(true); setError(false);
    try { await controller.setSessionContextBudget!(original, tokens, abort.signal);
      const next = await controller.getSessionContextBudget!(session.id, session.generation, abort.signal);
      if (!abort.signal.aborted && abortRef.current === abort) setView(next);
    } catch { if (!abort.signal.aborted && abortRef.current === abort) setError(true); }
    finally { if (!abort.signal.aborted && abortRef.current === abort) setBusy(false); }
  };
  return <div className="session-context-budget">
    <p>{t("contextBudget.help")}</p>
    {!view && !error && <Spinner label={t("settings.providerGroups.loading")} />}
    {error && <p role="alert">{t("contextBudget.failed")}</p>}
    {view && <>
      {view.canConfigure ? <label>{t("contextBudget.title")}<select aria-label={t("contextBudget.title")} disabled={busy || error} value={current === undefined ? "default" : String(current)} onChange={event => void save(event.target.value === "default" ? undefined : Number(event.target.value))}>
        <option value="default">{t("contextBudget.default", { tokens: defaultWindow ? formatTokenCount(defaultWindow) : "—" })}</option>
        {options.filter(value => !value.isDefault).map(value => <option key={value.tokens} value={value.tokens}>{formatTokenCount(value.tokens)}</option>)}
        {current !== undefined && !options.some(value => !value.isDefault && value.tokens === current) && <option value={current}>{t("contextBudget.current", { tokens: formatTokenCount(current) })}</option>}
      </select></label> : <p>{t("contextBudget.unsupported")}</p>}
      {effective !== undefined && <p>{t("contextBudget.effective", { tokens: formatTokenCount(effective) })}</p>}
      {effective !== undefined && (session.context?.usedTokens ?? 0) > effective && <p>{t("contextBudget.compactSoon")}</p>}
    </>}
    {error && <Button disabled={busy} onClick={() => setReload(value => value + 1)}>{t("common.retry")}</Button>}
  </div>;
}
function numeric(value: bigint | undefined): number | undefined { return value === undefined ? undefined : Number(value); }
