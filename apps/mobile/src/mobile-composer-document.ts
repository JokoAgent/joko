import { create } from "@bufbuild/protobuf";
import {
  InputContentSchema,
  InputMentionRangeSchema,
  InputPartSchema,
  SessionMentionSchema,
  WorkspaceLineRangeSchema,
  WorkspaceMentionSchema,
  type InputContent
} from "@joko/contracts";
import { canonicalWorkspacePath } from "./workspace-files";

export interface MobileComposerSessionMention {
  readonly kind: "session";
  readonly mentionId: string;
  readonly sessionId: string;
  readonly displayText: string;
  readonly start: number;
  readonly end: number;
}

export interface MobileWorkspaceLineRange {
  readonly startLine: number;
  readonly endLine: number;
}

export interface MobileComposerWorkspaceMention {
  readonly kind: "workspace";
  readonly mentionId: string;
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly displayText: string;
  readonly directory: boolean;
  readonly lineRange?: MobileWorkspaceLineRange;
  readonly start: number;
  readonly end: number;
}

export type MobileComposerMention = MobileComposerSessionMention | MobileComposerWorkspaceMention;

export interface MobileComposerDraft {
  readonly text: string;
  readonly mentions: readonly MobileComposerMention[];
}

export interface MobileComposerSelection {
  readonly start: number;
  readonly end: number;
}

export interface MobileComposerEditResult {
  readonly draft: MobileComposerDraft;
  readonly selection: MobileComposerSelection;
}

const maximumDraftCharacters = 1_000_000;
const maximumSessionMentions = 8;
const maximumDisplayCharacters = 256;
const maximumLineNumber = 0xffff_ffff;

export function emptyMobileComposerDraft(): MobileComposerDraft {
  return { text: "", mentions: [] };
}

export function plainTextMobileComposerDraft(text: string): MobileComposerDraft {
  return normalizeMobileComposerDraft({ text, mentions: [] });
}

export function normalizeMobileComposerDraft(value: MobileComposerDraft): MobileComposerDraft {
  if (!value || typeof value !== "object" || typeof value.text !== "string" || !Array.isArray(value.mentions)) {
    throw new Error("The local Joko structured task draft is invalid.");
  }
  if (value.text.length > maximumDraftCharacters) {
    throw new Error("The local Joko structured task draft is too large.");
  }
  if (value.mentions.filter((mention) => mention?.kind === "session").length > maximumSessionMentions) {
    throw new Error("A task message can reference at most 8 other tasks.");
  }
  const mentionIds = new Set<string>();
  let previousEnd = 0;
  const mentions = value.mentions.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || (candidate.kind !== "session" && candidate.kind !== "workspace")) {
      throw new Error("The local Joko task reference is invalid.");
    }
    assertIdentity(candidate.mentionId, "reference occurrence");
    if (mentionIds.has(candidate.mentionId)) throw new Error("The local Joko task reference occurrence is duplicated.");
    mentionIds.add(candidate.mentionId);
    const displayText = normalizeDisplayText(candidate.displayText);
    const normalized = candidate.kind === "session"
      ? normalizeSessionMention(candidate, displayText)
      : normalizeWorkspaceMention(candidate, displayText);
    if (!Number.isSafeInteger(candidate.start) || !Number.isSafeInteger(candidate.end)
      || candidate.start < previousEnd || candidate.start < 0 || candidate.end <= candidate.start
      || candidate.end > value.text.length || !isUtf16Boundary(value.text, candidate.start)
      || !isUtf16Boundary(value.text, candidate.end)
      || value.text.slice(candidate.start, candidate.end) !== mobileComposerMentionToken(normalized)) {
      throw new Error("The local Joko task reference range is invalid.");
    }
    previousEnd = candidate.end;
    return {
      ...normalized,
      mentionId: candidate.mentionId,
      start: candidate.start,
      end: candidate.end
    };
  });
  return { text: value.text, mentions };
}

export function cloneMobileComposerDraft(draft: MobileComposerDraft): MobileComposerDraft {
  const exact = normalizeMobileComposerDraft(draft);
  return {
    text: exact.text,
    mentions: exact.mentions.map((mention) => mention.kind === "workspace" && mention.lineRange !== undefined
      ? { ...mention, lineRange: { ...mention.lineRange } }
      : { ...mention })
  };
}

