import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { extract, list } from "tar";
import { redactSecrets } from "@joko/core";
import type { OperationalStore } from "@joko/store";
import type { ArtifactStore } from "./artifact-store.js";
import type { PiResourceManager, PiPackageCandidateInspection } from "./resource-manager.js";
import type { BridgeToolCallContext, BridgeToolCallResult, BridgeToolProvider } from "./mcp-router.js";
import { nodeExecutableEnvironment, resolveBundledNpmRuntime } from "./npm-runtime.js";

const ID = "joko_plugin_authoring";
const MAXIMUM_BYTES = 500 * 1024 * 1024;
const schema = { type: "object", properties: { directory: { type: "string", minLength: 1, maxLength: 4096 } }, required: ["directory"], additionalProperties: false };

/** Actual parser and npm bytes, independently of installation or publication. */
export class PluginAuthoringTools implements BridgeToolProvider {
  readonly id = ID;
  readonly generation = 1;
  readonly available = true;
  readonly tools = [
    { serverId: ID, name: "validate_extension_package", description: "Validate plugin source inside this task's current local Workspace with the actual package/Extension parser. Executes no scripts and does not install.", inputSchema: schema, requiresPermission: false },
    { serverId: ID, name: "pack_extension_package", description: "Validate and pack plugin source inside this task's local Workspace with bundled npm offline and lifecycle scripts disabled. Verify the packed tree and return an actual tgz Artifact. Does not install or publish.", inputSchema: schema, requiresPermission: true }
  ];
  constructor(private readonly options: { readonly store: OperationalStore; readonly resources: PiResourceManager; readonly artifacts: ArtifactStore; readonly workingRoot: string;
    readonly captureWorkspace: (context: BridgeToolCallContext) => { readonly root: string; readonly remote: boolean; readonly assertCurrent: () => void } }) {}
  includeForTarget(targetId: string): boolean { const target = this.options.store.getTarget(targetId).descriptor; return target.trusted && target.remoteWorkspace === undefined; }

