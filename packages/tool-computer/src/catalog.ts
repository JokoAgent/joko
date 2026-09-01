import type { ComputerToolDescriptor } from "./provider.js";

export const COMPUTER_TOOL_NAMES = [
  "status",
  "check_permissions",
  "get_accessibility_tree",
  "launch_app",
  "list_apps",
  "list_windows",
  "get_window_state",
  "click",
  "double_click",
  "right_click",
  "drag",
  "type_text",
  "set_value",
  "press_key",
  "hotkey",
  "scroll",
  "zoom",
  "get_screen_size",
  "get_cursor_position",
  "move_cursor",
  "get_agent_cursor_state",
  "start_recording",
  "stop_recording",
  "replay_trajectory"
] as const;

export type ComputerPublicToolName = typeof COMPUTER_TOOL_NAMES[number];

type JsonSchema = Readonly<Record<string, unknown>>;

const stringValue = (description?: string): JsonSchema => ({
  type: "string",
  ...(description === undefined ? {} : { description })
});
const numberValue = (options: {
  integer?: boolean;
  minimum?: number;
  maximum?: number;
  description?: string;
} = {}): JsonSchema => ({
  type: options.integer === true ? "integer" : "number",
  ...(options.minimum === undefined ? {} : { minimum: options.minimum }),
  ...(options.maximum === undefined ? {} : { maximum: options.maximum }),
  ...(options.description === undefined ? {} : { description: options.description })
});
const booleanValue = (): JsonSchema => ({ type: "boolean" });
const stringArray = (minimumItems?: number): JsonSchema => ({
  type: "array",
  items: { type: "string" },
  ...(minimumItems === undefined ? {} : { minItems: minimumItems })
});
const choice = (...values: readonly string[]): JsonSchema => ({ type: "string", enum: values });
const objectSchema = (
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[] = []
): JsonSchema => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties,
  additionalProperties: false,
  ...(required.length === 0 ? {} : { required })
});

const pid = numberValue({ integer: true, minimum: 1 });
const windowId = numberValue({ integer: true, minimum: 0 });
const elementIndex = numberValue({ integer: true, minimum: 0 });
const session = stringValue();
const snapshotId = stringValue(
  "snapshot_id returned by the get_window_state call this element_index comes from. Recommended whenever element_index is used: if the window has been observed again since, the action is rejected with STALE_SNAPSHOT so you can re-observe instead of acting on the wrong element."
);

function tool(
  name: ComputerPublicToolName,
  description: string,
  inputSchema: JsonSchema,
  readOnly = false
): ComputerToolDescriptor {
  return Object.freeze({
    name,
    description,
    inputSchema,
    annotations: Object.freeze({
      readOnlyHint: readOnly,
      destructiveHint: !readOnly,
      idempotentHint: readOnly
    })
  });
}

