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
import {
  mobileComposerMessageReferenceTextMaximumCharacters,
  parseMobileComposerRouteHref,
  sanitizeMobileComposerReferenceLabel,
  seedMobileComposerRouteReference,
  segmentMobileComposerRoutePaste,
  summarizeMobileComposerMessageReference,
  type MobileComposerRoutePasteOptions,
  type MobileComposerRoutePasteSegment
} from "./mobile-composer-route-links";

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
  /** A restored quote can retain its canonical containing user input. */
  readonly sourceRole: "assistant" | "user";
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** A copied file excerpt is quoted data, without message or file access authority. */
export interface MobileComposerFileQuoteAtom {
  readonly kind: "file-quote";
  readonly atomId: string;
  readonly sourceSessionId: string;
  readonly sourcePath: string;
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

interface MobileComposerRouteReferenceAtomBase {
  readonly kind: "route-reference";
  readonly atomId: string;
  readonly serialized: string;
  readonly displayText: string;
  readonly start: number;
  readonly end: number;
}

export interface MobileComposerSessionRouteReferenceAtom extends MobileComposerRouteReferenceAtomBase {
  readonly routeKind: "session";
  readonly href: string;
  readonly sessionId: string;
  readonly messageId?: string;
  readonly eventId?: string;
}

export interface MobileComposerProjectRouteReferenceAtom extends MobileComposerRouteReferenceAtomBase {
  readonly routeKind: "project";
  readonly href: string;
  readonly projectId: string;
}

export interface MobileComposerPathRouteReferenceAtom extends MobileComposerRouteReferenceAtomBase {
  readonly routeKind: "path";
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly directory: boolean;
}

export type MobileComposerRouteReferenceAtom = MobileComposerSessionRouteReferenceAtom
  | MobileComposerProjectRouteReferenceAtom
  | MobileComposerPathRouteReferenceAtom;

export type MobileComposerAtom = MobileComposerQuoteAtom
  | MobileComposerFileQuoteAtom
  | MobileComposerPastedTextAtom
  | MobileComposerRouteReferenceAtom;

export function isMobileComposerQuoteAtom(atom: MobileComposerAtom | undefined): atom is MobileComposerQuoteAtom | MobileComposerFileQuoteAtom {
  return atom?.kind === "quote" || atom?.kind === "file-quote";
}

export interface MobileComposerSlashCommandMark {
  /** Exact local presentation text selected from the current-task command palette. */
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface MobileComposerDraft {
  readonly text: string;
  readonly mentions: readonly MobileComposerMention[];
  readonly atoms: readonly MobileComposerAtom[];
  readonly slashCommands: readonly MobileComposerSlashCommandMark[];
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

export interface MobileComposerRoutePasteResult extends MobileComposerEditResult {
  readonly insertedAtomIds: readonly string[];
}

type MobileComposerAtomPresentation =
  | Pick<MobileComposerQuoteAtom, "kind" | "text">
  | Pick<MobileComposerFileQuoteAtom, "kind" | "text" | "sourcePath">
  | Pick<MobileComposerPastedTextAtom, "kind" | "text">
  | Pick<MobileComposerRouteReferenceAtom, "kind" | "serialized" | "displayText">;

type MobileComposerRouteReferenceAtomSeed =
  | Omit<MobileComposerSessionRouteReferenceAtom, "atomId" | "start" | "end">
  | Omit<MobileComposerProjectRouteReferenceAtom, "atomId" | "start" | "end">
  | Omit<MobileComposerPathRouteReferenceAtom, "atomId" | "start" | "end">;

type MobileComposerAtomSeed =
  | Omit<MobileComposerQuoteAtom, "atomId" | "start" | "end">
  | Omit<MobileComposerFileQuoteAtom, "atomId" | "start" | "end">
  | Omit<MobileComposerPastedTextAtom, "atomId" | "start" | "end">
  | MobileComposerRouteReferenceAtomSeed;

const maximumDraftCharacters = 1_000_000;
export const mobileLongPasteLineThreshold = 24;
export const mobileLongPasteCharacterThreshold = 4_000;
export const mobileLongPasteMaximumCharacters = 2_000_000;
export const mobileComposerNativeInputMaximumCharacters = maximumDraftCharacters + mobileLongPasteMaximumCharacters;
export const mobileSelectionQuoteMaximumCharacters = 4_000;
export const mobileSelectionQuoteMarker = "<!-- joko-selection-quote -->";
export const mobileSelectionQuoteMarkerLine = `> ${mobileSelectionQuoteMarker}`;
export const mobileComposerMaximumAtoms = 1_024;
const maximumSlashCommandMarks = 1_024;
const maximumSlashCommandCharacters = 257;
const maximumSelectionQuotes = 32;
const maximumSerializedCharacters = 2_000_000;
const maximumSessionMentions = 8;
const maximumDisplayCharacters = 256;
const maximumLineNumber = 0xffff_ffff;
const maximumUint64 = 18_446_744_073_709_551_615n;

export function emptyMobileComposerDraft(): MobileComposerDraft {
  return { text: "", mentions: [], atoms: [], slashCommands: [], attachments: [] };
}

export function plainTextMobileComposerDraft(text: string): MobileComposerDraft {
  return normalizeMobileComposerDraft({ text, mentions: [], atoms: [], slashCommands: [], attachments: [] });
}

export function normalizeMobileComposerDraft(value: MobileComposerDraft): MobileComposerDraft {
  if (!value || typeof value !== "object" || typeof value.text !== "string"
    || !Array.isArray(value.mentions) || !Array.isArray(value.atoms)
    || !Array.isArray(value.slashCommands) || !Array.isArray(value.attachments)) {
    throw new Error("The local Joko structured task draft is invalid.");
  }
  if (value.text.length > maximumDraftCharacters) {
    throw new Error("The local Joko structured task draft is too large.");
  }
  if (value.mentions.filter((mention) => mention?.kind === "session").length > maximumSessionMentions) {
    throw new Error("A task message can reference at most 8 other tasks.");
  }
  if (value.atoms.length > mobileComposerMaximumAtoms) {
    throw new Error(`A task message can contain at most ${mobileComposerMaximumAtoms} structured message items.`);
  }
  if (value.slashCommands.length > maximumSlashCommandMarks) {
    throw new Error(`A task message can contain at most ${maximumSlashCommandMarks} selected slash commands.`);
  }
  if (value.atoms.filter(isMobileComposerQuoteAtom).length > maximumSelectionQuotes) {
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
      || (candidate.kind !== "quote" && candidate.kind !== "file-quote" && candidate.kind !== "pasted-text" && candidate.kind !== "route-reference")) {
      throw new Error("The local Joko composer atom is invalid.");
    }
    assertIdentity(candidate.atomId, "composer atom occurrence");
    if (atomIds.has(candidate.atomId)) throw new Error("The local Joko composer atom occurrence is duplicated.");
    atomIds.add(candidate.atomId);
    const normalized = candidate.kind === "quote"
      ? normalizeQuoteAtom(candidate)
      : candidate.kind === "file-quote"
        ? normalizeFileQuoteAtom(candidate)
      : candidate.kind === "pasted-text"
        ? normalizePastedTextAtom(candidate)
        : normalizeRouteReferenceAtom(candidate);
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
    if (!isMobileComposerQuoteAtom(atom)) continue;
    const separatedBefore = atom.start === 0 || value.text.slice(atom.start - 2, atom.start) === "\n\n";
    const separatedAfter = atom.end === value.text.length || value.text.slice(atom.end, atom.end + 2) === "\n\n";
    if (!separatedBefore || !separatedAfter) {
      throw new Error("A Joko message quote must remain a separate composer block.");
    }
  }
  for (const mention of mentions) {
    if (atoms.some((atom) => mention.start < atom.end && mention.end > atom.start)) {
      throw new Error("A Joko reference cannot overlap a structured composer item.");
    }
  }
  previousEnd = 0;
  const slashCommands = value.slashCommands.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || typeof candidate.text !== "string"
      || candidate.text.length < 2 || candidate.text.length > maximumSlashCommandCharacters
      || !/^\/[^\s/\u0000-\u001f\u007f\u2028\u2029]+$/u.test(candidate.text)
      || !Number.isSafeInteger(candidate.start) || !Number.isSafeInteger(candidate.end)
      || candidate.start < previousEnd || candidate.start < 0 || candidate.end <= candidate.start
      || candidate.end > value.text.length || candidate.end - candidate.start !== candidate.text.length
      || !isUtf16Boundary(value.text, candidate.start) || !isUtf16Boundary(value.text, candidate.end)
      || value.text.slice(candidate.start, candidate.end) !== candidate.text) {
      throw new Error("The local Joko selected slash-command mark is invalid.");
    }
    if (mentions.some((mention) => candidate.start < mention.end && candidate.end > mention.start)
      || atoms.some((atom) => candidate.start < atom.end && candidate.end > atom.start)) {
      throw new Error("A selected slash command cannot overlap a structured composer item.");
    }
    previousEnd = candidate.end;
    return { text: candidate.text, start: candidate.start, end: candidate.end };
  });
  const attachments = normalizeMobileComposerAttachmentSet(value.attachments);
  const draft = { text: value.text, mentions, atoms, slashCommands, attachments };
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
    slashCommands: exact.slashCommands.map((mark) => ({ ...mark })),
    attachments: exact.attachments.map(cloneMobileComposerAttachment)
  };
}

