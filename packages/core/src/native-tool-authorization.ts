/** Private service authority for an extension-owned native execution. This is
 * never accepted from a model, a plugin page, a client contract or native text. */
export interface NativeToolAuthorizationRequest {
  readonly toolName: string;
  readonly input: unknown;
  readonly signal: AbortSignal;
}
export interface NativeToolAuthorizationDecision {
  readonly verdict: "default" | "allow" | "block" | "ask";
  readonly reason?: string;
  readonly unavailable?: boolean;
  readonly authorizationRevision?: string;
}
export interface NativeToolAuthorization {
  /** Native engines with unobservable automatic tools must route this turn
   * through their existing approval protocol rather than bypassing the host. */
  readonly required: boolean;
  readonly capture: () => string | undefined;
  readonly assertCurrent: (expectedRevision?: string) => void;
  readonly review: (request: NativeToolAuthorizationRequest) => Promise<NativeToolAuthorizationDecision>;
}
