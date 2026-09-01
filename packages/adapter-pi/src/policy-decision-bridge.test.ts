import { describe, expect, it, vi } from "vitest";

import {
  encodePolicyDecisionRequest,
  handlePolicyDecisionExtensionRequest,
  MAXIMUM_POLICY_WORKSPACE_RELATIVE_PATH_CHARACTERS
} from "./policy-decision-bridge.js";

describe("managed policy decision bridge", () => {
  it("round-trips one bounded typed observation to the host evaluator", async () => {
    const notify = vi.fn(async () => undefined);
    const decide = vi.fn(async () => "deny" as const);
    const handled = await handlePolicyDecisionExtensionRequest({
      id: "policy-one",
      method: "input",
      title: encodePolicyDecisionRequest({
        policyGeneration: 8,
        observation: {
          subjectKind: "browser",
          risk: "high",
          toolProviderId: "browser",
          toolName: "navigate"
        }
      })
    }, {
      decide,
      transport: { closed: false, notify },
      isCurrent: () => true
    });

    expect(handled).toBe(true);
    expect(decide).toHaveBeenCalledWith({
      policyGeneration: 8,
      observation: {
        subjectKind: "browser",
        risk: "high",
        toolProviderId: "browser",
        toolName: "navigate"
      }
    });
    expect(notify).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "policy-one",
      value: "deny"
    });
  });

  it("consumes malformed reserved requests and fails them closed", async () => {
    const notify = vi.fn(async () => undefined);
    const handled = await handlePolicyDecisionExtensionRequest({
      id: "bad",
      method: "input",
      title: "joko:policy-decision/v1/not+base64"
    }, {
      decide: async () => "allow",
      transport: { closed: false, notify },
      isCurrent: () => true
    });

    expect(handled).toBe(true);
    expect(notify).toHaveBeenCalledWith({ type: "extension_ui_response", id: "bad", cancelled: true });
  });

  it("preserves the complete contract-bounded workspace path and rejects one character beyond it", async () => {
    const notify = vi.fn(async () => undefined);
    const decide = vi.fn(async () => "allow" as const);
    const workspaceRelativePath = "a".repeat(MAXIMUM_POLICY_WORKSPACE_RELATIVE_PATH_CHARACTERS);
    const title = encodePolicyDecisionRequest({
      policyGeneration: 2,
      observation: { subjectKind: "file_read", risk: "read_only", workspaceRelativePath, toolName: "read" }
    });

    await expect(handlePolicyDecisionExtensionRequest({
      id: "long-path",
      method: "input",
      title
    }, {
      decide,
      transport: { closed: false, notify },
      isCurrent: () => true
    })).resolves.toBe(true);
    expect(decide).toHaveBeenCalledWith({
      policyGeneration: 2,
      observation: { subjectKind: "file_read", risk: "read_only", workspaceRelativePath, toolName: "read" }
    });

    expect(() => encodePolicyDecisionRequest({
      policyGeneration: 2,
      observation: {
        subjectKind: "file_read",
        risk: "read_only",
        workspaceRelativePath: `${workspaceRelativePath}a`,
        toolName: "read"
      }
    })).toThrow("invalid bounded observation");
  });
});
