import { describe, expect, it, vi } from "vitest";
import { deferredShareValue, pngBlob, shareImageTestSurface } from "./share-image.test-support.js";
import {
  ShareMessageImageEncodingError,
  assertPngBlob,
  deliverShareMessageImage,
  shareMessageImageFilename
} from "./share-message-image.js";
import { redactShareMessageText } from "./share-redaction.js";

describe("share-message PNG integrity and delivery", () => {
  it("accepts only a real PNG signature", async () => {
    const { action } = shareImageTestSurface();
    await expect(assertPngBlob(pngBlob(), action)).resolves.toBeUndefined();
    await expect(assertPngBlob(new Blob(["not png"], { type: "image/png" }), action)).rejects.toBeInstanceOf(ShareMessageImageEncodingError);
    await expect(assertPngBlob(new Blob([await pngBlob().arrayBuffer()], { type: "image/jpeg" }), action)).rejects.toBeInstanceOf(ShareMessageImageEncodingError);
  });

  it.each(["aborted", "navigated"] as const)("does not dispatch after PNG validation becomes %s", async (reason) => {
    const surface = shareImageTestSurface();
    const bytes = deferredShareValue<ArrayBuffer>();
    const blob = pngBlob();
    vi.spyOn(blob, "slice").mockReturnValue({ arrayBuffer: () => bytes.promise } as Blob);
    const pending = deliverShareMessageImage(blob, "task.png", "Task", surface.action);
    const rejected = expect(pending).rejects.toThrow();
    if (reason === "aborted") surface.abort.abort();
    else surface.window.document = { createElement: vi.fn() };
    bytes.resolve(await pngBlob().arrayBuffer());
    await rejected;
    expect(surface.share).not.toHaveBeenCalled();
    expect(surface.click).not.toHaveBeenCalled();
  });

  it("uses the initiating share capability and downloads only when preflight declines", async () => {
    const surface = shareImageTestSurface();
    await expect(deliverShareMessageImage(pngBlob(), "task.png", "Task", surface.action)).resolves.toBe("shared");
    expect(surface.share).toHaveBeenCalledOnce();
    expect(surface.click).not.toHaveBeenCalled();
    surface.window.navigator.canShare.mockReturnValue(false);
    await expect(deliverShareMessageImage(pngBlob(), "task.png", "Task", surface.action)).resolves.toBe("dispatched");
    expect(surface.share).toHaveBeenCalledOnce();
    expect(surface.click).toHaveBeenCalledOnce();
    surface.window.dispatchEvent(new Event("pagehide"));
    expect(surface.window.URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:share-image");
  });

  it("preserves native cancellation, unknown failure and an already issued success without a second download", async () => {
    const surface = shareImageTestSurface();
    surface.share.mockRejectedValueOnce(new DOMException("cancelled", "AbortError"));
    await expect(deliverShareMessageImage(pngBlob(), "task.png", "Task", surface.action)).resolves.toBe("cancelled");
    surface.share.mockRejectedValueOnce(new Error("Native result unavailable"));
    await expect(deliverShareMessageImage(pngBlob(), "task.png", "Task", surface.action)).rejects.toThrow("Native result unavailable");
    const completion = deferredShareValue<void>();
    surface.share.mockImplementationOnce(() => { surface.abort.abort(); return completion.promise; });
    const issued = deliverShareMessageImage(pngBlob(), "task.png", "Task", surface.action);
    await vi.waitFor(() => expect(surface.share).toHaveBeenCalledTimes(3));
    completion.resolve();
    await expect(issued).resolves.toBe("shared");
    expect(surface.click).not.toHaveBeenCalled();
  });

  it.each(["file-missing", "share-missing", "can-share-missing", "can-share-throws", "activation-inactive", "activation-missing"] as const)("chooses browser delivery when file-share preflight is %s", async (capability) => {
    const surface = shareImageTestSurface();
    if (capability === "file-missing") Reflect.deleteProperty(surface.window, "File");
    else if (capability === "share-missing") Reflect.deleteProperty(surface.window.navigator, "share");
    else if (capability === "can-share-missing") Reflect.deleteProperty(surface.window.navigator, "canShare");
    else if (capability === "can-share-throws") surface.window.navigator.canShare.mockImplementation(() => { throw new Error("unsupported"); });
    else if (capability === "activation-inactive") surface.window.navigator.userActivation!.isActive = false;
    else Reflect.deleteProperty(surface.window.navigator, "userActivation");
    await expect(deliverShareMessageImage(pngBlob(), "task.png", "Task", surface.action)).resolves.toBe("dispatched");
    expect(surface.share).not.toHaveBeenCalled();
    expect(surface.click).toHaveBeenCalledOnce();
  });

  it("creates a bounded filesystem-safe Joko filename", () => {
    expect(shareMessageImageFilename(" Release / Review ", Date.UTC(2026, 7, 23, 4, 5, 6))).toBe("joko-release-review-2026-08-23T04-05-06-000Z.png");
    expect(shareMessageImageFilename("Deploy sk-secretvalue123", Number.POSITIVE_INFINITY)).toBe("joko-deploy-redacted-message.png");
  });
});

describe("share-message redaction", () => {
  it("covers token, query, and private-key forms without echoing their values", () => {
    const redacted = redactShareMessageText("api_key=secretvalue123 token=anothersecret123 ?token=urlsecret123 -----BEGIN PRIVATE KEY----- abc -----END PRIVATE KEY-----");
    expect(redacted).not.toContain("secretvalue123");
    expect(redacted).not.toContain("anothersecret123");
    expect(redacted).not.toContain("urlsecret123");
    expect(redacted).not.toContain(" abc ");
  });

  it("redacts structured JSON, authorization headers, environment keys, quoted values, and URL credentials", () => {
    const structured = JSON.stringify({
      password: "hunter2",
      Authorization: "Basic dXNlcjpwYXNz",
      OPENAI_API_KEY: "openai-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      safe: "visible"
    });
    expect(JSON.parse(redactShareMessageText(structured))).toEqual({
      password: "[REDACTED]",
      Authorization: "[REDACTED]",
      OPENAI_API_KEY: "[REDACTED]",
      AWS_SECRET_ACCESS_KEY: "[REDACTED]",
      safe: "visible"
    });
    const plain = redactShareMessageText('Authorization: Basic dXNlcjpwYXNz\nOPENAI_API_KEY="secret value"\npassword: \'two words\'\nhttps://name:pass@example.com/path');
    expect(plain).toContain("Authorization: [REDACTED]");
    expect(plain).toContain('OPENAI_API_KEY="[REDACTED]"');
    expect(plain).toContain("password: '[REDACTED]'");
    expect(plain).toContain("https://[REDACTED]@example.com/path");
    for (const secret of ["dXNlcjpwYXNz", "secret value", "two words", "name:pass"]) expect(plain).not.toContain(secret);
  });
});
