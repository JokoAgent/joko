import { PersonalDevelopmentError, type DevelopmentOperation, type PersonalDevelopmentOwner } from "@joko/personal-development";
import { operationBodyHash, type OperationalStore } from "@joko/store";
import type { createPersonalDevelopmentDoctorPrerequisites } from "./personal-development-doctor-environment.js";
import type { DevelopmentDoctorCheck, DevelopmentDoctorEnvironment } from "./personal-development-doctor-types.js";

const SCOPE = "personal-development-settings-environment", CHECK_IDS = ["platform", "git", "gitLfs", "node", "pnpm", "python", "native", "storage"];
interface RecordValue { readonly format: 1; readonly ownerId: string; readonly environment: DevelopmentDoctorEnvironment;
  readonly operations: Readonly<Record<string, DevelopmentOperation>> }
interface Flight { readonly operationId: string; readonly controller: AbortController; readonly promise: Promise<void> }
export function safeDevelopmentDoctorCheck(check: { readonly id: string; readonly status: DevelopmentDoctorCheck["status"]; readonly version?: string;
  readonly reason?: string; readonly freeGiB?: number; readonly source?: "system" | "managed"; readonly progress?: DevelopmentDoctorCheck["progress"] }): DevelopmentDoctorCheck {
  return { id: check.id, status: check.status, ...(check.version ? { version: check.version } : {}), ...(check.reason ? { reason: check.reason } : {}),
    ...(check.freeGiB === undefined ? {} : { freeGiB: check.freeGiB }), ...(check.source ? { source: check.source } : {}), ...(check.progress ? { progress: { ...check.progress } } : {}) };
}

