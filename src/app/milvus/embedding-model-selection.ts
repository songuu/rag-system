interface EmbeddingModelOption {
  name: string;
}

interface ResolveEmbeddingModelSelectionInput {
  currentModel: string;
  configuredModel?: string;
  availableModels: EmbeddingModelOption[];
}

function normalizeOllamaModelName(modelName: string): string {
  const normalizedName = modelName.trim().toLowerCase();
  return normalizedName.endsWith(':latest')
    ? normalizedName.slice(0, -':latest'.length)
    : normalizedName;
}

function findAvailableModel(
  modelName: string | undefined,
  availableModels: EmbeddingModelOption[],
): string | undefined {
  if (!modelName) return undefined;

  const trimmedModelName = modelName.trim();
  const exactMatch = availableModels.find(
    (model) => model.name.toLowerCase() === trimmedModelName.toLowerCase(),
  );
  if (exactMatch) return exactMatch.name;

  const normalizedModelName = normalizeOllamaModelName(trimmedModelName);
  return availableModels.find(
    (model) => normalizeOllamaModelName(model.name) === normalizedModelName,
  )?.name;
}

export function resolveEmbeddingModelSelection({
  currentModel,
  configuredModel,
  availableModels,
}: ResolveEmbeddingModelSelectionInput): string {
  return (
    findAvailableModel(configuredModel, availableModels) ??
    findAvailableModel(currentModel, availableModels) ??
    availableModels[0]?.name ??
    configuredModel?.trim() ??
    currentModel
  );
}
