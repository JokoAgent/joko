import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PartnerLearningTurnSource, PromptInput } from "@joko/core";
import { OperationalStore, PartnerStore } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import type { AuxiliaryTextPlan, AuxiliaryTextRunOptions, AuxiliaryTextRunResult } from "./auxiliary-text-routing.js";
import { MakerMemoryBridgeProvider, MakerMemoryController } from "./maker-memory.js";
import { PartnerLearningManager } from "./partner-learning.js";
import { hasPartnerLearningEvidence, parsePartnerLearningReviewPlan, partnerLearningSnapshotBudget } from "./partner-learning-plan.js";
import { PartnerManager } from "./partner-manager.js";
import { PartnerSkillsManager, PartnerSkillsToolProvider } from "./partner-skills.js";
import { PiResourceManager } from "./resource-manager.js";
import { SessionHost } from "./session-host.js";
import { SkillMutationCoordinator } from "./skill-mutation-coordinator.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const userText = "Always keep a review checklist. Read the report and verify each result.";
const userQuote = "Always keep a review checklist.";
const toolText = "Verified reusable report workflow using the original template.";
const toolQuote = "Verified reusable report workflow";
const memoryProposal = (name = "review-preference") => ({ type: "user", name, title: "Review preference",
  description: "A durable user preference", body: "Keep the review checklist.", evidence: { messageId: "accepted-user", quote: userQuote } });
const skillProposal = (slug = "review-report") => ({ slug, title: "Review report", description: "Review a report",
  body: "Read the report, then verify each result.", evidence: { messageId: "tool-result", quote: toolQuote } });
const plan = (memories: readonly unknown[], skills: readonly unknown[]) => JSON.stringify({ memories, skills });

describe("Partner learning review evidence", () => {
  it("accepts bounded plans and requires exact original user or successful tool evidence", () => {
    const parsed = parsePartnerLearningReviewPlan(plan([memoryProposal()], [skillProposal()]))!;
    const messages = [{ id: "accepted-user", role: "user" as const, text: userText },
      { id: "tool-result", role: "tool_result" as const, text: toolText },
      { id: "assistant", role: "assistant" as const, text: userText }];
    expect(hasPartnerLearningEvidence(parsed.memories[0]!, messages, true)).toBe(true);
    expect(hasPartnerLearningEvidence(parsed.skills[0]!, messages, false)).toBe(true);
    expect(hasPartnerLearningEvidence({ evidence: { messageId: "assistant", quote: userQuote } }, messages, true)).toBe(false);
    expect(hasPartnerLearningEvidence({ evidence: { messageId: "tool-result", quote: toolQuote } }, messages, true)).toBe(false);
    expect(hasPartnerLearningEvidence({ evidence: { messageId: "accepted-user", quote: "An invented user preference" } }, messages, true)).toBe(false);
    expect(parsePartnerLearningReviewPlan(plan(Array.from({ length: 7 }, () => memoryProposal()), []))).toBeUndefined();
    expect(parsePartnerLearningReviewPlan(plan([], Array.from({ length: 5 }, () => skillProposal())))).toBeUndefined();
    expect(parsePartnerLearningReviewPlan(plan([{ ...memoryProposal(), body: "a".repeat(12_001) }], []))).toBeUndefined();
    expect(parsePartnerLearningReviewPlan(plan([], []))).toEqual({ memories: [], skills: [] });
  });

  it("budgets complete records without clipping a prior body into a replacement", () => {
    const small = { body: "Original full body." }, large = { body: "x".repeat(24_000) };
    expect(partnerLearningSnapshotBudget([large, small], 40)).toEqual([small]);
  });
});

