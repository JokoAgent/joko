// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { translate } from "../i18n.js";
import type { TimelineItemView } from "../model.js";
import { RuntimeRecoveryBlock, summarizeRuntimeRecoveryError } from "./Timeline.js";

const roots: Root[] = [];
const english = (key: Parameters<typeof translate>[1], values?: Readonly<Record<string, string | number>>) => translate("en", key, values);
const chinese = (key: Parameters<typeof translate>[1], values?: Readonly<Record<string, string | number>>) => translate("zh-CN", key, values);

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("RuntimeRecoveryBlock", () => {
  it("compresses only the visible summary while retaining the complete interruption detail", () => {
    expect(summarizeRuntimeRecoveryError(" API Error: stream disconnected. More detail."))
      .toBe("stream disconnected.");
    expect(summarizeRuntimeRecoveryError(`API Error: ${"x".repeat(90)}`)?.length).toBe(72);
  });

  it("renders one grayscale progress row and expands its durable retry detail", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const item = recoveryItem("running");
    await act(async () => root.render(<RuntimeRecoveryBlock item={item} t={chinese} />));

    const row = container.querySelector<HTMLElement>(".runtime-recovery-row")!;
    const trigger = row.querySelector<HTMLButtonElement>("button")!;
    expect(row.dataset.state).toBe("running");
    expect(trigger.textContent).toContain("重新连接中 2/5…");
    expect(trigger.textContent).toContain("stream disconnected.");
    expect(row.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("重新连接中 2/5…");
    expect(row.querySelector("pre")).toBeNull();

    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(row.querySelector("pre")?.textContent).toBe("API Error: stream disconnected. Full provider detail.");
    expect(row.textContent).toContain("本次重试 2/5");
    expect(row.textContent).toContain("本任务累计重连 4 次");

    await act(async () => root.render(<RuntimeRecoveryBlock item={recoveryItem("succeeded")} t={english} />));
    expect(container.querySelector(".runtime-recovery-row")?.textContent).toContain("Reconnected");
  });
});

function recoveryItem(state: NonNullable<TimelineItemView["runtimeRecovery"]>["state"]): TimelineItemView {
  return {
    id: "runtime-recovery-a",
    sequence: 3n,
    kind: "runtimeRecovery",
    createdAt: 123,
    runtimeRecovery: {
      id: "recovery-a",
      sourceRunId: "run-a",
      continuationRunId: "run-b",
      state,
      attempt: 2,
      maximumAttempts: 5,
      sessionTotal: 4,
      error: {
        code: "UPSTREAM_OVERLOAD",
        message: "API Error: stream disconnected. Full provider detail.",
        phase: "stream",
        severity: "retryable",
        retryable: true,
        recovery: []
      }
    }
  };
}
