import {
  mobileComposerAtomLabel,
  normalizeMobileComposerDraft,
  type MobileComposerAtom,
  type MobileComposerDraft,
  type MobileComposerEditResult,
  type MobileComposerMention,
  type MobileComposerSelection
} from "./mobile-composer-document";

export type MobileComposerRichOccurrenceKind = MobileComposerMention["kind"] | MobileComposerAtom["kind"];

export interface MobileComposerRichTextSegment {
  readonly type: "text";
  readonly text: string;
}

export interface MobileComposerRichOccurrenceSegment {
  readonly type: "occurrence";
  readonly occurrenceKey: string;
}

export type MobileComposerRichEditSegment = MobileComposerRichTextSegment | MobileComposerRichOccurrenceSegment;

export interface MobileComposerRichOccurrenceNode extends MobileComposerRichOccurrenceSegment {
  readonly kind: MobileComposerRichOccurrenceKind;
  readonly token: string;
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly block: boolean;
}

export type MobileComposerRichRenderNode = MobileComposerRichTextSegment | MobileComposerRichOccurrenceNode;

export interface MobileComposerRichDocument {
  readonly version: 1;
  readonly nodes: readonly MobileComposerRichRenderNode[];
}

interface OwnedOccurrence {
  readonly occurrenceKey: string;
  readonly start: number;
  readonly end: number;
  readonly mention?: MobileComposerMention;
  readonly atom?: MobileComposerAtom;
}

const maximumRichTextCharacters = 1_000_000;
const maximumOccurrenceKeyCharacters = 2_100;

export function mobileComposerMentionOccurrenceKey(mentionId: string): string {
  return `mention:${mentionId}`;
}

export function mobileComposerAtomOccurrenceKey(atomId: string): string {
  return `atom:${atomId}`;
}

export function mobileComposerRichDocument(draft: MobileComposerDraft): MobileComposerRichDocument {
  const exact = normalizeMobileComposerDraft(draft);
  const occurrences = orderedOccurrences(exact);
  const nodes: MobileComposerRichRenderNode[] = [];
  let offset = 0;
  for (const occurrence of occurrences) {
    pushText(nodes, exact.text.slice(offset, occurrence.start));
    const token = exact.text.slice(occurrence.start, occurrence.end);
    if (occurrence.mention) {
      const mention = occurrence.mention;
      nodes.push({
        type: "occurrence",
        occurrenceKey: occurrence.occurrenceKey,
        kind: mention.kind,
        token,
        label: token,
        accessibilityLabel: `${mentionLabel(mention)} reference ${mention.displayText}`,
        block: false
      });
    } else if (occurrence.atom) {
      const atom = occurrence.atom;
      const label = mobileComposerAtomLabel(atom);
      nodes.push({
        type: "occurrence",
        occurrenceKey: occurrence.occurrenceKey,
        kind: atom.kind,
        token,
        label,
        accessibilityLabel: atom.kind === "quote"
          ? "Quote from Assistant"
          : atom.kind === "route-reference"
            ? `${atom.routeKind === "project" ? "Project" : "Task"} link ${label}`
            : label,
        block: atom.kind === "quote"
      });
    }
    offset = occurrence.end;
  }
  pushText(nodes, exact.text.slice(offset));
  return { version: 1, nodes };
}

export function reconcileMobileComposerRichDocument(
  draft: MobileComposerDraft,
  segments: readonly MobileComposerRichEditSegment[],
  selection: MobileComposerSelection
): MobileComposerEditResult {
  const exact = normalizeMobileComposerDraft(draft);
  if (!Array.isArray(segments)) throw new Error("The Joko rich composer document is invalid.");
  const occurrences = orderedOccurrences(exact);
  if (segments.length > occurrences.length * 2 + 1) {
    throw new Error("The Joko rich composer document has too many segments.");
  }
  const byKey = new Map(occurrences.map((occurrence, index) => [occurrence.occurrenceKey, {
    occurrence,
    index
  }] as const));
  const seen = new Set<string>();
  const text: string[] = [];
  const mentions: MobileComposerMention[] = [];
  const atoms: MobileComposerAtom[] = [];
  let length = 0;
  let lastOccurrenceIndex = -1;
  let previousWasText = false;

  for (const segment of segments) {
    if (!segment || typeof segment !== "object") {
      throw new Error("The Joko rich composer document contains an invalid segment.");
    }
    if (segment.type === "text") {
      if (typeof segment.text !== "string" || segment.text.length === 0 || previousWasText) {
        throw new Error("The Joko rich composer text segment is invalid.");
      }
      length = boundedLength(length, segment.text.length);
      text.push(segment.text);
      previousWasText = true;
      continue;
    }
    if (segment.type !== "occurrence" || typeof segment.occurrenceKey !== "string"
      || segment.occurrenceKey.length === 0 || segment.occurrenceKey.length > maximumOccurrenceKeyCharacters) {
      throw new Error("The Joko rich composer occurrence is invalid.");
    }
    const owned = byKey.get(segment.occurrenceKey);
    if (!owned || seen.has(segment.occurrenceKey) || owned.index <= lastOccurrenceIndex) {
      throw new Error("The Joko rich composer occurrence order is invalid.");
    }
    seen.add(segment.occurrenceKey);
    lastOccurrenceIndex = owned.index;
    const token = exact.text.slice(owned.occurrence.start, owned.occurrence.end);
    const start = length;
    length = boundedLength(length, token.length);
    text.push(token);
    if (owned.occurrence.mention) {
      mentions.push(cloneMentionAt(owned.occurrence.mention, start, length));
    } else if (owned.occurrence.atom) {
      atoms.push({ ...owned.occurrence.atom, start, end: length });
    }
    previousWasText = false;
  }

  const next = normalizeMobileComposerDraft({
    text: text.join(""),
    mentions,
    atoms,
    attachments: exact.attachments
  });
  const normalizedSelection = validateMobileComposerRichSelection(next, selection);
  return { draft: next, selection: normalizedSelection };
}

