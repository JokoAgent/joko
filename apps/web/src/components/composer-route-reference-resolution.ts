import type { EditorView } from "@tiptap/pm/view";
import type { ComposerRouteReferenceAttrs } from "./ComposerRouteReferenceNode.js";
import {
  sanitizeComposerReferenceLabel,
  serializeComposerRouteReference,
  type ComposerPasteSegment
} from "./composer-paste-pipeline.js";

export const COMPOSER_MESSAGE_REFERENCE_LABEL_LIMIT = 240;
export const COMPOSER_MESSAGE_REFERENCE_TEXT_LIMIT = 12_000;

export type ComposerRouteReferenceResolutionTarget =
  | { readonly kind: "session"; readonly href: string; readonly sessionId: string }
  | {
      readonly kind: "message";
      readonly href: string;
      readonly sessionId: string;
      readonly messageId?: string;
      readonly eventId?: string;
    }
  | { readonly kind: "project"; readonly href: string; readonly projectId: string };

export type ComposerRouteReferenceResolver = (
  target: ComposerRouteReferenceResolutionTarget
) => Promise<string | null | undefined>;

export interface PendingComposerRouteReferenceResolution {
  readonly target: ComposerRouteReferenceResolutionTarget;
  readonly expectedDisplay: string;
}

export interface SeededComposerRouteReference {
  readonly attrs: ComposerRouteReferenceAttrs;
  readonly pending?: PendingComposerRouteReferenceResolution;
}

/** Build the immediate chip without waiting for storage or a remote task mirror. */
export function seedComposerRouteReference(
  segment: Extract<ComposerPasteSegment, { readonly kind: "session" | "project" }>
): SeededComposerRouteReference {
  const explicit = segment.label === null ? "" : sanitizeComposerReferenceLabel(segment.label);
  if (segment.kind === "project") {
    const display = explicit || shortComposerReferenceId(segment.projectId);
    return {
      attrs: {
        kind: "project",
        display,
        serialized: explicit === "" ? segment.href : serializeComposerRouteReference(segment),
        reference: segment.projectId,
        href: segment.href
      },
      ...(explicit !== "" ? {} : {
        pending: {
          target: { kind: "project", href: segment.href, projectId: segment.projectId },
          expectedDisplay: display
        }
      })
    };
  }

  const anchorIdentity = segment.messageId ?? segment.eventId;
  if (anchorIdentity !== undefined) {
    const display = shortComposerReferenceId(anchorIdentity);
    return {
      attrs: {
        kind: "session",
        display,
        // A message anchor is stable location metadata. Its resolved body is
        // carried separately and must never replace the deep-link wire text.
        serialized: segment.href,
        reference: segment.sessionId,
        href: segment.href
      },
      pending: {
        target: {
          kind: "message",
          href: segment.href,
          sessionId: segment.sessionId,
          ...(segment.messageId === undefined ? {} : { messageId: segment.messageId }),
          ...(segment.eventId === undefined ? {} : { eventId: segment.eventId })
        },
        expectedDisplay: display
      }
    };
  }

  const display = explicit || shortComposerReferenceId(segment.sessionId);
  return {
    attrs: {
      kind: "session",
      display,
      serialized: explicit === "" ? segment.href : serializeComposerRouteReference(segment),
      reference: segment.sessionId,
      href: segment.href
    },
    ...(explicit !== "" ? {} : {
      pending: {
        target: { kind: "session", href: segment.href, sessionId: segment.sessionId },
        expectedDisplay: display
      }
    })
  };
}

export function shortComposerReferenceId(value: string): string {
  return value.length <= 13 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

export function summarizeComposerMessageReference(value: string): string {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= COMPOSER_MESSAGE_REFERENCE_LABEL_LIMIT) return collapsed;
  return `${collapsed.slice(0, COMPOSER_MESSAGE_REFERENCE_LABEL_LIMIT - 1)}…`;
}

export function boundComposerMessageReference(value: string): { readonly text: string; readonly truncated: boolean } {
  const text = value.trim();
  return text.length <= COMPOSER_MESSAGE_REFERENCE_TEXT_LIMIT
    ? { text, truncated: false }
    : { text: text.slice(0, COMPOSER_MESSAGE_REFERENCE_TEXT_LIMIT), truncated: true };
}

/** Resolve in place without introducing a synthetic undo step or touching an edited chip. */
export function resolveComposerRouteReferences(
  view: EditorView,
  pending: readonly PendingComposerRouteReferenceResolution[],
  resolver: ComposerRouteReferenceResolver | undefined
): void {
  if (resolver === undefined || pending.length === 0) return;
  const unique = new Map<string, PendingComposerRouteReferenceResolution>();
  for (const item of pending) unique.set(`${item.target.kind}\u0000${item.target.href}`, item);
  for (const item of unique.values()) {
    void resolver(item.target).then((value) => {
      if (value === null || value === undefined || view.isDestroyed) return;
      const resolved = resolvedRouteReferencePresentation(item.target, value);
      if (resolved === undefined) return;
      const transaction = view.state.tr;
      let changed = false;
      view.state.doc.descendants((node, position) => {
        if (node.type.name !== "composerRouteReference") return;
        const attrs = node.attrs as ComposerRouteReferenceAttrs;
        if (attrs.href !== item.target.href || attrs.display !== item.expectedDisplay) return;
        if (attrs.serialized !== item.target.href) return;
        transaction.setNodeMarkup(position, undefined, { ...attrs, ...resolved });
        changed = true;
      });
      if (!changed || view.isDestroyed) return;
      transaction.setMeta("addToHistory", false);
      view.dispatch(transaction);
    }).catch(() => {
      // Resolution is enrichment only; the original deep link remains usable.
    });
  }
}

function resolvedRouteReferencePresentation(
  target: ComposerRouteReferenceResolutionTarget,
  value: string
): Partial<ComposerRouteReferenceAttrs> | undefined {
  if (target.kind === "message") {
    const bounded = boundComposerMessageReference(value);
    const display = summarizeComposerMessageReference(bounded.text);
    if (display === "") return undefined;
    return {
      display,
      semanticText: bounded.text,
      ...(bounded.truncated ? { semanticTextTruncated: true } : {})
    };
  }
  const display = sanitizeComposerReferenceLabel(value);
  if (display === "") return undefined;
  return {
    display,
    ...(target.kind === "session" ? { serialized: `[${display}](${target.href})` } : {})
  };
}
