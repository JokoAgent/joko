export type DesktopWindowLoadFailureAction = "retry" | "close";
export type DesktopWindowLoadRecoveryResult = "loaded" | "closed";

export interface DesktopWindowLoadRecoveryOptions {
  readonly unavailable: () => boolean;
  readonly load: (attempt: number) => Promise<void>;
  readonly presentFailure: (
    error: unknown,
    attempt: number
  ) => Promise<DesktopWindowLoadFailureAction>;
  readonly close: () => void | Promise<void>;
}

/**
 * Keep a failed BrowserWindow recoverable without retaining an unusable native
 * window identity. Every retry reuses the secured window and its listeners;
 * close is the single terminal path when the user declines or native failure
 * presentation itself is unavailable.
 */
export async function loadDesktopWindowWithRecovery(
  options: DesktopWindowLoadRecoveryOptions
): Promise<DesktopWindowLoadRecoveryResult> {
  return continueDesktopWindowLoadRecovery(options);
}

/** Start at the recovery prompt when a previously loaded renderer is lost. */
export async function recoverDesktopWindowAfterFailure(
  options: DesktopWindowLoadRecoveryOptions,
  error: unknown
): Promise<DesktopWindowLoadRecoveryResult> {
  return continueDesktopWindowLoadRecovery(options, error);
}

async function continueDesktopWindowLoadRecovery(
  options: DesktopWindowLoadRecoveryOptions,
  initialFailure?: unknown
): Promise<DesktopWindowLoadRecoveryResult> {
  let attempt = 0;
  let pendingFailure = initialFailure;
  while (!options.unavailable()) {
    attempt += 1;
    if (pendingFailure === undefined) {
      try {
        await options.load(attempt);
        return "loaded";
      } catch (error) {
        pendingFailure = error;
      }
    }
    if (options.unavailable()) return "closed";
    let action: DesktopWindowLoadFailureAction;
    try {
      action = await options.presentFailure(pendingFailure, attempt);
    } catch (presentationError) {
      await options.close();
      throw presentationError;
    }
    if (options.unavailable()) return "closed";
    if (action === "retry") {
      pendingFailure = undefined;
      continue;
    }
    await options.close();
    return "closed";
  }
  return "closed";
}
