import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { modelPricesWithOverride, modelTokenPricesAt, type ProviderModel } from "@joko/core";
import { RevisionConflictError, StoreError, type OperationalStore } from "@joko/store";
import { providerGroupDefaultMember, type ProviderGroupDirectory, type ProviderGroupDirectorySource, type ProviderGroupMemberStatus } from "./provider-group-directory.js";
import { selectProviderGroupMember } from "./provider-group-scheduler.js";
import type { ProviderGroupQuota } from "./provider-group-quota.js";
import type { SessionRuntimeProfile } from "./session-runtime-control.js";

const CONFIG_KEY = "task-model-groups";
const ROTATION_KEY = "task-model-group-rotation";
const BINDING_KEY = "task-model-group-binding";
const MAX_GROUPS = 32;
const MAX_CANDIDATES = 16;
const MAX_SCHEDULES = 8;
const USD_TO_CNY = 6.7;
const ordinaryAgents: ReadonlySet<string> = new Set(["codex", "claude-agent-sdk-stdio", "pi"]);

export interface TaskModelGroupSource {
  readonly sourceKey: string;
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
}

interface Candidate {
  readonly source: TaskModelGroupSource;
  readonly disabled: boolean;
}

interface Schedule {
  readonly startHour: number;
  readonly endHour: number;
  readonly useGroupId: string;
}

interface Group {
  readonly groupId: string;
  readonly name: string;
  readonly strategy: contract.TaskModelGroupStrategy;
  readonly candidates: readonly Candidate[];
  readonly effortId: string;
  readonly preferVisionWithImages: boolean;
  readonly schedules: readonly Schedule[];
}

interface Configuration {
  readonly revision: bigint;
  readonly groups: readonly Group[];
}

interface Choice {
  readonly source: ProviderGroupDirectorySource;
  readonly reference: TaskModelGroupSource;
  readonly status: ProviderGroupMemberStatus;
  readonly model: ProviderModel;
  readonly cost: number;
}

export interface TaskModelGroupAssignment {
  readonly groupName: string;
  readonly effectiveGroupName: string;
  readonly model: ProviderModel;
  readonly source: ProviderGroupDirectorySource;
  readonly status: ProviderGroupMemberStatus;
  readonly profile: SessionRuntimeProfile;
  assertCurrent(): void;
  bind(sessionId: string, keepRotation?: boolean): void;
}

interface TaskModelGroupBinding {
  readonly groupId: string;
  readonly effectiveGroupId: string;
  readonly revision: string;
  readonly source: TaskModelGroupSource;
  readonly rotationCommitted: boolean;
}

interface ResolveOptions {
  readonly signal: AbortSignal;
  readonly accepts?: (source: ProviderGroupDirectorySource, model: ProviderModel) => boolean;
  readonly lastPicked?: TaskModelGroupSource;
  readonly requireReady?: boolean;
}

export class TaskModelGroups {
  constructor(readonly options: {
    readonly store: OperationalStore;
    readonly directory: ProviderGroupDirectory;
    readonly ownerId: string;
    readonly ownerGeneration: () => string;
    readonly modelEnabled: (backendId: string, providerId: string, modelId: string) => boolean;
    readonly now: () => number;
  }) {}

  get config(): Configuration {
    const saved = this.options.store.findSetting<readonly Group[]>("service", this.options.ownerId, CONFIG_KEY);
    return { revision: saved?.revision ?? 0n, groups: saved?.value ?? [] };
  }

  list(): contract.ListTaskModelGroupsResponse {
    const config = this.config, saved = new Set(config.groups.flatMap(group => group.candidates.map(candidate => candidateKey(candidate.source))));
    const sources = this.options.directory.sources().filter(source => ordinaryAgents.has(source.agentKind));
    return create(contract.ListTaskModelGroupsResponseSchema, { config: wireConfig(config),
      sources: sources.flatMap(source => {
        const available = source.available && (source.kind === "local" || source.remotelyEnabled);
        return source.models.flatMap(model => {
          const usable = available && this.modelEnabled(source, model);
          const reference = { sourceKey: source.key, backendId: source.backendId, providerId: source.providerId, modelId: model.modelId };
          return usable || saved.has(candidateKey(reference)) ? [wireSource(source, model, usable)] : [];
        });
      }) });
  }

