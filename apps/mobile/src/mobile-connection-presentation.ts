import type { ConnectionScreenState, ConnectionScreenNode } from "@joko/web/connection-contract";
import type { MobileState, SavedMobileConnection } from "./mobile-client";
import { mobileMessage, type MobileMessageKey } from "./mobile-messages";
import type { MobileSupportedLocale } from "./mobile-locale-preference";

const sharedMessageKeys = {
  "app.name": "Joko",
  "app.tagline": "connection.stage.subtitle",
  "connection.toggleArtwork": "connection.stage.changeIllustration",
  "connection.nextArtworkGroup": "connection.stage.nextIllustration",
  "connection.method": "connection.title",
  "connection.nearby": "connection.mode.nearby",
  "connection.savedNodes": "connection.mode.saved",
  "connection.add": "connection.mode.add",
  "connection.discovered": "connection.nearbyTitle",
  "connection.noneDiscovered": "connection.nearbyEmpty",
  "connection.discoveryFallback": "connection.nearbyEmpty",
  "connection.enterManually": "connection.mode.add",
  "connection.discovering": "common.refreshing",
  "connection.pairingOpen": "connection.pairingAvailable",
  "connection.pairingClosed": "connection.pairingClosed",
  "connection.useNode": "connection.mode.add",
  "connection.connect": "common.connect",
  "connection.connecting": "common.connecting",
  "connection.pair": "connection.pairDevice",
  "connection.pairHelp": "connection.description",
  "connection.origin": "connection.address",
  "connection.secureHint": "connection.description",
  "connection.insecureLanTitle": "connection.httpWarning",
  "connection.insecureLanBody": "connection.httpWarning",
  "connection.insecureLanConfirm": "connection.httpWarning",
  "connection.code": "connection.pairingCode",
  "connection.deviceName": "connection.deviceName",
  "connection.rememberAutomatically": "connection.remember.title",
  "connection.rememberAutomaticallyHelp": "connection.remember.description",
  "connection.rememberAutomaticallyUnavailable": "connection.remember.description",
  "connection.rememberedTargetUnavailable": "connection.missingSaved",
  "connection.forget": "connection.forgetTitle",
  "settings.theme": "settings.appearance",
  "settings.light": "settings.theme.light",
  "settings.dark": "settings.theme.dark",
  "common.cancel": "common.cancel",
  "common.refresh": "common.refresh",
  "common.retry": "common.retry",
  "common.loading": "common.refreshing",
  "error.unexpected": "connection.repair"
} as const satisfies Readonly<Record<string, MobileMessageKey | "Joko">>;

export function mobileConnectionMessages(locale: MobileSupportedLocale): Readonly<Record<string, string>> {
  if (locale === "en" || locale === "zh-CN") return {
    "connection.rememberAutomaticallyHelp": mobileMessage(locale, "connection.remember.description")
  };
  return Object.fromEntries(Object.entries(sharedMessageKeys).map(([key, mobileKey]) => [key,
    mobileKey === "Joko" ? "Joko" : mobileMessage(locale, mobileKey,
      mobileKey === "connection.stage.changeIllustration" ? { id: "" } : undefined)]));
}

export function projectMobileConnection(state: MobileState, locale: MobileSupportedLocale, dark: boolean,
  defaultDeviceName: string, canGoBack: boolean, interactive = true): ConnectionScreenState {
  const profiles = state.saved.map((profile) => ({
    id: profile.profileId, deviceId: profile.deviceId, serverId: profile.serverId,
    name: profile.displayName, origin: profile.origin, automatic: profile.automatic,
    credentialState: profile.credentialState, statusLabel: savedStatus(profile, locale), error: profile.error,
    identityLabel: mobileMessage(locale, "connection.identity", { id: profile.serverId }),
    pendingCount: profile.pendingOperations.length,
    pendingLabel: profile.pendingOperations.length === 0 ? undefined : mobileMessage(locale, "connection.retainedOperations", {
      count: profile.pendingOperations.length, ids: profile.pendingOperations.map((item) => item.operationId).join(", ")
    })
  }));
  return {
    connectionState: state.status === "connecting" ? "connecting" : state.status === "connected" ? "connected"
      : state.status === "offline" ? "offline" : "disconnected",
    profiles, activeProfile: profiles.find((profile) => profile.id === state.activeProfileId),
    discoveredNodes: state.nearby.map((node) => connectionNode(node, node.origin)),
    discoveryState: state.discoveryState === "refreshing" ? "discovering" : state.discoveryState === "idle" ? "idle" : "ready",
    discoveryError: state.discoveryError, automaticConnectionAvailable: true,
    preferences: { theme: dark ? "dark" : "light", automaticConnectionTarget: state.automaticProfileId
      ? { kind: "profile", profileId: state.automaticProfileId } : undefined },
    effectiveLocale: locale,
    error: state.connectionAttemptError || (!state.activeProfileId ? state.error : undefined),
    busy: state.busy, interactive,
    initialMode: state.connectionMode === "add" ? "pair" : state.connectionMode,
    defaultDeviceName, sessionOnlyCredential: false,
    capabilities: { challengePairing: true, recheckSaved: true, back: canGoBack },
    candidate: state.candidate ? { origin: state.candidate.origin,
      node: { ...connectionNode(state.candidate.node, state.candidate.origin),
        identityLabel: mobileMessage(locale, "connection.identity", { id: state.candidate.node.serverId }),
        summaryLabel: mobileMessage(locale, "connection.candidateSummary", {
          version: state.candidate.node.version || mobileMessage(locale, "common.unknown"),
          api: state.candidate.node.apiVersion,
          pairing: mobileMessage(locale, state.candidate.node.pairingEnabled ? "connection.pairingAvailable" : "connection.pairingClosed")
        }) }
    } : undefined,
    challenge: state.challenge ? { origin: state.challenge.origin, deviceName: state.challenge.deviceName } : undefined,
    labels: {
      inspect: mobileMessage(locale, "connection.checkIdentity"),
      requestPairing: mobileMessage(locale, "connection.requestPairing"),
      challengeHint: mobileMessage(locale, "connection.challenge"),
      pairingHelp: mobileMessage(locale, "connection.description"),
      recheckSaved: mobileMessage(locale, "connection.recheck"),
      back: mobileMessage(locale, "common.backTo", { label: "Joko" }),
      checking: mobileMessage(locale, "connection.checking"),
      automaticEntry: mobileMessage(locale, "connection.automaticEntry"),
      turnOff: mobileMessage(locale, "common.turnOff")
    }
  };
}

function connectionNode(node: { serverId: string; displayName: string; version: string; apiVersion: string;
  pairingEnabled: boolean }, origin: string): ConnectionScreenNode {
  const url = new URL(origin);
  return { serverId: node.serverId, name: node.displayName, origin, version: node.version,
    apiVersion: node.apiVersion, pairingEnabled: node.pairingEnabled, lastSeenAt: Date.now(), source: "orchestrator",
    transport: url.protocol === "https:" ? "https" : ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ? "loopbackHttp" : "lanHttp" };
}

function savedStatus(profile: SavedMobileConnection, locale: MobileSupportedLocale): string {
  const keys = { checking: "connection.status.checking", available: "connection.status.available",
    missing: "connection.status.missing", unreadable: "connection.status.unreadable", unavailable: "connection.status.unavailable",
    "identity-conflict": "connection.status.identityConflict", offline: "connection.status.offline", unknown: "connection.status.unchecked"
  } as const;
  return mobileMessage(locale, keys[profile.credentialState]);
}
