// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { translate } from "../i18n.js";
import type { TimelineItemView } from "../model.js";
import { ReviewCard, reviewTaskHash } from "./Timeline.js";

const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]): string => translate("en", key, values);
const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("isolated Review card", () => {
  it("shows the independent read-only hint and reviewer task link while running", () => {
    const markup = renderToStaticMarkup(<ReviewCard item={item({ state: "running" })} t={t} />);
    expect(markup).toContain("Reviewing current work");
    expect(markup).toContain("Independent task · no development memory · read-only");
    expect(markup).toContain("Open review task");
  });

  it("renders completed markdown and typed failure copy without exposing provider errors", () => {
    const complete = renderToStaticMarkup(<ReviewCard item={item({ state: "completed", result: "## Finding\n\nSafe." })} t={t} />);
    expect(complete).toContain("Review complete");
    expect(complete).toContain("<h2>Finding</h2>");

    const stale = renderToStaticMarkup(<ReviewCard item={item({
      state: "completed",
      freshness: "stale",
      result: "## Previous conclusion\n\nPreserved."
    })} t={t} />);
    expect(stale).toContain("Outdated evidence");
    expect(stale).toContain("preserved for audit");
    expect(stale).toContain("Recheck evidence to verify its status");
    expect(stale).toContain("<h2>Previous conclusion</h2>");

    const failed = renderToStaticMarkup(<ReviewCard item={item({ state: "failed", failureCode: "artifact-unavailable" })} t={t} />);
    expect(failed).toContain("Review did not complete");
    expect(failed).toContain("couldn&#x27;t safely read the review artifacts");
  });

  it("opens the exact reviewer task route without treating its ID as path syntax", () => {
    expect(reviewTaskHash("reviewer/one two")).toBe("#/tasks/reviewer%2Fone%20two");
  });

  it("offers evidence reobservation only for terminal stale or unavailable Reviews", () => {
    const reobserve = async (): Promise<void> => undefined;
    const stale = renderToStaticMarkup(<ReviewCard item={item({ state: "completed", freshness: "stale" })} t={t} onReobserveReview={reobserve} />);
    const unavailable = renderToStaticMarkup(<ReviewCard item={item({ state: "failed", freshness: "unavailable" })} t={t} onReobserveReview={reobserve} />);
    const current = renderToStaticMarkup(<ReviewCard item={item({ state: "completed", freshness: "current" })} t={t} onReobserveReview={reobserve} />);
    const running = renderToStaticMarkup(<ReviewCard item={item({ state: "running", freshness: "unavailable" })} t={t} onReobserveReview={reobserve} />);

    expect(stale).toContain("Recheck evidence");
    expect(unavailable).toContain("Recheck evidence");
    expect(current).not.toContain("Recheck evidence");
    expect(running).not.toContain("Recheck evidence");
    expect(translate("zh-CN", "review.reobserve")).toBe("重新检查证据");
  });

  it("keeps the durable conclusion visible and prevents duplicate checks while one is pending", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const reobserve = vi.fn(() => pending);
    const container = await mount(<ReviewCard
      item={item({ state: "completed", freshness: "stale", result: "Preserved conclusion" })}
      t={t}
      onReobserveReview={reobserve}
    />);
    const button = buttonNamed(container, "Recheck evidence");

    await act(async () => { button.click(); button.click(); await Promise.resolve(); });
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toContain("Checking evidence…");
    expect(container.textContent).toContain("Preserved conclusion");
    expect(reobserve).toHaveBeenCalledTimes(1);
    expect(reobserve).toHaveBeenCalledWith("review-1");

    await act(async () => { finish(); await pending; });
    expect(button.disabled).toBe(false);
  });

  it("keeps the last verified freshness and shows local recovery copy when reobservation fails", async () => {
    const container = await mount(<ReviewCard
      item={item({ state: "completed", freshness: "unavailable", result: "Last durable conclusion" })}
      t={t}
      onReobserveReview={async () => { throw new Error("private provider detail"); }}
    />);

    await act(async () => { buttonNamed(container, "Recheck evidence").click(); await Promise.resolve(); });

    expect(container.querySelector("article")?.dataset.freshness).toBe("unavailable");
    expect(container.textContent).toContain("Last durable conclusion");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn't recheck the evidence. The last verified state is unchanged.");
    expect(container.textContent).not.toContain("private provider detail");
  });
});

async function mount(element: ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.includes(name));
  if (button === undefined) throw new Error(`Missing button ${name}`);
  return button;
}

function item(overrides: Partial<NonNullable<TimelineItemView["review"]>>): TimelineItemView {
  return {
    id: "review:review-1",
    sequence: 1n,
    kind: "review",
    createdAt: 1,
    review: {
      id: "review-1",
      sourceSessionId: "source-1",
      reviewerSessionId: "reviewer-1",
      state: "running",
      freshness: "current",
      freshnessCheckedAt: 1,
      targetKind: "mixed",
      evidence: { sealSha256: "a".repeat(64), capturedAt: 1 },
      createdAt: 1,
      updatedAt: 1,
      revision: 1n,
      ...overrides
    }
  };
}
