/** Complete the installed SDK's cancellation surface without replacing its constructors. */
export function installMobileAbortSignalRuntime(signalConstructor: Pick<typeof AbortSignal, "prototype"> = AbortSignal,
  controllerConstructor: Pick<typeof AbortController, "prototype"> = AbortController): void {
  if (!("reason" in signalConstructor.prototype)) {
    const reasons = new WeakMap<AbortSignal, unknown>();
    Object.defineProperty(signalConstructor.prototype, "reason", {
      configurable: true,
      enumerable: true,
      get(this: AbortSignal): unknown { return reasons.get(this); }
    });
    const descriptor = Object.getOwnPropertyDescriptor(controllerConstructor.prototype, "abort");
    const originalAbort = controllerConstructor.prototype.abort;
    Object.defineProperty(controllerConstructor.prototype, "abort", {
      ...descriptor,
      value: function abort(this: AbortController, ...arguments_: unknown[]): void {
        const reason = arguments_[0];
        const signal = this.signal;
        if (!signal.aborted) {
          // Older RN abort-controller dispatches synchronously and ignores the
          // argument. Listeners must see the original reason during that event.
          reasons.set(signal, reason === undefined ? new DOMException("The operation was aborted.", "AbortError") : reason);
        }
        originalAbort.call(this, reason);
      }
    });
  }
  if (typeof signalConstructor.prototype.throwIfAborted === "function") return;
  Object.defineProperty(signalConstructor.prototype, "throwIfAborted", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function (this: AbortSignal): void {
      if (!this.aborted) return;
      if ("reason" in this) throw this.reason;
      throw new DOMException("The operation was aborted.", "AbortError");
    }
  });
}

installMobileAbortSignalRuntime();
