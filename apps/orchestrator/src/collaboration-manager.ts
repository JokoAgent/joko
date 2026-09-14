import { createHash, randomUUID } from "node:crypto";

import type { OperationalStore } from "@joko/store";

export type CollaborationScopeKind = "team" | "department";
export type CollaborationRole = "viewer" | "publisher" | "administrator";
export type SkillAccessVisibility = "public" | "department" | "private";

export interface CollaborationActor {
  readonly id: string;
  readonly displayName: string;
}

export interface CollaborationMembership {
  readonly actorId: string;
  readonly role: CollaborationRole;
}

export interface CollaborationScope {
  readonly id: string;
  readonly revision: bigint;
  readonly kind: CollaborationScopeKind;
  readonly name: string;
  readonly members: readonly CollaborationMembership[];
}

export interface CollaborationDirectory {
  readonly available: boolean;
  readonly revision: bigint;
  readonly actor?: CollaborationActor;
  readonly scopes: readonly CollaborationScope[];
  readonly recoveredFromCorruption: boolean;
  readonly unavailableReason?: string;
}

export type SkillAccessPublisher =
  | { readonly kind: "personal"; readonly actorId: string }
  | { readonly kind: "team"; readonly scopeId: string }
  | { readonly kind: "external"; readonly sourceId: string };

/** Path- and content-free policy attached to one exact market entry revision. */
export interface SkillAccessPolicy {
  readonly revision: bigint;
  readonly publisher: SkillAccessPublisher;
  readonly visibility: SkillAccessVisibility;
  readonly audienceScopeIds: readonly string[];
}

export interface SkillPublicationSelection {
  readonly publisher: "personal" | "team";
  readonly publisherScopeId?: string;
  readonly visibility: SkillAccessVisibility;
  readonly audienceScopeIds: readonly string[];
}

interface StoredCollaborationScope extends Omit<CollaborationScope, "revision"> {
  readonly revision: string;
}

interface StoredCollaborationDirectory {
  readonly format: 1;
  readonly revision: string;
  readonly actor: CollaborationActor;
  readonly scopes: readonly StoredCollaborationScope[];
}

export type CollaborationErrorCode =
  | "COLLABORATION_UNAVAILABLE"
  | "COLLABORATION_CHANGED"
  | "COLLABORATION_SCOPE_NOT_FOUND"
  | "COLLABORATION_SCOPE_IN_USE"
  | "COLLABORATION_PERMISSION_DENIED"
  | "COLLABORATION_INVALID";

export class CollaborationError extends Error {
  constructor(readonly code: CollaborationErrorCode, message: string) {
    super(message);
    this.name = "CollaborationError";
  }
}

export interface CollaborationManagerOptions {
  readonly store: OperationalStore;
  readonly scopeId?: string;
  readonly actorDisplayName?: string;
  readonly idFactory?: () => string;
  readonly maximumScopes?: number;
}

const SETTING_KEY = "collaboration.directory";
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const UNAVAILABLE_REASON = "Collaboration identity is unavailable. Repair the local collaboration directory before using restricted publishing.";

/** Durable local collaboration identity, membership, and Skill access-policy owner. */
export class CollaborationManager {
  readonly #store: OperationalStore;
  readonly #scopeId: string;
  readonly #actorDisplayName: string;
  readonly #idFactory: () => string;
  readonly #maximumScopes: number;
  #catalog?: StoredCollaborationDirectory;
  #initialized = false;
  #recoveredFromCorruption = false;

