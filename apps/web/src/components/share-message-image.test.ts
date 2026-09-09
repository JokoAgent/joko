import { describe, expect, it, vi } from "vitest";
import { deferredShareValue, pngBlob, shareImageTestPalette, shareImageTestSurface } from "./share-image.test-support.js";
import {
  MAXIMUM_SHARE_IMAGE_EDGE_PIXELS,
  MAXIMUM_SHARE_IMAGE_PIXELS,
  MAXIMUM_SHARE_MESSAGE_CHARACTERS,
  ShareMessageImageEmptyError,
  ShareMessageImageEncodingError,
  ShareMessageImageTooLargeError,
  assertPngBlob,
  buildShareMessageImagePng,
  deliverShareMessageImage,
  layoutShareMessageImage,
  redactShareMessageText,
  shareMessageImageFilename,
  wrapShareMessageText
} from "./share-message-image.js";


describe("share-message PNG layout", () => {
  it("wraps paragraphs and unbroken tokens without exceeding the measured width", () => {
    const lines = wrapShareMessageText("one two three\n\nabcdefghij", 50, (value) => value.length * 10);
    expect(lines).toEqual(["one", "two", "three", "", "abcde", "fghij"]);
    expect(lines.every((line) => line.length * 10 <= 50)).toBe(true);
  });

  it("redacts common credentials before laying out a bounded readable image", () => {
    const layout = layoutShareMessageImage({
      sessionName: "Deploy sk-sessionsecret123",
      role: "assistant",
      roleLabel: "Agent",
      text: "Authorization: Bearer sk-supersecret123456 and token=opaque-value-123",
      attachmentNames: ["result.txt"],
      attachmentsLabel: "Attachments",
      createdAtLabel: "Today, 12:00"
    }, (value) => value.length * 8);

    expect(layout.title).not.toContain("sk-sessionsecret123");
    expect(layout.lines.join("\n")).not.toContain("sk-supersecret123456");
    expect(layout.lines.join("\n")).not.toContain("opaque-value-123");
    expect(layout.lines.join("\n")).toContain("[REDACTED]");
    expect(layout.width * layout.scale).toBeLessThanOrEqual(MAXIMUM_SHARE_IMAGE_EDGE_PIXELS);
    expect(layout.height * layout.scale).toBeLessThanOrEqual(MAXIMUM_SHARE_IMAGE_EDGE_PIXELS);
    expect(layout.width * layout.height * layout.scale ** 2).toBeLessThanOrEqual(MAXIMUM_SHARE_IMAGE_PIXELS);
  });

  it("rejects empty, overlong, or unreadably tall exports instead of silently truncating", () => {
    const base = { sessionName: "Task", role: "user" as const, roleLabel: "You", attachmentsLabel: "Attachments" };
    expect(() => layoutShareMessageImage({ ...base, text: "" }, () => 1)).toThrow(ShareMessageImageEmptyError);
    expect(() => layoutShareMessageImage({ ...base, text: "x".repeat(MAXIMUM_SHARE_MESSAGE_CHARACTERS + 1) }, () => 1)).toThrow(ShareMessageImageTooLargeError);
    expect(() => layoutShareMessageImage({ ...base, text: "x".repeat(MAXIMUM_SHARE_MESSAGE_CHARACTERS) }, (value) => value.length * 100)).toThrow(ShareMessageImageTooLargeError);
  });
});

describe("share-message PNG integrity and delivery", () => {
  it("accepts only a real PNG signature", async () => {
    const { action } = shareImageTestSurface();
    await expect(assertPngBlob(pngBlob(), action)).resolves.toBeUndefined();
    await expect(assertPngBlob(new Blob(["not png"], { type: "image/png" }), action)).rejects.toBeInstanceOf(ShareMessageImageEncodingError);
    await expect(assertPngBlob(new Blob([await pngBlob().arrayBuffer()], { type: "image/jpeg" }), action)).rejects.toBeInstanceOf(ShareMessageImageEncodingError);
  });

  it("encodes using the initiating document and releases its canvas, including retired encoding", async () => {
    const surface = shareImageTestSurface();
    const content = { sessionName: "Task", role: "assistant" as const, roleLabel: "Agent", text: "Completed the review.", attachmentsLabel: "Attachments" };
    await expect(buildShareMessageImagePng(content, surface.action, shareImageTestPalette)).resolves.toMatchObject({ type: "image/png" });
    expect(surface.canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png");
    expect([surface.canvas.width, surface.canvas.height]).toEqual([0, 0]);

    let finish!: BlobCallback;
    surface.canvas.toBlob.mockImplementationOnce((callback) => { finish = callback; });
    const pending = buildShareMessageImagePng(content, surface.action, shareImageTestPalette);
    const rejected = expect(pending).rejects.toThrow();
    surface.abort.abort();
    await rejected;
    expect([surface.canvas.width, surface.canvas.height]).toEqual([0, 0]);
    finish(pngBlob());
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

  it.each(["missing", "throws", "inactive"] as const)("chooses browser delivery when file-share preflight is %s", async (capability) => {
    const surface = shareImageTestSurface();
    if (capability === "missing") Reflect.deleteProperty(surface.window.navigator, "canShare");
    else if (capability === "throws") surface.window.navigator.canShare.mockImplementation(() => { throw new Error("unsupported"); });
    else surface.window.navigator.userActivation.isActive = false;
    await expect(deliverShareMessageImage(pngBlob(), "task.png", "Task", surface.action)).resolves.toBe("dispatched");
    expect(surface.share).not.toHaveBeenCalled();
    expect(surface.click).toHaveBeenCalledOnce();
  });

  it("creates a bounded filesystem-safe Joko filename", () => {
    expect(shareMessageImageFilename(" Release / Review ", Date.UTC(2026, 7, 23, 4, 5, 6))).toBe("joko-release-review-2026-08-23T04-05-06-000Z.png");
    expect(shareMessageImageFilename("Deploy sk-secretvalue123", Number.POSITIVE_INFINITY)).toBe("joko-deploy-redacted-token-message.png");
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
});