export function mobileComposerDraftsEqual(left: MobileComposerDraft, right: MobileComposerDraft): boolean {
  const first = normalizeMobileComposerDraft(left);
  const second = normalizeMobileComposerDraft(right);
  return first.text === second.text && first.mentions.length === second.mentions.length
    && first.mentions.every((mention, index) => {
      const candidate = second.mentions[index];
      return candidate !== undefined && mention.kind === candidate.kind && mention.mentionId === candidate.mentionId
        && mention.displayText === candidate.displayText && mention.start === candidate.start && mention.end === candidate.end
        && (mention.kind === "session"
          ? candidate.kind === "session" && mention.sessionId === candidate.sessionId
          : candidate.kind === "workspace" && mention.workspaceId === candidate.workspaceId
            && mention.relativePath === candidate.relativePath && mention.directory === candidate.directory
            && sameLineRange(mention.lineRange, candidate.lineRange));
    });
}

export function mobileSessionMentionToken(displayText: string): string {
  return `@${normalizeDisplayText(displayText)}`;
}

export function mobileWorkspaceMentionToken(input: {
  readonly displayText: string;
  readonly directory: boolean;
  readonly lineRange?: MobileWorkspaceLineRange;
}): string {
  const label = `@${normalizeDisplayText(input.displayText)}${input.directory ? "/" : ""}`;
  const range = normalizeWorkspaceLineRange(input.lineRange, input.directory);
  return range === undefined ? label : `${label}:${range.startLine}–${range.endLine}`;
}

export function reconcileMobileComposerText(
  draft: MobileComposerDraft,
  nextText: string
): MobileComposerEditResult {
  const current = normalizeMobileComposerDraft(draft);
  if (typeof nextText !== "string" || nextText.length > maximumDraftCharacters) {
    throw new Error("The local Joko structured task draft is too large.");
  }
  if (current.text === nextText) {
    return { draft: cloneMobileComposerDraft(current), selection: { start: nextText.length, end: nextText.length } };
  }
  let prefix = 0;
  while (prefix < current.text.length && prefix < nextText.length && current.text[prefix] === nextText[prefix]) prefix += 1;
  while (prefix > 0 && (!isUtf16Boundary(current.text, prefix) || !isUtf16Boundary(nextText, prefix))) prefix -= 1;
  let suffix = 0;
  while (suffix < current.text.length - prefix && suffix < nextText.length - prefix
    && current.text[current.text.length - suffix - 1] === nextText[nextText.length - suffix - 1]) suffix += 1;
  while (suffix > 0 && (!isUtf16Boundary(current.text, current.text.length - suffix)
    || !isUtf16Boundary(nextText, nextText.length - suffix))) suffix -= 1;
  const oldEnd = current.text.length - suffix;
  const inserted = nextText.slice(prefix, nextText.length - suffix);
  return replaceMobileComposerRange(current, { start: prefix, end: oldEnd }, inserted);
}

export function insertMobileSessionMention(
  draft: MobileComposerDraft,
  selection: MobileComposerSelection,
  candidate: { readonly sessionId: string; readonly displayText: string },
  mentionId: string
): MobileComposerEditResult {
  const current = normalizeMobileComposerDraft(draft);
  assertIdentity(candidate.sessionId, "referenced task");
  assertIdentity(mentionId, "reference occurrence");
  const range = expandedAtomicRange(current, normalizeSelection(selection, current.text));
  const retainedSessionCount = current.mentions.filter((mention) => mention.kind === "session"
    && (mention.end <= range.start || mention.start >= range.end)).length;
  if (retainedSessionCount >= maximumSessionMentions) throw new Error("A task message can reference at most 8 other tasks.");
  const mention: MobileComposerSessionMention = {
    kind: "session",
    mentionId,
    sessionId: candidate.sessionId,
    displayText: normalizeDisplayText(candidate.displayText),
    start: 0,
    end: 0
  };
  return insertMobileComposerMention(current, range, mention);
}

