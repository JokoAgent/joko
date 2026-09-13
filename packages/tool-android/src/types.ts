export type AndroidHostPlatform = "darwin" | "linux" | "win32" | "unsupported";

export type AndroidAdbPathSource =
  | "bundled"
  | "custom"
  | "environment"
  | "fallback"
  | "path"
  | "prepared"
  | "sdk";

export type AndroidDeviceState = "device" | "offline" | "unauthorized" | "unknown";

export interface AndroidConnectedDevice {
  readonly serial: string;
  readonly state: AndroidDeviceState;
  readonly product?: string;
  readonly model?: string;
  readonly device?: string;
  readonly transportId?: string;
  readonly usb?: string;
}

export interface AndroidInstallationStatus {
  readonly state: "installed" | "missing" | "unsupported";
  readonly executablePath?: string;
  readonly pathSource: AndroidAdbPathSource;
  readonly version?: string;
  readonly preparation?: {
    readonly supported: boolean;
    readonly attempted: boolean;
    readonly ready: boolean;
    readonly executablePath?: string;
    readonly error?: string;
  };
}

export interface AndroidServerStatus {
  readonly state: "running" | "stopped" | "unknown";
  readonly port: number;
  readonly managedByRuntime: boolean;
}

export type AndroidRuntimeIssue =
  | "adb_not_found"
  | "device_offline"
  | "device_unauthorized"
  | "multiple_devices"
  | "no_device"
  | "unsupported_platform";

export interface AndroidRuntimeStatus {
  readonly supported: boolean;
  readonly platform: AndroidHostPlatform;
  readonly architecture: string;
  readonly installation: AndroidInstallationStatus;
  readonly server: AndroidServerStatus;
  readonly devices: readonly AndroidConnectedDevice[];
  readonly configuredDefaultDeviceSerial?: string;
  readonly selectedDeviceSerial?: string;
  readonly issue?: AndroidRuntimeIssue;
  readonly error?: string;
  readonly activityState: AndroidRuntimeActivityState;
}

export type AndroidRuntimeActivityState = "checking" | "idle" | "preparing";

export interface AndroidScreenState {
  readonly width: number;
  readonly height: number;
  readonly density: number | null;
}

export interface AndroidCurrentAppState {
  readonly packageName: string | null;
  readonly activity: string | null;
}

export interface AndroidUiBounds {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface AndroidUiNode {
  readonly index: number;
  readonly text?: string;
  readonly contentDescription?: string;
  readonly className?: string;
  readonly resourceId?: string;
  readonly packageName?: string;
  readonly bounds: AndroidUiBounds;
  readonly clickable: boolean;
  readonly enabled: boolean;
  readonly focusable?: boolean;
  readonly longClickable?: boolean;
  readonly scrollable?: boolean;
  readonly checked?: boolean;
  readonly selected?: boolean;
  readonly password?: boolean;
}

export interface AndroidScreenshot {
  readonly mimeType: "image/png";
  readonly dataBase64: string;
  readonly byteLength: number;
}

export interface AndroidDeviceSnapshot {
  readonly deviceSerial: string;
  readonly screen: AndroidScreenState;
  readonly currentApp: AndroidCurrentAppState;
  readonly screenshot: AndroidScreenshot;
  readonly nodes: readonly AndroidUiNode[];
  readonly nodesTruncated: boolean;
  readonly capturedAt: number;
  readonly uiDumpError?: string;
}

export type AndroidKey =
  | "APP_SWITCH"
  | "BACK"
  | "DPAD_CENTER"
  | "DPAD_DOWN"
  | "DPAD_LEFT"
  | "DPAD_RIGHT"
  | "DPAD_UP"
  | "ENTER"
  | "HOME"
  | "POWER";

export interface AndroidPoint {
  readonly x: number;
  readonly y: number;
}

export interface AndroidInstallOptions {
  readonly replace?: boolean;
  readonly allowDowngrade?: boolean;
  readonly grantRuntimePermissions?: boolean;
  readonly allowTestPackage?: boolean;
}

export type AndroidRuntimeErrorCode =
  | "adb_not_found"
  | "artifact_invalid"
  | "artifact_outside_roots"
  | "artifact_too_large"
  | "command_failed"
  | "device_offline"
  | "device_unauthorized"
  | "invalid_coordinate"
  | "invalid_device_serial"
  | "invalid_endpoint"
  | "invalid_node"
  | "invalid_session"
  | "multiple_devices"
  | "no_device"
  | "server_not_owned"
  | "snapshot_failed"
  | "unsafe_input"
  | "unsupported_key"
  | "unsupported_platform";

export class AndroidRuntimeError extends Error {
  constructor(
    readonly code: AndroidRuntimeErrorCode,
    message: string,
    readonly safeDetails?: Readonly<Record<string, unknown>>
  ) {
    super(message);
    this.name = "AndroidRuntimeError";
  }
}
