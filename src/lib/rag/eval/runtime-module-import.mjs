/**
 * Dynamic TS imports can be native ESM or tsx's CommonJS default namespace in
 * this package. Normalize only that loader boundary; real named exports win.
 * @template {object} T
 * @param {string} moduleUrl
 * @returns {Promise<T>}
 */
export async function importRuntimeModule(moduleUrl) {
  const namespace = await import(moduleUrl);
  const fallback = namespace.default;
  if (fallback !== null && (typeof fallback === 'object' || typeof fallback === 'function')) {
    return /** @type {T} */ (Object.assign(Object.create(null), fallback, namespace));
  }
  return /** @type {T} */ (namespace);
}