export const COMPUTER_PUBLIC_TOOLS: readonly ComputerToolDescriptor[] = Object.freeze([
  tool("status", "Check whether the local computer-use driver is installed and callable.", objectSchema({}), true),
  tool(
    "check_permissions",
    "Check OS-level permissions required by cua-driver without opening system permission prompts.",
    objectSchema({ prompt: { type: "boolean", const: false } }),
    true
  ),
  tool(
    "get_accessibility_tree",
    "Return a lightweight desktop snapshot of running apps and visible windows. Use this for fast discovery before heavier per-window inspection.",
    objectSchema({}),
    true
  ),
  tool(
    "launch_app",
    "Launch or locate an application without stealing focus. Prefer this over shell open/Start-Process for GUI apps. If an already-running app such as Simulator is not discoverable here, use list_windows with {\"process_name\":\"Simulator\"}.",
    objectSchema({
      name: stringValue(),
      bundle_id: stringValue(),
      urls: stringArray(),
      electron_debugging_port: numberValue({ integer: true }),
      webkit_inspector_port: numberValue({ integer: true }),
      creates_new_application_instance: booleanValue(),
      additional_arguments: stringArray()
    })
  ),
  tool("list_apps", "List installed and running desktop applications.", objectSchema({}), true),
  tool(
    "list_windows",
    "List known top-level windows. Use before choosing a target window; for example, {\"process_name\":\"Simulator\"}. Hosts may enrich results with process provenance and generic identity hints.",
    objectSchema({
      on_screen_only: booleanValue(),
      pid,
      query: stringValue(),
      workspace_root: stringValue(),
      process_name: stringValue()
    }),
    true
  ),
  tool(
    "get_window_state",
    "Inspect one window and return its accessibility tree/screenshot state. Use {\"capture_mode\":\"vision\"} for a screenshot and normally omit screenshot_out_file so the driver uses its default path. Call before element-indexed actions. The result carries a snapshot_id; pass it to element-indexed actions so actions taken on an outdated view of the window are rejected as STALE_SNAPSHOT instead of hitting the wrong element.",
    objectSchema({
      pid,
      window_id: windowId,
      capture_mode: choice("som", "vision", "ax"),
      query: stringValue(),
      screenshot_out_file: stringValue(),
      session,
      max_elements: numberValue({
        integer: true,
        minimum: 1,
        description: "Maximum number of accessibility tree elements to return. Use to limit context size for complex windows like Chrome."
      }),
      max_depth: numberValue({
        integer: true,
        minimum: 1,
        description: "Maximum depth of the accessibility tree to traverse. Use to limit tree depth for complex windows."
      })
    }, ["pid", "window_id"]),
    true
  ),
  tool(
    "click",
    "Click a target app by element_index+window_id or by window-local coordinates. Always include pid and include window_id for coordinates. Requires a prior get_window_state for element indices.",
    objectSchema({
      pid,
      window_id: windowId,
      element_index: elementIndex,
      x: numberValue(),
      y: numberValue(),
      action: stringValue(),
      count: numberValue({ integer: true, minimum: 1 }),
      modifier: stringArray(),
      from_zoom: booleanValue(),
      debug_image_out: stringValue(),
      snapshot_id: snapshotId,
      session
    }, ["pid"])
  ),
  tool(
    "double_click",
    "Double-click a target element or window-local coordinate. Always include pid and include window_id for coordinates.",
    objectSchema({
      pid,
      window_id: windowId,
      element_index: elementIndex,
      x: numberValue(),
      y: numberValue(),
      snapshot_id: snapshotId,
      session
    }, ["pid"])
  ),
  tool(
    "right_click",
    "Right-click a target element or window-local coordinate. Always include pid and include window_id for coordinates.",
    objectSchema({
      pid,
      window_id: windowId,
      element_index: elementIndex,
      x: numberValue(),
      y: numberValue(),
      modifier: stringArray(),
      snapshot_id: snapshotId,
      session
    }, ["pid"])
  ),
  tool(
    "drag",
    "Drag from one window-local coordinate to another. Use after get_window_state or zoom.",
    objectSchema({
      pid,
      window_id: windowId,
      from_x: numberValue(),
      from_y: numberValue(),
      to_x: numberValue(),
      to_y: numberValue(),
      duration_ms: numberValue({ integer: true, minimum: 0, maximum: 10_000 }),
      steps: numberValue({ integer: true, minimum: 1, maximum: 200 }),
      button: choice("left", "right", "middle"),
      modifier: stringArray(),
      from_zoom: booleanValue(),
      session
    }, ["pid", "from_x", "from_y", "to_x", "to_y"])
  ),
  tool(
    "type_text",
    "Type or set text in the target app. Always include pid and include window_id when targeting a specific window.",
    objectSchema({
      pid,
      text: stringValue(),
      element_index: elementIndex,
      window_id: windowId,
      delay_ms: numberValue({ integer: true, minimum: 0, maximum: 200 }),
      snapshot_id: snapshotId,
      session
    }, ["pid", "text"])
  ),
  tool(
    "set_value",
    "Set a text field value through accessibility. Prefer this for minimized/background text fields when typing cannot commit.",
    objectSchema({
      pid,
      window_id: windowId,
      element_index: elementIndex,
      value: stringValue(),
      snapshot_id: snapshotId,
      session
    }, ["pid", "window_id", "element_index", "value"])
  ),
  tool(
    "press_key",
    "Press a single key in the target app.",
    objectSchema({
      pid,
      key: stringValue(),
      modifiers: stringArray(),
      element_index: elementIndex,
      window_id: windowId,
      snapshot_id: snapshotId,
      session
    }, ["pid", "key"])
  ),
  tool(
    "hotkey",
    "Press a keyboard shortcut in the target app, e.g. [\"cmd\",\"c\"].",
    objectSchema({ pid, keys: stringArray(2), window_id: windowId, session }, ["pid", "keys"])
  ),
  tool(
    "scroll",
    "Scroll a target element or window-local coordinate.",
    objectSchema({
      pid,
      window_id: windowId,
      element_index: elementIndex,
      direction: choice("up", "down", "left", "right"),
      amount: numberValue({ integer: true, minimum: 1, maximum: 50 }),
      by: choice("line", "page"),
      snapshot_id: snapshotId,
      session
    }, ["pid", "direction"])
  ),
  tool(
    "zoom",
    "Capture a zoomed region from a window screenshot for pixel-level targeting. Use screenshot pixel bounds x1,y1,x2,y2.",
    objectSchema({
      pid,
      window_id: windowId,
      x1: numberValue(),
      y1: numberValue(),
      x2: numberValue(),
      y2: numberValue()
    }, ["window_id", "x1", "y1", "x2", "y2"]),
    true
  ),
  tool("get_screen_size", "Return screen dimensions for the current desktop.", objectSchema({}), true),
  tool("get_cursor_position", "Return the current pointer position. Read-only; does not move the cursor.", objectSchema({}), true),
  tool(
    "move_cursor",
    "Move the visible agent cursor overlay to screen coordinates without moving the real mouse pointer.",
    objectSchema({ x: numberValue(), y: numberValue(), cursor_id: stringValue(), session }, ["x", "y"])
  ),
  tool(
    "get_agent_cursor_state",
    "Return the current agent cursor overlay state for this session or cursor id.",
    objectSchema({ cursor_id: stringValue() }),
    true
  ),
  tool(
    "start_recording",
    "Start trajectory recording to an explicit output directory. Records subsequent computer-use action turns for debugging or replay.",
    objectSchema({ output_dir: stringValue(), record_video: booleanValue(), session }, ["output_dir"])
  ),
  tool("stop_recording", "Stop trajectory recording and finalize video output when video recording was enabled.", objectSchema({})),
  tool(
    "replay_trajectory",
    "Replay a previously recorded trajectory directory. Use only when the user explicitly asks to replay/debug a recording.",
    objectSchema({
      dir: stringValue(),
      delay_ms: numberValue({ integer: true, minimum: 0, maximum: 10_000 }),
      stop_on_error: booleanValue()
    }, ["dir"])
  )
]);

