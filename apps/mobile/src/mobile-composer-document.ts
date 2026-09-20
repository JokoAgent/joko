import { create } from "@bufbuild/protobuf";
import {
  ArtifactMentionSchema,
  BlobDisposition,
  BlobRefSchema,
  ImageRefSchema,
  InlineTextRangeSchema,
  InputContentSchema,
  InputMentionRangeSchema,
  InputPartSchema,
  ResourceMentionSchema,
  SessionMentionSchema,
  WorkspaceLineRangeSchema,
  WorkspaceMentionSchema,
  type InputContent
} from "@joko/contracts";
import {
  cloneMobileComposerAttachment,
  mobileComposerAttachmentsEqual,
  normalizeMobileComposerAttachmentSet,
  normalizeMobileComposerAttachment,
  type MobileComposerAttachment,
  type MobileUploadedComposerAttachment
} from "./mobile-attachments";
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

export interface MobileComposerResourceMention {
  readonly kind: "resource";
  readonly mentionId: string;
  readonly resourceId: string;
  readonly displayText: string;
  readonly discoveredRevision: string;
  readonly resourceVersion: string;
  readonly runtimeGeneration: string;
  readonly start: number;
  readonly end: number;
}

export interface MobileComposerArtifactMention {
  readonly kind: "artifact";
  readonly mentionId: string;
  readonly artifactId: string;
  readonly sourceSessionId: string;
  readonly displayText: string;
  readonly start: number;
  readonly end: number;
}

export type MobileComposerMention = MobileComposerSessionMention
  | MobileComposerWorkspaceMention
  | MobileComposerResourceMention
  | MobileComposerArtifactMention;

