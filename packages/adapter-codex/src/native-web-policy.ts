import { evaluateOrderedPolicyRules, type PolicySnapshot, type PolicyRuleDecision } from "@joko/core";
import type { JsonObject } from "./protocol.js";

/** Native hosted web search has no fail-closed local per-query callback.
 * Match its exact public names and every action family it can perform. */
export function nativeWebPolicy(snapshot: PolicySnapshot | undefined): PolicyRuleDecision | undefined {
  if (!snapshot?.rules.length) return undefined;
  const decisions = (["network", "browser", "resource"] as const).flatMap(subjectKind =>
    ["web_search", "web.run", "WebSearch"].flatMap(toolName => {
      const decision = evaluateOrderedPolicyRules(snapshot, { subjectKind, toolName, risk: "high" });
      return decision ? [decision] : [];
    }));
  return decisions.find(decision => decision.action === "deny") ?? decisions.find(decision => decision.action === "ask") ?? decisions[0];
}

export function nativeWebPolicyConfiguration(snapshot: PolicySnapshot | undefined): JsonObject {
  const action = nativeWebPolicy(snapshot)?.action;
  // An Ask starts disabled. A real owner interaction may authorize the
  // bounded next turn before its original native web configuration is restored.
  return action === "deny" || action === "ask" ? { web_search: "disabled" } : {};
}
