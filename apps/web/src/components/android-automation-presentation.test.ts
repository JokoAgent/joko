import { describe, expect, it } from "vitest";

import { translate } from "../i18n.js";
import type { AndroidAutomationSettingsView } from "../model.js";
import {
  androidConnectionGuideKind,
  androidDeviceLabel,
  describeAndroidDeviceStatus
} from "./android-automation-presentation.js";

const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]): string =>
  translate("en", key, values);

describe("Android automation presentation", () => {
  it("labels devices with their model and serial", () => {
    expect(androidDeviceLabel(device("device-1", "device", "Pixel 9"))).toBe("Pixel 9 (device-1)");
    expect(androidDeviceLabel(device("device-2", "offline"))).toBe("device-2");
  });

  it("prioritizes the explicitly configured unauthorized device", () => {
    const settings = fixture({
      devices: [device("ready-1", "device"), device("chosen", "unauthorized")],
      configuredDefaultDeviceSerial: "chosen",
      issue: "noDevice"
    });
    expect(androidConnectionGuideKind(settings)).toBe("unauthorized");
    expect(describeAndroidDeviceStatus(settings, t)).toContain("default Android device is unavailable");
  });

  it("shows no connection guide whenever an automatic ready device exists", () => {
    const settings = fixture({ devices: [device("ready-1", "device")], issue: "unspecified" });
    expect(androidConnectionGuideKind(settings)).toBeUndefined();
    expect(describeAndroidDeviceStatus(settings, t)).toBe("1 ready device connected");
  });

  it("maps no-device, offline, and disabled states", () => {
    expect(androidConnectionGuideKind(fixture({ issue: "noDevice" }))).toBe("connect");
    expect(androidConnectionGuideKind(fixture({
      devices: [device("device-1", "offline")],
      issue: "deviceOffline"
    }))).toBe("offline");
    expect(androidConnectionGuideKind(fixture({ enabled: false, statusObserved: false }))).toBeUndefined();
    expect(describeAndroidDeviceStatus(fixture({ enabled: false, statusObserved: false }), t)).toContain("is off");
    const observed = fixture({
      enabled: false,
      statusObserved: true,
      devices: [device("device-1", "offline")],
      issue: "deviceOffline"
    });
    expect(androidConnectionGuideKind(observed)).toBe("offline");
    expect(describeAndroidDeviceStatus(observed, t)).toContain("offline");
  });
});

function fixture(overrides: Partial<AndroidAutomationSettingsView> = {}): AndroidAutomationSettingsView {
  return {
    enabled: true,
    support: "supported",
    supportReason: "",
    adbAvailable: true,
    adbPath: "adb",
    adbPathSource: "path",
    preparationSupported: true,
    preparationReady: true,
    preparationError: "",
    adbVersion: "1.0.41",
    devices: [],
    defaultDeviceSerial: "",
    configuredDefaultDeviceSerial: "",
    adbPathOverride: "",
    issue: "noDevice",
    failureReason: "",
    platform: "win32",
    runtimeState: "ready",
    statusObserved: true,
    ...overrides
  };
}

function device(serial: string, state: string, model = "") {
  return {
    deviceSerial: serial,
    state,
    product: "",
    model,
    device: "",
    transportId: "",
    usb: ""
  };
}
