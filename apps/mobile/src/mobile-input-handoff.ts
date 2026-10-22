import { base64Encode } from "@bufbuild/protobuf/wire";
import { createClient, type Transport } from "@connectrpc/connect";
import {
  InputHandoffDecisionKind, InputHandoffService, InputHandoffStatePhase, inputHandoffPresentation,
  parseInputHandoffPicture, parseInputHandoffSubmission, validateInputHandoffSubmissionForStep,
  type CredentialUploadTicket, type InputHandoffDecision, type InputHandoffPicture,
  type InputHandoffSnapshot, type InputHandoffState, type InputHandoffSubmission
} from "@joko/contracts";
import type { PairedCredential } from "./network";

export interface MobileInputHandoffScope {
  readonly ownerKey: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly signal: AbortSignal;
  readonly assertCurrent: (signal: AbortSignal) => void;
}
export interface MobileInputHandoffApi {
  readonly ownerKey: string;
  readonly sessionId: string;
  readonly deviceId: string;
  isCurrent(): boolean;
  list(signal: AbortSignal): Promise<readonly InputHandoffSnapshot[]>;
  decide(snapshot: InputHandoffSnapshot, action: InputHandoffDecision["action"], signal: AbortSignal): Promise<boolean>;
  submit(snapshot: InputHandoffSnapshot, submission: InputHandoffSubmission, signal: AbortSignal): Promise<boolean>;
  picture(snapshot: InputHandoffSnapshot, signal: AbortSignal): Promise<InputHandoffPicture>;
}
export interface MobileInputHandoffTask {
  readonly sessionId: string; readonly requestId: string; readonly generation: bigint; readonly stepNumber: number;
}
export interface MobileInputHandoffTasksApi {
  readonly ownerKey: string;
  isCurrent(): boolean;
  list(signal: AbortSignal): Promise<readonly MobileInputHandoffTask[]>;
}
export async function readMobileInputHandoffTasks(transport: Transport, signal: AbortSignal): Promise<readonly MobileInputHandoffTask[]> {
  const value = await createClient(InputHandoffService, transport).listInputHandoffTasks({}, { signal }); signal.throwIfAborted();
  if (value.tasks.length > 10_000) throw new Error("Invalid input handoff subjects.");
  return value.tasks.map(task => {
    if (![task.sessionId, task.requestId].every(id => id.length > 0 && id.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(id))
      || task.generation < 0n || task.stepNumber < 1) throw new Error("Invalid input handoff subject.");
    return { sessionId: task.sessionId, requestId: task.requestId, generation: task.generation, stepNumber: task.stepNumber };
  });
}

/** Expo's native SHA-256 hashes the exact UTF-8 presentation; no Web Crypto assumption. */
export async function mobileInputHandoffPresentationDigest(snapshot: InputHandoffSnapshot): Promise<string> {
  const { CryptoDigestAlgorithm, CryptoEncoding, digestStringAsync } = await import("expo-crypto");
  return digestStringAsync(CryptoDigestAlgorithm.SHA256, JSON.stringify(inputHandoffPresentation(snapshot)), { encoding: CryptoEncoding.HEX });
}

/** Owner credentials and field values are kept out of the normal operation queue. */
export function createMobileInputHandoffApi(options: {
  readonly transport: Transport;
  readonly credential: PairedCredential;
  readonly scope: MobileInputHandoffScope;
  readonly fetch?: typeof fetch;
}): MobileInputHandoffApi {
  const client = createClient(InputHandoffService, options.transport), scope = options.scope;
  const kinds = { done: InputHandoffDecisionKind.DONE, cancel: InputHandoffDecisionKind.CANCEL, stay: InputHandoffDecisionKind.STAY,
    refresh: InputHandoffDecisionKind.REFRESH, claim: InputHandoffDecisionKind.CLAIM, picture: InputHandoffDecisionKind.PICTURE };
  const invoke = async <T>(signal: AbortSignal, work: (signal: AbortSignal, current: () => void) => Promise<T>): Promise<T> => {
    const active = AbortSignal.any([signal, scope.signal]);
    const current = () => { active.throwIfAborted(); scope.assertCurrent(active); };
    current(); const value = await work(active, current); current(); return value;
  };
  return {
    ownerKey: scope.ownerKey, sessionId: scope.sessionId, deviceId: scope.deviceId,
    isCurrent: () => { try { scope.signal.throwIfAborted(); scope.assertCurrent(scope.signal); return true; } catch { return false; } },
    list: signal => invoke(signal, async active => (await client.listInputHandoffs({ sessionId: scope.sessionId }, { signal: active })).states.map(mobileInputHandoffSnapshot)),
    decide: (snapshot, action, signal) => invoke(signal, async active => (await client.decideInputHandoff({ requestId: snapshot.requestId,
      expectedRevision: BigInt(snapshot.revision), decision: kinds[action] }, { signal: active })).accepted),
    submit: (snapshot, submission, signal) => invoke(signal, async (active, current) => {
      if (snapshot.remoteInput !== true) return false;
      const exact = parseInputHandoffSubmission(submission);
      try {
        if (!validateInputHandoffSubmissionForStep(snapshot, exact)) return false;
        const presentationSha256 = await mobileInputHandoffPresentationDigest(snapshot); current();
        const response = await client.beginInputHandoffSubmission({ requestId: snapshot.requestId,
          expectedRevision: BigInt(snapshot.revision), presentationSha256 }, { signal: active }); current();
        const credentialUploadTicketId = await uploadPrivateInput(options.credential, exact, response.ticket, active, current, options.fetch ?? fetch); current();
        return (await client.submitInputHandoff({ requestId: snapshot.requestId, expectedRevision: BigInt(snapshot.revision), credentialUploadTicketId }, { signal: active })).accepted;
      } finally { for (const id of Object.keys(exact.values)) delete exact.values[id]; }
    }),
    picture: (snapshot, signal) => invoke(signal, async (active, current) => {
      const presentationSha256 = await mobileInputHandoffPresentationDigest(snapshot); current();
      const value = await client.readInputHandoffPicture({ requestId: snapshot.requestId, expectedRevision: BigInt(snapshot.revision), presentationSha256 }, { signal: active }); current();
      return parseInputHandoffPicture({ mime: "image/jpeg", data: base64Encode(value.jpeg), width: value.width, height: value.height,
        ...(value.qrText === undefined ? {} : { qr: { text: value.qrText, ...(value.qrUrl === undefined ? {} : { url: value.qrUrl }) } }) });
    })
  };
}