const TOOL_NAME_SET = new Set<string>(COMPUTER_TOOL_NAMES);

export function isComputerPublicToolName(value: string): value is ComputerPublicToolName {
  return TOOL_NAME_SET.has(value);
}

export function computerPublicTool(name: string): ComputerToolDescriptor | undefined {
  return COMPUTER_PUBLIC_TOOLS.find((candidate) => candidate.name === name);
}

export class ComputerToolArgumentError extends Error {
  constructor(readonly field?: string) {
    super("Computer automation tool arguments are invalid.");
    this.name = "ComputerToolArgumentError";
  }
}

export function normalizeComputerToolArguments(
  name: ComputerPublicToolName,
  input: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const normalized = { ...input };
  validateAgainstSchema(normalized, computerPublicTool(name)!.inputSchema);
  return normalized;
}

function validateAgainstSchema(value: unknown, schema: JsonSchema, field = "arguments"): void {
  const type = schema["type"];
  if (type === "object") {
    if (!isRecord(value)) throw new ComputerToolArgumentError(field);
    const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
    const required = Array.isArray(schema["required"])
      ? schema["required"].filter((item): item is string => typeof item === "string")
      : [];
    for (const key of required) {
      if (value[key] === undefined) throw new ComputerToolArgumentError(key);
    }
    for (const [key, item] of Object.entries(value)) {
      const child = properties[key];
      if (!isRecord(child)) throw new ComputerToolArgumentError(key);
      validateAgainstSchema(item, child, key);
    }
    return;
  }
  if (type === "array") {
    if (!Array.isArray(value)) throw new ComputerToolArgumentError(field);
    const minimumItems = schema["minItems"];
    if (typeof minimumItems === "number" && value.length < minimumItems) throw new ComputerToolArgumentError(field);
    const itemSchema = schema["items"];
    if (isRecord(itemSchema)) {
      for (const item of value) validateAgainstSchema(item, itemSchema, field);
    }
    return;
  }
  if (type === "string") {
    if (typeof value !== "string" || value.includes("\0")) throw new ComputerToolArgumentError(field);
  } else if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) {
      throw new ComputerToolArgumentError(field);
    }
    if (typeof schema["minimum"] === "number" && value < schema["minimum"]) throw new ComputerToolArgumentError(field);
    if (typeof schema["maximum"] === "number" && value > schema["maximum"]) throw new ComputerToolArgumentError(field);
  } else if (type === "boolean" && typeof value !== "boolean") {
    throw new ComputerToolArgumentError(field);
  }
  if (Object.hasOwn(schema, "const") && value !== schema["const"]) throw new ComputerToolArgumentError(field);
  if (Array.isArray(schema["enum"]) && !schema["enum"].includes(value)) throw new ComputerToolArgumentError(field);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
