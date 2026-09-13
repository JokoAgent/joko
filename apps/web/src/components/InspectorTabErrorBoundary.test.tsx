// @vitest-environment jsdom

import { act, useState } from "react";
import type { JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { translate } from "../i18n.js";
import { InspectorTabErrorBoundary } from "./InspectorTabErrorBoundary.js";
import type { Translator } from "./types.js";

const roots: Root[] = [];
const t: Translator = (key, values) => translate("en", key, values);

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("Inspector tab error isolation", () => {
  it("keeps sibling panels mounted and retries only the failed panel", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    roots.push(root);

    function ThrowingPanel({ failed }: { readonly failed: boolean }): JSX.Element {
      if (failed) throw new Error("panel failed");
      return <span>recovered panel</span>;
    }

    function Harness(): JSX.Element {
      const [failed, setFailed] = useState(true);
      return <>
        <button type="button" onClick={() => setFailed(false)}>repair panel</button>
        <InspectorTabErrorBoundary resetKey="session:broken" t={t}><ThrowingPanel failed={failed} /></InspectorTabErrorBoundary>
        <InspectorTabErrorBoundary resetKey="session:healthy" t={t}><span>healthy panel</span></InspectorTabErrorBoundary>
      </>;
    }

    await act(async () => root.render(<Harness />));
    expect(container.textContent).toContain(t("errorBoundary.routeTitle"));
    expect(container.textContent).toContain("healthy panel");
    await act(async () => buttonWithText(container, "repair panel").click());
    await act(async () => buttonWithText(container, t("common.retry")).click());
    expect(container.textContent).toContain("recovered panel");
    expect(container.textContent).toContain("healthy panel");
    consoleError.mockRestore();
  });
});

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.includes(text));
  if (button === undefined) throw new Error(`Expected button: ${text}`);
  return button;
}
