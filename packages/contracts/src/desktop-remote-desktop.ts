export type DesktopRemoteDesktopPermissionStatus = "granted" | "missing" | "unknown" | "notRequired";

export interface DesktopRemoteDesktopPermissions {
  readonly screenRecording: DesktopRemoteDesktopPermissionStatus;
  readonly accessibility: DesktopRemoteDesktopPermissionStatus;
}

export type DesktopRemoteDesktopWindowsSupport = "ready" | "missing" | "installRequired" | "unavailable";

/** Setup diagnostics contain only a bounded step code and Win32 error number. */
export interface DesktopRemoteDesktopWindowsDiagnostic {
  readonly step: string;
  readonly childStep?: string;
  readonly osError: number;
}

/** Process-local state owned by the current primary Desktop document. */
export interface DesktopRemoteDesktopSnapshot {
  readonly enabled: boolean;
  readonly active: boolean;
  readonly controlling: boolean;
  readonly overlayVisible?: boolean;
  readonly controllerDeviceId?: string;
  readonly displayId?: string;
  readonly permissions: DesktopRemoteDesktopPermissions;
  readonly windowsSupport?: DesktopRemoteDesktopWindowsSupport;
  readonly windowsSupportDiagnostic?: DesktopRemoteDesktopWindowsDiagnostic;
}

export interface DesktopRemoteDesktopApi {
  setAppearance?(dark: boolean): Promise<void>;
  getState(refreshWindowsSupport?: boolean): Promise<DesktopRemoteDesktopSnapshot>;
  setEnabled(enabled: boolean): Promise<DesktopRemoteDesktopSnapshot>;
  configureWindowsSupport(enabled: boolean): Promise<DesktopRemoteDesktopSnapshot>;
  disconnect(): Promise<DesktopRemoteDesktopSnapshot>;
  getPermissions(): Promise<DesktopRemoteDesktopPermissions>;
  showPermissionGuide(): Promise<DesktopRemoteDesktopPermissions>;
  onStateChanged(listener: (state: DesktopRemoteDesktopSnapshot) => void): () => void;
}
