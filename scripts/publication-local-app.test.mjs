import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedBaseEnvironment } from './publication-local-app.mjs';

test('isolated app preserves OS execution settings and blocks legacy secrets in every Next env file',()=>{
  const directory=mkdtempSync(join(tmpdir(),'publication-app-env-'));
  try {
    for(const name of ['.env','.env.local','.env.development','.env.development.local'])
      writeFileSync(join(directory,name),'NEO4J_PASSWORD=legacy-admin\nOPENAI_API_KEY=legacy-key\nPOSTGRES_URL=legacy-owner\n');
    const env=isolatedBaseEnvironment({Path:'runtime-bin',SystemRoot:'system',NEO4J_PASSWORD:'inherited-admin',ARBITRARY_TOKEN:'inherited-token'},directory);
    assert.equal(env.Path,'runtime-bin');assert.equal(env.SystemRoot,'system');
    assert.equal(env.NEO4J_PASSWORD,'');assert.equal(env.OPENAI_API_KEY,'');assert.equal(env.POSTGRES_URL,'');
    assert.equal(env.ARBITRARY_TOKEN,undefined);
    assert.ok(!JSON.stringify(env).includes('legacy-'));assert.ok(!JSON.stringify(env).includes('inherited-'));
  } finally {rmSync(directory,{recursive:true});}
});
