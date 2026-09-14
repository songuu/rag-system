interface OllamaModelName {
  name: string;
}

function normalizeLatestTag(modelName: string): string {
  return modelName.trim().replace(/:latest$/i, '').toLowerCase();
}

export function findEquivalentOllamaModel(
  configuredModel: string | null | undefined,
  availableModels: readonly OllamaModelName[]
): string | undefined {
  const configuredName = configuredModel?.trim();
  if (!configuredName) return undefined;

  const exactMatch = availableModels.find(model => model.name === configuredName);
  if (exactMatch) return exactMatch.name;

  const normalizedConfiguredName = normalizeLatestTag(configuredName);
  return availableModels.find(
    model => normalizeLatestTag(model.name) === normalizedConfiguredName
  )?.name;
}

/**
 * Ollama treats an omitted tag as `latest`. Resolve the configured value to
 * the concrete installed name so controlled selects do not oscillate between
 * equivalent tagged and untagged values.
 */
export function resolveConfiguredOllamaModel(
  configuredModel: string | null | undefined,
  availableModels: readonly OllamaModelName[]
): string {
  const configuredName = configuredModel?.trim();

  if (!configuredName) {
    return availableModels[0]?.name ?? '';
  }

  return findEquivalentOllamaModel(configuredName, availableModels)
    ?? availableModels[0]?.name
    ?? configuredName;
}
