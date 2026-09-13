import type { Translator } from "./components/types.js";

export type ScheduleTemplateCapability = "worktree" | "pullRequest" | "web" | "parameters";
export type ScheduleTemplateId =
  | "nightly-test-repair"
  | "pull-request-review"
  | "topic-radar"
  | "competitor-radar"
  | "weekly-report-draft"
  | "documentation-freshness";

export interface ScheduleTemplateParameter {
  readonly key: string;
  readonly label: string;
  readonly type: "string" | "number" | "boolean" | "select";
  readonly required: boolean;
  readonly defaultValue?: string;
  readonly options?: readonly string[];
  readonly placeholder?: string;
}

export interface ScheduleTemplate {
  readonly id: ScheduleTemplateId;
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly categoryId: "development" | "radar" | "office";
  readonly cronExpression: string;
  readonly timezone: string;
  readonly useWorktree: boolean;
  readonly notifyDesktop: boolean;
  readonly capabilities: readonly ScheduleTemplateCapability[];
  readonly parameters: readonly ScheduleTemplateParameter[];
}

export interface ScheduleTemplateCategory {
  readonly id: ScheduleTemplate["categoryId"];
  readonly name: string;
  readonly order: number;
}

export interface ScheduleTemplateDraftPatch {
  readonly name: string;
  readonly kind: "cron";
  readonly expression: string;
  readonly timezone: string;
  readonly inputText: string;
  readonly executionMode: "agent";
  readonly sessionMode: "fresh";
  readonly sessionId: "";
  readonly useWorktree: boolean;
  readonly worktreeSourceRef?: undefined;
  readonly refreshWorktreeRemote: false;
  readonly notifyDesktop: boolean;
}

interface TemplateDefinition {
  readonly id: ScheduleTemplateId;
  readonly categoryId: ScheduleTemplate["categoryId"];
  readonly cronExpression: string;
  readonly useWorktree?: boolean;
  readonly capabilities?: readonly Exclude<ScheduleTemplateCapability, "worktree" | "parameters">[];
  readonly parameter?: {
    readonly key: string;
    readonly labelKey: Parameters<Translator>[0];
    readonly placeholderKey: Parameters<Translator>[0];
  };
}

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const PLACEHOLDER_PATTERN = /\{\{([A-Za-z0-9_-]+)\}\}/g;

const CATEGORY_DEFINITIONS = [
  { id: "development", nameKey: "scheduler.templateCategoryDevelopment", order: 1 },
  { id: "radar", nameKey: "scheduler.templateCategoryRadar", order: 2 },
  { id: "office", nameKey: "scheduler.templateCategoryOffice", order: 3 }
] as const satisfies readonly {
  readonly id: ScheduleTemplate["categoryId"];
  readonly nameKey: Parameters<Translator>[0];
  readonly order: number;
}[];

const TEMPLATE_DEFINITIONS = [
  {
    id: "nightly-test-repair",
    categoryId: "development",
    cronExpression: "0 2 * * *",
    useWorktree: true,
    capabilities: ["pullRequest"]
  },
  {
    id: "pull-request-review",
    categoryId: "development",
    cronExpression: "0 10 * * 1-5",
    capabilities: ["pullRequest"]
  },
  {
    id: "topic-radar",
    categoryId: "radar",
    cronExpression: "0 9 * * 1-5",
    capabilities: ["web"],
    parameter: {
      key: "topic",
      labelKey: "scheduler.templateTopicLabel",
      placeholderKey: "scheduler.templateTopicPlaceholder"
    }
  },
  {
    id: "competitor-radar",
    categoryId: "radar",
    cronExpression: "0 9 * * 1",
    capabilities: ["web"],
    parameter: {
      key: "competitors",
      labelKey: "scheduler.templateCompetitorsLabel",
      placeholderKey: "scheduler.templateCompetitorsPlaceholder"
    }
  },
  {
    id: "weekly-report-draft",
    categoryId: "office",
    cronExpression: "0 16 * * 5"
  },
  {
    id: "documentation-freshness",
    categoryId: "office",
    cronExpression: "0 10 1 * *"
  }
] as const satisfies readonly TemplateDefinition[];

export function scheduleTemplateCategories(t: Translator): readonly ScheduleTemplateCategory[] {
  return CATEGORY_DEFINITIONS.map((category) => ({
    id: category.id,
    name: t(category.nameKey),
    order: category.order
  }));
}

