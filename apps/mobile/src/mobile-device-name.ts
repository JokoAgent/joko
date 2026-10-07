import { create } from "@bufbuild/protobuf";
import { DeviceNameSourceSchema, type DeviceNameSource } from "@joko/contracts";

export type MobileDeviceNameSourceProvider = () => DeviceNameSource;

export function validMobileDeviceName(value: string): boolean {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(normalized);
}

export function mobileDeviceNameSource(nativeDeviceName: string | null | undefined, platform: string): DeviceNameSource {
  const defaultDisplayName = nativeDeviceName?.trim() || `Joko ${platform}`;
  if (!validMobileDeviceName(defaultDisplayName)) throw new Error("The native device name is invalid.");
  return create(DeviceNameSourceSchema, {
    defaultDisplayName
  });
}
