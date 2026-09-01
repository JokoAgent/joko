export interface AppearancePreferences {
  readonly uiFamily: string;
  readonly codeFamily: string;
  readonly uiSize: number;
  readonly codeSize: number;
  readonly windowZoom: number;
}

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  uiFamily: "",
  codeFamily: "",
  uiSize: 14,
  codeSize: 14,
  windowZoom: 1
};

export const APPEARANCE_LIMITS = {
  uiSize: { min: 12, max: 24 },
  codeSize: { min: 10, max: 24 },
  windowZoom: { min: 0.5, max: 3, step: 0.1 }
} as const;

const UI_TEXT_TOKEN_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 24, 28] as const;

export function clampUiSize(value: number, fallback = DEFAULT_APPEARANCE_PREFERENCES.uiSize): number {
  return clampInteger(value, APPEARANCE_LIMITS.uiSize.min, APPEARANCE_LIMITS.uiSize.max, fallback);
}

export function clampCodeSize(value: number, fallback = DEFAULT_APPEARANCE_PREFERENCES.codeSize): number {
  return clampInteger(value, APPEARANCE_LIMITS.codeSize.min, APPEARANCE_LIMITS.codeSize.max, fallback);
}

export function clampWindowZoom(value: number, fallback = DEFAULT_APPEARANCE_PREFERENCES.windowZoom): number {
  if (!Number.isFinite(value)) return fallback;
  const stepped = Math.round(value / APPEARANCE_LIMITS.windowZoom.step) * APPEARANCE_LIMITS.windowZoom.step;
  return roundDecimal(Math.min(APPEARANCE_LIMITS.windowZoom.max, Math.max(APPEARANCE_LIMITS.windowZoom.min, stepped)), 2);
}

export function normalizeFontFamily(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 256) : "";
}

export function normalizeAppearancePreferences(value: unknown): AppearancePreferences {
  const record = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    uiFamily: normalizeFontFamily(record["uiFamily"]),
    codeFamily: normalizeFontFamily(record["codeFamily"]),
    uiSize: typeof record["uiSize"] === "number" ? clampUiSize(record["uiSize"]) : DEFAULT_APPEARANCE_PREFERENCES.uiSize,
    codeSize: typeof record["codeSize"] === "number" ? clampCodeSize(record["codeSize"]) : DEFAULT_APPEARANCE_PREFERENCES.codeSize,
    windowZoom: typeof record["windowZoom"] === "number" ? clampWindowZoom(record["windowZoom"]) : DEFAULT_APPEARANCE_PREFERENCES.windowZoom
  };
}

export function appearanceStyleProperties(settings: AppearancePreferences): Readonly<Record<string, string | undefined>> {
  const uiFamily = normalizeFontFamily(settings.uiFamily);
  const codeFamily = normalizeFontFamily(settings.codeFamily);
  const uiSize = clampUiSize(settings.uiSize);
  const codeSize = clampCodeSize(settings.codeSize);
  const scale = uiSize / DEFAULT_APPEARANCE_PREFERENCES.uiSize;
  const properties: Record<string, string | undefined> = {
    "--app-font-ui": uiFamily ? `${uiFamily}, var(--app-font-ui-default)` : undefined,
    "--app-font-code": codeFamily ? `${codeFamily}, var(--app-font-code-default)` : undefined,
    "--app-ui-font-size": `${uiSize}px`,
    "--app-code-font-size": `${codeSize}px`
  };
  for (const size of UI_TEXT_TOKEN_SIZES) properties[`--text-${size}`] = `${Math.round(size * scale)}px`;
  return properties;
}

export function applyAppearanceTypography(
  settings: AppearancePreferences,
  targets: readonly Pick<HTMLElement, "style">[]
): void {
  const properties = appearanceStyleProperties(settings);
  for (const target of targets) {
    for (const [name, value] of Object.entries(properties)) {
      if (value === undefined) target.style.removeProperty(name);
      else target.style.setProperty(name, value);
    }
  }
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function roundDecimal(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