  save(expectedRevision: bigint, input: readonly contract.TaskModelGroup[]): contract.TaskModelGroupConfig {
    const groups = parseGroups(input);
    return this.options.store.transaction(store => {
      const current = this.config;
      assertRevision(expectedRevision, current.revision);
      if (JSON.stringify(current.groups) === JSON.stringify(groups)) return wireConfig(current);
      const saved = store.setSetting("service", this.options.ownerId, CONFIG_KEY, groups);
      const rotation = store.findSetting<Record<string, string>>("service", this.options.ownerId, ROTATION_KEY)?.value;
      if (rotation) store.setSetting("service", this.options.ownerId, ROTATION_KEY, Object.fromEntries(
        groups.flatMap(group => {
          const last = rotation[group.groupId];
          return last !== undefined && group.candidates.some(candidate => candidateKey(candidate.source) === last)
            ? [[group.groupId, last]] : [];
        })));
      return wireConfig({ revision: saved.revision, groups });
    });
  }

  async preview(selection: contract.TaskModelGroupSelection, signal: AbortSignal): Promise<contract.PreviewTaskModelGroupResponse> {
    const resolved = await this.resolve(selection, { signal });
    return create(contract.PreviewTaskModelGroupResponseSchema, resolved === undefined ? {} : {
      groupName: resolved.groupName, effectiveGroupName: resolved.effectiveGroupName,
      selected: wireSource(resolved.source, resolved.model, true), effortId: resolved.profile.effort ?? "",
      quotaLimited: resolved.status.quota.limited,
      ...(resolved.status.quota.resetAt === undefined ? {} : { availableAtMs: BigInt(Math.ceil(resolved.status.quota.resetAt)) })
    });
  }

  binding(sessionId: string): TaskModelGroupBinding | undefined {
    return this.options.store.findSetting<TaskModelGroupBinding>("session", sessionId, BINDING_KEY)?.value;
  }

  ownsRoute(sessionId: string, profile: Pick<SessionRuntimeProfile, "backendId" | "providerId" | "modelId"> | undefined): boolean {
    const source = this.binding(sessionId)?.source;
    return source !== undefined && profile !== undefined && profile.backendId === source.backendId
      && profile.providerId === source.providerId && profile.modelId === source.modelId;
  }

  async boundQuota(sessionId: string, signal: AbortSignal): Promise<ProviderGroupQuota | undefined> {
    const reference = this.binding(sessionId)?.source;
    const source = reference && this.options.directory.sources().find(source => source.key === reference.sourceKey
      && source.backendId === reference.backendId && source.providerId === reference.providerId);
    if (!reference || !source) return undefined;
    try {
      const status = await this.options.directory.read(providerGroupDefaultMember(source), {
        agentKind: source.agentKind, modelId: reference.modelId, ownTask: true
      }, signal);
      return status.reachable && status.model !== undefined ? status.quota : undefined;
    } catch {
      signal.throwIfAborted();
      return undefined;
    }
  }

  commitBoundRotation(sessionId: string): void {
    const binding = this.binding(sessionId);
    if (binding === undefined || binding.rotationCommitted) return;
    const store = this.options.store;
    if (this.config.revision.toString() === binding.revision) {
      const current = store.findSetting<Record<string, string>>("service", this.options.ownerId, ROTATION_KEY)?.value ?? {};
      store.setSetting("service", this.options.ownerId, ROTATION_KEY, { ...current, [binding.effectiveGroupId]: candidateKey(binding.source) });
    }
    store.setSetting("session", sessionId, BINDING_KEY, { ...binding, rotationCommitted: true });
  }

