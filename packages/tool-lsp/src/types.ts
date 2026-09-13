import type { LspToolErrorShape } from "./errors.js";

export const LSP_TOOL_ACTIONS = Object.freeze([
  "hover",
  "goto_definition",
  "find_references",
  "outline",
  "workspace_symbol",
  "incoming_calls"
] as const);

export type LspToolAction = (typeof LSP_TOOL_ACTIONS)[number];

export interface LspCallOptions {
  readonly signal?: AbortSignal;
  /** Relative duration for this operation. */
  readonly timeoutMs?: number;
  /** Absolute Unix time in milliseconds. The earliest configured deadline wins. */
  readonly deadlineAtMs?: number;
}

export interface LspPosition {
  readonly line: number;
  readonly column: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

export interface LspLocation {
  /** Forward-slash workspace-relative path. */
  readonly path: string;
  readonly range: LspRange;
}

export interface LspWorkspaceRequest {
  readonly workspaceRoot: string;
  readonly maxResults?: number;
}

export interface LspFileRequest extends LspWorkspaceRequest {
  readonly file: string;
}

export interface LspPositionRequest extends LspFileRequest {
  /** One-based line. */
  readonly line: number;
  /** One-based UTF-16 column. */
  readonly column: number;
}

export interface LspWorkspaceSymbolRequest extends LspWorkspaceRequest {
  readonly query: string;
}

export type LspToolRequest =
  | ({ readonly action: "hover" } & LspPositionRequest)
  | ({ readonly action: "goto_definition" } & LspPositionRequest)
  | ({ readonly action: "find_references" } & LspPositionRequest)
  | ({ readonly action: "outline" } & LspFileRequest)
  | ({ readonly action: "workspace_symbol" } & LspWorkspaceSymbolRequest)
  | ({ readonly action: "incoming_calls" } & LspPositionRequest);

export interface LspToolResult<TItem, TAction extends LspToolAction = LspToolAction> {
  readonly action: TAction;
  readonly items: readonly TItem[];
  /** True when maxResults or the public output budget omitted additional items. */
  readonly truncated: boolean;
}

export interface LspHoverItem {
  readonly kind: string;
  readonly modifiers: readonly string[];
  readonly display: string;
  readonly documentation: string;
  readonly range: LspRange;
}

export interface LspDefinitionItem {
  readonly name: string;
  readonly kind: string;
  readonly container?: string;
  readonly location: LspLocation;
}

export interface LspReferenceItem {
  readonly location: LspLocation;
  readonly isWriteAccess: boolean;
  readonly isInString: boolean;
}

export interface LspOutlineItem {
  readonly name: string;
  readonly kind: string;
  readonly modifiers: readonly string[];
  readonly depth: number;
  readonly parent?: string;
  readonly location: LspLocation;
  readonly selection?: LspRange;
}

export interface LspWorkspaceSymbolItem {
  readonly name: string;
  readonly kind: string;
  readonly modifiers: readonly string[];
  readonly matchKind: "exact" | "prefix" | "substring" | "camelCase";
  readonly container?: string;
  readonly location: LspLocation;
}

export interface LspCallHierarchySource {
  readonly name: string;
  readonly kind: string;
  readonly modifiers: readonly string[];
  readonly container?: string;
  readonly location: LspLocation;
  readonly selection: LspRange;
}

export interface LspIncomingCallItem {
  readonly from: LspCallHierarchySource;
  readonly callSites: readonly LspRange[];
}

export type LspHoverResult = LspToolResult<LspHoverItem, "hover">;
export type LspDefinitionResult = LspToolResult<LspDefinitionItem, "goto_definition">;
export type LspReferencesResult = LspToolResult<LspReferenceItem, "find_references">;
export type LspOutlineResult = LspToolResult<LspOutlineItem, "outline">;
export type LspWorkspaceSymbolResult = LspToolResult<LspWorkspaceSymbolItem, "workspace_symbol">;
export type LspIncomingCallsResult = LspToolResult<LspIncomingCallItem, "incoming_calls">;

export type LspToolResponse =
  | LspHoverResult
  | LspDefinitionResult
  | LspReferencesResult
  | LspOutlineResult
  | LspWorkspaceSymbolResult
  | LspIncomingCallsResult;

/** Serialization shape suitable for an RPC or tool-provider error envelope. */
export interface LspBridgeFailure {
  readonly ok: false;
  readonly error: LspToolErrorShape;
}

export interface LspBridgeSuccess {
  readonly ok: true;
  readonly result: LspToolResponse;
}

export type LspBridgeResponse = LspBridgeSuccess | LspBridgeFailure;
