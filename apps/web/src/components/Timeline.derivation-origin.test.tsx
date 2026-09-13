// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { SessionView, TimelineItemView } from "../model.js";
import { SessionDerivationMarker } from "./Timeline.js";
import { insertTimelineDerivationOrigin, projectTimelineRenderItems } from "./timeline-render-items.js";
import type { Translator } from "./types.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("Timeline task derivation origin", () => {
  it("mounts an accessible source action and degrades to static context when unavailable", async () => {
    const origin = derivationOrigin();
    const onOpen = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => root.render(<SessionDerivationMarker origin={origin} onOpen={onOpen} t={t} />));
    expect(container.querySelector('[role="note"][aria-label="timeline.forkOrigin"]')).not.toBeNull();
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="timeline.openOrigin"]');
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    expect(onOpen).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<SessionDerivationMarker origin={{ ...origin, sourceSessionAvailable: false, sourceMessageAvailable: false }} t={t} />));
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector(".timeline-derivation-origin__unavailable")?.textContent)
      .toContain("timeline.originUnavailable");
  });

  it("places the marker between inherited history and activity created after the fork", () => {
    const projected = projectTimelineRenderItems([
      item("old", 10),
      item("new", 30)
    ]);
    const rows = insertTimelineDerivationOrigin(projected, derivationOrigin(), 20);

    expect(rows.map((row) => row.type === "item" ? row.item.id : row.type)).toEqual([
      "old",
      "derivationOrigin",
      "new"
    ]);
  });
});

function derivationOrigin(): NonNullable<SessionView["derivationOrigin"]> {
  return {
    kind: "fork",
    sourceSessionId: "source-task",
    sourceMessageId: "source-message",
    sourceEventId: "source-event",
    sourceSessionAvailable: true,
    sourceMessageAvailable: true
  };
}

function item(id: string, createdAt: number): TimelineItemView {
  return { id, sequence: BigInt(createdAt), kind: "assistant", createdAt, text: id };
}

const t: Translator = (key) => String(key);
