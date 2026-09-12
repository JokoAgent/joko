/** Serializes acquisition, renewal and release against the callback that owns the lock. */
export class QueueLockLease {
  private tail = Promise.resolve();
  private releaseResult: Promise<void> | undefined;
  constructor(private readonly setLocked: (locked: boolean) => Promise<void>) {}

  acquire(): Promise<void> {
    if (this.releaseResult !== undefined) return Promise.reject(new Error("The queue interaction has ended."));
    const result = this.tail.catch(() => undefined).then(() => {
      if (this.releaseResult !== undefined) throw new Error("The queue interaction has ended.");
      return this.setLocked(true);
    });
    this.tail = result;
    return result;
  }

  release(): Promise<void> {
    // A lost acquisition acknowledgement may still own a server lock. Always
    // attempt the exact token release, after every in-flight acquisition settles.
    this.releaseResult ??= this.tail.catch(() => undefined).then(() => this.setLocked(false));
    return this.releaseResult;
  }
}
