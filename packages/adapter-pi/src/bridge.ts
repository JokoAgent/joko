import { join } from "node:path";
import {
  MAXIMUM_POLICY_DECISION_ENVELOPE_CHARACTERS
} from "./policy-decision-bridge.js";
import { provisionManagedAutoReviewRuntime } from "./auto-review-runtime.js";
import { atomicWriteFile } from "./config.js";
import {
  MAXIMUM_PI_RUNTIME_TOOL_CATALOG_BYTES,
  PI_RUNTIME_TOOL_CATALOG_CHUNK_BYTES
} from "./runtime-tool-catalog.js";

const BRIDGE_FILE_NAME = "joko-managed-bridge.ts";

export const DEFAULT_MANAGED_BASH_TIMEOUT_SECONDS = 300;
export const MAXIMUM_MANAGED_BASH_TIMEOUT_SECONDS = 1_800;
export const MAXIMUM_MANAGED_MCP_BRIDGE_RESPONSE_BYTES = 2 * 1024 * 1024;

export function normalizeManagedBashTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_MANAGED_BASH_TIMEOUT_SECONDS;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAXIMUM_MANAGED_BASH_TIMEOUT_SECONDS
  ) {
    throw new Error("Invalid bash timeout: expected a finite number of seconds in (0, 1800]");
  }
  return value;
}

export async function provisionManagedBridge(agentHome: string): Promise<string> {
  const path = join(agentHome, "managed", BRIDGE_FILE_NAME);
  await provisionManagedAutoReviewRuntime(agentHome);
  await atomicWriteFile(path, MANAGED_BRIDGE_SOURCE);
  return path;
}

/**
 * Loaded explicitly after `--no-extensions`. It deliberately ignores project
 * settings/extensions and reads only generation-scoped files provisioned by
 * Orchestrator. Secrets are never written into this source.
 */
