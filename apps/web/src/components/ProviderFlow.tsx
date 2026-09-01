import type { JSX, ReactNode } from "react";
import { Check } from "lucide-react";

import type { Translator } from "./types.js";
import { ModalBackButton, cx } from "./ui.js";

export function ProviderWizardProgress({ activeStep, t }: {
  readonly activeStep: 1 | 2 | 3;
  readonly t: Translator;
}): JSX.Element {
  const steps = [
    t("settings.providerWizard.choose"),
    t("settings.providerWizard.connect"),
    t("settings.providerWizard.chooseModels")
  ];
  return <ol className="provider-wizard-progress" aria-label={t("settings.addProvider")}>
    {steps.map((label, index) => {
      const step = index + 1;
      const done = step < activeStep;
      return <li className={cx(step === activeStep && "is-active", done && "is-done")} key={label}>
        <span aria-hidden="true">{done ? <Check /> : step}</span>
        <span>{label}</span>
      </li>;
    })}
  </ol>;
}

export function ProviderFlowBackButton({ onBack, disabled = false, t }: {
  readonly onBack: () => void;
  readonly disabled?: boolean;
  readonly t: Translator;
}): JSX.Element {
  return <ModalBackButton
    className="provider-flow-header-back"
    label={t("common.back")}
    disabled={disabled}
    onClick={onBack}
  />;
}

export function ProviderFlowFooter({ children, className }: {
  readonly children: ReactNode;
  readonly className?: string;
}): JSX.Element {
  return <div className={cx("provider-flow-footer", className)}>
    <span className="provider-flow-footer__actions">{children}</span>
  </div>;
}
