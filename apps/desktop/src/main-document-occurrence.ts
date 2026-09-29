export interface DesktopMainDocumentOwner<TEndpoint> {
  readonly endpoint: TEndpoint;
  readonly claim: string;
  readonly occurrence: string;
}

export interface DesktopMainDocumentCapture<TEndpoint> {
  readonly current: DesktopMainDocumentOwner<TEndpoint>;
  readonly created: boolean;
  readonly retired?: DesktopMainDocumentOwner<TEndpoint>;
}

/**
 * The primary preload captures a fresh occurrence exactly once for each main
 * Document. Navigation attempts are deliberately not an ownership boundary:
 * a blocked or failed navigation leaves the existing preload authoritative.
 */
export class DesktopMainDocumentOccurrenceAuthority<TEndpoint> {
  #current: DesktopMainDocumentOwner<TEndpoint> | undefined;

  constructor(private readonly createOccurrence: () => string) {}

  capture(endpoint: TEndpoint, claim: string): DesktopMainDocumentCapture<TEndpoint> {
    if (!isDesktopMainDocumentClaim(claim)) {
      throw new TypeError("Desktop main Document preload claim is invalid.");
    }
    if (this.#current?.endpoint === endpoint && this.#current.claim === claim) {
      return Object.freeze({ current: this.#current, created: false });
    }
    const occurrence = this.createOccurrence();
    if (typeof occurrence !== "string" || occurrence.length < 1 || occurrence.length > 256 ||
      occurrence.trim() !== occurrence || /[\u0000-\u001f\u007f]/u.test(occurrence)) {
      throw new TypeError("Desktop main Document occurrence factory returned an invalid identity.");
    }
    const retired = this.#current;
    const current = Object.freeze({ endpoint, claim, occurrence });
    this.#current = current;
    return Object.freeze({ current, created: true, ...(retired === undefined ? {} : { retired }) });
  }

  currentFor(endpoint: TEndpoint): string | undefined {
    return this.#current?.endpoint === endpoint ? this.#current.occurrence : undefined;
  }

  isCurrent(endpoint: TEndpoint, occurrence: string): boolean {
    return this.#current?.endpoint === endpoint && this.#current.occurrence === occurrence;
  }

  retire(endpoint: TEndpoint): DesktopMainDocumentOwner<TEndpoint> | undefined {
    if (this.#current?.endpoint !== endpoint) return undefined;
    const retired = this.#current;
    this.#current = undefined;
    return retired;
  }

  retireCurrent(): DesktopMainDocumentOwner<TEndpoint> | undefined {
    const retired = this.#current;
    this.#current = undefined;
    return retired;
  }
}

export function isDesktopMainDocumentClaim(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}
