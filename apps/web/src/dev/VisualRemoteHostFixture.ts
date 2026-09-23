import type { AppController } from "../controller.js";
import { ConnectError, Code } from "@connectrpc/connect";
import type { RemoteBackendRuntimeInstallEventView, RemoteBackendRuntimeView, RemoteHostCapabilitiesView, RemoteHostDraft, RemoteHostView, TargetView, SshKeyView } from "../model.js";

/** Memory-only settings fixture. No SSH process, credential upload, or network requests. */
export class VisualRemoteHostFixture {
  readonly #targets: Map<string, TargetView>;
  readonly #hosts = new Map<string, Map<string, RemoteHostView>>();
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #runtimeInstalled = new Map<string, boolean>();
  readonly #onTarget: (target: TargetView) => void;
  readonly #keys = new Map<string, SshKeyView>([
    ["visual-work-key", { id: "visual-work-key", name: "id_ed25519", algorithm: "ssh-ed25519", comment: "Development workstation", sha256Fingerprint: "SHA256:WYm7qEkjBWvfSQHJZxtzUKNbTtGtBoSTCBPtmsZfKVU", modifiedAt: 1_783_000_000_000, inAgent: true }],
    ["visual-build-key", { id: "visual-build-key", name: "build_access", algorithm: "ssh-ed25519", comment: "Build service", sha256Fingerprint: "SHA256:NQLVrMAe45Mg1u34FvZNqcYmTSFK9HU0ueDtnMwM6cE", modifiedAt: 1_783_000_001_000, inAgent: false }]
  ]);

  constructor(targets: readonly TargetView[], onTarget: (target: TargetView) => void) {
    this.#targets = new Map(targets.map(target => [target.id, target]));
    this.#onTarget = onTarget;
    for (const target of targets) this.#hosts.set(target.id, new Map([["visual-workstation", {
      targetId: target.id, id: "visual-workstation", hostname: "workstation.example.test", port: 22, user: "joko",
      source: "manual", authentication: "systemAgent", revision: 1n,
      trust: { algorithm: "ssh-ed25519", sha256Fingerprint: "SHA256:visual-fixture-only", pinnedAt: 1 },
      status: { state: "ready", changedAt: 1 }
    }]]));
  }

  getRemoteHostCapabilities = async (): Promise<RemoteHostCapabilitiesView> => ({ catalog: true, management: true, connectionControl: true, connectionTest: true, trustReset: true, commandExecution: false, processStreaming: true, fileTransfer: true, tcpForwarding: false, backendRuntimeSetup: true });
  listRemoteHosts = async (targetId: string): Promise<readonly RemoteHostView[]> => [...this.catalog(targetId).values()];
  listRemoteHostDirectories: AppController["listRemoteHostDirectories"] = async (targetId, hostId, targetRevision, hostRevision, path, signal) => {
    await Promise.resolve(); signal?.throwIfAborted();
    const target = this.#targets.get(targetId);
    if (target?.revision !== targetRevision) throw new ConnectError("Project changed.", Code.Aborted);
    const host = this.requireHost(targetId, hostId, hostRevision);
    if (host.status.state !== "ready" || host.trust === undefined) throw new ConnectError("Host is not ready.", Code.FailedPrecondition);
    const currentPath = path === "" ? "/home/joko" : path;
    if (!currentPath.startsWith("/")) throw new ConnectError("Use an absolute SSH path.", Code.InvalidArgument);
    return { targetId, hostId, targetRevision, hostRevision, path: currentPath,
      parentPath: currentPath === "/" ? "/" : currentPath.slice(0, currentPath.lastIndexOf("/")) || "/",
      directories: currentPath === "/home/joko" ? [{ name: "project", path: "/home/joko/project" }] : [], truncated: false };
  };
  watchRemoteHosts = async function* (this: VisualRemoteHostFixture, targetId: string, signal?: AbortSignal): AsyncGenerator<readonly RemoteHostView[]> {
    const listeners = this.#listeners.get(targetId) ?? new Set(); this.#listeners.set(targetId, listeners);
    const queue: (readonly RemoteHostView[])[] = [];
    let wake: (() => void) | undefined;
    const publish = (): void => { queue.push([...this.catalog(targetId).values()]); wake?.(); };
    const cancel = (): void => wake?.();
    listeners.add(publish); signal?.addEventListener("abort", cancel);
    try {
      yield [...this.catalog(targetId).values()];
      while (!signal?.aborted) {
        if (queue.length === 0) await new Promise<void>(resolve => { wake = resolve; });
        wake = undefined;
        if (signal?.aborted) return;
        while (queue.length > 0) yield queue.shift()!;
      }
    } finally { listeners.delete(publish); signal?.removeEventListener("abort", cancel); }
  }.bind(this);
  refreshRemoteHostCatalog = async (targetId: string): Promise<readonly RemoteHostView[]> => { this.publish(targetId); return this.listRemoteHosts(targetId); };
  createRemoteHost = async (targetId: string, draft: RemoteHostDraft): Promise<RemoteHostView> => {
    if (this.catalog(targetId).has(draft.id)) throw new Error("The host alias already exists.");
    const host: RemoteHostView = { ...draft, targetId, source: "manual", revision: 1n, status: { state: "disconnected", changedAt: 1 } };
    this.catalog(targetId).set(host.id, host); this.publish(targetId); return host;
  };
  updateRemoteHost = async (targetId: string, hostId: string, revision: bigint, draft: RemoteHostDraft): Promise<RemoteHostView> => this.change(targetId, hostId, revision, host => ({ ...host, ...draft, id: hostId }));
  deleteRemoteHost = async (targetId: string, hostId: string, revision: bigint): Promise<void> => { this.requireHost(targetId, hostId, revision); this.catalog(targetId).delete(hostId); this.publish(targetId); };
  connectRemoteHost = async (targetId: string, hostId: string, revision: bigint): Promise<RemoteHostView> => this.change(targetId, hostId, revision, host => ({ ...host, trust: { algorithm: "ssh-ed25519", sha256Fingerprint: "SHA256:visual-fixture-only", pinnedAt: 1 }, status: { state: "ready", changedAt: 1 } }));
  disconnectRemoteHost = async (targetId: string, hostId: string, revision: bigint): Promise<RemoteHostView> => this.change(targetId, hostId, revision, host => ({ ...host, status: { state: "disconnected", changedAt: 1 } }));
  testRemoteHostConnection = async (targetId: string, hostId: string, revision: bigint): Promise<RemoteHostView> => this.requireHost(targetId, hostId, revision);
  clearRemoteHostTrust = async (targetId: string, hostId: string, revision: bigint): Promise<RemoteHostView> => this.change(targetId, hostId, revision, host => ({ ...host, trust: undefined }));
  probeRemoteBackendRuntime: AppController["probeRemoteBackendRuntime"] = async (targetId, hostId, targetRevision, hostRevision, signal) => {
    await Promise.resolve(); signal?.throwIfAborted();
    return this.runtime(targetId, hostId, targetRevision, hostRevision);
  };
  installRemoteBackendRuntime: AppController["installRemoteBackendRuntime"] = async function* (
    this: VisualRemoteHostFixture,
    targetId: string,
    hostId: string,
    targetRevision: bigint,
    hostRevision: bigint,
    _reinstall: boolean,
    signal?: AbortSignal
  ): AsyncGenerator<RemoteBackendRuntimeInstallEventView> {
    const requestId = `visual-runtime-${targetId}-${hostId}`;
    const phases = ["probing", "downloading", "installing", "validating"] as const;
    let sequence = 0n;
    for (const phase of phases) {
      signal?.throwIfAborted();
      sequence += 1n;
      yield { requestId, sequence, phase, runtime: { ...this.runtime(targetId, hostId, targetRevision, hostRevision), state: phase === "probing" ? "probing" : "installing", canInstall: false, canReinstall: false, canUninstall: false }, observedAt: Date.now() };
      await Promise.resolve();
    }
    this.#runtimeInstalled.set(`${targetId}\0${hostId}`, true);
    sequence += 1n;
    yield { requestId, sequence, phase: "complete", runtime: this.runtime(targetId, hostId, targetRevision, hostRevision), observedAt: Date.now() };
  }.bind(this);
  uninstallRemoteBackendRuntime: AppController["uninstallRemoteBackendRuntime"] = async (targetId, hostId, targetRevision, hostRevision) => {
    this.runtime(targetId, hostId, targetRevision, hostRevision);
    this.#runtimeInstalled.set(`${targetId}\0${hostId}`, false);
    return this.runtime(targetId, hostId, targetRevision, hostRevision);
  };
  saveCredential: AppController["saveCredential"] = async () => { throw new Error("The visual fixture accepts no private keys."); };
  listSshKeys: AppController["listSshKeys"] = async (signal) => {
    await Promise.resolve(); signal.throwIfAborted();
    return { keys: [...this.#keys.values()], agentState: "ready", generationSupported: true };
  };
  generateSshKey: AppController["generateSshKey"] = async (draft, signal) => {
    await Promise.resolve(); signal.throwIfAborted();
    const base = draft.name.trim() || "id_joko_ed25519";
    if (!/^[a-zA-Z0-9_.-]+$/u.test(base)) throw new ConnectError("ssh_key.invalid_name", Code.InvalidArgument);
    let name = base; let suffix = 1;
    while ([...this.#keys.values()].some((key) => key.name === name)) name = `${base}_${suffix++}`;
    const key: SshKeyView = { id: `visual-generated-${this.#keys.size}`, name, comment: draft.comment, algorithm: "ssh-ed25519", sha256Fingerprint: "SHA256:J1YyjwoRwft18LdQSgCE16vjINTE9HFxfVrESYiWEV8", modifiedAt: 1_783_000_002_000, inAgent: false };
    this.#keys.set(key.id, key); return key;
  };
  addSshKeyToAgent: AppController["addSshKeyToAgent"] = async (id, fingerprint, _passphrase, signal) => {
    await Promise.resolve(); signal.throwIfAborted();
    const key = this.requireKey(id, fingerprint); this.#keys.set(id, { ...key, inAgent: true });
  };
  readSshPublicKey: AppController["readSshPublicKey"] = async (id, fingerprint, signal) => {
    await Promise.resolve(); signal.throwIfAborted();
    const key = this.requireKey(id, fingerprint);
    return `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ${key.comment}`;
  };
  getSshKeyInstallCommand: AppController["getSshKeyInstallCommand"] = async (draft, signal) => {
    await Promise.resolve(); signal.throwIfAborted(); this.requireKey(draft.keyId, draft.expectedFingerprint);
    const destination = draft.destination;
    const host = destination.kind === "savedHost" ? this.requireHost(destination.targetId, destination.hostId, destination.expectedRevision) : destination;
    const quote = (text: string): string => `'${text.replaceAll("'", draft.shell === "powershell" ? "''" : `'"'"'`)}'`;
    const remote = "umask 077; mkdir -p ~/.ssh; printf '%s\\n' 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' >> ~/.ssh/authorized_keys";
    return `ssh -p ${host.port} ${quote(`${host.user}@${host.hostname}`)} ${quote(remote)}`;
  };
  updateTarget: AppController["updateTarget"] = async (id, patch, revision) => {
    const target = this.#targets.get(id);
    if (target === undefined || target.revision !== revision) throw new Error("The project changed. Reload its current values.");
    const next = { ...target, revision: revision + 1n, ...(patch.name === undefined ? {} : { name: patch.name }), ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }), ...(patch.workspaceLocation === undefined ? {} : { remoteWorkspace: patch.workspaceLocation.kind === "serviceNode" ? undefined : { hostId: patch.workspaceLocation.hostId, workspaceRoot: patch.workspaceLocation.workspaceRoot } }) };
    this.#targets.set(id, next); this.#onTarget(next);
  };

  private catalog(targetId: string): Map<string, RemoteHostView> {
    const hosts = this.#hosts.get(targetId); if (hosts === undefined) throw new Error("The project does not exist."); return hosts;
  }
  private runtime(targetId: string, hostId: string, targetRevision: bigint, hostRevision: bigint): RemoteBackendRuntimeView {
    const target = this.#targets.get(targetId);
    const host = this.requireHost(targetId, hostId, hostRevision);
    if (target === undefined || target.revision !== targetRevision || host.status.state !== "ready" || host.trust === undefined) throw new Error("The runtime authority changed.");
    const installed = this.#runtimeInstalled.get(`${targetId}\0${hostId}`) ?? true;
    return {
      targetId, hostId, displayName: "Agent runtime", expectedVersion: "0.153.4",
      ...(installed ? { installedVersion: "0.153.4" } : {}),
      state: installed ? "ready" : "notInstalled",
      canInstall: !installed, canReinstall: installed, canUninstall: installed,
      observedAt: Date.now(), targetRevision, hostRevision
    };
  }
  private requireKey(id: string, fingerprint: string): SshKeyView {
    const key = this.#keys.get(id);
    if (key === undefined) throw new ConnectError("ssh_key.not_found", Code.NotFound);
    if (key.sha256Fingerprint !== fingerprint) throw new ConnectError("ssh_key.key_changed", Code.Aborted);
    return key;
  }
  private requireHost(targetId: string, id: string, revision: bigint): RemoteHostView {
    const host = this.catalog(targetId).get(id); if (host === undefined || host.revision !== revision) throw new Error("The host changed. Reopen its current values."); return host;
  }
  private change(targetId: string, id: string, revision: bigint, update: (host: RemoteHostView) => RemoteHostView): RemoteHostView {
    const next = { ...update(this.requireHost(targetId, id, revision)), revision: revision + 1n }; this.catalog(targetId).set(id, next); this.publish(targetId); return next;
  }
  private publish(targetId: string): void { for (const listener of this.#listeners.get(targetId) ?? []) listener(); }
}
