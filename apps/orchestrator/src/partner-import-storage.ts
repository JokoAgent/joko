import { AgentImportError, createImportedEnvironmentStore, fingerprint, validateNativePartnerPackage, type ImportReceipt } from "@joko/agent-import";
import type { OperationalStore } from "@joko/store";
import type { CredentialVault } from "./credential-vault.js";

const SCOPE_TYPE = "service"; const SCOPE_ID = "orchestrator";
const RECEIPT_PREFIX = "partner-import.receipt.";
const ENVIRONMENT_PREFIX = "partner-import.private.";
interface StoredImportCipher {
  readonly algorithm: "aes-256-gcm"; readonly nonceHex: string; readonly ciphertextHex: string; readonly tagHex: string;
}
function cipherBytes(value: unknown, size?: number): Buffer {
  if (typeof value !== "string" || value.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(value) || size !== undefined && value.length !== size * 2) throw new AgentImportError("CREDENTIAL_STORAGE_INVALID");
  return Buffer.from(value, "hex");
}

/** SQLite commits safe progress before effects; private archives use the existing vault and master key. */
export class PartnerImportStorage {
  readonly environment;
  constructor(private readonly store: OperationalStore, private readonly vault: CredentialVault) {
    this.environment = createImportedEnvironmentStore({
      read: async (key, assertOwner) => {
        assertOwner(); const stored = store.findSetting<{ version: 1; sealed: StoredImportCipher }>(SCOPE_TYPE, SCOPE_ID, ENVIRONMENT_PREFIX + fingerprint(key));
        if (!stored) return null;
        const value = stored.value;
        if (!value || value.version !== 1 || !value.sealed || Object.keys(value).some(field => !["version", "sealed"].includes(field))) throw new AgentImportError("CREDENTIAL_STORAGE_INVALID");
        let decoded: string; try {
          const sealed = value.sealed;
          if (sealed.algorithm !== "aes-256-gcm" || !fields(sealed as unknown as Record<string, unknown>, ["algorithm", "nonceHex", "ciphertextHex", "tagHex"])) throw new AgentImportError("CREDENTIAL_STORAGE_INVALID");
          decoded = vault.open({ algorithm: sealed.algorithm, nonce: cipherBytes(sealed.nonceHex, 12).toString("base64"),
            ciphertext: cipherBytes(sealed.ciphertextHex).toString("base64"), tag: cipherBytes(sealed.tagHex, 16).toString("base64") }, key);
        } catch { throw new AgentImportError("CREDENTIAL_STORAGE_INVALID"); }
        assertOwner(); return decoded;
      },
      write: async (key, value, assertOwner) => {
        assertOwner(); const cipher = vault.seal(value, key); assertOwner();
        // The Store redacts strings. Base64 ciphertext can randomly resemble a
        // credential, so persist authenticated bytes in an unambiguous alphabet.
        const sealed: StoredImportCipher = { algorithm: cipher.algorithm, nonceHex: Buffer.from(cipher.nonce, "base64").toString("hex"),
          ciphertextHex: Buffer.from(cipher.ciphertext, "base64").toString("hex"), tagHex: Buffer.from(cipher.tag, "base64").toString("hex") };
        store.setSetting(SCOPE_TYPE, SCOPE_ID, ENVIRONMENT_PREFIX + fingerprint(key), { version: 1, sealed }); assertOwner();
      },
      remove: async (key, assertOwner) => { assertOwner(); store.deleteSetting(SCOPE_TYPE, SCOPE_ID, ENVIRONMENT_PREFIX + fingerprint(key)); assertOwner(); },
    });
  }

