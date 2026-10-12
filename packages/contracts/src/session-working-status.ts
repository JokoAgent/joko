import { CompactionState, MessageRole, RetryState, type Event } from "./gen/joko/v1/event_pb.js";
import { CompositeArgumentKind, InteractionState, type DisplayArgument, type Interaction } from "./gen/joko/v1/interaction_pb.js";
import { RunState, SessionState, type Session, type Run } from "./gen/joko/v1/runtime_pb.js";
import { ToolCallState } from "./gen/joko/v1/tool_pb.js";
import { PartnerWorkingPhase } from "./gen/joko/v1/partner_pb.js";
import { publicToolResultWorkingPhase, publicToolWorkingPhase, type ObservedWorkingPhase, type WorkingPhase } from "./working-status.js";

export interface SessionWorkingStatus {
  readonly sessionId: string;
  readonly targetId: string;
  readonly backendId: string;
  readonly generation: bigint;
  readonly runId: string;
  readonly attemptId: string;
  readonly phase: ObservedWorkingPhase;
}

const activeStates = [RunState.DISPATCHING, RunState.DISPATCH_UNKNOWN, RunState.RUNNING, RunState.WAITING, RunState.RETRYING];
const phases: Record<ObservedWorkingPhase, PartnerWorkingPhase> = {
  thinking: PartnerWorkingPhase.THINKING, replying: PartnerWorkingPhase.REPLYING, processing: PartnerWorkingPhase.PROCESSING,
  compacting: PartnerWorkingPhase.COMPACTING, "reading-memory": PartnerWorkingPhase.READING_MEMORY,
  "saving-memory": PartnerWorkingPhase.SAVING_MEMORY, "deleting-memory": PartnerWorkingPhase.DELETING_MEMORY,
  "organizing-memory": PartnerWorkingPhase.ORGANIZING_MEMORY, "reading-file": PartnerWorkingPhase.READING_FILE,
  "saving-file": PartnerWorkingPhase.SAVING_FILE, searching: PartnerWorkingPhase.SEARCHING, "reading-web": PartnerWorkingPhase.READING_WEB,
  "searching-files": PartnerWorkingPhase.SEARCHING_FILES, testing: PartnerWorkingPhase.TESTING, checking: PartnerWorkingPhase.CHECKING,
  "reviewing-memory": PartnerWorkingPhase.REVIEWING_MEMORY, "reviewing-files": PartnerWorkingPhase.REVIEWING_FILES,
  "reviewing-sources": PartnerWorkingPhase.REVIEWING_SOURCES, "reviewing-checks": PartnerWorkingPhase.REVIEWING_CHECKS,
  reconnecting: PartnerWorkingPhase.RECONNECTING, "model-busy": PartnerWorkingPhase.MODEL_BUSY, "rate-limit": PartnerWorkingPhase.RATE_LIMIT
};

export function toPartnerWorkingPhase(phase: ObservedWorkingPhase): PartnerWorkingPhase { return phases[phase]; }
export function fromPartnerWorkingPhase(phase: PartnerWorkingPhase): ObservedWorkingPhase | undefined {
  return (Object.keys(phases) as ObservedWorkingPhase[]).find((key) => phases[key] === phase);
}

export function workingStatusTurnKey(status: Omit<SessionWorkingStatus, "phase">): string {
  return JSON.stringify([status.sessionId, status.targetId, status.backendId, status.generation.toString(), status.runId, status.attemptId]);
}

function currentRun(session: Session, runs: readonly Run[]): Run | null | undefined {
  const matches = runs.filter((run) => run.sessionId === session.sessionId && run.targetId === session.targetId
    && run.backendId === session.backendId && run.version?.generation === session.version?.generation && activeStates.includes(run.state));
  return matches.length > 1 ? null : matches[0];
}

/** Incremental public facts only; raw arguments, output, errors and reasoning are not retained. */
export class SessionWorkingStatusProjection {
  readonly identity: Omit<SessionWorkingStatus, "phase">;
  #phase: WorkingPhase;
  #retry: ObservedWorkingPhase | undefined;
  #blocked = false;
  #ended = false;
  #compacting = false;
  #sequence = 0n;
  readonly #seen = new Set<string>();
  readonly #waiting = new Set<string>();
  readonly #tools = new Map<string, { readonly phase: WorkingPhase; readonly terminal: boolean }>();

  constructor(session: Session, run?: Run) {
    this.identity = { sessionId: session.sessionId, targetId: session.targetId, backendId: session.backendId,
      generation: session.version?.generation ?? 0n, runId: run?.runId ?? "", attemptId: run?.activeAttemptId ?? "" };
    this.#phase = run ? "thinking" : "processing";
  }

