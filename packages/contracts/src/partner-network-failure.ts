/** Only these categories may be supplied by a group executor. */
export const PARTNER_NETWORK_FAILURE_CODES = ["IMAGE_INPUT_UNSUPPORTED", "MODEL_UNAVAILABLE", "AUTH_REQUIRED", "RATE_LIMITED", "UPSTREAM_OVERLOADED",
  "QUOTA_EXCEEDED", "NETWORK_ERROR", "RUNTIME_TIMEOUT", "RUNTIME_ERROR"] as const;
export type PartnerNetworkFailureCode = typeof PARTNER_NETWORK_FAILURE_CODES[number];
export function isPartnerNetworkFailureCode(value: unknown): value is PartnerNetworkFailureCode {
  return typeof value === "string" && (PARTNER_NETWORK_FAILURE_CODES as readonly string[]).includes(value);
}
export function partnerNetworkFailureMessage(code: string, locale: string): string {
  const key = isPartnerNetworkFailureCode(code) ? code : "RUNTIME_ERROR";
  if (code === "input-unavailable") return locale === "zh-CN" ? "这个模型或当前授权无法读取附件，请使用支持的图片、PDF 或文本文件后重新发送。" : "The model or current authorization cannot read the attachment. Use a supported image, PDF or text file and send again.";
  const messages: Record<PartnerNetworkFailureCode, string> = locale === "zh-CN" ? {
    IMAGE_INPUT_UNSUPPORTED: "伙伴的当前模型无法读取图片，请在伙伴所属电脑选择支持图片的模型，或移除图片后重新发送。",
    MODEL_UNAVAILABLE: "伙伴没有可用模型，请在伙伴所属电脑配置可用模型后重新发送。",
    AUTH_REQUIRED: "模型服务的认证已失效，请在伙伴所属电脑重新登录或更新凭据后重新发送。",
    RATE_LIMITED: "模型服务暂时限流，请稍后重新发送。",
    UPSTREAM_OVERLOADED: "模型服务暂时繁忙，请稍后重新发送，或在伙伴所属电脑选择其他可用模型。",
    QUOTA_EXCEEDED: "模型账户的额度或预算已用尽，请在伙伴所属电脑检查额度与预算后重新发送。",
    NETWORK_ERROR: "伙伴未能连接模型服务，请检查伙伴所属电脑的网络后重新发送。",
    RUNTIME_TIMEOUT: "伙伴等待模型回复超时，请稍后重新发送。",
    RUNTIME_ERROR: "伙伴未能完成回复，请重新发送；若仍失败，请在伙伴所属电脑查看日志。"
  } : {
    IMAGE_INPUT_UNSUPPORTED: "The companion's model cannot read images. Choose an image-capable model on its home computer, or remove the image and send again.",
    MODEL_UNAVAILABLE: "The companion has no available model. Configure an available model on its home computer and send again.",
    AUTH_REQUIRED: "Model authentication is no longer valid. Sign in or update credentials on the companion's home computer and send again.",
    RATE_LIMITED: "The model service is temporarily rate limited. Wait a little and send again.",
    UPSTREAM_OVERLOADED: "The model service is temporarily busy. Send again later, or choose another available model on the companion's home computer.",
    QUOTA_EXCEEDED: "The model account has exhausted its quota or budget. Check it on the companion's home computer and send again.",
    NETWORK_ERROR: "The companion could not connect to the model service. Check its home computer's connection and send again.",
    RUNTIME_TIMEOUT: "The companion timed out waiting for the model. Send again later.",
    RUNTIME_ERROR: "The companion could not finish its reply. Send again; if it still fails, check the logs on its home computer."
  };
  return messages[key];
}
