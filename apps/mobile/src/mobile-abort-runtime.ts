/** The native SDK signal exposes cancellation events but lacks this standard guard. */
export function installMobileAbortSignalRuntime(signalConstructor: Pick<typeof AbortSignal, "prototype"> = AbortSignal): void {
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
