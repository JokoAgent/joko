import { describe, expect, it } from "vitest";
import {
  isAllowedDesktopMicrophoneRequest,
  mapDesktopMicrophonePermissionStatus,
  microphoneMainFrameFromPermissionDetails,
  microphoneMediaTypesFromPermissionDetails
} from "../src/microphone-permission.js";

describe("desktop microphone permission fence", () => {
  it("allows only trusted main-frame audio-only capture", () => {
    const request = {
      permission: "media",
      trustedOwner: true,
      mainFrame: true,
      trustedFrameUrl: "joko://app/index.html",
      requestingUrl: "joko://app/index.html",
      mediaTypes: ["audio"]
    } as const;
    expect(isAllowedDesktopMicrophoneRequest(request)).toBe(true);
    expect(isAllowedDesktopMicrophoneRequest({ ...request, mediaTypes: ["video"] })).toBe(false);
    expect(isAllowedDesktopMicrophoneRequest({ ...request, mediaTypes: ["audio", "video"] })).toBe(false);
    expect(isAllowedDesktopMicrophoneRequest({ ...request, mainFrame: false })).toBe(false);
    expect(isAllowedDesktopMicrophoneRequest({ ...request, trustedOwner: false })).toBe(false);
    expect(isAllowedDesktopMicrophoneRequest({ ...request, requestingUrl: "https://untrusted.example/" })).toBe(false);
  });

  it("extracts Electron check and request media details without widening malformed data", () => {
    expect(microphoneMediaTypesFromPermissionDetails({ mediaType: "audio" })).toEqual(["audio"]);
    expect(microphoneMediaTypesFromPermissionDetails({ mediaTypes: ["audio", 4, null] })).toEqual(["audio"]);
    expect(microphoneMediaTypesFromPermissionDetails({ mediaTypes: "audio" })).toEqual([]);
    expect(microphoneMainFrameFromPermissionDetails({ isMainFrame: true })).toBe(true);
    expect(microphoneMainFrameFromPermissionDetails({ isMainFrame: "true" })).toBe(false);
  });

  it("projects bounded operating-system permission states", () => {
    expect(mapDesktopMicrophonePermissionStatus("granted")).toBe("granted");
    expect(mapDesktopMicrophonePermissionStatus("restricted")).toBe("denied");
    expect(mapDesktopMicrophonePermissionStatus("not-determined")).toBe("prompt");
    expect(mapDesktopMicrophonePermissionStatus("future-value")).toBe("unknown");
  });
});
