import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyImportedEnvironment, fingerprint, type ImportReceipt } from "@joko/agent-import";
import { OperationalStore } from "@joko/store";
import { CredentialVault } from "./credential-vault.js";
import { PartnerImportStorage } from "./partner-import-storage.js";

const temporaryBase = resolve(tmpdir()); const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (resolve(root) !== root || dirname(root) !== temporaryBase || !basename(root).startsWith("joko-import-storage-")) throw new Error("Import storage cleanup is outside its allocated directory");
    await rm(root, { recursive: true, force: true });
  }
});
const assertOwner = () => {};
function receipt(): ImportReceipt {
  return { version: 1, selectionHash: fingerprint("intent"), submissionHash: fingerprint("submission"), deferSetup: true, entryNames: { memory: "Notes" }, copied: ["memory"], routines: {},
    environmentSaved: true, checkpointSaved: true, checkpointCleared: false, partnerCreated: true, cancelled: false,
    result: { requestId: "import_request_000001", partnerId: "partner_1", canonicalSessionId: "canonical", status: "needs-attention", checks: [{ entryId: "memory", status: "copied" }], saved: true, savedEntryIds: ["memory"] } };
}

describe("Partner import persistence", () => {
  it("restores progress and full private originals after SQLite and vault restart without plaintext in database, WAL or receipt", async () => {
    const root = await mkdtemp(join(temporaryBase, "joko-import-storage-")); roots.push(root);
    const keyPath = join(root, "vault.key"); const database = join(root, "operational.sqlite");
    let store = new OperationalStore(database);
    const original = "fake-import-original-secret-abcdefghijklmnopqrstuvwxyz";
    const data = emptyImportedEnvironment({ kind: "hermes", agentId: "default", name: "Reports", root, workspace: root, configFile: join(root, "config.yaml") });
    data.env.REPORT_TOKEN = original; data.documents.memory = " Complete original\n" + original; data.memoryFiles.original = Buffer.from([0, 255, 17]).toString("base64");
    data.documents.full = "Full native document.\n".repeat(25_000);
    try {
      const storage = new PartnerImportStorage(store, await CredentialVault.open(keyPath)); await storage.environment.write("partner_1", data, assertOwner);
      expect(await storage.environment.read("partner_1", assertOwner)).toEqual(data);
      storage.saveReceipt(receipt()); expect(JSON.stringify(storage.readReceipt(receipt().result.requestId))).not.toContain(original);
      for (const file of [database, database + "-wal"]) expect((await readFile(file)).includes(Buffer.from(original))).toBe(false);
      const events = store.listEvents(); expect(JSON.stringify(events, (_key, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain(original);
      store.close(); store = new OperationalStore(database);
      const restarted = new PartnerImportStorage(store, await CredentialVault.open(keyPath));
      expect(await restarted.environment.read("partner_1", assertOwner)).toEqual(data);
      expect(restarted.readReceipt(receipt().result.requestId)).toEqual(receipt());
      expect(restarted.listReceipts()).toEqual([receipt()]);
      await restarted.environment.remove("partner_1", assertOwner);
      const reopened = new PartnerImportStorage(store, await CredentialVault.open(keyPath)); expect(await reopened.environment.read("partner_1", assertOwner)).toBeUndefined();
      expect(reopened.readReceipt(receipt().result.requestId)?.result.saved).toBe(true);
    } finally { store.close(); }
  });
  it("fails closed on an incompatible receipt or damaged ciphertext rather than creating fresh progress", async () => {
    const root = await mkdtemp(join(temporaryBase, "joko-import-storage-")); roots.push(root);
    const store = new OperationalStore(join(root, "operational.sqlite"));
    try {
      const storage = new PartnerImportStorage(store, await CredentialVault.open(join(root, "vault.key")));
      const current = receipt(); const older: Record<string, unknown> = { ...current }; delete older.deferSetup;
      store.setSetting("service", "orchestrator", "partner-import.receipt." + fingerprint(current.result.requestId), older);
      expect(() => storage.readReceipt(current.result.requestId)).toThrow("IMPORT_RECEIPT_INVALID");
      const data = emptyImportedEnvironment({ kind: "hermes", agentId: "default", name: "Reports", root, workspace: root, configFile: join(root, "config.yaml") });
      await storage.environment.write("partner_1", data, assertOwner);
      const privateSetting = store.listSettings("service", "orchestrator").find(item => item.key.startsWith("partner-import.private."))!;
      const value = privateSetting.value as { version: 1; sealed: { tagHex: string } };
      store.setSetting("service", "orchestrator", privateSetting.key, { ...value, sealed: { ...value.sealed, tagHex: Buffer.alloc(16).toString("hex") } });
      await expect(storage.environment.read("partner_1", assertOwner)).rejects.toMatchObject({ code: "CREDENTIAL_STORAGE_INVALID" });
    } finally { store.close(); }
  });
});
