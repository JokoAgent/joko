// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController, ControllerState } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type ArtifactView, type BackendView, type SessionResourceView, type SessionView } from "../model.js";
import { SessionPane } from "./SessionPane.js";

vi.mock("./Composer.js", async () => {
  const React = await import("react");
  return {
    Composer: (props: { readonly resources: readonly SessionResourceView[]; readonly artifacts?: readonly ArtifactView[] }) => React.createElement(
      React.Fragment,
      undefined,
      React.createElement("output", { "data-testid": "task-resources" }, JSON.stringify(props.resources)),
      React.createElement("output", { "data-testid": "task-artifacts" }, JSON.stringify(props.artifacts ?? []))
    )
  };
});
vi.mock("./Timeline.js", () => ({ Timeline: () => null }));

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("SessionPane live resource catalog", () => {
  it("shows only the response owned by the current task generation", async () => {
    const pending: Array<(resources: readonly SessionResourceView[]) => void> = [];
    const listSessionResources = vi.fn<AppController["listSessionResources"]>((_sessionId, signal) => new Promise((resolve, reject) => {
      pending.push(resolve);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const first = session(1n);
    const controller = controllerFor(first, listSessionResources);
    const backend = resourceBackend();
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    roots.push(root);
    const render = async (current: SessionView) => act(async () => root.render(<SessionPane
      controller={controller}
      session={current}
      backend={backend}
      models={[]}
      timeline={[]}
      timelineHasEarlier={false}
      timelineHistoryLoading={false}
      onLoadEarlierTimeline={async () => undefined}
      extensionWidgets={[]}
      extensionStatuses={[]}
      queue={[]}
      extraDirectories={[]}
      resources={[]}
      commandRefreshSignal={[]}
      remainingInteractions={0}
      navigationOpen
      inspectorOpen
      t={(key) => key}
      runAction={(_key, action) => { void action(); }}
      onOpenNavigation={() => undefined}
      onOpenInspector={() => undefined}
      onRename={() => undefined}
      onArchive={() => undefined}
      onDelete={() => undefined}
    />));

    await render(first);
    await vi.waitFor(() => expect(listSessionResources).toHaveBeenCalledTimes(1));
    expect(catalog(container)).toEqual([]);
    await act(async () => pending[0]?.([resource(1)]));
    await vi.waitFor(() => expect(catalog(container)).toEqual([resource(1)]));

    const second = session(2n);
    await render(second);
    expect(catalog(container)).toEqual([]);
    await vi.waitFor(() => expect(listSessionResources).toHaveBeenCalledTimes(2));
    await act(async () => pending[1]?.([resource(1)]));
    expect(catalog(container)).toEqual([]);
  });

  it("uses the complete Artifact query and retires a prior task generation response", async () => {
    const pending: Array<(artifacts: readonly ArtifactView[]) => void> = [];
    const listSessionArtifacts = vi.fn<AppController["listSessionArtifacts"]>(() => new Promise((resolve) => {
      pending.push(resolve);
    }));
    const first = session(1n);
    const controller = controllerFor(first, vi.fn(async () => []), listSessionArtifacts);
    const backend = artifactBackend();
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    roots.push(root);
    const timelineOnly = artifact("timeline-only");
    const render = async (current: SessionView) => act(async () => root.render(<SessionPane
      controller={controller}
      session={current}
      backend={backend}
      models={[]}
      timeline={[{ id: "timeline-only", sequence: 1n, kind: "artifact", createdAt: 1, artifact: timelineOnly }]}
      timelineHasEarlier={false}
      timelineHistoryLoading={false}
      onLoadEarlierTimeline={async () => undefined}
      extensionWidgets={[]}
      extensionStatuses={[]}
      queue={[]}
      extraDirectories={[]}
      resources={[]}
      commandRefreshSignal={[]}
      remainingInteractions={0}
      navigationOpen
      inspectorOpen
      t={(key) => key}
      runAction={(_key, action) => { void action(); }}
      onOpenNavigation={() => undefined}
      onOpenInspector={() => undefined}
      onRename={() => undefined}
      onArchive={() => undefined}
      onDelete={() => undefined}
    />));

    await render(first);
    await vi.waitFor(() => expect(listSessionArtifacts).toHaveBeenCalledTimes(1));
    expect(artifactCatalog(container)).toEqual([]);

    await render(session(2n));
    await vi.waitFor(() => expect(listSessionArtifacts).toHaveBeenCalledTimes(2));
    await act(async () => pending[0]?.([artifact("old-generation")]));
    expect(artifactCatalog(container)).toEqual([]);
    await act(async () => pending[1]?.([artifact("catalog-artifact")]));
    await vi.waitFor(() => expect(artifactCatalog(container)).toEqual([artifact("catalog-artifact")]));
  });
});

function catalog(container: HTMLElement): readonly SessionResourceView[] {
  return JSON.parse(container.querySelector('[data-testid="task-resources"]')?.textContent ?? "[]") as SessionResourceView[];
}

function artifactCatalog(container: HTMLElement): readonly ArtifactView[] {
  return JSON.parse(container.querySelector('[data-testid="task-artifacts"]')?.textContent ?? "[]") as ArtifactView[];
}

function artifact(id: string): ArtifactView {
  return {
    id,
    blobId: `blob-${id}`,
    title: id,
    kind: "file",
    fileName: `${id}.txt`,
    mediaType: "text/plain",
    byteSize: 4
  };
}

function resource(runtimeGeneration: number): SessionResourceView {
  return {
    sessionId: "session-one",
    id: "resource-one",
    name: "Release",
    kind: "prompt",
    discoveredRevision: "sha256:exact",
    resourceVersion: "7",
    runtimeGeneration
  };
}

function resourceBackend(): BackendView {
  return {
    id: "backend-one",
    name: "Backend",
    version: "1",
    health: "healthy",
    capabilities: new Map([
      ["runtime.resources", { name: "runtime.resources", supported: true, options: [] }],
      ["input.mention", { name: "input.mention", supported: true, options: ["resource"] }]
    ])
  };
}

function artifactBackend(): BackendView {
  return {
    id: "backend-one",
    name: "Backend",
    version: "1",
    health: "healthy",
    capabilities: new Map([
      ["input.mention", { name: "input.mention", supported: true, options: ["artifact"] }]
    ])
  };
}

function session(generation: bigint): SessionView {
  return {
    id: "session-one",
    backendId: "backend-one",
    targetId: "target-one",
    name: "Task",
    state: "idle",
    pinned: false,
    archived: false,
    generation,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt: 1_000
  };
}

function controllerFor(
  sourceSession: SessionView,
  listSessionResources: AppController["listSessionResources"],
  listSessionArtifacts: AppController["listSessionArtifacts"] = async () => []
): AppController {
  const snapshot = { ...emptySnapshot(), sessions: [sourceSession], backends: [resourceBackend()] };
  const state: ControllerState = {
    ready: true,
    connectionState: "connected",
    profiles: [],
    machineCaches: [],
    machinePresenceByProfile: {},
    discoveredNodes: [],
    discoveryState: "idle",
    managedOrchestratorStatus: undefined,
    automaticConnectionAvailable: false,
    snapshot,
    route: { kind: "session", sessionId: sourceSession.id },
    preferences: DEFAULT_UI_PREFERENCES,
    extensionNotifications: []
  };
  return { state, listSessionResources, listSessionArtifacts } as unknown as AppController;
}
