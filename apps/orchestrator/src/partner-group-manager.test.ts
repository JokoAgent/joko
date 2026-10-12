import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PartnerGroupStore, PartnerStore } from "@joko/store";
import { PartnerGroupManager, type PartnerGroupRuntime } from "./partner-group-manager.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(withPlan = false) {
  const root = await mkdtemp(join(tmpdir(), "joko-group-manager-"));
  const profiles = new PartnerStore(join(root, "profiles.db")), storage = new PartnerGroupStore(join(root, "groups.db"));
  const members = ["Writer", "Reviewer"].map(name => {
    const created = profiles.createPartner({ requestId: `group-profile-${name}`, expectedDirectoryRevision: profiles.directoryState().revision,
      displayName: name, avatar: "orbit", templateId: "general", identitySource: `You are ${name}.`, usesDirectoryDefaults: false,
      capabilities: { modelChain: [{ backendId: "agent", providerId: "local", modelId: "text", fastMode: false }], permissionMode: "ask", planMode: false } });
    const linked = profiles.bindCanonicalSession({ partnerId: created.id, expectedRevision: created.revision, expectedProfileVersion: created.profileVersion, sessionId: `${name}-canonical` });
    return profiles.markReady(linked.id, linked.revision);
  });
  const calls: Array<{ partnerId: string; prompt: string }> = [];
  const runtime: PartnerGroupRuntime = {
    recover: async () => undefined,
    ensureLane: async input => { input.assertCurrent(); return { sessionId: input.partner.id, assertCurrent: input.assertCurrent }; },
    execute: async input => { input.onAccepted(); calls.push({ partnerId: input.lane.sessionId, prompt: input.prompt }); return { status: "completed", text: "NO_REPLY" }; },
    stop: async () => true, archive: async () => undefined, hasPendingInteraction: () => false
  };
  const notifyStep = vi.fn(async (): Promise<void> => undefined);
  const manager = new PartnerGroupManager({ storage, partners: { getPartner: id => profiles.getPartner(id), listPartners: () => profiles.listPartners() },
    runtime, work: { validateProject: async path => path, prepare: async (_group, plan) => ({ path: plan.workDir ?? "/owned/group-plan", branch: null }),
      snapshot: async () => new Map(), changedFiles: async () => ["result.txt"], trashGroup: async () => undefined },
    attachments: { prepare: async input => ({ attachments: input.attachments, commit: async () => undefined, discard: async () => undefined }) },
    decidePlan: async () => withPlan ? { needsPlan: true, steps: members.map((member, index) => ({ partnerId: member.id, task: index ? "Review result" : "Write result" })) } : { needsPlan: false }, changed: () => undefined, notifyStep });
  await manager.start();
  cleanups.push(async () => { await manager.close(); profiles.close(); storage.close(); await rm(root, { recursive: true, force: true }); });
  const group = manager.create({ requestId: "group-original-create", expectedDirectoryRevision: storage.directoryRevision(), name: "Project", memberIds: members.map(member => member.id) });
  const send = (text: string, clientId: string, division = false) => manager.send({ groupId: group.id, expectedRevision: storage.get(group.id).revision, clientId,
    text, mentions: null, division, attachments: [], deviceId: "viewer", assertRequest: () => undefined });
  return { manager, profiles, storage, group, members, runtime, calls, send, notifyStep };
}

