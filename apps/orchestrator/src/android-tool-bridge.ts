import {
  AndroidToolProvider,
  type AndroidToolCallResult,
  type AndroidToolDescriptor
} from "@joko/tool-android";

import type {
  BridgeToolCallContext,
  BridgeToolProvider,
  McpCallResult,
  McpToolDescriptor,
  BridgeToolCallResult,
  McpResultArtifactStore
} from "./mcp-router.js";
import { operationBodyHash, type OperationalStore } from "@joko/store";
import type { BlobRef } from "@joko/core";

export const ANDROID_BRIDGE_PROVIDER_ID = "joko_android";

const CATEGORY = "android";
const LIST_TOOLS_NAME = "list_tools";
const CALL_TOOL_NAME = "call_tool";
const WORKFLOW = "Start with status or list_devices. Use get_device_state before tap/swipe/input_text/press_key/launch_app. Re-read get_device_state after each action to verify results.";
const XML_RECEIPT_KIND = "android_ui_xml_capture";
const XML_PAGE_LIMIT = 16 * 1024;

export interface AndroidXmlArtifactPort extends McpResultArtifactStore {
  readBlob(blob: BlobRef): Promise<{ readonly data: Uint8Array; readonly mimeType: string }>;
}
interface XmlScope { readonly sessionId: string; readonly targetId: string; readonly generation: number; readonly providerGeneration: number }
interface XmlReceipt { readonly format: 1; readonly scope: XmlScope; readonly blob: BlobRef }

const BRIDGE_TOOLS: readonly McpToolDescriptor[] = Object.freeze([
  {
    serverId: ANDROID_BRIDGE_PROVIDER_ID,
    name: LIST_TOOLS_NAME,
    description: "Discover Android adb automation tools. Use list_tools first, then call_tool with validated args.",
    inputSchema: objectSchema({
      category: {
        type: "string",
        enum: [CATEGORY],
        description: "Tool category. Omit to list categories overview."
      }
    }),
    requiresPermission: true
  },
  {
    serverId: ANDROID_BRIDGE_PROVIDER_ID,
    name: CALL_TOOL_NAME,
    description: "Invoke one Android adb automation tool. Arguments are validated before dispatching to the host.",
    inputSchema: objectSchema({
      name: { type: "string", description: "Tool name from list_tools" },
      args: {
        type: "object",
        description: "Arguments object for the selected tool (pass the JSON object itself, not a serialized string)",
        additionalProperties: {}
      }
    }, ["name", "args"]),
    requiresPermission: true
  }
]);

/**
 * Exposes the two-entry discovery/dispatch surface through the authenticated
 * Pi bridge. The action catalog remains private to this provider generation,
 * and the durable feature switch is sampled only for new Session snapshots.
 */
export class AndroidToolBridgeProvider implements BridgeToolProvider {
  readonly id = ANDROID_BRIDGE_PROVIDER_ID;
  readonly generation = 1;
  readonly tools = BRIDGE_TOOLS;
  readonly #provider: () => AndroidToolProvider;
  readonly #enabledForNewSessions: () => boolean;
  readonly #catalog: readonly AndroidToolDescriptor[];
  readonly #store: OperationalStore | undefined;
  readonly #artifacts: AndroidXmlArtifactPort | undefined;
  readonly #redactXml: (value: string) => string;

