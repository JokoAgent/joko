import type { AdapterContext } from "@joko/core";

export interface ClaudeManagedChildWorkspace {
  readonly workspaceRoot: string;
  readonly branch: string;
  assertCurrent(): void;
  verify(signal: AbortSignal): Promise<void>;
  release(input: { readonly writerRetired: true }): Promise<"released" | "preserved">;
}

export interface ClaudeManagedChildWorkspaceInput {
  readonly context: AdapterContext;
  readonly childTaskId: string;
  readonly childSessionId: string;
  readonly parentTaskId?: string;
  readonly parentWorkspaceTaskId?: string;
  readonly sourceWorkspaceRoot: string;
  readonly signal: AbortSignal;
}

export type ClaudeManagedChildWorkspaceFactory = (input: ClaudeManagedChildWorkspaceInput) => Promise<ClaudeManagedChildWorkspace>;
