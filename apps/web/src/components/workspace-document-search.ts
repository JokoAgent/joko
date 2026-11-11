import { SearchQuery } from "@codemirror/search";
import { Facet, StateEffect, StateField, type EditorState, type Text } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

export interface WorkspaceDocumentSearchRange {
  readonly from: number;
  readonly to: number;
}

export interface WorkspaceDocumentSearchSelection {
  readonly query: string;
  readonly matches: readonly WorkspaceDocumentSearchRange[];
  readonly activeIndex: number;
}

interface WorkspaceDocumentSearchFieldValue extends WorkspaceDocumentSearchSelection {
  readonly decorations: DecorationSet;
}

type ReadConcealedRanges = (doc: Text) => readonly WorkspaceDocumentSearchRange[];
export const workspaceDocumentSearchConcealedRanges = Facet.define<ReadConcealedRanges, ReadConcealedRanges | undefined>({
  combine: (values) => values[0]
});

export const setWorkspaceSearchDecorations = StateEffect.define<WorkspaceDocumentSearchSelection>();
const matchDecoration = Decoration.mark({ class: "cm-doc-search-match" });
const activeDecoration = Decoration.mark({ class: "cm-doc-search-match cm-doc-search-active" });

export const workspaceActiveSearchField = StateField.define<WorkspaceDocumentSearchFieldValue>({
  create: () => searchFieldValue("", [], -1),
  update(value, transaction) {
    const effect = transaction.effects.findLast((item) => item.is(setWorkspaceSearchDecorations));
    if (effect?.is(setWorkspaceSearchDecorations)) {
      return searchFieldValue(effect.value.query, effect.value.matches, effect.value.activeIndex);
    }
    if (!transaction.docChanged || value.query === "") return value;
    const { matches } = collectWorkspaceDocumentMatches(transaction.state, value.query);
    const activeIndex = matches.length === 0 ? -1 : Math.min(Math.max(value.activeIndex, 0), matches.length - 1);
    return searchFieldValue(value.query, matches, activeIndex);
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
});

export function collectWorkspaceDocumentMatches(state: EditorState, query: string): {
  readonly matches: readonly WorkspaceDocumentSearchRange[];
  readonly truncated: boolean;
} {
  if (query === "") return { matches: [], truncated: false };
  const concealed = [...(state.facet(workspaceDocumentSearchConcealedRanges)?.(state.doc) ?? [])]
    .sort((left, right) => left.from - right.from);
  const matches: WorkspaceDocumentSearchRange[] = [];
  const cursor = new SearchQuery({ search: query, caseSensitive: false, literal: true }).getCursor(state);
  let concealedIndex = 0;
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    const { from, to } = next.value;
    while (concealedIndex < concealed.length && concealed[concealedIndex]!.to <= from) concealedIndex += 1;
    const hidden = concealed[concealedIndex];
    if (hidden === undefined || hidden.from >= to) matches.push({ from, to });
  }
  return { matches, truncated: false };
}

function searchFieldValue(
  query: string,
  matches: readonly WorkspaceDocumentSearchRange[],
  activeIndex: number
): WorkspaceDocumentSearchFieldValue {
  return {
    query,
    matches,
    activeIndex,
    decorations: Decoration.set(matches.map((match, index) => (
      index === activeIndex ? activeDecoration : matchDecoration
    ).range(match.from, match.to)))
  };
}
