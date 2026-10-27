interface InstalledModel { name: string; modified_at?: string; digest?: string; size?: number }

export function normalizeInstalledOllamaModels(models: readonly unknown[]): InstalledModel[] {
  const unique = new Map<string, InstalledModel>();
  for (const candidate of models) {
    if (!candidate || typeof candidate !== 'object' || !('name' in candidate)
      || typeof candidate.name !== 'string' || !candidate.name.trim()) continue;
    const model = candidate as InstalledModel;
    // Ollama can expose both migrated manifests and internal runner aliases.
    if (/^llamacpp:[a-f\d]{64}$/iu.test(model.name)) continue;
    const identity = model.name.replace(/:latest$/u, '');
    const prior = unique.get(identity);
    if (!prior || (Date.parse(model.modified_at || '') || 0) > (Date.parse(prior.modified_at || '') || 0)) {
      unique.set(identity, model);
    }
  }
  return [...unique.values()];
}
