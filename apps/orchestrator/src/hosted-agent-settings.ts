import { z } from "zod";
import { RevisionConflictError, type OperationalStore } from "@joko/store";
import { DEFAULT_HOSTED_AGENT_LIMITS, validateHostedAgentLimits, type HostedAgentLimits } from "./hosted-agent-limits.js";

export const HOSTED_AGENT_SETTING_KEY = "settings.hosted_agents";
const id = z.string().min(1).max(512).refine(value => !/[\0\r\n]/u.test(value));
const epoch = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const schema = z.strictObject({ format: z.literal(1), remoteControlEnabled: z.boolean(), generation: epoch,
  providers: z.array(z.strictObject({ backendId: id, providerId: id, enabled: z.boolean(), generation: epoch })).max(10_000),
  limits: z.strictObject({ perDevice: z.number(), total: z.number() }).optional() });
type Value = z.infer<typeof schema>;
export interface HostedAgentSettingsSnapshot { readonly revision: bigint; readonly value: Value }
export type HostedAgentSettingsUpdate =
  | { readonly kind: "remote_control"; readonly enabled: boolean }
  | { readonly kind: "provider"; readonly backendId: string; readonly providerId: string; readonly enabled: boolean }
  | { readonly kind: "limits"; readonly value: HostedAgentLimits }
  | { readonly kind: "reset_limits" };

/** Node-owned opt-in. Sharing and per-Provider settings survive a temporary
 * pause; quotas apply only to new native runtimes, so lowering never kills one. */
export class HostedAgentSettings {
  constructor(readonly store: OperationalStore) { this.snapshot(); }
  snapshot(): HostedAgentSettingsSnapshot {
    const row = this.store.findSetting<unknown>("service", "orchestrator", HOSTED_AGENT_SETTING_KEY);
    if (!row) return { revision: 0n, value: { format: 1, remoteControlEnabled: false, generation: 1, providers: [] } };
    const parsed = schema.safeParse(row.value);
    if (!parsed.success) throw new Error("Hosted Agent settings require current v1 data.");
    const value = parsed.data;
    if (new Set(value.providers.map(provider => JSON.stringify([provider.backendId, provider.providerId]))).size !== value.providers.length) throw new Error("Hosted Agent Provider settings conflict.");
    if (value.limits) validateHostedAgentLimits(value.limits);
    return { revision: row.revision, value };
  }
  limits(): HostedAgentLimits { return this.snapshot().value.limits ?? DEFAULT_HOSTED_AGENT_LIMITS; }
  providerEnabled(backendId: string, providerId: string): boolean {
    const value = this.snapshot().value;
    return value.remoteControlEnabled && value.providers.some(provider => provider.backendId === backendId && provider.providerId === providerId && provider.enabled);
  }
  captureComputer(): () => void {
    const captured = this.snapshot().value; if (!captured.remoteControlEnabled) throw new Error("Remote Agent invocation is disabled on this computer.");
    return () => { const current = this.snapshot().value;
      if (!current.remoteControlEnabled || current.generation !== captured.generation) throw new Error("Remote Agent permission changed on this computer."); };
  }
  captureProvider(backendId: string, providerId: string): () => void {
    const captured = this.snapshot().value.providers.find(provider => provider.backendId === backendId && provider.providerId === providerId);
    if (!captured?.enabled) throw new Error("Remote invocation is disabled for this Provider.");
    return () => { const current = this.snapshot().value.providers.find(provider => provider.backendId === backendId && provider.providerId === providerId);
      if (!current?.enabled || current.generation !== captured.generation) throw new Error("Remote Provider invocation permission changed."); };
  }
  update(update: HostedAgentSettingsUpdate, expectedRevision: bigint): HostedAgentSettingsSnapshot {
    return this.store.transaction(() => {
      const current = this.snapshot(); if (current.revision !== expectedRevision) throw new RevisionConflictError("Setting", HOSTED_AGENT_SETTING_KEY, expectedRevision, current.revision);
      let value: Value = current.value;
      switch (update.kind) {
        case "remote_control":
          if (typeof update.enabled !== "boolean") throw new Error("Remote invocation permission is invalid.");
          if (value.remoteControlEnabled !== update.enabled) value = { ...value, remoteControlEnabled: update.enabled, generation: nextGeneration(value.generation) };
          break;
        case "provider": {
          if (!id.safeParse(update.backendId).success || !id.safeParse(update.providerId).success || typeof update.enabled !== "boolean") throw new Error("Remote Provider permission is invalid.");
          if (update.enabled && !value.remoteControlEnabled) throw new Error("Enable remote control on this computer first.");
          const index = value.providers.findIndex(provider => provider.backendId === update.backendId && provider.providerId === update.providerId), prior = value.providers[index];
          if (prior?.enabled === update.enabled) break;
          const providers = [...value.providers], replacement = { backendId: update.backendId, providerId: update.providerId, enabled: update.enabled, generation: nextGeneration(prior?.generation ?? 0) };
          if (index < 0) providers.push(replacement); else providers[index] = replacement;
          value = { ...value, providers }; break;
        }
        case "limits": value = { ...value, limits: validateHostedAgentLimits(update.value) }; break;
        case "reset_limits": { const { limits: _limits, ...rest } = value; value = rest; break; }
        default: throw new Error("Hosted Agent settings operation is invalid.");
      }
      if (JSON.stringify(value) === JSON.stringify(current.value)) return current;
      const row = this.store.setSetting("service", "orchestrator", HOSTED_AGENT_SETTING_KEY, schema.parse(value));
      return { revision: row.revision, value };
    });
  }
}
function nextGeneration(value: number): number { if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) throw new Error("Remote invocation permission generation is exhausted."); return value + 1; }
