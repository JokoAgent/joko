import type {
  BackendToolDescriptor,
  DynamicInputField,
  DynamicInputFieldConstraints,
  DynamicInputFieldType,
  DynamicInputSchema
} from "@joko/core";

import { piError } from "./errors.js";

interface PiToolDefinitionShape {
  readonly name?: unknown;
  readonly label?: unknown;
  readonly description?: unknown;
  readonly parameters?: unknown;
}

interface BuiltInFactory {
  readonly exportName:
    | "createReadToolDefinition"
    | "createBashToolDefinition"
    | "createEditToolDefinition"
    | "createWriteToolDefinition"
    | "createGrepToolDefinition"
    | "createFindToolDefinition"
    | "createLsToolDefinition";
  readonly expectedName: string;
  readonly requiresPermission: boolean;
  readonly streamingUpdates: boolean;
}

const BUILTIN_FACTORIES: readonly BuiltInFactory[] = [
  { exportName: "createReadToolDefinition", expectedName: "read", requiresPermission: false, streamingUpdates: false },
  { exportName: "createBashToolDefinition", expectedName: "bash", requiresPermission: true, streamingUpdates: true },
  { exportName: "createEditToolDefinition", expectedName: "edit", requiresPermission: true, streamingUpdates: false },
  { exportName: "createWriteToolDefinition", expectedName: "write", requiresPermission: true, streamingUpdates: false },
  { exportName: "createGrepToolDefinition", expectedName: "grep", requiresPermission: false, streamingUpdates: false },
  { exportName: "createFindToolDefinition", expectedName: "find", requiresPermission: false, streamingUpdates: false },
  { exportName: "createLsToolDefinition", expectedName: "ls", requiresPermission: false, streamingUpdates: false }
];

const DEFAULT_ENABLED_TOOLS = new Set(["read", "bash", "edit", "write"]);
const TOOL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SECRET_FIELD = /(?:secret|password|token|credential|api[_-]?key)/iu;

type SchemaTraversalTask =
  | {
      readonly kind: "object";
      readonly schema: Readonly<Record<string, unknown>>;
      readonly prefix: string;
    }
  | {
      readonly kind: "property";
      readonly name: string;
      readonly rawProperty: unknown;
      readonly prefix: string;
      readonly required: ReadonlySet<string>;
    }
  | {
      readonly kind: "array";
      readonly schema: Readonly<Record<string, unknown>>;
      readonly path: string;
    }
  | {
      readonly kind: "array_item";
      readonly item: Readonly<Record<string, unknown>>;
      readonly path: string;
    }
  | {
      readonly kind: "leave";
      readonly schema: Readonly<Record<string, unknown>>;
    };

/**
 * Enumerates definitions from the installed Pi package instead of copying a
 * release-specific schema into Joko. Pi types are consumed only through a
 * narrow structural boundary and never escape into @joko/core.
 */
export async function loadPiBuiltInToolCatalog(input: {
  readonly cwd: string;
  readonly enabledToolNames?: readonly string[];
}): Promise<readonly BackendToolDescriptor[]> {
  const runtime = await import("@earendil-works/pi-coding-agent") as Readonly<Record<string, unknown>>;
  const enabled = input.enabledToolNames === undefined
    ? DEFAULT_ENABLED_TOOLS
    : new Set(input.enabledToolNames);
  const tools: BackendToolDescriptor[] = [];
  const seen = new Set<string>();

  for (const metadata of BUILTIN_FACTORIES) {
    const candidate = runtime[metadata.exportName];
    if (typeof candidate !== "function") {
      throw catalogError(`Installed Pi does not export ${metadata.exportName}.`);
    }
    let raw: unknown;
    try {
      raw = candidate(input.cwd);
    } catch (error) {
      throw catalogError(`Installed Pi failed to construct its ${metadata.expectedName} tool definition.`, error);
    }
    const definition = toolDefinition(raw, metadata.exportName);
    const name = safeToolId(definition.name, `${metadata.exportName}.name`);
    if (name !== metadata.expectedName) {
      throw catalogError(`Installed Pi returned a mismatched ${metadata.exportName} tool identity.`);
    }
    if (seen.has(name)) throw catalogError(`Installed Pi returned duplicate built-in tool '${name}'.`);
    seen.add(name);
    tools.push({
      toolId: name,
      name,
      displayName: displayText(definition.label, name, `${name}.label`),
      description: requiredText(definition.description, `${name}.description`, 16_384),
      inputSchema: projectPiInputSchema(definition.parameters, name),
      // Pi exposes schemas and execution functions, but no fixed permission
      // flag. These hints apply Joko's host risk classifier: filesystem reads
      // are normally safe, while command execution and mutation are gated.
      requiresPermission: metadata.requiresPermission,
      streamingUpdates: metadata.streamingUpdates,
      enabled: enabled.has(name)
    });
  }
  return tools;
}

