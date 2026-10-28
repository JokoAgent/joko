import type { NewSessionDraft, OperationApi, ProvisionalTaskReceipt } from "./model.js";
import { randomUuid } from "./web-crypto.js";

type PreparationApi = Pick<OperationApi, "createSession" | "readSessionPreparation" | "prewarmSession" | "discardProvisionalSession">;
export function provisionalDraftConfiguration(draft: NewSessionDraft): string {
  return JSON.stringify([draft.targetId, draft.expectedTargetRevision?.toString(), draft.providerId, draft.modelId,
    draft.effort ?? "", draft.fastMode, draft.permissionMode, draft.planMode, draft.initialPlacement ?? "project",
    draft.nativeStart, draft.worktree ?? null]);
}

/** The receipt is saved before native creation. Unknown effects only query that
 * original Operation; a later draft never replaces or deletes its owner. */
export class ProvisionalDraftTask {
  #tail: Promise<void> = Promise.resolve();
  constructor(readonly options: {
    readonly api: PreparationApi;
    readonly read: () => ProvisionalTaskReceipt | undefined;
    readonly save: (receipt: ProvisionalTaskReceipt | undefined) => Promise<void>;
    readonly isCurrent: () => boolean;
  }) {}

  prepare(draft: NewSessionDraft): Promise<void> {
    return this.#serial(async () => {
      this.#assertCurrent();
      let receipt = await this.#reconcile();
      if (receipt?.adoptOperationId) return;
      if (receipt && (receipt.configurationKey !== provisionalDraftConfiguration(draft) || receipt.discardOperationId)) {
        if (!await this.#discard(receipt)) return;
        receipt = undefined;
      }
      if (receipt?.sessionId) {
        await this.options.api.prewarmSession?.(receipt.sessionId, receipt.draftId); this.#assertCurrent(); return;
      }
      if (receipt) return;
      receipt = { draftId: randomUuid(), operationId: randomUuid(), configurationKey: provisionalDraftConfiguration(draft) };
      await this.options.save(receipt); this.#assertCurrent();
      try {
        const result = await this.options.api.createSession({ ...draft, name: "Unsent task", operationId: receipt.operationId, provisionalDraftId: receipt.draftId });
        this.#assertCurrent();
        await this.options.save({ ...receipt, sessionId: result.sessionId });
      } catch (error) {
        if (this.options.isCurrent()) await this.#reconcile().catch(() => undefined);
        throw error;
      }
    });
  }

  /** The first real input consumes the exact prepared task through CreateSession's
   * adoption branch. With no preparation, the normal cold creation is unchanged. */
  take(draft: NewSessionDraft): Promise<Pick<NewSessionDraft, "provisionalDraftId" | "reuseProvisionalSessionId" | "operationId">> {
    return this.#serial(async () => {
      this.#assertCurrent();
      const receipt = await this.#reconcile();
      if (!receipt) return {};
      if (receipt.configurationKey !== provisionalDraftConfiguration(draft) || receipt.discardOperationId) {
        if (!await this.#discard(receipt)) throw new Error("Check the original unused task operation before sending this draft.");
        return {};
      }
      if (!receipt.sessionId) throw new Error("Task preparation is still unresolved. Retry to check the original operation.");
      const adopting = { ...receipt, adoptOperationId: receipt.adoptOperationId ?? randomUuid() };
      await this.options.save(adopting); this.#assertCurrent();
      return { provisionalDraftId: receipt.draftId, reuseProvisionalSessionId: receipt.sessionId, operationId: adopting.adoptOperationId };
    });
  }

  retire(): Promise<boolean> { return this.#serial(async () => { this.#assertCurrent(); const receipt = await this.#reconcile(); return !receipt || this.#discard(receipt); }); }
  accepted(): Promise<void> { return this.#serial(async () => { if (this.options.isCurrent()) await this.options.save(undefined); }); }

  async #reconcile(): Promise<ProvisionalTaskReceipt | undefined> {
    const receipt = this.options.read();
    if (!receipt || receipt.sessionId) return receipt;
    const observation = await this.options.api.readSessionPreparation?.(receipt.operationId);
    this.#assertCurrent();
    if (!observation || observation.state === "pending") return receipt;
    if (observation.state === "failed") {
      if (observation.stateMayHaveChanged !== false) throw new Error(observation.error || "The original native creation outcome is unresolved. Inspect its original operation before preparing another task.");
      await this.options.save(undefined); return undefined;
    }
    if (!observation.sessionId || observation.provisionalDraftId !== receipt.draftId) {
      throw new Error("The original task preparation no longer belongs to this draft.");
    }
    const ready = { ...receipt, sessionId: observation.sessionId }; await this.options.save(ready); return ready;
  }
  async #discard(receipt: ProvisionalTaskReceipt): Promise<boolean> {
    if (!receipt.sessionId) return false;
    if (receipt.adoptOperationId) {
      const observation = await this.options.api.readSessionPreparation?.(receipt.adoptOperationId); this.#assertCurrent();
      if (!observation || observation.state === "pending") return false;
      if (observation.state === "succeeded") { await this.options.save(undefined); return true; }
      if (observation.stateMayHaveChanged !== false) return false;
    }
    const discard = this.options.api.discardProvisionalSession;
    if (!discard) return false;
    const deleting = { ...receipt, discardOperationId: receipt.discardOperationId ?? randomUuid() };
    await this.options.save(deleting); this.#assertCurrent();
    await discard(receipt.sessionId, receipt.draftId, deleting.discardOperationId); this.#assertCurrent();
    await this.options.save(undefined); return true;
  }
  #assertCurrent(): void { if (!this.options.isCurrent()) throw new Error("The draft preparation owner changed."); }
  #serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(action, action); this.#tail = result.then(() => undefined, () => undefined); return result;
  }
}
