import { describe, expect, it, vi } from "vitest";
import {
  MobilePdfPreviewFiles,
  inspectMobilePdfPreviewBytes,
  isMobilePdfPreviewMediaType,
  mobilePdfPreviewTesting,
  type MobilePdfPreviewFileDriver,
  type MobilePdfPreviewFileSnapshot
} from "./mobile-pdf-preview";

describe("mobile PDF preview bytes", () => {
  it("accepts canonical PDF 1.x and 2.0 cross-reference tables", () => {
    const first = pdfBytes("1.7");
    const second = pdfBytes("2.0");
    expect(inspectMobilePdfPreviewBytes(first, "application/pdf; charset=binary", "docs/Proof.PDF"))
      .toMatchObject({ mediaType: "application/pdf", version: "1.7", xrefKind: "table" });
    expect(inspectMobilePdfPreviewBytes(second, "application/pdf", "proof.pdf"))
      .toMatchObject({ version: "2.0", xrefKind: "table" });
    expect(isMobilePdfPreviewMediaType("APPLICATION/PDF; version=1.7")).toBe(true);
    expect(isMobilePdfPreviewMediaType("application/octet-stream")).toBe(false);
  });

  it("accepts an exact xref-stream target", () => {
    const bytes = xrefStreamPdfBytes();
    expect(inspectMobilePdfPreviewBytes(bytes, "application/pdf", "stream.pdf"))
      .toMatchObject({ xrefKind: "stream" });
  });

  it("rejects mismatched type, extension, header, EOF, pointer, trailer and object structure", () => {
    const bytes = pdfBytes();
    expect(() => inspectMobilePdfPreviewBytes(bytes, "application/octet-stream", "proof.pdf")).toThrow(/application\/pdf/u);
    expect(() => inspectMobilePdfPreviewBytes(bytes, "application/pdf", "proof.bin")).toThrow(/extension/u);
    expect(() => inspectMobilePdfPreviewBytes(replace(bytes, "%PDF-", "%PDE-"), "application/pdf", "proof.pdf"))
      .toThrow(/header/u);
    expect(() => inspectMobilePdfPreviewBytes(bytes.subarray(0, bytes.length - 7), "application/pdf", "proof.pdf"))
      .toThrow(/EOF/u);
    expect(() => inspectMobilePdfPreviewBytes(replace(bytes, "startxref\n", "startxred\n"), "application/pdf", "proof.pdf"))
      .toThrow(/cross-reference/u);
    expect(() => inspectMobilePdfPreviewBytes(replace(bytes, "trailer", "trailee"), "application/pdf", "proof.pdf"))
      .toThrow(/trailer/u);
    expect(() => inspectMobilePdfPreviewBytes(replace(bytes, "endobj", "endobx"), "application/pdf", "proof.pdf"))
      .toThrow(/indirect object/u);
  });
});

describe("MobilePdfPreviewFiles", () => {
  it("writes one controlled lease and verifies exact readback", async () => {
    const bytes = pdfBytes();
    const fixture = filesFixture(bytes);
    const files = new MobilePdfPreviewFiles(fixture.driver, async () => "a".repeat(64));
    await expect(files.stage("profile-one", "lease-one", "../../source.pdf", "application/pdf", "a".repeat(64), bytes))
      .resolves.toEqual(expect.objectContaining({
        profileId: "profile-one",
        leaseId: "lease-one",
        fileName: "preview-lease-one.pdf",
        uri: "file:///cache/joko-pdf-preview/preview-lease-one.pdf",
        mediaType: "application/pdf",
        localByteSize: bytes.byteLength
      }));
    expect(fixture.prepare).toHaveBeenCalledOnce();
    expect(fixture.write).toHaveBeenCalledWith("preview-lease-one.pdf", bytes);
    expect(mobilePdfPreviewTesting.pdfPreviewRootDirectory).toBe("joko-pdf-preview");
  });

  it("fails closed on digest or readback mismatch and removes a written stage", async () => {
    const bytes = pdfBytes();
    const fixture = filesFixture(bytes, Uint8Array.from(bytes, (value, index) => index === 12 ? value ^ 1 : value));
    const badDigest = new MobilePdfPreviewFiles(fixture.driver, async () => "b".repeat(64));
    await expect(badDigest.stage("profile", "lease", "proof.pdf", "application/pdf", "a".repeat(64), bytes))
      .rejects.toThrow(/SHA-256/u);
    expect(fixture.write).not.toHaveBeenCalled();

    const badReadback = new MobilePdfPreviewFiles(fixture.driver, async () => "a".repeat(64));
    await expect(badReadback.stage("profile", "lease", "proof.pdf", "application/pdf", "a".repeat(64), bytes))
      .rejects.toThrow(/readback/u);
    expect(fixture.remove).toHaveBeenCalledWith(expect.objectContaining({ fileName: "preview-lease.pdf" }));
  });

  it("removes a stage completed after cancellation", async () => {
    const bytes = pdfBytes();
    const controller = new AbortController();
    const fixture = filesFixture(bytes, bytes, () => controller.abort());
    const files = new MobilePdfPreviewFiles(fixture.driver, async () => "a".repeat(64));
    await expect(files.stage("profile", "late", "proof.pdf", "application/pdf", "a".repeat(64), bytes, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.remove).toHaveBeenCalledWith(expect.objectContaining({ fileName: "preview-late.pdf" }));
  });
});

function filesFixture(bytes: Uint8Array, readback = bytes, afterWrite?: () => void) {
  const prepare = vi.fn(async () => undefined);
  const write = vi.fn(async (fileName: string): Promise<MobilePdfPreviewFileSnapshot> => {
    afterWrite?.();
    return { uri: `file:///cache/joko-pdf-preview/${fileName}`, fileName,
      byteSize: readback.byteLength, bytes: readback };
  });
  const remove = vi.fn(async () => undefined);
  const driver: MobilePdfPreviewFileDriver = { prepare, write, remove };
  return { driver, prepare, write, remove };
}

function pdfBytes(version = "1.7"): Uint8Array {
  const body = `%PDF-${version}\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\n`;
  const xref = new TextEncoder().encode(body).byteLength;
  return new TextEncoder().encode(`${body}xref\n0 3\n0000000000 65535 f \n0000000009 00000 n \n0000000060 00000 n \ntrailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

function xrefStreamPdfBytes(): Uint8Array {
  const body = "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n";
  const xref = new TextEncoder().encode(body).byteLength;
  return new TextEncoder().encode(`${body}2 0 obj\n<< /Type /XRef /Size 3 /Length 1 >>\nstream\n0\nendstream\nendobj\nstartxref\n${xref}\n%%EOF\n`);
}

function replace(bytes: Uint8Array, from: string, to: string): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  if (from.length !== to.length || !text.includes(from)) throw new Error("Invalid PDF fixture replacement.");
  return new TextEncoder().encode(text.replaceAll(from, to));
}
