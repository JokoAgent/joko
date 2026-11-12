import { spawn } from "node:child_process";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";

const MAX_RESPONSE_BYTES = 8_000_000;
const MAX_SCRIPT_RUNTIME_MS = 180_000;
const Outcome = contract.NativeSystemContactWriteOutcome;
const Method = contract.NativeInputHandoffMethod;

// Fetch each field in bulk. Contacts.app returns an array per Apple Event.
const READ_SCRIPT = `
(() => {
  const contacts = Application('/System/Applications/Contacts.app');
  const people = contacts.people;
  const names = people.name();
  const ids = people.id();
  const companies = people.company();
  const organizations = people.organization();
  const titles = people.jobTitle();
  const notes = people.note();
  const emailValues = people.emails.value();
  const emailLabels = people.emails.label();
  const phoneValues = people.phones.value();
  const phoneLabels = people.phones.label();
  const entries = (values, labels, i) => (values[i] || []).map((value, j) => ({ value, label: (labels[i] || [])[j] }));
  const result = [];
  for (let i = 0; i < names.length; i++) {
    const name = String(names[i] || '').trim();
    if (!name || !name.normalize('NFKC').toLowerCase().includes(input.nameContains)) continue;
    const emails = entries(emailValues, emailLabels, i);
    if (input.requireEmail && !emails.some(item => String(item.value || '').trim())) continue;
    result.push({ nativeId: ids[i], name, company: companies[i], organization: organizations[i], title: titles[i], note: notes[i],
      emails, phones: entries(phoneValues, phoneLabels, i) });
    if (result.length > 2000) break;
  }
  return JSON.stringify(result);
})()
`;

const WRITE_SCRIPT = `
(() => {
  const contacts = Application('/System/Applications/Contacts.app');
  const knownIds = new Set(contacts.people.id());
  const results = [];
  const touched = [];
  const normalizePhone = value => String(value).replace(/[^0-9+]/g, '');
  for (const item of input) {
    const result = { contactId: item.contactId, outcome: 'failed' };
    results.push(result);
    const fields = item.fields;
    const organization = fields.kind === 2;
    let person;
    try {
      if (item.nativeId) {
        if (!knownIds.has(item.nativeId)) { result.outcome = 'missing'; continue; }
        person = contacts.people.byId(item.nativeId);
        if (person.id() !== item.nativeId) { result.outcome = 'missing'; continue; }
        const kindChanged = person.company() !== organization;
        const nameChanged = person.name() !== fields.displayName;
        result.outcome = 'unknown';
        if (kindChanged) person.company = organization;
        if (kindChanged || nameChanged) {
          if (organization) {
            person.organization = fields.displayName;
            if (kindChanged) { person.firstName = ''; person.middleName = ''; person.lastName = ''; }
          } else {
            person.firstName = fields.displayName; person.middleName = ''; person.lastName = '';
            if (kindChanged && !fields.organizationName) person.organization = '';
          }
        }
      } else {
        person = organization
          ? contacts.Person({ organization: fields.displayName, company: true })
          : contacts.Person({ firstName: fields.displayName });
        result.outcome = 'unknown';
        contacts.people.push(person);
      }
      if (!organization && fields.organizationName) person.organization = fields.organizationName;
      if (!organization && fields.title) person.jobTitle = fields.title;
      else if (!organization && fields.organizationName && item.nativeId) person.jobTitle = '';
      const emails = new Set(person.emails.value().map(value => String(value).toLowerCase()));
      for (const entry of fields.emails) {
        const key = entry.value.toLowerCase();
        if (!emails.has(key)) { person.emails.push(contacts.Email({ label: entry.label || 'work', value: entry.value })); emails.add(key); }
      }
      const phones = new Set(person.phones.value().map(normalizePhone));
      for (const entry of fields.phones) {
        const key = normalizePhone(entry.value);
        if (!phones.has(key)) { person.phones.push(contacts.Phone({ label: entry.label || 'work', value: entry.value })); phones.add(key); }
      }
      touched.push({ result, person, existing: !!item.nativeId });
    } catch (_) { /* A row touched before failure remains uncertain. */ }
  }
  if (results.some(result => result.outcome === 'unknown')) {
    try { contacts.save(); } catch (_) { return JSON.stringify(results); }
  }
  for (const row of touched) {
    try {
      const id = row.person.id();
      if (id) { row.result.nativeId = id; row.result.outcome = row.existing ? 'updated' : 'created'; }
    } catch (_) { /* Creation has no confirmed identifier until after save. */ }
  }
  return JSON.stringify(results);
})()
`;

export class MacSystemContactsPermissionError extends Error {}