export function mobileComposerDraftsEqual(left: MobileComposerDraft, right: MobileComposerDraft): boolean {
  const first = normalizeMobileComposerDraft(left);
  const second = normalizeMobileComposerDraft(right);
  return first.text === second.text && first.mentions.length === second.mentions.length
    && first.atoms.length === second.atoms.length
    && first.slashCommands.length === second.slashCommands.length
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
        && atom.start === candidate.start && atom.end === candidate.end
        && sameComposerAtomAuthority(atom, candidate);
    })
    && first.slashCommands.every((mark, index) => {
      const candidate = second.slashCommands[index];
      return candidate !== undefined && mark.text === candidate.text
        && mark.start === candidate.start && mark.end === candidate.end;
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

export function mobileComposerAtomToken(atom: MobileComposerAtomPresentation): string {
  if (atom.kind === "file-quote") return "⟦Quote from File⟧";
  if (atom.kind === "quote") return "⟦Quote from Assistant⟧";
  if (atom.kind === "route-reference") return atom.serialized;
  const lines = mobilePastedTextLineCount(atom.text);
  return `⟦Pasted text (${lines} ${lines === 1 ? "line" : "lines"})⟧`;
}

export function mobileComposerAtomLabel(atom: MobileComposerAtomPresentation): string {
  if (atom.kind === "file-quote") return "Quote from File";
  if (atom.kind === "quote") return "Quote from Assistant";
  return atom.kind === "route-reference" ? atom.displayText : mobileComposerAtomToken(atom).slice(1, -1);
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
  const quoteBefore = current.atoms.find((atom) => isMobileComposerQuoteAtom(atom) && atom.end === prefix);
  if (inserted && oldEnd === prefix && quoteBefore && quoteBefore.end === current.text.length) {
    if (atomId !== undefined && isLongMobileComposerPaste(inserted)) {
      const separated = replaceMobileComposerRange(current, { start: prefix, end: oldEnd }, "\n\n");
      return insertMobilePastedText(separated.draft, separated.selection, inserted, atomId);
    }
    return replaceMobileComposerRange(current, { start: prefix, end: oldEnd }, `\n\n${inserted}`);
  }
  const quoteAfter = current.atoms.find((atom) => isMobileComposerQuoteAtom(atom) && atom.start === prefix);
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

export function appendMobileFileSelectionQuote(
  draft: MobileComposerDraft,
  quote: { readonly sourceSessionId: string; readonly sourcePath: string; readonly text: string },
  atomId: string
): MobileComposerEditResult {
  const current = normalizeMobileComposerDraft(draft);
  assertIdentity(atomId, "composer atom occurrence");
  const text = normalizedSelectionQuoteText(quote.text);
  if (text === undefined || text.length > mobileSelectionQuoteMaximumCharacters) throw new Error("Select non-empty file text of at most 4,000 characters.");
  const atom = normalizeFileQuoteAtom({ kind: "file-quote", ...quote, text, atomId, start: 0, end: 0 });
  return insertMobileComposerAtom(current, { start: current.text.length, end: current.text.length },
    { ...atom, atomId }, current.text.length ? "\n\n" : "", "");
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
  const quoteBefore = current.atoms.find((atom) => isMobileComposerQuoteAtom(atom) && atom.end === range.start);
  if (range.start === range.end && quoteBefore?.end === current.text.length) {
    return replaceMobileComposerRange(current, range, `\n\n${text}`);
  }
  const quoteAfter = current.atoms.find((atom) => isMobileComposerQuoteAtom(atom) && atom.start === range.end);
  if (range.start === range.end && quoteAfter?.start === 0) {
    return replaceMobileComposerRange(current, range, `${text}\n\n`);
  }
  return replaceMobileComposerRange(current, range, text);
}

export function insertMobileStructuredClipboardText(
  draft: MobileComposerDraft,
  selection: MobileComposerSelection,
  text: string,
  atomIdFactory: (index: number) => string,
  options: MobileComposerRoutePasteOptions = {}
): MobileComposerRoutePasteResult {
  if (isLongMobileComposerPaste(text)) {
    return { ...insertMobileClipboardText(draft, selection, text, atomIdFactory(0)), insertedAtomIds: [] };
  }
  const segments = segmentMobileComposerRoutePaste(text, options);
  if (segments !== null) return insertMobileRouteReferencePaste(draft, selection, segments, atomIdFactory);
  return { ...insertMobileClipboardText(draft, selection, text, atomIdFactory(0)), insertedAtomIds: [] };
}

export function insertMobileRouteReferencePaste(
  draft: MobileComposerDraft,
  selection: MobileComposerSelection,
  segments: readonly MobileComposerRoutePasteSegment[],
  atomIdFactory: (index: number) => string
): MobileComposerRoutePasteResult {
  const current = normalizeMobileComposerDraft(draft);
  if (!Array.isArray(segments) || !segments.some((segment) => segment?.kind === "route-reference")) {
    throw new Error("The clipboard does not contain a Joko link or validated Workspace path.");
  }
  const range = expandedAtomicRange(current, normalizeSelection(selection, current.text));
  const quoteBefore = current.atoms.find((atom) => isMobileComposerQuoteAtom(atom) && atom.end === range.start);
  const quoteAfter = current.atoms.find((atom) => isMobileComposerQuoteAtom(atom) && atom.start === range.end);
  const prefix = range.start === range.end && quoteBefore?.end === current.text.length ? "\n\n" : "";
  const suffix = range.start === range.end && quoteAfter?.start === 0 ? "\n\n" : "";
  const replacement: string[] = [prefix];
  const occurrences: MobileComposerRouteReferenceAtom[] = [];
  let offset = range.start + prefix.length;
  let routeIndex = 0;
  for (const segment of segments) {
    if (!segment || typeof segment !== "object") throw new Error("The pasted Joko link is invalid.");
    if (segment.kind === "text") {
      if (typeof segment.text !== "string") throw new Error("The pasted Joko link text is invalid.");
      replacement.push(segment.text);
      offset += segment.text.length;
      continue;
    }
    if (segment.kind !== "route-reference") throw new Error("The pasted Joko link is invalid.");
    const seeded = seedMobileComposerRouteReference(segment);
    const atomId = atomIdFactory(routeIndex++);
    assertIdentity(atomId, "composer atom occurrence");
    const candidate: MobileComposerRouteReferenceAtom = seeded.routeKind === "session"
      ? {
          kind: "route-reference",
          routeKind: "session",
          atomId,
          href: seeded.href,
          serialized: seeded.serialized,
          sessionId: seeded.sessionId,
          ...(seeded.messageId === undefined ? {} : { messageId: seeded.messageId }),
          ...(seeded.eventId === undefined ? {} : { eventId: seeded.eventId }),
          displayText: seeded.displayText,
          start: offset,
          end: offset + seeded.serialized.length
        }
      : seeded.routeKind === "project" ? {
          kind: "route-reference",
          routeKind: "project",
          atomId,
          href: seeded.href,
          serialized: seeded.serialized,
          projectId: seeded.projectId,
          displayText: seeded.displayText,
          start: offset,
          end: offset + seeded.serialized.length
        }
      : {
          kind: "route-reference",
          routeKind: "path",
          atomId,
          serialized: seeded.serialized,
          workspaceId: seeded.workspaceId,
          relativePath: seeded.relativePath,
          directory: seeded.directory,
          displayText: seeded.displayText,
          start: offset,
          end: offset + seeded.serialized.length
        };
    const atom = normalizeRouteReferenceAtom(candidate);
    occurrences.push({ ...atom, atomId, start: offset, end: offset + seeded.serialized.length });
    replacement.push(seeded.serialized);
    offset += seeded.serialized.length;
  }
  replacement.push(suffix);
  const result = replaceMobileComposerRange(current, range, replacement.join(""));
  if (result.draft.atoms.length + occurrences.length > mobileComposerMaximumAtoms) {
    throw new Error(`A task message can contain at most ${mobileComposerMaximumAtoms} structured message items.`);
  }
  const atoms = [...result.draft.atoms, ...occurrences]
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const next = normalizeMobileComposerDraft({ ...result.draft, atoms });
  const caret = range.start + replacement.join("").length;
  return {
    draft: next,
    selection: { start: caret, end: caret },
    insertedAtomIds: occurrences.map((atom) => atom.atomId)
  };
}

export function updateMobileRouteReferenceAtom(
  draft: MobileComposerDraft,
  expected: MobileComposerRouteReferenceAtom,
  resolvedText: string
): MobileComposerEditResult | undefined {
  if (expected.routeKind === "path") return undefined;
  const current = normalizeMobileComposerDraft(draft);
  const atom = current.atoms.find((candidate) => candidate.atomId === expected.atomId);
  if (atom?.kind !== "route-reference" || atom.routeKind === "path"
    || !sameComposerAtomAuthority(atom, expected)) return undefined;
  const anchored = atom.routeKind === "session"
    && (atom.messageId !== undefined || atom.eventId !== undefined);
  const displayText = anchored
    ? summarizeMobileComposerMessageReference(resolvedText.slice(0, mobileComposerMessageReferenceTextMaximumCharacters))
    : sanitizeMobileComposerReferenceLabel(resolvedText);
  if (displayText === "") return undefined;
  const serialized = anchored ? atom.href : `[${displayText}](${atom.href})`;
  return replaceMobileComposerAtom(current, atom, normalizeRouteReferenceAtom({
    ...atom,
    displayText,
    serialized
  }));
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
  const quoteBefore = current.atoms.find((candidate) => isMobileComposerQuoteAtom(candidate) && candidate.end === range.start);
  const quoteAfter = current.atoms.find((candidate) => isMobileComposerQuoteAtom(candidate) && candidate.start === range.end);
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
  if (!atom) throw new Error("The selected structured message item is no longer in this draft.");
  if (!isMobileComposerQuoteAtom(atom)) return replaceMobileComposerRange(current, { start: atom.start, end: atom.end }, "");
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
    slashCommands: current.slashCommands,
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
  const slashCommands = [
    ...source.slashCommands.map((mark) => ({ ...mark })),
    ...existing.slashCommands.map((mark) => ({
      ...mark,
      start: mark.start + offset,
      end: mark.end + offset
    }))
  ];
  return normalizeMobileComposerDraft({
    text: `${source.text}${separator}${existing.text}`,
    mentions,
    atoms,
    slashCommands,
    attachments
  });
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
      slashCommands: existing.slashCommands,
      attachments: existing.attachments.slice(0, source.attachments.length)
    })) return undefined;
    return normalizeMobileComposerDraft({
      text: "",
      mentions: [],
      atoms: [],
      slashCommands: [],
      attachments: remainingAttachments
    });
  }
  const separator = "\n\n";
  const offset = source.text.length + separator.length;
  if (!existing.text.startsWith(`${source.text}${separator}`)) return undefined;
  const sourceMentions = existing.mentions.filter((mention) => mention.end <= source.text.length);
  const sourceAtoms = existing.atoms.filter((atom) => atom.end <= source.text.length);
  const sourceSlashCommands = existing.slashCommands.filter((mark) => mark.end <= source.text.length);
  if (!mobileComposerDraftsEqual(source, {
    text: source.text,
    mentions: sourceMentions,
    atoms: sourceAtoms,
    slashCommands: sourceSlashCommands,
    attachments: existing.attachments.slice(0, source.attachments.length)
  })) return undefined;
  if (existing.mentions.some((mention) => mention.start < offset && mention.end > source.text.length)) return undefined;
  if (existing.atoms.some((atom) => atom.start < offset && atom.end > source.text.length)) return undefined;
  if (existing.slashCommands.some((mark) => mark.start < offset && mark.end > source.text.length)) return undefined;
  return normalizeMobileComposerDraft({
    text: existing.text.slice(offset),
    mentions: existing.mentions
      .filter((mention) => mention.start >= offset)
      .map((mention) => ({ ...cloneMention(mention), start: mention.start - offset, end: mention.end - offset })),
    atoms: existing.atoms
      .filter((atom) => atom.start >= offset)
      .map((atom) => ({ ...atom, start: atom.start - offset, end: atom.end - offset })),
    slashCommands: existing.slashCommands
      .filter((mark) => mark.start >= offset)
      .map((mark) => ({ ...mark, start: mark.start - offset, end: mark.end - offset })),
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
    quotesEncoded: exact.atoms.some(isMobileComposerQuoteAtom),
    pastedTextRanges: serialized.pastedTextRanges.map((range) => create(InlineTextRangeSchema, range)),
    mentionRanges: exact.mentions.map((mention, mentionIndex) => create(InputMentionRangeSchema, {
      start: projectComposerOffset(mention.start, exact.atoms),
      end: projectComposerOffset(mention.end, exact.atoms),
      mentionIndex
    }))
  });
}

