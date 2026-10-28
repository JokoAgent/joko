/** Private service authority for a native execution. This is
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
  /** Current ordered policy, read only by owner-private execution boundaries.
   * The caller must retain the matching capture/assertCurrent revision fence. */
  readonly snapshot?: () => import("./policy.js").PolicySnapshot;
  /** Current authored Queue/answer projection, excluding native inherited
   * history, service messages, pasted/quoted data and reference bodies. */
  readonly readOwnerUserInstructions?: () => readonly string[];
  /** A service-registered background task retains this exact original dispatch.
   * The caller must separately fence its private native runner occurrence. */
  readonly forBackgroundTask?: (taskId: string) => NativeToolAuthorization;
  readonly assertCurrent: (expectedRevision?: string) => void;
  readonly review: (request: NativeToolAuthorizationRequest) => Promise<NativeToolAuthorizationDecision>;
}
