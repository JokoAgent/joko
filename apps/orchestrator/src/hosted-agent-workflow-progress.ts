import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BackgroundTaskOutputResult, BackgroundWorkflowReadInput } from "@joko/core";
import type { HostedNativeCommand } from "@joko/adapter-hosted";
import type { HostedAgentStore, HostedNativeSessionRecord, HostedNativeSessionOwner } from "@joko/store";
import type { HostedAgentPrincipal } from "./hosted-agent-host.js";

export type HostedWorkflowProgressCommand = Extract<HostedNativeCommand, { kind: "workflow_progress" }>;
export interface HostedWorkflowProgressResult { readonly output: BackgroundTaskOutputResult; readonly virtualRoot: string }
export type HostedWorkflowProfileReader = (home: string, input: BackgroundWorkflowReadInput) => Promise<BackgroundTaskOutputResult>;

export class HostedAgentWorkflowProgress {
  constructor(readonly options: {
    readonly root: string;
    readonly store: HostedAgentStore;
    readonly authorize: (principal: HostedAgentPrincipal, command: HostedWorkflowProgressCommand, record: HostedNativeSessionRecord) => {
      readonly read: HostedWorkflowProfileReader; readonly assertCurrent: () => void;
    };
  }) {}

  async read(principal: HostedAgentPrincipal, command: HostedWorkflowProgressCommand, signal: AbortSignal): Promise<HostedWorkflowProgressResult> {
    const absent = (): HostedWorkflowProgressResult => ({ virtualRoot: "", output: { status: "unavailable", text: "", totalBytes: 0, truncated: false, capturedAtMs: Date.now() } });
    signal.throwIfAborted(); principal.assertCurrent(); principal.providerGrant?.assertCurrent();
    if (!/^claude-task-[0-9a-f]{32}$/u.test(command.taskId) || !Number.isSafeInteger(command.maximumBytes)
      || command.maximumBytes < 1 || command.maximumBytes > 262_144) throw new Error("The native workflow observation is invalid.");
    const owner: HostedNativeSessionOwner = { authorityId: principal.id, deviceId: principal.deviceId, trust: principal.trust,
      backendId: command.backendId, sessionId: command.sessionId, targetId: command.targetId, nativeSessionId: command.nativeSessionId,
      ...(principal.providerGrant?.cleanupOwner ? { providerGrant: principal.providerGrant.cleanupOwner } : {}) };
    const store = this.options.store, key = store.key(owner), record = store.find(key);
    if (!record?.binding || record.state === "creating" || record.state === "purging"
      || record.derivation && (!record.derivation.adopted || record.derivation.cleanupRequested || record.derivation.state !== "settled")) return absent();
    const grantIdentity = (grant: HostedNativeSessionOwner["providerGrant"]) => grant === undefined ? "" : JSON.stringify([grant.shareId, grant.memberId, grant.incarnation, grant.cleanupKey]);
    if (grantIdentity(record.owner.providerGrant) !== grantIdentity(owner.providerGrant)) throw new Error("The native workflow grant changed.");
    const access = this.options.authorize(principal, command, record), observed = store.backgroundTaskBinding(key, command.taskId), binding = observed ?? record.binding;
    const bindingIdentity = (value: typeof binding | undefined) => value === undefined ? "" : JSON.stringify([value.opaqueRef, value.nativeSessionId, value.generation]);
    const originalBinding = bindingIdentity(binding);
    const assertCurrent = (): void => {
      signal.throwIfAborted(); principal.assertCurrent(); principal.providerGrant?.assertCurrent(); access.assertCurrent();
      const current = store.find(key), task = store.backgroundTaskBinding(key, command.taskId);
      if (!current || current.leaseId !== record.leaseId || current.storageKey !== record.storageKey
        || current.state === "creating" || current.state === "purging"
        || JSON.stringify(current.owner) !== JSON.stringify(record.owner)
        || current.derivation && (!current.derivation.adopted || current.derivation.cleanupRequested || current.derivation.state !== "settled")
        || bindingIdentity(task ?? (observed === undefined ? current.binding : undefined)) !== originalBinding) throw new Error("The native workflow owner changed.");
    };
    assertCurrent();
    const root = this.options.root, lineage = record.storageKey ?? record.key;
    if (resolve(root) !== root) throw new Error("The native workflow storage root is invalid.");
    const home = join(root, lineage, "native"), workspace = join(root, lineage, "workspace");
    try {
      const actualHome = await realpath(home); assertCurrent();
      const actualWorkspace = await realpath(workspace); assertCurrent();
      if (actualHome !== home || actualWorkspace !== workspace) return absent();
    } catch { assertCurrent(); return absent(); }
    const output = await access.read(home, { sessionId: `hosted-session:${key}`, target: { id: `hosted-target:${lineage}`,
      backendId: owner.backendId, displayName: "Hosted Agent", workspaceRoot: workspace, trusted: false, managed: true },
      bindings: [binding], taskId: command.taskId, maximumBytes: command.maximumBytes, signal, assertCurrent });
    assertCurrent(); return { output, virtualRoot: workspace };
  }
}
