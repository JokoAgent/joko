import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { redactSecrets, type SessionDescriptor } from "@joko/core";
import type { OperationalStore, PartnerStore } from "@joko/store";
import type { PartnerManager } from "./partner-manager.js";
import { fromProtoRevision, toProtoRevision } from "./proto-mapper.js";
import { type PiResourceDescriptor, type PiResourceManager, type PreparedPiResourceMutation } from "./resource-manager.js";
import { readSkillFile, renderSkillFile, type SkillFileMetadata } from "./skill-file.js";
import { SkillMutationCoordinator, skillInstallSlotMutationKey, skillResourceMutationKey } from "./skill-mutation-coordinator.js";
import type { BridgeToolCallContext, BridgeToolProvider, McpToolDescriptor, PartnerLearningSaveCapture } from "./mcp-router.js";

export interface PartnerLearningSkillRecord {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly revision: bigint;
  readonly contentRevision: string;
}
export interface PartnerLearningSkillBody extends PartnerLearningSkillRecord { readonly body: string; }
export interface PartnerLearningSkillSnapshot {
  readonly catalog: readonly PartnerLearningSkillRecord[];
  readonly bodies: readonly PartnerLearningSkillBody[];
}

type PersonalSkill = ReturnType<PiResourceManager["listPartnerSkills"]>[number];
const fail = (message: string, code = Code.FailedPrecondition): never => { throw new ConnectError(message, code); };
const preview = (text: string, length: number) => text.slice(0, length).replace(/[\uD800-\uDBFF]$/u, "");
function field(value: unknown, maximum: number, required = true): string {
  if (typeof value !== "string" || value.length > maximum || required && !value.trim()
    || /[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || redactSecrets(value) !== value) {
    return fail("Skill content is invalid or contains credentials.", Code.InvalidArgument);
  }
  return value.trim();
}
function slugOf(name: string, supplied?: unknown): string {
  const source = supplied === undefined ? name : field(supplied, 64);
  const slug = source.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 64);
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) return fail("Provide an ASCII skill slug.", Code.InvalidArgument);
  return slug;
}
const summary = (item: PersonalSkill, file: SkillFileMetadata): contract.PartnerSkillSummary => create(contract.PartnerSkillSummarySchema, {
  id: item.resource.id, slug: item.slug, name: preview(file.name, 64), description: preview(file.description, 280),
  updatedAt: preview(file.updatedAt, 64), enabled: item.resource.enabled,
  revision: toProtoRevision(item.resource.versionNumber), contentRevision: item.resource.discoveredRevision
});
function detail(item: PersonalSkill, file: SkillFileMetadata, ownerReadOnly: boolean): contract.PartnerSkill {
  const raw = { id: item.resource.id, slug: item.slug, name: file.name, description: file.description, updatedAt: file.updatedAt,
    revision: item.resource.versionNumber.toString(), contentRevision: item.resource.discoveredRevision, body: file.body, bodyBytes: Buffer.byteLength(file.body) };
  const large = Buffer.byteLength(JSON.stringify(raw)) + 1_024 > 55_000 || file.name.length > 64 || file.description.length > 280;
  return create(contract.PartnerSkillSchema, { summary: summary(item, file),
    body: large ? `${preview(file.body, 12_000)}${file.body.length > 12_000 ? "\n…" : ""}` : file.body,
    readOnly: ownerReadOnly || large, bodyBytes: BigInt(Buffer.byteLength(file.body)) });
}

