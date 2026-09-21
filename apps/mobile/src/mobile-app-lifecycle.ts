export type MobileAppLifecycleState = "active" | "inactive" | "background" | "unknown";

export interface MobileAppLifecycleTransition {
  readonly state: MobileAppLifecycleState;
  readonly interactive: boolean;
  /** Present only when the authenticated transport must change lifecycle. */
  readonly transportForeground?: boolean;
  /** True only when transport crosses a real background boundary. */
  readonly enteredBackground: boolean;
  /** True for cold activation or recovery from a real background, not inactive jitter. */
  readonly enteredForeground: boolean;
}

export interface MobileNetworkPath {
  readonly type?: string;
  readonly isConnected?: boolean;
  readonly isInternetReachable?: boolean;
}

/**
 * AppState's `inactive` is an interaction fence, not evidence that the app
 * entered the background. iOS system sheets and Control Center routinely
 * produce active -> inactive -> active; retiring the authenticated transport
 * on that path cancels the very native operation which caused the transition.
 */
export class MobileAppLifecycleCoordinator {
  #state: MobileAppLifecycleState;
  #transportForeground: boolean;

  constructor(initialState: string) {
    this.#state = normalizeMobileAppLifecycleState(initialState);
    this.#transportForeground = this.#state === "active";
  }

  get state(): MobileAppLifecycleState { return this.#state; }
  get transportForeground(): boolean { return this.#transportForeground; }

  transition(rawState: string): MobileAppLifecycleTransition {
    const state = normalizeMobileAppLifecycleState(rawState);
    this.#state = state;
    let transportForeground: boolean | undefined;
    if (state === "background" && this.#transportForeground) {
      this.#transportForeground = false;
      transportForeground = false;
    } else if (state === "active" && !this.#transportForeground) {
      this.#transportForeground = true;
      transportForeground = true;
    }
    return Object.freeze({
      state,
      interactive: state === "active",
      ...(transportForeground === undefined ? {} : { transportForeground }),
      enteredBackground: transportForeground === false,
      enteredForeground: transportForeground === true
    });
  }
}

export function normalizeMobileAppLifecycleState(value: string): MobileAppLifecycleState {
  return value === "active" || value === "inactive" || value === "background" ? value : "unknown";
}

/** Ignore the listener's initial snapshot and semantically identical repeats. */
export function mobileNetworkPathChanged(
  previous: MobileNetworkPath | undefined,
  next: MobileNetworkPath
): boolean {
  return previous !== undefined && (previous.type !== next.type
    || previous.isConnected !== next.isConnected
    || previous.isInternetReachable !== next.isInternetReachable);
}
