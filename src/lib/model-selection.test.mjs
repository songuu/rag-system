import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSessionModelConfig, isSameModel, requestSessionModelSelection } from './model-selection.ts';

const serverConfig = {
  llm: { provider: 'ollama', model: 'llama3.1' },
  embedding: { provider: 'ollama', model: 'nomic-embed-text', dimension: 768 },
};
const selection = { provider: 'ollama', model: 'glm-4.7-flash', serverModel: 'llama3.1' };

test('health refresh retains the selected LLM and the configured corpus embedding', () => {
  const refreshed = resolveSessionModelConfig(structuredClone(serverConfig), selection);
  assert.equal(refreshed.llm.model, 'glm-4.7-flash');
  assert.deepEqual(refreshed.embedding, serverConfig.embedding);
  assert.equal(serverConfig.llm.model, 'llama3.1');
});

test('new server defaults or providers supersede the session selection', () => {
  const newDefault = { ...serverConfig, llm: { provider: 'ollama', model: 'qwen2.5' } };
  const newProvider = { ...serverConfig, llm: { provider: 'openai', model: 'llama3.1' } };
  assert.equal(resolveSessionModelConfig(newDefault, selection).llm.model, 'qwen2.5');
  assert.equal(resolveSessionModelConfig(newProvider, selection).llm.provider, 'openai');
  assert.deepEqual(resolveSessionModelConfig(serverConfig, null), serverConfig);
});

test('only Ollama latest aliases denote the same model', () => {
  assert.equal(isSameModel('nomic-embed-text', 'nomic-embed-text:latest', 'ollama'), true);
  assert.equal(isSameModel('nomic-embed-text', 'nomic-embed-text:v2', 'ollama'), false);
  assert.equal(isSameModel('model', 'model:latest', 'custom'), false);
});

test('selection requests allow cold development compilation and return the validated choice', async t => {
  let deadline;
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    deadline = milliseconds;
    return new AbortController().signal;
  });
  const validated = {
    success: true, defaultLlmModel: 'llama3.1',
    config: { ...serverConfig, llm: { provider: 'ollama', model: 'glm-4.7-flash' } },
  };
  const fetchSelection = async (url, options) => {
    assert.equal(url, '/rag-api/model-selection');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { llmModel: 'glm-4.7-flash', embeddingModel: 'nomic-embed-text', reindex: true });
    return Response.json(validated);
  };
  const previousMode = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'development';
    const result = await requestSessionModelSelection('glm-4.7-flash', 'nomic-embed-text', fetchSelection);
    assert.equal(deadline, 60_000);
    assert.equal(result.config.llm.model, 'glm-4.7-flash');
    process.env.NODE_ENV = 'production';
    await requestSessionModelSelection('glm-4.7-flash', 'nomic-embed-text', fetchSelection);
    assert.equal(deadline, 15_000);
  } finally {
    if (previousMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousMode;
  }
});

test('selection timeout and connection failures have actionable Chinese messages', async () => {
  await assert.rejects(
    requestSessionModelSelection('glm-4.7-flash', 'nomic-embed-text', async () => {
      throw new DOMException('signal timed out', 'TimeoutError');
    }),
    /模型切换验证超时.*当前页面选择未更新/
  );
  await assert.rejects(
    requestSessionModelSelection('glm-4.7-flash', 'nomic-embed-text', async () => {
      throw new TypeError('Failed to fetch');
    }),
    /无法连接模型切换服务/
  );
  await assert.rejects(
    requestSessionModelSelection('glm-4.7-flash', 'nomic-embed-text', async () => ({
      status: 200, ok: true,
      async json() { throw new DOMException('signal timed out', 'TimeoutError'); },
    })),
    /模型切换验证超时.*当前页面选择未更新/
  );
});

test('向量切换轮询重建任务，准备完成前不返回新模型配置', async t => {
  t.mock.method(globalThis, 'setTimeout', callback => { queueMicrotask(callback); return 0; });
  const calls = [];
  const progress = [];
  const result = await requestSessionModelSelection('glm', 'bge-m3', async (url, options) => {
    calls.push([url, options.method]);
    if (options.method === 'POST') return Response.json({ success: true,
      job: { id: 'job-1', status: 'building', stage: 'embedding', completed: 8 } }, { status: 202 });
    return Response.json({ success: true, defaultLlmModel: 'llama3.1', job: { id: 'job-1', status: 'ready' },
      config: { llm: { provider: 'ollama', model: 'glm' }, embedding: { provider: 'ollama', model: 'bge-m3', dimension: 1024 } } });
  }, message => progress.push(message));
  assert.equal(result.config.embedding.dimension, 1024);
  assert.deepEqual(calls, [['/rag-api/model-selection', 'POST'], ['/rag-api/model-selection?jobId=job-1', 'GET']]);
  assert.match(progress[0], /8 个文档块/);
  await assert.rejects(requestSessionModelSelection('glm', 'bge-m3', async (_url, options) => Response.json(options.method === 'POST'
    ? { success: true, job: { id: 'job-2', status: 'building', completed: 0 } }
    : { success: true, job: { id: 'job-2', status: 'failed', error: '重建失败，旧索引保留' } }, { status: options.method === 'POST' ? 202 : 200 })), /旧索引保留/);
  await assert.rejects(requestSessionModelSelection('glm', 'bge-m3', async (_url, options) => {
    if (options.method === 'GET') throw new DOMException('signal timed out', 'TimeoutError');
    return Response.json({ success: true, job: { id: 'job-3', status: 'building', completed: 0 } }, { status: 202 });
  }), /获取向量重建进度失败.*后台任务可能仍在进行/);
});

test('selection preserves server rejection reasons and rejects invalid successful responses', async () => {
  await assert.rejects(
    requestSessionModelSelection('glm-4.7-flash', 'nomic-embed-text', async () => Response.json(
      { success: false, error: '所选模型未获服务器授权' }, { status: 403 }
    )),
    /所选模型未获服务器授权/
  );
  await assert.rejects(
    requestSessionModelSelection('glm-4.7-flash', 'nomic-embed-text', async () => Response.json({ success: true })),
    /模型切换服务返回的数据不完整/
  );
});
