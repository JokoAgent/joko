interface RetirementEventSource<Event extends string> {
  isDestroyed(): boolean;
  once(event: Event, listener: () => void): unknown;
  removeListener(event: Event, listener: () => void): unknown;
}

/** Observe the captured native window and guest context before dispatching close. */
export function observePackagedSmokeWindowRetirement(options: {
  readonly window: RetirementEventSource<"closed">;
  readonly contents: RetirementEventSource<"destroyed">;
  readonly observe?: (stage: "native_closed" | "contents_destroyed") => void;
}): { wait(deadline: number): Promise<void>; cancel(): void } {
  let nativeClosed = false;
  let contentsDestroyed = false;
  let settled = false;
  let deadline: number | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // A preceding close/focus assertion may fail before this promise is awaited.
  // The original failure stays authoritative while finally cancels the observer.
  void completion.catch(() => undefined);
  const progress = (stage: "native_closed" | "contents_destroyed"): void => {
    try { options.observe?.(stage); } catch { /* Diagnostics do not own retirement. */ }
  };
  const finish = (error?: unknown): void => {
    if (settled) return;
    settled = true;
    if (timeout !== undefined) clearTimeout(timeout);
    options.window.removeListener("closed", closed);
    options.contents.removeListener("destroyed", destroyed);
    if (error === undefined) resolveCompletion(); else rejectCompletion(error);
  };
  const incompleteError = (): Error => new Error("Packaged Inspector original window surface did not retire before reopening.");
  const complete = (): void => {
    if (nativeClosed && contentsDestroyed) finish(deadline !== undefined && Date.now() > deadline ? incompleteError() : undefined);
  };
  const closed = (): void => {
    if (nativeClosed || settled) return;
    nativeClosed = true;
    progress("native_closed");
    complete();
  };
  const destroyed = (): void => {
    if (contentsDestroyed || settled) return;
    contentsDestroyed = true;
    progress("contents_destroyed");
    complete();
  };
  try {
    options.window.once("closed", closed);
    options.contents.once("destroyed", destroyed);
    // A received native closed event forbids later native-window inspection.
    if (!nativeClosed && options.window.isDestroyed()) closed();
    if (!contentsDestroyed && options.contents.isDestroyed()) destroyed();
  } catch (error) {
    finish(error);
  }
  return {
    wait: (originalDeadline) => {
      // Registration precedes close. Only the subsequent reopen phase owns
      // this deadline, so the existing native-close/reload budgets stay intact.
      if (!settled && deadline === undefined) {
        deadline = originalDeadline;
        timeout = setTimeout(() => finish(incompleteError()), Math.max(0, originalDeadline - Date.now()));
      }
      return completion;
    },
    cancel: () => finish(new Error("Packaged Inspector retirement observation was cancelled."))
  };
}