  async resolve(selection: contract.TaskModelGroupSelection, options: ResolveOptions): Promise<TaskModelGroupAssignment | undefined> {
    const generation = this.options.ownerGeneration(), config = this.config, now = this.options.now();
    const assertCurrent = () => {
      options.signal.throwIfAborted();
      if (generation !== this.options.ownerGeneration()) throw new StoreError("The model group owner changed.");
      assertRevision(config.revision, this.config.revision);
    };
    assertCurrent();
    assertRevision(selection.expectedRevision, config.revision);
    const original = config.groups.find(group => group.groupId === selection.groupId);
    if (!original) throw new StoreError("The selected model group is no longer available.");
    const group = scheduledGroup(original, config.groups, new Date(now).getHours());
    const sources = this.options.directory.sources();
    const choices = await Promise.all(group.candidates.map(async candidate => {
      if (candidate.disabled) return undefined;
      const reference = candidate.source;
      const source = sources.find(source => source.key === reference.sourceKey
        && source.backendId === reference.backendId && source.providerId === reference.providerId);
      const model = source?.models.find(model => model.modelId === reference.modelId);
      if (!source || !model || !this.modelEnabled(source, model) || options.accepts?.(source, model) === false) return undefined;
      try {
        const status = await this.options.directory.read(providerGroupDefaultMember(source), {
          agentKind: source.agentKind, modelId: reference.modelId, ownTask: true
        }, options.signal);
        if (!status.reachable || !status.model || (!status.available && !status.quota.limited)) return undefined;
        return { source, reference, status, model, cost: group.strategy === contract.TaskModelGroupStrategy.LOWEST_COST
          ? this.cost(source, model, status, now) : Infinity } satisfies Choice;
      } catch {
        options.signal.throwIfAborted();
        return undefined;
      }
    }));
    assertCurrent();
    const rotation = this.options.store.findSetting<Record<string, string>>("service", this.options.ownerId, ROTATION_KEY)?.value;
    // Keep positions of disabled or unavailable members so rotation resumes in list order.
    const last = options.lastPicked === undefined ? rotation?.[group.groupId] : candidateKey(options.lastPicked);
    const picked = pickChoice(group, choices, now, last, selection.hasImages);
    if (!picked || options.requireReady === true && picked.status.quota.limited) return undefined;
    const effort = picked.model.thinkingLevels.includes(group.effortId) ? group.effortId : undefined;
    const assertChoice = () => {
      assertCurrent();
      picked.status.assertCurrent();
      const live = this.options.directory.sources().find(source => source.key === picked.source.key && source.backendId === picked.source.backendId);
      const currentModel = live?.models.find(model => model.modelId === picked.reference.modelId);
      if (!live || !live.available || !currentModel || !this.modelEnabled(live, currentModel) || options.accepts?.(live, currentModel) === false
        || (effort !== undefined && !currentModel.thinkingLevels.includes(effort))) throw new StoreError("The selected model group source changed.");
    };
    return {
      source: picked.source, model: picked.model, status: picked.status, profile: {
        backendId: picked.reference.backendId, providerId: picked.reference.providerId, modelId: picked.reference.modelId,
        ...(effort === undefined ? {} : { effort }), fastMode: false
      }, groupName: original.name, effectiveGroupName: group.name,
      assertCurrent: assertChoice,
      bind: (sessionId, keepRotation = false) => {
        assertChoice();
        this.options.store.setSetting("session", sessionId, BINDING_KEY, {
          groupId: original.groupId, effectiveGroupId: group.groupId, revision: config.revision.toString(),
          source: picked.reference, rotationCommitted: keepRotation
        } satisfies TaskModelGroupBinding);
      }
    };
  }

  private modelEnabled(source: ProviderGroupDirectorySource, model: ProviderModel): boolean {
    return ordinaryAgents.has(source.agentKind) && this.options.modelEnabled(source.backendId, source.providerId, model.modelId);
  }

  private cost(source: ProviderGroupDirectorySource, model: ProviderModel, status: ProviderGroupMemberStatus, at: number): number {
    const quota = status.quota;
    if (quota.pacingWindow || quota.weeklyResetAt !== undefined || quota.fiveHourResetAt !== undefined) return 0;
    if (source.brand === "openai" || source.brand === "anthropic") return Infinity;
    const quote = source.kind === "local"
      ? modelPricesWithOverride(model, this.options.store.findModelPriceOverride(this.options.ownerId, source.backendId, source.providerId, model.modelId), { at })
      : modelTokenPricesAt(model, { at });
    if (quote === undefined || quote.cost.output === undefined) return Infinity;
    const output = quote.cost.output;
    if (quote.currencyCode === "CNY") return output / USD_TO_CNY;
    return quote.currencyCode === "USD" ? output : Infinity;
  }
}

function pickChoice(group: Group, choices: readonly (Choice | undefined)[], now: number, last: string | undefined, hasImages: boolean): Choice | undefined {
  const useVision = hasImages && group.preferVisionWithImages && choices.some(choice => choice?.model.supportsImages);
  const eligible = choices.filter((choice): choice is Choice => choice !== undefined && (!useVision || choice.model.supportsImages));
  const ready = eligible.filter(choice => !choice.status.quota.limited);
  if (ready.length === 0) return eligible.reduce<Choice | undefined>((best, choice) =>
    best === undefined || (choice.status.quota.resetAt ?? Infinity) < (best.status.quota.resetAt ?? Infinity) ? choice : best, undefined);
  switch (group.strategy) {
    case contract.TaskModelGroupStrategy.LOWEST_COST:
      return ready.reduce((best, choice) => choice.cost < best.cost ? choice : best);
    case contract.TaskModelGroupStrategy.ROUND_ROBIN: {
      const lastIndex = group.candidates.findIndex(candidate => candidateKey(candidate.source) === last);
      return ready.find(choice => choices.indexOf(choice) > lastIndex) ?? ready[0];
    }
    case contract.TaskModelGroupStrategy.EXPIRING_QUOTA: {
      const picks = ready.map(({ reference, status }) => ({
        id: candidateKey(reference), available: true, paused: false, running: 0, capacity: 1, weight: 1,
        ...(status.quota.urgency === undefined ? {} : { urgency: status.quota.urgency }),
        ...(status.quota.fiveHourTight === undefined ? {} : { fiveHourTight: status.quota.fiveHourTight })
      }));
      const winner = selectProviderGroupMember(picks, "ordered", { now });
      return ready.find(({ reference }) => candidateKey(reference) === winner);
    }
    default: return ready[0];
  }
}

