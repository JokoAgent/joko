export interface RoutinePreRunHook { readonly command: string; readonly timeoutMs?: number; }

export interface RoutineModel {
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly effort?: string;
  readonly fastMode: boolean | "ultrafast";
}

/** Sources describe events, independently of the connector transporting them. */
export interface RoutineSource {
  id: string;
  name: string;
  events: Array<{ type: string; name: string; fields: string[] }>;
  status: "listening" | "disconnected" | "error";
  lastEventAt?: number;
}

/** The host supplies source identity; publishers cannot choose a target Bot or prompt. */
export interface RoutineEvent {
  id: string;
  type: string;
  occurredAt: number;
  subject?: string;
  data: Record<string, string | number | boolean>;
  originRoutineId?: string;
}

export type RoutineTrigger =
  | { id: string; kind: "cron"; expression: string; timezone: string }
  | { id: string; kind: "interval"; intervalMs: number; anchorMs?: number }
  | { id: string; kind: "once"; at: number }
  | {
      id: string;
      kind: "event";
      sourceId: string;
      eventType: string;
      filters: Array<{
        field: string;
        operator: "equals" | "contains" | "not-equals";
        value: string;
      }>;
    };

/** A single standing instruction, with OR-combined time and event triggers. */
export interface Routine {
  /** Host template; the owner may pause/resume it without editing its definition. */
  builtin?: "follow-up";
  builtinVersion?: number;
  /** Derived by the engine, never accepted as configuration. */
  activity?: "queued" | "running";
  id: string;
  partnerId: string;
  name: string;
  prompt: string;
  enabled: boolean;
  triggers: RoutineTrigger[];
  /** Suppress successful attention unless explicitly requested by the run. */
  silentWhenIdle: boolean;
  /** A check can skip model dispatch before the independent task starts. */
  preRunHook?: RoutinePreRunHook;
  sessionMode?: "persistent" | "fresh";
  modelOverride?: RoutineModel | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type RoutineInput = Pick<
  Routine,
  "name" | "prompt" | "enabled" | "triggers" | "silentWhenIdle" | "preRunHook" | "sessionMode" | "modelOverride"
>;

/** Durable receipt and execution history share one identity across all trigger kinds. */
export interface RoutineRun {
  id: string;
  routineId: string;
  revision: number;
  triggerIds: string[];
  events: Array<{ sourceId: string; event: RoutineEvent }>;
  status:
    "queued" | "running" | "success" | "failed" | "interrupted" | "cancelled" | "skipped";
  createdAt: number;
  finishedAt?: number;
  error?: string;
  scheduleRunId?: string;
  sessionId?: string;
  resultText?: string;
}

/** One node-owned snapshot; the host commits each transition atomically. */
export interface RoutineState {
  version: 1;
  routines: Routine[];
  runs: RoutineRun[];
  receipts: Record<string, number>;
  next: Record<string, number>;
  /** Lifecycle suspension preserves each routine's own enabled preference. */
  pausedPartnerIds: string[];
  retiredRoutineIds: string[];
}
