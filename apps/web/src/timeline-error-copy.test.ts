import { describe, expect, it } from "vitest";

import { translate } from "./i18n.js";
import { timelineErrorCopy } from "./timeline-error-copy.js";

describe("timelineErrorCopy", () => {
  it("maps published failures to typed, localized title, message, and recovery copy", () => {
    const capacity = timelineErrorCopy("UPSTREAM_OVERLOAD");
    const authentication = timelineErrorCopy("BACKEND_AUTHENTICATION_REQUIRED");
    const usage = timelineErrorCopy("CODEX_RATE_LIMITED");
    const attachment = timelineErrorCopy("CODEX_IMAGE_TOO_LARGE");
    const state = timelineErrorCopy("PI_STALE_GENERATION");

    expect(capacity.kind).toBe("capacity");
    expect(translate("en", capacity.titleKey)).toBe("Model service is busy");
    expect(translate("zh-CN", capacity.messageKey)).toContain("没有可用容量");
    expect(translate("zh-CN", capacity.recoveryKey)).toContain("另一个可用模型");
    expect(authentication.kind).toBe("authentication");
    expect(usage.kind).toBe("usage");
    expect(attachment.kind).toBe("attachment");
    expect(state.kind).toBe("state");
  });

  it("uses safe generic copy for unknown and lookalike codes", () => {
    for (const code of ["GENERIC_FAILURE", "upstream_overload", ""]) {
      const copy = timelineErrorCopy(code);
      expect(copy.kind).toBe("unknown");
      expect(translate("en", copy.titleKey)).toBe("Something went wrong");
      expect(translate("en", copy.messageKey)).toBe("The task could not continue because of an unexpected problem.");
      expect(translate("en", copy.recoveryKey)).toBe("Try again once. If the problem continues, open diagnostics for details.");
    }
  });
});
