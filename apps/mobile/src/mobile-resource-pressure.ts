import { requireOptionalNativeModule } from "expo";
import type { EventSubscription } from "expo-modules-core";

export type MobileResourcePressureSeverity = "warning" | "critical";

export interface MobileResourcePressureEvent {
  readonly sequence: number;
  readonly severity: MobileResourcePressureSeverity;
  readonly platform: "android" | "ios";
}

interface NativeResourcePressureModule {
  addListener(
    eventName: "onResourcePressure",
    listener: (event: unknown) => void
  ): EventSubscription;
}

let nativeModule: NativeResourcePressureModule | null = null;
try {
  nativeModule = requireOptionalNativeModule<NativeResourcePressureModule>("JokoMobileResourcePressure");
} catch {
  nativeModule = null;
}

export function mobileResourcePressureSupported(): boolean {
  return nativeModule !== null;
}

export function subscribeMobileResourcePressure(
  listener: (event: MobileResourcePressureEvent) => void,
  source: NativeResourcePressureModule | null = nativeModule
): EventSubscription | undefined {
  if (source === null) return undefined;
  let lastSequence = 0;
  return source.addListener("onResourcePressure", (value) => {
    const event = parseMobileResourcePressureEvent(value);
    if (!event || event.sequence <= lastSequence) return;
    lastSequence = event.sequence;
    listener(event);
  });
}

export function parseMobileResourcePressureEvent(value: unknown): MobileResourcePressureEvent | undefined {
  if (!plainObject(value) || !exactKeys(value, ["sequence", "severity", "platform"])
    || !Number.isSafeInteger(value["sequence"]) || (value["sequence"] as number) < 1
    || (value["severity"] !== "warning" && value["severity"] !== "critical")
    || (value["platform"] !== "android" && value["platform"] !== "ios")) return undefined;
  return {
    sequence: value["sequence"] as number,
    severity: value["severity"],
    platform: value["platform"]
  };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const exact = [...expected].sort();
  return actual.length === exact.length && actual.every((key, index) => key === exact[index]);
}
