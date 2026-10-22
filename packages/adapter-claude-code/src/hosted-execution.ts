import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertHostedExecution, hostedExecutionEnvironmentNote, type AdapterContext, type HostedExecution } from "@joko/core";
import type { ClaudeSdkQueryOptions } from "./sdk-runtime.js";

export function assertClaudeHostedModel(hosted: HostedExecution | undefined, providerId: string | undefined, modelId: string | undefined): void {
  if (!hosted) return;
  assertHostedExecution(hosted);
  if (hosted.trust === "guest" && (providerId !== hosted.providerId || !modelId || !hosted.modelIds.includes(modelId))) {
    throw new Error("The shared Provider does not allow this model.");
  }
}

export async function prepareClaudeHostedExecution(context: AdapterContext): Promise<void> {
  const hosted = context.hostedExecution; if (!hosted) return;
  assertHostedExecution(hosted);
  if (context.target.remoteWorkspace || resolve(context.target.workspaceRoot) !== resolve(hosted.workspace.root)) {
    throw new Error("Hosted execution requires its exact local virtual workspace.");
  }
  if (hosted.trust === "guest") {
    const suffix = relative(hosted.guestHome, hosted.workspace.root), info = await lstat(hosted.guestHome);
    if (!isAbsolute(hosted.guestHome) || !info.isDirectory() || info.isSymbolicLink() || await realpath(hosted.guestHome) !== resolve(hosted.guestHome)
      || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error("Shared Agent workspace is outside its isolated home.");
  }
  assertHostedExecution(hosted);
}

export function claudeHostedSettings(hosted: HostedExecution): Exclude<ClaudeSdkQueryOptions["settings"], undefined> {
  assertHostedExecution(hosted);
  const excludes = new Set<string>();
  for (let directory = dirname(hosted.workspace.root); ; directory = dirname(directory)) {
    for (const file of [join(directory, "CLAUDE.md"), join(directory, "CLAUDE.local.md"), join(directory, ".claude", "CLAUDE.md")]) {
      excludes.add(file); excludes.add(file.split(sep).join("/"));
    }
    excludes.add(join(directory, ".claude", "rules").split(sep).join("/") + "/**");
    if (dirname(directory) === directory) break;
  }
  return {
    // The Source owns task instructions and resources; native discovery must
    // not walk the model computer's parents or run its hooks and helpers.
    disableAllHooks: true, disableClaudeAiConnectors: true, disableRemoteControl: true,
    disableSkillShellExecution: true, autoMemoryEnabled: false, autoDreamEnabled: false,
    includeGitInstructions: false, claudeMdExcludes: [...excludes],
    ...(hosted.trust === "guest" ? { availableModels: [...hosted.modelIds], enforceAvailableModels: true } : {})
  };
}

export function claudeHostedEnvironment(hosted: HostedExecution, environment: Readonly<Record<string, string>>): Readonly<Record<string, string | undefined>> {
  assertHostedExecution(hosted);
  const config = environment["CLAUDE_CONFIG_DIR"];
  if (hosted.trust === "guest") {
    const suffix = config ? relative(hosted.guestHome, config) : "..";
    if (!config || !isAbsolute(config) || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
      throw new Error("The shared native configuration must belong to its isolated home.");
    }
  }
  return {
    CLAUDE_CODE_SUBAGENT_MODEL: undefined, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: undefined,
    CLAUDE_CODE_MANAGED_SETTINGS_PATH: undefined, CLAUDE_CODE_REMOTE_SETTINGS_PATH: undefined,
    CLAUDE_CODE_SHELL: undefined,
    ...(hosted.trust === "guest" ? { HOME: hosted.guestHome, USERPROFILE: hosted.guestHome,
      APPDATA: join(hosted.guestHome, "config"), LOCALAPPDATA: join(hosted.guestHome, "local"),
      CLAUDE_CONFIG_DIR: config, ANTHROPIC_SMALL_FAST_MODEL: hosted.modelIds[0] } : {})
  };
}

export function claudeHostedPrompt(hosted: HostedExecution, append?: string): string {
  return [append, hostedExecutionEnvironmentNote(hosted),
    "Use the Source MCP file and shell tools for this workspace. Native filesystem and shell tools are disabled. File checkpoints do not cover changes on the task's computer."].filter(Boolean).join("\n\n");
}

export function sameClaudeHostedExecution(left: HostedExecution | undefined, right: HostedExecution | undefined): boolean {
  if (!left || !right) return left === right;
  try { assertHostedExecution(left); assertHostedExecution(right); } catch { return false; }
  return left.channel.endpoint === right.channel.endpoint && left.channel.bearer === right.channel.bearer
    && left.source.sessionId === right.source.sessionId && left.source.targetId === right.source.targetId
    && left.source.generation === right.source.generation && left.trust === right.trust
    && left.workspace.root === right.workspace.root
    && (left.trust !== "guest" || right.trust === "guest" && left.guestHome === right.guestHome
      && left.providerId === right.providerId && JSON.stringify(left.modelIds) === JSON.stringify(right.modelIds));
}
