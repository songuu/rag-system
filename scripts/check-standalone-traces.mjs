import { lstat, opendir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

if (process.env.STATIC_EXPORT === 'true') {
  console.log('Standalone trace guard skipped for static export.');
  process.exit(0);
}

const tracePolicies = [
  {
    name: 'document-search',
    file: '.next/server/app/api/document-search/route.js.nft.json',
    forbiddenSourcePrefixes: ['/src/lib/rag/core/', '/src/lib/rag/multimodal/'],
  },
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

// Source policies are route-specific; private runtime data is forbidden globally.
// Inspect metadata only, and never include private paths or identifiers in output.
const workspace = await realpath(process.cwd());
const privateRoots = [
  path.join(workspace, 'data/context-sessions'),
  path.join(workspace, '.next/standalone/data/context-sessions'),
];
const canonicalPrivateRoots = (await Promise.all(privateRoots.map(optionalRealpath))).filter(Boolean);
const canonicalTargets = new Map();
await validateDirectoryPath('.next/server');
let manifestCount = 0;
let privateReferences = 0;
for await (const file of runtimeTraceFiles()) {
  let trace;
  try {
    trace = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw new Error('Invalid standalone trace metadata.');
  }
  if (!Array.isArray(trace?.files) || trace.files.some(file =>
    typeof file !== 'string' || file.length === 0 || file.includes('\0')
  )) {
    throw new Error('Invalid standalone trace metadata.');
  }
  manifestCount += 1;
  for (const reference of trace.files) {
    const target = path.resolve(path.dirname(file), reference.replaceAll('\\', '/'));
    let privateTarget = privateRoots.some(root => isWithin(root, target));
    if (!privateTarget) {
      if (!canonicalTargets.has(target)) canonicalTargets.set(target, await optionalRealpath(target));
      const canonical = canonicalTargets.get(target);
      privateTarget = canonical !== null && canonicalPrivateRoots.some(root => isWithin(root, canonical));
    }
    if (privateTarget) privateReferences += 1;
  }
}
summaries.push(`manifests=${manifestCount}`, `privateReferences=${privateReferences}`);
if (privateReferences > 0) {
  violations.push(`${privateReferences} private session references in runtime traces`);
}
if (await validateDirectoryPath('.next/standalone/data')) {
  const packaged = await optionalLstat(privateRoots[1]);
  if (packaged) violations.push('standalone contains packaged private session state');
}

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
      `${policy.name}: ${offenders.length} raw source/test files`
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
    `standalone: ${packagedRawSources.length} raw source/test files`
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

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function optionalRealpath(file) {
  try {
    return await realpath(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('Unsafe standalone trace path.');
  }
}

async function optionalLstat(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    // Do not propagate OS errors that could disclose a private target path.
    throw new Error('Unsafe standalone trace path.');
  }
}

async function validateDirectoryPath(relativePath) {
  let candidate = workspace;
  for (const part of relativePath.split('/')) {
    candidate = path.join(candidate, part);
    const info = await optionalLstat(candidate);
    if (!info) return false;
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Unsafe standalone trace path.');
    if (path.relative(candidate, await realpath(candidate)) !== '') throw new Error('Unsafe standalone trace path.');
  }
  return true;
}

async function* walkTraceFiles(directory) {
  const handle = await opendir(directory);
  for await (const entry of handle) {
    if (entry.isSymbolicLink()) throw new Error('Unsafe standalone trace path.');
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walkTraceFiles(candidate);
    else if (entry.isFile() && entry.name.endsWith('.nft.json')) yield candidate;
  }
}

async function* runtimeTraceFiles() {
  yield* walkTraceFiles(path.join(workspace, '.next/server'));
  // Next publishes both per-route traces and root server runtime traces. Cache
  // intermediates and the copied standalone subtree are not source manifests.
  const directory = path.join(workspace, '.next');
  const handle = await opendir(directory);
  for await (const entry of handle) {
    if (!entry.name.endsWith('.nft.json')) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Unsafe standalone trace path.');
    yield path.join(directory, entry.name);
  }
}
