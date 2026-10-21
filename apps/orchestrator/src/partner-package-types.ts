import type { AgentImportResult } from '@joko/agent-import';

/** Same whitelist as the offline package compiler. */
export const PARTNER_CAPABILITY_ICONS = ['code', 'check', 'folder', 'file', 'target', 'list', 'layout', 'search', 'history',
  'chart', 'alert', 'layers', 'link', 'video'] as const;
export type PartnerCapabilityIcon = typeof PARTNER_CAPABILITY_ICONS[number];

export interface PartnerPackageIdentity { packageId: string; packageVersion: string; packageHash: string }
/** Package-authored opening: greeting material and the Skill run right after it. */
export interface PartnerPackageOpening {
  welcome: string; capabilities: string[]; onboardingSkill?: string;
  /** Starter choices parsed from the package's getting-started Skill; shown with the opening line. */
  starterOptions?: string[];
}
/** The line the companion actually opens with: the package welcome without its closing question,
 *  because the setup turn that follows asks the real question. */
export function partnerOpeningGreeting(welcome: string): string {
  const text = welcome.trim();
  return /^(.*[。.!！])\s*[^。.!！]*[?？]$/s.exec(text)?.[1] ?? text;
}
export interface PartnerPackageSkill { name: string; description: string }
export interface PartnerPackageReference { title: string; summary: string }
export interface PartnerPackageTool { id: string; purpose: string }
/** `cron` is the package's example expression; its timezone is deliberately dropped. */
export interface PartnerPackageRoutine { name: string; summary: string; cron?: string }
export type PartnerPackageLocale = 'en' | 'ja' | 'ko' | 'zh-TW';
/** The language-dependent fields of a catalog entry: the entry holds them in Simplified Chinese, `locales` in the others. */
export interface PartnerPackageCopy {
  name: string; description: string; welcome: string;
  /** Short authored pitch for the detail-page bubble (`presentation.bubbleZh` / `i18n.<lang>.bubble`). */
  bubble: string;
  capabilities: Array<{ icon: PartnerCapabilityIcon; label: string }>;
  skills: PartnerPackageSkill[];
  knowledge: PartnerPackageReference[];
  /** What the companion remembers about the user once the opening is confirmed. */
  remembers: string[];
  routines: PartnerPackageRoutine[]; tools: PartnerPackageTool[];
  /** Import entry id → name shown to the user, so a partial save can name what failed. */
  itemNames: Record<string, string>;
}
export interface PartnerPackageEntry extends PartnerPackageIdentity, PartnerPackageCopy {
  avatar: string; requiredInputs: string[];
  /** Authored copy per UI language; the base fields hold Simplified Chinese. */
  locales: Record<PartnerPackageLocale, PartnerPackageCopy>;
  installation?: AgentImportResult;
}
/** UI language → package copy language: Traditional Chinese → zh-TW, other Chinese → zh-CN, unknown → en. */
export function partnerPackageLocale(language: string | undefined | null): 'zh-CN' | PartnerPackageLocale {
  const tag = (language ?? '').trim().replace(/_/g, '-').toLowerCase();
  if (/^zh-(tw|hk|mo|hant)/.test(tag)) return 'zh-TW';
  if (tag.startsWith('zh')) return 'zh-CN';
  if (tag.startsWith('ja')) return 'ja';
  if (tag.startsWith('ko')) return 'ko';
  return 'en';
}
/** The entry as the given UI language should see it. */
export function localizedPartnerPackageEntry(entry: PartnerPackageEntry, language: string | undefined | null): PartnerPackageEntry {
  const locale = partnerPackageLocale(language);
  if (locale === 'zh-CN') return entry;
  return { ...entry, ...entry.locales[locale] };
}
export interface PartnerPackageApi {
  list(): Promise<PartnerPackageEntry[]>;
  invite(input: PartnerPackageIdentity & { locale?: string }): Promise<AgentImportResult>;
  status(requestId: string): Promise<AgentImportResult | undefined>;
}

/** Show only a cadence that can be expressed in the selected product language. */
export function partnerPackageRoutineRhythm(cron: string | undefined, locale: string): string | undefined {
  if (!cron) return undefined;
  const zh = locale.startsWith('zh');
  const [minute, hour, day, month, weekday] = cron.trim().split(/\s+/);
  if (day !== '*' || month !== '*') return undefined;
  if (hour === '*' && weekday === '*' && minute === '0,30') return zh ? '每 30 分钟' : 'Every 30 minutes';
  if (!/^\d+$/.test(minute ?? '') || !/^\d+$/.test(hour ?? '')) return undefined;
  const time = `${hour!.padStart(2, '0')}:${minute!.padStart(2, '0')}`;
  if (weekday === '*') return zh ? `每天 ${time}` : `Daily at ${time}`;
  if (weekday === '1-5') return zh ? `工作日 ${time}` : `Weekdays at ${time}`;
  const days = zh ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (/^[0-6]$/.test(weekday ?? '')) return zh ? `每${days[Number(weekday)]} ${time}` : `${days[Number(weekday)]} at ${time}`;
  return undefined;
}
