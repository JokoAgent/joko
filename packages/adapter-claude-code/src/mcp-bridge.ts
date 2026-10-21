import type { PartnerLearningToolAuthority } from "@joko/core";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CreateTaskResult } from "@modelcontextprotocol/sdk/types.js";

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
  readonly taskResult?: CreateTaskResult;
}

export interface ClaudeMcpModelToolCall {
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly toolUseId: string;
  readonly signal: AbortSignal;
  readonly modelCallId: string;
}

export interface ClaudeMcpModelServer {
  readonly serverId: string;
  connect(transport: Transport, callTool: (input: ClaudeMcpModelToolCall) => Promise<ClaudeMcpCallResult>): Promise<void>;
}

export interface ClaudeMcpRuntimeLease {
  readonly tools: readonly ClaudeMcpTool[];
  readonly models?: readonly ClaudeMcpModelServer[];
  assertCurrent(): void;
  call(input: {
    readonly serverId: string;
    readonly toolName: string;
    readonly requestId: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly signal: AbortSignal;
    readonly partnerLearningAuthority?: PartnerLearningToolAuthority;
    readonly modelCallId?: string;
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
