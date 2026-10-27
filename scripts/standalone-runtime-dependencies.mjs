import { createRequire } from 'node:module';
import path from 'node:path';

export const standaloneRuntimeDependencies = [
  '@langchain/core/embeddings', '@langchain/core/language_models/chat_models',
  '@langchain/core/callbacks/manager', '@langchain/core/documents', '@langchain/core/language_models/base',
  '@langchain/core/messages', '@langchain/core/output_parsers', '@langchain/core/prompts',
  '@langchain/core/runnables', '@langchain/core/tracers/tracer_langchain',
  '@langchain/ollama', '@langchain/openai', '@langchain/langgraph', '@langchain/langgraph/prebuilt',
  '@langchain/textsplitters', 'langchain',
  '@zilliz/milvus2-sdk-node', '@xenova/transformers',
];

// This package's CJS export is incorrectly declared inside type:module.
// Workers import the adjacent ESM distribution directly instead.
export const standaloneEsmRuntimeDependencies = ['@lingo-reader/mobi-parser'];
export function resolveStandaloneEsmEntry(requireProject, dependency) {
  return requireProject.resolve(dependency).replace(/\.js$/, '.mjs');
}

export async function traceStandaloneRuntime(projectRoot, traceFiles) {
  const requireProject = createRequire(path.join(projectRoot, 'package.json'));
  const trace = traceFiles || requireProject('next/dist/compiled/@vercel/nft').nodeFileTrace;
  const entries = [
    ...standaloneRuntimeDependencies.map(dependency => requireProject.resolve(dependency)),
    // Keep the advertised entry too: require.resolve checks its existence before
    // workers select the adjacent, working ESM distribution.
    ...standaloneEsmRuntimeDependencies.flatMap(dependency => [
      requireProject.resolve(dependency), resolveStandaloneEsmEntry(requireProject, dependency),
    ]),
  ];
  // Trace native entry points as well as Next's ESM graph, including their
  // transitive require() exports. Avoid shipping every file of every SDK.
  const { fileList } = await trace(entries, {
    base: projectRoot, processCwd: projectRoot, conditions: ['node', 'require', 'default'], fileIOConcurrency: 128,
  });
  const entryAliases = [...standaloneRuntimeDependencies, ...standaloneEsmRuntimeDependencies]
    .map(dependency => `node_modules/${dependency.split('/').slice(0, dependency.startsWith('@') ? 2 : 1).join('/')}`);
  return [...new Set([...fileList, ...entryAliases, ...entryAliases.map(alias => `${alias}/package.json`)].map(file => path.posix.normalize(file.replaceAll('\\', '/')))
    .filter(file => file.startsWith('node_modules/')))].sort();
}
