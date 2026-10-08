// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { AppController, ControllerState } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type BackendView, type SessionView } from "../model.js";
import { plainTextToComposerDocument } from "../composer-quote-document.js";
import type { ObjectiveDialogHandoffRequest } from "./ObjectiveIndicator.js";
import { SessionPane } from "./SessionPane.js";

const harness = vi.hoisted(() => ({
  composer: undefined as Record<string, unknown> | undefined,
  indicator: undefined as Record<string, unknown> | undefined
}));

vi.mock("./Composer.js", async () => {
  const { useEffect, useRef } = await import("react");
  return {
    Composer: (props: Record<string, unknown>) => {
      harness.composer = props;
      const applied = useRef<string | undefined>(undefined);
      useEffect(() => {
        const handoff = props.objectiveDialogHandoff as ObjectiveDialogHandoffRequest | undefined;
        const open = props.onOpenObjective as ((onSaved: () => void, request: ObjectiveDialogHandoffRequest) => void) | undefined;
        if (handoff !== undefined && applied.current !== handoff.id) {
          applied.current = handoff.id;
          open?.(() => undefined, handoff);
        }
      }, [props.objectiveDialogHandoff, props.onOpenObjective]);
      return null;
    }
  };
});

vi.mock("./ObjectiveIndicator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ObjectiveIndicator.js")>();
  return {
    ...actual,
    ObjectiveIndicator: (props: Record<string, unknown>) => {
      harness.indicator = props;
      return null;
    }
  };
});

vi.mock("./Timeline.js", () => ({ Timeline: () => null }));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness.composer = undefined;
  harness.indicator = undefined;
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("retires the local handoff request when Objective write access disappears", async () => {
  const handled = vi.fn();
  const controller = objectiveController();
  const handoff = objectiveHandoff();

  await render(controller, session, handoff, handled);
  await vi.waitFor(() => expect((harness.indicator?.dialogRequest as { readonly id?: string } | undefined)?.id).toBe(handoff.id));
  expect(handled).not.toHaveBeenCalled();

  const archived = { ...session, archived: true };
  await render(controller, archived, handoff, handled);
  await vi.waitFor(() => expect(handled).toHaveBeenCalledWith(handoff.id));
  expect(harness.indicator?.dialogRequest).toBeUndefined();
});

const session: SessionView = {
  id: "task-one",
  backendId: "backend-one",
  targetId: "target-one",
  name: "Task one",
  state: "idle",
  pinned: false,
  archived: false,
  generation: 9n,
  fastMode: false,
  permissionMode: "ask",
  planMode: false,
  updatedAt: 1
};

const backend: BackendView = {
  id: session.backendId,
  name: "Backend",
  version: "1",
  health: "healthy",
  authenticationState: "notRequired",
  capabilities: new Map([["input.text", { name: "input.text", supported: true, options: [] }]])
};

function objectiveHandoff(): ObjectiveDialogHandoffRequest {
  return {
    id: "home-objective",
    serverId: "server-one",
    profileId: "profile-one",
    connectionGeneration: 3,
    sessionId: session.id,
    sessionGeneration: session.generation,
    expectedDraft: {
      text: "/goal",
      editorDocument: plainTextToComposerDocument("/goal"),
      attachments: [],
      mentions: [],
      deliveryMode: "prompt"
    }
  };
}

function objectiveController(): AppController {
  const snapshot = { ...emptySnapshot(), sessions: [session], backends: [backend] };
  const state: ControllerState = {
    ready: true,
    connectionState: "connected",
    connectionGeneration: 3,
    profiles: [],
    machineCaches: [],
    machinePresenceByProfile: {},
    activeProfile: { id: "profile-one", serverId: "server-one", deviceId: "device-one", name: "Local", origin: "https://localhost" },
    discoveredNodes: [],
    discoveryState: "idle",
    managedOrchestratorStatus: undefined,
    automaticConnectionAvailable: false,
    snapshot,
    route: { kind: "session", sessionId: session.id },
    preferences: DEFAULT_UI_PREFERENCES,
    systemLocale: "en",
    effectiveLocale: "en",
    extensionNotifications: []
  };
  return {
    state,
    getPortableReplacementCleanup: vi.fn(async () => undefined),
    exportSession: vi.fn(async () => new Blob()),
    getArtifactUrl: vi.fn(async () => "blob:artifact"),
    releaseArtifactUrl: vi.fn(),
    downloadArtifact: vi.fn(async () => undefined)
  } as unknown as AppController;
}

async function render(
  controller: AppController,
  currentSession: SessionView,
  handoff: ObjectiveDialogHandoffRequest,
  onHandled: (requestId: string) => void
): Promise<void> {
  await act(async () => root.render(<SessionPane
    controller={controller}
    session={currentSession}
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
    navigationOpen={false}
    inspectorOpen={false}
    objectiveDialogHandoff={handoff}
    onObjectiveDialogHandoffHandled={onHandled}
    t={(key) => key}
    runAction={(_key, action) => { void action(); }}
    onOpenNavigation={() => undefined}
    onOpenInspector={() => undefined}
    onRename={() => undefined}
    onArchive={() => undefined}
    onDelete={() => undefined}
  />));
}
