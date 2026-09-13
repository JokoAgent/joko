export type VoiceInputState =
  | "idle"
  | "listening"
  | "submitting"
  | "refining"
  | "done"
  | "error";

export type VoiceInputTerminalOutcome = "success" | "no_speech" | "failed" | "cancelled";

export type VoiceInputDraftSource = "partial" | "stable";

export type AsrErrorCategory =
  | "transport"
  | "authentication"
  | "quota"
  | "protocol"
  | "unknown";

export type AsrEvent =
  | { readonly type: "connected" }
  | { readonly type: "partial"; readonly text: string }
  | { readonly type: "stable"; readonly text: string }
  | { readonly type: "disconnected"; readonly recoverable: boolean }
  | {
      readonly type: "error";
      readonly category: AsrErrorCategory;
      readonly recoverable: boolean;
    };

export interface AsrStartRequest {
  readonly runId: string;
  readonly mimeType: SupportedAudioMimeType;
  readonly locale?: string;
}

export interface AudioChunk {
  readonly data: ArrayBuffer;
  readonly durationMs: number;
  readonly voiced: boolean;
}

/** A transport adapter owns capture/network resources; the controller owns their lifetime. */
export interface AsrProvider {
  start(request: AsrStartRequest): Promise<void>;
  appendAudio(chunk: AudioChunk): void;
  flushAudio(): Promise<void>;
  stop(): Promise<void>;
  onEvent(listener: (event: AsrEvent) => void): () => void;
  recover?(): Promise<void>;
}

export type SupportedAudioMimeType =
  | "audio/mp4"
  | "audio/mpeg"
  | "audio/ogg"
  | "audio/pcm"
  | "audio/wav"
  | "audio/webm";

export interface VoiceInputStartOptions {
  readonly mimeType: string;
  readonly locale?: string;
}

export interface SpeechSegment {
  readonly id: string;
  readonly source: "mic";
  readonly status: "draft" | "submitted" | "refined";
  readonly text: string;
  readonly basedOnText?: string;
  readonly updatedAt: number;
}

export type EditorRevision = string | number;

/** The revision is the exact editor version in which the submitted text landed. */
export interface EditorRangeAcceptance {
  readonly id: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly revision: EditorRevision;
  readonly userEdited?: boolean;
}

export interface EditorRangeStatus {
  readonly exists: boolean;
  readonly revision: EditorRevision;
  readonly userEdited: boolean;
}

export type RefinementRejectionReason = "unchanged" | "unsafe" | "invalid_output" | "unavailable";

export type RefinementResult =
  | {
      readonly accepted: true;
      readonly basedOnText: string;
      readonly refinedText: string;
    }
  | {
      readonly accepted: false;
      readonly reason: RefinementRejectionReason;
    };

export interface RefinementRequest {
  readonly runId: string;
  readonly text: string;
  readonly locale?: string;
  readonly signal: AbortSignal;
  readonly onPreview: (text: string) => void;
}

export interface VoiceRefiner {
  refine(request: RefinementRequest): Promise<RefinementResult>;
}

export type RefinementDiscardReason =
  | "apply_failed"
  | "base_text_changed"
  | "cancelled"
  | "range_missing"
  | "refiner_failed"
  | "refiner_rejected"
  | "run_failed"
  | "stale_revision"
  | "stale_run"
  | "unchanged"
  | "user_edited";

export type RefinementEvent =
  | {
      readonly type: "preview";
      readonly runId: string;
      readonly rangeId: string;
      readonly expectedRevision: EditorRevision;
      readonly text: string;
    }
  | {
      readonly type: "applied";
      readonly runId: string;
      readonly rangeId: string;
      readonly expectedRevision: EditorRevision;
      readonly text: string;
    }
  | {
      readonly type: "discarded";
      readonly runId: string;
      readonly rangeId?: string;
      readonly reason: RefinementDiscardReason;
    };

export type RefinementApplyResult =
  | { readonly applied: true; readonly revision: EditorRevision }
  | {
      readonly applied: false;
      readonly reason: "range_missing" | "stale_revision" | "user_edited" | "apply_failed";
    };

export interface RefinementApplyRequest {
  readonly rangeId: string;
  readonly expectedRevision: EditorRevision;
  readonly refinedText: string;
}

export interface VoiceSubmission {
  readonly runId: string;
  readonly text: string;
  readonly source: VoiceInputDraftSource;
  readonly salvaged: boolean;
  readonly segment: SpeechSegment;
}

export type VoiceInputFailureCode =
  | "connection_interrupted"
  | "empty_transcript"
  | "host_submission_failed"
  | "provider_authentication"
  | "provider_close_failed"
  | "provider_error"
  | "provider_flush_failed"
  | "provider_protocol"
  | "provider_quota"
  | "provider_start_failed";

export interface VoiceInputFailure {
  readonly code: VoiceInputFailureCode;
  readonly transcriptKept: boolean;
}

/** Diagnostic events intentionally contain no transcript or provider error text. */
export type VoiceInputDiagnosticEvent =
  | {
      readonly type: "stall_warning";
      readonly wallMsSinceLastSignal: number;
      readonly audioMsSinceLastSignal: number;
      readonly voicedAudioMsSinceLastSignal: number;
      readonly everSawSignal: boolean;
    }
  | {
      readonly type: "recovery_attempted";
      readonly attempt: number;
      readonly trigger: "disconnected" | "error";
    }
  | { readonly type: "recovery_succeeded"; readonly attempt: number }
  | { readonly type: "recovery_failed"; readonly attempt: number }
  | {
      readonly type: "transcript_salvaged";
      readonly source: VoiceInputDraftSource;
      readonly accepted: boolean;
      readonly characterCount: number;
    }
  | { readonly type: "refinement_discarded"; readonly reason: RefinementDiscardReason };

export interface VoiceInputCallbacks {
  readonly onStateChanged?: (state: VoiceInputState, outcome?: VoiceInputTerminalOutcome) => void;
  readonly onDraftChanged?: (text: string, segment: SpeechSegment, source: VoiceInputDraftSource) => void;
  readonly onSubmitted: (submission: VoiceSubmission) => EditorRangeAcceptance | undefined;
  readonly inspectEditorRange?: (range: EditorRangeAcceptance) => EditorRangeStatus | undefined;
  readonly applyRefinement?: (request: RefinementApplyRequest) => RefinementApplyResult;
  readonly onRefinement?: (event: RefinementEvent) => void;
  readonly onError?: (failure: VoiceInputFailure) => void;
  readonly onDiagnostic?: (event: VoiceInputDiagnosticEvent) => void;
}

export interface VoiceInputClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface VoiceInputControllerOptions {
  readonly provider: AsrProvider;
  readonly callbacks: VoiceInputCallbacks;
  readonly refiner?: VoiceRefiner;
  readonly stableWaitMs?: number;
  readonly clock?: VoiceInputClock;
  readonly createId?: () => string;
}
