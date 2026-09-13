import { PermissionDecisionKind } from "@joko/contracts";
import type { AppController } from "./controller.js";
import type { InteractionView, Locale, SessionView, TimelineItemView } from "./model.js";

export interface NativeTaskStatusProjectionInput {
  readonly ownerId: string;
  readonly revision: bigint;
  readonly locale: Locale;
  readonly sessions: readonly SessionView[];
  readonly interactions: readonly InteractionView[];
  readonly timelineBySession: ReadonlyMap<string, readonly TimelineItemView[]>;
}

export function projectNativeTaskStatusSnapshot(
  input: NativeTaskStatusProjectionInput
): JokoDesktopNativeTaskStatusSnapshot {
  const interactionsBySession = new Map<string, InteractionView[]>();
  for (const interaction of input.interactions) {
    const session = input.sessions.find((candidate) => candidate.id === interaction.sessionId);
    if (session === undefined || session.generation !== interaction.generation) continue;
    const bucket = interactionsBySession.get(interaction.sessionId) ?? [];
    bucket.push(interaction);
    interactionsBySession.set(interaction.sessionId, bucket);
  }
  const sessions = input.sessions.flatMap((session) => {
    const interaction = (interactionsBySession.get(session.id) ?? [])
      .slice()
      .sort((left, right) => interactionPriority(left.kind) - interactionPriority(right.kind) ||
        left.createdAt - right.createdAt)[0];
    const phase = nativeTaskPhase(session, interaction);
    if (phase === undefined) return [];
    const title = boundedDisplayText(interaction?.title || session.name || "Untitled task", 160);
    const detail = boundedDisplayText(interaction?.message || session.summary || "", 600);
    const permission = interaction?.kind === "permission"
      ? nativePermissionProjection(interaction)
      : undefined;
    const activityLines = nativeTaskStatusActivityLines(input.timelineBySession.get(session.id) ?? []);
    return [{
      sessionId: session.id,
      title,
      detail,
      phase,
      ...(interaction === undefined ? {} : { interactionKind: interaction.kind }),
      activityLines,
      ...(session.activeRunStartedAt === undefined ? {} : { startedAt: session.activeRunStartedAt }),
      updatedAt: Math.max(session.updatedAt, session.attention?.updatedAt ?? 0, interaction?.createdAt ?? 0),
      ...(permission === undefined ? {} : { permission })
    } satisfies JokoDesktopNativeTaskStatusSnapshot["sessions"][number]];
  });
  return {
    ownerId: input.ownerId,
    revision: input.revision.toString(),
    locale: input.locale,
    sessions
  };
}

function nativeTaskStatusActivityLines(
  timeline: readonly TimelineItemView[]
): JokoDesktopNativeTaskStatusSnapshot["sessions"][number]["activityLines"] {
  return timeline.flatMap((item) => {
    const projection = nativeTaskStatusActivityLine(item);
    return projection === undefined ? [] : [projection];
  }).slice(-3);
}

function nativeTaskStatusActivityLine(
  item: TimelineItemView
): JokoDesktopNativeTaskStatusSnapshot["sessions"][number]["activityLines"][number] | undefined {
  const kind = item.kind === "user"
    ? "user"
    : item.kind === "assistant" || item.kind === "thinking"
      ? "assistant"
      : item.kind === "tool" || item.kind === "toolResult"
        ? "tool"
        : item.kind === "status" || item.kind === "error" || item.kind === "interaction" ||
          item.kind === "background" || item.kind === "review"
          ? "status"
          : undefined;
  if (kind === undefined) return undefined;
  const rawText = kind === "tool" ? item.tool?.name ?? item.title ?? "" : item.text ?? item.title ?? "";
  const text = boundedDisplayText(rawText, 300);
  if (text === "") return undefined;
  return { id: boundedIdentity(item.id), kind, text };
}

export async function resolveNativeTaskStatusPermissionAction(
  controller: Pick<AppController, "state" | "resolveInteraction">,
  action: JokoDesktopNativeTaskStatusAction
): Promise<boolean> {
  if (action.kind !== "permission") return false;
  const interaction = controller.state.snapshot.interactions.find((candidate) =>
    candidate.id === action.interactionId &&
    candidate.sessionId === action.sessionId &&
    candidate.generation.toString() === action.generation &&
    candidate.kind === "permission"
  );
  if (interaction === undefined) return false;
  const session = controller.state.snapshot.sessions.find((candidate) => candidate.id === action.sessionId);
  if (session === undefined || session.generation !== interaction.generation) return false;
  const decisionId = permissionDecisionId(action.decision);
  if (!interaction.options.some((option) => option.id === decisionId)) return false;
  await controller.resolveInteraction(interaction, { kind: "permission", decisionId });
  return true;
}

function nativeTaskPhase(
  session: SessionView,
  interaction: InteractionView | undefined
): JokoDesktopNativeTaskStatusPhase | undefined {
  if (interaction !== undefined || session.attention?.kind === "awaiting" && session.attention.unread) {
    return "interaction";
  }
  if (session.state === "error" || session.attention?.kind === "error" && session.attention.unread) return "error";
  if (session.attention?.kind === "done" && session.attention.unread) return "completed";
  if (session.state === "running" || session.state === "waiting" || session.state === "retrying") return "running";
  return undefined;
}

function nativePermissionProjection(
  interaction: InteractionView
): NonNullable<JokoDesktopNativeTaskStatusSnapshot["sessions"][number]["permission"]> {
  const decisions = new Set(interaction.options.map((option) => option.id));
  return {
    interactionId: interaction.id,
    generation: interaction.generation.toString(),
    allow: decisions.has(String(PermissionDecisionKind.ALLOW_ONCE)),
    allowForSession: decisions.has(String(PermissionDecisionKind.ALLOW_FOR_SESSION)),
    deny: decisions.has(String(PermissionDecisionKind.DENY_ONCE))
  };
}

function permissionDecisionId(decision: JokoDesktopNativeTaskStatusDecision): string {
  if (decision === "allow") return String(PermissionDecisionKind.ALLOW_ONCE);
  if (decision === "allowForSession") return String(PermissionDecisionKind.ALLOW_FOR_SESSION);
  return String(PermissionDecisionKind.DENY_ONCE);
}

function interactionPriority(kind: InteractionView["kind"]): number {
  if (kind === "plan") return 0;
  if (kind === "permission") return 1;
  if (kind === "question") return 2;
  return 3;
}

function boundedDisplayText(value: string, maximum: number): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").trim().slice(0, maximum);
}

function boundedIdentity(value: string): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 256);
  return sanitized === "" ? "activity" : sanitized;
}
