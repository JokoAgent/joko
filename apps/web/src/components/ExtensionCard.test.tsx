// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { ExtensionCardSchema, ExtensionCardServiceGetResponseSchema, ExtensionAuthorizationPhase, extensionCardFormDeliveryScope, pendingExtensionCardFormDelivery } from "@joko/contracts";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import type { ExtensionCardApi } from "../model.js";
import { translate } from "../i18n.js";
import { ExtensionCard, ExtensionCardTimelineProvider } from "./ExtensionCard.js";
import { ExtensionMailLinkContext } from "./ExtensionMailReader.js";

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false }))); });
const roots: Array<{ root: Root; element: HTMLElement }> = [];
afterEach(async () => { for (const { root, element } of roots.splice(0)) { await act(async () => root.unmount()); element.remove(); } vi.useRealTimers(); });
const t = (key: Parameters<typeof translate>[1]) => translate("en", key);
const escape = (value: unknown) => JSON.stringify(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
const html = (subject = "Draft") => `<div data-joko-form="${escape([{ name: "subject", label: "Subject", value: subject }])}" data-joko-change="save"></div><button data-joko-action="send">Send</button>`;
const card = (subject = "Draft") => create(ExtensionCardSchema, { cardId: "extension-card:one", sessionId: "task", extensionName: "Mail", html: html(subject), height: 160 });
function mount() { const element = document.body.appendChild(document.createElement("div")), root = createRoot(element); roots.push({ root, element }); return { root, element }; }
function controller(api: ExtensionCardApi, server = "one", guest = false): AppController {
  return { state: { connectionState: "connected", connectionGeneration: 1, navigationRevision: 1, route: { kind: "session", sessionId: "task" },
    activeProfile: { id: "owner", serverId: server, origin: `https://${server}.example.test` }, ...(guest ? { sessionAccess: { role: "guest" } } : {}) }, extensionCardApi: () => api,
    openHttpLink: vi.fn(async () => {}) } as unknown as AppController;
}
function apiFixture() {
  const owner = {}, formScope = () => extensionCardFormDeliveryScope(owner, "task");
  return { formScope, get: vi.fn(async () => create(ExtensionCardServiceGetResponseSchema, { card: card(), interactive: true })),
    dispatch: vi.fn(async () => ({ accepted: true })), authorizeLink: vi.fn(async () => ({ authorized: true })) } as unknown as ExtensionCardApi & { get: ReturnType<typeof vi.fn>; dispatch: ReturnType<typeof vi.fn> };
}
it("keeps host account authorization in Desktop controls and exposes an explicit cancel while authorizing", async () => {
  const f = mount(), api = apiFixture(), hostCard = create(ExtensionCardSchema, { cardId: "host-authorization", sessionId: "task", extensionName: "Mail", html: '<p>Connect account</p><button data-joko-action="host:connect-account">Connect account</button>' });
  api.get.mockResolvedValue(create(ExtensionCardServiceGetResponseSchema, { card: hostCard, interactive: true, hostAuthorization: true, authorizationPhase: ExtensionAuthorizationPhase.PREPARING, authorizationClientConfigured: true }));
  await act(async () => f.root.render(<ExtensionCardTimelineProvider controller={controller(api)}><ExtensionCard card={hostCard} t={t} /></ExtensionCardTimelineProvider>));
  expect(f.element.textContent).toContain("Desktop");
  Object.assign(api, { canAuthorizeAccount: true });
  let signal!: AbortSignal;
  api.dispatch.mockImplementation(async (_request: unknown, options: { signal: AbortSignal }) => {
    signal = options.signal; return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }));
  });
  await act(async () => f.root.render(<ExtensionCardTimelineProvider controller={controller(api, "desktop")}><ExtensionCard card={hostCard} t={t} /></ExtensionCardTimelineProvider>));
  expect(f.element.querySelector("iframe")).toBeNull();
  await act(async () => [...f.element.querySelectorAll("button")].find(button => button.textContent === "Connect account")!.click());
  const cancel = [...f.element.querySelectorAll("button")].find(button => button.textContent === "Cancel"); expect(cancel).toBeDefined();
  await act(async () => cancel!.click()); expect(signal.aborted).toBe(true);
});
it("retains its original API while the same owner's mail-link callback or parent state changes", async () => {
  const f = mount(), api = apiFixture(), view = controller(api), bind = vi.fn(() => ({ ...api })); Object.assign(view, { extensionCardApi: bind });
  const render = () => <ExtensionMailLinkContext.Provider value={async () => false}><ExtensionCardTimelineProvider controller={view}><ExtensionCard card={card()} t={t} /></ExtensionCardTimelineProvider></ExtensionMailLinkContext.Provider>;
  await act(async () => f.root.render(render())); await act(async () => f.root.render(render()));
  expect(bind).toHaveBeenCalledOnce();
});
function edit(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("retains edits across autosave echoes and barriers survive Strict Mode effect replay", async () => {
  const f = mount(), api = apiFixture(), view = controller(api);
  const render = (value = card()) => <StrictMode><ExtensionCardTimelineProvider controller={view}><ExtensionCard card={value} t={t} /></ExtensionCardTimelineProvider></StrictMode>;
  await act(async () => f.root.render(render()));
  const input = f.element.querySelector<HTMLInputElement>('input[aria-label="Subject"]')!; expect(input.disabled).toBe(false);
  await act(async () => edit(input, "Local edit"));
  expect(api.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ formValues: [{ name: "subject", value: "Local edit" }], change: true }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect((await pendingExtensionCardFormDelivery(api.formScope("task"))) ?? true).toBe(true);
  api.get.mockResolvedValue(create(ExtensionCardServiceGetResponseSchema, { card: card("Saved elsewhere"), interactive: true }));
  await act(async () => f.root.render(render(card("Saved elsewhere"))));
  expect(f.element.querySelector<HTMLInputElement>('input[aria-label="Subject"]')?.value).toBe("Local edit");
  const frame = f.element.querySelector("iframe")!; expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
  expect(frame.getAttribute("srcdoc")).toContain("script-src 'none'");
});

it("keeps failed form changes pending until a successful retry and releases them on owner retirement", async () => {
  const f = mount(), api = apiFixture(); api.dispatch.mockResolvedValue({ accepted: false });
  await act(async () => f.root.render(<ExtensionCardTimelineProvider controller={controller(api)}><ExtensionCard card={card()} t={t} /></ExtensionCardTimelineProvider>));
  await act(async () => edit(f.element.querySelector("input")!, "Unsaved"));
  expect(await pendingExtensionCardFormDelivery(api.formScope("task"))).toBe(false); expect(f.element.querySelector('[role="alert"]')).not.toBeNull();
  api.dispatch.mockResolvedValue({ accepted: true });
  await act(async () => [...f.element.querySelectorAll("button")].find(button => button.textContent === "Retry")!.click());
  expect((await pendingExtensionCardFormDelivery(api.formScope("task"))) ?? true).toBe(true);
  api.dispatch.mockResolvedValue({ accepted: false }); await act(async () => edit(f.element.querySelector("input")!, "Another edit"));
  await act(async () => f.root.render(<ExtensionCardTimelineProvider controller={controller(api, "second")}><ExtensionCard card={card()} t={t} /></ExtensionCardTimelineProvider>));
  expect((await pendingExtensionCardFormDelivery(api.formScope("task"))) ?? true).toBe(true);
});

it("ignores a late snapshot from the old connection and leaves shared history read-only", async () => {
  const f = mount(), first = apiFixture(), second = apiFixture(); let finish!: (value: unknown) => void;
  first.get.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => f.root.render(<ExtensionCardTimelineProvider controller={controller(first)}><ExtensionCard card={card()} t={t} /></ExtensionCardTimelineProvider>));
  second.get.mockResolvedValue(create(ExtensionCardServiceGetResponseSchema, { card: card("Current owner"), interactive: true }));
  await act(async () => f.root.render(<ExtensionCardTimelineProvider controller={controller(second, "second")}><ExtensionCard card={card()} t={t} /></ExtensionCardTimelineProvider>));
  await act(async () => finish(create(ExtensionCardServiceGetResponseSchema, { card: card("Old owner"), interactive: true })));
  expect(f.element.querySelector<HTMLInputElement>("input")?.value).toBe("Current owner");
  const shared = apiFixture();
  await act(async () => f.root.render(<ExtensionCardTimelineProvider controller={controller(shared, "second", true)}><ExtensionCard card={card()} t={t} /></ExtensionCardTimelineProvider>));
  expect(shared.get).not.toHaveBeenCalled(); expect(shared.dispatch).not.toHaveBeenCalled(); expect(f.element.querySelector("input")).toBeNull(); expect(f.element.textContent).toContain("read-only");
});

