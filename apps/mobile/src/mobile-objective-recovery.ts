import type { MobilePlainStorageDriver } from "./connection-storage";
import { normalizeMobileObjectiveInput, type MobileObjectiveInput } from "./mobile-objective";

export interface MobileObjectiveRecoveryIdentity {
  readonly profileId: string;
  readonly connectionId: string;
  readonly serverId: string;
  readonly sessionId: string;
  readonly generation: string;
}

/** A form draft has no permission to repeat an objective mutation. */
export class MobileObjectiveRecovery {
  constructor(readonly driver: MobilePlainStorageDriver) {}
  async save(identity: MobileObjectiveRecoveryIdentity, input: MobileObjectiveInput): Promise<void> {
    await this.driver.setItem(key(identity), JSON.stringify({ version: 1, identity, input: normalizeMobileObjectiveInput(input) }));
  }
  async read(identity: MobileObjectiveRecoveryIdentity): Promise<MobileObjectiveInput | undefined> {
    const raw = await this.driver.getItem(key(identity));
    if (raw === null) return undefined;
    if (raw.length > 260_000) throw new Error("The objective form draft is invalid.");
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("identity" in value)
      || !("input" in value) || !value.identity || typeof value.identity !== "object") throw new Error("The objective form draft is invalid.");
    for (const field of ["profileId", "connectionId", "serverId", "sessionId", "generation"] as const) {
      if (!(field in value.identity) || (value.identity as Record<string, unknown>)[field] !== identity[field]) {
        // A retired connection or runtime can never donate a form to its replacement.
        return undefined;
      }
    }
    return normalizeMobileObjectiveInput(value.input as MobileObjectiveInput);
  }
  async clear(identity: MobileObjectiveRecoveryIdentity): Promise<void> {
    if (await this.read(identity) !== undefined) await this.driver.removeItem(key(identity));
  }
}
function key(identity: MobileObjectiveRecoveryIdentity): string {
  if (Object.values(identity).some(value => typeof value !== "string" || !value || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value))
    || !/^[1-9][0-9]*$/u.test(identity.generation)) throw new Error("The objective form owner is invalid.");
  return `joko.mobile.objective-form.v1.${encodeURIComponent(identity.profileId)}.${encodeURIComponent(identity.sessionId)}`;
}
