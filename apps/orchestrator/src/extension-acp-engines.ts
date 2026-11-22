import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { StdioJsonRpcTransport } from "@joko/adapter-codex";
import type { AdapterContext, BlobRef, TargetDescriptor } from "@joko/core";
import { createChildRuntimeEnvironment, DurableProcessOwner, type ProcessIdentitySupervisor } from "@joko/runtime-governance";
import type { OperationalStore } from "@joko/store";
import type { BackendInstanceRegistry } from "./backend-instance-registry.js";
import { ACP_ENGINE_KIND, ExtensionAcpAdapter, type ExtensionAcpProcess } from "./extension-acp-adapter.js";
import type { ApprovedExtensionTaskEngine, ExtensionCatalogManager } from "./extension-catalog.js";
import { inspectPiPackageCatalog } from "./pi-package-compatibility.js";
import type { PiResourceDescriptor, PiResourceManager } from "./resource-manager.js";
import type { SessionHost } from "./session-host.js";

const MAXIMUM_PLUGIN_PROCESSES = 4;
const ACP_CATALOG_SETTING_KEY = "plugin-acp.catalog.v1";

interface EngineSlot {
  readonly id: string;
  readonly name: string;
  approval?: ApprovedExtensionTaskEngine;
  adapter?: ExtensionAcpAdapter;
  mustStop: boolean;
}

interface ExtensionAcpEngineOptions {
  readonly store: OperationalStore;
  readonly catalog: ExtensionCatalogManager;
  readonly resources: PiResourceManager;
  readonly registry: BackendInstanceRegistry;
  readonly host: SessionHost;
  readonly directories: string;
  readonly supervisor: ProcessIdentitySupervisor;
  readonly workspace: { readonly id: string; readonly root: string; readonly trusted: boolean };
  readonly readBlob: (blob: BlobRef) => Promise<Uint8Array>;
}

/** Publishes approved task engines without opening any native process. */
export class ExtensionAcpEngines {
  private readonly slots = new Map<string, EngineSlot>();
  private readonly launches = new Map<string, number>();
  private readonly stopAuthorityListener: () => void;
  private work: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly recoveryFailures = new Set<string>();

  constructor(private readonly options: ExtensionAcpEngineOptions) {
    this.stopAuthorityListener = options.catalog.onAuthorityChanged(() => {
      this.fenceLostApprovals();
      void this.reconcile().catch(() => this.reportUnavailable());
    });
  }

  reconcile(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const pending = this.work.catch(() => undefined).then(() => this.applyCatalog());
    this.work = pending;
    return pending;
  }

