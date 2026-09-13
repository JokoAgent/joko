import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  MANAGED_SUBAGENT_ACTIVITY_MARKER,
  MANAGED_SUBAGENT_COMMAND_NAME,
  MANAGED_SUBAGENT_CONTROL_COMMAND_NAME,
  MANAGED_SUBAGENT_FILE_NAME,
  MANAGED_SUBAGENT_HARD_LIMIT_ENV,
  MANAGED_SUBAGENT_IDLE_RELEASE_ENV,
  MANAGED_SUBAGENT_PRODUCT_SESSION_ENV,
  MANAGED_SUBAGENT_SOFT_LIMIT_ENV,
  MANAGED_SUBAGENT_SOURCE,
  MANAGED_SUBAGENT_STATUS_TOOL_NAME,
  MANAGED_SUBAGENT_TOOL_NAME
} from "./managed-subagent-source.js";
import {
  MANAGED_SUBAGENT_PROFILE_NAMES,
  MANAGED_SUBAGENT_THINKING_LEVELS,
  MANAGED_SUBAGENT_TOOL_DESCRIPTORS,
  provisionManagedSubagent
} from "./managed-subagent.js";
import { mkdtemp } from "./test-paths.js";
import {
  MANAGED_SUBAGENT_RUNNER_FILE_NAME,
  MANAGED_SUBAGENT_RUNNER_SOURCE
} from "./managed-subagent-runner-source.js";

const execFileAsync = promisify(execFile);

