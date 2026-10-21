// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { McpAppCardSchema, McpAppOperation, McpAppServiceOperateResponseSchema } from "@joko/contracts";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { McpAppCard, McpAppTimelineProvider } from "./McpAppCard.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
});
const roots: Array<{ root: Root; element: HTMLElement }> = [];
afterEach(async () => { for (const { root, element } of roots.splice(0)) { await act(async () => root.unmount()); element.remove(); } });
const t = (key: Parameters<typeof translate>[1]) => translate("en", key);
const card = create(McpAppCardSchema, { cardId: "mcp-app:00000000-0000-0000-0000-000000000001", sessionId: "task", title: "Example form", text: "Public answer" });
function mount() { const element = document.body.appendChild(document.createElement("div")), root = createRoot(element); roots.push({ root, element }); return { root, element }; }
function controller(operate: ReturnType<typeof vi.fn>, serverId = "one", guest = false): AppController {
  return { state: { connectionState: "connected", activeProfile: { id: "connection", serverId, origin: "https://node.example.test" },
    snapshot: { generation: 1n }, ...(guest ? { sessionAccess: { role: "guest" } } : {}) },
    mcpAppApi: () => ({ operate }), openHttpLink: vi.fn(async () => {}) } as unknown as AppController;
}

it("keeps shared-task cards read-only without opening an interactive View", async () => {
  const f = mount(), operate = vi.fn();
  await act(async () => f.root.render(<McpAppTimelineProvider controller={controller(operate, "one", true)}><McpAppCard card={card} locale="en" t={t} /></McpAppTimelineProvider>));
  expect(f.element.textContent).toContain("Public answer");
  expect(f.element.textContent).toContain("read-only");
  expect(f.element.querySelector("iframe")).toBeNull();
  expect(operate).not.toHaveBeenCalled();
});

it("accepts presentation notifications only from its real proxy and retains the same frame across updates", async () => {
  const f = mount();
  const operate = vi.fn(async ({ operation }: { operation: McpAppOperation }) => operation === McpAppOperation.OPEN
    ? create(McpAppServiceOperateResponseSchema, { viewId: "view", proxyUrl: "https://node.example.test/mcp-apps/proxy/opaque", prefersBorder: true })
    : create(McpAppServiceOperateResponseSchema));
  await act(async () => f.root.render(<McpAppTimelineProvider controller={controller(operate)}><McpAppCard card={card} locale="en" t={t} /></McpAppTimelineProvider>));
  const frame = f.element.querySelector("iframe")!;
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  await act(async () => { window.dispatchEvent(new MessageEvent("message", { source: window, data: { method: "ui/notifications/initialized" } })); });
  expect(f.element.textContent).not.toContain("Expand application");
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow!, data: { method: "ui/notifications/initialized" } }));
    window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow!, data: { method: "ui/notifications/size-changed", params: { height: 9000 } } }));
  });
  expect(f.element.textContent).toContain("Expand application");
  expect((f.element.querySelector(".mcp-app-card__surface") as HTMLElement).style.height).toBe("1200px");
  await act(async () => f.root.render(<McpAppTimelineProvider controller={controller(operate)}><McpAppCard card={card} locale="zh-CN" t={t} /></McpAppTimelineProvider>));
  expect(f.element.querySelector("iframe")).toBe(frame);
  expect(operate.mock.calls.some(([request]) => request.operation === McpAppOperation.CONTEXT)).toBe(true);
});

it("reclaims a late open through its original connection when the visible node changes", async () => {
  const f = mount();
  let finish!: (value: ReturnType<typeof create<typeof McpAppServiceOperateResponseSchema>>) => void;
  const first = vi.fn(({ operation }: { operation: McpAppOperation }) => operation === McpAppOperation.OPEN
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(create(McpAppServiceOperateResponseSchema)));
  const second = vi.fn(async (_request: { operation: McpAppOperation; viewId?: string }) => create(McpAppServiceOperateResponseSchema, { viewId: "second", proxyUrl: "https://node.example.test/mcp-apps/proxy/second" }));
  await act(async () => f.root.render(<McpAppTimelineProvider controller={controller(first, "one")}><McpAppCard card={card} locale="en" t={t} /></McpAppTimelineProvider>));
  await act(async () => f.root.render(<McpAppTimelineProvider controller={controller(second, "two")}><McpAppCard card={card} locale="en" t={t} /></McpAppTimelineProvider>));
  await act(async () => finish(create(McpAppServiceOperateResponseSchema, { viewId: "first", proxyUrl: "https://old.example.test/mcp-apps/proxy/first" })));
  expect(first.mock.calls.some(([request]) => request.operation === McpAppOperation.TEARDOWN && (request as { viewId?: string }).viewId === "first")).toBe(true);
  expect(second.mock.calls.some(([request]) => (request as { viewId?: string })?.viewId === "first")).toBe(false);
  expect(f.element.querySelector("iframe")?.getAttribute("src")).toContain("/second");
});
