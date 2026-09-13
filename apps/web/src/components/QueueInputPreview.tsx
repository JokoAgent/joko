import { Braces, FileText, Folder, Image as ImageIcon, MessageSquare, Paperclip } from "lucide-react";
import type { JSX, ReactNode } from "react";
import type { QueueItemView, TimelineInputMentionRangeView, TimelineInputMentionView } from "../model.js";
import { parseSelectionQuoteMessage, selectionQuoteTextSourceSegments } from "../selection-quote.js";
import { SelectionQuoteChip } from "./SelectionQuoteChip.js";
import { buildSentPastedTextMessageSegments } from "./sent-pasted-text.js";
import { sentInputMentionSegments, validSentInputMentionRanges } from "./timeline-references.js";
import type { Translator } from "./types.js";

/**
 * Read-only projection of the exact accepted queue input. Metadata-backed
 * atoms stay static here so queue-row keyboard and drag controls remain the
 * only interaction surface.
 */
export function QueueInputPreview({
  text,
  quotesEncoded = false,
  pastedTextRanges = [],
  inputMentions = [],
  mentionRanges = [],
  attachments = [],
  t
}: QueueItemView & { readonly t: Translator }): JSX.Element {
  const parsed = parseSelectionQuoteMessage(text, quotesEncoded);
  const textSources = selectionQuoteTextSourceSegments(text, quotesEncoded);
  const pastedSegments = buildSentPastedTextMessageSegments(text, quotesEncoded, pastedTextRanges);
  const validMentionRanges = validSentInputMentionRanges(text, inputMentions, mentionRanges);
  const renderedMentionIndexes = new Set<number>();
  let textSegmentIndex = 0;

  return <span className="queue-strip__text queue-input-preview">
    <span className="queue-input-preview__content">
      {parsed.segments.map((segment, segmentIndex) => {
        if (segment.kind === "quote") {
          return <SelectionQuoteChip quote={segment.quote} key={`quote:${segmentIndex}`} />;
        }
        const source = textSources[textSegmentIndex];
        const pasted = pastedSegments[textSegmentIndex];
        textSegmentIndex += 1;
        if (source === undefined || pasted === undefined) {
          return <span className="queue-input-preview__text" key={`text:${segmentIndex}`}>{segment.text}</span>;
        }
        const sourceMatches = text.slice(source.sourceStart, source.sourceEnd) === segment.text
          && pasted.text === segment.text;
        let tokenStart = 0;
        return <span className="queue-input-preview__text" key={`text:${segmentIndex}`}>{pasted.tokens.map((token, tokenIndex) => {
          const start = tokenStart;
          tokenStart += token.text.length;
          if (token.kind === "pasted") {
            return <span className="queue-input-preview__chip queue-input-preview__pasted-text" data-queue-pasted-text="" title={token.display} aria-label={token.display} key={`pasted:${tokenIndex}`}>
              <FileText aria-hidden="true" /><span>{token.display}</span>
            </span>;
          }
          return <span key={`plain:${tokenIndex}`}>{renderTextWithMentions(
            token.text,
            sourceMatches ? source.sourceStart + start : undefined,
            inputMentions,
            validMentionRanges,
            renderedMentionIndexes,
            t
          )}</span>;
        })}</span>;
      })}
    </span>
    {inputMentions.some((_mention, index) => !renderedMentionIndexes.has(index)) && (
      <span className="queue-input-preview__references">
        {inputMentions.map((mention, index) => renderedMentionIndexes.has(index) ? null : (
          <StaticMentionChip mention={mention} mentionIndex={index} detached t={t} key={`reference:${index}`}>
            {mention.displayText}
          </StaticMentionChip>
        ))}
      </span>
    )}
    {attachments.length > 0 && <span className="queue-input-preview__attachments">
      {attachments.map((attachment, index) => {
        const typeLabel = t(attachment.kind === "image"
          ? "queue.previewAttachment.image"
          : "queue.previewAttachment.file");
        const label = nonBlankLabel(attachment.label, t("queue.previewUnnamedAttachment"));
        const accessibleLabel = t("queue.previewAccessibleLabel", { type: typeLabel, name: label });
        return <span className="queue-input-preview__chip queue-input-preview__attachment" data-queue-attachment-kind={attachment.kind} title={accessibleLabel} key={`${attachment.kind}:${attachment.label}:${index}`}>
          {attachment.kind === "image" ? <ImageIcon aria-hidden="true" /> : <Paperclip aria-hidden="true" />}
          <span className="sr-only">{t("queue.previewAccessibleLabel", { type: typeLabel, name: "" })}</span>
          <span data-queue-chip-label="">{label}</span>
        </span>;
      })}
    </span>}
  </span>;
}

