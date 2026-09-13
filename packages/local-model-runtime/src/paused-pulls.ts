import { canonicalModelName } from "./security.js";
import type { PausedModelPull, PausedPullRepository, RuntimeOwnerGeneration } from "./types.js";

function ownerKey(owner: RuntimeOwnerGeneration): string {
  return `${owner.ownerId}\0${owner.generation}`;
}

export class MemoryPausedPullRepository implements PausedPullRepository {
  private readonly records = new Map<string, Map<string, PausedModelPull>>();

  async list(owner: RuntimeOwnerGeneration): Promise<readonly PausedModelPull[]> {
    return [...(this.records.get(ownerKey(owner))?.values() ?? [])];
  }

  async put(record: PausedModelPull): Promise<void> {
    const key = ownerKey({ ownerId: record.ownerId, generation: record.ownerGeneration });
    const ownerRecords = this.records.get(key) ?? new Map<string, PausedModelPull>();
    ownerRecords.set(canonicalModelName(record.name), record);
    this.records.set(key, ownerRecords);
  }

  async remove(owner: RuntimeOwnerGeneration, name: string): Promise<PausedModelPull | undefined> {
    const ownerRecords = this.records.get(ownerKey(owner));
    if (ownerRecords === undefined) return undefined;
    const key = canonicalModelName(name);
    const record = ownerRecords.get(key);
    ownerRecords.delete(key);
    if (ownerRecords.size === 0) this.records.delete(ownerKey(owner));
    return record;
  }
}