export function insertMobileWorkspaceMention(
  draft: MobileComposerDraft,
  selection: MobileComposerSelection,
  candidate: {
    readonly workspaceId: string;
    readonly relativePath: string;
    readonly displayText: string;
    readonly directory: boolean;
    readonly lineRange?: MobileWorkspaceLineRange;
  },
  mentionId: string
): MobileComposerEditResult {
  const current = normalizeMobileComposerDraft(draft);
  assertIdentity(mentionId, "reference occurrence");
  const range = expandedAtomicRange(current, normalizeSelection(selection, current.text));
  const mention: MobileComposerWorkspaceMention = {
    kind: "workspace",
    mentionId,
    workspaceId: candidate.workspaceId,
    relativePath: candidate.relativePath,
    displayText: candidate.displayText,
    directory: candidate.directory,
    ...(candidate.lineRange === undefined ? {} : { lineRange: candidate.lineRange }),
    start: 0,
    end: 0
  };
  const normalized = normalizeWorkspaceMention(mention, normalizeDisplayText(mention.displayText));
  return insertMobileComposerMention(current, range, { ...normalized, mentionId, start: 0, end: 0 });
}

export function appendPlainTextToMobileComposer(draft: MobileComposerDraft, addition: string): MobileComposerDraft {
  const current = normalizeMobileComposerDraft(draft);
  if (!addition) return current;
  const separator = current.text.length > 0 ? "\n\n" : "";
  return normalizeMobileComposerDraft({
    text: `${current.text}${separator}${addition}`,
    mentions: current.mentions
  });
}

export function removeMobileComposerMention(
  draft: MobileComposerDraft,
  mentionId: string
): MobileComposerEditResult {
  const current = normalizeMobileComposerDraft(draft);
  const mention = current.mentions.find((candidate) => candidate.mentionId === mentionId);
  if (!mention) throw new Error("The selected task reference is no longer in this draft.");
  return replaceMobileComposerRange(current, { start: mention.start, end: mention.end }, "");
}

export function mobileComposerInput(draft: MobileComposerDraft): InputContent {
  const exact = normalizeMobileComposerDraft(draft);
  if (!exact.text.trim()) throw new Error("Enter a task message before sending.");
  return create(InputContentSchema, {
    parts: [
      create(InputPartSchema, { content: { case: "text", value: exact.text } }),
      ...exact.mentions.map((mention) => mention.kind === "session"
        ? create(InputPartSchema, {
            content: { case: "sessionMention", value: create(SessionMentionSchema, {
              sessionId: mention.sessionId,
              displayText: mention.displayText
            }) }
          })
        : create(InputPartSchema, {
            content: { case: "workspaceMention", value: create(WorkspaceMentionSchema, {
              workspaceId: mention.workspaceId,
              relativePath: mention.relativePath,
              displayText: mention.displayText,
              directory: mention.directory,
              ...(mention.lineRange === undefined ? {} : {
                lineRange: create(WorkspaceLineRangeSchema, mention.lineRange)
              })
            }) }
          }))
    ],
    mentionRanges: exact.mentions.map((mention, mentionIndex) => create(InputMentionRangeSchema, {
      start: mention.start,
      end: mention.end,
      mentionIndex
    }))
  });
}

export function mobileInputSummary(input: InputContent | undefined, typedMetadataTrusted = true): string {
  if (!input) return "";
  const text = input.parts.flatMap((part) => part.content.case === "text" ? [part.content.value] : []).join("");
  const media = input.parts.flatMap((part) => part.content.case === "image" ? ["[Image]"]
    : part.content.case === "file" ? ["[File]"] : []);
  if (!typedMetadataTrusted) {
    const untrustedStructuredMetadata = input.parts.some((part) => part.content.case === "sessionMention"
      || part.content.case === "workspaceMention" || part.content.case === "resourceMention"
      || part.content.case === "artifactMention")
      || input.mentionRanges.length > 0 || input.pastedTextRanges.length > 0 || input.quotesEncoded;
    return [text, ...media, ...(untrustedStructuredMetadata ? ["[Untrusted structured metadata ignored]"] : [])]
      .filter((value) => value.length > 0).join("\n");
  }
  const mentions = input.parts.flatMap((part) => {
    if (part.content.case === "sessionMention") return [{ label: part.content.value.displayText || part.content.value.sessionId, valid: true }];
    if (part.content.case === "workspaceMention") return [{
      label: part.content.value.displayText || part.content.value.relativePath,
      valid: validInputWorkspaceMention(part.content.value)
    }];
    if (part.content.case === "resourceMention") return [{ label: part.content.value.displayText || part.content.value.resourceId, valid: true }];
    if (part.content.case === "artifactMention") return [{ label: part.content.value.displayText || part.content.value.artifactId, valid: true }];
    return [];
  });
  const rangesValid = mentions.every((mention) => mention.valid)
    && validMentionRanges(text, mentions.length, input.mentionRanges, input.pastedTextRanges);
  const inline = new Set(rangesValid ? input.mentionRanges.map((range) => range.mentionIndex) : []);
  const suffix: string[] = [...media];
  if (rangesValid) {
    mentions.forEach((mention, index) => { if (!inline.has(index)) suffix.push(`@${mention.label}`); });
  } else if (mentions.length > 0 || input.mentionRanges.length > 0) {
    suffix.push("[Invalid reference metadata]");
  }
  return [text, ...suffix].filter((value) => value.length > 0).join("\n");
}