it("refreshes a visible working card until the service reports its finite working window ended", async () => {
  const f = mount(), api = apiFixture(); vi.useFakeTimers();
  api.get.mockResolvedValueOnce(create(ExtensionCardServiceGetResponseSchema, { card: card(), interactive: true, working: true }))
    .mockResolvedValue(create(ExtensionCardServiceGetResponseSchema, { card: card(), interactive: true, working: false }));
  await act(async () => f.root.render(<ExtensionCardTimelineProvider controller={controller(api)}><ExtensionCard card={card()} t={t} /></ExtensionCardTimelineProvider>));
  expect(f.element.querySelector("article")?.getAttribute("aria-busy")).toBe("true");
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(f.element.querySelector("article")?.getAttribute("aria-busy")).toBe("false");
  const settled = api.get.mock.calls.length; await act(async () => { await vi.advanceTimersByTimeAsync(6000); }); expect(api.get).toHaveBeenCalledTimes(settled);
});

function mailCard() {
  const fields = [...["to", "cc", "bcc", "subject", "body"].map(name => ({ name, label: name, value: name === "subject" ? "Draft" : "" })),
    { name: "attachmentItems", label: "Files", value: "[]", kind: "mail-attachments" }];
  const mail = { accountId: "account", draftId: "draft", key: "11111111-1111-4111-8111-111111111111", from: "owner@example.test", fields, attachments: [], state: "draft", status: "Saved", sendLabel: "Send", fromLabel: "From" };
  return create(ExtensionCardSchema, { ...card(), html: `<div data-joko-mail="${escape(mail)}"></div><div data-joko-form="${escape(fields)}" data-joko-change="save"></div>` });
}
async function pick(element: HTMLElement) {
  const input = element.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["private bytes"], "notes.txt", { type: "text/plain" })] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}
