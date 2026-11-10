import { useEffect, useRef, useState } from "react";
import { DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, parseProviderAccountResetSettings, ProviderAccountResetAvailability, ProviderAccountResetOutcome,
  type ProviderAccountResetApi, type ProviderAccountResetOffer, type ProviderAccountResetSettingsValue, type ProviderAccountResetState } from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { ProviderRuntimeView, Locale } from "../model.js";
import type { Translator } from "./types.js";
import { Button, Modal, Spinner } from "./ui.js";
import "./provider-account-resets.css";

export function ProviderAccountResets({ controller, runtime, locale, t, compact = false }: { readonly controller: AppController; readonly runtime: ProviderRuntimeView; readonly locale: Locale; readonly t: Translator; readonly compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const api = controller.providerAccountResets?.();
  if (!runtime.capabilities.has("provider.account_resets") || !api) return null;
  const controls = <ResetControls key={`${api.ownerKey}:${runtime.backendId}:${runtime.id}`} api={api} backendId={runtime.backendId} providerId={runtime.id} locale={locale} t={t} />;
  return compact ? <><Button className="provider-account-resets-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>{t("accountReset.title")}</Button>
    <Modal open={open} title={t("accountReset.title")} onClose={() => setOpen(false)} showClose closeLabel={t("common.close")}>{controls}</Modal></> : controls;
}

function ResetControls({ api, backendId, providerId, locale, t }: { readonly api: ProviderAccountResetApi; readonly backendId: string; readonly providerId: string; readonly locale: Locale; readonly t: Translator }) {
  const [state, setState] = useState<ProviderAccountResetState>(), [revision, setRevision] = useState(0), [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false), [actionFailed, setActionFailed] = useState(false), [invalid, setInvalid] = useState(false), [result, setResult] = useState<ProviderAccountResetOutcome>();
  const [settings, setSettings] = useState<ProviderAccountResetSettingsValue>(DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS), [days, setDays] = useState("3");
  const [confirmation, setConfirmation] = useState<{ readonly accountKey: string; readonly offer: ProviderAccountResetOffer }>();
  const apiRef = useRef(api); apiRef.current = api;
  const stateRef = useRef(state); stateRef.current = state;
  const lifetime = useRef(new AbortController());
  useEffect(() => { const owner = new AbortController(); lifetime.current = owner; return () => owner.abort(); }, []);
  useEffect(() => {
    const abort = new AbortController(); let live = true; setLoading(true); setFailed(false); const timer = setTimeout(() => abort.abort(), 30_000);
    void apiRef.current.read(backendId, providerId, abort.signal).then(value => { if (live) setState(value); })
      .catch(() => { if (live) setFailed(true); }).finally(() => { clearTimeout(timer); if (live) setLoading(false); });
    return () => { live = false; clearTimeout(timer); abort.abort(); };
  }, [backendId, providerId, revision]);
  useEffect(() => {
    const value = state?.automaticSettings; if (!value) return;
    setSettings({ enabled: value.enabled, lowQuota: value.lowQuota, minimumDays: value.minimumDays, expiring: value.expiring, expiryMinutes: value.expiryMinutes });
    setDays(String(value.minimumDays)); setInvalid(false); setResult(undefined); setConfirmation(undefined);
  }, [state?.accountKey, state?.settingsRevision?.value]);
  const change = (patch: Partial<ProviderAccountResetSettingsValue>) => setSettings(current => {
    const next = { ...current, ...patch }; return !next.lowQuota && !next.expiring ? { ...next, enabled: false } : next;
  });
  const action = async (offer?: ProviderAccountResetOffer, restore = false) => {
    if (!state || busy || lifetime.current.signal.aborted) return;
    let value: ProviderAccountResetSettingsValue | null = null;
    if (!offer && !restore) {
      try { if (!/^\d{1,3}$/u.test(days)) throw new Error(); value = parseProviderAccountResetSettings({ ...settings, minimumDays: Number(days) }); }
      catch { setInvalid(true); return; }
    }
    setBusy(true); setActionFailed(false); setInvalid(false); const account = state.accountKey;
    const current = () => !lifetime.current.signal.aborted && stateRef.current?.accountKey === account;
    try {
      if (offer) { const receipt = await apiRef.current.consume(state, offer, lifetime.current.signal); if (current()) setResult(receipt.outcome); }
      else await apiRef.current.save(state, value, lifetime.current.signal);
      if (current()) setRevision(value => value + 1);
    } catch { if (current()) { setActionFailed(true); if (offer) setRevision(value => value + 1); } }
    finally { if (current()) setBusy(false); }
  };
  const time = (value: { seconds: bigint; nanos: number } | undefined) => value ? new Date(Number(value.seconds) * 1000 + value.nanos / 1_000_000).toLocaleString(locale === "en-XA" ? "en" : locale) : "—";
  const ready = state?.availability === ProviderAccountResetAvailability.AVAILABLE;
  const disabled = busy || loading || failed || !ready;
  const offerButton = (offer: ProviderAccountResetOffer) => <Button disabled={disabled}
    onClick={() => state && setConfirmation({ accountKey: state.accountKey, offer })}>{t(offer.retryOnly ? "accountReset.retry" : "accountReset.use")}</Button>;
  const outcomes = { [ProviderAccountResetOutcome.RESET]: "accountReset.outcome.reset", [ProviderAccountResetOutcome.NOTHING_TO_RESET]: "accountReset.outcome.nothingToReset",
    [ProviderAccountResetOutcome.NO_CREDIT]: "accountReset.outcome.noCredit", [ProviderAccountResetOutcome.ALREADY_REDEEMED]: "accountReset.outcome.alreadyRedeemed" } as const;
  return <section className="provider-account-resets" aria-label={t("accountReset.title")}>
    <h3>{t("accountReset.title")}</h3>{loading && <Spinner label={t("accountReset.reading")} />}
    {(failed || actionFailed) && <p role="alert">{t("accountReset.failed")}</p>}{invalid && <p role="alert">{t("accountReset.invalid")}</p>}
    {result !== undefined && result !== ProviderAccountResetOutcome.UNSPECIFIED && <p role="status">{t(outcomes[result])}</p>}
    {state && !ready && <p>{t(state.availability === ProviderAccountResetAvailability.UNSUPPORTED ? "accountReset.unsupported" : "accountReset.unavailable")}</p>}
    {ready && state && <>
      <p>{t("accountReset.account", { account: state.accountLabel })}</p><p>{state.availableCount === undefined ? t("accountReset.unknownCount") : t("accountReset.count", { count: state.availableCount })}</p>
      {state.defaultOffer?.retryOnly && <p role="status">{t("accountReset.pending")}</p>}
      {state.defaultOffer && (!state.detailsAvailable || state.defaultOffer.retryOnly) && offerButton(state.defaultOffer)}
      <ul>{state.credits.map((credit, index) => <li key={credit.offer?.offerId ?? index}><strong>{credit.title || t("accountReset.credit")}</strong>
        <p>{t("accountReset.granted", { time: time(credit.grantedAt) })}</p>{credit.expiresAt && <p>{t("accountReset.expires", { time: time(credit.expiresAt) })}</p>}{credit.offer && offerButton(credit.offer)}</li>)}</ul>
      <fieldset disabled={disabled}><legend>{t("accountReset.automatic")}</legend><p>{t("accountReset.help")}</p>
        <label><input type="checkbox" checked={settings.enabled} disabled={!settings.lowQuota && !settings.expiring} onChange={event => change({ enabled: event.target.checked })} />{t("accountReset.enabled")}</label>
        <label><input type="checkbox" checked={settings.lowQuota} onChange={event => change({ lowQuota: event.target.checked })} />{t("accountReset.lowQuota")}</label>
        <label>{t("accountReset.minimumDays")}<input type="number" min={0} max={365} step={1} value={days} onChange={event => setDays(event.target.value)} /></label>
        <label><input type="checkbox" checked={settings.expiring} onChange={event => change({ expiring: event.target.checked })} />{t("accountReset.expiring")}</label>
        <label>{t("accountReset.expiryMinutes")}<select value={settings.expiryMinutes} onChange={event => change({ expiryMinutes: Number(event.target.value) })}>{[30, 60, 360, 1440].map(value => <option key={value} value={value}>{new Intl.NumberFormat(locale).format(value)}</option>)}</select></label>
        <Button onClick={() => void action()}>{t("accountReset.save")}</Button><Button onClick={() => void action(undefined, true)}>{t("accountReset.defaults")}</Button>
      </fieldset>{state.customized && <p>{t("accountReset.customized")}</p>}{state.lastAutomaticUse && <p>{t("accountReset.lastUsed", { time: time(state.lastAutomaticUse) })}</p>}
    </>}
    <Button disabled={busy || loading} onClick={() => setRevision(current => current + 1)}>{t("accountReset.refresh")}</Button>
    <Modal open={confirmation !== undefined} title={t(confirmation?.offer.retryOnly ? "accountReset.confirmRetry" : "accountReset.confirm")} onClose={() => setConfirmation(undefined)}
      description={confirmation && state ? t(confirmation.offer.retryOnly ? "accountReset.confirmRetryBody" : "accountReset.confirmBody", {
        account: state.accountLabel, credit: state.credits.find(credit => credit.offer?.offerId === confirmation.offer.offerId)?.title || t("accountReset.credit"), expiry: time(confirmation.offer.expiresAt)
      }) : undefined} size="small" dialogRole="alertdialog">
      <Button onClick={() => setConfirmation(undefined)}>{t("accountReset.cancel")}</Button><Button disabled={disabled} onClick={() => {
        const pending = confirmation, current = stateRef.current; setConfirmation(undefined);
        if (pending && current?.accountKey === pending.accountKey && [current.defaultOffer, ...current.credits.map(credit => credit.offer)].some(offer => offer?.offerId === pending.offer.offerId)) void action(pending.offer);
      }}>{t(confirmation?.offer.retryOnly ? "accountReset.retry" : "accountReset.use")}</Button>
    </Modal>
  </section>;
}
