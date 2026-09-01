export interface ComposerAutoFocusState {
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly hydrated: boolean;
  readonly activeElementIsNeutral: boolean;
  readonly activeElementMatchesAnchor: boolean;
  readonly activeElementInsideComposer: boolean;
}

export function shouldAutoFocusComposer(state: ComposerAutoFocusState): boolean {
  return state.enabled
    && !state.readOnly
    && state.hydrated
    && !state.activeElementInsideComposer
    && (state.activeElementIsNeutral || state.activeElementMatchesAnchor);
}