export const MANAGED_BRIDGE_SOURCE = String.raw`
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createPiAutoReviewer } from "./joko-managed-auto-review.mjs";

type ApprovedRoot = { path: string; access: "read_only" | "read_write" };
type Control = { generation: number; policyGeneration: number; permissionMode: "ask" | "auto" | "bypassPermissions"; planMode: boolean; fastMode: boolean; approvedRoots: ApprovedRoot[]; runtimePolicy: "standard" | "review_read_only"; writtenAt: string };
type PolicySubjectKind = "file_read" | "file_write" | "command" | "network" | "mcp" | "browser" | "resource" | "extra_directory";
type PolicyRisk = "read_only" | "low" | "medium" | "high" | "critical";
type PolicyObservation = { subjectKind: PolicySubjectKind; risk: PolicyRisk; workspaceRelativePath?: string; toolProviderId?: string; toolName?: string };
type McpTool = { serverId: string; name: string; runtimeName?: string; policySubject?: PolicySubjectKind; description: string; inputSchema: Record<string, unknown>; requiresPermission: boolean };
type McpDescriptor = { endpoint: string; generation: number; sessionId: string; targetId: string; tools: McpTool[] };
type McpBridgeErrorCode = "resource_exhausted" | "artifact_unavailable" | "invalid_result";
const DEFAULT_BASH_TIMEOUT_SECONDS = 300;
const MAX_BASH_TIMEOUT_SECONDS = 1800;
const MAX_MCP_BRIDGE_RESPONSE_BYTES = ${MAXIMUM_MANAGED_MCP_BRIDGE_RESPONSE_BYTES};
const RUNTIME_TOOL_CATALOG_STATUS_KEY = "joko-runtime-tool-catalog/v1";
const MAX_RUNTIME_TOOL_CATALOG_BYTES = ${MAXIMUM_PI_RUNTIME_TOOL_CATALOG_BYTES};
const RUNTIME_TOOL_CATALOG_CHUNK_BYTES = ${PI_RUNTIME_TOOL_CATALOG_CHUNK_BYTES};
const COMMAND_GATE_REQUEST_PREFIX = "joko:command-gate/v1/";
const POLICY_DECISION_REQUEST_PREFIX = "joko:policy-decision/v1/";
const MAX_POLICY_DECISION_ENVELOPE_CHARACTERS = ${MAXIMUM_POLICY_DECISION_ENVELOPE_CHARACTERS};

const controlPath = process.env.JOKO_PI_CONTROL_FILE;
const mcpDescriptorPath = process.env.JOKO_PI_MCP_DESCRIPTOR_FILE;
const workspaceRoot = process.env.JOKO_PI_WORKSPACE_ROOT ? realpathSync(process.env.JOKO_PI_WORKSPACE_ROOT) : process.cwd();
const runtimeGeneration = Number(process.env.JOKO_PI_GENERATION);
const mcpToken = process.env.JOKO_PI_MCP_TOKEN;
let secretEnvironmentNames: string[] = [];
try {
  const parsed = JSON.parse(process.env.JOKO_PI_SECRET_ENV_NAMES ?? "[]");
  if (Array.isArray(parsed)) secretEnvironmentNames = parsed.filter((value): value is string => typeof value === "string");
} catch {}
delete process.env.JOKO_PI_MCP_TOKEN;
delete process.env.JOKO_PI_SECRET_ENV_NAMES;

async function commandGateRequest(ctx: any, action: "acquire" | "release", toolCallId: string): Promise<void> {
  if (!ctx.hasUI) throw new Error("Orchestrator command capacity control is unavailable");
  const title = COMMAND_GATE_REQUEST_PREFIX + action + "/" + Buffer.from(toolCallId, "utf8").toString("base64url");
  const response = await ctx.ui.input(title, "");
  if (response !== (action === "acquire" ? "admitted" : "released")) {
    throw new Error(action === "acquire"
      ? "Command execution was cancelled before capacity became available"
      : "Command capacity release was not acknowledged");
  }
}

function readControl(): Control {
  if (!controlPath) throw new Error("Joko control file is unavailable");
  const value = JSON.parse(readFileSync(controlPath, "utf8")) as Control;
  if (value.generation !== runtimeGeneration) throw new Error("Joko runtime generation fence mismatch");
  if (!Number.isSafeInteger(value.policyGeneration) || value.policyGeneration < 0) throw new Error("Invalid policy generation");
  if (!['ask', 'auto', 'bypassPermissions'].includes(value.permissionMode)) throw new Error("Invalid permission control state");
  if (typeof value.planMode !== "boolean" || typeof value.fastMode !== "boolean") throw new Error("Invalid execution mode control state");
  if (!['standard', 'review_read_only'].includes(value.runtimePolicy)) throw new Error("Invalid immutable runtime policy");
  if (!Array.isArray(value.approvedRoots) || value.approvedRoots.some((root) =>
    !root || typeof root.path !== "string" || !isAbsolute(root.path) ||
    !["read_only", "read_write"].includes(root.access))) {
    throw new Error("Invalid approved-root control state");
  }
  return value;
}

function assertPolicyUnchanged(expected: Control): Control {
  const current = readControl();
  if (current.policyGeneration !== expected.policyGeneration) {
    throw new Error("Joko policy changed while the interaction was pending");
  }
  return current;
}

function advancePolicy(control: Control): Control {
  return { ...control, policyGeneration: control.policyGeneration + 1, writtenAt: new Date().toISOString() };
}

function bashTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_BASH_TIMEOUT_SECONDS;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_BASH_TIMEOUT_SECONDS) {
    throw new Error("Invalid bash timeout: expected a finite number of seconds in (0, 1800]");
  }
  return value;
}

function writeControl(control: Control): void {
  if (!controlPath) throw new Error("Joko control file is unavailable");
  const temporary = controlPath + "." + process.pid + ".tmp";
  writeFileSync(temporary, JSON.stringify({ ...control, writtenAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, controlPath);
}

function sanitizeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const denied = new Set(secretEnvironmentNames);
  denied.add("JOKO_PI_MCP_TOKEN");
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (denied.has(key) || /^JOKO_PI_/i.test(key) || /^PI_CODING_AGENT_/i.test(key) || /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}

type PlanReviewResponse = { decision: "execute" | "stay" | "refine"; feedback: string };

function planReviewResponse(value: string | undefined): PlanReviewResponse | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || !["execute", "stay", "refine"].includes(String(parsed.decision))) return undefined;
    return {
      decision: parsed.decision as PlanReviewResponse["decision"],
      feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
    };
  } catch {
    return undefined;
  }
}

function questionResponse(value: string | undefined): Record<string, string | boolean | string[]> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as { answers?: unknown };
    if (!parsed || !parsed.answers || typeof parsed.answers !== "object" || Array.isArray(parsed.answers)) return undefined;
    const answers: Record<string, string | boolean | string[]> = {};
    for (const [key, answer] of Object.entries(parsed.answers as Record<string, unknown>)) {
      if (typeof answer === "string" || typeof answer === "boolean") answers[key] = answer;
      else if (Array.isArray(answer) && answer.every((item) => typeof item === "string")) answers[key] = answer as string[];
      else return undefined;
    }
    return answers;
  } catch {
    return undefined;
  }
}

function freezeToolInput(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value as object)) return;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) freezeToolInput(child, seen);
  Object.freeze(value);
}

type ToolRisk = "safe_read" | "workspace_write" | "safe_command" | "ambiguous" | "dangerous";
const credentialPath = /(?:^|[\\/])(?:\.ssh|\.aws|\.azure|\.config[\\/]gcloud|\.npmrc|\.pypirc|\.netrc|\.env(?:\.[^\\/]*)?|auth\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.[^\\/]*)?|[^\\/]*\.(?:pem|key|p12|pfx)|[^\\/]*(?:credential|secret|token|keychain)[^\\/]*)(?:[\\/]|$)/i;
const dangerousCommand = /\b(?:rm\s+-rf|rmdir\s+\/s|del\s+\/f|format|diskpart|shutdown|reboot|reg\s+(?:delete|add)|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|curl\b.*\|\s*(?:sh|bash)|powershell\b.*-enc)\b/i;
const shellMeta = /(?:\|\||&&|[|;<>\x60]|\$\(|\r|\n)/;

function toolPath(input: unknown, fallback?: string): string | undefined {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  for (const key of ["path", "file_path", "filePath", "directory"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return fallback;
}

function isContained(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(".." + sep) && !isAbsolute(suffix));
}

function authorizedPathAccess(rawPath: string, allowMissing: boolean, control: Control): "read_only" | "read_write" | undefined {
  const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(workspaceRoot, rawPath);
  const roots: ApprovedRoot[] = [
    { path: workspaceRoot, access: "read_write" },
    ...control.approvedRoots.map((root) => ({ path: resolve(root.path), access: root.access })),
  ];
  roots.sort((left, right) => right.path.length - left.path.length);
  const selected = roots.find((root) => isContained(root.path, candidate));
  if (!selected) return undefined;
  try {
    if (lstatSync(selected.path).isSymbolicLink()) return undefined;
  } catch {
    return undefined;
  }
  const suffix = relative(selected.path, candidate);
  let segmentProbe = selected.path;
  for (const segment of suffix.split(sep).filter(Boolean)) {
    segmentProbe = resolve(segmentProbe, segment);
    try {
      if (lstatSync(segmentProbe).isSymbolicLink()) return undefined;
    } catch {
      if (!allowMissing) return undefined;
      break;
    }
  }
  let probe = candidate;
  for (;;) {
    try {
      const info = lstatSync(probe);
      if (info.isSymbolicLink()) return undefined;
      const canonical = realpathSync(probe);
      if (!isContained(selected.path, canonical)) return undefined;
      if (probe === candidate && !info.isFile() && !info.isDirectory()) return undefined;
      return probe === candidate || allowMissing ? selected.access : undefined;
    } catch {
      if (!allowMissing || probe === selected.path) return undefined;
      const parent = dirname(probe);
      if (parent === probe || !isContained(selected.path, parent)) return undefined;
      probe = parent;
    }
  }
}

/** Resolve through the nearest existing ancestor so a missing child below a
 * symlink is reviewed against the symlink's canonical destination. */
function resolveReviewPath(rawPath: string, cwd: string): string | undefined {
  const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);
  let probe = candidate;
  const missing: string[] = [];
  for (;;) {
    try {
      const canonical = realpathSync(probe);
      return resolve(canonical, ...missing.reverse());
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return undefined;
      missing.push(probe.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      probe = parent;
    }
  }
}

function classifyTool(name: string, input: unknown, control: Control): ToolRisk {
  if (name === "ask_user_question") return "safe_read";
  const directManagedDescriptor = mcp?.tools.find((tool) => tool.runtimeName === name);
  if (directManagedDescriptor) return directManagedDescriptor.requiresPermission === false ? "safe_read" : "ambiguous";
  if (name.startsWith("mcp__")) {
    const descriptor = mcp?.tools.find((tool) => name === "mcp__" + tool.serverId + "__" + tool.name);
    return descriptor?.requiresPermission === false ? "safe_read" : "ambiguous";
  }
  if (name === "read" || name === "grep" || name === "find" || name === "ls") {
    const path = toolPath(input, ".");
    if (!path) return "ambiguous";
    if (credentialPath.test(path)) return "dangerous";
    return authorizedPathAccess(path, false, control) ? "safe_read" : "dangerous";
  }
  if (name === "write" || name === "edit") {
    const path = toolPath(input);
    if (!path) return "ambiguous";
    if (credentialPath.test(path)) return "dangerous";
    return authorizedPathAccess(path, true, control) === "read_write" ? "workspace_write" : "dangerous";
  }
  if (name === "bash") {
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const command = typeof record.command === "string" ? record.command.trim() : "";
    if (!command) return "ambiguous";
    if (dangerousCommand.test(command) || credentialPath.test(command)) return "dangerous";
    if (shellMeta.test(command)) return "ambiguous";
    const normalized = command.toLowerCase();
    if (["pwd", "ls", "dir", "git status", "git diff", "git log", "git show"].includes(normalized)) {
      return "safe_command";
    }
  }
  return "ambiguous";
}

function policyRisk(risk: ToolRisk): PolicyRisk {
  if (risk === "safe_read") return "read_only";
  if (risk === "safe_command") return "low";
  if (risk === "workspace_write") return "medium";
  if (risk === "dangerous") return "critical";
  return "high";
}

function policyObservation(name: string, input: unknown, risk: ToolRisk): PolicyObservation {
  const direct = mcp?.tools.find((tool) => tool.runtimeName === name);
  const bridged = direct ?? mcp?.tools.find((tool) => name === "mcp__" + tool.serverId + "__" + tool.name);
  if (bridged) return {
    subjectKind: bridged.policySubject ?? "mcp",
    risk: policyRisk(risk),
    toolProviderId: bridged.serverId,
    toolName: bridged.name,
  };
  if (name === "read" || name === "grep" || name === "find" || name === "ls" || name === "write" || name === "edit") {
    const rawPath = toolPath(input, name === "read" || name === "grep" || name === "find" || name === "ls" ? "." : undefined);
    const canonical = rawPath ? resolveReviewPath(rawPath, workspaceRoot) : undefined;
    const inWorkspace = canonical !== undefined && isContained(workspaceRoot, canonical);
    const workspaceRelativePath = inWorkspace ? relative(workspaceRoot, canonical).split(sep).join("/") : undefined;
    return {
      subjectKind: inWorkspace
        ? (name === "write" || name === "edit" ? "file_write" : "file_read")
        : "extra_directory",
      risk: policyRisk(risk),
      ...(workspaceRelativePath ? { workspaceRelativePath } : {}),
      toolName: name,
    };
  }
  if (name === "bash") return { subjectKind: "command", risk: policyRisk(risk), toolName: name };
  return { subjectKind: "resource", risk: policyRisk(risk), toolName: name };
}

async function orderedPolicyDecision(
  ctx: any,
  control: Control,
  observation: PolicyObservation,
): Promise<"allow" | "deny" | "ask" | "default" | "stale"> {
  if (!ctx.hasUI) return "stale";
  const encoded = Buffer.from(JSON.stringify({
    format: 1,
    policyGeneration: control.policyGeneration,
    ...observation,
  }), "utf8").toString("base64url");
  if (encoded.length > MAX_POLICY_DECISION_ENVELOPE_CHARACTERS) return "stale";
  const response = await ctx.ui.input(POLICY_DECISION_REQUEST_PREFIX + encoded, "");
  return response === "allow" || response === "deny" || response === "ask" || response === "default" || response === "stale"
    ? response
    : "stale";
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const candidate = message as { role?: string; content?: unknown };
  if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return "";
  return candidate.content
    .filter((block): block is { type: "text"; text: string } => !!block && typeof block === "object" && (block as any).type === "text" && typeof (block as any).text === "string")
    .map((block) => block.text)
    .join("\n");
}

function readMcpDescriptor(): McpDescriptor | undefined {
  if (!mcpDescriptorPath || !mcpToken) return undefined;
  const descriptor = JSON.parse(readFileSync(mcpDescriptorPath, "utf8")) as McpDescriptor;
  if (descriptor.generation !== runtimeGeneration || typeof descriptor.sessionId !== "string" || !descriptor.sessionId ||
    typeof descriptor.targetId !== "string" || !descriptor.targetId || !Array.isArray(descriptor.tools)) {
    throw new Error("Joko MCP descriptor generation fence mismatch");
  }
  if (descriptor.tools.some((tool) => !tool || typeof tool.serverId !== "string" || typeof tool.name !== "string" ||
    (tool.runtimeName !== undefined && typeof tool.runtimeName !== "string") ||
    (tool.policySubject !== undefined && !["file_read", "file_write", "command", "network", "mcp", "browser", "resource", "extra_directory"].includes(tool.policySubject)) ||
    typeof tool.description !== "string" || !tool.inputSchema || typeof tool.inputSchema !== "object" ||
    Array.isArray(tool.inputSchema) || typeof tool.requiresPermission !== "boolean")) {
    throw new Error("Joko MCP descriptor contains an invalid tool");
  }
  return descriptor;
}

// Read once for the process generation. The descriptor is provisioned by the
// host and generation-fenced; tool arguments can never downgrade this policy.
const mcp = readMcpDescriptor();
const autoReviewer = createPiAutoReviewer({
  platform: process.platform,
  resolvePath: resolveReviewPath,
});

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_MCP_BRIDGE_RESPONSE_BYTES) {
    throw new Error("MCP bridge response exceeded its bounded wire envelope");
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > MAX_MCP_BRIDGE_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("MCP bridge response exceeded its bounded wire envelope");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export default function jokoManagedBridge(pi: ExtensionAPI): void {
  // This hook runs on the final Provider-specific payload for every ordinary
  // prompt, steer, follow-up, retry, and queued turn. Orchestrator validates model
  // eligibility before toggling the generation-fenced control value.
  pi.on("before_provider_request", (event) => {
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return event.payload;
    const payload = { ...(event.payload as Record<string, unknown>) };
    if (readControl().fastMode) payload.service_tier = "priority";
    else delete payload.service_tier;
    return payload;
  });

  // Override model and direct-user bash execution so provider/MCP credentials
  // inherited by Pi are removed at the process spawn boundary.
  const bashTool = createBashTool(process.cwd(), {
    exposeSessionEnvironment: false,
    spawnHook: ({ command, cwd, env }) => ({ command, cwd, env: sanitizeEnvironment(env) }),
  });
  pi.registerTool({
    ...bashTool,
    execute: async (id, params, signal, onUpdate, ctx) => {
      await commandGateRequest(ctx, "acquire", String(id));
      try {
        return await bashTool.execute(
          id,
          { ...params, timeout: bashTimeout((params as { timeout?: unknown }).timeout) },
          signal,
          onUpdate,
          ctx,
        );
      } finally {
        await commandGateRequest(ctx, "release", String(id)).catch(() => undefined);
      }
    },
  });
  const questionOption = Type.Object({
    label: Type.String({ minLength: 1, maxLength: 512 }),
    description: Type.Optional(Type.String({ maxLength: 2048 })),
  });
  const questionItem = Type.Object({
    question: Type.String({ minLength: 1, maxLength: 4096 }),
    header: Type.Optional(Type.String({ maxLength: 512 })),
    options: Type.Optional(Type.Array(questionOption, { maxItems: 16 })),
    multiSelect: Type.Optional(Type.Boolean()),
  });
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask user question",
    description: "Ask the user one or more typed questions and allow each step to be answered or skipped.",
    parameters: Type.Object({
      questions: Type.Array(questionItem, { minItems: 1, maxItems: 8 }),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return { content: [{ type: "text", text: "User interaction is unavailable." }], details: { cancelled: true } };
      }
      const fields = params.questions.map((question, questionIndex) => {
        const fieldId = "q" + String(questionIndex + 1);
        const options = Array.isArray(question.options) ? question.options : [];
        const base = {
          id: fieldId,
          label: question.header && question.header.trim() ? question.header.trim() : "Question " + String(questionIndex + 1),
          description: question.question,
          // AskUserQuestion always offers Skip for each step. Keep
          // that native host behavior explicit in the typed descriptor rather
          // than teaching shared UI to recognize a Pi/backend identifier.
          required: false,
        };
        if (options.length === 0) return { ...base, kind: "text", multiline: true };
        const choices = options.map((option, optionIndex) => ({
          id: fieldId + "-option-" + String(optionIndex + 1),
          label: option.label,
          description: option.description,
        }));
        return { ...base, kind: question.multiSelect ? "multiple" : "single", choices };
      });
      const descriptor = {
        title: params.questions.length === 1 ? "Pi needs your input" : "Pi has " + String(params.questions.length) + " questions",
        prompt: "Answer the questions below to continue the current turn.",
        fields,
      };
      const policy = readControl();
      const raw = await ctx.ui.editor(
        "joko:question\n" + Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64url"),
        "",
      );
      try {
        assertPolicyUnchanged(policy);
      } catch {
        return {
          content: [{ type: "text", text: "The answer was discarded because execution policy changed while the question was pending." }],
          details: { cancelled: true, stalePolicy: true },
        };
      }
      const answers = questionResponse(raw);
      if (!answers) {
        return { content: [{ type: "text", text: "The user cancelled the question." }], details: { cancelled: true } };
      }
      const readable: Record<string, string | boolean | string[]> = {};
      params.questions.forEach((question, questionIndex) => {
        const fieldId = "q" + String(questionIndex + 1);
        const keyBase = question.header && question.header.trim() ? question.header.trim() : question.question;
        const key = Object.prototype.hasOwnProperty.call(readable, keyBase) ? keyBase + " #" + String(questionIndex + 1) : keyBase;
        const answer = answers[fieldId];
        const options = Array.isArray(question.options) ? question.options : [];
        if (typeof answer === "string" && options.length > 0) {
          const match = /^q\d+-option-(\d+)$/.exec(answer);
          const optionIndex = match ? Number(match[1]) - 1 : -1;
          readable[key] = options[optionIndex]?.label ?? answer;
        } else if (Array.isArray(answer) && options.length > 0) {
          readable[key] = answer.map((choice) => {
            const match = /^q\d+-option-(\d+)$/.exec(choice);
            const optionIndex = match ? Number(match[1]) - 1 : -1;
            return options[optionIndex]?.label ?? choice;
          });
        } else if (answer !== undefined) {
          readable[key] = answer;
        }
      });
      return {
        content: [{ type: "text", text: "User answers:\n" + JSON.stringify(readable, null, 2) }],
        details: { cancelled: false, answers: readable },
      };
    },
  });
  pi.on("user_bash", () => {
    const local = createLocalBashOperations();
    return {
      operations: {
        exec(command, cwd, options) {
          if (readControl().runtimePolicy === "review_read_only") throw new Error("Reviewer runtime forbids shell execution");
          return local.exec(command, cwd, {
            ...options,
            timeout: bashTimeout(options.timeout),
            env: sanitizeEnvironment(options.env ?? process.env),
          });
        },
      },
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    try {
      // This bridge is loaded last. Freeze the final argument graph before any
      // async review so an earlier handler retaining a reference cannot mutate
      // the actual execution input during the permission window.
      freezeToolInput(event.input);
    } catch {
      return { block: true, reason: "Tool arguments could not be frozen at the final policy boundary" };
    }
    let control: Control;
    try {
      control = readControl();
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : "Joko control state unavailable" };
    }
    const risk = classifyTool(event.toolName, event.input, control);
    if (control.runtimePolicy === "review_read_only") {
      const readTool = event.toolName === "read" || event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls";
      return readTool && risk === "safe_read"
        ? undefined
        : { block: true, reason: "Reviewer runtime permits only canonical bounded read, grep, find, and ls operations" };
    }
    const localReview = autoReviewer.classify({ event, control, workspaceRoot, ctx });
    if (control.planMode && (localReview.tier !== "green" || (risk !== "safe_read" && risk !== "safe_command"))) {
      return { block: true, reason: "Plan mode blocked a tool outside the read-only allowlist" };
    }
    const orderedDecision = await orderedPolicyDecision(ctx, control, policyObservation(event.toolName, event.input, risk));
    try {
      assertPolicyUnchanged(control);
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : "Joko policy changed while ordered rules were evaluated" };
    }
    if (orderedDecision === "stale") return { block: true, reason: "Ordered policy evaluation was unavailable or stale" };
    if (orderedDecision === "deny") return { block: true, reason: "An ordered owner policy rule denied this tool call" };
    if (orderedDecision === "allow") return;
    // Full Access is the user's explicit acceptance of execution with the Pi
    // process account. Immutable reviewer and Plan Mode boundaries above still
    // dominate it, but ordinary risk classification must not silently turn
    // Full Access back into Ask.
    if (orderedDecision !== "ask" && control.permissionMode === "bypassPermissions") return;
    if (orderedDecision !== "ask" && control.permissionMode === "ask" && localReview.tier === "green" && risk === "safe_read") return;

    let decision: { verdict: "allow" | "block" | "ask"; reason: string; safeAlternative?: string };
    if (orderedDecision !== "ask" && control.permissionMode === "auto") {
      decision = await autoReviewer.review({
        ctx,
        event,
        control,
        workspaceRoot,
        readControl,
        notifyUnavailable: (message: string) => {
          if (ctx.hasUI) ctx.ui.notify(message, "warning");
        },
      });
      if (decision.verdict === "allow") return;
      if (decision.verdict === "block") {
        const alternative = decision.safeAlternative ? " Safe alternative: " + decision.safeAlternative : "";
        return { block: true, reason: "Auto-review blocked this tool call: " + decision.reason + alternative };
      }
    } else {
      decision = { verdict: "ask", reason: orderedDecision === "ask" ? "An ordered owner policy rule requires confirmation." : localReview.reason };
    }

    if (!ctx.hasUI) return { block: true, reason: "This tool call requires explicit user confirmation, but the Joko interaction bridge is unavailable" };
    const confirmed = await ctx.ui.confirm(
      "joko:permission:" + event.toolName,
      decision.reason + "\n\nBounded arguments:\n" + localReview.evidence,
    );
    try {
      assertPolicyUnchanged(control);
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : "Joko policy changed while permission was pending" };
    }
    if (!confirmed) return { block: true, reason: "The user declined this tool call" };
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const control = readControl();
    if (control.runtimePolicy === "review_read_only") return;
    ctx.ui.setStatus("joko-plan", control.planMode ? "plan" : undefined);
    if (!control.planMode) return;
    return {
      message: {
        customType: "joko-plan-mode",
        display: false,
        content: "[JOKO PLAN MODE ACTIVE]\nExplore with read-only tools, ask clarifying questions, and produce a concrete numbered implementation plan. Do not modify files or external state until the user approves the plan.",
      },
    };
  });

  pi.on("agent_end", async (event, ctx) => {
    const control = readControl();
    if (!control.planMode || !ctx.hasUI || event.willRetry) return;
    const plan = [...event.messages].reverse().map(messageText).find(Boolean);
    if (!plan) return;
    const rawChoice = await ctx.ui.select("joko:plan-review\n" + plan, ["Execute plan", "Stay in plan mode", "Refine plan"]);
    let current: Control;
    try {
      current = assertPolicyUnchanged(control);
    } catch {
      ctx.ui.notify("The plan response was discarded because execution policy changed.", "warning");
      return;
    }
    const choice = planReviewResponse(rawChoice);
    if (choice?.decision === "execute") {
      writeControl(advancePolicy({ ...current, planMode: false }));
      ctx.ui.setStatus("joko-plan", undefined);
      const executionMessage = choice.feedback.trim()
        ? "The user approved the plan with this guidance:\n" + choice.feedback.trim() + "\n\nExecute it now, preserving the agreed order and safety constraints."
        : "The user approved the plan. Execute it now, preserving the agreed order and safety constraints.";
      pi.sendUserMessage(executionMessage, {
        deliverAs: "followUp",
        triggerTurn: true,
      });
    } else if (choice?.decision === "refine") {
      const refinement = choice.feedback.trim();
      if (refinement) pi.sendUserMessage(refinement, { deliverAs: "followUp", triggerTurn: true });
      else ctx.ui.notify("Add feedback before asking Pi to refine the plan.", "warning");
    }
  });

  pi.registerCommand("plan", {
    description: "Toggle Joko plan mode",
    handler: async (args, ctx) => {
      const control = readControl();
      if (control.runtimePolicy === "review_read_only") throw new Error("Reviewer runtime policy is immutable and cannot enter plan mode");
      const requested = args.trim().toLowerCase();
      const enabled = requested === "on" ? true : requested === "off" ? false : !control.planMode;
      writeControl(advancePolicy({ ...control, planMode: enabled }));
      ctx.ui.setStatus("joko-plan", enabled ? "plan" : undefined);
      ctx.ui.notify(enabled ? "Plan mode enabled" : "Plan mode disabled", "info");
    },
  });

  pi.registerCommand("joko-navigate-tree", {
    description: "Navigate the native Pi entry tree through the Joko host",
    handler: async (args, ctx) => {
      const payload = JSON.parse(Buffer.from(args.trim(), "base64url").toString("utf8")) as {
        entryId?: string;
        summarize?: boolean;
        customInstructions?: unknown;
      };
      if (!payload.entryId) throw new Error("Missing native entry id");
      const customInstructions = typeof payload.customInstructions === "string"
        ? payload.customInstructions.trim().slice(0, 4_000)
        : undefined;
      const result = await ctx.navigateTree(payload.entryId, {
        summarize: payload.summarize ?? false,
        ...(payload.summarize === true && customInstructions ? { customInstructions } : {})
      });
      if (result.cancelled) throw new Error("Native tree navigation was cancelled");
      if (result.editorText !== undefined) ctx.ui.setEditorText(result.editorText);
      ctx.ui.notify("joko:navigate-complete:" + payload.entryId, "info");
    },
  });

  pi.registerCommand("joko-rebuild-context", {
    description: "Replace native context at a Joko recovery boundary",
    handler: async (args, ctx) => {
      const encoded = args.trim();
      if (!encoded || encoded.length > 4_096 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
        throw new Error("Invalid context rebuild descriptor");
      }
      const descriptorBytes = Buffer.from(encoded, "base64url");
      if (descriptorBytes.toString("base64url") !== encoded) throw new Error("Invalid context rebuild descriptor");
      const descriptor = JSON.parse(descriptorBytes.toString("utf8")) as {
        format?: unknown;
        fileName?: unknown;
        byteLength?: unknown;
        sha256?: unknown;
        reason?: unknown;
      };
      const artifactCapacityBytes = Number(process.env.JOKO_PI_ARTIFACT_CAPACITY_BYTES);
      if (!Number.isSafeInteger(artifactCapacityBytes) || artifactCapacityBytes < 1) {
        throw new Error("Context rebuild Artifact capacity is unavailable");
      }
      if (
        descriptor.format !== 1 ||
        typeof descriptor.fileName !== "string" ||
        !/^joko-context-rebuild-[a-f0-9-]{36}\.txt$/.test(descriptor.fileName) ||
        !Number.isSafeInteger(descriptor.byteLength) ||
        (descriptor.byteLength as number) < 1 ||
        (descriptor.byteLength as number) > artifactCapacityBytes ||
        typeof descriptor.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(descriptor.sha256)
      ) {
        throw new Error("Invalid context rebuild Artifact descriptor");
      }
      const artifactRootValue = process.env.TEMP;
      if (!artifactRootValue) throw new Error("Context rebuild Artifact root is unavailable");
      const artifactRoot = realpathSync(artifactRootValue);
      const candidate = resolve(artifactRoot, descriptor.fileName);
      const linkInfo = lstatSync(candidate);
      const canonical = realpathSync(candidate);
      if (!isContained(artifactRoot, canonical) || linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
        throw new Error("Invalid context rebuild Artifact source");
      }
      let handoffBytes: Buffer;
      try {
        handoffBytes = readFileSync(canonical);
      } finally {
        try { unlinkSync(candidate); } catch {}
      }
      if (
        handoffBytes.byteLength !== descriptor.byteLength ||
        createHash("sha256").update(handoffBytes).digest("hex") !== descriptor.sha256
      ) {
        throw new Error("Context rebuild Artifact integrity check failed");
      }
      const handoff = handoffBytes.toString("utf8");
      if (!Buffer.from(handoff, "utf8").equals(handoffBytes) || !handoff.trim()) {
        throw new Error("Invalid context rebuild handoff");
      }
      const reason = descriptor.reason === "context_overflow" || descriptor.reason === "prompt_timeout"
        ? descriptor.reason
        : "message_deletion";
      const result = await ctx.newSession({
        setup: async (sessionManager) => {
          sessionManager.appendCustomMessageEntry(
            "joko-context-rebuild-handoff",
            handoff,
            false,
            { reason },
          );
        },
      });
      if (result.cancelled) throw new Error("Native context rebuild was cancelled");
    },
  });

  pi.registerCommand("joko-reset-context", {
    description: "Replace native context with an empty Pi session through the Joko host",
    handler: async (_args, ctx) => {
      // Deliberately omit setup/parentSession. The clear command must create a truly
      // empty JSONL rather than smuggling prior transcript content into context.
      const result = await ctx.newSession();
      if (result.cancelled) throw new Error("Native context reset was cancelled");
    },
  });

  if (mcp) {
    for (const descriptor of mcp.tools) {
      const toolName = descriptor.runtimeName ?? "mcp__" + descriptor.serverId + "__" + descriptor.name;
      pi.registerTool({
        name: toolName,
        label: descriptor.name,
        description: descriptor.description,
        parameters: descriptor.inputSchema as any,
        async execute(_id, params, signal) {
          if (typeof _id !== "string" || _id.length < 1 || _id.length > 1024 || _id.includes("\0") || /[\r\n]/u.test(_id)) {
            throw new Error("MCP bridge tool-call identity is invalid");
          }
          const response = await fetch(mcp.endpoint, {
            method: "POST",
            redirect: "error",
            headers: {
              "authorization": "Bearer " + mcpToken,
              "content-type": "application/json",
              "x-joko-pi-generation": String(runtimeGeneration),
            },
            body: JSON.stringify({
              requestId: _id,
              serverId: descriptor.serverId,
              toolName: descriptor.name,
              arguments: params,
              generation: runtimeGeneration,
              sessionId: mcp.sessionId,
              targetId: mcp.targetId,
            }),
            signal,
          });
          if (!response.ok) throw new Error("MCP bridge request failed with status " + response.status);
          const body = await readBoundedJson(response) as { content?: unknown; details?: unknown; isError?: boolean; error?: string; errorCode?: McpBridgeErrorCode } | null;
          if (!body || typeof body !== "object") throw new Error("MCP bridge returned an invalid JSON body");
          if (body.isError) {
            const code = body.errorCode;
            const failure = new Error((code ? "[" + code + "] " : "") + (body.error || "MCP tool failed")) as Error & { code?: McpBridgeErrorCode; details?: unknown };
            if (code) failure.code = code;
            if (body.details !== undefined) failure.details = body.details;
            throw failure;
          }
          const content = Array.isArray(body.content)
            ? body.content
            : [{ type: "text", text: typeof body.content === "string" ? body.content : JSON.stringify(body.content ?? null) }];
          return { content, details: body.details };
        },
      });
    }
  }

  // Pi exposes the authoritative tool registry to extensions but not through
  // its RPC command union. Publish bounded records through an RPC-supported
  // fire-and-forget status envelope. The Adapter consumes this reserved key
  // internally; it never becomes a user-visible status or durable event.
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "rpc") return;
    try {
      const tools = pi.getAllTools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        promptGuidelines: tool.promptGuidelines,
        sourceInfo: tool.sourceInfo,
      }));
      const catalogText = JSON.stringify({
        format: 1,
        complete: true,
        activeToolNames: pi.getActiveTools(),
        tools,
      });
      const byteLength = Buffer.byteLength(catalogText, "utf8");
      if (byteLength > MAX_RUNTIME_TOOL_CATALOG_BYTES) {
        ctx.ui.setStatus(RUNTIME_TOOL_CATALOG_STATUS_KEY, JSON.stringify({
          format: 1,
          complete: false,
          reason: "catalog_too_large",
        }));
        return;
      }
      const catalogBytes = Buffer.from(catalogText, "utf8");
      const sha256 = createHash("sha256").update(catalogBytes).digest("hex");
      const catalogId = sha256;
      const count = Math.ceil(catalogBytes.byteLength / RUNTIME_TOOL_CATALOG_CHUNK_BYTES);
      for (let index = 0; index < count; index += 1) {
        const payload = catalogBytes
          .subarray(index * RUNTIME_TOOL_CATALOG_CHUNK_BYTES, (index + 1) * RUNTIME_TOOL_CATALOG_CHUNK_BYTES)
          .toString("base64url");
        ctx.ui.setStatus(RUNTIME_TOOL_CATALOG_STATUS_KEY, JSON.stringify({
          format: 1,
          catalogId,
          index,
          count,
          byteLength: catalogBytes.byteLength,
          sha256,
          payload,
        }));
      }
    } catch {
      ctx.ui.setStatus(RUNTIME_TOOL_CATALOG_STATUS_KEY, JSON.stringify({
        format: 1,
        complete: false,
        reason: "capture_failed",
      }));
    }
  });
}
`;
