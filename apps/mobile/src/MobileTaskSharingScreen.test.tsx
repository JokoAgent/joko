// @vitest-environment jsdom
import { act, createElement, type ChangeEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, expect, it, vi } from "vitest";
import { buildTaskShareInvitation, JoinTaskShareResponseSchema, ListTaskSharesResponseSchema, PreviewTaskShareInvitationResponseSchema,
  TaskShareSchema, type PreviewTaskShareInvitationResponse, type TaskSharingApi } from "@joko/contracts";
import type { MobileClient, MobileState } from "./mobile-client";
import { MobileTaskSharingScreen } from "./MobileTaskSharingScreen";
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("react-native", () => ({
  ScrollView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
  View: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
  Text: ({ children }: { children?: ReactNode }) => createElement("span", {}, children),
  TextInput: ({ accessibilityLabel, value, editable, onChangeText }: {
    accessibilityLabel: string; value: string; editable: boolean; onChangeText(value: string): void;
  }) => createElement("input", { "aria-label": accessibilityLabel, value, readOnly: !editable,
    onChange: (event: ChangeEvent<HTMLInputElement>) => onChangeText(event.currentTarget.value) }),
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

it("adopts a newer native invitation without displaying or joining the earlier preview", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const shareFor = (letter: "a" | "b") => create(TaskShareSchema, {
    shareId: `share-${letter}`, sessionId: `task-${letter}`, shareGeneration: 1n, title: `Shared task ${letter.toUpperCase()}`,
    hostServerId: `host-${letter}`, hostOrigin: `https://${letter}.example.test`
  });
  const invitationFor = (letter: "a" | "b") => {
    const { shareId, shareGeneration, hostServerId, hostOrigin } = shareFor(letter);
    return buildTaskShareInvitation({ shareId, shareGeneration, hostServerId, hostOrigin,
      endpointPublicKey: `ed25519:${letter.repeat(64)}`, inviteSecret: letter.repeat(48) });
  };
  const a = invitationFor("a"), b = invitationFor("b");
  const reads = new Map<string, { signal: AbortSignal; finish(value: PreviewTaskShareInvitationResponse): void }>();
  const api = {
    list: vi.fn(async () => create(ListTaskSharesResponseSchema)),
    preview: vi.fn((invitation: string, signal: AbortSignal) => new Promise<PreviewTaskShareInvitationResponse>(finish => {
      reads.set(invitation, { signal, finish });
    })),
    join: vi.fn(async (operationId: string) => create(JoinTaskShareResponseSchema, {
      intent: { operationId, status: "joined", joined: { joinId: "joined-b", share: shareFor("b") } }
    }))
  };
  const openJoinedTask = vi.fn(async () => undefined), onOpenTask = vi.fn(), onInvitationConsumed = vi.fn();
  const client = { taskSharingApi: () => api, taskSharingOwnerKey: () => "owner", newTaskSharingActionId: () => "join-b", openJoinedTask } as unknown as MobileClient;
  const storage = { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined) };
  const host = document.body.appendChild(document.createElement("div")), root = createRoot(host);
  cleanups.push(() => { act(() => root.unmount()); host.remove(); });
  const render = (incoming?: string) => root.render(<MobileTaskSharingScreen client={client} state={{} as MobileState}
    colors={{ background: "#fff", ink: "#111", muted: "#777", border: "#ddd", accent: "#f90" } as never}
    locale="en" foreground storage={storage} invitation={incoming} onInvitationConsumed={onInvitationConsumed} onBack={() => {}} onOpenTask={onOpenTask} />);
  const button = (label: string) => Array.from(host.querySelectorAll("button")).find(item => item.textContent === label);
  const click = async (label: string) => {
    const target = button(label);
    expect(target?.disabled).toBe(false);
    await act(async () => target!.click());
  };
  await act(async () => render(a));
  await act(async () => render());
  const name = host.querySelector<HTMLInputElement>('input[aria-label="Your display name"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Participant");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Preview invitation");
  expect(reads.get(a)?.signal.aborted).toBe(false);

  await act(async () => render(b));
  await act(async () => render());
  expect(onInvitationConsumed.mock.calls).toEqual([[a], [b]]);
  expect(reads.get(a)?.signal.aborted).toBe(true);
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Invitation link"]')?.value).toBe(b);
  await click("Preview invitation");
  await act(async () => reads.get(a)!.finish(create(PreviewTaskShareInvitationResponseSchema, { share: shareFor("a") })));
  expect(host.textContent).not.toContain("Shared task A");
  expect(button("Join task")).toBeUndefined();
  expect(button("Preview invitation")?.disabled).toBe(true);
  expect(api.join).not.toHaveBeenCalled();

  await act(async () => reads.get(b)!.finish(create(PreviewTaskShareInvitationResponseSchema, { share: shareFor("b") })));
  expect(host.textContent).toContain("Shared task B · https://b.example.test");
  await click("Join task");
  expect(api.join).toHaveBeenCalledExactlyOnceWith("join-b", b, "Participant", expect.any(AbortSignal));
  expect(openJoinedTask).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ joinId: "joined-b", share: shareFor("b") }));
  expect(onOpenTask).toHaveBeenCalledOnce();
});
