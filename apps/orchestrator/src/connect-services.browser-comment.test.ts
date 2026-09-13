import { Code } from "@connectrpc/connect";
import {
  BrowserCommentDesignAction,
  BrowserCommentInspectionIntent,
  BrowserCommentTargetKind,
  BrowserCommentThemeVariant
} from "@joko/contracts";
import type { BrowserProvider } from "@joko/tool-browser";
import { describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";

const context = {
  requestHeader: new Headers({ authorization: "Bearer connection-key" }),
  signal: new AbortController().signal
};

describe("ephemeral Browser page-comment service", () => {
  it("maps DOM evidence without publishing an operation and forwards the exact owner fence", async () => {
    const inspectHumanCommentTarget = vi.fn(async () => ({
      targetToken: "target-token-1",
      target: {
        kind: "element" as const,
        point: { x: 320, y: 180 },
        viewport: { width: 1280, height: 720 },
        targetTag: "button",
        targetLabel: "Save",
        targetRole: "button",
        targetSelector: "#save",
        targetPath: "html > body > button",
        nearbyText: "Account settings",
        themeVariant: "dark" as const,
        designBaseline: {
          styles: {
            color: "rgb(255, 255, 255)",
            "background-color": "rgb(37, 99, 235)",
            "font-size": "14px",
            "font-weight": "600",
            padding: "8px 12px",
            "border-radius": "6px"
          },
          editableText: "Save",
          provenance: { color: "selector .primary, /app.css" }
        }
      }
    }));
    const fixture = application({ inspectHumanCommentTarget });
    const services = createConnectServices(fixture);
    const inspect = services.browser.inspectBrowserCommentTarget as unknown as (request: Record<string, unknown>, context: unknown) => Promise<any>;
    const response = await inspect({
      browserProviderId: "browser-1",
      pageId: "page-1",
      takeoverId: "takeover-1",
      generation: 7n,
      intent: BrowserCommentInspectionIntent.ELEMENT,
      markerNumber: 4,
      point: { x: 0.25, y: 0.25 }
    }, context);

    expect(inspectHumanCommentTarget).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "browser-1",
      pageId: "page-1",
      takeoverId: "takeover-1",
      generation: 7,
      owner: "connection-1"
    }), { intent: "element", markerNumber: 4, normalizedX: 0.25, normalizedY: 0.25 });
    expect(response).toMatchObject({
      targetToken: "target-token-1",
      target: {
        kind: BrowserCommentTargetKind.ELEMENT,
        targetSelector: "#save",
        themeVariant: BrowserCommentThemeVariant.DARK,
        designBaseline: { editableText: "Save" }
      }
    });
  });

  it("preserves empty text previews and rejects a connection that does not own the takeover", async () => {
    const updateHumanCommentDesign = vi.fn(async () => ({
      placements: [{
        markerNumber: 1,
        point: { x: -24, y: 810 },
        viewport: { width: 1280, height: 720 },
        pending: true,
        region: { x: -50, y: 780, width: 120, height: 90 },
        textRegions: [{ x: -10, y: 800, width: 60, height: 20 }]
      }]
    }));
    const fixture = application({ updateHumanCommentDesign });
    const services = createConnectServices(fixture);
    const update = services.browser.updateBrowserCommentDesign as unknown as (request: Record<string, unknown>, context: unknown) => Promise<unknown>;
    const response = await update({
      browserProviderId: "browser-1",
      pageId: "page-1",
      takeoverId: "takeover-1",
      generation: 7n,
      action: BrowserCommentDesignAction.APPLY,
      targetToken: "target-token-1",
      styles: [{ key: "color", value: "#ffffff" }],
      text: ""
    }, context);
    expect(updateHumanCommentDesign).toHaveBeenCalledWith(expect.objectContaining({ owner: "connection-1" }), {
      action: "apply",
      targetToken: "target-token-1",
      styles: { color: "#ffffff" },
      text: ""
    });
    expect(response).toMatchObject({
      placements: [{
        markerNumber: 1,
        point: { x: -24, y: 810 },
        pending: true,
        region: { x: -50, y: 780 },
        textRegions: [{ x: -10, y: 800 }]
      }]
    });

    const foreign = application({ updateHumanCommentDesign }, "connection-2");
    const foreignUpdate = createConnectServices(foreign).browser.updateBrowserCommentDesign as unknown as typeof update;
    await expect(foreignUpdate({
      browserProviderId: "browser-1",
      pageId: "page-1",
      takeoverId: "takeover-1",
      generation: 7n,
      action: BrowserCommentDesignAction.RESET_ALL
    }, context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
  });
});

function application(
  methods: {
    readonly inspectHumanCommentTarget?: ReturnType<typeof vi.fn>;
    readonly updateHumanCommentDesign?: ReturnType<typeof vi.fn>;
  },
  owner = "connection-1"
): OrchestratorApplication {
  const takeover = {
    takeoverId: "takeover-1",
    providerId: "browser-1",
    pageId: "page-1",
    generation: 7,
    owner,
    startedAt: 1,
    expiresAt: 10_000
  };
  const browserProvider = {
    id: "browser-1",
    generation: 7,
    currentHumanTakeover: () => takeover,
    inspectHumanCommentTarget: methods.inspectHumanCommentTarget,
    updateHumanCommentDesign: methods.updateHumanCommentDesign
  } as unknown as BrowserProvider;
  return {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store: {},
    connections: { authenticate: vi.fn(() => ({ id: "connection-1", state: "active" })) },
    artifacts: {},
    blobTransfers: {},
    artifactRepository: {},
    workspaces: {},
    workspaceChanges: {},
    sessionHost: {},
    scheduler: {},
    adapters: [],
    browser: browserProvider,
    browserState: {
      findRecoverablePage: () => ({
        browserProviderId: "browser-1",
        pageId: "page-1",
        sessionId: "session-1",
        targetId: "target-1",
        bindingGeneration: 1,
        generation: 7,
        url: "https://example.test/",
        title: "Example",
        openedAt: 1,
        updatedAt: 1
      })
    },
    browserActivity: [],
    close: async () => undefined
  } as unknown as OrchestratorApplication;
}
