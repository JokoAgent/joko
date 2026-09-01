import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => vi.unstubAllGlobals());

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

describe("share-message PNG integrity", () => {
  it("accepts only a real PNG signature", async () => {
    await expect(assertPngBlob(new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])], { type: "image/png" }))).resolves.toBeUndefined();
    await expect(assertPngBlob(new Blob(["not png"], { type: "image/png" }))).rejects.toBeInstanceOf(ShareMessageImageEncodingError);
    await expect(assertPngBlob(new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/jpeg" }))).rejects.toBeInstanceOf(ShareMessageImageEncodingError);
  });

  it("requests browser canvas PNG encoding and rejects no intermediate format", async () => {
    const encoded = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])], { type: "image/png" });
    const encodingTypes: string[] = [];
    const context = new Proxy({
      measureText: (value: string) => ({ width: value.length * 8 })
    } as unknown as CanvasRenderingContext2D, {
      get(target, property) {
        if (property in target) return Reflect.get(target, property);
        return vi.fn();
      },
      set(target, property, value) {
        return Reflect.set(target, property, value);
      }
    });
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toBlob: (callback: BlobCallback, type?: string) => { encodingTypes.push(type ?? ""); callback(encoded); }
    } as unknown as HTMLCanvasElement;
    vi.stubGlobal("document", { createElement: () => canvas });

    const result = await buildShareMessageImagePng({
      sessionName: "Task",
      role: "assistant",
      roleLabel: "Agent",
      text: "Completed the review.",
      attachmentsLabel: "Attachments"
    }, {
      background: "white",
      surface: "white",
      text: "black",
      secondaryText: "gray",
      line: "gray",
      accent: "orange",
      accentInk: "black",
      fontFamily: "sans-serif"
    });

    expect(encodingTypes).toEqual(["image/png"]);
    expect(result).toBe(encoded);
    expect(canvas.width).toBeGreaterThan(0);
    expect(canvas.height).toBeGreaterThan(0);
  });

  it("delivers a validated PNG through a real browser download fallback", async () => {
    const blob = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])], { type: "image/png" });
    const click = vi.fn();
    const remove = vi.fn();
    const appendChild = vi.fn();
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("File", undefined);
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", {
      createElement: () => ({ href: "", download: "", rel: "", hidden: false, click, remove }),
      body: { appendChild }
    });
    vi.stubGlobal("URL", { createObjectURL: () => "blob:joko-share", revokeObjectURL });
    vi.stubGlobal("window", { setTimeout: (callback: () => void) => { callback(); return 1; } });

    await expect(deliverShareMessageImage(blob, "joko-task.png", "Task")).resolves.toBe("downloaded");
    expect(appendChild).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:joko-share");
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