/** Settings owns a full durable environment observation without creating any Session. */
export class PersonalDevelopmentSettingsEnvironment {
  readonly #listeners = new Set<() => void>();
  #flight: Flight | undefined;
  #unsubscribe: (() => void) | undefined;
  #closed = false;
  constructor(readonly options: { readonly store: OperationalStore; readonly ownerId: string; readonly owner: PersonalDevelopmentOwner;
    readonly prerequisites: ReturnType<typeof createPersonalDevelopmentDoctorPrerequisites>; readonly assertAvailable: () => void;
    readonly now?: () => number; readonly platform?: string; readonly arch?: string }) {}
  get #now(): number { return this.options.now?.() ?? Date.now(); }
  initialize(): void {
    const value = this.#record();
    if (value?.environment.operation?.status === "running") {
      const operation: DevelopmentOperation = { ...value.environment.operation, status: "unknown", stage: "recovery-required", error: "PROCESS_UNKNOWN", finishedAt: this.#now };
      this.#save({ ...value, environment: { ...value.environment, status: "unknown", operation }, operations: { ...value.operations, [operation.id]: operation } });
    }
    this.#unsubscribe = this.options.owner.subscribe(state => {
      const flight = this.#flight, record = this.#record(); if (!flight || !record || record.environment.operation?.id !== flight.operationId) return;
      const operation = state.operations[flight.operationId]; if (!operation) return;
      const tools = state.environment.checks.map(safeDevelopmentDoctorCheck);
      const checks = record.environment.checks.map(check => tools.find(tool => tool.id === check.id) ?? check);
      this.#update({ checks, operation: { ...operation, kind: record.environment.operation.kind,
        inputHash: record.environment.operation.inputHash, status: "running", finishedAt: undefined } });
    });
  }
  snapshot(): DevelopmentDoctorEnvironment | undefined { const value = this.#record(); return value ? structuredClone(value.environment) : undefined; }
  operations(): readonly DevelopmentOperation[] { return Object.values(this.#record()?.operations ?? {}).map(value => structuredClone(value)); }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); listener(); return () => { this.#listeners.delete(listener); }; }
  #record(): RecordValue | undefined {
    const value = this.options.store.findSetting("service", SCOPE, this.options.ownerId)?.value as RecordValue | undefined;
    if (value === undefined) return undefined;
    if (value.format !== 1 || value.ownerId !== this.options.ownerId || !value.environment || !Array.isArray(value.environment.checks) || !value.operations
      || !["unchecked", "checking", "preparing", "ready", "failed", "cancelled", "unknown"].includes(value.environment.status)) throw new PersonalDevelopmentError("STATE_INVALID");
    return value;
  }
  #save(value: RecordValue): void {
    this.options.store.setSetting("service", SCOPE, this.options.ownerId, JSON.parse(JSON.stringify(value)) as RecordValue);
    for (const listener of this.#listeners) listener();
  }
  #update(patch: Partial<DevelopmentDoctorEnvironment>): void {
    const value = this.#record(); if (!value) throw new PersonalDevelopmentError("STATE_INVALID");
    const environment = { ...value.environment, ...patch }, operation = environment.operation;
    this.#save({ ...value, environment, operations: { ...value.operations, ...(operation ? { [operation.id]: operation } : {}) } });
  }
  run(input: { readonly operationId: string; readonly mode: "check" | "prepare" }): string {
    if (this.#closed) throw new PersonalDevelopmentError("OWNER_CHANGED"); this.options.assertAvailable();
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u.test(input.operationId) || input.mode !== "check" && input.mode !== "prepare") throw new PersonalDevelopmentError("INVALID_ARGUMENT");
    const previous = this.#record(), kind = `settings-environment-${input.mode}`;
    if (previous?.operations[input.operationId]) { if (previous.operations[input.operationId]!.kind !== kind) throw new PersonalDevelopmentError("INVALID_ARGUMENT"); return input.operationId; }
    if (this.#flight) throw new PersonalDevelopmentError("BUSY");
    const operation: DevelopmentOperation = { id: input.operationId, kind, status: "running", stage: "environment", inputHash: operationBodyHash({ mode: input.mode }), startedAt: this.#now };
    this.#save({ format: 1, ownerId: this.options.ownerId, operations: { ...previous?.operations, [input.operationId]: operation }, environment: {
      status: input.mode === "check" ? "checking" : "preparing", checks: CHECK_IDS.map(id => ({ id, status: "pending" })), operation,
      platform: this.options.platform ?? process.platform, arch: this.options.arch ?? process.arch } });
    const controller = new AbortController(), promise = Promise.resolve().then(() => this.#run(input, controller));
    this.#flight = { operationId: input.operationId, controller, promise };
    void promise.finally(() => { if (this.#flight?.controller === controller) this.#flight = undefined; }).catch(() => undefined);
    return input.operationId;
  }
  async #run(input: { readonly operationId: string; readonly mode: "check" | "prepare" }, controller: AbortController): Promise<void> {
    const signal = controller.signal;
    const timeout = setTimeout(() => controller.abort("timeout"), input.mode === "check" ? 60_000 : 20 * 60_000); timeout.unref();
    const cancel = () => { this.options.owner.cancel(input.operationId); }; signal.addEventListener("abort", cancel, { once: true });
    const assert = () => { signal.throwIfAborted(); this.options.assertAvailable(); if (this.#flight?.operationId !== input.operationId) throw new PersonalDevelopmentError("OWNER_CHANGED"); };
    try {
      assert(); const platform = this.options.prerequisites.platform();
      this.#update({ checks: this.snapshot()!.checks.map(check => check.id === "platform" ? platform : check) });
      if (platform.status !== "ready") throw new PersonalDevelopmentError("UNSUPPORTED_PLATFORM");
      if (input.mode === "check") await this.options.owner.checkEnvironment({ operationId: input.operationId });
      else await this.options.owner.prepareEnvironment({ operationId: input.operationId });
      assert(); const tools = this.options.owner.snapshot().environment.checks.map(safeDevelopmentDoctorCheck);
      this.#update({ checks: this.snapshot()!.checks.map(check => tools.find(tool => tool.id === check.id) ?? check) });
      for (const id of ["native", "storage"] as const) {
        assert(); this.#update({ checks: this.snapshot()!.checks.map(check => check.id === id ? { id, status: "checking" } : check),
          operation: { ...this.snapshot()!.operation!, stage: id } });
        const check = await this.options.prerequisites[id](signal); assert();
        this.#update({ checks: this.snapshot()!.checks.map(value => value.id === id ? check : value) });
      }
      const environment = this.snapshot()!, ready = environment.checks.every(check => check.status === "ready");
      this.#update({ status: ready ? "ready" : "failed", operation: { ...environment.operation!, kind: `settings-environment-${input.mode}`,
        status: "succeeded", stage: "completed", error: ready ? undefined : "ENVIRONMENT_NOT_READY", finishedAt: this.#now } });
    } catch (error) {
      const code = error instanceof PersonalDevelopmentError ? error.code : signal.aborted ? "CANCELLED" : "PROCESS_UNKNOWN";
      const status = code === "PROCESS_UNKNOWN" ? "unknown" : signal.aborted && signal.reason !== "timeout" ? "cancelled" : "failed";
      const environment = this.snapshot()!;
      this.#update({ status, checks: environment.checks.map(check => ["pending", "checking", "downloading", "verifying", "extracting"].includes(check.status)
        ? { ...check, status: signal.aborted ? "cancelled" : "failed" } : check), operation: { ...environment.operation!, kind: `settings-environment-${input.mode}`,
        status, stage: "stopped", error: code, finishedAt: this.#now } });
    } finally { clearTimeout(timeout); signal.removeEventListener("abort", cancel); }
  }
  cancel(operationId: string): boolean {
    if (this.#flight?.operationId !== operationId) return false;
    this.#flight.controller.abort(); this.options.owner.cancel(operationId); return true;
  }
  async dispose(): Promise<void> { this.#closed = true; this.#unsubscribe?.(); if (this.#flight) { this.cancel(this.#flight.operationId); await this.#flight.promise; } this.#listeners.clear(); }
}
