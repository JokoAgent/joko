import { basename } from "node:path";

import { JokoError, NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD, redactSecrets, type PublicError, type SessionDescriptor } from "@joko/core";
import { OperationConflictError, OperationInProgressError, OperationPreviouslyFailedError, type OperationalStore } from "@joko/store";
import { DocumentOutputError, DocumentPathError, type publishDocumentOutput } from "@joko/tool-document";

import type { ArtifactRecord, ArtifactStore } from "./artifact-store.js";
import type { BridgeToolCallContext, McpCallResult } from "./mcp-router.js";
import { nativeBindingFingerprint } from "./native-state-observation.js";

const documentMediaTypes = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf"
};

export type DocumentFormat = keyof typeof documentMediaTypes;
type DocumentWriteInput = Parameters<typeof publishDocumentOutput>[0];
type DocumentWriteResult = Awaited<ReturnType<typeof publishDocumentOutput>>;
export type DocumentWriteReceipt = Pick<DocumentWriteResult, "path" | "relativePath" | "bytes"> & {
  readonly deliveryWarning?: string;
};

export class DocumentDeliveryError extends Error {
  constructor(readonly code: "OUTPUT_REQUEST_CONFLICT" | "OUTPUT_OUTCOME_UNKNOWN", message: string) { super(message); }
}

/** Delivers a verified replacement as a versioned Artifact of the originating Run. */
export class DocumentOutputDelivery {
  constructor(
    private readonly store: OperationalStore,
    private readonly artifacts: Pick<ArtifactStore, "ingestBytes">,
    private readonly redactText: (value: string) => string
  ) {}

  async write(
    format: DocumentFormat,
    input: DocumentWriteInput,
    context: BridgeToolCallContext,
    publish: typeof publishDocumentOutput,
    respond: (receipt: DocumentWriteReceipt) => McpCallResult
  ): Promise<McpCallResult> {
    const { inputQueueItem: owner, requestIdentity, requestBodyHash, normalizeResultForStorage } = context;
    if (owner === undefined || requestIdentity === undefined || requestBodyHash === undefined ||
        normalizeResultForStorage === undefined) {
      return respond(documentReceipt(await publish(input)));
    }

    const assertCurrent = () => {
      input.signal?.throwIfAborted();
      input.assertCurrent?.();
      const session = this.store.getSession(context.sessionId).descriptor;
      const queue = this.store.getQueueItem(owner.id);
      const run = this.store.getRun(owner.runId).descriptor;
      if (!this.canDeliver(session) || session.binding.generation !== context.generation || session.targetId !== context.targetId ||
          queue.sessionId !== session.id || queue.runId !== run.id || queue.attemptId !== owner.attemptId ||
          (queue.state !== "dispatching" && queue.state !== "backend_accepted") ||
          run.sessionId !== session.id || !["queued", "running", "waiting", "retrying"].includes(run.state)) {
        throw new Error("The original document Run is no longer active.");
      }
      return session;
    };
    assertCurrent();
    const claim = this.claim(requestIdentity, requestBodyHash, context, owner, assertCurrent);
    if (!claim.claimed) return claim.value;

    let staged: ArtifactRecord | undefined;
    try {
      const result = await publish({ ...input, assertCurrent });
      assertCurrent();
      let receipt = documentReceipt(result);
      if (result.existingTarget) {
        try {
          staged = await this.artifacts.ingestBytes(input.bytes, {
            fileName: redactSecrets(this.redactText(basename(result.path))),
            mimeType: documentMediaTypes[format],
            expiresAt: Date.now() + 10 * 60_000
          });
          if (staged.sha256 !== result.sha256 || staged.byteLength !== result.bytes) {
            throw new Error("The document Artifact does not match the verified output.");
          }
        } catch {
          if (staged !== undefined) this.store.releaseArtifactStaging([staged.id]);
          staged = undefined;
          receipt = { ...receipt, deliveryWarning: "The document was saved, but its Artifact is unavailable." };
        }
      }
      const response = normalizeResultForStorage(respond(receipt));
      const completion = this.store.completeDeferredEffectOperation(claim.operation.id, claim.operation.bodyHash, (store) => {
        const session = assertCurrent();
        if (staged !== undefined) {
          const { blob } = store.adoptSessionArtifact({
            blob: store.getArtifact(staged.id).blob, sessionId: session.id, runId: owner.runId
          });
          store.appendEvent({
            backendId: session.backendId, targetId: session.targetId, sessionId: session.id,
            runId: owner.runId, attemptId: owner.attemptId, generation: context.generation,
            operationId: claim.operation.id, traceId: `artifact:${blob.id}`,
            metadata: { namespace: "joko.document_output", fields: {
              [NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD]: nativeBindingFingerprint(session.binding.opaqueRef)
            } },
            payload: { type: "artifact", artifact: blob, purpose: "file" }
          });
        }
        return response;
      });
      staged = undefined;
      return completion.value;
    } catch (error) {
      // These rejections precede publication. A lost write or readback receipt
      // leaves the original claim in place so a retry cannot replace the file again.
      if (error instanceof DocumentPathError || error instanceof DocumentOutputError && isPreWriteRejection(error.code)) {
        this.store.failEffectOperation(claim.operation.id, claim.operation.bodyHash, new JokoError({
          code: error.code, message: error.message, phase: "effect", retryable: false, stateMayHaveChanged: false,
          recovery: "Change the document request before trying again."
        }));
      }
      throw error;
    } finally {
      if (staged !== undefined) this.store.releaseArtifactStaging([staged.id]);
    }
  }

