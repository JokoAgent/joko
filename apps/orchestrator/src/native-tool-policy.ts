import { posix, win32 } from "node:path";
import {
  classifyToolCall, evaluateOrderedPolicyRules, isWithin, policyObservationForToolCall,
  type NativeToolAuthorizationDecision, type NativeToolAuthorizationRequest, type PolicyObservation,
  type PolicySnapshot, type ToolCall
} from "@joko/core";
import { realPathOrAncestor } from "./hosted-agent-workspace.js";

const ALIASES: Readonly<Record<string, string>> = {
  Read: "read", read_file: "read", Glob: "find", Grep: "grep", LS: "ls", Write: "write", Edit: "edit", MultiEdit: "edit",
  NotebookEdit: "edit", Bash: "bash", command: "bash", shell_command: "bash", exec_command: "bash"
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function callsFor(request: NativeToolAuthorizationRequest, root: string): readonly ToolCall[] {
  const input = record(request.input), name = ALIASES[request.toolName] ?? request.toolName;
  if (request.toolName === "file_change" && Array.isArray(input.changes)) {
    return input.changes.flatMap(change => {
      const item = record(change), kind = record(item.kind);
      return [item.path, kind.move_path].filter((path): path is string => typeof path === "string")
        .map(path => ({ name: "write", args: { path } }));
    });
  }
  if (request.toolName === "apply_patch") {
    const patch = typeof request.input === "string" ? request.input : input.input ?? input.patch;
    if (typeof patch === "string") return [...patch.matchAll(/^\*\*\* (?:Add File: |Delete File: |Update File: |Move to: )(.+)$/gmu)]
      .map(match => ({ name: "write", args: { path: match[1]! } }));
  }
  const path = input.path ?? input.file_path ?? input.filePath ?? input.notebook_path ?? input.directory;
  const command = input.command ?? input.cmd;
  return [{ name, args: { ...input,
    ...(["read", "write", "edit", "ls", "find", "grep"].includes(name) ? { path: typeof path === "string" ? path : root } : {}),
    ...(name === "bash" ? { command: Array.isArray(command) ? command.join(" ") : command } : {}) } }];
}

/** Shared service policy for native automatic tools and native approvals.
 * It does not replace either engine's ordinary permission or Plan controls. */
export function reviewNativeToolPolicy(snapshot: PolicySnapshot, request: NativeToolAuthorizationRequest, options: {
  readonly pathStyle?: "posix" | "win32";
  readonly remote?: boolean;
  readonly extraReadOnlyRoots?: readonly string[];
} = {}): NativeToolAuthorizationDecision {
  request.signal.throwIfAborted();
  const paths = options.pathStyle === "win32" ? win32 : options.pathStyle === "posix" ? posix : process.platform === "win32" ? win32 : posix;
  const context = { workspaceRoot: snapshot.workspaceRoot, extraReadOnlyRoots: options.extraReadOnlyRoots ?? [],
    ...(options.pathStyle ? { pathStyle: options.pathStyle } : {}) };
  const observations: PolicyObservation[] = [];
  for (const call of callsFor(request, snapshot.workspaceRoot)) {
    const candidates: ToolCall[] = [call];
    const rawPath = call.args.path;
    if (typeof rawPath === "string" && !options.remote) {
      const canonical = realPathOrAncestor(paths.resolve(snapshot.workspaceRoot, rawPath));
      candidates.push({ ...call, args: { ...call.args, path: canonical } });
    }
    for (const candidate of candidates) {
      const observation = policyObservationForToolCall(candidate, context, classifyToolCall(candidate, context));
      const network = ["WebFetch", "WebSearch", "web_search"].includes(candidate.name);
      const current: PolicyObservation = network ? { ...observation, subjectKind: "network" } : observation;
      if (network) observations.push(observation);
      observations.push(current);
      if (request.toolName !== candidate.name) observations.push({ ...current, toolName: request.toolName });
      // A recursive search rooted above a denied subtree can disclose its
      // files without ever issuing a separate Read call for those files.
      if ((["find", "grep", "ls"].includes(candidate.name) || ["read", "write", "edit"].includes(candidate.name) && candidate.args.recursive === true) && typeof candidate.args.path === "string") {
        const root = paths.resolve(snapshot.workspaceRoot, candidate.args.path);
        const subjectKind = ["write", "edit"].includes(candidate.name) ? "file_write" : "file_read";
        for (const rule of snapshot.rules) {
          if (rule.workspaceRelativePathPrefix === undefined || rule.subjectKind !== subjectKind) continue;
          const subtree = paths.resolve(snapshot.workspaceRoot, rule.workspaceRelativePathPrefix);
          if (!isWithin(subtree, root, options.pathStyle)) continue;
          observations.push({ ...observation, subjectKind, workspaceRelativePath: rule.workspaceRelativePathPrefix });
          if (request.toolName !== candidate.name) observations.push({ ...observation, toolName: request.toolName,
            subjectKind, workspaceRelativePath: rule.workspaceRelativePathPrefix });
        }
      }
    }
  }
  const matches = observations.flatMap(observation => {
    const decision = evaluateOrderedPolicyRules(snapshot, observation);
    return decision ? [decision] : [];
  });
  const selected = matches.find(match => match.action === "deny") ?? matches.find(match => match.action === "ask") ?? matches[0];
  return selected === undefined ? { verdict: "default" }
    : { verdict: selected.action === "deny" ? "block" : selected.action, reason: `Ordered policy rule '${selected.ruleId}' requires ${selected.action}.` };
}
