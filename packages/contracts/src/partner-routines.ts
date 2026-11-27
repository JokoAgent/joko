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
      return { ...result, routines: result.routines.filter(item => !item.builtin) };
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
      if (result.runs.length > 20 || result.runs.some(run => run.routineId !== routineId || !run.id || !run.definitionRevision || run.status === 0)
        || result.nextOffset !== undefined && (!result.runs.length || result.nextOffset !== offset + result.runs.length)) throw new Error("Routine history page is invalid.");
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

const localReceiptUpdates = new Map<string, Promise<void>>();
function serializeLocalReceipt(key: string, update: () => Promise<void>): Promise<void> {
  const previous = localReceiptUpdates.get(key) ?? Promise.resolve();
  const next = previous.then(update, update);
  localReceiptUpdates.set(key, next);
  return next.finally(() => {
    if (localReceiptUpdates.get(key) === next) localReceiptUpdates.delete(key);
  });
}

/** The original request ID is durable before dispatch. All windows serialize changes to the same slot. */
export class RoutineCreationReceipts {
  constructor(private readonly storage: RoutineReceiptStorage, private readonly ownerKey: string,
    private readonly exclusive: (key: string, update: () => Promise<void>) => Promise<void> = serializeLocalReceipt) {}
  #key(partnerId: string): string { return `joko.partner-routine-creation.v1:${encodeURIComponent(JSON.stringify([this.ownerKey, partnerId]))}`; }
  #runKey(partnerId: string, routineId: string): string { return `${this.#key(partnerId)}:run:${encodeURIComponent(routineId)}`; }
  async #read(key: string): Promise<string | undefined> {
    const raw = await this.storage.getItem(key);
    if (raw === null) return undefined;
    if (!/^[A-Za-z0-9_-]{16,100}$/u.test(raw)) throw new Error("The routine receipt requires recovery.");
    return raw;
  }
  #claim(key: string, id: string): Promise<void> {
    return this.exclusive(key, async () => {
      if (!/^[A-Za-z0-9_-]{16,100}$/u.test(id) || await this.#read(key)) throw new Error("Recover the pending routine request first.");
      await this.storage.setItem(key, id);
      if (await this.#read(key) !== id) throw new Error("The routine receipt was not saved.");
    });
  }
  #resolve(key: string, id: string): Promise<void> {
    return this.exclusive(key, async () => {
      // Another window may have recovered this request and started its successor.
      if (await this.#read(key) !== id) return;
      await this.storage.removeItem(key);
      if (await this.#read(key) !== undefined) throw new Error("The routine receipt is still pending.");
    });
  }
  read(partnerId: string): Promise<string | undefined> { return this.#read(this.#key(partnerId)); }
  claim(partnerId: string, id: string): Promise<void> { return this.#claim(this.#key(partnerId), id); }
  resolve(partnerId: string, id: string): Promise<void> { return this.#resolve(this.#key(partnerId), id); }
  readRun(partnerId: string, routineId: string): Promise<string | undefined> { return this.#read(this.#runKey(partnerId, routineId)); }
  claimRun(partnerId: string, routineId: string, id: string): Promise<void> { return this.#claim(this.#runKey(partnerId, routineId), id); }
  resolveRun(partnerId: string, routineId: string, id: string): Promise<void> { return this.#resolve(this.#runKey(partnerId, routineId), id); }
}
