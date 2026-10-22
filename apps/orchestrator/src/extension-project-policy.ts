import { createHash } from "node:crypto";
import path from "node:path";
import type { TargetDescriptor, RuntimeResource } from "@joko/core";
import type { OperationalStore } from "@joko/store";
import type { ExtensionCatalogDescriptor, ExtensionCatalogSnapshot } from "./extension-catalog.js";
import { listProjectDirectories } from "./project-directory-browser.js";

export interface ExtensionProject {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}
export interface ExtensionProjectState {
  readonly project: ExtensionProject;
  readonly revision: bigint;
  readonly disabledExtensionIds: readonly string[];
}
const SCOPE = "extension-project-policies";

/** String-only: a remote workspace path must never be resolved on this host. */
export function normalizeExtensionProjectPath(value: string): string {
  if (!value.trim() || value.length > 4096 || /[\0\r\n]/u.test(value)) throw new Error("Invalid project directory.");
  const windows = /^[A-Za-z]:[\\/]/u.test(value) || value.includes("\\");
  if (!(windows ? path.win32 : path.posix).isAbsolute(value)) throw new Error("Invalid project directory.");
  let normalized = (windows ? path.win32 : path.posix).normalize(value);
  if (windows) {
    if (normalized.length > 3 && /[\\/]$/u.test(normalized)) normalized = normalized.slice(0, -1);
    return normalized.toLowerCase();
  }
  if (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

export function extensionProjectForTarget(target: TargetDescriptor): ExtensionProject {
  const remote = target.remoteWorkspace;
  const directory = remote?.workspaceRoot ?? target.workspaceRoot;
  const host = remote === undefined ? ["local"] : remote.kind === "ssh"
    ? ["ssh", remote.hostTargetId, remote.hostId] : ["device_peer", remote.controllerDeviceId, remote.targetDeviceId];
  const id = createHash("sha256").update(JSON.stringify([...host, normalizeExtensionProjectPath(directory)])).digest("hex");
  return { id, name: target.displayName, path: directory };
}

/** Durable disable-only exceptions. Uninstall never deletes a project's choices. */
export class ExtensionProjectPolicies {
  readonly #browsed = new Map<string, Map<string, ExtensionProject>>();
  constructor(private readonly store: OperationalStore) {}

  list(): readonly ExtensionProject[] {
    const projects = new Map<string, ExtensionProject>();
    for (const { descriptor } of this.store.listTargets()) {
      const project = extensionProjectForTarget(descriptor);
      if (!projects.has(project.id)) projects.set(project.id, project);
    }
    return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async resolve(directory: string, connectionId: string, signal: AbortSignal, assertCurrent: () => void): Promise<ExtensionProject> {
    // A browsed directory is transient authority on the selected service. It
    // neither creates a Target/Session nor modifies the user's recent projects.
    normalizeExtensionProjectPath(directory);
    const listing = await listProjectDirectories(directory, signal);
    signal.throwIfAborted(); assertCurrent();
    const normalized = normalizeExtensionProjectPath(listing.path);
    const project = { id: createHash("sha256").update(JSON.stringify(["local", normalized])).digest("hex"),
      name: path.basename(listing.path) || listing.path, path: listing.path };
    let owned = this.#browsed.get(connectionId);
    if (!owned) {
      if (this.#browsed.size >= 256) this.#browsed.delete(this.#browsed.keys().next().value!);
      owned = new Map(); this.#browsed.set(connectionId, owned);
    }
    if (!owned.has(project.id) && owned.size >= 256) throw new Error("Project directory selection capacity exceeded.");
    owned.set(project.id, project);
    return project;
  }

  project(id: string, connectionId: string): ExtensionProject {
    const project = this.list().find(project => project.id === id) ?? this.#browsed.get(connectionId)?.get(id);
    if (!project) throw new Error("Project directory not found. Select it again on this service.");
    return project;
  }

  #read(id: string): { revision: bigint; ids: readonly string[] } {
    const record = this.store.findSetting("service", SCOPE, id);
    if (!record) return { revision: 0n, ids: [] };
    const value = record.value as { format?: unknown; disabledExtensionIds?: unknown } | null;
    const ids = value?.disabledExtensionIds;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "disabledExtensionIds,format"
      || value.format !== 1 || !Array.isArray(ids) || ids.length > 4096
      || ids.some(id => typeof id !== "string" || !id || id.length > 256)
      || new Set(ids).size !== ids.length
      || [...ids].sort().some((id, index) => id !== ids[index])) {
      throw new Error("Project plugin settings are unreadable. Restore the current-v1 settings before changing them.");
    }
    return { revision: record.revision, ids: ids as string[] };
  }

  state(id: string, connectionId: string): ExtensionProjectState {
    const project = this.project(id, connectionId), state = this.#read(id);
    return { project, revision: state.revision, disabledExtensionIds: [...state.ids] };
  }

  setEnabled(id: string, connectionId: string, extension: ExtensionCatalogDescriptor, enabled: boolean, expectedRevision: bigint): void {
    this.project(id, connectionId);
    if (extension.owner.kind !== "resource" || !extension.installed) throw new Error("Only installed plugins support project settings.");
    const state = this.#read(id);
    if (state.revision !== expectedRevision) throw new Error("Project plugin settings changed concurrently.");
    if (enabled && !extension.enabled) throw new Error("Enable this plugin globally before enabling it for a project.");
    const ids = new Set(state.ids);
    if (enabled) ids.delete(extension.id); else ids.add(extension.id);
    if (ids.size > 4096) throw new Error("Project plugin settings exceed their limit.");
    this.store.setSetting("service", SCOPE, id, { format: 1, disabledExtensionIds: [...ids].sort() });
  }

  enabledForTarget(extensionId: string, targetId: string): boolean {
    const target = this.store.getTarget(targetId).descriptor;
    return !this.#read(extensionProjectForTarget(target).id).ids.includes(extensionId);
  }

  assertEnabledForSession(extensionId: string, sessionId: string): void {
    if (!this.enabledForTarget(extensionId, this.store.getSession(sessionId).descriptor.targetId)) throw new Error("Plugin is disabled for this project.");
  }

  snapshot(snapshot: ExtensionCatalogSnapshot, targetId: string): ExtensionCatalogSnapshot {
    const state = this.#read(extensionProjectForTarget(this.store.getTarget(targetId).descriptor).id), disabled = new Set(state.ids);
    // Pagination must fence changes to either the installation catalog or the
    // project's exceptions, including equal-size swaps between pages.
    const revision = createHash("sha256").update(JSON.stringify([snapshot.revision.toString(), state.revision.toString()])).digest().readBigUInt64BE();
    return { ...snapshot, revision, entries: snapshot.entries.filter(entry => !disabled.has(entry.id)) };
  }

  excludedNativeEntries(entries: readonly ExtensionCatalogDescriptor[], resources: readonly RuntimeResource[], targetId: string): readonly { readonly resourceId: string; readonly entryPath?: string }[] {
    const disabled = new Set(this.#read(extensionProjectForTarget(this.store.getTarget(targetId).descriptor).id).ids);
    return entries.flatMap(entry => {
      if (!disabled.has(entry.id) || entry.owner.kind !== "resource") return [];
      const resourceId = entry.owner.resourceId;
      const resource = resources.find(resource => resource.id === resourceId);
      if (!resource) return [];
      if (resource.kind === "extension") return [{ resourceId }];
      if (resource.kind !== "package" || entry.runtimeEntryPath === undefined) return [];
      return [{ resourceId, entryPath: entry.runtimeEntryPath }];
    });
  }
}