function renderTextWithMentions(
  value: string,
  sourceStart: number | undefined,
  mentions: readonly TimelineInputMentionView[],
  ranges: readonly TimelineInputMentionRangeView[] | undefined,
  renderedMentionIndexes: Set<number>,
  t: Translator
): readonly ReactNode[] {
  if (sourceStart === undefined || ranges === undefined) return [value];
  const sourceEnd = sourceStart + value.length;
  const localRanges = ranges
    .filter((range) => range.start >= sourceStart && range.end <= sourceEnd)
    .map((range) => ({ ...range, start: range.start - sourceStart, end: range.end - sourceStart }));
  return sentInputMentionSegments(value, mentions, localRanges).map((segment, index) => {
    if (segment.kind !== "mention") return <span key={`text:${index}`}>{segment.text}</span>;
    renderedMentionIndexes.add(segment.mentionIndex);
    return <StaticMentionChip mention={segment.mention} mentionIndex={segment.mentionIndex} t={t} key={`mention:${index}`}>
      {segment.text}
    </StaticMentionChip>;
  });
}

function StaticMentionChip({ mention, mentionIndex, detached = false, children, t }: {
  readonly mention: TimelineInputMentionView;
  readonly mentionIndex: number;
  readonly detached?: boolean;
  readonly children: string;
  readonly t: Translator;
}): JSX.Element {
  const typeLabel = mentionTypeLabel(mention, t);
  const fallbackLabel = t("queue.previewUnnamedReference");
  const visibleLabel = detached ? nonBlankLabel(children, fallbackLabel) : children;
  const accessibleName = nonBlankLabel(visibleLabel, nonBlankLabel(mention.displayText, fallbackLabel));
  const accessibleLabel = t("queue.previewAccessibleLabel", { type: typeLabel, name: accessibleName });
  return <span
    className={`queue-input-preview__chip queue-input-preview__mention${detached ? " is-detached" : ""}`}
    data-queue-mention-index={mentionIndex}
    data-queue-mention-kind={mention.kind}
    title={accessibleLabel}
  >
    {mention.kind === "workspace"
      ? mention.directory ? <Folder aria-hidden="true" /> : <FileText aria-hidden="true" />
      : mention.kind === "session"
        ? <MessageSquare aria-hidden="true" />
        : mention.kind === "resource"
          ? <Braces aria-hidden="true" />
          : <FileText aria-hidden="true" />}
    <span className="sr-only">{t("queue.previewAccessibleLabel", { type: typeLabel, name: "" })}</span>
    <span data-queue-chip-label="">{visibleLabel}</span>
    {visibleLabel.trim() === "" && <span className="sr-only">{accessibleName}</span>}
  </span>;
}

function mentionTypeLabel(mention: TimelineInputMentionView, t: Translator): string {
  if (mention.kind === "workspace") {
    return t(mention.directory
      ? "queue.previewReference.workspaceDirectory"
      : "queue.previewReference.workspaceFile");
  }
  if (mention.kind === "session") return t("queue.previewReference.session");
  if (mention.kind === "resource") return t("queue.previewReference.resource");
  return t("queue.previewReference.artifact");
}

function nonBlankLabel(value: string, fallback: string): string {
  return value.trim() === "" ? fallback : value;
}
