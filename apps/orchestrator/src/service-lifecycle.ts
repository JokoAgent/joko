export interface OrchestratorLifecycleApplication {
  readonly lanDiscovery: { readonly stop: () => Promise<void> };
  readonly close: () => Promise<void>;
}

export interface OrchestratorLifecycleServer {
  readonly close: () => Promise<void>;
  readonly log?: { readonly info: (fields: { readonly signal: string }, message: string) => void };
}

export class OrchestratorStartupInterruptedError extends Error {
  constructor() {
    super("Orchestrator startup was interrupted by shutdown.");
    this.name = "OrchestratorStartupInterruptedError";
  }
}

/**
 * Own every resource from the first application allocation through listener
 * startup. Shutdown intent is sticky: known resources close immediately to
 * unblock in-flight listen calls, and anything registered later is closed as
 * soon as it appears. The authoritative close promise waits until startup has
 * stopped producing resources, so no late listener can escape cleanup.
 */
export class OrchestratorServiceLifecycle {
  readonly #application: OrchestratorLifecycleApplication;
  readonly #disposeBootstrap: () => void;
  readonly #drainPromises: Promise<void>[] = [];
  readonly #cleanupErrors: unknown[] = [];
  readonly #closedResources = new Set<object>();
  readonly #startupSettled: Promise<void>;
  #settleStartup!: () => void;
  #startupFinished = false;
  #shutdownSignal: string | undefined;
  #closePromise: Promise<void> | undefined;
  #publicServer: OrchestratorLifecycleServer | undefined;
  #internalServer: OrchestratorLifecycleServer | undefined;
  #stopPairingAnnouncements: (() => void) | undefined;
  #bootstrapDisposed = false;

  constructor(application: OrchestratorLifecycleApplication, disposeBootstrap: () => void) {
    this.#application = application;
    this.#disposeBootstrap = disposeBootstrap;
    this.#startupSettled = new Promise<void>((resolve) => { this.#settleStartup = resolve; });
  }

  get shutdownRequested(): boolean {
    return this.#shutdownSignal !== undefined;
  }

  registerPublicServer<T extends OrchestratorLifecycleServer>(server: T): T {
    this.#publicServer = server;
    if (this.shutdownRequested) this.#closeResource(server, () => server.close());
    return server;
  }

  registerInternalServer<T extends OrchestratorLifecycleServer>(server: T): T {
    this.#internalServer = server;
    if (this.shutdownRequested) this.#closeResource(server, () => server.close());
    return server;
  }

  registerPairingAnnouncements(stop: () => void): void {
    if (this.shutdownRequested) {
      stop();
      return;
    }
    this.#stopPairingAnnouncements = stop;
  }

  assertStartupActive(): void {
    if (this.shutdownRequested) throw new OrchestratorStartupInterruptedError();
  }

  finishStartup(): void {
    if (this.#startupFinished) return;
    this.#startupFinished = true;
    this.#settleStartup();
  }

  requestShutdown(signal: string): Promise<void> {
    if (this.#shutdownSignal === undefined) {
      this.#shutdownSignal = signal;
      this.#publicServer?.log?.info({ signal }, "Orchestrator is shutting down");
      this.#disposeBootstrapOnce();
      this.#stopPairingAnnouncements?.();
      this.#stopPairingAnnouncements = undefined;
      this.#closeResource(this.#application.lanDiscovery, () => this.#application.lanDiscovery.stop());
      if (this.#internalServer !== undefined) {
        this.#closeResource(this.#internalServer, () => this.#internalServer!.close());
      }
      if (this.#publicServer !== undefined) {
        this.#closeResource(this.#publicServer, () => this.#publicServer!.close());
      }
    }
    this.#closePromise ??= (async () => {
      await this.#startupSettled;
      // Registrations after shutdown enqueue their cleanup synchronously. Once
      // startup is settled, the list can no longer grow.
      await Promise.all(this.#drainPromises);
      // Store/session/application state stays available until every listener
      // has stopped accepting and drained in-flight requests.
      await this.#application.close().catch((error: unknown) => {
        this.#cleanupErrors.push(error);
      });
      if (this.#cleanupErrors.length > 0) {
        throw new Error("Orchestrator shutdown could not close all resources.");
      }
    })();
    return this.#closePromise;
  }

  #disposeBootstrapOnce(): void {
    if (this.#bootstrapDisposed) return;
    this.#bootstrapDisposed = true;
    try { this.#disposeBootstrap(); } catch { /* best-effort shutdown */ }
  }

  #closeResource(resource: object, close: () => Promise<void>): void {
    if (this.#closedResources.has(resource)) return;
    this.#closedResources.add(resource);
    this.#drainPromises.push(Promise.resolve().then(close).catch((error: unknown) => {
      this.#cleanupErrors.push(error);
    }));
  }
}
