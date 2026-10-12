import { create, toJsonString, type MessageInitShape } from "@bufbuild/protobuf";
import {
  RoutineDefinitionSchema, SavePartnerRoutineRequestSchema, RunPartnerRoutineRequestSchema, DeletePartnerRoutineRequestSchema,
  type RoutineDefinition, type PartnerRoutine, type ListPartnerRoutinesResponse, type ListPartnerRoutineRunsResponse,
  type GetPartnerRoutineCreationResponse, type SavePartnerRoutineResponse, type RetirePartnerRoutineCreationResponse,
  type RunPartnerRoutineResponse, type DeletePartnerRoutineResponse
} from "./gen/joko/v1/partner_routine_pb.js";

export interface PartnerRoutineApi {
  readonly ownerKey: string;
  newRequestId(): string;
  list(signal: AbortSignal): Promise<ListPartnerRoutinesResponse>;
  save(revision: bigint, definition: RoutineDefinition, intent: { readonly requestId: string } | { readonly routine: PartnerRoutine }, signal: AbortSignal): Promise<PartnerRoutine>;
  run(revision: bigint, routine: PartnerRoutine, requestId: string, signal: AbortSignal): Promise<void>;
  remove(revision: bigint, routine: PartnerRoutine, signal: AbortSignal): Promise<void>;
  history(routineId: string, offset: number, signal: AbortSignal): Promise<ListPartnerRoutineRunsResponse>;
  lookup(requestId: string, signal: AbortSignal): Promise<GetPartnerRoutineCreationResponse>;
  retire(requestId: string, signal: AbortSignal): Promise<RetirePartnerRoutineCreationResponse>;
}
interface RoutineRpc {
  listPartnerRoutines(request: { partnerId: string }, options: { signal: AbortSignal }): Promise<ListPartnerRoutinesResponse>;
  savePartnerRoutine(request: MessageInitShape<typeof SavePartnerRoutineRequestSchema>, options: { signal: AbortSignal }): Promise<SavePartnerRoutineResponse>;
  runPartnerRoutine(request: MessageInitShape<typeof RunPartnerRoutineRequestSchema>, options: { signal: AbortSignal }): Promise<RunPartnerRoutineResponse>;
  deletePartnerRoutine(request: MessageInitShape<typeof DeletePartnerRoutineRequestSchema>, options: { signal: AbortSignal }): Promise<DeletePartnerRoutineResponse>;
  listPartnerRoutineRuns(request: { partnerId: string; routineId: string; offset: number }, options: { signal: AbortSignal }): Promise<ListPartnerRoutineRunsResponse>;
  getPartnerRoutineCreation(request: { partnerId: string; requestId: string }, options: { signal: AbortSignal }): Promise<GetPartnerRoutineCreationResponse>;
  retirePartnerRoutineCreation(request: { partnerId: string; requestId: string }, options: { signal: AbortSignal }): Promise<RetirePartnerRoutineCreationResponse>;
}
/** Generated contracts are the sole RPC boundary shared by native and Web clients. */
export function createPartnerRoutineApi(input: { readonly rpc: RoutineRpc; readonly partnerId: string; readonly ownerKey: string;
  readonly newRequestId: () => string; readonly assertCurrent: (signal: AbortSignal) => void }): PartnerRoutineApi {
  const { rpc, partnerId } = input;
  const check = (signal: AbortSignal): void => { signal.throwIfAborted(); input.assertCurrent(signal); };
  const invoke = async <T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> => { check(signal); const result = await action(); check(signal); return result; };
  const routine = (value: PartnerRoutine | undefined): PartnerRoutine => {
    if (!value || value.partnerId !== partnerId || !value.id || !value.revision || value.revision.value < 1n || !value.definition
      || typeof value.definition.enabled !== "boolean" || typeof value.definition.silentWhenIdle !== "boolean") throw new Error("Routine response owner is invalid.");
    return value;
  };
  return { ownerKey: input.ownerKey, newRequestId: input.newRequestId,
    list: signal => invoke(signal, async () => {
      const result = await rpc.listPartnerRoutines({ partnerId }, { signal });
      if (result.partnerId !== partnerId || !result.partnerRevision || result.partnerRevision.value < 1n) throw new Error("Routine catalog owner is invalid.");
      const ids = new Set<string>(); for (const item of result.routines) { routine(item); if (ids.has(item.id)) throw new Error("Routine catalog has duplicate identities."); ids.add(item.id); }
      return result;
    }),
    save: (revision, definition, intent, signal) => invoke(signal, async () => routine((await rpc.savePartnerRoutine({
      partnerId, expectedPartnerRevision: { value: revision }, definition,
      intent: "requestId" in intent ? { case: "creationRequestId", value: intent.requestId } : { case: "routineId", value: routine(intent.routine).id },
      ...("routine" in intent ? { expectedRevision: intent.routine.revision } : {}) }, { signal })).routine)),
    run: (revision, selected, requestId, signal) => invoke(signal, async () => { await rpc.runPartnerRoutine({ partnerId,
      expectedPartnerRevision: { value: revision }, routineId: routine(selected).id, expectedRevision: selected.revision, requestId }, { signal }); }),
    remove: (revision, selected, signal) => invoke(signal, async () => { await rpc.deletePartnerRoutine({ partnerId,
      expectedPartnerRevision: { value: revision }, routineId: routine(selected).id, expectedRevision: selected.revision }, { signal }); }),
    history: (routineId, offset, signal) => invoke(signal, async () => {
      const result = await rpc.listPartnerRoutineRuns({ partnerId, routineId, offset }, { signal });
      if (result.runs.length > 20 || result.runs.some(run => run.routineId !== routineId || !run.id || !run.definitionRevision || run.status === 0)) throw new Error("Routine history owner is invalid.");
      return result;
    }),
    lookup: (requestId, signal) => invoke(signal, async () => { const result = await rpc.getPartnerRoutineCreation({ partnerId, requestId }, { signal });
      if (result.routine) routine(result.routine); if (result.routine && result.retired) throw new Error("Creation receipt is contradictory."); return result; }),
    retire: (requestId, signal) => invoke(signal, async () => { const result = await rpc.retirePartnerRoutineCreation({ partnerId, requestId }, { signal });
      if (result.routine) routine(result.routine); if (result.routine && result.retired) throw new Error("Creation receipt is contradictory."); return result; })
  };
}
export function newRoutineDefinition(): RoutineDefinition {
  return create(RoutineDefinitionSchema, { name: "", prompt: "", enabled: true, silentWhenIdle: false,
    triggers: [{ id: "time-1", kind: { case: "interval", value: { intervalMs: 60n * 60_000n } } }] });
}
export function routineDefinitionKey(value: RoutineDefinition): string { return toJsonString(RoutineDefinitionSchema, value); }