describe("managed Pi subagent extension", () => {
  it("is valid standalone TypeScript with retained Apache-2.0 attribution", () => {
    const result = ts.transpileModule(MANAGED_SUBAGENT_SOURCE, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext
      },
      fileName: MANAGED_SUBAGENT_FILE_NAME,
      reportDiagnostics: true
    });
    const errors = (result.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
    expect(errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
    expect(MANAGED_SUBAGENT_SOURCE).toContain("Includes Apache-2.0 licensed portions.");
    expect(MANAGED_SUBAGENT_SOURCE).toContain("Copyright 2026 XD Inc.");
    expect(MANAGED_SUBAGENT_SOURCE).not.toMatch(/from\s+["'](?:\.\.?[\\/]|[A-Za-z]:)/u);
  });

  it("binds a durable resume status path and identity to its immutable launch config", async () => {
    const validate = resumeSessionValidationHelper();
    const sessionRoot = await mkdtemp(join(tmpdir(), "joko-pi-resume-fence-"));
    const runDirectory = join(sessionRoot, randomUUID());
    const sessionsDirectory = join(runDirectory, "sessions");
    const configuredNativeSessionId = randomUUID();
    const substitutedNativeSessionId = randomUUID();
    const configuredSessionPath = join(sessionsDirectory, `${configuredNativeSessionId}.jsonl`);
    const substitutedSessionPath = join(sessionsDirectory, `${substitutedNativeSessionId}.jsonl`);
    await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(configuredSessionPath, "{}\n", { mode: 0o600 }),
      writeFile(substitutedSessionPath, "{}\n", { mode: 0o600 })
    ]);

    expect(() => validate(runDirectory, {
      config: { nativeSessionId: configuredNativeSessionId },
      status: {
        nativeSessionId: substitutedNativeSessionId,
        nativeSessionPath: substitutedSessionPath
      }
    })).toThrow(/native session is unavailable or escaped storage/iu);
    expect(validate(runDirectory, {
      config: { nativeSessionId: configuredNativeSessionId },
      status: {
        nativeSessionId: configuredNativeSessionId,
        nativeSessionPath: configuredSessionPath
      }
    })).toMatchObject({ sessionPath: configuredSessionPath });
  });

  it("forwards foreground permission and capacity requests once and fails closed", async () => {
    const helpers = foregroundApprovalHelpers();
    const writes: string[] = [];
    let confirmCalls = 0;
    let resolveConfirm!: (value: boolean) => void;
    const confirmation = new Promise<boolean>((resolve) => { resolveConfirm = resolve; });
    const controller = approvalController(writes);
    const event = {
      type: "extension_ui_request",
      id: "approval-one",
      method: "confirm",
      title: "joko:permission:bash",
      message: "Run bounded reviewed evidence"
    };
    const context = { ui: { confirm: async () => { confirmCalls += 1; return confirmation; } } };
    helpers.handleChildApproval(controller, event, context);
    helpers.handleChildApproval(controller, event, context);
    expect(confirmCalls).toBe(0);
    await Promise.resolve();
    expect(confirmCalls).toBe(1);
    resolveConfirm(true);
    await waitForWrites(writes, 1);
    expect(JSON.parse(writes[0]!)).toEqual({ type: "extension_ui_response", id: "approval-one", confirmed: true });

    const denied: string[] = [];
    helpers.handleChildApproval(approvalController(denied), { ...event, id: "approval-two" }, {
      ui: { confirm: async () => { throw new Error("cancelled"); } }
    });
    await waitForWrites(denied, 1);
    expect(JSON.parse(denied[0]!)).toEqual({ type: "extension_ui_response", id: "approval-two", confirmed: false });

    const gated: string[] = [];
    helpers.handleChildApproval(approvalController(gated), {
      type: "extension_ui_request",
      id: "gate-one",
      method: "input",
      title: `joko:command-gate/v1/acquire/${Buffer.from("tool-one").toString("base64url")}`,
      placeholder: ""
    }, { ui: { input: async () => "admitted" } });
    await waitForWrites(gated, 1);
    expect(JSON.parse(gated[0]!)).toEqual({ type: "extension_ui_response", id: "gate-one", value: "admitted" });

    const policyWrites: string[] = [];
    const policyTitle = `joko:policy-decision/v1/${"a".repeat(8_000)}`;
    let receivedPolicyTitle = "";
    helpers.handleChildApproval(approvalController(policyWrites), {
      type: "extension_ui_request",
      id: "policy-one",
      method: "input",
      title: policyTitle,
      placeholder: ""
    }, { ui: { input: async (title: string) => { receivedPolicyTitle = title; return "deny"; } } });
    await waitForWrites(policyWrites, 1);
    expect(receivedPolicyTitle).toBe(policyTitle);
    expect(JSON.parse(policyWrites[0]!)).toEqual({ type: "extension_ui_response", id: "policy-one", value: "deny" });
  });

  it("strictly normalizes built-in and inline custom read-only roles", () => {
    const helpers = invocationHelpers();
    const builtIns = helpers.normalizeTasks({
      tasks: MANAGED_SUBAGENT_PROFILE_NAMES.map((agent) => ({ agent, task: `Inspect as ${agent}` }))
    });
    expect(builtIns.map((task) => task.agent)).toEqual(MANAGED_SUBAGENT_PROFILE_NAMES);
    expect(builtIns.find((task) => task.agent === "worker")?.profile).toMatchObject({
      tools: "read,grep,find,ls,edit,write,bash",
      toolClass: "write",
      readOnly: false
    });

    const [custom] = helpers.normalizeTasks({
      task: "Inspect one file",
      customRole: { name: "api_reader", prompt: "Focus on public contracts.", toolClass: "read" }
    });
    expect(custom).toMatchObject({
      agent: "api_reader",
      profile: { tools: "read", toolClass: "read" }
    });
    expect(custom?.profile.prompt).toContain("strictly read-only");
    expect(custom?.profile.prompt).not.toContain("Focus on public contracts.");
    expect(custom?.profile.rolePrompt).toBe("Focus on public contracts.");
    const [routed] = helpers.normalizeTasks({
      agent: "scout",
      task: "Use an exact route",
      provider: "alpha-provider",
      model: "family/model-v1",
      thinking: "high"
    });
    expect(routed).toMatchObject({ provider: "alpha-provider", model: "family/model-v1", thinking: "high" });
    expect(() => helpers.normalizeTasks({
      agent: "scout",
      task: "Missing model",
      provider: "alpha-provider"
    })).toThrow(/requires an exact model id/u);
    expect(() => helpers.normalizeTasks({
      agent: "scout",
      task: "ambiguous",
      customRole: { name: "reader", prompt: "Read.", toolClass: "read" }
    })).toThrow(/cannot combine agent with customRole/u);
    expect(() => helpers.normalizeTasks({
      task: "unsafe class",
      customRole: { name: "writer", prompt: "Change it.", toolClass: "write" }
    })).toThrow(/must be read or search/u);
    expect(() => helpers.normalizeTasks({
      task: "reserved role",
      customRole: { name: "scout", prompt: "Read.", toolClass: "read" }
    })).toThrow(/invalid or reserved/u);
    expect(helpers.normalizeTasks({
      tasks: [{ id: "step_a", agent: "worker", title: "T".repeat(120), task: "x".repeat(32_000), model: "m".repeat(500) }]
    })[0]).toMatchObject({ id: "step_a", title: "T".repeat(120), task: "x".repeat(32_000), model: "m".repeat(500) });
    expect(() => helpers.normalizeTasks({ agent: "worker", task: "x".repeat(32_001) })).toThrow(/32000/u);
    expect(() => helpers.normalizeTasks({ agent: "worker", title: "x".repeat(121), task: "work" })).toThrow(/120/u);
    expect(() => helpers.normalizeTasks({ agent: "worker", model: "m".repeat(501), task: "work" })).toThrow(/500/u);
    expect(() => helpers.normalizeTasks({
      tasks: [{ id: "same", agent: "scout", task: "one" }, { id: "same", agent: "worker", task: "two" }]
    })).toThrow(/duplicate subagent task id/u);
  });

  it("resolves every child route against provider-aware session models and thinking support", () => {
    const helpers = invocationHelpers();
    const alpha = { provider: "alpha", id: "shared-model", reasoning: true, thinkingLevelMap: {} };
    const beta = { provider: "beta", id: "shared-model", reasoning: true, thinkingLevelMap: { high: null } };
    const plain = { provider: "alpha", id: "plain-model", reasoning: false };
    const context = {
      model: alpha,
      thinkingLevel: "medium",
      scopedModels: [],
      modelRegistry: { getAvailable: () => [alpha, beta, plain] }
    };

    expect(helpers.routeFromContext(context, { provider: "beta", model: "shared-model", thinking: "low" })).toEqual({
      provider: "beta",
      model: "shared-model",
      effort: "low"
    });
    expect(helpers.routeFromContext(context, { provider: "", model: "shared-model", thinking: "" })).toEqual({
      provider: "alpha",
      model: "shared-model",
      effort: "medium"
    });
    expect(() => helpers.routeFromContext(
      { ...context, model: { provider: "gamma", id: "current-model", reasoning: true } },
      { provider: "", model: "shared-model", thinking: "off" }
    )).toThrow(/ambiguous across providers/u);
    expect(() => helpers.routeFromContext(context, {
      provider: "alpha",
      model: "plain-model",
      thinking: "high"
    })).toThrow(/unsupported by the selected model/u);
    expect(() => helpers.routeFromContext(context, {
      provider: "beta",
      model: "shared-model",
      thinking: "high"
    })).toThrow(/unavailable for the selected provider\/model route/u);
    expect(() => helpers.routeFromContext(
      { ...context, scopedModels: [{ model: alpha }] },
      { provider: "beta", model: "shared-model", thinking: "off" }
    )).toThrow(/not available in this session/u);
  });

  it("validates the managed subagent deadline boundary", () => {
    const helpers = invocationHelpers();
    expect(helpers.timeoutMs({})).toBe(1_800_000);
    expect(helpers.timeoutMs({ timeoutSeconds: 86_400 })).toBe(86_400_000);
    expect(() => helpers.timeoutMs({ timeoutSeconds: 86_401 })).toThrow(/10 to 86400/u);
  });

  it("forks only an immutable bounded user/assistant text snapshot", () => {
    const snapshot = parentSnapshotHelper()({
      sessionManager: {
        getBranch: () => [{
          type: "message",
          message: { role: "user", content: [{ type: "text", text: `keep sk-${"a".repeat(20)} ${"u".repeat(20_000)}` }] }
        }, {
          type: "message",
          message: { role: "assistant", content: [{ type: "image", data: "ignored" }, { type: "text", text: "a".repeat(20_000) }] }
        }, {
          type: "message",
          message: { role: "tool", content: [{ type: "text", text: "must-not-copy" }] }
        }]
      }
    });
    expect(snapshot).toHaveLength(32_000);
    expect(snapshot).toContain("USER:\nkeep [REDACTED]");
    expect(snapshot).toContain("ASSISTANT:\n");
    expect(snapshot).not.toContain("must-not-copy");
    expect(snapshot).not.toContain(`sk-${"a".repeat(20)}`);
  });

  it("requires an authoritative linked worktree when isolation is requested", () => {
    let calls = 0;
    isolationHelper(() => {
      calls += 1;
      return { status: 0, stdout: "true\n" };
    })({ isolation: "inherit" });
    expect(calls).toBe(0);

    const root = process.cwd();
    const common = join(root, ".git");
    const primary = isolationHelper((args) => gitProbe(args, root, common, common));
    expect(() => primary({ isolation: "require-worktree" })).toThrow(/authoritative linked Git worktree/u);

    const linkedGit = join(common, "worktrees", "managed-child");
    const linked = isolationHelper((args) => gitProbe(args, root, linkedGit, common));
    expect(() => linked({ isolation: "require-worktree" })).not.toThrow();
  });

  it("enforces configured worker soft, hard, idle-release, and inherited toolchain caps", () => {
    expect(MANAGED_SUBAGENT_SOFT_LIMIT_ENV).toBe("JOKO_PI_WORKER_SOFT_LIMIT");
    expect(MANAGED_SUBAGENT_HARD_LIMIT_ENV).toBe("JOKO_PI_WORKER_HARD_LIMIT");
    expect(MANAGED_SUBAGENT_IDLE_RELEASE_ENV).toBe("JOKO_PI_WORKER_IDLE_RELEASE_MINUTES");
  });

  it("separates durable background ownership from foreground shutdown cleanup", () => {
    expect(MANAGED_SUBAGENT_TOOL_NAME).toBe("subagent");
    expect(MANAGED_SUBAGENT_STATUS_TOOL_NAME).toBe("subagent_status");
    expect(MANAGED_SUBAGENT_COMMAND_NAME).toBe("subagents");
    expect(MANAGED_SUBAGENT_CONTROL_COMMAND_NAME).toBe("joko-stop-background-task");
    expect(MANAGED_SUBAGENT_PRODUCT_SESSION_ENV).toBe("JOKO_PI_PRODUCT_SESSION_ID");
    expect(MANAGED_SUBAGENT_ACTIVITY_MARKER).toBe("__jokoSubagentActivity");
  });

  it("executes the generated watchdog logic and exits after its real parent dies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "joko-pi-subagent-watchdog-"));
    const watchdogPath = join(directory, "watchdog.mjs");
    const launcherPath = join(directory, "launcher.mjs");
    const start = MANAGED_SUBAGENT_SOURCE.indexOf("function installParentWatchdog()");
    const end = MANAGED_SUBAGENT_SOURCE.indexOf("\n\nfunction profileNames", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const watchdogFunction = MANAGED_SUBAGENT_SOURCE.slice(start, end);
    await Promise.all([
      writeFile(
        watchdogPath,
        [
          'const PARENT_PID_ENV = "JOKO_PI_SUBAGENT_PARENT_PID";',
          "const PARENT_WATCHDOG_INTERVAL_MS = 25;",
          watchdogFunction,
          "installParentWatchdog();",
          'process.stdout.write("ready\\n");',
          "setInterval(() => {}, 1000);"
        ].join("\n"),
        "utf8"
      ),
      writeFile(
        launcherPath,
        [
          'import { spawn } from "node:child_process";',
          `const child = spawn(process.execPath, [${JSON.stringify(watchdogPath)}], {`,
          '  env: { ...process.env, JOKO_PI_SUBAGENT_PARENT_PID: String(process.pid) },',
          '  stdio: ["ignore", "pipe", "ignore"], windowsHide: true',
          "});",
          'child.stdout.once("data", () => { process.stdout.write(String(child.pid)); process.exit(0); });'
        ].join("\n"),
        "utf8"
      )
    ]);
    const { stdout } = await execFileAsync(process.execPath, [launcherPath], { windowsHide: true, timeout: 5_000 });
    const childPid = Number.parseInt(stdout.trim(), 10);
    expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
    try {
      await expectProcessToExit(childPid, 5_000);
    } finally {
      try { process.kill(childPid, "SIGKILL"); } catch {}
    }
  }, 10_000);

  it("atomically provisions the exact managed source under Agent Home", async () => {
    const home = await mkdtemp(join(tmpdir(), "joko-pi-subagent-"));
    await mkdir(join(home, "managed"), { recursive: true });
    const path = await provisionManagedSubagent(home);
    expect(path).toBe(join(home, "managed", MANAGED_SUBAGENT_FILE_NAME));
    expect(await readFile(path, "utf8")).toBe(MANAGED_SUBAGENT_SOURCE);
    expect(await readFile(join(home, "managed", MANAGED_SUBAGENT_RUNNER_FILE_NAME), "utf8")).toBe(MANAGED_SUBAGENT_RUNNER_SOURCE);
  });

  it("publishes backend-neutral descriptors for both managed tools", () => {
    expect(MANAGED_SUBAGENT_TOOL_DESCRIPTORS).toEqual([
      expect.objectContaining({ name: "subagent", requiresPermission: true, streamingUpdates: true, enabled: true }),
      expect.objectContaining({ name: "subagent_status", requiresPermission: true, streamingUpdates: false, enabled: true })
    ]);
    expect(MANAGED_SUBAGENT_TOOL_DESCRIPTORS[0]?.inputSchema.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fieldPath: "action", enumValues: ["run", "doctor", "guide"] }),
        expect.objectContaining({ fieldPath: "agent", enumValues: MANAGED_SUBAGENT_PROFILE_NAMES }),
        expect.objectContaining({ fieldPath: "customRole.toolClass", enumValues: ["read", "search"] }),
        expect.objectContaining({ fieldPath: "provider", constraints: expect.objectContaining({ maximumLength: 128 }) }),
        expect.objectContaining({ fieldPath: "model", constraints: expect.objectContaining({ maximumLength: 500 }) }),
        expect.objectContaining({ fieldPath: "thinking", enumValues: MANAGED_SUBAGENT_THINKING_LEVELS }),
        expect.objectContaining({ fieldPath: "tasks[].provider" }),
        expect.objectContaining({ fieldPath: "tasks[].model" }),
        expect.objectContaining({ fieldPath: "tasks[].thinking", enumValues: MANAGED_SUBAGENT_THINKING_LEVELS }),
        expect.objectContaining({ fieldPath: "background", type: "boolean" }),
        expect.objectContaining({ fieldPath: "context", enumValues: ["fresh", "fork"] }),
        expect.objectContaining({ fieldPath: "isolation", enumValues: ["inherit", "require-worktree"] }),
        expect.objectContaining({ fieldPath: "timeoutSeconds", constraints: { minimumNumber: 10, maximumNumber: 86_400 } })
      ])
    );
    expect(MANAGED_SUBAGENT_TOOL_DESCRIPTORS[1]?.inputSchema.fields[0]?.enumValues).toEqual([
      "list", "inspect", "wait", "cancel", "steer", "follow_up", "resume"
    ]);
    expect(MANAGED_SUBAGENT_TOOL_DESCRIPTORS[1]?.inputSchema.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldPath: "message", constraints: { minimumLength: 1, maximumLength: 32_000 } })
    ]));
  });
});

