import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { installMobileAbortSignalRuntime } from "./mobile-abort-runtime";

const sdkRequire = createRequire(createRequire(import.meta.url).resolve("react-native/package.json"));
const native = sdkRequire("abort-controller") as { AbortController: typeof AbortController; AbortSignal: typeof AbortSignal };

it("lets the installed native SDK signals guard active reads and reject cancellation without changing standard signals", () => {
  const prototype = native.AbortSignal.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, "throwIfAborted");
  const originalReason = Object.getOwnPropertyDescriptor(prototype, "reason");
  const originalAbort = Object.getOwnPropertyDescriptor(native.AbortController.prototype, "abort")!;
  try {
    installMobileAbortSignalRuntime(native.AbortSignal, native.AbortController);
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
    const standardAbort = AbortController.prototype.abort;
    installMobileAbortSignalRuntime();
    expect(AbortSignal.prototype.throwIfAborted).toBe(guard);
    expect(AbortController.prototype.abort).toBe(standardAbort);
    const reason = new Error("Explicit cancellation");
    const standard = new AbortController();
    standard.abort(reason);
    expect(() => standard.signal.throwIfAborted()).toThrow(reason);
  } finally {
    if (original) Object.defineProperty(prototype, "throwIfAborted", original);
    else Reflect.deleteProperty(prototype, "throwIfAborted");
    if (originalReason) Object.defineProperty(prototype, "reason", originalReason);
    else Reflect.deleteProperty(prototype, "reason");
    Object.defineProperty(native.AbortController.prototype, "abort", originalAbort);
  }
});

it("preserves the first native reason before synchronous abort listeners and keeps native constructor behavior", () => {
  const signalPrototype = native.AbortSignal.prototype, controllerPrototype = native.AbortController.prototype;
  const guard = Object.getOwnPropertyDescriptor(signalPrototype, "throwIfAborted");
  const reason = Object.getOwnPropertyDescriptor(signalPrototype, "reason");
  const abort = Object.getOwnPropertyDescriptor(controllerPrototype, "abort")!;
  const constructor = native.AbortController;
  try {
    installMobileAbortSignalRuntime(native.AbortSignal, native.AbortController);
    const patched = controllerPrototype.abort;
    installMobileAbortSignalRuntime(native.AbortSignal, native.AbortController);
    expect(controllerPrototype.abort).toBe(patched);
    expect(native.AbortController).toBe(constructor);
    const controller = new constructor(), observed: unknown[] = [];
    const first = Object.assign(new Error("The operation deadline elapsed."), { code: "deadline_exceeded" });
    controller.signal.addEventListener("abort", () => observed.push(controller.signal.reason));
    controller.abort(first);
    controller.abort(new Error("Later cancellation"));
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe(first);
    expect(observed).toEqual([first]);
    expect(() => controller.signal.throwIfAborted()).toThrow(first);
    const explicitNull = new constructor(); explicitNull.abort(null);
    expect(explicitNull.signal.reason).toBeNull();
    expect(() => constructor.prototype.abort.call({} as AbortController)).toThrow(TypeError);
  } finally {
    if (guard) Object.defineProperty(signalPrototype, "throwIfAborted", guard); else Reflect.deleteProperty(signalPrototype, "throwIfAborted");
    if (reason) Object.defineProperty(signalPrototype, "reason", reason); else Reflect.deleteProperty(signalPrototype, "reason");
    Object.defineProperty(controllerPrototype, "abort", abort);
  }
});
