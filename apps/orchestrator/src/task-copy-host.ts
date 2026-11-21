import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createClient, Code, ConnectError } from "@connectrpc/connect";
import { createConnectTransport, endpointOrigin, parseTrustedNodeInvitation } from "@joko/connection-transport/node";
import * as contract from "@joko/contracts";
import { capabilityNames, type BlobRef, type TargetDescriptor } from "@joko/core";
import { operationBodyHash, type ConnectionRecord, type OperationalStore } from "@joko/store";
import type { ArtifactStore } from "./artifact-store.js";
import { isLoopbackHost, isPrivateLanHttpOrigin } from "./config.js";
import type { ConnectionManager } from "./connection-manager.js";
import type { ImportPortableSessionResult, SessionHost } from "./session-host.js";
import { packageTaskCopyLayout, taskCopyWorkerName, taskCopyWorkspaceName, unpackTaskCopyLayout,
  type CopiedGoal, type CopiedWorker, type StagedTaskCopyWorker } from "./task-copy-group.js";
import { captureTaskCopyWorkspace, restoreTaskCopyWorkspace, type TaskCopyWorkspaceSummary } from "./task-copy-workspace.js";

const TRANSFER_TTL_MS = 10 * 60_000;
const CAPTURE_TTL_MS = 20 * 60_000;
const CHUNK_BYTES = 256 * 1024;
const MAXIMUM_ACTIVE_TRANSFERS = 12;
const UNTIL_IMPORTED_MS = 60 * 60_000;
const TARGET_SETTING = "portable-task-copy.v1";
const checkedId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const sha256 = /^[a-f0-9]{64}$/u;

export interface PreparedTaskCopyPart { readonly sha256: string; readonly size: number }
export interface PreparedTaskCopy {
  readonly transferId: string; readonly secret: Uint8Array; readonly operationId: string;
  readonly sourceServerId: string; readonly destinationServerId: string;
  readonly sourceSessionId: string; readonly sourceSessionGeneration: number;
  readonly expiresAt: number; readonly sessionPackage: PreparedTaskCopyPart; readonly workspaceArchive: PreparedTaskCopyPart;
  readonly title: string; readonly backendId: string; readonly managed: boolean;
}

export interface TaskCopyReceipt {
  readonly operationId: string; readonly targetId: string;
  readonly task: ImportPortableSessionResult;
  readonly workspace: TaskCopyWorkspaceSummary;
}

interface PrivateDirectory { readonly path: string; readonly identity: BigIntStats }
interface SourceLease {
  readonly grant: PreparedTaskCopy; readonly directory: PrivateDirectory; readonly archive: string; readonly package: BlobRef;
  readonly owner: ConnectionRecord; readonly stop: AbortController; readonly timer: NodeJS.Timeout; readonly revoke: () => void;
}
interface DestinationCopy {
  readonly operationId: string; readonly targetId: string; readonly connectionId: string; readonly bindingHash: string;
  readonly package: BlobRef; readonly workspace: TaskCopyWorkspaceSummary;
  readonly goal?: Omit<CopiedGoal, "workers"> & { readonly workers: readonly DestinationCopyWorker[] };
  readonly directories: readonly { readonly path: string; readonly device: string; readonly inode: string }[];
}
interface DestinationCopyWorker extends CopiedWorker { readonly targetId: string; readonly operationId: string; readonly package: BlobRef }
interface SourceRequest { readonly operationId: string; readonly sessionId: string; readonly generation: number; readonly destinationServerId: string }
interface DestinationRequest {
  readonly grant: PreparedTaskCopy; readonly sourceOrigin: string; readonly sourceInvitation?: string;
  readonly backendId: string; readonly parentTarget?: { readonly id: string; readonly revision: bigint };
}

/** Owner of short-lived source grants and exact target import receipts. */
export class TaskCopyHost {
  readonly #transfers = new Map<string, SourceLease>();
  readonly #preparations = new Map<string, { readonly binding: string; readonly promise: Promise<PreparedTaskCopy> }>();
  readonly #receiving = new Map<string, { readonly binding: string; readonly promise: Promise<TaskCopyReceipt> }>();
  readonly #stop = new AbortController();

  constructor(private readonly options: {
    readonly store: OperationalStore; readonly host: SessionHost; readonly connections: ConnectionManager;
    readonly artifacts: ArtifactStore; readonly dataDirectory: string; readonly serverId: string;
    readonly applicationVersion: string; readonly allowInsecureLoopback: boolean; readonly allowInsecureLan: boolean;
  }) {}

