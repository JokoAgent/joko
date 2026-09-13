export type ReviewSourceDescriptor =
  | { readonly kind: "unstaged" }
  | { readonly kind: "staged" }
  | { readonly kind: "commit"; readonly commitOid: string | null }
  | { readonly kind: "branch"; readonly baseRef: string | null }
  | { readonly kind: "last-turn" }
  | {
    readonly kind: "turn-set";
    readonly targetSessionId: string | null;
    readonly changeSetIds: readonly string[];
  };

export interface ReviewSourceCapabilities {
  readonly canDiscard: boolean;
  readonly canCommit: boolean;
  readonly canPush: boolean;
  readonly canRichPreview: boolean;
  readonly canOpenFile: boolean;
  readonly canSwitchSource: boolean;
  readonly showBranchInfo: boolean;
}

export function reviewSourceCapabilities(descriptor: ReviewSourceDescriptor): ReviewSourceCapabilities {
  if (descriptor.kind === "turn-set") {
    return {
      canDiscard: false,
      canCommit: false,
      canPush: false,
      canRichPreview: false,
      canOpenFile: false,
      canSwitchSource: true,
      showBranchInfo: false
    };
  }
  return {
    canDiscard: descriptor.kind === "unstaged",
    canCommit: true,
    canPush: true,
    canRichPreview: true,
    canOpenFile: true,
    canSwitchSource: true,
    showBranchInfo: true
  };
}
