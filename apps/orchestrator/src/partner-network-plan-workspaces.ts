import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { PartnerNetworkPlan, PartnerNetworkRoom } from "@joko/contracts";
import { redactSecrets, type PartnerGroupPlan, type PartnerGroupRecord } from "@joko/core";
import { networkHash, type OperationalStore, type PartnerGroupStore, type PartnerProfileRecord } from "@joko/store";
import type { ArtifactRecord, ArtifactStore } from "./artifact-store.js";
import type { PartnerGroupWorkDirectories } from "./partner-group-manager.js";
import { isShareCredentialPath, textSpellsOutSecret } from "./hosted-agent-credentials.js";

interface LocalPlan { version: 1; hostServerId: string; roomId: string; planId: string; groupId: string; localPlanId: string; }
/** Computer-local project paths never enter the shared room or its public plan record. */
export class PartnerNetworkPlanWorkspaces {
  constructor(readonly store: OperationalStore, readonly lanes: PartnerGroupStore, readonly work: PartnerGroupWorkDirectories) {}
  #key(room: PartnerNetworkRoom): string { return networkHash([room.hostServerId, room.id]); }
  project(room: PartnerNetworkRoom): string { return this.store.findSetting<{ directory: string }>("service", "partner-network-projects", this.#key(room))?.value.directory ?? ""; }
  async configure(room: PartnerNetworkRoom, directory: string, assertCurrent: () => void): Promise<string> {
    assertCurrent(); const canonical = directory.trim() ? await this.work.validateProject(directory) : ""; assertCurrent();
    this.store.setSetting("service", "partner-network-projects", this.#key(room), { directory: canonical }); return canonical;
  }
  async prepare(room: PartnerNetworkRoom, plan: PartnerNetworkPlan, profile: PartnerProfileRecord, assertCurrent: () => void): Promise<{
    group: PartnerGroupRecord; plan: PartnerGroupPlan; path: string; branch: string | null;
  }> {
    assertCurrent(); if (plan.roomId !== room.id) throw new Error("workdir-unavailable");
    const key = networkHash([room.hostServerId, room.id, plan.id]);
    let saved = this.store.findSetting<LocalPlan>("service", "partner-network-plan-workspaces", key)?.value;
    if (saved && (saved.version !== 1 || saved.hostServerId !== room.hostServerId || saved.roomId !== room.id || saved.planId !== plan.id)) throw new Error("workdir-unavailable");
    if (!saved) {
      let group = this.lanes.createExecutionGroup({ requestId: `network-plan:${key}`, partnerId: profile.id });
      group = this.lanes.update(group.id, group.revision, { name: room.name.slice(0, 40) || "Group", projectDir: this.project(room) || null });
      const localPlan = this.lanes.createPlan(group.id, group.revision, { requestText: plan.requestText.slice(0, 8_000), attachments: [],
        organizerPartnerId: profile.id, organizerName: profile.displayName, steps: [{ partnerId: profile.id, partnerName: profile.displayName, task: "Group plan" }] });
      saved = { version: 1, hostServerId: room.hostServerId, roomId: room.id, planId: plan.id, groupId: group.id, localPlanId: localPlan.id };
      this.store.setSetting("service", "partner-network-plan-workspaces", key, saved);
    }
    const group = this.lanes.ensureExecutionMember(saved.groupId, profile.id); let localPlan = this.lanes.getPlan(saved.localPlanId);
    try {
      const location = await this.work.prepare(group, localPlan, assertCurrent); assertCurrent();
      if (localPlan.workDir !== location.path || localPlan.branch !== location.branch) localPlan = this.lanes.updatePlan(localPlan.id, localPlan.revision, value => ({ ...value, workDir: location.path, branch: location.branch }));
      return { group, plan: localPlan, ...location };
    } catch { assertCurrent(); throw new Error("workdir-unavailable"); }
  }
  snapshot(path: string): Promise<ReadonlyMap<string, string>> { return this.work.snapshot(path); }
  async outputs(path: string, before: ReadonlyMap<string, string>, artifacts: ArtifactStore, signal: AbortSignal, assertCurrent: () => void): Promise<readonly { artifact: ArtifactRecord; name: string }[]> {
    const files = (await this.work.changedFiles(path, before)).slice(0, 20), root = await realpath(path), results: { artifact: ArtifactRecord; name: string }[] = []; let bytes = 0;
    for (const name of files) {
      signal.throwIfAborted(); assertCurrent(); if (isAbsolute(name)) throw new Error("input-unavailable");
      const requested = resolve(root, name), canonical = await realpath(requested), rel = relative(root, canonical);
      if (!rel || rel === ".." || rel.startsWith(`..\\`) || rel.startsWith("../") || isAbsolute(rel) || canonical !== requested) throw new Error("input-unavailable");
      if (isShareCredentialPath(requested) || isShareCredentialPath(canonical)) continue;
      const info = await lstat(canonical); bytes += info.size;
      if (!info.isFile() || info.isSymbolicLink() || info.size > Math.min(artifacts.maximumBlobBytes, 100 * 1024 * 1024) || bytes > 100 * 1024 * 1024) throw new Error("input-unavailable");
      if (info.size === 0) continue;
      const handle = await open(canonical, "r");
      try {
        const content = await handle.readFile(); assertCurrent(); signal.throwIfAborted();
        let text: string | undefined; try { text = new TextDecoder("utf-8", { fatal: true }).decode(content); } catch { /* Binary output uses the existing attachment path. */ }
        if (text !== undefined && (redactSecrets(text) !== text || textSpellsOutSecret(text))) continue;
        const artifact = await artifacts.ingestFileHandle(handle, { expectedSize: info.size, fileName: basename(name), signal, beforeFinalize: async () => {
          assertCurrent(); signal.throwIfAborted(); const current = await handle.stat();
          if (current.dev !== info.dev || current.ino !== info.ino || current.size !== info.size || current.mtimeMs !== info.mtimeMs || current.ctimeMs !== info.ctimeMs
            || await realpath(requested) !== canonical) throw new Error("input-unavailable");
        } }); assertCurrent(); results.push({ artifact, name: basename(name) });
      } finally { await handle.close(); }
    }
    return results;
  }
}
