import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import { PartnerImportEditor, PartnerImportReceipts, type ImportReceiptStorage } from "./partner-import-editor.js";
import { PartnerImportCategory, PartnerImportStatus, PartnerImportPreviewPageSchema, PartnerImportResultSchema, type PartnerImportResult } from "./gen/joko/v1/partner_import_pb.js";
import type { PartnerImportApi } from "./partner-import.js";

function storage(): ImportReceiptStorage & { rows: Map<string, string> } {
  const rows = new Map<string, string>(); return { rows, getItem: async key => rows.get(key) ?? null,
    setItem: async (key, value) => { rows.set(key, value); }, removeItem: async key => { rows.delete(key); } };
}
function fixture() {
  const preview = create(PartnerImportPreviewPageSchema, { id: "preview", source: { id: "source", name: "Native analyst" }, name: "Local analyst", total: 2,
    entries: [{ id: "memory", index: 0, name: "Memory", category: PartnerImportCategory.MEMORY, selected: true },
      { id: "skill", index: 1, name: "Skill", category: PartnerImportCategory.SKILLS, selected: true }] });
  let receipt: PartnerImportResult | undefined;
  const api: PartnerImportApi = { ownerKey: "owner", newRequestId: vi.fn(() => "import_request_000001"), sources: vi.fn(async () => []), preview: vi.fn(async () => preview),
    status: vi.fn(async () => receipt), start: vi.fn(async selection => {
      receipt = create(PartnerImportResultSchema, { requestId: selection.requestId, partnerId: "partner", canonicalSessionId: "task", status: PartnerImportStatus.NEEDS_ATTENTION,
        saved: true, savedEntryIds: ["memory"], checks: [{ entryId: "memory", status: 1 }, { entryId: "skill", status: 3, message: "IMPORT_ITEM_FAILED" }] });
      throw new Error("Lost acceptance response");
    }), retry: vi.fn(async requestId => receipt = create(PartnerImportResultSchema, { requestId, partnerId: "partner", canonicalSessionId: "task",
      status: PartnerImportStatus.COMPLETE, saved: true, savedEntryIds: ["memory", "skill"] })) };
  return { preview, api };
}
describe("import controller recovery", () => {
  it("keeps only the original opaque receipt after a lost response and resumes missing work explicitly without resending creation", async () => {
    const f = fixture(); const driver = storage(); const receipts = new PartnerImportReceipts(driver, "node"); const editor = new PartnerImportEditor(f.api, receipts);
    await editor.load(); await editor.choose("source"); await editor.start();
    expect(editor.state.pendingId).toBe("import_request_000001"); expect(editor.state.error).toBe("IMPORT_FAILED");
    expect([...driver.rows.values()]).toEqual([JSON.stringify({ version: 1, requestId: "import_request_000001" })]); editor.dispose();
    const recovered = new PartnerImportEditor(f.api, new PartnerImportReceipts(driver, "node")); await recovered.load();
    expect(recovered.state.result?.savedEntryIds).toEqual(["memory"]); expect(recovered.locked).toBe(true); expect(recovered.state.preview).toBeUndefined();
    expect(f.api.start).toHaveBeenCalledOnce(); expect(f.api.preview).toHaveBeenCalledOnce(); expect(f.api.retry).not.toHaveBeenCalled();
    await recovered.retry(); expect(f.api.retry).toHaveBeenCalledExactlyOnceWith("import_request_000001", false, expect.any(AbortSignal));
    expect(recovered.state.result?.status).toBe(PartnerImportStatus.COMPLETE); await recovered.release(); expect(driver.rows.size).toBe(0);
    expect(f.api.newRequestId).toHaveBeenCalledOnce(); recovered.dispose();
  });
  it("serializes competing receipt claims and retires a late preview when its controller closes", async () => {
    const driver = storage(); const a = new PartnerImportReceipts(driver, "same-node"); const b = new PartnerImportReceipts(driver, "same-node");
    const outcomes = await Promise.allSettled([a.claim("import_request_000001"), b.claim("import_request_000002")]);
    expect(outcomes.map(value => value.status)).toEqual(["fulfilled", "rejected"]); expect(await a.read()).toBe("import_request_000001");
    await b.release("import_request_000002"); expect(await a.read()).toBe("import_request_000001");
    const f = fixture(); let finish!: (value: typeof f.preview) => void;
    f.api.preview = vi.fn(() => new Promise<typeof f.preview>(resolve => { finish = resolve; }));
    const editor = new PartnerImportEditor(f.api, new PartnerImportReceipts(storage(), "other-node")); await editor.load(); const loading = editor.choose("source");
    editor.dispose(); finish(f.preview); await loading; expect(editor.state.preview).toBeUndefined(); expect(editor.active).toBe(false);
  });
});