it("holds failed attachment delivery across snapshots until retry or explicit cancellation", async () => {
  const f = mount(), api = apiFixture(), upload = vi.fn<ExtensionCardApi["uploadAttachment"]>(async () => { throw new Error("Unavailable"); });
  Object.assign(api, { uploadAttachment: upload }); api.get.mockResolvedValue(create(ExtensionCardServiceGetResponseSchema, { card: mailCard(), interactive: true }));
  const render = () => <ExtensionCardTimelineProvider controller={controller(api)}><ExtensionCard card={mailCard()} t={t} /></ExtensionCardTimelineProvider>;
  await act(async () => f.root.render(render())); await pick(f.element);
  expect(await pendingExtensionCardFormDelivery(api.formScope("task"))).toBe(false);
  await act(async () => f.root.render(render())); expect(f.element.querySelector('[role="alert"]')).not.toBeNull();
  upload.mockImplementation(async () => "receipt");
  await act(async () => [...f.element.querySelectorAll("button")].find(button => button.textContent === "Retry")!.click());
  expect(api.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ uploadId: "receipt", actionId: "mail:attach:11111111-1111-4111-8111-111111111111" }), expect.anything());
  expect(pendingExtensionCardFormDelivery(api.formScope("task"))).toBeUndefined();
  upload.mockImplementation(async () => { throw new Error("Unavailable"); }); await pick(f.element);
  await act(async () => [...f.element.querySelectorAll("button")].find(button => button.textContent === "Cancel")!.click());
  expect(pendingExtensionCardFormDelivery(api.formScope("task"))).toBeUndefined();
});
it("retires the original attachment selection before a new connection can dispatch it", async () => {
  const f = mount(), first = apiFixture(), second = apiFixture(); let finish!: (value: string) => void; let signal!: AbortSignal;
  Object.assign(first, { uploadAttachment: vi.fn((_task, _card, _file, _inline, abort: AbortSignal) => { signal = abort; return new Promise<string>(resolve => { finish = resolve; }); }) });
  for (const api of [first, second]) api.get.mockResolvedValue(create(ExtensionCardServiceGetResponseSchema, { card: mailCard(), interactive: true }));
  await act(async () => f.root.render(<ExtensionCardTimelineProvider controller={controller(first)}><ExtensionCard card={mailCard()} t={t} /></ExtensionCardTimelineProvider>));
  await pick(f.element); expect(signal.aborted).toBe(false);
  await act(async () => f.root.render(<ExtensionCardTimelineProvider controller={controller(second, "second")}><ExtensionCard card={mailCard()} t={t} /></ExtensionCardTimelineProvider>));
  expect(signal.aborted).toBe(true); await act(async () => finish("late-receipt"));
  expect(first.dispatch).not.toHaveBeenCalled(); expect(second.dispatch).not.toHaveBeenCalled(); expect(pendingExtensionCardFormDelivery(first.formScope("task"))).toBeUndefined();
});