  observe(event: Event): void {
    const i = event.identity, expected = this.identity;
    if (this.#ended || !expected.runId || !event.eventId || this.#seen.has(event.eventId)
      || i?.sessionId !== expected.sessionId || i.targetId !== expected.targetId || i.backendId !== expected.backendId
      || i.generation !== expected.generation || event.cursor?.generation !== expected.generation
      || event.cursor.sequence < 1n || event.cursor.sequence <= this.#sequence
      || i.runId !== expected.runId || i.attemptId !== expected.attemptId) return;
    this.#seen.add(event.eventId); this.#sequence = event.cursor.sequence;
    const kind = event.payload?.kind;
    switch (kind?.case) {
      case "runDone": case "runAborted": case "terminalError": this.#ended = true; break;
      case "recoverableError": this.#blocked = true; break;
      case "interactionChanged":
        if (kind.value.interaction?.sessionId === expected.sessionId && kind.value.interaction.generation === expected.generation)
          this.#blocked = kind.value.interaction.state === InteractionState.PENDING;
        break;
      case "retryChanged":
        if (kind.value.runId !== expected.runId || kind.value.attemptId !== expected.attemptId) break;
        if (kind.value.state === RetryState.ABORTED || kind.value.state === RetryState.EXHAUSTED) this.#ended = true;
        if (kind.value.state === RetryState.WAITING) { this.#retry = retryPhase(kind.value.error?.code); this.#blocked = false; }
        if (kind.value.state === RetryState.STARTED || kind.value.state === RetryState.SUCCEEDED) { this.#retry = undefined; this.#blocked = false; }
        break;
      case "compactionChanged": this.#compacting = kind.value.state === CompactionState.STARTED; break;
      case "messageStarted":
        if (kind.value.role === MessageRole.USER) { this.#phase = "thinking"; this.#tools.clear(); this.#waiting.clear(); }
        break;
      case "textDelta": if (kind.value.delta.trim()) this.#phase = "replying"; break;
      case "messageCompleted":
        if (kind.value.role === MessageRole.ASSISTANT && kind.value.blocks.some((block) =>
          block.content.case === "text" && block.content.value.trim() !== "")) this.#phase = "replying";
        break;
      case "toolCallStarted": case "toolCallUpdated": case "toolCallCompleted": {
        const call = kind.value.toolCall;
        if (!call || !id(call.toolCallId) || !id(call.toolId) || call.sessionId !== expected.sessionId
          || call.runId !== expected.runId || call.attemptId !== expected.attemptId) break;
        const key = JSON.stringify([call.toolCallId, call.toolId, call.toolProviderId]);
        const previous = this.#tools.get(key);
        if (previous?.terminal) break;
        const terminal = [ToolCallState.SUCCEEDED, ToolCallState.FAILED, ToolCallState.ABORTED].includes(call.state);
        const input = displayInput(call.arguments);
        const phase = call.arguments.length === 0 && previous ? previous.phase
          : publicToolWorkingPhase(call.toolId, input.slice(0, 262_144), call.arguments.length > 256
            || call.arguments.some((argument) => argument.redacted) || input.length > 262_144);
        this.#tools.set(key, { phase, terminal });
        if (call.state === ToolCallState.WAITING_PERMISSION) this.#waiting.add(key);
        else { this.#waiting.delete(key); this.#phase = terminal ? publicToolResultWorkingPhase(phase) : phase; }
        break;
      }
    }
  }

  end(identity: Omit<SessionWorkingStatus, "phase">): void {
    if (workingStatusTurnKey(identity) === workingStatusTurnKey(this.identity)) this.#ended = true;
  }

  read(session: Session, runs: readonly Run[], interactions: readonly Interaction[]): SessionWorkingStatus | undefined {
    if (session.archived || session.version?.generation === undefined || session.version.generation < 1n) return undefined;
    const run = currentRun(session, runs);
    const identity = { sessionId: session.sessionId, targetId: session.targetId, backendId: session.backendId,
      generation: session.version.generation, runId: run?.runId ?? "", attemptId: run?.activeAttemptId ?? "" };
    if (run === null || workingStatusTurnKey(identity) !== workingStatusTurnKey(this.identity) || this.#ended || this.#blocked
      || this.#waiting.size > 0 || session.state === SessionState.ERROR || session.state === SessionState.WAITING
      || run?.state === RunState.WAITING || interactions.some((interaction) => interaction.sessionId === session.sessionId
        && interaction.targetId === session.targetId && interaction.backendId === session.backendId
        && interaction.generation === session.version!.generation && interaction.state === InteractionState.PENDING)) return undefined;
    const recovering = session.state === SessionState.RECOVERING || run?.state === RunState.DISPATCH_UNKNOWN || run?.state === RunState.RETRYING;
    const compacting = session.contextState?.compacting ?? this.#compacting;
    if (!recovering && !compacting && session.state !== SessionState.RUNNING && run === undefined) return undefined;
    return { ...this.identity, phase: this.#retry ?? (recovering ? retryPhase(run?.error?.code)
      : compacting ? "compacting" : this.#phase) };
  }
}

export function projectSessionWorkingStatus(session: Session, runs: readonly Run[], interactions: readonly Interaction[],
  events: readonly Event[]): SessionWorkingStatus | undefined {
  const run = currentRun(session, runs);
  if (run === null) return undefined;
  const projection = new SessionWorkingStatusProjection(session, run);
  for (const event of [...events].sort((a, b) => (a.cursor?.sequence ?? 0n) < (b.cursor?.sequence ?? 0n) ? -1
    : (a.cursor?.sequence ?? 0n) > (b.cursor?.sequence ?? 0n) ? 1 : 0)) projection.observe(event);
  return projection.read(session, runs, interactions);
}

function displayInput(arguments_: readonly DisplayArgument[]): string {
  return arguments_.slice(0, 256).map((argument) => {
    const value = argument.value;
    let text = "";
    switch (value.case) {
      case "text": text = value.value; break;
      case "number": case "integer": case "boolean": text = String(value.value); break;
      case "null": text = "null"; break;
      case "composite": text = `${value.value.kind === CompositeArgumentKind.ARRAY ? "array" : "object"} (${value.value.childCount})`; break;
    }
    return `${argument.fieldPath}: ${text}`;
  }).join("\n");
}

function retryPhase(code: string | undefined): ObservedWorkingPhase {
  if (["RATE_LIMITED", "rate_limited", "rate_limit_error", "429"].includes(code ?? "")) return "rate-limit";
  if (["OVERLOADED", "overloaded_error", "MODEL_OVERLOADED", "at_capacity"].includes(code ?? "")) return "model-busy";
  return "reconnecting";
}
function id(value: string): boolean { return value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value); }
