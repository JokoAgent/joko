import { mailReaderMatches, parseMailMessage, type MailReaderDeclaration, type MailMessage } from "@joko/contracts";

export interface ExtensionMailPreviewRequest {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly url: string;
  readonly read: boolean;
  readonly opened: boolean;
  readonly readerSelectionId?: string;
}
interface ExtensionMailReaderChoice { readonly selectionId: string; readonly displayName: string }
export interface ExtensionMailReader extends ExtensionMailReaderChoice { readonly id: string; readonly reader: MailReaderDeclaration }
export interface ExtensionMailPreview {
  readonly supported: boolean;
  readonly message?: MailMessage;
  readonly extensionId?: string;
  readonly readerChoices?: readonly ExtensionMailReaderChoice[];
  readonly error?: "MAIL_PROVIDER_AMBIGUOUS" | "MAIL_PROVIDER_CHANGED" | "MAIL_READ_FAILED";
}
export function createExtensionMailReader(deps: {
  readonly plugins: () => readonly ExtensionMailReader[];
  readonly authorize: () => void | Promise<void>;
  readonly captureScope: () => () => void;
  readonly call: (plugin: ExtensionMailReader, url: string, markRead?: true) => Promise<{ readonly ok: boolean; readonly result?: unknown }>;
}) {
  return async (url: string, read: boolean, opened: boolean, selectionId?: string): Promise<ExtensionMailPreview> => {
    const current = deps.captureScope();
    await deps.authorize(); current();
    const candidates = deps.plugins().filter(plugin => mailReaderMatches(plugin.reader, url));
    const readerChoices = () => candidates.map(({ selectionId, displayName }) => ({ selectionId, displayName }));
    const selected = selectionId === undefined ? undefined : candidates.find(plugin => plugin.selectionId === selectionId);
    if (selectionId !== undefined && selected === undefined) return { supported: true, error: "MAIL_PROVIDER_CHANGED", readerChoices: readerChoices() };
    if (!candidates.length) return { supported: false };
    if (!read) return { supported: true };
    if (selected === undefined && candidates.length !== 1) return { supported: true, error: "MAIL_PROVIDER_AMBIGUOUS", readerChoices: readerChoices() };
    const plugin = selected ?? candidates[0]!;
    const result = await deps.call(plugin, url, opened && plugin.reader.markRead === true ? true : undefined);
    current(); await deps.authorize(); current();
    const message = result.ok ? parseMailMessage(result.result) : null;
    if (!message) return { supported: true, error: "MAIL_READ_FAILED" };
    if (message.conversation?.messages.some(item => !mailReaderMatches(plugin.reader, item.url))) {
      delete message.conversation; message.conversationUnavailable = true;
    }
    return { supported: true, message, extensionId: plugin.id };
  };
}
