import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import type { BackgroundTask, Event, SubagentRun, SubagentRunDetail, SubagentTranscriptEntry } from "@joko/contracts";
import {
  mergeMobileDelegatedTranscript, mobileDelegatedEventKey, mobileDelegatedEventRecords, mobileDelegatedRunIsCurrent,
  projectMobileDelegatedEntries, resolveMobileDelegatedChild, type MobileDelegatedEntry
} from "./mobile-delegated";

export interface MobileDelegatedControls {
  readonly authorityKey: string;
  readonly surfaceOwnerKey: string;
  readonly sessionId: string;
  readonly generation: bigint;
  readonly canListBackground: boolean;
  readonly canListRuns: boolean;
  readonly canReadDetail: boolean;
  readonly canReadTranscript: boolean;
}
export interface MobileDelegatedReadClient {
  taskDelegatedControls(): MobileDelegatedControls | undefined;
  loadTaskBackgroundTasks(authorityKey: string, pageToken?: string, signal?: AbortSignal): Promise<{ tasks: readonly BackgroundTask[]; nextPageToken: string }>;
  loadTaskDelegatedRuns(authorityKey: string, pageToken?: string, signal?: AbortSignal): Promise<{ runs: readonly SubagentRun[]; nextPageToken: string }>;
  loadTaskDelegatedDetail(authorityKey: string, runId: string, signal?: AbortSignal): Promise<SubagentRunDetail>;
  loadTaskDelegatedTranscript(authorityKey: string, runId: string, childId?: string, pageToken?: string, signal?: AbortSignal): Promise<{
    entries: readonly SubagentTranscriptEntry[]; nextPageToken: string; tailPageToken: string;
  }>;
}
export type MobileDelegatedReadPhase = "idle" | "loading" | "ready" | "empty" | "error" | "cancelled";
export interface MobileDelegatedTasksState {
  readonly ownerKey?: string;
  readonly phase: MobileDelegatedReadPhase;
  readonly entries: readonly MobileDelegatedEntry[];
  readonly error?: "readFailed" | "unavailable";
}

const maximumPages = 100;
const maximumRecords = 20_000;
const timeoutMs = 20_000;

