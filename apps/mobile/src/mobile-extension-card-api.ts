import type { Client } from "@connectrpc/connect";
import type { ExtensionCardService } from "@joko/contracts";
export type MobileExtensionCardApi = Pick<Client<typeof ExtensionCardService>, "get" | "dispatch" | "authorizeLink" | "previewMail" | "beginAttachment" | "readMedia"> & {
  formScope(sessionId: string): string;
  uploadAttachment(sessionId: string, cardId: string, source: import("./network").MobileBlobUploadSource, inline: boolean, signal: AbortSignal): Promise<string>;
  pickAttachment?(cardId: string, inline: boolean, signal: AbortSignal): Promise<string | undefined>;
  previewMedia?(cardId: string, uri: string): Promise<void>;
  prepareAudio?(cardId: string, uri: string, signal: AbortSignal): Promise<{
    readonly uri: string; readonly mediaType: string; readonly instanceId: string; release(): Promise<void>;
  }>;
};
