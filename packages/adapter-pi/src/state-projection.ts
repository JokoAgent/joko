import { win32 } from "node:path";

import { redactSecrets, type PiNativeStateMetadata } from "@joko/core";

import type { PiRpcModel, PiRpcState } from "./protocol.js";

const MAX_IDENTIFIER = 512;
const MAX_DISPLAY = 2_048;

/**
 * Convert one successful get_state plus Adapter-owned runtime controls into
 * the closed Pi state payload. Values are bounded before they can enter a
 * durable Orchestrator observation.
 */
export function projectPiNativeState(
  state: PiRpcState,
  controls: { readonly autoRetry: boolean; readonly activeLeafId?: string }
): PiNativeStateMetadata {
  const model = state.model as unknown as PiRpcModel | undefined;
  return {
    nativeSessionId: safeText(state.sessionId, MAX_IDENTIFIER),
    nativeSessionName: safeText(state.sessionName ?? "", MAX_DISPLAY, true),
    nativeSessionFileDisplay: state.sessionFile === undefined
      ? ""
      : safeText(win32.basename(state.sessionFile), MAX_DISPLAY, true),
    ...(model === undefined
      ? {}
      : {
          model: {
            providerId: safeText(model.provider, MAX_IDENTIFIER),
            modelId: safeText(model.id, MAX_IDENTIFIER)
          }
        }),
    thinkingLevel: safeText(state.thinkingLevel, MAX_IDENTIFIER, true),
    streaming: state.isStreaming === true,
    compacting: state.isCompacting === true,
    steeringMode: state.steeringMode === "all" ? "all" : "one_at_a_time",
    followUpMode: state.followUpMode === "all" ? "all" : "one_at_a_time",
    autoCompaction: state.autoCompactionEnabled === true,
    autoRetry: controls.autoRetry,
    messageCount: safeCount(state.messageCount),
    pendingMessageCount: safeCount(state.pendingMessageCount),
    activeLeafId: safeText(controls.activeLeafId ?? "", MAX_IDENTIFIER, true)
  };
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeText(value: unknown, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string") return "";
  const text = redactSecrets(value).slice(0, maximum).trim();
  return allowEmpty || text !== "" ? text : "";
}