/** Restore accepted input semantics; historical attachment bytes require a new explicit selection. */
export function restoreMobileComposerInput(input: InputContent, source: {
  readonly sessionId: string; readonly messageId: string; readonly eventId: string;
}): MobileComposerDraft {
  const wireText = input.parts.flatMap((part) => part.content.case === "text" ? [part.content.value] : []).join("");
  if (wireText.length > maximumSerializedCharacters || input.parts.length > 1_024) {
    throw new Error("The historical task input exceeds the composer limit.");
  }
  const parts = input.parts.flatMap((part) => part.content.case === "sessionMention" || part.content.case === "workspaceMention"
    || part.content.case === "resourceMention" || part.content.case === "artifactMention" ? [part.content] : []);
  if (!validMentionRanges(wireText, parts.length, input.mentionRanges, input.pastedTextRanges)) {
    throw new Error("The historical task input has invalid reference or paste ranges.");
  }
  type Segment = { start: number; end: number; kind: "mention"; index: number }
    | { start: number; end: number; kind: "paste" | "quote"; text: string; sourcePath?: string };
  const segments: Segment[] = [
    ...input.mentionRanges.map((range): Segment => ({ start: range.start, end: range.end, kind: "mention", index: range.mentionIndex })),
    ...input.pastedTextRanges.map((range): Segment => ({ start: range.start, end: range.end, kind: "paste", text: wireText.slice(range.start, range.end) }))
  ];
  if (input.quotesEncoded) {
    let cursor = 0;
    const lines = wireText.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const start = cursor; cursor += line.length;
      if (line.replace(/\n$/u, "") !== mobileSelectionQuoteMarkerLine
        || segments.some((segment) => start < segment.end && cursor > segment.start)) continue;
      let end = cursor;
      const quoted: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1]!.replace(/\n$/u, "");
        if (next !== ">" && !next.startsWith("> ")) break;
        quoted.push(next === ">" ? "" : next.slice(2));
        index += 1; end += lines[index]!.length; cursor = end;
      }
      if (wireText[end - 1] === "\n") end -= 1;
      if (quoted.length === 0 || segments.some((segment) => start < segment.end && end > segment.start)) {
        throw new Error("The historical quote overlaps another input item or has no quoted text.");
      }
      const footer = quoted.at(-1)?.match(/^— source: (.+)$/u);
      let sourcePath: string | undefined;
      if (footer) { try { sourcePath = normalizeFileQuoteSourcePath(footer[1]!); } catch { /* Unrecognized footers remain quoted text. */ } }
      if (sourcePath && quoted.length > 1) quoted.pop(); else sourcePath = undefined;
      segments.push({ start, end, kind: "quote", text: quoted.join("\n"), ...(sourcePath ? { sourcePath } : {}) });
    }
  }
  segments.sort((left, right) => left.start - right.start);
  let text = ""; let cursor = 0;
  const mentions: MobileComposerMention[] = [];
  const atoms: MobileComposerAtom[] = [];
  const restored = new Set<number>();
  type MentionSeed = Omit<MobileComposerSessionMention, "mentionId" | "start" | "end">
    | Omit<MobileComposerWorkspaceMention, "mentionId" | "start" | "end">
    | Omit<MobileComposerResourceMention, "mentionId" | "start" | "end">
    | Omit<MobileComposerArtifactMention, "mentionId" | "start" | "end">;
  const mentionSeed = (index: number): MentionSeed => {
    const part = parts[index]!;
    if (part.case === "sessionMention") return { kind: "session", sessionId: part.value.sessionId, displayText: part.value.displayText };
    if (part.case === "workspaceMention") return { kind: "workspace", workspaceId: part.value.workspaceId,
      relativePath: part.value.relativePath, directory: part.value.directory, displayText: part.value.displayText,
      ...(part.value.lineRange ? { lineRange: { startLine: part.value.lineRange.startLine, endLine: part.value.lineRange.endLine } } : {}) };
    if (part.case === "resourceMention") return { kind: "resource", resourceId: part.value.resourceId,
      displayText: part.value.displayText, discoveredRevision: part.value.discoveredRevision,
      resourceVersion: part.value.resourceVersion.toString(10), runtimeGeneration: part.value.runtimeGeneration.toString(10) };
    return { kind: "artifact", artifactId: part.value.artifactId, sourceSessionId: part.value.sourceSessionId,
      displayText: part.value.displayText };
  };
  for (const segment of segments) {
    if (segment.start < cursor) throw new Error("The historical input items overlap.");
    text += wireText.slice(cursor, segment.start);
    const start = text.length;
    if (segment.kind === "mention") {
      const seed = mentionSeed(segment.index);
      text += mobileComposerMentionToken(seed);
      mentions.push({ ...seed, mentionId: `restored-mention-${segment.index}`, start, end: text.length } as MobileComposerMention);
      restored.add(segment.index);
    } else {
      const seed = segment.kind === "quote" ? segment.sourcePath
        ? { kind: "file-quote" as const, text: segment.text, sourceSessionId: source.sessionId, sourcePath: segment.sourcePath }
        : { kind: "quote" as const, text: segment.text, sourceRole: "user" as const,
          sourceSessionId: source.sessionId, sourceMessageId: source.messageId, sourceEventId: source.eventId }
        : { kind: "pasted-text" as const, text: segment.text };
      text += mobileComposerAtomToken(seed);
      atoms.push({ ...seed, atomId: `restored-${segment.kind}-${atoms.length}`, start, end: text.length });
    }
    cursor = segment.end;
  }
  text += wireText.slice(cursor);
  parts.forEach((_part, index) => {
    if (restored.has(index)) return;
    if (text.length) text += atoms.some((atom) => isMobileComposerQuoteAtom(atom) && atom.end === text.length) ? "\n\n" : "\n";
    const seed = mentionSeed(index); const start = text.length;
    text += mobileComposerMentionToken(seed);
    mentions.push({ ...seed, mentionId: `restored-mention-${index}`, start, end: text.length } as MobileComposerMention);
  });
  return normalizeMobileComposerDraft({ text, mentions, atoms, attachments: [], slashCommands: [] });
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
  const slashCommands = remapSlashCommandMarks(exact.slashCommands, range, replacement.length);
  const next = normalizeMobileComposerDraft({
    text,
    mentions,
    atoms,
    slashCommands,
    attachments: exact.attachments
  });
  const caret = range.start + replacement.length;
  return { draft: next, selection: { start: caret, end: caret } };
}