  async recoverProcesses(): Promise<void> {
    for (const { descriptor } of this.options.store.listBackends()) {
      if (descriptor.adapterKind !== ACP_ENGINE_KIND || !/^plugin-acp-[a-f0-9]{32}$/u.test(descriptor.id)) continue;
      const parent = join(this.options.directories, "processes", descriptor.id);
      try {
        const children = await readdir(parent, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        for (const child of children) {
          if (!child.isDirectory() || child.isSymbolicLink() || !/^[a-f0-9]{64}$/u.test(child.name)) {
            throw new Error("Task engine process storage is invalid.");
          }
          await new DurableProcessOwner({
            rootDirectory: join(parent, child.name), instanceId: `${descriptor.id}-${child.name}`,
            generation: descriptor.instanceGeneration, recoverStale: true, supervisor: this.options.supervisor
          }).prepare(5_000);
        }
      } catch {
        this.recoveryFailures.add(descriptor.id);
        this.reportUnavailable();
      }
      this.options.store.publishBackendInstanceDescriptor({
        expectedCurrentGeneration: descriptor.instanceGeneration,
        descriptor: { ...descriptor, health: "unavailable", authenticationState: "error", models: [], capabilities: new Map() }
      });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopAuthorityListener();
    this.fenceLostApprovals();
    await this.work.catch(() => undefined);
    const results = await Promise.allSettled([...this.slots.values()].map(slot => slot.adapter?.dispose()));
    if (results.some(result => result.status === "rejected")) throw new Error("A plugin task engine has not confirmed exit.");
  }

  private fenceLostApprovals(): void {
    for (const slot of this.slots.values()) {
      if (slot.approval === undefined || (!this.closed && current(slot.approval))) continue;
      slot.approval = undefined;
      slot.mustStop = true;
    }
  }

  private async applyCatalog(): Promise<void> {
    if (this.closed) return;
    this.fenceLostApprovals();
    for (const slot of this.slots.values()) {
      if (!slot.mustStop) continue;
      await slot.adapter?.revoke();
      if (slot.adapter !== undefined) await this.options.registry.refresh(slot.id);
      slot.mustStop = false;
    }
    const approved = this.options.catalog.approvedTaskEngines();
    for (const grant of approved) {
      if (this.closed || !current(grant)) continue;
      const id = engineId(grant);
      if (this.recoveryFailures.has(id)) continue;
      const existing = this.slots.get(id);
      if (existing?.approval !== undefined) continue;
      const slot: EngineSlot = existing ?? { id, name: grant.engine.name, mustStop: false };
      slot.approval = grant;
      this.slots.set(id, slot);
      try {
        if (slot.adapter === undefined) {
          const snapshot = await this.options.registry.add({
            instanceId: id, adapterKind: ACP_ENGINE_KIND, displayName: slot.name,
            create: ({ generation }) => {
              const adapter = new ExtensionAcpAdapter({
                id, generation, name: slot.name, approved: () => !this.closed && slot.approval !== undefined && current(slot.approval),
                open: context => this.open(slot, generation, context), readBlob: this.options.readBlob,
                emitBackgroundTool: (sessionId, binding, payload) =>
                  this.options.host.recordAcpBackgroundToolEvent(id, generation, sessionId, binding, payload),
                sessionCatalogChanged: (sessionId, binding, models) => this.options.host.recordAcpSessionModels(id, sessionId, binding, models),
                catalogChanged: observed => {
                  const approval = slot.approval;
                  if (this.closed || approval === undefined || !current(approval)) return;
                  this.options.store.setSetting("backend", slot.id, ACP_CATALOG_SETTING_KEY, {
                    contentRevision: approval.binding.discoveredRevision, observed
                  });
                  void this.refresh(slot).catch(() => this.reportUnavailable());
                }
              });
              this.restoreCatalog(adapter, grant);
              return adapter;
            }
          });
          const adapter = this.options.registry.adapter(id);
          if (!(adapter instanceof ExtensionAcpAdapter) || snapshot.state !== "available") throw new Error("Task engine registration is unavailable.");
          this.options.host.installBackendInstance(adapter, snapshot.descriptor);
          slot.adapter = adapter;
        } else {
          this.restoreCatalog(slot.adapter, grant);
          await this.options.registry.refresh(id);
          this.options.host.wakeBackendQueues(id);
        }
        if (slot.approval === grant && current(grant)) await this.ensureDefaultTarget(slot, grant);
      } catch {
        this.reportUnavailable();
      }
    }
  }

  private async refresh(slot: EngineSlot): Promise<void> {
    if (this.closed || slot.adapter === undefined || slot.approval === undefined || !current(slot.approval)) return;
    await this.options.registry.refresh(slot.id);
  }

  private restoreCatalog(adapter: ExtensionAcpAdapter, grant: ApprovedExtensionTaskEngine): void {
    const saved = this.options.store.findSetting<{ readonly contentRevision: string; readonly observed: unknown }>("backend", adapter.id, ACP_CATALOG_SETTING_KEY)?.value;
    if (saved?.contentRevision === grant.binding.discoveredRevision) adapter.restoreCatalog(saved.observed);
  }

  private async ensureDefaultTarget(slot: EngineSlot, approval: ApprovedExtensionTaskEngine): Promise<void> {
    const resource = this.options.resources.get(approval.binding.resourceId);
    const targetId = `target-${slot.id}`;
    if (this.options.store.listTargets().some(target => target.descriptor.id === targetId)) return;
    const base = resource.targetId === undefined ? undefined : this.options.store.getTarget(resource.targetId);
    if (base?.descriptor.remoteWorkspace !== undefined) return;
    const workspaceId = base === undefined ? this.options.workspace.id : value(base.metadata, "workspaceId");
    if (typeof workspaceId !== "string" || workspaceId.length === 0) return;
    approval.assertCurrent();
    const target: TargetDescriptor = {
      id: targetId, backendId: slot.id, displayName: base?.descriptor.displayName ?? this.options.workspace.root.split(/[\\/]/u).filter(Boolean).at(-1) ?? slot.name,
      workspaceRoot: base?.descriptor.workspaceRoot ?? this.options.workspace.root,
      trusted: base?.descriptor.trusted ?? this.options.workspace.trusted, managed: false
    };
    await this.options.host.registerTarget(target, { workspaceId });
  }

  private async open(slot: EngineSlot, generation: number, context: AdapterContext): Promise<ExtensionAcpProcess> {
    const approval = slot.approval;
    if (approval === undefined || this.closed) throw new Error("The task engine is unavailable.");
    const resourceId = approval.binding.resourceId;
    const authorize = () => {
      if (this.closed || slot.approval !== approval) throw new Error("The task engine approval changed.");
      approval.assertCurrent();
    };
    context.signal.throwIfAborted();
    authorize();
    const count = this.launches.get(resourceId) ?? 0;
    if (count >= MAXIMUM_PLUGIN_PROCESSES) throw new Error("This plugin has reached its task engine process limit.");
    this.launches.set(resourceId, count + 1);
    let limitHeld = true;
    const releaseLimit = () => {
      if (!limitHeld) return;
      limitHeld = false;
      const remaining = (this.launches.get(resourceId) ?? 1) - 1;
      if (remaining === 0) this.launches.delete(resourceId); else this.launches.set(resourceId, remaining);
    };
    let directory: string | undefined;
    let lease: Awaited<ReturnType<PiResourceManager["acquireInstalledPackage"]>> | undefined;
    const release = async () => {
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
      await lease?.release();
      releaseLimit();
    };
    try {
      const resource = this.options.resources.get(resourceId);
      if (resource.packageIdentity === undefined || resource.approvedAt === undefined) throw new Error("The plugin installation is unapproved.");
      this.assertResourceTarget(resource, context);
      lease = await this.options.resources.acquireInstalledPackage({
        resourceId, backendId: resource.backendId, expectedResourceVersion: resource.versionNumber,
        expectedDiscoveredRevision: approval.binding.discoveredRevision, expectedPackageIdentity: resource.packageIdentity,
        ...(resource.version === undefined ? {} : { expectedPackageVersion: resource.version })
      });
      const snapshots = join(this.options.directories, "snapshots");
      await mkdir(snapshots, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(snapshots, "engine-"));
      const packageRoot = join(directory, "package");
      await mkdir(packageRoot, { mode: 0o700 });
      await lease.snapshotTo(packageRoot, context.signal);
      const catalog = await inspectPiPackageCatalog(packageRoot);
      const inspected = catalog.extensions.find(extension => extension.relativePath === approval.extensionEntry)
        ?.taskEngines?.find(engine => engine.id === approval.engine.id);
      if (JSON.stringify(inspected) !== JSON.stringify(approval.engine)) throw new Error("The approved task engine entry changed.");
      await lease.assertCurrent(context.signal);
      context.signal.throwIfAborted();
      authorize();
      const sessionOwner = createHash("sha256").update(context.sessionId).digest("hex");
      const transport = new StdioJsonRpcTransport({
        command: process.execPath,
        args: [resolve(packageRoot, ...approval.engine.entry.split("/"))],
        cwd: packageRoot,
        env: createChildRuntimeEnvironment({ overrides: {
          ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
          SSH_AUTH_SOCK: undefined, WSL_INTEROP: undefined, HTTP_PROXY: undefined, HTTPS_PROXY: undefined,
          ALL_PROXY: undefined, http_proxy: undefined, https_proxy: undefined, all_proxy: undefined
        } }).environment,
        processOwner: {
          rootDirectory: join(this.options.directories, "processes", slot.id, sessionOwner),
          instanceId: `${slot.id}-${sessionOwner}`, generation, recoverStale: true, supervisor: this.options.supervisor
        }
      });
      return { transport, assertCurrent: () => { authorize(); this.assertResourceTarget(this.options.resources.get(resourceId), context); }, release };
    } catch (error) {
      await release();
      throw error;
    }
  }

  private assertResourceTarget(resource: PiResourceDescriptor, context: AdapterContext): void {
    if (resource.targetId === undefined) return;
    const original = this.options.store.getTarget(resource.targetId).descriptor;
    const requested = this.options.store.getTarget(context.target.id).descriptor;
    const pathKey = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
    if (original.remoteWorkspace !== undefined || !original.trusted || pathKey(original.workspaceRoot) !== pathKey(requested.workspaceRoot)) {
      throw new Error("The task engine belongs to another project.");
    }
  }

  private reportUnavailable(): void {
    if (!this.closed) this.options.store.appendDiagnostic({
      severity: "warning", component: "plugin-acp", code: "PLUGIN_TASK_ENGINE_UNAVAILABLE",
      message: "A plugin task engine could not finish updating its process authority."
    });
  }
}

function engineId(approval: ApprovedExtensionTaskEngine): string {
  return `plugin-acp-${createHash("sha256").update(JSON.stringify([approval.extensionId, approval.engine.id])).digest("hex").slice(0, 32)}`;
}

function current(approval: ApprovedExtensionTaskEngine): boolean {
  try { approval.assertCurrent(); return true; } catch { return false; }
}

function value(item: unknown, key: string): unknown {
  return item !== null && typeof item === "object" ? Reflect.get(item, key) : undefined;
}
