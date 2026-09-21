import type { ConfigContext, ExpoConfig } from "expo/config";

export const JOKO_MOBILE_UPDATE_FEED_ENV = "JOKO_MOBILE_UPDATE_FEED_URL";
export const JOKO_MOBILE_OTA_ENV = "JOKO_MOBILE_OTA_URL";
export const JOKO_MOBILE_BETA_ENV = "JOKO_MOBILE_BETA_UPDATES";

export interface MobileUpdateBuildConfiguration {
  readonly releaseFeedUrl: string | null;
  readonly otaUrl: string | null;
  readonly betaEnabled: boolean;
}

export function resolveMobileUpdateBuildConfiguration(
  environment: Readonly<Record<string, string | undefined>>
): MobileUpdateBuildConfiguration {
  const releaseFeedUrl = optionalPublicHttpsUrl(environment[JOKO_MOBILE_UPDATE_FEED_ENV], JOKO_MOBILE_UPDATE_FEED_ENV);
  const otaUrl = optionalPublicHttpsUrl(environment[JOKO_MOBILE_OTA_ENV], JOKO_MOBILE_OTA_ENV);
  const betaValue = environment[JOKO_MOBILE_BETA_ENV]?.trim();
  if (betaValue !== undefined && betaValue !== "" && betaValue !== "0" && betaValue !== "1") {
    throw new Error(`${JOKO_MOBILE_BETA_ENV} must be 0, 1, or unset.`);
  }
  const betaEnabled = betaValue === "1";
  if (betaEnabled && releaseFeedUrl === null && otaUrl === null) {
    throw new Error(`${JOKO_MOBILE_BETA_ENV}=1 requires a configured Joko mobile update authority.`);
  }
  return Object.freeze({ releaseFeedUrl, otaUrl, betaEnabled });
}

export default function mobileExpoConfig({ config }: ConfigContext): ExpoConfig {
  const update = resolveMobileUpdateBuildConfiguration(process.env);
  const name = config.name ?? "Joko";
  const slug = config.slug ?? "joko";
  return {
    ...config,
    name,
    slug,
    runtimeVersion: { policy: "fingerprint" },
    updates: {
      enabled: update.otaUrl !== null,
      checkAutomatically: "NEVER",
      fallbackToCacheTimeout: 0,
      requestHeaders: { "expo-channel-name": "stable" },
      ...(update.otaUrl === null ? {} : { url: update.otaUrl })
    },
    extra: {
      ...config.extra,
      jokoMobileUpdate: {
        version: 1,
        releaseFeedUrl: update.releaseFeedUrl ?? "",
        otaEnabled: update.otaUrl !== null,
        betaEnabled: update.betaEnabled
      }
    }
  };
}

function optionalPublicHttpsUrl(value: string | undefined, name: string): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  let url: URL;
  try { url = new URL(candidate); }
  catch { throw new Error(`${name} must be an absolute HTTPS URL.`); }
  if (url.protocol !== "https:" || !publicDnsHostname(url.hostname)
    || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be a public HTTPS URL without credentials, query, or fragment.`);
  }
  return url.href;
}

function publicDnsHostname(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return value.includes(".") && !value.startsWith("[") && !/^\d+(?:\.\d+){3}$/u.test(value)
    && ![".local", ".localhost", ".internal", ".invalid", ".test", ".example", ".home.arpa"]
      .some((suffix) => value === suffix.slice(1) || value.endsWith(suffix));
}
