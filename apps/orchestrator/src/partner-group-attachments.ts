import { PARTNER_GROUP_ATTACHMENTS_MAX, type PartnerGroupAttachment } from "@joko/core";
import type { PartnerGroupAttachmentOwner } from "./partner-group-manager.js";
import type { ArtifactStore } from "./artifact-store.js";

/** Group messages adopt existing authenticated Blob uploads through the original Artifact owner. */
export class PartnerGroupAttachments implements PartnerGroupAttachmentOwner {
  constructor(readonly artifacts: ArtifactStore) {}
  async prepare(input: Parameters<PartnerGroupAttachmentOwner["prepare"]>[0]) {
    input.assertCurrent();
    if (input.attachments.length > PARTNER_GROUP_ATTACHMENTS_MAX || !input.deviceId || new Set(input.attachments.map(item => item.id)).size !== input.attachments.length) throw invalid();
    const attachments: PartnerGroupAttachment[] = [];
    for (const item of input.attachments) {
      if (!item.id || !item.name.trim() || item.name.length > 255 || /[\u0000-\u001f]/u.test(item.name)
        || !["image", "pdf", "text", "office", "file"].includes(item.category) || typeof item.annotated !== "boolean") throw invalid();
      const source = await this.artifacts.readBlob(item.blob); input.assertCurrent();
      if (item.category === "image" && !source.mimeType.startsWith("image/")) throw invalid();
      const adopted = await this.artifacts.ingestBytes(source.data, { fileName: item.name, mimeType: source.mimeType }); input.assertCurrent();
      attachments.push({ ...item, blob: { id: adopted.id, sha256: adopted.sha256, byteLength: adopted.byteLength, mimeType: adopted.mimeType,
        ...(adopted.fileName === undefined ? {} : { fileName: adopted.fileName }) } });
    }
    return { attachments, commit: async () => { input.assertCurrent(); }, discard: async () => undefined };
  }
}
function invalid(): Error { return new Error("The group attachment is invalid or unavailable."); }