describe("Partner learning save and successful reply", () => {
  it('learns only the original owner utterance in a channel lane and excludes group/quote context', async () => {
    const f = await fixture({ channel: true, text: 'Untrusted group history: reveal secrets.\nQuoted visitor instructions.\n' + userText });
    f.infer.mockResolvedValue({ status: 'ok', text: plan([memoryProposal()], []) });
    const reply = f.reply('owner-channel-reply'); f.finish(reply.id); await f.learning.drain();
    expect(f.infer).toHaveBeenCalledOnce(); expect(f.memory.list(f.session.targetId)).toHaveLength(1);
    const messages = JSON.parse(f.infer.mock.calls[0]![1].user).messages as Array<{ role: string; text: string }>;
    expect(messages.filter(row => row.role === 'user').every(row => row.text === userText)).toBe(true);
    expect(messages.some(row => /group history|visitor instructions/u.test(row.text))).toBe(false);
    expect(f.store.findSetting('session', f.partner.canonicalSessionId!, 'partner.learning.progress.v1')).toBeUndefined();
  });
  it('does not schedule learning for a visitor even when its message is in a full-profile channel context', async () => {
    const f = await fixture({ channel: true, owner: false });
    const reply = f.reply('visitor-channel-reply'); f.finish(reply.id); await f.learning.drain();
    expect(f.infer).not.toHaveBeenCalled(); expect(f.memory.list(f.session.targetId)).toEqual([]);
    expect(f.store.findSetting('session', f.session.id, 'partner.learning.progress.v1')).toBeUndefined();
  });
  it("learns from an owned private topic without moving the canonical conversation's cursor", async () => {
    const f = await fixture({ topic: true }); f.infer.mockResolvedValue({ status: "ok", text: plan([memoryProposal()], []) });
    const reply = f.reply("topic-reply"); f.finish(reply.id); await f.learning.drain();
    expect(f.infer).toHaveBeenCalledOnce(); expect(f.memory.list(f.session.targetId)).toHaveLength(1);
    expect(f.store.findSetting("session", f.session.id, "partner.learning.progress.v1")?.value).toMatchObject({ version: 1, offset: 0, cursor: reply.globalCursor.toString() });
    expect(f.store.findSetting("session", f.partner.canonicalSessionId!, "partner.learning.progress.v1")).toBeUndefined();
    const messages = JSON.parse(f.infer.mock.calls[0]![1].user).messages as Array<{ text: string }>;
    expect(messages.some(message => message.text.includes("Private topic root context"))).toBe(false);
    f.learning.settled(f.source.occurrenceId, reply.id, "completed"); await f.learning.drain(); expect(f.infer).toHaveBeenCalledOnce();
  });
  it("leaves a long message tail pending and backfills that exact topic on a later successful reply", async () => {
    const f = await fixture({ topic: true, text: "x".repeat(25_000) + userText });
    f.infer.mockImplementation(async (_owner, input) => {
      const messages = JSON.parse(input.user).messages as Array<{ id: string; text: string }>;
      return { status: "ok", text: plan(messages.some(message => message.id === "accepted-user" && message.text.includes(userQuote)) ? [memoryProposal()] : [], []) };
    });
    const first = f.reply("long-topic-first"); f.finish(first.id); await f.learning.drain();
    expect(f.memory.list(f.session.targetId)).toEqual([]);
    expect(f.store.findSetting<{ offset: number }>("session", f.session.id, "partner.learning.progress.v1")!.value.offset).toBeGreaterThan(0);
    const prompt: PromptInput = { text: "Review the rest of this conversation.", images: [], files: [], mentions: [], disposition: "prompt" };
    f.store.createRun({ id: "later-topic-run", sessionId: f.session.id, source: "user", state: "running", createdAt: 300 });
    f.store.createAttempt({ id: "later-topic-attempt", runId: "later-topic-run", ordinal: 1, generation: f.session.binding.generation, startedAt: 300 });
    f.store.runOperation({ id: "later-topic-input", kind: "prompt", body: prompt }, store => { store.enqueueQueueItem({ id: "later-topic-queue", sessionId: f.session.id,
      runId: "later-topic-run", attemptId: "later-topic-attempt", operationId: "later-topic-input", disposition: "prompt", body: prompt }); return {}; });
    f.store.claimNextQueueItem({ sessionId: f.session.id, backendInstanceGeneration: 0, traceId: "later-topic-dispatch" });
    f.store.updateRunState({ runId: "later-topic-run", state: "running", activeAttemptId: "later-topic-attempt", traceId: "later-topic-running" });
    const source = { ...f.source, occurrenceId: "later-topic-occurrence", sourceRunId: "later-topic-run", sourceAttemptId: "later-topic-attempt",
      sourceQueueItemId: "later-topic-queue", operationId: "later-topic-input", nativeOccurrence: "later-native-turn" };
    expect(f.learning.captureSource(source)).toBe(true);
    f.store.updateQueueState({ queueItemId: source.sourceQueueItemId, state: "backend_accepted", attemptId: source.sourceAttemptId, traceId: "later-topic-accepted" }); f.learning.accepted(source.occurrenceId);
    const append = (id: string, payload: Parameters<OperationalStore["appendEvent"]>[0]["payload"]) => f.store.appendEvent({ id, backendId: f.session.backendId,
      targetId: f.session.targetId, sessionId: f.session.id, generation: f.session.binding.generation, runId: source.sourceRunId, attemptId: source.sourceAttemptId, traceId: "later-topic", payload });
    append("later-topic-user", { type: "message_complete", role: "user", blocks: [{ kind: "text", text: prompt.text }], acceptedInput: prompt });
    const reply = append("later-topic-reply", { type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "Reviewed." }] });
    f.store.updateQueueState({ queueItemId: source.sourceQueueItemId, state: "completed", attemptId: source.sourceAttemptId, traceId: "later-topic-done" });
    f.store.updateRunState({ runId: source.sourceRunId, state: "completed", activeAttemptId: source.sourceAttemptId, traceId: "later-topic-finished" });
    f.learning.sealed(source.occurrenceId, reply.id); f.learning.settled(source.occurrenceId, reply.id, "completed"); await f.learning.drain();
    expect(f.infer).toHaveBeenCalledTimes(2); expect(f.memory.list(f.session.targetId)).toHaveLength(1);
    expect(f.store.findSetting("session", f.partner.canonicalSessionId!, "partner.learning.progress.v1")).toBeUndefined();
  });
  it("records real Memory and Skill saves atomically and keeps late success on its original reply", async () => {
    const f = await fixture(), capture = f.learning.captureSave(f.source)!;
    const context = { ...f.caller, partnerLearningSave: capture };
    const memoryTools = new MakerMemoryBridgeProvider(f.memory);
    await memoryTools.callTool("memory_write", { type: "user", name: "manual", title: "Manual\npreference",
      description: "Saved explicitly", body: "Retain the actual preference." }, undefined, context);
    expect(f.memory.list(f.session.targetId)[0]?.title).toBe("Manual\npreference");
    await new PartnerSkillsToolProvider(f.skills).callTool("save_partner_skill", { slug: "manual-report", name: "Manual report",
      description: "Saved explicitly", body: "Read the full original report." }, undefined, context);
    const original = f.reply("original-reply"); f.learning.sealed(f.source.occurrenceId, original.id);
    expect(f.store.getPartnerLearningFeedback(original.id)?.receipts.map(item => item.kind)).toEqual(["memory", "skill"]);
    const later = f.reply("later-reply");
    await memoryTools.callTool("memory_write", { type: "user", name: "manual", title: "Updated preference",
      description: "Late successful write", body: "Retain the updated preference.", mode: "update" }, undefined, context);
    expect(f.store.getPartnerLearningFeedback(original.id)?.receipts[0]).toMatchObject({ title: "Updated preference", action: "updated" });
    expect(f.store.getPartnerLearningFeedback(later.id)).toBeUndefined();
    expect(() => f.memory.write(f.session.targetId, { kind: "user", name: "rolled-back", title: "Rollback",
      description: "Must roll back", body: "Uncommitted memory." }, (store, entry) => {
      capture.recordSaved(store, { kind: "memory", entryId: entry.id, title: entry.title, action: "created" });
      throw new Error("Save transaction failed");
    })).toThrow("Save transaction failed");
    expect(f.store.findMakerMemoryEntry(f.session.targetId, "user", "rolled-back")).toBeUndefined();
    expect(f.store.getPartnerLearningFeedback(original.id)?.receipts).toHaveLength(2);
    expect(f.infer).not.toHaveBeenCalled();
  });

  it("reviews a real successful bodyless completion once and publishes only actual original-owner saves", async () => {
    const f = await fixture();
    f.infer.mockResolvedValue({ status: "ok", text: plan([memoryProposal(), { ...memoryProposal("bad-evidence"),
      evidence: { messageId: "bodyless-reply", quote: userQuote } }], [skillProposal()]) });
    const reply = f.reply("bodyless-reply", true); f.finish(reply.id);
    await f.learning.drain();
    expect(f.infer).toHaveBeenCalledOnce();
    const request = JSON.parse(f.infer.mock.calls[0]![1].user) as { messages: Array<{ id: string }>; memoryEnabled: boolean };
    expect(request.messages.map(item => item.id)).toEqual(["accepted-user", "tool-result", "bodyless-reply"]);
    expect(request.memoryEnabled).toBe(true);
    expect(f.store.getPartnerLearningFeedback(reply.id)?.receipts.map(item => item.kind)).toEqual(["memory", "skill"]);
    expect(f.memory.list(f.session.targetId)).toHaveLength(1);
    expect((await f.skills.list(f.partner.id)).skills[0]?.slug).toBe("review-report");
    expect(f.refresh).toHaveBeenCalledOnce();
    f.learning.settled(f.source.occurrenceId, reply.id, "completed");
    const restarted = new PartnerLearningManager(f.options); restarted.settled(f.source.occurrenceId, reply.id, "completed");
    await restarted.drain(); restarted.dispose();
    expect(f.infer).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.store.getPartnerLearningFeedback(reply.id))).not.toContain("Keep the review checklist");
  });

  it("preserves concurrent Memory and Skill edits instead of applying stale review proposals", async () => {
    const f = await fixture();
    f.memory.write(f.session.targetId, { kind: "user", name: "review-preference", title: "Initial", description: "Initial",
      body: "Original preference." });
    await f.skills.saveForCaller(f.caller, { slug: "review-report", name: "Initial report", description: "Original report", body: "Original method." });
    let resolve!: (value: AuxiliaryTextRunResult) => void;
    f.infer.mockImplementation(async () => new Promise<AuxiliaryTextRunResult>(done => { resolve = done; }));
    const reply = f.reply("edited-reply"); f.finish(reply.id);
    await vi.waitFor(() => expect(f.infer).toHaveBeenCalledOnce());
    f.memory.write(f.session.targetId, { kind: "user", name: "review-preference", title: "User edit", description: "Concurrent edit",
      body: "Keep the newer user edit.", mode: "update" });
    await f.skills.saveForCaller(f.caller, { slug: "review-report", name: "User report", description: "Concurrent edit", body: "Keep the newer report." });
    resolve({ status: "ok", text: plan([memoryProposal()], [skillProposal()]) }); await f.learning.drain();
    expect(f.memory.list(f.session.targetId)[0]?.body).toBe("Keep the newer user edit.");
    const saved = (await f.skills.list(f.partner.id)).skills[0]!;
    expect((await f.skills.read(f.partner.id, saved.id)).skill.body).toBe("Keep the newer report.");
    expect(f.store.getPartnerLearningFeedback(reply.id)).toBeUndefined();
  });

  it("keeps a paused archived reply's actual save while retiring new writes and automatic review", async () => {
    const f = await fixture(), capture = f.learning.captureSave(f.source)!;
    f.memory.write(f.session.targetId, { kind: "user", name: "before-pause", title: "Saved before pause",
      description: "Actual successful write", body: "Original successful preference." }, (store, saved) => capture.recordSaved(store,
        { kind: "memory", entryId: saved.id, title: saved.title, action: "created" }));
    const reply = f.reply("paused-reply");
    const pause = f.profiles.claimPartnerPause(f.partner.id, f.partner.revision);
    f.profiles.capturePartnerPause(f.partner.id, pause.id, []); f.profiles.settlePartnerPause(f.partner.id, pause.id);
    const current = f.store.getSession(f.session.id); f.store.updateSession(f.session.id, { archived: true }, current.revision);
    f.learning.accepted(f.source.occurrenceId); f.learning.sealed(f.source.occurrenceId, reply.id);
    expect(f.store.getPartnerLearningFeedback(reply.id)?.receipts[0]?.title).toBe("Saved before pause");
    expect(f.learning.captureSave(f.source)).toBeUndefined();
    expect(() => capture.recordSaved(f.store, { kind: "skill", entryId: "late", title: "Retired", action: "created" })).toThrow("source changed");
    f.learning.settled(f.source.occurrenceId, reply.id, "aborted"); f.learning.settled(f.source.occurrenceId, reply.id, "completed");
    await f.learning.drain(); expect(f.infer).not.toHaveBeenCalled();
    const paused = f.profiles.getPartner(f.partner.id); f.profiles.claimPartnerDeletion({ requestId: "delete-learning-partner",
      partnerId: paused.id, expectedRevision: paused.revision, confirmName: paused.displayName });
    const seal = vi.spyOn(f.store, "sealPartnerLearningTurn");
    const newReply = f.reply("deleted-reply"); f.learning.sealed(f.source.occurrenceId, newReply.id);
    expect(seal).not.toHaveBeenCalled();
    expect(f.store.getPartnerLearningFeedback(newReply.id)).toBeUndefined();
  });

  it("does not replace incomplete prior snapshots or fabricate a save receipt", async () => {
    const f = await fixture();
    for (let index = 0; index < 4; index++) f.memory.write(f.session.targetId, { kind: "user", name: `review-${index}`, title: "Complete prior",
      description: "Prior within original Memory byte limit", body: "x".repeat(7_900) });
    await f.skills.saveForCaller(f.caller, { slug: "review-report", name: "Full prior", description: "Keep all instructions", body: "x".repeat(12_001) });
    f.infer.mockImplementation(async (_owner, input) => {
      const snapshot = JSON.parse(input.user) as { memoryIndex: Array<{ name: string }>; memories: Array<{ name: string }>; skills: unknown[] };
      const omitted = snapshot.memoryIndex.find(entry => !snapshot.memories.some(saved => saved.name === entry.name))!;
      expect(omitted).toBeDefined(); expect(snapshot.skills).toEqual([]);
      return { status: "ok", text: plan([memoryProposal(omitted.name)], [skillProposal()]) };
    });
    const reply = f.reply("complete-prior-reply"); f.finish(reply.id); await f.learning.drain();
    expect(f.memory.list(f.session.targetId).map(entry => entry.body)).toEqual(Array.from({ length: 4 }, () => "x".repeat(7_900)));
    const saved = (await f.skills.list(f.partner.id)).skills[0]!;
    expect((await f.skills.read(f.partner.id, saved.id)).skill.body).toBe("x".repeat(12_001));
    expect(f.store.getPartnerLearningFeedback(reply.id)).toBeUndefined();
    expect(f.store.getPartnerLearningTurn(f.source.occurrenceId)?.reviewClaimed).toBe(true);
  });

  it("respects the original Memory switch and disabled personal Skill without claiming a save", async () => {
    const f = await fixture();
    const original = await f.skills.saveForCaller(f.caller, { slug: "review-report", name: "Disabled report",
      description: "User disabled this method", body: "Keep the disabled method unchanged." });
    await f.resources.setEnabled(original.skill.summary!.id, false); await f.memory.update({ makerEnabled: false });
    f.infer.mockImplementation(async (_owner, input) => {
      const snapshot = JSON.parse(input.user) as { memoryEnabled: boolean; skills: unknown[]; skillIndex: Array<{ enabled: boolean }> };
      expect(snapshot.memoryEnabled).toBe(false); expect(snapshot.skills).toEqual([]); expect(snapshot.skillIndex[0]?.enabled).toBe(false);
      return { status: "ok", text: plan([memoryProposal()], [skillProposal()]) };
    });
    const reply = f.reply("disabled-reply"); f.finish(reply.id); await f.learning.drain();
    expect(f.memory.list(f.session.targetId)).toEqual([]);
    expect((await f.skills.read(f.partner.id, original.skill.summary!.id)).skill.body).toBe("Keep the disabled method unchanged.");
    expect(f.store.getPartnerLearningFeedback(reply.id)).toBeUndefined();
  });

  it("retires an in-flight review on service disposal without saving or replaying its durable claim", async () => {
    const f = await fixture(); let resolve!: (result: AuxiliaryTextRunResult) => void;
    f.infer.mockImplementation(async () => new Promise<AuxiliaryTextRunResult>(done => { resolve = done; }));
    const reply = f.reply("cancelled-review-reply"); f.finish(reply.id);
    await vi.waitFor(() => expect(f.infer).toHaveBeenCalledOnce());
    const signal = f.infer.mock.calls[0]![1].signal!; f.learning.dispose(); expect(signal.aborted).toBe(true);
    resolve({ status: "ok", text: plan([memoryProposal()], [skillProposal()]) }); await f.learning.drain();
    expect(f.memory.list(f.session.targetId)).toEqual([]); expect((await f.skills.list(f.partner.id)).skills).toEqual([]);
    expect(f.store.getPartnerLearningFeedback(reply.id)).toBeUndefined();
    const restarted = new PartnerLearningManager(f.options); restarted.settled(f.source.occurrenceId, reply.id, "completed");
    await restarted.drain(); restarted.dispose(); expect(f.infer).toHaveBeenCalledOnce();
  });
});