export function projectPiInputSchema(raw: unknown, toolName: string): DynamicInputSchema {
  const schema = record(raw, `${toolName}.parameters`);
  if (schema["type"] !== "object") throw catalogError(`Pi tool '${toolName}' parameters must be an object schema.`);
  const fields: DynamicInputField[] = [];
  const active = new Set<Readonly<Record<string, unknown>>>();
  const tasks: SchemaTraversalTask[] = [{ kind: "object", schema, prefix: "" }];
  while (tasks.length > 0) {
    const task = tasks.pop()!;
    if (task.kind === "leave") {
      active.delete(task.schema);
      continue;
    }
    if (task.kind === "object") {
      enterSchema(task.schema, active);
      tasks.push({ kind: "leave", schema: task.schema });
      const properties = task.schema["properties"] === undefined
        ? {}
        : record(task.schema["properties"], `${task.prefix || "parameters"}.properties`);
      const required = new Set(Array.isArray(task.schema["required"])
        ? task.schema["required"].map((value) => schemaText(value, "schema.required"))
        : []);
      const entries = Object.entries(properties).sort(([left], [right]) => left.localeCompare(right, "en"));
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [name, rawProperty] = entries[index]!;
        tasks.push({ kind: "property", name, rawProperty, prefix: task.prefix, required });
      }
      continue;
    }
    if (task.kind === "array") {
      enterSchema(task.schema, active);
      tasks.push({ kind: "leave", schema: task.schema });
      const rawItems = task.schema["items"];
      if (rawItems !== undefined) {
        tasks.push({
          kind: "array_item",
          item: record(rawItems, `${task.path}.items`),
          path: task.path
        });
      }
      continue;
    }
    if (task.kind === "property") {
      const property = record(task.rawProperty, `${task.prefix}${task.name}`);
      const path = task.prefix === "" ? task.name : `${task.prefix}.${task.name}`;
      const type = schemaFieldType(property, path);
      fields.push(projectSchemaField(
        property,
        path,
        type,
        task.required.has(task.name),
        humanize(task.name),
        SECRET_FIELD.test(task.name)
      ));
      if (type === "object") tasks.push({ kind: "object", schema: property, prefix: path });
      if (type === "array") tasks.push({ kind: "array", schema: property, path });
      continue;
    }

    const itemPath = `${task.path}[]`;
    const type = schemaFieldType(task.item, itemPath);
    fields.push(projectSchemaField(
      task.item,
      itemPath,
      type,
      true,
      `${humanize(task.path.split(".").at(-1) ?? task.path)} item`,
      SECRET_FIELD.test(task.path)
    ));
    if (type === "object") tasks.push({ kind: "object", schema: task.item, prefix: itemPath });
    if (type === "array") tasks.push({ kind: "array", schema: task.item, path: itemPath });
  }
  return {
    fields,
    allowsAdditionalFields: schema["additionalProperties"] !== false
  };
}

function enterSchema(
  schema: Readonly<Record<string, unknown>>,
  active: Set<Readonly<Record<string, unknown>>>
): void {
  if (active.has(schema)) throw catalogError("Pi tool input schema contains a cyclic object graph.");
  active.add(schema);
}

function projectSchemaField(
  schema: Readonly<Record<string, unknown>>,
  path: string,
  type: DynamicInputFieldType,
  required: boolean,
  fallbackTitle: string,
  secretName: boolean
): DynamicInputField {
  const constraints = fieldConstraints(schema, type, path);
  return {
    fieldPath: path,
    title: schemaDisplayText(schema["title"], fallbackTitle, `${path}.title`),
    description: optionalSchemaText(schema["description"], `${path}.description`) ?? "",
    type,
    required,
    secret: schema["writeOnly"] === true || secretName,
    enumValues: stringEnum(schema, path),
    ...(constraints === undefined ? {} : { constraints })
  };
}

