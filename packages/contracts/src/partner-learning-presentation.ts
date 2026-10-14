import { PartnerLearningAction, PartnerLearningKind, type PartnerLearningFeedback } from "./gen/joko/v1/event_pb.js";

export type PartnerLearningSettingsDestination = "memory" | "skills";
export interface PartnerLearningReceiptView {
  readonly kind: "memory" | "skill";
  readonly entryId: string;
  readonly title: string;
  readonly action: "created" | "updated";
}
export interface PartnerLearningFeedbackView {
  readonly receipts: readonly PartnerLearningReceiptView[];
  readonly revision: bigint;
}
export interface PartnerLearningRow {
  readonly kind: PartnerLearningReceiptView["kind"];
  readonly title: string;
  readonly action: PartnerLearningReceiptView["action"];
  readonly destination: PartnerLearningSettingsDestination;
}

const forbiddenDisplay = /[\u0000-\u001f\u007f]/u;

/** Generated current-v1 metadata only. Tool output and model plans are never receipt authority. */
export function projectPartnerLearningFeedback(value: PartnerLearningFeedback | undefined): PartnerLearningFeedbackView | undefined {
  if (value === undefined) return undefined;
  if (!value.revision || value.revision.value <= 0n || !Array.isArray(value.receipts)) throw new Error("Invalid Partner learning feedback.");
  const receipts = new Map<string, PartnerLearningReceiptView>();
  for (const receipt of value.receipts) {
    const kind = receipt.kind === PartnerLearningKind.MEMORY ? "memory" : receipt.kind === PartnerLearningKind.SKILL ? "skill" : undefined;
    const action = receipt.action === PartnerLearningAction.CREATED ? "created" : receipt.action === PartnerLearningAction.UPDATED ? "updated" : undefined;
    if (!kind || !action || !receipt.entryId || receipt.entryId !== receipt.entryId.trim() || receipt.entryId.length > 256 || forbiddenDisplay.test(receipt.entryId)
      || !receipt.title || receipt.title !== receipt.title.trim() || Array.from(receipt.title).length > 100 || forbiddenDisplay.test(receipt.title)) {
      throw new Error("Invalid Partner learning receipt.");
    }
    receipts.set(`${kind}:${receipt.entryId}`, { kind, entryId: receipt.entryId, title: receipt.title, action });
  }
  return { revision: value.revision.value, receipts: [...receipts.values()].sort((a, b) => Number(a.kind === "skill") - Number(b.kind === "skill")) };
}

/** Two quiet summaries preserve the complete safe titles and original receipt identities. */
export function partnerLearningRows(feedback: PartnerLearningFeedbackView | undefined): readonly PartnerLearningRow[] {
  return (["memory", "skill"] as const).flatMap(kind => {
    const receipts = feedback?.receipts.filter(receipt => receipt.kind === kind) ?? [];
    return receipts.length === 0 ? [] : [{ kind, title: receipts.map(receipt => receipt.title).join(" · "),
      action: receipts.some(receipt => receipt.action === "updated") ? "updated" as const : "created" as const,
      destination: kind === "memory" ? "memory" as const : "skills" as const }];
  });
}
