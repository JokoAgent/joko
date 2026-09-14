import type { JSONContent } from "@tiptap/core";
import { remapComposerInlineMentionReplacement } from "./composer-mention-ranges.js";
import { composerDocumentPlainText } from "./composer-quote-document.js";
import type {
  ComposerInlineMentionRange,
  ExtensionCatalogEntryView,
  ExtensionCatalogView,
  PendingExtensionUseView
} from "./model.js";
import { replaceComposerDocumentTextRange } from "./components/composer-inline-mention.js";

export interface AppliedExtensionUse {
  readonly document: JSONContent;
  readonly text: string;
  readonly inlineMentionRanges: readonly ComposerInlineMentionRange[];
}

/** Resolves a one-shot handoff only while the exact owner projection and the
 * runtime command that advertised it are still authoritative. */
export function resolvePendingExtensionUse(
  pending: PendingExtensionUseView,
  catalog: ExtensionCatalogView
): ExtensionCatalogEntryView | undefined {
  const extension = catalog.extensions.find((candidate) => candidate.id === pending.extensionId);
  if (extension === undefined
    || extension.revision.toString(10) !== pending.extensionRevision
    || !extension.installed
    || !extension.enabled
    || !extension.useSupported
    || extension.setup.state !== "ready" && extension.setup.state !== "notRequired"
    || !extension.commands.some((command) => command.name === pending.commandName
      && command.sessionId === pending.runtimeSessionId)
    || !sameExtensionOwner(extension.owner, pending.owner)) return undefined;
  return extension;
}

/** Places an Extension command at the runtime's leading slash-command slot.
 * Selecting Use is an explicit primary-action choice, so an existing leading
 * slash command is replaced while the remainder of the rich draft is kept. */
export function applyPendingExtensionUse(
  document: JSONContent,
  inlineMentionRanges: readonly ComposerInlineMentionRange[],
  commandName: string
): AppliedExtensionUse | undefined {
  const text = composerDocumentPlainText(document);
  const desired = `/${commandName}`;
  const leadingCommand = /^\/[^\s/]+/u.exec(text)?.[0];
  if (leadingCommand === desired) return { document, text, inlineMentionRanges };
  const to = leadingCommand?.length ?? 0;
  const replacement = leadingCommand === undefined ? `${desired} ` : desired;
  const nextDocument = replaceComposerDocumentTextRange(document, 0, to, replacement);
  if (nextDocument === undefined) return undefined;
  return {
    document: nextDocument,
    text: composerDocumentPlainText(nextDocument),
    inlineMentionRanges: remapComposerInlineMentionReplacement(inlineMentionRanges, 0, to, replacement.length)
  };
}

function sameExtensionOwner(
  current: ExtensionCatalogEntryView["owner"],
  pending: PendingExtensionUseView["owner"]
): boolean {
  if (current.kind !== pending.kind) return false;
  if (current.kind === "resource" && pending.kind === "resource") {
    return current.resourceId === pending.resourceId
      && current.discoveredRevision === pending.discoveredRevision
      && current.resourceRevision.toString(10) === pending.resourceRevision;
  }
  if (current.kind === "mcp" && pending.kind === "mcp") {
    return current.serverId === pending.serverId
      && current.serverRevision.toString(10) === pending.serverRevision;
  }
  return false;
}
