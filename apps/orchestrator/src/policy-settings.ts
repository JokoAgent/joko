import * as contract from "@joko/contracts";
import type {
  OrderedPolicyRule,
  PolicyRisk,
  PolicyRuleEffect,
  PolicySnapshot,
  PolicySubjectKind,
  TargetDescriptor
} from "@joko/core";
import type { OperationalStore } from "@joko/store";

export const POLICY_SETTINGS_KEY = "settings.policy";

export class PolicySettingsValidationError extends Error {
  constructor(readonly field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "PolicySettingsValidationError";
  }
}

export function validatePolicySettings(settings: contract.PolicySettings): void {
  compilePolicyRules(settings);
}

export function policySnapshotFor(
  store: OperationalStore,
  target: TargetDescriptor
): PolicySnapshot {
  const record = store.findSetting<contract.PolicySettings>("service", "orchestrator", POLICY_SETTINGS_KEY);
  const rules = record === undefined ? [] : compilePolicyRules(record.value).filter((rule) =>
    (rule.backendId === undefined || rule.backendId === target.backendId)
    && (rule.targetId === undefined || rule.targetId === target.id)
  );
  return Object.freeze({
    generation: record?.revision.toString(10) ?? "0",
    backendId: target.backendId,
    targetId: target.id,
    workspaceRoot: target.workspaceRoot,
    rules: Object.freeze(rules)
  });
}

function compilePolicyRules(settings: contract.PolicySettings): readonly OrderedPolicyRule[] {
  const ids = new Set<string>();
  const rules: OrderedPolicyRule[] = [];
  settings.rules.forEach((rule, order) => {
    const field = `rules[${order}]`;
    const id = requiredIdentifier(rule.policyRuleId, `${field}.policy_rule_id`, 128);
    if (ids.has(id)) throw invalid(`${field}.policy_rule_id`, "must be unique");
    ids.add(id);
    const effect = policyEffect(rule.effect, `${field}.effect`);
    const subjectKind = policySubjectKind(rule.subjectKind, `${field}.subject_kind`);
    const ceiling = policyRisk(rule.ceiling, `${field}.ceiling`);
    const backendId = optionalIdentifier(rule.backendId, `${field}.backend_id`, 256);
    const targetId = optionalIdentifier(rule.targetId, `${field}.target_id`, 256);
    const toolProviderId = optionalIdentifier(rule.toolProviderId, `${field}.tool_provider_id`, 256);
    const toolName = optionalIdentifier(rule.toolName, `${field}.tool_name`, 256);
    const workspaceRelativePathPrefix = workspacePrefix(
      rule.workspaceRelativePathPrefix,
      `${field}.workspace_relative_path_prefix`
    );
    if (!Number.isSafeInteger(rule.priority) || rule.priority < 0 || rule.priority > 0xffff_ffff) {
      throw invalid(`${field}.priority`, "must be an unsigned 32-bit integer");
    }
    if (!rule.enabled) return;
    rules.push(Object.freeze({
      id,
      effect,
      subjectKind,
      ...(backendId === undefined ? {} : { backendId }),
      ...(targetId === undefined ? {} : { targetId }),
      ...(workspaceRelativePathPrefix === undefined ? {} : { workspaceRelativePathPrefix }),
      ...(toolProviderId === undefined ? {} : { toolProviderId }),
      ...(toolName === undefined ? {} : { toolName }),
      ceiling,
      priority: rule.priority,
      order
    }));
  });
  return rules;
}

function policyEffect(value: contract.PolicyEffect, field: string): PolicyRuleEffect {
  switch (value) {
    case contract.PolicyEffect.ALLOW: return "allow";
    case contract.PolicyEffect.DENY: return "deny";
    case contract.PolicyEffect.ASK: return "ask";
    case contract.PolicyEffect.UNSPECIFIED: throw invalid(field, "is required");
    default: throw invalid(field, "is unknown");
  }
}

function policySubjectKind(value: contract.PolicySubjectKind, field: string): PolicySubjectKind {
  switch (value) {
    case contract.PolicySubjectKind.FILE_READ: return "file_read";
    case contract.PolicySubjectKind.FILE_WRITE: return "file_write";
    case contract.PolicySubjectKind.COMMAND: return "command";
    case contract.PolicySubjectKind.NETWORK: return "network";
    case contract.PolicySubjectKind.MCP: return "mcp";
    case contract.PolicySubjectKind.BROWSER: return "browser";
    case contract.PolicySubjectKind.RESOURCE: return "resource";
    case contract.PolicySubjectKind.EXTRA_DIRECTORY: return "extra_directory";
    case contract.PolicySubjectKind.UNSPECIFIED: throw invalid(field, "is required");
    default: throw invalid(field, "is unknown");
  }
}

function policyRisk(value: contract.PermissionRisk, field: string): PolicyRisk {
  switch (value) {
    case contract.PermissionRisk.UNSPECIFIED:
    case contract.PermissionRisk.CRITICAL:
      return "critical";
    case contract.PermissionRisk.READ_ONLY: return "read_only";
    case contract.PermissionRisk.LOW: return "low";
    case contract.PermissionRisk.MEDIUM: return "medium";
    case contract.PermissionRisk.HIGH: return "high";
    default: throw invalid(field, "is unknown");
  }
}

function requiredIdentifier(value: string, field: string, maximum: number): string {
  const normalized = optionalIdentifier(value, field, maximum);
  if (normalized === undefined) throw invalid(field, "is required");
  return normalized;
}

function optionalIdentifier(value: string, field: string, maximum: number): string | undefined {
  if (value === "") return undefined;
  if (value !== value.trim()) throw invalid(field, "must not have surrounding whitespace");
  if ([...value].length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalid(field, `must be at most ${maximum} visible characters`);
  }
  return value;
}

function workspacePrefix(value: string, field: string): string | undefined {
  if (value === "") return undefined;
  if (value !== value.trim()) throw invalid(field, "must not have surrounding whitespace");
  if ([...value].length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalid(field, "must be at most 4096 visible characters");
  }
  const portable = value.replace(/\\/gu, "/");
  if (portable.startsWith("/") || /^[A-Za-z]:/u.test(portable)) {
    throw invalid(field, "must be workspace-relative");
  }
  const segments = portable.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) throw invalid(field, "must not traverse outside the workspace");
  return segments.join("/");
}

function invalid(field: string, message: string): PolicySettingsValidationError {
  return new PolicySettingsValidationError(field, message);
}