/** Private files have one Resource owner; clients only receive opaque IDs and bounded text. */
export class PartnerSkillsManager {
  constructor(readonly partners: PartnerManager, readonly profiles: PartnerStore, readonly store: OperationalStore,
    readonly resources: PiResourceManager, readonly mutations: SkillMutationCoordinator,
    readonly requestRefresh?: (sessionId: string) => boolean,
    readonly groupHomeTarget: (sessionId: string, targetId: string) => string | undefined = () => undefined) {}
  owner(partnerId: string, expected?: bigint, writable = false): contract.PartnerSkillsOwner {
    const profile = this.partners.getPartner(partnerId);
    if (profile.lifecycle === "deleted" || profile.initializationState !== "ready" || !profile.canonicalSessionId) return fail("Partner skills are unavailable.");
    if (expected !== undefined && profile.revision !== expected) return fail("Partner changed. Refresh before saving.", Code.Aborted);
    const session = this.store.getSession(profile.canonicalSessionId).descriptor;
    const target = this.store.getTarget(profile.homeTargetId).descriptor;
    const link = this.profiles.getSessionLink(session.id);
    if (session.deletedAt !== undefined || session.targetId !== target.id
      || !target.trusted || link?.partnerId !== partnerId || link.role !== "canonical"
      || session.remoteWorkspace?.kind === "ssh" || target.remoteWorkspace?.kind === "ssh") return fail("The local skill owner is unavailable.");
    const readOnly = profile.lifecycle === "archived" || profile.pauseCleanupPending === true
      || this.partners.listPendingRestarts().some(item => item.partnerId === partnerId);
    if (writable && readOnly) return fail("Partner skills are read-only.");
    return create(contract.PartnerSkillsOwnerSchema, { partnerId, homeTargetId: target.id, canonicalSessionId: session.id,
      revision: toProtoRevision(profile.revision), readOnly });
  }
  #capture(partnerId: string, expected?: bigint, writable = false, signal?: AbortSignal, assertCaller?: () => void) {
    const owner = this.owner(partnerId, expected, writable), revision = fromProtoRevision(owner.revision, "revision");
    const target = this.store.getTarget(owner.homeTargetId), session = this.store.getSession(owner.canonicalSessionId).descriptor,
      backend = this.store.getBackend(session.backendId).descriptor;
    const assertCurrent = () => {
      signal?.throwIfAborted(); assertCaller?.();
      const current = this.owner(partnerId, revision, writable);
      if (current.homeTargetId !== owner.homeTargetId || current.canonicalSessionId !== owner.canonicalSessionId
        || this.store.getTarget(owner.homeTargetId).revision !== target.revision
        || this.store.getSession(owner.canonicalSessionId).descriptor.backendId !== session.backendId
        || this.store.getSession(owner.canonicalSessionId).descriptor.binding.generation !== session.binding.generation
        || this.store.getBackend(backend.id).descriptor.instanceGeneration !== backend.instanceGeneration) return fail("Skill owner changed.", Code.Aborted);
    };
    assertCurrent(); return { owner, assertCurrent };
  }
  #item(owner: contract.PartnerSkillsOwner, id: string): PersonalSkill {
    return this.resources.listPartnerSkills(owner.partnerId, owner.homeTargetId).find(item => item.resource.id === id)
      ?? fail("Skill not found.", Code.NotFound);
  }
  async #file(item: PersonalSkill, signal?: AbortSignal): Promise<SkillFileMetadata> {
    const lease = await this.resources.acquireSkillContent({ resourceId: item.resource.id, expectedResourceVersion: item.resource.versionNumber });
    try {
      const source = await readFile(lease.entryFilePath, { encoding: "utf8", ...(signal ? { signal } : {}) });
      await lease.assertCurrent(signal);
      if (lease.dirty) return fail("Skill files changed. Review them before editing.", Code.Aborted);
      const file = readSkillFile(source, item.slug);
      // Imported current files are already projected by their credential owner.
      if (redactSecrets(source) !== source) return fail("Skill content is unavailable.");
      return file;
    } finally { await lease.release(); }
  }
  async list(partnerId: string, query = "", offset = 0, limit = 20, signal?: AbortSignal, assertCaller?: () => void) {
    const scope = this.#capture(partnerId, undefined, false, signal, assertCaller);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) return fail("Skill page is invalid.", Code.InvalidArgument);
    const terms = field(query, 1_024, false).toLocaleLowerCase("en-US").split(/\s+/u).filter(Boolean);
    const hits: { item: PersonalSkill; file: SkillFileMetadata }[] = [];
    for (const item of this.resources.listPartnerSkills(partnerId, scope.owner.homeTargetId)) {
      const file = await this.#file(item, signal); scope.assertCurrent();
      const text = `${file.name}\n${file.description}`.toLocaleLowerCase("en-US");
      if (terms.every(term => text.includes(term))) hits.push({ item, file: { ...file, body: "", name: preview(file.name, 64), description: preview(file.description, 280) } });
    }
    hits.sort((a, b) => a.file.name.localeCompare(b.file.name, "en") || a.item.slug.localeCompare(b.item.slug, "en"));
    scope.assertCurrent();
    const page: typeof hits = []; let bytes = 512;
    for (const hit of hits.slice(offset, offset + limit)) {
      const size = Buffer.byteLength(JSON.stringify({ id: hit.item.resource.id, slug: hit.item.slug, name: hit.file.name,
        description: hit.file.description, updatedAt: preview(hit.file.updatedAt, 64), enabled: hit.item.resource.enabled,
        revision: hit.item.resource.versionNumber.toString(), contentRevision: hit.item.resource.discoveredRevision,
        ...(hit.item.resource.enabled ? { filePath: hit.item.relativeFilePath, bodyStartLine: hit.file.bodyStartLine } : {}) }));
      if (page.length && bytes + size > 16 * 1024) break;
      page.push(hit); bytes += size;
    }
    return { owner: scope.owner, skills: page.map(hit => summary(hit.item, hit.file)), total: hits.length,
      ...(offset + page.length < hits.length ? { nextOffset: offset + page.length } : {}),
      nativeFiles: page.map(hit => hit.item.resource.enabled ? { filePath: hit.item.relativeFilePath, bodyStartLine: hit.file.bodyStartLine } : {}) };
  }
  async referenceMetadata(partnerId: string, signal: AbortSignal, runtimeBackendId?: string) {
    const scope = this.#capture(partnerId, undefined, false, signal), target = this.store.getTarget(scope.owner.homeTargetId).descriptor;
    const entries: { id: string; name: string; nativeName: string; description: string }[] = [];
    const backendId = runtimeBackendId ?? this.store.getSession(scope.owner.canonicalSessionId).descriptor.backendId;
    const personal = new Set(this.resources.listPartnerSkills(partnerId, target.id).map(item => item.resource.id));
    for (const resource of this.resources.list({ kind: "skill" }).filter(item => item.backendId === backendId || personal.has(item.id))) {
      if (resource.targetId !== undefined && resource.targetId !== target.id || !resource.enabled
        || !["approved", "installed", "loaded"].includes(resource.state)) continue;
      const file = await this.#file({ resource, slug: resource.name, relativeFilePath: "" }, signal);
      scope.assertCurrent(); entries.push({ id: resource.id, name: file.name, nativeName: file.slug, description: file.description });
    }
    scope.assertCurrent(); return entries;
  }
  async read(partnerId: string, id: string, signal?: AbortSignal) {
    const scope = this.#capture(partnerId, undefined, false, signal), item = this.#item(scope.owner, id);
    const file = await this.#file(item, signal); scope.assertCurrent();
    return { owner: scope.owner, skill: detail(item, file, scope.owner.readOnly) };
  }
  async readLearningSnapshot(partnerId: string, signal: AbortSignal, assertCaller: () => void): Promise<PartnerLearningSkillSnapshot | undefined> {
    const scope = this.#capture(partnerId, undefined, false, signal, assertCaller);
    const catalog: PartnerLearningSkillRecord[] = [], bodies: PartnerLearningSkillBody[] = [];
    let indexChars = 2, bodyChars = 24_000, enabledCount = 0;
    for (const item of this.resources.listPartnerSkills(partnerId, scope.owner.homeTargetId)) {
      const file = await this.#file(item, signal); scope.assertCurrent();
      const index = { slug: item.slug, title: file.name, description: file.description, enabled: item.resource.enabled };
      indexChars += JSON.stringify(index).length + 1;
      if (indexChars > 24_000) return undefined;
      const record: PartnerLearningSkillRecord = { ...index, id: item.resource.id, revision: item.resource.versionNumber,
        contentRevision: item.resource.discoveredRevision };
      catalog.push(record);
      if (!record.enabled || ++enabledCount > 40 || file.body.length > 12_000) continue;
      const size = JSON.stringify({ ...index, body: file.body }).length;
      if (size > bodyChars) continue;
      bodies.push({ ...record, body: file.body }); bodyChars -= size;
    }
    scope.assertCurrent(); return { catalog, bodies };
  }
  async saveLearningProposal(partnerId: string, input: { readonly slug: string; readonly title: string;
    readonly description: string; readonly body: string; readonly expectedPartnerRevision: bigint;
    readonly prior?: PartnerLearningSkillRecord }, signal: AbortSignal, assertCaller: () => void, learningSave: PartnerLearningSaveCapture) {
    if (slugOf(input.title, input.slug) !== input.slug) return fail("Skill identity is invalid.", Code.InvalidArgument);
    return this.#write(partnerId, { slug: input.slug, name: input.title, description: input.description, body: input.body,
      expectedPartnerRevision: input.expectedPartnerRevision, expectAbsent: input.prior === undefined, requireEnabled: true,
      deferRefresh: true,
      ...(input.prior === undefined ? {} : { id: input.prior.id, expectedRevision: input.prior.revision,
        expectedContentRevision: input.prior.contentRevision }) }, signal, assertCaller, learningSave);
  }
  async #write(partnerId: string, input: { readonly id?: string; readonly slug: string; readonly name: string; readonly description: string;
    readonly body: string; readonly expectedPartnerRevision?: bigint; readonly expectedRevision?: bigint; readonly expectedContentRevision?: string;
    readonly expectAbsent?: boolean; readonly requireEnabled?: boolean; readonly deferRefresh?: boolean },
    signal?: AbortSignal, assertCaller?: () => void, learningSave?: PartnerLearningSaveCapture) {
    const scope = this.#capture(partnerId, input.expectedPartnerRevision, true, signal, assertCaller);
    const name = field(input.name, 64), description = field(input.description, 280), body = field(input.body, 65_536);
    if (Buffer.byteLength(body) > 65_536) return fail("Skill body exceeds 64 KiB.", Code.InvalidArgument);
    const item = input.id ? this.#item(scope.owner, input.id)
      : this.resources.listPartnerSkills(partnerId, scope.owner.homeTargetId).find(entry => entry.slug === input.slug);
    if (item && input.expectAbsent || item && input.requireEnabled && !item.resource.enabled) return fail("Skill changed. Refresh before saving.", Code.Aborted);
    if (item && (input.expectedRevision !== undefined && item.resource.versionNumber !== input.expectedRevision
      || input.expectedContentRevision !== undefined && item.resource.discoveredRevision !== input.expectedContentRevision)) return fail("Skill changed. Refresh before saving.", Code.Aborted);
    const backendId = this.store.getTarget(scope.owner.homeTargetId).descriptor.backendId;
    const slot = skillInstallSlotMutationKey({ backendId, targetId: scope.owner.homeTargetId, scope: "project", parentKey: ".agents/skills", name: item?.slug ?? input.slug });
    const mutationLease = this.mutations.acquire([slot, ...(item ? [skillResourceMutationKey(item.resource.id)] : [])]);
    if (!mutationLease) return fail("Skill is being changed. Refresh before saving.", Code.Aborted);
    const draft = await mkdtemp(join(tmpdir(), "joko-personal-skill-"));
    let prepared: PreparedPiResourceMutation<unknown> | undefined;
    try {
      let entryName = item?.slug ?? input.slug;
      if (item) {
        const lease = await this.resources.acquireSkillContent({ resourceId: item.resource.id, expectedResourceVersion: item.resource.versionNumber });
        try {
          if (lease.dirty) return fail("Skill files changed. Refresh before saving.", Code.Aborted);
          await lease.snapshotTo(draft, signal); entryName = basename(dirname(lease.entryFilePath));
        } finally { await lease.release(); }
      }
      const updatedAt = new Date().toISOString();
      await writeFile(join(draft, "SKILL.md"), renderSkillFile({ slug: entryName, name, description, updatedAt, body }), { mode: 0o600 });
      scope.assertCurrent(); mutationLease.assertActive();
      const changedByConnectionId = "partner-skill-owner";
      prepared = item ? await this.resources.prepareReplaceSkillContent({ resourceId: item.resource.id,
        expectedResourceVersion: item.resource.versionNumber, expectedObservedRevision: item.resource.discoveredRevision,
        candidateRoot: draft, changedByConnectionId, name: entryName })
        : await this.resources.preparePartnerSkill({ partnerId, backendId, targetId: scope.owner.homeTargetId,
          slug: input.slug, candidateRoot: draft, changedByConnectionId });
      scope.assertCurrent(); mutationLease.assertActive();
      await this.resources.completePreparedMutation(prepared, finalize => this.store.transaction(store => {
        scope.assertCurrent(); finalize(store);
        const saved = this.resources.listPartnerSkills(partnerId, scope.owner.homeTargetId).find(entry => entry.slug === entryName)!;
        learningSave?.recordSaved(store, { kind: "skill", entryId: saved.resource.id, title: name,
          action: item === undefined ? "created" : "updated" });
      }));
      prepared = undefined; scope.assertCurrent();
      const saved = this.resources.listPartnerSkills(partnerId, scope.owner.homeTargetId).find(entry => entry.slug === entryName)!;
      return { owner: scope.owner, skill: detail(saved, readSkillFile(renderSkillFile({ slug: entryName, name, description, updatedAt, body }), entryName), scope.owner.readOnly),
        created: item === undefined, effective: !input.deferRefresh && this.requestRefresh?.(scope.owner.canonicalSessionId) ? "next-turn" as const : "next-session" as const };
    } finally {
      try { if (prepared) await this.resources.discardPreparedMutation(prepared); }
      finally { await rm(draft, { recursive: true, force: true }); mutationLease.release(); }
    }
  }
  async update(request: contract.UpdatePartnerSkillRequest, signal?: AbortSignal) {
    const existing = await this.read(request.partnerId, request.skillId, signal);
    if (existing.skill.readOnly) return fail("This skill is read-only.");
    return this.#write(request.partnerId, { id: request.skillId, slug: existing.skill.summary!.slug, name: request.name,
      description: request.description, body: request.body, expectedPartnerRevision: fromProtoRevision(request.expectedPartnerRevision, "expected_partner_revision"),
      expectedRevision: fromProtoRevision(request.expectedRevision, "expected_revision"), expectedContentRevision: request.expectedContentRevision }, signal);
  }
  async remove(request: contract.DeletePartnerSkillRequest, signal?: AbortSignal) {
    const scope = this.#capture(request.partnerId, fromProtoRevision(request.expectedPartnerRevision, "expected_partner_revision"), true, signal);
    const item = this.#item(scope.owner, request.skillId);
    if (item.resource.versionNumber !== fromProtoRevision(request.expectedRevision, "expected_revision")
      || item.resource.discoveredRevision !== request.expectedContentRevision) return fail("Skill changed. Refresh before deleting.", Code.Aborted);
    const file = await this.#file(item, signal); scope.assertCurrent();
    if (detail(item, file, scope.owner.readOnly).readOnly) return fail("This skill is read-only.");
    const mutationLease = this.mutations.acquire([skillResourceMutationKey(item.resource.id)]);
    if (!mutationLease) return fail("Skill is being changed.", Code.Aborted);
    const recovery = await mkdtemp(join(tmpdir(), "joko-skill-recovery-"));
    let prepared: PreparedPiResourceMutation<PiResourceDescriptor> | undefined;
    try {
      prepared = await this.resources.prepareRemoveSkillContent({ resourceId: item.resource.id, expectedResourceVersion: item.resource.versionNumber,
        expectedObservedRevision: item.resource.discoveredRevision, recoveryDestination: recovery });
      scope.assertCurrent(); mutationLease.assertActive();
      await this.resources.completePreparedMutation(prepared, finalize => this.store.transaction(store => { scope.assertCurrent(); finalize(store); }));
      prepared = undefined; scope.assertCurrent(); this.requestRefresh?.(scope.owner.canonicalSessionId);
      return { owner: scope.owner, skillId: item.resource.id };
    } finally {
      try { if (prepared) await this.resources.discardPreparedMutation(prepared); }
      finally { await rm(recovery, { recursive: true, force: true }); mutationLease.release(); }
    }
  }
  caller(context: BridgeToolCallContext, signal?: AbortSignal) {
    const session = this.store.getSession(context.sessionId).descriptor, link = this.profiles.getSessionLink(session.id);
    if (!link || link.role !== "canonical" && link.role !== "delegation" && link.role !== "group") return fail("The task does not own personal skills.");
    const profile = this.profiles.getPartner(link.partnerId), backend = this.store.getBackend(session.backendId).descriptor;
    const assertCurrent = () => {
      signal?.throwIfAborted();
      const current = this.store.getSession(session.id).descriptor, live = this.profiles.getSessionLink(session.id), partner = this.partners.getPartner(profile.id);
      if (current.archived || current.deletedAt !== undefined || current.remoteWorkspace?.kind === "ssh" || current.targetId !== context.targetId
        || current.binding.generation !== context.generation || current.backendId !== session.backendId
        || partner.homeTargetId !== context.targetId && this.groupHomeTarget(context.sessionId, context.targetId) !== partner.homeTargetId
        || partner.lifecycle !== "active" || partner.initializationState !== "ready"
        || partner.revision !== profile.revision || !live || live.partnerId !== profile.id || live.role !== link.role
        || context.providerGeneration !== undefined && context.providerGeneration !== 1
        || this.store.getBackend(session.backendId).descriptor.instanceGeneration !== backend.instanceGeneration) return fail("The personal skill caller changed.");
      this.owner(profile.id, profile.revision, true);
    };
    assertCurrent(); return { partnerId: profile.id, assertCurrent };
  }
  async saveForCaller(context: BridgeToolCallContext, input: Readonly<Record<string, unknown>>, signal?: AbortSignal) {
    const learningSave = context.partnerLearningSave;
    const caller = this.caller(context, signal), name = field(input["name"], 64);
    return this.#write(caller.partnerId, { slug: slugOf(name, input["slug"]), name,
      description: field(input["description"], 280), body: field(input["body"], 65_536) }, signal, caller.assertCurrent, learningSave);
  }
  runtimeIdentity(session: SessionDescriptor): string | undefined {
    const link = this.profiles.getSessionLink(session.id); if (!link) return undefined;
    const profile = this.profiles.getPartner(link.partnerId);
    if (profile.homeTargetId !== session.targetId && this.groupHomeTarget(session.id, session.targetId) !== profile.homeTargetId || profile.lifecycle === "deleted") return undefined;
    return createHash("sha256").update(JSON.stringify(this.resources.listPartnerSkills(profile.id, profile.homeTargetId)
      .map(({ resource, slug }) => [resource.id, slug, resource.enabled, resource.discoveredRevision]).sort((a, b) => String(a[0]).localeCompare(String(b[0]), "en")))).digest("hex");
  }
}

