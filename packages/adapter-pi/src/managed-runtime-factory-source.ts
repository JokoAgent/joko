type ManagedRuntimeFactoryName = "createPiAutoReviewer" | "createPiModelCatalogAdditions";

const FUNCTION_NAME_HELPER_SOURCE =
  'const __name = (target, value) => Object.defineProperty(target, "name", { value, configurable: true });';

/**
 * Serializes a closure-free factory as standalone ESM.
 *
 * Production bundlers can retain their module-scoped `__name` annotations in
 * Function#toString() output. Re-provision the helper beside the serialized
 * factory so the generated module remains self-contained after bundling.
 */
export function managedRuntimeFactorySource(
  exportName: ManagedRuntimeFactoryName,
  factory: { toString(): string }
): string {
  return `${FUNCTION_NAME_HELPER_SOURCE}\nexport const ${exportName} = ${factory.toString()};\n`;
}
