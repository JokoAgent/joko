import {
  updateMobileRouteReferenceAtom,
  type MobileComposerDraft,
  type MobileComposerSelection
} from "./mobile-composer-document";
import {
  mobileComposerRouteResolutionTarget,
  type MobileComposerRouteResolutionTarget
} from "./mobile-composer-route-links";

export type MobileComposerRouteResolver = (
  target: MobileComposerRouteResolutionTarget
) => Promise<string | undefined>;

export async function enrichMobileComposerRouteReferences(
  draft: MobileComposerDraft,
  selection: MobileComposerSelection,
  insertedAtomIds: readonly string[],
  resolver: MobileComposerRouteResolver
): Promise<{ readonly draft: MobileComposerDraft; readonly selection: MobileComposerSelection }> {
  const expected = insertedAtomIds.flatMap((atomId) => {
    const atom = draft.atoms.find((candidate) => candidate.atomId === atomId);
    return atom?.kind === "route-reference"
      && (atom.serialized === atom.href || atom.routeKind === "session"
        && (atom.messageId !== undefined || atom.eventId !== undefined))
      ? [atom]
      : [];
  });
  const values = await Promise.all(expected.map(async (atom) => {
    try { return await resolver(mobileComposerRouteResolutionTarget(atom)); }
    catch { return undefined; }
  }));
  let next = draft;
  expected.forEach((atom, index) => {
    const value = values[index];
    if (value === undefined) return;
    next = updateMobileRouteReferenceAtom(next, atom, value)?.draft ?? next;
  });
  const delta = next.text.length - draft.text.length;
  return {
    draft: next,
    selection: { start: selection.start + delta, end: selection.end + delta }
  };
}
