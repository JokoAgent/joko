import type { ContactDraft, ContactProfileRecord } from "@joko/store";

export interface ParsedContactVCard {
  readonly draft: ContactDraft;
  readonly organizationName?: string;
  readonly title?: string;
  readonly groups: readonly string[];
}

interface VCardProperty {
  readonly name: string;
  readonly parameters: ReadonlyMap<string, readonly string[]>;
  readonly value: string;
}

const EMPLOYMENT_RELATION = /任职|就职|在职|供职|入职|works?\s+at|employ/iu;
const PLATFORM = /^[a-z0-9_-]{1,32}$/u;

/** Bounded by ContactManager before parsing. Invalid individual cards are skipped. */
export function parseContactVCards(text: string): readonly ParsedContactVCard[] {
  const records: ParsedContactVCard[] = [];
  for (const block of splitCards(unfoldLines(text))) {
    try {
      const record = parseCard(block);
      if (record !== undefined) records.push(record);
    } catch {
      // One malformed card must not discard the rest of an otherwise usable file.
    }
  }
  return records;
}

/**
 * Portable vCard export deliberately excludes private narrative, agent notes,
 * and event history. Those fields are not public address-book data.
 */
export function serializeContactVCards(profiles: readonly ContactProfileRecord[]): string {
  const lines: string[] = [];
  for (const profile of profiles) {
    lines.push("BEGIN:VCARD", "VERSION:3.0");
    lines.push(`N:${escapeText(profile.displayName)};;;;`);
    lines.push(`FN:${escapeText(profile.displayName)}`);
    if (profile.aliases.length > 0) {
      lines.push(`NICKNAME:${profile.aliases.map(escapeText).join(",")}`);
    }
    if (profile.kind === "organization") {
      lines.push("KIND:org", "X-ABSHOWAS:COMPANY", `ORG:${escapeText(profile.displayName)}`);
    } else {
      const employment = profile.relations.filter((relation) => relation.direction === "outgoing"
        && relation.relatedKind === "organization" && EMPLOYMENT_RELATION.test(relation.relation)).at(-1);
      if (employment !== undefined) {
        lines.push(`ORG:${escapeText(employment.relatedDisplayName)}`);
        if (employment.note !== "") lines.push(`TITLE:${escapeText(employment.note)}`);
      }
    }
    for (const identity of profile.identities) {
      const label = sanitizeTypeLabel(identity.label);
      const type = label === "" ? "" : `;TYPE=${label}`;
      if (identity.platform === "email") lines.push(`EMAIL${type}:${escapeText(identity.value)}`);
      else if (identity.platform === "phone") lines.push(`TEL${type}:${escapeText(identity.value)}`);
      else if (identity.platform !== "device-contact") {
        lines.push(`X-JOKO-${identity.platform.toUpperCase()}:${escapeText(identity.value)}`);
      }
    }
    if (profile.summary !== "") lines.push(`NOTE:${escapeText(profile.summary)}`);
    if (profile.groups.length > 0) {
      lines.push(`CATEGORIES:${profile.groups.map((group) => escapeText(group.name)).join(",")}`);
    }
    lines.push("END:VCARD");
  }
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

function parseCard(lines: readonly string[]): ParsedContactVCard | undefined {
  let formattedName = "";
  let structuredName = "";
  let organizationName: string | undefined;
  let title: string | undefined;
  let note: string | undefined;
  let organization = false;
  const aliases: string[] = [];
  const identities: Array<{ platform: string; value: string; label?: string }> = [];
  const groups: string[] = [];

  for (const line of lines) {
    const property = parseProperty(line);
    if (property === undefined || property.value === "") continue;
    if (property.name.startsWith("X-JOKO-")) {
      const platform = property.name.slice("X-JOKO-".length).toLocaleLowerCase("en-US");
      const value = unescapeText(property.value).trim();
      if (PLATFORM.test(platform) && value !== "" && platform !== "device-contact") {
        identities.push({ platform, value });
      }
      continue;
    }
    switch (property.name) {
      case "FN":
        formattedName = unescapeText(property.value).trim();
        break;
      case "N": {
        const components = splitUnescaped(property.value, ";").map((value) => unescapeText(value).trim());
        const family = components[0] ?? "";
        const given = components[1] ?? "";
        structuredName = /[\u3400-\u9fff\uf900-\ufaff]/u.test(family + given)
          ? `${family}${given}` : `${given} ${family}`.trim();
        break;
      }
      case "NICKNAME":
        for (const value of splitUnescaped(property.value, ",")) addUnique(aliases, unescapeText(value).trim());
        break;
      case "ORG":
        organizationName = unescapeText(splitUnescaped(property.value, ";")[0] ?? "").trim() || undefined;
        break;
      case "TITLE":
        title = unescapeText(property.value).trim() || undefined;
        break;
      case "NOTE":
        note = unescapeText(property.value).trim() || undefined;
        break;
      case "CATEGORIES":
        for (const value of splitUnescaped(property.value, ",")) addUnique(groups, unescapeText(value).trim());
        break;
      case "X-ABSHOWAS":
        if (property.value.trim().toUpperCase() === "COMPANY") organization = true;
        break;
      case "KIND":
        if (/^org(?:anization)?$/iu.test(property.value.trim())) organization = true;
        break;
      case "EMAIL": {
        const value = property.value.trim().replace(/^mailto:/iu, "");
        if (value !== "") identities.push(withLabel("email", value, property.parameters));
        break;
      }
      case "TEL": {
        const value = property.value.trim().replace(/^tel:/iu, "");
        if (value !== "") identities.push(withLabel("phone", value, property.parameters));
        break;
      }
    }
  }

  const displayName = formattedName || structuredName || organizationName || "";
  if (displayName === "") return undefined;
  if (formattedName === "" && structuredName === "" && organizationName !== undefined) organization = true;
  const summary = note === undefined ? "" : firstLine(note).slice(0, 300);
  const narrative = note !== undefined && note !== summary ? note : "";
  return {
    draft: {
      kind: organization ? "organization" : "person",
      displayName,
      aliases,
      summary,
      ...(narrative === "" ? {} : { narrative }),
      source: "import",
      identities
    },
    ...(organization || organizationName === undefined ? {} : { organizationName }),
    ...(organization || title === undefined ? {} : { title }),
    groups
  };
}

function unfoldLines(text: string): readonly string[] {
  const output: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/u)) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && output.length > 0) output[output.length - 1] += line.slice(1);
    else output.push(line);
  }
  return output;
}

