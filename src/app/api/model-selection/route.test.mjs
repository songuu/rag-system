import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/lib/embedding-reindex-runtime') return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
      import { embeddingReindexJobs } from ${JSON.stringify(pathToFileURL(path.resolve('src/lib/embedding-reindex-jobs.ts')).href)};
      export function beginEmbeddingReindex(model, context, selection) {
        const job = { id: 'fixture-job', ...context, model, status: 'building', stage: 'embedding', completed: 0, selection };
        embeddingReindexJobs().set(job.id, job);
        return job;
      }
    `) };
    if (specifier === '@/lib/model-config' || specifier === '@/lib/embedding-config'
      || specifier.startsWith('@langchain/')) {
      throw new Error('Model selection must not load model SDKs merely to validate a choice.');
    }
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    if (specifier.startsWith('@/')) {
      return nextResolve(pathToFileURL(path.resolve('src', specifier.slice(2) + '.ts')).href, context);
    }
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const target = new URL(specifier, context.parentURL);
      if (!existsSync(target) && existsSync(new URL(target.href + '.ts'))) {
        return nextResolve(target.href + '.ts', context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const { POST, GET } = await import('./route.ts');
const { embeddingReindexJobs } = await import('@/lib/embedding-reindex-jobs');
const { validateAskInput } = await import('@/lib/security/request-validation');

async function selectModel(body) {
  return POST(new Request('http://localhost/api/model-selection', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

test('model selection validates the ask allowlist without changing server defaults', async () => {
  const env = {
    MODEL_PROVIDER: 'ollama',
    OLLAMA_LLM_MODEL: 'llama3.1',
    EMBEDDING_PROVIDER: 'ollama',
    OLLAMA_EMBEDDING_MODEL: 'nomic-embed-text',
    RAG_ALLOWED_LLM_MODELS: 'llama3.1,glm-4.7-flash',
    RAG_ALLOWED_EMBEDDING_MODELS: 'nomic-embed-text,other-embedding',
  };
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const response = await selectModel({ llmModel: 'glm-4.7-flash:latest', embeddingModel: 'nomic-embed-text:latest' });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.config.llm.model, 'glm-4.7-flash');
    assert.equal(body.config.embedding.model, 'nomic-embed-text');
    assert.equal(body.defaultLlmModel, 'llama3.1');
    assert.equal(process.env.OLLAMA_LLM_MODEL, 'llama3.1');
    assert.equal(validateAskInput({ question: 'hello', llmModel: body.config.llm.model }, env).llmModel, 'glm-4.7-flash');

    const denied = await selectModel({ llmModel: 'unapproved', embeddingModel: 'nomic-embed-text' });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'MODEL_NOT_ALLOWED');

    const incompatible = await selectModel({ llmModel: 'glm-4.7-flash', embeddingModel: 'other-embedding' });
    assert.equal(incompatible.status, 409);
    assert.equal((await incompatible.json()).code, 'EMBEDDING_MODEL_REQUIRES_REINDEX');

    const badId = await selectModel({ llmModel: '../../secret', embeddingModel: 'nomic-embed-text' });
    assert.equal(badId.status, 400);
    assert.equal((await badId.json()).code, 'INVALID_MODEL_ID');

    const badEmbedding = await selectModel({ llmModel: 'glm-4.7-flash', embeddingModel: 42 });
    assert.equal(badEmbedding.status, 400);

    process.env.RAG_ALLOWED_LLM_MODELS = 'llama3.1,glm-4.7-flash:latest';
    const tagged = await selectModel({ llmModel: 'glm-4.7-flash:latest', embeddingModel: 'nomic-embed-text' });
    assert.equal((await tagged.json()).config.llm.model, 'glm-4.7-flash:latest');
    const differentTag = await selectModel({ llmModel: 'glm-4.7-flash:v2', embeddingModel: 'nomic-embed-text' });
    assert.equal(differentTag.status, 403);

    const malformed = await POST(new Request('http://localhost/api/model-selection', { method: 'POST', body: '{' }));
    assert.equal(malformed.status, 400);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('嵌入重建需要权限，立即返回后台任务，完成后才返回配置；状态查询受身份约束', async () => {
  const env = { RAG_ACCESS_MODE: 'single-tenant-token', RAG_SINGLE_TENANT_TOKEN: 'fixture-token',
    RAG_SINGLE_TENANT_ACTOR_ID: 'index-owner', RAG_SINGLE_TENANT_ROLE: 'viewer',
    RAG_DEFAULT_TENANT_ID: 'tenant-index', RAG_DEFAULT_CORPUS_ID: 'corpus-index',
    RAG_ALLOWED_LLM_MODELS: '', RAG_ALLOWED_EMBEDDING_MODELS: '' };
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const request = (body, authorized = true) => new Request('http://localhost/api/model-selection', { method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorized ? { authorization: 'Bearer fixture-token' } : {}) }, body: JSON.stringify(body) });
  try {
    const body = { llmModel: 'glm', embeddingModel: 'bge-m3', reindex: true };
    assert.equal((await POST(request(body, false))).status, 401);
    assert.equal((await POST(request(body))).status, 403);
    process.env.RAG_SINGLE_TENANT_ROLE = 'owner';
    const response = await POST(request(body));
    assert.equal(response.status, 202);
    const started = await response.json();
    assert.equal(started.job.status, 'building');
    assert.equal(started.config, undefined);
    const statusRequest = () => new Request('http://localhost/api/model-selection?jobId=fixture-job', { headers: { authorization: 'Bearer fixture-token' } });
    assert.equal((await (await GET(statusRequest())).json()).config, undefined);
    const job = embeddingReindexJobs().get('fixture-job');
    job.status = 'ready'; job.selection.config.embedding = { provider: 'ollama', model: 'bge-m3', dimension: 1024 };
    assert.equal((await (await GET(statusRequest())).json()).config.embedding.dimension, 1024);
    process.env.RAG_SINGLE_TENANT_ACTOR_ID = 'another-actor';
    assert.equal((await GET(statusRequest())).status, 403);
  } finally {
    embeddingReindexJobs().clear();
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
