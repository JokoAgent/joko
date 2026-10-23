import { ModelSourceKind, type ModelSourceDescriptor } from "@joko/contracts";
import type { ModelSourceView, ModelView } from "./model.js";

export function projectModelSourceView(source: ModelSourceDescriptor | undefined): ModelSourceView | undefined {
  if (!source) return undefined;
  const kind = source.kind === ModelSourceKind.LOCAL ? "local" : source.kind === ModelSourceKind.DEVICE ? "device"
    : source.kind === ModelSourceKind.SHARE ? "share" : source.kind === ModelSourceKind.GROUP ? "group" : undefined;
  if (!kind || !source.displayName || !Number.isSafeInteger(source.groupMemberCount) || source.groupMemberCount < 0) return undefined;
  return { kind, displayName: source.displayName, nodeId: source.nodeId, nodeName: source.nodeName,
    nativeAdapterKind: source.nativeAdapterKind, groupMemberCount: source.groupMemberCount, grouped: source.grouped };
}

/** Every display row retains its complete route; names and model IDs never
 * establish equivalence between two computers or two grants. */
export function modelSourceLabel(model: Pick<ModelView, "providerName" | "source">): string {
  const source = model.source;
  if (!source) return model.providerName;
  return [source.displayName, source.nodeName, source.nativeAdapterKind,
    source.groupMemberCount > 0 ? `×${source.groupMemberCount}` : undefined].filter(Boolean).join(" · ");
}

export function modelSourceSelectable(model: Pick<ModelView, "source">): boolean {
  return model.source?.grouped !== true;
}