function splitCards(lines: readonly string[]): readonly (readonly string[])[] {
  const cards: string[][] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    const marker = line.trim().toUpperCase();
    if (marker === "BEGIN:VCARD") current = [];
    else if (marker === "END:VCARD") {
      if (current !== undefined) cards.push(current);
      current = undefined;
    } else if (current !== undefined) current.push(line);
  }
  return cards;
}

function parseProperty(line: string): VCardProperty | undefined {
  const colon = findUnquoted(line, ":");
  if (colon < 0) return undefined;
  const parts = line.slice(0, colon).split(";");
  let name = parts[0]!.toUpperCase();
  const dot = name.indexOf(".");
  if (dot >= 0) name = name.slice(dot + 1);
  const parameters = new Map<string, string[]>();
  for (const part of parts.slice(1)) {
    const equals = part.indexOf("=");
    const key = (equals >= 0 ? part.slice(0, equals) : "TYPE").toUpperCase();
    const values = (equals >= 0 ? part.slice(equals + 1) : part).split(",")
      .map((value) => value.replace(/^"|"$/gu, "").trim()).filter(Boolean);
    parameters.set(key, [...(parameters.get(key) ?? []), ...values]);
  }
  return { name, parameters, value: line.slice(colon + 1) };
}

function findUnquoted(value: string, needle: string): number {
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\"") quoted = !quoted;
    else if (value[index] === needle && !quoted) return index;
  }
  return -1;
}

function splitUnescaped(value: string, separator: string): readonly string[] {
  const parts: string[] = [];
  let current = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "\\" && index + 1 < value.length) {
      current += character + value[index + 1]!;
      index += 1;
    } else if (character === separator) {
      parts.push(current);
      current = "";
    } else current += character;
  }
  parts.push(current);
  return parts;
}

function unescapeText(value: string): string {
  return value.replace(/\\(.)/gu, (_match, character: string) => character === "n" || character === "N" ? "\n" : character);
}

function escapeText(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/([,;])/gu, "\\$1").replace(/\r?\n|\r/gu, "\\n");
}

function foldLine(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= 75) return line;
  const output: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of line) {
    const length = Buffer.byteLength(character, "utf8");
    if (current !== "" && bytes + length > 75) {
      output.push(current);
      current = " ";
      bytes = 1;
    }
    current += character;
    bytes += length;
  }
  output.push(current);
  return output.join("\r\n");
}

function sanitizeTypeLabel(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9-]/gu, "");
}

function withLabel(platform: string, value: string, parameters: ReadonlyMap<string, readonly string[]>): {
  readonly platform: string;
  readonly value: string;
  readonly label?: string;
} {
  const label = (parameters.get("TYPE") ?? []).map((item) => item.toLocaleLowerCase("en-US"))
    .find((item) => !["pref", "internet", "voice"].includes(item));
  return { platform, value, ...(label === undefined ? {} : { label }) };
}

function addUnique(values: string[], value: string): void {
  if (value !== "" && !values.includes(value)) values.push(value);
}

function firstLine(value: string): string {
  return value.split(/\r?\n|\r/u)[0]?.trim() ?? "";
}
