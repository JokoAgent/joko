/** Product-authorized MCP catalog and executor for one committed native Query. */
export interface ClaudeMcpTool {
  readonly serverId: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
}

export interface ClaudeMcpCallResult {
  readonly content: readonly unknown[];
  readonly isError: boolean;
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly bridgeMetadata?: unknown;
}

export interface ClaudeMcpRuntimeLease {
  readonly tools: readonly ClaudeMcpTool[];
  assertCurrent(): void;
  call(input: {
    readonly serverId: string;
    readonly toolName: string;
    readonly requestId: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly signal: AbortSignal;
  }): Promise<ClaudeMcpCallResult>;
  release(): void;
}

export interface ClaudeMcpBridgePort {
  open(input: {
    readonly sessionId: string;
    readonly targetId: string;
    readonly generation: number;
    readonly signal: AbortSignal;
  }): ClaudeMcpRuntimeLease;
}
