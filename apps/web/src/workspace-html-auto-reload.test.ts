import { expect, it } from "vitest";
import type { SessionView, TimelineItemView } from "./model.js";
import { WorkspaceHtmlAutoReload } from "./workspace-html-auto-reload.js";

it("refreshes only the observed main Run's changed HTML after delayed durable change evidence, once and while active", () => {
  const tracker = new WorkspaceHtmlAutoReload("workspace", "pages/index.html");
  const session = (runId?: string) => ({ ...(runId === undefined ? {} : { activeRunId: runId }) }) as SessionView;
  const evidence = (runId: string, path: string) => [{ runId, workspaceDiff: { changeSetId: runId, workspaceId: "workspace", files: [{ path, status: "modified" }] } }] as unknown as TimelineItemView[];
  expect(tracker.observe(session(), evidence("old", "pages/index.html"), true)).toBe(false);
  expect(tracker.observe(session("run"), [], true)).toBe(false);
  expect(tracker.observe(session(), [], true)).toBe(false);
  expect(tracker.observe(session(), evidence("old", "pages/index.html"), true)).toBe(false);
  expect(tracker.observe(session(), evidence("run", "pages/index.html"), true)).toBe(true);
  expect(tracker.observe(session(), evidence("run", "pages/index.html"), true)).toBe(false);
  tracker.observe(session("other-file"), [], true);
  expect(tracker.observe(session(), evidence("other-file", "assets/style.css"), true)).toBe(false);
  tracker.observe(session("inactive"), [], true);
  tracker.observe(session(), [], false);
  expect(tracker.observe(session(), evidence("inactive", "pages/index.html"), true)).toBe(false);
  tracker.observe(session("superseded"), [], true);
  tracker.observe(session("new-run"), [], true);
  expect(tracker.observe(session(), evidence("superseded", "pages/index.html"), true)).toBe(false);
  expect(tracker.observe(session(), evidence("new-run", "pages/index.html"), true)).toBe(true);
});

it("follows same-authority HTML navigation without trusting another preview origin or malformed page URL", () => {
  const tracker = new WorkspaceHtmlAutoReload("workspace", "pages/index.html");
  const session = (runId?: string) => ({ ...(runId === undefined ? {} : { activeRunId: runId }) }) as SessionView;
  const evidence = (runId: string, path: string) => [{ runId, workspaceDiff: { changeSetId: runId, workspaceId: "workspace", files: [{ path, status: "modified" }] } }] as unknown as TimelineItemView[];
  expect(tracker.observePageUrl("http://preview.preview.joko.localhost/pages/index.html?generation=one#main")).toBe(true);
  expect(tracker.observePageUrl("http://preview.preview.joko.localhost/pages/details.html?generation=two")).toBe(true);
  tracker.observe(session("details"), [], true);
  expect(tracker.observe(session(), evidence("details", "pages/index.html"), true)).toBe(false);
  tracker.observe(session("details-current"), [], true);
  expect(tracker.observe(session(), evidence("details-current", "pages/details.html"), true)).toBe(true);

  expect(tracker.observePageUrl("http://other.preview.joko.localhost/pages/other.html")).toBe(false);
  expect(tracker.observePageUrl("http://preview.preview.joko.localhost/pages/%2e%2e%2Fprivate.html")).toBe(false);
  expect(tracker.observePageUrl("http://preview.preview.joko.localhost/pages/data.json")).toBe(false);
  tracker.observe(session("still-details"), [], true);
  expect(tracker.observe(session(), evidence("still-details", "pages/details.html"), true)).toBe(true);
});
