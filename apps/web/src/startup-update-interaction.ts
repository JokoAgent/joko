const startupUpdateInteractionOwners = new Set<symbol>();

/**
 * The startup updater is a renderer-wide modal, including its minimum-visible
 * hold after main releases the startup gate. Owners are tokens so React cleanup
 * stays idempotent across Strict Mode and interrupted commits.
 */
export function acquireStartupUpdateInteractionBarrier(): () => void {
  const owner = Symbol("startup-update-interaction");
  startupUpdateInteractionOwners.add(owner);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    startupUpdateInteractionOwners.delete(owner);
  };
}

export function isStartupUpdateInteractionBlocked(): boolean {
  return startupUpdateInteractionOwners.size > 0;
}

/** Test seam for suites that intentionally interrupt a mounted React tree. */
export function resetStartupUpdateInteractionBarrierForTests(): void {
  startupUpdateInteractionOwners.clear();
}