export class MobileDelegatedTasksReader {
  #state: MobileDelegatedTasksState = { phase: "idle", entries: [] };
  #listeners = new Set<() => void>();
  #controls?: MobileDelegatedControls;
  #abort?: AbortController;
  #epoch = 0;
  #tasks: readonly BackgroundTask[] = [];
  #runs: readonly SubagentRun[] = [];
  #events: readonly Event[] = [];
  constructor(private readonly client: MobileDelegatedReadClient) {}
  get state(): MobileDelegatedTasksState { return this.#state; }
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  snapshot = (): MobileDelegatedTasksState => this.#state;
  #set(state: MobileDelegatedTasksState): void { this.#state = state; for (const listener of this.#listeners) listener(); }
  setOwner(controls: MobileDelegatedControls | undefined): void {
    if (this.#controls?.authorityKey === controls?.authorityKey) return;
    this.cancel(); this.#controls = controls; this.#tasks = []; this.#runs = []; this.#events = [];
    this.#set({ ...(controls ? { ownerKey: controls.surfaceOwnerKey } : {}), phase: "idle", entries: [] });
  }
  cancel(): void {
    this.#epoch += 1; this.#abort?.abort(); this.#abort = undefined;
    if (this.#state.phase === "loading") this.#set({ ...this.#state, phase: "cancelled" });
  }
  acceptEvents(events: readonly Event[], tasks: readonly BackgroundTask[] = []): void {
    const owner = this.#controls;
    if (!owner) return;
    this.#events = events;
    const records = mobileDelegatedEventRecords(owner.sessionId, owner.generation, events);
    const projected = projectMobileDelegatedEntries(owner.sessionId,
      [...this.#tasks, ...(owner.canListBackground ? tasks : []), ...(owner.canListBackground ? records.tasks : [])],
      [...this.#runs, ...(owner.canListRuns ? records.runs : [])]).map((entry) => {
        const matching = events.filter((event) => event.identity?.sessionId === owner.sessionId && event.cursor?.generation === owner.generation
          && event.payload?.kind.case === "subagentTranscriptAppended"
          && event.payload.kind.value.subagentRunId === entry.run?.subagentRunId);
        return { ...entry, refreshKey: matching.map((event) => `${event.eventId}:${event.cursor?.sequence}`).join("\u001f") };
      });
    this.#tasks = projected.flatMap((entry) => entry.task ? [entry.task] : []);
    this.#runs = projected.flatMap((entry) => entry.run ? [entry.run] : []);
    this.#set({ ...this.#state, entries: projected });
  }
  async refresh(): Promise<void> {
    const controls = this.#controls;
    if (!controls || this.client.taskDelegatedControls()?.authorityKey !== controls.authorityKey) { this.setOwner(undefined); return; }
    this.cancel(); const epoch = ++this.#epoch; const abort = new AbortController(); this.#abort = abort;
    this.#set({ ...this.#state, phase: "loading", error: undefined });
    try {
      const [tasks, runs] = await boundedRead(abort, async (signal) => Promise.all([
        controls.canListBackground ? collectPages((token) => this.client.loadTaskBackgroundTasks(controls.authorityKey, token, signal), "tasks") : [],
        controls.canListRuns ? collectPages((token) => this.client.loadTaskDelegatedRuns(controls.authorityKey, token, signal), "runs") : []
      ]));
      if (!this.#current(epoch, controls, abort)) return;
      this.#tasks = [...this.#tasks, ...tasks]; this.#runs = [...this.#runs, ...runs];
      this.acceptEvents(this.#events);
      this.#set({ ...this.#state, phase: this.#state.entries.length ? "ready" : "empty", error: undefined });
    } catch {
      if (this.#epoch === epoch && this.#controls?.authorityKey === controls.authorityKey) {
        this.#set({ ...this.#state, phase: "error", error: "readFailed" });
      }
    } finally { if (this.#abort === abort) this.#abort = undefined; }
  }
  #current(epoch: number, controls: MobileDelegatedControls, abort: AbortController): boolean {
    return !abort.signal.aborted && epoch === this.#epoch && this.#controls?.authorityKey === controls.authorityKey
      && this.client.taskDelegatedControls()?.authorityKey === controls.authorityKey;
  }
}

export function useMobileDelegatedTasks(client: MobileDelegatedReadClient, controls: MobileDelegatedControls | undefined,
  events: readonly Event[], tasks: readonly BackgroundTask[] = []): MobileDelegatedTasksState & { retry(): void; cancel(): void } {
  const reader = useMemo(() => new MobileDelegatedTasksReader(client), [client]);
  const state = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot);
  const key = controls ? mobileDelegatedEventKey(controls.sessionId, controls.generation, events) : "";
  const taskKey = tasks.map((task) => `${task.backgroundTaskId}:${task.version?.generation}:${task.version?.revision?.value}`).join("\u001f");
  const current = useRef({ events, tasks }); current.current = { events, tasks };
  useEffect(() => {
    reader.setOwner(controls);
    const subscription = AppState.addEventListener("change", (value) => {
      if (value !== "active") reader.setOwner(undefined);
      else { reader.setOwner(client.taskDelegatedControls()); reader.acceptEvents(current.current.events, current.current.tasks); void reader.refresh(); }
    });
    return () => { subscription.remove(); reader.setOwner(undefined); };
  }, [reader, client, controls?.authorityKey]);
  useEffect(() => {
    reader.acceptEvents(events, tasks);
    if (controls && AppState.currentState === "active") void reader.refresh();
    return () => reader.cancel();
  }, [reader, controls?.authorityKey, key, taskKey]);
  return { ...state, retry: () => void reader.refresh(), cancel: () => reader.cancel() };
}

export interface MobileDelegatedDetailState {
  readonly phase: MobileDelegatedReadPhase;
  readonly detail?: SubagentRunDetail;
  readonly entries: readonly SubagentTranscriptEntry[];
  readonly childId: string;
  readonly nextPageToken: string;
  readonly tailPageToken: string;
  readonly transcriptAvailable: boolean;
  readonly error?: "readFailed" | "unavailable" | "staleGeneration";
}

export class MobileDelegatedDetailReader {
  #state: MobileDelegatedDetailState = { phase: "idle", entries: [], childId: "", nextPageToken: "", tailPageToken: "", transcriptAvailable: false };
  #listeners = new Set<() => void>();
  #abort?: AbortController;
  #epoch = 0;
  #tokens = new Set<string>();
  constructor(private readonly client: MobileDelegatedReadClient, private readonly controls: MobileDelegatedControls,
    private run: SubagentRun) {}
  updateRun(run: SubagentRun): void {
    if (run.sessionId === this.run.sessionId && run.subagentRunId === this.run.subagentRunId
      && mobileDelegatedRunIsCurrent(run, this.run)) this.run = run;
  }
  get state(): MobileDelegatedDetailState { return this.#state; }
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  snapshot = (): MobileDelegatedDetailState => this.#state;
  #set(state: MobileDelegatedDetailState): void { this.#state = state; for (const listener of this.#listeners) listener(); }
  cancel(): void { this.#epoch += 1; this.#abort?.abort(); this.#abort = undefined;
    if (this.#state.phase === "loading") this.#set({ ...this.#state, phase: "cancelled" }); }
  retire(): void { this.cancel(); this.#set({ phase: "idle", entries: [], childId: "", nextPageToken: "", tailPageToken: "", transcriptAvailable: false }); }
  async refresh(): Promise<void> {
    if (!this.controls.canReadDetail || this.client.taskDelegatedControls()?.authorityKey !== this.controls.authorityKey) {
      this.retire(); this.#set({ ...this.#state, phase: "error", error: "unavailable" }); return;
    }
    await this.#request(async (signal) => {
      const detail = await this.client.loadTaskDelegatedDetail(this.controls.authorityKey, this.run.subagentRunId, signal);
      if (signal.aborted) throw new Error("Delegated detail reading was cancelled.");
      if (!detail.run || detail.run.sessionId !== this.run.sessionId || detail.run.subagentRunId !== this.run.subagentRunId
        || !mobileDelegatedRunIsCurrent(detail.run, this.run)) throw new Error("A stale delegated generation was returned.");
      const child = resolveMobileDelegatedChild(detail.children, this.#state.childId);
      const childId = child?.childId ?? "";
      const available = this.controls.canReadTranscript && detail.run.capabilities?.viewFullTranscript === true;
      const keep = childId === this.#state.childId && available && this.#state.transcriptAvailable;
      const tail = keep && !this.#state.nextPageToken ? this.#state.tailPageToken : "";
      let page = available ? await this.client.loadTaskDelegatedTranscript(this.controls.authorityKey, this.run.subagentRunId, childId, tail, signal) : undefined;
      if (signal.aborted) throw new Error("Delegated content reading was cancelled.");
      let entries = keep ? mergeMobileDelegatedTranscript(this.#state.entries, page?.entries ?? []) : page?.entries ?? [];
      if (tail) {
        const seen = new Set([tail]);
        while (page?.nextPageToken) {
          if (seen.has(page.nextPageToken) || seen.size >= maximumPages) throw new Error("Cyclic delegated transcript tail.");
          seen.add(page.nextPageToken);
          page = await this.client.loadTaskDelegatedTranscript(this.controls.authorityKey, this.run.subagentRunId, childId, page.nextPageToken, signal);
          if (signal.aborted) throw new Error("Delegated content reading was cancelled.");
          entries = mergeMobileDelegatedTranscript(entries, page.entries);
          if (entries.length > maximumRecords) throw new Error("Delegated transcript exceeded its read limit.");
        }
      }
      if (signal.aborted) throw new Error("Delegated content reading was cancelled.");
      if (!keep) this.#tokens = new Set([""]);
      return { phase: entries.length || detail.returnedResult || detail.children.length || detail.activity.length ? "ready" as const : "empty" as const,
        detail, entries, childId, nextPageToken: keep && this.#state.nextPageToken ? this.#state.nextPageToken : page?.nextPageToken ?? "", tailPageToken: page?.tailPageToken ?? "",
        transcriptAvailable: available };
    });
  }
  async selectChild(identity: string): Promise<void> {
    const child = identity ? resolveMobileDelegatedChild(this.#state.detail?.children ?? [], identity) : undefined;
    if (identity && !child) throw new Error("The delegated child generation is unavailable.");
    this.cancel(); this.#tokens = new Set();
    this.#set({ ...this.#state, phase: "idle", childId: child?.childId ?? "", entries: [], nextPageToken: "", tailPageToken: "", error: undefined });
    await this.#page("");
  }
  async loadMore(): Promise<void> { if (this.#state.nextPageToken) await this.#page(this.#state.nextPageToken); }
  async #page(token: string): Promise<void> {
    if (!this.#state.transcriptAvailable || this.#state.phase === "loading") return;
    if (this.#tokens.has(token) || this.#tokens.size >= maximumPages || this.#state.entries.length >= maximumRecords) {
      this.#set({ ...this.#state, phase: "error", error: "readFailed" }); return;
    }
    await this.#request(async (signal) => {
      const page = await this.client.loadTaskDelegatedTranscript(this.controls.authorityKey, this.run.subagentRunId, this.#state.childId, token, signal);
      if (signal.aborted) throw new Error("Delegated content reading was cancelled.");
      if (page.nextPageToken && (page.nextPageToken === token || this.#tokens.has(page.nextPageToken))) throw new Error("Cyclic delegated transcript page.");
      const entries = mergeMobileDelegatedTranscript(this.#state.entries, page.entries);
      if (entries.length > maximumRecords) throw new Error("Delegated transcript exceeded its read limit.");
      this.#tokens.add(token);
      return { ...this.#state, phase: entries.length ? "ready" as const : "empty" as const, entries,
        nextPageToken: page.nextPageToken, tailPageToken: page.tailPageToken, error: undefined };
    });
  }
  async #request(read: (signal: AbortSignal) => Promise<MobileDelegatedDetailState>): Promise<void> {
    if (this.client.taskDelegatedControls()?.authorityKey !== this.controls.authorityKey) { this.retire(); return; }
    this.cancel(); const epoch = ++this.#epoch; const abort = new AbortController(); this.#abort = abort;
    this.#set({ ...this.#state, phase: "loading", error: undefined });
    try {
      const state = await boundedRead(abort, read);
      if (epoch === this.#epoch && !abort.signal.aborted
        && this.client.taskDelegatedControls()?.authorityKey === this.controls.authorityKey) this.#set(state);
    } catch {
      if (epoch === this.#epoch && this.client.taskDelegatedControls()?.authorityKey === this.controls.authorityKey)
        this.#set({ ...this.#state, phase: "error", error: "readFailed" });
    } finally { if (this.#abort === abort) this.#abort = undefined; }
  }
}

async function collectPages<K extends "tasks" | "runs", T>(load: (token: string) => Promise<{ nextPageToken: string } & Record<K, readonly T[]>>, key: K): Promise<readonly T[]> {
  let token = ""; const tokens = new Set<string>(); const entries: T[] = [];
  for (let index = 0; index < maximumPages; index += 1) {
    if (tokens.has(token)) throw new Error("Cyclic delegated activity page.");
    tokens.add(token); const page = await load(token); entries.push(...page[key]);
    if (entries.length > maximumRecords) throw new Error("Delegated activity exceeded its read limit.");
    if (!page.nextPageToken) return entries;
    token = page.nextPageToken;
  }
  throw new Error("Delegated activity exceeded its page limit.");
}

async function boundedRead<T>(abort: AbortController, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled: (() => void) | undefined;
  try {
    return await Promise.race([read(abort.signal), new Promise<never>((_, reject) => {
      cancelled = () => reject(new Error("Delegated reading cancelled."));
      abort.signal.addEventListener("abort", cancelled, { once: true });
      timer = setTimeout(() => abort.abort(), timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); if (cancelled) abort.signal.removeEventListener("abort", cancelled); }
}
