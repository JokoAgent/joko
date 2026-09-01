import type {
  JsonAgentSessionEvent,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
  RpcSessionState
} from "@earendil-works/pi-coding-agent";

export type PiRpcCommand = RpcCommand | RpcExtensionUIResponse;
export type PiRpcResponse = RpcResponse;
export type PiRpcState = RpcSessionState;
export type PiRpcEvent = JsonAgentSessionEvent | RpcExtensionUIRequest | PiUnknownEvent;

export interface PiUnknownEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface PiRpcModel {
  readonly id: string;
  readonly name?: string;
  readonly provider: string;
  readonly api?: string;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
  readonly input?: readonly string[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly cost?: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
  };
  readonly [key: string]: unknown;
}

export interface PiRpcTreeNode {
  readonly entry: {
    readonly id: string;
    readonly parentId: string | null;
    readonly type: string;
    readonly timestamp?: string;
    readonly [key: string]: unknown;
  };
  readonly label?: string;
  readonly labelTimestamp?: string;
  readonly children: readonly PiRpcTreeNode[];
}

export interface PiRpcEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: string;
  readonly timestamp?: string;
  readonly [key: string]: unknown;
}

export interface PiRpcCommandDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly source: "extension" | "prompt" | "skill";
  readonly sourceInfo?: {
    readonly path?: string;
    readonly scope?: string;
    readonly [key: string]: unknown;
  };
}

export function isRpcResponse(value: unknown): value is PiRpcResponse {
  return isRecord(value) && value.type === "response" && typeof value.command === "string" && typeof value.success === "boolean";
}

export function isExtensionUiRequest(value: unknown): value is RpcExtensionUIRequest {
  return isRecord(value) && value.type === "extension_ui_request" && typeof value.id === "string" && typeof value.method === "string";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