export interface RoutineReceiptStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}
/** Client-only, body-free receipts make lost creation acknowledgements recoverable after reload. */
export class RoutineCreationReceipts {
  #tail = Promise.resolve();
  constructor(private readonly storage: RoutineReceiptStorage, private readonly ownerKey: string) {}
  #key(partnerId: string): string { return `joko.partner-routine-creation.v1:${encodeURIComponent(JSON.stringify([this.ownerKey, partnerId]))}`; }
  async read(partnerId: string): Promise<string | undefined> {
    const raw = await this.storage.getItem(this.#key(partnerId)); if (raw === null) return undefined;
    if (!/^[A-Za-z0-9_-]{16,100}$/u.test(raw)) throw new Error("The routine creation receipt requires recovery.");
    return raw;
  }
  claim(partnerId: string, id: string): Promise<void> { return this.#serialize(async () => {
    if (!/^[A-Za-z0-9_-]{16,100}$/u.test(id) || await this.read(partnerId)) throw new Error("Recover the pending routine before creating another.");
    await this.storage.setItem(this.#key(partnerId), id);
    if (await this.read(partnerId) !== id) throw new Error("The creation receipt was not saved.");
  }); }
  resolve(partnerId: string, id: string): Promise<void> { return this.#serialize(async () => {
    const current = await this.read(partnerId); if (current !== undefined && current !== id) throw new Error("Creation receipt changed.");
    await this.storage.removeItem(this.#key(partnerId)); if (await this.read(partnerId)) throw new Error("The creation receipt is still pending.");
  }); }
  #serialize(action: () => Promise<void>): Promise<void> { const next = this.#tail.then(action); this.#tail = next.catch(() => undefined); return next; }
  #runKey(partnerId: string, routineId: string): string { return `${this.#key(partnerId)}:run:${encodeURIComponent(routineId)}`; }
  async readRun(partnerId: string, routineId: string): Promise<string | undefined> {
    const id = await this.storage.getItem(this.#runKey(partnerId, routineId));
    if (id === null) return undefined;
    if (!/^[A-Za-z0-9_-]{16,100}$/u.test(id)) throw new Error("Run receipt requires recovery.");
    return id;
  }
  claimRun(partnerId: string, routineId: string, id: string): Promise<void> { return this.#serialize(async () => {
    if (!/^[A-Za-z0-9_-]{16,100}$/u.test(id) || await this.readRun(partnerId, routineId)) throw new Error("Recover the pending run first.");
    await this.storage.setItem(this.#runKey(partnerId, routineId), id);
    if (await this.readRun(partnerId, routineId) !== id) throw new Error("Run receipt was not saved.");
  }); }
  resolveRun(partnerId: string, routineId: string, id: string): Promise<void> { return this.#serialize(async () => {
    const current = await this.readRun(partnerId, routineId);
    if (current !== undefined && current !== id) throw new Error("Run receipt changed.");
    await this.storage.removeItem(this.#runKey(partnerId, routineId));
    if (await this.readRun(partnerId, routineId)) throw new Error("Run receipt is still pending.");
  }); }
}
