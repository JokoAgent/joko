import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, mkdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { PromptInput, SessionDescriptor, TargetDescriptor } from "@joko/core";
import {
  NotFoundError,
  PartnerStoreError,
  decodePartnerAvatar,
  type PartnerAvatarInput,
  partnerHomeDirectoryName,
  type CreatePartnerInput,
  type OperationalStore,
  type PersistedEvent,
  type PartnerCapabilitiesRecord,
  type PartnerModelRouteRecord,
  type PartnerDirectoryState,
  type PartnerInitializationErrorCode,
  type PartnerInvitationStage,
  type PartnerPatch,
  type PartnerDelegationRecord,
  type PartnerDeletionRecord,
  type PartnerRestartRecord,
  type PartnerPauseRecord,
  type PartnerLifecycle,
  type PartnerPrivateMessageRecord,
  type PartnerPrivateMessageReservation,
  type PartnerPrivateThreadReadStateRecord,
  type PartnerPrivateThreadRecord,
  type PartnerPrivateThreadViewRecord,
  type PartnerProfileRecord,
  type PartnerReadStateRecord,
  type PartnerSessionLinkRecord,
  type PartnerStore
} from "@joko/store";

import { modelRoutingEnabled } from "./backend-model-access.js";
import type { SessionHost } from "./session-host.js";
import type { SessionRuntimeProfile } from "./session-runtime-control.js";
import type { WorkspaceService } from "./workspace-service.js";

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
  | "PARTNER_BACKEND_CHANGE_UNSUPPORTED"
  | "PARTNER_SESSION_INACTIVE"
  | "PARTNER_DELIVERY_UNAVAILABLE"
  | "PARTNER_DELEGATION_UNAVAILABLE";

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
  const key = (route: Pick<SessionRuntimeProfile, "backendId" | "providerId" | "modelId">) =>
    `${route.backendId}\0${route.providerId}\0${route.modelId}`;
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
    | "enqueueServiceInput" | "abort" | "getSessionRuntimeControl" | "setSessionRuntimeControl"
    | "retirePartnerSession" | "quiescePartnerTargetCreations"
    | "restartPartnerSession" | "canRestartPartnerSession"
    | "preparePartnerPauseQueue" | "pausePartnerSession" | "restorePartnerQueue" | "wakePartnerSession"
    | "retirePartnerPolicyRuntime" | "retryPartnerPolicyRetirement"
  >;
  readonly workspaceService: Pick<WorkspaceService, "register" | "unregister">;
  readonly homesRoot: string;
  readonly appDefaultModel?: () => PartnerCapabilitiesRecord["modelChain"][number] | undefined;
  readonly retireWorkbench?: (partnerId: string, targetId: string) => void;
  readonly ownedIndependentSessions?: (partnerId: string) => readonly string[];
  readonly forgetIndependentTasks?: (partnerId: string) => void;
  readonly resumeIndependentReturns?: (partnerId: string) => Promise<void>;
  readonly pauseGoal?: (sessionId: string, operationId: string) => Promise<void>;
  readonly onRoutineLifecycle?: (partnerId: string, state: PartnerLifecycle) => Promise<void>;
  readonly prepareImportDeletion?: (partnerId: string) => Promise<void>;
  readonly onReady?: (partnerId: string) => Promise<void>;
  readonly homeChanging?: (partnerId: string) => boolean;
  readonly remoteHomeModelAvailable?: (targetId: string, route: PartnerModelRouteRecord) => boolean;
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

export interface PartnerActivitySummary {
  readonly partnerId: string;
  readonly unreadReplyCount: number;
  readonly latestReplyCursor?: bigint;
  readonly latestReplyAt?: number;
  readonly latestReplyPreview: string;
  readonly artifactCount: number;
  readonly activeDelegationCount: number;
  readonly readState: PartnerReadStateRecord;
}

export interface PartnerSessionView {
  readonly link: PartnerSessionLinkRecord;
  readonly session?: SessionDescriptor;
  readonly available: boolean;
  readonly readOnly: boolean;
}

export interface PartnerPrivateMessageDelivery {
  readonly reservation: PartnerPrivateMessageReservation;
  readonly message: PartnerPrivateMessageRecord;
}

export interface PartnerDelegationView {
  readonly delegation: PartnerDelegationRecord;
  readonly artifactCount: number;
}

/** Owns durable profile → managed home Target → canonical Session reconciliation. */
export class PartnerManager {
  readonly #importScope = new AsyncLocalStorage<{ key: string; active: boolean }>();
  readonly #homeScope = new AsyncLocalStorage<{ key: string; active: boolean }>();
  readonly #homeChanging: (partnerId: string) => boolean;
  readonly #remoteHomeModelAvailable: NonNullable<PartnerManagerOptions["remoteHomeModelAvailable"]>;
  readonly #prepareImportDeletion: PartnerManagerOptions["prepareImportDeletion"];
  readonly #optionsOnReady: PartnerManagerOptions["onReady"];
  readonly #store: PartnerStore;
  readonly #operationalStore: OperationalStore;
  readonly #sessionHost: PartnerManagerOptions["sessionHost"];
  readonly #workspaceService: PartnerManagerOptions["workspaceService"];
  readonly #homesRoot: string;
  readonly #appDefaultModel: PartnerManagerOptions["appDefaultModel"];
  readonly #prepareAvatar: NonNullable<PartnerManagerOptions["prepareAvatar"]>;
  readonly #retireWorkbench: PartnerManagerOptions["retireWorkbench"];
  readonly #ownedIndependentSessions: PartnerManagerOptions["ownedIndependentSessions"];
  readonly #forgetIndependentTasks: PartnerManagerOptions["forgetIndependentTasks"];
  readonly #resumeIndependentReturns: PartnerManagerOptions["resumeIndependentReturns"];
  readonly #pauseGoal: PartnerManagerOptions["pauseGoal"];
  readonly #routineLifecycle: PartnerManagerOptions["onRoutineLifecycle"];
  readonly #locks = new Map<string, Promise<void>>();
  readonly #pauseFlights = new Map<string, Promise<void>>();

  constructor(options: PartnerManagerOptions) {
    this.#homeChanging = options.homeChanging ?? (() => false);
    this.#remoteHomeModelAvailable = options.remoteHomeModelAvailable ?? (() => false);
    this.#appDefaultModel = options.appDefaultModel;
    this.#store = options.store;
    this.#operationalStore = options.operationalStore;
    this.#sessionHost = options.sessionHost;
    this.#workspaceService = options.workspaceService;
    this.#homesRoot = resolve(options.homesRoot);
    this.#retireWorkbench = options.retireWorkbench;
    this.#ownedIndependentSessions = options.ownedIndependentSessions;
    this.#forgetIndependentTasks = options.forgetIndependentTasks;
    this.#resumeIndependentReturns = options.resumeIndependentReturns;
    this.#pauseGoal = options.pauseGoal;
    this.#routineLifecycle = options.onRoutineLifecycle;
    this.#prepareImportDeletion = options.prepareImportDeletion;
    this.#optionsOnReady = options.onReady;
    this.#prepareAvatar = options.prepareAvatar ?? (async ({ partner, homePath }) => {
      const file = typeof partner.avatar === "string" ? "AVATAR.svg"
        : partner.avatar.mimeType === "image/jpeg" ? "AVATAR.jpg"
          : partner.avatar.mimeType === "image/png" ? "AVATAR.png" : "AVATAR.webp";
      const content = typeof partner.avatar === "string" ? avatarSvg(partner.avatar as PartnerAvatarPreset)
        : this.#store.readPartnerAvatar(partner.id, partner.revision, partner.avatar.sha256).content;
      await atomicWrite(join(homePath, file), content);
      for (const other of ["AVATAR.svg", "AVATAR.jpg", "AVATAR.png", "AVATAR.webp"]) {
        if (other !== file) await unlink(join(homePath, other)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    });
  }

  directory(): PartnerDirectoryView {
    const state = this.#store.directoryState();
    const defaultCapabilities = state.defaultCapabilities ?? this.#followingDefaults();
    return {
      state: { ...state, ...(defaultCapabilities === undefined ? {} : { defaultCapabilities }) },
      templates: PARTNER_TEMPLATES,
      avatarPresets: PARTNER_AVATAR_PRESETS
    };
  }

  listPartners(lifecycle?: PartnerLifecycle): readonly PartnerProfileRecord[] {
    return this.#store.listPartners(lifecycle === undefined ? {} : { lifecycle });
  }

  getPartner(partnerId: string): PartnerProfileRecord {
    return this.#store.getPartner(partnerId);
  }

