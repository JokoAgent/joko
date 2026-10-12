import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { AgentImportError, type AgentImportPreview, type AgentImportResult, type AgentImportSource } from "@joko/agent-import";
import type { PartnerImportManager, PartnerImportController } from "./partner-import-manager.js";

export function createPartnerImportConnectService(manager: PartnerImportManager | undefined,
  authenticate: (context: HandlerContext) => { readonly id: string }): ServiceImpl<typeof contract.PartnerImportService> {
  const owner = () => { if (!manager) throw new ConnectError("Partner import is unavailable.", Code.Unimplemented); return manager; };
  const scope = (context: HandlerContext, controllerId = "saved"): PartnerImportController => {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(controllerId)) throw new ConnectError("Invalid import controller.", Code.InvalidArgument);
    const id = authenticate(context).id;
    const value = { ownerKey: `${id}:${controllerId}`, assertCurrent: () => {
      context.signal.throwIfAborted(); if (authenticate(context).id !== id) throw new ConnectError("Import owner changed.", Code.Canceled);
    } }; value.assertCurrent(); return value;
  };
  const invoke = async <T>(context: HandlerContext, controllerId: string | undefined, action: (scope: PartnerImportController) => T | Promise<T>): Promise<T> => {
    const controller = scope(context, controllerId);
    try { const result = await action(controller); controller.assertCurrent(); return result; }
    catch (error) {
      if (error instanceof ConnectError) throw error;
      const code = error instanceof AgentImportError ? error.code : "IMPORT_FAILED";
      throw new ConnectError(code, code === "INVALID_SELECTION" ? Code.InvalidArgument : code === "REQUEST_ALREADY_USED" ? Code.AlreadyExists : Code.FailedPrecondition);
    }
  };
  const result = (value: AgentImportResult) => toProtoImportResult(value, owner().entryNames(value.requestId));
  return {
    listPartnerImportSources: (request, context) => invoke(context, request.controllerId, async controller =>
      create(contract.ListPartnerImportSourcesResponseSchema, { sources: (await owner().sources(controller)).map(toProtoImportSource) })),
    previewPartnerImport: (request, context) => invoke(context, request.controllerId, async controller =>
      create(contract.PreviewPartnerImportResponseSchema, { preview: toProtoImportPage(await owner().preview(request.sourceId, controller), 0) })),
    readPartnerImportPreview: (request, context) => invoke(context, request.controllerId, controller =>
      create(contract.ReadPartnerImportPreviewResponseSchema, { preview: toProtoImportPage(owner().readPreview(request.previewId, controller), request.offset) })),
    startPartnerImport: (request, context) => invoke(context, request.controllerId, async controller => {
      const value = request.selection; if (!value) throw new AgentImportError("INVALID_SELECTION");
      return create(contract.StartPartnerImportResponseSchema, { result: result(await owner().start({ previewId: value.previewId, requestId: value.requestId,
        name: value.name, ...(value.avatarImageBase64 !== undefined ? { avatarImageBase64: value.avatarImageBase64 } : {}), entryIds: value.entryIds,
        ...(value.entryRanges.length ? { entryRanges: value.entryRanges.map(range => [range.first, range.last] as const) } : {}),
        takeover: value.takeover, deferSetup: value.deferSetup }, controller)) });
    }),
    getPartnerImportStatus: (request, context) => invoke(context, undefined, controller => {
      const value = owner().status(request.requestId, controller);
      return create(contract.GetPartnerImportStatusResponseSchema, { ...(value ? { result: result(value) } : {}) });
    }),
    retryPartnerImport: (request, context) => invoke(context, undefined, async controller =>
      create(contract.RetryPartnerImportResponseSchema, { result: result(await owner().retry(request.requestId, controller, request.resumeSetup)) })),
  };
}

function toProtoImportSource(value: AgentImportSource): contract.PartnerImportSource {
  return create(contract.PartnerImportSourceSchema, { ...value,
    kind: value.kind === "hermes" ? contract.PartnerImportSourceKind.HERMES : contract.PartnerImportSourceKind.OPENCLAW });
}
function toProtoImportPage(value: AgentImportPreview, offset: number): contract.PartnerImportPreviewPage {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.entries.length) throw new AgentImportError("INVALID_SELECTION");
  const categories = { personality: contract.PartnerImportCategory.PERSONALITY, memory: contract.PartnerImportCategory.MEMORY,
    skills: contract.PartnerImportCategory.SKILLS, connections: contract.PartnerImportCategory.CONNECTIONS, automations: contract.PartnerImportCategory.AUTOMATIONS };
  return create(contract.PartnerImportPreviewPageSchema, { id: value.id, source: toProtoImportSource(value.source), name: value.name,
    ...(value.avatarImageBase64 !== undefined ? { avatarImageBase64: value.avatarImageBase64 } : {}), total: value.entries.length,
    entries: value.entries.slice(offset, offset + 20).map((entry, index) => create(contract.PartnerImportEntrySchema, { ...entry, index: index + offset,
      category: categories[entry.category], dependsOn: [...(entry.dependsOn ?? [])], exclusiveWith: [...(entry.exclusiveWith ?? [])], issues: [...(entry.issues ?? [])] })),
    ...(offset + 20 < value.entries.length ? { nextOffset: offset + 20 } : {}) });
}
export function toProtoImportResult(value: AgentImportResult, names: Readonly<Record<string, string>> = {}): contract.PartnerImportResult {
  const checks = { copied: contract.PartnerImportCheckStatus.COPIED, verified: contract.PartnerImportCheckStatus.VERIFIED,
    "needs-attention": contract.PartnerImportCheckStatus.NEEDS_ATTENTION, "taken-over": contract.PartnerImportCheckStatus.TAKEN_OVER, paused: contract.PartnerImportCheckStatus.PAUSED };
  return create(contract.PartnerImportResultSchema, { ...value,
    status: value.status === "complete" ? contract.PartnerImportStatus.COMPLETE : value.status === "running" ? contract.PartnerImportStatus.RUNNING : contract.PartnerImportStatus.NEEDS_ATTENTION,
    checks: value.checks.map(check => create(contract.PartnerImportCheckSchema, { ...check, status: checks[check.status], ...(names[check.entryId] ? { name: names[check.entryId] } : {}) })),
    savedEntryIds: [...value.savedEntryIds] });
}
