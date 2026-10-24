import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decideToolCall, evaluateOrderedPolicyRules, isWithin, type PolicySnapshot } from "./policy.js";

const context = {
  mode: "auto" as const,
  workspaceRoot: "C:\\work\\project",
  extraReadOnlyRoots: ["C:\\docs"],
  explicitDenyTools: new Set<string>(),
  explicitAllowTools: new Set<string>()
};

it("uses the task filesystem path style across a different controller platform", () => {
  const peer = { ...context, mode: "acceptEdits" as const, pathStyle: "posix" as const, workspaceRoot: "/peer/project", extraReadOnlyRoots: ["/peer/docs"] };
  expect(decideToolCall({ name: "read", args: { path: "/peer/project/src/file.ts" } }, peer).action).toBe("allow");
  expect(decideToolCall({ name: "read", args: { path: "/PEER/project/private" } }, peer).action).toBe("ask");
  expect(decideToolCall({ name: "read", args: { path: "/peer/project-other/private" } }, peer).action).toBe("ask");
  expect(isWithin("C:\\PEER\\project\\file", "c:\\peer\\project", "win32")).toBe(true);
  const policySnapshot: PolicySnapshot = { generation: "1", backendId: "source", targetId: "peer-target", workspaceRoot: peer.workspaceRoot,
    rules: [{ id: "private", subjectKind: "file_read", workspaceRelativePathPrefix: "private", effect: "deny", ceiling: "critical", priority: 1, order: 0 }] };
  expect(decideToolCall({ name: "read", args: { path: "/peer/project/private/file" } }, { ...peer, policySnapshot }).action).toBe("deny");
});

describe("permission policy", () => {
  it("accepts bounded file edits while continuing to ask for commands and external tools", () => {
    const edits = { ...context, mode: "acceptEdits" as const };
    expect(decideToolCall({ name: "write", args: { path: "src/app.ts" } }, edits).action).toBe("allow");
    expect(decideToolCall({ name: "bash", args: { command: "git status" } }, edits).action).toBe("ask");
    expect(decideToolCall({ name: "mcp__service__publish", args: {} }, edits).action).toBe("ask");
    expect(decideToolCall({ name: "write", args: { path: resolve(edits.workspaceRoot, "..", "outside", "file") } }, edits).action).toBe("ask");
  });
  it("allows bounded workspace writes in auto mode", () => {
    expect(decideToolCall({ name: "write", args: { path: "src/app.ts" } }, context).action).toBe("allow");
  });

  it("asks for ambiguous commands and denies credential reads by confirmation", () => {
    expect(decideToolCall({ name: "bash", args: { command: "npm install" } }, context).action).toBe("ask");
    const credential = decideToolCall({ name: "read", args: { path: "C:\\Users\\me\\.ssh\\id_ed25519" } }, context);
    expect(credential).toMatchObject({ action: "ask", risk: "dangerous" });
  });

  it.each([
    "git diff --output=/other/result.patch",
    "git diff --output result.patch",
    "git diff --out=result.patch",
    "git diff --o=result.patch",
    "git diff -oresult.patch",
    "git diff --ext-diff",
    "git diff --ext",
    "git diff --textconv",
    "git diff --text",
    "git diff --'out'put=result.patch",
    "git diff --out\\put=result.patch",
    "git diff --no-index C:/other/a C:/other/b",
    "git diff -- ../../other/file"
  ])("requires review for git diff side effects or unbounded arguments: %s", (command) => {
    expect(decideToolCall({ name: "bash", args: { command } }, { ...context, pathStyle: "win32" }))
      .toMatchObject({ action: "ask", risk: "ambiguous" });
  });

  it.each(["git diff", "git diff --stat", "git diff --no-ext-diff", "git diff --no-textconv"])(
    "requires review when configured external diff programs remain enabled: %s", command => {
      expect(decideToolCall({ name: "bash", args: { command } }, { ...context, mode: "auto" })).toMatchObject({ action: "ask", risk: "ambiguous" });
    }
  );

  it.each(["git diff --no-ext-diff --no-textconv", "git diff --no-ext-diff --no-textconv --stat", "git diff --no-ext-diff --no-textconv --cached --name-only", "git diff --no-ext-diff --no-textconv -U3 HEAD -- src/app.ts"])(
    "allows bounded read-only git diff arguments: %s", (command) => {
      expect(decideToolCall({ name: "bash", args: { command } }, { ...context, pathStyle: "win32" }))
        .toMatchObject({ action: "allow", risk: "safe_command" });
    }
  );

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
    expect(decideToolCall({ name: "bash", args: { command: "git diff --no-ext-diff --no-textconv" } }, reviewer)).toMatchObject({ action: "deny", risk: "safe_command" });
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
    expect(isWithin("..\\secret", "C:\\work\\project", "win32")).toBe(false);
    expect(isWithin("src\\index.ts", "C:\\work\\project", "win32")).toBe(true);
    expect(isWithin("../secret", "/work/project", "posix")).toBe(false);
    expect(isWithin("src/index.ts", "/work/project", "posix")).toBe(true);
  });
});
