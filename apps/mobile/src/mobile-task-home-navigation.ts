export interface MobileHomeViewState {
  readonly search: string;
  readonly statusFilter: "active" | "archived" | "all";
}

export type MobileHomeNavigationIntent =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "new-task" | "incoming-share" | "home" | "menu" | "search" }
  | { readonly kind: "page"; readonly action: () => void };

export interface MobileTaskHomeNavigationScope {
  readonly sourceKey: string;
  readonly sessionId: string | undefined;
  readonly runtimeKey: string;
}

export interface MobileTaskHomeNavigationPorts {
  readScope(): MobileTaskHomeNavigationScope | undefined;
  close(): void;
  prepare(isCurrent: () => boolean): Promise<void>;
  execute(intent: MobileHomeNavigationIntent, sourceCurrent: () => boolean): Promise<void>;
  failed(error: unknown): void;
  changed?(): void;
}

interface PendingNavigation {
  readonly scope: MobileTaskHomeNavigationScope;
  readonly intent: MobileHomeNavigationIntent;
}

/** An ephemeral UI intent without task content, credentials or effect receipts. */
export class MobileTaskHomeNavigation {
  #pending: PendingNavigation | undefined;
  #running: PendingNavigation | undefined;
  #closing = false;
  #executing = false;

  constructor(private readonly ports: MobileTaskHomeNavigationPorts) {}

  get busy(): boolean { return this.#closing || this.#pending !== undefined || this.#running !== undefined; }

  close(): void {
    if (this.#closing) return;
    this.#closing = true;
    this.ports.changed?.();
    this.ports.close();
  }

  request(intent: MobileHomeNavigationIntent, modal: boolean): void {
    if (this.busy) return;
    const scope = this.ports.readScope();
    if (!scope) return;
    if (intent.kind === "session" && intent.sessionId === scope.sessionId) {
      if (modal) this.close();
      return;
    }
    const delivery = this.defer(intent);
    if (!delivery) return;
    if (modal) this.close(); else delivery();
  }

  /** Capture before an enclosing menu starts closing, then deliver after its unmount. */
  defer(intent: MobileHomeNavigationIntent): (() => void) | undefined {
    if (this.busy) return;
    const scope = this.ports.readScope();
    if (!scope) return;
    const pending = { scope, intent };
    this.#pending = pending;
    this.ports.changed?.();
    return () => { if (this.#pending === pending) void this.#deliver(pending); };
  }

  closed(): void {
    this.#closing = false;
    this.ports.changed?.();
    const pending = this.#pending;
    if (pending) void this.#deliver(pending);
  }

  retire(): void {
    this.#pending = undefined;
    this.#running = undefined;
    this.#closing = false;
    this.#executing = false;
    this.ports.changed?.();
  }

  observeScope(): void {
    const pending = this.#running ?? this.#pending;
    if (!pending) return;
    const actual = this.ports.readScope();
    if (actual?.sourceKey === pending.scope.sourceKey) {
      if (actual.sessionId === pending.scope.sessionId && actual.runtimeKey === pending.scope.runtimeKey) return;
      if (this.#executing && pending.intent.kind === "session" && actual.sessionId === pending.intent.sessionId) return;
    }
    this.retire();
  }

  async #deliver(pending: PendingNavigation): Promise<void> {
    if (this.#pending !== pending || this.#running) return;
    this.#pending = undefined;
    this.#running = pending;
    const sourceCurrent = (): boolean => this.#running === pending
      && this.ports.readScope()?.sourceKey === pending.scope.sourceKey;
    const current = (): boolean => {
      const actual = this.ports.readScope();
      return actual !== undefined && sourceCurrent() && actual.sessionId === pending.scope.sessionId
        && actual.runtimeKey === pending.scope.runtimeKey;
    };
    try {
      if (!current()) return;
      await this.ports.prepare(current);
      if (!current()) return;
      this.#executing = true;
      await this.ports.execute(pending.intent, sourceCurrent);
    } catch (error) {
      if (current()) this.ports.failed(error);
    } finally {
      if (this.#running === pending) { this.#running = undefined; this.#executing = false; }
      this.ports.changed?.();
    }
  }
}
