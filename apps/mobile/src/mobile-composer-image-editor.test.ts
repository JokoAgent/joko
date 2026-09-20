import { describe, expect, it } from "vitest";
import { mobileAnnotatedImageFileName } from "./mobile-composer-image-editor";

describe("mobile composer image editor", () => {
  it("creates a bounded output leaf with an encoding-matching extension", () => {
    expect(mobileAnnotatedImageFileName("folder/photo.heic", "image/png")).toBe("photo-annotated.png");
    expect(mobileAnnotatedImageFileName("photo.jpeg", "image/jpeg")).toBe("photo-annotated.jpg");
    expect(mobileAnnotatedImageFileName(".hidden", "image/png")).toBe("image-annotated.png");
  });
});
