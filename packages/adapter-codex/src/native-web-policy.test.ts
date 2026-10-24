import { describe, expect, it } from "vitest";
import type { OrderedPolicyRule, PolicySnapshot } from "@joko/core";
import { nativeWebPolicy, nativeWebPolicyConfiguration } from "./native-web-policy.js";

function snapshot(rules: readonly Partial<OrderedPolicyRule>[]): PolicySnapshot {
  return { generation: "1", backendId: "native", targetId: "project", workspaceRoot: "/project", rules: rules.map((rule, order) => ({
    id: String(order), order, subjectKind: "network", effect: "deny", ceiling: "critical", priority: 0, ...rule
  })) };
}
describe("native hosted web policy", () => {
  it.each(["network", "browser", "resource"] as const)("maps an applicable %s deny to the exact native disabled config", subjectKind => {
    expect(nativeWebPolicyConfiguration(snapshot([{ subjectKind }]))).toEqual({ web_search: "disabled" });
  });
  it("preserves deny precedence, exact scopes, tool names, risk ceiling, and later allowance", () => {
    expect(nativeWebPolicy(snapshot([{ effect: "allow", priority: 100 }, { toolName: "web_search" }]))?.action).toBe("deny");
    expect(nativeWebPolicy(snapshot([{ backendId: "other" }, { targetId: "other" }, { toolName: "unrelated" }, { ceiling: "low" }]))).toBeUndefined();
    expect(nativeWebPolicyConfiguration(snapshot([{ effect: "allow" }]))).toEqual({});
    expect(nativeWebPolicyConfiguration(snapshot([{ effect: "ask" }]))).toEqual({ web_search: "disabled" });
  });
});