  isHomeChanging(partnerId: string): boolean { return this.#homeChanging(partnerId); }

  async runHomeManagement<T>(partnerId: string, action: () => Promise<T>): Promise<T> {
    const scope = { key: partnerId, active: true };
    try { return await this.#homeScope.run(scope, () => this.#serialized(partnerId, async () => {
      const internal = { key: partnerId, active: true };
      try { return await this.#importScope.run(internal, action); }
      finally { internal.active = false; }
    })); }
    finally { scope.active = false; }
  }

  async localHome(partnerId: string): Promise<string> {
    const partner = this.#store.getPartner(partnerId), homePath = await this.#writeHome(partner);
    await this.#prepareAvatar({ partner, homePath }); return homePath;
  }

  validateHomeCapabilities(capabilities: PartnerCapabilitiesRecord): void { this.#validateCapabilities(capabilities); }

  readPartnerAvatar(partnerId: string, expectedRevision: bigint, sha256: string) {
    return this.#store.readPartnerAvatar(partnerId, expectedRevision, sha256);
  }

  getPartnerCreation(requestId: string): PartnerProfileRecord {
    const partner = this.#store.getPartnerCreation(requestId);
    if (partner === undefined) {
      throw new PartnerStoreError("PARTNER_NOT_FOUND", "This partner creation request was not found.");
    }
    return partner;
  }

  retirePartnerCreation(requestId: string): PartnerProfileRecord | undefined {
    return this.#store.retirePartnerCreation(requestId);
  }

  partnerForHomeTarget(targetId: string): PartnerProfileRecord | undefined {
    return this.#store.findPartnerByHomeTarget(targetId);
  }

  canonicalCaller(sessionId: string): PartnerProfileRecord {
    const partner = this.#store.findPartnerByCanonicalSession(sessionId);
    if (partner === undefined || partner.lifecycle !== "active" || partner.initializationState !== "ready"
      || partner.canonicalSessionId !== sessionId) {
      throw new PartnerManagerError(
        "PARTNER_SESSION_INACTIVE",
        "This action requires an active partner canonical task."
      );
    }
    const session = this.#operationalStore.getSession(sessionId).descriptor;
    if (session.targetId !== partner.homeTargetId || session.archived || session.deletedAt !== undefined) {
      throw new PartnerManagerError(
        "PARTNER_SESSION_INACTIVE",
        "The partner canonical task is archived, deleted, or belongs to another home."
      );
    }
    return partner;
  }

  resolveTaskModel(sessionId: string, explicit?: PartnerModelRouteRecord): { readonly route: PartnerModelRouteRecord; readonly assertCurrent: () => void } {
    const profile = this.canonicalCaller(sessionId), session = this.#operationalStore.getSession(sessionId).descriptor;
    const target = this.#operationalStore.getTarget(session.targetId);
    const callerGeneration = this.#operationalStore.getBackend(session.backendId).descriptor.instanceGeneration;
    const runtime = this.#sessionHost.getSessionRuntimeControl(sessionId);
    const selected = explicit ?? profile.taskModelOverride ?? runtime.effective;
    if (selected === undefined || !target.descriptor.trusted || !this.#homeRouteAvailable(target.descriptor, selected)) throw modelUnavailable();
    const route = Object.freeze({ ...selected });
    const capabilities = { ...profile.capabilities, modelChain: [route] };
    this.#validateCapabilities(capabilities);
    const backend = this.#operationalStore.getBackend(route.backendId).descriptor;
    const catalog = () => {
      const current = this.#operationalStore.getBackend(route.backendId).descriptor;
      return JSON.stringify([current.instanceGeneration, current.installationState, current.health, current.authenticationState,
        current.models, [...current.capabilities].map(([key, value]) => [key, value.supported, value.options])]);
    };
    const sourceCatalog = catalog();
    const assertCurrent = () => {
      const current = this.canonicalCaller(sessionId), live = this.#operationalStore.getSession(sessionId).descriptor;
      const home = this.#operationalStore.getTarget(session.targetId);
      if (current.revision !== profile.revision || current.profileVersion !== profile.profileVersion
        || live.binding.generation !== session.binding.generation || live.backendId !== session.backendId
        || home.revision !== target.revision || !home.descriptor.trusted || !this.#homeRouteAvailable(home.descriptor, route)
        || this.#operationalStore.getBackend(session.backendId).descriptor.instanceGeneration !== callerGeneration
        || this.#operationalStore.getBackend(route.backendId).descriptor.instanceGeneration !== backend.instanceGeneration
        || catalog() !== sourceCatalog || explicit === undefined && profile.taskModelOverride === undefined
          && this.#sessionHost.getSessionRuntimeControl(sessionId).generation !== runtime.generation) throw modelUnavailable();
      this.#validateCapabilities(capabilities);
    };
    assertCurrent(); return { route, assertCurrent };
  }

  activity(partnerId: string): PartnerActivitySummary {
    const partner = this.#store.getPartner(partnerId);
    const readState = this.#store.readState(partner.id);
    const sessionId = partner.canonicalSessionId;
    let unreadReplyCount = 0;
    let latestReply: PersistedEvent | undefined;
    if (sessionId !== undefined) {
      let afterCursor = readState.throughCursor;
      for (;;) {
        const page = this.#operationalStore.listEvents({ sessionId, afterCursor, limit: 1_000 });
        for (const event of page) {
          if (event.payload.type === "message_complete" && event.payload.role === "assistant"
            && event.payload.partnerPrivateOrigin === undefined) {
            unreadReplyCount += 1;
            latestReply = event;
          }
        }
        if (page.length < 1_000) break;
        afterCursor = page.at(-1)!.globalCursor;
      }
      if (latestReply === undefined) latestReply = this.#latestAssistantReply(sessionId, true);
    }
    const artifactCount = this.#store.listSessionLinks(partner.id).filter(link => link.role !== "group")
      .reduce((count, link) => count + this.#operationalStore.countArtifacts({ sessionId: link.sessionId }), 0);
    const activeDelegationCount = this.#store.listDelegations(partner.id, {
      statuses: ["preparing", "queued", "running", "waiting", "unknown"]
    }).length;
    return {
      partnerId: partner.id,
      unreadReplyCount,
      latestReplyPreview: latestReply?.payload.type === "message_complete"
        ? latestReply.payload.blocks.filter((block) => block.kind === "text")
          .map((block) => block.text).join(" ").replace(/\s+/gu, " ").trim().slice(0, 500) : "",
      ...(latestReply === undefined ? {} : {
        latestReplyCursor: latestReply.globalCursor,
        latestReplyAt: latestReply.emittedAt
      }),
      artifactCount,
      activeDelegationCount,
      readState
    };
  }

  markRead(partnerId: string, throughCursor: bigint): PartnerReadStateRecord {
    const partner = this.#store.getPartner(partnerId);
    if (partner.canonicalSessionId === undefined) {
      throw new PartnerManagerError("PARTNER_SESSION_INACTIVE", "The partner has no canonical task.");
    }
    const latest = this.#operationalStore.listEvents({
      sessionId: partner.canonicalSessionId,
      order: "desc",
      limit: 1
    })[0];
    if (throughCursor < 0n || (latest !== undefined && throughCursor > latest.globalCursor)
      || (latest === undefined && throughCursor > 0n)) {
      throw new PartnerStoreError("PARTNER_INVALID", "The partner read cursor is outside the canonical task.");
    }
    return this.#store.markRead(partner.id, throughCursor);
  }

  listSessions(partnerId: string, includeGroup = false): readonly PartnerSessionView[] {
    const partner = this.#store.getPartner(partnerId);
    return this.#store.listSessionLinks(partner.id).filter(link => includeGroup || link.role !== "group").map((link) => {
      let session: SessionDescriptor | undefined;
      try {
        session = this.#operationalStore.getSession(link.sessionId).descriptor;
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
      if (session !== undefined && link.role !== "group" && link.role !== "history" && session.targetId !== partner.homeTargetId) {
        throw new PartnerStoreError(
          "PARTNER_SESSION_CONFLICT",
          "A linked partner task no longer belongs to the partner home."
        );
      }
      return {
        link,
        ...(session === undefined ? {} : { session }),
        available: session !== undefined && session.deletedAt === undefined,
        readOnly: link.role !== "canonical" || session?.archived === true || session?.deletedAt !== undefined
      };
    });
  }

  listPrivateThreads(partnerId: string): readonly PartnerPrivateThreadRecord[] {
    return this.#store.listPrivateThreads(partnerId);
  }

  getPrivateThread(threadId: string, viewerPartnerId: string): PartnerPrivateThreadViewRecord {
    return this.#store.getPrivateThread(threadId, viewerPartnerId);
  }

  markPrivateThreadRead(
    threadId: string,
    partnerId: string,
    throughSequence: number
  ): PartnerPrivateThreadReadStateRecord {
    return this.#store.markPrivateThreadRead(threadId, partnerId, throughSequence);
  }

  async sendPrivateMessage(input: {
    readonly messageId?: string;
    readonly callerSessionId: string;
    readonly targetPartnerId: string;
    readonly content: string;
  }): Promise<PartnerPrivateMessageDelivery> {
    const caller = this.canonicalCaller(input.callerSessionId);
    const target = this.#store.getPartner(input.targetPartnerId);
    if (target.canonicalSessionId === undefined) {
      throw new PartnerManagerError("PARTNER_DELIVERY_UNAVAILABLE", "The target partner has no canonical task.");
    }
    const [first, second] = caller.id < target.id ? [caller.id, target.id] : [target.id, caller.id];
    return this.#serialized(`private:${first}:${second}`, async () => {
      const reservation = this.#store.reservePrivateMessage({
        ...(input.messageId === undefined ? {} : { id: input.messageId }),
        senderPartnerId: caller.id,
        recipientPartnerId: target.id,
        senderSessionId: caller.canonicalSessionId!,
        recipientSessionId: target.canonicalSessionId!,
        content: input.content
      });
      if (reservation.message.deliveryStatus === "failed") {
        throw new PartnerManagerError(
          "PARTNER_DELIVERY_UNAVAILABLE",
          reservation.message.errorText ?? "The target partner did not accept the private message."
        );
      }
      try {
        const message = this.#deliverPrivateMessage(reservation.message);
        return { reservation, message };
      } catch (error) {
        this.#store.markPrivateMessageFailed(
          reservation.message.id,
          publicFailureText(error, "The target partner did not accept the private message.")
        );
        throw new PartnerManagerError(
          "PARTNER_DELIVERY_UNAVAILABLE",
          publicFailureText(error, "The target partner did not accept the private message.")
        );
      }
    });
  }

  async startDelegation(input: {
    readonly delegationId?: string;
    readonly callerSessionId: string;
    readonly targetPartnerId: string;
    readonly title: string;
    readonly objective: string;
  }): Promise<PartnerDelegationView> {
    const caller = this.canonicalCaller(input.callerSessionId);
    const created = this.#store.createDelegation({
      ...(input.delegationId === undefined ? {} : { id: input.delegationId }),
      requesterPartnerId: caller.id,
      targetPartnerId: input.targetPartnerId,
      parentSessionId: caller.canonicalSessionId!,
      title: input.title,
      objective: input.objective
    });
    return this.#serialized(`delegation:${created.id}`, async () => {
      const delegation = await this.#resumeDelegation(created.id);
      return this.#delegationView(delegation);
    });
  }

  async getDelegation(delegationId: string, viewerPartnerId: string): Promise<PartnerDelegationView> {
    const current = this.#store.getDelegation(delegationId);
    if (current.requesterPartnerId !== viewerPartnerId && current.targetPartnerId !== viewerPartnerId) {
      throw new PartnerStoreError("PARTNER_NOT_FOUND", "The partner delegation was not found.");
    }
    const delegation = await this.#serialized(`delegation:${current.id}`, () => this.#reconcileDelegation(current.id));
    return this.#delegationView(delegation);
  }

  async listDelegations(partnerId: string): Promise<readonly PartnerDelegationView[]> {
    this.#store.getPartner(partnerId);
    const records = this.#store.listDelegations(partnerId);
    const result: PartnerDelegationView[] = [];
    for (const record of records) {
      const delegation = await this.#serialized(`delegation:${record.id}`, () => this.#reconcileDelegation(record.id));
      result.push(this.#delegationView(delegation));
    }
    return result;
  }

  async cancelDelegation(
    delegationId: string,
    requesterPartnerId: string,
    expectedRevision?: bigint
  ): Promise<PartnerDelegationView> {
    return this.#serialized(`delegation:${delegationId}`, async () => {
      let current = this.#store.getDelegation(delegationId);
      if (current.requesterPartnerId !== requesterPartnerId) {
        throw new PartnerStoreError("PARTNER_NOT_FOUND", "The partner delegation was not found.");
      }
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new PartnerStoreError(
          "PARTNER_DELEGATION_CHANGED",
          `Partner delegation ${current.id} changed; read it again and retry.`
        );
      }
      current = await this.#reconcileDelegation(delegationId);
      if (isTerminalDelegation(current.status)) return this.#delegationView(current);
      if (current.childSessionId === undefined || current.runId === undefined) {
        current = this.#store.transitionDelegation({
          delegationId: current.id,
          expectedRevision: current.revision,
          status: "cancelled"
        });
        return this.#delegationView(current);
      }
      try {
        await this.#sessionHost.abort(current.childSessionId, current.runId);
        current = this.#store.transitionDelegation({
          delegationId: current.id,
          expectedRevision: current.revision,
          status: "cancelled"
        });
      } catch (error) {
        current = this.#store.transitionDelegation({
          delegationId: current.id,
          expectedRevision: current.revision,
          status: "unknown",
          errorText: publicFailureText(error, "Cancellation could not be confirmed.")
        });
      }
      return this.#delegationView(current);
    });
  }

  async createPartner(input: CreatePartnerInput, assertCurrent?: () => void): Promise<PartnerProfileRecord> {
    return this.#createPartner(input, false, assertCurrent);
  }

  async createImportedPartner(input: CreatePartnerInput): Promise<PartnerProfileRecord> {
    const scope = this.#importScope.getStore();
    if (!input.id || !scope?.active || scope.key !== input.id) throw new PartnerStoreError("PARTNER_INVALID", "Import creation requires its active management owner.");
    return this.#createPartner(input, true);
  }

  /** Trusted package installation may write its managed Home before a model or canonical task exists. */
  async prepareImportedHome(partnerId: string): Promise<string> {
    const scope = this.#importScope.getStore();
    if (!scope?.active || scope.key !== partnerId) throw new PartnerStoreError("PARTNER_INVALID", "Package installation requires its active management owner.");
    const profile = this.#store.getPartner(partnerId);
    if (profile.lifecycle !== "active") throw new PartnerStoreError("PARTNER_CHANGED", "The package Partner is unavailable.");
    const home = await this.#writeHome(profile);
    await this.#prepareAvatar({ partner: profile, homePath: home });
    return home;
  }

  async #createPartner(input: CreatePartnerInput, acceptedImport: boolean, assertCurrent?: () => void): Promise<PartnerProfileRecord> {
    if (!PARTNER_TEMPLATES.some((template) => template.templateId === input.templateId)) {
      throw new PartnerManagerError("PARTNER_TEMPLATE_INVALID", "The selected partner template is unavailable.");
    }
    await assertAvatar(input.avatar);
    assertCurrent?.();
    if (input.capabilities.permissionMode === "bypassPermissions") this.#validateCapabilities(input.capabilities);
    const existing = this.#store.getPartnerCreation(input.requestId);
    const created = acceptedImport ? this.#store.createImportedPartner(input) : this.#store.createPartner(input, this.#followingDefaults());
    if (existing !== undefined) return created;
    return this.#serialized(created.id, () => this.#initializeCurrent(created.id));
  }

  async updatePartner(
    partnerId: string,
    expectedRevision: bigint,
    patch: PartnerPatch,
    assertCurrent?: () => void,
    modelOnlyDefaults = false
  ): Promise<PartnerProfileRecord> {
    return this.#serialized(partnerId, async () => {
      const current = this.#store.getPartner(partnerId);
      if (current.revision !== expectedRevision) {
        throw new PartnerStoreError("PARTNER_CHANGED", `Partner ${partnerId} changed; read it again and retry.`);
      }
      if (patch.avatar !== undefined) await assertAvatar(patch.avatar);
      const usesDefaults = patch.usesDirectoryDefaults ?? current.usesDirectoryDefaults;
      if (usesDefaults && patch.capabilities !== undefined) {
        throw new PartnerStoreError("PARTNER_INVALID", "A partner using directory defaults cannot also provide capability overrides.");
      }
      const capabilities = usesDefaults
        ? this.#effectiveDefaults(current, modelOnlyDefaults)
        : patch.capabilities ?? current.capabilities;
      if (capabilities === undefined) {
        throw new PartnerManagerError("PARTNER_MODEL_UNAVAILABLE", "Partner directory defaults are not configured.");
      }
      if (!(capabilities.modelChain.length === 0 && patch.capabilities === undefined && current.canonicalSessionId === undefined)) this.#validateCapabilities(capabilities);
      if (current.canonicalSessionId !== undefined && capabilities.modelChain.some(route => !this.#homeRouteAvailable(this.#operationalStore.getTarget(current.homeTargetId).descriptor, route))) throw modelUnavailable();
      if (capabilities.permissionMode === "bypassPermissions" && current.canonicalSessionId !== undefined) {
        this.#assertFullAccessTarget(current);
      }
      const taskModel = patch.taskModelOverride === null ? undefined : patch.taskModelOverride ?? current.taskModelOverride;
      if (taskModel !== undefined && (JSON.stringify(taskModel) !== JSON.stringify(current.taskModelOverride)
        || capabilities.permissionMode !== current.capabilities.permissionMode || capabilities.planMode !== current.capabilities.planMode)) {
        this.#validateCapabilities({ ...capabilities, modelChain: [taskModel] });
        if (!this.#homeRouteAvailable(this.#operationalStore.getTarget(current.homeTargetId).descriptor, taskModel)) throw modelUnavailable();
      }
      assertCurrent?.();
      const updated = this.#store.updatePartner(partnerId, expectedRevision, patch, usesDefaults ? capabilities : undefined);
      return this.#initializeCurrent(updated.id);
    });
  }

  async setLifecycle(
    partnerId: string,
    expectedRevision: bigint,
    lifecycle: PartnerLifecycle
  ): Promise<PartnerProfileRecord> {
    return this.#serialized(partnerId, async () => {
      if (lifecycle === "paused") {
        const pause = this.#store.claimPartnerPause(partnerId, expectedRevision);
        await this.#advancePause(pause); return this.#store.getPartner(partnerId);
      }
      const current = this.#store.getPartner(partnerId);
      if (current.lifecycle === "paused" && lifecycle === "active") {
        if (current.revision !== expectedRevision) throw new PartnerStoreError("PARTNER_CHANGED", "Partner changed. Refresh before resuming.");
        return this.#resumePaused(this.#store.getPartnerPause(partnerId)!);
      }
      const updated = this.#store.setLifecycle(partnerId, expectedRevision, lifecycle);
      await this.#routineLifecycle?.(partnerId, updated.lifecycle);
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

  async runOwnedManagement<T>(partnerId: string, expectedRevision: bigint, action: () => Promise<T>): Promise<T> {
    return this.#serialized(partnerId, async () => {
      const partner = this.#store.getPartner(partnerId);
      if (partner.revision !== expectedRevision) throw new PartnerStoreError("PARTNER_CHANGED", "Partner changed. Refresh before continuing.");
      if (partner.lifecycle !== "active" || partner.initializationState !== "ready"
        || this.#store.listPendingPartnerRestarts().some(restart => restart.partnerId === partnerId)) {
        throw new PartnerStoreError("PARTNER_INVALID", "Partner is unavailable for management.");
      }
      return action();
    });
  }

  /** One import pass shares the profile mutation lane with edits, pause and deletion. */
  async runImportManagement<T>(partnerId: string, action: () => Promise<T>): Promise<T> {
    return this.#serialized(partnerId, async () => {
      const scope = { key: partnerId, active: true };
      try { return await this.#importScope.run(scope, action); }
      finally { scope.active = false; }
    });
  }

  async #advancePause(pause: PartnerPauseRecord): Promise<void> {
    if (pause.phase !== "closing") return;
    if (this.#pauseFlights.has(pause.partnerId)) throw new PartnerStoreError("PARTNER_CHANGED", "Partner shutdown is still settling. Refresh before retrying.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const task = this.#finishPause(pause).finally(() => { if (this.#pauseFlights.get(pause.partnerId) === task) this.#pauseFlights.delete(pause.partnerId); });
    this.#pauseFlights.set(pause.partnerId, task);
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new PartnerStoreError("PARTNER_CHANGED", "Partner shutdown is still awaiting confirmation.")), 30_000); });
    try { await Promise.race([task, timeout]); }
    catch {
      if (this.#store.getPartnerPause(pause.partnerId)?.id === pause.id) this.#store.recordPartnerPauseFailure(pause.partnerId, pause.id);
      throw new PartnerStoreError("PARTNER_CHANGED", "Partner shutdown is pending. Refresh or resume explicitly to continue cleanup.");
    } finally { clearTimeout(timer); }
  }

  async #finishPause(initial: PartnerPauseRecord): Promise<void> {
    let pause = this.#store.getPartnerPause(initial.partnerId)!;
    const assertCurrent = () => {
      if (this.#store.getPartner(pause.partnerId).lifecycle !== "paused" || this.#store.getPartnerPause(pause.partnerId)?.id !== pause.id) {
        throw new PartnerStoreError("PARTNER_CHANGED", "Partner shutdown owner changed.");
      }
    };
    assertCurrent();
    if (!pause.captured) {
      await Promise.allSettled(pause.delegationIds.map(id => this.#locks.get(`delegation:${id}`)).filter((value): value is Promise<void> => value !== undefined));
      assertCurrent();
      const sessions = new Set(this.listSessions(pause.partnerId, true).map(value => value.link.sessionId));
      for (const id of this.#ownedIndependentSessions?.(pause.partnerId) ?? []) sessions.add(id);
      for (const id of pause.delegationIds) { const delegated = this.#store.getDelegation(id); if (delegated.childSessionId) sessions.add(delegated.childSessionId); }
      pause = this.#store.capturePartnerPause(pause.partnerId, pause.id, [...sessions].sort()
        .filter(sessionId => {
          try { this.#operationalStore.getSession(sessionId); return true; }
          catch (error) { if (error instanceof NotFoundError) return false; throw error; }
        })
        .map(sessionId => ({ sessionId, wasQueuePaused: this.#operationalStore.getQueueControl(sessionId).paused, closeCompleted: false })));
    }
    for (const session of pause.sessions) {
      if (session.wasQueuePaused || session.queuePauseRevision !== undefined) continue;
      const queuePauseRevision = this.#sessionHost.preparePartnerPauseQueue({ sessionId: session.sessionId,
        operationId: `partner-pause:${pause.id}:${session.sessionId}`, wasQueuePaused: session.wasQueuePaused });
      pause = this.#store.advancePartnerPauseSession(pause.partnerId, pause.id, { sessionId: session.sessionId,
        ...(queuePauseRevision === undefined ? {} : { queuePauseRevision }) });
    }
    // Closing the native handles can unblock routine cancellation; both owners settle before the paused checkpoint.
    const results = await Promise.allSettled([
      this.#routineLifecycle?.(pause.partnerId, "paused") ?? Promise.resolve(),
      (async () => {
        for (const session of pause.sessions) {
          if (session.closeCompleted) continue;
          assertCurrent();
          await this.#sessionHost.pausePartnerSession({ sessionId: session.sessionId, operationId: `partner-pause:${pause.id}:${session.sessionId}`,
            cancelQueued: pause.delegationIds.some(id => this.#store.getDelegation(id).childSessionId === session.sessionId)
              || this.#ownedIndependentSessions?.(pause.partnerId).includes(session.sessionId) === true,
            assertCurrent, pauseGoal: () => this.#pauseGoal?.(session.sessionId, `partner-pause:${pause.id}:${session.sessionId}:goal`) ?? Promise.resolve() });
          assertCurrent(); this.#store.advancePartnerPauseSession(pause.partnerId, pause.id, { sessionId: session.sessionId, closeCompleted: true });
        }
      })()
    ]);
    if (results.some(result => result.status === "rejected")) throw new PartnerStoreError("PARTNER_CHANGED", "Partner shutdown is still pending.");
    assertCurrent(); this.#store.settlePartnerPause(pause.partnerId, pause.id);
  }

  async #resumePaused(initial: PartnerPauseRecord): Promise<PartnerProfileRecord> {
    if (initial.phase === "closing") await this.#advancePause(initial);
    const pause = this.#store.preparePartnerResume(initial.partnerId, initial.id);
    try {
      await this.#preparePausedProfile(this.#store.getPartner(pause.partnerId));
      await this.#routineLifecycle?.(pause.partnerId, "active");
      for (const session of pause.sessions) this.#sessionHost.restorePartnerQueue({ sessionId: session.sessionId,
        operationId: `partner-pause:${pause.id}:${session.sessionId}`, ...(session.queuePauseRevision === undefined ? {} : { queuePauseRevision: session.queuePauseRevision }) });
      const resumed = this.#store.finishPartnerResume(pause.partnerId, pause.id);
      await this.#resumeIndependentReturns?.(pause.partnerId);
      for (const session of pause.sessions) { try { this.#sessionHost.wakePartnerSession(session.sessionId); } catch { /* A retained historical task need not reactivate. */ } }
      return resumed;
    } catch {
      this.#store.recordPartnerPauseFailure(pause.partnerId, pause.id);
      throw new PartnerStoreError("PARTNER_CHANGED", "Partner resume is pending. Refresh and resume explicitly to continue.");
    }
  }

  restartControls(partnerId: string): { readonly revision: bigint; readonly available: boolean } {
    const partner = this.#store.getPartner(partnerId);
    return { revision: partner.revision, available: partner.lifecycle === "active" && partner.canonicalSessionId !== undefined
      && this.#sessionHost.canRestartPartnerSession(partner.canonicalSessionId) };
  }

  listPendingRestarts(): readonly PartnerRestartRecord[] { return this.#store.listPendingPartnerRestarts(); }
  getRestart(requestId: string): PartnerRestartRecord | undefined { return this.#store.getPartnerRestart(requestId); }
  isRestartRetired(requestId: string): boolean { return this.#store.isPartnerRestartRetired(requestId); }
  retireRestart(requestId: string): PartnerRestartRecord | undefined { return this.#store.retirePartnerRestart(requestId); }

  async restartPartner(input: { readonly requestId: string; readonly partnerId: string;
    readonly expectedRevision: bigint }): Promise<PartnerRestartRecord> {
    return this.#serialized(input.partnerId, async () => {
      const existing = this.#store.getPartnerRestart(input.requestId);
      if (existing !== undefined) {
        if (existing.partnerId !== input.partnerId) throw new PartnerStoreError("PARTNER_INVALID", "The restart belongs to another partner.");
        return existing;
      }
      const partner = this.#store.getPartner(input.partnerId);
      if (!this.restartControls(partner.id).available || partner.canonicalSessionId === undefined) {
        throw new PartnerStoreError("PARTNER_INVALID", "The partner runtime cannot be restarted right now.");
      }
      const binding = this.#operationalStore.getSession(partner.canonicalSessionId).descriptor.binding;
      const restart = this.#store.claimPartnerRestart({ ...input, sourceGeneration: binding.generation,
        sourceBindingFingerprint: createHash("sha256").update(binding.opaqueRef).digest("hex") });
      return this.#advanceRestart(restart);
    });
  }

  async retryRestart(requestId: string): Promise<PartnerRestartRecord> {
    const current = this.#store.getPartnerRestart(requestId);
    if (current === undefined) throw new PartnerStoreError("PARTNER_NOT_FOUND", "The partner restart was not found.");
    return this.#serialized(current.partnerId, () => this.#advanceRestart(current));
  }

  async #advanceRestart(initial: PartnerRestartRecord): Promise<PartnerRestartRecord> {
    const restart = this.#store.getPartnerRestart(initial.requestId)!;
    if (restart.phase === "ready") return restart;
    const operationId = `partner-restart:${createHash("sha256").update(restart.requestId).digest("hex")}`;
    const assertCurrent = () => {
      const current = this.#store.getPartnerRestart(restart.requestId);
      const partner = this.#store.getPartner(restart.partnerId);
      const session = this.#operationalStore.getSession(restart.sessionId).descriptor;
      if (current?.phase !== "closing" || partner.lifecycle !== "active"
        || partner.canonicalSessionId !== restart.sessionId || partner.revision !== restart.profileRevision
        || session.archived || session.deletedAt !== undefined || session.binding.generation !== restart.sourceGeneration
        || createHash("sha256").update(session.binding.opaqueRef).digest("hex") !== restart.sourceBindingFingerprint) {
        throw new PartnerStoreError("PARTNER_CHANGED", "The runtime restart no longer owns this canonical Session.");
      }
    };
    try {
      assertCurrent();
      await this.#sessionHost.restartPartnerSession({ sessionId: restart.sessionId, operationId, assertCurrent,
        pauseGoal: () => this.#pauseGoal?.(restart.sessionId, `${operationId}:goal`) ?? Promise.resolve() });
      assertCurrent();
      return this.#store.settlePartnerRestart(restart.requestId, true);
    } catch { return this.#store.settlePartnerRestart(restart.requestId, false); }
  }

  listPendingDeletions(): readonly PartnerDeletionRecord[] { return this.#store.listPendingPartnerDeletions(); }
  getDeletion(requestId: string): PartnerDeletionRecord | undefined { return this.#store.getPartnerDeletion(requestId); }
  isDeletionRetired(requestId: string): boolean { return this.#store.isPartnerDeletionRetired(requestId); }
  retireDeletion(requestId: string): PartnerDeletionRecord | undefined { return this.#store.retirePartnerDeletion(requestId); }

  async deletePartner(input: { readonly requestId: string; readonly partnerId: string;
    readonly expectedRevision: bigint; readonly confirmName: string }): Promise<PartnerDeletionRecord> {
    return this.#serialized(input.partnerId, async () => {
      const existing = this.#store.getPartnerDeletion(input.requestId);
      if (existing) {
        if (existing.partnerId !== input.partnerId) throw new PartnerStoreError("PARTNER_INVALID", "The deletion request belongs to another partner.");
        return existing;
      }
      const pause = this.#store.getPartnerPause(input.partnerId);
      if (pause?.phase === "closing") await this.#advancePause(pause);
      if (this.#pauseFlights.has(input.partnerId)) throw new PartnerStoreError("PARTNER_CHANGED", "The previous shutdown is still settling.");
      const deletion = this.#store.claimPartnerDeletion(input);
      return this.#advanceDeletion(deletion);
    });
  }

  async retryDeletion(requestId: string): Promise<PartnerDeletionRecord> {
    const deletion = this.#store.getPartnerDeletion(requestId);
    if (!deletion) throw new PartnerStoreError("PARTNER_NOT_FOUND", "The partner deletion was not found.");
    return this.#serialized(deletion.partnerId, () => this.#advanceDeletion(deletion));
  }

  async #advanceDeletion(initial: PartnerDeletionRecord): Promise<PartnerDeletionRecord> {
    let deletion = this.#store.getPartnerDeletion(initial.requestId)!;
    if (deletion.phase === "completed") return deletion;
    try {
      await this.#routineLifecycle?.(deletion.partnerId, "deleted");
      await this.#prepareImportDeletion?.(deletion.partnerId);
      this.#retireWorkbench?.(deletion.partnerId, deletion.homeTargetId);
      this.#workspaceService.unregister(deletion.homeTargetId);
      try {
        const target = this.#operationalStore.getTarget(deletion.homeTargetId);
        if (target.descriptor.trusted) this.#operationalStore.upsertTarget({ ...target.descriptor, trusted: false }, target.metadata);
      } catch (error) { if (!(error instanceof NotFoundError)) throw error; }
      if (deletion.phase === "closing") {
        await Promise.allSettled(this.#store.listDelegations(deletion.partnerId).map((entry) => this.#locks.get(`delegation:${entry.id}`))
          .filter((entry): entry is Promise<void> => entry !== undefined));
        await this.#sessionHost.quiescePartnerTargetCreations(deletion.homeTargetId);
        deletion = this.#store.extendPartnerDeletionSessions(deletion.requestId,
          this.#operationalStore.listSessions({ targetId: deletion.homeTargetId, includeArchived: true, includeDeleted: true })
            .map((session) => session.descriptor.id).concat(this.#ownedIndependentSessions?.(deletion.partnerId) ?? []));
        for (const sessionId of deletion.sessionIds) {
          try { this.#operationalStore.getSession(sessionId); }
          catch (error) { if (error instanceof NotFoundError) continue; throw error; }
          const operationId = `partner-retirement:${createHash("sha256").update(`${deletion.requestId}\n${sessionId}`).digest("hex")}`;
          await this.#sessionHost.retirePartnerSession(sessionId, operationId);
        }
        deletion = this.#store.advancePartnerDeletion(deletion.requestId);
      }
      await this.#removeHome(deletion.partnerId);
      this.#forgetIndependentTasks?.(deletion.partnerId);
      return this.#store.completePartnerDeletion(deletion.requestId);
    } catch {
      return this.#store.recordPartnerDeletionFailure(deletion.requestId,
        deletion.phase === "closing" ? "runtime_close_pending" : "home_cleanup_pending");
    }
  }

  async #removeHome(partnerId: string): Promise<void> {
    let rootInfo;
    try { rootInfo = await lstat(this.#homesRoot); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("The managed home root changed.");
    const root = await realpath(this.#homesRoot);
    if (!samePath(root, this.#homesRoot)) throw new Error("The managed home root changed.");
    const home = join(root, partnerHomeDirectoryName(partnerId));
    let info;
    try { info = await lstat(home); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The managed home is not a directory.");
    const canonical = await realpath(home);
    if (!samePath(canonical, home) || !samePath(dirname(canonical), root)) throw new Error("The managed home escaped its root.");
    await rm(canonical, { recursive: true, force: true });
  }

  async updateDirectoryDefaults(
    expectedDirectoryRevision: bigint,
    capabilities: PartnerCapabilitiesRecord
  ): Promise<readonly PartnerProfileRecord[]> {
    this.#validateCapabilities(capabilities);
    if (capabilities.permissionMode === "bypassPermissions") {
      for (const profile of this.#store.listPartners().filter(profile => profile.usesDirectoryDefaults && profile.canonicalSessionId !== undefined)) {
        this.#assertFullAccessTarget(profile);
      }
    }
    const affected = this.#store.setDirectoryDefaults(expectedDirectoryRevision, capabilities);
    const reconciled: PartnerProfileRecord[] = [];
    for (const partner of affected) {
      reconciled.push(await this.#serialized(partner.id, () => this.#initializeCurrent(partner.id)));
    }
    return reconciled;
  }

  #followingDefaults(current?: PartnerProfileRecord): PartnerCapabilitiesRecord | undefined {
    const route = this.#appDefaultModel?.();
    return route === undefined ? undefined : { modelChain: [route], permissionMode: current?.capabilities.permissionMode ?? "ask", planMode: current?.capabilities.planMode ?? false };
  }
  #effectiveDefaults(current: PartnerProfileRecord, modelOnly: boolean): PartnerCapabilitiesRecord | undefined {
    const defaults = this.#store.directoryState().defaultCapabilities ?? this.#followingDefaults(current);
    return defaults === undefined ? undefined : modelOnly ? { ...current.capabilities, modelChain: defaults.modelChain } : defaults;
  }
  async followAppDefaultModel(): Promise<void> {
    if (this.#store.directoryState().defaultCapabilities !== undefined) return;
    for (const profile of this.#store.listPartners().filter(item => item.usesDirectoryDefaults)) {
      await this.#serialized(profile.id, async () => {
        const current = this.#store.getPartner(profile.id);
        if (!current.usesDirectoryDefaults || this.#store.directoryState().defaultCapabilities !== undefined) return;
        const defaults = this.#followingDefaults(current); if (!defaults) return;
        const updated = this.#store.updatePartner(current.id, current.revision, { usesDirectoryDefaults: true }, defaults);
        // Unsupported inherited modes remain visible as initialization errors;
        // a global model change must not silently lower permission or Plan.
        await this.#initializeCurrent(updated.id);
      });
    }
  }

  /** Resume only interrupted work. Explicit failures remain visible until retry. */
  async recoverPending(): Promise<void> {
    for (const pause of this.#store.listPartnerPauses()) {
      await this.#serialized(pause.partnerId, async () => {
        try { if (pause.phase === "resuming") await this.#resumePaused(pause); else await this.#advancePause(pause); }
        catch { /* The durable paused owner remains available for explicit recovery. */ }
      });
    }
    for (const deletion of this.#store.listPendingPartnerDeletions()) {
      await this.#serialized(deletion.partnerId, () => this.#advanceDeletion(deletion));
    }
    for (const partner of this.#store.listPartners({ lifecycle: "active" })) {
      if (partner.initializationState !== "pending") continue;
      await this.#serialized(partner.id, () => this.#initializeCurrent(partner.id));
    }
    for (const message of this.#store.listPendingPrivateMessages()) {
      try {
        this.#deliverPrivateMessage(message);
      } catch {
        // Keep the durable pending reservation. A later explicit recovery or
        // partner action can replay the same Operation without duplicating it.
      }
    }
    for (const delegation of this.#store.listRecoverableDelegations()) {
      await this.#serialized(`delegation:${delegation.id}`, () => this.#reconcileDelegation(delegation.id));
    }
  }

  async retryPendingPrivateMessages(): Promise<void> {
    for (const message of this.#store.listPendingPrivateMessages()) {
      try {
        this.#deliverPrivateMessage(message);
      } catch {
        // Offline or unavailable targets remain explicitly pending.
      }
    }
  }

  #deliverPrivateMessage(message: PartnerPrivateMessageRecord): PartnerPrivateMessageRecord {
    if (message.deliveryStatus !== "pending") return message;
    const sender = this.#store.getPartner(message.senderPartnerId);
    const recipient = this.#store.getPartner(message.recipientPartnerId);
    if (recipient.lifecycle !== "active" || recipient.initializationState !== "ready"
      || recipient.canonicalSessionId !== message.recipientSessionId) {
      throw new PartnerManagerError(
        "PARTNER_DELIVERY_UNAVAILABLE",
        "The target partner canonical task changed before delivery."
      );
    }
    const prompt = [
      `[Private message from partner ${JSON.stringify(sender.displayName)} (${sender.id})]`,
      `Handle this in the current canonical task. Reply only when useful by calling send_private_message with target_partner_id=${JSON.stringify(sender.id)}. Do not send acknowledgement-only replies.`,
      "<partner_message>",
      message.content,
      "</partner_message>"
    ].join("\n\n");
    const execution = this.#sessionHost.enqueueServiceInput({
      operationId: message.operationId,
      sessionId: message.recipientSessionId,
      prompt: servicePrompt(prompt),
      source: "system",
      originSessionId: message.senderSessionId,
      partnerPrivateOrigin: {
        messageId: message.id, threadId: message.threadId,
        senderPartnerId: message.senderPartnerId, recipientPartnerId: message.recipientPartnerId,
        senderDisplayName: sender.displayName
      }
    });
    return this.#store.markPrivateMessageDelivered(message.id, execution.value.runId);
  }

  async #resumeDelegation(delegationId: string): Promise<PartnerDelegationRecord> {
    let current = this.#store.getDelegation(delegationId);
    if (isTerminalDelegation(current.status)) return current;
    const target = this.#store.getPartner(current.targetPartnerId);
    if (target.lifecycle !== "active" || target.initializationState !== "ready") {
      return this.#store.transitionDelegation({
        delegationId: current.id,
        expectedRevision: current.revision,
        status: "failed",
        errorText: "The target partner is inactive or unavailable."
      });
    }
    const snapshot = this.#store.listProfileVersions(target.id)
      .find((version) => version.version === current.targetProfileVersion);
    if (snapshot === undefined) {
      return this.#store.transitionDelegation({
        delegationId: current.id,
        expectedRevision: current.revision,
        status: "failed",
        errorText: "The target partner profile snapshot is unavailable."
      });
    }
    try {
      if (current.childSessionId === undefined) {
        const primary = snapshot.capabilities.modelChain[0]!;
        const execution = await this.#sessionHost.createServiceSession({
          operationId: current.createOperationId,
          serviceKind: "partner",
          targetId: target.homeTargetId,
          ...(primary.backendId === this.#operationalStore.getTarget(target.homeTargetId).descriptor.backendId ? {} : { runtimeBackendId: primary.backendId }),
          title: `${target.displayName}: ${current.title}`,
          providerId: primary.providerId,
          modelId: primary.modelId,
          ...(primary.effort === undefined ? {} : { effort: primary.effort }),
          fastMode: primary.fastMode,
          permissionMode: snapshot.capabilities.permissionMode,
          planMode: snapshot.capabilities.planMode,
          appendSystemPrompt: snapshot.identitySource
        });
        current = this.#store.bindDelegationSession(
          current.id,
          current.revision,
          execution.value.sessionId
        );
      }
      if (current.runId === undefined) {
        const requester = this.#store.getPartner(current.requesterPartnerId);
        const prompt = [
          `[Delegated task from partner ${JSON.stringify(requester.displayName)} (${requester.id})]`,
          "Complete this objective as an independent visible task. Report a concise result in this task and preserve useful artifacts through the normal Artifact boundary.",
          "<delegated_objective>",
          current.objective,
          "</delegated_objective>"
        ].join("\n\n");
        const execution = this.#sessionHost.enqueueServiceInput({
          operationId: current.enqueueOperationId,
          sessionId: current.childSessionId!,
          prompt: servicePrompt(prompt),
          source: "system",
          originSessionId: current.parentSessionId
        });
        current = this.#store.transitionDelegation({
          delegationId: current.id,
          expectedRevision: current.revision,
          status: "queued",
          runId: execution.value.runId
        });
      }
      return this.#reconcileDelegation(current.id);
    } catch (error) {
      current = this.#store.getDelegation(current.id);
      if (isTerminalDelegation(current.status)) return current;
      return this.#store.transitionDelegation({
        delegationId: current.id,
        expectedRevision: current.revision,
        status: "unknown",
        errorText: publicFailureText(error, "Delegation dispatch could not be confirmed.")
      });
    }
  }

  async #reconcileDelegation(delegationId: string): Promise<PartnerDelegationRecord> {
    let current = this.#store.getDelegation(delegationId);
    if (isTerminalDelegation(current.status)) return current;
    if (current.childSessionId === undefined || current.runId === undefined) {
      return this.#resumeDelegation(current.id);
    }
    try {
      const run = this.#operationalStore.getRun(current.runId).descriptor;
      const status = run.state === "queued"
        ? "queued"
        : run.state === "running" || run.state === "retrying"
          ? "running"
          : run.state === "waiting"
            ? "waiting"
            : run.state === "completed"
              ? "completed"
              : run.state === "aborted"
                ? "cancelled"
                : run.state === "failed"
                  ? "failed"
                  : "unknown";
      if (status === current.status && status !== "completed" && status !== "failed") return current;
      current = this.#store.transitionDelegation({
        delegationId: current.id,
        expectedRevision: current.revision,
        status,
        ...(status === "completed" ? { resultSummary: this.#delegationResult(current.childSessionId) } : {}),
        ...(status === "failed" ? {
          errorText: run.error?.message ?? "The delegated task failed."
        } : {})
      });
      return current;
    } catch (error) {
      current = this.#store.getDelegation(current.id);
      if (isTerminalDelegation(current.status)) return current;
      if (current.status === "unknown") return current;
      return this.#store.transitionDelegation({
        delegationId: current.id,
        expectedRevision: current.revision,
        status: "unknown",
        errorText: publicFailureText(error, "Delegation state could not be confirmed.")
      });
    }
  }

  #delegationView(delegation: PartnerDelegationRecord): PartnerDelegationView {
    return {
      delegation,
      artifactCount: delegation.childSessionId === undefined
        ? 0
        : this.#operationalStore.countArtifacts({ sessionId: delegation.childSessionId })
    };
  }

  #delegationResult(sessionId: string): string {
    const event = this.#latestAssistantReply(sessionId);
    if (event?.payload.type !== "message_complete") return "The delegated task completed without a text summary.";
    const text = event.payload.blocks
      .filter((block): block is Extract<(typeof event.payload.blocks)[number], { readonly kind: "text" }> => block.kind === "text")
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 12_000);
    return text || "The delegated task completed without a text summary.";
  }

  #latestAssistantReply(sessionId: string, publicOnly = false): PersistedEvent | undefined {
    let beforeCursor: bigint | undefined;
    for (;;) {
      const page = this.#operationalStore.listEvents({
        sessionId,
        ...(beforeCursor === undefined ? {} : { beforeCursor }),
        order: "desc",
        limit: 1_000
      });
      const reply = page.find((event) =>
        event.payload.type === "message_complete" && event.payload.role === "assistant"
        && (!publicOnly || event.payload.partnerPrivateOrigin === undefined));
      if (reply !== undefined || page.length < 1_000) return reply;
      beforeCursor = page.at(-1)!.globalCursor;
    }
  }

  async #initializeCurrent(partnerId: string): Promise<PartnerProfileRecord> {
    let current = this.#store.getPartner(partnerId);
    if (current.lifecycle === "paused") { await this.#preparePausedProfile(current); return this.#store.getPartner(partnerId); }
    if (current.lifecycle !== "active" || current.initializationState === "ready") return current;
    if (current.canonicalSessionId !== undefined) {
      try { await this.#sessionHost.retryPartnerPolicyRetirement(current.canonicalSessionId); }
      catch { return this.#recordFailure(current, "session_unavailable"); }
    }

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
      const target = this.#target(current, primary.backendId, homePath);
      await this.#workspaceService.register({
        id: current.homeTargetId,
        root: target.remoteWorkspace?.workspaceRoot ?? target.workspaceRoot,
        displayName: `${current.displayName} home`,
        trusted: true,
        ...(target.remoteWorkspace === undefined ? {} : { remote: { targetId: target.id, binding: target.remoteWorkspace } })
      });
      await this.#sessionHost.registerTarget(target, {
        ...this.#homeMetadata(current.homeTargetId),
        kind: "partner_home",
        partnerId: current.id,
        profileVersion: current.profileVersion,
        workspaceId: current.homeTargetId
      });
      const existing = this.#canonicalSession(current);
      if (existing !== undefined && !existing.replace) {
        await this.#applyCanonicalSettings(current, existing.sessionId);
      } else {
        const execution = await this.#sessionHost.createServiceSession({
          operationId: `partner-session:${current.id}:${current.profileVersion}:${current.revision}`,
          serviceKind: "partner",
          targetId: current.homeTargetId,
          runtimeBackendId: primary.backendId,
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
      const ready = this.#store.markReady(current.id, current.revision);
      if (this.#optionsOnReady) {
        const scope = { key: current.id, active: true };
        try { await this.#importScope.run(scope, () => this.#optionsOnReady!(ready.id)); }
        finally { scope.active = false; }
      }
      return this.#store.getPartner(ready.id);
    } catch (error) {
      const code: PartnerInitializationErrorCode = error instanceof PartnerStoreError
        && (error.code === "PARTNER_CHANGED" || error.code === "PARTNER_SESSION_CONFLICT")
        ? "state_changed"
        : "session_unavailable";
      return this.#recordFailure(current, code);
    }
  }

  #canonicalSession(profile: PartnerProfileRecord): { readonly sessionId: string; readonly replace: boolean; readonly missing?: true } | undefined {
    if (profile.canonicalSessionId === undefined) return undefined;
    let session;
    try {
      session = this.#operationalStore.getSession(profile.canonicalSessionId).descriptor;
    } catch (error) {
      if (error instanceof NotFoundError) return { sessionId: profile.canonicalSessionId, replace: true, missing: true };
      throw error;
    }
    if (session.targetId !== profile.homeTargetId) {
      throw new PartnerStoreError("PARTNER_SESSION_CONFLICT", "The canonical Session no longer belongs to this partner home.");
    }
    return {
      sessionId: session.id,
      replace: session.deletedAt !== undefined || session.archived
    };
  }

  async #preparePausedProfile(profile: PartnerProfileRecord): Promise<void> {
    const pause = this.#store.getPartnerPause(profile.id);
    if (!pause || pause.phase === "closing" || !profile.canonicalSessionId) throw new PartnerStoreError("PARTNER_CHANGED", "Partner shutdown is still pending.");
    const assertCurrent = (): void => {
      const current = this.#store.getPartner(profile.id);
      if (current.lifecycle !== "paused" || current.revision !== profile.revision
        || current.canonicalSessionId !== profile.canonicalSessionId || this.#store.getPartnerPause(profile.id)?.id !== pause.id) {
        throw new PartnerStoreError("PARTNER_CHANGED", "The paused Partner settings owner changed.");
      }
    };
    assertCurrent(); this.#validateCapabilities(profile.capabilities);
    const primary = profile.capabilities.modelChain[0]!;
    const homePath = await this.#writeHome(profile); assertCurrent();
    const target = this.#target(profile, primary.backendId, homePath);
    await this.#workspaceService.register({ id: profile.homeTargetId, root: target.remoteWorkspace?.workspaceRoot ?? target.workspaceRoot,
      displayName: `${profile.displayName} home`, trusted: true,
      ...(target.remoteWorkspace === undefined ? {} : { remote: { targetId: target.id, binding: target.remoteWorkspace } }) }); assertCurrent();
    await this.#sessionHost.registerTarget(target, {
      ...this.#homeMetadata(profile.homeTargetId),
      kind: "partner_home", partnerId: profile.id, profileVersion: profile.profileVersion, workspaceId: profile.homeTargetId
    }); assertCurrent();
    const stored = this.#operationalStore.getSession(profile.canonicalSessionId);
    if (stored.descriptor.targetId !== profile.homeTargetId
      || stored.descriptor.deletedAt !== undefined || stored.descriptor.archived) throw new PartnerStoreError("PARTNER_CHANGED", "The paused Partner canonical task changed.");
    await this.#sessionHost.updateServiceSessionPrompt(profile.canonicalSessionId, profile.identitySource); assertCurrent();
    const latest = this.#operationalStore.getSession(profile.canonicalSessionId);
    if (latest.descriptor.backendId !== primary.backendId) {
      this.#operationalStore.updateSession(profile.canonicalSessionId, { title: profile.displayName,
        permissionMode: profile.capabilities.permissionMode, planMode: profile.capabilities.planMode }, latest.revision);
      const runtime = this.#sessionHost.getSessionRuntimeControl(profile.canonicalSessionId);
      await this.#sessionHost.setSessionRuntimeControl({ sessionId: profile.canonicalSessionId, expectedGeneration: runtime.generation,
        patch: { ...primary } }); assertCurrent(); return;
    }
    const runtime = this.#sessionHost.getSessionRuntimeControl(profile.canonicalSessionId);
    if (runtime.handoffState === "pending") {
      await this.#sessionHost.setSessionRuntimeControl({ sessionId: profile.canonicalSessionId,
        expectedGeneration: runtime.generation, patch: { ...primary } }); assertCurrent();
    }
    this.#operationalStore.updateSession(profile.canonicalSessionId, { title: profile.displayName,
      providerId: primary.providerId, modelId: primary.modelId, effort: primary.effort ?? null, fastMode: primary.fastMode,
      permissionMode: profile.capabilities.permissionMode, planMode: profile.capabilities.planMode }, latest.revision);
  }

  async #applyCanonicalSettings(profile: PartnerProfileRecord, sessionId: string): Promise<void> {
    const primary = profile.capabilities.modelChain[0]!;
    await this.#sessionHost.updateServiceSessionPrompt(sessionId, profile.identitySource);
    const before = this.#operationalStore.getSession(sessionId);
    if (before.descriptor.backendId !== primary.backendId) {
      this.#operationalStore.updateSession(sessionId, { title: profile.displayName, permissionMode: profile.capabilities.permissionMode,
        planMode: profile.capabilities.planMode }, before.revision);
      const runtime = this.#sessionHost.getSessionRuntimeControl(sessionId);
      await this.#sessionHost.setSessionRuntimeControl({ sessionId, expectedGeneration: runtime.generation, patch: { ...primary } });
      return;
    }
    const runtime = this.#sessionHost.getSessionRuntimeControl(sessionId);
    if (runtime.handoffState === "pending") {
      await this.#sessionHost.setSessionRuntimeControl({ sessionId, expectedGeneration: runtime.generation, patch: { ...primary } });
    }
    try {
      const state = await this.#sessionHost.applySessionSettings(sessionId, {
        providerId: primary.providerId,
        modelId: primary.modelId,
        ...(primary.effort === undefined ? {} : { effort: primary.effort }),
        fastMode: primary.fastMode,
        permissionMode: profile.capabilities.permissionMode,
        planMode: profile.capabilities.planMode
      }, { requireNativeObservation: true, reconcileNativePolicy: runtime.handoffState === "pending" });
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
    } catch (error) {
      await this.#sessionHost.retirePartnerPolicyRuntime(sessionId, before.descriptor.binding, () => {
        const owner = this.#store.getPartner(profile.id);
        if (owner.canonicalSessionId !== sessionId || owner.homeTargetId !== profile.homeTargetId || owner.lifecycle === "deleted") {
          throw new PartnerStoreError("PARTNER_CHANGED", "The canonical permission owner changed.");
        }
      });
      throw error;
    }
  }

  #assertFullAccessTarget(profile: PartnerProfileRecord): void {
    const target = this.#operationalStore.getTarget(profile.homeTargetId);
    const metadata = target.metadata as Record<string, unknown>;
    if (!target.descriptor.trusted || !target.descriptor.managed || profile.capabilities.modelChain.some(route => !this.#homeRouteAvailable(target.descriptor, route))
      || metadata?.["kind"] !== "partner_home" || metadata?.["partnerId"] !== profile.id) throw modelUnavailable();
  }
  #homeRouteAvailable(target: TargetDescriptor, route: PartnerModelRouteRecord): boolean {
    return target.remoteWorkspace === undefined || target.remoteWorkspace.kind === "device_peer" && this.#remoteHomeModelAvailable(target.id, route);
  }

  #target(profile: PartnerProfileRecord, backendId: string, homePath: string): TargetDescriptor {
    if (profile.canonicalSessionId !== undefined) {
      try {
        const existing = this.#operationalStore.getTarget(profile.homeTargetId);
        backendId = existing.descriptor.backendId;
        if (existing.descriptor.remoteWorkspace?.kind === "device_peer" && existing.descriptor.managed
          && typeof existing.metadata === "object" && existing.metadata !== null
          && "kind" in existing.metadata && existing.metadata.kind === "partner_home"
          && "partnerId" in existing.metadata && existing.metadata.partnerId === profile.id) {
          return { ...existing.descriptor, displayName: `${profile.displayName} home` };
        }
      }
      catch (error) {
        // A retained profile can recreate a missing home Target only when its old Session is also absent.
        if (!(error instanceof NotFoundError) || this.#canonicalSession(profile)?.missing !== true) throw error;
      }
    }
    return {
      id: profile.homeTargetId,
      backendId,
      displayName: `${profile.displayName} home`,
      workspaceRoot: homePath,
      managed: true,
      trusted: true
    };
  }

  #homeMetadata(targetId: string): Record<string, unknown> {
    try { const metadata = this.#operationalStore.getTarget(targetId).metadata;
      return typeof metadata === "object" && metadata !== null && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {};
    } catch (error) { if (error instanceof NotFoundError) return {}; throw error; }
  }

  #validateCapabilities(capabilities: PartnerCapabilitiesRecord): void {
    if (capabilities.modelChain.length < 1 || capabilities.modelChain.length > 5) throw modelUnavailable();
    const identities = new Set<string>();
    for (const route of capabilities.modelChain) {
      const backendId = route.backendId;
      let backend;
      try { backend = this.#operationalStore.getBackend(backendId).descriptor; } catch { throw modelUnavailable(); }
      if (backend.health === "unavailable" || backend.installationState !== "installed"
        || backend.authenticationState !== "authenticated" && backend.authenticationState !== "not_required") throw modelUnavailable();
      const identity = `${backendId}\0${route.providerId}\0${route.modelId}`;
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
      if (capabilities.modelChain.filter(candidate => candidate.backendId === backendId).length > 1
        && backend.capabilities.get("model.switch")?.supported !== true) throw modelUnavailable();
      if (capabilities.modelChain.some(candidate => candidate.backendId !== backendId)
        && backend.capabilities.get("session.resume")?.supported !== true) throw modelUnavailable();
    const modes = backend.capabilities.get("permission.modes");
    if (modes?.supported !== true || !modes.options?.includes(capabilities.permissionMode)) {
      throw modelUnavailable();
    }
    if (capabilities.planMode && backend.capabilities.get("plan_mode")?.supported !== true) {
      throw modelUnavailable();
    }
    }
  }

  async #writeHome(profile: PartnerProfileRecord): Promise<string> {
    await mkdir(this.#homesRoot, { recursive: true });
    const root = await realpath(this.#homesRoot);
    const directoryName = partnerHomeDirectoryName(profile.id);
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
    const home = this.#homeScope.getStore();
    if (this.#homeChanging(partnerId) && !(home?.active && home.key === partnerId)) {
      throw new PartnerStoreError("PARTNER_CHANGED", "The Partner is changing its execution computer. Wait or recover that change first.");
    }
    const current = this.#importScope.getStore();
    if (current?.active && current.key === partnerId) return action();
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

async function assertAvatar(avatar: PartnerAvatarInput): Promise<void> {
  if (typeof avatar === "string") {
    if (!(PARTNER_AVATAR_PRESETS as readonly string[]).includes(avatar)) {
      throw new PartnerManagerError("PARTNER_AVATAR_INVALID", "The selected partner avatar is unavailable.");
    }
    return;
  }
  const { bytes } = decodePartnerAvatar(avatar?.base64);
  try {
    const { default: sharp } = await import("sharp");
    const decoder = sharp(bytes, { limitInputPixels: 40_000_000, failOn: "warning" });
    const metadata = await decoder.metadata();
    if (!["jpeg", "png", "webp"].includes(metadata.format ?? "") || !metadata.width || !metadata.height
      || metadata.width > 16_384 || metadata.height > 16_384 || (metadata.pages ?? 1) !== 1) throw new Error();
    await decoder.resize(1, 1).raw().toBuffer();
  } catch {
    throw new PartnerManagerError("PARTNER_AVATAR_INVALID", "Select a valid, single-frame PNG, JPEG or WebP Partner image.");
  }
}

function modelUnavailable(): PartnerManagerError {
  return new PartnerManagerError(
    "PARTNER_MODEL_UNAVAILABLE",
    "The selected partner model or capability settings are unavailable."
  );
}

function isTerminalDelegation(status: PartnerDelegationRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function publicFailureText(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message.trim() : "";
  if (text === "") return fallback;
  return text.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 2_000);
}

function servicePrompt(text: string): PromptInput {
  return {
    text,
    images: [],
    files: [],
    mentions: [],
    disposition: "prompt"
  };
}

async function atomicWrite(path: string, content: string | Uint8Array): Promise<void> {
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
