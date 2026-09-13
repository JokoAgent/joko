import type { MessageKey } from "../i18n.js";

export type Translator = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
export type RunAction = (key: string, action: () => Promise<void>) => void;
