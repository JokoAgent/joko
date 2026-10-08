/** Public presentation data for the single connection page. Credentials stay with its host. */
export type ConnectionScreenMode = "nearby" | "saved" | "pair";
export type ConnectionScreenTheme = "system" | "light" | "dark";

export interface ConnectionScreenProfile {
  readonly id: string;
  readonly deviceId: string;
  readonly serverId: string;
  readonly name: string;
  readonly origin: string;
  readonly managedLocal?: boolean;
  readonly lastConnectedAt?: number;
  readonly automatic?: boolean;
  readonly credentialState?: "unknown" | "checking" | "available" | "missing" | "unreadable" | "unavailable" | "identity-conflict" | "offline";
  readonly statusLabel?: string;
  readonly identityLabel?: string;
  readonly pendingCount?: number;
  readonly pendingLabel?: string;
  readonly error?: string;
}

export interface ConnectionScreenNode {
  readonly serverId: string;
  readonly name: string;
  readonly origin: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly pairingEnabled: boolean;
  readonly lastSeenAt: number;
  readonly source: "current" | "orchestrator" | "desktop";
  readonly transport: "https" | "loopbackHttp" | "lanHttp";
  readonly identityLabel?: string;
  readonly summaryLabel?: string;
}

export type ConnectionScreenManagedStatus =
  | { readonly state: "disabled" }
  | { readonly state: "starting" }
  | { readonly state: "ready"; readonly connection: {
    readonly profileId: string; readonly serverId: string;
  } }
  | { readonly state: "retryableError"; readonly reason: "serviceUnavailable" | "startFailed" }
  | { readonly state: "recoveryRequired"; readonly reason: "credentialUnavailable" | "credentialRejected" | "identityConflict" };

export interface ConnectionScreenLabels {
  readonly inspect: string;
  readonly requestPairing: string;
  readonly challengeHint: string;
  readonly pairingHelp: string;
  readonly recheckSaved: string;
  readonly back: string;
  readonly checking: string;
  readonly automaticEntry: string;
  readonly turnOff: string;
}

export interface ConnectionScreenState {
  readonly connectionState: "disconnected" | "connecting" | "connected" | "reconnecting" | "offline";
  readonly profiles: readonly ConnectionScreenProfile[];
  readonly activeProfile?: ConnectionScreenProfile;
  readonly discoveredNodes: readonly ConnectionScreenNode[];
  readonly discoveryState: "idle" | "discovering" | "ready";
  readonly discoveryError?: string;
  readonly managedOrchestratorStatus?: ConnectionScreenManagedStatus;
  readonly automaticConnectionAvailable: boolean;
  readonly preferences: {
    readonly theme: ConnectionScreenTheme;
    readonly automaticConnectionTarget?: { readonly kind: "managedLocal" }
      | { readonly kind: "profile"; readonly profileId: string };
  };
  readonly effectiveLocale?: string;
  readonly error?: string;
  readonly busy?: boolean;
  readonly interactive?: boolean;
  readonly initialMode?: ConnectionScreenMode;
  readonly defaultDeviceName?: string;
  readonly sessionOnlyCredential?: boolean;
  readonly capabilities?: {
    readonly challengePairing?: boolean;
    readonly recheckSaved?: boolean;
    readonly back?: boolean;
  };
  readonly candidate?: { readonly origin: string; readonly node: ConnectionScreenNode };
  /** Only the challenge's form scope is public; its identifier is retained by the host. */
  readonly challenge?: { readonly origin: string; readonly deviceName: string };
  readonly labels?: Partial<ConnectionScreenLabels>;
}

export interface ConnectionScreenController {
  readonly state: ConnectionScreenState;
  connect(profile: ConnectionScreenProfile, options?: { readonly automatic?: boolean }): Promise<void>;
  pair(origin: string, code: string, deviceName: string, options?: { readonly automatic?: boolean }): Promise<void>;
  disconnect(): Promise<void>;
  forgetProfile(profileId: string): Promise<void>;
  refreshDiscoveredNodes(): Promise<void>;
  retryManagedOrchestrator(): Promise<void>;
  cancelAutomaticConnectionAttempt(): void;
  setAutomaticConnectionEnabled(enabled: boolean): Promise<void>;
  setTheme(theme: ConnectionScreenTheme): Promise<void>;
  inspect?(origin: string): Promise<void>;
  requestPairing?(origin: string, deviceName: string): Promise<void>;
  cancelPairing?(): void;
  recheckSavedProfiles?(): Promise<void>;
  goBack?(): Promise<void>;
  selectMode?(mode: ConnectionScreenMode): void;
}

/** The embedded host accepts only these actions, never arbitrary controller methods. */
export interface ConnectionScreenActionArguments {
  readonly connect: readonly [profileId: string, options?: { readonly automatic?: boolean }];
  readonly pair: readonly [origin: string, code: string, deviceName: string, options?: { readonly automatic?: boolean }];
  readonly disconnect: readonly [];
  readonly forgetProfile: readonly [profileId: string];
  readonly refreshDiscoveredNodes: readonly [];
  readonly retryManagedOrchestrator: readonly [];
  readonly cancelAutomaticConnectionAttempt: readonly [];
  readonly setAutomaticConnectionEnabled: readonly [enabled: boolean];
  readonly setTheme: readonly [theme: ConnectionScreenTheme];
  readonly inspect: readonly [origin: string];
  readonly requestPairing: readonly [origin: string, deviceName: string];
  readonly cancelPairing: readonly [];
  readonly recheckSavedProfiles: readonly [];
  readonly goBack: readonly [];
  readonly selectMode: readonly [mode: ConnectionScreenMode];
}

export type ConnectionScreenAction = {
  [Name in keyof ConnectionScreenActionArguments]: { readonly name: Name; readonly args: ConnectionScreenActionArguments[Name] }
}[keyof ConnectionScreenActionArguments];
