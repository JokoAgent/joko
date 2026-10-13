import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { promisify } from "node:util";

const execute = promisify(execFile);
const unavailable = (): Error => new Error("REMOTE_DESKTOP_HOST_MUTE_UNAVAILABLE");

export function supportsDesktopRemoteDesktopLinuxMute(): boolean {
  if (process.platform !== "linux") return false;
  try {
    for (const tool of ["pactl", "pw-dump", "pw-cli"]) accessSync(`/usr/bin/${tool}`, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

interface Sink {
  readonly id: number;
  readonly serial: number;
  readonly name: string;
  readonly muted: boolean;
}

interface MuteOccurrence {
  readonly owner: object;
  readonly current: () => boolean;
  readonly signal: AbortSignal;
  readonly original: Map<string, Sink>;
  readonly abort: () => void;
  retired: boolean;
  watchPending: boolean;
}

/** Playback softMute leaves the monitor branch audible to the remote viewer.
 * Each exact owner retains its id/serial snapshots until restoration succeeds. */
export class DesktopRemoteDesktopLinuxMute {
  readonly #run: (tool: string, args: string[]) => Promise<string>;
  readonly #occurrences = new Set<MuteOccurrence>();
  #active: MuteOccurrence | undefined;
  #tail: Promise<void> = Promise.resolve();
  #watchTimer: ReturnType<typeof setInterval> | undefined;
  #restoreTimer: ReturnType<typeof setTimeout> | undefined;
  #restoreAttempt = 0;

  constructor(run: (tool: string, args: string[]) => Promise<string> = async (tool, args) => {
    const { stdout } = await execute(`/usr/bin/${tool}`, args, {
      timeout: 2_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8"
    });
    return stdout;
  }) {
    this.#run = run;
  }

  set(owner: object, enabled: boolean, current: () => boolean, signal: AbortSignal): Promise<void> {
    if (!enabled) {
      const valid = this.#authorized(current, signal);
      const result = this.release(owner);
      return valid ? result : result.then(() => { throw unavailable(); });
    }
    if (!this.#authorized(current, signal)) return Promise.reject(unavailable());
    this.#resetRestoreRetry();
    let occurrence = this.#active;
    if (occurrence?.owner !== owner || !this.#valid(occurrence)) {
      if (occurrence) this.#retire(occurrence);
      const next: MuteOccurrence = {
        owner, current, signal, original: new Map(), retired: false, watchPending: false,
        abort: () => {
          this.#retire(next);
          void this.#enqueue(() => this.#restore(next)).catch(() => this.#scheduleRestore());
        }
      };
      occurrence = next;
      this.#occurrences.add(next);
      this.#active = next;
      signal.addEventListener("abort", next.abort, { once: true });
    }
    const captured = occurrence;
    return this.#enqueue(async () => {
      try {
        this.#check(captured);
        // Finish a retired occurrence before taking a replacement snapshot.
        for (const previous of this.#occurrences) {
          if (previous !== captured && previous.retired) await this.#restore(previous);
        }
        await this.#mute(captured);
        this.#startWatch(captured);
      } catch {
        this.#retire(captured);
        try { await this.#restore(captured); } catch { this.#scheduleRestore(); }
        this.#scheduleRestore();
        throw unavailable();
      }
    });
  }

  release(owner: object): Promise<void> {
    const occurrences = [...this.#occurrences].filter(occurrence => occurrence.owner === owner);
    for (const occurrence of occurrences) this.#retire(occurrence);
    if (occurrences.length) this.#resetRestoreRetry();
    const result = this.#enqueue(async () => {
      for (const occurrence of occurrences) await this.#restore(occurrence);
    });
    void result.then(() => this.#scheduleRestore(), () => this.#scheduleRestore());
    return result;
  }

  releaseAll(): Promise<void> {
    const occurrences = [...this.#occurrences];
    for (const occurrence of occurrences) this.#retire(occurrence);
    this.#resetRestoreRetry();
    const result = this.#enqueue(async () => {
      for (const occurrence of occurrences) await this.#restore(occurrence);
    });
    void result.then(() => this.#scheduleRestore(), () => this.#scheduleRestore());
    return result;
  }

  #key(sink: Sink): string { return `${sink.id}:${sink.serial}`; }

  #authorized(current: () => boolean, signal: AbortSignal): boolean {
    try { return !signal.aborted && current(); } catch { return false; }
  }

  #valid(occurrence: MuteOccurrence): boolean {
    return !occurrence.retired && this.#active === occurrence
      && this.#authorized(occurrence.current, occurrence.signal);
  }

  #check(occurrence: MuteOccurrence): void {
    if (!this.#valid(occurrence)) throw unavailable();
  }

  #retire(occurrence: MuteOccurrence): void {
    occurrence.retired = true;
    occurrence.signal.removeEventListener("abort", occurrence.abort);
    if (this.#active === occurrence) {
      this.#active = undefined;
      clearInterval(this.#watchTimer);
      this.#watchTimer = undefined;
    }
  }

  async #sinks(): Promise<Sink[]> {
    const nodes: unknown = JSON.parse(await this.#run("pw-dump", []));
    if (!Array.isArray(nodes) || nodes.length > 10_000) throw unavailable();
    return nodes.flatMap((value: unknown): Sink[] => {
      const node = record(value), info = record(node?.["info"]), props = record(info?.["props"]);
      const params = record(info?.["params"])?.["Props"];
      const mute = Array.isArray(params) ? params.map(record).find(item => typeof item?.["softMute"] === "boolean") : undefined;
      const id = node?.["id"], serial = Number(props?.["object.serial"]), name = props?.["node.name"];
      return typeof id === "number" && Number.isSafeInteger(id) && id > 0
        && Number.isSafeInteger(serial) && serial > 0 && props?.["media.class"] === "Audio/Sink"
        && typeof name === "string" && mute
        ? [{ id, serial, name, muted: mute["softMute"] as boolean }] : [];
    });
  }

  async #mute(occurrence: MuteOccurrence): Promise<void> {
    this.#check(occurrence);
    const sinks = await this.#sinks();
    this.#check(occurrence);
    const name = (await this.#run("pactl", ["get-default-sink"])).trim();
    this.#check(occurrence);
    const current = sinks.find(sink => sink.name === name);
    if (!current) {
      if (occurrence.original.size) return;
      throw unavailable();
    }
    occurrence.original.set(this.#key(current), occurrence.original.get(this.#key(current)) ?? current);
    for (const sink of sinks) {
      if (!occurrence.original.has(this.#key(sink))) continue;
      this.#check(occurrence);
      await this.#run("pw-cli", ["set-param", String(sink.id), "Props", "{ softMute: true }"]);
      this.#check(occurrence);
    }
  }

  async #restore(occurrence: MuteOccurrence): Promise<void> {
    if (!occurrence.retired) return;
    if (occurrence.original.size) {
      const sinks = await this.#sinks();
      const present = new Set(sinks.map(sink => this.#key(sink)));
      for (const key of occurrence.original.keys()) {
        if (!present.has(key)) occurrence.original.delete(key);
      }
      for (const sink of sinks) {
        const saved = occurrence.original.get(this.#key(sink));
        if (!saved) continue;
        await this.#run("pw-cli", ["set-param", String(sink.id), "Props", `{ softMute: ${saved.muted ? "true" : "false"} }`]);
        occurrence.original.delete(this.#key(sink));
      }
    }
    if (!occurrence.original.size) this.#occurrences.delete(occurrence);
    if (![...this.#occurrences].some(value => value.retired && value.original.size)) this.#resetRestoreRetry();
  }

  #startWatch(occurrence: MuteOccurrence): void {
    if (this.#watchTimer || !this.#valid(occurrence)) return;
    this.#watchTimer = setInterval(() => {
      if (occurrence.watchPending) return;
      if (!this.#valid(occurrence)) this.#retire(occurrence);
      occurrence.watchPending = true;
      void this.#enqueue(async () => {
        if (occurrence.retired) { await this.#restore(occurrence); return; }
        try { await this.#mute(occurrence); } catch {
          if (!this.#valid(occurrence)) {
            this.#retire(occurrence);
            await this.#restore(occurrence);
          }
          throw unavailable();
        }
      }).catch(() => this.#scheduleRestore()).finally(() => { occurrence.watchPending = false; });
    }, 1_000);
    this.#watchTimer.unref?.();
  }

  #resetRestoreRetry(): void {
    clearTimeout(this.#restoreTimer);
    this.#restoreTimer = undefined;
    this.#restoreAttempt = 0;
  }

  #scheduleRestore(): void {
    if (this.#restoreTimer || this.#restoreAttempt >= 5
      || ![...this.#occurrences].some(value => value.retired && value.original.size)) return;
    const delay = [250, 500, 1_000, 2_000, 4_000][this.#restoreAttempt++];
    this.#restoreTimer = setTimeout(() => {
      this.#restoreTimer = undefined;
      void this.#enqueue(async () => {
        for (const occurrence of this.#occurrences) if (occurrence.retired) await this.#restore(occurrence);
      }).then(() => this.#scheduleRestore(), () => this.#scheduleRestore());
    }, delay);
    this.#restoreTimer.unref?.();
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.#tail.then(operation).catch(() => { throw unavailable(); });
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}
