// @vitest-environment jsdom
import { create } from "@bufbuild/protobuf";
import { ExtensionCardSchema } from "@joko/contracts";
import { expect, it } from "vitest";
import { extensionCardGalleryImages } from "./extension-card-gallery.js";
it("keeps exact duplicate image occurrences in card order and excludes controls and model posters", () => {
  const uri = `joko-media://blobs/${"a".repeat(64)}.png`, model = `joko-media://blobs/${"b".repeat(64)}.glb`;
  const first = create(ExtensionCardSchema, { sessionId: "task", cardId: "one", html: `<img src="${uri}"><button data-joko-action="edit"><img src="${uri}"></button><div data-joko-link="https://example.test"><img src="${uri}"></div><img src="${uri}" data-joko-model="${model}"><img src="${uri}"><img src="https://outside.example.test/photo.png">` });
  const second = create(ExtensionCardSchema, { sessionId: "task", cardId: "two", html: `<img src="${uri}">` });
  expect(extensionCardGalleryImages([first, second])).toEqual([
    { sessionId: "task", cardId: "one", uri, imageIndex: 0 }, { sessionId: "task", cardId: "one", uri, imageIndex: 1 }, { sessionId: "task", cardId: "two", uri, imageIndex: 0 }
  ]);
});
