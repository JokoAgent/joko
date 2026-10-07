import { isDesktopMainDocumentClaim } from "./main-document-occurrence.js";

export interface DesktopOpenWithDocumentOwner<TEndpoint> {
  readonly endpoint: TEndpoint;
  readonly claim: string;
  readonly occurrence: string;
}

export interface DesktopOpenWithDocumentCapture<TEndpoint> {
  readonly current: DesktopOpenWithDocumentOwner<TEndpoint>;
  readonly created: boolean;
}

/**
 * A WebContents and its WebFrameMain survive committed navigations. This
 * authority instead rotates when the replacement preload presents its private
 * claim, so a failed navigation cannot retire a still-live Document and a
 * committed replacement cannot inherit an open-with list.
 */
export class DesktopOpenWithDocumentAuthority<TEndpoint> {
  readonly #current = new Map<TEndpoint, DesktopOpenWithDocumentOwner<TEndpoint>>();

  constructor(
    private readonly createOccurrence: () => string,
    private readonly onRetire: (owner: DesktopOpenWithDocumentOwner<TEndpoint>) => void
  ) {}

  capture(endpoint: TEndpoint, claim: string): DesktopOpenWithDocumentCapture<TEndpoint> {
    if (!isDesktopMainDocumentClaim(claim)) {
      throw new TypeError("Desktop open-with Document claim is invalid.");
    }
    const existing = this.#current.get(endpoint);
    if (existing?.claim === claim) return Object.freeze({ current: existing, created: false });

    const occurrence = this.createOccurrence();
    if (!isOccurrence(occurrence)) {
      throw new TypeError("Desktop open-with occurrence factory returned an invalid identity.");
    }
    const current = Object.freeze({ endpoint, claim, occurrence });
    this.#current.set(endpoint, current);
    if (existing !== undefined) this.onRetire(existing);
    return Object.freeze({ current, created: true });
  }

  requireCurrent(endpoint: TEndpoint, occurrence: unknown): DesktopOpenWithDocumentOwner<TEndpoint> {
    const current = this.#current.get(endpoint);
    if (!isOccurrence(occurrence) || current === undefined || current.occurrence !== occurrence) {
      throw new Error("Open-with IPC did not originate from the current application Document occurrence.");
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

function isOccurrence(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}