function replaceMobileComposerRange(
  draft: MobileComposerDraft,
  selection: MobileComposerSelection,
  replacement: string
): MobileComposerEditResult {
  const exact = normalizeMobileComposerDraft(draft);
  const range = expandedAtomicRange(exact, normalizeSelection(selection, exact.text));
  const text = `${exact.text.slice(0, range.start)}${replacement}${exact.text.slice(range.end)}`;
  if (text.length > maximumDraftCharacters) throw new Error("The local Joko structured task draft is too large.");
  const delta = replacement.length - (range.end - range.start);
  const mentions = exact.mentions.flatMap((mention) => {
    if (mention.end <= range.start) return [{ ...mention }];
    if (mention.start >= range.end) return [{ ...mention, start: mention.start + delta, end: mention.end + delta }];
    return [];
  });
  const next = normalizeMobileComposerDraft({ text, mentions });
  const caret = range.start + replacement.length;
  return { draft: next, selection: { start: caret, end: caret } };
}

function insertMobileComposerMention(
  draft: MobileComposerDraft,
  range: MobileComposerSelection,
  mention: MobileComposerMention
): MobileComposerEditResult {
  const token = mobileComposerMentionToken(mention);
  const prefix = range.start > 0 && !/\s/u.test(draft.text[range.start - 1] ?? "") ? " " : "";
  const suffix = range.end < draft.text.length && !/\s/u.test(draft.text[range.end] ?? "") ? " " : "";
  const result = replaceMobileComposerRange(draft, range, `${prefix}${token}${suffix}`);
  const start = range.start + prefix.length;
  const occurrence = { ...mention, start, end: start + token.length };
  const mentions = [...result.draft.mentions, occurrence]
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const next = normalizeMobileComposerDraft({ text: result.draft.text, mentions });
  const caret = range.start + prefix.length + token.length + suffix.length;
  return { draft: next, selection: { start: caret, end: caret } };
}

function mobileComposerMentionToken(mention: Pick<MobileComposerMention, "kind" | "displayText">
  & Partial<Pick<MobileComposerWorkspaceMention, "directory" | "lineRange">>): string {
  return mention.kind === "session"
    ? mobileSessionMentionToken(mention.displayText)
    : mobileWorkspaceMentionToken({
        displayText: mention.displayText,
        directory: mention.directory === true,
        ...(mention.lineRange === undefined ? {} : { lineRange: mention.lineRange })
      });
}

function normalizeSessionMention(
  mention: MobileComposerSessionMention,
  displayText: string
): Pick<MobileComposerSessionMention, "kind" | "sessionId" | "displayText"> {
  assertIdentity(mention.sessionId, "referenced task");
  return { kind: "session", sessionId: mention.sessionId, displayText };
}

function normalizeWorkspaceMention(
  mention: MobileComposerWorkspaceMention,
  displayText: string
): Omit<MobileComposerWorkspaceMention, "mentionId" | "start" | "end"> {
  assertIdentity(mention.workspaceId, "workspace");
  const relativePath = canonicalWorkspacePath(mention.relativePath);
  if (typeof mention.directory !== "boolean") throw new Error("The local Joko workspace reference kind is invalid.");
  const lineRange = normalizeWorkspaceLineRange(mention.lineRange, mention.directory);
  return {
    kind: "workspace",
    workspaceId: mention.workspaceId,
    relativePath,
    displayText,
    directory: mention.directory,
    ...(lineRange === undefined ? {} : { lineRange })
  };
}

