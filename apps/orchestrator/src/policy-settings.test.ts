import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import type { OperationalStore } from "@joko/store";
import { describe, expect, it } from "vitest";

import { POLICY_SETTINGS_KEY, PolicySettingsValidationError, policySnapshotFor, validatePolicySettings } from "./policy-settings.js";

describe("ordered policy settings", () => {
  it("normalizes and scopes the current Backend/Target/workspace snapshot", () => {
    const settings = create(contract.PolicySettingsSchema, {
      rules: [
        create(contract.PolicyRuleSchema, {
          policyRuleId: "source-write",
          effect: contract.PolicyEffect.ASK,
          subjectKind: contract.PolicySubjectKind.FILE_WRITE,
          backendId: "pi",
          targetId: "target-a",
          workspaceRelativePathPrefix: ".\\src\\",
          toolName: "write",
          ceiling: contract.PermissionRisk.MEDIUM,
          enabled: true,
          priority: 20
        }),
        create(contract.PolicyRuleSchema, {
          policyRuleId: "other-target",
          effect: contract.PolicyEffect.DENY,
          subjectKind: contract.PolicySubjectKind.COMMAND,
          targetId: "target-b",
          ceiling: contract.PermissionRisk.CRITICAL,
          enabled: true
        })
      ]
    });
    const store = {
      findSetting: (_scope: string, _id: string, key: string) => key === POLICY_SETTINGS_KEY
        ? { value: settings, revision: 7n }
        : undefined
    } as unknown as OperationalStore;

    const snapshot = policySnapshotFor(store, {
      id: "target-a",
      backendId: "pi",
      displayName: "Target",
      workspaceRoot: "C:\\work",
      managed: true,
      trusted: true
    });

    expect(snapshot).toMatchObject({ backendId: "pi", targetId: "target-a", workspaceRoot: "C:\\work" });
    expect(snapshot.rules).toEqual([expect.objectContaining({
      id: "source-write",
      workspaceRelativePathPrefix: "src",
      ceiling: "medium",
      priority: 20,
      order: 0
    })]);
  });

  it("rejects duplicate identities and escaping workspace prefixes", () => {
    const duplicate = (prefix: string) => create(contract.PolicySettingsSchema, {
      rules: [0, 1].map(() => create(contract.PolicyRuleSchema, {
        policyRuleId: "same",
        effect: contract.PolicyEffect.ALLOW,
        subjectKind: contract.PolicySubjectKind.FILE_READ,
        workspaceRelativePathPrefix: prefix,
        enabled: true
      }))
    });

    expect(() => validatePolicySettings(duplicate("src"))).toThrow(PolicySettingsValidationError);
    expect(() => validatePolicySettings(create(contract.PolicySettingsSchema, {
      rules: [create(contract.PolicyRuleSchema, {
        policyRuleId: "escape",
        effect: contract.PolicyEffect.DENY,
        subjectKind: contract.PolicySubjectKind.FILE_READ,
        workspaceRelativePathPrefix: "../secret",
        enabled: true
      })]
    }))).toThrow(/must not traverse/u);
  });
});
