import { isDesktopMainDocumentClaim } from "./main-document-occurrence.js";

export interface DesktopNativeGamepadDocumentOwner<TEndpoint> {
  readonly endpoint: TEndpoint;
  readonly claim: string;
  readonly occurrence: string;
}

export interface DesktopNativeGamepadDocumentCapture<TEndpoint> {
  readonly current: DesktopNativeGamepadDocumentOwner<TEndpoint>;
  readonly created: boolean;
}

/**
 * Binds native gamepad interest to one preload occurrence per application
 * window. Electron's WebFrameMain follows a FrameTreeNode across committed
 * navigations, so neither WebContents nor WebFrameMain is a Document identity.
 */
export class DesktopNativeGamepadDocumentAuthority<TEndpoint> {
  readonly #current = new Map<TEndpoint, DesktopNativeGamepadDocumentOwner<TEndpoint>>();

  constructor(
    private readonly createOccurrence: () => string,
    private readonly onRetire: (owner: DesktopNativeGamepadDocumentOwner<TEndpoint>) => void
  ) {}

  capture(endpoint: TEndpoint, claim: string): DesktopNativeGamepadDocumentCapture<TEndpoint> {
    if (!isDesktopMainDocumentClaim(claim)) {
      throw new TypeError("Desktop native gamepad Document claim is invalid.");
    }
    const existing = this.#current.get(endpoint);
    if (existing?.claim === claim) return Object.freeze({ current: existing, created: false });

    const occurrence = this.createOccurrence();
    if (!isDocumentOccurrence(occurrence)) {
      throw new TypeError("Desktop native gamepad occurrence factory returned an invalid identity.");
    }
    const current = Object.freeze({ endpoint, claim, occurrence });
    this.#current.set(endpoint, current);
    if (existing !== undefined) this.onRetire(existing);
    return Object.freeze({ current, created: true });
  }

  requireCurrent(endpoint: TEndpoint, occurrence: unknown): DesktopNativeGamepadDocumentOwner<TEndpoint> {
    const current = this.#current.get(endpoint);
    if (!isDocumentOccurrence(occurrence) || current === undefined || current.occurrence !== occurrence) {
      throw new Error("Native gamepad IPC did not originate from the current application Document occurrence.");
    }
    return current;
  }

  isCurrent(endpoint: TEndpoint, occurrence: string): boolean {
    return this.#current.get(endpoint)?.occurrence === occurrence;
  }

  retire(endpoint: TEndpoint): void {
    const current = this.#current.get(endpoint);
    if (current === undefined) return;
    this.#current.delete(endpoint);
    this.onRetire(current);
  }
}

function isDocumentOccurrence(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}
