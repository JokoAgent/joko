import { describe, expect, it } from "vitest";

import { parseFeishuContent } from "./content.js";

describe("parseFeishuContent", () => {
  it("normalizes text, files, posts, cards, and unsupported media without exposing download keys as text", () => {
    expect(parseFeishuContent("text", JSON.stringify({ text: "  hello  " }))).toEqual({
      text: "hello",
      attachments: [],
      unsupported: []
    });
    expect(parseFeishuContent("file", JSON.stringify({
      file_key: "file-secret-coordinate",
      file_name: "evidence.pdf",
      file_size: "42"
    }))).toEqual({
      text: "",
      attachments: [{
        kind: "file",
        providerKey: "file-secret-coordinate",
        fileName: "evidence.pdf",
        mimeType: null,
        byteLength: 42
      }],
      unsupported: []
    });
    expect(parseFeishuContent("post", JSON.stringify({
      title: "Status",
      content: [[
        { tag: "text", text: "ready" },
        { tag: "img", image_key: "image-secret-coordinate" },
        { tag: "media", file_name: "clip.mp4" }
      ]]
    }))).toEqual({
      text: "Status\nready",
      attachments: [expect.objectContaining({ kind: "image", providerKey: "image-secret-coordinate" })],
      unsupported: [{ code: "post.media", label: "Video clip.mp4" }]
    });
    expect(parseFeishuContent("interactive", JSON.stringify({
      body: { elements: [{ tag: "markdown", content: "Choose one" }] }
    })).text).toBe("Choose one");
    expect(parseFeishuContent("audio", "{}")).toEqual({
      text: "",
      attachments: [],
      unsupported: [{ code: "audio", label: "Voice message" }]
    });
    expect(parseFeishuContent("text", "not-json")).toEqual({ text: "", attachments: [], unsupported: [] });
  });
});