export function markMobileComposerSlashCommand(
  draft: MobileComposerDraft,
  start: number,
  text: string
): MobileComposerDraft {
  const exact = normalizeMobileComposerDraft(draft);
  if (!Number.isSafeInteger(start) || start < 0 || typeof text !== "string") {
    throw new Error("The selected slash command could not be marked.");
  }
  const mark = { text, start, end: start + text.length };
  return normalizeMobileComposerDraft({
    ...exact,
    slashCommands: [...exact.slashCommands, mark]
      .sort((left, right) => left.start - right.start || left.end - right.end)
  });
}

function insertMobileComposerMention(
  draft: MobileComposerDraft,
  range: MobileComposerSelection,
  mention: MobileComposerMention
): MobileComposerEditResult {
  const token = mobileComposerMentionToken(mention);
  const quoteBefore = draft.atoms.find((atom) => isMobileComposerQuoteAtom(atom) && atom.end === range.start);
  const quoteAfter = draft.atoms.find((atom) => isMobileComposerQuoteAtom(atom) && atom.start === range.end);
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
    slashCommands: result.draft.slashCommands,
    attachments: result.draft.attachments
  });
  const caret = range.start + prefix.length + token.length + suffix.length;
  return { draft: next, selection: { start: caret, end: caret } };
}

