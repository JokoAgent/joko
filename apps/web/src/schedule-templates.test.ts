import { describe, expect, it } from "vitest";

import type { Translator } from "./components/types.js";
import { translate } from "./i18n.js";
import {
  applyScheduleTemplateParameters,
  initialScheduleTemplateParameters,
  scheduleTemplateCatalog,
  scheduleTemplateCategories,
  scheduleTemplateDraftPatch,
  scheduleTemplateParameterKeys
} from "./schedule-templates.js";

const keyTranslator = ((key: string) => key) as Translator;
const t = ((key, values) => translate("en", key, values)) as Translator;

describe("schedule templates", () => {
  it("provides three ordered categories with exactly two templates each", () => {
    const categories = scheduleTemplateCategories(keyTranslator);
    const templates = scheduleTemplateCatalog(keyTranslator);
    expect(categories.map((category) => category.order)).toEqual([1, 2, 3]);
    expect(new Set(templates.map((template) => template.id)).size).toBe(6);
    for (const category of categories) {
      expect(templates.filter((template) => template.categoryId === category.id)).toHaveLength(2);
    }
  });

  it("keeps capability chips derived from real template behavior", () => {
    const templates = scheduleTemplateCatalog(keyTranslator);
    for (const template of templates) {
      expect(template.capabilities.includes("worktree")).toBe(template.useWorktree);
      expect(template.capabilities.includes("parameters")).toBe(template.parameters.length > 0);
      expect(new Set(template.capabilities).size).toBe(template.capabilities.length);
    }
    expect(templates.find((template) => template.id === "nightly-test-repair")?.capabilities)
      .toEqual(["worktree", "pullRequest"]);
  });

  it("keeps prompt placeholders and declared parameters in exact agreement", () => {
    for (const template of scheduleTemplateCatalog(t)) {
      expect(new Set(scheduleTemplateParameterKeys(template.prompt)))
        .toEqual(new Set(template.parameters.map((parameter) => parameter.key)));
    }
  });

  it("requires declared values and substitutes the complete placeholder range", () => {
    const template = scheduleTemplateCatalog(t).find((candidate) => candidate.id === "topic-radar")!;
    expect(initialScheduleTemplateParameters(template)).toEqual({ topic: "" });
    expect(() => applyScheduleTemplateParameters(template, {})).toThrow(/topic/);
    expect(applyScheduleTemplateParameters(template, { topic: "Agent systems" })).not.toContain("{{topic}}");
  });

  it("preserves unknown placeholders instead of silently deleting template text", () => {
    expect(applyScheduleTemplateParameters({
      prompt: "Known {{name}} unknown {{later}}",
      parameters: [{ key: "name", label: "Name", type: "string", required: true }]
    }, { name: "value" })).toBe("Known value unknown {{later}}");
  });

  it("maps a selected template to a fresh agent schedule without losing behavior flags", () => {
    const template = scheduleTemplateCatalog(t).find((candidate) => candidate.id === "nightly-test-repair")!;
    expect(scheduleTemplateDraftPatch(template, {})).toMatchObject({
      name: "Nightly test self-healing",
      kind: "cron",
      expression: "0 2 * * *",
      timezone: "Asia/Shanghai",
      executionMode: "agent",
      sessionMode: "fresh",
      sessionId: "",
      useWorktree: true,
      worktreeSourceRef: undefined,
      refreshWorktreeRemote: false,
      notifyDesktop: true
    });
  });
});