async function uploadPrivateInput(credential: PairedCredential, submission: InputHandoffSubmission, ticket: CredentialUploadTicket | undefined,
  signal: AbortSignal, current: () => void, send: typeof fetch): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(submission));
  try {
    const expiry = ticket?.expiresAt;
    if (!ticket?.ticketId || !expiry || !Number.isSafeInteger(Number(expiry.seconds)) || expiry.nanos < 0 || expiry.nanos >= 1_000_000_000
      || Number(expiry.seconds) * 1000 + Math.floor(expiry.nanos / 1_000_000) <= Date.now()
      || bytes.length === 0 || BigInt(bytes.length) > ticket.maximumBytes || bytes.length > 128 * 1024) throw new Error("The private input channel is unavailable.");
    const relative = ticket.relativeEndpoint, base = new URL(credential.origin), endpoint = new URL(relative, base);
    if (!relative.startsWith("/") || relative.startsWith("//") || /[\\?#]/u.test(relative) || endpoint.origin !== base.origin
      || endpoint.pathname !== relative || endpoint.username || endpoint.password) throw new Error("The private input channel is unavailable.");
    current();
    const response = await send(endpoint.toString(), { method: "PUT", headers: { authorization: `Bearer ${credential.authKey}`, "content-type": "application/octet-stream" },
      body: bytes, signal, cache: "no-store", redirect: "error" }); current();
    if (!response.ok) throw new Error("The private input upload could not be confirmed.");
    return ticket.ticketId;
  } finally { bytes.fill(0); }
}

const phases: Readonly<Partial<Record<InputHandoffStatePhase, InputHandoffSnapshot["phase"]>>> = {
  [InputHandoffStatePhase.READING]: "reading", [InputHandoffStatePhase.READY]: "ready", [InputHandoffStatePhase.WORKING]: "working",
  [InputHandoffStatePhase.FINISHING]: "finishing", [InputHandoffStatePhase.SUCCEEDED]: "succeeded", [InputHandoffStatePhase.CANCELLED]: "cancelled",
  [InputHandoffStatePhase.FAILED]: "failed", [InputHandoffStatePhase.EXPIRED]: "expired"
};
export function mobileInputHandoffSnapshot(value: InputHandoffState): InputHandoffSnapshot {
  const phase = phases[value.phase];
  if (!phase || !value.source || !value.requestId || value.controls.length > 40 || value.revision > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid input handoff state.");
  return { kind: "input_handoff", requestId: value.requestId, revision: Number(value.revision), phase, purpose: value.purpose,
    source: { app: value.source.app, ...(value.source.window === undefined ? {} : { window: value.source.window }),
      ...(value.source.origin === undefined ? {} : { origin: value.source.origin }),
      ...(value.source.warning === undefined ? {} : { warning: value.source.warning as NonNullable<InputHandoffSnapshot["source"]["warning"]> }) },
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
    ...(value.picture ? { picture: true as const } : {}), ...(value.liveView ? { liveView: true as const } : {}),
    ...(value.deviceCode ? { deviceCode: { code: value.deviceCode.code, url: value.deviceCode.url, origin: value.deviceCode.origin } } : {}),
    ...(["scan", "scanned"].includes(value.qr ?? "") ? { qr: value.qr as "scan" | "scanned" } : {}) };
}
