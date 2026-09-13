import { useEffect, useRef, useState } from "react";
import type { JSX, Ref } from "react";

import type { AppController } from "../controller.js";
import type { ModelPriceOverrideView, ModelPriceQuoteView, ModelView } from "../model.js";
import type { Translator } from "./types.js";
import { Button, ErrorBanner, Modal, SelectControl, Spinner, cx } from "./ui.js";

type ModelPriceOperations = Pick<AppController,
  "getModelPriceOverride" | "setModelPriceOverride" | "resetModelPriceOverride"
>;

interface ModelPriceDraft {
  readonly currency: ModelPriceQuoteView["currency"];
  readonly input: string;
  readonly output: string;
  readonly cacheRead: string;
  readonly cacheWrite: string;
}

export interface ModelPriceVariant {
  readonly model: ModelView;
  readonly label: string;
}

export function ModelPriceOverrideDialog({ controller, model, variants, t, onClose }: {
  readonly controller: ModelPriceOperations;
  readonly model?: ModelView;
  readonly variants?: readonly ModelPriceVariant[];
  readonly t: Translator;
  readonly onClose: () => void;
}): JSX.Element {
  const [selectedModelKey, setSelectedModelKey] = useState<string>();
  const [price, setPrice] = useState<ModelPriceOverrideView>();
  const [draft, setDraft] = useState<ModelPriceDraft>();
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<"save" | "reset">();
  const [error, setError] = useState<"load" | "save" | "reset">();
  const inputRef = useRef<HTMLInputElement>(null);
  const requestEpochRef = useRef(0);
  const focusWhenReadyRef = useRef(false);
  const candidates = model === undefined
    ? []
    : variants?.some((candidate) => modelRouteKey(candidate.model) === modelRouteKey(model)) === true
      ? variants
      : [{ model, label: model.backendId }];
  const activeModel = candidates.find((candidate) => modelRouteKey(candidate.model) === selectedModelKey)?.model
    ?? candidates.find((candidate) => modelRouteKey(candidate.model) === modelRouteKey(model!))?.model
    ?? candidates[0]?.model;

  useEffect(() => {
    setSelectedModelKey(model === undefined ? undefined : modelRouteKey(model));
  }, [model]);

  useEffect(() => {
    const epoch = ++requestEpochRef.current;
    setPrice(undefined);
    setDraft(undefined);
    setError(undefined);
    if (activeModel === undefined) {
      focusWhenReadyRef.current = false;
      setLoading(false);
      return;
    }
    focusWhenReadyRef.current = true;
    const abort = new AbortController();
    setLoading(true);
    void controller.getModelPriceOverride(activeModel.backendId, activeModel.providerId, activeModel.modelId, abort.signal).then((value) => {
      if (requestEpochRef.current !== epoch) return;
      setPrice(value);
      setDraft(modelPriceDraft(modelPriceInitialQuote(value), value.allowedCurrencies[0]));
      setLoading(false);
    }).catch(() => {
      if (requestEpochRef.current !== epoch || abort.signal.aborted) return;
      setError("load");
      setLoading(false);
    });
    return () => abort.abort();
  }, [activeModel, controller]);
  useEffect(() => {
    if (loading || draft === undefined || !focusWhenReadyRef.current) return;
    focusWhenReadyRef.current = false;
    inputRef.current?.focus();
  }, [draft, loading]);

  const desired = draft === undefined ? undefined : modelPriceQuote(draft);
  const busy = pending !== undefined;
  const updateDraft = (change: Partial<ModelPriceDraft>): void => {
    setDraft((current) => current === undefined ? current : { ...current, ...change });
  };
  const save = async (): Promise<void> => {
    if (activeModel === undefined || desired === undefined || busy) return;
    const epoch = requestEpochRef.current;
    setPending("save");
    setError(undefined);
    try {
      await controller.setModelPriceOverride(activeModel.backendId, activeModel.providerId, activeModel.modelId, desired);
      if (requestEpochRef.current === epoch) onClose();
    } catch {
      if (requestEpochRef.current === epoch) setError("save");
    } finally {
      if (requestEpochRef.current === epoch) setPending(undefined);
    }
  };
  const reset = async (): Promise<void> => {
    if (activeModel === undefined || busy) return;
    const epoch = requestEpochRef.current;
    setPending("reset");
    setError(undefined);
    try {
      const value = await controller.resetModelPriceOverride(activeModel.backendId, activeModel.providerId, activeModel.modelId);
      if (requestEpochRef.current !== epoch) return;
      setPrice(value);
      setDraft(modelPriceDraft(modelPriceInitialQuote(value), value.allowedCurrencies[0]));
    } catch {
      if (requestEpochRef.current === epoch) setError("reset");
    } finally {
      if (requestEpochRef.current === epoch) setPending(undefined);
    }
  };

  return <Modal
    open={model !== undefined}
    title={t("settings.modelPrice.title", { name: model?.name ?? "" })}
    description={t("settings.modelPrice.description")}
    closeLabel={t("common.close")}
    showClose
    size="medium"
    className="model-price-dialog"
    initialFocus={() => inputRef.current}
    onClose={onClose}
  >
    {candidates.length > 1 && <div className="model-price-dialog__variants" role="tablist" aria-label={t("settings.modelPrice.routes")}>
      {candidates.map((candidate) => {
        const key = modelRouteKey(candidate.model);
        const selected = key === modelRouteKey(activeModel!);
        return <button type="button" role="tab" aria-selected={selected} className={cx(selected && "is-active")} disabled={busy} key={key} onClick={() => setSelectedModelKey(key)}>{candidate.label}</button>;
      })}
    </div>}
    {loading && <div className="model-price-dialog__loading" aria-busy="true"><Spinner label={t("settings.modelPrice.loading")} /></div>}
    {error !== undefined && <ErrorBanner
      message={t(`settings.modelPrice.${error}Failed`)}
      {...(error === "load" && activeModel !== undefined ? { onRetry: () => {
        const current = activeModel;
        const epoch = ++requestEpochRef.current;
        setError(undefined);
        setLoading(true);
        void controller.getModelPriceOverride(current.backendId, current.providerId, current.modelId).then((value) => {
          if (requestEpochRef.current !== epoch) return;
          setPrice(value);
          setDraft(modelPriceDraft(modelPriceInitialQuote(value), value.allowedCurrencies[0]));
          setLoading(false);
        }).catch(() => {
          if (requestEpochRef.current !== epoch) return;
          setError("load");
          setLoading(false);
        });
      } } : {})}
    />}
    {price !== undefined && draft !== undefined && <form className="settings-form model-price-dialog__form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="model-price-dialog__grid">
        <label className="field model-price-dialog__currency"><span>{t("settings.modelPrice.currency")}</span><SelectControl value={draft.currency} disabled={busy} onChange={(event) => updateDraft({ currency: event.target.value as ModelPriceQuoteView["currency"] })}>{price.allowedCurrencies.map((currency) => <option key={currency} value={currency}>{currency}</option>)}</SelectControl></label>
        <PriceInput inputRef={inputRef} label={t("settings.modelPrice.input")} value={draft.input} disabled={busy} onChange={(input) => updateDraft({ input })} />
        <PriceInput label={t("settings.modelPrice.output")} value={draft.output} disabled={busy} onChange={(output) => updateDraft({ output })} />
        <PriceInput label={t("settings.modelPrice.cacheRead")} value={draft.cacheRead} disabled={busy} optional onChange={(cacheRead) => updateDraft({ cacheRead })} />
        <PriceInput label={t("settings.modelPrice.cacheWrite")} value={draft.cacheWrite} disabled={busy} optional onChange={(cacheWrite) => updateDraft({ cacheWrite })} />
      </div>
      <p className="model-price-dialog__unit">{t("settings.modelPrice.unit")}{price.registryUpdatedAt === undefined ? "" : ` · ${t("settings.modelPrice.registryDate", { date: new Date(price.registryUpdatedAt).toISOString().slice(0, 10) })}`}</p>
      {desired === undefined && <p className="model-price-dialog__validation" role="alert">{t("settings.modelPrice.invalid")}</p>}
      <div className="model-price-dialog__footer">
        <div>{price.override !== undefined && <Button type="button" disabled={busy} onClick={() => void reset()}>{pending === "reset" ? t("common.working") : t("settings.modelPrice.reset")}</Button>}</div>
        <div className="model-price-dialog__footer-actions">
          <Button type="button" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" tone="primary" disabled={busy || desired === undefined}>{pending === "save" ? t("common.working") : t("common.save")}</Button>
        </div>
      </div>
    </form>}
  </Modal>;
}

