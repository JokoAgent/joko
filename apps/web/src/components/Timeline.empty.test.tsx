// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import { Timeline } from "./Timeline.js";
import type { Translator } from "./types.js";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

it("keeps the exact Task identity on an empty timeline", async () => {
  const t = ((key: string) => key) as Translator;
  await act(async () => root.render(<Timeline
    ownerKey="empty-task-owner"
    sessionId="empty-task"
    sessionName="Empty Task"
    sessionActive={false}
    items={[]}
    messageNavRailEnabled={false}
    streamFadeEnabled={false}
    hasEarlier={false}
    historyLoading={false}
    locale="en"
    t={t}
    onLoadEarlier={async () => undefined}
    onArtifactUrl={async () => ""}
    onArtifactUrlRelease={() => undefined}
    onArtifactDownload={async () => "dispatched"}
  />));

  const timeline = host.querySelector<HTMLElement>('.timeline--empty[data-timeline-session-id="empty-task"]');
  expect(timeline).not.toBeNull();
  expect(timeline?.getAttribute("aria-label")).toBe("timeline.label");
});
