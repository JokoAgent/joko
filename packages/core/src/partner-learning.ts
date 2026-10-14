/** Display-only facts from a successful, private memory or Skill write. */
export interface PartnerLearningReceipt {
  readonly kind: "memory" | "skill";
  readonly entryId: string;
  readonly title: string;
  readonly action: "created" | "updated";
}

export interface PartnerLearningFeedback {
  readonly receipts: readonly PartnerLearningReceipt[];
  readonly revision: string;
}

/** Private Host provenance, captured synchronously from an Adapter's original
 * turn. Public tool arguments and clients cannot author this authority. */
export interface PartnerLearningTurnSource {
  readonly occurrenceId: string;
  readonly sessionId: string;
  readonly targetId: string;
  readonly backendId: string;
  readonly backendInstanceGeneration: number;
  readonly bindingGeneration: number;
  readonly bindingFingerprint: string;
  readonly sourceRunId: string;
  readonly sourceAttemptId: string;
  readonly sourceQueueItemId: string;
  readonly operationId?: string;
  readonly nativeOccurrence: string;
  readonly nativeTurnId?: string;
}
