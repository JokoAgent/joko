import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { installMobileAbortSignalRuntime } from "./mobile-abort-runtime";

const sdkRequire = createRequire(createRequire(import.meta.url).resolve("react-native/package.json"));
const native = sdkRequire("abort-controller") as { AbortController: typeof AbortController; AbortSignal: typeof AbortSignal };

it("lets the installed native SDK signals guard active reads and reject cancellation without changing standard signals", () => {
  const prototype = native.AbortSignal.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, "throwIfAborted");
  try {
    installMobileAbortSignalRuntime(native.AbortSignal);
    const controller = new native.AbortController();
    expect(() => controller.signal.throwIfAborted()).not.toThrow();
    controller.abort();
    let failure: unknown;
    try { controller.signal.throwIfAborted(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(DOMException);
    expect((failure as DOMException).name).toBe("AbortError");
    Object.defineProperty(controller.signal, "reason", { value: null });
    try { controller.signal.throwIfAborted(); expect.unreachable(); } catch (error) { expect(error).toBeNull(); }
    const guard = AbortSignal.prototype.throwIfAborted;
    installMobileAbortSignalRuntime();
    expect(AbortSignal.prototype.throwIfAborted).toBe(guard);
    const reason = new Error("Explicit cancellation");
    const standard = new AbortController();
    standard.abort(reason);
    expect(() => standard.signal.throwIfAborted()).toThrow(reason);
  } finally {
    if (original) Object.defineProperty(prototype, "throwIfAborted", original);
    else Reflect.deleteProperty(prototype, "throwIfAborted");
  }
});