describe("Partner group execution owner", () => {
  it("accepts a new note after the handoff commits while its outbox notification is still settling", async () => {
    const f = await fixture(true); let release!: () => void;
    f.notifyStep.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    await f.send("Prepare a shared result", "handoff-note-original", true);
    await vi.waitFor(() => expect(f.storage.openPlan(f.group.id)?.status).toBe("proposed"));
    const proposed = f.storage.openPlan(f.group.id)!; await f.manager.planAction(f.group.id, proposed.id, proposed.revision, "start", () => undefined);
    await vi.waitFor(() => expect(f.storage.openPlan(f.group.id)?.status).toBe("waiting"));
    await expect(f.send("Add the missing conclusion", "handoff-follow-up")).resolves.toMatchObject({ content: "Add the missing conclusion" });
    await vi.waitFor(() => expect(f.calls.some(call => call.prompt.includes("Add the missing conclusion"))).toBe(true)); release();
  });
  it("fixes the broadcast high-water mark, enforces reply circles and preserves unread replies beyond the latest page", async () => {
    const f = await fixture(); let call = 0;
    f.runtime.execute = async input => {
      input.onAccepted(); f.calls.push({ partnerId: input.lane.sessionId, prompt: input.prompt });
      call++; return { status: "completed", text: call <= 4 ? `Reply ${call}` : "NO_REPLY" };
    };
    f.runtime.ensureLane = async input => {
      if (input.partner.id === f.members[1]!.id) await new Promise(resolve => setTimeout(resolve, 35));
      input.assertCurrent(); return { sessionId: input.partner.id, assertCurrent: input.assertCurrent };
    };
    const original = await f.send("Discuss the result", "group-user-original");
    await vi.waitFor(() => expect(f.manager.detail(f.group.id, "viewer").round.canContinue).toBe(true));
    expect(f.calls).toHaveLength(6);
    expect(f.calls[1]?.prompt).not.toContain("Reply 1");
    expect(f.calls[2]?.prompt).toContain("Reply 1");
    expect(f.storage.messages(f.group.id).messages.filter(message => message.authorKind === "partner")).toHaveLength(4);
    expect(await f.send("Discuss the result", "group-user-original")).toEqual(original); expect(f.calls).toHaveLength(6);
    await expect(f.send("A different request", "group-user-original")).rejects.toMatchObject({ code: "changed" }); expect(f.calls).toHaveLength(6);
    for (let i = 0; i < 102; i++) f.storage.appendMessage(f.group.id, { clientId: `quiet-user-${i}`, kind: "message", authorKind: "user", authorPartnerId: null,
      authorName: "", content: "Follow up", mentions: { all: false, partnerIds: [] }, noticeCode: null, planId: null, files: [], attachments: [] });
    expect(f.manager.list("viewer").groups[0]?.unread).toBe(true);
    f.manager.markRead(f.group.id, "viewer", f.storage.latestSequence(f.group.id)); expect(f.manager.list("viewer").groups[0]?.unread).toBe(false);
  });
  it("persists approved step handoffs atomically and waits for explicit continuation between members", async () => {
    const f = await fixture(true);
    f.runtime.execute = async input => { input.onAccepted(); f.calls.push({ partnerId: input.lane.sessionId, prompt: input.prompt }); return { status: "completed", text: "Finished this step." }; };
    await f.send("Create the result", "group-user-plan", true);
    await vi.waitFor(() => expect(f.storage.openPlan(f.group.id)?.status).toBe("proposed"));
    const first = f.storage.openPlan(f.group.id)!;
    await f.manager.planAction(f.group.id, first.id, first.revision, "start", () => undefined);
    await vi.waitFor(() => expect(f.storage.openPlan(f.group.id)?.status).toBe("waiting"));
    const waiting = f.storage.openPlan(f.group.id)!; expect(waiting.steps.map(step => step.status)).toEqual(["done", "pending"]); expect(f.calls).toHaveLength(1);
    const handoff = f.storage.findMessage(f.group.id, waiting.steps[0]!.resultMessageId!)!; expect(handoff.files).toEqual(["result.txt"]);
    await f.manager.planAction(f.group.id, waiting.id, waiting.revision, "continue", () => undefined);
    await vi.waitFor(() => expect(f.storage.getPlan(first.id).status).toBe("done"));
    expect(f.calls).toHaveLength(2); expect(f.calls[1]?.prompt).toContain("Finished this step.");
    expect(f.notifyStep).toHaveBeenCalledTimes(2);
    expect(f.storage.messages(f.group.id).messages.at(-1)?.kind).toBe("plan-end");
  });
});