function PriceInput({ inputRef, label, value, disabled, optional = false, onChange }: {
  readonly inputRef?: Ref<HTMLInputElement>;
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly optional?: boolean;
  readonly onChange: (value: string) => void;
}): JSX.Element {
  return <label className="field"><span>{label}</span><input ref={inputRef} type="number" min="0" step="any" required={!optional} disabled={disabled} value={value} placeholder={optional ? "—" : "0"} onChange={(event) => onChange(event.target.value)} /></label>;
}

function modelPriceInitialQuote(price: ModelPriceOverrideView): ModelPriceQuoteView | undefined {
  return price.override ?? (price.referenceAvailable ? price.reference : undefined);
}

function modelPriceDraft(quote: ModelPriceQuoteView | undefined, fallbackCurrency: ModelPriceQuoteView["currency"] = "USD"): ModelPriceDraft {
  return {
    currency: quote?.currency ?? fallbackCurrency,
    input: quote === undefined ? "" : String(quote.inputPerMillion),
    output: quote === undefined ? "" : String(quote.outputPerMillion),
    cacheRead: quote?.cacheReadPerMillion === undefined ? "" : String(quote.cacheReadPerMillion),
    cacheWrite: quote?.cacheWritePerMillion === undefined ? "" : String(quote.cacheWritePerMillion)
  };
}

function modelRouteKey(model: ModelView): string {
  return `${model.backendId}\u0000${model.providerId}\u0000${model.modelId}`;
}

function modelPriceQuote(draft: ModelPriceDraft): ModelPriceQuoteView | undefined {
  const inputPerMillion = requiredPrice(draft.input);
  const outputPerMillion = requiredPrice(draft.output);
  const cacheReadPerMillion = optionalPrice(draft.cacheRead);
  const cacheWritePerMillion = optionalPrice(draft.cacheWrite);
  if (inputPerMillion === undefined || outputPerMillion === undefined || cacheReadPerMillion === null || cacheWritePerMillion === null) return undefined;
  return {
    currency: draft.currency,
    inputPerMillion,
    outputPerMillion,
    ...(cacheReadPerMillion === undefined ? {} : { cacheReadPerMillion }),
    ...(cacheWritePerMillion === undefined ? {} : { cacheWritePerMillion })
  };
}

function requiredPrice(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function optionalPrice(value: string): number | undefined | null {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