  constructor(input: {
    readonly provider: () => AndroidToolProvider;
    readonly enabledForNewSessions: () => boolean;
    readonly store?: OperationalStore;
    readonly artifacts?: AndroidXmlArtifactPort;
    readonly redactXml?: (value: string) => string;
  }) {
    this.#provider = input.provider;
    this.#enabledForNewSessions = input.enabledForNewSessions;
    this.#store = input.store;
    this.#artifacts = input.artifacts;
    this.#redactXml = input.redactXml ?? ((value) => value);
    this.#catalog = Object.freeze(input.provider().listTools().map((tool) => tool.name !== "get_device_state" ? tool : {
      ...tool, description: `${tool.description} To read a previously returned complete XML Artifact, pass only xml_artifact_id and optional xml_offset/xml_limit. This branch reads no device state. Offsets and limits are UTF-16 code units; pages never split a surrogate pair.`,
      inputSchema: { ...tool.inputSchema, properties: {
        ...(tool.inputSchema["properties"] as Record<string, unknown>),
        xml_artifact_id: { type: "string", minLength: 1, maxLength: 512 },
        xml_offset: { type: "integer", minimum: 0, maximum: 10 * 1024 * 1024 },
        xml_limit: { type: "integer", minimum: 1, maximum: XML_PAGE_LIMIT }
      } }
    }));
    if (this.#catalog.length !== 8) throw new Error("Android automation must expose exactly eight actions.");
  }

  get available(): boolean {
    return true;
  }

  get includeInSnapshot(): boolean {
    return this.#enabledForNewSessions();
  }

  async callTool(
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    context: BridgeToolCallContext
  ): Promise<McpCallResult> {
    if (name === LIST_TOOLS_NAME) return this.#listTools(arguments_);
    if (name === CALL_TOOL_NAME) return this.#callSelectedTool(arguments_, signal, context);
    throw new Error("Android automation bridge tool is not part of this generation.");
  }

  closeSession(sessionId: string): void {
    this.#provider().closeSession(sessionId);
  }

  #listTools(arguments_: Readonly<Record<string, unknown>>): McpCallResult {
    if (!hasOnlyKeys(arguments_, ["category"])) {
      return invalidArgumentsResult(LIST_TOOLS_NAME, [validationIssue([], "unrecognized_keys", "Unsupported list_tools argument.")], BRIDGE_TOOLS[0]?.inputSchema);
    }
    const category = arguments_["category"];
    if (category !== undefined && category !== CATEGORY) {
      return invalidArgumentsResult(LIST_TOOLS_NAME, [validationIssue(["category"], "invalid_value", "Expected android.")], BRIDGE_TOOLS[0]?.inputSchema);
    }
    if (category === CATEGORY) {
      return textResult({
        ok: true,
        category: CATEGORY,
        tools: this.#catalog.map((tool) => ({
          name: tool.name,
          category: CATEGORY,
          description: tool.description,
          readOnly: tool.annotations.readOnlyHint
        })),
        workflow: WORKFLOW
      });
    }
    return textResult({
      ok: true,
      categories: [{ name: CATEGORY, tool_count: this.#catalog.length }],
      hint: "Use list_tools({category:\"android\"}) to inspect the Android tool list."
    });
  }

  async #callSelectedTool(
    arguments_: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    context: BridgeToolCallContext
  ): Promise<BridgeToolCallResult> {
    const outerSchema = BRIDGE_TOOLS[1]?.inputSchema;
    if (!hasOnlyKeys(arguments_, ["name", "args"])) {
      return invalidArgumentsResult(CALL_TOOL_NAME, [validationIssue([], "unrecognized_keys", "Unsupported call_tool argument.")], outerSchema);
    }
    const selectedName = arguments_["name"];
    if (typeof selectedName !== "string") {
      return invalidArgumentsResult(CALL_TOOL_NAME, [validationIssue(["name"], "invalid_type", "Expected a tool name string.")], outerSchema);
    }
    const selected = this.#catalog.find((tool) => tool.name === selectedName);
    if (selected === undefined) return unknownToolResult(selectedName, this.#catalog);

    const selectedArguments = coerceObjectArgument(arguments_["args"]);
    if (!isRecord(selectedArguments)) {
      return invalidArgumentsResult(selectedName, [validationIssue(["args"], "invalid_type", "Expected an arguments object.")], selected.inputSchema);
    }
    const issues = validateSchema(selectedArguments, selected.inputSchema);
    if (issues.length > 0) return invalidArgumentsResult(selectedName, issues, selected.inputSchema);
    if (selected.name === "get_device_state" && selectedArguments["xml_artifact_id"] !== undefined) {
      if (!hasOnlyKeys(selectedArguments, ["xml_artifact_id", "xml_offset", "xml_limit"])) return textResult({ ok: false, errorCode: "INVALID_ARGS" }, true);
      return this.#readXml(selectedArguments, context, signal);
    }
    if (selectedArguments["xml_offset"] !== undefined || selectedArguments["xml_limit"] !== undefined) return textResult({ ok: false, errorCode: "INVALID_ARGS" }, true);

    const provider = this.#provider();
    const result = await provider.callTool(
      context.sessionId,
      selected.name,
      selectedArguments,
      signal
    );
    const mapped = mapToolResult(result);
    if (result.rawUiXml === undefined || selected.name !== "get_device_state") return mapped;
    const store = this.#store;
    const artifacts = this.#artifacts;
    if (store === undefined || artifacts === undefined) return textResult({ ok: false, errorCode: "ARTIFACT_UNAVAILABLE" }, true);
    const guard = (): void => {
      signal?.throwIfAborted();
      const session = store.getSession(context.sessionId).descriptor;
      if (this.#provider() !== provider || session.targetId !== context.targetId
        || session.binding.generation !== context.generation || session.archived || session.deletedAt !== undefined
        || store.findPendingSessionLifecycleCleanup(context.sessionId) !== undefined) throw new Error("Android XML task owner is no longer active.");
    };
    guard();
    const safeXml = this.#redactXml(result.rawUiXml);
    const bytes = Buffer.from(safeXml, "utf8");
    if (bytes.byteLength < 1 || bytes.byteLength > Math.min(10 * 1024 * 1024, artifacts.maximumBlobBytes)) {
      return textResult({ ok: false, errorCode: "UI_XML_TOO_LARGE" }, true);
    }
    const blob = await artifacts.ingestBytes(bytes, { fileName: "android-ui.xml", mimeType: "application/xml" });
    guard();
    const scope = this.#xmlScope(context);
    const receipt: XmlReceipt = { format: 1, scope, blob: { id: blob.id, sha256: blob.sha256,
      byteLength: blob.byteLength, mimeType: blob.mimeType } };
    store.runOperation({ id: xmlReceiptId(scope, blob.id), kind: XML_RECEIPT_KIND, body: receipt }, () => { guard(); return receipt; });
    guard();
    const xml = { type: "text", text: `Complete Android UI XML:\n${safeXml}` } as const;
    const inlined = Buffer.byteLength(JSON.stringify([...mapped.content, xml]), "utf8") <= 480 * 1024;
    return { ...mapped,
      content: [...mapped.content, ...(inlined ? [xml] : []), { type: "text", text: JSON.stringify({
        raw_ui_dump_artifact: { id: blob.id, sha256: blob.sha256, byteLength: blob.byteLength, mimeType: blob.mimeType },
        xml_complete: true, xml_model_readable: true, xml_inline_complete: inlined, xml_inline_truncated: !inlined,
        xml_read_hint: { name: "get_device_state", args: { xml_artifact_id: blob.id, xml_offset: 0, xml_limit: XML_PAGE_LIMIT },
          offset_kind: "utf16", page_limit: XML_PAGE_LIMIT }
      }) }],
      hostArtifacts: [{ blob, label: "Complete Android UI XML" }]
    };
  }

  #xmlScope(context: BridgeToolCallContext): XmlScope {
    if (context.providerGeneration !== undefined && context.providerGeneration !== this.generation) throw new Error("Android XML Provider generation is stale.");
    return { sessionId: context.sessionId, targetId: context.targetId, generation: context.generation, providerGeneration: this.generation };
  }

  async #readXml(args: Readonly<Record<string, unknown>>, context: BridgeToolCallContext, signal?: AbortSignal): Promise<McpCallResult> {
    try {
      const store = this.#store;
      const artifacts = this.#artifacts;
      if (store === undefined || artifacts === undefined) throw new Error("unavailable");
      const scope = this.#xmlScope(context);
      const guard = (): void => {
        signal?.throwIfAborted();
        const session = store.getSession(scope.sessionId).descriptor;
        this.#xmlScope(context);
        if (session.targetId !== scope.targetId || session.binding.generation !== scope.generation
          || session.archived || session.deletedAt !== undefined || store.findPendingSessionLifecycleCleanup(scope.sessionId) !== undefined) throw new Error("retired");
      };
      guard();
      const id = args["xml_artifact_id"] as string;
      const operation = store.findOperation<XmlReceipt>(xmlReceiptId(scope, id));
      const receipt = operation?.response;
      if (operation?.status !== "completed" || operation.kind !== XML_RECEIPT_KIND || receipt?.format !== 1
        || operationBodyHash(receipt.scope) !== operationBodyHash(scope) || receipt.blob.id !== id
        || receipt.blob.mimeType !== "application/xml" || receipt.blob.byteLength < 1 || receipt.blob.byteLength > 10 * 1024 * 1024
        || operation.bodyHash !== operationBodyHash(receipt)) throw new Error("unavailable");
      const read = await artifacts.readBlob(receipt.blob);
      guard();
      if (read.mimeType !== receipt.blob.mimeType || read.data.byteLength !== receipt.blob.byteLength) throw new Error("unavailable");
      const xml = new TextDecoder("utf-8", { fatal: true }).decode(read.data);
      const offset = (args["xml_offset"] as number | undefined) ?? 0;
      const limit = (args["xml_limit"] as number | undefined) ?? XML_PAGE_LIMIT;
      if (offset > xml.length || splitsSurrogate(xml, offset)) return textResult({ ok: false, errorCode: "INVALID_XML_RANGE" }, true);
      let end = Math.min(xml.length, offset + limit);
      if (splitsSurrogate(xml, end)) end -= 1;
      if (end === offset && offset < xml.length) return textResult({ ok: false, errorCode: "INVALID_XML_RANGE" }, true);
      guard();
      return textResult({ ok: true, data: { xml_artifact_id: id, xml_sha256: receipt.blob.sha256,
        xml_byte_length: receipt.blob.byteLength, xml_offset: offset, xml_offset_kind: "utf16",
        xml_text: xml.slice(offset, end), next_xml_offset: end, xml_eof: end === xml.length } });
    } catch (error) {
      if (signal?.aborted === true) throw error;
      return textResult({ ok: false, errorCode: "UI_XML_UNAVAILABLE" }, true);
    }
  }
}

