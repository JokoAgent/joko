import { describe, expect, it } from "vitest";
import { BrowserExperienceRecorder, deferredBrowserRecipeIssue, suggestBrowserRecipes } from "./browser-experience.js";

describe("Browser experience", () => {
  it("records only the navigation-to-read action shape and retires failed or finished flows", () => {
    const recorder = new BrowserExperienceRecorder();
    recorder.start("task/page", "https://example.test/private?q=secret");
    expect(recorder.step("other/page", "extract")).toBeUndefined();
    expect(recorder.step("task/page", "type")).toBeUndefined();
    expect(recorder.step("task/page", "extract")).toEqual({ site: "example.test", actions: ["navigate", "type", "extract"] });
    expect(recorder.step("task/page", "evaluate")).toBeUndefined();
    recorder.start("task/page", "https://example.test"); recorder.clear("task/page");
    expect(recorder.step("task/page", "extract")).toBeUndefined();
    recorder.start("task/page", "https://user:secret@example.test");
    expect(recorder.step("task/page", "extract")).toBeUndefined();
    recorder.start("task/page", "https://example.test");
    for (let i = 0; i < 32; i++) recorder.step("task/page", "wait");
    expect(recorder.step("task/page", "extract")).toBeUndefined();
  });

  it("suggests only host-bound, profile-matching reusable recipes with a bounded intent ranking", () => {
    const recipes = ["search", "read", "latest", "more"].map(id => ({ id, match: ["example.test"], access: "read" as const, steps: [{ action: "extract" }] }));
    const suspended = { ...recipes[0]!, id: "paused", validation: { site: "example.test", state: "suspended" as const } };
    const other = { ...recipes[0]!, id: "other", validation: { site: "example.test", state: "active" as const, profile: "sidebar" } };
    const unsafe = { ...recipes[0]!, id: "unsafe", validation: { site: "example.test", state: "candidate" as const }, steps: [{ action: "click" }] };
    expect(suggestBrowserRecipes([...recipes, suspended, other, unsafe], "sub.example.test", "search", "external").map(recipe => recipe.id)).toEqual(["search"]);
    expect(suggestBrowserRecipes(recipes, "notexample.test", "", "external")).toEqual([]);
    expect(suggestBrowserRecipes(recipes, "example.test", "", "external")).toHaveLength(3);
    expect(deferredBrowserRecipeIssue({ access: "write", steps: [{ action: "extract" }] })).toBeDefined();
    expect(deferredBrowserRecipeIssue({ access: "read", steps: [{ action: "wait", fn: "() => true" }] })).toBeDefined();
  });
});
