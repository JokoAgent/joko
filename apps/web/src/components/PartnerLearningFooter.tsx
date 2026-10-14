import { BookOpen, Brain } from "lucide-react";
import { partnerLearningMessage, partnerLearningRows, type PartnerLearningFeedbackView, type PartnerLearningSettingsDestination } from "@joko/contracts";

export function PartnerLearningFooter({ feedback, locale, disabled, onOpen }: {
  readonly feedback?: PartnerLearningFeedbackView;
  readonly locale: string;
  readonly disabled: boolean;
  readonly onOpen: (destination: PartnerLearningSettingsDestination) => void;
}) {
  const rows = partnerLearningRows(feedback);
  if (rows.length === 0) return null;
  return <div className="partner-learning-footer" data-partner-learning-footer>
    {rows.map(row => { const Icon = row.kind === "memory" ? Brain : BookOpen; return <button type="button" key={row.kind}
      disabled={disabled} onClick={() => onOpen(row.destination)} title={partnerLearningMessage(locale, row)}>
      <Icon size={13} aria-hidden="true" /><span>{partnerLearningMessage(locale, row)}</span>
    </button>; })}
  </div>;
}
