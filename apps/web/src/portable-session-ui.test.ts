import { describe, expect, it } from "vitest";

import { emptySnapshot, type AppSnapshot, type BackendView, type ModelView, type SessionView } from "./model.js";
import {
  browserFileFromDesktopFile,
  isPortableSessionFile,
  portableSessionExecutionForTarget,
  portableSessionExportSupported,
  portableSessionTargetOptions,
  portableSessionWorktreeProbeTargetIds
} from "./portable-session-ui.js";

describe("portable session UI policy", () => {
  it("gates export and import destinations with the portable-transfer capability", () => {
    const snapshot = fixture();
    const local = session({ backendId: "capable" });
    expect(portableSessionExportSupported(local, snapshot)).toBe(true);
    expect(portableSessionExportSupported({ ...local, remoteWorkspace: true }, snapshot)).toBe(false);
    expect(portableSessionExportSupported(session({ backendId: "limited" }), snapshot)).toBe(false);
    expect(portableSessionTargetOptions(snapshot, new Set(["project-target"]))).toEqual([
      { id: "project-target", label: "Project · Workspace", worktreeSupported: true },
      { id: "dialogue-target", label: "Dialogue", worktreeSupported: false }
    ]);
    expect(portableSessionWorktreeProbeTargetIds(snapshot)).toEqual(["project-target"]);
  });

  it("uses the selected target backend defaults after capability filtering", () => {
    const execution = portableSessionExecutionForTarget(fixture(), "project-target");
    expect(execution).toEqual({
      providerId: "provider",
      modelId: "model",
      effort: "high",
      fastMode: true,
      permissionMode: "auto",
      planMode: true
    });
    expect(portableSessionExecutionForTarget(fixture(), "limited-target")).toBeUndefined();
  });

  it("turns a trusted desktop byte snapshot into the browser File contract", async () => {
    const file = browserFileFromDesktopFile({
      name: "task.JSHARE",
      mediaType: "application/vnd.joko.session",
      bytes: new Uint8Array([1, 2, 3])
    });
    expect(isPortableSessionFile(file)).toBe(true);
    expect(file.type).toBe("application/vnd.joko.session");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(isPortableSessionFile({ name: "task.jshare.zip" })).toBe(false);
  });
});

function fixture(): Pick<AppSnapshot, "backends" | "models" | "settings" | "targets" | "workspaces"> {
  const empty = emptySnapshot();
  const capable = backend("capable", true);
  const limited = backend("limited", false);
  const model: ModelView = {
    backendId: "capable",
    providerId: "provider",
    providerName: "Provider",
    modelId: "model",
    name: "Model",
    available: true,
    supportsImages: true,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsFast: true,
    efforts: ["medium", "high"],
    contextWindow: 100,
    maximumOutputTokens: 50,
    inputCostMicrosPerMillion: 0,
    outputCostMicrosPerMillion: 0,
    currencyCode: "USD"
  };
  return {
    backends: [capable, limited],
    models: [model],
    targets: [
      { id: "project-target", backendId: "capable", name: "Project", workspaceId: "project-workspace", workspaceName: "Workspace", trusted: true, pinned: false, archived: false },
      { id: "dialogue-target", backendId: "capable", name: "Dialogue", workspaceId: "dialogue-workspace", workspaceName: "Dialogue", trusted: true, pinned: false, archived: false },
      { id: "limited-target", backendId: "limited", name: "Limited", workspaceId: "limited-workspace", workspaceName: "Limited", trusted: true, pinned: false, archived: false }
    ],
    workspaces: [
      { id: "project-workspace", targetId: "project-target", name: "Workspace", kind: "userProject", serverPath: "D:/project", trusted: true, dirty: false, entries: [] },
      { id: "dialogue-workspace", targetId: "dialogue-target", name: "Dialogue", kind: "managedDialogue", serverPath: "D:/dialogue", trusted: true, dirty: false, entries: [] },
      { id: "limited-workspace", targetId: "limited-target", name: "Limited", kind: "userProject", serverPath: "D:/limited", trusted: true, dirty: false, entries: [] }
    ],
    settings: {
      ...empty.settings,
      backendSettings: [{
        backendId: "capable",
        enabled: true,
        permissionMode: "auto",
        planMode: true,
        model: { providerId: "provider", modelId: "model", effort: "high", fastMode: true }
      }],
      policy: { ...empty.settings.policy, defaultMode: "ask" }
    }
  };
}

function backend(id: string, portable: boolean): BackendView {
  return {
    id,
    name: id,
    version: "1",
    health: "healthy",
    capabilities: new Map([
      ["session.portable_transfer", { name: "session.portable_transfer", supported: portable, options: [] }],
      ["model.switch", { name: "model.switch", supported: true, options: [] }],
      ["model.effort", { name: "model.effort", supported: true, options: [] }],
      ["model.fast_mode", { name: "model.fast_mode", supported: true, options: [] }],
      ["permission.modes", { name: "permission.modes", supported: true, options: ["ask", "auto"] }],
      ["plan_mode", { name: "plan_mode", supported: true, options: [] }]
    ])
  };
}

function session(patch: Partial<SessionView>): SessionView {
  return {
    id: "session",
    backendId: "capable",
    targetId: "project-target",
    name: "Task",
    state: "idle",
    pinned: false,
    archived: false,
    generation: 1n,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt: 1,
    ...patch
  };
}
