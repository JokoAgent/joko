import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(resolve(root, "App.tsx"), "utf8");
const sheet = readFileSync(resolve(root, "MobileActionSheet.tsx"), "utf8");
const actions = readFileSync(resolve(root, "task-actions.ts"), "utf8");

describe("native mobile copy-link boundary", () => {
  it("routes task and completed-message actions only through the canonical public builders and system text clipboard", () => {
    expect(app).toContain("if (!await Clipboard.setStringAsync(value))");
    expect(app).toContain("buildMobileTaskDeepLink(authority.sessionId)");
    expect(app).toContain("buildMobileMessageDeepLink(authority.sessionId, authority.messageId, authority.messageEventId)");
    expect(app).toContain("claimMobileCopyLinkAuthority(projectMobileNativeIntentSnapshot(client.state)");
    expect(app).toContain("mobileCopyLinkAuthorityMatches(authority, projectMobileNativeIntentSnapshot(client.state))");
    expect(app).toContain('type SessionOption = "rename" | "copy-link" | "pin" | "archive" | "delete";');
    expect(actions).toContain('id: "copy-link"');
  });

  it("keeps offline copy reachable while mutation actions remain connected-only", () => {
    expect(app).toContain('state.status !== "connected" && state.status !== "offline"');
    expect(app).toContain('state.status === "connected" || item.id === "copy-link"');
    expect(app).toContain('disabled={state.status !== "connected"}');
    expect(sheet).toContain("accessibilityState={{ disabled: item.disabled === true }}");
    expect(sheet).toContain("disabled={item.disabled}");
  });

  it("does not introduce a network, service mutation, or device-local profile into copied links", () => {
    expect(app).not.toMatch(/copyPublicTaskLink[\s\S]{0,1400}(?:mobileNetwork|fetch\(|client\.(?:send|rename|delete|set))/u);
    const nativeIntent = readFileSync(resolve(root, "mobile-native-intent.ts"), "utf8");
    const builder = nativeIntent.slice(nativeIntent.indexOf("function buildMobileSessionDeepLink"));
    expect(builder).not.toContain("profile=");
    expect(builder).not.toContain("https://");
  });
});