function normalizeWorkspaceLineRange(
  range: MobileWorkspaceLineRange | undefined,
  directory: boolean
): MobileWorkspaceLineRange | undefined {
  if (range === undefined) return undefined;
  if (directory || !Number.isSafeInteger(range.startLine) || !Number.isSafeInteger(range.endLine)
    || range.startLine < 1 || range.endLine < range.startLine || range.endLine > maximumLineNumber) {
    throw new Error("A workspace line reference requires a file and paired, ordered one-based lines.");
  }
  return { startLine: range.startLine, endLine: range.endLine };
}

function sameLineRange(left: MobileWorkspaceLineRange | undefined, right: MobileWorkspaceLineRange | undefined): boolean {
  return left === undefined || right === undefined
    ? left === undefined && right === undefined
    : left.startLine === right.startLine && left.endLine === right.endLine;
}

function validInputWorkspaceMention(mention: {
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly directory: boolean;
  readonly lineRange?: { readonly startLine: number; readonly endLine: number };
}): boolean {
  try {
    assertIdentity(mention.workspaceId, "workspace");
    canonicalWorkspacePath(mention.relativePath);
    normalizeWorkspaceLineRange(mention.lineRange, mention.directory);
    return true;
  } catch {
    return false;
  }
}

function expandedAtomicRange(draft: MobileComposerDraft, selection: MobileComposerSelection): MobileComposerSelection {
  let start = selection.start;
  let end = selection.end;
  for (const mention of draft.mentions) {
    const insertionInside = start === end && mention.start < start && start < mention.end;
    const overlaps = start < mention.end && end > mention.start;
    if (!insertionInside && !overlaps) continue;
    start = Math.min(start, mention.start);
    end = Math.max(end, mention.end);
  }
  return { start, end };
}

function normalizeSelection(selection: MobileComposerSelection, text: string): MobileComposerSelection {
  if (!selection || !Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end)) {
    throw new Error("The Joko task message selection is invalid.");
  }
  const start = Math.max(0, Math.min(selection.start, selection.end, text.length));
  const end = Math.max(start, Math.min(Math.max(selection.start, selection.end), text.length));
  if (!isUtf16Boundary(text, start) || !isUtf16Boundary(text, end)) {
    throw new Error("The Joko task message selection splits a Unicode character.");
  }
  return { start, end };
}

function normalizeDisplayText(value: string): string {
  if (typeof value !== "string") throw new Error("The local Joko reference label is invalid.");
  const exact = value.trim();
  if (!exact || exact.length > maximumDisplayCharacters || /[\u0000-\u001f\u007f]/u.test(exact)) {
    throw new Error("The local Joko reference label is invalid.");
  }
  return exact;
}

function assertIdentity(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`The local Joko ${label} identity is invalid.`);
  }
}

function validMentionRanges(
  text: string,
  mentionCount: number,
  ranges: InputContent["mentionRanges"],
  pastedTextRanges: InputContent["pastedTextRanges"]
): boolean {
  if (!validOrderedTextRanges(text, pastedTextRanges)) return false;
  let previousEnd = 0;
  const seenMentionIndexes = new Set<number>();
  for (const range of ranges) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
      || range.start < previousEnd || range.start < 0 || range.end <= range.start || range.end > text.length
      || !isUtf16Boundary(text, range.start) || !isUtf16Boundary(text, range.end)
      || !Number.isSafeInteger(range.mentionIndex) || range.mentionIndex < 0 || range.mentionIndex >= mentionCount
      || seenMentionIndexes.has(range.mentionIndex)
      || pastedTextRanges.some((pasted) => range.start < pasted.end && range.end > pasted.start)) return false;
    seenMentionIndexes.add(range.mentionIndex);
    previousEnd = range.end;
  }
  return true;
}

function validOrderedTextRanges(
  text: string,
  ranges: InputContent["pastedTextRanges"]
): boolean {
  let previousEnd = 0;
  for (const range of ranges) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
      || range.start < previousEnd || range.start < 0 || range.end <= range.start || range.end > text.length
      || !isUtf16Boundary(text, range.start) || !isUtf16Boundary(text, range.end)) return false;
    previousEnd = range.end;
  }
  return true;
}

function isUtf16Boundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

export const mobileComposerDocumentTesting = {
  maximumDraftCharacters,
  maximumSessionMentions,
  maximumLineNumber
};