function fieldConstraints(
  schema: Readonly<Record<string, unknown>>,
  type: DynamicInputFieldType,
  fieldPath: string
): DynamicInputFieldConstraints | undefined {
  const minimumLength = optionalUInt32(schema["minLength"], `${fieldPath}.minLength`);
  const maximumLength = optionalUInt32(schema["maxLength"], `${fieldPath}.maxLength`);
  if (minimumLength !== undefined && maximumLength !== undefined && minimumLength > maximumLength) {
    throw catalogError(`Pi tool field '${fieldPath}' has inverted length constraints.`);
  }
  const minimumNumber = optionalFiniteNumber(schema["minimum"], `${fieldPath}.minimum`);
  const maximumNumber = optionalFiniteNumber(schema["maximum"], `${fieldPath}.maximum`);
  if (minimumNumber !== undefined && maximumNumber !== undefined && minimumNumber > maximumNumber) {
    throw catalogError(`Pi tool field '${fieldPath}' has inverted numeric constraints.`);
  }
  const pattern = optionalSchemaText(schema["pattern"], `${fieldPath}.pattern`);
  const value: DynamicInputFieldConstraints = {
    ...(minimumLength === undefined ? {} : { minimumLength }),
    ...(maximumLength === undefined ? {} : { maximumLength }),
    ...(minimumNumber === undefined ? {} : { minimumNumber }),
    ...(maximumNumber === undefined ? {} : { maximumNumber }),
    ...(pattern === undefined ? {} : { pattern }),
    ...(type === "array" ? { itemFieldPath: `${fieldPath}[]` } : {})
  };
  return Object.keys(value).length === 0 ? undefined : value;
}

function schemaFieldType(schema: Readonly<Record<string, unknown>>, fieldPath: string): DynamicInputFieldType {
  if (schema["contentEncoding"] === "base64") return "blob";
  const value = schema["type"];
  if (value === "string" || value === "number" || value === "integer" || value === "boolean" || value === "object" || value === "array") {
    return value;
  }
  if (literalStringUnion(schema["anyOf"], fieldPath) !== undefined) return "string";
  throw catalogError(`Pi tool field '${fieldPath}' uses an unsupported schema type.`);
}

function stringEnum(schema: Readonly<Record<string, unknown>>, fieldPath: string): readonly string[] {
  const value = schema["enum"];
  const literalUnion = literalStringUnion(schema["anyOf"], fieldPath);
  if (literalUnion !== undefined) return literalUnion;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw catalogError(`Pi tool field '${fieldPath}' contains a non-string enum.`);
  }
  return [...new Set(value)];
}

function literalStringUnion(value: unknown, fieldPath: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const values: string[] = [];
  for (const [index, candidate] of value.entries()) {
    const branch = record(candidate, `${fieldPath}.anyOf[${index}]`);
    if (typeof branch["const"] !== "string" || (branch["type"] !== undefined && branch["type"] !== "string")) return undefined;
    values.push(branch["const"]);
  }
  return [...new Set(values)];
}

function toolDefinition(value: unknown, source: string): PiToolDefinitionShape {
  const result = record(value, source);
  return {
    name: result["name"],
    label: result["label"],
    description: result["description"],
    parameters: result["parameters"]
  };
}

function record(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw catalogError(`Installed Pi returned an invalid ${field} object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function safeToolId(value: unknown, field: string): string {
  if (typeof value !== "string" || !TOOL_ID.test(value)) throw catalogError(`Installed Pi returned an invalid ${field}.`);
  return value;
}

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum || /[\u0000\u007f]/u.test(value)) {
    throw catalogError(`Installed Pi returned invalid text for ${field}.`);
  }
  return value;
}

function optionalText(value: unknown, field: string, maximum: number): string | undefined {
  return value === undefined ? undefined : requiredText(value, field, maximum);
}

function displayText(value: unknown, fallback: string, field: string): string {
  return value === undefined ? fallback : requiredText(value, field, 256);
}

function schemaDisplayText(value: unknown, fallback: string, field: string): string {
  return value === undefined ? fallback : schemaText(value, field);
}

function optionalSchemaText(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : schemaText(value, field);
}

function schemaText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || /[\u0000\u007f]/u.test(value)) {
    throw catalogError(`Installed Pi returned invalid text for ${field}.`);
  }
  return value;
}

function optionalUInt32(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0xffff_ffff) {
    throw catalogError(`Installed Pi returned an invalid ${field}.`);
  }
  return value as number;
}

function optionalFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw catalogError(`Installed Pi returned an invalid ${field}.`);
  return value;
}

function humanize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .replace(/^./u, (character) => character.toLocaleUpperCase("en"));
}

function catalogError(message: string, cause?: unknown): Error {
  return piError("PI_TOOL_CATALOG_INVALID", message, "provision", {
    ...(cause === undefined ? {} : { cause })
  });
}
