import { isAbsolute, normalize, relative, resolve } from "node:path";
import type { PermissionMode } from "./types.js";

export type ToolRisk = "safe_read" | "workspace_write" | "safe_command" | "ambiguous" | "dangerous";

export type PolicyRuleEffect = "allow" | "deny" | "ask";
export type PolicySubjectKind =
  | "file_read"
  | "file_write"
  | "command"
  | "network"
  | "mcp"
  | "browser"
  | "resource"
  | "extra_directory";
export type PolicyRisk = "read_only" | "low" | "medium" | "high" | "critical";

/** Capability-neutral, service-normalized rule. `order` preserves the public
 * repeated-field order when two rules have the same priority. */
export interface OrderedPolicyRule {
  readonly id: string;
  readonly effect: PolicyRuleEffect;
  readonly subjectKind: PolicySubjectKind;
  readonly backendId?: string;
  readonly targetId?: string;
  readonly workspaceRelativePathPrefix?: string;
  readonly toolProviderId?: string;
  readonly toolName?: string;
  readonly ceiling: PolicyRisk;
  readonly priority: number;
  readonly order: number;
}

/** Exact policy authority sampled for one current Backend/Target/workspace. */
export interface PolicySnapshot {
  readonly generation: string;
  readonly backendId: string;
  readonly targetId: string;
  readonly workspaceRoot: string;
  readonly rules: readonly OrderedPolicyRule[];
}

export interface PolicyObservation {
  readonly subjectKind: PolicySubjectKind;
  readonly risk: PolicyRisk;
  readonly workspaceRelativePath?: string;
  readonly toolProviderId?: string;
  readonly toolName?: string;
}

export interface PolicyRuleDecision {
  readonly action: PolicyRuleEffect;
  readonly ruleId: string;
}

export interface ToolCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface PolicyContext {
  readonly mode: PermissionMode;
  /** Host-owned hard lock used by isolated reviewer sessions; it dominates Full Access. */
  readonly readOnly?: boolean;
  readonly workspaceRoot: string;
  readonly extraReadOnlyRoots: readonly string[];
  readonly explicitDenyTools: ReadonlySet<string>;
  readonly explicitAllowTools: ReadonlySet<string>;
  readonly policySnapshot?: PolicySnapshot;
}

export interface PolicyDecision {
  readonly action: "allow" | "ask" | "deny";
  readonly risk: ToolRisk;
  readonly reason: string;
}

