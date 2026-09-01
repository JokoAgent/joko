export interface ManagedExitFenceOptions<Runtime> {
  readonly getInitialization: () => Promise<unknown> | undefined;
  readonly clearInitialization: (initialization: Promise<unknown>) => void;
  readonly getRuntime: () => Runtime | undefined;
  readonly stopRuntime: (runtime: Runtime) => Promise<void>;
  readonly clearRuntime: (runtime: Runtime) => void;
}

export interface ManagedExitFence {
  readonly shutdownStarted: boolean;
  readonly assertInitializationAllowed: () => void;
  readonly stop: () => Promise<void>;
  readonly releaseForRecovery: () => void;
}

/**
 * Serializes a managed child startup with complete-exit/update-apply shutdown.
 * The fence is raised synchronously before the initialization snapshot so a
 * renderer retry cannot spawn a detached child behind the stop operation.
 */
export function createManagedExitFence<Runtime>(options: ManagedExitFenceOptions<Runtime>): ManagedExitFence {
  let shutdownStarted = false;

  return Object.freeze({
    get shutdownStarted(): boolean {
      return shutdownStarted;
    },
    assertInitializationAllowed: (): void => {
      if (shutdownStarted) throw new Error("Managed Orchestrator cannot start during complete exit.");
    },
    stop: async (): Promise<void> => {
      if (shutdownStarted) throw new Error("Managed Orchestrator shutdown is already in progress.");
      shutdownStarted = true;
      try {
        const initialization = options.getInitialization();
        if (initialization !== undefined) {
          await initialization;
          options.clearInitialization(initialization);
        }
        const runtime = options.getRuntime();
        if (runtime !== undefined) {
          await options.stopRuntime(runtime);
          options.clearRuntime(runtime);
        }
      } catch (error) {
        shutdownStarted = false;
        throw error;
      }
    },
    releaseForRecovery: (): void => {
      shutdownStarted = false;
    }
  });
}
