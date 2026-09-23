import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { expect, it } from "vitest";
import { createPptxBuffer, readDocumentInput, publishDocumentOutput } from "./index.js";

it("renders all six editable slide layouts with notes and a bounded in-task image", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-presentation-"));
  const outside = await mkdtemp(join(tmpdir(), "joko-presentation-outside-"));
  try {
    const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#4388cc" } }).png().toBuffer();
    await writeFile(join(root, "illustration.png"), image);
    await writeFile(join(outside, "secret.png"), image);
    const result = await createPptxBuffer({
      title: "Quarterly review", theme: "navy", footer: true,
      slides: [
        { layout: "cover", title: "Quarterly review", subtitle: "September" },
        { layout: "section", title: "Highlights", notes: "Speak to the trend" },
        { layout: "content", title: "What changed", bullets: ["Revenue grew", "Costs fell"], body: "Measured across regions", imagePath: "illustration.png" },
        { layout: "comparison", title: "Two options", columns: [
          { title: "Option A", bullets: ["Fast"], body: "Available now" },
          { title: "Option B", bullets: ["Flexible"], body: "Later" }
        ] },
        { layout: "metrics", title: "Results", metrics: [
          { value: "98%", label: "Uptime", detail: "Last quarter" },
          { value: 12, label: "Regions" },
          { value: "4.2", label: "Rating" },
          { value: "2x", label: "Throughput" }
        ] },
        { layout: "image", title: "Product view", imagePath: "illustration.png", body: "A full-width image" }
      ]
    }, (inPath, maxBytes, signal) => readDocumentInput({ root, inPath, maxBytes, ...(signal ? { signal } : {}) }));
    expect(result).toMatchObject({ slides: 6, layouts: ["cover", "section", "content", "comparison", "metrics", "image"], theme: "navy", footer: true });
    const published = await publishDocumentOutput({ root, outPath: "documents/review.pptx", bytes: result.buffer, overwrite: false });
    const zip = await JSZip.loadAsync(await readFile(published.path));
    const presentation = await zip.file("ppt/presentation.xml")!.async("string");
    expect(presentation).toContain("sldSz");
    const slides = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/u.test(name));
    expect(slides).toHaveLength(6);
    const slideText = (await Promise.all(slides.map(name => zip.file(name)!.async("string")))).join("\n");
    for (const text of ["Quarterly review", "Revenue grew", "Option A", "Option B", "Uptime", "Product view"]) {
      expect(slideText).toContain(text);
    }
    const notes = Object.keys(zip.files).filter(name => /^ppt\/notesSlides\/notesSlide\d+\.xml$/u.test(name));
    expect((await Promise.all(notes.map(name => zip.file(name)!.async("string")))).join("\n")).toContain("Speak to the trend");
    expect(Object.keys(zip.files).filter(name => name.startsWith("ppt/media/") && !name.endsWith("/"))).not.toHaveLength(0);
    expect(slideText).toContain("Measured across regions");
    expect(slideText).toContain("A full-width image");
    await expect(publishDocumentOutput({ root, outPath: "documents/review.pptx", bytes: result.buffer, overwrite: false }))
      .rejects.toMatchObject({ code: "FILE_EXISTS" });
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await expect(readDocumentInput({ root, inPath: "linked/secret.png", maxBytes: 1024 }))
      .rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await expect(readDocumentInput({ root, inPath: "../secret.png", maxBytes: 1024 }))
      .rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await expect(readDocumentInput({ root, inPath: "illustration.png", maxBytes: 8 }))
      .rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(createPptxBuffer({ slides: [{ title: "Invalid", layout: "comparison", columns: [
      { title: "A" }, { title: "B", unexpected: true }
    ] }] }, async () => image)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
