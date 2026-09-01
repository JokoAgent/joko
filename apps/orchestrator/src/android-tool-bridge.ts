import {
  AndroidToolProvider,
  type AndroidToolCallResult,
  type AndroidToolDescriptor
} from "@joko/tool-android";

import type {
  BridgeToolCallContext,
  BridgeToolProvider,
  McpCallResult,
  McpToolDescriptor
} from "./mcp-router.js";

export const ANDROID_BRIDGE_PROVIDER_ID = "joko_android";

const CATEGORY = "android";
const LIST_TOOLS_NAME = "list_tools";
const CALL_TOOL_NAME = "call_tool";
const WORKFLOW = "Start with status or list_devices. Use get_device_state before tap/swipe/input_text/press_key/launch_app. Re-read get_device_state after each action to verify results.";

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
        description: "Arguments object for the selected tool（传 JSON 对象本身，不要序列化成字符串）",
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

  constructor(input: {
    readonly provider: () => AndroidToolProvider;
    readonly enabledForNewSessions: () => boolean;
  }) {
    this.#provider = input.provider;
    this.#enabledForNewSessions = input.enabledForNewSessions;
    this.#catalog = Object.freeze([...input.provider().listTools()]);
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
  ): Promise<McpCallResult> {
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

    return mapToolResult(await this.#provider().callTool(
      context.sessionId,
      selected.name,
      selectedArguments,
      signal
    ));
  }
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
