// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InputHandoffSnapshot, InputHandoffSubmission } from "@joko/contracts";
import type { InputHandoffApi } from "../input-handoff.js";
import { InputHandoffCard, InputHandoffPanel } from "./InputHandoffCard.js";
const roots: Root[] = [];
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.replaceChildren(); Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); });
const snapshot = (patch: Partial<InputHandoffSnapshot> = {}): InputHandoffSnapshot => ({ kind: "input_handoff", requestId: "request-1", revision: 1, phase: "ready", purpose: "登录后继续设置", source: { app: "Browser", origin: "https://login.example.test" }, stepNumber: 1,
  controls: [{ id: "email", kind: "text", label: "账号", contentType: "email" }, { id: "password", kind: "text", label: "密码", contentType: "password" }], ...patch });
function api(states: readonly InputHandoffSnapshot[] = [snapshot()]) {
  const sent: InputHandoffSubmission[] = [];
  const value: InputHandoffApi = { listInputHandoffs: vi.fn(async () => states), decideInputHandoff: vi.fn(async () => true),
    submitInputHandoff: vi.fn(async (_snapshot, submission) => { sent.push(structuredClone(submission)); return true; }), readInputHandoffPicture: vi.fn(async () => null) };
  return { value, sent };
}
async function mount(value: ReactNode) { const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); roots.push(root); await act(async () => root.render(value)); return { root, container }; }
function button(label: string): HTMLButtonElement { const value = [...document.querySelectorAll("button")].find(item => item.textContent === label); if (!value) throw new Error("Missing button " + label); return value; }
async function enter(input: HTMLInputElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); }
it("uses normal password autofill fields, keeps autocomplete when revealed and clears values after private submission", async () => {
  const f = api(); await mount(<InputHandoffCard api={f.value} snapshot={snapshot()} viewer={{ deviceId: "owner" }} />);
  expect(f.value.readInputHandoffPicture).not.toHaveBeenCalled(); await act(async () => button("在此设备填写").click());
  const email = document.querySelector<HTMLInputElement>('input[name="input-handoff-email"]')!, password = document.querySelector<HTMLInputElement>('input[name="input-handoff-password"]')!;
  expect(email.autocomplete).toBe("email"); expect(password.type).toBe("password"); expect(password.autocomplete).toBe("current-password");
  await enter(email, "owner@example.test"); await enter(password, "synthetic-secret");
  await act(async () => button("显示密码").click()); expect(password.type).toBe("text"); expect(password.autocomplete).toBe("current-password");
  await act(async () => password.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(f.sent).toEqual([{ expectedRevision: 1, values: { email: "owner@example.test", password: "synthetic-secret" }, action: { kind: "submit" } }]);
  expect(password.value).toBe(""); expect(email.value).toBe(""); expect(password.type).toBe("password"); expect(document.body.textContent).not.toContain("synthetic-secret");
});
it("resets the draft on a changed step and restores keyboard focus when the modal closes", async () => {
  const f = api(), mounted = await mount(<InputHandoffCard api={f.value} snapshot={snapshot()} viewer={{ local: true }} />);
  const opener = button("在此设备填写"); opener.focus(); await act(async () => opener.click());
  await enter(document.querySelector<HTMLInputElement>('input[type="password"]')!, "old-step-value");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(opener);
  await act(async () => opener.click()); expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  await act(async () => mounted.root.render(<InputHandoffCard api={f.value} snapshot={snapshot({ revision: 2, stepNumber: 2 })} viewer={{ local: true }} />));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it("destroys open drafts when the original owner connection changes", async () => {
  const f = api(), props = { api: f.value, sessionId: "session", viewer: { deviceId: "owner" } };
  const mounted = await mount(<InputHandoffPanel {...props} ownerKey="connection-a" />);
  await act(async () => button("在此设备填写").click()); await enter(document.querySelector<HTMLInputElement>('input[type="password"]')!, "old-owner-value");
  await act(async () => mounted.root.render(<InputHandoffPanel {...props} ownerKey="connection-b" />));
  expect(document.querySelector('[role="dialog"]')).toBeNull(); await act(async () => button("在此设备填写").click()); expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
});
it("loads a QR picture only on explicit owner open and leaves its real app URL usable", async () => {
  const f = api(); f.value.readInputHandoffPicture = vi.fn(async () => ({ mime: "image/jpeg" as const, data: "AQ==", width: 80, height: 80, qr: { text: "https://login.example.test/qr", url: "https://login.example.test/qr" } }));
  await mount(<InputHandoffCard api={f.value} snapshot={snapshot({ controls: [], qr: "scan", picture: true })} viewer={{ deviceId: "owner" }} />);
  expect(f.value.readInputHandoffPicture).not.toHaveBeenCalled(); await act(async () => button("查看登录二维码").click());
  expect(f.value.readInputHandoffPicture).toHaveBeenCalledOnce(); expect(document.querySelector<HTMLAnchorElement>('a[target="_blank"]')?.href).toBe("https://login.example.test/qr");
});