  readReceipt(requestId: string): ImportReceipt | undefined {
    const value = this.store.findSetting<unknown>(SCOPE_TYPE, SCOPE_ID, receiptKey(requestId))?.value;
    if (value === undefined) return undefined;
    validateImportReceipt(value); if (value.result.requestId !== requestId) throw new AgentImportError("IMPORT_RECEIPT_INVALID"); return value;
  }
  saveReceipt(receipt: ImportReceipt): number {
    validateImportReceipt(receipt);
    this.store.setSetting(SCOPE_TYPE, SCOPE_ID, receiptKey(receipt.result.requestId), receipt);
    return Buffer.byteLength(JSON.stringify(receipt));
  }
  listReceipts(): ImportReceipt[] {
    const result: ImportReceipt[] = [];
    for (const setting of this.store.listSettingsByKeyPrefix(SCOPE_TYPE, SCOPE_ID, RECEIPT_PREFIX)) {
      validateImportReceipt(setting.value); result.push(setting.value);
    }
    return result;
  }
}

function receiptKey(id: string): string {
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(id)) throw new AgentImportError("INVALID_SELECTION"); return RECEIPT_PREFIX + fingerprint(id);
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(child => typeof child === "string"); }

/** No missing-field defaults or older receipt readers; validation never includes source content in errors. */
export function validateImportReceipt(value: unknown): asserts value is ImportReceipt {
  if (record(value) && value.nativePackage !== undefined) validateNativePartnerPackage(value.nativePackage);
  const required = ["version", "selectionHash", "submissionHash", "deferSetup", "result", "entryNames", "copied", "environmentSaved", "checkpointSaved", "checkpointCleared", "partnerCreated", "cancelled", "routines"];
  if (!record(value) || !fields(value, required, ["creationRejected", "nativePackage"]) || value.version !== 1 || typeof value.selectionHash !== "string" || !/^[a-f0-9]{64}$/.test(value.selectionHash)
    || typeof value.submissionHash !== "string" || !/^[a-f0-9]{64}$/.test(value.submissionHash)
    || ["deferSetup", "environmentSaved", "checkpointSaved", "checkpointCleared", "partnerCreated", "cancelled"].some(key => typeof value[key] !== "boolean")
    || value.creationRejected !== undefined && value.creationRejected !== "IMPORT_NAME_EXISTS"
    || !strings(value.copied) || !record(value.entryNames) || Object.values(value.entryNames).some(name => typeof name !== "string")
    || !record(value.result) || !fields(value.result, ["requestId", "partnerId", "status", "checks", "saved", "savedEntryIds"], ["canonicalSessionId"])
    || typeof value.result.requestId !== "string" || !/^[A-Za-z0-9_-]{16,100}$/.test(value.result.requestId)
    || typeof value.result.partnerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.result.partnerId)
    || !["running", "complete", "needs-attention"].includes(String(value.result.status)) || typeof value.result.saved !== "boolean" || !strings(value.result.savedEntryIds)
    || !Array.isArray(value.result.checks) || value.result.checks.some(check => !record(check) || !fields(check, ["entryId", "status"], ["message", "progress"])
      || typeof check.entryId !== "string" || !["copied", "verified", "needs-attention", "taken-over", "paused"].includes(String(check.status))
      || check.message !== undefined && (typeof check.message !== "string" || !/^[A-Z][A-Z_]+$/.test(check.message))
      || check.progress !== undefined && (!record(check.progress) || !fields(check.progress, ["saved", "total"])
        || !Number.isSafeInteger(check.progress.saved) || !Number.isSafeInteger(check.progress.total) || Number(check.progress.saved) < 0 || Number(check.progress.total) < Number(check.progress.saved)))
    || !record(value.routines) || Object.values(value.routines).some(routine => !record(routine) || !fields(routine, ["id", "phase"], ["sourceRestored"])
      || typeof routine.id !== "string" || !["created", "verified", "pausing-source", "source-paused", "complete"].includes(String(routine.phase))
      || routine.sourceRestored !== undefined && typeof routine.sourceRestored !== "boolean")) throw new AgentImportError("IMPORT_RECEIPT_INVALID");
}
