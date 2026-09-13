import type { ComposerRouteReferenceAttrs } from "./ComposerRouteReferenceNode.js";
import {
  parseComposerRouteReference,
  type ComposerPasteSegment
} from "./composer-paste-pipeline.js";
import {
  seedComposerRouteReference,
  type PendingComposerRouteReferenceResolution
} from "./composer-route-reference-resolution.js";
import {
  WORKSPACE_ENTRY_DRAG_MIME,
  decodeWorkspaceEntryDragPayload
} from "./workspace-tree-state.js";

export const SESSION_LINK_DRAG_MIME = "application/x-joko-session-link";

const MAXIMUM_DROP_LINK_CHARACTERS = 8_192;

export interface ComposerInternalDropDataTransfer {
  getData(type: string): string;
}

export interface ComposerInternalDropInsertion {
  readonly source: "workspace" | "session";
  readonly attrs: ComposerRouteReferenceAttrs;
  readonly pending?: PendingComposerRouteReferenceResolution;
}

/**
 * Resolve private in-app drag payloads before the ordinary OS File path. A
 * workspace entry is accepted only by a composer for that exact workspace.
 */
export function resolveComposerInternalDrop(
  dataTransfer: ComposerInternalDropDataTransfer,
  workspaceId: string | undefined
): ComposerInternalDropInsertion | undefined {
  const workspace = decodeWorkspaceEntryDragPayload(readDropData(dataTransfer, WORKSPACE_ENTRY_DRAG_MIME));
  if (workspace !== undefined && workspaceId !== undefined && workspace.workspaceId === workspaceId) {
    return {
      source: "workspace",
      attrs: {
        kind: "path",
        display: workspace.path,
        serialized: `@${workspace.path}`,
        reference: workspace.path
      }
    };
  }

  const href = readDropData(dataTransfer, SESSION_LINK_DRAG_MIME).trim();
  if (href === "" || href.length > MAXIMUM_DROP_LINK_CHARACTERS) return undefined;
  const reference = parseComposerRouteReference(href);
  if (reference?.kind !== "session") return undefined;
  const segment: Extract<ComposerPasteSegment, { readonly kind: "session" }> = {
    kind: "session",
    href,
    label: null,
    sessionId: reference.sessionId,
    ...(reference.messageId === undefined ? {} : { messageId: reference.messageId }),
    ...(reference.eventId === undefined ? {} : { eventId: reference.eventId })
  };
  const seeded = seedComposerRouteReference(segment);
  return {
    source: "session",
    attrs: seeded.attrs,
    ...(seeded.pending === undefined ? {} : { pending: seeded.pending })
  };
}

export function hasComposerInternalDrop(dataTransfer: ComposerInternalDropDataTransfer): boolean {
  return readDropData(dataTransfer, WORKSPACE_ENTRY_DRAG_MIME) !== ""
    || readDropData(dataTransfer, SESSION_LINK_DRAG_MIME).trim() !== "";
}

function readDropData(dataTransfer: ComposerInternalDropDataTransfer, type: string): string {
  try {
    const value = dataTransfer.getData(type);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}
