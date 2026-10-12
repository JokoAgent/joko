import type { MessageInitShape } from "@bufbuild/protobuf";
import {
  PartnerImportCategory, PartnerImportCheckStatus, PartnerImportStatus,
  type PartnerImportEntry, type PartnerImportSource, type PartnerImportPreviewPage, type PartnerImportSelection,
  type PartnerImportResult, type ListPartnerImportSourcesResponse, type PreviewPartnerImportResponse,
  type ReadPartnerImportPreviewResponse, type StartPartnerImportResponse, type GetPartnerImportStatusResponse, type RetryPartnerImportResponse,
  type StartPartnerImportRequestSchema,
} from "./gen/joko/v1/partner_import_pb.js";

export interface PartnerImportPreview extends Omit<PartnerImportPreviewPage, "entries" | "nextOffset"> { readonly entries: readonly PartnerImportEntry[]; }
export interface PartnerImportApi {
  readonly ownerKey: string;
  newRequestId(): string;
  sources(signal: AbortSignal): Promise<readonly PartnerImportSource[]>;
  preview(sourceId: string, signal: AbortSignal): Promise<PartnerImportPreview>;
  start(selection: MessageInitShape<typeof StartPartnerImportRequestSchema>["selection"], signal: AbortSignal): Promise<PartnerImportResult>;
  status(requestId: string, signal: AbortSignal): Promise<PartnerImportResult | undefined>;
  retry(requestId: string, resumeSetup: boolean, signal: AbortSignal): Promise<PartnerImportResult>;
}
interface ImportRpc {
  listPartnerImportSources(request: { controllerId: string }, options: { signal: AbortSignal }): Promise<ListPartnerImportSourcesResponse>;
  previewPartnerImport(request: { sourceId: string; controllerId: string }, options: { signal: AbortSignal }): Promise<PreviewPartnerImportResponse>;
  readPartnerImportPreview(request: { previewId: string; offset: number; controllerId: string }, options: { signal: AbortSignal }): Promise<ReadPartnerImportPreviewResponse>;
  startPartnerImport(request: MessageInitShape<typeof StartPartnerImportRequestSchema>, options: { signal: AbortSignal }): Promise<StartPartnerImportResponse>;
  getPartnerImportStatus(request: { requestId: string }, options: { signal: AbortSignal }): Promise<GetPartnerImportStatusResponse>;
  retryPartnerImport(request: { requestId: string; resumeSetup: boolean }, options: { signal: AbortSignal }): Promise<RetryPartnerImportResponse>;
}
/** Every platform shares the same generated RPC boundary and immutable full-preview selection. */
export function createPartnerImportApi(options: { rpc: ImportRpc; ownerKey: string; controllerId: string; assertCurrent(): void; newRequestId(): string }): PartnerImportApi {
  const { rpc, controllerId } = options;
  const invoke = async <T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted(); options.assertCurrent(); const result = await action(); signal.throwIfAborted(); options.assertCurrent(); return result;
  };
  const result = (value: PartnerImportResult | undefined, requestId?: string) => {
    if (!value || !value.requestId || requestId && value.requestId !== requestId || !value.partnerId || value.status === PartnerImportStatus.UNSPECIFIED
      || new Set(value.savedEntryIds).size !== value.savedEntryIds.length || value.checks.some(check => !check.entryId || check.status === PartnerImportCheckStatus.UNSPECIFIED
        || check.progress && check.progress.saved > check.progress.total)) throw new Error("Import receipt owner is invalid."); return value;
  };
  return {
    ownerKey: options.ownerKey, newRequestId: options.newRequestId,
    sources: signal => invoke(signal, async () => {
      const sources = (await rpc.listPartnerImportSources({ controllerId }, { signal })).sources;
      if (sources.some(source => !source.id || source.kind === 0) || new Set(sources.map(source => source.id)).size !== sources.length) throw new Error("Import source catalog is invalid."); return sources;
    }),
    preview: (sourceId, signal) => invoke(signal, async () => {
      const first = (await rpc.previewPartnerImport({ sourceId, controllerId }, { signal })).preview;
      if (!first || first.source?.id !== sourceId || !first.id) throw new Error("Import preview owner is invalid.");
      const entries: PartnerImportEntry[] = []; const ids = new Set<string>(); let page = first; let offset = 0;
      for (;;) {
        options.assertCurrent(); signal.throwIfAborted();
        if (page.id !== first.id || page.source?.id !== sourceId || page.total !== first.total || page.entries.length > 20
          || page.entries.some((entry, index) => !entry.id || ids.has(entry.id) || entry.index !== offset + index || entry.category === PartnerImportCategory.UNSPECIFIED)) throw new Error("Import preview changed during reading.");
        for (const entry of page.entries) { if (ids.has(entry.id)) throw new Error("Import preview repeats an entry."); ids.add(entry.id); entries.push(entry); }
        offset += page.entries.length;
        if (page.nextOffset === undefined) break;
        if (!page.entries.length || page.nextOffset !== offset || offset >= first.total) throw new Error("Import preview pagination is invalid.");
        page = (await rpc.readPartnerImportPreview({ previewId: first.id, offset, controllerId }, { signal })).preview!;
        if (!page) throw new Error("Import preview is unavailable.");
      }
      if (entries.length !== first.total) throw new Error("Import preview is incomplete.");
      const { nextOffset: _next, ...metadata } = first; return { ...metadata, entries };
    }),
    start: (selection, signal) => invoke(signal, async () => result((await rpc.startPartnerImport({ selection, controllerId }, { signal })).result, selection?.requestId)),
    status: (requestId, signal) => invoke(signal, async () => { const value = (await rpc.getPartnerImportStatus({ requestId }, { signal })).result; return value ? result(value, requestId) : undefined; }),
    retry: (requestId, resumeSetup, signal) => invoke(signal, async () => result((await rpc.retryPartnerImport({ requestId, resumeSetup }, { signal })).result, requestId)),
  };
}