function xmlReceiptId(scope: XmlScope, artifactId: string): string {
  return `android-ui-xml:${operationBodyHash({ ...scope, artifactId })}`;
}
function splitsSurrogate(value: string, offset: number): boolean {
  return offset > 0 && offset < value.length && value.charCodeAt(offset - 1) >= 0xd800
    && value.charCodeAt(offset - 1) <= 0xdbff && value.charCodeAt(offset) >= 0xdc00 && value.charCodeAt(offset) <= 0xdfff;
}

interface ValidationIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
}

function textResult(value: unknown, isError = false): McpCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError
  };
}

function unknownToolResult(
  requested: string,
  catalog: readonly AndroidToolDescriptor[]
): McpCallResult {
  return textResult({
    ok: false,
    errorCode: "UNKNOWN_TOOL",
    data: {
      message: "Android automation tool is unavailable.",
      requested,
      available: catalog.map((tool) => tool.name),
      hint: "Use list_tools to inspect the Android tool list."
    }
  }, true);
}

function invalidArgumentsResult(
  tool: string,
  issues: readonly ValidationIssue[],
  schema: Readonly<Record<string, unknown>> | undefined
): McpCallResult {
  return textResult({
    ok: false,
    errorCode: "INVALID_ARGS",
    data: {
      message: "Android tool arguments are invalid.",
      tool,
      validation_errors: issues,
      schema: schema ?? objectSchema({}),
      hint: "Use list_tools and retry with arguments that match the selected tool."
    }
  }, true);
}

