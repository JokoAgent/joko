import { expect, it } from "vitest";
import { OperationalStore, RevisionConflictError } from "@joko/store";
import { HostedAgentSettings, HOSTED_AGENT_SETTING_KEY } from "./hosted-agent-settings.js";
import { HostedAgentSessionSlots } from "./hosted-agent-limits.js";

it("requires ordered opt-in, preserves Provider permission during a computer pause, and fences old captures after re-enabling", () => {
  const store = new OperationalStore(":memory:");
  try {
    const settings = new HostedAgentSettings(store); let snapshot = settings.snapshot();
    expect(settings.providerEnabled("native", "provider")).toBe(false);
    expect(() => settings.update({ kind: "provider", backendId: "native", providerId: "provider", enabled: true }, snapshot.revision)).toThrow("first");
    snapshot = settings.update({ kind: "remote_control", enabled: true }, snapshot.revision);
    snapshot = settings.update({ kind: "provider", backendId: "native", providerId: "provider", enabled: true }, snapshot.revision);
    const computer = settings.captureComputer(), provider = settings.captureProvider("native", "provider");
    snapshot = settings.update({ kind: "remote_control", enabled: false }, snapshot.revision);
    expect(settings.providerEnabled("native", "provider")).toBe(false); expect(snapshot.value.providers[0]?.enabled).toBe(true);
    snapshot = settings.update({ kind: "remote_control", enabled: true }, snapshot.revision);
    expect(settings.providerEnabled("native", "provider")).toBe(true); expect(() => computer()).toThrow("changed"); expect(() => provider()).not.toThrow();
    snapshot = settings.update({ kind: "provider", backendId: "native", providerId: "provider", enabled: false }, snapshot.revision);
    settings.update({ kind: "provider", backendId: "native", providerId: "provider", enabled: true }, snapshot.revision);
    expect(() => provider()).toThrow("changed");
    expect(() => settings.update({ kind: "reset_limits" }, 0n)).toThrow(RevisionConflictError);
  } finally { store.close(); }
});
it("applies lower limits to new admissions while retaining active native owners, and resets only the explicit quota override", () => {
  const store = new OperationalStore(":memory:");
  try {
    const settings = new HostedAgentSettings(store), slots = new HostedAgentSessionSlots(() => settings.limits());
    let snapshot = settings.update({ kind: "remote_control", enabled: true }, 0n);
    snapshot = settings.update({ kind: "provider", backendId: "native", providerId: "provider", enabled: true }, snapshot.revision);
    const computer = settings.captureComputer(), provider = settings.captureProvider("native", "provider"), first = slots.reserve("source"), second = slots.reserve("source");
    snapshot = settings.update({ kind: "limits", value: { perDevice: 1, total: 1 } }, snapshot.revision);
    expect(slots.summary()).toEqual({ total: 2, devices: 1, maximumDevice: 2 }); expect(() => slots.reserve("source")).toThrow("limit");
    expect(() => computer()).not.toThrow(); expect(() => provider()).not.toThrow();
    for (const value of [{ perDevice: 0, total: 64 }, { perDevice: 65, total: 64 }, { perDevice: 16, total: 1001 }, { perDevice: 1.5, total: 64 }]) {
      expect(() => settings.update({ kind: "limits", value }, snapshot.revision)).toThrow("integers");
    }
    const reset = settings.update({ kind: "reset_limits" }, snapshot.revision);
    expect(reset.value.limits).toBeUndefined(); expect(settings.limits()).toEqual({ perDevice: 16, total: 64 });
    expect(reset.value.providers).toEqual(snapshot.value.providers); expect(reset.value.generation).toBe(snapshot.value.generation);
    first.release(); second.release(); expect(slots.summary()).toEqual({ total: 0, devices: 0, maximumDevice: 0 });
  } finally { store.close(); }
});
it("rejects incompatible persisted remote settings without interpreting partial or legacy fields", () => {
  const store = new OperationalStore(":memory:");
  try {
    store.setSetting("service", "orchestrator", HOSTED_AGENT_SETTING_KEY, { format: 1, remoteControlEnabled: true, generation: 1, providers: [], oldLimits: { perDevice: 16, total: 64 } });
    expect(() => new HostedAgentSettings(store)).toThrow("current v1");
  } finally { store.close(); }
});
