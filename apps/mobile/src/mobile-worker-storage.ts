import type { MobilePlainStorageDriver } from "./connection-storage";
import { PermissionMode } from "@joko/contracts";
import { normalizeMobileWorkerForm, type MobileWorkerForm, type MobileWorkerTarget } from "./mobile-collaboration";
import type { MobileModelControlSelection } from "./mobile-runtime-controls";

export interface MobileWorkerFormIdentity {
  readonly profileId: string;
  readonly connectionId: string;
  readonly serverId: string;
  readonly sessionId: string;
  readonly generation: string;
}
interface WorkerPreferences {
  readonly version: 1;
  readonly backendId?: string;
  readonly selections: Readonly<Record<string, { readonly model?: MobileModelControlSelection; readonly permissionMode: PermissionMode }>>;
}

/** Preferences never retain role/task text. Recovery forms never authorize a replay. */
export class MobileWorkerStorage {
  constructor(readonly driver: MobilePlainStorageDriver) {}
  async defaults(profileId: string, targets: readonly MobileWorkerTarget[], initialTargetId: string): Promise<MobileWorkerForm | undefined> {
    const raw = await this.driver.getItem(preferenceKey(profileId));
    let preferences: WorkerPreferences | undefined;
    if (raw !== null) {
      if (raw.length > 100_000) throw new Error("The worker preferences are invalid.");
      const parsed = JSON.parse(raw) as WorkerPreferences;
      if (parsed?.version !== 1 || !parsed.selections || typeof parsed.selections !== "object" || Array.isArray(parsed.selections)) throw new Error("The worker preferences are invalid.");
      preferences = parsed;
    }
    const target = targets.find(value => value.id === initialTargetId && value.backendId === preferences?.backendId)
      ?? targets.find(value => value.backendId === preferences?.backendId) ?? targets.find(value => value.id === initialTargetId) ?? targets[0];
    if (!target) return undefined;
    const preference = preferences?.selections[target.backendId];
    const selection = preference?.model;
    const route = selection && target.models.find(value => value.providerId === selection.providerId && value.modelId === selection.modelId);
    const model = route && typeof selection.fastMode === "boolean"
      ? { providerId: route.providerId, modelId: route.modelId,
        ...(target.canSetEffort && route.efforts.some(value => value.id === selection.effortId) ? { effortId: selection.effortId } : {}),
        fastMode: target.canSetFastMode && route.supportsFastMode && selection.fastMode }
      : target.defaultModel;
    const permissionMode = preference && target.permissionModes.includes(preference.permissionMode) ? preference.permissionMode
      : target.permissionModes.includes(PermissionMode.AUTO) ? PermissionMode.AUTO : target.permissionModes[0]!;
    return { role: "developer", targetId: target.id, permissionMode, initialTask: "", ...(model === undefined ? {} : { model }) };
  }
  async remember(profileId: string, target: MobileWorkerTarget, input: MobileWorkerForm): Promise<void> {
    const form = normalizeMobileWorkerForm(input), raw = await this.driver.getItem(preferenceKey(profileId));
    const old = raw === null ? undefined : JSON.parse(raw) as WorkerPreferences;
    if (old && (old.version !== 1 || !old.selections || typeof old.selections !== "object" || Array.isArray(old.selections))) throw new Error("The worker preferences are invalid.");
    await this.driver.setItem(preferenceKey(profileId), JSON.stringify({ version: 1, backendId: target.backendId,
      selections: { ...old?.selections, [target.backendId]: { permissionMode: form.permissionMode, ...(form.model ? { model: form.model } : {}) } } }));
  }
  async save(identity: MobileWorkerFormIdentity, input: MobileWorkerForm): Promise<void> {
    await this.driver.setItem(formKey(identity), JSON.stringify({ version: 1, identity, input: normalizeMobileWorkerForm(input) }));
  }
  async read(identity: MobileWorkerFormIdentity): Promise<MobileWorkerForm | undefined> {
    const raw = await this.driver.getItem(formKey(identity));
    if (raw === null) return undefined;
    if (raw.length > 270_000) throw new Error("The worker recovery form is invalid.");
    const value = JSON.parse(raw) as { version: number; identity: MobileWorkerFormIdentity; input: MobileWorkerForm };
    if (value?.version !== 1 || !value.identity || typeof value.identity !== "object") throw new Error("The worker recovery form is invalid.");
    if (Object.keys(identity).some(field => value.identity[field as keyof MobileWorkerFormIdentity] !== identity[field as keyof MobileWorkerFormIdentity])) return undefined;
    return normalizeMobileWorkerForm(value.input);
  }
  async clear(identity: MobileWorkerFormIdentity): Promise<void> {
    if (await this.read(identity)) await this.driver.removeItem(formKey(identity));
  }
}
function preferenceKey(profileId: string): string {
  validIdentity(profileId);
  return `joko.mobile.worker-preferences.v1.${encodeURIComponent(profileId)}`;
}
function formKey(identity: MobileWorkerFormIdentity): string {
  Object.values(identity).forEach(validIdentity);
  if (!/^[1-9][0-9]*$/u.test(identity.generation)) throw new Error("The worker form runtime is invalid.");
  return `joko.mobile.worker-form.v1.${encodeURIComponent(identity.profileId)}.${encodeURIComponent(identity.sessionId)}`;
}
function validIdentity(value: string): void {
  if (typeof value !== "string" || !value || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("The worker form owner is invalid.");
}
