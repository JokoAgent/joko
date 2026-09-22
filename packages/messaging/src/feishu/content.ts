import type { FeishuInboundContent, FeishuInboundPart } from "./model.js";

const EMPTY: FeishuInboundContent = Object.freeze({ text: "", attachments: [], unsupported: [] });

export function parseFeishuContent(messageType: string, rawContent: string): FeishuInboundContent {
  let value: unknown;
  try {
    value = JSON.parse(rawContent) as unknown;
  } catch {
    return EMPTY;
  }
  if (!isRecord(value)) return EMPTY;
  if (messageType === "text") {
    return { text: stringValue(value["text"]).trim(), attachments: [], unsupported: [] };
  }
  if (messageType === "image") {
    const key = stringValue(value["image_key"]);
    return key === "" ? EMPTY : {
      text: "",
      attachments: [{ kind: "image", providerKey: key, fileName: `${key}.image`, mimeType: null, byteLength: null }],
      unsupported: []
    };
  }
  if (messageType === "file") {
    const key = stringValue(value["file_key"]);
    if (key === "") return EMPTY;
    return {
      text: "",
      attachments: [{
        kind: "file",
        providerKey: key,
        fileName: stringValue(value["file_name"]) || key,
        mimeType: null,
        byteLength: finiteLength(value["file_size"])
      }],
      unsupported: []
    };
  }
  if (messageType === "post") return parsePost(value);
  if (messageType === "interactive" || messageType === "card") {
    return { text: interactiveText(value), attachments: [], unsupported: [] };
  }
  if (["sticker", "location", "share_chat", "share_user", "system", "merge_forward"].includes(messageType)) {
    return EMPTY;
  }
  if (messageType === "audio") {
    return { text: "", attachments: [], unsupported: [{ code: "audio", label: "Voice message" }] };
  }
  if (messageType === "media") {
    return {
      text: "",
      attachments: [],
      unsupported: [{ code: "media", label: `Video ${stringValue(value["file_name"]) || "attachment"}` }]
    };
  }
  return { text: "", attachments: [], unsupported: [{ code: messageType || "unknown", label: "Unsupported message type" }] };
}

function parsePost(value: Readonly<Record<string, unknown>>): FeishuInboundContent {
  const lines: string[] = [];
  const title = stringValue(value["title"]).trim();
  if (title !== "") lines.push(title);
  const attachments: FeishuInboundPart[] = [];
  const unsupported: Array<{ readonly code: string; readonly label: string }> = [];
  const content = Array.isArray(value["content"]) ? value["content"] : [];
  for (const paragraph of content) {
    if (!Array.isArray(paragraph)) continue;
    const parts: string[] = [];
    for (const rawNode of paragraph) {
      if (!isRecord(rawNode)) continue;
      const tag = stringValue(rawNode["tag"]);
      if (["text", "md", "a", "code_inline", "code_block"].includes(tag)) {
        const text = stringValue(rawNode["text"]);
        if (text !== "") parts.push(text);
      } else if (tag === "img") {
        const key = stringValue(rawNode["image_key"]);
        if (key !== "") attachments.push({
          kind: "image",
          providerKey: key,
          fileName: `${key}.image`,
          mimeType: null,
          byteLength: null
        });
      } else if (tag === "media") {
        unsupported.push({ code: "post.media", label: `Video ${stringValue(rawNode["file_name"]) || "attachment"}` });
      }
    }
    if (parts.length > 0) lines.push(parts.join(""));
  }
  return { text: lines.join("\n").trim(), attachments, unsupported };
}

function interactiveText(value: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  const body = recordValue(value["body"]);
  collectCardText(body?.["elements"], parts);
  collectCardText(value["elements"], parts);
  return parts.join("\n").trim();
}

function collectCardText(value: unknown, parts: string[]): void {
  if (!Array.isArray(value)) return;
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const tag = stringValue(raw["tag"]);
    if (tag === "markdown") {
      const text = stringValue(raw["content"]).trim();
      if (text !== "") parts.push(text);
    } else if (tag === "img") {
      parts.push("[Image]");
    } else if (tag === "div") {
      const text = recordValue(raw["text"]);
      const content = stringValue(text?.["content"]).trim();
      if (content !== "") parts.push(content);
    }
  }
}

function finiteLength(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
