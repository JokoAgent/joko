export interface ResponsesInputTextPart {
  type: 'input_text' | 'output_text' | 'text';
  text: string;
}

export interface ResponsesInputImagePart {
  type: 'input_image';
  image_url?: string | {
    url: string;
    detail?: string;
  };
  file_id?: string;
  detail?: string;
}

export interface ResponsesInputFilePart {
  type: 'input_file';
  file_id?: string;
  file_data?: string;
  file_url?: string;
  filename?: string;
}

export interface ResponsesInputAudioPart {
  type: 'input_audio';
  input_audio?: {
    data: string;
    format: string;
  };
  data?: string;
  format?: string;
}

export type ResponsesContentPart =
  | ResponsesInputTextPart
  | ResponsesInputImagePart
  | ResponsesInputFilePart
  | ResponsesInputAudioPart
  | {
  type: string;
  [key: string]: unknown;
};

export interface ChatToolCallExtraContent {
  [key: string]: unknown;
  google?: {
    [key: string]: unknown;
    thought_signature?: string;
  };
}

export type ResponsesInputItem =
  | {
      type?: 'message';
      role: 'user' | 'assistant' | 'system' | 'developer';
      content: string | ResponsesContentPart[];
    }
  | {
      type: 'function_call';
      call_id: string;
      name: string;
      arguments: string;
      extra_content?: ChatToolCallExtraContent;
    }
  | {
      type: 'function_call_output';
      call_id: string;
      output: unknown;
    }
  | {
      type: 'reasoning';
      [key: string]: unknown;
    }
  | {
      type: string;
      [key: string]: unknown;
    };

export interface ResponsesFunctionTool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ResponsesCustomTool {
  type: 'custom';
  name: string;
  description?: string;
  [key: string]: unknown;
}

export interface ResponsesNamespaceTool {
  type: 'namespace';
  name: string;
  tools?: Array<ResponsesFunctionTool | ResponsesCustomTool | { type: string; [key: string]: unknown }>;
  children?: Array<ResponsesFunctionTool | ResponsesCustomTool | { type: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface ResponsesRequest {
  model: string;
  instructions?: string | ResponsesContentPart[];
  input: string | ResponsesInputItem[];
  tools?: Array<
    | string
    | ResponsesFunctionTool
    | ResponsesCustomTool
    | ResponsesNamespaceTool
    | { type: string; [key: string]: unknown }
  >;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  max_output_tokens?: number;
  reasoning?: { effort?: string; [key: string]: unknown };
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  seed?: number;
  user?: string;
  metadata?: Record<string, unknown>;
  service_tier?: string;
  response_format?: unknown;
  text?: { format?: unknown; [key: string]: unknown };
  logit_bias?: Record<string, number>;
  logprobs?: boolean;
  top_logprobs?: number;
  n?: number;
  stream?: boolean;
  store?: boolean;
  [key: string]: unknown;
}

export interface ChatTextContentPart {
  type: 'text';
  text: string;
}

export interface ChatImageUrlContentPart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: string;
  };
}

export interface ChatFileContentPart {
  type: 'file';
  file: {
    file_id?: string;
    file_data?: string;
    file_url?: string;
    filename?: string;
  };
}

export interface ChatInputAudioContentPart {
  type: 'input_audio';
  input_audio: {
    data: string;
    format: string;
  };
}

export type ChatUserContentPart =
  | ChatTextContentPart
  | ChatImageUrlContentPart
  | ChatFileContentPart
  | ChatInputAudioContentPart;

export interface ChatTextMessage {
  role: 'system' | 'developer';
  content: string;
}

export interface ChatUserMessage {
  role: 'user';
  content: string | ChatUserContentPart[];
}

export interface ChatAssistantMessage {
  role: 'assistant';
  content?: string | null;

  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };

    extra_content?: ChatToolCallExtraContent;
  }>;
}

export interface ChatToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

export type ChatMessage = ChatTextMessage | ChatUserMessage | ChatAssistantMessage | ChatToolMessage;

export interface ChatCompletionsRequest {
  model: string;
  messages: ChatMessage[];
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters: Record<string, unknown>;
      strict?: boolean;
    };
  }>;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning_effort?: string;
  reasoning?: { effort: string };
  thinking?: { type: string };
  enable_thinking?: boolean;
  reasoning_split?: boolean;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  seed?: number;
  user?: string;
  metadata?: Record<string, unknown>;
  service_tier?: string;
  response_format?: unknown;
  logit_bias?: Record<string, number>;
  logprobs?: boolean;
  top_logprobs?: number;
  stream: boolean;
  stream_options?: { include_usage: true };
}

export type ChatDeveloperRole = 'developer' | 'system';
export type ChatMaxTokensField = 'max_tokens' | 'max_completion_tokens' | 'omit';
export type ChatImageInput = 'image_url';
export type ChatFileInput = 'file';
export type ChatAudioInput = 'input_audio';
export type ChatReasoningField =
  | 'reasoning_effort'
  | 'reasoning.effort'
  | 'thinking.type'
  | 'enable_thinking'
  | 'reasoning_split'
  | 'none';
export type ChatReasoningHistoryField = 'reasoning_content';
export type ChatPassthroughField =
  | 'temperature'
  | 'top_p'
  | 'frequency_penalty'
  | 'presence_penalty'
  | 'stop'
  | 'seed'
  | 'user'
  | 'metadata'
  | 'service_tier'
  | 'response_format'
  | 'logit_bias'
  | 'logprobs'
  | 'top_logprobs';

export interface ChatBridgeCapabilities {
  developerRole?: ChatDeveloperRole;
  parallelToolCalls?: boolean;
  maxTokensField?: ChatMaxTokensField;
  reasoningField?: ChatReasoningField;
  reasoningHistoryField?: ChatReasoningHistoryField;
  imageInput?: ChatImageInput;
  fileInput?: ChatFileInput;
  audioInput?: ChatAudioInput;
  reasoningEffortMap?: Readonly<Record<string, string | boolean>>;
  passthroughFields?: readonly ChatPassthroughField[];
  streamUsage?: boolean;
  toolCallReasoningPlaceholder?: boolean;
  forceAutoToolChoice?: boolean;
  googleThoughtSignaturePlaceholder?: boolean;
  systemMessagePolicy?: 'preserve' | 'coalesce-leading';
}

const UNSUPPORTED_RESPONSES_FEATURE_MESSAGE_PREFIX =
  'Responses feature is not supported by the Chat Completions bridge: ';
const RESPONSES_IMAGE_CONTENT_PART_TYPES = new Set(['input_image', 'image_url', 'image']);

export function isResponsesImageContentPartType(
  value: unknown,
): value is 'input_image' | 'image_url' | 'image' {
  return typeof value === 'string' && RESPONSES_IMAGE_CONTENT_PART_TYPES.has(value);
}

export class UnsupportedResponsesFeatureError extends Error {
  readonly feature: string;

  constructor(feature: string) {
    super(`${UNSUPPORTED_RESPONSES_FEATURE_MESSAGE_PREFIX}${feature}`);
    this.name = 'UnsupportedResponsesFeatureError';
    this.feature = feature;
  }
}
