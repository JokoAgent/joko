import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentImportError, type AgentImportSelection, type ImportItem, type ImportSnapshot } from "./types.js";
import { indexImportSnapshot } from "./snapshot.js";
import { transferPartnerImport, type ImportReceipt, type TransferDeps } from "./transfer.js";

const source = { kind: "hermes" as const, agentId: "default", name: "Reports", root: resolve("source"), workspace: resolve("source"), configFile: resolve("source", "config.yaml") };
const items: ImportItem[] = [
  { view: { id: "identity", category: "personality", name: "Identity", selected: true }, text: "Reporter", role: "identity" },
  { view: { id: "memory", category: "memory", name: "Notes", selected: true }, text: "Full notes" },
  { view: { id: "routine", category: "automations", name: "Report", selected: true, enabled: true }, automation: { sourceId: "daily", original: {}, deliveries: [],
    fingerprint: createHash("sha256").update("source-job").digest("hex"), input: { name: "Report", prompt: "Read report", enabled: false, triggers: [{ id: "time", kind: "interval", intervalMs: 60_000 }], silentWhenIdle: false } } },
];
const data: ImportSnapshot = indexImportSnapshot({ source, items, fingerprint: createHash("sha256").update("snapshot").digest("hex") });
const selection: AgentImportSelection = { previewId: "preview", requestId: "import_request_000001", name: "Reports", entryIds: items.map(item => item.view.id), takeover: true, deferSetup: false };
function harness() {
  let saved: ImportReceipt | undefined; const effects: string[] = [];
  const deps: TransferDeps = {
    assertOwner: () => {}, partnerId: () => "partner_1", readReceipt: async () => saved && structuredClone(saved), readSkillConfig: async () => ({}),
    saveReceipt: async receipt => { saved = structuredClone(receipt); effects.push(`save:${saved.routines.routine?.phase ?? "initial"}`); },
    createPartner: vi.fn(async () => { expect(saved?.checkpointSaved).toBe(true); effects.push("partner"); }),
    validateItems: () => {}, saveCheckpoint: vi.fn(async () => { expect(saved).toBeDefined(); effects.push("checkpoint"); }),
    importItem: vi.fn(async (_partnerId, item) => { effects.push(`copy:${item.view.id}`); }), saveEnvironment: vi.fn(async () => { effects.push("environment"); }),
    createConversation: async () => "canonical", createRoutine: vi.fn(async () => { effects.push("routine"); return "routine_1"; }),
    verifyAutomation: vi.fn(async () => { effects.push("verify"); return { verified: true }; }),
    pauseSource: vi.fn(async () => { expect(saved?.routines.routine?.phase).toBe("pausing-source"); effects.push("pause-source"); }),
    resumeSource: vi.fn(async () => { effects.push("resume-source"); }), enableRoutine: vi.fn(async () => { expect(saved?.routines.routine?.phase).toBe("source-paused"); effects.push("enable"); }),
  };
  return { deps, effects, receipt: () => saved! };
}

describe("durable import transfer", () => {
  it("retains healthy copies across an item failure and retries only missing work under the same original intent", async () => {
    const current = harness(); let failMemory = true;
    current.deps.importItem = vi.fn(async (_partnerId, item) => {
      if (item.view.id === "memory" && failMemory) throw Object.assign(new AgentImportError("MEMORY_WRITE_FAILED"), { importProgress: { saved: 1, total: 2 } });
    });
    const deferred = { ...selection, deferSetup: true };
    const first = await transferPartnerImport(data, deferred, current.deps);
    expect(first.status).toBe("needs-attention"); expect(first.savedEntryIds).toEqual(["identity", "routine"]);
    expect(first.checks.find(check => check.entryId === "memory")?.progress).toEqual({ saved: 1, total: 2 });
    expect(current.deps.pauseSource).not.toHaveBeenCalled(); expect(current.deps.verifyAutomation).not.toHaveBeenCalled();
    failMemory = false;
    const final = await transferPartnerImport(data, deferred, current.deps, false, true);
    expect(final.status).toBe("complete"); expect(final.canonicalSessionId).toBe("canonical"); expect(final.savedEntryIds).toEqual(["identity", "memory", "routine"]);
    expect(vi.mocked(current.deps.importItem).mock.calls.map(call => call[1].view.id)).toEqual(["identity", "memory", "memory"]);
    expect(current.deps.saveEnvironment).toHaveBeenCalledTimes(1); expect(current.deps.createRoutine).toHaveBeenCalledTimes(1);
    await expect(transferPartnerImport(data, selection, current.deps)).rejects.toMatchObject({ code: "REQUEST_ALREADY_USED" });
  });
  it("reconciles a persisted ambiguous source pause without another verification or duplicate native takeover", async () => {
    const current = harness(); let attempts = 0;
    current.deps.pauseSource = vi.fn(async (_item, _snapshot, interrupted) => {
      expect(current.receipt().routines.routine?.phase).toBe("pausing-source");
      if (++attempts === 1) throw new AgentImportError("SOURCE_HANDOVER_UNCERTAIN");
      expect(interrupted).toBe(true);
    });
    const pending = await transferPartnerImport(data, selection, current.deps);
    expect(pending.status).toBe("running"); expect(current.receipt().routines.routine?.phase).toBe("pausing-source");
    const final = await transferPartnerImport(data, selection, current.deps, true);
    expect(final.status).toBe("complete"); expect(final.checks.find(check => check.entryId === "routine")?.status).toBe("taken-over");
    expect(current.deps.verifyAutomation).toHaveBeenCalledTimes(1); expect(current.deps.enableRoutine).toHaveBeenCalledTimes(1);
    expect(current.deps.resumeSource).not.toHaveBeenCalled(); expect(current.deps.createRoutine).toHaveBeenCalledTimes(1);
    expect(current.effects.indexOf("checkpoint")).toBeLessThan(current.effects.indexOf("partner"));
  });
  it("restores only the source actually paused by this import when target activation definitively fails", async () => {
    const current = harness(); current.deps.enableRoutine = vi.fn(async () => { throw new AgentImportError("TARGET_ACTIVATION_FAILED"); });
    const failed = await transferPartnerImport(data, selection, current.deps);
    expect(failed.status).toBe("needs-attention"); expect(current.receipt().routines.routine?.phase).toBe("verified");
    expect(current.deps.resumeSource).toHaveBeenCalledTimes(1);
    const disabled = structuredClone(data); disabled.items.find(item => item.automation)!.view.enabled = false;
    const paused = harness();
    const result = await transferPartnerImport(disabled, selection, paused.deps);
    expect(result.status).toBe("complete"); expect(result.checks.find(check => check.entryId === "routine")?.status).toBe("paused");
    expect(paused.deps.pauseSource).not.toHaveBeenCalled(); expect(paused.deps.enableRoutine).not.toHaveBeenCalled(); expect(paused.deps.verifyAutomation).not.toHaveBeenCalled();
  });
});
