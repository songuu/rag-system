import { opendir, readFile } from 'node:fs/promises';
import path from 'node:path';

if (process.env.STATIC_EXPORT === 'true') {
  console.log('Standalone trace guard skipped for static export.');
  process.exit(0);
}

const tracePolicies = [
  {
    name: 'ask',
    file: '.next/server/app/api/ask/route.js.nft.json',
    forbiddenSourcePrefixes: [
      '/src/lib/rag/core/',
      '/src/lib/rag/multimodal/',
      '/src/lib/mirofish/',
    ],
  },
  {
    name: 'pipeline',
    file: '.next/server/app/api/pipeline/route.js.nft.json',
    forbiddenSourcePrefixes: ['/src/lib/rag/multimodal/'],
  },
  {
    name: 'mirofish-graph',
    file: '.next/server/app/api/mirofish/graph/route.js.nft.json',
    forbiddenSourcePrefixes: ['/src/lib/mirofish/'],
  },
];

const forbiddenStandaloneRoots = [
  '.next/standalone/src/lib/rag/core',
  '.next/standalone/src/lib/rag/multimodal',
  '.next/standalone/src/lib/mirofish',
];
const rawSourceExtension = /\.(?:[cm]?[jt]sx?)$/i;

const summaries = [];
const violations = [];

for (const policy of tracePolicies) {
  let trace;
  try {
    trace = JSON.parse(await readFile(policy.file, 'utf8'));
  } catch (error) {
    throw new Error(
      `Unable to validate ${policy.name} standalone trace at ${policy.file}.`,
      { cause: error }
    );
  }
  if (!Array.isArray(trace.files)) {
    throw new Error(`${policy.file} does not contain a files array.`);
  }
  const offenders = trace.files.filter(file => {
    if (typeof file !== 'string') return false;
    const normalized = '/' + file.replaceAll('\\', '/');
    if (!rawSourceExtension.test(normalized)) return false;
    return policy.forbiddenSourcePrefixes.some(prefix =>
      normalized.includes(prefix)
    );
  });
  summaries.push(`${policy.name}=${trace.files.length}`);
  if (offenders.length > 0) {
    violations.push(
      `${policy.name}: ${offenders.length} raw source/test files\n`
        + offenders.slice(0, 20).map(file => `  - ${file}`).join('\n')
    );
  }
}

const packagedRawSources = [];
for (const root of forbiddenStandaloneRoots) {
  for await (const file of walkFiles(root)) {
    if (rawSourceExtension.test(file)) packagedRawSources.push(file);
  }
}
summaries.push(`standaloneRaw=${packagedRawSources.length}`);
if (packagedRawSources.length > 0) {
  violations.push(
    `standalone: ${packagedRawSources.length} raw source/test files\n`
      + packagedRawSources.slice(0, 20).map(file => `  - ${file}`).join('\n')
  );
}

if (violations.length > 0) {
  throw new Error(
    'Standalone trace guard rejected over-broad runtime source tracing:\n'
      + violations.join('\n')
  );
}

console.log(`Standalone trace guard passed (${summaries.join(', ')}).`);

async function* walkFiles(directory) {
  let handle;
  try {
    handle = await opendir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for await (const entry of handle) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(candidate);
      continue;
    }
    if (entry.isFile()) yield candidate;
  }
}