function insertMobileComposerAtom(
  draft: MobileComposerDraft,
  range: MobileComposerSelection,
  atom: MobileComposerAtomSeed & { readonly atomId?: string },
  prefix: string,
  suffix: string
): MobileComposerEditResult {
  const atomId = atom.atomId;
  if (atomId === undefined) throw new Error("The Joko composer atom occurrence is invalid.");
  const token = mobileComposerAtomToken(atom);
  const result = replaceMobileComposerRange(draft, range, `${prefix}${token}${suffix}`);
  if (result.draft.atoms.length >= mobileComposerMaximumAtoms) {
    throw new Error(`A task message can contain at most ${mobileComposerMaximumAtoms} structured message items.`);
  }
  const start = range.start + prefix.length;
  const occurrence = { ...atom, atomId, start, end: start + token.length } as MobileComposerAtom;
  const atoms = [...result.draft.atoms, occurrence]
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const next = normalizeMobileComposerDraft({
    text: result.draft.text,
    mentions: result.draft.mentions,
    atoms,
    slashCommands: result.draft.slashCommands,
    attachments: result.draft.attachments
  });
  const caret = range.start + prefix.length + token.length + suffix.length;
  return { draft: next, selection: { start: caret, end: caret } };
}

function replaceMobileComposerAtom(
  draft: MobileComposerDraft,
  previous: MobileComposerAtom,
  replacement: MobileComposerAtomSeed
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
  if (atom.sourceRole !== "assistant" && atom.sourceRole !== "user") throw new Error("The message quote source role is invalid.");
  const text = normalizedSelectionQuoteText(atom.text);
  if (text === undefined || text !== atom.text || text.length > mobileSelectionQuoteMaximumCharacters) {
    throw new Error("The local Joko message quote is invalid.");
  }
  return {
    kind: "quote",
    sourceSessionId: normalizeExactIdentity(atom.sourceSessionId, "quote source task", 1_024),
    sourceMessageId: normalizeExactIdentity(atom.sourceMessageId, "quote source message", 1_024),
    sourceEventId: normalizeExactIdentity(atom.sourceEventId, "quote source Event", 1_024),
    sourceRole: atom.sourceRole,
    text
  };
}

