import { CompactionState, InteractionState, MessageRole, RetryState, RunState,
  publicToolResultWorkingPhase, publicToolWorkingPhase, type Event, type WorkingPhase } from "@joko/contracts";
import { mobilePartnerActivityState, type MobilePartnerDirectoryObservation } from "./mobile-partner-activity";
import type { MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import { projectMobileToolCall, type MobileToolCallView } from "./mobile-tool-call";

export type MobilePartnerWorkingPhase = WorkingPhase | "reconnecting" | "model-busy" | "rate-limit";
export interface MobilePartnerWorkingStatus {
  readonly turnKey: string;
  readonly phase: MobilePartnerWorkingPhase;
}

/** The current canonical Run supplies facts even while the user reads an older message window. */
export function mobilePartnerWorkingStatus(partner: MobilePartnerDirectoryProfile | undefined,
  observation: MobilePartnerDirectoryObservation | undefined, events: readonly Event[]): MobilePartnerWorkingStatus | undefined {
  if (!partner || !observation?.online || partner.lifecycle !== "active" || partner.initializationState !== "ready") return undefined;
  const activity = mobilePartnerActivityState(partner, observation);
  if (!["working", "recovering", "compacting"].includes(activity)) return undefined;
  const session = observation.snapshot.sessions.find((entry) => entry.sessionId === partner.canonicalSessionId)!;
  const generation = session.version!.generation;
  const runs = observation.snapshot.runs.filter((run) => run.sessionId === session.sessionId
    && run.targetId === session.targetId && run.backendId === session.backendId && run.version?.generation === generation
    && [RunState.DISPATCHING, RunState.DISPATCH_UNKNOWN, RunState.RUNNING, RunState.WAITING, RunState.RETRYING].includes(run.state));
  if (runs.length > 1 || runs[0]?.state === RunState.WAITING) return undefined;
  const run = runs[0];
  let phase: WorkingPhase = run ? "thinking" : "processing";
  let retry: MobilePartnerWorkingPhase | undefined = activity === "recovering" ? retryPhase(run?.error?.code) : undefined;
  let blocked = false;
  let compacting = activity === "compacting";
  const waitingTools = new Set<string>();
  const tools = new Map<string, MobileToolCallView>();
  const seen = new Set<string>();
  const ordered = [...events].sort((a, b) => (a.cursor?.sequence ?? 0n) < (b.cursor?.sequence ?? 0n) ? -1
    : (a.cursor?.sequence ?? 0n) > (b.cursor?.sequence ?? 0n) ? 1 : 0);
  for (const event of ordered) {
    const identity = event.identity;
    if (!run || !event.eventId || seen.has(event.eventId) || identity?.sessionId !== session.sessionId
      || identity.targetId !== session.targetId || identity.backendId !== session.backendId
      || identity.generation !== generation || event.cursor?.generation !== generation || event.cursor.sequence < 1n
      || identity.runId !== run.runId || identity.attemptId !== run.activeAttemptId) continue;
    seen.add(event.eventId);
    const kind = event.payload?.kind;
    switch (kind?.case) {
      case "runDone": case "runAborted": case "terminalError": return undefined;
      case "recoverableError": blocked = true; break;
      case "interactionChanged":
        if (kind.value.interaction?.sessionId === session.sessionId && kind.value.interaction.generation === generation) {
          blocked = kind.value.interaction.state === InteractionState.PENDING;
        }
        break;
      case "retryChanged":
        if (kind.value.runId !== run.runId || kind.value.attemptId !== run.activeAttemptId) break;
        if (kind.value.state === RetryState.ABORTED || kind.value.state === RetryState.EXHAUSTED) return undefined;
        if (kind.value.state === RetryState.WAITING) { retry = retryPhase(kind.value.error?.code); blocked = false; }
        if (kind.value.state === RetryState.STARTED || kind.value.state === RetryState.SUCCEEDED) { retry = undefined; blocked = false; }
        break;
      case "compactionChanged":
        if (session.contextState?.compacting === undefined) compacting = kind.value.state === CompactionState.STARTED;
        break;
      case "messageStarted":
        if (kind.value.role === MessageRole.USER) { phase = "thinking"; tools.clear(); waitingTools.clear(); }
        break;
      case "textDelta": if (kind.value.delta.trim()) phase = "replying"; break;
      case "messageCompleted":
        if (kind.value.role === MessageRole.ASSISTANT && kind.value.blocks.some((block) =>
          block.content.case === "text" && block.content.value.trim() !== "")) phase = "replying";
        break;
      case "toolCallStarted": case "toolCallUpdated": case "toolCallCompleted": {
        const call = projectMobileToolCall(event);
        if (!call) break;
        const previous = tools.get(call.scopeKey);
        const current = projectMobileToolCall(event, previous)!;
        const toolPhase = publicToolWorkingPhase(current.name, current.input,
          current.inputRedacted || current.inputTruncated);
        tools.set(call.scopeKey, current);
        if (current.state === "waiting") waitingTools.add(current.scopeKey);
        else {
          waitingTools.delete(current.scopeKey);
          phase = ["succeeded", "failed", "aborted"].includes(current.state) ? publicToolResultWorkingPhase(toolPhase) : toolPhase;
        }
        break;
      }
    }
  }
  if (blocked || waitingTools.size > 0) return undefined;
  return { turnKey: JSON.stringify([observation.ownerKey, session.sessionId, generation.toString(), run?.runId ?? "", run?.activeAttemptId ?? ""]),
    phase: retry ?? (compacting ? "compacting" : phase) };
}

function retryPhase(code: string | undefined): MobilePartnerWorkingPhase {
  if (["RATE_LIMITED", "rate_limited", "rate_limit_error", "429"].includes(code ?? "")) return "rate-limit";
  if (["OVERLOADED", "overloaded_error", "MODEL_OVERLOADED", "at_capacity"].includes(code ?? "")) return "model-busy";
  return "reconnecting";
}
