import { describe, expect, it } from "vitest";

import { ORCHESTRATOR_WEB_CONTENT_SECURITY_POLICY } from "./server.js";

describe("Orchestrator Web content security policy", () => {
  it("permits the bundled fonts, authenticated media URLs, and self-hosted diagram runtime", () => {
    expect(ORCHESTRATOR_WEB_CONTENT_SECURITY_POLICY).toContain("font-src 'self' data:");
    expect(ORCHESTRATOR_WEB_CONTENT_SECURITY_POLICY).toContain("media-src 'self' blob: data:");
    expect(ORCHESTRATOR_WEB_CONTENT_SECURITY_POLICY).toContain("connect-src 'self' blob:");
    expect(ORCHESTRATOR_WEB_CONTENT_SECURITY_POLICY).toContain("script-src 'self' 'unsafe-eval'");
    expect(ORCHESTRATOR_WEB_CONTENT_SECURITY_POLICY).toContain("frame-src 'none'");
  });
});