function normalizeFileQuoteAtom(atom: MobileComposerFileQuoteAtom): Omit<MobileComposerFileQuoteAtom, "atomId" | "start" | "end"> {
  const text = normalizedSelectionQuoteText(atom.text);
  const sourcePath = normalizeFileQuoteSourcePath(atom.sourcePath);
  if (text === undefined || text !== atom.text || text.length > mobileSelectionQuoteMaximumCharacters
    || /[\uD800-\uDFFF]/u.test(text)
    || Object.hasOwn(atom, "sourceMessageId") || Object.hasOwn(atom, "sourceEventId") || Object.hasOwn(atom, "sourceRole")) {
    throw new Error("The local Joko file quote is invalid.");
  }
  return { kind: "file-quote", text, sourcePath, sourceSessionId: normalizeExactIdentity(atom.sourceSessionId, "quote source task", 1_024) };
}

function normalizeFileQuoteSourcePath(value: string): string {
  const path = canonicalWorkspacePath(value);
  if (path !== value || path.length > 4_096 || /^[a-z]:/iu.test(path)) throw new Error("The local Joko file quote source is invalid.");
  return path;
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

function normalizeRouteReferenceAtom(
  atom: MobileComposerRouteReferenceAtom
): MobileComposerRouteReferenceAtomSeed {
  if (atom.routeKind === "path") {
    const workspaceId = normalizeExactIdentity(atom.workspaceId, "Workspace path owner", 1_024);
    const relativePath = canonicalWorkspacePath(atom.relativePath);
    if (relativePath !== atom.relativePath || typeof atom.directory !== "boolean"
      || atom.serialized !== `@${relativePath}` || atom.displayText !== relativePath) {
      throw new Error("The local Joko Workspace path is invalid.");
    }
    return {
      kind: "route-reference",
      routeKind: "path",
      workspaceId,
      relativePath,
      directory: atom.directory,
      serialized: atom.serialized,
      displayText: atom.displayText
    };
  }
  const parsed = parseMobileComposerRouteHref(atom.href);
  if (parsed === undefined || parsed.href !== atom.href || parsed.routeKind !== atom.routeKind
    || (parsed.routeKind === "session" && atom.routeKind === "session"
      ? parsed.sessionId !== atom.sessionId || parsed.messageId !== atom.messageId
        || parsed.eventId !== atom.eventId
      : parsed.routeKind === "project" && atom.routeKind === "project"
        ? parsed.projectId !== atom.projectId
        : true)) {
    throw new Error("The local Joko link target is invalid.");
  }
  const displayText = sanitizeMobileComposerReferenceLabel(atom.displayText);
  if (displayText === "" || displayText !== atom.displayText) {
    throw new Error("The local Joko link label is invalid.");
  }
  const anchored = parsed.routeKind === "session"
    && (parsed.messageId !== undefined || parsed.eventId !== undefined);
  const expectedSerialized = anchored ? parsed.href : `[${displayText}](${parsed.href})`;
  if (atom.serialized !== parsed.href && atom.serialized !== expectedSerialized) {
    throw new Error("The local Joko link wire text is invalid.");
  }
  if (anchored && atom.serialized !== parsed.href) {
    throw new Error("A Joko message link must retain its exact deep-link wire text.");
  }
  return parsed.routeKind === "session"
    ? {
        kind: "route-reference",
        routeKind: "session",
        href: parsed.href,
        serialized: atom.serialized,
        sessionId: parsed.sessionId,
        ...(parsed.messageId === undefined ? {} : { messageId: parsed.messageId }),
        ...(parsed.eventId === undefined ? {} : { eventId: parsed.eventId }),
        displayText
      }
    : {
        kind: "route-reference",
        routeKind: "project",
        href: parsed.href,
        serialized: atom.serialized,
        projectId: parsed.projectId,
        displayText
      };
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
    if (isMobileComposerQuoteAtom(atom)) {
      text += mobileSelectionQuoteText(atom.text, atom.kind === "file-quote" ? atom.sourcePath : undefined);
    } else if (atom.kind === "pasted-text") {
      const start = text.length;
      text += atom.text;
      pastedTextRanges.push({ start, end: text.length, display: mobileComposerAtomLabel(atom) });
    } else {
      text += atom.serialized;
    }
    cursor = atom.end;
  }
  text += draft.text.slice(cursor);
  if (text.length > maximumSerializedCharacters) {
    throw new Error(`A task message can contain at most ${maximumSerializedCharacters.toLocaleString("en-US")} serialized characters.`);
  }
  return { text, pastedTextRanges };
}

