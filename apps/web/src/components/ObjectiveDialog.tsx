import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import type { ObjectiveLimitsView, ObjectiveView } from "../model.js";
import type { Translator } from "./types.js";
import { Button, Modal, SelectControl } from "./ui.js";

const UNLIMITED = "unlimited";
const MAXIMUM_TURN_PRESETS = [10, 20, 50, 100] as const;
const TOKEN_BUDGET_PRESETS = [500_000, 1_000_000, 2_000_000, 5_000_000] as const;
const NO_PROGRESS_PRESETS = [2, 3, 5] as const;

export interface ObjectiveDialogLimits {
  readonly maximumTurns: number | null;
  readonly tokenBudget: number | null;
  readonly noProgressTurnLimit: number | null;
}

export const DEFAULT_OBJECTIVE_DIALOG_LIMITS: ObjectiveDialogLimits = {
  maximumTurns: null,
  tokenBudget: null,
  noProgressTurnLimit: 3
};

export function ObjectiveDialog({
  open,
  objective,
  initialText = "",
  ownerDocument,
  t,
  onClose,
  onSubmit,
  onSaved
}: {
  readonly open: boolean;
  readonly objective?: ObjectiveView;
  readonly initialText?: string;
  readonly ownerDocument?: Document;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onSubmit: (text: string, limits: ObjectiveDialogLimits) => Promise<void>;
  readonly onSaved?: () => void;
}): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [limits, setLimits] = useState<ObjectiveDialogLimits>(DEFAULT_OBJECTIVE_DIALOG_LIMITS);
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) {
      setText("");
      setLimits(DEFAULT_OBJECTIVE_DIALOG_LIMITS);
      setAdvanced(false);
      setSaving(false);
      setError(undefined);
      return;
    }
    setText(objective?.text ?? initialText);
    setLimits(objective === undefined ? DEFAULT_OBJECTIVE_DIALOG_LIMITS : {
      maximumTurns: objective.maximumTurns ?? null,
      tokenBudget: objective.tokenBudget ?? null,
      noProgressTurnLimit: objective.noProgressTurnLimit ?? null
    });
    setAdvanced(false);
    setError(undefined);
  }, [open]);

  const trimmed = text.trim();
  const save = async (): Promise<void> => {
    if (saving || trimmed === "") return;
    setSaving(true);
    setError(undefined);
    try {
      await onSubmit(trimmed, limits);
      onSaved?.();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("objective.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return <Modal
    open={open}
    title={objective === undefined ? t("objective.createTitle") : t("objective.editTitle")}
    description={t("objective.dialogDescription")}
    onClose={() => { if (!saving) onClose(); }}
    closeLabel={t("common.close")}
    size="medium"
    dismissOnBackdrop={!saving}
    initialFocus={() => textareaRef.current}
    ownerDocument={ownerDocument}
  >
    <div className="objective-dialog">
      <label className="objective-dialog__field">
        <span>{t("objective.objectiveLabel")}</span>
        <textarea
          ref={textareaRef}
          value={text}
          rows={5}
          maxLength={32_000}
          disabled={saving}
          placeholder={t("objective.placeholder")}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void save();
            }
          }}
        />
      </label>
      <button className="objective-dialog__advanced-toggle" type="button" disabled={saving} aria-expanded={advanced} onClick={() => setAdvanced((value) => !value)}>
        {advanced ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
        {t("objective.advanced")}
      </button>
      {advanced && <div className="objective-dialog__advanced">
        <small>{t("objective.advancedHint")}</small>
        <ObjectiveLimitRow label={t("objective.maximumTurns")} value={limits.maximumTurns} presets={MAXIMUM_TURN_PRESETS} disabled={saving} unlimitedLabel={t("objective.unlimited")} onChange={(maximumTurns) => setLimits((current) => ({ ...current, maximumTurns }))} />
        <ObjectiveLimitRow label={t("objective.tokenBudget")} value={limits.tokenBudget} presets={TOKEN_BUDGET_PRESETS} disabled={saving} unlimitedLabel={t("objective.unlimited")} format={formatTokens} onChange={(tokenBudget) => setLimits((current) => ({ ...current, tokenBudget }))} />
        <ObjectiveLimitRow label={t("objective.noProgressTurnLimit")} value={limits.noProgressTurnLimit} presets={NO_PROGRESS_PRESETS} disabled={saving} unlimitedLabel={t("objective.unlimited")} onChange={(noProgressTurnLimit) => setLimits((current) => ({ ...current, noProgressTurnLimit }))} />
      </div>}
      {error !== undefined && <p className="objective-dialog__error" role="alert">{error}</p>}
      <div className="modal__actions">
        <Button disabled={saving} onClick={onClose}>{t("common.cancel")}</Button>
        <Button tone="primary" disabled={saving || trimmed === ""} onClick={() => { void save(); }}>
          {saving ? t("objective.saving") : objective === undefined ? t("objective.start") : t("common.save")}
        </Button>
      </div>
    </div>
  </Modal>;
}

function ObjectiveLimitRow({ label, value, presets, format = String, disabled, unlimitedLabel, onChange }: {
  readonly label: string;
  readonly value: number | null;
  readonly presets: readonly number[];
  readonly format?: (value: number) => string;
  readonly disabled: boolean;
  readonly unlimitedLabel: string;
  readonly onChange: (value: number | null) => void;
}): JSX.Element {
  const values = value !== null && !presets.includes(value) ? [value, ...presets] : presets;
  return <label className="objective-dialog__limit">
    <span>{label}</span>
    <SelectControl
      value={value === null ? UNLIMITED : String(value)}
      disabled={disabled}
      aria-label={label}
      onChange={(event) => onChange(event.target.value === UNLIMITED ? null : Number(event.target.value))}
    >
      {values.map((preset) => <option value={preset} key={preset}>{format(preset)}</option>)}
      <option value={UNLIMITED}>{unlimitedLabel}</option>
    </SelectControl>
  </label>;
}

function formatTokens(value: number): string {
  if (value % 1_000_000 === 0) return `${value / 1_000_000}M`;
  if (value % 1_000 === 0) return `${value / 1_000}K`;
  return String(value);
}

export function objectiveLimitsFromDialog(value: ObjectiveDialogLimits): ObjectiveLimitsView {
  return {
    ...(value.maximumTurns === null ? {} : { maximumTurns: value.maximumTurns }),
    ...(value.tokenBudget === null ? {} : { tokenBudget: value.tokenBudget }),
    ...(value.noProgressTurnLimit === null ? {} : { noProgressTurnLimit: value.noProgressTurnLimit })
  };
}
