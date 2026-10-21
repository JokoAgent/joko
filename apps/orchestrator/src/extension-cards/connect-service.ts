import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { ConnectionManager } from "../connection-manager.js";
import type { ExtensionCardsManager } from "./manager.js";
import { toProtoBlobRef } from "../proto-mapper.js";

export function createExtensionCardConnectService(manager: ExtensionCardsManager | undefined, connections: ConnectionManager): ServiceImpl<typeof contract.ExtensionCardService> {
  const required = () => { if (!manager) throw new ConnectError("Extension cards are unavailable.", Code.Unavailable); return manager; };
  const validate = (sessionId: string, cardId: string) => {
    if (!sessionId || sessionId.length > 256 || !cardId || cardId.length > 128) throw new ConnectError("Invalid extension card scope.", Code.InvalidArgument);
  };
  const effect = async <T>(work: () => T | Promise<T>): Promise<T> => {
    try { return await work(); } catch (error) {
      if (error instanceof ConnectError) throw error;
      throw new ConnectError("Extension card is unavailable. Check its task and installed plugin, then retry.", Code.FailedPrecondition);
    }
  };
  return {
    get: async (request, context) => {
      const connection = connections.authenticate(context.requestHeader.get("authorization") ?? undefined);
      validate(request.sessionId, request.cardId); context.signal.throwIfAborted();
      return effect(() => {
        connections.fence(connection);
        const result = required().get(request.sessionId, request.cardId), card = result.card;
        return create(contract.ExtensionCardServiceGetResponseSchema, { animatedHtml: result.animatedHtml, working: result.working,
          interactive: result.interactive, mediaUris: result.mediaUris, card: { cardId: card.id, sessionId: card.sessionId, extensionId: card.extensionId,
            extensionName: card.extensionName, toolUseId: card.toolUseId, html: card.html, text: card.text, height: card.height,
            updatedAt: timestampFromMs(card.updatedAt) } });
      });
    },
    dispatch: async (request, context) => {
      const connection = connections.authenticate(context.requestHeader.get("authorization") ?? undefined);
      validate(request.sessionId, request.cardId); context.signal.throwIfAborted();
      let formValues: Record<string, string>;
      try { formValues = contract.extensionCardFormValuesFromEntries(request.formValues); }
      catch { throw new ConnectError("Invalid extension form values.", Code.InvalidArgument); }
      return effect(async () => {
        // Provider work outlives this delivery acknowledgement. Its retained
        // guard follows the authenticated Connection, not a completed HTTP RPC.
        const accepted = await required().dispatch({ ...request, formValues }, () => connections.fence(connection), connection.id);
        connections.fence(connection); context.signal.throwIfAborted();
        return create(contract.ExtensionCardServiceDispatchResponseSchema, { accepted });
      });
    },
    authorizeLink: async (request, context) => {
      const connection = connections.authenticate(context.requestHeader.get("authorization") ?? undefined);
      validate(request.sessionId, request.cardId); context.signal.throwIfAborted();
      return effect(() => {
        connections.fence(connection);
        return create(contract.ExtensionCardServiceAuthorizeLinkResponseSchema, { authorized: required().authorizeLink(request.sessionId, request.cardId, request.url) });
      });
    },
    previewMail: async (request, context) => {
      const connection = connections.authenticate(context.requestHeader.get("authorization") ?? undefined);
      if (!request.sessionId || request.sessionId.length > 256 || !request.url || request.url.length > 2048) throw new ConnectError("Invalid mail preview request.", Code.InvalidArgument);
      context.signal.throwIfAborted();
      return effect(async () => {
        const result = await required().previewMail(request.sessionId, request.url, request.read, request.opened, context.signal, () => connections.fence(connection));
        connections.fence(connection); context.signal.throwIfAborted();
        return create(contract.ExtensionCardServicePreviewMailResponseSchema, { supported: result.supported,
          messageJson: result.message ? JSON.stringify(result.message) : "", error: result.error ?? "", extensionId: result.extensionId ?? "" });
      });
    },
    beginAttachment: async (request, context) => {
      const connection = connections.authenticate(context.requestHeader.get("authorization") ?? undefined);
      validate(request.sessionId, request.cardId); context.signal.throwIfAborted();
      if (request.byteSize > 16n * 1024n * 1024n) throw new ConnectError("Mail attachment exceeds its limit.", Code.InvalidArgument);
      return effect(async () => {
        const transfer = await required().beginAttachment(request.sessionId, request.cardId, connection.id, { name: request.fileName, mimeType: request.mediaType,
          bytes: Number(request.byteSize), sha256: request.sha256Hex, inline: request.inline }, () => { context.signal.throwIfAborted(); connections.fence(connection); });
        return create(contract.ExtensionCardServiceBeginAttachmentResponseSchema, { upload: { uploadId: transfer.uploadId, expectedSha256Hex: request.sha256Hex,
          expectedByteSize: request.byteSize, ticket: { ticketId: transfer.ticketId, direction: contract.TransferDirection.UPLOAD, relativeEndpoint: transfer.relativeEndpoint,
            expiresAt: timestampFromMs(transfer.expiresAt), maximumBytes: request.byteSize, requiredMediaType: request.mediaType } } });
      });
    },
    readMedia: async (request, context) => {
      const connection = connections.authenticate(context.requestHeader.get("authorization") ?? undefined);
      if (!request.sessionId || request.sessionId.length > 256 || request.cardId.length > 128 || request.extensionId.length > 256 || request.uri.length > 256) throw new ConnectError("Invalid extension media request.", Code.InvalidArgument);
      return effect(async () => {
        if (request.metadataOnly) {
          const blob = await required().describeMedia(request, () => { context.signal.throwIfAborted(); connections.fence(connection); });
          return create(contract.ExtensionCardServiceReadMediaResponseSchema, { blob: toProtoBlobRef(blob) });
        }
        const dataUrl = await required().readMedia(request, () => { context.signal.throwIfAborted(); connections.fence(connection); });
        return create(contract.ExtensionCardServiceReadMediaResponseSchema, { dataUrl });
      });
    }
  };
}
