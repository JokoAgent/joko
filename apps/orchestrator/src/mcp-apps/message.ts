/** An in-process authorization is rechecked before admitting or dispatching App input. */
export type McpAppMessageGuard = (() => Promise<void>) & { readonly signal: AbortSignal };
