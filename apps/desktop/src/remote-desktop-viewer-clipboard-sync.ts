import { createHash } from "node:crypto";
import { fromBinary } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { RemoteDesktopService, RemoteDesktopFailureReason as Failure,
  type DesktopRemoteDesktopViewerClipboardSyncState, type RemoteDesktopLease } from "@joko/contracts";
import { ClipboardSync, ClipboardSyncError, getClipboardSyncFailure,
  type ClipboardSyncBaseline, type ClipboardSyncRemote, type LocalClipboardReadCache } from "@joko/remote-desktop-sync";
import { DesktopRemoteDesktopClipboardCounter } from "./remote-desktop-clipboard-counter.js";
import { DesktopRemoteDesktopClipboard, parseClipboardContent } from "./remote-desktop-clipboard.js";
import type { DesktopRemoteDesktopViewerConnection } from "./remote-desktop-viewer-connection.js";

export interface DesktopViewerSyncClipboard {
  readonly platform?: NodeJS.Platform;
  readonly available: boolean;
  version(signal: AbortSignal, current?: () => boolean): Promise<string>;
  read(current: () => boolean, signal: AbortSignal): Promise<string>;
  write(json: string, version: string, current: () => boolean, signal: AbortSignal): Promise<string>;
  stop(): void;
}
export interface DesktopViewerClipboardSyncScope {
  readonly connection: DesktopRemoteDesktopViewerConnection;
  readonly generation: number;
  readonly focusRevision: number;
  readonly desired: boolean;
  readonly eligible: boolean;
}
interface Occurrence {
  readonly connection: DesktopRemoteDesktopViewerConnection;
  readonly lease: RemoteDesktopLease;
  readonly key: string;
  syncGeneration?: bigint;
}

