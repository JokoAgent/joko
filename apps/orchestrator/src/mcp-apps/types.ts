/** Service-private MCP Apps records. Public clients receive generated card contracts. */
export const MCP_APP_LINK_GRANT_MS = 30_000;
export interface McpAppLinkAuthorization { authorized: true; validForMs: number }
export type McpAppHostEvent<T> =
  | { seq: number; message: T; openLink?: never }
  | { seq: number; openLink: { id: string; url: string }; message?: never };
export interface McpAppRecord {
  version: 1;
  serverId: string;
  serverRevision: string;
  resourceUri: string;
  connectionId?: string;
  tool: {
    name: string;
    title?: string;
    inputSchema: { type: 'object'; [key: string]: unknown };
    [key: string]: unknown;
  };
  arguments: Record<string, unknown>;
  result?: {
    content: unknown[];
    structuredContent?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
    isError?: boolean;
    [key: string]: unknown;
  };
  cancelled?: string;
}
export interface McpAppDocument {
  viewId: string;
  html: string;
  csp: string;
  prefersBorder: boolean;
  policy?: {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  };
}
