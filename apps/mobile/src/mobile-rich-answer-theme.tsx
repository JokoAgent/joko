import { createContext, useContext, useMemo, type PropsWithChildren } from "react";
import type { MobileMarkdownColors } from "./mobile-markdown-rich-html";

export interface RichAnswerColors {
  readonly textPrimary: string; readonly textSecondary: string; readonly textTertiary: string;
  readonly textPlaceholder: string; readonly statusDone: string; readonly warningFg: string;
  readonly statusError: string; readonly border: string; readonly borderStrong: string;
  readonly surfaceElevated: string;
}
const Theme = createContext<{ readonly colors: RichAnswerColors; readonly locale: string } | undefined>(undefined);
export function MobileRichAnswerTheme({ colors, locale, children }: PropsWithChildren<{ readonly colors: MobileMarkdownColors; readonly locale: string }>) {
  const value = useMemo(() => ({ locale, colors: {
    textPrimary: colors.ink, textSecondary: colors.muted, textTertiary: colors.muted,
    textPlaceholder: colors.muted, statusDone: colors.positive ?? colors.ink,
    warningFg: colors.warning ?? colors.accent, statusError: colors.negative,
    border: colors.border, borderStrong: colors.border, surfaceElevated: colors.background
  } }), [colors, locale]);
  return <Theme.Provider value={value}>{children}</Theme.Provider>;
}
export function useRichAnswerTheme() {
  const value = useContext(Theme);
  if (!value) throw new Error("The answer theme is unavailable.");
  return value;
}
export function useRichAnswerStyles<T>(make: (colors: RichAnswerColors) => T): T {
  const { colors } = useRichAnswerTheme();
  return useMemo(() => make(colors), [colors, make]);
}
export function useRichAnswerMessages() {
  const { locale } = useRichAnswerTheme();
  return { t: (key: string) => key.endsWith("calculationUnavailable")
    ? locale.startsWith("zh") ? "此计算暂不可用。" : "This calculation is unavailable."
    : locale.startsWith("zh") ? "内容尚未完整，已保留收到的部分。" : "The answer is incomplete. Received content is preserved." };
}
export const richAnswerSpacing = { xs: 4, sm: 8, md: 12, lg: 16 };
export const richAnswerRadius = { pill: 12, micro: 2 };
export const richAnswerTextStyles = {
  bodyLarge: { fontSize: 16, lineHeight: 24 }, body: { fontSize: 14, lineHeight: 20 },
  subtitle: { fontSize: 20, lineHeight: 28 }, footnote: { fontSize: 12, lineHeight: 18 },
  headline: { fontSize: 24, lineHeight: 32 }
};
export const richAnswerFontWeight = { regular: "400", medium: "600" } as const;
export const richAnswerIconSize = { action: 20 };
export const richAnswerIconStroke = { thin: 1.75, regular: 2 };
