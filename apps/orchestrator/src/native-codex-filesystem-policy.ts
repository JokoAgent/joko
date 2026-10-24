import { posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import {
  classifyToolCall, evaluateOrderedPolicyRules, isWithin, policyObservationForToolCall,
  type PolicySnapshot
} from "@joko/core";
import type { HostedAgentCodexAction } from "./hosted-agent-codex-mapping.js";

type TreeAction = Extract<HostedAgentCodexAction, { readonly kind: "read" | "write" }>;
type JsonRecord = Record<string, unknown>;

export interface NativeCodexFileSystemPolicyInput {
  /** Current service policy for the execution workspace, not the creation-time context snapshot. */
  readonly snapshot: PolicySnapshot;
  readonly actions: readonly HostedAgentCodexAction[];
  readonly method: string;
  readonly params: unknown;
  readonly pathStyle: "posix" | "win32";
  /** The fixed native runtime must enforce its Require filesystem helper, without an unsandboxed fallback. */
  readonly enforcement: "native-os-sandbox" | "unavailable";
  /** Resolves on the original execution machine, including the existing ancestor of a missing path. */
  readonly canonicalize: (absolutePath: string) => Promise<string>;
  /** Fences both this snapshot generation and the wire request's original owner. */
  readonly assertCurrent: () => void;
}

export class NativeCodexFileSystemPolicyError extends Error {
  readonly code = "NATIVE_CODEX_FILESYSTEM_POLICY_UNAVAILABLE";
  constructor(readonly reason: string) { super(reason); this.name = "NativeCodexFileSystemPolicyError"; }
}

/** Supplements the ordinary primitive authorization with a native read-deny
 * boundary for symlinks discovered inside a recursive operation. It grants no
 * permission and never answers an ask. The caller must retain the same owner
 * fence through the eventual native stdin write.
 *
 * Fixed 0.159.2 evidence: exec-server/src/local_file_system.rs sync_walk follows
 * nested directory symlinks; capability_discovery.rs also reads their manifests
 * internally. tests/capability_discovery.rs::sandboxed_discovery_follows_only_
 * permitted_external_symlinks proves per-root native sandbox enforcement.
 */
export async function tightenNativeCodexFileSystemPolicy(input: NativeCodexFileSystemPolicyInput): Promise<unknown> {
  input.assertCurrent();
  const trees = input.actions.filter((action): action is TreeAction =>
    (action.kind === "read" || action.kind === "write") && action.scope === "tree");
  if (trees.length === 0) return input.params;
  // The ordinary root canonical gate already covers a walk that cannot follow
  // nested symlinks. Do not introduce a sandbox dependency for that safe shape.
  if (input.method === "fs/walk" && record(record(input.params)?.options)?.followDirectorySymlinks === false) return input.params;
  if (!absolutePath(input.snapshot.workspaceRoot, input.pathStyle)) unavailable("The native filesystem policy workspace is not absolute.");

  // A mutation can itself enumerate directories. Its independent read/write
  // policy cannot be expressed by adding a native deny (which denies both).
  // Keep this narrow adapter read-only instead of silently changing copy/remove.
  const mutating = trees.some(action => action.kind === "write");
  const effects: TreeAction[] = mutating
    ? [...trees, ...trees.filter(action => action.kind === "write").map(action => ({ kind: "read" as const, path: action.path, scope: "tree" as const }))]
    : trees;
  const denied = new Set<string>();
  for (const action of effects) {
    for (const rule of input.snapshot.rules) {
      if (rule.effect !== "deny") continue;
      const prefix = rule.workspaceRelativePathPrefix;
      const path = prefix === undefined ? input.snapshot.workspaceRoot : prefixPath(prefix, input.snapshot, input.pathStyle);
      const call = { name: action.kind, args: { path } };
      const context = { workspaceRoot: input.snapshot.workspaceRoot, extraReadOnlyRoots: [], pathStyle: input.pathStyle };
      const observation = policyObservationForToolCall(call, context, classifyToolCall(call, context));
      // The core evaluator gives every matching explicit deny precedence over
      // allow/ask. Reuse its exact backend, Target, tool/provider and risk masks.
      if (evaluateOrderedPolicyRules({ ...input.snapshot, rules: [rule] }, observation)?.action !== "deny") continue;
      if (mutating) unavailable("The native filesystem sandbox cannot preserve independent recursive read/write policy; this copy or removal was not dispatched.");
      if (rule.ceiling !== "critical") unavailable("Risk-selective recursive filesystem denial cannot be represented by the native sandbox.");
      if (prefix === undefined) unavailable("The current policy denies this native recursive filesystem operation.");
      denied.add(path);
    }
  }
  if (denied.size === 0) return input.params;
  if (input.method !== "fs/walk" && input.method !== "capabilityRoots/discoverV1") {
    unavailable("This native recursive filesystem method has no enforceable policy projection.");
  }
  if (input.enforcement !== "native-os-sandbox") unavailable("The execution machine cannot enforce native recursive filesystem denial.");
  const params = record(input.params);
  if (!params) unavailable("The native recursive filesystem parameters are invalid.");
  const roots = input.method === "capabilityRoots/discoverV1" ? params.roots : undefined;
  if (input.method === "capabilityRoots/discoverV1" && (!Array.isArray(roots) || roots.length === 0)) {
    unavailable("The native capability roots are invalid.");
  }
  const requests = Array.isArray(roots) ? roots.map(root => {
    const item = record(root);
    if (!item) unavailable("The native capability root is invalid.");
    return item;
  }) : [params];
  for (const request of requests) assertSandboxSupported(request.sandbox, input.pathStyle);

  const deniedUris = new Set<string>();
  for (const path of denied) {
    input.assertCurrent();
    deniedUris.add(pathUri(path, input.pathStyle));
    const resolved = await input.canonicalize(path);
    input.assertCurrent();
    if (!absolutePath(resolved, input.pathStyle)) unavailable("A native filesystem denial resolved to a foreign or relative path.");
    deniedUris.add(pathUri(resolved, input.pathStyle));
  }
  const entries = [...deniedUris].map(path => ({ path: { type: "path", path }, access: "deny" }));
  const narrowed = requests.map(request => ({ ...request, sandbox: tightenSandbox(request.sandbox, entries, input) }));
  input.assertCurrent();
  return input.method === "capabilityRoots/discoverV1" ? { ...params, roots: narrowed } : narrowed[0]!;
}

function assertSandboxSupported(value: unknown, pathStyle: NativeCodexFileSystemPolicyInput["pathStyle"]): void {
  if (value !== undefined && value !== null && !record(value)) unavailable("The native filesystem sandbox is invalid.");
  const sandbox = record(value);
  // Fixed native Linux Landlock has no restricted-read implementation. Windows
  // WRITE_RESTRICTED tokens likewise cannot enforce deny-read ACEs; only the
  // already configured elevated backend can. Never promote that setting here.
  if (sandbox?.useLegacyLandlock === true) unavailable("The legacy native Landlock backend cannot enforce recursive read denial.");
  if (pathStyle === "win32" && sandbox?.windowsSandboxLevel !== "elevated") {
    unavailable("Recursive read denial requires an already configured elevated Windows sandbox.");
  }
}

function tightenSandbox(value: unknown, denied: readonly JsonRecord[], input: NativeCodexFileSystemPolicyInput): JsonRecord {
  const original = record(value) ?? {};
  const permissions = record(original.permissions);
  const fileSystem = record(permissions?.file_system);
  if (permissions?.type === "managed" && fileSystem?.type === "restricted") {
    if (!Array.isArray(fileSystem.entries)) unavailable("The restricted native filesystem entries are invalid.");
    // Preserve all original entries, dynamic path contexts, backend settings,
    // network restrictions and future fields. Add no readable or writable root.
    return { ...original, permissions: { ...permissions,
      file_system: { ...fileSystem, entries: [...fileSystem.entries, ...denied] } } };
  }
  if (value !== undefined && value !== null && (permissions === undefined
    || !(permissions.type === "disabled" || permissions.type === "external"
      || permissions.type === "managed" && fileSystem?.type === "unrestricted"))) {
    unavailable("The original native filesystem permission profile cannot be narrowed safely.");
  }
  // None/Disabled/External/Unrestricted already permit reads everywhere. A
  // read-only root preserves that baseline while introducing no writable root.
  return { ...original,
    ...(original.cwd === undefined ? { cwd: pathUri(input.snapshot.workspaceRoot, input.pathStyle) } : {}),
    windowsSandboxLevel: original.windowsSandboxLevel ?? "disabled",
    permissions: { type: "managed", network: "restricted", file_system: { type: "restricted", entries: [
      { path: { type: "special", value: { kind: "root" } }, access: "read" }, ...denied
    ] } } };
}

function prefixPath(prefix: string, snapshot: PolicySnapshot, style: NativeCodexFileSystemPolicyInput["pathStyle"]): string {
  const paths = style === "win32" ? win32 : posix;
  if (prefix.includes("\0") || prefix.includes("\\") || prefix.startsWith("/") || prefix.split("/").some(part => part === ".." || part === ".")) {
    unavailable("The native filesystem policy prefix is not canonical.");
  }
  const path = paths.resolve(snapshot.workspaceRoot, prefix);
  if (!isWithin(path, snapshot.workspaceRoot, style)) unavailable("The native filesystem policy prefix escapes its workspace.");
  return path;
}

function absolutePath(path: string, style: NativeCodexFileSystemPolicyInput["pathStyle"]): boolean {
  return typeof path === "string" && !path.includes("\0") && (style === "win32"
    ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/u.test(path) && win32.isAbsolute(path)
    : posix.isAbsolute(path));
}
function pathUri(path: string, style: NativeCodexFileSystemPolicyInput["pathStyle"]): string {
  return pathToFileURL(path, { windows: style === "win32" }).href;
}
function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined;
}
function unavailable(reason: string): never { throw new NativeCodexFileSystemPolicyError(reason); }
