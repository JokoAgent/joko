import { parseDocument } from "yaml";

export interface SkillFileMetadata {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly updatedAt: string;
  readonly body: string;
  readonly bodyStartLine: number;
  readonly frontmatterBytes: number;
}
/** Standard current Skill frontmatter; original instructions and assets are not rewritten on read. */
export function readSkillFile(source: string, fallbackSlug: string): SkillFileMetadata {
  const normalized = source.replace(/\r\n/gu, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(normalized);
  let fields: Record<string, unknown> = {};
  if (match) {
    const document = parseDocument(match[1]!, { schema: "core", prettyErrors: false });
    if (!document.errors.length) {
      const value: unknown = document.toJS({ maxAliasCount: 0 });
      if (value && typeof value === "object" && !Array.isArray(value)) fields = value as Record<string, unknown>;
    }
  }
  const metadata = fields["metadata"];
  const extra = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {};
  const string = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
  const header = match?.[0] ?? "";
  return { slug: string(fields["name"], fallbackSlug), name: string(extra["displayName"], string(fields["name"], fallbackSlug)),
    description: string(fields["description"]), updatedAt: string(extra["updatedAt"]),
    body: normalized.slice(header.length).trim(), bodyStartLine: header.split("\n").length,
    frontmatterBytes: Buffer.byteLength(header) };
}
export function renderSkillFile(input: { readonly slug: string; readonly name: string; readonly description: string; readonly updatedAt: string; readonly body: string }): string {
  const quote = (value: string) => JSON.stringify(value.replace(/[\r\n]+/gu, " "));
  return ["---", `name: ${quote(input.slug)}`, `description: ${quote(input.description)}`, "metadata:",
    `  displayName: ${quote(input.name)}`, `  updatedAt: ${quote(input.updatedAt)}`, "---", "", input.body.trim(), ""].join("\n");
}