  prepare(input: SourceRequest, owner: ConnectionRecord, signal: AbortSignal): Promise<PreparedTaskCopy> {
    if (!uuid.test(input.operationId) || !checkedId.test(input.sessionId) || !checkedId.test(input.destinationServerId)
      || input.destinationServerId === this.options.serverId || !Number.isSafeInteger(input.generation) || input.generation < 1) {
      throw new ConnectError("Choose an original task and a different paired node.", Code.InvalidArgument);
    }
    this.#fence(owner, signal);
    const key = `${owner.id}:${input.operationId}`, binding = operationBodyHash(input);
    const existing = this.#preparations.get(key);
    if (existing) {
      if (existing.binding !== binding) throw conflict();
      return existing.promise;
    }
    if (this.#preparations.size >= MAXIMUM_ACTIVE_TRANSFERS) throw new ConnectError("The node is currently preparing too many task copies.", Code.ResourceExhausted);
    const promise = this.#prepare(input, owner, signal).catch(error => { this.#preparations.delete(key); throw error; });
    this.#preparations.set(key, { binding, promise });
    return promise;
  }

  async *read(input: { readonly transferId: string; readonly operationId: string; readonly destinationServerId: string;
    readonly part: "session" | "workspace"; readonly authorization: string | null; readonly signal: AbortSignal }):
  AsyncGenerator<{ readonly offset: bigint; readonly content: Uint8Array }> {
    const lease = this.#transfers.get(input.transferId);
    const supplied = /^JokoTaskCopy ([a-zA-Z0-9_-]{43})$/u.exec(input.authorization ?? "")?.[1];
    const secret = supplied ? Buffer.from(supplied, "base64url") : undefined;
    if (!lease || !secret || secret.length !== 32 || !timingSafeEqual(secret, lease.grant.secret)
      || input.operationId !== lease.grant.operationId || input.destinationServerId !== lease.grant.destinationServerId) {
      throw new ConnectError("The task copy read grant is unavailable.", Code.PermissionDenied);
    }
    const check = () => {
      this.#fence(lease.owner, input.signal);
      lease.stop.signal.throwIfAborted();
      if (Date.now() >= lease.grant.expiresAt) throw new ConnectError("The task copy grant expired.", Code.FailedPrecondition);
    };
    check();
    const metadata = input.part === "session" ? lease.grant.sessionPackage : lease.grant.workspaceArchive;
    const download = input.part === "session" ? await this.options.artifacts.createDownloadTicket(lease.package.id) : undefined;
    const file = input.part === "workspace" ? await open(lease.archive, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) : undefined;
    const stream = download ? (await this.options.artifacts.openDownload(download.ticketId, download.secret)).stream
      : file!.createReadStream({ autoClose: true, highWaterMark: CHUNK_BYTES });
    let offset = 0;
    try {
      for await (const value of stream) {
        check();
        const bytes = Buffer.from(value as Uint8Array);
        for (let start = 0; start < bytes.length; start += CHUNK_BYTES) {
          check();
          const content = bytes.subarray(start, start + CHUNK_BYTES);
          if (offset + content.length > metadata.size) throw invalidGrant();
          yield { offset: BigInt(offset), content };
          offset += content.length;
        }
      }
      if (offset !== metadata.size) throw invalidGrant();
      check();
    } finally { stream.destroy(); }
  }

  cancel(transferId: string, operationId: string, owner: ConnectionRecord): boolean {
    this.#fence(owner);
    const lease = this.#transfers.get(transferId);
    if (!lease) return false;
    if (lease.owner.id !== owner.id || lease.owner.authKeyDigest !== owner.authKeyDigest || lease.grant.operationId !== operationId) throw conflict();
    this.#retire(lease);
    return true;
  }

  receive(input: DestinationRequest, owner: ConnectionRecord, signal: AbortSignal): Promise<TaskCopyReceipt> {
    this.#fence(owner, signal);
    this.#validateDestination(input);
    const { grant } = input, targetId = taskCopyTargetId(grant.operationId);
    const binding = operationBodyHash({ sourceServerId: grant.sourceServerId, sourceSessionId: grant.sourceSessionId,
      generation: grant.sourceSessionGeneration, sourceBackendId: grant.backendId, title: grant.title, managed: grant.managed,
      sessionPackage: grant.sessionPackage, workspaceArchive: grant.workspaceArchive, backendId: input.backendId,
      parent: input.parentTarget ? [input.parentTarget.id, input.parentTarget.revision.toString()] : null });
    const requestBinding = `${owner.id}:${binding}`;
    const active = this.#receiving.get(grant.operationId);
    if (active) { if (active.binding !== requestBinding) throw conflict(); return active.promise; }
    if (this.#receiving.size >= MAXIMUM_ACTIVE_TRANSFERS) throw new ConnectError("The node is receiving too many task copies.", Code.ResourceExhausted);
    const promise = this.#receive(input, owner, targetId, binding, signal).finally(() => this.#receiving.delete(grant.operationId));
    this.#receiving.set(grant.operationId, { binding: requestBinding, promise });
    return promise;
  }

  receipt(operationId: string, owner: ConnectionRecord): TaskCopyReceipt | undefined {
    this.#fence(owner);
    if (!uuid.test(operationId)) throw invalidGrant();
    const targetId = taskCopyTargetId(operationId);
    const prepared = this.options.store.findSetting<DestinationCopy>("target", targetId, TARGET_SETTING)?.value;
    if (!prepared) return undefined;
    if (prepared.connectionId !== owner.id || prepared.operationId !== operationId || prepared.targetId !== targetId) throw conflict();
    const task = this.options.host.readPortableTaskCopyReceipt(operationId, owner);
    return task === undefined ? undefined : { operationId, targetId, workspace: prepared.workspace, task };
  }

  async close(): Promise<void> {
    this.#stop.abort();
    const transfers = [...this.#transfers.values()];
    for (const transfer of transfers) this.#retire(transfer);
    await Promise.allSettled([...this.#preparations.values(), ...this.#receiving.values()].map(value => value.promise));
  }

  async #prepare(input: SourceRequest, owner: ConnectionRecord, requestSignal: AbortSignal): Promise<PreparedTaskCopy> {
    const capture = this.options.host.captureTaskCopySource(input.sessionId, input.generation);
    const stop = new AbortController();
    const revoke = this.options.connections.onRevoked(owner.id, () => stop.abort());
    const signal = AbortSignal.any([requestSignal, this.#stop.signal, stop.signal, AbortSignal.timeout(CAPTURE_TTL_MS)]);
    const check = () => { this.#fence(owner, signal); capture.assertCurrent(); };
    let directory: PrivateDirectory | undefined;
    let published = false;
    try {
      capture.assertWorkspaceIdle();
      directory = await createPrivateDirectory(await this.#scratchRoot(), "source-");
      const maximum = this.options.artifacts.maximumBlobBytes;
      let remaining = maximum;
      const workspaceIndexes = new Map<string, number>();
      const workers: CopiedWorker[] = [];
      let exported: Awaited<ReturnType<SessionHost["exportPortableSession"]>> | undefined;
      for (const [index, member] of [capture.lead, ...capture.workers.map(worker => worker.source)].entries()) {
        const root = await realpath(member.root);
        let workspace = workspaceIndexes.get(root);
        if (workspace === undefined) {
          workspace = workspaceIndexes.size;
          workspaceIndexes.set(root, workspace);
          const stage = await createPrivateDirectory(directory.path, "workspace-");
          const snapshot = await captureTaskCopyWorkspace({ root, stage: stage.path, excludedRoots: capture.excludedRoots(member.root),
            maximumBytes: remaining, signal, assertCurrent: check });
          remaining -= snapshot.uncompressedBytes;
          await rename(snapshot.archive, join(directory.path, taskCopyWorkspaceName(workspace)));
        }
        capture.assertWorkspaceIdle();
        const history = await this.options.host.exportPortableSession({ sessionId: member.sessionId, taskCopyRoot: member.root,
          applicationVersion: this.options.applicationVersion, expiresAt: Date.now() + CAPTURE_TTL_MS + TRANSFER_TTL_MS }, check);
        if (history.fidelity === "product_only" || history.missingMediaCount !== 0) {
          throw new ConnectError("This Backend could not prepare the complete native task history.", Code.FailedPrecondition);
        }
        if (index === 0) { exported = history; continue; }
        remaining -= history.artifact.byteLength;
        if (remaining < 0) throw new ConnectError("The workspace and worker histories exceed the task copy limit.", Code.ResourceExhausted);
        const data = await this.options.artifacts.readBlob(history.artifact);
        await writeFile(join(directory.path, taskCopyWorkerName(index - 1)), data.data, { flag: "wx", mode: 0o600, signal });
        workers.push({ ...capture.workers[index - 1]!.values, workspace });
      }
      if (exported === undefined) throw invalidGrant();
      capture.assertWorkspaceIdle();
      const archive = await packageTaskCopyLayout(directory.path, { format: 1, workspaces: workspaceIndexes.size,
        goal: capture.goal === undefined ? undefined : { ...capture.goal, workers } });
      const workspaceArchive = await digestFile(archive, maximum, check);
      check();
      const grant: PreparedTaskCopy = Object.freeze({ transferId: randomUUID(), secret: randomBytes(32), operationId: input.operationId,
        sourceServerId: this.options.serverId, destinationServerId: input.destinationServerId, sourceSessionId: input.sessionId,
        sourceSessionGeneration: input.generation, expiresAt: Date.now() + TRANSFER_TTL_MS,
        sessionPackage: { sha256: exported.artifact.sha256, size: exported.artifact.byteLength }, workspaceArchive,
        title: capture.lead.title, backendId: capture.lead.backendId, managed: capture.lead.managed });
      const timer = setTimeout(() => { const current = this.#transfers.get(grant.transferId); if (current) this.#retire(current); }, TRANSFER_TTL_MS);
      timer.unref();
      const lease: SourceLease = { grant, directory, archive, package: exported.artifact, owner, stop, timer, revoke };
      stop.signal.addEventListener("abort", () => this.#retire(lease), { once: true });
      this.#transfers.set(grant.transferId, lease);
      published = true;
      return grant;
    } finally {
      if (!published) { revoke(); if (directory) await removePrivateDirectory(directory); }
    }
  }

  #retire(lease: SourceLease): void {
    if (this.#transfers.get(lease.grant.transferId) !== lease) return;
    this.#transfers.delete(lease.grant.transferId);
    this.#preparations.delete(`${lease.owner.id}:${lease.grant.operationId}`);
    clearTimeout(lease.timer); lease.revoke(); lease.stop.abort();
    void removePrivateDirectory(lease.directory).catch(() => undefined);
  }

  #fence(owner: ConnectionRecord, signal?: AbortSignal): void {
    this.#stop.signal.throwIfAborted(); signal?.throwIfAborted(); this.options.connections.fence(owner);
  }

  #validateDestination(input: DestinationRequest): void {
    const { grant } = input, limit = this.options.artifacts.maximumBlobBytes;
    if (!uuid.test(grant.transferId) || !uuid.test(grant.operationId) || grant.secret.length !== 32
      || !checkedId.test(grant.sourceServerId) || grant.sourceServerId === this.options.serverId || grant.destinationServerId !== this.options.serverId
      || !checkedId.test(grant.sourceSessionId) || !checkedId.test(grant.backendId) || !checkedId.test(input.backendId)
      || !Number.isSafeInteger(grant.sourceSessionGeneration) || grant.sourceSessionGeneration < 1
      || !grant.title.trim() || grant.title.length > 512 || /[\u0000-\u001f\u007f]/u.test(grant.title)
      || !Number.isSafeInteger(grant.expiresAt) || [grant.sessionPackage, grant.workspaceArchive].some(part =>
        !sha256.test(part.sha256) || !Number.isSafeInteger(part.size) || part.size < 1 || part.size > limit)
      || input.parentTarget !== undefined && (!checkedId.test(input.parentTarget.id) || input.parentTarget.revision < 1n)) throw invalidGrant();
  }

  async #receive(input: DestinationRequest, owner: ConnectionRecord, targetId: string, binding: string, requestSignal: AbortSignal): Promise<TaskCopyReceipt> {
    const { store, host, connections, artifacts } = this.options;
    const { grant } = input;
    const stop = new AbortController();
    const revoke = connections.onRevoked(owner.id, () => stop.abort());
    const signal = AbortSignal.any([requestSignal, this.#stop.signal, stop.signal, AbortSignal.timeout(TRANSFER_TTL_MS)]);
    const check = () => this.#fence(owner, signal);
    let stage: PrivateDirectory | undefined;
    const destinations: PrivateDirectory[] = [];
    let ready = false;
    try {
      check();
      let prepared = store.findSetting<DestinationCopy>("target", targetId, TARGET_SETTING)?.value;
      if (prepared !== undefined && (prepared.connectionId !== owner.id || prepared.bindingHash !== binding
        || prepared.operationId !== grant.operationId || prepared.targetId !== targetId)) throw conflict();
      const receipt = this.receipt(grant.operationId, owner);
      if (receipt) return receipt;
      if (!prepared) {
        if (grant.expiresAt <= Date.now()) throw new ConnectError("The source task copy grant expired.", Code.FailedPrecondition);
        if (store.findOperation(grant.operationId) !== undefined || store.listTargets().some(item => item.descriptor.id === targetId)) throw conflict();
        this.#assertBackend(input.backendId, grant.backendId);
        const checkParent = () => {
          check();
          if (!input.parentTarget) return undefined;
          const parent = store.getTarget(input.parentTarget.id);
          if (parent.revision !== input.parentTarget.revision || parent.descriptor.remoteWorkspace || parent.descriptor.managed
            || !parent.descriptor.trusted || (parent.metadata as { readonly deletedAt?: unknown })?.deletedAt !== undefined) {
            throw new ConnectError("The approved destination project changed or is unavailable.", Code.FailedPrecondition);
          }
          return parent.descriptor.workspaceRoot;
        };
        const parent = checkParent();
        const canonicalParent = parent === undefined
          ? await privatePath(await realpath(this.options.dataDirectory), grant.managed ? "managed-workspaces" : "copied-projects")
          : await realpath(parent);
        if (parent !== undefined && relative(parent, canonicalParent) !== "") throw conflict();
        const origin = this.#sourceTransport(input);
        const source = createClient(contract.ConnectionService, origin);
        const identity = await source.getServerInfo({}, { signal, timeoutMs: 15_000 });
        check();
        if (identity.server?.serverId !== grant.sourceServerId) throw new ConnectError("The source node identity changed.", Code.PermissionDenied);
        const client = createClient(contract.PortableSessionService, origin);
        const headers = { authorization: `JokoTaskCopy ${Buffer.from(grant.secret).toString("base64url")}` };
        const download = (part: contract.PortableTaskCopyPartKind) => client.readPortableTaskCopy({
          transferId: grant.transferId, operationId: grant.operationId, destinationServerId: grant.destinationServerId, part
        }, { headers, signal });
        stage = await createPrivateDirectory(await this.#scratchRoot(), "destination-");
        const packagePath = join(stage.path, "session.jshare"), copyPath = join(stage.path, "copy.tar");
        await receiveCopyPart(packagePath, grant.sessionPackage, download(contract.PortableTaskCopyPartKind.SESSION), check);
        await receiveCopyPart(copyPath, grant.workspaceArchive, download(contract.PortableTaskCopyPartKind.WORKSPACE), check);
        const layout = await unpackTaskCopyLayout(copyPath, stage.path, artifacts.maximumBlobBytes, check);
        const chosenWorkerBackend = layout.goal?.workers.map(worker => {
          const backendId = worker.backendId === grant.backendId ? input.backendId : worker.backendId;
          this.#assertBackend(backendId, worker.backendId);
          return backendId;
        }) ?? [];
        checkParent();
        const base = grant.title.normalize("NFC").replace(/[^a-z0-9]+/giu, "-").replace(/^-+|-+$/gu, "").slice(0, 50) || "task";
        const prefix = parent === undefined && grant.managed ? `${targetId}-` : `${base}-copy-`;
        if (relative(canonicalParent, await realpath(canonicalParent)) !== "") throw conflict();
        let remaining = artifacts.maximumBlobBytes, skippedCount = 0;
        const skipped: TaskCopyWorkspaceSummary["skipped"][number][] = [];
        for (let i = 0; i < layout.workspaces; i += 1) {
          const destination = await createPrivateDirectory(canonicalParent, i === 0 ? prefix : `${base}-worker-${i}-`);
          destinations.push(destination);
          const unpacked = await createPrivateDirectory(stage.path, "unpacked-");
          const workspace = await restoreTaskCopyWorkspace({
            archive: join(stage.path, taskCopyWorkspaceName(i)), stage: unpacked.path, destination: destination.path,
            maximumBytes: remaining, signal, assertCurrent: () => { checkParent(); }
          });
          remaining -= workspace.uncompressedBytes;
          skippedCount += workspace.skippedCount;
          skipped.push(...workspace.skipped.map(file => i === 0 ? file : { ...file, path: `worker-${i}/${file.path}` }));
        }
        checkParent();
        const target: TargetDescriptor = { id: targetId, backendId: input.backendId, displayName: grant.title, workspaceRoot: destinations[0]!.path,
          managed: parent === undefined && grant.managed, trusted: false };
        const targets = [target];
        const workers: DestinationCopyWorker[] = [];
        const blob = await ingestTaskCopyPackage(artifacts, packagePath, signal, checkParent, grant.sessionPackage);
        for (const [index, worker] of (layout.goal?.workers ?? []).entries()) {
          const workerTargetId = `${targetId}-worker-${index}`;
          targets.push({ id: workerTargetId, backendId: chosenWorkerBackend[index]!, displayName: `${layout.goal!.title} · ${worker.label}`,
            workspaceRoot: destinations[worker.workspace]!.path, managed: parent === undefined && worker.managed, trusted: false });
          const packagePath = join(stage.path, taskCopyWorkerName(index));
          const packageBlob = await ingestTaskCopyPackage(artifacts, packagePath, signal, checkParent);
          workers.push({ ...worker, targetId: workerTargetId, operationId: `${grant.operationId}:worker:${index}`, package: packageBlob });
        }
        for (const item of targets) { await host.validateTarget(item); checkParent(); }
        const directories = destinations.map(directory => ({ path: directory.path, device: directory.identity.dev.toString(), inode: directory.identity.ino.toString() }));
        await assertCopyDirectories(directories, check);
        prepared = { operationId: grant.operationId, targetId, connectionId: owner.id, bindingHash: binding, package: blob,
          workspace: { skippedCount, skipped: skipped.slice(0, 100) }, directories,
          goal: layout.goal === undefined ? undefined : { ...layout.goal, workers } };
        store.transaction(current => {
          checkParent();
          if (current.findSetting("target", targetId, TARGET_SETTING) || current.findOperation(grant.operationId)) throw conflict();
          for (const item of targets) {
            if (current.listTargets().some(target => target.descriptor.id === item.id)) throw conflict();
            current.upsertTarget(item, { workspaceId: `${item.id}-workspace`, taskCopy: true });
          }
          current.setSetting("target", targetId, TARGET_SETTING, prepared);
        });
        ready = true;
      }
      check();
      await assertCopyDirectories(prepared.directories, check);
      const members: StagedTaskCopyWorker[] = [];
      for (const worker of prepared.goal?.workers ?? []) {
        const imported = await host.importPortableSession({ operationId: worker.operationId, connection: owner, targetId: worker.targetId,
          package: worker.package, fastMode: false, permissionMode: "ask", planMode: false, overwrite: false,
          taskCopy: { kind: "worker" }, assertTaskCopyCurrent: check });
        members.push({ ...worker, sessionId: imported.value.sessionId });
      }
      const imported = await host.importPortableSession({ operationId: grant.operationId, connection: owner, targetId,
        package: prepared.package, fastMode: false, permissionMode: "ask", planMode: false, overwrite: false, assertTaskCopyCurrent: check,
        taskCopy: prepared.goal === undefined ? undefined : { kind: "lead", goal: { ...prepared.goal, workers: members } } });
      return { operationId: grant.operationId, targetId, task: imported.value, workspace: prepared.workspace };
    } finally {
      revoke();
      if (stage) await removePrivateDirectory(stage).catch(() => undefined);
      if (!ready) await Promise.allSettled(destinations.map(removePrivateDirectory));
    }
  }

  #assertBackend(backendId: string, sourceBackendId: string) {
    const backend = this.options.store.getBackend(backendId).descriptor;
    if (backend.health === "unavailable" || backend.capabilities.get(capabilityNames.sessionPortableTransfer)?.supported !== true
      || contract.portableSessionNativeFormat(backendId) !== contract.portableSessionNativeFormat(sourceBackendId)) {
      throw new ConnectError("Choose destination runtimes that can restore the task and each worker.", Code.FailedPrecondition);
    }
  }

  #sourceTransport(input: DestinationRequest) {
    const baseUrl = endpointOrigin(input.sourceOrigin);
    const parsed = new URL(baseUrl);
    const invitation = input.sourceInvitation === undefined ? undefined : parseTrustedNodeInvitation(input.sourceInvitation);
    if (invitation && (invitation.origin !== baseUrl || invitation.serverId !== input.grant.sourceServerId || invitation.endpointTransport !== undefined)) {
      throw invalidGrant();
    }
    const allowedPlaintext = parsed.protocol === "http:" && ((this.options.allowInsecureLoopback && isLoopbackHost(parsed.hostname))
      || (this.options.allowInsecureLan && isPrivateLanHttpOrigin(baseUrl)));
    if (!allowedPlaintext && (parsed.protocol !== "https:" || !invitation)) {
      throw new ConnectError("The destination needs a reachable, trusted HTTPS entrance for the source node.", Code.FailedPrecondition);
    }
    return createConnectTransport({ baseUrl, httpVersion: "1.1", useBinaryFormat: true,
      readMaxBytes: CHUNK_BYTES + 16_384, writeMaxBytes: 64 * 1024,
      ...(invitation === undefined ? {} : { endpointPublicKey: invitation.endpointPublicKey, transportKind: "https" as const }) });
  }

  async #scratchRoot(): Promise<string> {
    return privatePath(await realpath(this.options.dataDirectory), "task-copy-staging");
  }
}

function taskCopyTargetId(operationId: string): string { return `task-copy-${operationId}`; }
function conflict(): ConnectError { return new ConnectError("The original task copy identity changed.", Code.Aborted); }
function invalidGrant(): ConnectError { return new ConnectError("The task copy grant or its contents are invalid.", Code.InvalidArgument); }

async function assertCopyDirectories(directories: DestinationCopy["directories"], check: () => void): Promise<void> {
  for (const directory of directories) {
    check();
    const current = await lstat(directory.path, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || directory.device !== current.dev.toString()
      || directory.inode !== current.ino.toString() || relative(directory.path, await realpath(directory.path)) !== "") throw conflict();
  }
  check();
}

async function ingestTaskCopyPackage(artifacts: ArtifactStore, path: string, signal: AbortSignal,
  check: () => unknown, expected?: PreparedTaskCopyPart): Promise<BlobRef> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const ingested = await artifacts.ingestFileHandle(handle, {
      expectedSize: expected?.size ?? (await handle.stat()).size, signal,
      mimeType: "application/vnd.joko.session", fileName: "task-copy.jshare", expiresAt: Date.now() + UNTIL_IMPORTED_MS,
      beforeFinalize: async digest => { check(); if (expected && digest.sha256 !== expected.sha256) throw invalidGrant(); }
    });
    return { id: ingested.id, byteLength: ingested.byteLength, sha256: ingested.sha256, mimeType: ingested.mimeType, fileName: ingested.fileName };
  } finally { await handle.close(); }
}

async function privatePath(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  await mkdir(path, { mode: 0o700 }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || relative(path, await realpath(path)) !== "") throw invalidGrant();
  return path;
}

async function createPrivateDirectory(root: string, prefix: string): Promise<PrivateDirectory> {
  const path = await mkdtemp(join(root, prefix));
  return { path, identity: await lstat(path, { bigint: true }) };
}

async function removePrivateDirectory(directory: PrivateDirectory): Promise<void> {
  const info = await lstat(directory.path, { bigint: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (info?.isDirectory() && !info.isSymbolicLink() && info.dev === directory.identity.dev && info.ino === directory.identity.ino
    && relative(directory.path, await realpath(directory.path)) === "") {
    await rm(directory.path, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function digestFile(path: string, maximum: number, check: () => void): Promise<PreparedTaskCopyPart> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      check();
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > maximum) throw invalidGrant();
      hash.update(bytes);
    }
    return { sha256: hash.digest("hex"), size };
  } finally { await handle.close(); }
}

async function receiveCopyPart(path: string, expected: PreparedTaskCopyPart,
  stream: AsyncIterable<{ readonly offset: bigint; readonly content: Uint8Array }>, check: () => void): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    const hash = createHash("sha256");
    let length = 0;
    for await (const chunk of stream) {
      check();
      const bytes = chunk.content;
      if (chunk.offset !== BigInt(length) || bytes.byteLength < 1 || bytes.byteLength > CHUNK_BYTES
        || length + bytes.byteLength > expected.size) throw invalidGrant();
      hash.update(bytes);
      for (let offset = 0; offset < bytes.length;) {
        const written = await handle.write(bytes, offset, bytes.length - offset, null);
        if (written.bytesWritten < 1) throw invalidGrant();
        offset += written.bytesWritten;
      }
      length += bytes.byteLength;
    }
    if (length !== expected.size || hash.digest("hex") !== expected.sha256) throw invalidGrant();
    check();
    await handle.sync();
  } finally { await handle.close(); }
}
