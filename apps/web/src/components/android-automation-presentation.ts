import type {
  AndroidAutomationSettingsView,
  AndroidDeviceView
} from "../model.js";
import type { Translator } from "./types.js";

export type AndroidConnectionGuideKind = "connect" | "unauthorized" | "offline";

export function androidDeviceLabel(device: AndroidDeviceView | undefined): string {
  if (device === undefined) return "";
  return device.model.trim() === ""
    ? device.deviceSerial
    : `${device.model} (${device.deviceSerial})`;
}

export function describeAndroidDeviceStatus(
  settings: AndroidAutomationSettingsView,
  t: Translator
): string {
  const readyDevices = settings.devices.filter((device) => device.state === "device");
  if (!settings.enabled && !settings.statusObserved) return t("settings.automationAndroidDisabled");
  if (settings.runtimeState === "checking") return t("settings.automationAndroidChecking");
  if (settings.runtimeState === "preparing") return t("settings.automationAndroidPreparing");
  if (settings.issue === "adbNotFound") return t("settings.automationAndroidAdbNotFound");
  if (!settings.adbAvailable && settings.issue === "driverError") {
    return t("settings.automationAndroidFailed", {
      message: settings.failureReason || settings.issue
    });
  }
  if (!settings.adbAvailable) {
    return settings.issue === "unspecified"
      ? t("settings.automationAndroidAdbNotFound")
      : t("settings.automationAndroidUnknownIssue", { issue: settings.issue });
  }
  if (settings.issue === "noDevice") {
    return settings.configuredDefaultDeviceSerial.trim() === ""
      ? t("settings.automationAndroidNoDevice")
      : t("settings.automationAndroidDefaultUnavailable", {
          device: settings.configuredDefaultDeviceSerial
        });
  }
  if (settings.issue === "multipleDevices") {
    return t("settings.automationAndroidMultipleDevices", { count: readyDevices.length });
  }
  if (settings.issue === "deviceUnauthorized") return t("settings.automationAndroidUnauthorized");
  if (settings.issue === "deviceOffline") return t("settings.automationAndroidOffline");
  if (settings.issue === "driverError") {
    return t("settings.automationAndroidFailed", {
      message: settings.failureReason || settings.issue
    });
  }
  if (settings.issue !== "unspecified") {
    return t("settings.automationAndroidUnknownIssue", { issue: settings.issue });
  }
  if (readyDevices.length === 0) return t("settings.automationAndroidNoDevice");
  return t("settings.automationAndroidDeviceConnected", { count: readyDevices.length });
}

export function androidConnectionGuideKind(
  settings: AndroidAutomationSettingsView
): AndroidConnectionGuideKind | undefined {
  if ((!settings.enabled && !settings.statusObserved) || !settings.adbAvailable) return undefined;
  const configured = settings.configuredDefaultDeviceSerial.trim();
  const selected = configured === ""
    ? undefined
    : settings.devices.find((device) => device.deviceSerial === configured);
  if (selected?.state === "unauthorized") return "unauthorized";
  if (selected?.state === "offline") return "offline";
  if (settings.devices.some((device) => device.state === "device")) return undefined;
  if (settings.devices.some((device) => device.state === "unauthorized")) return "unauthorized";
  if (settings.devices.some((device) => device.state === "offline")) return "offline";
  if (settings.issue === "deviceUnauthorized") return "unauthorized";
  if (settings.issue === "deviceOffline") return "offline";
  if (settings.issue === "noDevice" || settings.issue === "unspecified") return "connect";
  return undefined;
}
