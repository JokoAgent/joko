import type { MobileComposerDraft } from "./mobile-composer-document";
import type { MobileTaskOutboxRecord } from "./mobile-task-outbox";
import { mobileInputSummary, mobileComposerInput } from "./mobile-composer-document";
import type { TimelineRow } from "./timeline";

export interface MobilePendingSendProgress {
  readonly phase: "preparing" | "uploading" | "sending" | "queued" | "waiting" | "unknown" | "failed";
  readonly input: MobileComposerDraft;
  readonly sentAt: number;
  readonly attachmentId?: string;
  readonly error?: string;
  readonly outboxId?: string;
}

export function mobilePendingSendText(input: MobileComposerDraft): string {
  return input.text.trim() ? mobileInputSummary(mobileComposerInput({ ...input, attachments: [] })) : "";
}

/** These are render hints from the original outbox, never a second delivery ledger. */
export function projectMobilePendingOutboxRows(rows: readonly TimelineRow[], records: readonly MobileTaskOutboxRecord[],
  connected: boolean): readonly TimelineRow[] {
  if (!records.length) return rows;
  const pending = new Map(records.map(record => [record.operationId, record]));
  const decorate = (row: TimelineRow, record: MobileTaskOutboxRecord): TimelineRow => ({ ...row,
    startedAtMs: record.createdAt, pendingSend: { input: record.input, sentAt: record.createdAt, outboxId: record.id,
      phase: record.state === "confirming" ? "unknown" : record.state === "failed" ? "failed"
        : !connected ? "waiting" : record.uploadAttachmentId ? "uploading" : "preparing",
      ...(record.uploadAttachmentId ? { attachmentId: record.uploadAttachmentId } : {}), ...(record.error ? { error: record.error } : {}) } });
  const result = rows.map(row => {
    const record = row.operationId ? pending.get(row.operationId) : undefined;
    if (!record) return row;
    pending.delete(record.operationId);
    return row.optimistic ? decorate(row, record) : row;
  });
  for (const record of pending.values()) result.push(decorate({ id: `optimistic-user:${record.operationId}`, eventId: record.operationId,
    label: "You", text: mobilePendingSendText(record.input), sequence: 0n, kind: "user", completed: false,
    operationId: record.operationId, optimistic: true }, record));
  return result;
}