export function defaultImportSelection(entries: readonly PartnerImportEntry[]): ReadonlySet<string> {
  return new Set(entries.filter(entry => entry.selected && !entry.exclusiveWith.length).map(entry => entry.id));
}
export function toggleImportEntry(entries: readonly PartnerImportEntry[], current: ReadonlySet<string>, entryId: string, enabled: boolean): ReadonlySet<string> {
  const item = entries.find(entry => entry.id === entryId); if (!item) throw new Error("Import entry is unavailable.");
  const selected = new Set(current);
  if (!enabled) { selected.delete(entryId); return selected; }
  for (const other of entries) if (item.exclusiveWith.includes(other.id) || other.exclusiveWith.includes(item.id)) selected.delete(other.id);
  selected.add(entryId); return selected;
}
export function importSelectionRanges(entries: readonly PartnerImportEntry[], selected: ReadonlySet<string>): Array<{ first: number; last: number }> {
  const indexes = entries.filter(entry => selected.has(entry.id)).map(entry => entry.index).sort((a, b) => a - b);
  if (indexes.length !== selected.size) throw new Error("Import selection changed.");
  const ranges: Array<{ first: number; last: number }> = [];
  for (const index of indexes) { const previous = ranges.at(-1); if (previous && previous.last + 1 === index) previous.last = index; else ranges.push({ first: index, last: index }); } return ranges;
}
export function importSelectionInput(preview: PartnerImportPreview, selected: ReadonlySet<string>, fields: { requestId: string; name: string; takeover: boolean; deferSetup: boolean; avatarImageBase64?: string }): Omit<PartnerImportSelection, "$typeName"> {
  if (!fields.name.trim() || fields.name.length > 200) throw new Error("IMPORT_NAME_REQUIRED");
  return { ...fields, previewId: preview.id, entryIds: [], entryRanges: importSelectionRanges(preview.entries, selected).map(range => ({ $typeName: "joko.v1.PartnerImportEntryRange", ...range })) };
}
