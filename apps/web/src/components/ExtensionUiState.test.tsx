// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ExtensionStatusView, ExtensionWidgetView } from "../model.js";
import { ExtensionStatuses, ExtensionWidgets } from "./SessionPane.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("durable extension UI state", () => {
  it("keeps status text readable while hiding its technical identity", () => {
    const container = mount(<ExtensionStatuses statuses={[status("technical-status-key", "  One\r\nTwo\tThree\u0000Four\u007fFive  ")]} />);
    const rendered = container.querySelector<HTMLElement>(".extension-status");

    expect(rendered?.textContent).toBe("One Two Three Four Five");
    expect(rendered?.dataset.statusKey).toBe("technical-status-key");
    expect(rendered?.title).toBe("One Two Three Four Five");
    expect(container.textContent).not.toContain("technical-status-key");
  });

  it("renders native-compatible bounded widget lines without a visible raw key", () => {
    const lines = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`);
    const container = mount(<ExtensionWidgets widgets={[widget("technical-widget-key", lines)]} label="Extension widgets" />);
    const section = container.querySelector<HTMLElement>(".extension-widget");

    expect(section?.dataset.widgetKey).toBe("technical-widget-key");
    expect(section?.getAttribute("aria-label")).toBe("technical-widget-key");
    expect(section?.textContent).toContain("line-10");
    expect(section?.textContent).not.toContain("line-11");
    expect(section?.textContent).toContain("... (widget truncated)");
    expect(section?.textContent).not.toContain("technical-widget-key");
  });
});

function mount(node: ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(node));
  return container;
}

function status(key: string, text: string): ExtensionStatusView {
  return { sessionId: "session-one", key, text, updatedAt: 1_000 };
}

function widget(key: string, lines: readonly string[]): ExtensionWidgetView {
  return { sessionId: "session-one", key, lines, placement: "aboveEditor", updatedAt: 1_000 };
}
