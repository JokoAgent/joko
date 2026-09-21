import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { Linking, Platform } from "react-native";
import {
  mobileUpdateChannelHeaders,
  mobileUpdateManifestId,
  parseMobileUpdateConfiguration,
  type MobileUpdateConfiguration,
  type MobileUpdatePlatform,
  type MobileUpdateRuntime,
  type MobileUpdateRuntimeInfo
} from "./mobile-update";

export interface MobileUpdateRuntimeEnvironment {
  readonly configuration?: MobileUpdateConfiguration;
  readonly configurationError?: string;
  readonly platform: MobileUpdatePlatform;
  readonly runtime: MobileUpdateRuntime;
}

const MOBILE_RELEASE_RESPONSE_MAXIMUM_CHARACTERS = 16_384;

export function createMobileUpdateRuntimeEnvironment(): MobileUpdateRuntimeEnvironment {
  const runtime = new ExpoMobileUpdateRuntime();
  const platform: MobileUpdatePlatform = Platform.OS === "android" || Platform.OS === "ios"
    ? Platform.OS
    : "other";
  try {
    const configuration = parseMobileUpdateConfiguration(
      Constants.expoConfig?.extra?.jokoMobileUpdate
    );
    return Object.freeze({ configuration, platform, runtime });
  } catch {
    return Object.freeze({
      configurationError: "The installed app has no valid Joko update configuration.",
      platform,
      runtime
    });
  }
}

export class ExpoMobileUpdateRuntime implements MobileUpdateRuntime {
  readonly info: MobileUpdateRuntimeInfo;

  constructor() {
    this.info = Object.freeze({
      appVersion: Application.nativeApplicationVersion ?? "",
      ...(Updates.runtimeVersion ? { runtimeVersion: Updates.runtimeVersion } : {}),
      ...(Updates.updateId ? { updateId: Updates.updateId.toLowerCase() } : {}),
      ...(Updates.channel ? { channel: Updates.channel } : {}),
      ...(Updates.createdAt instanceof Date && Number.isFinite(Updates.createdAt.getTime())
        ? { createdAt: Updates.createdAt }
        : {}),
      isEnabled: Updates.isEnabled,
      isEmbeddedLaunch: Updates.isEmbeddedLaunch,
      isEmergencyLaunch: Updates.isEmergencyLaunch,
      ...(Updates.emergencyLaunchReason ? { emergencyLaunchReason: Updates.emergencyLaunchReason } : {})
    });
  }

  configureChannel(channel: "stable" | "beta"): void {
    Updates.setUpdateRequestHeadersOverride(mobileUpdateChannelHeaders(channel));
  }

  async checkOta() {
    const result = await Updates.checkForUpdateAsync();
    return Object.freeze({
      isAvailable: result.isAvailable,
      ...(result.isAvailable ? optionalManifestId(result.manifest) : {})
    });
  }

  async fetchOta() {
    const result = await Updates.fetchUpdateAsync();
    return Object.freeze({
      isNew: result.isNew,
      ...(result.isNew ? optionalManifestId(result.manifest) : {})
    });
  }

  reload(): Promise<void> {
    return Updates.reloadAsync();
  }

  async fetchRelease(
    feedUrl: string,
    platform: "android" | "ios",
    channel: "stable" | "beta",
    timeoutMs: number
  ): Promise<unknown | null> {
    const url = new URL(feedUrl);
    url.searchParams.set("platform", platform);
    url.searchParams.set("channel", channel);
    url.searchParams.set("t", String(Date.now()));
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error(`mobile-release-timeout(${timeoutMs}ms)`));
      }, timeoutMs);
    });
    try {
      const request = (async (): Promise<unknown | null> => {
        const response = await fetch(url.href, {
          method: "GET",
          headers: { Accept: "application/json" },
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          signal: abort.signal
        });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`mobile-release-http-${response.status}`);
        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > MOBILE_RELEASE_RESPONSE_MAXIMUM_CHARACTERS * 4) {
          throw new Error("mobile-release-response-too-large");
        }
        const body = await response.text();
        if (body.length > MOBILE_RELEASE_RESPONSE_MAXIMUM_CHARACTERS) {
          throw new Error("mobile-release-response-too-large");
        }
        return JSON.parse(body) as unknown;
      })();
      return await Promise.race([request, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async openUrl(url: string): Promise<void> {
    const target = new URL(url);
    if (target.protocol !== "https:" || !publicDnsHostname(target.hostname) || target.username || target.password
      || target.search || target.hash) {
      throw new Error("The Joko mobile install target is invalid.");
    }
    if (!await Linking.canOpenURL(target.href)) {
      throw new Error("This device cannot open the Joko mobile install target.");
    }
    await Linking.openURL(target.href);
  }
}

function publicDnsHostname(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return value.includes(".") && !value.startsWith("[") && !/^\d+(?:\.\d+){3}$/u.test(value)
    && ![".local", ".localhost", ".internal", ".invalid", ".test", ".example", ".home.arpa"]
      .some((suffix) => value === suffix.slice(1) || value.endsWith(suffix));
}

function optionalManifestId(manifest: unknown): { readonly manifestId: string } | Record<string, never> {
  const manifestId = mobileUpdateManifestId(manifest);
  return manifestId === undefined ? {} : { manifestId };
}
