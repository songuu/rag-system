import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

registerHooks({resolve(s,c,n){if(s.startsWith('.')&&c.parentURL?.startsWith('file:')){const u=new URL(s+'.ts',c.parentURL);if(existsSync(fileURLToPath(u)))return n(u.href,c);}return n(s,c);}});
test('real local Ollama alias embeds and the exact publication config can be reused for a query',{
  skip:process.env.PUBLICATION_EMBEDDING_LIVE!=='1',timeout:120000,
},async()=>{
  process.env.EMBEDDING_PROVIDER='ollama';
  process.env.OLLAMA_BASE_URL='http://127.0.0.1:11434';
  process.env.OLLAMA_EMBEDDING_MODEL='nomic-embed-text';
  const {resolvePublicationEmbedding}=await import('./publication-embedding.ts');
  const session=await resolvePublicationEmbedding();
  const vectors=await session.embedDocuments(['企业知识库发布测试。','The immutable model alias remains queryable.']);
  assert.equal(vectors.length,2);assert.equal(vectors[0].length,session.config.dimension);
  const exact=await resolvePublicationEmbedding(session.config);
  const query=await exact.embedQuery('企业知识库发布测试。');
  assert.deepEqual(query,vectors[0]);
  assert.match(session.config.model,/^rag-publication-[a-f0-9]{64}:latest$/);
});
