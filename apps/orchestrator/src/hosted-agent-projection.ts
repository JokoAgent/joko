import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { AdapterContext, AdapterEventMetadata, DurableNativeDispatchPreparation, EventPayload,
  InteractionPayload, NativeHistoryProjection, NativeSessionBinding, NativeSessionState, PiEventMetadata } from "@joko/core";
import { pathTextContext, type ExecutorWorkspace, type PathTextContext } from "./hosted-agent-workspace.js";

const URL_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s\x60"'<>()[\]{}]+/giu;
const IDENTITY_FIELDS = new Set(["id", "blockId", "toolCallId", "toolUseId", "toolUseIds", "runId", "taskId", "parentTaskId",
  "sessionId", "targetId", "backendId", "nativeSessionId", "opaqueRef", "entryId", "nativeEntryId", "nativeParentEntryId",
  "parentEntryId", "parentId", "leafId", "activeEntryId", "activeLeafId", "requestId", "interactionId", "modelId", "providerId",
  "toolName", "lastToolName", "identityAliases", "providerRunIds", "logicalAgentId", "projectionKind", "sha256",
  "inputFingerprint", "data", "base64", "bytes"]);

/** Original-task projection. A native binding belongs to the Source Adapter;
 * the Provider's JSONL path is useful only inside its private native journal. */
export class HostedAgentProjection {
  readonly #workspace: ExecutorWorkspace;
  readonly #context: Pick<AdapterContext, "sessionId" | "target">;
  readonly #binding: () => NativeSessionBinding;
  constructor(workspace: ExecutorWorkspace, context: Pick<AdapterContext, "sessionId" | "target">, binding: () => NativeSessionBinding) {
    this.#workspace = workspace; this.#context = context; this.#binding = binding;
  }
  binding(): NativeSessionBinding { return { ...this.#binding() }; }
  state(value: NativeSessionState): NativeSessionState {
    const projected = this.value(value);
    return { ...projected, binding: this.binding(), ...(value.pi === undefined ? {} : { pi: this.#nativeState(value.pi) }) };
  }
  event(event: EventPayload): EventPayload {
    if (event.type === "native_session_changed") {
      const binding = this.binding();
      return { type: event.type, opaqueRef: binding.opaqueRef,
        ...(binding.nativeSessionId === undefined ? {} : { nativeSessionId: binding.nativeSessionId }),
        ...(event.leafId === undefined ? {} : { leafId: event.leafId }) };
    }
    const projected = this.value(event);
    if (projected.type === "subagent_run") return { ...projected, run: { ...projected.run, sessionId: this.#context.sessionId } };
    return projected;
  }
  history(history: NativeHistoryProjection): NativeHistoryProjection {
    return { ...history, events: history.events.map(event => ({ ...event, payload: this.event(event.payload),
      ...(event.metadata === undefined ? {} : { metadata: this.metadata(event.metadata) }) })),
      ...(history.activeEntryMetadata === undefined ? {} : { activeEntryMetadata: this.metadata(history.activeEntryMetadata) }) };
  }
  dispatch(preparation: DurableNativeDispatchPreparation): DurableNativeDispatchPreparation {
    return { inputFingerprint: preparation.inputFingerprint, nativeHistory: this.history(preparation.nativeHistory) };
  }
  interaction(request: InteractionPayload): InteractionPayload {
    // Permission and question receipts identify the exact native request. Only
    // plan display text has Source file references to restore before review.
    if (request.kind !== "plan_review") return request;
    return this.value(request);
  }
  metadata(metadata: AdapterEventMetadata): AdapterEventMetadata {
    return { ...metadata, ...(metadata.pi === undefined ? {} : { pi: this.#pi(metadata.pi) }) };
  }
  value<T>(value: T): T { return this.#value(value) as T; }
  #value(value: unknown, key = ""): unknown {
    if (typeof value === "string") return this.#text(value, pathTextContext(key));
    if (Array.isArray(value)) return value.map(item => this.#value(item, key));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, IDENTITY_FIELDS.has(field) ? item : this.#value(item, field)]));
  }
  #text(value: string, context: PathTextContext): string {
    const alias = this.#workspace.mapAlias(value);
    if (alias !== value && (context === "path" || ((context === "untyped" || context === "ambiguous-path") && existsSync(alias)))) return alias;
    const pieces: string[] = []; let end = 0;
    for (const match of value.matchAll(URL_TEXT)) {
      pieces.push(this.#workspace.mapTextFromAgent(value.slice(end, match.index), context), this.#url(match[0]));
      end = match.index! + match[0].length;
    }
    pieces.push(this.#workspace.mapTextFromAgent(value.slice(end), context)); return pieces.join("");
  }
  #url(value: string): string {
    try {
      const url = new URL(value); if (url.protocol !== "file:") return value;
      const remote = url.hostname ? "//" + url.hostname + decodeURIComponent(url.pathname) : decodeURIComponent(url.pathname).replace(/^\/(?=[A-Za-z]:[\\/])/u, "");
      const local = this.#workspace.mapAlias(remote); if (local === remote) return value;
      const result = pathToFileURL(local); result.search = url.search; result.hash = url.hash; return result.href;
    } catch { return value; }
  }
  #nativeState(value: NonNullable<NativeSessionState["pi"]>): NonNullable<NativeSessionState["pi"]> {
    return { ...value, nativeSessionId: this.#binding().nativeSessionId ?? "", nativeSessionFileDisplay: "" };
  }
  #pi(pi: PiEventMetadata): PiEventMetadata {
    const payload = pi.payload;
    switch (payload.case) {
      case "nativeState": return { ...pi, payload: { ...payload, value: this.#nativeState(payload.value) } };
      case "sessionIdentityUpdate": return { ...pi, payload: { ...payload, value: { ...payload.value,
        previousNativeSessionId: payload.value.previousNativeSessionId ? this.#binding().nativeSessionId ?? "" : "",
        nativeSessionId: this.#binding().nativeSessionId ?? "", nativeSessionFileDisplay: "" } } };
      case "sessionTreeUpdate": return { ...pi, payload: { ...payload, value: { ...this.value(payload.value), nativeSessionId: this.#binding().nativeSessionId ?? "" } } };
      case "resourceUpdate": return { ...pi, payload: { ...payload, value: { ...this.value(payload.value),
        resource: { ...this.value(payload.value.resource), targetId: this.#context.target.id } } } };
      default: return this.value(pi);
    }
  }
}
