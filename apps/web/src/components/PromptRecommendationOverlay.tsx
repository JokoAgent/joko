import type { JSX, ReactNode } from "react";
import "./PromptRecommendationOverlay.css";

export function PromptRecommendationEditorFrame({ recommendation, children, onAccept, acceptLabel = "Tab" }: {
  readonly recommendation?: string;
  readonly children: ReactNode;
  readonly onAccept?: () => void;
  readonly acceptLabel?: string;
}): JSX.Element {
  return <div
    className="prompt-recommendation-editor"
    data-recommendation-active={recommendation === undefined ? undefined : "true"}
  >
    {children}
    {recommendation !== undefined && <div className="prompt-recommendation-editor__overlay">
      <span className="prompt-recommendation-editor__text" aria-hidden="true">{recommendation}</span>
      {onAccept === undefined
        ? <kbd className="prompt-recommendation-editor__key" aria-hidden="true">{acceptLabel}</kbd>
        : <button
            className="prompt-recommendation-editor__key prompt-recommendation-editor__key--action"
            type="button"
            aria-label={`${acceptLabel}: ${recommendation}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onAccept}
          >{acceptLabel}</button>}
    </div>}
  </div>;
}

export function isPromptRecommendationAcceptKey(event: Pick<KeyboardEvent,
  "key" | "repeat" | "isComposing" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>): boolean {
  return event.key === "Tab" &&
    !event.repeat &&
    !event.isComposing &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey;
}

export interface PromptRecommendationVisibilityInput {
  readonly enabled: boolean;
  readonly available: boolean;
  readonly hydrated: boolean;
  readonly readOnly: boolean;
  readonly locked: boolean;
  readonly bashMode: boolean;
  readonly paletteOpen: boolean;
  readonly documentEmpty: boolean;
  readonly hasAttachments: boolean;
  readonly hasMentions: boolean;
  readonly hasSelectionQuotes: boolean;
  readonly hasUnfinishedQueue: boolean;
  readonly queuePaused: boolean;
}

/** Prediction dispatch, overlay visibility, Tab acceptance, and cleanup share
 * this one renderer-side predicate. Orchestrator repeats the authoritative fence. */
export function shouldShowPromptRecommendation(input: PromptRecommendationVisibilityInput): boolean {
  return input.enabled &&
    input.available &&
    input.hydrated &&
    !input.readOnly &&
    !input.locked &&
    !input.bashMode &&
    !input.paletteOpen &&
    input.documentEmpty &&
    !input.hasAttachments &&
    !input.hasMentions &&
    !input.hasSelectionQuotes &&
    !input.hasUnfinishedQueue &&
    !input.queuePaused;
}
