import type { ConnectionArtworkTheme } from "@joko/brand-assets/connection-artwork";
import darkAppIcon from "@joko/brand-assets/icon-dark.svg";
import lightAppIcon from "@joko/brand-assets/icon-light.svg";
import darkLoadingIllustration from "@joko/brand-assets/loading-dark.svg";
import lightLoadingIllustration from "@joko/brand-assets/loading-light.svg";

export function mobileConnectionAppIcon(theme: ConnectionArtworkTheme): string {
  return theme === "dark" ? darkAppIcon : lightAppIcon;
}

export function mobileLoadingIllustration(theme: ConnectionArtworkTheme): string {
  return theme === "dark" ? darkLoadingIllustration : lightLoadingIllustration;
}
