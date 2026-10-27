import { join } from 'node:path';

export function resolveMobiParserPath(): string {
  // Next rewrites statically imported createRequire.resolve() into a bundler
  // module ID. Workers need a real file path; keep resolution native to Node.
  // The standalone runtime tracing list carries both parser distributions.
  const nativeModule = process.getBuiltinModule('node:module');
  return nativeModule.createRequire(join(process.cwd(), 'package.json'))
    .resolve('@lingo-reader/mobi-parser').replace(/\.js$/, '.mjs');
}