/** One window's system-only clipboard owner. Only metadata leaves Main. */
export class DesktopRemoteDesktopViewerClipboardSync {
  #revision = 0;
  #key?: string;
  #abort = new AbortController();
  #baseline: ClipboardSyncBaseline = { local: "", remote: "" };
  #cache: LocalClipboardReadCache = {};
  #enabled?: Occurrence;
  #operation?: Occurrence;
  #pending = false;
  #clearing = 0;
  #retired = false;
  #retryAt = 0;
  #failures = 0;
  #state: DesktopRemoteDesktopViewerClipboardSyncState;
  #timer: ReturnType<typeof setInterval>;
  #settled: Promise<void> = Promise.resolve();
  #clearOperations = new Set<Promise<void>>();
  constructor(private readonly options: {
    readonly scope: () => DesktopViewerClipboardSyncScope;
    readonly changed: () => void;
    readonly clipboard?: DesktopViewerSyncClipboard;
  }) {
    this.clipboard = options.clipboard ?? nativeClipboard();
    this.#state = { available: this.clipboard.available, active: false, pending: false };
    this.#timer = setInterval(() => this.refresh(), 1_500); this.#timer.unref?.();
  }
  private readonly clipboard: DesktopViewerSyncClipboard;
  get snapshot(): DesktopRemoteDesktopViewerClipboardSyncState { return this.#state; }
  private publish(patch: Partial<DesktopRemoteDesktopViewerClipboardSyncState>): void {
    const next = { ...this.#state, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.#state)) return;
    this.#state = next; this.options.changed();
  }
  private scopeKey(scope: DesktopViewerClipboardSyncScope): string | undefined {
    const lease = scope.connection.lease;
    return !this.#retired && scope.desired && scope.eligible && this.clipboard.available &&
      scope.connection.current && scope.connection.caps?.clipboardSync && lease?.controlling
      ? `${scope.generation}:${lease.leaseId}:${lease.controlGeneration}:${scope.focusRevision}` : undefined;
  }
  refresh(resetBaseline = false): void {
    if (this.#retired) return;
    const scope = this.options.scope();
    if (!scope.desired || resetBaseline) {
      this.#baseline = { local: "", remote: "" }; this.#cache = {};
      this.#retryAt = 0; this.#failures = 0; this.publish({ notice: undefined });
    }
    const key = this.scopeKey(scope);
    if (key !== this.#key || resetBaseline) {
      this.invalidate(); this.#key = key;
    }
    this.publish({ available: this.clipboard.available && scope.connection.caps?.clipboardSync === true,
      pending: this.#pending || this.#clearing > 0 });
    if (key && !this.#pending && !this.#clearing && Date.now() >= this.#retryAt) this.#settled = this.tick(scope, key);
  }
  async pause(): Promise<void> {
    this.refresh(); await this.#settled;
    while (this.#clearOperations.size) await Promise.all([...this.#clearOperations]);
  }
  retry(): void {
    this.#retryAt = 0; this.#failures = 0; this.publish({ notice: undefined }); this.refresh(true);
  }
  private invalidate(): void {
    this.#revision++; this.#abort.abort(); this.#abort = new AbortController(); this.clipboard.stop();
    this.#key = undefined;
    const occurrence = this.#enabled ?? this.#operation;
    this.#enabled = undefined;
    this.publish({ active: false });
    if (occurrence) this.clearHost(occurrence);
  }
  private clearHost(occurrence: Occurrence): void {
    this.#clearing++; this.publish({ pending: true });
    const check = (): void => {
      const lease = occurrence.connection.lease;
      if (!occurrence.connection.current || lease?.leaseId !== occurrence.lease.leaseId ||
        lease.controlGeneration !== occurrence.lease.controlGeneration) throw new ClipboardSyncError("expired");
    };
    const operation = occurrence.connection.syncRequest("setRemoteDesktopClipboardSync", { request: {
      leaseId: occurrence.lease.leaseId, controlGeneration: occurrence.lease.controlGeneration, enabled: false
    } }, occurrence.lease, check).then(() => undefined, () => undefined).finally(() => {
      this.#clearing--; this.publish({ pending: this.#pending || this.#clearing > 0 });
      this.#clearOperations.delete(operation);
      if (!this.#retired) this.refresh();
    });
    this.#clearOperations.add(operation);
  }
  private async tick(scope: DesktopViewerClipboardSyncScope, key: string): Promise<void> {
    const lease = scope.connection.lease;
    if (!lease || this.#pending || this.#clearing) return;
    const revision = this.#revision, signal = this.#abort.signal;
    const occurrence = this.#enabled ?? { connection: scope.connection, lease, key };
    this.#operation = occurrence; this.#pending = true; this.publish({ pending: true });
    const current = (): boolean => !signal.aborted && revision === this.#revision && key === this.scopeKey(this.options.scope());
    const check = (): void => { if (!current()) throw new ClipboardSyncError("expired"); };
    const request = async (name: "setRemoteDesktopClipboardSync" | "getRemoteDesktopClipboardVersion" | "transferRemoteDesktopClipboardContent", input: Record<string, unknown>) => {
      check();
      const reply = await scope.connection.syncRequest(name, input, lease, check); check();
      if (!reply.ok) throw wireFailure(reply.code, reply.reason);
      return reply.bytes;
    };
    const transfer = async (action: object, version?: string, inline = false) => {
      const bytes = await request("transferRemoteDesktopClipboardContent", { transfer: {
        leaseId: lease.leaseId, controlGeneration: lease.controlGeneration, syncGeneration: occurrence.syncGeneration,
        sync: true, inline, ...(version === undefined ? {} : { version }), action
      } });
      const result = fromBinary(RemoteDesktopService.method.transferRemoteDesktopClipboardContent.output, bytes).result;
      if (!result) throw new ClipboardSyncError("unknown");
      return result;
    };
    const remote: ClipboardSyncRemote = {
      version: async () => {
        const bytes = await request("getRemoteDesktopClipboardVersion", { request: {
          leaseId: lease.leaseId, controlGeneration: lease.controlGeneration, syncGeneration: occurrence.syncGeneration
        } });
        const result = fromBinary(RemoteDesktopService.method.getRemoteDesktopClipboardVersion.output, bytes).result;
        if (!result) throw new ClipboardSyncError("unknown"); return result.version;
      },
      copy: async (version, inline) => {
        const result = await transfer({ case: "copy", value: {} }, version, inline);
        return { length: result.length ?? 0, ...(result.transferId ? { id: result.transferId } : {}),
          ...(inline && result.data ? { data: result.data } : {}) };
      },
      begin: async (length, version) => (await transfer({ case: "begin", value: { length } }, version)).transferId ?? "",
      read: async (id, offset) => (await transfer({ case: "read", value: { transferId: id, offset } })).data ?? "",
      write: async (id, offset, data) => { await transfer({ case: "write", value: { transferId: id, offset, data } }); },
      commit: async (id) => (await transfer({ case: "commit", value: { transferId: id } })).version ?? "",
      paste: async (json, version) => (await transfer({ case: "paste", value: { data: json } }, version, true)).version ?? "",
      cancel: async (id) => { await transfer({ case: "cancel", value: { transferId: id } }); }
    };
    try {
      if (!this.#enabled) {
        const bytes = await request("setRemoteDesktopClipboardSync", { request: {
          leaseId: lease.leaseId, controlGeneration: lease.controlGeneration, enabled: true
        } });
        const result = fromBinary(RemoteDesktopService.method.setRemoteDesktopClipboardSync.output, bytes).result;
        if (!result?.enabled || result.syncGeneration <= 0n) throw new ClipboardSyncError("unavailable");
        occurrence.syncGeneration = result.syncGeneration; this.#enabled = occurrence;
      }
      check(); this.publish({ active: true });
      const engine = new ClipboardSync({ remote, current, inline: scope.connection.caps?.clipboardInline === true,
        localVersion: async () => { try { return await this.clipboard.version(signal, current); } catch (error) { throw nativeFailure(error); } },
        readLocal: async () => { try { return await this.clipboard.read(current, signal); } catch (error) { throw nativeFailure(error); } },
        writeLocal: async (json, version) => { try { return await this.clipboard.write(json, version, current, signal); } catch (error) { throw nativeFailure(error); } },
        localReadCache: this.#cache,
        digest: (json) => {
          let content: ReturnType<typeof parseClipboardContent>;
          try { content = parseClipboardContent(JSON.parse(json)); } catch (error) { throw nativeFailure(error); }
          return createHash("sha256").update(JSON.stringify([content.text, content.html, content.rtf, content.url, content.png])).digest("hex");
        },
        trace: (stage) => {
          if (!current()) return;
          if (stage === "content-skipped") this.publish({ notice: "skipped" });
          else if (stage === "local-to-remote-complete" || stage === "remote-to-local-complete") this.publish({ notice: undefined });
        }
      }, this.#baseline);
      await engine.tick(); check(); this.#failures = 0; this.#retryAt = Date.now() + 1_500;
      if (this.#state.notice === "temporary" || this.#state.notice === "permission") this.publish({ notice: undefined });
    } catch (error) {
      if (!current()) return;
      const failure = getClipboardSyncFailure(error, this.#failures++);
      this.#retryAt = failure.delay === null ? Infinity : Date.now() + failure.delay;
      this.publish({ active: false, notice: failure.reason === "outcome-unknown" ? "unknown" : failure.notice === "failed" ? "temporary" : failure.notice });
    } finally {
      this.#operation = undefined; this.#pending = false;
      // A canceled request can have reached the host before its late receipt.
      if (!current()) this.clearHost(occurrence);
      this.publish({ pending: this.#clearing > 0 });
      if (!this.#retired) this.refresh();
    }
  }
  retire(): void {
    if (this.#retired) return;
    this.#retired = true; clearInterval(this.#timer); this.invalidate();
  }
}

export function nativeClipboard(): DesktopViewerSyncClipboard {
  const counter = new DesktopRemoteDesktopClipboardCounter();
  const clipboard = new DesktopRemoteDesktopClipboard(() => undefined);
  return {
    platform: process.platform,
    available: clipboard.available,
    version: (signal, current) => counter.read(true, signal, current),
    read: async (current, signal) => JSON.stringify(await clipboard.readSystemContent(current, signal)),
    write: (json, version, current, signal) => clipboard.writeSystemContent(parseClipboardContent(JSON.parse(json)), version, current, signal),
    stop: () => counter.stop()
  };
}
function nativeFailure(error: unknown): ClipboardSyncError {
  if (error instanceof ClipboardSyncError) return error;
  if (error instanceof Error && "outcomeUnknown" in error && error.outcomeUnknown === true) return new ClipboardSyncError("outcome-unknown");
  const code = error instanceof Error ? error.message : "";
  const reasons = { REMOTE_DESKTOP_CLIPBOARD_EMPTY: "empty", REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED: "unsupported",
    REMOTE_DESKTOP_CLIPBOARD_TOO_LARGE: "too-large", REMOTE_DESKTOP_CLIPBOARD_CHANGED: "changed",
    REMOTE_DESKTOP_CLIPBOARD_EXPIRED: "expired", REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE: "unavailable",
    REMOTE_DESKTOP_CLIPBOARD_WRITE_FAILED: "write-failed", REMOTE_DESKTOP_CLIPBOARD_PERMISSION: "permission" } as const;
  return new ClipboardSyncError(reasons[code as keyof typeof reasons] ?? "unknown");
}
function wireFailure(code: number, reason: Failure): ClipboardSyncError {
  if (code === Code.Aborted && reason === Failure.CLIPBOARD_UNAVAILABLE) return new ClipboardSyncError("outcome-unknown");
  if (code === Code.PermissionDenied || code === Code.Unauthenticated) return new ClipboardSyncError("permission");
  switch (reason) {
    case Failure.CLIPBOARD_EMPTY: return new ClipboardSyncError("empty");
    case Failure.CLIPBOARD_TOO_LARGE: return new ClipboardSyncError("too-large");
    case Failure.CLIPBOARD_UNSUPPORTED: return new ClipboardSyncError("unsupported");
    case Failure.CLIPBOARD_CHANGED: return new ClipboardSyncError("changed");
    case Failure.CLIPBOARD_EXPIRED: return new ClipboardSyncError("expired");
    default: return new ClipboardSyncError("unknown");
  }
}
