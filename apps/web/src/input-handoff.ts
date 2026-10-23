import { InputHandoffStatePhase, inputHandoffPresentation, type InputHandoffDecision, type InputHandoffPicture,
  type InputHandoffSnapshot, type InputHandoffState, type InputHandoffSubmission } from "@joko/contracts";

export interface InputHandoffApi {
  listInputHandoffs(sessionId: string, signal?: AbortSignal): Promise<readonly InputHandoffSnapshot[]>;
  decideInputHandoff(requestId: string, decision: InputHandoffDecision, signal?: AbortSignal): Promise<boolean>;
  submitInputHandoff(snapshot: InputHandoffSnapshot, submission: InputHandoffSubmission, signal?: AbortSignal): Promise<boolean>;
  readInputHandoffPicture(snapshot: InputHandoffSnapshot, signal?: AbortSignal): Promise<InputHandoffPicture | null>;
  openInputHandoffLiveView?(snapshot: InputHandoffSnapshot, signal?: AbortSignal): Promise<void>;
}
const phases: Readonly<Partial<Record<InputHandoffStatePhase, InputHandoffSnapshot["phase"]>>> = {
  [InputHandoffStatePhase.READING]: "reading", [InputHandoffStatePhase.READY]: "ready", [InputHandoffStatePhase.WORKING]: "working",
  [InputHandoffStatePhase.FINISHING]: "finishing", [InputHandoffStatePhase.SUCCEEDED]: "succeeded", [InputHandoffStatePhase.CANCELLED]: "cancelled",
  [InputHandoffStatePhase.FAILED]: "failed", [InputHandoffStatePhase.EXPIRED]: "expired"
};
export function inputHandoffSnapshotFromProto(value: InputHandoffState): InputHandoffSnapshot {
  const phase = phases[value.phase];
  if (!phase || !value.source || !value.requestId || value.controls.length > 40 || value.revision > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid input handoff state.");
  const snapshot: InputHandoffSnapshot = {
    kind: "input_handoff", requestId: value.requestId, revision: Number(value.revision), phase, purpose: value.purpose,
    source: { app: value.source.app, ...(value.source.window === undefined ? {} : { window: value.source.window }),
      ...(value.source.origin === undefined ? {} : { origin: value.source.origin }), ...(value.source.warning === undefined ? {} : { warning: value.source.warning as NonNullable<InputHandoffSnapshot["source"]["warning"]> }) },
    stepNumber: value.stepNumber,
    controls: value.controls.map(control => {
      if (control.control.case === "errorNote") return { id: control.id, kind: "note" as const, text: control.control.value, tone: "error" as const };
      if (control.control.case !== "text") throw new Error("Invalid input handoff control.");
      const text = control.control.value;
      if (!["text", "username", "email", "tel", "url", "number", "password", "one-time-code", "search"].includes(text.contentType)) throw new Error("Invalid input handoff field.");
      return { id: control.id, kind: "text" as const, label: text.label, contentType: text.contentType as Extract<InputHandoffSnapshot["controls"][number], { kind: "text" }>["contentType"],
        ...(text.placeholder === undefined ? {} : { placeholder: text.placeholder }), ...(text.multiline ? { multiline: true as const } : {}), ...(text.filled ? { filled: true as const } : {}),
        ...(text.suggestions.length ? { suggestions: text.suggestions.map(item => ({ id: item.id, label: item.label })) } : {}) };
    }),
    ...(value.note === undefined ? {} : { note: value.note }), ...(value.requester === undefined ? {} : { requester: value.requester }), ...(value.command === undefined ? {} : { command: value.command }),
    ...(value.holder ? { holder: { ...(value.holder.local ? { local: true as const } : {}), ...(value.holder.deviceId === undefined ? {} : { deviceId: value.holder.deviceId }),
      ...(value.holder.name === undefined ? {} : { name: value.holder.name }), ...(["mobile", "desktop"].includes(value.holder.platform ?? "") ? { platform: value.holder.platform as "mobile" | "desktop" } : {}) } } : {}),
    ...(value.finishingUntilMs === undefined ? {} : { finishingUntil: Number(value.finishingUntilMs) }), ...(value.failure === undefined ? {} : { failure: value.failure as InputHandoffSnapshot["failure"] }),
    ...(value.agentControlled ? { agentControlled: true as const } : {}), ...(value.remoteInput ? { remoteInput: true as const } : {}), ...(value.terminal ? { terminal: true as const } : {}),
    ...(value.picture ? { picture: true as const } : {}), ...(value.liveView ? { liveView: true as const } : {}), ...(value.deviceCode ? { deviceCode: { code: value.deviceCode.code, url: value.deviceCode.url, origin: value.deviceCode.origin } } : {}),
    ...(["scan", "scanned"].includes(value.qr ?? "") ? { qr: value.qr as "scan" | "scanned" } : {})
  };
  return snapshot;
}
/** Exact presentation digest; secrets and pixels do not participate. */
export async function inputHandoffPresentationDigest(snapshot: InputHandoffSnapshot): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(inputHandoffPresentation(snapshot))), hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join("");
}
