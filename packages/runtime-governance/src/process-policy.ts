import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

import type { AgentResourceSettings, ManagedProcessPriority } from "./settings.js";

const execFileAsync = promisify(execFile);

export const TOOLCHAIN_THREAD_ENVIRONMENT_KEYS = Object.freeze([
  "VITEST_MAX_FORKS",
  "VITEST_MAX_THREADS",
  "CARGO_BUILD_JOBS"
] as const);

export type ProcessPriorityApplication =
  | "not_requested"
  | "applied"
  | "process_gone"
  | "permission_denied"
  | "failed";

export interface ProcessPriorityResult {
  readonly requested: ManagedProcessPriority;
  readonly application: ProcessPriorityApplication;
  readonly appliesToNewProcessesOnly: true;
  readonly backgroundPolicyApplied: boolean;
}

export interface ProcessPriorityDependencies {
  readonly platform?: NodeJS.Platform;
  readonly setPriority?: (pid: number, priority: number) => void;
  readonly applyDarwinBackgroundPolicy?: (pid: number) => Promise<boolean>;
}

export function recommendedToolchainThreads(priority: ManagedProcessPriority, availableParallelism: number): number {
  const cores = Math.max(1, Math.floor(Number.isFinite(availableParallelism) ? availableParallelism : 1));
  return Math.max(1, Math.ceil(cores / (priority === "lowest" ? 4 : 2)));
}

export function toolchainThreadEnvironment(
  settings: Pick<AgentResourceSettings, "capToolchainThreads" | "processPriority">,
  baseEnvironment: Readonly<NodeJS.ProcessEnv>,
  options: {
    readonly availableParallelism?: number;
    readonly platform?: NodeJS.Platform;
  } = {}
): Readonly<Record<string, string>> {
  if (!settings.capToolchainThreads) return {};
  const platform = options.platform ?? process.platform;
  const threads = recommendedToolchainThreads(
    settings.processPriority,
    options.availableParallelism ?? os.availableParallelism()
  );
  const desired: Record<string, string> = {
    VITEST_MAX_FORKS: String(threads),
    VITEST_MAX_THREADS: String(threads),
    CARGO_BUILD_JOBS: String(threads),
    ...(platform === "win32" ? {} : { MAKEFLAGS: `-j${threads}` })
  };
  const additions: Record<string, string> = {};
  for (const [key, value] of Object.entries(desired)) {
    if (!hasEnvironmentKey(baseEnvironment, key, platform)) additions[key] = value;
  }
  return additions;
}

export async function applyNewProcessPriority(
  pid: number,
  priority: ManagedProcessPriority,
  dependencies: ProcessPriorityDependencies = {}
): Promise<ProcessPriorityResult> {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    return { requested: priority, application: "failed", appliesToNewProcessesOnly: true, backgroundPolicyApplied: false };
  }
  if (priority === "normal") {
    return {
      requested: priority,
      application: "not_requested",
      appliesToNewProcessesOnly: true,
      backgroundPolicyApplied: false
    };
  }
  const platform = dependencies.platform ?? process.platform;
  const setPriority = dependencies.setPriority ?? os.setPriority;
  let application: ProcessPriorityApplication = "applied";
  try {
    setPriority(
      pid,
      priority === "lowest"
        ? os.constants.priority.PRIORITY_LOW
        : os.constants.priority.PRIORITY_BELOW_NORMAL
    );
  } catch (error) {
    const code = systemErrorCode(error);
    application = code === "ESRCH"
      ? "process_gone"
      : code === "EPERM" || code === "EACCES"
        ? "permission_denied"
        : "failed";
  }
  let backgroundPolicyApplied = false;
  if (platform === "darwin" && priority === "lowest" && application === "applied") {
    const applyBackgroundPolicy = dependencies.applyDarwinBackgroundPolicy ?? defaultDarwinBackgroundPolicy;
    backgroundPolicyApplied = await applyBackgroundPolicy(pid).catch(() => false);
  }
  return { requested: priority, application, appliesToNewProcessesOnly: true, backgroundPolicyApplied };
}

async function defaultDarwinBackgroundPolicy(pid: number): Promise<boolean> {
  await execFileAsync("/usr/sbin/taskpolicy", ["-b", "-p", String(pid)], {
    timeout: 5_000,
    windowsHide: true
  });
  return true;
}

export function systemErrorCode(error: unknown): string | undefined {
  const candidate = error as NodeJS.ErrnoException & { readonly info?: { readonly code?: string } };
  if (typeof candidate?.info?.code === "string") return candidate.info.code;
  if (typeof candidate?.code === "string" && candidate.code !== "ERR_SYSTEM_ERROR") return candidate.code;
  return /\b(EACCES|EPERM|ESRCH)\b/u.exec(String(candidate?.message ?? ""))?.[1];
}

function hasEnvironmentKey(environment: Readonly<NodeJS.ProcessEnv>, key: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return environment[key] !== undefined;
  const normalized = key.toLowerCase();
  return Object.keys(environment).some((candidate) => candidate.toLowerCase() === normalized);
}
