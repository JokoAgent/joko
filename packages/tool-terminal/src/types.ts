export interface TerminalScope {
  readonly sessionId: string;
  readonly targetId: string;
  readonly workspaceRoot: string;
  /** A remote scope uses POSIX paths owned by this host, never the service filesystem. */
  readonly remoteHostId?: string;
}

export interface TerminalReference extends TerminalScope {
  readonly id: string;
  readonly generation: number;
}

export interface TerminalCreateInput extends TerminalScope {
  readonly id: string;
  readonly initialPalette: TerminalPalette;
  /** A relative directory beneath the registered canonical workspace. */
  readonly cwd?: string;
  readonly shellId?: string;
  readonly cols?: number;
  readonly rows?: number;
}

export interface TerminalPalette {
  readonly ansiRgb: readonly number[];
  readonly foregroundRgb: number;
  readonly backgroundRgb: number;
  readonly cursorRgb: number;
}

export interface TerminalViewAppearance {
  readonly viewId: string;
  readonly viewRevision: number;
  readonly palette: TerminalPalette;
}

export interface TerminalAppearanceResult {
  readonly accepted: boolean;
  readonly acceptedViewRevision: number;
  readonly appearanceRevision: number;
  readonly ownsDefaults: boolean;
}

export interface TerminalDescriptor {
  readonly id: string;
  readonly sessionId: string;
  readonly targetId: string;
  readonly generation: number;
  readonly status: "running" | "exited" | "closed" | "failed";
  readonly exitConfirmed: boolean;
  readonly shellId: string;
  readonly shellLabel: string;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly pid?: number;
  readonly exitCode?: number;
  readonly exitSignal?: number;
  readonly failureCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TerminalShell {
  readonly id: string;
  readonly label: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly isDefault: boolean;
}

export interface TerminalSnapshot {
  readonly terminal: TerminalDescriptor;
  /** The last fully parsed output/state sequence represented by serialized. */
  readonly sequence: number;
  /** VT screen, cursor, modes, alternate buffer and bounded scrollback. Reset before replay. */
  readonly serialized: string;
  readonly activeColorOverrides: string;
  readonly appearanceRevision: number;
}

interface TerminalFrameIdentity {
  readonly terminalId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly appearanceRevision: number;
  readonly activeColorOverrides?: string;
}

export type TerminalFrame =
  | (TerminalFrameIdentity & { readonly kind: "output"; readonly data: string })
  | (TerminalFrameIdentity & { readonly kind: "state"; readonly terminal: TerminalDescriptor })
  | (TerminalFrameIdentity & { readonly kind: "reset"; readonly terminal: TerminalDescriptor; readonly serialized: string; readonly activeColorOverrides: string });

export interface TerminalStreamInput extends TerminalReference {
  readonly appearance: TerminalViewAppearance;
  /** Omit for a full checkpoint. A retained cursor resumes raw incremental output. */
  readonly afterSequence?: number;
}

export class TerminalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly stateMayHaveChanged = false
  ) {
    super(message);
    this.name = "TerminalError";
  }
}
