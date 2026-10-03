import { create, fromJson, toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { VoiceInputSaucSettingsSchema, VoiceInputServiceSettingsPatchSchema } from "./gen/joko/v1/settings_pb.js";
import { StartVoiceInputRequestSchema } from "./gen/joko/v1/service_pb.js";
import { defaultVoiceInputSaucSettings, projectVoiceInputSaucSettings, protoVoiceInputSaucSettings, voiceInputSaucEndpoint,
  voiceInputRecognitionContextFromTexts, voiceInputRecognitionLocale } from "./voice-input-sauc-settings.js";

describe("public SAUC route and ephemeral recognition contracts", () => {
  it("keeps complete independent route selections, ticket-only credentials and ordered request-only text", () => {
    const primary = { ...defaultVoiceInputSaucSettings(), mode: "streamInput" as const, authentication: "accessToken" as const,
      appId: "public-app", useDictionaryHotwords: true, boostingTableName: "preferred", boostingTableId: "id-wins" };
    const wire = create(VoiceInputServiceSettingsPatchSchema, { sauc: protoVoiceInputSaucSettings(primary),
      fallbackSauc: protoVoiceInputSaucSettings(defaultVoiceInputSaucSettings()), credentialUploadTicketId: "ticket" });
    expect(projectVoiceInputSaucSettings(wire.sauc)).toEqual(primary);
    expect(projectVoiceInputSaucSettings(wire.fallbackSauc)?.mode).toBe("asyncTwoPass");
    expect(create(VoiceInputServiceSettingsPatchSchema).sauc).toBeUndefined();
    expect(() => projectVoiceInputSaucSettings(create(VoiceInputSaucSettingsSchema))).toThrow(/invalid/u);
    expect(() => fromJson(VoiceInputSaucSettingsSchema, { apiKey: "secret" })).toThrow();
    const start = fromJson(StartVoiceInputRequestSchema, { requestId: "run", mimeType: "audio/pcm",
      refinementInstructions: "Cleanup only", recognitionContext: { contextData: [{ text: "First context" }, { text: "Second context" }] } });
    expect(toJson(StartVoiceInputRequestSchema, start)).toMatchObject({ refinementInstructions: "Cleanup only",
      recognitionContext: { contextData: [{ text: "First context" }, { text: "Second context" }] } });
    expect(() => fromJson(StartVoiceInputRequestSchema, { recognitionContext: { hotwords: ["client-owned"] } })).toThrow();
    expect(voiceInputSaucEndpoint("wss://speech.example:8443/api/v3/sauc/bigmodel_async", primary.mode))
      .toBe("wss://speech.example:8443/api/v3/sauc/bigmodel_nostream");
    expect(voiceInputRecognitionContextFromTexts(["  第一行\r\n第二行\t内容  "])).toEqual({ contextData: [{ text: "第一行\n第二行\t内容" }] });
    expect(() => voiceInputRecognitionContextFromTexts([" \r\n "])).toThrow(/empty/u);
    expect(() => voiceInputRecognitionContextFromTexts(["bad\u0000text"])).toThrow(/invalid/u);
    expect(() => voiceInputRecognitionContextFromTexts(["中".repeat(683)])).toThrow(/UTF-8/u);
    expect(voiceInputRecognitionLocale("en", { supportsLocale: true, supportedLocales: ["en-US", "fr-FR"] })).toBe("en-US");
    expect(voiceInputRecognitionLocale("ja", { supportsLocale: true, supportedLocales: ["en-US"] })).toBeUndefined();
  });
});
