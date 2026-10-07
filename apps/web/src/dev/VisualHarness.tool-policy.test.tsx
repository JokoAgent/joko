// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolPolicySettingsView } from "../model.js";
import { VisualHarness } from "./VisualHarness.js";
import { VisualToolPolicyFixture, VISUAL_TOOL_POLICY_SETTLE_EVENT, PROVIDER_ID, TARGET_A_ID, TARGET_B_ID,
  type VisualToolPolicyAttempt, type VisualToolPolicyState } from "./VisualToolPolicyFixture.js";

let root: Root | undefined;
const fixtures: VisualToolPolicyFixture[] = [];
type ObservedState = VisualToolPolicyState & {
  readonly snapshotRevision: string;
  readonly settingsRevision: string;
  readonly snapshotPolicy: ToolPolicySettingsView;
  readonly activity: unknown;
};

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/__visual-harness__?scenario=tool-policy&theme=light&running=1&queue=1&interaction=0#/settings/general");
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn((media: string) => ({
    matches: false, media, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(() => true)
  })) });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  root = undefined;
  for (const fixture of fixtures.splice(0)) fixture.cancelPending();
  document.body.replaceChildren();
  window.localStorage.clear();
  window.sessionStorage.clear();
  delete document.documentElement.dataset.harnessToolPolicyState;
  delete document.documentElement.dataset.harnessLastAction;
  delete document.documentElement.dataset.visualHarness;
  delete document.documentElement.dataset.theme;
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  vi.restoreAllMocks();
});

describe("Tool policy visual harness", () => {
  it("publishes confirmed user/project inheritance through actual Tools and retires failed or stale changes", async () => {
    await Promise.all([import("../components/SessionPane.js"), import("../components/SettingsPage.js")]);
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => { root?.render(<VisualHarness />); await wait(100); });
    await act(async () => wait(40));
    const initial = state();
    expect(initial).toMatchObject({ phase: "ready", attempts: 0, confirmedAttempts: 0, failedAttempts: 0,
      snapshotPolicy: { userEffectiveEnabled: true, userEffectiveSource: "productDefault" } });
    expect(initial.activity).toMatchObject({ sessions: expect.arrayContaining([expect.objectContaining({ id: "session-1", state: "running", activeRunId: "visual-run" })]),
      queue: [{ id: "visual-queue", state: "accepted" }] });
    await click(navigation("Tools"));
    expect(window.location.hash).toBe("#/settings/tools");
    expect(document.querySelector(".tool-policy-list")?.textContent).not.toContain("No configurable");
    expect(document.querySelector(".tool-policy-controls")?.textContent).toContain("Changes apply to new tasks");
    await selectScope("User default");
    expectRow(true, "Product default", false);

    await click(toggle());
    const first = required(state().pending);
    expect(state()).toMatchObject({ phase: "pending", attempts: 1, pending: { toolProviderId: PROVIDER_ID, patch: { enabled: false } } });
    expect(first.targetId).toBeUndefined();
    expect(toggle().disabled).toBe(true);
    expectRow(true, "Product default", false);
    await click(toggle());
    expect(state().attempts).toBe(1);
    for (const invalid of [
      { ownerId: "retired-owner" }, { toolProviderId: "another-provider" }, { targetId: TARGET_B_ID },
      { patch: { enabled: true } }, { patch: { enabled: false, reset: true } }
    ]) {
      await dispatch({ ownerId: state().ownerId, ...first, ...invalid, outcome: "success" });
      expect(state().phase).toBe("pending");
    }
    await settle("failure");
    expect(document.body.textContent).toContain("The deterministic tool policy request failed. Retry the change.");
    expect(toggle().disabled).toBe(false);
    expect(state()).toMatchObject({ phase: "failed", attempts: 1, failedAttempts: 1, confirmedAttempts: 0 });
    expect(state().snapshotPolicy).toEqual(initial.snapshotPolicy);
    expect(state().snapshotRevision).toBe(initial.snapshotRevision);
    expect(state().settingsRevision).toBe(initial.settingsRevision);
    expectRow(true, "Product default", false);
    await act(async () => wait(40));
    expect(state().attempts).toBe(1);

    await click(toggle());
    const second = required(state().pending);
    await settle("success", first);
    expect(state().phase).toBe("pending");
    await settle("success");
    expectRow(false, "User default", true);
    expect(state().snapshotPolicy).toMatchObject({ userOverride: { enabled: false },
      userEffectiveEnabled: false, userEffectiveSource: "userDefault",
      targetSettings: [{ targetId: TARGET_A_ID, effectiveEnabled: false, effectiveSource: "userDefault" },
        { targetId: TARGET_B_ID, effectiveEnabled: false, effectiveSource: "userDefault" }] });
    const confirmedUser = state();
    await settle("success", second);
    expect(state()).toEqual(confirmedUser);

    await selectScope("Project A");
    expectRow(false, "User default", false);
    await click(toggle());
    expect(required(state().pending)).toMatchObject({ targetId: TARGET_A_ID, patch: { enabled: true } });
    await settle("success");
    expectRow(true, "Project override", true);
    const beforeScopeChange = state();
    await selectScope("Project B");
    expectRow(false, "User default", false);
    expect(state()).toEqual(beforeScopeChange);
    await selectScope("Project A");
    expectRow(true, "Project override", true);
    expect(state()).toEqual(beforeScopeChange);

    await click(reset());
    expect(required(state().pending)).toMatchObject({ targetId: TARGET_A_ID, patch: { reset: true } });
    expect(toggle().disabled).toBe(true);
    expect(reset().disabled).toBe(true);
    await settle("success");
    expectRow(false, "User default", false);
    expect(state().snapshotPolicy.targetSettings.find((target) => target.targetId === TARGET_A_ID)?.projectOverride).toBeUndefined();
    await selectScope("User default");
    await click(reset());
    expect(required(state().pending).targetId).toBeUndefined();
    await settle("success");
    expectRow(true, "Product default", false);
    const final = state();
    expect(final).toMatchObject({ attempts: 5, failedAttempts: 1, confirmedAttempts: 4 });
    expect(final.snapshotPolicy.userOverride).toBeUndefined();
    expect(final.snapshotPolicy.targetSettings).toEqual(initial.snapshotPolicy.targetSettings);
    expect(final.policy).toEqual(final.snapshotPolicy);
    expect(final.snapshotRevision).toBe((BigInt(initial.snapshotRevision) + 4n).toString());
    expect(final.settingsRevision).toBe((BigInt(initial.settingsRevision) + 4n).toString());
    expect(final.activity).toEqual(initial.activity);
    await click(navigation("General"));
    await click(navigation("Tools"));
    await selectScope("Project A");
    expectRow(true, "Product default", false);
    expect(state()).toEqual(final);
    await act(async () => root?.unmount());
    root = undefined;
    expect(document.documentElement.dataset.harnessToolPolicyState).toBeUndefined();
    await dispatch({ ownerId: final.ownerId, ...second, outcome: "success" });
    expect(document.documentElement.dataset.harnessToolPolicyState).toBeUndefined();

    // The same helper owns unmount cancellation, without a second UI fixture journey.
    const publish = vi.fn();
    const fixture = new VisualToolPolicyFixture(publish);
    fixtures.push(fixture);
    const pending = fixture.updateToolPolicySettings(PROVIDER_ID, TARGET_A_ID, { enabled: false });
    const retiredAttempt = required(fixture.state.pending);
    const retired = expect(pending).rejects.toThrow("owner retired");
    fixture.cancelPending();
    await retired;
    const retry = fixture.updateToolPolicySettings(PROVIDER_ID, TARGET_A_ID, { enabled: false });
    expect(fixture.settle({ ownerId: fixture.state.ownerId, ...retiredAttempt, outcome: "success" })).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    expect(fixture.settle({ ownerId: fixture.state.ownerId, ...required(fixture.state.pending), outcome: "success" })).toBe(true);
    await retry;
    expect(publish).toHaveBeenCalledTimes(1);
  }, 15_000);
});

