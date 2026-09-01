interface CapabilitySupportView {
  readonly supported: boolean;
}

export interface NativeSessionDiscoveryAvailability {
  /** Discovery UI and reads are present only when explicitly advertised. */
  readonly visible: boolean;
  /** Attaching additionally requires the independent resume capability. */
  readonly attachEnabled: boolean;
}

export function nativeSessionDiscoveryAvailability(
  capabilities: ReadonlyMap<string, CapabilitySupportView> | undefined
): NativeSessionDiscoveryAvailability {
  const visible = capabilities?.get("session.discovery")?.supported === true;
  return {
    visible,
    attachEnabled: visible && capabilities?.get("session.resume")?.supported === true
  };
}
