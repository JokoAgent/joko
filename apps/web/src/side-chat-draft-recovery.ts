import type { AppController } from "./controller.js";
import type { PendingSideChatDraft } from "./model.js";
import { normalizePendingSideChatDraft } from "./local-state.js";

type RecoveryApi = Pick<AppController, "openSideChat" | "readSideChatOperation" | "readPendingSideChat" | "savePendingSideChat" | "adoptPendingSideChat">;
export type SideChatDraftOutcome =
  | { readonly state: "pending" }
  | { readonly state: "failed"; readonly error: string; readonly stateMayHaveChanged: boolean }
  | { readonly state: "existing"; readonly sessionId: string }
  | { readonly state: "adopted"; readonly sessionId: string }
  | { readonly state: "stale" };

export async function recoverSideChatDraft(api: RecoveryApi, record: PendingSideChatDraft, options: {
  readonly isCurrent: () => boolean; readonly dispatch?: boolean; readonly appendToExisting?: boolean;
}): Promise<SideChatDraftOutcome> {
  if (!api.readPendingSideChat || !api.savePendingSideChat || !api.readSideChatOperation || !api.adoptPendingSideChat) {
    throw new Error("Durable Side Chat draft recovery is unavailable.");
  }
  const current = (): void => { if (!options.isCurrent()) throw new Error("The original Side Chat draft owner changed."); };
  const original = normalizePendingSideChatDraft(record);
  if (original === undefined) throw new Error("The original Side Chat draft receipt is invalid.");
  const assertReceipt = async (): Promise<void> => {
    current(); const saved = await api.readPendingSideChat!(record.sourceSessionId); current();
    if (JSON.stringify(normalizePendingSideChatDraft(saved)) !== JSON.stringify(original)) throw new Error("The original Side Chat draft receipt changed.");
  };
  await assertReceipt();
  if (options.dispatch) {
    await api.openSideChat(record.sourceSessionId, BigInt(record.sourceGeneration), {
      operationId: record.operationId, beforeDispatch: async id => {
        if (id !== record.operationId) throw new Error("The Side Chat operation identity changed.");
        await assertReceipt();
      }
    }); current();
  }
  const operation = await api.readSideChatOperation(record); current();
  if (operation.state !== "succeeded") return operation;
  await assertReceipt();
  const adopted = await api.adoptPendingSideChat(record, operation.sessionId, options.appendToExisting === true, options.isCurrent); current();
  return adopted === "stale" ? { state: "stale" } : { state: adopted, sessionId: operation.sessionId };
}