export function scheduleTemplateCatalog(t: Translator): readonly ScheduleTemplate[] {
  return TEMPLATE_DEFINITIONS.map((literalDefinition) => {
    const definition: TemplateDefinition = literalDefinition;
    const parameters: readonly ScheduleTemplateParameter[] = definition.parameter === undefined
      ? []
      : [{
          key: definition.parameter.key,
          label: t(definition.parameter.labelKey),
          type: "string",
          required: true,
          placeholder: t(definition.parameter.placeholderKey)
        }];
    const capabilities = [
      ...(definition.useWorktree === true ? ["worktree" as const] : []),
      ...(definition.capabilities ?? []),
      ...(parameters.length > 0 ? ["parameters" as const] : [])
    ];
    return {
      id: definition.id,
      categoryId: definition.categoryId,
      name: t(templateMessageKey(definition.id, "name")),
      description: t(templateMessageKey(definition.id, "description")),
      prompt: t(templateMessageKey(definition.id, "prompt")),
      cronExpression: definition.cronExpression,
      timezone: DEFAULT_TIMEZONE,
      useWorktree: definition.useWorktree === true,
      notifyDesktop: true,
      capabilities,
      parameters
    };
  });
}

export function initialScheduleTemplateParameters(
  template: Pick<ScheduleTemplate, "parameters">
): Readonly<Record<string, string>> {
  return Object.fromEntries(template.parameters.map((parameter) => [parameter.key, parameter.defaultValue ?? ""]));
}

export function applyScheduleTemplateParameters(
  template: Pick<ScheduleTemplate, "prompt" | "parameters">,
  values: Readonly<Record<string, string>>
): string {
  const definitions = new Map(template.parameters.map((parameter) => [parameter.key, parameter]));
  for (const parameter of template.parameters) {
    const value = values[parameter.key]?.trim() ?? "";
    const fallback = parameter.defaultValue?.trim() ?? "";
    if (parameter.required && value === "" && fallback === "") {
      throw new Error(`Missing required schedule template parameter: ${parameter.key}`);
    }
  }
  return template.prompt.replace(PLACEHOLDER_PATTERN, (placeholder, key: string) => {
    const definition = definitions.get(key);
    if (definition === undefined) return placeholder;
    const value = values[key]?.trim() ?? "";
    return value === "" ? definition.defaultValue ?? "" : value;
  });
}

export function scheduleTemplateDraftPatch(
  template: ScheduleTemplate,
  values: Readonly<Record<string, string>>
): ScheduleTemplateDraftPatch {
  return {
    name: template.name,
    kind: "cron",
    expression: template.cronExpression,
    timezone: template.timezone,
    inputText: applyScheduleTemplateParameters(template, values),
    executionMode: "agent",
    sessionMode: "fresh",
    sessionId: "",
    useWorktree: template.useWorktree,
    worktreeSourceRef: undefined,
    refreshWorktreeRemote: false,
    notifyDesktop: template.notifyDesktop
  };
}

export function scheduleTemplateParameterKeys(prompt: string): readonly string[] {
  return [...prompt.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1] ?? "");
}

function templateMessageKey(
  id: ScheduleTemplateId,
  field: "name" | "description" | "prompt"
): Parameters<Translator>[0] {
  const keys = {
    "nightly-test-repair": {
      name: "scheduler.templateNightlyTestName",
      description: "scheduler.templateNightlyTestDescription",
      prompt: "scheduler.templateNightlyTestPrompt"
    },
    "pull-request-review": {
      name: "scheduler.templatePullRequestName",
      description: "scheduler.templatePullRequestDescription",
      prompt: "scheduler.templatePullRequestPrompt"
    },
    "topic-radar": {
      name: "scheduler.templateTopicRadarName",
      description: "scheduler.templateTopicRadarDescription",
      prompt: "scheduler.templateTopicRadarPrompt"
    },
    "competitor-radar": {
      name: "scheduler.templateCompetitorName",
      description: "scheduler.templateCompetitorDescription",
      prompt: "scheduler.templateCompetitorPrompt"
    },
    "weekly-report-draft": {
      name: "scheduler.templateWeeklyReportName",
      description: "scheduler.templateWeeklyReportDescription",
      prompt: "scheduler.templateWeeklyReportPrompt"
    },
    "documentation-freshness": {
      name: "scheduler.templateDocumentationName",
      description: "scheduler.templateDocumentationDescription",
      prompt: "scheduler.templateDocumentationPrompt"
    }
  } as const satisfies Readonly<Record<ScheduleTemplateId, Readonly<Record<typeof field, Parameters<Translator>[0]>>>>;
  return keys[id][field];
}
