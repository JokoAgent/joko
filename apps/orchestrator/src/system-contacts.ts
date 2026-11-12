import { create } from "@bufbuild/protobuf";
import { ContactKind, NativeSystemContactsReadRequestSchema, type NativeSystemContactCard } from "@joko/contracts";
import { ContactStoreError, normalizeContactIdentityValue, type ContactIdentityDraft } from "@joko/store";
import { ContactManagerError, type ContactManager, type SystemContactImportRecord } from "./contact-manager.js";
import type { NativeSystemContactsPort } from "./input-handoff/native-host.js";

export interface SystemContactsAccess {
  readonly port: NativeSystemContactsPort;
  readonly ownerId: string;
  readonly assertCurrent: () => void;
}

export interface SystemContactImportOptions {
  readonly nameContains?: string;
  readonly requireEmail?: boolean;
  readonly group?: string;
}

export async function readSystemContactImport(
  contacts: ContactManager,
  access: SystemContactsAccess,
  options: SystemContactImportOptions = {},
  signal?: AbortSignal
) {
  const revision = contacts.directory().revision;
  const records = await readSystemContactRecords(contacts, access, options, signal);
  access.assertCurrent();
  signal?.throwIfAborted();
  if (contacts.directory().revision !== revision) {
    throw new ContactManagerError("CONTACT_IMPORT_CHANGED", "Contacts changed during the system read. Open a new preview.");
  }
  return contacts.previewSystemContactImport(records, {
    ownerId: access.ownerId, deviceId: access.port.deviceId, assertCurrent: access.port.assertCurrent
  });
}

export async function readSystemContactRecords(
  contacts: ContactManager,
  access: SystemContactsAccess,
  options: SystemContactImportOptions,
  signal?: AbortSignal
): Promise<readonly SystemContactImportRecord[]> {
  const directory = contacts.directory();
  if (!directory.enabled) throw new ContactManagerError("CONTACT_IMPORT_INVALID", "Enable Contacts before importing system cards.");
  const check = () => {
    signal?.throwIfAborted();
    access.assertCurrent();
    if (contacts.directory().revision !== directory.revision) {
      throw new ContactManagerError("CONTACT_IMPORT_CHANGED", "Contacts changed during the system read. Open a new preview.");
    }
  };
  check();
  const result = await access.port.read(create(NativeSystemContactsReadRequestSchema, {
    nameContains: options.nameContains ?? "", requireEmail: options.requireEmail === true
  }), check, signal);
  check();
  if (result.cards.length > 2_000) {
    throw new ContactManagerError("CONTACT_IMPORT_INVALID", "The macOS Contacts import exceeds 2,000 cards. Narrow the selection.");
  }
  const seen = new Set<string>();
  return result.cards.flatMap(card => {
    if (card.nativeId !== "" && seen.has(card.nativeId)) return [];
    seen.add(card.nativeId);
    return [importRecord(card, options.group)];
  });
}

function importRecord(card: NativeSystemContactCard, group?: string): SystemContactImportRecord {
  const fields = card.fields;
  const kind = fields?.kind === ContactKind.ORGANIZATION ? "organization" : "person";
  const identities = new Map<string, ContactIdentityDraft>();
  for (const [platform, addresses] of [["email", fields?.emails], ["phone", fields?.phones]] as const) {
    for (const { value, label } of addresses ?? []) {
      try {
        const key = `${platform}:${normalizeContactIdentityValue(value, platform)}`;
        if (!identities.has(key)) identities.set(key, { platform, value, label: contactLine(label, 100) });
      } catch (error) {
        if (!(error instanceof ContactStoreError && error.code === "CONTACT_INVALID")) throw error;
      }
    }
  }
  return {
    nativeId: validSystemContactId(card.nativeId) ? card.nativeId : "",
    draft: {
      kind, displayName: fields?.displayName ?? "", summary: contactLine(card.note.split(/\r?\n/u, 1)[0] ?? "", 300),
      source: "import", status: "confirmed", identities: [...identities.values()]
    },
    ...(kind !== "person" || !fields?.organizationName ? {} : { organizationName: fields.organizationName }),
    ...(kind !== "person" || !fields?.title ? {} : { title: contactLine(fields.title, 1_000) }),
    groups: group ? [group] : []
  };
}

export function validSystemContactId(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function contactLine(value: string, limit: number): string {
  return value.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .trim().slice(0, limit).replace(/[\uD800-\uDBFF]$/u, "").trim();
}
