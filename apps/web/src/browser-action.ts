export interface BrowserActionContext {
  readonly ownerDocument: Document;
  readonly signal: AbortSignal;
}

export interface HttpLinkOpenOptions {
  readonly forceExternal?: boolean;
  readonly forceSidebar?: boolean;
  readonly action?: BrowserActionContext;
}

export class WorkspaceHtmlExternalUnavailableError extends Error {
  constructor() { super("HTML previews require the isolated sidebar Browser."); }
}

/** Check immediately before dispatching an effect in the initiating window. */
export function assertBrowserActionCurrent({ ownerDocument, signal }: BrowserActionContext): void {
  signal.throwIfAborted();
  const ownerWindow = ownerDocument.defaultView;
  if (ownerWindow === null || ownerWindow.closed || ownerWindow.document !== ownerDocument) {
    throw new Error("The initiating window is no longer available.");
  }
}
