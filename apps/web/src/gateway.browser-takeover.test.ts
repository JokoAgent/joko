import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  BrowserProviderState,
  BrowserCommentDesignAction,
  BrowserCommentInspectionIntent,
  BrowserCommentTargetKind,
  BrowserCommentThemeVariant,
  BrowserTakeoverKey,
  BrowserTakeoverKeyModifier,
  BrowserTakeoverMouseButton,
  BrowserTakeoverNavigationCommandKind,
  BrowserTakeoverState,
  GetSnapshotResponseSchema,
  InspectBrowserCommentTargetResponseSchema,
  OperationState,
  SnapshotSchema,
  SubmitOperationResponseSchema,
  UpdateBrowserCommentDesignResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

describe("remote browser takeover gateway", () => {
  it("opens a session-scoped fresh page and returns its exact takeover page", async () => {
    const submitted: any[] = [];
    const snapshot = create(SnapshotSchema, {
      browsers: [{ browserProviderId: "browser-1", state: BrowserProviderState.READY, generation: 7n }]
    });
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") return response(method, create(GetSnapshotResponseSchema, { snapshot }));
        submitted.push(input.mutation.payload);
        return response(method, create(SubmitOperationResponseSchema, {
          operation: {
            operationId: input.operationId,
            state: OperationState.SUCCEEDED,
            result: {
              payload: {
                case: "browserTakeover",
                value: {
                  takeoverId: "takeover-new",
                  pageId: "page-new",
                  connectionId: "connection-1",
                  state: BrowserTakeoverState.ACTIVE,
                  generation: 7n
                }
              }
            }
          }
        }));
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-1", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    await expect(gateway.openBrowserPage("browser-1", "session-1", "https://example.test/docs")).resolves.toBe("page-new");
    expect(submitted).toMatchObject([{
      case: "openBrowserPage",
      value: {
        browserProviderId: "browser-1",
        sessionId: "session-1",
        url: "https://example.test/docs",
        expectedGeneration: 7n,
        currentPageId: "",
        takeoverId: "",
        recoveryPageId: ""
      }
    }]);
    await expect(gateway.openBrowserPage("browser-1", "session-1", "https://example.test/callback?access_token=secret"))
      .rejects.toThrow("Credential-shaped");
    expect(submitted).toHaveLength(1);
    gateway.disconnect();
  });

  it("focuses, closes, and restores pages through the exact owned lifecycle fence", async () => {
    const submitted: any[] = [];
    const snapshot = create(SnapshotSchema, {
      browsers: [{
        browserProviderId: "browser-1",
        state: BrowserProviderState.READY,
        generation: 7n,
        pages: [
          { pageId: "page-1", url: "https://one.test/" },
          { pageId: "page-2", url: "https://two.test/" },
          { pageId: "page-lost", url: "https://lost.test/", recoverable: true, lastKnownGeneration: 6n }
        ],
        takeover: {
          takeoverId: "takeover-1",
          pageId: "page-1",
          connectionId: "connection-1",
          state: BrowserTakeoverState.ACTIVE,
          generation: 7n
        }
      }]
    });
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") return response(method, create(GetSnapshotResponseSchema, { snapshot }));
        const payload = input.mutation.payload;
        submitted.push(payload);
        const pageId = payload.case === "focusBrowserPage" ? "page-2"
          : payload.case === "closeBrowserPage" ? "page-2"
            : "page-new";
        return response(method, create(SubmitOperationResponseSchema, {
          operation: {
            operationId: input.operationId,
            state: OperationState.SUCCEEDED,
            result: { payload: { case: "browserTakeover", value: {
              takeoverId: `takeover-${pageId}`,
              pageId,
              connectionId: "connection-1",
              state: BrowserTakeoverState.ACTIVE,
              generation: 7n
            } } }
          }
        }));
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-1", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    await expect(gateway.focusBrowserPage("browser-1", "page-2")).resolves.toBe("page-2");
    await expect(gateway.closeBrowserPage("browser-1", "page-1")).resolves.toBe("page-2");
    await expect(gateway.recoverBrowserPage("browser-1", "session-1", "page-lost", "https://lost.test/"))
      .resolves.toBe("page-new");

    expect(submitted).toMatchObject([
      { case: "focusBrowserPage", value: {
        browserProviderId: "browser-1", pageId: "page-2", currentPageId: "page-1", takeoverId: "takeover-1", generation: 7n
      } },
      { case: "closeBrowserPage", value: {
        browserProviderId: "browser-1", pageId: "page-1", currentPageId: "page-1", takeoverId: "takeover-1", generation: 7n
      } },
      { case: "openBrowserPage", value: {
        browserProviderId: "browser-1", sessionId: "session-1", url: "https://lost.test/", expectedGeneration: 7n,
        currentPageId: "page-1", takeoverId: "takeover-1", recoveryPageId: "page-lost"
      } }
    ]);
    gateway.disconnect();
  });

  it("submits the exact owner fence and refreshes the screenshot after a typed action", async () => {
    const submitted: any[] = [];
    const snapshot = create(SnapshotSchema, {
      generation: 1n,
      resumeCursor: { generation: 1n, sequence: 0n },
      browsers: [{
        browserProviderId: "browser-1",
        displayName: "Browser",
        state: BrowserProviderState.READY,
        generation: 7n,
        pages: [{ pageId: "page-1", title: "Page", url: "https://example.test" }],
        takeover: {
          takeoverId: "takeover-1",
          pageId: "page-1",
          connectionId: "connection-1",
          state: BrowserTakeoverState.ACTIVE,
          generation: 7n
        }
      }]
    });
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") return response(method, create(GetSnapshotResponseSchema, { snapshot }));
        submitted.push(input.mutation.payload);
        const screenshot = input.mutation.payload.case === "captureBrowserScreenshot";
        return response(method, create(SubmitOperationResponseSchema, {
          operation: {
            operationId: input.operationId,
            state: OperationState.SUCCEEDED,
            result: screenshot
              ? { payload: { case: "screenshot", value: { blob: { blobId: "blob-after-action" } } } }
              : { payload: { case: "acknowledgement", value: { accepted: true } } }
          }
        }));
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-1", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    const blobId = await gateway.performBrowserTakeoverAction("browser-1", "page-1", {
      kind: "mouseClick",
      normalizedX: 0.25,
      normalizedY: 0.75,
      button: "secondary"
    });

    expect(blobId).toBe("blob-after-action");
    expect(submitted.map((payload) => payload.case)).toEqual(["browserTakeoverAction", "captureBrowserScreenshot"]);
    expect(submitted[0]?.value).toMatchObject({
      browserProviderId: "browser-1",
      pageId: "page-1",
      takeoverId: "takeover-1",
      generation: 7n,
      action: {
        case: "mouseClick",
        value: { normalizedX: 0.25, normalizedY: 0.75, button: BrowserTakeoverMouseButton.SECONDARY }
      }
    });
    expect(submitted[1]?.value).toMatchObject({ browserProviderId: "browser-1", pageId: "page-1", fullPage: false });

    await gateway.performBrowserTakeoverAction("browser-1", "page-1", {
      kind: "mouseMove",
      normalizedX: 0.4,
      normalizedY: 0.2
    });
    await gateway.performBrowserTakeoverAction("browser-1", "page-1", {
      kind: "mouseDrag",
      startNormalizedX: 0.1,
      startNormalizedY: 0.2,
      endNormalizedX: 0.8,
      endNormalizedY: 0.9,
      button: "primary"
    });
    expect(submitted.filter((payload) => payload.case === "browserTakeoverAction").map((payload) => payload.value.action)).toMatchObject([
      { case: "mouseClick", value: { clickCount: 1 } },
      { case: "mouseMove", value: { normalizedX: 0.4, normalizedY: 0.2 } },
      { case: "mouseDrag", value: { startNormalizedX: 0.1, startNormalizedY: 0.2, endNormalizedX: 0.8, endNormalizedY: 0.9, button: BrowserTakeoverMouseButton.PRIMARY } }
    ]);
    gateway.disconnect();
  });

  it("encodes the keyboard whitelist and rejects a takeover owned by another connection before RPC", async () => {
    const snapshot = create(SnapshotSchema, {
      browsers: [{
        browserProviderId: "browser-1",
        state: BrowserProviderState.READY,
        generation: 7n,
        pages: [{ pageId: "page-1" }],
        takeover: { takeoverId: "takeover-1", pageId: "page-1", connectionId: "connection-2", state: BrowserTakeoverState.ACTIVE, generation: 7n }
      }]
    });
    const unary = vi.fn(async (method: any) => response(method, create(GetSnapshotResponseSchema, { snapshot })));
    const transport = { unary, stream: vi.fn(async (method: any) => response(method, idleStream(), true)) } as unknown as Transport;
    const gateway = createOrchestratorGateway({ id: "connection-1", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" }, "secret", {}, () => transport);
    await gateway.connect();
    unary.mockClear();

    await expect(gateway.performBrowserTakeoverAction("browser-1", "page-1", { kind: "keyPress", key: "enter" })).rejects.toThrow("another connection");
    expect(unary).not.toHaveBeenCalled();
    expect(BrowserTakeoverKey.ENTER).toBeGreaterThan(0);
    gateway.disconnect();
  });

  it("encodes modifier chords and chrome navigation without weakening the takeover fence", async () => {
    const submitted: any[] = [];
    const snapshot = create(SnapshotSchema, {
      browsers: [{
        browserProviderId: "browser-1",
        state: BrowserProviderState.READY,
        generation: 7n,
        pages: [{ pageId: "page-1", url: "https://example.test/" }],
        takeover: {
          takeoverId: "takeover-1",
          pageId: "page-1",
          connectionId: "connection-1",
          state: BrowserTakeoverState.ACTIVE,
          generation: 7n
        }
      }]
    });
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") return response(method, create(GetSnapshotResponseSchema, { snapshot }));
        submitted.push(input.mutation.payload);
        const screenshot = input.mutation.payload.case === "captureBrowserScreenshot";
        return response(method, create(SubmitOperationResponseSchema, {
          operation: {
            operationId: input.operationId,
            state: OperationState.SUCCEEDED,
            result: screenshot
              ? { payload: { case: "screenshot", value: { blob: { blobId: "capture" } } } }
              : { payload: { case: "acknowledgement", value: { accepted: true } } }
          }
        }));
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-1", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    await gateway.performBrowserTakeoverAction("browser-1", "page-1", {
      kind: "keyPress",
      key: "c",
      modifiers: ["control", "shift"]
    });
    await gateway.performBrowserTakeoverAction("browser-1", "page-1", {
      kind: "navigate",
      url: "https://openai.com/docs"
    });
    await gateway.performBrowserTakeoverAction("browser-1", "page-1", {
      kind: "navigationCommand",
      command: "forward"
    });

    const actions = submitted.filter((payload) => payload.case === "browserTakeoverAction").map((payload) => payload.value.action);
    expect(actions).toMatchObject([
      {
        case: "keyPress",
        value: {
          key: BrowserTakeoverKey.UNSPECIFIED,
          character: "c",
          modifiers: [BrowserTakeoverKeyModifier.CONTROL, BrowserTakeoverKeyModifier.SHIFT]
        }
      },
      { case: "navigate", value: { url: "https://openai.com/docs" } },
      { case: "navigationCommand", value: { command: BrowserTakeoverNavigationCommandKind.FORWARD } }
    ]);

    await expect(gateway.performBrowserTakeoverAction("browser-1", "page-1", {
      kind: "navigate",
      url: "https://example.test/callback?access_token=secret"
    })).rejects.toThrow("Credential-shaped");
    gateway.disconnect();
  });

  it("keeps DOM inspection and live design preview on the exact ephemeral takeover fence", async () => {
    const calls: Array<{ readonly method: string; readonly input: any }> = [];
    const snapshot = create(SnapshotSchema, {
      browsers: [{
        browserProviderId: "browser-1",
        state: BrowserProviderState.READY,
        generation: 7n,
        pages: [{ pageId: "page-1", title: "Page", url: "https://example.test/" }],
        takeover: {
          takeoverId: "takeover-1",
          pageId: "page-1",
          connectionId: "connection-1",
          state: BrowserTakeoverState.ACTIVE,
          generation: 7n
        }
      }]
    });
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") return response(method, create(GetSnapshotResponseSchema, { snapshot }));
        calls.push({ method: method.localName, input });
        if (method.localName === "inspectBrowserCommentTarget") {
          return response(method, create(InspectBrowserCommentTargetResponseSchema, {
            targetToken: "target-token-1",
            target: {
              kind: BrowserCommentTargetKind.ELEMENT,
              point: { x: 320, y: 180 },
              viewport: { width: 1280, height: 720 },
              targetTag: "button",
              targetLabel: "Save",
              targetRole: "button",
              targetSelector: "#save",
              targetPath: "html > body > button",
              nearbyText: "Account settings",
              themeVariant: BrowserCommentThemeVariant.DARK,
              designBaseline: {
                styles: [
                  { key: "color", value: "rgb(255, 255, 255)" },
                  { key: "font-weight", value: "400" }
                ],
                editableText: "Save",
                provenance: [{ key: "color", value: "selector .primary, /app.css" }]
              }
            }
          }));
        }
        if (method.localName === "updateBrowserCommentDesign" && input.action === BrowserCommentDesignAction.RECONCILE) {
          return response(method, create(UpdateBrowserCommentDesignResponseSchema, {
            placements: [{
              markerNumber: 4,
              point: { x: -12, y: 96 },
              viewport: { width: 1280, height: 720 },
              pending: true,
              textRegions: [{ x: -20, y: 80, width: 40, height: 18 }]
            }]
          }));
        }
        return response(method, create(UpdateBrowserCommentDesignResponseSchema, {}));
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway({ id: "connection-1", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" }, "secret", {}, () => transport);
    await gateway.connect();

    await expect(gateway.inspectBrowserCommentTarget("browser-1", "page-1", {
      intent: "element",
      markerNumber: 4,
      point: { x: 320, y: 180 },
      viewport: { width: 1280, height: 720 }
    })).resolves.toMatchObject({
      targetToken: "target-token-1",
      target: {
        kind: "element",
        targetSelector: "#save",
        themeVariant: "dark",
        designBaseline: { editableText: "Save", styles: { color: "rgb(255, 255, 255)" } }
      }
    });
    await gateway.updateBrowserCommentDesign("browser-1", "page-1", {
      action: "apply",
      targetToken: "target-token-1",
      styles: { color: "#ffffff", "font-weight": "600" },
      text: ""
    });
    await expect(gateway.updateBrowserCommentDesign("browser-1", "page-1", { action: "reconcile", validMarkerNumbers: [1, 3] })).resolves.toEqual([{
      markerNumber: 4,
      point: { x: -12, y: 96 },
      viewport: { width: 1280, height: 720 },
      pending: true,
      textRegions: [{ x: -20, y: 80, width: 40, height: 18 }]
    }]);

    const commentCalls = calls.filter((call) => call.method === "inspectBrowserCommentTarget" || call.method === "updateBrowserCommentDesign");
    expect(commentCalls[0]).toMatchObject({
      method: "inspectBrowserCommentTarget",
      input: {
        browserProviderId: "browser-1",
        pageId: "page-1",
        takeoverId: "takeover-1",
        generation: 7n,
        markerNumber: 4,
        intent: BrowserCommentInspectionIntent.ELEMENT,
        point: { x: 0.25, y: 0.25 }
      }
    });
    expect(commentCalls[1]).toMatchObject({ method: "updateBrowserCommentDesign", input: {
      action: BrowserCommentDesignAction.APPLY,
      targetToken: "target-token-1",
      styles: [
        { key: "color", value: "#ffffff" },
        { key: "font-weight", value: "600" }
      ],
      text: ""
    } });
    expect(commentCalls[2]).toMatchObject({ method: "updateBrowserCommentDesign", input: {
      action: BrowserCommentDesignAction.RECONCILE,
      validMarkerNumbers: [1, 3]
    } });
    gateway.disconnect();
  });
});

function response(method: any, message: any, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
