import { Buffer } from "node:buffer";

import type { PolicyObservation, PolicyRuleEffect } from "@joko/core";

export const POLICY_DECISION_REQUEST_PREFIX = "joko:policy-decision/v1/";
export const MAXIMUM_POLICY_DECISION_ENVELOPE_CHARACTERS = 8 * 1024;
export const MAXIMUM_POLICY_WORKSPACE_RELATIVE_PATH_CHARACTERS = 4_096;
export const MAXIMUM_POLICY_IDENTIFIER_CHARACTERS = 256;

export interface PolicyDecisionRequest {
  readonly policyGeneration: number;
  readonly observation: PolicyObservation;
}

export type PolicyDecisionResult = PolicyRuleEffect | "default" | "stale";

type PolicyDecisionTransport = {
  readonly closed: boolean;
  notify(message:
    | { readonly type: "extension_ui_response"; readonly id: string; readonly value: string }
    | { readonly type: "extension_ui_response"; readonly id: string; readonly cancelled: true }
  ): Promise<void>;
};

export async function handlePolicyDecisionExtensionRequest(
  event: Readonly<Record<string, unknown>>,
  options: {
    readonly decide: (request: PolicyDecisionRequest) => Promise<PolicyDecisionResult>;
    readonly transport: PolicyDecisionTransport;
    readonly isCurrent: () => boolean;
  }
): Promise<boolean> {
  if (event["method"] !== "input" || typeof event["title"] !== "string"
      || !event["title"].startsWith(POLICY_DECISION_REQUEST_PREFIX)) return false;
  const requestId = typeof event["id"] === "string" ? event["id"] : "";
  const request = parsePolicyDecisionRequest(event["title"]);
  if (requestId === "" || request === undefined) {
    await respond(options, requestId, { cancelled: true });
    return true;
  }
  let result: PolicyDecisionResult;
  try {
    result = await options.decide(request);
  } catch {
    await respond(options, requestId, { cancelled: true });
    return true;
  }
  await respond(options, requestId, { value: result });
  return true;
}

export function encodePolicyDecisionRequest(request: PolicyDecisionRequest): string {
  const payload = Buffer.from(JSON.stringify({
    format: 1,
    policyGeneration: request.policyGeneration,
    ...request.observation
  }), "utf8").toString("base64url");
  if (payload.length > MAXIMUM_POLICY_DECISION_ENVELOPE_CHARACTERS) {
    throw new Error("Policy decision request exceeds its bounded envelope");
  }
  const encoded = `${POLICY_DECISION_REQUEST_PREFIX}${payload}`;
  if (parsePolicyDecisionRequest(encoded) === undefined) {
    throw new Error("Policy decision request contains an invalid bounded observation");
  }
  return encoded;
}

function parsePolicyDecisionRequest(value: string): PolicyDecisionRequest | undefined {
  const encoded = value.slice(POLICY_DECISION_REQUEST_PREFIX.length);
  if (
    encoded.length < 1
    || encoded.length > MAXIMUM_POLICY_DECISION_ENVELOPE_CHARACTERS
    || !/^[A-Za-z0-9_-]+$/u.test(encoded)
  ) return undefined;
  let parsed: unknown;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) return undefined;
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed["format"] !== 1) return undefined;
  const policyGeneration = parsed["policyGeneration"];
  const subjectKind = parsed["subjectKind"];
  const risk = parsed["risk"];
  if (typeof policyGeneration !== "number" || !Number.isSafeInteger(policyGeneration) || policyGeneration < 0) return undefined;
  if (!POLICY_SUBJECTS.has(subjectKind) || !POLICY_RISKS.has(risk)) return undefined;
  const workspaceRelativePath = boundedString(
    parsed["workspaceRelativePath"],
    MAXIMUM_POLICY_WORKSPACE_RELATIVE_PATH_CHARACTERS
  );
  const toolProviderId = boundedString(parsed["toolProviderId"], MAXIMUM_POLICY_IDENTIFIER_CHARACTERS);
  const toolName = boundedString(parsed["toolName"], MAXIMUM_POLICY_IDENTIFIER_CHARACTERS);
  if ((parsed["workspaceRelativePath"] !== undefined && workspaceRelativePath === undefined)
      || (parsed["toolProviderId"] !== undefined && toolProviderId === undefined)
      || (parsed["toolName"] !== undefined && toolName === undefined)) return undefined;
  return {
    policyGeneration,
    observation: {
      subjectKind: subjectKind as PolicyObservation["subjectKind"],
      risk: risk as PolicyObservation["risk"],
      ...(workspaceRelativePath === undefined ? {} : { workspaceRelativePath }),
      ...(toolProviderId === undefined ? {} : { toolProviderId }),
      ...(toolName === undefined ? {} : { toolName })
    }
  };
}

const POLICY_SUBJECTS = new Set<unknown>([
  "file_read", "file_write", "command", "network", "mcp", "browser", "resource", "extra_directory"
]);
const POLICY_RISKS = new Set<unknown>(["read_only", "low", "medium", "high", "critical"]);

function boundedString(value: unknown, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "" || [...value].length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    return undefined;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function respond(
  options: { readonly transport: PolicyDecisionTransport; readonly isCurrent: () => boolean },
  requestId: string,
  result: { readonly value: string } | { readonly cancelled: true }
): Promise<void> {
  if (requestId === "" || !options.isCurrent() || options.transport.closed) return;
  await options.transport.notify({ type: "extension_ui_response", id: requestId, ...result });
}
