import { describe, expect, it } from "vitest";
import { decideToolCall, evaluateOrderedPolicyRules, isWithin, type PolicySnapshot } from "./policy.js";

const context = {
  mode: "auto" as const,
  workspaceRoot: "C:\\work\\project",
  extraReadOnlyRoots: ["C:\\docs"],
  explicitDenyTools: new Set<string>(),
  explicitAllowTools: new Set<string>()
};

describe("permission policy", () => {
  it("allows bounded workspace writes in auto mode", () => {
    expect(decideToolCall({ name: "write", args: { path: "src/app.ts" } }, context).action).toBe("allow");
  });

  it("asks for ambiguous commands and denies credential reads by confirmation", () => {
    expect(decideToolCall({ name: "bash", args: { command: "npm install" } }, context).action).toBe("ask");
    const credential = decideToolCall({ name: "read", args: { path: "C:\\Users\\me\\.ssh\\id_ed25519" } }, context);
    expect(credential).toMatchObject({ action: "ask", risk: "dangerous" });
  });

  it("respects explicit deny even in Full Access", () => {
    const decision = decideToolCall(
      { name: "bash", args: { command: "git status" } },
      { ...context, mode: "bypassPermissions", explicitDenyTools: new Set(["bash"]) }
    );
    expect(decision.action).toBe("deny");
  });

  it("hard-locks isolated reviewer work to safe reads even when Full Access was inherited", () => {
    const reviewer = { ...context, mode: "bypassPermissions" as const, readOnly: true };
    expect(decideToolCall({ name: "read", args: { path: "src/app.ts" } }, reviewer).action).toBe("allow");
    expect(decideToolCall({ name: "bash", args: { command: "git diff" } }, reviewer)).toMatchObject({ action: "deny", risk: "safe_command" });
    expect(decideToolCall({ name: "write", args: { path: "src/app.ts" } }, reviewer)).toMatchObject({ action: "deny", risk: "workspace_write" });
    expect(decideToolCall({ name: "mcp__remote__create", args: {} }, reviewer)).toMatchObject({ action: "deny" });
    expect(decideToolCall({ name: "read", args: { path: ".pypirc" } }, reviewer)).toMatchObject({ action: "deny", risk: "dangerous" });
    expect(decideToolCall({ name: "grep", args: { path: ".ssh/id_rsa" } }, reviewer)).toMatchObject({ action: "deny", risk: "dangerous" });
  });

  it("evaluates higher-priority rules in stable order while every matching deny wins", () => {
    const snapshot: PolicySnapshot = {
      generation: "9",
      backendId: "backend-a",
      targetId: "target-a",
      workspaceRoot: "C:\\work",
      rules: [
        { id: "allow-command", effect: "allow", subjectKind: "command", ceiling: "critical", priority: 100, order: 0 },
        { id: "ask-command", effect: "ask", subjectKind: "command", ceiling: "critical", priority: 50, order: 1 },
        { id: "deny-bash", effect: "deny", subjectKind: "command", toolName: "bash", ceiling: "critical", priority: 1, order: 2 }
      ]
    };

    expect(evaluateOrderedPolicyRules(snapshot, {
      subjectKind: "command",
      risk: "high",
      toolName: "bash"
    })).toEqual({ action: "deny", ruleId: "deny-bash" });
    expect(evaluateOrderedPolicyRules(snapshot, {
      subjectKind: "command",
      risk: "high",
      toolName: "terminal"
    })).toEqual({ action: "allow", ruleId: "allow-command" });
  });

  it("matches scoped path ceilings and lets ordered rules dominate Full Access", () => {
    const snapshot: PolicySnapshot = {
      generation: "10",
      backendId: "pi",
      targetId: "target-a",
      workspaceRoot: "C:\\work",
      rules: [{
        id: "ask-source-writes",
        effect: "ask",
        subjectKind: "file_write",
        backendId: "pi",
        targetId: "target-a",
        workspaceRelativePathPrefix: "src",
        toolName: "write",
        ceiling: "medium",
        priority: 4,
        order: 0
      }]
    };
    const policyContext = {
      mode: "bypassPermissions" as const,
      workspaceRoot: "C:\\work",
      extraReadOnlyRoots: [] as readonly string[],
      explicitDenyTools: new Set<string>(),
      explicitAllowTools: new Set<string>(),
      policySnapshot: snapshot
    };

    expect(decideToolCall(
      { name: "write", args: { path: "src/app.ts" } },
      policyContext
    )).toMatchObject({ action: "ask", risk: "workspace_write" });
    expect(decideToolCall(
      { name: "write", args: { path: "tests/app.ts" } },
      policyContext
    ).action).toBe("allow");
  });
});

describe("path containment", () => {
  it("rejects parent traversal", () => {
    expect(isWithin("..\\secret", "C:\\work\\project")).toBe(false);
    expect(isWithin("src\\index.ts", "C:\\work\\project")).toBe(true);
  });
});