function mapToolResult(result: AndroidToolCallResult): McpCallResult {
  return {
    content: result.content.map((item) => item.type === "image"
      ? { type: "image", data: item.data, mimeType: item.mimeType }
      : { type: "text", text: item.text }),
    isError: result.isError === true
  };
}

function coerceObjectArgument(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function validateSchema(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  path: readonly (string | number)[] = []
): readonly ValidationIssue[] {
  if (schema["type"] === "object") {
    if (!isRecord(value)) return [validationIssue(path, "invalid_type", "Expected an object.")];
    const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
    const required = Array.isArray(schema["required"])
      ? schema["required"].filter((item): item is string => typeof item === "string")
      : [];
    const issues: ValidationIssue[] = [];
    for (const key of required) {
      if (!(key in value)) issues.push(validationIssue([...path, key], "invalid_type", "Required argument is missing."));
    }
    if (schema["additionalProperties"] === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) issues.push(validationIssue([...path, key], "unrecognized_keys", "Argument is not supported."));
      }
    }
    for (const [key, item] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (isRecord(propertySchema)) issues.push(...validateSchema(item, propertySchema, [...path, key]));
    }
    return issues;
  }
  if (schema["type"] === "string") {
    if (typeof value !== "string") return [validationIssue(path, "invalid_type", "Expected a string.")];
    if (typeof schema["minLength"] === "number" && value.length < schema["minLength"]) {
      return [validationIssue(path, "too_small", "String is shorter than allowed.")];
    }
    if (typeof schema["maxLength"] === "number" && value.length > schema["maxLength"]) {
      return [validationIssue(path, "too_big", "String is longer than allowed.")];
    }
    if (Array.isArray(schema["enum"]) && !schema["enum"].includes(value)) {
      return [validationIssue(path, "invalid_value", "String is not one of the allowed values.")];
    }
    return [];
  }
  if (schema["type"] === "integer") {
    if (!Number.isSafeInteger(value)) return [validationIssue(path, "invalid_type", "Expected an integer.")];
    const number = value as number;
    if (typeof schema["minimum"] === "number" && number < schema["minimum"]) {
      return [validationIssue(path, "too_small", "Integer is smaller than allowed.")];
    }
    if (typeof schema["maximum"] === "number" && number > schema["maximum"]) {
      return [validationIssue(path, "too_big", "Integer is larger than allowed.")];
    }
  }
  return [];
}

function validationIssue(
  path: readonly (string | number)[],
  code: string,
  message: string
): ValidationIssue {
  return { path, code, message };
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = []
): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