function state(): ObservedState {
  return JSON.parse(required(document.documentElement.dataset.harnessToolPolicyState)) as ObservedState;
}
function navigation(label: string): HTMLButtonElement {
  return required([...document.querySelectorAll<HTMLButtonElement>(".settings-nav button")].find((value) => value.textContent?.trim() === label));
}
function toggle(): HTMLButtonElement {
  return required(document.querySelector<HTMLButtonElement>('.tool-policy-list button[role="switch"]'));
}
function reset(): HTMLButtonElement {
  return required([...document.querySelectorAll<HTMLButtonElement>(".tool-policy-list button")].find((value) => value.textContent?.trim() === "Reset"));
}
function expectRow(enabled: boolean, source: string, hasReset: boolean): void {
  expect(toggle().getAttribute("aria-checked")).toBe(String(enabled));
  expect(document.querySelector(".tool-policy-actions .pill")?.textContent).toBe(source);
  expect([...document.querySelectorAll(".tool-policy-list button")].some((value) => value.textContent?.trim() === "Reset")).toBe(hasReset);
}
async function selectScope(label: string): Promise<void> {
  await click(required(document.querySelector<HTMLButtonElement>('.tool-policy-controls button[role="combobox"]')));
  await click(required([...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((value) => value.textContent?.trim() === label)));
}
async function click(control: HTMLButtonElement): Promise<void> {
  await act(async () => { control.click(); await wait(35); });
}
async function settle(outcome: "failure" | "success", attempt: VisualToolPolicyAttempt = required(state().pending)): Promise<void> {
  await dispatch({ ownerId: state().ownerId, ...attempt, outcome });
}
async function dispatch(detail: unknown): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(VISUAL_TOOL_POLICY_SETTLE_EVENT, { detail }));
    await wait(35);
  });
}
function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Expected the tool policy fixture control to exist.");
  return value;
}
function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