export async function executeMacSystemContactsCommand(
  command: Pick<contract.NativeInputHandoffCommand, "method" | "payload">,
  signal: AbortSignal,
  run: (script: string, signal: AbortSignal) => Promise<unknown> = runContactsScript
): Promise<Uint8Array> {
  if (command.payload.byteLength > 65_536) throw invalid();
  if (command.method === Method.READ_SYSTEM_CONTACTS) {
    const request = fromBinary(contract.NativeSystemContactsReadRequestSchema, command.payload);
    if (request.nameContains.length > 100 || request.nameContains.includes("\0")) throw invalid();
    const filter = { nameContains: request.nameContains.normalize("NFKC").toLowerCase(), requireEmail: request.requireEmail };
    const output = await run(contactsScript(READ_SCRIPT, filter), signal);
    return toBinary(contract.NativeSystemContactsReadResponseSchema, create(contract.NativeSystemContactsReadResponseSchema, {
      cards: array(output, 2_001).map(readCard)
    }));
  }
  if (command.method !== Method.WRITE_SYSTEM_CONTACTS) throw invalid();
  const request = fromBinary(contract.NativeSystemContactsWriteRequestSchema, command.payload);
  if (request.items.length === 0 || request.items.length > 200 || new Set(request.items.map(item => item.contactId)).size !== request.items.length) throw invalid();
  const items = request.items.map(writeItem);
  const output = await run(contactsScript(WRITE_SCRIPT, items), signal);
  const receipts = array(output, items.length);
  if (receipts.length !== items.length) throw invalid();
  return toBinary(contract.NativeSystemContactsWriteResponseSchema, create(contract.NativeSystemContactsWriteResponseSchema, {
    receipts: receipts.map((receipt, index) => writeReceipt(receipt, items[index]!))
  }));
}

function readCard(value: unknown): Omit<contract.NativeSystemContactCard, "$typeName"> {
  const row = record(value);
  const addresses = (items: unknown): contract.NativeSystemContactAddress[] => array(items, 10_000).flatMap(item => {
    const address = record(item), value = nativeText(address["value"]);
    const label = nativeText(address["label"]).replace(/^_\$!<(.+)>!\$_$/u, "$1").toLowerCase();
    return value ? [create(contract.NativeSystemContactAddressSchema, { value, label })] : [];
  });
  return {
    nativeId: nativeText(row["nativeId"]),
    fields: create(contract.NativeSystemContactFieldsSchema, {
      kind: row["company"] === true ? contract.ContactKind.ORGANIZATION : contract.ContactKind.PERSON,
      displayName: nativeText(row["name"]), organizationName: nativeText(row["organization"]), title: nativeText(row["title"]),
      emails: addresses(row["emails"]), phones: addresses(row["phones"])
    }),
    note: nativeText(row["note"])
  };
}

function writeItem(item: contract.NativeSystemContactWriteItem) {
  const fields = item.fields;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(item.contactId) || fields === undefined
    || item.nativeId !== undefined && !validText(item.nativeId, 512, true)
    || fields.kind !== contract.ContactKind.PERSON && fields.kind !== contract.ContactKind.ORGANIZATION
    || !validText(fields.displayName, 100, true) || !validText(fields.organizationName, 100) || !validText(fields.title, 1_000)
    || fields.emails.length + fields.phones.length > 30) throw invalid();
  const address = ({ value, label }: contract.NativeSystemContactAddress) => {
    if (!validText(value, 320, true) || !validText(label, 100)) throw invalid();
    return { value, label };
  };
  return { contactId: item.contactId, nativeId: item.nativeId, fields: {
    displayName: fields.displayName, kind: fields.kind, organizationName: fields.organizationName, title: fields.title,
    emails: fields.emails.map(address), phones: fields.phones.map(address)
  } };
}

function writeReceipt(value: unknown, item: ReturnType<typeof writeItem>): Omit<contract.NativeSystemContactWriteReceipt, "$typeName"> {
  const row = record(value);
  if (row["contactId"] !== item.contactId) throw invalid();
  const outcome = row["outcome"], nativeId = row["nativeId"];
  if (outcome === "created" && item.nativeId === undefined && validText(nativeId, 512, true)) {
    return { contactId: item.contactId, outcome: Outcome.CREATED, nativeId };
  }
  if (outcome === "updated" && item.nativeId !== undefined && nativeId === item.nativeId) {
    return { contactId: item.contactId, outcome: Outcome.UPDATED, nativeId: item.nativeId };
  }
  if (outcome === "missing" && item.nativeId !== undefined) return { contactId: item.contactId, outcome: Outcome.MISSING };
  return { contactId: item.contactId, outcome: outcome === "failed" ? Outcome.FAILED : Outcome.UNKNOWN };
}

function contactsScript(script: string, input: unknown): string {
  const literal = JSON.stringify(JSON.stringify(input)).replace(/\u2028/gu, "\\u2028").replace(/\u2029/gu, "\\u2029");
  return `const input = JSON.parse(${literal});\n${script}`;
}

async function runContactsScript(script: string, signal: AbortSignal): Promise<unknown> {
  if (process.platform !== "darwin") throw invalid();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(MAX_SCRIPT_RUNTIME_MS)]);
  deadline.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-"], { signal: deadline, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let bytes = 0, stderr = "", failed = false;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= MAX_RESPONSE_BYTES) stdout.push(chunk);
      else { failed = true; child.kill(); }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-1_024); });
    child.on("error", () => { failed = true; });
    child.stdin.on("error", () => { failed = true; });
    child.on("close", (code) => {
      try {
        deadline.throwIfAborted();
        if (code !== 0 && /\(-1743\)/u.test(stderr)) throw new MacSystemContactsPermissionError();
        if (failed || code !== 0) throw invalid();
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")) as unknown);
      } catch (error) { reject(error); }
    });
    child.stdin.end(script);
  });
}

function array(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw invalid();
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function nativeText(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function validText(value: unknown, max: number, required = false): value is string {
  return typeof value === "string" && (!required || value.length > 0) && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}
function invalid(): Error { return new Error("The macOS Contacts command could not be completed."); }