const providerId = "joko_partner_skills";
const text = { type: "string" };
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[], write: boolean): McpToolDescriptor => ({
  serverId: providerId, name, description, inputSchema: { type: "object", properties, required, additionalProperties: false }, requiresPermission: write
});
export class PartnerSkillsToolProvider implements BridgeToolProvider {
  readonly id = providerId; readonly generation = 1; readonly available = true;
  readonly tools = [tool("save_partner_skill", "Save or update one personal skill for this Partner. Use an ASCII slug for a non-ASCII name. Never include credentials.",
    { name: { ...text, minLength: 1, maxLength: 64 }, description: { ...text, minLength: 1, maxLength: 280 }, body: { ...text, minLength: 1 }, slug: { ...text, minLength: 1, maxLength: 64 } }, ["name", "description", "body"], true),
    tool("list_partner_skills", "Search this Partner's full personal skill metadata. Follow nextOffset; enabled filePath values are relative to this workspace.",
      { query: { ...text, maxLength: 1_024 }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, [], false)];
  constructor(readonly manager: PartnerSkillsManager) {}
  includeForTarget(targetId: string): boolean { return this.manager.profiles.listPartners().some(profile => profile.homeTargetId === targetId && profile.lifecycle !== "deleted"); }
  async callTool(name: string, input: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined, context: BridgeToolCallContext) {
    try {
      const caller = this.manager.caller(context, signal);
      let value: Readonly<Record<string, unknown>>;
      if (name === "save_partner_skill") {
        const result = await this.manager.saveForCaller(context, input, signal), saved = result.skill.summary!;
        value = { skill: { slug: saved.slug, name: saved.name, description: saved.description, updatedAt: saved.updatedAt }, created: result.created, effective: result.effective };
      } else if (name === "list_partner_skills") {
        const result = await this.manager.list(caller.partnerId, input["query"] === undefined ? "" : field(input["query"], 1_024, false),
          input["offset"] === undefined ? 0 : input["offset"] as number, input["limit"] === undefined ? 20 : input["limit"] as number, signal, caller.assertCurrent);
        value = { skills: result.skills.map((item, index) => ({ slug: item.slug, name: item.name, description: item.description,
          updatedAt: item.updatedAt, ...(item.enabled ? result.nativeFiles[index] : { enabled: false }) })), total: result.total,
          ...(result.nextOffset === undefined ? {} : { nextOffset: result.nextOffset }) };
      } else return fail("Skill tool is unavailable.", Code.NotFound);
      caller.assertCurrent(); return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value, isError: false };
    } catch (error) {
      signal?.throwIfAborted();
      return { content: [{ type: "text" as const, text: error instanceof ConnectError ? error.rawMessage : "Personal skill operation failed. Refresh before retrying." }], isError: true };
    }
  }
}
type SkillMethods = Pick<ServiceImpl<typeof contract.PartnerService>, "listPartnerSkills" | "readPartnerSkill" | "updatePartnerSkill" | "deletePartnerSkill">;
export function createPartnerSkillMethods(manager: PartnerSkillsManager | undefined, authenticate: (context: HandlerContext) => unknown): SkillMethods {
  const run = async <T>(context: HandlerContext, operation: (manager: PartnerSkillsManager) => Promise<T>): Promise<T> => {
    authenticate(context); context.signal.throwIfAborted(); if (!manager) throw new ConnectError("Partner skills are unavailable.", Code.Unimplemented);
    try { return await operation(manager); } catch (error) {
      if (error instanceof ConnectError) throw error;
      throw new ConnectError("Skill files could not be read or changed. Refresh before retrying.", Code.Unavailable);
    }
  };
  return {
    listPartnerSkills: (request, context) => run(context, async owner => {
      const { nativeFiles: _, ...value } = await owner.list(request.partnerId, request.query, request.offset, request.limit || 20, context.signal);
      return create(contract.ListPartnerSkillsResponseSchema, value);
    }),
    readPartnerSkill: (request, context) => run(context, async owner => create(contract.ReadPartnerSkillResponseSchema, await owner.read(request.partnerId, request.skillId, context.signal))),
    updatePartnerSkill: (request, context) => run(context, async owner => create(contract.UpdatePartnerSkillResponseSchema, await owner.update(request, context.signal))),
    deletePartnerSkill: (request, context) => run(context, async owner => create(contract.DeletePartnerSkillResponseSchema, await owner.remove(request, context.signal)))
  };
}
