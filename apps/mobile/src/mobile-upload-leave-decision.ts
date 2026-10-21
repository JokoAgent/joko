/** One upload attempt owns its leave dialog and the dispatch decision that follows it. */
export class MobileUploadLeaveDecision {
  readonly controller = new AbortController();
  #pending?: { readonly promise: Promise<boolean>; readonly resolve: (discard: boolean) => void };
  #discarded = false;

  requestLeave(confirm: (decide: (discard: boolean) => void) => void, leave: () => void): void {
    if (this.#pending || this.#discarded) return;
    let resolve!: (discard: boolean) => void;
    const pending = { promise: new Promise<boolean>(settle => { resolve = settle; }), resolve: (discard: boolean) => resolve(discard) };
    this.#pending = pending;
    confirm(discard => {
      if (this.#pending !== pending) return;
      this.#pending = undefined;
      if (discard) { this.#discarded = true; this.controller.abort(); }
      pending.resolve(discard);
      if (discard) leave();
    });
  }

  async waitForLeaveDecision(): Promise<boolean> {
    return (await this.#pending?.promise) ?? this.#discarded;
  }

  dispose(): void {
    this.#discarded = true; this.controller.abort();
    this.#pending?.resolve(true); this.#pending = undefined;
  }
}
