// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { TimelineItemView } from "../model.js";
import { ErrorTailBanner } from "./ErrorTailBanner.js";

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => { document.body.replaceChildren(); });

describe("ErrorTailBanner usage-limit recovery", () => {
  it("offers the prefilled schedule action for a classified Provider limit", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onSchedule = vi.fn();
    const hint = { resetAtMs: 4_100_000_000_000 };
    await act(async () => root.render(<ErrorTailBanner
      item={errorItem()}
      actions={[]}
      usageLimitRecovery={hint}
      t={(key) => String(key)}
      onAction={vi.fn()}
      onScheduleUsageRecovery={onSchedule}
    />));

    const button = [...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.includes("errorTail.scheduleAfterReset"));
    await act(async () => button?.click());
    expect(onSchedule).toHaveBeenCalledExactlyOnceWith(hint);
    await act(async () => root.unmount());
  });
});

function errorItem(): TimelineItemView {
  return {
    id: "error-one",
    kind: "error",
    title: "Provider limit",
    text: "The usage limit has been reached.",
    error: {
      code: "PROVIDER_LIMIT",
      message: "The usage limit has been reached.",
      phase: "stream",
      severity: "blocked",
      retryable: false,
      recovery: []
    }
  } as unknown as TimelineItemView;
}