interface InvocationHelpers {
  normalizeTasks(params: Record<string, unknown>): Array<{
    agent: string;
    provider: string;
    model: string;
    thinking: string;
    profile: { tools: string; toolClass: string; prompt: string; rolePrompt?: string; readOnly?: boolean };
  }>;
  routeFromContext(
    context: Record<string, unknown>,
    task: { provider: string; model: string; thinking: string }
  ): { provider: string; model: string; effort: string };
  timeoutMs(params: Record<string, unknown>): number;
}

function invocationHelpers(): InvocationHelpers {
  const constantsStart = MANAGED_SUBAGENT_SOURCE.indexOf("const MAX_TASKS");
  const constantsEnd = MANAGED_SUBAGENT_SOURCE.indexOf("\n\nconst liveChildren", constantsStart);
  const normalizationStart = MANAGED_SUBAGENT_SOURCE.indexOf("function optionalText");
  const normalizationEnd = MANAGED_SUBAGENT_SOURCE.indexOf("\n\nfunction timeoutMs", normalizationStart);
  const timeoutStart = MANAGED_SUBAGENT_SOURCE.indexOf("function timeoutMs", normalizationEnd);
  const timeoutEnd = MANAGED_SUBAGENT_SOURCE.indexOf("\n\nfunction availableModelsFromContext", timeoutStart);
  const routingStart = MANAGED_SUBAGENT_SOURCE.indexOf("function availableModelsFromContext");
  const routingEnd = MANAGED_SUBAGENT_SOURCE.indexOf("\n\nfunction guideText", routingStart);
  for (const boundary of [constantsStart, constantsEnd, normalizationStart, normalizationEnd, timeoutStart, timeoutEnd, routingStart, routingEnd]) {
    expect(boundary).toBeGreaterThanOrEqual(0);
  }
  const body = [
    MANAGED_SUBAGENT_SOURCE.slice(constantsStart, constantsEnd),
    "function profileNames() { return Object.keys(PROFILES).join(' | '); }",
    MANAGED_SUBAGENT_SOURCE.slice(normalizationStart, normalizationEnd),
    MANAGED_SUBAGENT_SOURCE.slice(timeoutStart, timeoutEnd),
    MANAGED_SUBAGENT_SOURCE.slice(routingStart, routingEnd),
    "return { normalizeTasks, routeFromContext, timeoutMs };"
  ].join("\n\n");
  return Function(body)() as InvocationHelpers;
}