  async callTool(name: string, input: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined, context: BridgeToolCallContext): Promise<BridgeToolCallResult> {
    let stage: string | undefined, root: string | undefined;
    try {
      const directory = input["directory"];
      if (!["validate_extension_package", "pack_extension_package"].includes(name) || Object.keys(input).some(key => key !== "directory")
        || typeof directory !== "string" || !directory || directory.length > 4096 || /[\u0000-\u001f\u007f]/u.test(directory)) throw new Error("Supply one plugin source directory.");
      const store = this.options.store, session = store.getSession(context.sessionId).descriptor, target = store.getTarget(context.targetId);
      const workspaceOwner = this.options.captureWorkspace(context);
      if (workspaceOwner.remote) throw new Error("Local package authoring tools are unavailable for this remote task Workspace.");
      const backendGeneration = store.getBackend(session.backendId).descriptor.instanceGeneration;
      const assertCurrent = () => {
        workspaceOwner.assertCurrent();
        signal?.throwIfAborted(); const current = store.getSession(context.sessionId).descriptor;
        if (current.archived || current.deletedAt !== undefined || current.targetId !== context.targetId || current.binding.generation !== context.generation
          || current.backendId !== session.backendId || current.binding.opaqueRef !== session.binding.opaqueRef
          || store.getBackend(session.backendId).descriptor.instanceGeneration !== backendGeneration
          || store.getTarget(context.targetId).revision !== target.revision || !this.includeForTarget(context.targetId)) throw new Error("The package authoring Workspace owner changed.");
      };
      assertCurrent();
      const workspace = await realpath(workspaceOwner.root), source = resolve(workspace, directory);
      if (!within(workspace, source) || await realpath(source) !== source || !(await lstat(source)).isDirectory()) throw new Error("The source must be a canonical directory in this Workspace.");
      const inspect = async (path: string) => {
        assertCurrent(); const value = await this.options.resources.inspectPackageCandidate(path, session.backendId, signal); assertCurrent();
        if (!value.compatibility.resources.some(resource => resource.kind === "extension")) throw new Error("The package has no declared native Extension entry.");
        return value;
      };
      const before = await inspect(source);
      if (name === "validate_extension_package") return result({ ...summary(before), validated: true, installed: false });
      await mkdir(this.options.workingRoot, { recursive: true, mode: 0o700 }); root = await realpath(this.options.workingRoot);
      stage = await realpath(await mkdtemp(join(root, "package-")));
      if (!within(root, stage) || stage === root) throw new Error("The package staging owner is invalid.");
      const cache = join(stage, "cache"), output = join(stage, "output"), unpacked = join(stage, "unpacked");
      await Promise.all([mkdir(cache), mkdir(output), mkdir(unpacked), writeFile(join(stage, "npmrc"), "", { flag: "wx", mode: 0o600 }), writeFile(join(stage, "global-npmrc"), "", { flag: "wx", mode: 0o600 })]);
      const npm = await resolveBundledNpmRuntime(); assertCurrent();
      const env = nodeExecutableEnvironment({ PATH: process.env["PATH"], SystemRoot: process.env["SystemRoot"], WINDIR: process.env["WINDIR"],
        HOME: stage, USERPROFILE: stage, TMP: stage, TEMP: stage, TMPDIR: stage, NPM_CONFIG_CACHE: cache,
        NPM_CONFIG_USERCONFIG: join(stage, "npmrc"), NPM_CONFIG_GLOBALCONFIG: join(stage, "global-npmrc"), NPM_CONFIG_OFFLINE: "true" });
      const receipt: unknown = JSON.parse(await runNpm(npm.cliPath, source, output, env, signal, assertCurrent));
      if (!Array.isArray(receipt) || receipt.length !== 1 || typeof receipt[0]?.filename !== "string") throw new Error("Npm did not return one exact archive receipt.");
      const fileName = receipt[0].filename as string;
      if (basename(fileName) !== fileName || !/^[A-Za-z0-9@][A-Za-z0-9@._+-]*\.tgz$/u.test(fileName)) throw new Error("Npm returned an invalid archive filename.");
      const archive = join(output, fileName), info = await lstat(archive);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAXIMUM_BYTES) throw new Error("The package archive exceeds the host limit.");
      let files = 0, bytes = 0, invalidArchive = false;
      await list({ file: archive, strict: true, onReadEntry: entry => {
        files += 1; bytes += entry.size; const path = entry.path.replace(/\/$/u, "");
        if (files > 10_000 || bytes > MAXIMUM_BYTES || !["File", "Directory"].includes(entry.type)
          || path !== "package" && !path.startsWith("package/") || path.split("/").some(part => !part || part === "." || part === "..")
          || /[:\\\u0000-\u001f\u007f]/u.test(path)) invalidArchive = true;
      } });
      if (invalidArchive) throw new Error("The archive contains an unsafe or oversized entry.");
      assertCurrent(); await extract({ file: archive, cwd: unpacked, strict: true, strip: 1, preservePaths: false }); assertCurrent();
      const packed = await inspect(unpacked), after = await inspect(source);
      if (before.discoveredRevision !== after.discoveredRevision) throw new Error("The source changed during packaging. Validate the current source before trying again.");
      const handle = await open(archive, "r");
      try {
        const artifact = await this.options.artifacts.ingestFileHandle(handle, { expectedSize: info.size, fileName, mimeType: "application/gzip", ...(signal ? { signal } : {}), beforeFinalize: async () => assertCurrent() });
        assertCurrent(); const { storagePath: _, createdAt: __, expiresAt: ___, ...blob } = artifact;
        return { ...result({ ...summary(packed), validated: true, installed: false, artifact: blob }), hostArtifacts: [{ blob, label: fileName }] };
      } finally { await handle.close(); }
    } catch (error) { return { isError: true, content: [{ type: "text", text: redactSecrets(error instanceof Error ? error.message : "Plugin package authoring failed.") }] }; }
    finally { if (stage && root && within(root, stage) && stage !== root && await realpath(stage).catch(() => undefined) === stage) await rm(stage, { recursive: true, force: true }).catch(() => undefined); }
  }
}
function within(root: string, child: string): boolean { const key = relative(root, child); return key === "" || key !== ".." && !key.startsWith(".." + sep) && !isAbsolute(key); }
function summary(value: PiPackageCandidateInspection) { return { name: value.compatibility.name, version: value.compatibility.version, revision: value.discoveredRevision,
  files: value.files, bytes: value.bytes, resources: value.compatibility.resources, warnings: value.compatibility.warnings }; }
function result(value: Record<string, unknown>): BridgeToolCallResult { return { isError: false, content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value }; }
function runNpm(cli: string, cwd: string, output: string, env: NodeJS.ProcessEnv, signal: AbortSignal | undefined, assertCurrent: () => void): Promise<string> {
  assertCurrent();
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli, "pack", "--json", "--ignore-scripts", "--offline", "--workspaces=false", "--pack-destination", output], { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", failure: Error | undefined;
    const stop = (message: string) => { failure ??= new Error(message); child.kill(); };
    const cancel = () => stop("Plugin packaging was cancelled."); signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
    const timer = setTimeout(() => stop("Plugin packaging exceeded its deadline."), 60_000);
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString("utf8"); if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) stop("The package receipt exceeds the host limit."); });
    child.stderr.on("data", (data: Buffer) => { if (stderr.length < 8192) stderr += data.toString("utf8"); });
    child.once("error", error => { failure = error; });
    child.once("close", code => { clearTimeout(timer); signal?.removeEventListener("abort", cancel);
      if (failure) reject(failure); else if (code !== 0) reject(new Error("Npm package creation failed: " + redactSecrets(stderr.slice(0, 2048))));
      else { try { assertCurrent(); done(stdout); } catch (error) { reject(error); } }
    });
  });
}
