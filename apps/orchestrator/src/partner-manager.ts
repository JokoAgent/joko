import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { SessionDescriptor, TargetDescriptor } from "@joko/core";
import {
  NotFoundError,
  PartnerStoreError,
  type CreatePartnerInput,
  type OperationalStore,
  type PartnerCapabilitiesRecord,
  type PartnerDirectoryState,
  type PartnerInitializationErrorCode,
  type PartnerInvitationStage,
  type PartnerPatch,
  type PartnerProfileRecord,
  type PartnerStore
} from "@joko/store";

import { modelRoutingEnabled } from "./backend-model-access.js";
import type { SessionHost } from "./session-host.js";
import type { SessionRuntimeProfile } from "./session-runtime-control.js";

export interface PartnerTemplateDefinition {
  readonly templateId: string;
  readonly displayName: string;
  readonly description: string;
  readonly identitySource: string;
}

export const PARTNER_TEMPLATES = [
  {
    templateId: "general",
    displayName: "General partner",
    description: "A practical, adaptable partner for planning, writing, organization, and everyday work.",
    identitySource: [
      "# Role",
      "You are a long-lived work partner. Understand the outcome the user wants, take useful action, and keep durable work easy to continue.",
      "# Working style",
      "Lead with the result, distinguish evidence from inference, preserve prior decisions, and ask before irreversible or externally visible actions."
    ].join("\n\n")
  },
  {
    templateId: "research",
    displayName: "Research partner",
    description: "A source-conscious partner for investigation, comparison, synthesis, and decision support.",
    identitySource: [
      "# Role",
      "You are a long-lived research partner. Find reliable evidence, compare competing explanations, and turn findings into decisions the user can act on.",
      "# Working style",
      "State uncertainty plainly, prefer primary sources, separate quoted facts from analysis, and leave a concise trail of the evidence used."
    ].join("\n\n")
  },
  {
    templateId: "engineering",
    displayName: "Engineering partner",
    description: "A careful implementation partner for software design, coding, verification, and maintenance.",
    identitySource: [
      "# Role",
      "You are a long-lived engineering partner. Build maintainable systems, investigate failures to their cause, and verify behavior at the boundary that owns it.",
      "# Working style",
      "Preserve user work, make scoped changes, explain tradeoffs concretely, and do not claim completion without relevant execution evidence."
    ].join("\n\n")
  }
] as const satisfies readonly PartnerTemplateDefinition[];

export const PARTNER_AVATAR_PRESETS = ["orbit", "spark", "leaf", "wave"] as const;

export type PartnerAvatarPreset = (typeof PARTNER_AVATAR_PRESETS)[number];

export type PartnerManagerErrorCode =
  | "PARTNER_TEMPLATE_INVALID"
  | "PARTNER_AVATAR_INVALID"
  | "PARTNER_MODEL_UNAVAILABLE"
  | "PARTNER_BACKEND_CHANGE_UNSUPPORTED";

export function partnerSessionRuntimeFallback(
  store: Pick<PartnerStore, "findPartnerByCanonicalSession">,
  input: {
    readonly sessionId: string;
    readonly current: SessionRuntimeProfile;
    readonly visitedRoutes: readonly string[];
    readonly currentHop: number;
  }
): { readonly owned: boolean; readonly candidate?: SessionRuntimeProfile } {
  const partner = store.findPartnerByCanonicalSession(input.sessionId);
  if (partner === undefined) return { owned: false };
  if (partner.lifecycle !== "active" || partner.initializationState !== "ready") return { owned: true };
  const chain = partner.capabilities.modelChain;
  if (input.currentHop >= chain.length - 1) return { owned: true };
  const key = (route: Pick<SessionRuntimeProfile, "providerId" | "modelId">) =>
    `${route.providerId}\0${route.modelId}`;
  const visited = new Set([...input.visitedRoutes, key(input.current)]);
  const currentIndex = chain.findIndex((route) => key(route) === key(input.current));
  const candidate = (currentIndex < 0 ? chain : chain.slice(currentIndex + 1))
    .find((route) => !visited.has(key(route)));
  return candidate === undefined ? { owned: true } : {
    owned: true,
    candidate: {
      backendId: candidate.backendId,
      providerId: candidate.providerId,
      modelId: candidate.modelId,
      ...(candidate.effort === undefined ? {} : { effort: candidate.effort }),
      fastMode: candidate.fastMode
    }
  };
}

