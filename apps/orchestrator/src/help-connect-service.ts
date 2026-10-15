import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { ConnectionManager } from "./connection-manager.js";
import type { HelpAssistant, HelpMessageValue } from "./help-assistant.js";
import type { HelpFeedbackStore } from "./help-feedback-store.js";

export function createHelpConnectService(help: HelpAssistant | undefined, feedback: HelpFeedbackStore | undefined,
  connections: ConnectionManager): ServiceImpl<typeof contract.HelpService> {
  const authority = (context: HandlerContext) => {
    const connection = connections.authenticate(context.requestHeader.get("authorization") ?? undefined);
    const revoked = new AbortController();
    const stop = connections.onRevoked(connection.id, () => revoked.abort());
    const signal = AbortSignal.any([context.signal, revoked.signal]);
    const assertCurrent = () => { signal.throwIfAborted(); connections.fence(connection); };
    return { connection, signal, assertCurrent, stop };
  };
  return {
    askHelp: async (request, context) => {
      const auth = authority(context);
      try {
        if (help === undefined) throw new ConnectError("Product help is unavailable.", Code.Unavailable);
        const messages: HelpMessageValue[] = request.messages.map(message => {
          if (message.role !== contract.HelpRole.USER && message.role !== contract.HelpRole.ASSISTANT) throw new ConnectError("Invalid help message role.", Code.InvalidArgument);
          return { role: message.role === contract.HelpRole.USER ? "user" : "assistant", content: message.content };
        });
        const answer = await help.ask(messages, request.locale, auth.signal, auth.assertCurrent);
        auth.assertCurrent();
        return create(contract.AskHelpResponseSchema, { result: answer === undefined
          ? { case: "noAnswer", value: {} }
          : { case: "answer", value: { text: answer.text, settingsSection: answer.settingsSection } } });
      } catch (error) {
        if (error instanceof RangeError) throw new ConnectError("Help history is invalid.", Code.InvalidArgument);
        if (auth.signal.aborted) throw new ConnectError("Help request was cancelled.", Code.Canceled);
        throw error;
      } finally { auth.stop(); }
    },
    createHelpFeedbackDraft: async (request, context) => {
      const auth = authority(context);
      try {
        auth.assertCurrent();
        if (feedback === undefined) throw new ConnectError("Local help feedback is unavailable.", Code.Unavailable);
        const draftId = await feedback.create(auth.connection.deviceId, { requestId: request.requestId, question: request.question,
          answer: request.answer, title: request.title, body: request.body, locale: request.locale }, auth.assertCurrent);
        auth.assertCurrent();
        return create(contract.CreateHelpFeedbackDraftResponseSchema, { draftId });
      } catch (error) {
        if (error instanceof RangeError) throw new ConnectError("Help feedback input is invalid.", Code.InvalidArgument);
        if (error instanceof ConnectError) throw error;
        if (auth.signal.aborted) throw new ConnectError("Help feedback request was cancelled.", Code.Canceled);
        throw new ConnectError("Local help feedback could not be saved. Retry the same draft.", Code.Unavailable);
      } finally { auth.stop(); }
    }
  };
}
