export interface PiManagedDurableRunSnapshot {
  readonly runId: string;
  readonly runnerInstanceId: string;
  readonly launchToken: string;
  readonly runnerScriptSha256: string;
  /** Volatile projected manifest/process state. */
  readonly revision: string;
  /** CAS fence for control and approval writes; excludes heartbeat-only churn. */
  readonly controlRevision: string;
  /** Frozen append-safe transcript artifact snapshot lease. */
  readonly transcriptRevision: string;
  /** Frozen result artifact snapshot lease, including an explicit absent snapshot. */
  readonly resultRevision: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly status: Readonly<Record<string, unknown>>;
  readonly owner: Readonly<Record<string, unknown>>;
  readonly claim?: Readonly<Record<string, unknown>>;
  readonly transcriptBytes: number;
  readonly resultBytes: number;
  /** Remote-side canonical native Session validation; never inferred from a service-node path. */
  readonly resumeSafe: boolean;
  /** Remote-side heartbeat freshness; never compares clocks across hosts. */
  readonly controlSafe: boolean;
}

export interface PiManagedDurableStore {
  scan(input: {
    readonly sessionId: string;
    readonly sessionKey: string;
    readonly afterRevision?: string;
    readonly limitBytes: number;
  }): Promise<{
    readonly revision: string;
    readonly unchanged: boolean;
    readonly retryAfterMs: number;
    readonly runs: readonly PiManagedDurableRunSnapshot[];
  }>;

  readTail(input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly runnerInstanceId: string;
    readonly artifactRevision: string;
    readonly pathKind: "transcript" | "result";
    readonly offset: number;
    readonly maxBytes: number;
  }): Promise<{
    readonly artifactRevision: string;
    readonly offset: number;
    readonly nextOffset: number;
    readonly eof: boolean;
    readonly content: Uint8Array;
  }>;

  writeControl(input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly runnerInstanceId: string;
    readonly launchToken: string;
    readonly runnerScriptSha256: string;
    readonly expectedControlRevision: string;
    readonly kind: "control" | "approval";
    readonly value: Readonly<Record<string, unknown>>;
  }): Promise<{
    readonly controlRevision: string;
    readonly receipt: string;
  }>;

  stopAndRemoveSession(input: {
    readonly sessionId: string;
    readonly sessionKey: string;
    readonly timeoutMs: number;
  }): Promise<
    | { readonly terminalRunIds: readonly string[]; readonly removed: false }
    | {
      readonly terminalRunIds: readonly string[];
      readonly removed: true;
      readonly deletionReceipt: string;
    }
  >;

  /**
   * Finalizes an already-confirmed removal without invalidating an in-flight
   * retry. The receipt remains idempotently verifiable for bounded recovery.
   */
  finalizeDeletion(input: {
    readonly sessionId: string;
    readonly sessionKey: string;
    readonly deletionReceipt: string;
  }): Promise<void>;

  /** Releases only this service attachment. It never stops or removes a runner. */
  dispose(): Promise<void>;
}

export interface PiManagedDurableStoreRegistry {
  storeFor(input: {
    readonly sessionId: string;
    readonly targetId: string;
    readonly bindingOpaqueRef: string;
    readonly generation: number;
  }): Promise<PiManagedDurableStore | undefined>;
}