  constructor(options: CollaborationManagerOptions) {
    this.#store = options.store;
    this.#scopeId = entityId(options.scopeId ?? "orchestrator", "Collaboration setting scope");
    this.#actorDisplayName = displayName(options.actorDisplayName ?? "Local owner", "Collaboration actor name");
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#maximumScopes = options.maximumScopes ?? 256;
    if (!Number.isSafeInteger(this.#maximumScopes) || this.#maximumScopes < 1 || this.#maximumScopes > 1_000) {
      throw new Error("Collaboration scope limit is invalid.");
    }
  }

  initialize(): void {
    if (this.#initialized) return;
    const setting = this.#store.findSetting<unknown>("service", this.#scopeId, SETTING_KEY);
    if (setting === undefined) {
      const actorId = collaborationEntityId("actor", this.#idFactory());
      const catalog: StoredCollaborationDirectory = {
        format: 1,
        revision: "1",
        actor: { id: actorId, displayName: this.#actorDisplayName },
        scopes: []
      };
      this.#store.setSetting("service", this.#scopeId, SETTING_KEY, catalog);
      this.#catalog = catalog;
    } else {
      try {
        this.#catalog = validateStoredDirectory(setting.value, this.#maximumScopes);
      } catch {
        // A corrupt identity is never replaced with a fabricated principal.
        // Keep the bytes for explicit recovery and fail every restricted action.
        this.#catalog = undefined;
        this.#recoveredFromCorruption = true;
      }
    }
    this.#initialized = true;
  }

  snapshot(): CollaborationDirectory {
    this.#assertInitialized();
    if (this.#catalog === undefined) return {
      available: false,
      revision: 0n,
      scopes: [],
      recoveredFromCorruption: this.#recoveredFromCorruption,
      unavailableReason: UNAVAILABLE_REASON
    };
    return {
      available: true,
      revision: BigInt(this.#catalog.revision),
      actor: { ...this.#catalog.actor },
      scopes: this.#catalog.scopes.map(publicScope),
      recoveredFromCorruption: this.#recoveredFromCorruption
    };
  }

  assertRevision(expectedRevision: bigint): void {
    const catalog = this.#requireCatalog();
    this.#assertCatalogRevision(catalog, expectedRevision);
  }

  createScope(input: {
    readonly expectedCatalogRevision: bigint;
    readonly kind: CollaborationScopeKind;
    readonly name: string;
  }): CollaborationScope {
    const catalog = this.#requireCatalog();
    this.#assertCatalogRevision(catalog, input.expectedCatalogRevision);
    if (catalog.scopes.length >= this.#maximumScopes) throw collaborationError("COLLABORATION_INVALID", "The collaboration directory is full.");
    const scope: StoredCollaborationScope = {
      id: collaborationEntityId("scope", this.#idFactory()),
      revision: "1",
      kind: scopeKind(input.kind),
      name: displayName(input.name, "Collaboration scope name"),
      members: [{ actorId: catalog.actor.id, role: "administrator" }]
    };
    if (catalog.scopes.some((candidate) => candidate.kind === scope.kind && folded(candidate.name) === folded(scope.name))) {
      throw collaborationError("COLLABORATION_INVALID", "A collaboration scope with this name already exists.");
    }
    this.#replace({ ...catalog, revision: increment(catalog.revision), scopes: [...catalog.scopes, scope] });
    return publicScope(scope);
  }

  updateScope(input: {
    readonly scopeId: string;
    readonly expectedRevision: bigint;
    readonly name: string;
  }): CollaborationScope {
    const catalog = this.#requireCatalog();
    const id = entityId(input.scopeId, "Collaboration scope ID");
    const current = catalog.scopes.find((scope) => scope.id === id);
    if (current === undefined) throw collaborationError("COLLABORATION_SCOPE_NOT_FOUND", "The collaboration scope no longer exists.");
    if (BigInt(current.revision) !== positiveRevision(input.expectedRevision, "Collaboration scope revision")) {
      throw collaborationError("COLLABORATION_CHANGED", "The collaboration scope changed concurrently.");
    }
    this.#assertRole(current, catalog.actor.id, new Set(["administrator"]));
    const name = displayName(input.name, "Collaboration scope name");
    if (catalog.scopes.some((candidate) => candidate.id !== id && candidate.kind === current.kind && folded(candidate.name) === folded(name))) {
      throw collaborationError("COLLABORATION_INVALID", "A collaboration scope with this name already exists.");
    }
    const next = { ...current, revision: increment(current.revision), name };
    this.#replace({
      ...catalog,
      revision: increment(catalog.revision),
      scopes: catalog.scopes.map((scope) => scope.id === id ? next : scope)
    });
    return publicScope(next);
  }

  removeScope(input: { readonly scopeId: string; readonly expectedRevision: bigint }): void {
    const catalog = this.#requireCatalog();
    const id = entityId(input.scopeId, "Collaboration scope ID");
    const current = catalog.scopes.find((scope) => scope.id === id);
    if (current === undefined) throw collaborationError("COLLABORATION_SCOPE_NOT_FOUND", "The collaboration scope no longer exists.");
    if (BigInt(current.revision) !== positiveRevision(input.expectedRevision, "Collaboration scope revision")) {
      throw collaborationError("COLLABORATION_CHANGED", "The collaboration scope changed concurrently.");
    }
    this.#assertRole(current, catalog.actor.id, new Set(["administrator"]));
    this.#replace({
      ...catalog,
      revision: increment(catalog.revision),
      scopes: catalog.scopes.filter((scope) => scope.id !== id)
    });
  }

  publicationCapabilities(): {
    readonly personal: true;
    readonly teamScopes: readonly CollaborationScope[];
    readonly departmentScopes: readonly CollaborationScope[];
  } {
    const catalog = this.#requireCatalog();
    const actorId = catalog.actor.id;
    return {
      personal: true,
      teamScopes: catalog.scopes.filter((scope) => scope.kind === "team" && publishRole(memberRole(scope, actorId))).map(publicScope),
      departmentScopes: catalog.scopes.filter((scope) => scope.kind === "department" && memberRole(scope, actorId) !== undefined).map(publicScope)
    };
  }

  authorizePublication(selection: SkillPublicationSelection, existing?: SkillAccessPolicy): SkillAccessPolicy {
    const catalog = this.#requireCatalog();
    if (existing !== undefined) {
      this.assertCanManage(existing);
      if (existing.publisher.kind === "external") {
        throw collaborationError("COLLABORATION_PERMISSION_DENIED", "External market entries cannot be republished as locally owned entries.");
      }
    }
    const audienceScopeIds = uniqueIds(selection.audienceScopeIds, "Publication audience scope ID");
    let publisher: SkillAccessPublisher;
    if (selection.publisher === "personal") {
      if (selection.publisherScopeId !== undefined || audienceScopeIds.length !== 0 || selection.visibility === "department") {
        throw collaborationError("COLLABORATION_INVALID", "Personal publishing supports public or private visibility without a team audience.");
      }
      publisher = { kind: "personal", actorId: catalog.actor.id };
    } else {
      const scopeId = entityId(selection.publisherScopeId ?? "", "Publisher team scope ID");
      const scope = catalog.scopes.find((candidate) => candidate.id === scopeId && candidate.kind === "team");
      if (scope === undefined) throw collaborationError("COLLABORATION_SCOPE_NOT_FOUND", "The publisher team no longer exists.");
      this.#assertRole(scope, catalog.actor.id, new Set(["administrator", "publisher"]));
      if (selection.visibility === "private") {
        throw collaborationError("COLLABORATION_INVALID", "Team publishing supports public or department visibility, not personal private visibility.");
      }
      if (selection.visibility === "department") {
        if (audienceScopeIds.length === 0) throw collaborationError("COLLABORATION_INVALID", "Department visibility requires at least one exact department audience.");
        for (const audienceId of audienceScopeIds) {
          const audience = catalog.scopes.find((candidate) => candidate.id === audienceId && candidate.kind === "department");
          if (audience === undefined || memberRole(audience, catalog.actor.id) === undefined) {
            throw collaborationError("COLLABORATION_PERMISSION_DENIED", "A department audience is unavailable to the current collaboration identity.");
          }
        }
      } else if (audienceScopeIds.length !== 0) {
        throw collaborationError("COLLABORATION_INVALID", "Public team publishing cannot retain a restricted audience list.");
      }
      publisher = { kind: "team", scopeId };
    }
    if (existing !== undefined && !samePublisher(existing.publisher, publisher)) {
      throw collaborationError("COLLABORATION_PERMISSION_DENIED", "Publishing ownership cannot be transferred by creating a new version.");
    }
    const revision = existing === undefined
      ? 1n
      : sameAccessSelection(existing, publisher, selection.visibility, audienceScopeIds)
        ? existing.revision
        : existing.revision + 1n;
    return { revision, publisher, visibility: selection.visibility, audienceScopeIds };
  }

  canView(policy: SkillAccessPolicy): boolean {
    if (policy.visibility === "public") return true;
    const catalog = this.#catalog;
    if (!this.#initialized || catalog === undefined) return false;
    if (policy.publisher.kind === "personal") return policy.visibility === "private" && policy.publisher.actorId === catalog.actor.id;
    if (policy.publisher.kind !== "team" || policy.visibility !== "department") return false;
    if (this.#isMember(policy.publisher.scopeId, catalog.actor.id)) return true;
    return policy.audienceScopeIds.some((scopeId) => this.#isMember(scopeId, catalog.actor.id));
  }

  canManage(policy: SkillAccessPolicy): boolean {
    const catalog = this.#catalog;
    if (!this.#initialized || catalog === undefined) return false;
    if (policy.publisher.kind === "personal") return policy.publisher.actorId === catalog.actor.id;
    if (policy.publisher.kind !== "team") return false;
    const publisherScopeId = policy.publisher.scopeId;
    const scope = catalog.scopes.find((candidate) => candidate.id === publisherScopeId && candidate.kind === "team");
    return scope !== undefined && publishRole(memberRole(scope, catalog.actor.id));
  }

  assertCanManage(policy: SkillAccessPolicy): void {
    if (!this.canManage(policy)) {
      throw collaborationError("COLLABORATION_PERMISSION_DENIED", "The current collaboration identity cannot manage this Skill entry.");
    }
  }

  displayScope(scopeId: string): string | undefined {
    const catalog = this.#catalog;
    if (!this.#initialized || catalog === undefined) return undefined;
    return catalog.scopes.find((scope) => scope.id === scopeId)?.name;
  }

  #isMember(scopeId: string, actorId: string): boolean {
    return this.#catalog?.scopes.some((scope) => scope.id === scopeId && memberRole(scope, actorId) !== undefined) === true;
  }

  #assertRole(scope: StoredCollaborationScope, actorId: string, allowed: ReadonlySet<CollaborationRole>): void {
    const role = memberRole(scope, actorId);
    if (role === undefined || !allowed.has(role)) {
      throw collaborationError("COLLABORATION_PERMISSION_DENIED", "The current collaboration identity cannot manage this scope.");
    }
  }

  #assertCatalogRevision(catalog: StoredCollaborationDirectory, expected: bigint): void {
    if (BigInt(catalog.revision) !== nonNegativeRevision(expected, "Collaboration catalog revision")) {
      throw collaborationError("COLLABORATION_CHANGED", "The collaboration directory changed concurrently.");
    }
  }

  #replace(next: StoredCollaborationDirectory): void {
    const current = this.#catalog;
    if (current === undefined) throw collaborationError("COLLABORATION_UNAVAILABLE", UNAVAILABLE_REASON);
    const validated = validateStoredDirectory(next, this.#maximumScopes);
    this.#store.setSetting("service", this.#scopeId, SETTING_KEY, validated);
    this.#catalog = validated;
  }

  #requireCatalog(): StoredCollaborationDirectory {
    this.#assertInitialized();
    if (this.#catalog === undefined) throw collaborationError("COLLABORATION_UNAVAILABLE", UNAVAILABLE_REASON);
    return this.#catalog;
  }

  #assertInitialized(): void {
    if (!this.#initialized) throw new Error("Collaboration manager is not initialized.");
  }
}

export function externalPublicSkillAccess(sourceId: string): SkillAccessPolicy {
  return {
    revision: 1n,
    publisher: { kind: "external", sourceId: entityId(sourceId, "Skill market source ID") },
    visibility: "public",
    audienceScopeIds: []
  };
}

function validateStoredDirectory(value: unknown, maximumScopes: number): StoredCollaborationDirectory {
  const object = strictObject(value, ["format", "revision", "actor", "scopes"], "Collaboration directory");
  if (object.format !== 1 || !Array.isArray(object.scopes) || object.scopes.length > maximumScopes) {
    throw new Error("Collaboration directory is invalid.");
  }
  const actorObject = strictObject(object.actor, ["id", "displayName"], "Collaboration actor");
  const actor: CollaborationActor = {
    id: entityId(actorObject.id, "Collaboration actor ID"),
    displayName: displayName(actorObject.displayName, "Collaboration actor name")
  };
  const scopes = object.scopes.map((value) => validateStoredScope(value, actor.id));
  if (new Set(scopes.map((scope) => scope.id)).size !== scopes.length) throw new Error("Collaboration scope IDs must be unique.");
  if (new Set(scopes.map((scope) => `${scope.kind}\0${folded(scope.name)}`)).size !== scopes.length) {
    throw new Error("Collaboration scope names must be unique within their kind.");
  }
  return {
    format: 1,
    revision: storedRevision(object.revision, "Collaboration catalog revision", true),
    actor,
    scopes
  };
}

function validateStoredScope(value: unknown, localActorId: string): StoredCollaborationScope {
  const object = strictObject(value, ["id", "revision", "kind", "name", "members"], "Collaboration scope");
  if (!Array.isArray(object.members) || object.members.length < 1 || object.members.length > 10_000) {
    throw new Error("Collaboration memberships are invalid.");
  }
  const members = object.members.map((value) => {
    const member = strictObject(value, ["actorId", "role"], "Collaboration membership");
    return {
      actorId: entityId(member.actorId, "Collaboration member actor ID"),
      role: role(member.role)
    } satisfies CollaborationMembership;
  });
  if (new Set(members.map((member) => member.actorId)).size !== members.length || !members.some((member) => member.actorId === localActorId)) {
    throw new Error("Collaboration memberships must uniquely include the local actor.");
  }
  return {
    id: entityId(object.id, "Collaboration scope ID"),
    revision: storedRevision(object.revision, "Collaboration scope revision", false),
    kind: scopeKind(object.kind),
    name: displayName(object.name, "Collaboration scope name"),
    members
  };
}

function publicScope(value: StoredCollaborationScope): CollaborationScope {
  return { ...value, revision: BigInt(value.revision), members: value.members.map((member) => ({ ...member })) };
}

function memberRole(scope: StoredCollaborationScope, actorId: string): CollaborationRole | undefined {
  return scope.members.find((member) => member.actorId === actorId)?.role;
}

function publishRole(value: CollaborationRole | undefined): boolean {
  return value === "administrator" || value === "publisher";
}

function samePublisher(left: SkillAccessPublisher, right: SkillAccessPublisher): boolean {
  return left.kind === right.kind && (left.kind === "personal" && right.kind === "personal"
    ? left.actorId === right.actorId
    : left.kind === "team" && right.kind === "team"
      ? left.scopeId === right.scopeId
      : left.kind === "external" && right.kind === "external" && left.sourceId === right.sourceId);
}

function sameAccessSelection(
  existing: SkillAccessPolicy,
  publisher: SkillAccessPublisher,
  visibility: SkillAccessVisibility,
  audienceScopeIds: readonly string[]
): boolean {
  return samePublisher(existing.publisher, publisher)
    && existing.visibility === visibility
    && existing.audienceScopeIds.length === audienceScopeIds.length
    && existing.audienceScopeIds.every((value, index) => value === audienceScopeIds[index]);
}

function uniqueIds(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values) || values.length > 256) throw collaborationError("COLLABORATION_INVALID", `${label} list is invalid.`);
  const result = values.map((value) => entityId(value, label)).sort((left, right) => left.localeCompare(right, "en"));
  if (new Set(result).size !== result.length) throw collaborationError("COLLABORATION_INVALID", `${label} list contains duplicates.`);
  return result;
}

function collaborationEntityId(kind: "actor" | "scope", seed: string): string {
  if (typeof seed !== "string" || seed.trim() === "" || seed.length > 1_024) throw new Error("Collaboration identity seed is invalid.");
  return `collaboration_${kind}_${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
}

function entityId(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.trim() || !ENTITY_ID.test(value)) {
    throw collaborationError("COLLABORATION_INVALID", `${label} is invalid.`);
  }
  return value;
}

function displayName(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.trim() || value.length < 1 || value.length > 128 || FORBIDDEN_TEXT.test(value)) {
    throw collaborationError("COLLABORATION_INVALID", `${label} is invalid.`);
  }
  return value;
}

function scopeKind(value: unknown): CollaborationScopeKind {
  if (value !== "team" && value !== "department") throw collaborationError("COLLABORATION_INVALID", "Collaboration scope kind is invalid.");
  return value;
}

function role(value: unknown): CollaborationRole {
  if (value !== "viewer" && value !== "publisher" && value !== "administrator") throw new Error("Collaboration role is invalid.");
  return value;
}

function positiveRevision(value: bigint, label: string): bigint {
  if (value < 1n) throw collaborationError("COLLABORATION_INVALID", `${label} is invalid.`);
  return value;
}

function nonNegativeRevision(value: bigint, label: string): bigint {
  if (value < 0n) throw collaborationError("COLLABORATION_INVALID", `${label} is invalid.`);
  return value;
}

function storedRevision(value: unknown, label: string, allowZero: boolean): string {
  if (typeof value !== "string" || !DECIMAL.test(value) || !allowZero && value === "0") throw new Error(`${label} is invalid.`);
  return value;
}

function increment(value: string): string {
  if (!DECIMAL.test(value)) throw new Error("Collaboration revision is invalid.");
  return (BigInt(value) + 1n).toString(10);
}

function folded(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function strictObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(object, key))) {
    throw new Error(`${label} shape is invalid.`);
  }
  return object;
}

function collaborationError(code: CollaborationErrorCode, message: string): CollaborationError {
  return new CollaborationError(code, message);
}
