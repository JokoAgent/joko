// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, expect, it, vi } from "vitest";
import type { TaskSharingApi } from "@joko/contracts";
import type { MobileClient, MobileState } from "./mobile-client";
import { MobileTaskSharingScreen } from "./MobileTaskSharingScreen";
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("react-native", () => ({
  ScrollView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
  View: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
  Text: ({ children }: { children?: ReactNode }) => createElement("span", {}, children),
  TextInput: () => null,
  Pressable: ({ children, disabled, onPress }: { children?: ReactNode; disabled?: boolean; onPress(): void }) =>
    createElement("button", { disabled, onClick: onPress }, children),
  Alert: { alert: (_title: string, _body: string, buttons: Array<{ onPress?: () => void }>) => buttons.at(-1)?.onPress?.() }
}));
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

it.each([Code.Unavailable, Code.FailedPrecondition])("recovers a rejected or never admitted action across remount (%s)", async code => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let stored: string | null = null;
  const storage = { getItem: async () => stored, setItem: async (_key: string, value: string) => { stored = value; } };
  const api = {
    list: vi.fn(async () => ({ owned: [], joined: [] })),
    create: vi.fn(async () => { throw new ConnectError("not accepted", code); }),
    lookupAction: vi.fn(async () => { throw new ConnectError("No such action", Code.NotFound); })
  } as unknown as TaskSharingApi;
  const client = { taskSharingApi: () => api, taskSharingOwnerKey: () => "owner", newTaskSharingActionId: () => "same-action" } as unknown as MobileClient;
  const host = document.createElement("div"); let root = createRoot(host);
  const render = () => root.render(<MobileTaskSharingScreen client={client}
    state={{ owner: { sessions: [{ sessionId: "task", displayName: "Task" }] } } as unknown as MobileState}
    colors={{ background: "#fff", ink: "#111", muted: "#777", border: "#ddd", accent: "#f90" } as never}
    locale="en" foreground storage={storage} initialSessionId="task" onInvitationConsumed={() => {}} onBack={() => {}} onOpenTask={() => {}} />);
  const click = async (label: string) => {
    const button = Array.from(host.querySelectorAll("button")).find(item => item.textContent === label);
    expect(button).toBeDefined(); await act(async () => button!.click());
  };
  cleanups.push(() => act(() => root.unmount()));
  await act(async () => render());
  await click("Share this task");
  expect(api.create).toHaveBeenCalledOnce();
  if (code === Code.FailedPrecondition) expect(JSON.parse(stored!)).toEqual([]);
  else {
    expect(JSON.parse(stored!)).toEqual([{ operationId: "same-action", kind: "create" }]);
    await act(async () => root.unmount()); root = createRoot(host); await act(async () => render());
    await click("Check action status");
    expect(api.lookupAction).toHaveBeenCalledWith("same-action", expect.anything());
    expect(JSON.parse(stored!)).toEqual([]);
    expect(host.textContent).toContain("did not accept");
  }
  expect(api.create).toHaveBeenCalledOnce();
});