function mobileSelectionQuoteText(text: string, sourcePath?: string): string {
  return [
    mobileSelectionQuoteMarkerLine,
    ...text.split("\n").map((line) => line === "" ? ">" : `> ${line}`),
    ...(sourcePath ? [`> — source: ${sourcePath}`] : [])
  ].join("\n");
}

function projectComposerOffset(offset: number, atoms: readonly MobileComposerAtom[]): number {
  let projected = offset;
  for (const atom of atoms) {
    if (offset <= atom.start) break;
    if (offset < atom.end) throw new Error("A Joko reference offset cannot be inside a composer atom.");
    const serializedLength = isMobileComposerQuoteAtom(atom)
      ? mobileSelectionQuoteText(atom.text, atom.kind === "file-quote" ? atom.sourcePath : undefined).length
      : atom.kind === "pasted-text" ? atom.text.length : atom.serialized.length;
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

function remapSlashCommandMarks(
  marks: readonly MobileComposerSlashCommandMark[],
  range: MobileComposerSelection,
  replacementLength: number
): readonly MobileComposerSlashCommandMark[] {
  const delta = replacementLength - (range.end - range.start);
  return marks.flatMap((mark) => {
    if (mark.end <= range.start) return [{ ...mark }];
    if (mark.start >= range.end) {
      return [{ ...mark, start: mark.start + delta, end: mark.end + delta }];
    }
    return [];
  });
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

function sameComposerAtomAuthority(left: MobileComposerAtom, right: MobileComposerAtom): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "pasted-text") return right.kind === "pasted-text" && left.text === right.text;
  if (left.kind === "file-quote") return right.kind === "file-quote" && left.text === right.text
    && left.sourceSessionId === right.sourceSessionId && left.sourcePath === right.sourcePath;
  if (left.kind === "quote") {
    return right.kind === "quote" && left.text === right.text
      && left.sourceSessionId === right.sourceSessionId
      && left.sourceMessageId === right.sourceMessageId
      && left.sourceEventId === right.sourceEventId
      && left.sourceRole === right.sourceRole;
  }
  if (right.kind !== "route-reference" || left.routeKind !== right.routeKind
    || left.serialized !== right.serialized
    || left.displayText !== right.displayText) return false;
  return left.routeKind === "session" && right.routeKind === "session"
    ? left.href === right.href && left.sessionId === right.sessionId && left.messageId === right.messageId
      && left.eventId === right.eventId
    : left.routeKind === "project" && right.routeKind === "project"
      ? left.href === right.href && left.projectId === right.projectId
      : left.routeKind === "path" && right.routeKind === "path"
        && left.workspaceId === right.workspaceId && left.relativePath === right.relativePath
        && left.directory === right.directory;
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
  maximumComposerAtoms: mobileComposerMaximumAtoms,
  maximumSelectionQuotes,
  maximumSerializedCharacters,
  maximumSessionMentions,
  maximumLineNumber
};
