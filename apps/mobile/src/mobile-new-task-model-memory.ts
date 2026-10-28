import type { MobilePlainStorageDriver } from "./connection-storage";
import type { MobileModelControlSelection } from "./mobile-runtime-controls";

export interface MobileNewTaskSourceSelection extends MobileModelControlSelection { readonly backendId: string; }
export interface MobileNewTaskModelMemoryIdentity { readonly profileId: string; readonly serverId: string; readonly nativeAdapterKind: string; }

/** Display memory is partitioned by the saved node and the declared native
 * runtime. It never supplies authority: callers revalidate the current catalog. */
export class MobileNewTaskModelMemory {
  readonly #values = new Map<string, MobileNewTaskSourceSelection>();
  readonly #revisions = new Map<string, number>();
  readonly #writes = new Map<string, Promise<void>>();
  constructor(readonly driver: MobilePlainStorageDriver) {}
  current(identity: MobileNewTaskModelMemoryIdentity): MobileNewTaskSourceSelection | undefined {
    const value = this.#values.get(key(identity)); return value ? { ...value } : undefined;
  }
  async read(identity: MobileNewTaskModelMemoryIdentity): Promise<MobileNewTaskSourceSelection | undefined> {
    const id = key(identity), revision = this.#revisions.get(id) ?? 0;
    const raw = await this.driver.getItem(id);
    if ((this.#revisions.get(id) ?? 0) !== revision) return this.current(identity);
    if (!raw) return this.current(identity);
    const value: unknown = JSON.parse(raw);
    if (!valid(value)) throw new Error("The saved model source selection is invalid.");
    this.#values.set(id, value); return { ...value };
  }
  async save(identity: MobileNewTaskModelMemoryIdentity, selection: MobileNewTaskSourceSelection): Promise<void> {
    if (!valid(selection)) throw new Error("The model source selection is invalid.");
    const id = key(identity), revision = (this.#revisions.get(id) ?? 0) + 1;
    this.#revisions.set(id, revision);
    const writing = (this.#writes.get(id) ?? Promise.resolve()).catch(() => undefined)
      .then(() => this.driver.setItem(id, JSON.stringify(selection)));
    this.#writes.set(id, writing);
    try { await writing; } finally { if (this.#writes.get(id) === writing) this.#writes.delete(id); }
    if (this.#revisions.get(id) === revision) this.#values.set(id, { ...selection });
  }
}
function key(identity: MobileNewTaskModelMemoryIdentity): string {
  if (![identity.profileId, identity.serverId, identity.nativeAdapterKind].every(id)) throw new Error("The model source memory owner is invalid.");
  return `joko.mobile.new-task-model.v1:${encodeURIComponent(JSON.stringify([identity.profileId, identity.serverId, identity.nativeAdapterKind]))}`;
}
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value); }
function valid(value: unknown): value is MobileNewTaskSourceSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every(field => ["backendId", "providerId", "modelId", "effortId", "fastMode"].includes(field))
    && [row["backendId"], row["providerId"], row["modelId"]].every(id)
    && (row["effortId"] === undefined || id(row["effortId"])) && (typeof row["fastMode"] === "boolean" || row["fastMode"] === "ultrafast");
}
