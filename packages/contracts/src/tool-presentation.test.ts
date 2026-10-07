import { describe, expect, it } from "vitest";

import { describeToolPresentation, parseToolDisplayInput } from "./tool-presentation.js";

describe("tool presentation", () => {
  it("decodes the current live root envelope and durable raw input", () => {
    expect(parseToolDisplayInput('$: {"path":"src/main.ts"}')).toEqual({ path: "src/main.ts" });
    expect(parseToolDisplayInput('{"path":"src/main.ts"}')).toEqual({ path: "src/main.ts" });
    expect(parseToolDisplayInput("$: git status --short")).toBe("git status --short");
  });

  it("describes command, file, search, and web tools by capability", () => {
    expect(describeToolPresentation("command", "$: git status --short")).toEqual({
      action: "runCommand",
      primary: "git status --short"
    });
    expect(describeToolPresentation("command", "null")).toEqual({ action: "runCommand", primary: "null" });
    expect(describeToolPresentation("Bash", '$: {"command":"pnpm test","description":"Run focused tests"}')).toEqual({
      action: "runCommand",
      primary: "Run focused tests"
    });
    expect(describeToolPresentation("Read", '{"file_path":"src/main.ts"}')).toEqual({
      action: "readFile",
      primary: "src/main.ts"
    });
    expect(describeToolPresentation("joko_grep", '$: {"query":"needle","path":"src"}')).toEqual({
      action: "searchFiles",
      primary: "needle"
    });
    expect(describeToolPresentation("WebFetch", '{"url":"https://example.test/docs"}')).toEqual({
      action: "fetchWeb",
      primary: "https://example.test/docs"
    });
    expect(describeToolPresentation("web_search", "null")).toEqual({ action: "searchWeb", primary: "null" });
  });

  it("describes current MCP, namespaced, and delegated-task identities", () => {
    expect(describeToolPresentation("mcp__records__lookup_customer", '{"query":"Acme"}')).toEqual({
      action: "callTool",
      primary: "records · lookup customer — Acme"
    });
    expect(describeToolPresentation("github/search_issues", '$: {"query":"is:open bug"}')).toEqual({
      action: "callTool",
      primary: "github · search issues — is:open bug"
    });
    expect(describeToolPresentation("mcp__joko_managed_subagent__delegate", '$: {"description":"Audit the parser"}')).toEqual({
      action: "delegateTask",
      primary: "Audit the parser"
    });
    expect(describeToolPresentation("subagent_status", '{"action":"wait","taskId":"worker-1"}')).toEqual({
      action: "manageTask",
      primary: "wait · worker-1"
    });
  });

  it("falls back for unknown, malformed, redacted, or oversized inputs", () => {
    expect(describeToolPresentation("unknown_tool", '{"path":"src/main.ts"}')).toBeUndefined();
    expect(describeToolPresentation("Read", "$: {broken")).toBeUndefined();
    expect(describeToolPresentation("Read", '{"path":"[REDACTED]"}')).toBeUndefined();
    expect(describeToolPresentation("update_plan", "$: {broken")).toBeUndefined();
    expect(describeToolPresentation("mcp__records__lookup", "$: {broken")).toBeUndefined();
    expect(describeToolPresentation("command", "x".repeat(65_537))).toBeUndefined();
    expect(describeToolPresentation("_/_", '{}')).toBeUndefined();
  });
});