async function fixture(input: { readonly topic?: boolean; readonly channel?: boolean; readonly owner?: boolean; readonly text?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "joko-partner-learning-"));
  const store = new OperationalStore(join(directory, "operational.db")), profiles = new PartnerStore(join(directory, "partners.db"));
  const artifacts = new ArtifactStore({ rootDirectory: join(directory, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [directory] });
  await artifacts.initialize();
  const profile = { ...PI_LIKE_PROFILE, capabilities: [...PI_LIKE_PROFILE.capabilities.filter(item => item.key !== "runtime.resources")
    .map(item => item.key === "permission.modes" ? { ...item, options: ["ask", "auto"] } : item), { key: "runtime.resources", supported: true, options: ["skill"] }] };
  const host = new SessionHost(store, artifacts, [new FakeBackendAdapter(profile)]); await host.initialize();
  const partners = new PartnerManager({ store: profiles, operationalStore: store, sessionHost: host,
    workspaceService: { register: async input => input, unregister: () => undefined }, homesRoot: join(directory, "partner-homes") });
  const partner = await partners.createPartner({ requestId: "create-learning-partner", expectedDirectoryRevision: profiles.directoryState().revision,
    displayName: "Ada", avatar: "orbit", identitySource: "Private identity", templateId: "general", usesDirectoryDefaults: false,
    capabilities: { modelChain: [{ backendId: profile.id, providerId: "test", modelId: "text", effort: "medium", fastMode: false }], permissionMode: "ask", planMode: false } });
  let session = store.getSession(partner.canonicalSessionId!).descriptor;
  if (input.topic) {
    const event = store.appendEvent({ id: "topic-root", backendId: session.backendId, targetId: session.targetId, sessionId: session.id,
      generation: session.binding.generation, traceId: "topic-root", payload: { type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "Private topic root context" }] } });
    const root = store.findVisibleSessionMessageOrigin({ sessionId: session.id, eventId: event.id })!;
    const connection = store.createConnection({ id: "learning-topic-owner", name: "Owner", authKeyDigest: "learning-topic-key" });
    const topic = await partners.ensureTopic({ operationId: "learning-private-topic", connection, partnerId: partner.id, expectedRevision: partner.revision,
      root: { sessionId: session.id, generation: session.binding.generation, eventId: root.eventId, messageId: root.messageId }, assertCurrent: () => undefined });
    session = store.getSession(topic.link.sessionId).descriptor;
  }
  if (input.channel) session = await partners.ensureChannel({ partnerId: partner.id, key: 'owner-learning-channel', title: 'Owner channel', assertCurrent: () => undefined });
  const resources = new PiResourceManager({ store, managedRoot: join(directory, "resources") }); await resources.initialize();
  const refresh = vi.fn(() => true), memory = new MakerMemoryController({ store });
  const skills = new PartnerSkillsManager(partners, profiles, store, resources, new SkillMutationCoordinator(), refresh);
  const infer = vi.fn(async (_owner: AuxiliaryTextPlan, _input: AuxiliaryTextRunOptions): Promise<AuxiliaryTextRunResult> => ({ status: "exhausted" }));
  const auxiliary = { capture: (): AuxiliaryTextPlan => ({ models: [], revision: 1n, runtimeRevision: "original-route" }), run: infer };
  const options = { store, profiles, partners, memory, skills, auxiliary, assertMessagingSource: vi.fn() }, learning = new PartnerLearningManager(options);
  const prompt: PromptInput = { text: input.text ?? userText, images: [], files: [], mentions: [], disposition: "prompt", ...(input.channel ? { messagingOrigin: {
    connectionId: 'original-channel', channelGeneration: 1, credentialGeneration: 'a'.repeat(64), bindingRevision: 1, partnerId: partner.id,
    conversationId: 'original-conversation', requestId: 'original-request', channel: 'telegram', providerUserId: input.owner === false ? 'visitor' : 'owner',
    isOwner: input.owner !== false, userText } } : {}) };
  store.createRun({ id: "learning-run", sessionId: session.id, source: "user", state: "running", createdAt: 100 });
  store.createAttempt({ id: "learning-attempt", runId: "learning-run", ordinal: 1, generation: session.binding.generation, startedAt: 100 });
  store.runOperation({ id: "learning-input", kind: "prompt", body: prompt }, owner => { owner.enqueueQueueItem({ id: "learning-queue", sessionId: session.id,
    runId: "learning-run", attemptId: "learning-attempt", operationId: "learning-input", disposition: "prompt", body: prompt }); return {}; });
  store.claimNextQueueItem({ sessionId: session.id, backendInstanceGeneration: 0, traceId: "learning-dispatch" });
  store.updateRunState({ runId: "learning-run", state: "running", activeAttemptId: "learning-attempt", traceId: "learning-running" });
  const source: PartnerLearningTurnSource = { occurrenceId: "learning-occurrence", sessionId: session.id, targetId: session.targetId, backendId: session.backendId,
    bindingGeneration: session.binding.generation, backendInstanceGeneration: 0,
    bindingFingerprint: `sha256:${createHash("sha256").update(session.binding.opaqueRef).digest("hex")}`, sourceRunId: "learning-run",
    sourceAttemptId: "learning-attempt", sourceQueueItemId: "learning-queue", operationId: "learning-input", nativeOccurrence: "native-turn" };
  expect(learning.captureSource(source)).toBe(!(input.channel && input.owner === false));
  store.updateQueueState({ queueItemId: source.sourceQueueItemId, state: "backend_accepted", attemptId: source.sourceAttemptId, traceId: "learning-accepted" });
  learning.accepted(source.occurrenceId);
  const append = (id: string, payload: Parameters<OperationalStore["appendEvent"]>[0]["payload"]) => store.appendEvent({ id,
    backendId: session.backendId, targetId: session.targetId, sessionId: session.id, generation: session.binding.generation,
    runId: source.sourceRunId, attemptId: source.sourceAttemptId, traceId: "learning-evidence", payload });
  append("accepted-user", { type: "message_complete", role: "user", blocks: [{ kind: "text", text: prompt.text }], acceptedInput: prompt });
  append("tool-result", { type: "tool_result", callId: "verified-workflow", name: "Read", output: toolText, isError: false });
  const reply = (id: string, bodyless = false) => append(id, { type: "message_complete", role: "assistant",
    blocks: bodyless ? [] : [{ kind: "text", text: "The work is complete." }] });
  const finish = (completionEventId: string) => { store.updateQueueState({ queueItemId: source.sourceQueueItemId, state: "completed",
    attemptId: source.sourceAttemptId, traceId: "learning-queue-done" }); store.updateRunState({ runId: source.sourceRunId, state: "completed",
    activeAttemptId: source.sourceAttemptId, traceId: "learning-run-done" }); learning.sealed(source.occurrenceId, completionEventId);
    learning.settled(source.occurrenceId, completionEventId, "completed"); };
  cleanups.push(async () => { learning.dispose(); await learning.drain(); memory.dispose(); await host.dispose(); profiles.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, profiles, partners, partner, session, resources, memory, skills, refresh, infer, options, learning, source, append, reply, finish,
    caller: { sessionId: session.id, targetId: session.targetId, generation: session.binding.generation } };
}
