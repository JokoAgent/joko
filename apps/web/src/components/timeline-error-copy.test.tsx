// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { translate } from "../i18n.js";
import type { TimelineItemView } from "../model.js";
import { ErrorBlock } from "./Timeline.js";

const roots: ReturnType<typeof createRoot>[] = [];

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("classified timeline failure UX", () => {
  it("shows localized title, message, and recovery copy while keeping technical detail collapsed", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ErrorBlock item={errorItem("UPSTREAM_OVERLOAD", "redacted upstream detail")} locale="zh-CN" t={(key, values) => translate("zh-CN", key, values)} />));

    expect(container.querySelector(".timeline-error__message")?.textContent).toContain("没有可用容量");
    expect(container.querySelector(".timeline-error__recovery")?.textContent).toContain("另一个可用模型");
    expect(container.querySelector(".timeline-error header strong")?.textContent).toBe("模型服务繁忙");
    const details = container.querySelector<HTMLDetailsElement>(".timeline-error__raw");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe("显示原始错误");
    expect(details?.querySelector("code")?.textContent).toBe("UPSTREAM_OVERLOAD");
    expect(details?.querySelector("pre")?.textContent).toBe("redacted upstream detail");

    await act(async () => {
      details!.open = true;
      details!.dispatchEvent(new Event("toggle", { bubbles: false }));
    });
    expect(details?.querySelector("summary")?.textContent).toBe("隐藏原始错误");
  });

  it("keeps unknown code and message out of the visible summary and inside technical detail", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ErrorBlock item={errorItem("GENERIC_FAILURE", "ordinary failure")} locale="en" t={(key, values) => translate("en", key, values)} />));

    expect(container.querySelector(".timeline-error__message")?.textContent).toBe("The task could not continue because of an unexpected problem.");
    expect(container.querySelector(".timeline-error__recovery")?.textContent).toContain("open diagnostics");
    expect(container.querySelector(".timeline-error header strong")?.textContent).toBe("Something went wrong");
    const details = container.querySelector<HTMLDetailsElement>(".timeline-error__raw");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("code")?.textContent).toBe("GENERIC_FAILURE");
    expect(details?.querySelector("pre")?.textContent).toBe("ordinary failure");
  });
});

function errorItem(code: string, message: string): TimelineItemView {
  return {
    id: `error-${code}`,
    sequence: 1n,
    kind: "error",
    createdAt: 1,
    title: code,
    text: message,
    error: { code, message, phase: "stream", severity: "retryable", retryable: true, recovery: [] }
  };
}
