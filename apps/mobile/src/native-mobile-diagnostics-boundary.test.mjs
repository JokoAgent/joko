import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const project = new URL("../", import.meta.url);
const diagnostics = readFileSync(new URL("src/mobile-diagnostics.ts", project), "utf8");
const app = readFileSync(new URL("src/App.tsx", project), "utf8");
const settings = readFileSync(new URL("src/MobileSettingsScreen.tsx", project), "utf8");
const messages = readFileSync(new URL("src/mobile-messages.ts", project), "utf8");

describe("mobile local diagnostics native boundary", () => {
  it("records only explicit app lifecycle, connection-state, and bounded stall events", () => {
    expect(app).toContain('mobileDiagnostics.record("app.started"');
    expect(app).toContain('mobileDiagnostics.record("app.lifecycle"');
    expect(app).toContain('mobileDiagnostics.record("connection.state"');
    expect(app).toContain('mobileDiagnostics.record("js.stall"');
    expect(app).toContain("mobileDiagnostics.flush()");
    expect(app).toContain('AppState.addEventListener("change"');
    expect(diagnostics).toContain('case "connection.state"');
    expect(diagnostics).toContain('case "js.stall"');
    expect(diagnostics).toContain("exactKeys(fields");
    expect(diagnostics).not.toMatch(/fetch\(|WebSocket|XMLHttpRequest|upload/iu);
  });

  it("stages one verified JSON file in the Joko app cache and delegates only to the native share sheet", () => {
    expect(diagnostics).toContain('const EXPORT_ROOT = "joko-mobile-diagnostics"');
    expect(diagnostics).toContain('const EXPORT_FILE_NAME = "joko-mobile-diagnostics.json"');
    expect(diagnostics).toContain('new Directory(Paths.cache, EXPORT_ROOT)');
    expect(diagnostics).toContain("const written = await file.bytes()");
    expect(diagnostics).toContain("equalBytes(bytes, written)");
    expect(diagnostics).toContain('Sharing.shareAsync(file.uri, { mimeType: "application/json", UTI: "public.json" })');
    expect(diagnostics).toContain("if (root.exists) root.delete()");
  });

  it("exposes explicit opt-in, retention, clear, and export without a diagnostic upload action", () => {
    expect(messages).toContain("Off by default.");
    expect(messages).toContain("Message text, files, paths, IDs, credentials, raw errors, audio, and transcripts are never included.");
    expect(messages).toContain('"settings.diagnostics.clearTitle": "Clear local diagnostics?"');
    expect(messages).toContain('"settings.diagnostics.export": "Export diagnostics"');
    expect(settings).toContain('accessibilityLabel={t("settings.diagnostics.record")}');
    expect(settings).toContain('t("settings.diagnostics.privacy")');
    expect(settings).toContain('t("settings.diagnostics.clearTitle")');
    expect(settings).toContain('t("settings.diagnostics.export")');
    expect(settings).not.toMatch(/uploadDiagnostics|Upload diagnostics/iu);
    expect(messages).not.toMatch(/uploadDiagnostics|Upload diagnostics/iu);
  });
});