export class PartnerManagerError extends Error {
  constructor(readonly code: PartnerManagerErrorCode, message: string) {
    super(message);
    this.name = "PartnerManagerError";
  }
}

export interface PartnerManagerOptions {
  readonly store: PartnerStore;
  readonly operationalStore: OperationalStore;
  readonly sessionHost: Pick<
    SessionHost,
    "registerTarget" | "createServiceSession" | "applySessionSettings" | "updateServiceSessionPrompt"
  >;
  readonly homesRoot: string;
  /** Test seam for a recoverable, optional-artwork preparation failure. */
  readonly prepareAvatar?: (input: {
    readonly partner: PartnerProfileRecord;
    readonly homePath: string;
  }) => Promise<void>;
}

export interface PartnerDirectoryView {
  readonly state: PartnerDirectoryState;
  readonly templates: readonly PartnerTemplateDefinition[];
  readonly avatarPresets: readonly PartnerAvatarPreset[];
}

/** Owns durable profile → managed home Target → canonical Session reconciliation. */
export class PartnerManager {
  readonly #store: PartnerStore;
  readonly #operationalStore: OperationalStore;
  readonly #sessionHost: PartnerManagerOptions["sessionHost"];
  readonly #homesRoot: string;
  readonly #prepareAvatar: NonNullable<PartnerManagerOptions["prepareAvatar"]>;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(options: PartnerManagerOptions) {
    this.#store = options.store;
    this.#operationalStore = options.operationalStore;
    this.#sessionHost = options.sessionHost;
    this.#homesRoot = resolve(options.homesRoot);
    this.#prepareAvatar = options.prepareAvatar ?? (async ({ partner, homePath }) => {
      await atomicWrite(join(homePath, "AVATAR.svg"), avatarSvg(partner.avatar as PartnerAvatarPreset));
    });
  }

  directory(): PartnerDirectoryView {
    return {
      state: this.#store.directoryState(),
      templates: PARTNER_TEMPLATES,
      avatarPresets: PARTNER_AVATAR_PRESETS
    };
  }

  listPartners(lifecycle?: "active" | "archived" | "deleted"): readonly PartnerProfileRecord[] {
    return this.#store.listPartners(lifecycle === undefined ? {} : { lifecycle });
  }

  getPartner(partnerId: string): PartnerProfileRecord {
    return this.#store.getPartner(partnerId);
  }

  async createPartner(input: CreatePartnerInput): Promise<PartnerProfileRecord> {
    assertPresentation(input.templateId, input.avatar);
    const created = this.#store.createPartner(input);
    return this.#serialized(created.id, () => this.#initializeCurrent(created.id));
  }

  async updatePartner(
    partnerId: string,
    expectedRevision: bigint,
    patch: PartnerPatch
  ): Promise<PartnerProfileRecord> {
    return this.#serialized(partnerId, async () => {
      const current = this.#store.getPartner(partnerId);
      if (current.revision !== expectedRevision) {
        throw new PartnerStoreError("PARTNER_CHANGED", `Partner ${partnerId} changed; read it again and retry.`);
      }
      if (patch.avatar !== undefined) assertAvatar(patch.avatar);
      const usesDefaults = patch.usesDirectoryDefaults ?? current.usesDirectoryDefaults;
      if (usesDefaults && patch.capabilities !== undefined) {
        throw new PartnerStoreError("PARTNER_INVALID", "A partner using directory defaults cannot also provide capability overrides.");
      }
      const capabilities = usesDefaults
        ? this.#store.directoryState().defaultCapabilities
        : patch.capabilities ?? current.capabilities;
      if (capabilities === undefined) {
        throw new PartnerManagerError("PARTNER_MODEL_UNAVAILABLE", "Partner directory defaults are not configured.");
      }
      this.#validateCapabilities(capabilities);
      const currentBackend = current.capabilities.modelChain[0]?.backendId;
      const nextBackend = capabilities.modelChain[0]?.backendId;
      if (current.canonicalSessionId !== undefined && currentBackend !== nextBackend) {
        throw new PartnerManagerError(
          "PARTNER_BACKEND_CHANGE_UNSUPPORTED",
          "An initialized partner cannot move its canonical Session to another Backend."
        );
      }
      const updated = this.#store.updatePartner(partnerId, expectedRevision, patch);
      return this.#initializeCurrent(updated.id);
    });
  }

  async setLifecycle(
    partnerId: string,
    expectedRevision: bigint,
    lifecycle: "active" | "archived" | "deleted"
  ): Promise<PartnerProfileRecord> {
    return this.#serialized(partnerId, async () => {
      const updated = this.#store.setLifecycle(partnerId, expectedRevision, lifecycle);
      if (updated.lifecycle !== "active" || updated.initializationState === "ready") return updated;
      const pending = updated.initializationState === "error"
        ? this.#store.prepareInitialization(updated.id, updated.revision)
        : updated;
      return this.#initializeCurrent(pending.id);
    });
  }

  async retryInitialization(partnerId: string, expectedRevision: bigint): Promise<PartnerProfileRecord> {
    return this.#serialized(partnerId, async () => {
      const pending = this.#store.prepareInitialization(partnerId, expectedRevision);
      return this.#initializeCurrent(pending.id);
    });
  }

  async updateDirectoryDefaults(
    expectedDirectoryRevision: bigint,
    capabilities: PartnerCapabilitiesRecord
  ): Promise<readonly PartnerProfileRecord[]> {
    this.#validateCapabilities(capabilities);
    const affected = this.#store.setDirectoryDefaults(expectedDirectoryRevision, capabilities);
    const reconciled: PartnerProfileRecord[] = [];
    for (const partner of affected) {
      reconciled.push(await this.#serialized(partner.id, () => this.#initializeCurrent(partner.id)));
    }
    return reconciled;
  }

  /** Resume only interrupted work. Explicit failures remain visible until retry. */
  async recoverPending(): Promise<void> {
    for (const partner of this.#store.listPartners({ lifecycle: "active" })) {
      if (partner.initializationState !== "pending") continue;
      await this.#serialized(partner.id, () => this.#initializeCurrent(partner.id));
    }
  }

  async #initializeCurrent(partnerId: string): Promise<PartnerProfileRecord> {
    let current = this.#store.getPartner(partnerId);
    if (current.lifecycle !== "active" || current.initializationState === "ready") return current;

    try {
      this.#validateCapabilities(current.capabilities);
    } catch {
      return this.#recordFailure(current, "model_unavailable");
    }

    let homePath: string;
    try {
      homePath = await this.#writeHome(current);
      current = this.#advanceStage(current, "avatar");
    } catch {
      return this.#recordFailure(current, "home_unavailable");
    }

    try {
      await this.#prepareAvatar({ partner: current, homePath });
      current = this.#advanceStage(current, "session");
    } catch {
      return this.#recordFailure(current, "avatar_unavailable");
    }

    try {
      const primary = current.capabilities.modelChain[0]!;
      await this.#sessionHost.registerTarget(this.#target(current, primary.backendId, homePath), {
        kind: "partner_home",
        partnerId: current.id,
        profileVersion: current.profileVersion
      });
      const existing = this.#canonicalSession(current);
      if (existing !== undefined && !existing.replace) {
        await this.#applyCanonicalSettings(current, existing.sessionId);
      } else {
        const execution = await this.#sessionHost.createServiceSession({
          operationId: `partner-session:${current.id}:${current.profileVersion}:${current.revision}`,
          serviceKind: "partner",
          targetId: current.homeTargetId,
          title: current.displayName,
          providerId: primary.providerId,
          modelId: primary.modelId,
          ...(primary.effort === undefined ? {} : { effort: primary.effort }),
          fastMode: primary.fastMode,
          permissionMode: current.capabilities.permissionMode,
          planMode: current.capabilities.planMode,
          appendSystemPrompt: current.identitySource
        });
        const latest = this.#store.getPartner(current.id);
        current = existing?.replace === true
          ? this.#store.replaceCanonicalSession({
              partnerId: latest.id,
              expectedRevision: latest.revision,
              expectedProfileVersion: latest.profileVersion,
              expectedCanonicalSessionId: existing.sessionId,
              sessionId: execution.value.sessionId
            })
          : this.#store.bindCanonicalSession({
              partnerId: latest.id,
              expectedRevision: latest.revision,
              expectedProfileVersion: latest.profileVersion,
              sessionId: execution.value.sessionId
            });
      }
      current = this.#store.getPartner(current.id);
      return this.#store.markReady(current.id, current.revision);
    } catch (error) {
      const code: PartnerInitializationErrorCode = error instanceof PartnerStoreError
        && (error.code === "PARTNER_CHANGED" || error.code === "PARTNER_SESSION_CONFLICT")
        ? "state_changed"
        : "session_unavailable";
      return this.#recordFailure(current, code);
    }
  }

  #canonicalSession(profile: PartnerProfileRecord): { readonly sessionId: string; readonly replace: boolean } | undefined {
    if (profile.canonicalSessionId === undefined) return undefined;
    let session;
    try {
      session = this.#operationalStore.getSession(profile.canonicalSessionId).descriptor;
    } catch (error) {
      if (error instanceof NotFoundError) return { sessionId: profile.canonicalSessionId, replace: true };
      throw error;
    }
    const primary = profile.capabilities.modelChain[0]!;
    if (session.targetId !== profile.homeTargetId || session.backendId !== primary.backendId) {
      throw new PartnerStoreError("PARTNER_SESSION_CONFLICT", "The canonical Session no longer belongs to this partner home.");
    }
    return {
      sessionId: session.id,
      replace: session.deletedAt !== undefined || session.archived
    };
  }

  async #applyCanonicalSettings(profile: PartnerProfileRecord, sessionId: string): Promise<void> {
    const primary = profile.capabilities.modelChain[0]!;
    await this.#sessionHost.updateServiceSessionPrompt(sessionId, profile.identitySource);
    const before = this.#operationalStore.getSession(sessionId);
    const state = await this.#sessionHost.applySessionSettings(sessionId, {
      providerId: primary.providerId,
      modelId: primary.modelId,
      ...(primary.effort === undefined ? {} : { effort: primary.effort }),
      fastMode: primary.fastMode,
      permissionMode: profile.capabilities.permissionMode,
      planMode: profile.capabilities.planMode
    }, { requireNativeObservation: true });
    if (state === undefined
      || state.providerId !== primary.providerId
      || state.modelId !== primary.modelId
      || !matchesPartnerEffort(primary.effort, state.effort)
      || state.fastMode !== primary.fastMode
      || (state.permissionMode !== undefined && state.permissionMode !== profile.capabilities.permissionMode)
      || (state.planMode !== undefined && state.planMode !== profile.capabilities.planMode)) {
      throw new Error("The canonical Session did not report the requested partner settings.");
    }
    const latest = this.#operationalStore.getSession(sessionId);
    if (latest.descriptor.targetId !== profile.homeTargetId
      || latest.descriptor.backendId !== primary.backendId
      || latest.descriptor.archived
      || latest.descriptor.deletedAt !== undefined
      || !sameSessionAxes(before.descriptor, latest.descriptor)) {
      throw new PartnerStoreError("PARTNER_CHANGED", "The canonical Session changed while partner settings were applied.");
    }
    this.#operationalStore.updateSession(sessionId, {
      title: profile.displayName,
      providerId: state.providerId,
      modelId: state.modelId,
      effort: primary.effort ?? null,
      fastMode: state.fastMode,
      permissionMode: profile.capabilities.permissionMode,
      planMode: profile.capabilities.planMode
    }, latest.revision);
  }

  #target(profile: PartnerProfileRecord, backendId: string, homePath: string): TargetDescriptor {
    return {
      id: profile.homeTargetId,
      backendId,
      displayName: `${profile.displayName} home`,
      workspaceRoot: homePath,
      managed: true,
      trusted: true
    };
  }

  #validateCapabilities(capabilities: PartnerCapabilitiesRecord): void {
    if (capabilities.modelChain.length < 1 || capabilities.modelChain.length > 3) throw modelUnavailable();
    const backendId = capabilities.modelChain[0]!.backendId;
    if (capabilities.modelChain.some((route) => route.backendId !== backendId)) throw modelUnavailable();
    let backend;
    try {
      backend = this.#operationalStore.getBackend(backendId).descriptor;
    } catch {
      throw modelUnavailable();
    }
    if (backend.health === "unavailable" || backend.installationState !== "installed"
      || (backend.authenticationState !== "authenticated" && backend.authenticationState !== "not_required")) {
      throw modelUnavailable();
    }
    const identities = new Set<string>();
    for (const route of capabilities.modelChain) {
      const identity = `${route.providerId}\0${route.modelId}`;
      if (identities.has(identity)) throw modelUnavailable();
      identities.add(identity);
      const model = backend.models.find((candidate) =>
        candidate.providerId === route.providerId && candidate.modelId === route.modelId);
      if (model === undefined || !modelRoutingEnabled(
        this.#operationalStore, backendId, route.providerId, route.modelId
      )) throw modelUnavailable();
      if (route.effort !== undefined && (
        backend.capabilities.get("model.effort")?.supported !== true
        || !model.thinkingLevels.includes(route.effort)
      )) throw modelUnavailable();
      if ((model.thinkingLevels.length > 0) !== (route.effort !== undefined)) throw modelUnavailable();
      if (route.fastMode && (
        backend.capabilities.get("model.fast_mode")?.supported !== true
        || model.supportsFastMode !== true
      )) throw modelUnavailable();
    }
    if (capabilities.modelChain.length > 1
      && backend.capabilities.get("model.switch")?.supported !== true) throw modelUnavailable();
    const modes = backend.capabilities.get("permission.modes");
    if (modes?.supported !== true || !modes.options?.includes(capabilities.permissionMode)) {
      throw modelUnavailable();
    }
    if (capabilities.planMode && backend.capabilities.get("plan_mode")?.supported !== true) {
      throw modelUnavailable();
    }
  }

  async #writeHome(profile: PartnerProfileRecord): Promise<string> {
    await mkdir(this.#homesRoot, { recursive: true });
    const root = await realpath(this.#homesRoot);
    const directoryName = `partner-${createHash("sha256").update(profile.id, "utf8").digest("hex").slice(0, 32)}`;
    const homePath = join(root, directoryName);
    await mkdir(homePath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const info = await lstat(homePath);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Partner home is not a managed directory.");
    const canonicalHome = await realpath(homePath);
    if (!samePath(dirname(canonicalHome), root)) throw new Error("Partner home escaped its managed root.");
    await atomicWrite(join(canonicalHome, "IDENTITY.md"), `${profile.identitySource}\n`);
    await atomicWrite(join(canonicalHome, ".joko-partner.json"), `${JSON.stringify({
      format: 1,
      partnerId: profile.id,
      profileVersion: profile.profileVersion,
      displayName: profile.displayName,
      avatar: profile.avatar,
      templateId: profile.templateId,
      identitySha256: createHash("sha256").update(profile.identitySource, "utf8").digest("hex"),
      capabilities: profile.capabilities,
      usesDirectoryDefaults: profile.usesDirectoryDefaults
    }, null, 2)}\n`);
    return canonicalHome;
  }

  #advanceStage(
    profile: PartnerProfileRecord,
    stage: Exclude<PartnerInvitationStage, "ready" | "failed">
  ): PartnerProfileRecord {
    const order: Record<Exclude<PartnerInvitationStage, "ready" | "failed">, number> = {
      home: 0,
      avatar: 1,
      session: 2
    };
    if (profile.invitationStage === "ready" || profile.invitationStage === "failed") return profile;
    if (order[profile.invitationStage] >= order[stage]) return profile;
    return this.#store.markInvitationStage(profile.id, profile.revision, stage);
  }

  #recordFailure(
    observed: PartnerProfileRecord,
    code: PartnerInitializationErrorCode
  ): PartnerProfileRecord {
    const current = this.#store.getPartner(observed.id);
    if (current.lifecycle === "deleted" || current.initializationState === "ready") return current;
    try {
      return this.#store.failInitialization(current.id, current.revision, code);
    } catch (error) {
      if (error instanceof PartnerStoreError && error.code === "PARTNER_CHANGED") {
        return this.#store.getPartner(current.id);
      }
      throw error;
    }
  }

  async #serialized<T>(partnerId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(partnerId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(action);
    const tail = task.then(() => undefined, () => undefined);
    this.#locks.set(partnerId, tail);
    void tail.finally(() => {
      if (this.#locks.get(partnerId) === tail) this.#locks.delete(partnerId);
    });
    return task;
  }
}

