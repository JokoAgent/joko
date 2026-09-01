export type CommandGateAdmission = "immediate" | "queued" | "wait_timeout" | "aborted";

export interface CommandGateLogger {
  info(message: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
  warn(message: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
  debug?(message: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
}

export interface CommandGateLeaseInput {
  readonly commandId: string;
  readonly sessionId: string;
  readonly signal?: AbortSignal;
}

export interface CommandConcurrencyGate {
  acquire(input: CommandGateLeaseInput): Promise<CommandGateAdmission>;
  release(commandId: string, reason: string): void;
  releaseSession(sessionId: string, reason: string): void;
  snapshot(): { readonly running: number; readonly queued: number };
  close(): void;
}

export interface CommandConcurrencyGateOptions {
  readonly readMaximum: () => number;
  readonly logger?: CommandGateLogger;
  readonly maximumWaitMs?: number;
  readonly runningLeaseMs?: number;
  readonly repumpIntervalMs?: number;
  readonly now?: () => number;
}

interface RunningCommand {
  readonly sessionId: string;
  readonly admittedAt: number;
}

interface WaitingCommand extends CommandGateLeaseInput {
  readonly resolve: (value: CommandGateAdmission) => void;
  timer: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
}

const DEFAULT_MAXIMUM_WAIT_MS = 120_000;
const DEFAULT_RUNNING_LEASE_MS = 30 * 60_000;
const DEFAULT_REPUMP_INTERVAL_MS = 1_000;
const SILENT_LOGGER: CommandGateLogger = { info() {}, warn() {} };

export function createCommandConcurrencyGate(options: CommandConcurrencyGateOptions): CommandConcurrencyGate {
  const logger = options.logger ?? SILENT_LOGGER;
  const now = options.now ?? Date.now;
  const maximumWaitMs = positiveDuration(options.maximumWaitMs, DEFAULT_MAXIMUM_WAIT_MS, "maximum wait");
  const runningLeaseMs = positiveDuration(options.runningLeaseMs, DEFAULT_RUNNING_LEASE_MS, "running lease");
  const repumpIntervalMs = positiveDuration(options.repumpIntervalMs, DEFAULT_REPUMP_INTERVAL_MS, "repump interval");
  const running = new Map<string, RunningCommand>();
  const waiting: WaitingCommand[] = [];
  let repumpTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const readMaximum = (): number => {
    try {
      const value = options.readMaximum();
      return Number.isFinite(value) ? Math.floor(value) : 0;
    } catch {
      logger.warn("Command concurrency setting could not be read; commands remain available.");
      return 0;
    }
  };

  const stopRepump = (): void => {
    if (repumpTimer === undefined) return;
    clearInterval(repumpTimer);
    repumpTimer = undefined;
  };

  const ensureRepump = (): void => {
    if (repumpTimer !== undefined || waiting.length === 0 || closed) return;
    repumpTimer = setInterval(() => pump(), repumpIntervalMs);
    repumpTimer.unref?.();
  };

  const removeWaiting = (entry: WaitingCommand): boolean => {
    const index = waiting.indexOf(entry);
    if (index < 0) return false;
    waiting.splice(index, 1);
    if (waiting.length === 0) stopRepump();
    return true;
  };

  const settleWaiting = (entry: WaitingCommand, value: CommandGateAdmission): void => {
    clearTimeout(entry.timer);
    if (entry.signal !== undefined && entry.abortListener !== undefined) {
      entry.signal.removeEventListener("abort", entry.abortListener);
    }
    entry.resolve(value);
  };

  const sweepExpired = (): void => {
    const expiredAt = now() - runningLeaseMs;
    for (const [commandId, entry] of running) {
      if (entry.admittedAt > expiredAt) continue;
      running.delete(commandId);
      logger.warn("A stale command concurrency lease was reclaimed.", {
        commandId,
        sessionId: entry.sessionId,
        heldMs: Math.max(0, now() - entry.admittedAt)
      });
    }
  };

  function pump(): void {
    if (closed) return;
    sweepExpired();
    while (waiting.length > 0) {
      const maximum = readMaximum();
      if (maximum > 0 && running.size >= maximum) break;
      const entry = waiting.shift()!;
      running.set(entry.commandId, { sessionId: entry.sessionId, admittedAt: now() });
      settleWaiting(entry, "queued");
    }
    if (waiting.length === 0) stopRepump();
    else ensureRepump();
  }

  return {
    acquire(input) {
      if (closed || input.signal?.aborted) return Promise.resolve("aborted");
      pump();
      const existing = running.get(input.commandId);
      if (existing !== undefined) {
        running.set(input.commandId, { sessionId: input.sessionId, admittedAt: now() });
        return Promise.resolve("immediate");
      }
      const maximum = readMaximum();
      if (waiting.length === 0 && (maximum <= 0 || running.size < maximum)) {
        running.set(input.commandId, { sessionId: input.sessionId, admittedAt: now() });
        return Promise.resolve("immediate");
      }
      return new Promise<CommandGateAdmission>((resolve) => {
        const entry: WaitingCommand = {
          ...input,
          resolve,
          timer: undefined as unknown as ReturnType<typeof setTimeout>
        };
        entry.timer = setTimeout(() => {
          if (!removeWaiting(entry)) return;
          running.set(entry.commandId, { sessionId: entry.sessionId, admittedAt: now() });
          logger.warn("Command concurrency wait expired; the command was admitted to avoid a permanent stall.", {
            commandId: entry.commandId,
            sessionId: entry.sessionId,
            waitedMs: maximumWaitMs,
            running: running.size,
            maximum: readMaximum()
          });
          settleWaiting(entry, "wait_timeout");
        }, maximumWaitMs);
        entry.timer.unref?.();
        if (entry.signal !== undefined) {
          entry.abortListener = () => {
            if (!removeWaiting(entry)) return;
            settleWaiting(entry, "aborted");
          };
          entry.signal.addEventListener("abort", entry.abortListener, { once: true });
        }
        waiting.push(entry);
        ensureRepump();
        logger.debug?.("Command queued behind the global concurrency gate.", {
          commandId: entry.commandId,
          sessionId: entry.sessionId,
          running: running.size,
          queued: waiting.length,
          maximum
        });
      });
    },
    release(commandId, reason) {
      const active = running.get(commandId);
      if (active !== undefined) {
        running.delete(commandId);
        logger.debug?.("Command concurrency lease released.", {
          commandId,
          sessionId: active.sessionId,
          reason,
          heldMs: Math.max(0, now() - active.admittedAt)
        });
        pump();
        return;
      }
      const queued = waiting.find((entry) => entry.commandId === commandId);
      if (queued !== undefined && removeWaiting(queued)) settleWaiting(queued, "aborted");
    },
    releaseSession(sessionId, reason) {
      let released = 0;
      for (const [commandId, entry] of running) {
        if (entry.sessionId !== sessionId) continue;
        running.delete(commandId);
        released += 1;
      }
      const queued = waiting.filter((entry) => entry.sessionId === sessionId);
      for (const entry of queued) {
        if (removeWaiting(entry)) settleWaiting(entry, "aborted");
      }
      if (released > 0 || queued.length > 0) {
        logger.info("Session command concurrency leases were cleared.", {
          sessionId,
          reason,
          released,
          cancelled: queued.length
        });
        pump();
      }
    },
    snapshot: () => ({ running: running.size, queued: waiting.length }),
    close() {
      if (closed) return;
      closed = true;
      stopRepump();
      running.clear();
      for (const entry of waiting.splice(0)) settleWaiting(entry, "aborted");
    }
  };
}

function positiveDuration(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) throw new Error(`Command gate ${label} must be positive.`);
  return resolved;
}