  private claim(
    requestIdentity: string,
    requestBodyHash: string,
    context: BridgeToolCallContext,
    owner: NonNullable<BridgeToolCallContext["inputQueueItem"]>,
    assertCurrent: () => void
  ) {
    try {
      return this.store.claimDeferredEffectOperation<McpCallResult>({
        id: `document-output:${requestIdentity}`, kind: "document_output",
        body: { sessionId: context.sessionId, targetId: context.targetId, generation: context.generation, owner, requestBodyHash }
      }, assertCurrent);
    } catch (error) {
      if (error instanceof OperationConflictError) {
        throw new DocumentDeliveryError("OUTPUT_REQUEST_CONFLICT", "This document request already owns a different write.");
      }
      if (error instanceof OperationInProgressError) {
        throw new DocumentDeliveryError("OUTPUT_OUTCOME_UNKNOWN", "The original document write is still awaiting its receipt.");
      }
      if (error instanceof OperationPreviouslyFailedError && error.storedError !== null && typeof error.storedError === "object") {
        const { code, message } = error.storedError as Partial<PublicError>;
        if (isPreWriteRejection(code) && typeof message === "string") throw new DocumentOutputError(code, message);
        if (code === "PATH_NOT_ALLOWED" && typeof message === "string") throw new DocumentPathError(message);
        if (code === "EFFECT_OUTCOME_UNKNOWN") {
          throw new DocumentDeliveryError("OUTPUT_OUTCOME_UNKNOWN", "The original document write has no confirmed receipt.");
        }
      }
      throw error;
    }
  }

  private canDeliver(session: SessionDescriptor): boolean {
    return this.store.findSessionRuntimePolicy(session.id)?.policy !== "review_read_only" &&
      !(session.derivationOrigin?.sideChat && session.worktree === undefined);
  }
}

function documentReceipt({ path, relativePath, bytes }: DocumentWriteResult): DocumentWriteReceipt {
  return { path, ...(relativePath === undefined ? {} : { relativePath }), bytes };
}

function isPreWriteRejection(code: unknown): code is "FILE_EXISTS" | "OUTPUT_TOO_LARGE" {
  return code === "FILE_EXISTS" || code === "OUTPUT_TOO_LARGE";
}
