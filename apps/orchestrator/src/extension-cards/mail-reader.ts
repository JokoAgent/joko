import { mailReaderMatches, parseMailMessage, type MailReaderDeclaration, type MailMessage } from "@joko/contracts";

export interface ExtensionMailReader { readonly id: string; readonly reader: MailReaderDeclaration }
export interface ExtensionMailPreview { readonly supported: boolean; readonly message?: MailMessage; readonly extensionId?: string; readonly error?: "MAIL_PROVIDER_AMBIGUOUS" | "MAIL_READ_FAILED" }
export function createExtensionMailReader(deps: {
  readonly plugins: () => readonly ExtensionMailReader[];
  readonly authorize: () => void | Promise<void>;
  readonly captureScope: () => () => void;
  readonly call: (plugin: ExtensionMailReader, url: string, markRead?: true) => Promise<{ readonly ok: boolean; readonly result?: unknown }>;
}) {
  return async (url: string, read: boolean, opened: boolean): Promise<ExtensionMailPreview> => {
    const current = deps.captureScope();
    await deps.authorize(); current();
    const candidates = deps.plugins().filter(plugin => mailReaderMatches(plugin.reader, url));
    if (!candidates.length) return { supported: false };
    if (!read) return { supported: true };
    if (candidates.length !== 1) return { supported: true, error: "MAIL_PROVIDER_AMBIGUOUS" };
    const plugin = candidates[0]!;
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