function assertPresentation(templateId: string, avatar: string): void {
  if (!PARTNER_TEMPLATES.some((template) => template.templateId === templateId)) {
    throw new PartnerManagerError("PARTNER_TEMPLATE_INVALID", "The selected partner template is unavailable.");
  }
  assertAvatar(avatar);
}

function assertAvatar(avatar: string): asserts avatar is PartnerAvatarPreset {
  if (!(PARTNER_AVATAR_PRESETS as readonly string[]).includes(avatar)) {
    throw new PartnerManagerError("PARTNER_AVATAR_INVALID", "The selected partner avatar is unavailable.");
  }
}

function modelUnavailable(): PartnerManagerError {
  return new PartnerManagerError(
    "PARTNER_MODEL_UNAVAILABLE",
    "The selected partner model or capability settings are unavailable."
  );
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function matchesPartnerEffort(expected: string | undefined, observed: string | undefined): boolean {
  // A runtime may expose disabled reasoning as an `off` sentinel even when
  // its model catalog has no effort axis. Keep that native representation
  // equivalent to the Partner profile's capability-neutral absence.
  return expected === undefined
    ? observed === undefined || observed === "off"
    : observed === expected;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLocaleLowerCase("en-US") === resolve(right).toLocaleLowerCase("en-US")
    : resolve(left) === resolve(right);
}

function sameSessionAxes(left: SessionDescriptor, right: SessionDescriptor): boolean {
  return left.providerId === right.providerId
    && left.modelId === right.modelId
    && left.effort === right.effort
    && left.fastMode === right.fastMode
    && left.permissionMode === right.permissionMode
    && left.planMode === right.planMode;
}

function avatarSvg(preset: PartnerAvatarPreset): string {
  const palette: Record<PartnerAvatarPreset, readonly [string, string]> = {
    orbit: ["#F2A65A", "#334155"],
    spark: ["#F59E0B", "#7C2D12"],
    leaf: ["#65A30D", "#14532D"],
    wave: ["#38BDF8", "#164E63"]
  };
  const [primary, secondary] = palette[preset];
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" role="img">',
    `<title>${preset} partner avatar</title>`,
    `<rect width="96" height="96" rx="28" fill="${secondary}"/>`,
    `<circle cx="48" cy="42" r="25" fill="${primary}"/>`,
    `<path d="M19 88c4-20 17-30 29-30s25 10 29 30" fill="${primary}"/>`,
    '<circle cx="39" cy="41" r="3" fill="#fff"/>',
    '<circle cx="57" cy="41" r="3" fill="#fff"/>',
    '</svg>\n'
  ].join("");
}
