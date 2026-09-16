import type { Transaction } from "@tiptap/pm/state";

const COMPOSER_SKIP_LIST_NORMALIZATION_META = "composerSkipListNormalization";

/**
 * Mark a document transaction whose structural change must not be interpreted
 * as newly typed Markdown. Atom insertion and background attribute enrichment
 * can leave a literal list marker at the start of the paragraph, but neither
 * action is user text input.
 */
export function skipComposerListNormalization(transaction: Transaction): Transaction {
  return transaction.setMeta(COMPOSER_SKIP_LIST_NORMALIZATION_META, true);
}

export function composerListNormalizationIsSkipped(transaction: Transaction): boolean {
  return transaction.getMeta(COMPOSER_SKIP_LIST_NORMALIZATION_META) === true;
}