function foregroundApprovalHelpers(): {
  handleChildApproval(controller: Record<string, unknown>, event: Record<string, unknown>, context: Record<string, unknown>): void;
} {
  const start = MANAGED_SUBAGENT_SOURCE.indexOf("function sendRpcNotification");
  const end = MANAGED_SUBAGENT_SOURCE.indexOf("\n\nfunction closeController", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const body = [
    'function redact(value) { return typeof value === "string" ? value : String(value || ""); }',
    'function clampText(value, maximum) { const text = redact(value).trim(); return text.length <= maximum ? text : text.slice(0, maximum - 1) + "…"; }',
    "const MAX_POLICY_DECISION_TITLE_CHARS = 9 * 1024;",
    MANAGED_SUBAGENT_SOURCE.slice(start, end),
    "return { handleChildApproval };"
  ].join("\n\n");
  return Function(body)() as ReturnType<typeof foregroundApprovalHelpers>;
}

function parentSnapshotHelper(): (context: Record<string, unknown>) => string {
  const start = MANAGED_SUBAGENT_SOURCE.indexOf("function clampText");
  const end = MANAGED_SUBAGENT_SOURCE.indexOf("\n\nfunction collectCredentialValues", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const body = [
    "const MAX_PARENT_CONTEXT_CHARS = 32000;",
    "const inheritedRedactionValues = [];",
    MANAGED_SUBAGENT_SOURCE.slice(start, end),
    "return parentContextSnapshot;"
  ].join("\n\n");
  return Function("relative", "sep", "isAbsolute", "resolve", "realpathSync", "spawnSync", body)(
    relative,
    sep,
    isAbsolute,
    resolve,
    (value: string) => value,
    () => ({ status: 1, stdout: "" })
  ) as (context: Record<string, unknown>) => string;
}

function resumeSessionValidationHelper(): (
  runDirectory: string,
  snapshot: {
    readonly config: { readonly nativeSessionId?: string; readonly resumeSessionPath?: string };
    readonly status: { readonly nativeSessionId?: string; readonly nativeSessionPath?: string };
  }
) => { readonly sessionPath: string; readonly claimPath: string } {
  const helpersStart = MANAGED_SUBAGENT_SOURCE.indexOf("function isContained");
  const helpersEnd = MANAGED_SUBAGENT_SOURCE.indexOf("\n\nfunction sameIdentity", helpersStart);
  const validationStart = MANAGED_SUBAGENT_SOURCE.indexOf("function validateResumeSession");
  const validationEnd = MANAGED_SUBAGENT_SOURCE.indexOf("\n\nasync function launchDurableJob", validationStart);
  for (const boundary of [helpersStart, helpersEnd, validationStart, validationEnd]) expect(boundary).toBeGreaterThanOrEqual(0);
  const body = [
    "const RUN_FORMAT = 1;",
    MANAGED_SUBAGENT_SOURCE.slice(helpersStart, helpersEnd),
    MANAGED_SUBAGENT_SOURCE.slice(validationStart, validationEnd),
    "return validateResumeSession;"
  ].join("\n\n");
  return Function(
    "resolve", "dirname", "relative", "sep", "isAbsolute", "basename",
    "lstatSync", "realpathSync", "join", "writeFileSync", "randomUUID",
    body
  )(
    resolve, dirname, relative, sep, isAbsolute, basename,
    lstatSync, realpathSync, join, writeFileSync, randomUUID
  ) as ReturnType<typeof resumeSessionValidationHelper>;
}

function isolationHelper(
  spawnProbe: (args: readonly string[]) => { status: number; stdout: string }
): (input: Record<string, unknown>) => void {
  const start = MANAGED_SUBAGENT_SOURCE.indexOf("function isContained");
  const end = MANAGED_SUBAGENT_SOURCE.indexOf("\n\nfunction parentContextSnapshot", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const body = `${MANAGED_SUBAGENT_SOURCE.slice(start, end)}\n\nreturn enforceIsolation;`;
  return Function("relative", "sep", "isAbsolute", "resolve", "realpathSync", "spawnSync", body)(
    relative,
    sep,
    isAbsolute,
    resolve,
    (value: string) => value,
    (_command: string, args: readonly string[]) => spawnProbe(args)
  ) as (input: Record<string, unknown>) => void;
}

function gitProbe(
  args: readonly string[],
  root: string,
  gitDirectory: string,
  commonDirectory: string
): { status: number; stdout: string } {
  const query = args[1];
  if (query === "--is-inside-work-tree") return { status: 0, stdout: "true\n" };
  if (query === "--git-dir") return { status: 0, stdout: `${gitDirectory}\n` };
  if (query === "--git-common-dir") return { status: 0, stdout: `${commonDirectory}\n` };
  if (query === "--show-toplevel") return { status: 0, stdout: `${root}\n` };
  return { status: 1, stdout: "" };
}

function approvalController(writes: string[]): Record<string, unknown> {
  return {
    alive: true,
    retiring: false,
    approvals: new Map(),
    child: { stdin: { write: (value: string) => { writes.push(value.trim()); } } }
  };
}

async function waitForWrites(writes: readonly string[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && writes.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(writes).toHaveLength(count);
}

async function expectProcessToExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() >= deadline) throw new Error(`Watchdog child ${pid} survived its parent`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
