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
  readonly types?: readonly string[] | DOMStringList;
  getData(type: string): string;
}

export interface ComposerInternalDropInsertion {
  readonly source: "workspace" | "session";
  readonly attrs: ComposerRouteReferenceAttrs;
  readonly pending?: PendingComposerRouteReferenceResolution;
}

export type ComposerInternalDropState =
  | { readonly kind: "none" }
  | { readonly kind: "pending" }
  | { readonly kind: "invalid" }
  | { readonly kind: "ready"; readonly insertion: ComposerInternalDropInsertion };

/**
 * Resolve private in-app drag payloads before the ordinary OS File path. A
 * workspace entry is accepted only by a composer for that exact workspace.
 */
export function resolveComposerInternalDrop(
  dataTransfer: ComposerInternalDropDataTransfer,
  workspaceId: string | undefined
): ComposerInternalDropInsertion | undefined {
  const state = classifyComposerInternalDrop(dataTransfer, workspaceId);
  return state.kind === "ready" ? state.insertion : undefined;
}

/**
 * Classify a private drag without treating protected-mode DataTransfer reads as
 * malformed. Browsers expose the MIME type during dragover but may reveal the
 * payload only for drop.
 */
export function classifyComposerInternalDrop(
  dataTransfer: ComposerInternalDropDataTransfer,
  workspaceId: string | undefined
): ComposerInternalDropState {
  const workspaceRaw = readDropData(dataTransfer, WORKSPACE_ENTRY_DRAG_MIME);
  const sessionRaw = readDropData(dataTransfer, SESSION_LINK_DRAG_MIME).trim();
  const claimsWorkspace = workspaceRaw !== "" || hasDropType(dataTransfer, WORKSPACE_ENTRY_DRAG_MIME);
  const claimsSession = sessionRaw !== "" || hasDropType(dataTransfer, SESSION_LINK_DRAG_MIME);
  if (!claimsWorkspace && !claimsSession) return { kind: "none" };

  if (workspaceRaw !== "") {
    const workspace = decodeWorkspaceEntryDragPayload(workspaceRaw);
    if (workspace === undefined || workspaceId === undefined || workspace.workspaceId !== workspaceId) return { kind: "invalid" };
    return {
      kind: "ready",
      insertion: {
        source: "workspace",
        attrs: {
          kind: "path",
          display: workspace.path,
          serialized: `@${workspace.path}`,
          reference: workspace.path
        }
      }
    };
  }

  if (sessionRaw === "") return { kind: "pending" };
  if (sessionRaw.length > MAXIMUM_DROP_LINK_CHARACTERS) return { kind: "invalid" };
  const reference = parseComposerRouteReference(sessionRaw);
  if (reference?.kind !== "session") return { kind: "invalid" };
  const segment: Extract<ComposerPasteSegment, { readonly kind: "session" }> = {
    kind: "session",
    href: sessionRaw,
    label: null,
    sessionId: reference.sessionId,
    ...(reference.messageId === undefined ? {} : { messageId: reference.messageId }),
    ...(reference.eventId === undefined ? {} : { eventId: reference.eventId })
  };
  const seeded = seedComposerRouteReference(segment);
  return {
    kind: "ready",
    insertion: {
      source: "session",
      attrs: seeded.attrs,
      ...(seeded.pending === undefined ? {} : { pending: seeded.pending })
    }
  };
}

export function hasComposerInternalDrop(dataTransfer: ComposerInternalDropDataTransfer): boolean {
  return classifyComposerInternalDrop(dataTransfer, undefined).kind !== "none";
}

function hasDropType(dataTransfer: ComposerInternalDropDataTransfer, type: string): boolean {
  try {
    return dataTransfer.types !== undefined && Array.from(dataTransfer.types).includes(type);
  } catch {
    return false;
  }
}

function readDropData(dataTransfer: ComposerInternalDropDataTransfer, type: string): string {
  try {
    const value = dataTransfer.getData(type);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}
