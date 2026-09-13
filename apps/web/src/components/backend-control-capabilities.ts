import { capabilityNames } from "@joko/contracts";
import type { BackendView, DeliveryMode, PermissionMode } from "../model.js";

const PERMISSION_MODES = ["ask", "auto", "bypassPermissions"] as const;

/**
 * Returns only the exact permission modes advertised by the current Backend
 * instance. A missing or empty option catalog carries no implicit defaults:
 * callers must fail closed instead of guessing modes.
 */
export function advertisedPermissionModes(
  backend: Pick<BackendView, "capabilities"> | undefined
): readonly PermissionMode[] {
  const capability = backend?.capabilities.get(capabilityNames.permissionModes);
  if (capability?.supported !== true) return [];
  return PERMISSION_MODES.filter((mode) => capability.options.includes(mode));
}

/** Live permission changes require both the action and its typed option catalog. */
export function permissionChangeSupported(
  backend: Pick<BackendView, "capabilities"> | undefined
): boolean {
  return backend?.capabilities.get(capabilityNames.permissionChange)?.supported === true
    && advertisedPermissionModes(backend).length > 0;
}

/** Plan mode is a standalone public capability, not a permission-option alias. */
export function planModeSupported(
  backend: Pick<BackendView, "capabilities"> | undefined
): boolean {
  return backend?.capabilities.get(capabilityNames.planMode)?.supported === true;
}

/** Queue delivery choices come only from the current Backend manifest. */
export function advertisedQueueDeliveryModes(
  backend: Pick<BackendView, "capabilities"> | undefined
): readonly DeliveryMode[] {
  const result: DeliveryMode[] = [];
  if (backend?.capabilities.get(capabilityNames.inputText)?.supported === true) result.push("prompt");
  if (backend?.capabilities.get(capabilityNames.turnFollowUp)?.supported === true) result.push("followUp");
  if (backend?.capabilities.get(capabilityNames.turnSteer)?.supported === true) result.push("steer");
  return result;
}
