import type { BridgeToolCallContext, BridgeToolProvider, McpCallResult, McpToolDescriptor } from "./mcp-router.js";
import type { VisionBridgeCoordinator } from "./personalization-inference.js";

export const VISION_BRIDGE_TOOL_PROVIDER_ID = "joko-vision-bridge";

const DEFAULT_PROMPT =
  "Describe this image accurately and factually. Do not guess or fabricate details. " +
  "Report visible text verbatim. If the image contains UI elements, list their labels and state.";
const LOCATE_PREFIX =
  "Locate the target below and return its bounding box as x1,y1,x2,y2 in pixel coordinates " +
  "with a top-left origin. If the target is not present, return NOT_FOUND. Target: ";

const TOOLS: readonly McpToolDescriptor[] = [
  {
    serverId: VISION_BRIDGE_TOOL_PROVIDER_ID,
    name: "vision",
    runtimeName: "vision",
    description:
      "Describe an image at a local path using the configured Vision Bridge. Use this for screenshots, UI mockups, diagrams, and images referenced by the user or produced by tools. Pass an optional query to focus on one aspect.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the image file." },
        query: { type: "string", description: "Optional focus question about the image." }
      },
      required: ["path"],
      additionalProperties: false
    },
    requiresPermission: false
  },
  {
    serverId: VISION_BRIDGE_TOOL_PROVIDER_ID,
    name: "vision-locate",
    runtimeName: "vision-locate",
    description:
      "Locate a target element in an image and return its pixel bounding box as x1,y1,x2,y2 with a top-left origin. Use this before cropping or acting on a specific UI element.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the image file." },
        target: { type: "string", description: "What to locate, for example the send button." }
      },
      required: ["path", "target"],
      additionalProperties: false
    },
    requiresPermission: false
  }
];

/** Pi layer-C vision tools. Provider credentials and image bytes remain in
 * Orchestrator: the managed extension receives only a generation-scoped loopback
 * grant and sends a path/focus request over that authenticated bridge. */
export class VisionBridgeToolProvider implements BridgeToolProvider {
  readonly id = VISION_BRIDGE_TOOL_PROVIDER_ID;
  readonly generation = 1;
  readonly tools = TOOLS;
  readonly #vision: VisionBridgeCoordinator;
  readonly #allowedRoots: (context: BridgeToolCallContext) => readonly string[];

  constructor(options: {
    readonly vision: VisionBridgeCoordinator;
    readonly allowedRoots: (context: BridgeToolCallContext) => readonly string[];
  }) {
    this.#vision = options.vision;
    this.#allowedRoots = options.allowedRoots;
  }

  get available(): boolean {
    const state = this.#vision.state();
    return state.enabled && state.available;
  }

  async callTool(
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    context: BridgeToolCallContext
  ): Promise<McpCallResult> {
    if (name !== "vision" && name !== "vision-locate") {
      throw new Error("Vision Bridge tool is not part of this runtime snapshot.");
    }
    const path = boundedRequiredString(arguments_["path"], 4_096, `${name}: path is required`);
    const focus = name === "vision"
      ? boundedOptionalString(arguments_["query"], 4_096) || DEFAULT_PROMPT
      : LOCATE_PREFIX + boundedRequiredString(arguments_["target"], 2_048, "vision-locate: target is required");
    const text = await this.#vision.describeFile({
      path,
      focus,
      allowedRoots: this.#allowedRoots(context),
      ...(signal === undefined ? {} : { signal })
    });
    return { content: [{ type: "text", text }], isError: false };
  }
}

function boundedRequiredString(value: unknown, maximum: number, error: string): string {
  if (typeof value !== "string") throw new Error(error);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) throw new Error(error);
  return normalized;
}

function boundedOptionalString(value: unknown, maximum: number): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error("vision: query is invalid");
  const normalized = value.trim();
  if (normalized.length > maximum) throw new Error("vision: query is invalid");
  return normalized;
}