const READ_TOOLS = new Set(["read", "ls", "find", "grep"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const SHELL_META = /(?:\|\||&&|[|;<>`]|\$\(|\r|\n)/;
const SAFE_COMMANDS = new Set(["git status", "git diff", "git log", "git show", "pwd", "ls", "dir"]);
const DANGEROUS_COMMAND = /\b(?:rm\s+-rf|rmdir\s+\/s|del\s+\/f|format|diskpart|shutdown|reboot|reg\s+(?:delete|add)|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|curl\b.*\|\s*(?:sh|bash)|powershell\b.*-enc)\b/i;
const CREDENTIAL_PATH = /(?:^|[\\/])(?:\.ssh|\.aws|\.azure|\.config[\\/]gcloud|\.npmrc|\.pypirc|\.netrc|\.env(?:\.[^\\/]*)?|auth\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.[^\\/]*)?|[^\\/]*\.(?:pem|key|p12|pfx)|[^\\/]*(?:credential|secret|token|keychain)[^\\/]*)(?:[\\/]|$)/i;

export function decideToolCall(call: ToolCall, context: PolicyContext): PolicyDecision {
  if (context.explicitDenyTools.has(call.name)) {
    return { action: "deny", risk: "dangerous", reason: "The tool is explicitly denied by policy." };
  }

  if (context.readOnly === true) {
    let risk: ToolRisk;
    try {
      risk = classifyToolCall(call, context);
    } catch {
      return { action: "deny", risk: "ambiguous", reason: "Read-only review classification failed closed." };
    }
    return risk === "safe_read"
      ? { action: "allow", risk, reason: "The isolated reviewer may use this read-only operation." }
      : { action: "deny", risk, reason: "The isolated reviewer permits only bounded read, grep, find, and ls operations; shell is always denied." };
  }

  let risk: ToolRisk | undefined;
  if ((context.policySnapshot?.rules.length ?? 0) > 0) {
    try {
      risk = classifyToolCall(call, context);
    } catch {
      return { action: "ask", risk: "ambiguous", reason: "Policy classification failed closed." };
    }
    const matched = evaluateOrderedPolicyRules(
      context.policySnapshot!,
      policyObservationForToolCall(call, context, risk)
    );
    if (matched !== undefined) {
      return {
        action: matched.action,
        risk,
        reason: `Ordered policy rule '${matched.ruleId}' requires ${matched.action}.`
      };
    }
  }

  if (context.mode === "bypassPermissions") {
    return { action: "allow", risk: risk ?? "ambiguous", reason: "Full Access was explicitly enabled for this session." };
  }

  if (risk === undefined) {
    try {
      risk = classifyToolCall(call, context);
    } catch {
      return { action: "ask", risk: "ambiguous", reason: "Policy classification failed closed." };
    }
  }

  if (context.mode === "ask") {
    if (risk === "safe_read" || (risk === "safe_command" && context.explicitAllowTools.has(call.name))) {
      return { action: "allow", risk, reason: "Read-only operation allowed by the ask policy." };
    }
    return { action: "ask", risk, reason: "The ask policy requires owner confirmation." };
  }

  if (risk === "safe_read" || risk === "workspace_write" || risk === "safe_command") {
    return { action: "allow", risk, reason: "Auto policy classified the operation as bounded and safe." };
  }
  return {
    action: "ask",
    risk,
    reason: risk === "dangerous" ? "A dangerous operation always requires confirmation." : "The operation is ambiguous."
  };
}

/** Evaluate all matching denies before the first ordered allow/ask. This
 * preserves the public explicit-deny invariant without making an early allow
 * sensitive to a later deny rule. */
export function evaluateOrderedPolicyRules(
  snapshot: PolicySnapshot,
  observation: PolicyObservation
): PolicyRuleDecision | undefined {
  const ordered = [...snapshot.rules].sort((left, right) =>
    right.priority - left.priority || left.order - right.order || left.id.localeCompare(right.id, "en")
  );
  const matching = ordered.filter((rule) => policyRuleMatches(rule, snapshot, observation));
  const denied = matching.find((rule) => rule.effect === "deny");
  const selected = denied ?? matching.find((rule) => rule.effect !== "deny");
  return selected === undefined ? undefined : { action: selected.effect, ruleId: selected.id };
}

export function policyObservationForToolCall(
  call: ToolCall,
  context: Pick<PolicyContext, "workspaceRoot" | "extraReadOnlyRoots">,
  risk: ToolRisk = classifyToolCall(call, context)
): PolicyObservation {
  const common = { risk: policyRiskForToolRisk(risk), toolName: call.name } as const;
  if (call.name.startsWith("mcp__")) {
    const separator = call.name.indexOf("__", "mcp__".length);
    return separator < 0
      ? { ...common, subjectKind: "mcp" }
      : {
          ...common,
          subjectKind: "mcp",
          toolProviderId: call.name.slice("mcp__".length, separator),
          toolName: call.name.slice(separator + 2)
        };
  }
  if (READ_TOOLS.has(call.name) || WRITE_TOOLS.has(call.name)) {
    const candidate = extractPath(call.args);
    const inWorkspace = candidate !== undefined && isWithin(candidate, context.workspaceRoot);
    const inExtraDirectory = candidate !== undefined && !inWorkspace
      && context.extraReadOnlyRoots.some((root) => isWithin(candidate, root));
    return {
      ...common,
      subjectKind: inExtraDirectory
        ? "extra_directory"
        : READ_TOOLS.has(call.name) ? "file_read" : "file_write",
      ...(inWorkspace && candidate !== undefined
        ? { workspaceRelativePath: normalizedWorkspaceRelativePath(candidate, context.workspaceRoot) }
        : {})
    };
  }
  if (call.name === "bash") return { ...common, subjectKind: "command" };
  return { ...common, subjectKind: "resource" };
}

export function policyRiskForToolRisk(risk: ToolRisk): PolicyRisk {
  switch (risk) {
    case "safe_read": return "read_only";
    case "safe_command": return "low";
    case "workspace_write": return "medium";
    case "ambiguous": return "high";
    case "dangerous": return "critical";
  }
}

export function classifyToolCall(call: ToolCall, context: Pick<PolicyContext, "workspaceRoot" | "extraReadOnlyRoots">): ToolRisk {
  if (call.name.startsWith("mcp__")) return "ambiguous";

  if (READ_TOOLS.has(call.name)) {
    const candidate = extractPath(call.args);
    if (candidate === undefined) return "ambiguous";
    if (CREDENTIAL_PATH.test(candidate)) return "dangerous";
    return isWithinAny(candidate, [context.workspaceRoot, ...context.extraReadOnlyRoots]) ? "safe_read" : "dangerous";
  }

  if (WRITE_TOOLS.has(call.name)) {
    const candidate = extractPath(call.args);
    if (candidate === undefined) return "ambiguous";
    if (CREDENTIAL_PATH.test(candidate)) return "dangerous";
    return isWithin(candidate, context.workspaceRoot) ? "workspace_write" : "dangerous";
  }

  if (call.name === "bash") {
    const command = typeof call.args.command === "string" ? call.args.command.trim() : undefined;
    if (command === undefined || command === "") return "ambiguous";
    if (DANGEROUS_COMMAND.test(command) || CREDENTIAL_PATH.test(command)) return "dangerous";
    if (SHELL_META.test(command)) return "ambiguous";
    return SAFE_COMMANDS.has(command.toLowerCase()) || command.toLowerCase().startsWith("git diff ") ? "safe_command" : "ambiguous";
  }

  return "ambiguous";
}

function extractPath(args: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ["path", "file_path", "filePath", "directory"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function isWithinAny(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => isWithin(candidate, root));
}

function policyRuleMatches(
  rule: OrderedPolicyRule,
  snapshot: PolicySnapshot,
  observation: PolicyObservation
): boolean {
  if (rule.subjectKind !== observation.subjectKind) return false;
  if (rule.backendId !== undefined && rule.backendId !== snapshot.backendId) return false;
  if (rule.targetId !== undefined && rule.targetId !== snapshot.targetId) return false;
  if (rule.toolProviderId !== undefined && rule.toolProviderId !== observation.toolProviderId) return false;
  if (rule.toolName !== undefined && rule.toolName !== observation.toolName) return false;
  if (POLICY_RISK_ORDER[observation.risk] > POLICY_RISK_ORDER[rule.ceiling]) return false;
  if (rule.workspaceRelativePathPrefix !== undefined) {
    const candidate = observation.workspaceRelativePath;
    if (candidate === undefined || !workspacePrefixMatches(candidate, rule.workspaceRelativePathPrefix)) return false;
  }
  return true;
}

const POLICY_RISK_ORDER: Readonly<Record<PolicyRisk, number>> = {
  read_only: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

function workspacePrefixMatches(candidate: string, prefix: string): boolean {
  if (prefix === "") return true;
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function normalizedWorkspaceRelativePath(candidate: string, workspaceRoot: string): string {
  const absoluteRoot = resolve(workspaceRoot);
  const absoluteCandidate = isAbsolute(candidate) ? resolve(normalize(candidate)) : resolve(absoluteRoot, normalize(candidate));
  return relative(absoluteRoot, absoluteCandidate).split("\\").join("/");
}

export function isWithin(candidate: string, root: string): boolean {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = isAbsolute(candidate) ? resolve(normalize(candidate)) : resolve(absoluteRoot, normalize(candidate));
  const rel = relative(absoluteRoot, absoluteCandidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
