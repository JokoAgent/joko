import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const project = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", project), "utf8"));
const root = readFileSync(new URL("src/App.tsx", project), "utf8");
const push = readFileSync(new URL("src/mobile-push-controller.ts", project), "utf8");
const voice = readFileSync(new URL("src/use-mobile-voice-input.ts", project), "utf8");

describe("native mobile OS lifecycle boundary", () => {
  it("routes raw AppState through one transport coordinator", () => {
    expect(root).toContain("new MobileAppLifecycleCoordinator(AppState.currentState)");
    expect(root).toContain("const transition = lifecycle.transition(status)");
    expect(root).toContain("client.setForeground(transition.transportForeground)");
    expect(root).toContain("mobilePush.handleAppStateChange(status)");
    expect(root).toContain("mobileUpdates.handleAppStateChange(status)");
    expect(root).toContain("if (transition.enteredBackground)");
    expect(root).toContain("if (!foreground || !batch || openedIncomingShareRef.current === batch.batchId");
  });

  it("uses the native network path signal only while active", () => {
    expect(pkg.dependencies["expo-network"]).toBe("~57.0.1");
    expect(root).toContain('import("expo-network")');
    expect(root).toContain('AppState.currentState !== "active"');
    expect(root).not.toContain("network.isConnected === false");
    expect(root).toContain("client.notifyNetworkChanged()");
  });

  it("keeps transient inactive permission UI distinct from real background retirement", () => {
    expect(push).toContain('if (state === "background")');
    expect(push).toContain('if (state !== "active") return');
    expect(voice).toContain('if (next !== "background") return');
    expect(voice).toContain("run?.shouldCancelForBackground");
  });
});
