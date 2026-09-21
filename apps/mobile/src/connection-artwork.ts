import {
  CONNECTION_ARTWORK_GROUP_IDS,
  connectionArtworkFrameId,
  nextConnectionArtworkGroupIndex,
  type ConnectionArtworkGroupId,
  type ConnectionArtworkTheme,
  type ConnectionArtworkVariant
} from "@joko/brand-assets/connection-artwork";
import acrobatDarkAlt from "@joko/brand-assets/landing-artwork/acrobat-dark-alt.svg";
import acrobatDark from "@joko/brand-assets/landing-artwork/acrobat-dark.svg";
import acrobatLightAlt from "@joko/brand-assets/landing-artwork/acrobat-light-alt.svg";
import acrobatLight from "@joko/brand-assets/landing-artwork/acrobat-light.svg";
import bikeDarkAlt from "@joko/brand-assets/landing-artwork/bike-dark-alt.svg";
import bikeDark from "@joko/brand-assets/landing-artwork/bike-dark.svg";
import bikeLightAlt from "@joko/brand-assets/landing-artwork/bike-light-alt.svg";
import bikeLight from "@joko/brand-assets/landing-artwork/bike-light.svg";
import darkAppIcon from "@joko/brand-assets/icon-dark.svg";
import lightAppIcon from "@joko/brand-assets/icon-light.svg";
import darkLoadingIllustration from "@joko/brand-assets/loading-dark.svg";
import lightLoadingIllustration from "@joko/brand-assets/loading-light.svg";
import joggingDarkAlt from "@joko/brand-assets/landing-artwork/jogging-dark-alt.svg";
import joggingDark from "@joko/brand-assets/landing-artwork/jogging-dark.svg";
import joggingLightAlt from "@joko/brand-assets/landing-artwork/jogging-light-alt.svg";
import joggingLight from "@joko/brand-assets/landing-artwork/jogging-light.svg";

interface ThemePair {
  readonly light: string;
  readonly dark: string;
}

interface ArtworkFrames {
  readonly base: ThemePair;
  readonly alt: ThemePair;
}

export interface MobileConnectionArtworkFrame {
  readonly id: string;
  readonly source: string;
}

const artworkByGroup = {
  jogging: {
    base: { light: joggingLight, dark: joggingDark },
    alt: { light: joggingLightAlt, dark: joggingDarkAlt }
  },
  acrobat: {
    base: { light: acrobatLight, dark: acrobatDark },
    alt: { light: acrobatLightAlt, dark: acrobatDarkAlt }
  },
  bike: {
    base: { light: bikeLight, dark: bikeDark },
    alt: { light: bikeLightAlt, dark: bikeDarkAlt }
  }
} satisfies Readonly<Record<ConnectionArtworkGroupId, ArtworkFrames>>;

const appIconByTheme = { light: lightAppIcon, dark: darkAppIcon } satisfies Readonly<Record<ConnectionArtworkTheme, string>>;
const loadingByTheme = { light: lightLoadingIllustration, dark: darkLoadingIllustration } satisfies Readonly<Record<ConnectionArtworkTheme, string>>;

export { CONNECTION_ARTWORK_GROUP_IDS, nextConnectionArtworkGroupIndex };
export type { ConnectionArtworkTheme, ConnectionArtworkVariant };

export function mobileConnectionArtworkFrame(
  groupIndex: number,
  variant: ConnectionArtworkVariant,
  theme: ConnectionArtworkTheme
): MobileConnectionArtworkFrame {
  const group = CONNECTION_ARTWORK_GROUP_IDS[groupIndex];
  if (group === undefined) throw new RangeError(`Unknown connection artwork group index: ${groupIndex}`);
  return { id: connectionArtworkFrameId(group, variant), source: artworkByGroup[group][variant][theme] };
}

export function mobileConnectionAppIcon(theme: ConnectionArtworkTheme): string {
  return appIconByTheme[theme];
}

export function mobileLoadingIllustration(theme: ConnectionArtworkTheme): string {
  return loadingByTheme[theme];
}