export function validateMobileComposerRichSelection(
  draft: MobileComposerDraft,
  selection: MobileComposerSelection
): MobileComposerSelection {
  const exact = normalizeMobileComposerDraft(draft);
  return normalizeRichSelection(exact, selection);
}

export function mobileComposerRichDocumentsEqual(
  left: MobileComposerRichDocument,
  right: MobileComposerRichDocument
): boolean {
  if (left.version !== 1 || right.version !== 1 || left.nodes.length !== right.nodes.length) return false;
  return left.nodes.every((node, index) => {
    const candidate = right.nodes[index];
    if (!candidate || node.type !== candidate.type) return false;
    if (node.type === "text" && candidate.type === "text") return node.text === candidate.text;
    return node.type === "occurrence" && candidate.type === "occurrence"
      && node.occurrenceKey === candidate.occurrenceKey && node.kind === candidate.kind
      && node.token === candidate.token && node.label === candidate.label
      && node.accessibilityLabel === candidate.accessibilityLabel && node.block === candidate.block;
  });
}

function orderedOccurrences(draft: MobileComposerDraft): OwnedOccurrence[] {
  const occurrences: OwnedOccurrence[] = [
    ...draft.mentions.map((mention) => ({
      occurrenceKey: mobileComposerMentionOccurrenceKey(mention.mentionId),
      start: mention.start,
      end: mention.end,
      mention
    })),
    ...draft.atoms.map((atom) => ({
      occurrenceKey: mobileComposerAtomOccurrenceKey(atom.atomId),
      start: atom.start,
      end: atom.end,
      atom
    }))
  ].sort((left, right) => left.start - right.start || left.end - right.end);
  const keys = new Set<string>();
  for (const occurrence of occurrences) {
    if (keys.has(occurrence.occurrenceKey)) {
      throw new Error("The Joko rich composer occurrence identity is duplicated.");
    }
    keys.add(occurrence.occurrenceKey);
  }
  return occurrences;
}

function pushText(nodes: MobileComposerRichRenderNode[], text: string): void {
  if (!text) return;
  const previous = nodes.at(-1);
  if (previous?.type === "text") nodes[nodes.length - 1] = { type: "text", text: previous.text + text };
  else nodes.push({ type: "text", text });
}

function boundedLength(current: number, addition: number): number {
  const next = current + addition;
  if (!Number.isSafeInteger(next) || next > maximumRichTextCharacters) {
    throw new Error("The Joko rich composer document is too large.");
  }
  return next;
}

function cloneMentionAt(mention: MobileComposerMention, start: number, end: number): MobileComposerMention {
  return mention.kind === "workspace" && mention.lineRange !== undefined
    ? { ...mention, lineRange: { ...mention.lineRange }, start, end }
    : { ...mention, start, end };
}

function normalizeRichSelection(
  draft: MobileComposerDraft,
  selection: MobileComposerSelection
): MobileComposerSelection {
  if (!selection || !Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end)
    || selection.start < 0 || selection.end < selection.start || selection.end > draft.text.length
    || !isUtf16Boundary(draft.text, selection.start) || !isUtf16Boundary(draft.text, selection.end)) {
    throw new Error("The Joko rich composer selection is invalid.");
  }
  for (const occurrence of [...draft.mentions, ...draft.atoms]) {
    const startsInside = occurrence.start < selection.start && selection.start < occurrence.end;
    const endsInside = occurrence.start < selection.end && selection.end < occurrence.end;
    if (startsInside || endsInside) {
      throw new Error("The Joko rich composer selection splits a structured occurrence.");
    }
  }
  return { start: selection.start, end: selection.end };
}

function isUtf16Boundary(value: string, offset: number): boolean {
  if (offset <= 0 || offset >= value.length) return true;
  const previous = value.charCodeAt(offset - 1);
  const next = value.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}

function mentionLabel(mention: MobileComposerMention): string {
  if (mention.kind === "session") return "Task";
  if (mention.kind === "workspace") return mention.directory ? "Workspace directory" : "Workspace file";
  if (mention.kind === "resource") return "Resource";
  return "Artifact";
}