export interface MobileComposerQuoteAtom {
  readonly kind: "quote";
  readonly atomId: string;
  readonly sourceSessionId: string;
  readonly sourceMessageId: string;
  readonly sourceEventId: string;
  readonly sourceRole: "assistant";
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface MobileComposerPastedTextAtom {
  readonly kind: "pasted-text";
  readonly atomId: string;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export type MobileComposerAtom = MobileComposerQuoteAtom | MobileComposerPastedTextAtom;

export interface MobileComposerDraft {
  readonly text: string;
  readonly mentions: readonly MobileComposerMention[];
  readonly atoms: readonly MobileComposerAtom[];
  readonly attachments: readonly MobileComposerAttachment[];
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
export const mobileLongPasteLineThreshold = 24;
export const mobileLongPasteCharacterThreshold = 4_000;
export const mobileLongPasteMaximumCharacters = 2_000_000;
export const mobileComposerNativeInputMaximumCharacters = maximumDraftCharacters + mobileLongPasteMaximumCharacters;
export const mobileSelectionQuoteMaximumCharacters = 4_000;
export const mobileSelectionQuoteMarker = "<!-- joko-selection-quote -->";
export const mobileSelectionQuoteMarkerLine = `> ${mobileSelectionQuoteMarker}`;
const maximumComposerAtoms = 1_024;
const maximumSelectionQuotes = 32;
const maximumSerializedCharacters = 2_000_000;
const maximumSessionMentions = 8;
const maximumDisplayCharacters = 256;
const maximumLineNumber = 0xffff_ffff;
const maximumUint64 = 18_446_744_073_709_551_615n;

export function emptyMobileComposerDraft(): MobileComposerDraft {
  return { text: "", mentions: [], atoms: [], attachments: [] };
}

export function plainTextMobileComposerDraft(text: string): MobileComposerDraft {
  return normalizeMobileComposerDraft({ text, mentions: [], atoms: [], attachments: [] });
}

export function normalizeMobileComposerDraft(value: MobileComposerDraft): MobileComposerDraft {
  if (!value || typeof value !== "object" || typeof value.text !== "string"
    || !Array.isArray(value.mentions) || !Array.isArray(value.atoms) || !Array.isArray(value.attachments)) {
    throw new Error("The local Joko structured task draft is invalid.");
  }
  if (value.text.length > maximumDraftCharacters) {
    throw new Error("The local Joko structured task draft is too large.");
  }
  if (value.mentions.filter((mention) => mention?.kind === "session").length > maximumSessionMentions) {
    throw new Error("A task message can reference at most 8 other tasks.");
  }
  if (value.atoms.length > maximumComposerAtoms) {
    throw new Error(`A task message can contain at most ${maximumComposerAtoms} structured quote or paste items.`);
  }
  if (value.atoms.filter((atom) => atom?.kind === "quote").length > maximumSelectionQuotes) {
    throw new Error(`A task message can contain at most ${maximumSelectionQuotes} selected-text quotes.`);
  }
  const mentionIds = new Set<string>();
  let previousEnd = 0;
  const mentions = value.mentions.map((candidate) => {
    if (!candidate || typeof candidate !== "object"
      || !["session", "workspace", "resource", "artifact"].includes(candidate.kind)) {
      throw new Error("The local Joko task reference is invalid.");
    }
    assertIdentity(candidate.mentionId, "reference occurrence");
    if (mentionIds.has(candidate.mentionId)) throw new Error("The local Joko task reference occurrence is duplicated.");
    mentionIds.add(candidate.mentionId);
    const displayText = normalizeDisplayText(candidate.displayText);
    const normalized = candidate.kind === "session"
      ? normalizeSessionMention(candidate, displayText)
      : candidate.kind === "workspace"
        ? normalizeWorkspaceMention(candidate, displayText)
        : candidate.kind === "resource"
          ? normalizeResourceMention(candidate, displayText)
          : normalizeArtifactMention(candidate, displayText);
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
  const atomIds = new Set<string>();
  previousEnd = 0;
  const atoms = value.atoms.map((candidate) => {
    if (!candidate || typeof candidate !== "object"
      || (candidate.kind !== "quote" && candidate.kind !== "pasted-text")) {
      throw new Error("The local Joko composer atom is invalid.");
    }
    assertIdentity(candidate.atomId, "composer atom occurrence");
    if (atomIds.has(candidate.atomId)) throw new Error("The local Joko composer atom occurrence is duplicated.");
    atomIds.add(candidate.atomId);
    const normalized = candidate.kind === "quote"
      ? normalizeQuoteAtom(candidate)
      : normalizePastedTextAtom(candidate);
    if (!Number.isSafeInteger(candidate.start) || !Number.isSafeInteger(candidate.end)
      || candidate.start < previousEnd || candidate.start < 0 || candidate.end <= candidate.start
      || candidate.end > value.text.length || !isUtf16Boundary(value.text, candidate.start)
      || !isUtf16Boundary(value.text, candidate.end)
      || value.text.slice(candidate.start, candidate.end) !== mobileComposerAtomToken(normalized)) {
      throw new Error("The local Joko composer atom range is invalid.");
    }
    previousEnd = candidate.end;
    return { ...normalized, atomId: candidate.atomId, start: candidate.start, end: candidate.end };
  });
  for (const atom of atoms) {
    if (atom.kind !== "quote") continue;
    const separatedBefore = atom.start === 0 || value.text.slice(atom.start - 2, atom.start) === "\n\n";
    const separatedAfter = atom.end === value.text.length || value.text.slice(atom.end, atom.end + 2) === "\n\n";
    if (!separatedBefore || !separatedAfter) {
      throw new Error("A Joko message quote must remain a separate composer block.");
    }
  }
  for (const mention of mentions) {
    if (atoms.some((atom) => mention.start < atom.end && mention.end > atom.start)) {
      throw new Error("A Joko reference cannot overlap a quote or pasted-text atom.");
    }
  }
  const attachments = normalizeMobileComposerAttachmentSet(value.attachments);
  const draft = { text: value.text, mentions, atoms, attachments };
  serializeMobileComposerText(draft);
  return draft;
}

export function cloneMobileComposerDraft(draft: MobileComposerDraft): MobileComposerDraft {
  const exact = normalizeMobileComposerDraft(draft);
  return {
    text: exact.text,
    mentions: exact.mentions.map((mention) => mention.kind === "workspace" && mention.lineRange !== undefined
      ? { ...mention, lineRange: { ...mention.lineRange } }
      : { ...mention }),
    atoms: exact.atoms.map((atom) => ({ ...atom })),
    attachments: exact.attachments.map(cloneMobileComposerAttachment)
  };
}

export function mobileComposerDraftsEqual(left: MobileComposerDraft, right: MobileComposerDraft): boolean {
  const first = normalizeMobileComposerDraft(left);
  const second = normalizeMobileComposerDraft(right);
  return first.text === second.text && first.mentions.length === second.mentions.length
    && first.atoms.length === second.atoms.length
    && first.attachments.length === second.attachments.length
    && first.attachments.every((attachment, index) => {
      const candidate = second.attachments[index];
      return candidate !== undefined && mobileComposerAttachmentsEqual(attachment, candidate);
    })
    && first.mentions.every((mention, index) => {
      const candidate = second.mentions[index];
      return candidate !== undefined && mention.kind === candidate.kind && mention.mentionId === candidate.mentionId
        && mention.displayText === candidate.displayText && mention.start === candidate.start && mention.end === candidate.end
        && sameMentionAuthority(mention, candidate);
    })
    && first.atoms.every((atom, index) => {
      const candidate = second.atoms[index];
      return candidate !== undefined && atom.kind === candidate.kind && atom.atomId === candidate.atomId
        && atom.text === candidate.text && atom.start === candidate.start && atom.end === candidate.end
        && (atom.kind === "pasted-text" || candidate.kind === "quote"
          && atom.sourceSessionId === candidate.sourceSessionId
          && atom.sourceMessageId === candidate.sourceMessageId
          && atom.sourceEventId === candidate.sourceEventId
          && atom.sourceRole === candidate.sourceRole);
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

export function mobileComposerAtomToken(atom: Pick<MobileComposerAtom, "kind" | "text">): string {
  if (atom.kind === "quote") return "⟦Quote from Assistant⟧";
  const lines = mobilePastedTextLineCount(atom.text);
  return `⟦Pasted text (${lines} ${lines === 1 ? "line" : "lines"})⟧`;
}

export function mobileComposerAtomLabel(atom: Pick<MobileComposerAtom, "kind" | "text">): string {
  return atom.kind === "quote"
    ? "Quote from Assistant"
    : mobileComposerAtomToken(atom).slice(1, -1);
}

export function isLongMobileComposerPaste(text: string): boolean {
  if (typeof text !== "string") return false;
  if (text.length >= mobileLongPasteCharacterThreshold) return true;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10 && ++lines >= mobileLongPasteLineThreshold) return true;
  }
  return false;
}

export function reconcileMobileComposerText(
  draft: MobileComposerDraft,
  nextText: string,
  atomId?: string
): MobileComposerEditResult {
  const current = normalizeMobileComposerDraft(draft);
  if (typeof nextText !== "string" || nextText.length > mobileComposerNativeInputMaximumCharacters) {
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
  const quoteBefore = current.atoms.find((atom) => atom.kind === "quote" && atom.end === prefix);
  if (inserted && oldEnd === prefix && quoteBefore && quoteBefore.end === current.text.length) {
    if (atomId !== undefined && isLongMobileComposerPaste(inserted)) {
      const separated = replaceMobileComposerRange(current, { start: prefix, end: oldEnd }, "\n\n");
      return insertMobilePastedText(separated.draft, separated.selection, inserted, atomId);
    }
    return replaceMobileComposerRange(current, { start: prefix, end: oldEnd }, `\n\n${inserted}`);
  }
  const quoteAfter = current.atoms.find((atom) => atom.kind === "quote" && atom.start === prefix);
  if (inserted && oldEnd === prefix && quoteAfter && quoteAfter.start === 0) {
    if (atomId !== undefined && isLongMobileComposerPaste(inserted)) {
      const separated = replaceMobileComposerRange(current, { start: prefix, end: oldEnd }, "\n\n");
      return insertMobilePastedText(separated.draft, { start: 0, end: 0 }, inserted, atomId);
    }
    return replaceMobileComposerRange(current, { start: prefix, end: oldEnd }, `${inserted}\n\n`);
  }
  if (atomId !== undefined && isLongMobileComposerPaste(inserted)) {
    return insertMobilePastedText(current, { start: prefix, end: oldEnd }, inserted, atomId);
  }
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

export function insertMobileResourceMention(
  draft: MobileComposerDraft,
  selection: MobileComposerSelection,
  candidate: {
    readonly resourceId: string;
    readonly displayText: string;
    readonly discoveredRevision: string;
    readonly resourceVersion: string;
    readonly runtimeGeneration: string;
  },
  mentionId: string
): MobileComposerEditResult {
  const current = normalizeMobileComposerDraft(draft);
  assertIdentity(mentionId, "reference occurrence");
  const range = expandedAtomicRange(current, normalizeSelection(selection, current.text));
  const mention = normalizeResourceMention({
    kind: "resource", mentionId, ...candidate, start: 0, end: 0
  }, normalizeDisplayText(candidate.displayText));
  return insertMobileComposerMention(current, range, { ...mention, mentionId, start: 0, end: 0 });
}

export function insertMobileArtifactMention(
  draft: MobileComposerDraft,
  selection: MobileComposerSelection,
  candidate: {
    readonly artifactId: string;
    readonly sourceSessionId: string;
    readonly displayText: string;
  },
  mentionId: string
): MobileComposerEditResult {
  const current = normalizeMobileComposerDraft(draft);
  assertIdentity(mentionId, "reference occurrence");
  const range = expandedAtomicRange(current, normalizeSelection(selection, current.text));
  const mention = normalizeArtifactMention({
    kind: "artifact", mentionId, ...candidate, start: 0, end: 0
  }, normalizeDisplayText(candidate.displayText));
  return insertMobileComposerMention(current, range, { ...mention, mentionId, start: 0, end: 0 });
}

export function appendMobileSelectionQuote(
  draft: MobileComposerDraft,
  quote: {
    readonly sourceSessionId: string;
    readonly sourceMessageId: string;
    readonly sourceEventId: string;
    readonly sourceRole: "assistant";
    readonly text: string;
  },
  atomId: string
): MobileComposerEditResult {
  const current = normalizeMobileComposerDraft(draft);
  assertIdentity(atomId, "composer atom occurrence");
  const normalizedText = normalizedSelectionQuoteText(quote.text);
  if (normalizedText === undefined) throw new Error("Select non-empty assistant text before adding a quote.");
  if (normalizedText.length > mobileSelectionQuoteMaximumCharacters) {
    throw new Error(`A selected quote can contain at most ${mobileSelectionQuoteMaximumCharacters.toLocaleString("en-US")} characters.`);
  }
  const atom = normalizeQuoteAtom({
    kind: "quote",
    atomId,
    sourceSessionId: quote.sourceSessionId,
    sourceMessageId: quote.sourceMessageId,
    sourceEventId: quote.sourceEventId,
    sourceRole: quote.sourceRole,
    text: normalizedText,
    start: 0,
    end: 0
  });
  const separator = current.text.length === 0 ? "" : "\n\n";
  return insertMobileComposerAtom(
    current,
    { start: current.text.length, end: current.text.length },
    { ...atom, atomId },
    separator,
    ""
  );
}

export function insertMobileClipboardText(
  draft: MobileComposerDraft,
  selection: MobileComposerSelection,
  text: string,
  atomId: string
): MobileComposerEditResult {
  if (typeof text !== "string" || text.length === 0) throw new Error("The clipboard does not contain text.");
  if (text.length > mobileLongPasteMaximumCharacters) {
    throw new Error(`Pasted text can contain at most ${mobileLongPasteMaximumCharacters.toLocaleString("en-US")} characters.`);
  }
  if (isLongMobileComposerPaste(text)) return insertMobilePastedText(draft, selection, text, atomId);
  const current = normalizeMobileComposerDraft(draft);
  const range = expandedAtomicRange(current, normalizeSelection(selection, current.text));
  const quoteBefore = current.atoms.find((atom) => atom.kind === "quote" && atom.end === range.start);
  if (range.start === range.end && quoteBefore?.end === current.text.length) {
    return replaceMobileComposerRange(current, range, `\n\n${text}`);
  }
  const quoteAfter = current.atoms.find((atom) => atom.kind === "quote" && atom.start === range.end);
  if (range.start === range.end && quoteAfter?.start === 0) {
    return replaceMobileComposerRange(current, range, `${text}\n\n`);
  }
  return replaceMobileComposerRange(current, range, text);
}

export function insertMobilePastedText(
  draft: MobileComposerDraft,
  selection: MobileComposerSelection,
  text: string,
  atomId: string
): MobileComposerEditResult {
  const current = normalizeMobileComposerDraft(draft);
  assertIdentity(atomId, "composer atom occurrence");
  const atom = normalizePastedTextAtom({ kind: "pasted-text", atomId, text, start: 0, end: 0 });
  const range = expandedAtomicRange(current, normalizeSelection(selection, current.text));
  const quoteBefore = current.atoms.find((candidate) => candidate.kind === "quote" && candidate.end === range.start);
  const quoteAfter = current.atoms.find((candidate) => candidate.kind === "quote" && candidate.start === range.end);
  const prefix = range.start === range.end && quoteBefore?.end === current.text.length ? "\n\n" : "";
  const suffix = range.start === range.end && quoteAfter?.start === 0 ? "\n\n" : "";
  return insertMobileComposerAtom(current, range, { ...atom, atomId }, prefix, suffix);
}

export function updateMobilePastedTextAtom(
  draft: MobileComposerDraft,
  atomId: string,
  text: string
): MobileComposerEditResult {
  const current = normalizeMobileComposerDraft(draft);
  const atom = current.atoms.find((candidate) => candidate.atomId === atomId);
  if (atom?.kind !== "pasted-text") throw new Error("The selected pasted-text item is no longer in this draft.");
  const normalized = normalizePastedTextAtom({ ...atom, text });
  return replaceMobileComposerAtom(current, atom, normalized);
}

export function removeMobileComposerAtom(
  draft: MobileComposerDraft,
  atomId: string
): MobileComposerEditResult {
  const current = normalizeMobileComposerDraft(draft);
  const atom = current.atoms.find((candidate) => candidate.atomId === atomId);
  if (!atom) throw new Error("The selected quote or pasted-text item is no longer in this draft.");
  if (atom.kind !== "quote") return replaceMobileComposerRange(current, { start: atom.start, end: atom.end }, "");
  const range = atom.start >= 2 && current.text.slice(atom.start - 2, atom.start) === "\n\n"
    ? { start: atom.start - 2, end: atom.end }
    : atom.end + 2 <= current.text.length && current.text.slice(atom.end, atom.end + 2) === "\n\n"
      ? { start: atom.start, end: atom.end + 2 }
      : { start: atom.start, end: atom.end };
  return replaceMobileComposerRange(current, range, "");
}

export function appendPlainTextToMobileComposer(draft: MobileComposerDraft, addition: string): MobileComposerDraft {
  const current = normalizeMobileComposerDraft(draft);
  if (!addition) return current;
  const separator = current.text.length > 0 ? "\n\n" : "";
  return normalizeMobileComposerDraft({
    text: `${current.text}${separator}${addition}`,
    mentions: current.mentions,
    atoms: current.atoms,
    attachments: current.attachments
  });
}

export function prependMobileComposerDraft(
  prefix: MobileComposerDraft,
  current: MobileComposerDraft
): MobileComposerDraft {
  const source = normalizeMobileComposerDraft(prefix);
  const existing = normalizeMobileComposerDraft(current);
  const attachments = mergeRecoveredAttachments(source.attachments, existing.attachments);
  if (!source.text) return normalizeMobileComposerDraft({ ...cloneMobileComposerDraft(existing), attachments });
  if (!existing.text) return normalizeMobileComposerDraft({ ...cloneMobileComposerDraft(source), attachments });
  const separator = "\n\n";
  const offset = source.text.length + separator.length;
  const usedMentionIds = new Set(source.mentions.map((mention) => mention.mentionId));
  const usedAtomIds = new Set(source.atoms.map((atom) => atom.atomId));
  const mentions = [
    ...source.mentions.map((mention) => cloneMention(mention)),
    ...existing.mentions.map((mention) => ({
      ...cloneMention(mention),
      mentionId: uniqueRecoveredMentionId(mention.mentionId, usedMentionIds),
      start: mention.start + offset,
      end: mention.end + offset
    }))
  ];
  const atoms = [
    ...source.atoms.map((atom) => ({ ...atom })),
    ...existing.atoms.map((atom) => ({
      ...atom,
      atomId: uniqueRecoveredAtomId(atom.atomId, usedAtomIds),
      start: atom.start + offset,
      end: atom.end + offset
    }))
  ];
  return normalizeMobileComposerDraft({ text: `${source.text}${separator}${existing.text}`, mentions, atoms, attachments });
}

export function mobileComposerDraftWithoutPrefix(
  prefix: MobileComposerDraft,
  current: MobileComposerDraft
): MobileComposerDraft | undefined {
  const source = normalizeMobileComposerDraft(prefix);
  const existing = normalizeMobileComposerDraft(current);
  if (existing.attachments.length < source.attachments.length
    || !source.attachments.every((attachment, index) => mobileComposerAttachmentsEqual(
      attachment,
      existing.attachments[index]!
    ))) return undefined;
  const remainingAttachments = existing.attachments.slice(source.attachments.length).map(cloneMobileComposerAttachment);
  if (!source.text) return normalizeMobileComposerDraft({ ...cloneMobileComposerDraft(existing), attachments: remainingAttachments });
  if (existing.text === source.text) {
    if (!mobileComposerDraftsEqual(source, {
      text: existing.text,
      mentions: existing.mentions,
      atoms: existing.atoms,
      attachments: existing.attachments.slice(0, source.attachments.length)
    })) return undefined;
    return normalizeMobileComposerDraft({ text: "", mentions: [], atoms: [], attachments: remainingAttachments });
  }
  const separator = "\n\n";
  const offset = source.text.length + separator.length;
  if (!existing.text.startsWith(`${source.text}${separator}`)) return undefined;
  const sourceMentions = existing.mentions.filter((mention) => mention.end <= source.text.length);
  const sourceAtoms = existing.atoms.filter((atom) => atom.end <= source.text.length);
  if (!mobileComposerDraftsEqual(source, {
    text: source.text,
    mentions: sourceMentions,
    atoms: sourceAtoms,
    attachments: existing.attachments.slice(0, source.attachments.length)
  })) return undefined;
  if (existing.mentions.some((mention) => mention.start < offset && mention.end > source.text.length)) return undefined;
  if (existing.atoms.some((atom) => atom.start < offset && atom.end > source.text.length)) return undefined;
  return normalizeMobileComposerDraft({
    text: existing.text.slice(offset),
    mentions: existing.mentions
      .filter((mention) => mention.start >= offset)
      .map((mention) => ({ ...cloneMention(mention), start: mention.start - offset, end: mention.end - offset })),
    atoms: existing.atoms
      .filter((atom) => atom.start >= offset)
      .map((atom) => ({ ...atom, start: atom.start - offset, end: atom.end - offset })),
    attachments: remainingAttachments
  });
}

export function recoverMobileComposerDraft(
  input: MobileComposerDraft,
  current: MobileComposerDraft | undefined
): MobileComposerDraft {
  const source = normalizeMobileComposerDraft(input);
  if (current === undefined) return cloneMobileComposerDraft(source);
  const existing = normalizeMobileComposerDraft(current);
  return mobileComposerDraftWithoutPrefix(source, existing) === undefined
    ? prependMobileComposerDraft(source, existing)
    : cloneMobileComposerDraft(existing);
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

export function expandedMobileComposerSelection(
  draft: MobileComposerDraft,
  selection: MobileComposerSelection
): MobileComposerSelection {
  const current = normalizeMobileComposerDraft(draft);
  return expandedAtomicRange(current, normalizeSelection(selection, current.text));
}

export function mobileComposerInput(draft: MobileComposerDraft): InputContent {
  const exact = normalizeMobileComposerDraft(draft);
  const serialized = serializeMobileComposerText(exact);
  if (!serialized.text.trim() && exact.attachments.length === 0) {
    throw new Error("Enter a task message or attach a file before sending.");
  }
  if (exact.attachments.some((attachment) => attachment.state !== "uploaded")) {
    throw new Error("Finish uploading every attachment before sending.");
  }
  return create(InputContentSchema, {
    parts: [
      ...(serialized.text.length === 0 ? [] : [create(InputPartSchema, { content: { case: "text", value: serialized.text } })]),
      ...exact.attachments.map((attachment) => mobileComposerAttachmentInputPart(
        attachment as MobileUploadedComposerAttachment
      )),
      ...exact.mentions.map(mobileComposerInputPart)
    ],
    quotesEncoded: exact.atoms.some((atom) => atom.kind === "quote"),
    pastedTextRanges: serialized.pastedTextRanges.map((range) => create(InlineTextRangeSchema, range)),
    mentionRanges: exact.mentions.map((mention, mentionIndex) => create(InputMentionRangeSchema, {
      start: projectComposerOffset(mention.start, exact.atoms),
      end: projectComposerOffset(mention.end, exact.atoms),
      mentionIndex
    }))
  });
}

export function mobileInputSummary(input: InputContent | undefined, typedMetadataTrusted = true): string {
  if (!input) return "";
  const wireText = input.parts.flatMap((part) => part.content.case === "text" ? [part.content.value] : []).join("");
  const media = input.parts.flatMap((part) => part.content.case === "image" ? ["[Image]"]
    : part.content.case === "file" ? ["[File]"] : []);
  if (!typedMetadataTrusted) {
    const untrustedStructuredMetadata = input.parts.some((part) => part.content.case === "sessionMention"
      || part.content.case === "workspaceMention" || part.content.case === "resourceMention"
      || part.content.case === "artifactMention")
      || input.mentionRanges.length > 0 || input.pastedTextRanges.length > 0 || input.quotesEncoded;
    return [wireText, ...media, ...(untrustedStructuredMetadata ? ["[Untrusted structured metadata ignored]"] : [])]
      .filter((value) => value.length > 0).join("\n");
  }
  const mentions = input.parts.flatMap((part) => {
    if (part.content.case === "sessionMention") return [{ label: part.content.value.displayText || part.content.value.sessionId, valid: true }];
    if (part.content.case === "workspaceMention") return [{
      label: part.content.value.displayText || part.content.value.relativePath,
      valid: validInputWorkspaceMention(part.content.value)
    }];
    if (part.content.case === "resourceMention") return [{
      label: part.content.value.displayText || part.content.value.resourceId,
      valid: validInputResourceMention(part.content.value)
    }];
    if (part.content.case === "artifactMention") return [{
      label: part.content.value.displayText || part.content.value.artifactId,
      valid: validInputArtifactMention(part.content.value)
    }];
    return [];
  });
  const rangesValid = mentions.every((mention) => mention.valid)
    && validMentionRanges(wireText, mentions.length, input.mentionRanges, input.pastedTextRanges);
  const compactText = rangesValid ? compactMobilePastedText(wireText, input.pastedTextRanges) : wireText;
  const text = input.quotesEncoded && rangesValid
    ? mobileVisibleSelectionQuoteText(compactText, []) ?? compactText
    : compactText;
  const inline = new Set(rangesValid ? input.mentionRanges.map((range) => range.mentionIndex) : []);
  const suffix: string[] = [...media];
  if (rangesValid) {
    mentions.forEach((mention, index) => { if (!inline.has(index)) suffix.push(`@${mention.label}`); });
  } else if (mentions.length > 0 || input.mentionRanges.length > 0) {
    suffix.push("[Invalid reference metadata]");
  }
  return [text, ...suffix].filter((value) => value.length > 0).join("\n");
}

export function replaceMobileComposerRange(
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
  const atoms = exact.atoms.flatMap((atom) => {
    if (atom.end <= range.start) return [{ ...atom }];
    if (atom.start >= range.end) return [{ ...atom, start: atom.start + delta, end: atom.end + delta }];
    return [];
  });
  const next = normalizeMobileComposerDraft({ text, mentions, atoms, attachments: exact.attachments });
  const caret = range.start + replacement.length;
  return { draft: next, selection: { start: caret, end: caret } };
}

function insertMobileComposerMention(
  draft: MobileComposerDraft,
  range: MobileComposerSelection,
  mention: MobileComposerMention
): MobileComposerEditResult {
  const token = mobileComposerMentionToken(mention);
  const quoteBefore = draft.atoms.find((atom) => atom.kind === "quote" && atom.end === range.start);
  const quoteAfter = draft.atoms.find((atom) => atom.kind === "quote" && atom.start === range.end);
  const prefix = range.start === range.end && quoteBefore?.end === draft.text.length
    ? "\n\n"
    : range.start > 0 && !/\s/u.test(draft.text[range.start - 1] ?? "") ? " " : "";
  const suffix = range.start === range.end && quoteAfter?.start === 0
    ? "\n\n"
    : range.end < draft.text.length && !/\s/u.test(draft.text[range.end] ?? "") ? " " : "";
  const result = replaceMobileComposerRange(draft, range, `${prefix}${token}${suffix}`);
  const start = range.start + prefix.length;
  const occurrence = { ...mention, start, end: start + token.length };
  const mentions = [...result.draft.mentions, occurrence]
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const next = normalizeMobileComposerDraft({
    text: result.draft.text,
    mentions,
    atoms: result.draft.atoms,
    attachments: result.draft.attachments
  });
  const caret = range.start + prefix.length + token.length + suffix.length;
  return { draft: next, selection: { start: caret, end: caret } };
}

function insertMobileComposerAtom(
  draft: MobileComposerDraft,
  range: MobileComposerSelection,
  atom: Omit<MobileComposerAtom, "atomId" | "start" | "end"> & { readonly atomId?: string },
  prefix: string,
  suffix: string
): MobileComposerEditResult {
  const atomId = atom.atomId;
  if (atomId === undefined) throw new Error("The Joko composer atom occurrence is invalid.");
  const token = mobileComposerAtomToken(atom);
  const result = replaceMobileComposerRange(draft, range, `${prefix}${token}${suffix}`);
  if (result.draft.atoms.length >= maximumComposerAtoms) {
    throw new Error(`A task message can contain at most ${maximumComposerAtoms} structured quote or paste items.`);
  }
  const start = range.start + prefix.length;
  const occurrence = { ...atom, atomId, start, end: start + token.length } as MobileComposerAtom;
  const atoms = [...result.draft.atoms, occurrence]
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const next = normalizeMobileComposerDraft({
    text: result.draft.text,
    mentions: result.draft.mentions,
    atoms,
    attachments: result.draft.attachments
  });
  const caret = range.start + prefix.length + token.length + suffix.length;
  return { draft: next, selection: { start: caret, end: caret } };
}

function replaceMobileComposerAtom(
  draft: MobileComposerDraft,
  previous: MobileComposerAtom,
  replacement: Omit<MobileComposerAtom, "atomId" | "start" | "end">
): MobileComposerEditResult {
  const result = replaceMobileComposerRange(draft, { start: previous.start, end: previous.end }, mobileComposerAtomToken(replacement));
  const token = mobileComposerAtomToken(replacement);
  const atom = { ...replacement, atomId: previous.atomId, start: previous.start, end: previous.start + token.length } as MobileComposerAtom;
  const atoms = [...result.draft.atoms, atom]
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const next = normalizeMobileComposerDraft({ ...result.draft, atoms });
  return { draft: next, selection: { start: atom.end, end: atom.end } };
}

function normalizeQuoteAtom(
  atom: MobileComposerQuoteAtom
): Omit<MobileComposerQuoteAtom, "atomId" | "start" | "end"> {
  if (atom.sourceRole !== "assistant") throw new Error("Only assistant text can be stored as a message quote.");
  const text = normalizedSelectionQuoteText(atom.text);
  if (text === undefined || text !== atom.text || text.length > mobileSelectionQuoteMaximumCharacters) {
    throw new Error("The local Joko message quote is invalid.");
  }
  return {
    kind: "quote",
    sourceSessionId: normalizeExactIdentity(atom.sourceSessionId, "quote source task", 1_024),
    sourceMessageId: normalizeExactIdentity(atom.sourceMessageId, "quote source message", 1_024),
    sourceEventId: normalizeExactIdentity(atom.sourceEventId, "quote source Event", 1_024),
    sourceRole: "assistant",
    text
  };
}

function normalizePastedTextAtom(
  atom: MobileComposerPastedTextAtom
): Omit<MobileComposerPastedTextAtom, "atomId" | "start" | "end"> {
  if (typeof atom.text !== "string" || atom.text.length === 0
    || atom.text.length > mobileLongPasteMaximumCharacters) {
    throw new Error(`Pasted text must contain between 1 and ${mobileLongPasteMaximumCharacters.toLocaleString("en-US")} characters.`);
  }
  return { kind: "pasted-text", text: atom.text };
}

function normalizedSelectionQuoteText(value: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\r\n?/gu, "\n").replace(/^\n+|\n+$/gu, "");
  return normalized.trim() === "" ? undefined : normalized;
}

function mobilePastedTextLineCount(text: string): number {
  let lines = text.length === 0 ? 0 : 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

interface MobileSerializedComposerText {
  readonly text: string;
  readonly pastedTextRanges: readonly { readonly start: number; readonly end: number; readonly display: string }[];
}

function serializeMobileComposerText(draft: MobileComposerDraft): MobileSerializedComposerText {
  let text = "";
  let cursor = 0;
  const pastedTextRanges: { start: number; end: number; display: string }[] = [];
  for (const atom of draft.atoms) {
    text += draft.text.slice(cursor, atom.start);
    if (atom.kind === "quote") {
      text += mobileSelectionQuoteText(atom.text);
    } else {
      const start = text.length;
      text += atom.text;
      pastedTextRanges.push({ start, end: text.length, display: mobileComposerAtomLabel(atom) });
    }
    cursor = atom.end;
  }
  text += draft.text.slice(cursor);
  if (text.length > maximumSerializedCharacters) {
    throw new Error(`A task message can contain at most ${maximumSerializedCharacters.toLocaleString("en-US")} serialized characters.`);
  }
  return { text, pastedTextRanges };
}

function mobileSelectionQuoteText(text: string): string {
  return [
    mobileSelectionQuoteMarkerLine,
    ...text.split("\n").map((line) => line === "" ? ">" : `> ${line}`)
  ].join("\n");
}

function projectComposerOffset(offset: number, atoms: readonly MobileComposerAtom[]): number {
  let projected = offset;
  for (const atom of atoms) {
    if (offset <= atom.start) break;
    if (offset < atom.end) throw new Error("A Joko reference offset cannot be inside a composer atom.");
    const serializedLength = atom.kind === "quote" ? mobileSelectionQuoteText(atom.text).length : atom.text.length;
    projected += serializedLength - (atom.end - atom.start);
  }
  return projected;
}

export function mobileVisibleSelectionQuoteText(
  text: string,
  pastedTextRanges: InputContent["pastedTextRanges"]
): string | undefined {
  if (!validOrderedTextRanges(text, pastedTextRanges)) return undefined;
  const retained: string[] = [];
  let lineStart = 0;
  for (const lineWithNewline of text.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const hasNewline = lineWithNewline.endsWith("\n");
    const line = hasNewline ? lineWithNewline.slice(0, -1) : lineWithNewline;
    const lineEnd = lineStart + line.length;
    const isMarker = line.replace(/\r$/u, "").trimStart() === mobileSelectionQuoteMarkerLine;
    const ownedByPaste = pastedTextRanges.some((range) => lineStart < range.end && lineEnd > range.start);
    if (!isMarker || ownedByPaste) retained.push(lineWithNewline);
    lineStart += lineWithNewline.length;
  }
  return retained.join("");
}

function mobileComposerMentionToken(mention: Pick<MobileComposerMention, "kind" | "displayText">
  & Partial<Pick<MobileComposerWorkspaceMention, "directory" | "lineRange">>): string {
  return mention.kind === "workspace"
    ? mobileWorkspaceMentionToken({
        displayText: mention.displayText,
        directory: mention.directory === true,
        ...(mention.lineRange === undefined ? {} : { lineRange: mention.lineRange })
      })
    : mobileSessionMentionToken(mention.displayText);
}

function cloneMention(mention: MobileComposerMention): MobileComposerMention {
  return mention.kind === "workspace" && mention.lineRange !== undefined
    ? { ...mention, lineRange: { ...mention.lineRange } }
    : { ...mention };
}

function mergeRecoveredAttachments(
  preferred: readonly MobileComposerAttachment[],
  existing: readonly MobileComposerAttachment[]
): readonly MobileComposerAttachment[] {
  const merged = preferred.map(cloneMobileComposerAttachment);
  const byId = new Map(merged.map((attachment) => [attachment.attachmentId, attachment] as const));
  for (const candidate of existing) {
    const attachment = normalizeMobileComposerAttachment(candidate);
    const duplicate = byId.get(attachment.attachmentId);
    if (duplicate !== undefined) {
      if (!mobileComposerAttachmentsEqual(duplicate, attachment)) {
        throw new Error("Recovered Joko attachments have conflicting local identities.");
      }
      continue;
    }
    merged.push(cloneMobileComposerAttachment(attachment));
    byId.set(attachment.attachmentId, attachment);
  }
  return merged;
}

function uniqueRecoveredMentionId(value: string, used: Set<string>): string {
  if (!used.has(value)) {
    used.add(value);
    return value;
  }
  for (let index = 1; index <= 10_000; index += 1) {
    const suffix = `-recovered-${index}`;
    const candidate = `${value.slice(0, 512 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new Error("The recovered Joko task references could not be assigned unique occurrences.");
}

function uniqueRecoveredAtomId(value: string, used: Set<string>): string {
  if (!used.has(value)) {
    used.add(value);
    return value;
  }
  for (let index = 1; index <= 10_000; index += 1) {
    const suffix = `-recovered-${index}`;
    const candidate = `${value.slice(0, 512 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new Error("The recovered Joko composer atoms could not be assigned unique occurrences.");
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

function normalizeResourceMention(
  mention: MobileComposerResourceMention,
  displayText: string
): Omit<MobileComposerResourceMention, "mentionId" | "start" | "end"> {
  const resourceId = normalizeExactIdentity(mention.resourceId, "resource", 4_096);
  const discoveredRevision = normalizeExactIdentity(mention.discoveredRevision, "resource revision", 4_096);
  const resourceVersion = normalizePositiveUint64Text(mention.resourceVersion, "resource version");
  const runtimeGeneration = normalizePositiveUint64Text(mention.runtimeGeneration, "resource runtime generation");
  return {
    kind: "resource",
    resourceId,
    displayText,
    discoveredRevision,
    resourceVersion,
    runtimeGeneration
  };
}

function normalizeArtifactMention(
  mention: MobileComposerArtifactMention,
  displayText: string
): Omit<MobileComposerArtifactMention, "mentionId" | "start" | "end"> {
  return {
    kind: "artifact",
    artifactId: normalizeExactIdentity(mention.artifactId, "Artifact", 1_024),
    sourceSessionId: normalizeExactIdentity(mention.sourceSessionId, "Artifact source task", 1_024),
    displayText
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

function sameMentionAuthority(left: MobileComposerMention, right: MobileComposerMention): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "session") return right.kind === "session" && left.sessionId === right.sessionId;
  if (left.kind === "workspace") {
    return right.kind === "workspace" && left.workspaceId === right.workspaceId
      && left.relativePath === right.relativePath && left.directory === right.directory
      && sameLineRange(left.lineRange, right.lineRange);
  }
  if (left.kind === "resource") {
    return right.kind === "resource" && left.resourceId === right.resourceId
      && left.discoveredRevision === right.discoveredRevision
      && left.resourceVersion === right.resourceVersion
      && left.runtimeGeneration === right.runtimeGeneration;
  }
  return right.kind === "artifact" && left.artifactId === right.artifactId
    && left.sourceSessionId === right.sourceSessionId;
}

function mobileComposerInputPart(mention: MobileComposerMention) {
  if (mention.kind === "session") {
    return create(InputPartSchema, {
      content: { case: "sessionMention", value: create(SessionMentionSchema, {
        sessionId: mention.sessionId,
        displayText: mention.displayText
      }) }
    });
  }
  if (mention.kind === "workspace") {
    return create(InputPartSchema, {
      content: { case: "workspaceMention", value: create(WorkspaceMentionSchema, {
        workspaceId: mention.workspaceId,
        relativePath: mention.relativePath,
        displayText: mention.displayText,
        directory: mention.directory,
        ...(mention.lineRange === undefined ? {} : {
          lineRange: create(WorkspaceLineRangeSchema, mention.lineRange)
        })
      }) }
    });
  }
  if (mention.kind === "resource") {
    return create(InputPartSchema, {
      content: { case: "resourceMention", value: create(ResourceMentionSchema, {
        resourceId: mention.resourceId,
        displayText: mention.displayText,
        discoveredRevision: mention.discoveredRevision,
        resourceVersion: BigInt(mention.resourceVersion),
        runtimeGeneration: BigInt(mention.runtimeGeneration)
      }) }
    });
  }
  return create(InputPartSchema, {
    content: { case: "artifactMention", value: create(ArtifactMentionSchema, {
      artifactId: mention.artifactId,
      sourceSessionId: mention.sourceSessionId,
      displayText: mention.displayText
    }) }
  });
}

function mobileComposerAttachmentInputPart(attachment: MobileUploadedComposerAttachment) {
  const blob = create(BlobRefSchema, {
    blobId: attachment.blobId,
    fileName: attachment.fileName,
    mediaType: attachment.mediaType,
    byteSize: BigInt(attachment.byteSize),
    sha256Hex: attachment.sha256Hex,
    disposition: BlobDisposition.ATTACHMENT
  });
  return attachment.kind === "image"
    ? create(InputPartSchema, {
        content: { case: "image", value: create(ImageRefSchema, {
          blob,
          widthPixels: 0,
          heightPixels: 0,
          altText: attachment.fileName
        }) }
      })
    : create(InputPartSchema, { content: { case: "file", value: blob } });
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

function validInputResourceMention(mention: {
  readonly resourceId: string;
  readonly discoveredRevision: string;
  readonly resourceVersion: bigint;
  readonly runtimeGeneration: bigint;
}): boolean {
  try {
    normalizeExactIdentity(mention.resourceId, "resource", 4_096);
    normalizeExactIdentity(mention.discoveredRevision, "resource revision", 4_096);
    normalizePositiveUint64Text(mention.resourceVersion.toString(10), "resource version");
    normalizePositiveUint64Text(mention.runtimeGeneration.toString(10), "resource runtime generation");
    return true;
  } catch {
    return false;
  }
}

function validInputArtifactMention(mention: {
  readonly artifactId: string;
  readonly sourceSessionId: string;
}): boolean {
  try {
    normalizeExactIdentity(mention.artifactId, "Artifact", 1_024);
    normalizeExactIdentity(mention.sourceSessionId, "Artifact source task", 1_024);
    return true;
  } catch {
    return false;
  }
}

function expandedAtomicRange(draft: MobileComposerDraft, selection: MobileComposerSelection): MobileComposerSelection {
  let start = selection.start;
  let end = selection.end;
  const ranges = [...draft.mentions, ...draft.atoms]
    .sort((left, right) => left.start - right.start || left.end - right.end);
  for (const atom of ranges) {
    const insertionInside = start === end && atom.start < start && start < atom.end;
    const overlaps = start < atom.end && end > atom.start;
    if (!insertionInside && !overlaps) continue;
    start = Math.min(start, atom.start);
    end = Math.max(end, atom.end);
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

function normalizeExactIdentity(value: string, label: string, maximumCharacters: number): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximumCharacters
    || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)) {
    throw new Error(`The local Joko ${label} identity is invalid.`);
  }
  return value;
}

function normalizePositiveUint64Text(value: string, label: string): string {
  if (typeof value !== "string" || value.length > 20 || !/^[1-9][0-9]*$/u.test(value)
    || BigInt(value) > maximumUint64) {
    throw new Error(`The local Joko ${label} is invalid.`);
  }
  return value;
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
      || !isUtf16Boundary(text, range.start) || !isUtf16Boundary(text, range.end)
      || typeof range.display !== "string" || !range.display || range.display.length > maximumDisplayCharacters
      || /[\u0000-\u001f\u007f]/u.test(range.display)) return false;
    previousEnd = range.end;
  }
  return true;
}

function compactMobilePastedText(text: string, ranges: InputContent["pastedTextRanges"]): string {
  let result = text;
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index]!;
    result = `${result.slice(0, range.start)}${range.display}${result.slice(range.end)}`;
  }
  return result;
}

function isUtf16Boundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

export const mobileComposerDocumentTesting = {
  maximumDraftCharacters,
  maximumComposerAtoms,
  maximumSelectionQuotes,
  maximumSerializedCharacters,
  maximumSessionMentions,
  maximumLineNumber
};