function scheduledGroup(base: Group, groups: readonly Group[], hour: number): Group {
  const visited = new Set([base.groupId]);
  let effective = base;
  for (;;) {
    const schedule = effective.schedules.find(({ startHour, endHour }) => startHour < endHour
      ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour);
    if (schedule === undefined) return effective;
    const next = groups.find(group => group.groupId === schedule.useGroupId);
    if (next === undefined || visited.has(next.groupId)) return base;
    visited.add(next.groupId);
    effective = next;
  }
}

function candidateKey(source: TaskModelGroupSource): string {
  return JSON.stringify([source.sourceKey, source.backendId, source.providerId, source.modelId]);
}

function assertRevision(expected: bigint, actual: bigint): void {
  if (expected !== actual) throw new RevisionConflictError("Model groups", CONFIG_KEY, expected, actual);
}

function key(value: string, maximum = 512): string {
  if (!value || value !== value.trim() || value.length > maximum || /[\p{Cc}\u2028\u2029]/u.test(value)) {
    throw new StoreError("Invalid model group identity.");
  }
  return value;
}

function parseGroups(input: readonly contract.TaskModelGroup[]): Group[] {
  if (input.length > MAX_GROUPS) throw new StoreError("Too many model groups.");
  const ids = new Set(input.map(group => key(group.groupId, 96)));
  if (ids.size !== input.length || ["__proto__", "constructor", "prototype"].some(id => ids.has(id))) {
    throw new StoreError("Model group identities must be unique and valid.");
  }
  return input.map(group => {
    if (group.candidates.length > MAX_CANDIDATES || group.schedules.length > MAX_SCHEDULES
      || group.strategy < contract.TaskModelGroupStrategy.EXPIRING_QUOTA || group.strategy > contract.TaskModelGroupStrategy.LOWEST_COST) {
      throw new StoreError("Invalid model group configuration.");
    }
    const candidates = group.candidates.map(candidate => {
      const source = candidate.source;
      if (!source) throw new StoreError("A model group candidate requires an exact source.");
      return { source: { sourceKey: key(source.sourceKey), backendId: key(source.backendId),
        providerId: key(source.providerId), modelId: key(source.modelId) }, disabled: candidate.disabled };
    });
    if (new Set(candidates.map(candidate => candidateKey(candidate.source))).size !== candidates.length) {
      throw new StoreError("Model group candidates must be unique.");
    }
    const schedules = group.schedules.map(schedule => {
      if (schedule.startHour > 23 || schedule.endHour > 23 || schedule.startHour === schedule.endHour
        || schedule.useGroupId === group.groupId || !ids.has(schedule.useGroupId)) throw new StoreError("Invalid model group hours.");
      return { startHour: schedule.startHour, endHour: schedule.endHour, useGroupId: schedule.useGroupId };
    });
    return { groupId: group.groupId, name: key(group.name.trim(), 80), strategy: group.strategy, candidates,
      effortId: group.effortId ? key(group.effortId, 64) : "", preferVisionWithImages: group.preferVisionWithImages, schedules };
  });
}

function wireConfig(config: Configuration): contract.TaskModelGroupConfig {
  return create(contract.TaskModelGroupConfigSchema, {
    revision: config.revision,
    groups: config.groups.map(group => ({ ...group, candidates: [...group.candidates], schedules: [...group.schedules] }))
  });
}

function wireSource(source: ProviderGroupDirectorySource, model: ProviderModel, available: boolean): contract.TaskModelGroupSource {
  return create(contract.TaskModelGroupSourceSchema, {
    source: { sourceKey: source.key, backendId: source.backendId, providerId: source.providerId, modelId: model.modelId },
    modelName: model.displayName, providerName: source.providerName, computerName: source.displayName, available, supportsImages: model.supportsImages
  });
}
