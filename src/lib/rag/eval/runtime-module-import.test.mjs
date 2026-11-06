import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';

const root = process.cwd();
test('actual tsx subprocess loads real runtime exports without default-only namespace loss or service IO', () => {
  const helperUrl = pathToFileURL(path.join(root, 'src/lib/rag/eval/runtime-module-import.mjs')).href;
  const script = `
    import { importRuntimeModule } from ${JSON.stringify(helperUrl)};
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    import net from 'node:net';
    let io = 0;
    globalThis.fetch = async () => { io++; throw new Error('service IO forbidden in loader test'); };
    net.Socket.prototype.connect = function () { io++; throw new Error('service IO forbidden in loader test'); };
    const checks = [
      ['src/lib/security/request-context.ts', ['resolveRagSecurityContext']],
      ['src/lib/postgres/client.ts', ['getPostgresClient']],
      ['src/lib/documents/publication-view.ts', ['readPublicationView']],
      ['src/app/api/ask/route.ts', ['POST']],
      ['src/lib/rag/eval/publication-eval-runtime.ts', ['createPublicationEvalRuntime']],
      ['src/lib/rag/eval/quality-scoring-model.ts', ['createModelSemanticJudge']],
    ];
    for (const [filename, names] of checks) {
      const actual = await importRuntimeModule(pathToFileURL(path.resolve(filename)).href);
      for (const name of names) if (typeof actual[name] !== 'function') throw new Error(filename + ' missing export ' + name);
    }
    const judge = await importRuntimeModule(pathToFileURL(path.resolve('src/lib/rag/eval/quality-scoring-model.ts')).href);
    if (typeof judge.SEMANTIC_JUDGE_RUBRIC_VERSION !== 'string') throw new Error('rubric constant lost');
    console.log('LOADER_OK:' + io);
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /LOADER_OK:0/);
});

test('normal ESM named exports remain authoritative over an unrelated default export object', async () => {
  const { importRuntimeModule } = await import('./runtime-module-import.mjs');
  const loaded = await importRuntimeModule('data:text/javascript,export default {value:1,extra:2};export const value=3;');
  assert.equal(loaded.value, 3);
  assert.equal(loaded.extra, 2);
});

test('documented --import tsx CLI validates a real contract without invoking services', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rag-live-loader-'));
  try {
    const helperUrl = pathToFileURL(path.join(root, 'src/lib/rag/eval/runtime-module-import.mjs')).href;
    const datasetPath = path.join(directory, 'dataset.json'), contractPath = path.join(directory, 'contract.json');
    const setup = `
      import { importRuntimeModule } from ${JSON.stringify(helperUrl)};
      import {readFile,writeFile} from 'node:fs/promises';
      import {pathToFileURL} from 'node:url';
      import path from 'node:path';
      const {createExperimentContract}=await importRuntimeModule(pathToFileURL(path.resolve('src/lib/rag/eval/experiment-contract.ts')).href);
      const dataset=JSON.parse(await readFile('src/lib/rag/eval/fixtures/e1b-canonical-v2.json','utf8'));
      for(const item of dataset.cases){item.tags=['human-reviewed']; if(item.expectedAnswer) item.expectedAnswer.referenceAnswer=item.expectedAnswer.requiredFacts.map(fact=>fact[0]).join(' ');}
      const configuration={implementationSha256:'a'.repeat(64),promptSha256:'b'.repeat(64),
        model:{provider:'ollama',name:'synthetic-loader-test',revision:'r1',parameters:{}},
        embedding:{provider:'ollama',name:'synthetic-embedding',revision:'r2',dimensions:1024},
        index:{id:'synthetic-index',revision:'r1'},retrieval:{topK:3,similarityThreshold:0},
        rerank:{enabled:false,provider:'none',model:'none',revision:'none',topN:3},
        context:{maxTokens:4000},cache:{mode:'disabled',identity:'none'}};
      const contract=createExperimentContract(dataset,{configuration,review:{reviewer:'synthetic-loader-test-only',reviewedAt:'2026-01-01T00:00:00Z'}});
      await writeFile(${JSON.stringify(datasetPath)},JSON.stringify(dataset));
      await writeFile(${JSON.stringify(contractPath)},JSON.stringify(contract));
    `;
    const prepared = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', setup], {
      cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    assert.equal(prepared.status, 0, prepared.stderr);
    const guard = path.join(directory, 'forbid-service-io.mjs');
    await writeFile(guard, `import net from 'node:net';globalThis.fetch=async()=>{throw Error('service IO forbidden');};net.Socket.prototype.connect=function(){throw Error('service IO forbidden');};`);
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--import', pathToFileURL(guard).href,
      'scripts/run-live-rag-eval.mjs', '--validate-only', '--dataset', datasetPath, '--contract', contractPath], {
      cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /"validated":true/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
