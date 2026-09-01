// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { EmptyState } from "./ui.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("EmptyState accessibility", () => {
  it("owns a unique heading relationship for every mounted instance", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(<>
      <EmptyState title="Main empty state" body="Nothing in the main view." />
      <EmptyState title="Inspector empty state" body="Nothing in the side panel." />
    </>));

    const sections = [...host.querySelectorAll<HTMLElement>(".empty-state")];
    const labelledBy = sections.map((section) => section.getAttribute("aria-labelledby"));
    expect(new Set(labelledBy).size).toBe(2);
    expect(sections.map((section) => {
      const id = section.getAttribute("aria-labelledby");
      const heading = section.querySelector<HTMLHeadingElement>("h2");
      return heading?.id === id ? heading.textContent : undefined;
    })).toEqual(["Main empty state", "Inspector empty state"]);
  });
});
