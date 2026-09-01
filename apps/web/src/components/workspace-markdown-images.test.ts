import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
  findWorkspaceMarkdownImageTargets,
  resolveWorkspaceMarkdownImageSource
} from "./workspace-markdown-images.js";

const doc = (...lines: readonly string[]): Text => Text.of([...lines]);

describe("Markdown image live preview", () => {
  it("recognizes standalone Markdown, HTML, centered groups, and image wiki embeds", () => {
    const targets = findWorkspaceMarkdownImageTargets(doc(
      "![logo](assets/logo.png \"Logo\")",
      "<p align=\"center\">",
      "  <img src=\"img/a.webp\" width=\"720\" />",
      "  <img src='img/b.png' height='200px'>",
      "</p>",
      "![[Some Image.png|300x200]]"
    ));
    expect(targets).toHaveLength(3);
    expect(targets[0]?.images[0]).toMatchObject({ src: "assets/logo.png", alt: "logo", title: "Logo" });
    expect(targets[1]).toMatchObject({ align: "center" });
    expect(targets[1]?.images).toHaveLength(2);
    expect(targets[1]?.images[0]).toMatchObject({ width: 720, height: null });
    expect(targets[2]?.images[0]).toMatchObject({ src: "Some Image.png", width: 300, height: 200 });
  });

  it("leaves inline/list images, non-image wiki embeds, and fenced examples as source", () => {
    expect(findWorkspaceMarkdownImageTargets(doc(
      "see ![icon](i.png) inline",
      "- ![listed](a.png)",
      "![[Project overview]]",
      "```markdown",
      "![example](x.png)",
      "```",
      "![real](y.png)"
    )).map((target) => target.images[0]?.src)).toEqual(["y.png"]);
    expect(findWorkspaceMarkdownImageTargets(doc("```", "![unfinished](x.png)", "![also-fenced](y.png)"))).toEqual([]);
  });

  it("resolves relative paths against the document directory and fails closed on escape or absolute paths", () => {
    expect(resolveWorkspaceMarkdownImageSource("docs/README.md", "./img/a%20b.png")).toEqual({
      kind: "workspace",
      path: "docs/img/a b.png"
    });
    expect(resolveWorkspaceMarkdownImageSource("docs/deep/README.md", "../img/a.png")).toEqual({
      kind: "workspace",
      path: "docs/img/a.png"
    });
    expect(resolveWorkspaceMarkdownImageSource("README.md", "../secret.png")).toBeUndefined();
    expect(resolveWorkspaceMarkdownImageSource("README.md", "C:\\secret.png")).toBeUndefined();
    expect(resolveWorkspaceMarkdownImageSource("README.md", "/secret.png")).toBeUndefined();
    expect(resolveWorkspaceMarkdownImageSource("README.md", "https://example.test/a.png")).toEqual({
      kind: "remote",
      url: "https://example.test/a.png"
    });
  });
});
