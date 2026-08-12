import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, '..');

// GitHub Pages has no standalone server, and the Windows development build
// does not need Linux shared objects. Linux server builds must carry the
// runtime library loaded by onnxruntime_binding.node at request time.
if (process.env.STATIC_EXPORT === 'true' || process.platform !== 'linux') {
  console.log('standalone native libraries: not applicable');
  process.exit(0);
}

const projectNodeModules = resolve(projectRoot, 'node_modules');
const directPackageJson = resolve(projectNodeModules, 'onnxruntime-node', 'package.json');
const pnpmStore = resolve(projectNodeModules, '.pnpm');
const packageJson = existsSync(directPackageJson)
  ? directPackageJson
  : readdirSync(pnpmStore)
    .filter(entry => entry.startsWith('onnxruntime-node@'))
    .map(entry => resolve(pnpmStore, entry, 'node_modules', 'onnxruntime-node', 'package.json'))
    .find(existsSync);

if (!packageJson) {
  throw new Error('onnxruntime-node is missing from node_modules.');
}

const packageRoot = dirname(realpathSync(packageJson));
const packagePathInNodeModules = relative(projectNodeModules, packageRoot);
if (
  !packagePathInNodeModules ||
  packagePathInNodeModules.startsWith('..') ||
  isAbsolute(packagePathInNodeModules)
) {
  throw new Error(`Unsafe onnxruntime package path: ${packagePathInNodeModules}`);
}

const nativeDirectory = join(packageRoot, 'bin', 'napi-v3', process.platform, process.arch);
const targetDirectory = join(
  projectRoot,
  '.next',
  'standalone',
  'node_modules',
  packagePathInNodeModules,
  'bin',
  'napi-v3',
  process.platform,
  process.arch
);

if (!existsSync(nativeDirectory) || !existsSync(targetDirectory)) {
  throw new Error(
    `Unable to locate onnxruntime native directories (source=${nativeDirectory}, target=${targetDirectory}).`
  );
}

const sharedLibraries = readdirSync(nativeDirectory)
  .filter(name => /^libonnxruntime.*\.so(?:\..+)?$/.test(name));
if (sharedLibraries.length === 0) {
  throw new Error(`No onnxruntime shared libraries found in ${nativeDirectory}.`);
}

mkdirSync(targetDirectory, { recursive: true });
for (const library of sharedLibraries) {
  copyFileSync(join(nativeDirectory, library), join(targetDirectory, library));
}

console.log(`standalone native libraries: copied ${sharedLibraries.join(', ')}`);
